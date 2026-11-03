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
  combinedSbomRef,
  loadSignedCatalog,
  sha256HexOf,
  verifyImageStatement,
  type SignedImageStatement,
} from "@agentx/contracts";
import {
  CatalogBuildError,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_COPY_TIMEOUT_MS,
  timeoutFlag,
  createCommandPort,
  execCommandPort,
  type ExecFileFn,
  buildPinnedCatalog,
  ecrScanPort,
  childrenProblem,
  evidenceFolderOf,
  platformSlugOf,
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
const PLATFORMS = ["linux/arm64", "linux/amd64"] as const;
/** The child manifest digest of one platform of an image: not the index digest, and different per platform. */
const childDigest = (id: string, platform: string): string => sha(`child:${id}:${platform}`);
const sbomDocument = (id: string, platform: string): Buffer => Buffer.from(JSON.stringify({ spdxVersion: "SPDX-2.3", name: `${id} ${platform}`, packages: [] }));

interface Calls { mirror: string[]; sbom: string[]; scan: string[]; sign: number }
interface FakeChanges {
  mirror?: (id: string) => Partial<MirrorResult>;
  sbom?: (id: string, platform: string) => Buffer | undefined;
  scan?: (id: string, platform: string, digest: string) => Partial<ScanResult>;
}
function fakePorts(change: FakeChanges = {}) {
  const calls: Calls = { mirror: [], sbom: [], scan: [], sign: 0 };
  const signer = testSigner();
  const ports: CatalogBuildPorts = {
    async mirror({ id, source, expectedDigest, repositoryName }) {
      calls.mirror.push(`${id} ${source} -> ${repositoryName}`);
      return { digest: expectedDigest, children: PLATFORMS.map((platform) => ({ platform, digest: childDigest(id, platform) })), ...change.mirror?.(id) };
    },
    async sbom({ id, platform, digest }) {
      calls.sbom.push(`${id} ${platform} ${digest}`);
      return change.sbom?.(id, platform) ?? sbomDocument(id, platform);
    },
    async scan({ id, platform, digest }) {
      calls.scan.push(`${id} ${platform} ${digest}`);
      return { digest, status: "complete", criticalOpen: 0, highOpen: 2, scannedAt: "2026-11-02T10:00:00.000Z", ...change.scan?.(id, platform, digest) };
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
      // One SBOM hash per entry in the catalog: the combined hash of its platforms' SBOM hashes (each platform's own is in the evidence and the signed statement).
      expect(entry.sbomRef, entry.id).toBe(combinedSbomRef(PLATFORMS.map((platform) => ({ platform, sbomRef: sha256HexOf(sbomDocument(entry.id, platform)) }))));
      expect(entry.scan, entry.id).toEqual({ scannedAt: "2026-11-02T10:00:00.000Z", criticalOpen: 0, highOpen: 2 });
    }
    // The file everything vouches for is signed, and loads as a pinned catalog.
    const loaded = loadSignedCatalog({ catalogBytes: output.catalogBytes, signatureBytes: output.signatureBytes, trustedKeys: [signer.publicKeyPem] });
    expect(loaded.ok && loaded.catalog.revision).toBe(catalog.revision + 1);
  });
  it("takes the SBOM and the scan of EACH platform's child manifest, never of the index", async () => {
    const { ports, calls } = fakePorts();
    await build(ports);
    expect(calls.sbom).toHaveLength(live.length * 2);
    expect(calls.scan).toHaveLength(live.length * 2);
    for (const entry of live) {
      for (const platform of PLATFORMS) {
        expect(calls.sbom, `${entry.id} ${platform}`).toContain(`${entry.id} ${platform} ${childDigest(entry.id, platform)}`);
        expect(calls.scan, `${entry.id} ${platform}`).toContain(`${entry.id} ${platform} ${childDigest(entry.id, platform)}`);
      }
      expect(calls.sbom.some((call) => call.endsWith(sourceDigest(entry.id)))).toBe(false);
      expect(calls.scan.some((call) => call.endsWith(sourceDigest(entry.id)))).toBe(false);
    }
  });
  it("records the oldest scan time and the most highs any one platform shows in the catalog entry, and each platform's own result in the evidence", async () => {
    const { ports } = fakePorts({
      scan: (id, platform) => (id === "postgres@16" ? (platform === "linux/arm64" ? { highOpen: 2, scannedAt: "2026-11-02T10:00:00.000Z" } : { highOpen: 7, scannedAt: "2026-11-02T08:00:00.000Z" }) : {}),
    });
    const output = await build(ports);
    expect(output.catalog.entries.find((entry) => entry.id === "postgres@16")!.scan).toEqual({ scannedAt: "2026-11-02T08:00:00.000Z", criticalOpen: 0, highOpen: 7 });
    const files = new Map(output.evidence.map((item) => [item.path, item.bytes]));
    expect(JSON.parse(files.get("evidence/postgres-16/linux-arm64/scan.json")!.toString())).toEqual({ platform: "linux/arm64", digest: childDigest("postgres@16", "linux/arm64"), status: "complete", criticalOpen: 0, highOpen: 2, scannedAt: "2026-11-02T10:00:00.000Z" });
    expect(JSON.parse(files.get("evidence/postgres-16/linux-amd64/scan.json")!.toString())).toEqual({ platform: "linux/amd64", digest: childDigest("postgres@16", "linux/amd64"), status: "complete", criticalOpen: 0, highOpen: 7, scannedAt: "2026-11-02T08:00:00.000Z" });
  });
  it("changes nothing in an entry but its pin (digest, SBOM, scan) and the file's revision and pinned flag", async () => {
    const { ports } = fakePorts();
    const pinned = ServiceCatalogSchema.parse(JSON.parse((await build(ports)).catalogBytes.toString("utf8")));
    for (const [index, entry] of pinned.entries.entries()) {
      const before = catalog.entries[index]!;
      expect({ ...entry, sbomRef: undefined, scan: undefined, image: { ...entry.image, digest: undefined } }).toEqual({ ...before, sbomRef: undefined, scan: undefined, image: { ...before.image, digest: undefined } });
    }
  });
  it("writes evidence for each image: each platform's SBOM and scan, and a signed statement that lists the child digests and verifies for exactly that image", async () => {
    const { ports, signer } = fakePorts();
    const output = await build(ports);
    const folder = evidenceFolderOf("postgres@16");
    expect(folder).toBe("postgres-16");
    expect(platformSlugOf("linux/arm64")).toBe("linux-arm64");
    const files = new Map(output.evidence.map((item) => [item.path, item.bytes]));
    expect(files.size).toBe(live.length * 5);
    for (const platform of PLATFORMS) {
      expect(files.get(`evidence/${folder}/${platformSlugOf(platform)}/sbom.json`), platform).toEqual(sbomDocument("postgres@16", platform));
      expect(JSON.parse(files.get(`evidence/${folder}/${platformSlugOf(platform)}/scan.json`)!.toString()), platform).toEqual({ platform, digest: childDigest("postgres@16", platform), status: "complete", criticalOpen: 0, highOpen: 2, scannedAt: "2026-11-02T10:00:00.000Z" });
    }
    const signed = JSON.parse(files.get(`evidence/${folder}/statement.json`)!.toString()) as SignedImageStatement;
    const children = [...PLATFORMS].sort().map((platform) => ({ platform, digest: childDigest("postgres@16", platform), sbomRef: sha256HexOf(sbomDocument("postgres@16", platform)), scannedAt: "2026-11-02T10:00:00.000Z" }));
    expect(signed.statement).toEqual({ id: "postgres@16", repository: "svc/postgres", digest: sourceDigest("postgres@16"), sbomRef: combinedSbomRef(children), scannedAt: "2026-11-02T10:00:00.000Z", children });
    expect(verifyImageStatement({ signed, trustedKeys: [signer.publicKeyPem] }).ok).toBe(true);
    // The statement does not verify for another image's digest, nor when a child digest, a child's SBOM hash or a whole platform is changed or left out.
    expect(verifyImageStatement({ signed: { ...signed, statement: { ...signed.statement, digest: sourceDigest("mysql@8") } }, trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
    const withChildren = (change: (list: typeof children) => typeof children) => ({ ...signed, statement: { ...signed.statement, children: change(children) } });
    expect(verifyImageStatement({ signed: withChildren((list) => [{ ...list[0]!, digest: sha("swapped") }, list[1]!]), trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
    expect(verifyImageStatement({ signed: withChildren((list) => [list[0]!]), trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
    expect(verifyImageStatement({ signed: withChildren((list) => [{ ...list[0]!, sbomRef: sha("other sbom") }, list[1]!]), trustedKeys: [signer.publicKeyPem] }).ok).toBe(false);
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
    const onlyAmd64 = [{ platform: "linux/amd64", digest: childDigest("mysql@8", "linux/amd64") }];
    expect(await refusalsOf(build(fakePorts({ mirror: (id) => (id === "mysql@8" ? { children: onlyAmd64 } : {}) }).ports))).toEqual([{ id: "mysql@8", code: "platforms_mismatch" }]);
    const extra = [...PLATFORMS, "linux/s390x"].map((platform) => ({ platform, digest: childDigest("mysql@8", platform) }));
    expect(await refusalsOf(build(fakePorts({ mirror: (id) => (id === "mysql@8" ? { children: extra } : {}) }).ports))).toEqual([{ id: "mysql@8", code: "platforms_mismatch" }]);
    expect(await refusalsOf(build(fakePorts({ mirror: (id) => (id === "mysql@8" ? { children: [] } : {}) }).ports))).toEqual([{ id: "mysql@8", code: "platforms_mismatch" }]);
  });
  it("children that cannot be told apart or are not digests: a platform twice, a shared manifest, a digest that is not sha256", async () => {
    const arm = { platform: "linux/arm64", digest: childDigest("mysql@8", "linux/arm64") };
    const amd = { platform: "linux/amd64", digest: childDigest("mysql@8", "linux/amd64") };
    for (const children of [[arm, { ...arm }], [arm, { ...amd, digest: arm.digest }], [arm, { ...amd, digest: "sha256:abc" }], [arm, { ...amd, digest: "latest" }]]) {
      expect(await refusalsOf(build(fakePorts({ mirror: (id) => (id === "mysql@8" ? { children } : {}) }).ports)), JSON.stringify(children)).toEqual([{ id: "mysql@8", code: "platforms_mismatch" }]);
    }
    expect(childrenProblem([arm, amd], ["linux/amd64", "linux/arm64"])).toBeUndefined();
    expect(childrenProblem([arm], ["linux/arm64"])).toBeUndefined();
  });
  it("no SBOM, an SBOM that is not an SPDX or CycloneDX document, or an empty one, for either platform", async () => {
    for (const platform of PLATFORMS) {
      for (const bad of [Buffer.alloc(0), Buffer.from("not json"), Buffer.from("[]"), Buffer.from('{"hello":1}')]) {
        const refused = await refusalsOf(build(fakePorts({ sbom: (id, which) => (id === "valkey@8" && which === platform ? bad : undefined) }).ports));
        expect(refused, `${platform} ${bad.toString()}`).toEqual([{ id: "valkey@8", code: "sbom_invalid" }]);
      }
    }
    const cyclone = fakePorts({ sbom: (id, platform) => Buffer.from(JSON.stringify({ bomFormat: "CycloneDX", id, platform })) });
    await expect(build(cyclone.ports)).resolves.toBeDefined();
  });
  it("the scan gate, per platform: a critical finding, an unfinished scan, an unsupported image, and a scan of another image refuse whichever platform it is", async () => {
    for (const platform of PLATFORMS) {
      const only = (change: Partial<ScanResult>): FakeChanges => ({ scan: (id, which) => (id === "postgres@17" && which === platform ? change : {}) });
      expect(await refusalsOf(build(fakePorts(only({ criticalOpen: 1 })).ports)), `${platform} critical`).toEqual([{ id: "postgres@17", code: "scan_critical" }]);
      for (const status of ["pending", "failed", "unsupported"] as const) {
        expect(await refusalsOf(build(fakePorts(only({ status })).ports)), `${platform} ${status}`).toEqual([{ id: "postgres@17", code: "scan_incomplete" }]);
      }
      expect(await refusalsOf(build(fakePorts(only({ digest: sha("another image") })).ports)), `${platform} other`).toEqual([{ id: "postgres@17", code: "scan_not_for_image" }]);
      expect(await refusalsOf(build(fakePorts(only({ highOpen: -1 })).ports)), `${platform} negative`).toEqual([{ id: "postgres@17", code: "scan_incomplete" }]);
    }
  });
  it("a scan of the INDEX digest instead of the platform's child is not accepted", async () => {
    expect(await refusalsOf(build(fakePorts({ scan: (id) => ({ digest: sourceDigest(id) }) }).ports))).toContainEqual({ id: "postgres@16", code: "scan_not_for_image" });
  });
  it("names the platform in the refusal, and lists every platform's refusal when both fail", async () => {
    const { ports } = fakePorts({ scan: (id) => (id === "postgres@17" ? { criticalOpen: 2 } : {}) });
    try {
      await build(ports);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogBuildError);
      const messages = (error as CatalogBuildError).refusals.map((refusal) => refusal.message);
      expect(messages).toHaveLength(2);
      expect(messages.some((message) => message.startsWith("linux/arm64:"))).toBe(true);
      expect(messages.some((message) => message.startsWith("linux/amd64:"))).toBe(true);
    }
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
    for (const bad of ["evidence/x/other.json", "/etc/passwd", "evidence/UPPER/linux-arm64/sbom.json", "evidence/a/b/sbom.json", "evidence/a/linux-arm64/other.json", "evidence/a/linux-s390x/sbom.json", "evidence/a/sbom.json", "evidence/a/linux-arm64/../../b/sbom.json", "outside/postgres-16/linux-arm64/sbom.json"]) {
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
  const armChild = sha("arm child");
  const amdChild = sha("amd child");
  const indexManifest = Buffer.from(JSON.stringify({
    manifests: [
      { digest: `sha256:${armChild}`, platform: { os: "linux", architecture: "arm64" } },
      { digest: `sha256:${amdChild}`, platform: { os: "linux", architecture: "amd64" } },
      { digest: `sha256:${sha("attestation")}`, platform: { os: "unknown", architecture: "unknown" } },
      { digest: "not-a-digest", platform: { os: "linux", architecture: "s390x" } },
    ],
  }));
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
    // The platforms are the index's, each with its OWN manifest digest; the attestation manifest and an entry without a real digest are not platforms.
    expect(result).toEqual({ digest: sha256HexOf(indexManifest), children: [{ platform: "linux/arm64", digest: armChild }, { platform: "linux/amd64", digest: amdChild }] });
    expect(JSON.stringify(log)).not.toMatch(/password|AWS:|Basic /u);
  });
  describe("a single-platform image", () => {
    const configBytes = Buffer.from(JSON.stringify({ architecture: "arm64", os: "linux", config: {} }));
    const manifestWith = (config: Buffer | undefined): Buffer => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", ...(config === undefined ? {} : { config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${sha256HexOf(config)}`, size: config.byteLength } }) }));
    const mirror = (manifest: Buffer, served: Buffer, log: string[][] = []) => {
      const port: CommandPort = {
        run: async (_file, args) => {
          log.push([...args]);
          if (args[0] === "copy") return Buffer.alloc(0);
          if (args.includes("--config")) return served;
          if (args.includes("--raw")) return manifest;
          throw new Error("a parsed (non-raw) inspect must not be used");
        },
      };
      return skopeoMirrorPort({ commands: port, registry: "r.example.com", authFile: "/a" })({ id: "x@1", source: "s.example.com/x@sha256:" + digest, repositoryName: "rovara-catalog/staging/svc/x", expectedDigest: digest });
    };

    it("takes its platform from the config blob its hashed manifest names, fetched raw, never from a second parsed inspect", async () => {
      const manifest = manifestWith(configBytes);
      const log: string[][] = [];
      const result = await mirror(manifest, configBytes, log);
      expect(result).toEqual({ digest: sha256HexOf(manifest), children: [{ platform: "linux/arm64", digest: sha256HexOf(manifest) }] });
      expect(log).toHaveLength(3);
      // copy, raw manifest, raw config blob: every inspect is raw.
      expect(log[0]![0]).toBe("copy");
      expect(log[1]).toEqual(["inspect", "--raw", "--authfile", "/a", `docker://r.example.com/rovara-catalog/staging/svc/x@sha256:${digest}`]);
      expect(log[2]).toEqual(["inspect", "--raw", "--config", "--authfile", "/a", `docker://r.example.com/rovara-catalog/staging/svc/x@sha256:${digest}`]);
      expect(log.filter((args) => args[0] === "inspect" && !args.includes("--raw"))).toEqual([]);
    });
    it("reads the architecture and os from the config, whichever they are", async () => {
      for (const [os, architecture] of [["linux", "amd64"], ["linux", "arm64"], ["windows", "amd64"]] as const) {
        const config = Buffer.from(JSON.stringify({ architecture, os }));
        const manifest = manifestWith(config);
        expect((await mirror(manifest, config)).children).toEqual([{ platform: `${os}/${architecture}`, digest: sha256HexOf(manifest) }]);
      }
    });
    it("refuses a config that does not hash to the digest the manifest names (the registry answered for another image)", async () => {
      const other = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux" }));
      await expect(mirror(manifestWith(configBytes), other)).rejects.toThrow("does not hash");
    });
    it("reports no platform when the manifest names no config, or the config names no os or architecture", async () => {
      expect((await mirror(manifestWith(undefined), configBytes)).children).toEqual([]);
      const noArch = Buffer.from(JSON.stringify({ os: "linux" }));
      expect((await mirror(manifestWith(noArch), noArch)).children).toEqual([]);
      const wrongTypes = Buffer.from(JSON.stringify({ os: 1, architecture: ["arm64"] }));
      expect((await mirror(manifestWith(wrongTypes), wrongTypes)).children).toEqual([]);
    });
  });
  it("runs syft on the registry copy of ONE platform's child digest, with --platform and the credential directory in the environment", async () => {
    const { port, log } = commands(Buffer.from("{}"));
    await syftSbomPort({ commands: port, registry: "r.example.com", authDir: "/tmp/auth" })({ id: "postgres@16", repositoryName: "rovara-catalog/staging/svc/postgres", platform: "linux/arm64", digest });
    expect(log[0]).toEqual({ file: "syft", args: [`registry:r.example.com/rovara-catalog/staging/svc/postgres@sha256:${digest}`, "--platform", "linux/arm64", "-o", "spdx-json", "--quiet"], env: { DOCKER_CONFIG: "/tmp/auth" } });
  });

  class Describe { constructor(readonly input: { repositoryName: string; imageId: { imageDigest: string } }) {} }
  class Start { constructor(readonly input: { repositoryName: string; imageId: { imageDigest: string } }) {} }
  const scanWith = (responses: Array<Error | Record<string, unknown>>) => {
    const sent: unknown[] = [];
    const client = { send: async (command: unknown) => { sent.push(command); const next = responses.shift(); if (next instanceof Error) throw next; return next; } };
    return { sent, port: ecrScanPort({ client, commands: { DescribeImageScanFindingsCommand: Describe, StartImageScanCommand: Start }, sleep: async () => undefined, maxPolls: 4, now: () => new Date("2026-11-02T12:00:00.000Z") }) };
  };
  it("reads ECR's finished scan of the child digest, counting critical and high findings", async () => {
    const { port, sent } = scanWith([{ imageScanStatus: { status: "COMPLETE" }, imageScanFindings: { imageScanCompletedAt: new Date("2026-11-02T09:00:00.000Z"), findingSeverityCounts: { CRITICAL: 1, HIGH: 4, MEDIUM: 9 } } }]);
    expect(await port({ id: "postgres@16", repositoryName: "rovara-catalog/staging/svc/postgres", platform: "linux/arm64", digest })).toEqual({ digest, status: "complete", criticalOpen: 1, highOpen: 4, scannedAt: "2026-11-02T09:00:00.000Z" });
    expect((sent[0] as Describe).input).toEqual({ repositoryName: "rovara-catalog/staging/svc/postgres", imageId: { imageDigest: `sha256:${digest}` } });
  });
  it("starts a scan once when there is none, waits, and reads it", async () => {
    const notFound = Object.assign(new Error("none"), { name: "ScanNotFoundException" });
    const { port, sent } = scanWith([notFound, { imageScanStatus: { status: "IN_PROGRESS" } }, { imageScanStatus: { status: "COMPLETE" }, imageScanFindings: { findingSeverityCounts: {} } }]);
    const result = await port({ id: "x@1", repositoryName: "rovara-catalog/staging/svc/x", platform: "linux/arm64", digest });
    expect(result).toMatchObject({ status: "complete", criticalOpen: 0, highOpen: 0, scannedAt: "2026-11-02T12:00:00.000Z" });
    expect(sent.filter((command) => command instanceof Start)).toHaveLength(1);
  });
  it("reports an unsupported or failed scan, and a scan that never finishes, as not complete (the gate then refuses)", async () => {
    expect((await scanWith([{ imageScanStatus: { status: "UNSUPPORTED_IMAGE" } }]).port({ id: "x@1", repositoryName: "r/x", platform: "linux/arm64", digest })).status).toBe("unsupported");
    expect((await scanWith([{ imageScanStatus: { status: "FAILED" } }]).port({ id: "x@1", repositoryName: "r/x", platform: "linux/arm64", digest })).status).toBe("failed");
    expect((await scanWith(Array.from({ length: 4 }, () => ({ imageScanStatus: { status: "IN_PROGRESS" } }))).port({ id: "x@1", repositoryName: "r/x", platform: "linux/arm64", digest })).status).toBe("pending");
    await expect(scanWith([Object.assign(new Error("denied"), { name: "AccessDeniedException" })]).port({ id: "x@1", repositoryName: "r/x", platform: "linux/arm64", digest })).rejects.toThrow("denied");
  });
});

describe("the command port", () => {
  const recorded = () => {
    const calls: Array<{ file: string; args: string[]; options: Parameters<ExecFileFn>[2] }> = [];
    const exec: ExecFileFn = async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: Buffer.from("ok") };
    };
    return { calls, exec };
  };

  it("kills a command after ten minutes by default, and keeps the output and environment handling as before", async () => {
    const { calls, exec } = recorded();
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBe(600_000);
    expect((await createCommandPort({ exec }).run("skopeo", ["inspect"], { env: { A: "1" } })).toString()).toBe("ok");
    expect(calls[0]?.options).toMatchObject({ encoding: "buffer", timeout: 600_000, killSignal: "SIGKILL" });
    expect(calls[0]?.options.env["A"]).toBe("1");
    expect(typeof execCommandPort.run).toBe("function");
  });

  it("takes a timeout per port and per command", async () => {
    const { calls, exec } = recorded();
    const port = createCommandPort({ timeoutMs: 5_000, exec });
    await port.run("a", []);
    await port.run("b", [], { timeoutMs: 7_000 });
    expect(calls.map((call) => call.options.timeout)).toEqual([5_000, 7_000]);
    await expect(port.run("c", [], { timeoutMs: 0 })).rejects.toThrow(/timeout/u);
  });

  it("says a killed command timed out, and passes other failures through unchanged", async () => {
    const killed: ExecFileFn = async () => { throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL" }); };
    await expect(createCommandPort({ timeoutMs: 3_000, exec: killed }).run("syft", [])).rejects.toThrow(/syft was killed after 3 s/u);
    const failed: ExecFileFn = async () => { throw Object.assign(new Error("exit 2"), { code: 2 }); };
    await expect(createCommandPort({ exec: failed }).run("syft", [])).rejects.toThrow("exit 2");
    const tooBig: ExecFileFn = async () => { throw Object.assign(new Error("maxBuffer"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }); };
    await expect(createCommandPort({ exec: tooBig }).run("syft", [])).rejects.toThrow("maxBuffer");
  });
});

describe("which timeout each catalog-build command gets", () => {
  const digest = "a".repeat(64);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${"b".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } }] }));
  const run = async (mirrorOptions: { copyTimeoutMs?: number } = {}, sbomOptions: { timeoutMs?: number } = {}) => {
    const seen: string[] = [];
    const port: CommandPort = { run: async (file, args, options) => { seen.push(`${file} ${args[0] as string} ${String(options?.timeoutMs)}`); return args.includes("--raw") ? manifest : Buffer.from("{}"); } };
    await skopeoMirrorPort({ commands: port, registry: "r.example.com", authFile: "/a", ...mirrorOptions })({ id: "x@1", source: `s.example.com/x@sha256:${digest}`, repositoryName: "rovara-catalog/staging/svc/x", expectedDigest: digest }).catch(() => undefined);
    await syftSbomPort({ commands: port, registry: "r.example.com", authDir: "/d", ...sbomOptions })({ id: "x@1", repositoryName: "rovara-catalog/staging/svc/x", platform: "linux/arm64", digest });
    return seen;
  };

  it("gives skopeo copy and syft 45 minutes and leaves skopeo inspect on the port's default", async () => {
    expect(DEFAULT_COPY_TIMEOUT_MS).toBe(2_700_000);
    expect(await run()).toEqual(["skopeo copy 2700000", "skopeo inspect undefined", "syft registry:r.example.com/rovara-catalog/staging/svc/x@sha256:" + digest + " 2700000"]);
  });

  it("takes the copy timeout from the caller", async () => {
    expect(await run({ copyTimeoutMs: 1_000 }, { timeoutMs: 2_000 })).toEqual(["skopeo copy 1000", "skopeo inspect undefined", "syft registry:r.example.com/rovara-catalog/staging/svc/x@sha256:" + digest + " 2000"]);
  });

  it("reads a timeout flag in whole seconds", () => {
    expect(timeoutFlag(undefined, 5, "--x")).toBe(5);
    expect(timeoutFlag("30", 5, "--x")).toBe(30_000);
    for (const bad of ["0", "-1", "1.5", "abc", ""]) expect(() => timeoutFlag(bad, 5, "--x")).toThrow("--x");
  });
});
