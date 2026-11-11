// A small, closed registry client for company-approved images: the broker's digest lookup and the mirror both read a registry through it, so the rules below are kept in ONE place.
//
// What it will and will not do:
//   - It only talks to a registry whose rule `companyImageRegistryRule` gave (a built-in one, or one of the company's extra ones), at the API host THE RULE names, never one taken from a typed image name. A registry
//     that is not allowed is `not_allowed` before any lookup or request.
//   - Before every host it contacts (the API host, the token service, a blob redirect target) the host must RESOLVE ONLY TO PUBLIC ADDRESSES (`resolvesOnlyToPublicAddresses`): an IP literal, a name that points at a
//     loopback, private, link-local or metadata address, or one that does not resolve is refused. That is the DNS check; the allowlist of exact hosts is the name check. (A fetch cannot pin the address it connects to, so
//     a registry host that is hijacked between the lookup and the connection is covered only by its TLS certificate; the allowlisted hosts are Rovara's choice, an extra one is the company admin's.)
//   - https only, no port, no credentials, and `redirect: "manual"`. A manifest or token request that is redirected fails. A BLOB request may follow up to three redirects, each to https on a host that has one of the
//     rule's blob host suffixes, resolved and checked as above, and the registry's token is NOT sent to the new host.
//   - The token service (`WWW-Authenticate` realm) must be one of the rule's auth hosts. Anonymous pull tokens only: there are no registry credentials anywhere in this module.
//   - Every body has a size cap and every request a time limit. Nothing here returns an error text of a registry: failures are one of four fixed reasons.
import { companyImageRegistryRule, type CompanyImageRegistryRule } from "@agentx/contracts";
import { resolvesOnlyToPublicAddresses, type AddressLookup } from "./public-address.js";

export type RegistryFailure = "not_allowed" | "not_found" | "too_large" | "unavailable";
export class RegistryClientError extends Error {
  constructor(readonly reason: RegistryFailure) { super(`registry: ${reason}`); this.name = "RegistryClientError"; }
}

export interface RegistryReply { status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> | null }
export type RegistryFetch = (url: string, init: { method: "GET" | "HEAD"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<RegistryReply>;

export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
export const REGISTRY_REQUEST_TIMEOUT_MS = 8_000;
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const TOKEN_MAX_BYTES = 16 * 1024;
const BLOB_REDIRECTS_MAX = 3;
const PUBLIC_HOST = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** The host of an https address with no port, credentials or fragment, or undefined. IP literals and private-looking names are not hosts here. */
function plainHttpsHost(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    const host = url.hostname.toLowerCase();
    return PUBLIC_HOST.test(host) && !/^[0-9.]+$/u.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

async function readCapped(body: AsyncIterable<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > max) throw new RegistryClientError("too_large");
    parts.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

/** `realm="https://auth.docker.io/token",service="registry.docker.io"` as a map. */
function challengeOf(header: string | null, rule: CompanyImageRegistryRule): { realm: string; service?: string } | undefined {
  if (header === null || !/^Bearer\s/iu.test(header)) return undefined;
  const fields = new Map<string, string>();
  for (const match of header.slice(7).matchAll(/([a-z]+)="([^"]*)"/giu)) fields.set(match[1]!.toLowerCase(), match[2]!);
  const realm = fields.get("realm");
  const host = realm === undefined ? undefined : plainHttpsHost(realm);
  if (realm === undefined || host === undefined || !rule.authHosts.includes(host)) return undefined;
  const service = fields.get("service");
  return { realm, ...(service === undefined || service.length > 200 ? {} : { service }) };
}

export interface RegistryClient {
  /** The manifest of a tag or a `sha256:` reference: its bytes, and the digest the registry says. */
  manifest(reference: string): Promise<{ bytes: Uint8Array; mediaType: string; digestHeader: string | undefined }>;
  /** A blob's bytes as a stream (the caller holds it to its digest). `maxBytes` is enforced while reading. */
  blob(digest: string, maxBytes: number): AsyncIterable<Uint8Array>;
  /** A small blob (an image's config) in memory. */
  smallBlob(digest: string, maxBytes: number): Promise<Uint8Array>;
}

export interface RegistryClientOptions {
  /** The registry as the image name spells it; checked against the built-in list and the company's `extra` list. */
  registry: string;
  extra: readonly string[];
  repository: string;
  fetchImpl: RegistryFetch;
  lookup: AddressLookup;
  timeoutMs?: number;
}

const REPOSITORY = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/u;
const REFERENCE = /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/u;

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const rule = companyImageRegistryRule(options.registry, options.extra);
  if (rule === undefined || !REPOSITORY.test(options.repository) || options.repository.length > 250) throw new RegistryClientError("not_allowed");
  const timeout = options.timeoutMs ?? REGISTRY_REQUEST_TIMEOUT_MS;
  const checkedHosts = new Map<string, Promise<boolean>>();
  const publicHost = (host: string): Promise<boolean> => {
    let known = checkedHosts.get(host);
    if (known === undefined) { known = resolvesOnlyToPublicAddresses(host, options.lookup); checkedHosts.set(host, known); }
    return known;
  };
  let token: string | undefined;

  async function send(url: string, headers: Record<string, string>): Promise<RegistryReply> {
    const host = plainHttpsHost(url);
    if (host === undefined || !(await publicHost(host))) throw new RegistryClientError("not_allowed");
    try {
      return await options.fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new RegistryClientError("unavailable");
    }
  }

  async function fetchToken(challenge: { realm: string; service?: string }): Promise<string> {
    const address = new URL(challenge.realm);
    address.searchParams.set("scope", `repository:${options.repository}:pull`);
    if (challenge.service !== undefined) address.searchParams.set("service", challenge.service);
    const reply = await send(address.toString(), { accept: "application/json" });
    if (reply.status !== 200) throw new RegistryClientError("unavailable");
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await readCapped(reply.body, TOKEN_MAX_BYTES))) as { token?: unknown; access_token?: unknown };
      const found = typeof parsed.token === "string" ? parsed.token : typeof parsed.access_token === "string" ? parsed.access_token : undefined;
      if (found === undefined || found.length === 0 || found.length > 8_000) throw new RegistryClientError("unavailable");
      return found;
    } catch (error) {
      throw error instanceof RegistryClientError ? error : new RegistryClientError("unavailable");
    }
  }

  /** The API request, with the one token exchange a registry may ask for. A redirect from the API host is only followed for a blob. */
  async function api(path: string, accept: string | undefined, blob: boolean): Promise<RegistryReply> {
    const url = `https://${rule!.apiHost}/v2/${options.repository}/${path}`;
    const headers = (): Record<string, string> => ({ ...(accept === undefined ? {} : { accept }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) });
    let reply = await send(url, headers());
    if (reply.status === 401 && token === undefined) {
      const challenge = challengeOf(reply.headers.get("www-authenticate"), rule!);
      if (challenge === undefined) throw new RegistryClientError("unavailable");
      token = await fetchToken(challenge);
      reply = await send(url, headers());
    }
    let hops = 0;
    while (reply.status >= 300 && reply.status < 400) {
      const location = reply.headers.get("location");
      if (!blob || location === null || hops >= BLOB_REDIRECTS_MAX) throw new RegistryClientError("unavailable");
      hops += 1;
      let next: string;
      try { next = new URL(location, url).toString(); } catch { throw new RegistryClientError("unavailable"); }
      const host = plainHttpsHost(next);
      // The suffix has a leading dot, so `evil-docker.com` is not `.docker.com`; the host itself is never its own suffix.
      if (host === undefined || !rule!.blobHostSuffixes.some((suffix) => host.endsWith(suffix))) throw new RegistryClientError("not_allowed");
      reply = await send(next, {});
    }
    if (reply.status === 404) throw new RegistryClientError("not_found");
    if (reply.status !== 200) throw new RegistryClientError("unavailable");
    return reply;
  }

  return {
    async manifest(reference) {
      if (!REFERENCE.test(reference)) throw new RegistryClientError("not_allowed");
      const reply = await api(`manifests/${reference}`, MANIFEST_ACCEPT, false);
      const bytes = await readCapped(reply.body, MANIFEST_MAX_BYTES);
      return { bytes, mediaType: (reply.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(), digestHeader: reply.headers.get("docker-content-digest") ?? undefined };
    },
    blob(digest, maxBytes) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new RegistryClientError("not_allowed");
      return (async function* () {
        const reply = await api(`blobs/${digest}`, undefined, true);
        let total = 0;
        if (reply.body === null) return;
        for await (const chunk of reply.body) {
          total += chunk.byteLength;
          if (total > maxBytes) throw new RegistryClientError("too_large");
          yield chunk;
        }
      })();
    },
    async smallBlob(digest, maxBytes) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new RegistryClientError("not_allowed");
      return readCapped((await api(`blobs/${digest}`, undefined, true)).body, maxBytes);
    },
  };
}

/** Global `fetch` as a `RegistryFetch`. */
export const globalRegistryFetch: RegistryFetch = async (url, init) => {
  const reply = await fetch(url, init);
  return { status: reply.status, headers: reply.headers, body: reply.body as unknown as AsyncIterable<Uint8Array> | null };
};
