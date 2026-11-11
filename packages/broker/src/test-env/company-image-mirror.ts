// Copying an approved company image into the install's own registry (the mirror). One image manifest (the approved linux/arm64 digest) and its config and layers go from the source registry to a private repository of
// the install, by digest, so the worker never reaches a public registry: it pulls from the install's registry with a login for that one repository (company-image-login.ts).
//
// What the copier guarantees, each with a test (tests/contract/company-image-mirror.test.ts):
//   - Only the registry the allowlist names is contacted, through the closed registry client (allowlist by host, public addresses only, no foreign redirect, size caps).
//   - The manifest is read BY THE APPROVED DIGEST and the sha256 of the bytes must equal it, so what is copied is exactly what an admin approved. Every layer and the config are held to their own digests while they stream:
//     a layer that does not hash to its digest is never completed in the registry.
//   - The image must be one plain image manifest for linux/arm64 with ordinary layers (no index, no foreign layer, no schema 1). Anything else fails with a fixed reason.
//   - The image is pushed with the manifest's own bytes and the approved digest, and read back from the registry by that digest before the copy is `ready`: the digest the worker pulls is the digest that was approved.
// Nothing here returns text from a registry or from AWS: failures are one of `COMPANY_IMAGE_MIRROR_FAILURES`. The AWS calls are PORTS (`EcrWriter`); their adapter is in aws/company-image-mirror-handler.ts.
import { createHash } from "node:crypto";
import { companyImageMirrorTag, companyImageRegistryRule, type CompanyImageMirrorFailure } from "@agentx/contracts";
import { configIsPlatform, manifestKindOf, readImageManifest, sha256Of } from "./company-image-manifest.js";
import { RegistryClientError, type RegistryClient } from "./company-image-registry-client.js";

/** What the copier needs of the install's registry, made with ONE repository's push credentials. */
export interface EcrWriter {
  /** Which of these `sha256:` blobs the repository already holds (a repository that does not exist yet holds none). */
  available(digests: readonly string[]): Promise<ReadonlySet<string>>;
  /** Uploads one blob in parts, then completes it with its digest. The caller has already held the bytes to the digest. */
  uploadBlob(digest: string, parts: AsyncIterable<Uint8Array>): Promise<void>;
  /** Puts the manifest (its exact text) under a tag, with the digest it must have. An image that is already there with that digest is fine. */
  putImage(input: { manifest: string; mediaType: string; digest: string; tag: string }): Promise<void>;
  /** The digest of the manifest the registry holds under `digest` (read back), or undefined. */
  readBack(digest: string): Promise<string | undefined>;
}

/** The largest image Rovara copies, and the largest single piece. A test database image is a few hundred megabytes; this is a ceiling, not a target. */
export const MIRROR_TOTAL_MAX_BYTES = 3 * 1024 ** 3;
export const MIRROR_BLOB_MAX_BYTES = 2 * 1024 ** 3;
/** The size of an upload part: ECR wants at least 5 MiB for every part but the last, and at most 10 MiB. */
export const MIRROR_PART_BYTES = 8 * 1024 * 1024;

class MirrorFailure extends Error { constructor(readonly reason: CompanyImageMirrorFailure) { super(reason); } }

const reasonOf = (error: unknown): CompanyImageMirrorFailure => {
  if (error instanceof MirrorFailure) return error.reason;
  if (error instanceof RegistryClientError) return error.reason === "not_allowed" ? "registry_not_allowed" : error.reason;
  return "unavailable";
};

/** Splits a byte stream into upload parts of `MIRROR_PART_BYTES` (the last may be smaller), holding the whole to `digest` as it goes. Throws `digest_mismatch` at the end when the bytes do not hash to it. */
export async function* verifiedParts(stream: AsyncIterable<Uint8Array>, digest: string, partBytes = MIRROR_PART_BYTES): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  let pending: Buffer[] = [];
  let held = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    pending.push(Buffer.from(chunk));
    held += chunk.byteLength;
    while (held >= partBytes) {
      const joined = Buffer.concat(pending);
      yield joined.subarray(0, partBytes);
      pending = [joined.subarray(partBytes)];
      held -= partBytes;
    }
  }
  if (`sha256:${hash.digest("hex")}` !== digest) throw new MirrorFailure("digest_mismatch");
  if (held > 0) yield Buffer.concat(pending);
}

export interface CopyInput { registry: string; extraRegistries: readonly string[]; digest: string }
export interface CopyPorts {
  /** The registry client for one repository of the source registry (it refuses a registry that is not allowed). */
  registry(input: { registry: string; extra: readonly string[]; repository: string }): RegistryClient;
  ecr: EcrWriter;
  now(): number;
  /** The copy is abandoned (`timeout`) once this time has passed. */
  deadlineMs: number;
}

/** Copies the approved image. `{ ok: true }` only when the install's registry holds the manifest by the approved digest afterwards. Never throws. */
export async function copyApprovedImage(ports: CopyPorts, input: CopyInput & { repository: string }): Promise<{ ok: true } | { ok: false; reason: CompanyImageMirrorFailure }> {
  try {
    if (companyImageRegistryRule(input.registry, input.extraRegistries) === undefined) throw new MirrorFailure("registry_not_allowed");
    if (!/^[a-f0-9]{64}$/u.test(input.digest)) throw new MirrorFailure("digest_mismatch");
    const source = ports.registry({ registry: input.registry, extra: input.extraRegistries, repository: input.repository });
    const reference = `sha256:${input.digest}`;
    const top = await source.manifest(reference);
    if (sha256Of(top.bytes) !== input.digest) throw new MirrorFailure("digest_mismatch");
    const kind = manifestKindOf(top.bytes, top.mediaType);
    // The approved digest is a platform manifest. An index here means the pin names the wrong thing: nothing is copied.
    if (kind !== "image") throw new MirrorFailure("unsupported");
    const read = readImageManifest(top.bytes);
    if (!read.ok) throw new MirrorFailure("unsupported");
    const manifest = read.manifest;
    const blobs = [{ digest: manifest.config.digest, size: manifest.config.size }, ...manifest.layers.map((layer) => ({ digest: layer.digest, size: layer.size }))];
    if (blobs.some((blob) => blob.size > MIRROR_BLOB_MAX_BYTES) || blobs.reduce((sum, blob) => sum + blob.size, 0) > MIRROR_TOTAL_MAX_BYTES) throw new MirrorFailure("too_large");
    // The config says what the image is built for: it must be linux/arm64 (the worker's platform), and it must hash to the digest the manifest names.
    const config = await source.smallBlob(manifest.config.digest, 1024 * 1024);
    if (`sha256:${sha256Of(config)}` !== manifest.config.digest) throw new MirrorFailure("digest_mismatch");
    if (!configIsPlatform(config)) throw new MirrorFailure("no_arm64");
    const wanted = [...new Set(blobs.map((blob) => blob.digest))];
    const present = await ports.ecr.available(wanted);
    for (const blob of wanted) {
      if (present.has(blob)) continue;
      if (ports.now() >= ports.deadlineMs) throw new MirrorFailure("timeout");
      const bytes = blob === manifest.config.digest ? (async function* () { yield config; })() : source.blob(blob, MIRROR_BLOB_MAX_BYTES);
      await ports.ecr.uploadBlob(blob, verifiedParts(bytes, blob));
    }
    if (ports.now() >= ports.deadlineMs) throw new MirrorFailure("timeout");
    await ports.ecr.putImage({ manifest: new TextDecoder().decode(top.bytes), mediaType: manifest.mediaType ?? top.mediaType, digest: reference, tag: companyImageMirrorTag(input.digest) });
    if (await ports.ecr.readBack(reference) !== input.digest) throw new MirrorFailure("digest_mismatch");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}
