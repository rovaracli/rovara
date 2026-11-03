// Test services slice 2 (s2-catalog): a "Rovara-built" source for the emulator in scripts/catalog-build.ts. The source is the OCI layout and the digest file of the emulator fork's workflow artifact (UNSIGNED). catalog-build reads and
// verifies the layout on disk, pushes it by its digest, requires the registry to serve the same digest, and only then takes the SBOM, the scan and the signature. Everything runs against fakes and temporary folders: no process
// is started, no registry or credential is touched.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceCatalogSchema, sha256HexOf } from "@agentx/contracts";
import {
  BuiltSourceSchema,
  CatalogBuildError,
  SourcesFileSchema,
  buildPinnedCatalog,
  readBuiltSource,
  skopeoMirrorPort,
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
}
interface MadeLayout { root: string; layout: string; digestFile: string; digest: string; indexBytes: Buffer; children: Array<{ platform: string; digest: string }> }
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
  if (options.attestation === true) items.push({ mediaType: OCI_MANIFEST, digest: `sha256:${sha("attestation, never in the layout")}`, size: 10, platform: { os: "unknown", architecture: "unknown" } });
  const indexBytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: items }));
  const digest = hex(indexBytes);
  await put(digest, indexBytes, "index");
  const top: unknown[] = [{ mediaType: options.topMediaType ?? OCI_INDEX, digest: `sha256:${digest}`, size: indexBytes.byteLength }];
  if (options.extraTopManifest === true) top.push({ mediaType: OCI_INDEX, digest: `sha256:${sha("another image")}`, size: 1 });
  await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: top }));
  const digestFile = join(root, "index.digest");
  await writeFile(digestFile, options.digestText === undefined ? `sha256:${digest}\n` : options.digestText(digest));
  return { root, layout, digestFile, digest, indexBytes, children };
}
const sourceOf = (made: MadeLayout): SourcesFile => ({ schemaVersion: 1, sources: { [ID]: { kind: "rovara-built", layout: made.layout, digestFile: made.digestFile } } });

describe("the sources file", () => {
  it("still takes a registry digest reference, and takes a Rovara-built source with exactly three keys", () => {
    const registry = { schemaVersion: 1, sources: { "postgres@16": `registry.example.com/library/postgres@sha256:${sha("p")}` } };
    expect(SourcesFileSchema.safeParse(registry).success).toBe(true);
    expect(SourcesFileSchema.safeParse({ schemaVersion: 1, sources: { [ID]: { kind: "rovara-built", layout: "oci", digestFile: "index.digest" } } }).success).toBe(true);
  });
  it("refuses a built source with another kind, an extra key, a missing key, or a path skopeo would read as a reference or that holds a line break", () => {
    const base = { kind: "rovara-built", layout: "oci", digestFile: "index.digest" };
    for (const bad of [{ ...base, kind: "other" }, { ...base, extra: 1 }, { kind: "rovara-built", layout: "oci" }, { ...base, layout: "oci:latest" }, { ...base, layout: "" }, { ...base, digestFile: "a\nb" }, { ...base, layout: "a".repeat(1025) }]) {
      expect(BuiltSourceSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("reading and verifying a layout (readBuiltSource)", () => {
  it("returns the digest, the platforms with their own manifest digests (an attestation manifest is not a platform) and the absolute layout path", async () => {
    const made = await makeLayout({ platforms: ["linux/arm64", "linux/amd64"], attestation: true });
    const result = await readBuiltSource({ baseDir: "/nowhere" })({ kind: "rovara-built", layout: made.layout, digestFile: made.digestFile });
    expect(result).toEqual({ digest: made.digest, children: made.children, layoutPath: made.layout });
  });
  it("reads relative paths from the base directory (the sources file's)", async () => {
    const made = await makeLayout();
    const result = await readBuiltSource({ baseDir: made.root })({ kind: "rovara-built", layout: "oci", digestFile: "index.digest" });
    expect(result.layoutPath).toBe(made.layout);
    expect(result.digest).toBe(made.digest);
  });
  const read = (made: MadeLayout) => readBuiltSource({ baseDir: made.root })({ kind: "rovara-built", layout: made.layout, digestFile: made.digestFile });

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
    await expect(readBuiltSource({ baseDir: other.root })({ kind: "rovara-built", layout: other.layout, digestFile: join(other.root, "absent") })).rejects.toThrow(/digest file is missing/u);
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
    const sources: SourcesFile = { schemaVersion: 1, sources: { "postgres@16": { kind: "rovara-built", layout: made.layout, digestFile: made.digestFile } } };
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
    const output = await buildBuilt(realPorts(made, port), { schemaVersion: 1, sources: { [ID]: { kind: "rovara-built", layout: "oci", digestFile: "index.digest" } } });
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
