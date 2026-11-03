// Test services, TS19 (design test-services.md, sections 2.5, 5.3 and 5.5): the catalog image pipeline. An OPERATOR runs this to pin the catalog; no test and no CI job does.
//
// For every catalog entry that is not retired it:
//   1. MIRRORS the image into the install's registry BY DIGEST from the source named in the sources file (a digest reference; a tag is refused). The digest the registry then serves, hashed from the manifest bytes, must be
//      exactly the digest the source named, and the platforms the image holds must be exactly the entry's. Anything else refuses the build;
//   2. records an SBOM (its SHA-256 becomes the entry's `sbomRef`) and a SCAN of that digest. A scan that is not for that digest, did not finish, or shows a critical finding refuses the build (highs are recorded);
//   3. SIGNS a statement for the image (id, repository, digest, SBOM hash, scan time), and then the catalog file itself (behind a fixed prefix, see contracts `service-catalog-verify.ts`);
//   4. writes the pinned `catalog.json`, `catalog.sig.json`, the evidence folder and the worker pre-pull list. The pinned file must parse as a pinned catalog: a half-pinned file does not (contract), so a build that pinned
//      only some entries cannot write one. All outputs are made in memory first; nothing is written when any entry is refused, and the catalog file is written last, each file by rename.
//
// Everything outside the decision rules is a PORT (mirror, SBOM, scan, signer, files), so the whole pipeline runs against fakes. The real ports at the bottom use skopeo, syft and ECR/KMS through clients the caller passes in;
// they are only built by `main()`, which runs only when this file is the entry point. Nothing here is imported by the broker or the worker, and no secret is read: the registry credential is ECR's short token, kept in a 0600 file.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  CATALOG_FILE,
  CATALOG_MAX_BYTES,
  CATALOG_SIGNATURE_ALGORITHM,
  CATALOG_SIGNATURE_FILE,
  CatalogIdSchema,
  CatalogRegistryHostSchema,
  PrepullListSchema,
  ServiceCatalogSchema,
  catalogPrepullList,
  catalogRepositoryName,
  catalogSigningMessage,
  imageStatementMessage,
  parseBundlePublicKey,
  sha256HexOf,
  verifyCatalogSignature,
  verifyImageStatement,
  type CatalogEntry,
  type CatalogSignature,
  type ServiceCatalog,
  type SignedImageStatement,
} from "@agentx/contracts";
import { kmsBundleSigner, type BundleSigner } from "./release/bundle.js";

const execFileAsync = promisify(execFile);

export const SBOM_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CATALOG_DIR = "environments/service-catalog";
export const DEFAULT_PREPULL_FILE = "packages/worker/service-catalog/prepull.json";
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
export const SourcesFileSchema = z.object({ schemaVersion: z.literal(1), sources: z.record(CatalogIdSchema, SourceRefSchema) }).strict();
export type SourcesFile = z.infer<typeof SourcesFileSchema>;
const digestOfSource = (ref: string): string => ref.slice(ref.lastIndexOf("@sha256:") + "@sha256:".length);

// ---- ports

export interface MirrorResult {
  /** The digest of the manifest the DESTINATION serves, hashed from its bytes (never the registry's claim). */
  readonly digest: string;
  /** `linux/arm64`, `linux/amd64`: the platforms the mirrored image holds. */
  readonly platforms: readonly string[];
}
export interface ScanResult {
  /** The digest the scan was for: checked against the image being pinned. */
  readonly digest: string;
  readonly status: "complete" | "failed" | "unsupported" | "pending";
  readonly criticalOpen: number;
  readonly highOpen: number;
  readonly scannedAt: string;
}
export interface CatalogBuildPorts {
  mirror(input: { id: string; source: string; repositoryName: string; expectedDigest: string }): Promise<MirrorResult>;
  sbom(input: { id: string; repositoryName: string; digest: string }): Promise<Uint8Array>;
  scan(input: { id: string; repositoryName: string; digest: string }): Promise<ScanResult>;
  /** Signs bytes. `publicKeyPem` is the public half installers pin; the private half never leaves the signer (KMS). */
  readonly signer: BundleSigner;
}

export const BUILD_REFUSAL_CODES = ["no_source", "unknown_source", "digest_mismatch", "platforms_mismatch", "sbom_invalid", "scan_not_for_image", "scan_incomplete", "scan_critical", "port_failed", "unsigned"] as const;
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
  /** Files under the evidence folder, by path relative to it. */
  readonly evidence: ReadonlyArray<{ path: string; bytes: Buffer }>;
}

/** The folder name of one entry's evidence (`postgres@16` is `postgres-16`; ids are checked names, so this is a plain path segment). */
export const evidenceFolderOf = (id: string): string => CatalogIdSchema.parse(id).replace("@", "-").replace(/[._]/gu, "-").toLowerCase();

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
 */
export async function buildPinnedCatalog(input: { catalog: unknown; sources: unknown; env: string; ports: CatalogBuildPorts }): Promise<CatalogBuildOutput> {
  const current = ServiceCatalogSchema.parse(input.catalog);
  const sources = SourcesFileSchema.parse(input.sources);
  const { ports } = input;
  const refusals: Array<{ id: string; code: BuildRefusalCode; message: string }> = [];
  const refuse = (id: string, code: BuildRefusalCode, message: string): void => void refusals.push({ id, code, message });

  const ids = new Set(current.entries.map((entry) => entry.id));
  // Two ids must not share an evidence folder (`a@1.2` and `a@1-2` would).
  if (new Set(current.entries.map((entry) => evidenceFolderOf(entry.id))).size !== current.entries.length) throw new Error("two catalog ids make the same evidence folder");
  for (const id of Object.keys(sources.sources)) if (!ids.has(id)) refuse(id, "unknown_source", "the sources file names an id the catalog does not have");

  // The signer's own key must be one an installer can pin (an ECDSA P-256 public key); checked before any image is touched.
  const { keyId } = parseBundlePublicKey(ports.signer.publicKeyPem);

  const entries: CatalogEntry[] = [];
  const evidence: Array<{ path: string; bytes: Buffer }> = [];
  for (const entry of current.entries) {
    if (entry.status === "retired") {
      // A retired entry is not rebuilt; what the previous pin said stays (a pinned environment may still name it).
      entries.push(entry);
      continue;
    }
    const source = sources.sources[entry.id];
    if (source === undefined) {
      refuse(entry.id, "no_source", "the sources file has no source image for this entry");
      continue;
    }
    const expectedDigest = digestOfSource(source);
    const repositoryName = catalogRepositoryName(input.env, entry.image.repository);
    try {
      // 1. mirror, and check what the destination serves.
      const mirrored = await ports.mirror({ id: entry.id, source, repositoryName, expectedDigest });
      if (mirrored.digest !== expectedDigest) {
        refuse(entry.id, "digest_mismatch", `the registry serves ${mirrored.digest.slice(0, 12)} where the source named ${expectedDigest.slice(0, 12)}`);
        continue;
      }
      const held = [...new Set(mirrored.platforms)].sort().join(",");
      const wanted = [...entry.image.platforms].sort().join(",");
      if (held !== wanted) {
        refuse(entry.id, "platforms_mismatch", `the image holds ${held === "" ? "no platform" : held} where the catalog lists ${wanted}`);
        continue;
      }
      // 2. SBOM and scan.
      const sbom = await ports.sbom({ id: entry.id, repositoryName, digest: expectedDigest });
      if (!isSbom(sbom)) {
        refuse(entry.id, "sbom_invalid", "no SBOM was produced (an SPDX or CycloneDX JSON document is required)");
        continue;
      }
      const scan = await ports.scan({ id: entry.id, repositoryName, digest: expectedDigest });
      if (scan.digest !== expectedDigest) {
        refuse(entry.id, "scan_not_for_image", "the scan result is for another image");
        continue;
      }
      if (scan.status !== "complete" || !Number.isInteger(scan.criticalOpen) || !Number.isInteger(scan.highOpen) || scan.criticalOpen < 0 || scan.highOpen < 0 || Number.isNaN(Date.parse(scan.scannedAt))) {
        refuse(entry.id, "scan_incomplete", `the scan did not finish (${scan.status})`);
        continue;
      }
      if (scan.criticalOpen !== 0) {
        refuse(entry.id, "scan_critical", `${String(scan.criticalOpen)} critical finding${scan.criticalOpen === 1 ? "" : "s"} open`);
        continue;
      }
      const sbomRef = sha256HexOf(sbom);
      const scannedAt = new Date(scan.scannedAt).toISOString();
      // 3. the image's signed statement.
      const statement = { id: entry.id, repository: entry.image.repository, digest: expectedDigest, sbomRef, scannedAt };
      const signed: SignedImageStatement = { statement, keyId, signature: (await ports.signer.sign(imageStatementMessage(statement))).toString("base64") };
      const own = verifyImageStatement({ signed, trustedKeys: [ports.signer.publicKeyPem] });
      if (!own.ok) {
        refuse(entry.id, "unsigned", `the signer's signature does not verify against its own public key: ${own.reason}`);
        continue;
      }
      const folder = `${EVIDENCE_DIR}/${evidenceFolderOf(entry.id)}`;
      evidence.push(
        { path: `${folder}/sbom.json`, bytes: Buffer.from(sbom) },
        { path: `${folder}/scan.json`, bytes: jsonBytes({ digest: expectedDigest, status: scan.status, criticalOpen: scan.criticalOpen, highOpen: scan.highOpen, scannedAt }) },
        { path: `${folder}/statement.json`, bytes: jsonBytes(signed) },
      );
      entries.push({ ...entry, image: { ...entry.image, digest: expectedDigest }, sbomRef, scan: { scannedAt, criticalOpen: 0, highOpen: scan.highOpen } });
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
  const prepull = PrepullListSchema.parse(catalogPrepullList(pinned));
  return { catalog: pinned, catalogBytes, signatureBytes: jsonBytes(signature), prepullBytes: jsonBytes(prepull), evidence };
}

// ---- writing

/** Writes a file by rename, so a reader never sees half of it. */
async function writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o644 });
  await rename(temporary, file);
}

/** Writes a build: evidence first, then the pre-pull list, then the signature and then the catalog (the file everything else vouches for) last. Nothing is written when `output` is not complete. */
export async function writeCatalogBuild(output: CatalogBuildOutput, where: { catalogDir: string; prepullFile: string }): Promise<void> {
  const catalogDir = resolve(where.catalogDir);
  // Evidence paths were made from checked ids; every one is re-checked BEFORE anything is written, so none leaves the evidence folder and a bad one leaves no partial output.
  for (const item of output.evidence) {
    if (!/^evidence\/[a-z0-9][a-z0-9-]*\/(?:sbom|scan|statement)\.json$/u.test(item.path)) throw new Error(`unexpected evidence path ${item.path}`);
  }
  for (const item of output.evidence) await writeAtomic(join(catalogDir, item.path), item.bytes);
  await writeAtomic(resolve(where.prepullFile), output.prepullBytes);
  await writeAtomic(join(catalogDir, CATALOG_SIGNATURE_FILE), output.signatureBytes);
  await writeAtomic(join(catalogDir, CATALOG_FILE), output.catalogBytes);
}

// ---- real ports (built only by main)

export interface CommandPort {
  run(file: string, args: readonly string[], options?: { env?: Record<string, string> }): Promise<Buffer>;
}
export const execCommandPort: CommandPort = {
  async run(file, args, options) {
    const { stdout } = await execFileAsync(file, [...args], { encoding: "buffer", maxBuffer: SBOM_MAX_BYTES, env: { ...process.env, ...options?.env } });
    return stdout;
  },
};

/** `docker://<registry>/<repository>:<first 32 digits of the digest>`: the tag is a handle, derived from the digest, and immutable in the repository. */
const tagFor = (digest: string): string => digest.slice(0, 32);

/** skopeo copies every platform with the digests kept; the destination is then asked for the manifest BY DIGEST and the bytes are hashed here. */
export function skopeoMirrorPort(input: { commands: CommandPort; registry: string; authFile: string }): CatalogBuildPorts["mirror"] {
  return async ({ source, repositoryName, expectedDigest }) => {
    const destination = `${input.registry}/${repositoryName}`;
    await input.commands.run("skopeo", ["copy", "--all", "--preserve-digests", "--dest-authfile", input.authFile, `docker://${source}`, `docker://${destination}:${tagFor(expectedDigest)}`]);
    const byDigest = `docker://${destination}@sha256:${expectedDigest}`;
    const raw = await input.commands.run("skopeo", ["inspect", "--raw", "--authfile", input.authFile, byDigest]);
    const digest = createHash("sha256").update(raw).digest("hex");
    const manifest = JSON.parse(raw.toString("utf8")) as { manifests?: Array<{ platform?: { os?: string; architecture?: string } }> };
    if (Array.isArray(manifest.manifests)) {
      // An index: its platform entries, without the attestation manifests (`unknown/unknown`).
      const platforms = manifest.manifests.flatMap((item) => (item.platform?.os !== undefined && item.platform.architecture !== undefined && item.platform.os !== "unknown" ? [`${item.platform.os}/${item.platform.architecture}`] : []));
      return { digest, platforms };
    }
    const single = JSON.parse((await input.commands.run("skopeo", ["inspect", "--authfile", input.authFile, byDigest])).toString("utf8")) as { Os?: string; Architecture?: string };
    return { digest, platforms: single.Os !== undefined && single.Architecture !== undefined ? [`${single.Os}/${single.Architecture}`] : [] };
  };
}

/** syft reads the image from the registry (the same credential file, as a Docker config directory) and writes SPDX JSON. */
export function syftSbomPort(input: { commands: CommandPort; registry: string; authDir: string }): CatalogBuildPorts["sbom"] {
  return async ({ repositoryName, digest }) => input.commands.run("syft", [`registry:${input.registry}/${repositoryName}@sha256:${digest}`, "-o", "spdx-json", "--quiet"], { env: { DOCKER_CONFIG: input.authDir } });
}

export interface EcrLike {
  send(command: unknown): Promise<unknown>;
}
export interface EcrCommands {
  DescribeImageScanFindingsCommand: new (input: { repositoryName: string; imageId: { imageDigest: string } }) => unknown;
  StartImageScanCommand: new (input: { repositoryName: string; imageId: { imageDigest: string } }) => unknown;
}
/** ECR's own scan of the pushed digest (scan on push is on for the repository): started if there is none, then read until it finishes. */
export function ecrScanPort(input: { client: EcrLike; commands: EcrCommands; sleep?: (ms: number) => Promise<void>; maxPolls?: number; pollMs?: number; now?: () => Date }): CatalogBuildPorts["scan"] {
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
  return `Usage: tsx scripts/catalog-build.ts --sources <file> --env <environment> --registry <host> --kms-key <key id or ARN> [--catalog-dir ${DEFAULT_CATALOG_DIR}] [--prepull-file ${DEFAULT_PREPULL_FILE}]
Run by an operator with the pipeline's own AWS credentials. It mirrors each catalog image by digest into <host>/rovara-catalog/<environment>/..., records an SBOM and a scan, signs, and writes the pinned catalog.json,
catalog.sig.json, evidence/ and the worker pre-pull list. Nothing is written if any image is refused. Needs skopeo and syft on PATH.\n`;
}

async function main(argv: string[]): Promise<void> {
  const values = (flag: string): string[] => argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ""] : []));
  const [sourcesFile] = values("--sources");
  const [env] = values("--env");
  const [registry] = values("--registry");
  const [kmsKey] = values("--kms-key");
  const catalogDir = resolve(values("--catalog-dir")[0] ?? DEFAULT_CATALOG_DIR);
  const prepullFile = resolve(values("--prepull-file")[0] ?? DEFAULT_PREPULL_FILE);
  if (!sourcesFile || !env || !registry || !kmsKey) throw new Error("--sources, --env, --registry and --kms-key are required");
  CatalogRegistryHostSchema.parse(registry);
  catalogRepositoryName(env, "svc/check");
  const [{ ECRClient, GetAuthorizationTokenCommand, DescribeImageScanFindingsCommand, StartImageScanCommand }, { KMSClient, GetPublicKeyCommand, SignCommand }] = await Promise.all([import("@aws-sdk/client-ecr"), import("@aws-sdk/client-kms")]);
  const ecr = new ECRClient({});
  const token = ((await ecr.send(new GetAuthorizationTokenCommand({}))) as { authorizationData?: Array<{ authorizationToken?: string; proxyEndpoint?: string }> }).authorizationData?.[0];
  if (token?.authorizationToken === undefined || token.proxyEndpoint === undefined || token.proxyEndpoint.replace(/^https:\/\//u, "") !== registry) throw new Error("ECR gave no credential for the registry named by --registry");
  // The credential goes to the tools in a 0600 file inside a 0700 directory, never on a command line.
  const authDir = await mkdtemp(join(tmpdir(), "rovara-catalog-auth-"));
  const authFile = join(authDir, "config.json");
  try {
    await writeFile(authFile, JSON.stringify({ auths: { [registry]: { auth: token.authorizationToken } } }), { mode: 0o600 });
    const commands = execCommandPort;
    const signer = await kmsBundleSigner({ client: new KMSClient({}), keyId: kmsKey, commands: { GetPublicKeyCommand, SignCommand } });
    const output = await buildPinnedCatalog({
      catalog: JSON.parse(await readFile(join(catalogDir, CATALOG_FILE), "utf8")) as unknown,
      sources: JSON.parse(await readFile(resolve(sourcesFile), "utf8")) as unknown,
      env,
      ports: {
        mirror: skopeoMirrorPort({ commands, registry, authFile }),
        sbom: syftSbomPort({ commands, registry, authDir }),
        scan: ecrScanPort({ client: ecr, commands: { DescribeImageScanFindingsCommand, StartImageScanCommand } }),
        signer,
      },
    });
    await writeCatalogBuild(output, { catalogDir, prepullFile });
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
