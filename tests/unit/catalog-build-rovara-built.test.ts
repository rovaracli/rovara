// Test services slice 2 (s2-catalog): a "Rovara-built" source for the emulator in scripts/catalog-build.ts. The source is the OCI layout and the digest file of the emulator fork's workflow artifact (UNSIGNED). catalog-build reads and
// verifies the layout on disk, pushes it by its digest, requires the registry to serve the same digest, and only then takes the SBOM, the scan and the signature. Everything runs against fakes and temporary folders: no process
// is started, no registry or credential is touched.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceCatalogSchema, sha256HexOf, verifyImageStatement, type SignedImageStatement } from "@rovara-code/contracts";
import {
  BuiltSourceSchema,
  CatalogBuildError,
  SourcesFileSchema,
  buildPinnedCatalog,
  readBuiltSource,
  skopeoMirrorPort,
  writeCatalogBuild,
  type BuiltLayout,
  type CatalogBuildPorts,
  type CommandPort,
  type SourcesFile,
} from "../../scripts/catalog-build.js";
import { sha, testSigner, unpinnedCatalog } from "../support/catalog-pinning.js";

const catalog = unpinnedCatalog();
const ID = "local-aws@r1";
const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const temporary = async (): Promise<string> => { const dir = await mkdtemp(join(tmpdir(), "catalog-built-test-")); dirs.push(dir); return dir; };
const hex = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

interface LayoutOptions {
  platforms?: readonly string[];
  attestation?: boolean;
  /** Writes the digest file with this text instead of the real digest. */
  digestText?: (digest: string) => string;
  extraTopManifest?: boolean;
  skipBlob?: (what: string) => boolean;
  corruptBlob?: (what: string) => boolean;
  topMediaType?: string;
  /** An extra index entry that is not a platform. */
  extraIndexEntry?: Record<string, unknown>;
  /** The CycloneDX list: default one component; "missing"; or the text of a file. */
  javaSbom?: "missing" | { text: string };
  /** What the artifact's scan-java-arm64.json holds: a grype result with these severities (default one medium), or "missing", or the text of a file that is not a result. */
  javaScan?: { severities: string[] } | "missing" | { text: string };
}
interface MadeLayout { root: string; layout: string; digestFile: string; javaScanFile: string; javaSbomFile: string; digest: string; indexBytes: Buffer; children: Array<{ platform: string; digest: string }> }
/** Writes what the workflow's `image-result` artifact holds: oci/ (oci-layout, index.json, blobs/sha256/...) and index.digest. */
async function makeLayout(options: LayoutOptions = {}): Promise<MadeLayout> {
  const root = await temporary();
  const layout = join(root, "oci");
  await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
  const put = async (name: string, bytes: Buffer, what: string): Promise<void> => {
    if (options.skipBlob?.(what) === true) return;
    await writeFile(join(layout, "blobs", "sha256", name), options.corruptBlob?.(what) === true ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes);
  };
  const children: Array<{ platform: string; digest: string }> = [];
  const items: unknown[] = [];
  for (const platform of options.platforms ?? ["linux/arm64"]) {
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST, config: { digest: `sha256:${sha(`config ${platform}`)}` }, layers: [] }));
    const digest = hex(manifest);
    await put(digest, manifest, platform);
    const [os, architecture] = platform.split("/") as [string, string];
    items.push({ mediaType: OCI_MANIFEST, digest: `sha256:${digest}`, size: manifest.byteLength, platform: { os, architecture } });
    children.push({ platform, digest });
  }
  if (options.attestation === true) items.push({ mediaType: OCI_MANIFEST, digest: `sha256:${sha("attestation, never in the layout")}`, size: 10, platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } });
  if (options.extraIndexEntry !== undefined) items.push(options.extraIndexEntry);
  const indexBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: items }));
  const digest = hex(indexBytes);
  await put(digest, indexBytes, "index");
  const top: unknown[] = [{ mediaType: options.topMediaType ?? OCI_INDEX, digest: `sha256:${digest}`, size: indexBytes.byteLength }];
  if (options.extraTopManifest === true) top.push({ mediaType: OCI_INDEX, digest: `sha256:${sha("another image")}`, size: 1 });
  await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: top }));
  const digestFile = join(root, "index.digest");
  await writeFile(digestFile, options.digestText === undefined ? `sha256:${digest}\n` : options.digestText(digest));
  const javaScanFile = join(root, "scan-java-arm64.json");
  const javaSbomFile = join(root, "sbom-arm64", "java-dependencies.cdx.json");
  await mkdir(join(root, "sbom-arm64"), { recursive: true });
  const sbom = options.javaSbom ?? { text: JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", components: [{ group: "io.quarkus", name: "quarkus-core", version: "3.1.0", purl: "pkg:maven/io.quarkus/quarkus-core@3.1.0" }, { name: "jackson-core", group: "com.fasterxml.jackson.core", version: "2.17.0", components: [{ name: "nested", version: "1.0" }] }] }) };
  if (sbom !== "missing") await writeFile(javaSbomFile, sbom.text);
  const java = options.javaScan ?? { severities: ["Medium"] };
  if (java !== "missing") await writeFile(javaScanFile, "text" in java ? java.text : JSON.stringify({ matches: java.severities.map((severity) => ({ vulnerability: { id: "CVE-2026-0001", severity }, artifact: { name: "io.quarkus:quarkus-core", version: "3.1.0", purl: "pkg:maven/io.quarkus/quarkus-core@3.1.0" } })), descriptor: { name: "grype", version: "0.90.0" } }));
  return { root, layout, digestFile, javaScanFile, javaSbomFile, digest, indexBytes, children };
}
const sourceOf = (made: MadeLayout): SourcesFile => ({ schemaVersion: 1, sources: { [ID]: { kind: "rovara-built", layout: made.layout, digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile } } });

describe("the sources file", () => {
  it("still takes a registry digest reference, and takes a Rovara-built source with exactly four keys (the layout, the digest file and the Java dependency scan)", () => {
    const registry = { schemaVersion: 1, sources: { "postgres@16": `registry.example.com/library/postgres@sha256:${sha("p")}` } };
    expect(SourcesFileSchema.safeParse(registry).success).toBe(true);
    expect(SourcesFileSchema.safeParse({ schemaVersion: 1, sources: { [ID]: { kind: "rovara-built", layout: "oci", digestFile: "index.digest", javaScan: "scan-java-arm64.json", javaSbom: "sbom-arm64/java-dependencies.cdx.json" } } }).success).toBe(true);
  });
  it("refuses a built source with another kind, an extra key, a missing key, or a path skopeo would read as a reference or that holds a line break", () => {
    const base = { kind: "rovara-built", layout: "oci", digestFile: "index.digest", javaScan: "scan-java-arm64.json", javaSbom: "sbom-arm64/java-dependencies.cdx.json" };
    for (const bad of [{ ...base, kind: "other" }, { ...base, extra: 1 }, { kind: "rovara-built", layout: "oci", digestFile: "index.digest" }, { ...base, layout: "oci:latest" }, { ...base, layout: "" }, { ...base, digestFile: "a\nb" }, { ...base, layout: "a".repeat(1025) }, { kind: "rovara-built", layout: "oci", digestFile: "index.digest", javaScan: "scan-java-arm64.json" }]) {
      expect(BuiltSourceSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("reading and verifying a layout (readBuiltSource)", () => {
  it("returns the digest, the platforms with their own manifest digests (an attestation manifest is not a platform) and the absolute layout path", async () => {
    const made = await makeLayout({ platforms: ["linux/arm64", "linux/amd64"], attestation: true });
    const result = await readBuiltSource({ baseDir: "/nowhere" })({ kind: "rovara-built", layout: made.layout, digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile });
    expect(result).toMatchObject({ digest: made.digest, children: made.children, layoutPath: made.layout });
  });
  it("reads relative paths from the base directory (the sources file's)", async () => {
    const made = await makeLayout();
    const result = await readBuiltSource({ baseDir: made.root })({ kind: "rovara-built", layout: "oci", digestFile: "index.digest", javaScan: "scan-java-arm64.json", javaSbom: "sbom-arm64/java-dependencies.cdx.json" });
    expect(result.layoutPath).toBe(made.layout);
    expect(result.digest).toBe(made.digest);
  });
  const read = (made: MadeLayout) => readBuiltSource({ baseDir: made.root })({ kind: "rovara-built", layout: made.layout, digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile });

  it("refuses a digest file that is not one sha256 digest", async () => {
    for (const text of ["", "latest\n", "sha256:abc\n", `sha256:${"A".repeat(64)}\n`, `sha256:${"a".repeat(64)}\nsha256:${"b".repeat(64)}\n`]) {
      await expect(read(await makeLayout({ digestText: () => text })), JSON.stringify(text)).rejects.toThrow(/digest file/u);
    }
  });
  it("refuses a digest file naming another image than the layout holds", async () => {
    await expect(read(await makeLayout({ digestText: () => `sha256:${sha("someone else")}\n` }))).rejects.toThrow(/not the digest in the digest file/u);
  });
  it("refuses a layout that holds more than one image", async () => {
    await expect(read(await makeLayout({ extraTopManifest: true }))).rejects.toThrow(/exactly one image/u);
  });
  it("refuses a top entry that is not an index (a bare manifest is not what the workflow builds)", async () => {
    await expect(read(await makeLayout({ topMediaType: OCI_MANIFEST }))).rejects.toThrow(/not an image index/u);
  });
  it("refuses an index whose bytes do not hash to the digest, and an index or platform manifest that is not in the layout", async () => {
    await expect(read(await makeLayout({ corruptBlob: (what) => what === "index" }))).rejects.toThrow(/does not hash/u);
    await expect(read(await makeLayout({ skipBlob: (what) => what === "index" }))).rejects.toThrow(/image index is missing/u);
    await expect(read(await makeLayout({ corruptBlob: (what) => what === "linux/arm64" }))).rejects.toThrow(/does not hash/u);
    await expect(read(await makeLayout({ skipBlob: (what) => what === "linux/arm64" }))).rejects.toThrow(/arm64 manifest is missing/u);
  });
  it("refuses a folder that is not an OCI layout, and a missing digest file", async () => {
    const made = await makeLayout();
    await rm(join(made.layout, "oci-layout"));
    await expect(read(made)).rejects.toThrow(/oci-layout is missing/u);
    const other = await makeLayout();
    await expect(readBuiltSource({ baseDir: other.root })({ kind: "rovara-built", layout: other.layout, digestFile: join(other.root, "absent"), javaScan: other.javaScanFile, javaSbom: other.javaSbomFile })).rejects.toThrow(/digest file is missing/u);
  });
});

/** Ports as in catalog-build.test.ts: the registry serves what the mirror is told to, SBOM and scan are canned. */
function fakePorts(change: { served?: (built: BuiltLayout | undefined, expected: string) => { digest: string; children?: Array<{ platform: string; digest: string }> }; readBuilt?: CatalogBuildPorts["readBuilt"] } = {}, made?: MadeLayout) {
  const calls = { mirror: [] as Array<{ source: string; expectedDigest: string; built: string | undefined; repositoryName: string }>, sbom: [] as string[], scan: [] as string[], read: 0 };
  const signer = testSigner();
  const ports: CatalogBuildPorts = {
    async mirror({ source, expectedDigest, built, repositoryName }) {
      calls.mirror.push({ source, expectedDigest, built: built?.layoutPath, repositoryName });
      const served = change.served?.(undefined, expectedDigest);
      return { digest: expectedDigest, children: made?.children ?? [], ...served };
    },
    async sbom({ id, platform }) { calls.sbom.push(`${id} ${platform}`); return Buffer.from(JSON.stringify({ spdxVersion: "SPDX-2.3", name: id, packages: [] })); },
    async scan({ id, platform, digest }) { calls.scan.push(`${id} ${platform}`); return { digest, status: "complete", criticalOpen: 0, highOpen: 0, scannedAt: "2026-11-03T10:00:00.000Z" }; },
    async registryServes() { return true; },
    readBuilt: change.readBuilt ?? (async (source) => { calls.read += 1; return readBuiltSource({ baseDir: "/" })(source); }),
    signer: { publicKeyPem: signer.publicKeyPem, sign: signer.sign },
  };
  return { ports, calls };
}
const buildBuilt = (ports: CatalogBuildPorts, sources: SourcesFile, entries: readonly string[] = [ID]) => buildPinnedCatalog({ catalog, sources, env: "staging", ports, entries });
const refusalsOf = async (promise: Promise<unknown>): Promise<Array<{ id: string; code: string }>> => {
  try { await promise; } catch (error) { if (error instanceof CatalogBuildError) return error.refusals.map(({ id, code }) => ({ id, code })); throw error; }
  return [];
};

describe("pinning the emulator from a Rovara-built layout (fakes)", () => {
  it("pushes the layout by the digest in the digest file into rovara-catalog/<env>/svc/local-aws, and pins that digest with an SBOM and a scan of the one platform", async () => {
    const made = await makeLayout();
    const { ports, calls } = fakePorts({}, made);
    const output = await buildBuilt(ports, sourceOf(made));
    expect(calls.mirror).toEqual([{ source: `rovara-built:sha256:${made.digest}`, expectedDigest: made.digest, built: made.layout, repositoryName: "rovara-catalog/staging/svc/local-aws" }]);
    expect(calls.sbom).toEqual([`${ID} linux/arm64`]);
    expect(calls.scan).toEqual([`${ID} linux/arm64`]);
    const pinned = ServiceCatalogSchema.parse(JSON.parse(output.catalogBytes.toString("utf8")));
    expect(pinned.entries.find((entry) => entry.id === ID)?.image.digest).toBe(made.digest);
    expect(pinned.entries.find((entry) => entry.id === ID)?.image.platforms).toEqual(["linux/arm64"]);
  });
  it("refuses when the registry serves another digest than the artifact's (nothing is pinned)", async () => {
    const made = await makeLayout();
    const { ports } = fakePorts({ served: () => ({ digest: sha("a different image") }) }, made);
    expect(await refusalsOf(buildBuilt(ports, sourceOf(made)))).toEqual([{ id: ID, code: "digest_mismatch" }]);
  });
  it("refuses when the registry serves other platform manifests than the layout holds", async () => {
    const made = await makeLayout();
    const { ports } = fakePorts({ served: () => ({ digest: made.digest, children: [{ platform: "linux/arm64", digest: sha("another manifest") }] }) }, made);
    expect(await refusalsOf(buildBuilt(ports, sourceOf(made)))).toEqual([{ id: ID, code: "platforms_mismatch" }]);
  });
  it("refuses a layout with a platform the entry does not list BEFORE anything is pushed (the emulator is arm64 only)", async () => {
    const made = await makeLayout({ platforms: ["linux/arm64", "linux/amd64"] });
    const { ports, calls } = fakePorts({}, made);
    expect(await refusalsOf(buildBuilt(ports, sourceOf(made)))).toEqual([{ id: ID, code: "platforms_mismatch" }]);
    expect(calls.mirror).toEqual([]);
    const amdOnly = await makeLayout({ platforms: ["linux/amd64"] });
    expect(await refusalsOf(buildBuilt(fakePorts({}, amdOnly).ports, sourceOf(amdOnly)))).toEqual([{ id: ID, code: "platforms_mismatch" }]);
  });
  it("refuses a layout that fails verification BEFORE anything is pushed", async () => {
    const made = await makeLayout({ corruptBlob: (what) => what === "index" });
    const { ports, calls } = fakePorts({}, made);
    expect(await refusalsOf(buildBuilt(ports, sourceOf(made)))).toEqual([{ id: ID, code: "built_source_invalid" }]);
    expect(calls.mirror).toEqual([]);
  });
  it("refuses a Rovara-built source for an entry that is not the emulator, before any read or push", async () => {
    const made = await makeLayout();
    const { ports, calls } = fakePorts({}, made);
    const sources: SourcesFile = { schemaVersion: 1, sources: { "postgres@16": { kind: "rovara-built", layout: made.layout, digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile } } };
    expect(await refusalsOf(buildBuilt(ports, sources, ["postgres@16"]))).toEqual([{ id: "postgres@16", code: "built_source_not_allowed" }]);
    expect(calls.read).toBe(0);
    expect(calls.mirror).toEqual([]);
  });
  it("refuses when this build has no way to read a Rovara-built source", async () => {
    const made = await makeLayout();
    const { ports } = fakePorts({}, made);
    const { readBuilt: _unused, ...withoutReader } = ports;
    void _unused;
    expect(await refusalsOf(buildBuilt(withoutReader, sourceOf(made)))).toEqual([{ id: ID, code: "port_failed" }]);
  });
  it("a critical finding in the scan still refuses the build: the artifact's own scan is not trusted", async () => {
    const made = await makeLayout();
    const { ports } = fakePorts({}, made);
    const scan: CatalogBuildPorts["scan"] = async ({ digest }) => ({ digest, status: "complete", criticalOpen: 1, highOpen: 0, scannedAt: "2026-11-03T10:00:00.000Z" });
    expect(await refusalsOf(buildBuilt({ ...ports, scan }, sourceOf(made)))).toEqual([{ id: ID, code: "scan_critical" }]);
  });
  it("a registry source for the emulator is still taken as before (a Rovara-built source is an addition, not a replacement)", async () => {
    const { ports, calls } = fakePorts({}, { children: [{ platform: "linux/arm64", digest: sha("child") }] } as MadeLayout);
    const digest = sha("registry image");
    await buildBuilt(ports, { schemaVersion: 1, sources: { [ID]: `registry.example.com/rovara/local-aws@sha256:${digest}` } });
    expect(calls.mirror[0]).toEqual({ source: `registry.example.com/rovara/local-aws@sha256:${digest}`, expectedDigest: digest, built: undefined, repositoryName: "rovara-catalog/staging/svc/local-aws" });
  });
});

describe("the real ports together (real layout on disk, fake skopeo)", () => {
  /** A skopeo that records its arguments and, for `inspect --raw`, answers with the index bytes of the layout it was told to push. */
  function skopeo(made: MadeLayout, served: Buffer = made.indexBytes) {
    const log: Array<{ file: string; args: readonly string[] }> = [];
    const port: CommandPort = { run: async (file, args) => { log.push({ file, args }); return args.includes("--raw") ? served : Buffer.alloc(0); } };
    return { port, log };
  }
  const realPorts = (made: MadeLayout, commands: CommandPort): CatalogBuildPorts => ({
    ...fakePorts({}, made).ports,
    mirror: skopeoMirrorPort({ commands, registry: REGISTRY, authFile: "/auth/config.json" }),
    readBuilt: readBuiltSource({ baseDir: made.root }),
  });

  it("copies the layout from disk with every platform and the digest kept, then reads it back by digest and pins it", async () => {
    const made = await makeLayout();
    const { port, log } = skopeo(made);
    const output = await buildBuilt(realPorts(made, port), { schemaVersion: 1, sources: { [ID]: { kind: "rovara-built", layout: "oci", digestFile: "index.digest", javaScan: "scan-java-arm64.json", javaSbom: "sbom-arm64/java-dependencies.cdx.json" } } });
    expect(log[0]).toEqual({ file: "skopeo", args: ["copy", "--all", "--preserve-digests", "--dest-authfile", "/auth/config.json", `oci:${made.layout}`, `docker://${REGISTRY}/rovara-catalog/staging/svc/local-aws:${made.digest.slice(0, 32)}`] });
    expect(log[1]!.args).toEqual(["inspect", "--raw", "--authfile", "/auth/config.json", `docker://${REGISTRY}/rovara-catalog/staging/svc/local-aws@sha256:${made.digest}`]);
    expect(JSON.stringify(log)).not.toContain("docker://registry");
    expect(ServiceCatalogSchema.parse(JSON.parse(output.catalogBytes.toString("utf8"))).entries.find((entry) => entry.id === ID)?.image.digest).toBe(made.digest);
  });
  it("refuses when the registry serves bytes that hash to another digest than the artifact's", async () => {
    const made = await makeLayout();
    const swapped = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: [] }));
    expect(sha256HexOf(swapped)).not.toBe(made.digest);
    const { port } = skopeo(made, swapped);
    expect(await refusalsOf(buildBuilt(realPorts(made, port), sourceOf(made)))).toEqual([{ id: ID, code: "digest_mismatch" }]);
  });
});

describe("the scan of the Java libraries inside the native binary (the image scan cannot see them)", () => {
  const read = (made: MadeLayout) => readBuiltSource({ baseDir: made.root })({ kind: "rovara-built", layout: made.layout, digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile });

  it("counts the artifact's findings by severity and keeps the file's SHA-256 and bytes", async () => {
    const made = await makeLayout({ javaScan: { severities: ["High", "high", "Medium", "Low", "Negligible", "Unknown"] } });
    const result = await read(made);
    expect(result.javaScan).toMatchObject({ criticalOpen: 0, highOpen: 2 });
    expect(result.javaScan.sha256).toBe(sha256HexOf(result.javaScan.bytes));
  });
  it("counts a critical finding, and a finding whose severity it cannot read, as critical", async () => {
    expect((await read(await makeLayout({ javaScan: { severities: ["Critical"] } }))).javaScan.criticalOpen).toBe(1);
    expect((await read(await makeLayout({ javaScan: { text: JSON.stringify({ descriptor: { name: "grype" }, matches: [{ vulnerability: {}, artifact: { name: "nested", version: "1.0" } }, { artifact: { name: "nested", version: "1.0" } }, { vulnerability: { severity: "Catastrophic" }, artifact: { name: "nested", version: "1.0" } }] }) } }))).javaScan.criticalOpen).toBe(3);
  });
  it("pass: a clean scan (no matches at all) pins, records the highs, and puts the file's hash and counts in the signed statement and the file in the evidence", async () => {
    const made = await makeLayout({ javaScan: { severities: ["High", "High", "Low"] } });
    const { ports } = fakePorts({}, made);
    const output = await buildBuilt(ports, sourceOf(made));
    const javaBytes = output.evidence.find((item) => item.path === "evidence/local-aws-r1/java-scan.json")?.bytes;
    expect(javaBytes).toBeDefined();
    const signed = JSON.parse(output.evidence.find((item) => item.path === "evidence/local-aws-r1/statement.json")!.bytes.toString("utf8")) as SignedImageStatement;
    expect(signed.statement.javaScan).toEqual({ sha256: sha256HexOf(javaBytes!), sbomSha256: sha256HexOf(await readFile(made.javaSbomFile)), criticalOpen: 0, highOpen: 2 });
    expect(output.evidence.some((item) => item.path === "evidence/local-aws-r1/java-sbom.json")).toBe(true);
    // The signature covers it: a statement with the hash changed no longer verifies.
    const trusted = [(ports.signer as { publicKeyPem: string }).publicKeyPem];
    expect(verifyImageStatement({ signed, trustedKeys: trusted }).ok).toBe(true);
    expect(verifyImageStatement({ signed: { ...signed, statement: { ...signed.statement, javaScan: { ...signed.statement.javaScan!, sha256: sha("other") } } }, trustedKeys: trusted }).ok).toBe(false);
    expect(verifyImageStatement({ signed: { ...signed, statement: { ...signed.statement, javaScan: { ...signed.statement.javaScan!, highOpen: 0 } } }, trustedKeys: trusted }).ok).toBe(false);
    expect(verifyImageStatement({ signed: { ...signed, statement: { ...signed.statement, javaScan: { ...signed.statement.javaScan!, sbomSha256: sha("other list") } } }, trustedKeys: trusted }).ok).toBe(false);
    // The entry's highs are the image's (the fake scan reports 0) plus the Java libraries' 2.
    const pinned = ServiceCatalogSchema.parse(JSON.parse(output.catalogBytes.toString("utf8")));
    expect(pinned.entries.find((entry) => entry.id === ID)?.scan?.highOpen).toBe(2);
  });
  it("a critical finding refuses the pin BEFORE anything is pushed", async () => {
    const made = await makeLayout({ javaScan: { severities: ["High", "Critical"] } });
    const { ports, calls } = fakePorts({}, made);
    expect(await refusalsOf(buildBuilt(ports, sourceOf(made)))).toEqual([{ id: ID, code: "scan_critical" }]);
    expect(calls.mirror).toEqual([]);
  });
  it("a missing scan file refuses (no scan is not a clean scan), before any push", async () => {
    const made = await makeLayout({ javaScan: "missing" });
    const { ports, calls } = fakePorts({}, made);
    expect(await refusalsOf(buildBuilt(ports, sourceOf(made)))).toEqual([{ id: ID, code: "built_source_invalid" }]);
    expect(calls.mirror).toEqual([]);
    await expect(read(made)).rejects.toThrow(/Java dependency scan file is missing/u);
  });
  it("a malformed scan file refuses: not JSON, JSON that is not an object with a matches list, a matches value that is not a list", async () => {
    for (const text of ["", "not json", "null", "[]", "{}", JSON.stringify({ matches: "none", descriptor: { name: "grype" } }), JSON.stringify({ matches: null, descriptor: { name: "grype" } })]) {
      const made = await makeLayout({ javaScan: { text } });
      const { ports, calls } = fakePorts({}, made);
      expect(await refusalsOf(buildBuilt(ports, sourceOf(made))), JSON.stringify(text)).toEqual([{ id: ID, code: "built_source_invalid" }]);
      expect(calls.mirror, JSON.stringify(text)).toEqual([]);
    }
  });
  it("a statement for an image with no Java scan (every registry source) is exactly what it was: no javaScan field", async () => {
    const { ports } = fakePorts({}, { children: [{ platform: "linux/arm64", digest: sha("child") }] } as MadeLayout);
    const output = await buildBuilt(ports, { schemaVersion: 1, sources: { [ID]: `registry.example.com/rovara/local-aws@sha256:${sha("registry image")}` } });
    const statement = JSON.parse(output.evidence.find((item) => item.path.endsWith("statement.json"))!.bytes.toString("utf8")) as SignedImageStatement;
    expect(statement.statement).not.toHaveProperty("javaScan");
    expect(output.evidence.some((item) => item.path.endsWith("java-scan.json"))).toBe(false);
  });
});

describe("writing a Rovara-built build", () => {
  it("writes the Java scan beside the statement in the entry's evidence folder, byte for byte", async () => {
    const made = await makeLayout({ javaScan: { severities: ["Low"] } });
    const output = await buildBuilt(fakePorts({}, made).ports, sourceOf(made));
    const out = await temporary();
    await writeCatalogBuild(output, { catalogDir: join(out, "catalog"), prepullFile: join(out, "prepull.json"), evidenceDir: join(out, "evidence") });
    expect(sha256HexOf(await readFile(join(out, "evidence/local-aws-r1/java-scan.json")))).toBe(sha256HexOf(await readFile(made.javaScanFile)));
  });
});

describe("binding the Java scan to the image's dependency list", () => {
  const read = (made: MadeLayout) => readBuiltSource({ baseDir: made.root })({ kind: "rovara-built", layout: made.layout, digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile });
  const refused = async (options: LayoutOptions, message: RegExp, label: string): Promise<void> => {
    const made = await makeLayout(options);
    const { ports, calls } = fakePorts({}, made);
    expect(await refusalsOf(buildBuilt(ports, sourceOf(made))), label).toEqual([{ id: ID, code: "built_source_invalid" }]);
    expect(calls.mirror, label).toEqual([]);
    await expect(read(made), label).rejects.toThrow(message);
  };

  it("refuses a generic result: {\"matches\":[]} and any file whose descriptor is not grype's", async () => {
    await refused({ javaScan: { text: JSON.stringify({ matches: [] }) } }, /not a grype result/u, "generic empty");
    await refused({ javaScan: { text: JSON.stringify({ matches: [], descriptor: { name: "trivy" } }) } }, /not a grype result/u, "other tool");
  });
  it("accepts a clean grype result for the list (no findings is the common case)", async () => {
    const result = await read(await makeLayout({ javaScan: { text: JSON.stringify({ matches: [], descriptor: { name: "grype", version: "0.90.0" } }) } }));
    expect(result.javaScan).toMatchObject({ criticalOpen: 0, highOpen: 0 });
  });
  it("refuses a finding that names a package that is not in the CycloneDX list that came with the artifact (a scan of another list)", async () => {
    const other = JSON.stringify({ descriptor: { name: "grype" }, matches: [{ vulnerability: { severity: "Low" }, artifact: { name: "log4j-core", version: "2.14.0", purl: "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.0" } }] });
    await refused({ javaScan: { text: other } }, /not in the CycloneDX list/u, "other package");
    // The right name with another version is another package.
    const version = JSON.stringify({ descriptor: { name: "grype" }, matches: [{ vulnerability: { severity: "Low" }, artifact: { name: "io.quarkus:quarkus-core", version: "9.9.9" } }] });
    await refused({ javaScan: { text: version } }, /not in the CycloneDX list/u, "other version");
  });
  it("finds a package by purl, by name and version, by group:name and in nested components", async () => {
    const finding = (artifact: Record<string, unknown>) => JSON.stringify({ descriptor: { name: "grype" }, matches: [{ vulnerability: { severity: "High" }, artifact }] });
    for (const artifact of [{ purl: "pkg:maven/io.quarkus/quarkus-core@3.1.0" }, { name: "jackson-core", version: "2.17.0" }, { name: "com.fasterxml.jackson.core:jackson-core", version: "2.17.0" }, { name: "nested", version: "1.0" }]) {
      expect((await read(await makeLayout({ javaScan: { text: finding(artifact) } }))).javaScan.highOpen, JSON.stringify(artifact)).toBe(1);
    }
  });
  it("refuses a missing, malformed, empty or non-CycloneDX dependency list", async () => {
    await refused({ javaSbom: "missing" }, /dependency list \(CycloneDX\) file is missing/u, "missing");
    await refused({ javaSbom: { text: "nope" } }, /not JSON/u, "not json");
    await refused({ javaSbom: { text: JSON.stringify({ bomFormat: "SPDX", components: [] }) } }, /not a CycloneDX/u, "wrong format");
    await refused({ javaSbom: { text: JSON.stringify({ bomFormat: "CycloneDX", components: [] }) } }, /no components/u, "empty list");
  });
  it("only BuildKit's attestation manifests are skipped in the index: any other entry without a real platform is refused", async () => {
    await refused({ extraIndexEntry: { mediaType: OCI_MANIFEST, digest: `sha256:${sha("x")}`, size: 1 } }, /neither a platform nor a known attestation/u, "no platform");
    await refused({ extraIndexEntry: { mediaType: OCI_MANIFEST, digest: `sha256:${sha("x")}`, size: 1, platform: { os: "unknown", architecture: "unknown" } } }, /neither a platform nor a known attestation/u, "unknown without annotation");
    await refused({ extraIndexEntry: { mediaType: OCI_MANIFEST, digest: `sha256:${sha("x")}`, size: 1, platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "something-else" } } }, /neither a platform nor a known attestation/u, "other annotation");
    const ok = await read(await makeLayout({ attestation: true }));
    expect(ok.children).toHaveLength(1);
  });
  it("refuses a resolved layout path that holds a colon, even when the written path has none (the base directory brings it)", async () => {
    const made = await makeLayout();
    const colon = join(made.root, "with:colon");
    await mkdir(colon, { recursive: true });
    await expect(readBuiltSource({ baseDir: colon })({ kind: "rovara-built", layout: "oci", digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile })).rejects.toThrow(/resolved\) holds ':'/u);
    await expect(readBuiltSource({ baseDir: colon })({ kind: "rovara-built", layout: join(made.root, "oci"), digestFile: made.digestFile, javaScan: made.javaScanFile, javaSbom: made.javaSbomFile })).resolves.toBeDefined();
  });
});
