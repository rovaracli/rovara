// Company-approved extra test-service images: looking up the digest of a tag, so an approval pins what a registry said and not what a person typed. The registry is read through the closed registry client
// (`company-image-registry-client.ts`): only an allowed registry (the four built-in ones and the company's own extra list), at the host the allowlist names, over https with no redirect, to hosts that resolve to public
// addresses only, with a time limit and a size limit. A lookup that fails for any reason says nothing but `undefined`: the caller then proposes nothing. Nothing here throws.

import { lookup as dnsLookup } from "node:dns/promises";
import { type CompanyImageName } from "./company-images.js";
import { configIsPlatform, manifestKindOf, platformDigestOf, readImageManifest, sha256Of } from "./company-image-manifest.js";
import { createRegistryClient, globalRegistryFetch, type RegistryFetch } from "./company-image-registry-client.js";
import type { AddressLookup } from "./public-address.js";

/**
 * The port the authority uses: the digest (64 hex) an image's tag has FOR linux/arm64, or undefined when it could not be looked up, the registry is not allowed, or the image has no linux/arm64 build.
 * `extraRegistries` is the company's own list (the four built-in registries are always allowed).
 */
export type CompanyImageDigestResolver = (image: CompanyImageName, extraRegistries?: readonly string[]) => Promise<string | undefined>;

export const RESOLVER_TIMEOUT_MS = 8_000;
/**
 * THE PIN: this is the digest of the image's linux/arm64 MANIFEST, not of the OCI index a multi-architecture tag points at (the worker runs linux/arm64; see contracts `company-image-mirror.ts` for the whole decision).
 * `docker-content-digest` of the manifest itself is what the registry says for that manifest, and it must equal the sha256 of the bytes we read; Rovara works the digest out from the bytes and uses the header only to
 * refuse a registry that disagrees with its own bytes. The mirror copies exactly this manifest and the worker pulls exactly this digest, so one number is approved, verified and run.
 */
const DIGEST_HEADER = /^sha256:([a-f0-9]{64})$/u;

const toAsync = (lookup: typeof dnsLookup): AddressLookup => async (host) => lookup(host, { all: true, verbatim: true });

/** The digest resolver over a registry's API. `fetchImpl` is global `fetch` in production; tests give a fake, and a fake name lookup. */
export function registryDigestResolver(fetchImpl: RegistryFetch = globalRegistryFetch, lookup: AddressLookup = toAsync(dnsLookup)): CompanyImageDigestResolver {
  return async (image, extraRegistries = []) => {
    try {
      const client = createRegistryClient({ registry: image.registry, extra: extraRegistries, repository: image.repository, fetchImpl, lookup, timeoutMs: RESOLVER_TIMEOUT_MS });
      const top = await client.manifest(image.tag);
      const kind = manifestKindOf(top.bytes, top.mediaType);
      if (kind === "index") return platformDigestOf(top.bytes);
      if (kind !== "image") return undefined;
      // A single image: its digest is the digest of the bytes read, the registry's own header (when it sends one) must agree, and its config must say linux/arm64.
      const digest = sha256Of(top.bytes);
      if (top.digestHeader !== undefined && DIGEST_HEADER.exec(top.digestHeader)?.[1] !== digest) return undefined;
      const read = readImageManifest(top.bytes);
      if (!read.ok) return undefined;
      const config = await client.smallBlob(read.manifest.config.digest, 1024 * 1024);
      if (sha256Of(config) !== read.manifest.config.digest.slice("sha256:".length) || !configIsPlatform(config)) return undefined;
      return digest;
    } catch {
      return undefined;
    }
  };
}


