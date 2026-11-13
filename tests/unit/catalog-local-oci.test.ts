// Real filesystem inputs, fake registry commands: never signs, authenticates or opens a network connection.
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CommandPort } from "../../scripts/catalog-build.js";
import { OCI_INDEX_MEDIA_TYPE, OCI_MANIFEST_MEDIA_TYPE, realRepackPorts, repackCatalog } from "../../scripts/catalog-repack.js";
import { unpinnedCatalog } from "../support/catalog-pinning.js";

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const identity = { runId: "43480470330", snapshotCommit: "a".repeat(40), workflow: "image.yml", builder: `sha256:${"b".repeat(64)}` };

async function fixture(id = "function-agent@r1", architectures = ["arm64"]) {
  const scratch = process.env["TMPDIR"];
  if (!scratch) throw new Error("TMPDIR must name the lane's scratch directory");
  const root = await mkdtemp(join(scratch, "catalog-local-oci-")); roots.push(root);
  const layout = join(root, "oci");
  await mkdir(join(layout, "blobs", "sha256"), { recursive: true });
  await mkdir(join(root, "work"));
  const blobs = new Map<string, Buffer>();
  const blob = async (data: Buffer, mediaType: string) => {
    const digest = `sha256:${sha(data)}`;
    blobs.set(digest, data);
    await writeFile(join(layout, "blobs", "sha256", digest.slice(7)), data);
    return { mediaType, digest, size: data.length };
  };
  const layer = await blob(Buffer.from("layer payload"), "application/vnd.oci.image.layer.v1.tar");
  const manifests = [];
  for (const architecture of architectures) {
    const config = await blob(bytes({ architecture, os: "linux" }), "application/vnd.oci.image.config.v1+json");
    const manifest = await blob(bytes({ schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA_TYPE, config, layers: [layer] }), OCI_MANIFEST_MEDIA_TYPE);
    manifests.push({ ...manifest, platform: { os: "linux", architecture } });
  }
  const index = await blob(bytes({ schemaVersion: 2, mediaType: OCI_INDEX_MEDIA_TYPE, manifests }), OCI_INDEX_MEDIA_TYPE);
  await writeFile(join(layout, "oci-layout"), bytes({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), bytes({ schemaVersion: 2, manifests: [index] }));
  const source = { kind: "local-oci", layout: "oci", sourceReference: `example.invalid/rovara/${id.split("@")[0]}@${index.digest}`, indexDigest: index.digest,
    platforms: Object.fromEntries(manifests.map((m) => [`linux/${m.platform.architecture}`, m.digest])), provenanceFile: "provenance.json", provenance: { ...identity } };
  const provenance = { schemaVersion: 1, id, ...identity, indexDigest: index.digest, platforms: { ...source.platforms } };
  const writeProvenance = () => writeFile(join(root, "provenance.json"), bytes(provenance));
  await writeProvenance();
  const calls: string[][] = [];
  let beforeCopy: (() => Promise<void>) | undefined;
  let failCopy = false;
  const served = new Map<string, Buffer>();
  const tags = new Map<string, string>();
  const commands: CommandPort = { async run(command, args) {
    calls.push([command, ...args]);
    if (command === "skopeo" && args.includes("inspect")) {
      const ref = args.at(-1) ?? "";
      const digest = ref.slice(ref.lastIndexOf("@") + 1);
      const data = served.get(digest) ?? blobs.get(digest);
      if (!data) throw new Error("missing fake manifest");
      return data;
    }
    if (command === "skopeo" && args.includes("copy")) {
      await beforeCopy?.();
      if (failCopy) throw new Error("copy deliberately failed");
      const from = args.at(-2) ?? "";
      const digest = (args.at(-1) ?? "").split("@")[1] ?? "";
      const data = from.startsWith("oci:") ? await readFile(join(from.slice(4), "blobs", "sha256", digest.slice(7))) : blobs.get(digest);
      if (!data) throw new Error("missing copy input");
      served.set(digest, data);
      return Buffer.alloc(0);
    }
    if (command === "oras" && args[0] === "manifest") {
      const data = await readFile(args.at(-1) ?? ""); served.set(`sha256:${sha(data)}`, data); return Buffer.alloc(0);
    }
    if (command === "oras" && args[0] === "resolve") return Buffer.from(tags.get(args.at(-1) ?? "") ?? "");
    if (command === "oras" && args[0] === "tag") {
      const ref = args.at(-2) ?? ""; const [repo, digest] = ref.split("@"); tags.set(`${repo}:${args.at(-1)}`, digest ?? ""); return Buffer.alloc(0);
    }
    throw new Error("unexpected command");
  } };
  const options = { commands, authFile: "unused-auth", copyTimeoutMs: 1000, localOci: { baseDir: root, workDir: join(root, "work") }, clock: { now: () => new Date("2026-11-13T12:00:00Z") },
    stage: async (data: Uint8Array) => { const path = join(root, "staged.json"); await writeFile(path, data); return { path, cleanup: () => rm(path) }; } };
  const run = (value: unknown = source) => repackCatalog({ catalog: unpinnedCatalog(), entries: [id], repack: { schemaVersion: 1, entries: { [id]: value } }, env: "staging", registry: "example.invalid", ports: realRepackPorts(options) });
  return { root, layout, layer, manifests, index, source, provenance, writeProvenance, run, calls, blobs, blob, options, setBeforeCopy: (fn: () => Promise<void>) => { beforeCopy = fn; }, failCopy: () => { failCopy = true; } };
}

async function refused(f: Awaited<ReturnType<typeof fixture>>, reason: RegExp) {
  await expect(f.run()).rejects.toThrow(reason);
  expect(f.calls).toEqual([]); // all guards run before registry reads/copies/pushes
  expect(await readdir(join(f.root, "work"))).toEqual([]);
}

describe("verified local OCI repack", () => {
  it.each([["function-agent@r1", ["arm64"]], ["model-stand-in@r1", ["arm64", "amd64"]]] as const)("repackages %s identically to registry bytes and cleans its snapshot", async (id, architectures) => {
    const f = await fixture(id, [...architectures]);
    const local = await f.run();
    expect(f.calls.some((c) => c[0] === "skopeo" && c.includes("copy") && c.some((a) => a.startsWith("oci:")))).toBe(true);
    const copies = f.calls.filter((c) => c[0] === "skopeo" && c.includes("copy"));
    expect(copies.map((c) => c.slice(1, 8)).sort()).toEqual([...architectures].sort().map((architecture) => ["--override-os", "linux", "--override-arch", architecture, "--override-variant", "", "copy"]));
    expect(copies.every((c) => c.includes("--preserve-digests"))).toBe(true);
    expect(f.calls.filter((c) => c.includes("inspect")).every((c) => c.at(-1)?.includes("rovara-catalog/staging/"))).toBe(true);
    const registry = await f.run(f.source.sourceReference);
    expect(local.sourcesBytes).toEqual(registry.sourcesBytes);
    expect(local.provenanceBytes).toEqual(registry.provenanceBytes);
    expect(await readdir(join(f.root, "work"))).toEqual([]);
  });
  it("refuses tampered layer bytes", async () => { const f = await fixture(); await writeFile(join(f.layout, "blobs", "sha256", f.layer.digest.slice(7)), "wrong payload"); await refused(f, /blob digest/); });
  it("refuses a wrong index pin", async () => { const f = await fixture(); f.source.indexDigest = `sha256:${"0".repeat(64)}`; f.source.sourceReference = `example.invalid/rovara/function-agent@${f.source.indexDigest}`; f.provenance.indexDigest = f.source.indexDigest; await f.writeProvenance(); await refused(f, /index digest/); });
  it("refuses a wrong platform pin", async () => { const f = await fixture(); f.source.platforms["linux/arm64"] = `sha256:${"0".repeat(64)}`; f.provenance.platforms = { ...f.source.platforms }; await f.writeProvenance(); await refused(f, /platform digest/); });
  it("refuses a required platform missing from layout", async () => { const f = await fixture("model-stand-in@r1"); await refused(f, /linux\/amd64/); });
  it("refuses extra platform pins", async () => { const f = await fixture(); f.source.platforms["linux/amd64"] = f.manifests[0]?.digest ?? ""; f.provenance.platforms = { ...f.source.platforms }; await f.writeProvenance(); await refused(f, /platform pins/); });
  it.each(["oci", "oci/blobs", "oci/blobs/sha256", "oci/index.json", "provenance.json", "oci/unused-link"])("refuses symlink %s", async (path) => {
    const f = await fixture(); const target = join(f.root, path); const saved = join(f.root, "saved");
    if (path !== "oci/unused-link") { const { rename } = await import("node:fs/promises"); await rename(target, saved); }
    await symlink(saved, target); await refused(f, /symlink/);
  });
  it("refuses path traversal", async () => { const f = await fixture(); f.source.layout = "oci/../oci"; await refused(f, /path/); });
  it("refuses a non-rovara-built catalog entry", async () => { const f = await fixture("postgres@16", ["arm64", "amd64"]); await refused(f, /rovara-built/); });
  it.each(["runId", "snapshotCommit", "workflow", "builder"] as const)("refuses mismatched provenance %s", async (key) => { const f = await fixture(); f.provenance[key] = { runId: "43480470331", snapshotCommit: "c".repeat(40), workflow: "other.yml", builder: `sha256:${"c".repeat(64)}` }[key]; await f.writeProvenance(); await refused(f, /provenance/); });
  it("refuses provenance digest mismatch", async () => { const f = await fixture(); f.provenance.indexDigest = `sha256:${"c".repeat(64)}`; await f.writeProvenance(); await refused(f, /provenance/); });
  it("refuses unknown provenance keys", async () => { const f = await fixture(); await writeFile(join(f.root, "provenance.json"), bytes({ ...f.provenance, extra: true })); await refused(f, /provenance/); });
  it("refuses unreadable provenance", async () => { const f = await fixture(); await rm(join(f.root, "provenance.json")); await refused(f, /local OCI/); });
  it("refuses oversized metadata", async () => { const f = await fixture(); const path = join(f.layout, "index.json"); const data = await readFile(path); await writeFile(path, Buffer.concat([data, Buffer.alloc(4 * 1024 * 1024 + 1 - data.length, 32)])); await refused(f, /size limit/); });
  it("accepts metadata at its stated limit", async () => { const f = await fixture(); const path = join(f.layout, "index.json"); const data = await readFile(path); await writeFile(path, Buffer.concat([data, Buffer.alloc(4 * 1024 * 1024 - data.length, 32)])); await expect(f.run()).resolves.toBeDefined(); });
  it("refuses descriptor size mismatch", async () => { const f = await fixture(); const top = { schemaVersion: 2, manifests: [{ ...f.index, size: f.index.size + 1 }] }; await writeFile(join(f.layout, "index.json"), bytes(top)); await refused(f, /descriptor size/); });
  it("refuses missing referenced blobs", async () => { const f = await fixture(); await rm(join(f.layout, "blobs", "sha256", f.layer.digest.slice(7))); await refused(f, /missing blob/); });
  it("refuses malformed descriptor paths", async () => {
    const f = await fixture(); const manifest = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA_TYPE, config: { ...f.layer, digest: "../../outside" }, layers: [] }), OCI_MANIFEST_MEDIA_TYPE);
    const index = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_INDEX_MEDIA_TYPE, manifests: [{ ...manifest, platform: { os: "linux", architecture: "arm64" } }] }), OCI_INDEX_MEDIA_TYPE);
    await writeFile(join(f.layout, "index.json"), bytes({ schemaVersion: 2, manifests: [index] }));
    f.source.indexDigest = index.digest; f.source.sourceReference = `example.invalid/rovara/function-agent@${index.digest}`; f.source.platforms = { "linux/arm64": manifest.digest }; f.provenance.indexDigest = index.digest; f.provenance.platforms = { ...f.source.platforms }; await f.writeProvenance(); await refused(f, /descriptor/);
  });
  it("copies a verified snapshot even when the input changes after validation", async () => {
    const f = await fixture();
    f.setBeforeCopy(async () => { await rm(f.layout, { recursive: true, force: true }); });
    await expect(f.run()).resolves.toBeDefined();
    expect(await readdir(join(f.root, "work"))).toEqual([]);
  });
  it("cleans the verified snapshot after copy failure", async () => { const f = await fixture(); f.failCopy(); await expect(f.run()).rejects.toThrow(/copy deliberately failed/); expect(await readdir(join(f.root, "work"))).toEqual([]); });
  it("refuses a source-reference digest that differs from the pin", async () => { const f = await fixture(); f.source.sourceReference = `example.invalid/rovara/function-agent@sha256:${"c".repeat(64)}`; await refused(f, /index digest/); });
  it("refuses hard-linked input", async () => { const f = await fixture(); await link(join(f.layout, "index.json"), join(f.root, "alias")); await refused(f, /hard-linked/); });
  it("refuses invalid layout marker", async () => { const f = await fixture(); await writeFile(join(f.layout, "oci-layout"), bytes({ imageLayoutVersion: "2.0.0" })); await refused(f, /layout marker/); });
  it("refuses unexpected blob paths", async () => { const f = await fixture(); await writeFile(join(f.layout, "extra"), "x"); await refused(f, /blob path/); });
  it("refuses excess directory depth", async () => { const f = await fixture(); await mkdir(join(f.layout, "a", "b", "c", "d"), { recursive: true }); await refused(f, /directory/); });
  it("refuses oversized blob before reading it", async () => { const f = await fixture(); const file = await open(join(f.layout, "blobs", "sha256", f.layer.digest.slice(7)), "w"); try { await file.truncate(64 * 1024 * 1024 + 1); } finally { await file.close(); } await refused(f, /size limit/); });
  it("accepts a blob at its stated limit", async () => { const f = await fixture(); await f.blob(Buffer.alloc(64 * 1024 * 1024), "application/octet-stream"); await expect(f.run()).resolves.toBeDefined(); });
  it("refuses file counts above the limit", async () => { const f = await fixture(); await Promise.all(Array.from({ length: 4097 }, (_, n) => writeFile(join(f.layout, "blobs", "sha256", n.toString(16).padStart(64, "0")), ""))); await refused(f, /file count/); });
  it("accepts exactly the total file count limit", async () => { const f = await fixture(); const original = (await readdir(join(f.layout, "blobs", "sha256"))).length; for (let n = original + 2; n < 4096; n++) await f.blob(Buffer.from(`extra-${n}`), "application/octet-stream"); await expect(f.run()).resolves.toBeDefined(); }, 30000);
  it("refuses absent local reader without falling back to a registry", async () => { const f = await fixture(); const ports = realRepackPorts(f.options); const registryPorts = { registry: ports.registry, indexes: ports.indexes, clock: ports.clock, files: ports.files }; await expect(repackCatalog({ catalog: unpinnedCatalog(), entries: ["function-agent@r1"], repack: { schemaVersion: 1, entries: { "function-agent@r1": f.source } }, env: "staging", registry: "example.invalid", ports: registryPorts })).rejects.toThrow(/reader is unavailable/); expect(f.calls).toEqual([]); });

  it("accepts the total blob byte limit and refuses one byte over", async () => {
    const f = await fixture();
    let remaining = 512 * 1024 * 1024 - [...f.blobs.values()].reduce((sum, value) => sum + value.length, 0);
    const block = Buffer.alloc(64 * 1024 * 1024);
    for (let n = 0; remaining > 0; n++) {
      block.fill(n); const data = block.subarray(0, Math.min(remaining, block.length));
      const desc = await f.blob(data, "application/octet-stream"); f.blobs.delete(desc.digest); remaining -= data.length;
    }
    await expect(f.run()).resolves.toBeDefined(); f.calls.length = 0;
    await f.blob(Buffer.from("x"), "application/octet-stream");
    await refused(f, /total size limit/);
  }, 120000);

  it("refuses nested image indexes before recursively expanding descriptors", async () => {
    const f = await fixture();
    const nested = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_INDEX_MEDIA_TYPE, manifests: [{ ...f.index, platform: { os: "linux", architecture: "arm64" } }] }), OCI_INDEX_MEDIA_TYPE);
    f.source.indexDigest = nested.digest; f.source.sourceReference = `example.invalid/rovara/function-agent@${nested.digest}`; f.source.platforms = { "linux/arm64": f.index.digest }; f.provenance.indexDigest = nested.digest; f.provenance.platforms = { ...f.source.platforms }; await f.writeProvenance();
    await writeFile(join(f.layout, "index.json"), bytes({ schemaVersion: 2, manifests: [nested] }));
    await refused(f, /nested image metadata/);
  });

  it("refuses unexpected empty directories rather than traversing arbitrary trees", async () => { const f = await fixture(); await mkdir(join(f.layout, "extra")); await refused(f, /directory/); });

  it("refuses provenance for another catalog id", async () => { const f = await fixture(); f.provenance.id = "model-stand-in@r1"; await f.writeProvenance(); await refused(f, /provenance mismatch/); });
  it("refuses provenance platform digest mismatch", async () => { const f = await fixture(); f.provenance.platforms["linux/arm64"] = `sha256:${"c".repeat(64)}`; await f.writeProvenance(); await refused(f, /provenance mismatch/); });
  it("refuses malformed provenance JSON", async () => { const f = await fixture(); await writeFile(join(f.root, "provenance.json"), "{"); await refused(f, /could not be read or parsed/); });
  it("refuses descriptor URLs even when local bytes exist", async () => {
    const f = await fixture(); const config = await f.blob(bytes({ architecture: "arm64", os: "linux" }), "application/vnd.oci.image.config.v1+json");
    const manifest = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA_TYPE, config, layers: [{ ...f.layer, urls: ["https://example.invalid/blob"] }] }), OCI_MANIFEST_MEDIA_TYPE);
    const index = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_INDEX_MEDIA_TYPE, manifests: [{ ...manifest, platform: { os: "linux", architecture: "arm64" } }] }), OCI_INDEX_MEDIA_TYPE);
    f.source.indexDigest = index.digest; f.source.sourceReference = `example.invalid/rovara/function-agent@${index.digest}`; f.source.platforms = { "linux/arm64": manifest.digest }; f.provenance.indexDigest = index.digest; f.provenance.platforms = { ...f.source.platforms }; await f.writeProvenance();
    await writeFile(join(f.layout, "index.json"), bytes({ schemaVersion: 2, manifests: [index] })); await refused(f, /descriptor/);
  });

  it("accepts maximum index descriptors and manifest layers while recording every dropped attestation", async () => {
    const f = await fixture(); const config = await f.blob(bytes({ architecture: "arm64", os: "linux" }), "application/vnd.oci.image.config.v1+json");
    const manifest = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA_TYPE, config, layers: Array.from({ length: 1024 }, () => f.layer) }), OCI_MANIFEST_MEDIA_TYPE);
    const main = { ...manifest, platform: { os: "linux", architecture: "arm64" } };
    const attestation = { ...manifest, platform: { os: "unknown", architecture: "unknown" }, annotations: { "vnd.docker.reference.type": "attestation-manifest" } };
    const index = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_INDEX_MEDIA_TYPE, manifests: [main, ...Array.from({ length: 255 }, () => attestation)] }), OCI_INDEX_MEDIA_TYPE);
    f.source.indexDigest = index.digest; f.source.sourceReference = `example.invalid/rovara/function-agent@${index.digest}`; f.source.platforms = { "linux/arm64": manifest.digest }; f.provenance.indexDigest = index.digest; f.provenance.platforms = { ...f.source.platforms }; await f.writeProvenance();
    await writeFile(join(f.layout, "index.json"), bytes({ schemaVersion: 2, manifests: [index] }));
    const output = await f.run(); expect(output.provenance.entries[0]?.dropped).toEqual(Array.from({ length: 255 }, () => ({ digest: manifest.digest, reason: "attestation" })));
  });

  it.each(["index subject", "manifest subject", "inline descriptor data"])("refuses unsupported %s references", async (where) => {
    const f = await fixture(); const config = await f.blob(bytes({ architecture: "arm64", os: "linux" }), "application/vnd.oci.image.config.v1+json");
    const manifest = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA_TYPE, config, layers: [{ ...f.layer, ...(where === "inline descriptor data" ? { data: Buffer.from("unverified inline bytes").toString("base64") } : {}) }], ...(where === "manifest subject" ? { subject: f.layer } : {}) }), OCI_MANIFEST_MEDIA_TYPE);
    const index = await f.blob(bytes({ schemaVersion: 2, mediaType: OCI_INDEX_MEDIA_TYPE, manifests: [{ ...manifest, platform: { os: "linux", architecture: "arm64" } }], ...(where === "index subject" ? { subject: f.layer } : {}) }), OCI_INDEX_MEDIA_TYPE);
    f.source.indexDigest = index.digest; f.source.sourceReference = `example.invalid/rovara/function-agent@${index.digest}`; f.source.platforms = { "linux/arm64": manifest.digest }; f.provenance.indexDigest = index.digest; f.provenance.platforms = { ...f.source.platforms }; await f.writeProvenance();
    await writeFile(join(f.layout, "index.json"), bytes({ schemaVersion: 2, manifests: [index] })); await refused(f, /local OCI/);
  });

});
