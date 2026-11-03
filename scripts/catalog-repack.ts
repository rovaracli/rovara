// Test services, lane ts-repack (design test-services.md sections 2.5 and 5.3; DECISIONS 2026-11-03, "Real-database prerequisites", step 3): REPACKAGING. An OPERATOR runs this, once per catalog release, before scripts/catalog-build.ts.
// No test and no CI job runs the real tools. It turns each upstream service image (postgres, redis ...) into a Rovara-built OCI index with EXACTLY the catalog's platforms, which is the shape catalog-build requires of
// its sources (catalog-build.ts, "SOURCES must be Rovara-built multi-platform INDEXES ... holding EXACTLY the platforms the catalog entry lists").
//
// The REPACK FILE lists each non-retired catalog entry with its upstream reference BY DIGEST (host/path@sha256:<digest> of the upstream INDEX, the digest the operator reviewed). A tag is refused: it names whatever the
// upstream owner pushes next. For each entry it:
//   1. reads the upstream index by that digest and checks that the bytes hash to it;
//   2. picks exactly the catalog's platforms (linux/arm64 and linux/amd64); an index without either is refused;
//   3. copies those child manifests, and their blobs, BY DIGEST into the entry's catalog repository (rovara-catalog/<env>/svc/<name>) in the Rovara staging registry, and checks that each child manifest now served there
//      hashes to the SAME digest: the image content is upstream's, exactly, never rebuilt;
//   4. builds a NEW OCI index holding only those children, annotated with the source reference, the source digest and the repack time;
//   5. pushes the index by digest and tags it with the first 32 hex digits of its digest (the tag catalog-build uses, so the repository's lifecycle policy never expires it);
//   6. reads the pushed index back by digest, re-hashes it, and checks it lists exactly the selected children with upstream's child digests; and checks the tag resolves to it;
//   7. writes the SOURCES FILE that catalog-build consumes (catalog id to the Rovara index, by digest) and a PROVENANCE record (upstream digest, child digests, the dropped manifests, the time).
//
// ATTESTATION MANIFESTS ARE DROPPED. Upstream indexes often carry BuildKit attestation manifests (`unknown/unknown`, annotation vnd.docker.reference.type). They are not platforms, and they describe how upstream built its
// image, not the Rovara-built index. The new index has no attestation manifest; the provenance record lists every manifest that was left out and why (`attestation`, `other_platform`, `no_platform`). Rovara's own SBOM and scan are
// taken per platform by catalog-build. The upstream index digest stays in the annotations, so the upstream image can always be found.
//
// Rules: by digest everywhere; child digests unchanged; every refusal aborts the whole run before any output file is written (the read phase refuses before anything is copied or pushed, too); the output is deterministic for
// the same inputs and the same repack time (the time is read from the clock ONCE per run; `--repack-time` pins it so a re-run gives the same index digests). Entries are processed in catalog-id order.
//
// Everything outside the decision rules is a PORT (registry read and copy, index push and tag, clock, output files), so the whole script runs against fakes. The real ports at the bottom use skopeo and oras through the
// same CommandPort catalog-build uses; they are only built by `main()`, which runs only when this file is the entry point. Nothing here is imported by the broker or the worker, and no secret is read: the registry
// credential is ECR's short token, kept in a 0600 file inside a 0700 directory.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { CATALOG_FILE, CatalogIdSchema, CatalogRegistryHostSchema, ServiceCatalogSchema, catalogRepositoryName } from "@agentx/contracts";
import { DEFAULT_CATALOG_DIR, DEFAULT_COMMAND_TIMEOUT_MS, SourceRefSchema, createCommandPort, tagFor, type CommandPort } from "./catalog-build.js";

export const OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
export const DOCKER_MANIFEST_LIST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.list.v2+json";
export const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const DOCKER_MANIFEST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
const IMAGE_MANIFEST_MEDIA_TYPES: readonly string[] = [OCI_MANIFEST_MEDIA_TYPE, DOCKER_MANIFEST_MEDIA_TYPE];
export const ANNOTATION_SOURCE_REFERENCE = "io.rovara.repack.source.reference";
export const ANNOTATION_SOURCE_DIGEST = "io.rovara.repack.source.digest";
export const ANNOTATION_REPACK_TIME = "io.rovara.repack.time";
const ATTESTATION_ANNOTATION = "vnd.docker.reference.type";
export const INDEX_MAX_BYTES = 4 * 1024 * 1024;

// ---- the repack file

/** `{ schemaVersion: 1, entries: { "postgres@16": "docker.io/library/postgres@sha256:<upstream index digest>" } }`. Each reference is checked on its own (so a tag is a refusal naming the entry, not a parse error). */
export const RepackFileSchema = z.object({ schemaVersion: z.literal(1), entries: z.record(z.string(), z.string()) }).strict();
export type RepackFile = z.infer<typeof RepackFileSchema>;

const hexOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const SOURCE_DIGEST_SEPARATOR = "@sha256:";
const repositoryOfSource = (reference: string): string => reference.slice(0, reference.lastIndexOf(SOURCE_DIGEST_SEPARATOR));
const digestOfSource = (reference: string): string => reference.slice(reference.lastIndexOf(SOURCE_DIGEST_SEPARATOR) + SOURCE_DIGEST_SEPARATOR.length);

// ---- ports

export interface RegistryPort {
  /** The raw bytes of the manifest `digest` (64 hex digits) of `repository` (`host/path`), read BY DIGEST. Upstream and Rovara repositories are both read through it. */
  readManifest(input: { repository: string; digest: string }): Promise<Uint8Array>;
  /** Copies ONE image manifest and its blobs, by digest, keeping the digest. The core re-reads the destination and checks the bytes hash to `digest`. */
  copyImage(input: { sourceRepository: string; destinationRepository: string; digest: string }): Promise<void>;
}
export interface IndexPort {
  /** Pushes `bytes` as the manifest `digest` of `repository` (by digest) and tags it `tag`. */
  push(input: { repository: string; digest: string; mediaType: string; bytes: Uint8Array; tag: string }): Promise<void>;
  /** The digest (`sha256:<hex>`) a tag resolves to, or nothing when the tag does not exist. */
  resolveTag(input: { repository: string; tag: string }): Promise<string | undefined>;
}
export interface ClockPort {
  now(): Date;
}
export interface OutputPort {
  /** Writes the files in the order given; the last one is the file everything else vouches for. */
  write(files: ReadonlyArray<{ path: string; bytes: Buffer }>): Promise<void>;
}
export interface RepackPorts {
  readonly registry: RegistryPort;
  readonly indexes: IndexPort;
  readonly clock: ClockPort;
  readonly files: OutputPort;
}

// ---- refusals

export const REPACK_REFUSAL_CODES = [
  "unknown_id", "retired_entry", "no_upstream", "tag_refused", "bad_reference",
  "upstream_digest_mismatch", "upstream_not_index", "platform_missing", "platform_ambiguous", "child_not_image",
  "child_digest_changed", "index_verify_failed", "tag_missing", "port_failed",
] as const;
export type RepackRefusalCode = (typeof REPACK_REFUSAL_CODES)[number];
export interface RepackRefusal { id: string; code: RepackRefusalCode; message: string }
export class RepackError extends Error {
  constructor(readonly refusals: readonly RepackRefusal[]) {
    super(`nothing was repacked or written: ${refusals.map((refusal) => `${refusal.id}: ${refusal.message}`).join("; ")}`);
    this.name = "RepackError";
  }
}

// ---- the upstream index

const DescriptorSchema = z
  .object({
    mediaType: z.string().max(200),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    size: z.number().int().min(0),
    platform: z.object({ architecture: z.string().max(40), os: z.string().max(40), variant: z.string().max(40).optional() }).passthrough().optional(),
    annotations: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
const UpstreamIndexSchema = z
  .object({ schemaVersion: z.literal(2), mediaType: z.enum([OCI_INDEX_MEDIA_TYPE, DOCKER_MANIFEST_LIST_MEDIA_TYPE]).optional(), manifests: z.array(DescriptorSchema).min(1).max(256) })
  .passthrough();

export interface SelectedChild {
  /** `linux/arm64`: the catalog's name of the platform. */
  readonly platformName: string;
  readonly platform: { readonly architecture: string; readonly os: string; readonly variant?: string };
  /** 64 hex digits. */
  readonly digest: string;
  readonly size: number;
  readonly mediaType: string;
}
export type DroppedReason = "attestation" | "other_platform" | "no_platform";
export interface DroppedManifest { readonly digest: string; readonly reason: DroppedReason }
export type PlatformSelection =
  | { ok: true; selected: SelectedChild[]; dropped: DroppedManifest[] }
  | { ok: false; code: "upstream_not_index" | "platform_missing" | "platform_ambiguous" | "child_not_image"; problem: string };

/**
 * Picks EXACTLY the wanted platforms out of an upstream index (already parsed JSON). Attestation manifests, other platforms and descriptors with no platform are dropped and returned (for the provenance record). A wanted
 * platform that is absent, listed twice, or not an image manifest refuses the entry: the result never holds fewer or more than the wanted platforms. Sorted by platform name; independent of the upstream order.
 */
export function selectPlatforms(upstream: unknown, wanted: readonly string[]): PlatformSelection {
  const index = UpstreamIndexSchema.safeParse(upstream);
  if (!index.success) return { ok: false, code: "upstream_not_index", problem: "the upstream manifest is not an image index or manifest list" };
  const found = new Map<string, SelectedChild[]>();
  const dropped: DroppedManifest[] = [];
  for (const descriptor of index.data.manifests) {
    const attestation = descriptor.annotations?.[ATTESTATION_ANNOTATION] !== undefined || descriptor.platform?.os === "unknown" || descriptor.platform?.architecture === "unknown";
    if (attestation) {
      dropped.push({ digest: descriptor.digest, reason: "attestation" });
      continue;
    }
    if (descriptor.platform === undefined) {
      dropped.push({ digest: descriptor.digest, reason: "no_platform" });
      continue;
    }
    const platformName = `${descriptor.platform.os}/${descriptor.platform.architecture}`;
    if (!wanted.includes(platformName)) {
      dropped.push({ digest: descriptor.digest, reason: "other_platform" });
      continue;
    }
    const platform = { architecture: descriptor.platform.architecture, os: descriptor.platform.os, ...(descriptor.platform.variant === undefined ? {} : { variant: descriptor.platform.variant }) };
    found.set(platformName, [...(found.get(platformName) ?? []), { platformName, platform, digest: descriptor.digest.slice("sha256:".length), size: descriptor.size, mediaType: descriptor.mediaType }]);
  }
  const selected: SelectedChild[] = [];
  for (const platformName of [...wanted].sort()) {
    const candidates = found.get(platformName) ?? [];
    if (candidates.length === 0) return { ok: false, code: "platform_missing", problem: `the upstream index has no ${platformName} image (the catalog lists ${[...wanted].sort().join(", ")})` };
    if (candidates.length > 1) return { ok: false, code: "platform_ambiguous", problem: `the upstream index lists ${platformName} more than once` };
    const child = candidates[0] as SelectedChild;
    if (!IMAGE_MANIFEST_MEDIA_TYPES.includes(child.mediaType)) return { ok: false, code: "child_not_image", problem: `the ${platformName} entry is not an image manifest (${child.mediaType})` };
    selected.push(child);
  }
  dropped.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  return { ok: true, selected, dropped };
}

// ---- the new index

export interface BuiltIndex {
  readonly bytes: Buffer;
  /** 64 hex digits of the bytes. */
  readonly digest: string;
  readonly mediaType: typeof OCI_INDEX_MEDIA_TYPE;
}

/**
 * The Rovara index: an OCI image index holding ONLY the given children, descriptors copied from upstream (digest, size and media type unchanged), and the three annotations. Fixed key order, no whitespace, children sorted
 * by platform name: the same inputs always give the same bytes.
 */
export function buildRepackIndex(input: { children: readonly SelectedChild[]; sourceReference: string; sourceDigest: string; repackedAt: string }): BuiltIndex {
  const children = [...input.children].sort((a, b) => (a.platformName < b.platformName ? -1 : a.platformName > b.platformName ? 1 : 0));
  const document = {
    schemaVersion: 2,
    mediaType: OCI_INDEX_MEDIA_TYPE,
    manifests: children.map((child) => ({
      mediaType: child.mediaType,
      digest: `sha256:${child.digest}`,
      size: child.size,
      platform: { architecture: child.platform.architecture, os: child.platform.os, ...(child.platform.variant === undefined ? {} : { variant: child.platform.variant }) },
    })),
    annotations: {
      [ANNOTATION_SOURCE_DIGEST]: `sha256:${input.sourceDigest}`,
      [ANNOTATION_SOURCE_REFERENCE]: input.sourceReference,
      [ANNOTATION_REPACK_TIME]: input.repackedAt,
    },
  };
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return { bytes, digest: hexOf(bytes), mediaType: OCI_INDEX_MEDIA_TYPE };
}

// ---- the run

export interface RepackOutput {
  readonly sources: { schemaVersion: 1; sources: Record<string, string> };
  readonly provenance: ProvenanceRecord;
  readonly sourcesBytes: Buffer;
  readonly provenanceBytes: Buffer;
}
export interface ProvenanceEntry {
  id: string;
  upstream: { reference: string; digest: string };
  rovara: { repository: string; reference: string; digest: string; tag: string };
  children: Array<{ platform: string; digest: string; mediaType: string; size: number }>;
  dropped: Array<{ digest: string; reason: DroppedReason }>;
}
export interface ProvenanceRecord { schemaVersion: 1; repackedAt: string; env: string; registry: string; entries: ProvenanceEntry[] }

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

interface Plan {
  readonly id: string;
  readonly sourceReference: string;
  readonly sourceRepository: string;
  readonly sourceDigest: string;
  readonly repositoryName: string;
  readonly selected: SelectedChild[];
  readonly dropped: DroppedManifest[];
}

/**
 * Repacks every non-retired entry of the catalog. Reads and writes only through the ports and returns the two files' bytes without writing them. Phase one is READ ONLY (every reference checked, every upstream index
 * read, hashed and its platforms picked): any refusal there throws before anything is copied or pushed, listing every refusal. Phase two copies, builds, pushes and verifies, entry by entry, and stops at the first refusal.
 */
export async function repackCatalog(input: { catalog: unknown; repack: unknown; env: string; registry: string; ports: RepackPorts }): Promise<RepackOutput> {
  const catalog = ServiceCatalogSchema.parse(input.catalog);
  const repack = RepackFileSchema.parse(input.repack);
  const registry = CatalogRegistryHostSchema.parse(input.registry);
  const { ports, env } = input;
  const entries = [...catalog.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const refusals: RepackRefusal[] = [];
  const refuse = (id: string, code: RepackRefusalCode, message: string): void => void refusals.push({ id, code, message });

  // ---- phase one: references (no I/O), then upstream indexes (read only)
  const byEntry = new Map(entries.map((entry) => [entry.id, entry]));
  for (const id of Object.keys(repack.entries).sort()) {
    if (!CatalogIdSchema.safeParse(id).success || !byEntry.has(id)) refuse(id, "unknown_id", "the repack file names an id the catalog does not have");
    else if (byEntry.get(id)?.status === "retired") refuse(id, "retired_entry", "a retired entry is not repacked");
  }
  const plans: Plan[] = [];
  for (const entry of entries) {
    if (entry.status === "retired") continue;
    const reference = repack.entries[entry.id];
    if (reference === undefined) {
      refuse(entry.id, "no_upstream", "the repack file has no upstream reference for this entry");
      continue;
    }
    if (!SourceRefSchema.safeParse(reference).success) {
      const digestOnly = /@sha256:[a-f0-9]{64}$/u.test(reference);
      if (digestOnly || !reference.includes("@")) refuse(entry.id, "tag_refused", "an upstream reference is host/path@sha256:<index digest>; a tag is refused (it names whatever upstream pushes next)");
      else refuse(entry.id, "bad_reference", "not a host/path@sha256:<64 hex digits> reference");
      continue;
    }
    plans.push({ id: entry.id, sourceReference: reference, sourceRepository: repositoryOfSource(reference), sourceDigest: digestOfSource(reference), repositoryName: catalogRepositoryName(env, entry.image.repository), selected: [], dropped: [] });
  }
  // A bad reference or a missing entry refuses the run before any registry is touched.
  if (refusals.length > 0) throw new RepackError(refusals);
  const planned: Plan[] = [];
  for (const plan of plans) {
    const entry = byEntry.get(plan.id);
    if (entry === undefined) continue;
    try {
      const bytes = await ports.registry.readManifest({ repository: plan.sourceRepository, digest: plan.sourceDigest });
      if (hexOf(bytes) !== plan.sourceDigest) {
        refuse(plan.id, "upstream_digest_mismatch", `the upstream served bytes that hash to ${hexOf(bytes).slice(0, 12)} where the repack file named ${plan.sourceDigest.slice(0, 12)}`);
        continue;
      }
      if (bytes.byteLength > INDEX_MAX_BYTES) {
        refuse(plan.id, "upstream_not_index", "the upstream manifest is too large");
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        refuse(plan.id, "upstream_not_index", "the upstream manifest is not JSON");
        continue;
      }
      const selection = selectPlatforms(parsed, entry.image.platforms);
      if (!selection.ok) {
        refuse(plan.id, selection.code, selection.problem);
        continue;
      }
      planned.push({ ...plan, selected: selection.selected, dropped: selection.dropped });
    } catch (error) {
      refuse(plan.id, "port_failed", error instanceof Error ? error.message.slice(0, 200) : "reading the upstream failed");
    }
  }
  if (refusals.length > 0) throw new RepackError(refusals);

  // ---- phase two: copy, build, push, verify
  const repackedAt = ports.clock.now();
  if (Number.isNaN(repackedAt.getTime())) throw new RepackError([{ id: "*", code: "port_failed", message: "the clock gave no valid time" }]);
  const time = repackedAt.toISOString();
  const provenanceEntries: ProvenanceEntry[] = [];
  const sources: Record<string, string> = {};
  for (const plan of planned) {
    const destination = `${registry}/${plan.repositoryName}`;
    try {
      // copy each child BY DIGEST and check the destination holds upstream's bytes
      for (const child of plan.selected) {
        await ports.registry.copyImage({ sourceRepository: plan.sourceRepository, destinationRepository: destination, digest: child.digest });
        const landed = await ports.registry.readManifest({ repository: destination, digest: child.digest });
        if (hexOf(landed) !== child.digest) {
          refuse(plan.id, "child_digest_changed", `${child.platformName}: the destination serves a manifest that hashes to ${hexOf(landed).slice(0, 12)} where upstream's digest is ${child.digest.slice(0, 12)}`);
          throw new RepackError(refusals);
        }
        if (landed.byteLength !== child.size) {
          refuse(plan.id, "child_digest_changed", `${child.platformName}: the destination serves ${String(landed.byteLength)} bytes where upstream's descriptor says ${String(child.size)}`);
          throw new RepackError(refusals);
        }
      }
      const built = buildRepackIndex({ children: plan.selected, sourceReference: plan.sourceReference, sourceDigest: plan.sourceDigest, repackedAt: time });
      const tag = tagFor(built.digest);
      await ports.indexes.push({ repository: destination, digest: built.digest, mediaType: built.mediaType, bytes: built.bytes, tag });
      // read it back by digest: the registry's bytes must be the ones built, must hash to the digest, and must list exactly upstream's children
      const served = Buffer.from(await ports.registry.readManifest({ repository: destination, digest: built.digest }));
      const verifyProblem = indexProblem(served, built, plan.selected);
      if (verifyProblem !== undefined) {
        refuse(plan.id, "index_verify_failed", verifyProblem);
        throw new RepackError(refusals);
      }
      if ((await ports.indexes.resolveTag({ repository: destination, tag })) !== `sha256:${built.digest}`) {
        refuse(plan.id, "tag_missing", `the tag ${tag} does not resolve to the pushed index (an untagged index is expired by the repository's lifecycle policy)`);
        throw new RepackError(refusals);
      }
      sources[plan.id] = `${destination}@sha256:${built.digest}`;
      provenanceEntries.push({
        id: plan.id,
        upstream: { reference: plan.sourceReference, digest: `sha256:${plan.sourceDigest}` },
        rovara: { repository: plan.repositoryName, reference: sources[plan.id] as string, digest: `sha256:${built.digest}`, tag },
        children: plan.selected.map((child) => ({ platform: child.platformName, digest: `sha256:${child.digest}`, mediaType: child.mediaType, size: child.size })),
        dropped: plan.dropped.map((item) => ({ digest: item.digest, reason: item.reason })),
      });
    } catch (error) {
      if (error instanceof RepackError) throw error;
      refuse(plan.id, "port_failed", error instanceof Error ? error.message.slice(0, 200) : "a step failed");
      throw new RepackError(refusals);
    }
  }
  const sortedSources = Object.fromEntries(Object.entries(sources).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const sourcesFile = { schemaVersion: 1 as const, sources: sortedSources };
  const provenance: ProvenanceRecord = { schemaVersion: 1, repackedAt: time, env, registry, entries: provenanceEntries.sort(byId) };
  return { sources: sourcesFile, provenance, sourcesBytes: jsonBytes(sourcesFile), provenanceBytes: jsonBytes(provenance) };
}

/** What is wrong with the index the registry serves, if anything: not the bytes built, not hashing to its digest, or not exactly upstream's selected children. */
function indexProblem(served: Buffer, built: BuiltIndex, selected: readonly SelectedChild[]): string | undefined {
  if (hexOf(served) !== built.digest) return `the registry serves bytes that hash to ${hexOf(served).slice(0, 12)} where the pushed index is ${built.digest.slice(0, 12)}`;
  if (Buffer.compare(served, built.bytes) !== 0) return "the registry serves other bytes than the index that was built";
  let parsed: { manifests?: Array<{ digest?: string; mediaType?: string; platform?: { os?: string; architecture?: string } }> };
  try {
    parsed = JSON.parse(served.toString("utf8")) as typeof parsed;
  } catch {
    return "the pushed index is not JSON";
  }
  const listed = (parsed.manifests ?? []).map((item) => `${item.platform?.os ?? "?"}/${item.platform?.architecture ?? "?"}=${item.digest ?? "?"}`).sort();
  const wanted = selected.map((child) => `${child.platformName}=sha256:${child.digest}`).sort();
  return listed.join(",") === wanted.join(",") ? undefined : `the pushed index lists ${listed.join(", ")} where upstream's children are ${wanted.join(", ")}`;
}

/** Repacks, then writes the provenance record and then the sources file (the file catalog-build reads) LAST. Nothing is written when anything was refused. */
export async function runRepack(input: { catalog: unknown; repack: unknown; env: string; registry: string; ports: RepackPorts; outputs: { sourcesFile: string; provenanceFile: string } }): Promise<RepackOutput> {
  const output = await repackCatalog(input);
  await input.ports.files.write([
    { path: input.outputs.provenanceFile, bytes: output.provenanceBytes },
    { path: input.outputs.sourcesFile, bytes: output.sourcesBytes },
  ]);
  return output;
}

// ---- real ports (built only by main)

/** skopeo reads and copies by digest. `copy` of one image manifest to a digest destination keeps the digest (`--preserve-digests`: no conversion). */
export function skopeoRegistryPort(input: { commands: CommandPort; authFile: string }): RegistryPort {
  return {
    async readManifest({ repository, digest }) {
      return input.commands.run("skopeo", ["inspect", "--raw", "--authfile", input.authFile, `docker://${repository}@sha256:${digest}`]);
    },
    async copyImage({ sourceRepository, destinationRepository, digest }) {
      await input.commands.run("skopeo", ["copy", "--preserve-digests", "--dest-authfile", input.authFile, `docker://${sourceRepository}@sha256:${digest}`, `docker://${destinationRepository}@sha256:${digest}`]);
    },
  };
}

/** oras pushes the index manifest by digest, tags it, and resolves a tag. The bytes go to the tool through a staged file (never a command line). */
export function orasIndexPort(input: { commands: CommandPort; authFile: string; stage: (bytes: Uint8Array) => Promise<{ path: string; cleanup: () => Promise<void> }> }): IndexPort {
  const resolveTag: IndexPort["resolveTag"] = async ({ repository, tag }) => {
    try {
      const resolved = (await input.commands.run("oras", ["resolve", "--registry-config", input.authFile, `${repository}:${tag}`])).toString("utf8").trim();
      return /^sha256:[a-f0-9]{64}$/u.test(resolved) ? resolved : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async push({ repository, digest, mediaType, bytes, tag }) {
      const staged = await input.stage(bytes);
      try {
        await input.commands.run("oras", ["manifest", "push", "--registry-config", input.authFile, "--media-type", mediaType, `${repository}@sha256:${digest}`, staged.path]);
      } finally {
        await staged.cleanup();
      }
      // The repositories have immutable tags, which may refuse even a same-digest re-tag on a retry: look first. Already this digest: nothing to do. Another digest: stop (the tag is never moved). Missing: tag.
      const existing = await resolveTag({ repository, tag });
      if (existing === `sha256:${digest}`) return;
      if (existing !== undefined) throw new Error(`the tag ${tag} already points at ${existing}, not at ${digest}`);
      await input.commands.run("oras", ["tag", "--registry-config", input.authFile, `${repository}@sha256:${digest}`, tag]);
    },
    resolveTag,
  };
}

async function writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, file);
}
export const fileOutputPort: OutputPort = {
  async write(files) {
    for (const file of files) await writeAtomic(resolve(file.path), file.bytes);
  },
};

// ---- command line

export function repackUsage(): string {
  return `Usage: tsx scripts/catalog-repack.ts --repack-file <file> --env <environment> --registry <host> --sources-out <file> --provenance-out <file> [--catalog-dir ${DEFAULT_CATALOG_DIR}] [--repack-time <ISO time>] [--overwrite] [--command-timeout-seconds ${String(DEFAULT_COMMAND_TIMEOUT_MS / 1000)}]
Run by an operator, with the owner's OK, on STAGING only: ~/.local/share/rovara-tools/staging-aws.sh npx tsx scripts/catalog-repack.ts ... (account 944937319445, us-west-2). Needs skopeo and oras (1.2.0 or newer, for
\`oras resolve\`) on PATH. Upstream images must be anonymously pullable (no upstream credential is used); Docker Hub limits anonymous pulls, so a run may stop on a rate limit: wait and retry (see --repack-time).
For each non-retired catalog entry it reads the upstream INDEX named in the repack file, checks its bytes hash to the digest the operator reviewed, picks exactly the catalog's platforms (linux/arm64 and linux/amd64; an
index without either is refused), copies those child manifests and blobs BY DIGEST into <host>/rovara-catalog/<environment>/<repository>, pushes a new OCI index holding only those children (annotations: source reference,
source digest, repack time) by digest, tags it with the first 32 digits of its digest, reads it back and checks it, then writes the provenance record and the sources file catalog-build reads (--sources).
The repack file is { "schemaVersion": 1, "entries": { "<catalog id>": "host/path@sha256:<upstream index digest>" } } with every non-retired entry listed. A tag is refused. Child digests are never changed.
The attestation manifests (unknown/unknown) in the upstream index are dropped and listed in the provenance record. Any refusal stops the run before the sources file is written.
The repack time is part of each index. RETRY an aborted run with the SAME --repack-time (the first run's time; use the one printed at its start): the indexes already pushed and tagged for completed entries are then
reused, not orphaned beside new ones, and the immutable tags are not touched again. Without --repack-time the time is now, so a new run makes new indexes.
The output directories must exist or be creatable and writable, the two output files must differ, and an existing sources or provenance file is not overwritten unless --overwrite is given.
Each skopeo and oras command is killed after --command-timeout-seconds.\n`;
}

export interface RepackArgs {
  repackFile: string;
  env: string;
  registry: string;
  sourcesOut: string;
  provenanceOut: string;
  catalogDir: string;
  repackTime: string | undefined;
  overwrite: boolean;
  commandTimeoutMs: number;
}
const VALUE_FLAGS = ["--repack-file", "--env", "--registry", "--sources-out", "--provenance-out", "--catalog-dir", "--repack-time", "--command-timeout-seconds"] as const;
const BOOLEAN_FLAGS = ["--overwrite", "--help"] as const;

/** Reads the command line. A flag it does not know, a flag given twice, a missing value, a bad time and identical output files are all errors (a typo must not be ignored). Paths are resolved. */
export function parseRepackArgs(argv: readonly string[]): RepackArgs {
  const found = new Map<string, string>();
  let overwrite = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if ((BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      if (arg === "--overwrite") overwrite = true;
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(arg)) throw new Error(`unknown argument ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (found.has(arg)) throw new Error(`${arg} is given twice`);
    found.set(arg, value);
    index += 1;
  }
  const need = (flag: string): string => {
    const value = found.get(flag);
    if (value === undefined) throw new Error("--repack-file, --env, --registry, --sources-out and --provenance-out are required");
    return value;
  };
  const repackTime = found.get("--repack-time");
  if (repackTime !== undefined && Number.isNaN(Date.parse(repackTime))) throw new Error("--repack-time is not a time");
  const seconds = Number(found.get("--command-timeout-seconds") ?? String(DEFAULT_COMMAND_TIMEOUT_MS / 1000));
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("--command-timeout-seconds is a positive whole number");
  const args: RepackArgs = {
    repackFile: resolve(need("--repack-file")),
    env: need("--env"),
    registry: need("--registry"),
    sourcesOut: resolve(need("--sources-out")),
    provenanceOut: resolve(need("--provenance-out")),
    catalogDir: resolve(found.get("--catalog-dir") ?? DEFAULT_CATALOG_DIR),
    repackTime,
    overwrite,
    commandTimeoutMs: seconds * 1000,
  };
  if (args.sourcesOut === args.provenanceOut) throw new Error("--sources-out and --provenance-out must be different files");
  CatalogRegistryHostSchema.parse(args.registry);
  catalogRepositoryName(args.env, "svc/check");
  return args;
}

/** The file system the output check needs (a seam for tests). */
export interface OutputCheckFs {
  exists(path: string): Promise<boolean>;
  /** Creates the directory when it is missing and throws when it cannot be written to. */
  ensureWritableDirectory(path: string): Promise<void>;
}
export const nodeOutputCheckFs: OutputCheckFs = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async ensureWritableDirectory(path) {
    await mkdir(path, { recursive: true });
    await access(path, constants.W_OK);
  },
};

/**
 * Checked BEFORE anything is copied or pushed, so a run cannot get through all the registry work and then fail at the write: both output directories exist (or are created) and are writable, and neither output
 * file exists unless `overwrite` is true (the sources file is what catalog-build reads, and the provenance record is the only record of what was repacked).
 */
export async function preflightOutputs(input: { sourcesFile: string; provenanceFile: string; overwrite: boolean }, fs: OutputCheckFs): Promise<void> {
  if (resolve(input.sourcesFile) === resolve(input.provenanceFile)) throw new Error("--sources-out and --provenance-out must be different files");
  for (const file of [input.sourcesFile, input.provenanceFile]) {
    try {
      await fs.ensureWritableDirectory(dirname(resolve(file)));
    } catch (error) {
      throw new Error(`the directory of ${file} does not exist and cannot be created, or is not writable${error instanceof Error ? ` (${error.message.slice(0, 120)})` : ""}`, { cause: error });
    }
  }
  if (!input.overwrite) {
    for (const file of [input.sourcesFile, input.provenanceFile]) {
      if (await fs.exists(file)) throw new Error(`${file} already exists; it is not overwritten unless --overwrite is given`);
    }
  }
}

/** Everything `main` checks before it asks for a credential or touches a registry: the command line and the outputs. */
export async function prepareRepackRun(argv: readonly string[], fs: OutputCheckFs): Promise<RepackArgs> {
  const args = parseRepackArgs(argv);
  await preflightOutputs({ sourcesFile: args.sourcesOut, provenanceFile: args.provenanceOut, overwrite: args.overwrite }, fs);
  return args;
}

async function main(argv: string[]): Promise<void> {
  const args = await prepareRepackRun(argv, nodeOutputCheckFs);
  const { registry, env, repackTime } = args;
  const runTime = repackTime === undefined ? new Date() : new Date(repackTime);
  process.stdout.write(`repack time ${runTime.toISOString()} (pass it as --repack-time to retry an aborted run)\n`);
  const { ECRClient, GetAuthorizationTokenCommand } = await import("@aws-sdk/client-ecr");
  const token = ((await new ECRClient({}).send(new GetAuthorizationTokenCommand({}))) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string }> }).authorizationData?.[0];
  if (token?.authorizationToken === undefined || token.proxyEndpoint === undefined || token.proxyEndpoint.replace(/^https:\/\//u, "") !== registry) throw new Error("ECR gave no credential for the registry named by --registry");
  // The credential goes to the tools in a 0600 file inside a 0700 directory, never on a command line.
  const workDir = await mkdtemp(join(tmpdir(), "rovara-catalog-repack-"));
  const authFile = join(workDir, "config.json");
  try {
    await writeFile(authFile, JSON.stringify({ auths: { [registry]: { auth: token.authorizationToken } } }), { mode: 0o600 });
    const commands = createCommandPort({ timeoutMs: args.commandTimeoutMs });
    let staged = 0;
    const output = await runRepack({
      catalog: JSON.parse(await readFile(join(args.catalogDir, CATALOG_FILE), "utf8")) as unknown,
      repack: JSON.parse(await readFile(args.repackFile, "utf8")) as unknown,
      env,
      registry,
      outputs: { sourcesFile: args.sourcesOut, provenanceFile: args.provenanceOut },
      ports: {
        registry: skopeoRegistryPort({ commands, authFile }),
        indexes: orasIndexPort({
          commands,
          authFile,
          stage: async (bytes) => {
            const path = join(workDir, `index-${String(staged++)}.json`);
            await writeFile(path, bytes, { mode: 0o600 });
            return { path, cleanup: () => rm(path, { force: true }) };
          },
        }),
        clock: { now: () => runTime },
        files: fileOutputPort,
      },
    });
    process.stdout.write(`repacked ${String(Object.keys(output.sources.sources).length)} images; sources: ${args.sourcesOut}; provenance: ${args.provenanceOut}\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(repackUsage());
  } else {
    main(argv).catch((error: unknown) => {
      process.stderr.write(`catalog repack failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
