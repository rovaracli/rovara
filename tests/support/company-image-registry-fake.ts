// A fake registry for the company image tests: images by digest (manifest, config, layers as real bytes with real sha256 digests), a fetch that answers like a registry API (token exchange, manifests by tag or digest,
// blobs with an optional redirect), and a name lookup the test controls. Nothing here touches the network.
import { createHash } from "node:crypto";
import type { RegistryFetch, RegistryReply } from "../../packages/broker/src/test-env/company-image-registry-client.js";

export const hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export function body(bytes: Uint8Array, chunk = 7): AsyncIterable<Uint8Array> {
  return (async function* () { for (let at = 0; at < bytes.byteLength; at += chunk) yield bytes.subarray(at, Math.min(bytes.byteLength, at + chunk)); })();
}
export function reply(status: number, headers: Record<string, string> = {}, content: Uint8Array | string = ""): RegistryReply {
  const bytes = typeof content === "string" ? text(content) : content;
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, body: body(bytes) };
}

export const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";
export const CONFIG_TYPE = "application/vnd.oci.image.config.v1+json";
export const LAYER_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";

export interface FakeImage { manifestBytes: Uint8Array; digest: string; config: Uint8Array; layers: Uint8Array[]; manifestText: string }

/** An image with real digests. `arch` goes in the config; `layers` are the layers' bytes. */
export function makeImage(options: { arch?: string; layers?: string[]; foreign?: boolean; salt?: string } = {}): FakeImage {
  const config = text(JSON.stringify({ architecture: options.arch ?? "arm64", os: "linux", salt: options.salt ?? "" }));
  const layers = (options.layers ?? ["layer one bytes", "layer two bytes, a little longer"]).map(text);
  const manifestText = JSON.stringify({
    schemaVersion: 2, mediaType: MANIFEST_TYPE,
    config: { mediaType: CONFIG_TYPE, digest: `sha256:${hex(config)}`, size: config.byteLength },
    layers: layers.map((layer) => ({ mediaType: LAYER_TYPE, digest: `sha256:${hex(layer)}`, size: layer.byteLength, ...(options.foreign === true ? { urls: ["https://elsewhere.example.org/blob"] } : {}) })),
  });
  const manifestBytes = text(manifestText);
  return { manifestBytes, digest: hex(manifestBytes), config, layers, manifestText };
}

export function makeIndex(children: Array<{ image: FakeImage; os: string; architecture: string; variant?: string; attestation?: boolean }>): { bytes: Uint8Array; digest: string } {
  const bytes = text(JSON.stringify({
    schemaVersion: 2, mediaType: INDEX_TYPE,
    manifests: children.map((child) => ({
      mediaType: MANIFEST_TYPE, digest: `sha256:${child.image.digest}`, size: child.image.manifestBytes.byteLength, platform: { os: child.os, architecture: child.architecture, ...(child.variant === undefined ? {} : { variant: child.variant }) },
      ...(child.attestation === true ? { annotations: { "vnd.docker.reference.type": "attestation-manifest" } } : {}),
    })),
  }));
  return { bytes, digest: hex(bytes) };
}

export interface FakeRegistryHost { apiHost: string; authHost?: string; blobHost?: string }

/**
 * A fetch over a table of tags and digests for ONE repository. `requests` records every URL asked (with whether an Authorization header went). The registry asks for a token first when `auth` is set.
 */
export function fakeRegistry(options: { host?: FakeRegistryHost; repository: string; tags?: Record<string, { bytes: Uint8Array; type: string }>; images?: FakeImage[]; indexes?: Array<{ bytes: Uint8Array; digest: string }>; auth?: boolean; blobRedirectTo?: string; realm?: string }) {
  const host = options.host ?? { apiHost: "registry-1.docker.io", authHost: "auth.docker.io" };
  const requests: Array<{ url: string; authorization: boolean }> = [];
  const manifests = new Map<string, { bytes: Uint8Array; type: string }>();
  const blobs = new Map<string, Uint8Array>();
  for (const image of options.images ?? []) {
    manifests.set(`sha256:${image.digest}`, { bytes: image.manifestBytes, type: MANIFEST_TYPE });
    blobs.set(`sha256:${hex(image.config)}`, image.config);
    for (const layer of image.layers) blobs.set(`sha256:${hex(layer)}`, layer);
  }
  for (const index of options.indexes ?? []) manifests.set(`sha256:${index.digest}`, { bytes: index.bytes, type: INDEX_TYPE });
  const fetchImpl: RegistryFetch = async (url, init) => {
    const address = new URL(url);
    requests.push({ url, authorization: init.headers["authorization"] !== undefined });
    if (address.host === host.authHost || address.host === (options.realm ?? "").replace(/^https:\/\//u, "").split("/")[0]) return reply(200, {}, JSON.stringify({ token: "fake-token-value" }));
    if (address.host === host.blobHost) {
      const blob = blobs.get(`sha256:${address.pathname.split("/").at(-1) ?? ""}`);
      return blob === undefined ? reply(404) : reply(200, {}, blob);
    }
    if (address.host !== host.apiHost) return reply(404);
    if (options.auth === true && init.headers["authorization"] === undefined) return reply(401, { "www-authenticate": `Bearer realm="${options.realm ?? `https://${host.authHost}/token`}",service="registry"` });
    const manifest = new RegExp(`^/v2/${options.repository}/manifests/(.+)$`, "u").exec(address.pathname);
    if (manifest !== null) {
      const found = options.tags?.[decodeURIComponent(manifest[1]!)] ?? manifests.get(decodeURIComponent(manifest[1]!));
      return found === undefined ? reply(404) : reply(200, { "content-type": found.type, "docker-content-digest": `sha256:${hex(found.bytes)}` }, found.bytes);
    }
    const blob = new RegExp(`^/v2/${options.repository}/blobs/(sha256:[a-f0-9]{64})$`, "u").exec(address.pathname);
    if (blob !== null) {
      if (options.blobRedirectTo !== undefined) return reply(307, { location: `${options.blobRedirectTo}/${blob[1]!.slice(7)}` });
      const found = blobs.get(blob[1]!);
      return found === undefined ? reply(404) : reply(200, {}, found);
    }
    return reply(404);
  };
  return { fetchImpl, requests, manifests, blobs };
}

/** A name lookup: by host, the addresses it gives (a host not listed does not resolve). `asked` records the hosts looked up. */
export function fakeLookup(table: Record<string, string[]>) {
  const asked: string[] = [];
  return { asked, lookup: async (host: string): Promise<Array<{ address: string }>> => { asked.push(host); const found = table[host]; if (found === undefined) throw new Error("ENOTFOUND"); return found.map((address) => ({ address })); } };
}
export const PUBLIC_HOSTS = { "registry-1.docker.io": ["54.236.113.205"], "auth.docker.io": ["3.209.95.6"], "ghcr.io": ["140.82.112.34"], "quay.io": ["52.1.2.3"], "public.ecr.aws": ["13.32.1.1"], "production.cloudflare.docker.com": ["104.18.1.1"], "registry.example.com": ["93.184.216.35"] };
