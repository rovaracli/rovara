// Enterprise foundations, task N2: the signed release bundle.
//
// A bundle is a release directory (release.json, templates, packages, legal) plus the container images the install runs
// (LiteLLM included), a bundle.json that lists EVERY other file with its SHA-256 and size, and bundle.sig.json, a detached
// signature over the exact bytes of bundle.json. The signature is ECDSA P-256 with SHA-256; verifiers hold public keys only.
// The bundle id is the SHA-256 of bundle.json: it is what a customer approves ("only a bundle whose hash the customer
// approved") and what a restore point records.
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { ImageDigest } from "./release.js";

export const BUNDLE_MANIFEST_FILE = "bundle.json";
export const BUNDLE_SIGNATURE_FILE = "bundle.sig.json";
export const BUNDLE_SIGNATURE_ALGORITHM = "ecdsa-p256-sha256";
/** Every bundle image is loaded into the install's own ECR under this prefix: `<prefix>/<environment>/<image name>`. The bundle names no target: the installer decides. */
export const BUNDLE_IMAGE_REPOSITORY_PREFIX = "rovara-bundle";
/** The mirrored LiteLLM image's name in a bundle. */
export const BUNDLE_LITELLM_IMAGE_NAME = "litellm";
/** Hard caps a verifier applies before parsing anything it was handed. */
export const BUNDLE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
export const BUNDLE_SIGNATURE_MAX_BYTES = 64 * 1024;
export const BUNDLE_MAX_FILES = 2_000;

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * A path inside the bundle: relative, "/"-separated, every segment starting with a letter or digit (so no "..", no ".", no empty
 * segment, no leading "/"), only the characters the release builder writes. The schema is the first guard; the verifier checks
 * containment again against the real directory.
 */
export const BundlePath = z.string().max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);
export const BundleImageName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);

export const BundleFileKind = z.enum(["release-manifest", "template", "package", "legal", "image", "notes", "synth-kit"]);
export type BundleFileKind = z.infer<typeof BundleFileKind>;
/** The directory of a bundle that holds the release's own pinned CDK app (task N3b). Only files of kind `synth-kit` live there, and every one of them does. */
export const BUNDLE_SYNTH_KIT_DIR = "synth-kit";
/** The kinds of file a bundle upgrade of a Public install deploys from the bundle itself. The kit, images and notes are never placed in the approval bucket for it. */
export const BUNDLE_PUBLIC_DEPLOYED_KINDS: readonly BundleFileKind[] = ["release-manifest", "template", "package", "legal"];

export const BundleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    format: z.literal("rovara-release-bundle"),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
    /** Every file of the bundle except bundle.json and bundle.sig.json. */
    files: z
      .array(z.object({ file: BundlePath, kind: BundleFileKind, sha256: Sha256, bytes: z.number().int().nonnegative() }).strict())
      .min(1)
      .max(BUNDLE_MAX_FILES),
    /** The images the install runs, as archives in `files` (kind "image"). The reference is the digest the archive was exported from. */
    images: z
      .array(
        z
          .object({
            name: BundleImageName,
            sourceRef: ImageDigest,
            file: BundlePath,
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .superRefine((manifest, context) => {
    const kinds = new Map<string, BundleFileKind>();
    for (const entry of manifest.files) {
      if (kinds.has(entry.file)) context.addIssue({ code: "custom", message: `file ${entry.file} is listed twice`, path: ["files"] });
      kinds.set(entry.file, entry.kind);
      // The kit has a directory of its own, and nothing else may sit in it: a file's kind is never decided by what it is called.
      if ((entry.kind === "synth-kit") !== entry.file.startsWith(`${BUNDLE_SYNTH_KIT_DIR}/`)) {
        context.addIssue({ code: "custom", message: `file ${entry.file}: the synth-kit kind is for files under ${BUNDLE_SYNTH_KIT_DIR}/ and only for them`, path: ["files"] });
      }
      if (entry.file === BUNDLE_MANIFEST_FILE || entry.file === BUNDLE_SIGNATURE_FILE) {
        context.addIssue({ code: "custom", message: `${entry.file} cannot list itself`, path: ["files"] });
      }
    }
    if (manifest.files.filter((entry) => entry.kind === "release-manifest").length !== 1 || kinds.get("release.json") !== "release-manifest") {
      context.addIssue({ code: "custom", message: "exactly one release-manifest file, release.json, is required", path: ["files"] });
    }
    if (kinds.size > 0 && [...kinds.values()].includes("synth-kit") && kinds.get(`${BUNDLE_SYNTH_KIT_DIR}/kit.json`) !== "synth-kit") {
      context.addIssue({ code: "custom", message: `a bundle with a synthesis kit lists ${BUNDLE_SYNTH_KIT_DIR}/kit.json`, path: ["files"] });
    }
    const names = new Set<string>();
    for (const image of manifest.images) {
      if (names.has(image.name)) context.addIssue({ code: "custom", message: `image ${image.name} is listed twice`, path: ["images"] });
      names.add(image.name);
      if (kinds.get(image.file) !== "image") context.addIssue({ code: "custom", message: `image ${image.name} names ${image.file}, which is not a listed image file`, path: ["images"] });
    }
    const imageFiles = manifest.files.filter((entry) => entry.kind === "image").map((entry) => entry.file);
    const referenced = new Set(manifest.images.map((image) => image.file));
    for (const file of imageFiles) if (!referenced.has(file)) context.addIssue({ code: "custom", message: `image file ${file} belongs to no image`, path: ["images"] });
  });
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

export const BundleSignatureSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal(BUNDLE_SIGNATURE_ALGORITHM),
    /** SHA-256 (hex) of the signing key's SubjectPublicKeyInfo DER: how a verifier picks which pinned key to use. */
    keyId: Sha256,
    /** SHA-256 (hex) of bundle.json: the bundle id. Informational; the verifier recomputes it. */
    bundleSha256: Sha256,
    /** DER-encoded ECDSA signature over the bytes of bundle.json, base64. */
    signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(256),
  })
  .strict();
export type BundleSignature = z.infer<typeof BundleSignatureSchema>;

export const sha256OfBytes = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A trusted key, as a PEM "PUBLIC KEY" (SubjectPublicKeyInfo). A private key, a certificate or a non-P-256 key is refused. */
export function parseBundlePublicKey(pem: string): { keyId: string; key: ReturnType<typeof createPublicKey> } {
  if (typeof pem !== "string" || !/^\s*-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem)) {
    throw new Error("a bundle signing key must be a PEM PUBLIC KEY");
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("a bundle signing key must be an ECDSA P-256 key");
  }
  const der = key.export({ type: "spki", format: "der" });
  return { keyId: sha256OfBytes(der), key };
}

export type BundleSignatureCheck = { ok: true; keyId: string; bundleSha256: string } | { ok: false; reason: string };

/**
 * Checks `signature` against the exact `manifestBytes` with the pinned key whose id it names. Fails closed: an unknown key id, a key
 * that cannot be read, an algorithm other than the one pinned, a signature that does not verify, and a `bundleSha256` that is not the
 * bytes' own hash are all refusals. Never throws.
 */
export function verifyBundleSignature(input: { manifestBytes: Uint8Array; signature: BundleSignature; trustedKeys: readonly string[] }): BundleSignatureCheck {
  const { manifestBytes, signature, trustedKeys } = input;
  try {
    const bundleSha256 = sha256OfBytes(manifestBytes);
    if (signature.bundleSha256 !== bundleSha256) return { ok: false, reason: "the signature file names a different bundle.json" };
    const candidates: Array<ReturnType<typeof parseBundlePublicKey>> = [];
    for (const pem of trustedKeys) {
      try {
        const parsed = parseBundlePublicKey(pem);
        if (parsed.keyId === signature.keyId) candidates.push(parsed);
      } catch {
        // An unreadable pinned key never verifies anything; the others still count.
      }
    }
    if (candidates.length === 0) return { ok: false, reason: `the bundle is signed by a key this installation does not trust (${signature.keyId.slice(0, 16)})` };
    const bytes = Buffer.from(signature.signature, "base64");
    for (const candidate of candidates) {
      if (verify("sha256", manifestBytes, { key: candidate.key, dsaEncoding: "der" }, bytes)) return { ok: true, keyId: candidate.keyId, bundleSha256 };
    }
    return { ok: false, reason: "the signature does not match bundle.json" };
  } catch {
    return { ok: false, reason: "the signature could not be checked" };
  }
}
