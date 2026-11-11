// Company-approved extra test-service images: looking up the digest of a tag, so an approval pins what a registry said and not what a person typed. The registry is asked with the standard registry API (an anonymous
// pull token when the registry asks for one), over https only, to a public DNS name only (never an address, a port or a private-looking name: the reference reader refuses those first, and the token address is checked here
// the same way), with no redirect followed, a time limit and a size limit. A lookup that fails for any reason says nothing but `undefined`: the caller then proposes nothing. Nothing here throws.
import { COMPANY_IMAGE_DEFAULT_REGISTRY, type CompanyImageName } from "./company-images.js";

/** The port the authority uses: the digest (64 hex) of an image's tag, or undefined when it could not be looked up. */
export type CompanyImageDigestResolver = (image: CompanyImageName) => Promise<string | undefined>;

export const RESOLVER_TIMEOUT_MS = 8_000;
const TOKEN_MAX_BYTES = 16 * 1024;
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const DIGEST_HEADER = /^sha256:([a-f0-9]{64})$/u;
const PUBLIC_HOST = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const PRIVATE_SUFFIX = /(?:^|\.)(?:local|localhost|internal|lan|home|corp|intranet|test|invalid|example)$/u;

/** The host of an https address that is a public-looking DNS name with no port, credentials or fragment, or undefined. */
function publicHttpsHost(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    const host = url.hostname.toLowerCase();
    return PUBLIC_HOST.test(host) && !/^[0-9.]+$/u.test(host) && !PRIVATE_SUFFIX.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** `realm="https://auth.docker.io/token",service="registry.docker.io"` as a map. Only the three keys a pull token needs are read. */
function challengeOf(header: string | null): { realm: string; service?: string } | undefined {
  if (header === null || !/^Bearer\s/iu.test(header)) return undefined;
  const fields = new Map<string, string>();
  for (const match of header.slice(7).matchAll(/([a-z]+)="([^"]*)"/giu)) fields.set(match[1]!.toLowerCase(), match[2]!);
  const realm = fields.get("realm");
  if (realm === undefined || publicHttpsHost(realm) === undefined) return undefined;
  const service = fields.get("service");
  return { realm, ...(service === undefined || service.length > 200 ? {} : { service }) };
}

type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; redirect?: "manual" | "error" | "follow"; signal?: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/** The digest resolver over a registry's API. `fetchImpl` is global `fetch` in production; tests give a fake. */
export function registryDigestResolver(fetchImpl: Fetch = fetch): CompanyImageDigestResolver {
  return async (image) => {
    try {
      const host = image.registry === COMPANY_IMAGE_DEFAULT_REGISTRY ? "registry-1.docker.io" : image.registry;
      if (publicHttpsHost(`https://${host}/`) === undefined) return undefined;
      const manifest = `https://${host}/v2/${image.repository}/manifests/${encodeURIComponent(image.tag)}`;
      const head = async (token?: string) => fetchImpl(manifest, {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(RESOLVER_TIMEOUT_MS),
        headers: { accept: MANIFEST_ACCEPT, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      });
      let reply = await head();
      if (reply.status === 401) {
        const challenge = challengeOf(reply.headers.get("www-authenticate"));
        if (challenge === undefined) return undefined;
        const address = new URL(challenge.realm);
        address.searchParams.set("scope", `repository:${image.repository}:pull`);
        if (challenge.service !== undefined) address.searchParams.set("service", challenge.service);
        const tokenReply = await fetchImpl(address.toString(), { redirect: "manual", signal: AbortSignal.timeout(RESOLVER_TIMEOUT_MS), headers: { accept: "application/json" } });
        if (tokenReply.status !== 200) return undefined;
        const text = await tokenReply.text();
        if (text.length > TOKEN_MAX_BYTES) return undefined;
        const parsed = JSON.parse(text) as { token?: unknown; access_token?: unknown };
        const token = typeof parsed.token === "string" ? parsed.token : typeof parsed.access_token === "string" ? parsed.access_token : undefined;
        if (token === undefined || token.length === 0 || token.length > 8_000) return undefined;
        reply = await head(token);
      }
      if (reply.status !== 200) return undefined;
      return DIGEST_HEADER.exec(reply.headers.get("docker-content-digest") ?? "")?.[1];
    } catch {
      return undefined;
    }
  };
}
