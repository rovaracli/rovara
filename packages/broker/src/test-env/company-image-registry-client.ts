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
//   - Every body has a size cap and every request a time limit: 8 seconds for the headers of any reply and for the whole of a manifest or token; a BLOB's body has no fixed total (a layer is hundreds of megabytes and each part
//     upload to the install's registry waits on the stream) but ends after `REGISTRY_BLOB_IDLE_MS` with no byte. Nothing here returns an error text of a registry: failures are one of five fixed reasons.
import { companyImageRegistryRule, type CompanyImageRegistryRule } from "@agentx/contracts";
import { resolvesOnlyToPublicAddresses, type AddressLookup } from "./public-address.js";

export type RegistryFailure = "not_allowed" | "not_found" | "too_large" | "unavailable" | "timeout";
export class RegistryClientError extends Error {
  constructor(readonly reason: RegistryFailure) { super(`registry: ${reason}`); this.name = "RegistryClientError"; }
}

export interface RegistryReply { status: number; headers: { get(name: string): string | null }; body: AsyncIterable<Uint8Array> | null }
export type RegistryFetch = (url: string, init: { method: "GET" | "HEAD"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal }) => Promise<RegistryReply>;

export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
/** The time to get a reply's headers, and the whole of a manifest, a token or a small blob. */
export const REGISTRY_REQUEST_TIMEOUT_MS = 8_000;
/** A layer streams for as long as it needs, as long as bytes keep arriving: this long with no byte at all ends it (`timeout`). The copy's own deadline bounds the whole. */
export const REGISTRY_BLOB_IDLE_MS = 30_000;
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

/**
 * A body that ends with `timeout` when no byte arrives for `idleMs`. The wait for each chunk is raced against the timer (a body that ignores the abort signal still ends), and the source is told to stop. The source
 * is not awaited on the way out: a stalled source never answers `return()`.
 */
async function* idleGuarded(body: AsyncIterable<Uint8Array>, controller: AbortController, idleMs: number): AsyncGenerator<Uint8Array> {
  const source = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RegistryClientError("timeout")); }, idleMs); });
      let step: IteratorResult<Uint8Array>;
      try {
        step = await Promise.race([source.next(), idle]);
      } catch (error) {
        throw error instanceof RegistryClientError ? error : new RegistryClientError("unavailable");
      } finally {
        clearTimeout(timer);
        void idle.catch(() => undefined);
      }
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    controller.abort();
    void Promise.resolve(source.return?.()).catch(() => undefined);
  }
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
  /** The time for a reply's headers and for a whole manifest or token. Default 8 seconds. */
  timeoutMs?: number;
  /** The most a blob's body may go without a byte. Default 30 seconds. */
  idleMs?: number;
}

const REPOSITORY = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/u;
const REFERENCE = /^(?:sha256:[a-f0-9]{64}|[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/u;

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const rule = companyImageRegistryRule(options.registry, options.extra);
  if (rule === undefined || !REPOSITORY.test(options.repository) || options.repository.length > 250) throw new RegistryClientError("not_allowed");
  const timeout = options.timeoutMs ?? REGISTRY_REQUEST_TIMEOUT_MS;
  const idleMs = options.idleMs ?? REGISTRY_BLOB_IDLE_MS;
  const checkedHosts = new Map<string, Promise<boolean>>();
  const publicHost = (host: string): Promise<boolean> => {
    let known = checkedHosts.get(host);
    if (known === undefined) { known = resolvesOnlyToPublicAddresses(host, options.lookup); checkedHosts.set(host, known); }
    return known;
  };
  let token: string | undefined;

  /**
   * One request. The time for the HEADERS is `timeout` for every request. For a manifest or a token the same limit covers the body (the signal stays); for a BLOB (`stream`) the signal is ours and ends only on an idle
   * stretch: the body is returned with an idle guard, so a slow but moving download is never cut off by the 8 seconds that a header deserves.
   */
  async function send(url: string, headers: Record<string, string>, stream = false): Promise<RegistryReply> {
    const host = plainHttpsHost(url);
    if (host === undefined || !(await publicHost(host))) throw new RegistryClientError("not_allowed");
    const controller = new AbortController();
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { headerTimer = setTimeout(() => { controller.abort(); reject(new RegistryClientError("unavailable")); }, timeout); });
    try {
      const reply = await Promise.race([options.fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: stream ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) }), late]);
      clearTimeout(headerTimer);
      return stream && reply.body !== null ? { ...reply, body: idleGuarded(reply.body, controller, idleMs) } : reply;
    } catch (error) {
      clearTimeout(headerTimer);
      void late.catch(() => undefined);
      throw error instanceof RegistryClientError ? error : new RegistryClientError("unavailable");
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
  async function api(path: string, accept: string | undefined, blob: boolean, stream = false): Promise<RegistryReply> {
    const url = `https://${rule!.apiHost}/v2/${options.repository}/${path}`;
    const headers = (): Record<string, string> => ({ ...(accept === undefined ? {} : { accept }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) });
    let reply = await send(url, headers(), stream);
    if (reply.status === 401 && token === undefined) {
      const challenge = challengeOf(reply.headers.get("www-authenticate"), rule!);
      if (challenge === undefined) throw new RegistryClientError("unavailable");
      token = await fetchToken(challenge);
      reply = await send(url, headers(), stream);
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
      // A built-in registry's blobs may come from its listed hosts only. A company's own registry may send them to any public https host (decision 93): `send` below still requires the name to resolve to public addresses only.
      if (host === undefined || (rule!.blobAnyPublicHost !== true && !rule!.blobHostSuffixes.some((suffix) => host.endsWith(suffix)))) throw new RegistryClientError("not_allowed");
      reply = await send(next, {}, stream);
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
        const reply = await api(`blobs/${digest}`, undefined, true, true);
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
