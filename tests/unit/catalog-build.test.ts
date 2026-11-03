// Test services TS19: the catalog image pipeline (scripts/catalog-build.ts), run against fakes. Nothing here starts a process, opens a network connection or reads a credential.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CATALOG_FILE,
  CATALOG_SIGNATURE_FILE,
  PrepullListSchema,
  ServiceCatalogSchema,
  catalogPrepullList,
  loadSignedCatalog,
  sha256HexOf,
  verifyImageStatement,
  type SignedImageStatement,
} from "@agentx/contracts";
import {
  CatalogBuildError,
  buildPinnedCatalog,
  ecrScanPort,
  evidenceFolderOf,
  skopeoMirrorPort,
  syftSbomPort,
  writeCatalogBuild,
  type CatalogBuildPorts,
  type CommandPort,
  type MirrorResult,
  type ScanResult,
  type SourcesFile,
} from "../../scripts/catalog-build.js";
import { sha, testSigner, unpinnedCatalog } from "../support/catalog-pinning.js";

const catalog = unpinnedCatalog();
const live = catalog.entries.filter((entry) => entry.status !== "retired");
const sourceDigest = (id: string): string => sha(`source:${id}`);
const sources = (): SourcesFile => ({ schemaVersion: 1, sources: Object.fromEntries(live.map((entry) => [entry.id, `registry.example.com/library/${entry.family}@sha256:${sourceDigest(entry.id)}`])) });
const sbomDocument = (id: string): Buffer => Buffer.from(JSON.stringify({ spdxVersion: "SPDX-2.3", name: id, packages: [] }));

interface Calls { mirror: string[]; sbom: string[]; scan: string[]; sign: number }
function fakePorts(change: { mirror?: (id: string) => Partial<MirrorResult>; sbom?: (id: string) => Buffer; scan?: (id: string, digest: string) => Partial<ScanResult> } = {}) {
  const calls: Calls = { mirror: [], sbom: [], scan: [], sign: 0 };
  const signer = testSigner();
  const ports: CatalogBuildPorts = {
    async mirror({ id, source, expectedDigest, repositoryName }) {
      calls.mirror.push(`${id} ${source} -> ${repositoryName}`);
      return { digest: expectedDigest, platforms: ["linux/arm64", "linux/amd64"], ...change.mirror?.(id) };
    },
    async sbom({ id }) {
      calls.sbom.push(id);
      return change.sbom?.(id) ?? sbomDocument(id);
    },
    async scan({ id, digest }) {
      calls.scan.push(id);
      return { digest, status: "complete", criticalOpen: 0, highOpen: 2, scannedAt: "2026-11-02T10:00:00.000Z", ...change.scan?.(id, digest) };
    },
    signer: { publicKeyPem: signer.publicKeyPem, sign: async (message) => { calls.sign += 1; return signer.sign(message); } },
  };
  return { ports, calls, signer };
}
const build = (ports: CatalogBuildPorts, overrides: { catalog?: unknown; sources?: unknown } = {}) => buildPinnedCatalog({ catalog: overrides.catalog ?? catalog, sources: overrides.sources ?? sources(), env: "staging", ports });
const refusalsOf = async (promise: Promise<unknown>): Promise<Array<{ id: string; code: string }>> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CatalogBuildError) return error.refusals.map(({ id, code }) => ({ id, code }));
    throw error;
  }
  return [];
};

describe("pinning the catalog", () => {
  it("mirrors every entry by the source's digest into the environment's repository, and pins that digest with an SBOM hash and the scan", async () => {
    const { ports, calls, signer } = fakePorts();
    const output = await build(ports);
    expect(calls.mirror).toHaveLength(live.length);
    expect(calls.mirror).toContain(`postgres@16 registry.example.com/library/postgres@sha256:${sourceDigest("postgres@16")} -> rovara-catalog/staging/svc/postgres`);
    const pinned = ServiceCatalogSchema.parse(JSON.parse(output.catalogBytes.toString("utf8")));
    expect(pinned).toMatchObject({ pinned: true, revision: catalog.revision + 1 });
    for (const entry of pinned.entries) {
      expect(entry.image.digest, entry.id).toBe(sourceDigest(entry.id));
      expect(entry.sbomRef, entry.id).toBe(sha256HexOf(sbomDocument(entry.id)));
      expect(entry.scan, entry.id).toEqual({ scannedAt: "2026-11-02T10:00:00.000Z", criticalOpen: 0, highOpen: 2 });
    }
    // The file everything vouches for is signed, and loads as a pinned catalog.
    const loaded = loadSignedCatalog({ catalogBytes: output.catalogBytes, signatureBytes: output.signatureBytes, trustedKeys: [signer.publicKeyPem] });
    expect(loaded.ok && loaded.catalog.revision).toBe(catalog.revision + 1);
  });
  it("changes nothing in an entry but its pin (digest, SBOM, scan) and the file's revision and pinned flag", async () => {
    const { ports } = fakePorts();
    const pinned = ServiceCatalogSchema.parse(JSON.parse((await build(ports)).catalogBytes.toString("utf8")));
    for (const [index, entry] of pinned.entries.entries()) {
      const before = catalog.entries[index]!;
      expect({ ...entry, sbomRef: undefined, scan: undefined, image: { ...entry.image, digest: undefined } }).toEqual({ ...before, sbomRef: undefined, scan: undefined, image: { ...before.image, digest: undefined } });
    }
  });
  it("writes evidence for each image: its SBOM, scan and a signed statement that verifies for exactly that image", async () => {
    const { ports, signer } = fakePorts();
    const output = await build(ports);
    const folder = evidenceFolderOf("postgres@16");
    expect(folder).toBe("postgres-16");
    const files = new Map(output.evidence.map((item) => [item.path, item.bytes]));
    expect(files.size).toBe(live.length * 3);
    expect(files.get(`evidence/${folder}/sbom.json`)).toEqual(sbomDocument("postgres@16"));
    expect(JSON.parse(files.get(`evidence/${folder}/scan.json`)!.toString())).toEqual({ digest: sourceDigest("postgres@16"), status: "complete", criticalOpen: 0, highOpen: 2, scannedAt: "2026-11-02T10:00:00.000Z" });
    const signed = JSON.parse(files.get(`evidence/${folder}/statement.json`)!.toString()) as SignedImageStatement;
    expect(signed.statement).toEqual({ id: "postgres@16", repository: "svc/postgres", digest: sourceDigest("postgres@16"), sbomRef: sha256HexOf(sbomDocument("postgres@16")), scannedAt: "2026-11-02T10:00:00.000Z" });
    expect(verifyImageStatement({ signed, trustedKeys: [signer.publicKeyPem] }).ok).toBe(true);
    // The statement does not verify for another image's digest.
    expect(verifyImageStatement({ signed: { ...signed, statement: { ...signed.statement, digest: sourceDigest("mysql@8") } }, trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
  });
  it("makes the worker pre-pull list from the pinned catalog it just made", async () => {
    const { ports } = fakePorts();
    const output = await build(ports);
    const list = PrepullListSchema.parse(JSON.parse(output.prepullBytes.toString("utf8")));
    expect(list).toEqual(catalogPrepullList(output.catalog));
    expect(list.images.map((image) => image.id)).toContain("postgres@16");
    expect(list.images.find((image) => image.id === "postgres@16")!.digest).toBe(sourceDigest("postgres@16"));
  });
  it("keeps a retired entry as it was and does not mirror it", async () => {
    const withRetired = ServiceCatalogSchema.parse({ ...JSON.parse(JSON.stringify(catalog)), entries: catalog.entries.map((entry) => (entry.id === "redis@7" ? { ...entry, status: "retired" } : entry)) });
    const { ports, calls } = fakePorts();
    const src = sources();
    delete src.sources["redis@7"];
    const output = await build(ports, { catalog: withRetired, sources: src });
    expect(calls.mirror.some((call) => call.startsWith("redis@7"))).toBe(false);
    const redis = output.catalog.entries.find((entry) => entry.id === "redis@7")!;
    expect(redis.status).toBe("retired");
    expect(redis.image.digest).toBeUndefined();
  });
});

describe("what refuses a build (all of them: nothing is returned, so nothing can be written)", () => {
  it("a source that is a tag, has no digest, or names an id the catalog does not have", async () => {
    for (const ref of ["registry.example.com/library/postgres:16", "registry.example.com/library/postgres:16@sha256:" + sourceDigest("postgres@16"), "registry.example.com/library/postgres@sha256:abc", "postgres@sha256:" + sourceDigest("x"), "https://registry.example.com/library/postgres@sha256:" + sourceDigest("x")]) {
      const src = sources();
      src.sources["postgres@16"] = ref;
      await expect(build(fakePorts().ports, { sources: src }), ref).rejects.toThrow();
    }
    const extra = sources();
    extra.sources["mongo@7"] = `registry.example.com/library/mongo@sha256:${sourceDigest("mongo")}`;
    expect(await refusalsOf(build(fakePorts().ports, { sources: extra }))).toEqual([{ id: "mongo@7", code: "unknown_source" }]);
  });
  it("an entry with no source", async () => {
    const src = sources();
    delete src.sources["mysql@8"];
    expect(await refusalsOf(build(fakePorts().ports, { sources: src }))).toEqual([{ id: "mysql@8", code: "no_source" }]);
  });
  it("a digest mismatch: the registry serves other bytes than the source named", async () => {
    const { ports } = fakePorts({ mirror: (id) => (id === "postgres@16" ? { digest: sha("rebuilt") } : {}) });
    expect(await refusalsOf(build(ports))).toEqual([{ id: "postgres@16", code: "digest_mismatch" }]);
  });
  it("an image that lacks a platform the catalog lists, or has one it does not", async () => {
    expect(await refusalsOf(build(fakePorts({ mirror: (id) => (id === "mysql@8" ? { platforms: ["linux/amd64"] } : {}) }).ports))).toEqual([{ id: "mysql@8", code: "platforms_mismatch" }]);
    expect(await refusalsOf(build(fakePorts({ mirror: (id) => (id === "mysql@8" ? { platforms: ["linux/amd64", "linux/arm64", "linux/s390x"] } : {}) }).ports))).toEqual([{ id: "mysql@8", code: "platforms_mismatch" }]);
  });
  it("no SBOM, an SBOM that is not an SPDX or CycloneDX document, or an empty one", async () => {
    for (const bad of [Buffer.alloc(0), Buffer.from("not json"), Buffer.from("[]"), Buffer.from('{"hello":1}')]) {
      expect(await refusalsOf(build(fakePorts({ sbom: (id) => (id === "valkey@8" ? bad : sbomDocument(id)) }).ports))).toEqual([{ id: "valkey@8", code: "sbom_invalid" }]);
    }
    const cyclone = fakePorts({ sbom: (id) => Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", id })) });
    await expect(build(cyclone.ports)).resolves.toBeDefined();
  });
  it("the scan gate: a critical finding, an unfinished scan, an unsupported image, and a scan of another image", async () => {
    expect(await refusalsOf(build(fakePorts({ scan: (id) => (id === "postgres@17" ? { criticalOpen: 1 } : {}) }).ports))).toEqual([{ id: "postgres@17", code: "scan_critical" }]);
    for (const status of ["pending", "failed", "unsupported"] as const) {
      expect(await refusalsOf(build(fakePorts({ scan: (id) => (id === "postgres@17" ? { status } : {}) }).ports)), status).toEqual([{ id: "postgres@17", code: "scan_incomplete" }]);
    }
    expect(await refusalsOf(build(fakePorts({ scan: (id) => (id === "postgres@17" ? { digest: sha("another image") } : {}) }).ports))).toEqual([{ id: "postgres@17", code: "scan_not_for_image" }]);
    expect(await refusalsOf(build(fakePorts({ scan: (id) => (id === "postgres@17" ? { highOpen: -1 } : {}) }).ports))).toEqual([{ id: "postgres@17", code: "scan_incomplete" }]);
  });
  it("high findings do not refuse; they are recorded", async () => {
    const output = await build(fakePorts({ scan: () => ({ highOpen: 40 }) }).ports);
    expect(output.catalog.entries.every((entry) => entry.status === "retired" || entry.scan?.highOpen === 40)).toBe(true);
  });
  it("a failing port refuses that entry in words, and the rest are still tried (the operator sees every refusal at once)", async () => {
    const { ports } = fakePorts();
    const refused = await refusalsOf(build({ ...ports, mirror: async (input) => { if (input.id === "mysql@8" || input.id === "valkey@8") throw new Error("skopeo: unauthorized"); return ports.mirror(input); } }));
    expect(refused).toEqual([{ id: "mysql@8", code: "port_failed" }, { id: "valkey@8", code: "port_failed" }]);
  });
  it("a refusal anywhere means no pinned file at all: a half-pinned catalog cannot come out", async () => {
    let result: unknown;
    try {
      result = await build(fakePorts({ scan: (id) => (id === "dns-helper@r1" ? { criticalOpen: 3 } : {}) }).ports);
    } catch {
      result = undefined;
    }
    expect(result).toBeUndefined();
  });
  it("a signer whose key cannot be pinned (not an ECDSA P-256 public key) is refused before any image is touched", async () => {
    const { ports, calls } = fakePorts();
    await expect(build({ ...ports, signer: { publicKeyPem: "not a key", sign: (message) => ports.signer.sign(message) } })).rejects.toThrow();
    expect(calls.mirror).toEqual([]);
  });
  it("a signer that signs with a different key than it publishes is refused", async () => {
    const { ports } = fakePorts();
    const stranger = testSigner();
    expect(await refusalsOf(build({ ...ports, signer: { publicKeyPem: ports.signer.publicKeyPem, sign: (message) => stranger.sign(message) } }))).toContainEqual({ id: "postgres@16", code: "unsigned" });
  });
});

describe("writing a build", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  const temporary = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "catalog-build-test-")); dirs.push(dir); return dir; };

  it("writes the evidence, the pre-pull list, the signature and the catalog, and the catalog loads with the signature", async () => {
    const { ports, signer } = fakePorts();
    const output = await build(ports);
    const root = await temporary();
    await writeCatalogBuild(output, { catalogDir: join(root, "environments/service-catalog"), prepullFile: join(root, "packages/worker/service-catalog/prepull.json") });
    const loaded = loadSignedCatalog({
      catalogBytes: await readFile(join(root, "environments/service-catalog", CATALOG_FILE)),
      signatureBytes: await readFile(join(root, "environments/service-catalog", CATALOG_SIGNATURE_FILE)),
      trustedKeys: [signer.publicKeyPem],
    });
    expect(loaded.ok).toBe(true);
    expect((await readdir(join(root, "environments/service-catalog/evidence"))).sort()).toEqual(live.map((entry) => evidenceFolderOf(entry.id)).sort());
    expect(JSON.parse(await readFile(join(root, "packages/worker/service-catalog/prepull.json"), "utf8"))).toEqual(JSON.parse(output.prepullBytes.toString()));
    expect((await readdir(join(root, "environments/service-catalog"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("refuses an evidence path that leaves the evidence folder, before it writes the catalog", async () => {
    const { ports } = fakePorts();
    const output = await build(ports);
    const root = await temporary();
    await mkdir(join(root, "c"), { recursive: true });
    const good = output.evidence[0]!;
    // A good file comes first and a bad one second: nothing at all is written.
    await expect(writeCatalogBuild({ ...output, evidence: [good, { path: "evidence/../../outside.json", bytes: Buffer.from("x") }] }, { catalogDir: join(root, "c"), prepullFile: join(root, "p.json") })).rejects.toThrow();
    await expect(readFile(join(root, "c", CATALOG_FILE))).rejects.toThrow();
    await expect(readFile(join(root, "c", good.path))).rejects.toThrow();
    await expect(readFile(join(root, "p.json"))).rejects.toThrow();
    for (const bad of ["evidence/x/other.json", "/etc/passwd", "evidence/UPPER/sbom.json", "evidence/a/b/sbom.json", "outside/postgres-16/sbom.json"]) {
      await expect(writeCatalogBuild({ ...output, evidence: [{ path: bad, bytes: Buffer.from("x") }] }, { catalogDir: join(root, "c"), prepullFile: join(root, "p.json") }), bad).rejects.toThrow();
    }
    await writeFile(join(root, "keep"), "x");
  });
  it("makes an evidence folder name from any catalog id, and refuses two ids that would share one", async () => {
    expect(evidenceFolderOf("redis@7.2_a")).toBe("redis-7-2-a");
    const twin = ServiceCatalogSchema.parse({ ...JSON.parse(JSON.stringify(catalog)), entries: [...catalog.entries, { ...JSON.parse(JSON.stringify(catalog.entries.find((entry) => entry.id === "redis@7"))), id: "redis@7.0", status: "available" }, { ...JSON.parse(JSON.stringify(catalog.entries.find((entry) => entry.id === "redis@7"))), id: "redis@7-0", status: "available" }] });
    await expect(build(fakePorts().ports, { catalog: twin })).rejects.toThrow("same evidence folder");
  });
});

describe("the real ports (against fake commands and a fake ECR; nothing is run)", () => {
  const digest = sha("img");
  const indexManifest = Buffer.from(JSON.stringify({ manifests: [{ platform: { os: "linux", architecture: "arm64" } }, { platform: { os: "linux", architecture: "amd64" } }, { platform: { os: "unknown", architecture: "unknown" } }] }));
  function commands(raw: Buffer): { port: CommandPort; log: Array<{ file: string; args: readonly string[]; env?: Record<string, string> | undefined }> } {
    const log: Array<{ file: string; args: readonly string[]; env?: Record<string, string> | undefined }> = [];
    return { log, port: { run: async (file, args, options) => { log.push({ file, args, env: options?.env }); return args.includes("--raw") ? raw : Buffer.from("{}"); } } };
  }

  it("mirrors with every platform and the digests kept, a destination tag derived from the digest, and the credential in a file, never in an argument", async () => {
    const { port, log } = commands(indexManifest);
    const result = await skopeoMirrorPort({ commands: port, registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", authFile: "/tmp/auth/config.json" })({ id: "postgres@16", source: `registry.example.com/library/postgres@sha256:${digest}`, repositoryName: "rovara-catalog/staging/svc/postgres", expectedDigest: digest });
    expect(log[0]).toEqual({ file: "skopeo", args: ["copy", "--all", "--preserve-digests", "--dest-authfile", "/tmp/auth/config.json", `docker://registry.example.com/library/postgres@sha256:${digest}`, `docker://111122223333.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/postgres:${digest.slice(0, 32)}`], env: undefined });
    expect(log[1]!.args).toEqual(["inspect", "--raw", "--authfile", "/tmp/auth/config.json", `docker://111122223333.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/postgres@sha256:${digest}`]);
    // The digest is HASHED from the manifest bytes the destination served, not read from anything it said.
    expect(result).toEqual({ digest: sha256HexOf(indexManifest), platforms: ["linux/arm64", "linux/amd64"] });
    expect(JSON.stringify(log)).not.toMatch(/password|AWS:|Basic /u);
  });
  it("reads a single-platform image's platform from skopeo inspect", async () => {
    const single = Buffer.from(JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json" }));
    const log: string[][] = [];
    const port: CommandPort = { run: async (_file, args) => { log.push([...args]); return args.includes("--raw") ? single : Buffer.from(JSON.stringify({ Os: "linux", Architecture: "arm64" })); } };
    const result = await skopeoMirrorPort({ commands: port, registry: "r.example.com", authFile: "/a" })({ id: "x@1", source: "s.example.com/x@sha256:" + digest, repositoryName: "rovara-catalog/staging/svc/x", expectedDigest: digest });
    expect(result.platforms).toEqual(["linux/arm64"]);
    expect(log).toHaveLength(3);
  });
  it("runs syft on the registry copy by digest, with the credential directory in the environment", async () => {
    const { port, log } = commands(Buffer.from("{}"));
    await syftSbomPort({ commands: port, registry: "r.example.com", authDir: "/tmp/auth" })({ id: "postgres@16", repositoryName: "rovara-catalog/staging/svc/postgres", digest });
    expect(log[0]).toEqual({ file: "syft", args: [`registry:r.example.com/rovara-catalog/staging/svc/postgres@sha256:${digest}`, "-o", "spdx-json", "--quiet"], env: { DOCKER_CONFIG: "/tmp/auth" } });
  });

  class Describe { constructor(readonly input: { repositoryName: string; imageId: { imageDigest: string } }) {} }
  class Start { constructor(readonly input: { repositoryName: string; imageId: { imageDigest: string } }) {} }
  const scanWith = (responses: Array<Error | Record<string, unknown>>) => {
    const sent: unknown[] = [];
    const client = { send: async (command: unknown) => { sent.push(command); const next = responses.shift(); if (next instanceof Error) throw next; return next; } };
    return { sent, port: ecrScanPort({ client, commands: { DescribeImageScanFindingsCommand: Describe, StartImageScanCommand: Start }, sleep: async () => undefined, maxPolls: 4, now: () => new Date("2026-11-02T12:00:00.000Z") }) };
  };
  it("reads ECR's finished scan of the digest, counting critical and high findings", async () => {
    const { port, sent } = scanWith([{ imageScanStatus: { status: "COMPLETE" }, imageScanFindings: { imageScanCompletedAt: new Date("2026-11-02T09:00:00.000Z"), findingSeverityCounts: { CRITICAL: 1, HIGH: 4, MEDIUM: 9 } } }]);
    expect(await port({ id: "postgres@16", repositoryName: "rovara-catalog/staging/svc/postgres", digest })).toEqual({ digest, status: "complete", criticalOpen: 1, highOpen: 4, scannedAt: "2026-11-02T09:00:00.000Z" });
    expect((sent[0] as Describe).input).toEqual({ repositoryName: "rovara-catalog/staging/svc/postgres", imageId: { imageDigest: `sha256:${digest}` } });
  });
  it("starts a scan once when there is none, waits, and reads it", async () => {
    const notFound = Object.assign(new Error("none"), { name: "ScanNotFoundException" });
    const { port, sent } = scanWith([notFound, { imageScanStatus: { status: "IN_PROGRESS" } }, { imageScanStatus: { status: "COMPLETE" }, imageScanFindings: { findingSeverityCounts: {} } }]);
    const result = await port({ id: "x@1", repositoryName: "rovara-catalog/staging/svc/x", digest });
    expect(result).toMatchObject({ status: "complete", criticalOpen: 0, highOpen: 0, scannedAt: "2026-11-02T12:00:00.000Z" });
    expect(sent.filter((command) => command instanceof Start)).toHaveLength(1);
  });
  it("reports an unsupported or failed scan, and a scan that never finishes, as not complete (the gate then refuses)", async () => {
    expect((await scanWith([{ imageScanStatus: { status: "UNSUPPORTED_IMAGE" } }]).port({ id: "x@1", repositoryName: "r/x", digest })).status).toBe("unsupported");
    expect((await scanWith([{ imageScanStatus: { status: "FAILED" } }]).port({ id: "x@1", repositoryName: "r/x", digest })).status).toBe("failed");
    expect((await scanWith(Array.from({ length: 4 }, () => ({ imageScanStatus: { status: "IN_PROGRESS" } }))).port({ id: "x@1", repositoryName: "r/x", digest })).status).toBe("pending");
    await expect(scanWith([Object.assign(new Error("denied"), { name: "AccessDeniedException" })]).port({ id: "x@1", repositoryName: "r/x", digest })).rejects.toThrow("denied");
  });
});
