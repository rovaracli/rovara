// Test services, TS19 (design test-services.md, sections 2.5, 5.3 and 5.5): the catalog image pipeline. An OPERATOR runs this to pin the catalog; no test and no CI job does.
//
// For every catalog entry that is not retired it:
//   1. MIRRORS the image into the install's registry BY DIGEST from the source named in the sources file (a digest reference; a tag is refused). The digest the registry then serves, hashed from the manifest bytes, must be
//      exactly the digest the source named, and the platforms the image holds must be exactly the entry's. The mirror also returns the CHILD manifest digest of each platform (read from the index the destination serves).
//      Anything else refuses the build;
//   2. for EACH PLATFORM (each child digest), records an SBOM (syft with `--platform`; its SHA-256 is that platform's `sbomRef`) and a SCAN (ECR scans image manifests, not indexes, so the scan is of the child digest). A
//      scan that is not for that child digest, did not finish, or shows a critical finding refuses the build, whichever platform it is (highs are recorded). A platform that is not complete with 0 critical findings pins
//      nothing: the workers are arm64 and the amd64 child must be as clean as the arm64 one. The SBOM and scan of an INDEX digest are never taken: they would describe one platform at most;
//   3. SIGNS a statement for the image (id, repository, the index digest, and for every platform its child digest, SBOM hash and scan time), and then the catalog file itself (behind a fixed prefix, see contracts
//      `service-catalog-verify.ts`). The catalog entry carries ONE `sbomRef` (the combined hash of the per-platform hashes, `combinedSbomRef`) and one scan (the OLDEST scan time, 0 critical, and the most highs any one
//      platform shows); the per-platform SBOMs, scans and hashes are in the evidence folder and the signed statement;
//   4. writes the pinned `catalog.json`, `catalog.sig.json`, the worker pre-pull list, and the evidence folder OUTSIDE the repository (`--evidence-dir`, required). The pinned file must parse as a pinned catalog: a half-pinned file does not (contract), so a build that pinned
//      only some entries cannot write one. (Slice 1: `--entries` pins chosen entries on purpose and carries the others over unpinned; the schema allows an entry that is not pinned YET, never a half-pinned one.) All outputs are made in memory first; nothing is written when any entry is refused, and the catalog file is written last, each file by rename.
//
// SOURCES must be Rovara-built multi-platform INDEXES (OCI image index or Docker manifest list) holding EXACTLY the platforms the catalog entry lists (`linux/arm64`, `linux/amd64`), by digest. A single-platform image is
// accepted only for an entry that lists that one platform (its platform is read from the config blob its manifest names, checked against that digest). An index with a platform the entry does not list, or without one it does, refuses the build. (Attestation manifests, `unknown/unknown`, are not platforms.)
//
// A ROVARA-BUILT source (slice 2, the emulator `local-aws` only): instead of a registry digest reference, a source can be `{ "kind": "rovara-built", "layout": "<OCI layout dir>", "digestFile": "<index.digest>" }`: the `image-result`
// artifact of the emulator fork's manual GitHub workflow (an UNSIGNED OCI layout and the digest of its index). Nothing is signed or trusted on GitHub; by owner decision this script is where the image is verified, scanned and signed:
//   a. the layout is read from disk first (`readBuiltSource`): the digest file is a sha256 digest, the layout holds exactly ONE image, that index, whose bytes hash to the digest file's digest, and each platform manifest it names is
//      present and hashes to its digest. The platforms must be exactly the entry's (linux/arm64) BEFORE anything is pushed;
//   b. the layout is pushed by that digest into `rovara-catalog/<env>/svc/<name>` (skopeo copy --all --preserve-digests), the digest the registry then serves must equal the artifact's, and the platforms it serves must be the layout's;
//   c. from there the path is the normal one: an SBOM and a scan per platform, a signature with Rovara's release KMS key. The artifact's own SBOMs and image scans are not trusted and not used;
//   d. EXCEPT the scan of the libraries compiled into the binaries (`javaScan`+`javaSbom`: grype on a CycloneDX list of the Java libraries; or the generic `libraryScan`+`librarySbom`: grype on syft's SPDX or CycloneDX SBOM, any language), because the registry's basic scan sees OS packages only. It is read before anything is pushed:
//      missing, unparseable or without a matches list refuses; any critical finding refuses; its high count is added to the entry's; its SHA-256 and counts are in the signed image statement and the file is kept as evidence/<id>/java-scan.json.
// A Rovara-built source for an entry that is not `emulated` is refused.
//
// Everything outside the decision rules is a PORT (mirror, SBOM, scan, signer, files), so the whole pipeline runs against fakes. The real ports at the bottom use skopeo, syft and ECR/KMS through clients the caller passes in;
// they are only built by `main()`, which runs only when this file is the entry point. Nothing here is imported by the broker or the worker, and no secret is read: the registry credential is ECR's short token, kept in a 0600 file.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { CATALOG_FILE, CATALOG_MAX_BYTES, CATALOG_SIGNATURE_ALGORITHM, CATALOG_SIGNATURE_FILE, CatalogIdSchema, CATALOG_PLATFORMS, CatalogRegistryHostSchema, PrepullListSchema, ServiceCatalogSchema, catalogPrepullList, catalogRepositoryName, catalogSigningMessage, combinedSbomRef, imageStatementMessage, parseBundlePublicKey, sha256HexOf, verifyCatalogSignature, verifyImageStatement, type CatalogEntry, type CatalogSignature, type ImageChildStatement, type ServiceCatalog, type SignedImageStatement } from "@rovara-code/contracts";
import { kmsBundleSigner, type BundleSigner } from "./release/bundle.js";
import { FUNCTION_RUNNER_PREPULL_FILE, functionRunnerPrepullList, withoutFunctionRunner } from "@agentx/cloud-contracts";

const execFileAsync = promisify(execFile);

export const SBOM_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CATALOG_DIR = "environments/service-catalog";
export const DEFAULT_PREPULL_FILE = "packages/worker/service-catalog/prepull.json";
export const DEFAULT_FUNCTION_RUNNER_PREPULL_FILE = FUNCTION_RUNNER_PREPULL_FILE;
export const EVIDENCE_DIR = "evidence";

// ---- the sources file

/**
 * A source image reference: `host[:port]/path@sha256:<hex>`. There is no tag in it: a tag names whatever the source's owner pushes next, a digest names bytes. (A `host/path:tag@sha256:...` form is refused as well:
 * the digest wins in a pull, but two names for one thing is how a reviewer misreads which image was meant.)
 */
export const SourceRefSchema = z
  .string()
  .max(400)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/u, "a source image is host/path@sha256:<digest>, never a tag");
/**
 * A Rovara-built source: the OCI layout directory, the file holding the index digest, the CycloneDX list of the Java libraries inside the binary (`sbom-<arch>/java-dependencies.cdx.json`) and the grype result on it (`scan-java-<arch>.json`), all from the fork's workflow artifact (`image-result`: `oci/`, `index.digest`). Relative paths are read from the sources file's
 * directory. A path may not hold `:` (skopeo's `oci:<dir>:<reference>` syntax), a newline or a NUL.
 */
const BuiltPathSchema = z.string().min(1).max(1024).regex(/^[^:\n\r\0]+$/u, "a path without ':' or line breaks");
// The embedded-library scan is ONE of two pairs, each a list of the libraries inside the binaries and a grype report over that list; a source with neither pair, a half pair or both pairs is refused, so a scan is never left out by accident.
//   - `javaScan` + `javaSbom`: the original form (the Java libraries compiled into the native binary; a CycloneDX list). Unchanged.
//   - `libraryScan` + `librarySbom`: the generic form, for any language (the AWS Emulator engine of catalog revision 4: a Go front process and a Rust engine). `librarySbom` is syft's SBOM of the image or binaries (SPDX JSON or CycloneDX
//     JSON); `libraryScan` is `grype sbom:<that file> -o json`. Same checks and the same gates as the Java pair: critical refuses, highs add to the entry's.
// Neither form can be waived: the registry's ECR scan is basic scanning (OS packages only) and the image SBOM is only hashed, so this is the only vulnerability scan of the libraries inside the binaries.
// `provenance` (optional): when the image was built in the public CI-only copy (rovaracli/rovara-local-aws, whose `snapshot/<12 hex>` branches are each a parentless snapshot of the private branch rovara/front), the two commit ids that link the build to the source:
// the public snapshot sha (the run's head sha, checked by scripts/verify-local-aws-run.sh) and the private commit it was cut from (checked by scripts/verify-local-aws-snapshot.sh). Kept as evidence/<id>/provenance.json.
export const BuiltProvenanceSchema = z.object({ privateSourceSha: z.string().regex(/^[0-9a-f]{40}$/u), publicSnapshotSha: z.string().regex(/^[0-9a-f]{40}$/u) }).strict();
export const BuiltSourceSchema = z.object({ kind: z.literal("rovara-built"), layout: BuiltPathSchema, digestFile: BuiltPathSchema, javaScan: BuiltPathSchema.optional(), javaSbom: BuiltPathSchema.optional(), libraryScan: BuiltPathSchema.optional(), librarySbom: BuiltPathSchema.optional(), provenance: BuiltProvenanceSchema.optional() }).strict()
  .refine((source) => {
    const java = [source.javaScan, source.javaSbom];
    const library = [source.libraryScan, source.librarySbom];
    const whole = (pair: Array<string | undefined>): boolean => pair.every((part) => part !== undefined);
    const empty = (pair: Array<string | undefined>): boolean => pair.every((part) => part === undefined);
    return (whole(java) && empty(library)) || (empty(java) && whole(library));
  }, "a Rovara-built source names exactly one embedded-library scan: both javaScan and javaSbom, or both libraryScan and librarySbom");
export type BuiltSource = z.infer<typeof BuiltSourceSchema>;
export const SourcesFileSchema = z.object({ schemaVersion: z.literal(1), sources: z.record(CatalogIdSchema, z.union([SourceRefSchema, BuiltSourceSchema])) }).strict();
export type SourcesFile = z.infer<typeof SourcesFileSchema>;
const digestOfSource = (ref: string): string => ref.slice(ref.lastIndexOf("@sha256:") + "@sha256:".length);

// ---- ports

/** One platform of a mirrored index: `linux/arm64` and the digest of that platform's own manifest. */
export interface MirroredChild {
  readonly platform: string;
  readonly digest: string;
}
export interface MirrorResult {
  /** The digest of the manifest the DESTINATION serves, hashed from its bytes (never the registry's claim). */
  readonly digest: string;
  /** Every platform the mirrored image holds, with its child manifest digest, read from the index the destination serves (a single-platform image is its own one child). */
  readonly children: readonly MirroredChild[];
}
export interface ScanResult {
  /** The digest the scan was for: checked against the child being pinned. */
  readonly digest: string;
  readonly status: "complete" | "failed" | "unsupported" | "pending";
  readonly criticalOpen: number;
  readonly highOpen: number;
  readonly scannedAt: string;
}
/** What the SBOM and scan ports are asked about: ONE platform's child manifest, never the index. */
export interface PlatformTarget {
  readonly id: string;
  readonly repositoryName: string;
  readonly platform: string;
  /** The child manifest digest of `platform`. */
  readonly digest: string;
}
/** What `readBuiltSource` found in a Rovara-built layout: the index digest (hex), the platforms the index names with their own manifest digests, and the layout's absolute path. */
/** A grype report over a list of the libraries inside the binaries, bound to that list: bytes and SHA-256 of both files and the counts. */
export interface EmbeddedScan { readonly bytes: Buffer; readonly sha256: string; readonly sbomBytes: Buffer; readonly sbomSha256: string; readonly criticalOpen: number; readonly highOpen: number }
export interface BuiltLayout {
  /** The scan of the Java libraries compiled into the native binary (the artifact's grype result), read here because the image scan cannot see them. `bytes` are kept as evidence; `sha256` goes in the signed statement. */
  readonly javaScan?: EmbeddedScan;
  /** The generic form of the same scan (`libraryScan` + `librarySbom`). Exactly one of the two is present. */
  readonly libraryScan?: EmbeddedScan;
  /** The source's `provenance`, passed through to the evidence. */
  readonly provenance?: z.infer<typeof BuiltProvenanceSchema>;
  readonly digest: string;
  readonly children: readonly MirroredChild[];
  readonly layoutPath: string;
}
export interface CatalogBuildPorts {
  /** `built` is set for a Rovara-built source: the layout (already verified by `readBuilt`) is pushed from disk, and `source` is only a label. */
  mirror: (input: { id: string; source: string; repositoryName: string; expectedDigest: string; built?: { layoutPath: string } }) => Promise<MirrorResult>;
  /** Reads and verifies a Rovara-built layout on disk (see `readBuiltSource`). Needed only when a selected source is Rovara-built; without it such a source is refused. */
  readBuilt?: (input: BuiltSource) => Promise<BuiltLayout>;
  sbom: (input: PlatformTarget) => Promise<Uint8Array>;
  scan: (input: PlatformTarget) => Promise<ScanResult>;
  /** Whether the environment's registry serves this digest of the repository now (an ECR describe-images by digest). A throw counts as "no". Asked only about pins an `--entries` build carries over. */
  registryServes: (input: { id: string; repositoryName: string; digest: string }) => Promise<boolean>;
  /** Signs bytes. `publicKeyPem` is the public half installers pin; the private half never leaves the signer (KMS). */
  readonly signer: BundleSigner;
}

/** A carried-over pin's recorded scan may be this old at most. */
export const CARRIED_PIN_MAX_SCAN_AGE_DAYS = 30;
export const BUILD_REFUSAL_CODES = ["no_source", "unknown_source", "digest_mismatch", "platforms_mismatch", "sbom_invalid", "scan_not_for_image", "scan_incomplete", "scan_critical", "port_failed", "unsigned", "unknown_entry", "retired_entry", "unselected_source", "carried_pin_missing", "carried_pin_stale", "built_source_not_allowed", "built_source_invalid", "worker_image_entry"] as const;
export type BuildRefusalCode = (typeof BUILD_REFUSAL_CODES)[number];
export class CatalogBuildError extends Error {
  constructor(readonly refusals: ReadonlyArray<{ id: string; code: BuildRefusalCode; message: string }>) {
    super(`the catalog was not pinned: ${refusals.map((refusal) => `${refusal.id}: ${refusal.message}`).join("; ")}`);
    this.name = "CatalogBuildError";
  }
}

export interface CatalogBuildOutput {
  readonly catalog: ServiceCatalog;
  readonly catalogBytes: Buffer;
  readonly signatureBytes: Buffer;
  readonly prepullBytes: Buffer;
  /** Slice 4: the function runner's pinned images (Lambda base images, the agent), kept OUT of `prepullBytes` (the services pre-pull) and read by the boot's own runner step. Empty until the runner entries are pinned. */
  readonly functionRunnerPrepullBytes: Buffer;
  /** Files under the evidence folder, by path relative to it. */
  readonly evidence: ReadonlyArray<{ path: string; bytes: Buffer }>;
}

/** The folder name of one entry's evidence (`postgres@16` is `postgres-16`; ids are checked names, so this is a plain path segment). */
export const evidenceFolderOf = (id: string): string => CatalogIdSchema.parse(id).replace("@", "-").replace(/[._]/gu, "-").toLowerCase();

/** The folder name of one platform inside an entry's evidence folder (`linux/arm64` is `linux-arm64`). */
export const platformSlugOf = (platform: string): string => platform.replace("/", "-");

/**
 * Whether the children the mirror reports are exactly the entry's platforms: each a platform the catalog knows, listed once, with a well-formed digest of its own (two platforms never share a manifest). A problem is
 * returned in words for the operator; nothing when the image is what the entry says it is.
 */
export function childrenProblem(children: readonly MirroredChild[], wanted: readonly string[]): string | undefined {
  const known: readonly string[] = CATALOG_PLATFORMS;
  const platforms = children.map((child) => child.platform);
  if (new Set(platforms).size !== platforms.length) return "the image lists a platform twice";
  if (platforms.some((platform) => !known.includes(platform))) return `the image holds a platform the catalog does not know (${platforms.filter((platform) => !known.includes(platform)).join(",")})`;
  if (children.some((child) => !/^[a-f0-9]{64}$/u.test(child.digest))) return "a platform's manifest digest is not a sha256 digest";
  if (new Set(children.map((child) => child.digest)).size !== children.length) return "two platforms share one manifest digest";
  const held = [...platforms].sort().join(",");
  const expected = [...wanted].sort().join(",");
  return held === expected ? undefined : `the image holds ${held === "" ? "no platform" : held} where the catalog lists ${expected}`;
}

const sameChildren = (left: readonly MirroredChild[], right: readonly MirroredChild[]): boolean => {
  const key = (children: readonly MirroredChild[]): string => children.map((child) => `${child.platform}=${child.digest}`).sort().join(",");
  return key(left) === key(right);
};

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

function isSbom(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > SBOM_MAX_BYTES) return false;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return typeof record["spdxVersion"] === "string" || record["bomFormat"] === "CycloneDX";
  } catch {
    return false;
  }
}

/**
 * Pins the catalog. Pure apart from the ports: it reads nothing and writes nothing. Throws `CatalogBuildError` listing every refused entry (all entries are tried, so an operator sees the whole list at once), and
 * returns outputs only when every non-retired entry is mirrored, scanned and signed.
 *
 * `entries` (slice 1, `--entries <ids>`): pins ONLY those entries, so one image can be pinned at a time. Every other entry is carried over exactly as the current file has it (an entry that was never pinned stays without
 * a digest, an SBOM and a scan, and nothing starts it; one that an earlier build pinned keeps that pin). The sources file must hold exactly the selected ids: a source for an entry that was not selected is a refusal, never
 * silently ignored. An id the catalog does not have, a retired id, and an empty or repeated list are refused. Left out, every non-retired entry is built, as before.
 *
 * A pin that is CARRIED OVER is part of a file this build signs again, so it is not signed blindly: the environment's registry must still serve its digest (`ports.registryServes`), and its recorded scan must be no
 * more than CARRIED_PIN_MAX_SCAN_AGE_DAYS old. Otherwise the build is refused, naming the entry: "re-run with --entries <id>".
 */
export async function buildPinnedCatalog(input: { catalog: unknown; sources: unknown; env: string; ports: CatalogBuildPorts; entries?: readonly string[]; now?: () => Date }): Promise<CatalogBuildOutput> {
  const current = ServiceCatalogSchema.parse(input.catalog);
  const sources = SourcesFileSchema.parse(input.sources);
  const { ports } = input;
  const refusals: Array<{ id: string; code: BuildRefusalCode; message: string }> = [];
  const refuse = (id: string, code: BuildRefusalCode, message: string): void => void refusals.push({ id, code, message });

  const ids = new Set(current.entries.map((entry) => entry.id));
  // Two ids must not share an evidence folder (`a@1.2` and `a@1-2` would).
  if (new Set(current.entries.map((entry) => evidenceFolderOf(entry.id))).size !== current.entries.length) throw new Error("two catalog ids make the same evidence folder");
  for (const id of Object.keys(sources.sources)) if (!ids.has(id)) refuse(id, "unknown_source", "the sources file names an id the catalog does not have");
  const selected = input.entries === undefined ? undefined : new Set(input.entries);
  if (input.entries !== undefined) {
    if (input.entries.length === 0) throw new Error("--entries needs at least one catalog id");
    if (selected!.size !== input.entries.length) throw new Error("--entries names an id twice");
    for (const id of input.entries) {
      if (!ids.has(id)) refuse(id, "unknown_entry", "--entries names an id the catalog does not have");
      else if (current.entries.find((entry) => entry.id === id)?.status === "retired") refuse(id, "retired_entry", "a retired entry is not pinned");
    }
    for (const id of Object.keys(sources.sources)) if (ids.has(id) && !selected!.has(id)) refuse(id, "unselected_source", "the sources file has a source for an entry that --entries did not select");
  }

  // The signer's own key must be one an installer can pin (an ECDSA P-256 public key); checked before any image is touched.
  const { keyId } = parseBundlePublicKey(ports.signer.publicKeyPem);

  const entries: CatalogEntry[] = [];
  const evidence: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of current.entries) {
    if (entry.workerImage === true) {
      // Slice 3: the fake server, the DNS helper and the test-account proxy run from the worker's own image: there is no image of theirs to mirror, scan or pin. They are carried over as they are; naming one (as a
      // selection or with a source) is refused, so nobody believes it was pinned.
      if (selected?.has(entry.id) === true || sources.sources[entry.id] !== undefined) refuse(entry.id, "worker_image_entry", "this helper runs from the worker's own image: it has no image to pin");
      entries.push(entry);
      continue;
    }
    if (entry.status === "retired") {
      // A retired entry is not rebuilt; what the previous pin said stays (a pinned environment may still name it).
      entries.push(entry);
      continue;
    }
    if (selected !== undefined && !selected.has(entry.id)) {
      // Not selected: carried over as it is (pinned stays pinned, unpinned stays unpinned). A carried pin is checked first (see above).
      entries.push(entry);
      if (entry.image.digest !== undefined) {
        const again = ` (re-run with --entries ${entry.id})`;
        const scannedAt = entry.scan === undefined ? Number.NaN : Date.parse(entry.scan.scannedAt);
        const age = (input.now ?? (() => new Date()))().getTime() - scannedAt;
        if (!(age <= CARRIED_PIN_MAX_SCAN_AGE_DAYS * 86_400_000)) {
          refuse(entry.id, "carried_pin_stale", `the recorded scan of the carried-over pin is more than ${String(CARRIED_PIN_MAX_SCAN_AGE_DAYS)} days old or has no date${again}`);
        } else if (!(await ports.registryServes({ id: entry.id, repositoryName: catalogRepositoryName(input.env, entry.image.repository), digest: entry.image.digest }).catch(() => false))) {
          refuse(entry.id, "carried_pin_missing", `the ${input.env} registry no longer serves the carried-over pin's digest${again}`);
        }
      }
      continue;
    }
    const source = sources.sources[entry.id];
    if (source === undefined) {
      refuse(entry.id, "no_source", "the sources file has no source image for this entry");
      continue;
    }
    const repositoryName = catalogRepositoryName(input.env, entry.image.repository);
    try {
      let expectedDigest: string;
      let sourceLabel: string;
      let built: BuiltLayout | undefined;
      if (typeof source === "string") {
        expectedDigest = digestOfSource(source);
        sourceLabel = source;
      } else {
        // A Rovara-built layout: only for the emulator, read and verified on disk before anything is pushed, and its platforms must already be the entry's.
        if (entry.backing !== "emulated") {
          refuse(entry.id, "built_source_not_allowed", "a Rovara-built source is only for an emulated entry (the emulator)");
          continue;
        }
        if (ports.readBuilt === undefined) {
          refuse(entry.id, "port_failed", "this build cannot read a Rovara-built source");
          continue;
        }
        try {
          built = await ports.readBuilt(source);
        } catch (error) {
          refuse(entry.id, "built_source_invalid", error instanceof Error ? error.message.slice(0, 200) : "the layout could not be read");
          continue;
        }
        const builtProblem = childrenProblem(built.children, entry.image.platforms);
        if (builtProblem !== undefined) {
          refuse(entry.id, "platforms_mismatch", `the layout: ${builtProblem}`);
          continue;
        }
        const embeddedCritical = (built.javaScan ?? built.libraryScan)?.criticalOpen ?? 0;
        if (embeddedCritical !== 0) {
          refuse(entry.id, "scan_critical", `embedded libraries: ${String(embeddedCritical)} critical finding${embeddedCritical === 1 ? "" : "s"} open in the artifact's scan`);
          continue;
        }
        expectedDigest = built.digest;
        sourceLabel = `rovara-built:sha256:${built.digest}`;
      }
      // 1. mirror, and check what the destination serves.
      const mirrored = await ports.mirror({ id: entry.id, source: sourceLabel, repositoryName, expectedDigest, ...(built === undefined ? {} : { built: { layoutPath: built.layoutPath } }) });
      if (mirrored.digest !== expectedDigest) {
        refuse(entry.id, "digest_mismatch", `the registry serves ${mirrored.digest.slice(0, 12)} where the source named ${expectedDigest.slice(0, 12)}`);
        continue;
      }
      if (built !== undefined && !sameChildren(built.children, mirrored.children)) {
        refuse(entry.id, "platforms_mismatch", "the registry serves other platform manifests than the layout holds");
        continue;
      }
      const childProblem = childrenProblem(mirrored.children, entry.image.platforms);
      if (childProblem !== undefined) {
        refuse(entry.id, "platforms_mismatch", childProblem);
        continue;
      }
      // 2. an SBOM and a scan for EACH platform's child manifest. Every platform is tried, so the operator sees every refusal of the entry at once.
      const children: ImageChildStatement[] = [];
      const platformEvidence: Array<{ path: string; bytes: Buffer }> = [];
      const folder = `${EVIDENCE_DIR}/${evidenceFolderOf(entry.id)}`;
      const highCounts: number[] = [];
      let platformRefused = false;
      for (const child of [...mirrored.children].sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0))) {
        const target: PlatformTarget = { id: entry.id, repositoryName, platform: child.platform, digest: child.digest };
        const sbom = await ports.sbom(target);
        if (!isSbom(sbom)) {
          refuse(entry.id, "sbom_invalid", `${child.platform}: no SBOM was produced (an SPDX or CycloneDX JSON document is required)`);
          platformRefused = true;
          continue;
        }
        const scan = await ports.scan(target);
        if (scan.digest !== child.digest) {
          refuse(entry.id, "scan_not_for_image", `${child.platform}: the scan result is for another image`);
          platformRefused = true;
          continue;
        }
        if (scan.status !== "complete" || !Number.isInteger(scan.criticalOpen) || !Number.isInteger(scan.highOpen) || scan.criticalOpen < 0 || scan.highOpen < 0 || Number.isNaN(Date.parse(scan.scannedAt))) {
          refuse(entry.id, "scan_incomplete", `${child.platform}: the scan did not finish (${scan.status})`);
          platformRefused = true;
          continue;
        }
        if (scan.criticalOpen !== 0) {
          refuse(entry.id, "scan_critical", `${child.platform}: ${String(scan.criticalOpen)} critical finding${scan.criticalOpen === 1 ? "" : "s"} open`);
          platformRefused = true;
          continue;
        }
        const scannedAt = new Date(scan.scannedAt).toISOString();
        const sbomRef = sha256HexOf(sbom);
        children.push({ platform: child.platform as ImageChildStatement["platform"], digest: child.digest, sbomRef, scannedAt });
        const platformFolder = `${folder}/${platformSlugOf(child.platform)}`;
        platformEvidence.push(
          { path: `${platformFolder}/sbom.json`, bytes: Buffer.from(sbom) },
          { path: `${platformFolder}/scan.json`, bytes: jsonBytes({ platform: child.platform, digest: child.digest, status: scan.status, criticalOpen: scan.criticalOpen, highOpen: scan.highOpen, scannedAt }) },
        );
        highCounts.push(scan.highOpen);
      }
      if (platformRefused) continue;
      const sbomRef = combinedSbomRef(children);
      const oldestScan = children.map((child) => child.scannedAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] as string;
      // A Rovara-built image's Java libraries are scanned apart (the image scan cannot see inside the binary): those highs add to the image's.
      const embedded = built === undefined ? undefined : built.javaScan ?? built.libraryScan;
      const highOpen = Math.max(...highCounts) + (embedded?.highOpen ?? 0);
      // 3. the image's signed statement: the index digest and every platform's child digest, SBOM hash and scan time, and for a Rovara-built image the hash and counts of the Java dependency scan.
      // Both forms of the embedded-library scan are recorded in the statement's `javaScan` field (owned by Code's contracts, which cannot say which form it was; the evidence file names do).
      const statement = { id: entry.id, repository: entry.image.repository, digest: expectedDigest, sbomRef, scannedAt: oldestScan, children, ...(embedded === undefined ? {} : { javaScan: { sha256: embedded.sha256, sbomSha256: embedded.sbomSha256, criticalOpen: 0 as const, highOpen: embedded.highOpen } }) };
      const signed: SignedImageStatement = { statement, keyId, signature: (await ports.signer.sign(imageStatementMessage(statement))).toString("base64") };
      const own = verifyImageStatement({ signed, trustedKeys: [ports.signer.publicKeyPem] });
      if (!own.ok) {
        refuse(entry.id, "unsigned", `the signer's signature does not verify against its own public key: ${own.reason}`);
        continue;
      }
      evidence.push(...platformEvidence, ...(embedded === undefined ? [] : [{ path: `${folder}/${built?.javaScan === undefined ? "library" : "java"}-scan.json`, bytes: embedded.bytes }, { path: `${folder}/${built?.javaScan === undefined ? "library" : "java"}-sbom.json`, bytes: embedded.sbomBytes }]), ...(built?.provenance === undefined ? [] : [{ path: `${folder}/provenance.json`, bytes: jsonBytes({ repository: "rovaracli/rovara-local-aws", ...built.provenance }) }]), { path: `${folder}/statement.json`, bytes: jsonBytes(signed) });
      entries.push({ ...entry, image: { ...entry.image, digest: expectedDigest }, sbomRef, scan: { scannedAt: oldestScan, criticalOpen: 0, highOpen } });
    } catch (error) {
      refuse(entry.id, "port_failed", error instanceof Error ? error.message.slice(0, 200) : "a step failed");
    }
  }
  if (refusals.length > 0) throw new CatalogBuildError(refusals);

  // 4. the pinned catalog. The schema is the half-pinned gate: it refuses a pinned file with any non-retired entry lacking a digest, an SBOM or a scan.
  const pinned = ServiceCatalogSchema.parse({ schemaVersion: current.schemaVersion, revision: current.revision + 1, pinned: true, entries });
  const catalogBytes = jsonBytes(pinned);
  if (catalogBytes.byteLength > CATALOG_MAX_BYTES) throw new CatalogBuildError([{ id: "*", code: "port_failed", message: "the pinned catalog is too large" }]);
  const signature: CatalogSignature = {
    schemaVersion: 1, algorithm: CATALOG_SIGNATURE_ALGORITHM, keyId, catalogSha256: sha256HexOf(catalogBytes),
    signature: (await ports.signer.sign(catalogSigningMessage(catalogBytes))).toString("base64"),
  };
  const own = verifyCatalogSignature({ catalogBytes, signature, trustedKeys: [ports.signer.publicKeyPem] });
  if (!own.ok) throw new CatalogBuildError([{ id: "*", code: "unsigned", message: `the signer's signature does not verify against its own public key: ${own.reason}` }]);
  // The vendored `catalogPrepullList` holds EVERY pinned local entry, which would put four Lambda base images in the services pre-pull: they go in their own list (function-runner-catalog.ts).
  const prepull = withoutFunctionRunner(PrepullListSchema.parse(catalogPrepullList(pinned)));
  const runnerPrepull = functionRunnerPrepullList(pinned);
  return { catalog: pinned, catalogBytes, signatureBytes: jsonBytes(signature), prepullBytes: jsonBytes(prepull), functionRunnerPrepullBytes: jsonBytes(runnerPrepull), evidence };
}

// ---- writing

/** Writes a file by rename, so a reader never sees half of it. */
async function writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, file);
}

/** The checkout this script lives in. The evidence folder must be outside it: SBOMs run to megabytes and must never be committed. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Throws when `directory` is the repository or inside it. */
export function assertOutsideRepo(directory: string, repoRoot: string = REPO_ROOT): void {
  const path = relative(repoRoot, resolve(directory));
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) throw new Error("--evidence-dir must be outside the repository (SBOMs are megabytes and are kept with the release evidence, not committed)");
}

/**
 * Writes a build: evidence first (into `evidenceDir`, laid out as `<evidenceDir>/<entry folder>/...`, outside the repository), then the pre-pull list, then the signature and then the catalog (the file everything else vouches for) last.
 * Nothing is written when `output` is not complete or `evidenceDir` is inside the repository.
 */
export async function writeCatalogBuild(output: CatalogBuildOutput, where: { catalogDir: string; prepullFile: string; evidenceDir: string; functionRunnerPrepullFile?: string }): Promise<void> {
  const catalogDir = resolve(where.catalogDir);
  const evidenceDir = resolve(where.evidenceDir);
  assertOutsideRepo(evidenceDir);
  // Evidence paths were made from checked ids; every one is re-checked BEFORE anything is written, so none leaves the evidence folder and a bad one leaves no partial output.
  for (const item of output.evidence) {
    if (!/^evidence\/[a-z0-9][a-z0-9-]*\/(?:statement\.json|provenance\.json|(?:java|library)-scan\.json|(?:java|library)-sbom\.json|linux-(?:arm64|amd64)\/(?:sbom|scan)\.json)$/u.test(item.path)) throw new Error(`unexpected evidence path ${item.path}`);
  }
  for (const item of output.evidence) await writeAtomic(join(evidenceDir, item.path.slice(`${EVIDENCE_DIR}/`.length)), item.bytes);
  await writeAtomic(resolve(where.prepullFile), output.prepullBytes);
  if (where.functionRunnerPrepullFile !== undefined) await writeAtomic(resolve(where.functionRunnerPrepullFile), output.functionRunnerPrepullBytes);
  await writeAtomic(join(catalogDir, CATALOG_SIGNATURE_FILE), output.signatureBytes);
  await writeAtomic(join(catalogDir, CATALOG_FILE), output.catalogBytes);
}

// ---- real ports (built only by main)

export interface CommandPort {
  run(file: string, args: readonly string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<Buffer>;
}
/** The longest one external command (skopeo, syft, oras) may run before it is killed. Per-command override: `options.timeoutMs`; per-port override: `createCommandPort`. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** The longest a COPY (skopeo copy of a whole image) or an SBOM (syft reading a whole image) may run: these move or read gigabytes, so they get 45 minutes; inspect and the other quick commands stay on the port's default. */
export const DEFAULT_COPY_TIMEOUT_MS = 45 * 60 * 1000;
/** The shape of the promisified `execFile` the command port uses (a seam, so a test can check the options without starting a process). */
export type ExecFileFn = (file: string, args: string[], options: { encoding: "buffer"; maxBuffer: number; env: NodeJS.ProcessEnv; timeout: number; killSignal: NodeJS.Signals }) => Promise<{ stdout: Buffer }>;
/** A command port that kills the child (SIGKILL) when it has run longer than its timeout, and says so in the error. Output and exit handling are `execFile`'s, as before. */
export function createCommandPort(input: { timeoutMs?: number; exec?: ExecFileFn } = {}): CommandPort {
  const exec: ExecFileFn = input.exec ?? ((file, args, options) => execFileAsync(file, args, options));
  const defaultTimeout = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return {
    async run(file, args, options) {
      const timeout = options?.timeoutMs ?? defaultTimeout;
      if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("a command timeout is a positive number of milliseconds");
      try {
        const { stdout } = await exec(file, [...args], { encoding: "buffer", maxBuffer: SBOM_MAX_BYTES, env: { ...process.env, ...options?.env }, timeout, killSignal: "SIGKILL" });
        return stdout;
      } catch (error) {
        if (typeof error === "object" && error !== null && (error as { killed?: unknown }).killed === true && (error as { code?: unknown }).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error(`${file} was killed after ${String(Math.round(timeout / 1000))} s (the command timeout)`, { cause: error });
        throw error;
      }
    },
  };
}
export const execCommandPort: CommandPort = createCommandPort();

/** `docker://<registry>/<repository>:<first 32 digits of the digest>`: the tag is a handle, derived from the digest, and immutable in the repository. */
export const tagFor = (digest: string): string => digest.slice(0, 32);

/**
 * skopeo copies every platform with the digests kept; the destination is then asked for the manifest BY DIGEST, the bytes are hashed here, and the child manifest digest of each platform is read from the index it served.
 * Attestation manifests (`unknown/unknown`) are not platforms and are left out.
 */
export function skopeoMirrorPort(input: { commands: CommandPort; registry: string; authFile: string; copyTimeoutMs?: number }): CatalogBuildPorts["mirror"] {
  return async ({ source, repositoryName, expectedDigest, built }) => {
    const destination = `${input.registry}/${repositoryName}`;
    // A Rovara-built layout is copied from disk (`oci:<dir>`: skopeo refuses a layout that holds more than one image, and `readBuiltSource` already checked that it holds exactly the one named by digest); everything after the copy is the same.
    const from = built === undefined ? `docker://${source}` : `oci:${built.layoutPath}`;
    // A registry source is read with the same auth file: repack leaves the source in the install's own private repository, which refuses an anonymous read.
    // The file holds only the install registry's credential, so a public source is still read anonymously. A layout on disk needs none.
    const sourceAuth = built === undefined ? ["--src-authfile", input.authFile] : [];
    await input.commands.run("skopeo", ["copy", "--all", "--preserve-digests", ...sourceAuth, "--dest-authfile", input.authFile, from, `docker://${destination}:${tagFor(expectedDigest)}`], { timeoutMs: input.copyTimeoutMs ?? DEFAULT_COPY_TIMEOUT_MS });
    const byDigest = `docker://${destination}@sha256:${expectedDigest}`;
    const raw = await input.commands.run("skopeo", ["inspect", "--raw", "--authfile", input.authFile, byDigest]);
    const digest = createHash("sha256").update(raw).digest("hex");
    const manifest = JSON.parse(raw.toString("utf8")) as { manifests?: Array<{ digest?: string; platform?: { os?: string; architecture?: string } }> };
    if (Array.isArray(manifest.manifests)) {
      // An index: its platform entries with their own manifest digests, without the attestation manifests.
      const children = manifest.manifests.flatMap((item) =>
        item.platform?.os !== undefined && item.platform.architecture !== undefined && item.platform.os !== "unknown" && /^sha256:[a-f0-9]{64}$/u.test(item.digest ?? "")
          ? [{ platform: `${item.platform.os}/${item.platform.architecture}`, digest: (item.digest as string).slice("sha256:".length) }]
          : [],
      );
      return { digest, children };
    }
    // A single-platform image is its own one child. Its platform comes from the CONFIG BLOB the hashed manifest names (`config.digest`), fetched raw and checked against that digest, never from a second, parsed
    // inspect of the registry (which could describe another image than the one whose bytes were hashed above).
    const configDigest = /^sha256:([a-f0-9]{64})$/u.exec((manifest as { config?: { digest?: string } }).config?.digest ?? "")?.[1];
    if (configDigest === undefined) return { digest, children: [] };
    const config = await input.commands.run("skopeo", ["inspect", "--raw", "--config", "--authfile", input.authFile, byDigest]);
    if (createHash("sha256").update(config).digest("hex") !== configDigest) throw new Error("the image config does not hash to the digest its manifest names");
    const { os, architecture } = JSON.parse(config.toString("utf8")) as { os?: string; architecture?: string };
    return { digest, children: typeof os === "string" && typeof architecture === "string" ? [{ platform: `${os}/${architecture}`, digest }] : [] };
  };
}

const OCI_INDEX_TYPES: readonly string[] = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
/** The most an index or a platform manifest read from a layout may be (they are a few hundred bytes; a layer is never read here). */
const BUILT_MANIFEST_MAX_BYTES = 1024 * 1024;

/** What the two forms of the embedded-library scan call their files in an operator's error message. */
interface ScanLabels { readonly scan: string; readonly list: string; readonly formats: "cyclonedx" | "cyclonedx-or-spdx" }
const JAVA_LABELS: ScanLabels = { scan: "the Java dependency scan file", list: "the Java dependency list", formats: "cyclonedx" };
const LIBRARY_LABELS: ScanLabels = { scan: "the library scan file", list: "the library SBOM", formats: "cyclonedx-or-spdx" };

/**
 * The components of a CycloneDX list (nested ones included), or, for the generic library form, of an SPDX JSON document (syft's `packages`, with the purls of their `externalRefs`): their purls and their `name`/`group:name` spellings with the version.
 */
function sbomComponents(bytes: Buffer, labels: ScanLabels = JAVA_LABELS): { purls: Set<string>; names: Set<string>; count: number } {
  let bom: { bomFormat?: unknown; components?: unknown; spdxVersion?: unknown; packages?: unknown } | null;
  try {
    bom = JSON.parse(bytes.toString("utf8")) as typeof bom;
  } catch {
    throw new Error(`${labels.list} is not JSON`);
  }
  if (labels.formats === "cyclonedx-or-spdx" && bom !== null && typeof bom === "object" && typeof bom.spdxVersion === "string" && bom.spdxVersion.startsWith("SPDX-") && Array.isArray(bom.packages)) {
    const purls = new Set<string>();
    const names = new Set<string>();
    let count = 0;
    for (const item of bom.packages as Array<{ name?: unknown; versionInfo?: unknown; externalRefs?: unknown } | null>) {
      if (item === null || typeof item !== "object") continue;
      count += 1;
      if (typeof item.name === "string" && typeof item.versionInfo === "string") names.add(`${item.name}@${item.versionInfo}`);
      if (Array.isArray(item.externalRefs)) for (const ref of item.externalRefs as Array<{ referenceType?: unknown; referenceLocator?: unknown } | null>) if (ref?.referenceType === "purl" && typeof ref.referenceLocator === "string") purls.add(ref.referenceLocator);
    }
    if (count === 0) throw new Error(`${labels.list} has no packages`);
    return { purls, names, count };
  }
  if (bom === null || typeof bom !== "object" || bom.bomFormat !== "CycloneDX" || !Array.isArray(bom.components)) throw new Error(labels.formats === "cyclonedx" ? `${labels.list} is not a CycloneDX document with components` : `${labels.list} is not an SPDX JSON or CycloneDX document with packages or components`);
  const purls = new Set<string>();
  const names = new Set<string>();
  let count = 0;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list as Array<{ name?: unknown; group?: unknown; version?: unknown; purl?: unknown; components?: unknown } | null>) {
      if (item === null || typeof item !== "object") continue;
      count += 1;
      if (typeof item.purl === "string") purls.add(item.purl);
      if (typeof item.name === "string" && typeof item.version === "string") {
        names.add(`${item.name}@${item.version}`);
        if (typeof item.group === "string" && item.group !== "") for (const joiner of [":", "/"]) names.add(`${item.group}${joiner}${item.name}@${item.version}`);
      }
      walk(item.components);
    }
  };
  walk(bom.components);
  if (count === 0) throw new Error(`${labels.list} has no components`);
  return { purls, names, count };
}

/**
 * The artifact's grype result on the Java dependency list, BOUND to the CycloneDX list that came with it. Missing, too large, not JSON, not grype's (`descriptor.name` must be "grype", so a generic `{"matches":[]}` is refused) or
 * without a `matches` list throws: no scan is not a clean scan. Every finding must name a package of that CycloneDX list (by purl, or by name and version), so a result for another list or another image is refused. Counts the matches by
 * severity (case-insensitive); a match with no readable severity is counted as critical, so a result this reader does not understand refuses and never passes.
 * LIMIT: grype's JSON does not carry a hash of the list it scanned, and a clean result (no findings) names nothing to bind to. For a clean result the only proof that grype ran on THIS list is the workflow's run log; the operator compares
 * the printed `descriptor` and `source` (see the operator commands) with the run's "Scan the Java libraries" step, as for the digest file. The statement records both files' SHA-256.
 */
async function readJavaScan(scanFile: string, sbomFile: string, labels: ScanLabels = JAVA_LABELS): Promise<EmbeddedScan> {
  const load = async (file: string, what: string): Promise<Buffer> => {
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new Error(`${what} is missing`);
    if (info.size > SBOM_MAX_BYTES) throw new Error(`${what} is too large`);
    return readFile(file);
  };
  const bytes = await load(scanFile, labels.scan);
  const sbomBytes = await load(sbomFile, labels === JAVA_LABELS ? "the Java dependency list (CycloneDX) file" : labels.list);
  const list = sbomComponents(sbomBytes, labels);
  let result: { matches?: unknown; descriptor?: { name?: unknown } | null } | null;
  try {
    result = JSON.parse(bytes.toString("utf8")) as typeof result;
  } catch {
    throw new Error(`${labels.scan} is not JSON`);
  }
  if (result === null || typeof result !== "object" || result.descriptor?.name !== "grype") throw new Error(`${labels.scan} is not a grype result (descriptor.name)`);
  if (!Array.isArray(result.matches)) throw new Error(`${labels.scan} has no matches list (not a grype result)`);
  let criticalOpen = 0;
  let highOpen = 0;
  for (const match of result.matches as Array<{ vulnerability?: { severity?: unknown }; artifact?: { name?: unknown; version?: unknown; purl?: unknown } } | null>) {
    const artifact = match?.artifact;
    const named = typeof artifact?.purl === "string" && list.purls.has(artifact.purl)
      || typeof artifact?.name === "string" && typeof artifact.version === "string" && list.names.has(`${artifact.name}@${artifact.version}`);
    if (!named) throw new Error(labels === JAVA_LABELS ? "a finding in the Java dependency scan names a package that is not in the CycloneDX list that came with it" : "a finding in the library scan names a package that is not in the SBOM that came with it");
    const raw = match?.vulnerability?.severity;
    const severity = typeof raw === "string" ? raw.toLowerCase() : undefined;
    if (severity === "high") highOpen += 1;
    else if (severity === undefined || !["negligible", "low", "medium", "unknown"].includes(severity)) criticalOpen += 1;
  }
  return { bytes, sha256: sha256HexOf(bytes), sbomBytes, sbomSha256: sha256HexOf(sbomBytes), criticalOpen, highOpen };
}

/**
 * Reads and VERIFIES a Rovara-built layout (the `image-result` artifact of the emulator workflow) before anything is pushed. Throws, in words for the operator, unless:
 *   - the digest file is one `sha256:<64 hex>` line;
 *   - `oci-layout` and `index.json` exist, and `index.json` names exactly ONE manifest, whose digest is the digest file's and which is an index;
 *   - that index's bytes (blobs/sha256/<hex>) hash to the digest, and each platform manifest it lists (attestation `unknown/unknown` entries are not platforms) is present and hashes to its own digest.
 * Layer blobs are not read: skopeo hashes them as it copies and the registry refuses a blob that does not match its digest. The platforms are returned; the caller compares them with the entry's.
 * `baseDir` is where a relative `layout` or `digestFile` is read from (the sources file's directory).
 */
export function readBuiltSource(input: { baseDir: string }): NonNullable<CatalogBuildPorts["readBuilt"]> {
  const place = (path: string): string => (isAbsolute(path) ? path : resolve(input.baseDir, path));
  const readSmall = async (file: string, what: string): Promise<Buffer> => {
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile()) throw new Error(`${what} is missing`);
    if (info.size > BUILT_MANIFEST_MAX_BYTES) throw new Error(`${what} is larger than ${String(BUILT_MANIFEST_MAX_BYTES)} bytes`);
    return readFile(file);
  };
  const parse = (bytes: Buffer, what: string): Record<string, unknown> => {
    try {
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* falls through */ }
    throw new Error(`${what} is not a JSON object`);
  };
  return async ({ layout, digestFile, javaScan, javaSbom, libraryScan, librarySbom, provenance }) => {
    const layoutPath = place(layout);
    // skopeo reads `oci:<path>:<reference>`: the RESOLVED path (a base directory can bring a colon) may not hold one, or a line break.
    if (/[:\n\r\0]/u.test(layoutPath)) throw new Error("the layout path (resolved) holds ':' or a line break; move the artifact to a plain folder");
    const javaScanBytes = javaScan !== undefined && javaSbom !== undefined ? await readJavaScan(place(javaScan), place(javaSbom)) : undefined;
    const libraryScanBytes = libraryScan !== undefined && librarySbom !== undefined ? await readJavaScan(place(libraryScan), place(librarySbom), LIBRARY_LABELS) : undefined;
    if ((javaScanBytes === undefined) === (libraryScanBytes === undefined)) throw new Error("the source must name exactly one embedded-library scan (javaScan and javaSbom, or libraryScan and librarySbom)");
    const digestText = (await readSmall(place(digestFile), "the digest file")).toString("utf8").trim();
    const wanted = /^sha256:([a-f0-9]{64})$/u.exec(digestText)?.[1];
    if (wanted === undefined) throw new Error("the digest file is not one sha256:<64 hex> digest");
    const marker = parse(await readSmall(join(layoutPath, "oci-layout"), "oci-layout"), "oci-layout");
    if (typeof marker["imageLayoutVersion"] !== "string" || !marker["imageLayoutVersion"].startsWith("1.")) throw new Error("oci-layout is not an OCI image layout version 1");
    const top = parse(await readSmall(join(layoutPath, "index.json"), "index.json"), "index.json")["manifests"];
    if (!Array.isArray(top) || top.length !== 1) throw new Error("the layout must hold exactly one image (index.json names " + String(Array.isArray(top) ? top.length : 0) + ")");
    const entry = top[0] as { digest?: unknown; mediaType?: unknown };
    if (entry.digest !== `sha256:${wanted}`) throw new Error("the layout's image is not the digest in the digest file");
    if (typeof entry.mediaType !== "string" || !OCI_INDEX_TYPES.includes(entry.mediaType)) throw new Error("the layout's image is not an image index");
    const blob = async (hex: string, what: string): Promise<Buffer> => {
      const bytes = await readSmall(join(layoutPath, "blobs", "sha256", hex), what);
      if (createHash("sha256").update(bytes).digest("hex") !== hex) throw new Error(`${what} does not hash to its digest`);
      return bytes;
    };
    const index = parse(await blob(wanted, "the image index"), "the image index");
    if (!Array.isArray(index["manifests"])) throw new Error("the image index lists no manifests");
    const children: MirroredChild[] = [];
    for (const item of index["manifests"] as Array<{ digest?: unknown; platform?: { os?: unknown; architecture?: unknown }; annotations?: Record<string, unknown> }>) {
      const os = item.platform?.os;
      const architecture = item.platform?.architecture;
      // Only BuildKit's attestation manifests (unknown/unknown, annotated as such) are not platforms; any other entry without a real platform is refused, not skipped.
      if (os === "unknown" && architecture === "unknown" && item.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") continue;
      if (typeof os !== "string" || typeof architecture !== "string" || os === "unknown" || architecture === "unknown") throw new Error("the image index holds an entry that is neither a platform nor a known attestation manifest");
      const hex = /^sha256:([a-f0-9]{64})$/u.exec(typeof item.digest === "string" ? item.digest : "")?.[1];
      if (hex === undefined) throw new Error(`the platform ${os}/${architecture} has no sha256 manifest digest`);
      await blob(hex, `the ${os}/${architecture} manifest`);
      children.push({ platform: `${os}/${architecture}`, digest: hex });
    }
    return { digest: wanted, children, layoutPath, ...(javaScanBytes === undefined ? {} : { javaScan: javaScanBytes }), ...(libraryScanBytes === undefined ? {} : { libraryScan: libraryScanBytes }), ...(provenance === undefined ? {} : { provenance }) };
  };
}

/** syft reads ONE platform's child manifest from the registry (`--platform`; the same credential file, as a Docker config directory) and writes SPDX JSON. */
export function syftSbomPort(input: { commands: CommandPort; registry: string; authDir: string; timeoutMs?: number }): CatalogBuildPorts["sbom"] {
  return async ({ repositoryName, digest, platform }) =>
    input.commands.run("syft", [`registry:${input.registry}/${repositoryName}@sha256:${digest}`, "--platform", platform, "-o", "spdx-json", "--quiet"], { env: { DOCKER_CONFIG: input.authDir }, timeoutMs: input.timeoutMs ?? DEFAULT_COPY_TIMEOUT_MS });
}

export interface EcrLike {
  send(command: unknown): Promise<unknown>;
}
export interface EcrCommands {
  DescribeImageScanFindingsCommand: new (input: { repositoryName: string; imageId: { imageDigest: string } }) => unknown;
  StartImageScanCommand: new (input: { repositoryName: string; imageId: { imageDigest: string } }) => unknown;
  DescribeImagesCommand: new (input: { repositoryName: string; imageIds: Array<{ imageDigest: string }> }) => unknown;
}
/** ECR's own scan of one pushed CHILD digest (ECR scans image manifests, not indexes; scan on push is on for the repository): started if there is none, then read until it finishes. */
/** `registryServes` over ECR: a describe-images by digest. The image not being there is "no"; any other failure throws (and the caller counts a throw as "no"). */
export function ecrServesPort(input: { client: EcrLike; commands: Pick<EcrCommands, "DescribeImagesCommand"> }): CatalogBuildPorts["registryServes"] {
  return async ({ repositoryName, digest }) => {
    try {
      const response = (await input.client.send(new input.commands.DescribeImagesCommand({ repositoryName, imageIds: [{ imageDigest: `sha256:${digest}` }] }))) as { imageDetails?: Array<{ imageDigest?: string }> };
      return (response.imageDetails ?? []).some((detail) => detail.imageDigest === `sha256:${digest}`);
    } catch (error) {
      if (error instanceof Error && (error.name === "ImageNotFoundException" || error.name === "RepositoryNotFoundException")) return false;
      throw error;
    }
  };
}

export function ecrScanPort(input: { client: EcrLike; commands: Pick<EcrCommands, "DescribeImageScanFindingsCommand" | "StartImageScanCommand">; sleep?: (ms: number) => Promise<void>; maxPolls?: number; pollMs?: number; now?: () => Date }): CatalogBuildPorts["scan"] {
  const sleep = input.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  return async ({ repositoryName, digest }) => {
    const imageId = { imageDigest: `sha256:${digest}` };
    type Findings = { imageScanStatus?: { status?: string }; imageScanFindings?: { imageScanCompletedAt?: Date | string; findingSeverityCounts?: Record<string, number> } };
    let started = false;
    for (let poll = 0; poll < (input.maxPolls ?? 60); poll += 1) {
      let response: Findings;
      try {
        response = (await input.client.send(new input.commands.DescribeImageScanFindingsCommand({ repositoryName, imageId }))) as Findings;
      } catch (error) {
        if (error instanceof Error && error.name === "ScanNotFoundException" && !started) {
          started = true;
          await input.client.send(new input.commands.StartImageScanCommand({ repositoryName, imageId }));
          await sleep(input.pollMs ?? 5_000);
          continue;
        }
        throw error;
      }
      const status = response.imageScanStatus?.status;
      if (status === "COMPLETE" || status === "ACTIVE") {
        const counts = response.imageScanFindings?.findingSeverityCounts ?? {};
        const at = response.imageScanFindings?.imageScanCompletedAt;
        return { digest, status: "complete", criticalOpen: counts["CRITICAL"] ?? 0, highOpen: counts["HIGH"] ?? 0, scannedAt: at === undefined ? (input.now ?? (() => new Date()))().toISOString() : new Date(at).toISOString() };
      }
      if (status === "FAILED" || status === "UNSUPPORTED_IMAGE" || status === "SCAN_ELIGIBILITY_EXPIRED" || status === "FINDINGS_UNAVAILABLE") {
        return { digest, status: status === "UNSUPPORTED_IMAGE" ? "unsupported" : "failed", criticalOpen: 0, highOpen: 0, scannedAt: (input.now ?? (() => new Date()))().toISOString() };
      }
      await sleep(input.pollMs ?? 5_000);
    }
    return { digest, status: "pending", criticalOpen: 0, highOpen: 0, scannedAt: (input.now ?? (() => new Date()))().toISOString() };
  };
}

// ---- command line

function usage(): string {
  return `Usage: tsx scripts/catalog-build.ts --sources <file> --env <environment> --registry <host> --kms-key <key id or ARN> [--entries <id,id,...>] --evidence-dir <folder outside the repository> [--catalog-dir ${DEFAULT_CATALOG_DIR}] [--prepull-file ${DEFAULT_PREPULL_FILE}] [--function-runner-prepull-file ${DEFAULT_FUNCTION_RUNNER_PREPULL_FILE}] [--command-timeout-seconds ${String(DEFAULT_COMMAND_TIMEOUT_MS / 1000)}] [--copy-timeout-seconds ${String(DEFAULT_COPY_TIMEOUT_MS / 1000)}]
Run by an operator with the pipeline's own AWS credentials. It mirrors each catalog image by digest into <host>/rovara-catalog/<environment>/..., records an SBOM and a scan for EACH PLATFORM, signs, and writes the
pinned catalog.json, catalog.sig.json and the worker pre-pull list into the repository, and the per-image evidence (SBOMs, scans, signed statements) into --evidence-dir, which is required and must be outside the repository. Nothing is written if any image is refused (a platform with a critical finding refuses the image). Needs skopeo and syft on PATH.
The sources file maps each catalog id to a digest reference (host/path@sha256:...), or, for the emulator only, to a Rovara-built layout:
{ "kind": "rovara-built", "layout": "<dir>/oci", "digestFile": "<dir>/index.digest", "javaScan": "<dir>/scan-java-arm64.json", "javaSbom": "<dir>/sbom-arm64/java-dependencies.cdx.json" } (the workflow artifact image-result, downloaded and unpacked; relative paths are read from the sources file's directory). javaScan and javaSbom are grype's scan of the Java libraries inside the binary and the CycloneDX list it scanned. An image from image/Containerfile.engine (AWS Emulator engine: Go and Rust) gives "libraryScan" and "librarySbom" instead (grype's report over syft's SPDX or CycloneDX SBOM). Exactly one pair; neither can be left out.
The layout is verified on disk, pushed by its digest, and the digest the registry serves must be the artifact's; the SBOM, the scan and the signature are this script's. Every source must be a Rovara-built multi-platform INDEX holding exactly the platforms the catalog lists for that id (a
single-platform image only for an id that lists that one platform); an index with another platform set is refused.
--entries pins only the listed catalog ids (comma-separated, for example postgres@16): the sources file must hold exactly those ids, and every other entry is carried over as it is (never pinned stays unpinned, and nothing starts it).
Each skopeo inspect is killed after --command-timeout-seconds; each skopeo copy and each syft run after --copy-timeout-seconds.\n`;
}

/** The value of `--entries`: catalog ids separated by commas (`postgres@16` or `postgres@16,mysql@8`), each a checked catalog id, none twice, none empty. Nothing given is nothing selected (every entry). Shared with catalog-repack. */
export function parseEntryIds(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",");
  for (const id of ids) {
    if (!CatalogIdSchema.safeParse(id).success) throw new Error("--entries is a comma-separated list of catalog ids, such as postgres@16");
  }
  if (new Set(ids).size !== ids.length) throw new Error("--entries names an id twice");
  return ids;
}

/** A timeout flag in whole seconds, or the default. Shared with catalog-repack. */
export function timeoutFlag(value: string | undefined, fallbackMs: number, flag: string): number {
  if (value === undefined) return fallbackMs;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error(`${flag} is a positive whole number of seconds`);
  return seconds * 1000;
}

async function main(argv: string[]): Promise<void> {
  const values = (flag: string): string[] => argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ""] : []));
  const [sourcesFile] = values("--sources");
  const [env] = values("--env");
  const [registry] = values("--registry");
  const [kmsKey] = values("--kms-key");
  if (values("--entries").length > 1) throw new Error("--entries is given twice");
  const entryIds = parseEntryIds(values("--entries")[0]);
  const catalogDir = resolve(values("--catalog-dir")[0] ?? DEFAULT_CATALOG_DIR);
  const prepullFile = resolve(values("--prepull-file")[0] ?? DEFAULT_PREPULL_FILE);
  const functionRunnerPrepullFile = resolve(values("--function-runner-prepull-file")[0] ?? DEFAULT_FUNCTION_RUNNER_PREPULL_FILE);
  if (values("--evidence-dir").length !== 1 || values("--evidence-dir")[0] === "") throw new Error("--evidence-dir is required (once): a folder outside the repository for the SBOMs, scans and statements");
  const evidenceDir = resolve(values("--evidence-dir")[0] as string);
  assertOutsideRepo(evidenceDir);
  if (!sourcesFile || !env || !registry || !kmsKey) throw new Error("--sources, --env, --registry and --kms-key are required");
  const commandTimeoutMs = timeoutFlag(values("--command-timeout-seconds")[0], DEFAULT_COMMAND_TIMEOUT_MS, "--command-timeout-seconds");
  const copyTimeoutMs = timeoutFlag(values("--copy-timeout-seconds")[0], DEFAULT_COPY_TIMEOUT_MS, "--copy-timeout-seconds");
  CatalogRegistryHostSchema.parse(registry);
  catalogRepositoryName(env, "svc/check");
  const [{ ECRClient, GetAuthorizationTokenCommand, DescribeImageScanFindingsCommand, StartImageScanCommand, DescribeImagesCommand }, { KMSClient, GetPublicKeyCommand, SignCommand }] = await Promise.all([import("@aws-sdk/client-ecr"), import("@aws-sdk/client-kms")]);
  const ecr = new ECRClient({});
  const token = ((await ecr.send(new GetAuthorizationTokenCommand({}))) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string }> }).authorizationData?.[0];
  if (token?.authorizationToken === undefined || token.proxyEndpoint === undefined || token.proxyEndpoint.replace(/^https:\/\//u, "") !== registry) throw new Error("ECR gave no credential for the registry named by --registry");
  // The credential goes to the tools in a 0600 file inside a 0700 directory, never on a command line.
  const authDir = await mkdtemp(join(tmpdir(), "rovara-catalog-auth-"));
  const authFile = join(authDir, "config.json");
  try {
    await writeFile(authFile, JSON.stringify({ auths: { [registry]: { auth: token.authorizationToken } } }), { mode: 0o600 });
    const commands = createCommandPort({ timeoutMs: commandTimeoutMs });
    const signer = await kmsBundleSigner({ client: new KMSClient({}), keyId: kmsKey, commands: { GetPublicKeyCommand, SignCommand } });
    const output = await buildPinnedCatalog({
      catalog: JSON.parse(await readFile(join(catalogDir, CATALOG_FILE), "utf8")) as unknown,
      sources: JSON.parse(await readFile(resolve(sourcesFile), "utf8")) as unknown,
      env,
      ...(entryIds === undefined ? {} : { entries: entryIds }),
      ports: {
        mirror: skopeoMirrorPort({ commands, registry, authFile, copyTimeoutMs }),
        readBuilt: readBuiltSource({ baseDir: dirname(resolve(sourcesFile)) }),
        sbom: syftSbomPort({ commands, registry, authDir, timeoutMs: copyTimeoutMs }),
        scan: ecrScanPort({ client: ecr, commands: { DescribeImageScanFindingsCommand, StartImageScanCommand } }),
        registryServes: ecrServesPort({ client: ecr, commands: { DescribeImagesCommand } }),
        signer,
      },
    });
    await writeCatalogBuild(output, { catalogDir, prepullFile, evidenceDir, functionRunnerPrepullFile });
    process.stdout.write(`pinned catalog revision ${String(output.catalog.revision)}: ${String(output.catalog.entries.filter((entry) => entry.image.digest !== undefined).length)} images\n`);
  } finally {
    await rm(authDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length === 0) {
    process.stdout.write(usage());
  } else {
    main(argv).catch((error: unknown) => {
      process.stderr.write(`catalog build failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
