// Reading registry manifests for company-approved images (pure: bytes in, facts out). The pin is the digest of the image's linux/arm64 manifest (contracts company-image-mirror.ts); this file finds it in an index,
// and checks that an image manifest is one the mirror can copy: a plain image manifest (Docker v2 or OCI), layers that are ordinary blobs with a digest and a size, and nothing foreign.
import { createHash } from "node:crypto";
import { COMPANY_IMAGE_PLATFORM } from "@agentx/cloud-contracts";
import { z } from "zod";

export const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const INDEX_TYPES: ReadonlySet<string> = new Set(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"]);
export const IMAGE_MANIFEST_TYPES: ReadonlySet<string> = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);
const LAYER_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip", "application/vnd.oci.image.layer.v1.tar+zstd",
  "application/vnd.docker.image.rootfs.diff.tar.gzip", "application/vnd.docker.image.rootfs.diff.tar",
]);
const CONFIG_TYPES: ReadonlySet<string> = new Set(["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"]);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const IndexSchema = z.object({
  mediaType: z.string().optional(),
  manifests: z.array(z.object({
    mediaType: z.string().optional(), digest: Digest, size: z.number().int().min(1).max(4 * 1024 * 1024),
    platform: z.object({ os: z.string(), architecture: z.string(), variant: z.string().optional() }).passthrough().optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  }).passthrough()).max(512),
}).passthrough();

const ImageSchema = z.object({
  schemaVersion: z.literal(2),
  mediaType: z.string().optional(),
  config: z.object({ mediaType: z.string(), digest: Digest, size: z.number().int().min(2).max(1024 * 1024) }).passthrough(),
  layers: z.array(z.object({ mediaType: z.string(), digest: Digest, size: z.number().int().min(0), urls: z.array(z.string()).optional() }).passthrough()).min(1).max(150),
}).passthrough();
export type ImageManifest = z.infer<typeof ImageSchema>;

function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return undefined; }
}

export type ManifestKind = "index" | "image" | "unknown";

/** What a manifest is, from its own `mediaType` (the header of a registry is not trusted over it). */
export function manifestKindOf(bytes: Uint8Array, headerType: string): ManifestKind {
  const parsed = json(bytes) as { mediaType?: unknown; manifests?: unknown; config?: unknown } | undefined;
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) return "unknown";
  const type = typeof parsed.mediaType === "string" ? parsed.mediaType : headerType;
  if (INDEX_TYPES.has(type) || (type === "" && Array.isArray(parsed.manifests))) return "index";
  if (IMAGE_MANIFEST_TYPES.has(type) || (type === "" && parsed.config !== undefined)) return "image";
  return "unknown";
}

/** The digest (64 hex) of the index's linux/arm64 image manifest, or undefined when it has none or has more than one. Attestation and other non-image entries never count. */
export function platformDigestOf(indexBytes: Uint8Array): string | undefined {
  const parsed = IndexSchema.safeParse(json(indexBytes));
  if (!parsed.success) return undefined;
  const found = parsed.data.manifests.filter((entry) => {
    if (entry.annotations?.["vnd.docker.reference.type"] !== undefined) return false;
    if (entry.mediaType !== undefined && !IMAGE_MANIFEST_TYPES.has(entry.mediaType)) return false;
    const platform = entry.platform;
    return platform?.os === COMPANY_IMAGE_PLATFORM.os && platform.architecture === COMPANY_IMAGE_PLATFORM.architecture && (platform.variant === undefined || platform.variant === "v8");
  });
  const digests = [...new Set(found.map((entry) => entry.digest.slice("sha256:".length)))];
  return digests.length === 1 ? digests[0] : undefined;
}

/** An image manifest the mirror can copy, or the reason it cannot. A foreign layer (a `urls` entry or a foreign media type) is refused: ECR cannot hold one. */
export function readImageManifest(bytes: Uint8Array): { ok: true; manifest: ImageManifest } | { ok: false; reason: "unsupported" } {
  const parsed = ImageSchema.safeParse(json(bytes));
  if (!parsed.success || !CONFIG_TYPES.has(parsed.data.config.mediaType)) return { ok: false, reason: "unsupported" };
  if (parsed.data.layers.some((layer) => !LAYER_TYPES.has(layer.mediaType) || (layer.urls?.length ?? 0) > 0)) return { ok: false, reason: "unsupported" };
  return { ok: true, manifest: parsed.data };
}

/** Whether an image's config says linux/arm64. */
export function configIsPlatform(configBytes: Uint8Array): boolean {
  const parsed = json(configBytes) as { os?: unknown; architecture?: unknown; variant?: unknown } | undefined;
  return typeof parsed === "object" && parsed !== null && parsed.os === COMPANY_IMAGE_PLATFORM.os && parsed.architecture === COMPANY_IMAGE_PLATFORM.architecture && (parsed.variant === undefined || parsed.variant === "v8");
}
