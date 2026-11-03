// Test services, lane ts-repack: the repackaging script (scripts/catalog-repack.ts), run against fakes. Nothing here starts a process, opens a network connection or reads a credential.
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServiceCatalogSchema } from "@agentx/contracts";
import { SourcesFileSchema, type CommandPort } from "../../scripts/catalog-build.js";
import {
  OCI_INDEX_MEDIA_TYPE,
  OCI_MANIFEST_MEDIA_TYPE,
  RepackError,
  nodeOutputCheckFs,
  RepackFileSchema,
  buildRepackIndex,
  orasIndexPort,
  parseRepackArgs,
  prepareRepackRun,
  realRepackPorts,
  preflightOutputs,
  repackCatalog,
  repackUsage,
  runRepack,
  selectPlatforms,
  skopeoRegistryPort,
  type ClockPort,
  type OutputCheckFs,
  type IndexPort,
  type OutputPort,
  type RegistryPort,
  type RepackPorts,
} from "../../scripts/catalog-repack.js";
import { unpinnedCatalog } from "../support/catalog-pinning.js";

const catalog = unpinnedCatalog();
const live = catalog.entries.filter((entry) => entry.status !== "retired");
const REGISTRY = "944937319445.dkr.ecr.us-west-2.amazonaws.com";
const NOW = "2026-11-03T10:00:00.000Z";
const hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_LIST = "application/vnd.docker.distribution.manifest.list.v2+json";

// ---- a fake world: one upstream registry and the Rovara staging registry, in memory

interface PlatformSpec { os: string; architecture: string; variant?: string }
interface UpstreamImage { index: Buffer; indexDigest: string; ref: string; repository: string; children: Map<string, { digest: string; bytes: Buffer }>; attestationDigests: string[] }
const childBytes = (id: string, platform: string): Buffer => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA_TYPE, config: { digest: `sha256:${hex(`config:${id}:${platform}`)}` }, layers: [] }));
const repositoryOf = (entry: { family: string }): string => `docker.io/library/${entry.family}`;

/** An upstream index for a catalog entry. `platforms` default to the catalog's two plus noise (a 386 image and an attestation manifest). */
function upstreamFor(entry: { id: string; family: string }, options: { platforms?: PlatformSpec[]; mediaType?: string; withAttestation?: boolean; childMediaType?: string; sizeOffset?: number } = {}): UpstreamImage {
  const platforms = options.platforms ?? [{ os: "linux", architecture: "amd64" }, { os: "linux", architecture: "arm64", variant: "v8" }, { os: "linux", architecture: "386" }];
  const children = new Map<string, { digest: string; bytes: Buffer }>();
  const manifests: unknown[] = [];
  for (const platform of platforms) {
    const key = `${platform.os}/${platform.architecture}${platform.variant === undefined ? "" : `/${platform.variant}`}`;
    const bytes = childBytes(entry.id, key);
    children.set(key, { digest: hex(bytes), bytes });
    manifests.push({ mediaType: options.childMediaType ?? OCI_MANIFEST_MEDIA_TYPE, digest: `sha256:${hex(bytes)}`, size: bytes.byteLength + (options.sizeOffset ?? 0), platform });
  }
  const attestationDigests: string[] = [];
  if (options.withAttestation !== false) {
    for (const platform of platforms.slice(0, 2)) {
      const bytes = Buffer.from(`attestation:${entry.id}:${platform.architecture}`);
      attestationDigests.push(hex(bytes));
      manifests.push({ mediaType: OCI_MANIFEST_MEDIA_TYPE, digest: `sha256:${hex(bytes)}`, size: bytes.byteLength, annotations: { "vnd.docker.reference.type": "attestation-manifest" }, platform: { os: "unknown", architecture: "unknown" } });
    }
  }
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: options.mediaType ?? OCI_INDEX_MEDIA_TYPE, manifests }));
  const indexDigest = hex(index);
  return { index, indexDigest, ref: `${repositoryOf(entry)}@sha256:${indexDigest}`, repository: repositoryOf(entry), children, attestationDigests };
}

interface WorldOptions {
  upstream?: (entry: { id: string; family: string }) => UpstreamImage;
  /** Called when a child is copied; return other bytes to land in the destination (an image that was rebuilt on the way). */
  landChild?: (digest: string, bytes: Buffer) => Buffer | undefined;
  /** Called when an index is pushed; return other bytes to land at that digest (a registry that stored something else). */
  landIndex?: (bytes: Buffer) => Buffer | undefined;
  skipTag?: boolean;
  failCopy?: (digest: string) => boolean;
  now?: string;
}
function world(options: WorldOptions = {}) {
  const stores = new Map<string, Map<string, Buffer>>();
  const store = (repository: string): Map<string, Buffer> => {
    let found = stores.get(repository);
    if (found === undefined) stores.set(repository, (found = new Map<string, Buffer>()));
    return found;
  };
  const images = new Map<string, UpstreamImage>();
  for (const entry of live) {
    const image = (options.upstream ?? ((e) => upstreamFor(e)))(entry);
    images.set(entry.id, image);
    store(image.repository).set(image.indexDigest, image.index);
    for (const child of image.children.values()) store(image.repository).set(child.digest, child.bytes);
  }
  const calls = { reads: [] as string[], copies: [] as string[], pushes: [] as Array<{ repository: string; digest: string; tag: string; mediaType: string; bytes: Buffer }>, writes: [] as Array<Array<{ path: string; bytes: Buffer }>> };
  const tags = new Map<string, string>();
  const registry: RegistryPort = {
    async readManifest({ repository, digest }) {
      calls.reads.push(`${repository}@${digest}`);
      const bytes = stores.get(repository)?.get(digest);
      if (bytes === undefined) throw new Error(`no manifest ${digest} in ${repository}`);
      return bytes;
    },
    async copyImage({ sourceRepository, destinationRepository, digest }) {
      calls.copies.push(`${sourceRepository}@${digest} -> ${destinationRepository}`);
      if (options.failCopy?.(digest)) throw new Error("copy failed");
      const bytes = stores.get(sourceRepository)?.get(digest);
      if (bytes === undefined) throw new Error("source child missing");
      store(destinationRepository).set(digest, options.landChild?.(digest, bytes) ?? bytes);
    },
  };
  const indexes: IndexPort = {
    async push({ repository, digest, mediaType, bytes: pushed, tag }) {
      const bytes = Buffer.from(pushed);
      calls.pushes.push({ repository, digest, mediaType, tag, bytes });
      store(repository).set(digest, options.landIndex?.(bytes) ?? bytes);
      if (options.skipTag !== true) tags.set(`${repository}:${tag}`, `sha256:${digest}`);
    },
    async resolveTag({ repository, tag }) {
      return tags.get(`${repository}:${tag}`);
    },
  };
  const clock: ClockPort = { now: () => new Date(options.now ?? NOW) };
  const files: OutputPort = { async write(list) { calls.writes.push([...list]); } };
  const ports: RepackPorts = { registry, indexes, clock, files };
  const repackFile = (change: (entries: Record<string, string>) => void = () => undefined): unknown => {
    const entries: Record<string, string> = Object.fromEntries(live.map((entry) => [entry.id, (images.get(entry.id) as UpstreamImage).ref]));
    change(entries);
    return { schemaVersion: 1, entries };
  };
  return { ports, calls, images, stores, tags, repackFile };
}
const destination = (repository: string): string => `${REGISTRY}/rovara-catalog/staging/${repository}`;
const run = (w: ReturnType<typeof world>, repack: unknown = w.repackFile(), overrides: { catalog?: unknown } = {}) =>
  repackCatalog({ catalog: overrides.catalog ?? catalog, repack, env: "staging", registry: REGISTRY, ports: w.ports });
const refusalsOf = async (promise: Promise<unknown>): Promise<Array<{ id: string; code: string }>> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RepackError) return error.refusals.map(({ id, code }) => ({ id, code }));
    throw error;
  }
  return [];
};
interface IndexDoc { schemaVersion: number; mediaType: string; manifests: Array<{ mediaType: string; digest: string; size: number; platform: { os: string; architecture: string; variant?: string } }>; annotations: Record<string, string> }
interface ProvenanceDoc { schemaVersion: number; repackedAt: string; env: string; registry: string; entries: Array<{ id: string; rovara: { reference: string }; dropped: unknown[] }> }
interface SourcesDoc { schemaVersion: number; sources: Record<string, string> }
const containing = (fragment: string): string => expect.stringContaining(fragment) as string;
const anyString = (): string => expect.any(String) as string;
const arrayWith = (...items: unknown[]): unknown[] => expect.arrayContaining(items) as unknown[];
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");
const parsed = (bytes: Uint8Array): IndexDoc => JSON.parse(text(bytes)) as IndexDoc;
const parsedProvenance = (bytes: Uint8Array): ProvenanceDoc => JSON.parse(text(bytes)) as ProvenanceDoc;
const parsedSources = (bytes: Uint8Array): SourcesDoc => JSON.parse(text(bytes)) as SourcesDoc;
const upstreamIndexOf = (image: UpstreamImage): { manifests: unknown[]; [key: string]: unknown } => JSON.parse(image.index.toString("utf8")) as { manifests: unknown[] };

describe("repacking an entry", () => {
  it("copies exactly the catalog's two child manifests by digest, builds a two-child index with the annotations, pushes it by digest with the digest-prefix tag, and records it in the sources file", async () => {
    const w = world();
    const output = await run(w);
    const postgres = w.images.get("postgres@16") as UpstreamImage;
    const amd64 = (postgres.children.get("linux/amd64") as { digest: string }).digest;
    const arm64 = (postgres.children.get("linux/arm64/v8") as { digest: string }).digest;
    expect(w.calls.copies).toContain(`docker.io/library/postgres@${amd64} -> ${destination("svc/postgres")}`);
    expect(w.calls.copies).toContain(`docker.io/library/postgres@${arm64} -> ${destination("svc/postgres")}`);
    expect(w.calls.copies).toHaveLength(live.length * 2);
    const push = w.calls.pushes.find((candidate) => parsed(candidate.bytes).annotations["io.rovara.repack.source.digest"] === `sha256:${postgres.indexDigest}`) as (typeof w.calls.pushes)[number];
    expect(push.repository).toBe(destination("svc/postgres"));
    expect(push.mediaType).toBe(OCI_INDEX_MEDIA_TYPE);
    expect(push.digest).toBe(hex(push.bytes));
    expect(push.tag).toBe(push.digest.slice(0, 32));
    const index = parsed(push.bytes);
    expect(index).toMatchObject({ schemaVersion: 2, mediaType: OCI_INDEX_MEDIA_TYPE });
    expect(index.manifests.map((m) => `${m.platform.os}/${m.platform.architecture}:${m.digest}:${m.mediaType}`)).toEqual([`linux/amd64:sha256:${amd64}:${OCI_MANIFEST_MEDIA_TYPE}`, `linux/arm64:sha256:${arm64}:${OCI_MANIFEST_MEDIA_TYPE}`]);
    expect(index.annotations).toEqual({ "io.rovara.repack.source.digest": `sha256:${postgres.indexDigest}`, "io.rovara.repack.source.reference": postgres.ref, "io.rovara.repack.time": NOW });
    const sources = SourcesFileSchema.parse(parsedSources(output.sourcesBytes));
    expect(Object.keys(sources.sources).sort()).toEqual(live.map((entry) => entry.id).sort());
    expect(sources.sources["postgres@16"]).toBe(`${destination("svc/postgres")}@sha256:${push.digest}`);
    expect(w.tags.get(`${destination("svc/postgres")}:${push.tag}`)).toBe(`sha256:${push.digest}`);
  });

  it("gives the three postgres majors one repository and three different indexes", async () => {
    const w = world();
    const output = await run(w);
    const sources = SourcesFileSchema.parse(parsedSources(output.sourcesBytes)).sources;
    const postgres = ["postgres@15", "postgres@16", "postgres@17"].map((id) => sources[id] as string);
    expect(new Set(postgres).size).toBe(3);
    for (const reference of postgres) expect(reference.startsWith(`${destination("svc/postgres")}@sha256:`)).toBe(true);
  });

  it("writes the sources file and the provenance record, in that order of importance (sources last), only after everything verified", async () => {
    const w = world();
    const logged: string[] = [];
    const ports: RepackPorts = { ...w.ports, files: { async write(list) { logged.push(...list.map((item) => item.path)); await w.ports.files.write(list); } } };
    await runRepack({ catalog, repack: w.repackFile(), env: "staging", registry: REGISTRY, ports, outputs: { sourcesFile: "/out/sources.json", provenanceFile: "/out/provenance.json" } });
    expect(logged).toEqual(["/out/provenance.json", "/out/sources.json"]);
    expect(w.calls.pushes).toHaveLength(live.length);
  });
});

describe("platform selection", () => {
  const entry = { id: "postgres@16", family: "postgres" };
  const wanted = ["linux/arm64", "linux/amd64"];
  const indexOf = upstreamIndexOf;

  it("keeps exactly the catalog's platforms and drops every other platform and the attestation manifests", () => {
    const image = upstreamFor(entry, { platforms: [{ os: "linux", architecture: "amd64" }, { os: "linux", architecture: "arm64", variant: "v8" }, { os: "linux", architecture: "386" }, { os: "linux", architecture: "arm", variant: "v7" }, { os: "windows", architecture: "amd64" }] });
    const result = selectPlatforms(indexOf(image), wanted);
    if (!result.ok) throw new Error(result.problem);
    expect(result.selected.map((child) => child.platformName)).toEqual(["linux/amd64", "linux/arm64"]);
    expect(result.dropped.map((item) => item.reason).sort()).toEqual(["attestation", "attestation", "other_platform", "other_platform", "other_platform"]);
    expect(result.dropped.map((item) => item.digest)).toEqual(expect.arrayContaining(image.attestationDigests.map((d) => `sha256:${d}`)));
  });

  it("refuses an index that lacks a wanted platform, whichever one", () => {
    expect(selectPlatforms(indexOf(upstreamFor(entry, { platforms: [{ os: "linux", architecture: "amd64" }, { os: "linux", architecture: "386" }] })), wanted)).toMatchObject({ ok: false, problem: containing("linux/arm64") });
    expect(selectPlatforms(indexOf(upstreamFor(entry, { platforms: [{ os: "linux", architecture: "arm64" }] })), wanted)).toMatchObject({ ok: false, problem: containing("linux/amd64") });
  });

  it("does not count an attestation manifest as a platform, even one that claims linux/arm64", () => {
    const image = indexOf(upstreamFor(entry, { platforms: [{ os: "linux", architecture: "amd64" }] }));
    image.manifests.push({ mediaType: OCI_MANIFEST_MEDIA_TYPE, digest: `sha256:${hex("fake")}`, size: 4, annotations: { "vnd.docker.reference.type": "attestation-manifest" }, platform: { os: "linux", architecture: "arm64" } });
    expect(selectPlatforms(image, wanted)).toMatchObject({ ok: false });
  });

  it("refuses a platform listed twice (two different images claim it), and a platform that is itself an index", () => {
    const image = indexOf(upstreamFor(entry, { platforms: [{ os: "linux", architecture: "amd64" }, { os: "linux", architecture: "arm64" }] }));
    image.manifests.push({ ...(image.manifests[0] as object), digest: `sha256:${hex("other")}` });
    expect(selectPlatforms(image, wanted)).toMatchObject({ ok: false, problem: containing("more than once") });
    const nested = indexOf(upstreamFor(entry, { platforms: [{ os: "linux", architecture: "amd64" }, { os: "linux", architecture: "arm64" }], childMediaType: OCI_INDEX_MEDIA_TYPE }));
    expect(selectPlatforms(nested, wanted)).toMatchObject({ ok: false, problem: containing("image manifest") });
  });

  it("accepts a Docker manifest list and Docker v2 child manifests, and still writes an OCI index", async () => {
    const w = world({ upstream: (e) => upstreamFor(e, { mediaType: DOCKER_LIST, childMediaType: DOCKER_MANIFEST, withAttestation: false }) });
    await run(w);
    const index = parsed(w.calls.pushes[0]?.bytes as Buffer);
    expect(index.mediaType).toBe(OCI_INDEX_MEDIA_TYPE);
    expect(index.manifests.every((m) => m.mediaType === DOCKER_MANIFEST)).toBe(true);
  });

  it("repacks only the platforms the catalog entry lists (a one-platform entry gets a one-child index)", async () => {
    const single = ServiceCatalogSchema.parse({ ...catalog, entries: catalog.entries.map((e) => (e.id === "postgres@16" ? { ...e, image: { ...e.image, platforms: ["linux/arm64"] } } : e)) });
    const w = world();
    await run(w, w.repackFile(), { catalog: single });
    const pushed = w.calls.pushes.map((push) => parsed(push.bytes)).find((index) => (index.annotations["io.rovara.repack.source.reference"] ?? "").includes("postgres") && index.manifests.length === 1);
    expect(pushed?.manifests[0]?.platform.architecture).toBe("arm64");
  });

  it("refuses the entry in a run, with nothing copied or written", async () => {
    const w = world({ upstream: (e) => (e.id === "mysql@8" ? upstreamFor(e, { platforms: [{ os: "linux", architecture: "amd64" }] }) : upstreamFor(e)) });
    expect(await refusalsOf(runRepack({ catalog, repack: w.repackFile(), env: "staging", registry: REGISTRY, ports: w.ports, outputs: { sourcesFile: "/o/s.json", provenanceFile: "/o/p.json" } }))).toEqual([{ id: "mysql@8", code: "platform_missing" }]);
    expect(w.calls.copies).toEqual([]);
    expect(w.calls.pushes).toEqual([]);
    expect(w.calls.writes).toEqual([]);
  });
});

describe("digest verification", () => {
  it("refuses an upstream index whose bytes do not hash to the digest the operator reviewed", async () => {
    const w = world();
    const image = w.images.get("redis@7") as UpstreamImage;
    w.stores.get(image.repository)?.set(image.indexDigest, Buffer.concat([image.index, Buffer.from(" ")]));
    expect(await refusalsOf(run(w))).toEqual([{ id: "redis@7", code: "upstream_digest_mismatch" }]);
    expect(w.calls.copies).toEqual([]);
  });

  it("refuses an upstream manifest that is not an index (one platform cannot make two)", async () => {
    const w = world({ upstream: (e) => {
      const image = upstreamFor(e);
      const single = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA_TYPE, config: {}, layers: [] }));
      return { ...image, index: single, indexDigest: hex(single), ref: `${image.repository}@sha256:${hex(single)}` };
    } });
    const refusals = await refusalsOf(run(w));
    expect(new Set(refusals.map((r) => r.code))).toEqual(new Set(["upstream_not_index"]));
    expect(refusals).toHaveLength(live.length);
  });

  it("refuses an index that is not JSON", async () => {
    const w = world({ upstream: (e) => {
      const image = upstreamFor(e);
      const junk = Buffer.from("not json");
      return { ...image, index: junk, indexDigest: hex(junk), ref: `${image.repository}@sha256:${hex(junk)}` };
    } });
    expect(new Set((await refusalsOf(run(w))).map((r) => r.code))).toEqual(new Set(["upstream_not_index"]));
  });

  it("refuses when the upstream cannot be read (a port failure is a refusal, never a pass)", async () => {
    const w = world();
    const image = w.images.get("valkey@8") as UpstreamImage;
    w.stores.get(image.repository)?.delete(image.indexDigest);
    expect(await refusalsOf(run(w))).toEqual([{ id: "valkey@8", code: "port_failed" }]);
  });
});

describe("the repack file", () => {
  it.each([
    ["a tag", "docker.io/library/postgres:16"],
    ["a tag with no host", "postgres:16"],
    ["latest implied (no tag, no digest)", "docker.io/library/postgres"],
    ["a tag next to a digest", `docker.io/library/postgres:16@sha256:${hex("x")}`],
  ])("refuses %s, before any registry is touched", async (_name, reference) => {
    const w = world();
    const refusals = await refusalsOf(run(w, w.repackFile((entries) => { entries["postgres@16"] = reference; })));
    expect(refusals).toEqual([{ id: "postgres@16", code: "tag_refused" }]);
    expect(w.calls.reads).toEqual([]);
    expect(w.calls.copies).toEqual([]);
  });

  it("refuses a malformed digest", async () => {
    const w = world();
    const refusals = await refusalsOf(run(w, w.repackFile((entries) => { entries["postgres@16"] = "docker.io/library/postgres@sha256:abc"; })));
    expect(refusals).toEqual([{ id: "postgres@16", code: "bad_reference" }]);
  });

  it("refuses a live entry with no upstream, an id the catalog does not have, and a retired entry", async () => {
    const w = world();
    expect(await refusalsOf(run(w, w.repackFile((entries) => { delete entries["redis@7"]; })))).toEqual([{ id: "redis@7", code: "no_upstream" }]);
    expect(await refusalsOf(run(w, w.repackFile((entries) => { entries["nosuch@1"] = (w.images.get("redis@7") as UpstreamImage).ref; })))).toEqual([{ id: "nosuch@1", code: "unknown_id" }]);
    const retired = ServiceCatalogSchema.parse({ ...catalog, entries: catalog.entries.map((e) => (e.id === "redis@7" ? { ...e, status: "retired" } : e)) });
    expect(await refusalsOf(run(w, w.repackFile(), { catalog: retired }))).toEqual([{ id: "redis@7", code: "retired_entry" }]);
    expect(w.calls.copies).toEqual([]);
  });

  it("is strict: an unknown field or a wrong schema version is an error, not ignored", () => {
    expect(() => RepackFileSchema.parse({ schemaVersion: 1, entries: {}, extra: 1 })).toThrow();
    expect(() => RepackFileSchema.parse({ schemaVersion: 2, entries: {} })).toThrow();
  });
});

describe("child digests are upstream's", () => {
  it("refuses a copy that landed other bytes under the child's digest (a rebuild)", async () => {
    const w = world({ landChild: (_digest, bytes) => Buffer.concat([bytes, Buffer.from(" ")]) });
    const refusals = await refusalsOf(run(w));
    expect(refusals[0]?.code).toBe("child_digest_changed");
    expect(w.calls.pushes).toEqual([]);
  });

  it("builds the index from the upstream descriptors without changing a digest, size or media type", () => {
    const image = upstreamFor({ id: "postgres@16", family: "postgres" });
    const selection = selectPlatforms(upstreamIndexOf(image), ["linux/arm64", "linux/amd64"]);
    if (!selection.ok) throw new Error(selection.problem);
    const built = buildRepackIndex({ children: selection.selected, sourceReference: image.ref, sourceDigest: image.indexDigest, repackedAt: NOW });
    expect(built.digest).toBe(hex(built.bytes));
    const index = parsed(built.bytes);
    for (const descriptor of index.manifests) {
      const upstream = [...image.children.values()].find((child) => `sha256:${child.digest}` === descriptor.digest) as { bytes: Buffer };
      expect(descriptor.size).toBe(upstream.bytes.byteLength);
    }
    expect(index.manifests.map((m) => m.digest)).toEqual(selection.selected.map((child) => `sha256:${child.digest}`));
  });

  it("refuses when the registry stores an index other than the one pushed (the index must re-hash to its digest)", async () => {
    const w = world({ landIndex: (bytes) => Buffer.concat([bytes, Buffer.from("\n")]) });
    expect((await refusalsOf(run(w)))[0]?.code).toBe("index_verify_failed");
  });

  it("refuses when the pushed index lists other children than upstream's two (even if it re-hashes correctly)", async () => {
    // A registry that returns, at the pushed digest, a well-formed index with an extra child: the bytes differ from what was built, so it is refused.
    const w = world({ landIndex: (bytes) => { const index = parsed(bytes); index.manifests.push(index.manifests[0] as IndexDoc["manifests"][number]); return Buffer.from(JSON.stringify(index)); } });
    expect((await refusalsOf(run(w)))[0]?.code).toBe("index_verify_failed");
  });

  it("refuses when the digest tag does not resolve to the pushed index (lifecycle would expire an untagged index)", async () => {
    const w = world({ skipTag: true });
    expect((await refusalsOf(run(w)))[0]?.code).toBe("tag_missing");
  });

  it("refuses when a copy fails, with nothing written", async () => {
    const w = world({ failCopy: () => true });
    expect(await refusalsOf(runRepack({ catalog, repack: w.repackFile(), env: "staging", registry: REGISTRY, ports: w.ports, outputs: { sourcesFile: "/o/s", provenanceFile: "/o/p" } }))).toEqual([{ id: anyString(), code: "port_failed" }]);
    expect(w.calls.writes).toEqual([]);
  });
});

describe("abort before write", () => {
  it("writes nothing and pushes nothing when one entry among many is refused in the read phase", async () => {
    const w = world({ upstream: (e) => (e.id === "rabbitmq@3" ? upstreamFor(e, { platforms: [{ os: "linux", architecture: "arm64" }] }) : upstreamFor(e)) });
    const refusals = await refusalsOf(runRepack({ catalog, repack: w.repackFile(), env: "staging", registry: REGISTRY, ports: w.ports, outputs: { sourcesFile: "/o/s", provenanceFile: "/o/p" } }));
    expect(refusals).toEqual([{ id: "rabbitmq@3", code: "platform_missing" }]);
    expect(w.calls.copies).toEqual([]);
    expect(w.calls.pushes).toEqual([]);
    expect(w.calls.writes).toEqual([]);
  });

  it("writes nothing when a later entry fails verification after earlier entries were pushed", async () => {
    let pushes = 0;
    const w = world({ landIndex: (bytes) => (++pushes === 5 ? Buffer.concat([bytes, Buffer.from("x")]) : undefined) });
    const refusals = await refusalsOf(runRepack({ catalog, repack: w.repackFile(), env: "staging", registry: REGISTRY, ports: w.ports, outputs: { sourcesFile: "/o/s", provenanceFile: "/o/p" } }));
    expect(refusals).toHaveLength(1);
    expect(w.calls.pushes.length).toBeGreaterThanOrEqual(5);
    expect(w.calls.writes).toEqual([]);
  });

  it("lists every refusal found in the read phase together", async () => {
    const w = world({ upstream: (e) => (e.id.startsWith("postgres@1") ? upstreamFor(e, { platforms: [{ os: "linux", architecture: "arm64" }] }) : upstreamFor(e)) });
    expect((await refusalsOf(run(w))).map((r) => r.id).sort()).toEqual(["postgres@15", "postgres@16", "postgres@17"]);
  });
});

describe("determinism", () => {
  it("gives byte-identical sources, provenance and indexes for the same inputs and time", async () => {
    const first = world();
    const second = world();
    const a = await run(first);
    const b = await run(second);
    expect(Buffer.compare(a.sourcesBytes, b.sourcesBytes)).toBe(0);
    expect(Buffer.compare(a.provenanceBytes, b.provenanceBytes)).toBe(0);
    expect(first.calls.pushes.map((push) => push.digest)).toEqual(second.calls.pushes.map((push) => push.digest));
  });

  it("does not depend on the order in which the upstream index lists its manifests", () => {
    const image = upstreamFor({ id: "postgres@16", family: "postgres" });
    const forward = upstreamIndexOf(image);
    const reversed = { ...forward, manifests: [...forward.manifests].reverse() };
    const build = (index: unknown): Buffer => {
      const selection = selectPlatforms(index, ["linux/arm64", "linux/amd64"]);
      if (!selection.ok) throw new Error(selection.problem);
      return buildRepackIndex({ children: selection.selected, sourceReference: image.ref, sourceDigest: image.indexDigest, repackedAt: NOW }).bytes;
    };
    expect(Buffer.compare(build(forward), build(reversed))).toBe(0);
  });

  it("lists the sources file's ids in sorted order (so a diff between two runs is a diff of the images)", async () => {
    const output = await run(world());
    const ids = Object.keys(SourcesFileSchema.parse(parsedSources(output.sourcesBytes)).sources);
    expect(ids).toEqual([...ids].sort());
  });

  it("lists the dropped manifests in digest order, whatever order upstream lists them in", () => {
    const image = upstreamFor({ id: "postgres@16", family: "postgres" });
    const forward = upstreamIndexOf(image);
    const droppedOf = (index: unknown): unknown => {
      const selection = selectPlatforms(index, ["linux/arm64", "linux/amd64"]);
      if (!selection.ok) throw new Error(selection.problem);
      return selection.dropped;
    };
    const dropped = droppedOf(forward) as Array<{ digest: string }>;
    expect(dropped.length).toBeGreaterThan(1);
    expect(dropped.map((item) => item.digest)).toEqual([...dropped.map((item) => item.digest)].sort());
    expect(droppedOf({ ...forward, manifests: [...forward.manifests].reverse() })).toEqual(dropped);
  });

  it("is byte-identical when the repack file lists the entries in another order", async () => {
    const w = world();
    const a = await run(w);
    const entries = (w.repackFile() as { entries: Record<string, string> }).entries;
    const b = await run(w, { schemaVersion: 1, entries: Object.fromEntries(Object.entries(entries).reverse()) });
    expect(Buffer.compare(a.sourcesBytes, b.sourcesBytes)).toBe(0);
    expect(Buffer.compare(a.provenanceBytes, b.provenanceBytes)).toBe(0);
  });

  it("reads the clock once: every index of a run carries the same repack time", async () => {
    let calls = 0;
    const w = world();
    const ports: RepackPorts = { ...w.ports, clock: { now: () => new Date(Date.parse(NOW) + 1000 * calls++) } };
    await repackCatalog({ catalog, repack: w.repackFile(), env: "staging", registry: REGISTRY, ports });
    expect(calls).toBe(1);
    expect(new Set(w.calls.pushes.map((push) => parsed(push.bytes).annotations["io.rovara.repack.time"]))).toEqual(new Set([NOW]));
  });

  it("the repack time is part of the index: another time is another digest (documented; pin the time with --repack-time to re-run)", async () => {
    const a = world({ now: "2026-11-03T10:00:00.000Z" });
    const b = world({ now: "2026-11-03T11:00:00.000Z" });
    await run(a);
    await run(b);
    expect(a.calls.pushes[0]?.digest).not.toBe(b.calls.pushes[0]?.digest);
  });
});

describe("the provenance record", () => {
  it("records, for every entry, the upstream reference and digest, the Rovara index, the child digests and the time", async () => {
    const w = world();
    const output = await run(w);
    const record = parsedProvenance(output.provenanceBytes);
    expect(record).toMatchObject({ schemaVersion: 1, repackedAt: NOW, env: "staging", registry: REGISTRY });
    expect(record.entries.map((e) => e.id)).toEqual(live.map((e) => e.id).sort());
    const entry = record.entries.find((e) => e.id === "postgres@16");
    const upstream = w.images.get("postgres@16") as UpstreamImage;
    const push = w.calls.pushes.find((p) => parsed(p.bytes).annotations["io.rovara.repack.source.digest"] === `sha256:${upstream.indexDigest}`) as (typeof w.calls.pushes)[number];
    expect(entry).toEqual({
      id: "postgres@16",
      upstream: { reference: upstream.ref, digest: `sha256:${upstream.indexDigest}` },
      rovara: { repository: "rovara-catalog/staging/svc/postgres", reference: `${destination("svc/postgres")}@sha256:${push.digest}`, digest: `sha256:${push.digest}`, tag: push.digest.slice(0, 32) },
      children: [
        { platform: "linux/amd64", digest: `sha256:${(upstream.children.get("linux/amd64") as { digest: string }).digest}`, mediaType: OCI_MANIFEST_MEDIA_TYPE, size: (upstream.children.get("linux/amd64") as { bytes: Buffer }).bytes.byteLength },
        { platform: "linux/arm64", digest: `sha256:${(upstream.children.get("linux/arm64/v8") as { digest: string }).digest}`, mediaType: OCI_MANIFEST_MEDIA_TYPE, size: (upstream.children.get("linux/arm64/v8") as { bytes: Buffer }).bytes.byteLength },
      ],
      dropped: arrayWith({ digest: `sha256:${upstream.attestationDigests[0]}`, reason: "attestation" }),
    });
    expect(entry?.dropped).toHaveLength(3);
  });

  it("is also written beside the sources file, which it agrees with", async () => {
    const w = world();
    await runRepack({ catalog, repack: w.repackFile(), env: "staging", registry: REGISTRY, ports: w.ports, outputs: { sourcesFile: "/out/sources.json", provenanceFile: "/out/provenance.json" } });
    const written = Object.fromEntries((w.calls.writes[0] ?? []).map((item) => [item.path, JSON.parse(text(item.bytes)) as unknown])) as { "/out/provenance.json": ProvenanceDoc; "/out/sources.json": SourcesDoc };
    for (const entry of written["/out/provenance.json"].entries) expect(written["/out/sources.json"].sources[entry.id]).toBe(entry.rovara.reference);
  });
});

describe("the real ports build their commands from digests (and are not run)", () => {
  const recorder = (outputs: Record<string, string> = {}) => {
    const log: string[][] = [];
    const commands: CommandPort = { async run(file, args) { log.push([file, ...args]); return Buffer.from(outputs[file] ?? ""); } };
    return { log, commands };
  };
  const digest = hex("c");

  it("skopeo reads and copies by digest, with the credential file and never a tag", async () => {
    const { log, commands } = recorder();
    const port = skopeoRegistryPort({ commands, authFile: "/auth/config.json" });
    await port.readManifest({ repository: "docker.io/library/postgres", digest });
    await port.copyImage({ sourceRepository: "docker.io/library/postgres", destinationRepository: destination("svc/postgres"), digest });
    expect(log).toEqual([
      ["skopeo", "inspect", "--raw", "--authfile", "/auth/config.json", `docker://docker.io/library/postgres@sha256:${digest}`],
      ["skopeo", "copy", "--preserve-digests", "--dest-authfile", "/auth/config.json", `docker://docker.io/library/postgres@sha256:${digest}`, `docker://${destination("svc/postgres")}@sha256:${digest}`],
    ]);
  });

  /** A fake oras: `manifest push` stores nothing, `tag` records the tag, `resolve` prints the digest of an existing tag and fails (exit 1) for a missing one. */
  const fakeOras = (tags: Record<string, string>) => {
    const log: string[][] = [];
    const commands: CommandPort = {
      async run(file, args) {
        log.push([file, ...args]);
        if (args[0] === "resolve") {
          const found = tags[args[args.length - 1] as string];
          if (found === undefined) throw new Error("not found");
          return Buffer.from(`${found}\n`);
        }
        if (args[0] === "tag") tags[`${(args[args.length - 2] as string).split("@")[0] as string}:${args[args.length - 1] as string}`] = (args[args.length - 2] as string).split("@")[1] as string;
        return Buffer.from("");
      },
    };
    const port = orasIndexPort({ commands, authFile: "/auth/config.json", stage: async () => ({ path: "/stage/index.json", cleanup: async () => undefined }) });
    return { log, port, tags };
  };
  const pushInput = { repository: destination("svc/postgres"), digest, mediaType: OCI_INDEX_MEDIA_TYPE, bytes: Buffer.from("{}"), tag: digest.slice(0, 32) };
  const tagRef = `${destination("svc/postgres")}:${digest.slice(0, 32)}`;
  const pushArgs = ["oras", "manifest", "push", "--registry-config", "/auth/config.json", "--media-type", OCI_INDEX_MEDIA_TYPE, `${destination("svc/postgres")}@sha256:${digest}`, "/stage/index.json"];
  const resolveArgs = ["oras", "resolve", "--registry-config", "/auth/config.json", tagRef];

  it("oras pushes the index by digest, looks at the tag, tags it only when it is missing, and resolves the tag", async () => {
    const { log, port } = fakeOras({});
    await port.push(pushInput);
    expect(await port.resolveTag({ repository: destination("svc/postgres"), tag: digest.slice(0, 32) })).toBe(`sha256:${digest}`);
    expect(log).toEqual([pushArgs, resolveArgs, ["oras", "tag", "--registry-config", "/auth/config.json", `${destination("svc/postgres")}@sha256:${digest}`, digest.slice(0, 32)], resolveArgs]);
  });

  it("does not tag again when the tag already points at this digest (a retry in an immutable repository)", async () => {
    const { log, port } = fakeOras({ [tagRef]: `sha256:${digest}` });
    await port.push(pushInput);
    expect(log).toEqual([pushArgs, resolveArgs]);
  });

  it("fails, and never moves the tag, when the tag already points at another digest", async () => {
    const { log, port } = fakeOras({ [tagRef]: `sha256:${hex("other")}` });
    await expect(port.push(pushInput)).rejects.toThrow(/already points at/u);
    expect(log.some((entry) => entry[1] === "tag")).toBe(false);
  });

  it("gives skopeo copy 45 minutes and leaves inspect and every oras command on the port default", async () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number | undefined }> = [];
    const commands: CommandPort = { async run(file, args, options) { calls.push({ file, args, timeoutMs: options?.timeoutMs }); return Buffer.from(`sha256:${digest}`); } };
    const registry = skopeoRegistryPort({ commands, authFile: "/a" });
    await registry.readManifest({ repository: "docker.io/library/postgres", digest });
    await registry.copyImage({ sourceRepository: "docker.io/library/postgres", destinationRepository: destination("svc/postgres"), digest });
    await skopeoRegistryPort({ commands, authFile: "/a", copyTimeoutMs: 5_000 }).copyImage({ sourceRepository: "a/b", destinationRepository: "c/d", digest });
    const oras = orasIndexPort({ commands, authFile: "/a", stage: async () => ({ path: "/s", cleanup: async () => undefined }) });
    await oras.resolveTag({ repository: "c/d", tag: "t" });
    expect(calls.map((call) => `${call.file} ${call.args[0] as string} ${String(call.timeoutMs)}`)).toEqual(["skopeo inspect undefined", "skopeo copy 2700000", "skopeo copy 5000", "oras resolve undefined"]);
  });

  it("assembles the real ports with the copy timeout the command line gave", async () => {
    const seen: Array<number | undefined> = [];
    const commands: CommandPort = { async run(_file, args, options) { if (args[0] === "copy") seen.push(options?.timeoutMs); return Buffer.from(""); } };
    const ports = realRepackPorts({ commands, authFile: "/a", copyTimeoutMs: 123_000, clock: { now: () => new Date(NOW) }, stage: async () => ({ path: "/s", cleanup: async () => undefined }) });
    await ports.registry.copyImage({ sourceRepository: "a/b", destinationRepository: "c/d", digest });
    expect(seen).toEqual([123_000]);
  });

  it("treats a tag that appears between the look and the tag as success, and still fails when it did not appear", async () => {
    const ref = `${destination("svc/postgres")}@sha256:${digest}`;
    const build = (afterTagFailure: string | undefined) => {
      let tagFailed = false;
      const commands: CommandPort = {
        async run(_file, args) {
          if (args[0] === "tag") { tagFailed = true; throw new Error("tag invalid: already exists"); }
          if (args[0] === "resolve") {
            if (!tagFailed || afterTagFailure === undefined) throw new Error("not found");
            return Buffer.from(afterTagFailure);
          }
          return Buffer.from("");
        },
      };
      return orasIndexPort({ commands, authFile: "/a", stage: async () => ({ path: "/s", cleanup: async () => undefined }) });
    };
    const input = { repository: destination("svc/postgres"), digest, mediaType: OCI_INDEX_MEDIA_TYPE, bytes: Buffer.from("{}"), tag: digest.slice(0, 32) };
    await expect(build(`sha256:${digest}`).push(input)).resolves.toBeUndefined();
    await expect(build(undefined).push(input)).rejects.toThrow(/already exists/u);
    await expect(build(`sha256:${hex("other")}`).push(input)).rejects.toThrow(/already exists/u);
    expect(ref).toContain(digest);
  });

  it("the usage text names the flags, the digest rule and the staging guard", () => {
    const text = repackUsage();
    for (const flag of ["--repack-file", "--env", "--registry", "--sources-out", "--provenance-out", "--repack-time"]) expect(text).toContain(flag);
    expect(text).toContain("staging-aws.sh");
    expect(text).toContain("tag is refused");
    expect(text).toContain("attestation");
    expect(text).toContain("SAME --repack-time");
    expect(text).toContain("anonymously pullable");
    expect(text).toContain("rate limit");
    expect(text).toContain("1.2.0");
    for (const flag of ["--overwrite", "--command-timeout-seconds", "--copy-timeout-seconds"]) expect(text).toContain(flag);
  });
});

describe("child sizes", () => {
  it("refuses a child whose landed manifest is not the size upstream's descriptor says", async () => {
    const w = world({ upstream: (e) => upstreamFor(e, { sizeOffset: 1 }) });
    const refusals = await refusalsOf(run(w));
    expect(refusals[0]?.code).toBe("child_digest_changed");
    expect(w.calls.pushes).toEqual([]);
  });
});

describe("the command line and the output check", () => {
  const base = ["--repack-file", "r.json", "--env", "staging", "--registry", REGISTRY, "--sources-out", "/o/sources.json", "--provenance-out", "/o/provenance.json"];
  const fakeFs = (existing: string[] = [], unwritable: string[] = [], links: Record<string, string> = {}, identities: Record<string, { dev: number; ino: number }> = {}) => {
    const created: string[] = [];
    const fs: OutputCheckFs = {
      async exists(path) { return existing.includes(path); },
      async ensureWritableDirectory(path) {
        if (unwritable.includes(path)) throw new Error("EACCES");
        created.push(path);
      },
      async realpath(path) { return links[path] ?? path; },
      async identity(path) { return identities[path]; },
    };
    return { fs, created };
  };

  it("reads the flags, resolves the paths and defaults the time, overwrite and timeout", () => {
    const args = parseRepackArgs(base);
    expect(args).toMatchObject({ env: "staging", registry: REGISTRY, sourcesOut: "/o/sources.json", provenanceOut: "/o/provenance.json", repackTime: undefined, overwrite: false, commandTimeoutMs: 600_000, copyTimeoutMs: 2_700_000 });
    expect(parseRepackArgs([...base, "--overwrite", "--repack-time", NOW, "--command-timeout-seconds", "30", "--copy-timeout-seconds", "90"])).toMatchObject({ overwrite: true, repackTime: NOW, commandTimeoutMs: 30_000, copyTimeoutMs: 90_000 });
  });

  it.each([
    ["identical output files", [...base.slice(0, 7), "/o/x.json", "--provenance-out", "/o/x.json"]],
    ["the same file under another spelling", [...base.slice(0, 7), "/o/x.json", "--provenance-out", "/o/../o/x.json"]],
    ["an unknown flag (a typo)", [...base, "--overwite"]],
    ["a flag given twice", [...base, "--env", "prod"]],
    ["a missing value", [...base.slice(0, 8), "--registry"]],
    ["a bad time", [...base, "--repack-time", "yesterday"]],
    ["a bad timeout", [...base, "--command-timeout-seconds", "0"]],
    ["a bad copy timeout", [...base, "--copy-timeout-seconds", "1.5"]],
    ["a required flag missing", base.slice(2)],
  ])("refuses %s", (_name, argv) => {
    expect(() => parseRepackArgs(argv)).toThrow();
  });

  it("checks that both output directories exist or can be created and are writable", async () => {
    const { fs, created } = fakeFs();
    await preflightOutputs({ sourcesFile: "/a/sources.json", provenanceFile: "/b/provenance.json", overwrite: false }, fs);
    expect(created).toEqual(["/a", "/b"]);
    await expect(preflightOutputs({ sourcesFile: "/a/sources.json", provenanceFile: "/b/provenance.json", overwrite: false }, fakeFs([], ["/b"]).fs)).rejects.toThrow(/provenance.json/u);
    await expect(preflightOutputs({ sourcesFile: "/a/sources.json", provenanceFile: "/b/provenance.json", overwrite: false }, fakeFs([], ["/a"]).fs)).rejects.toThrow(/sources.json/u);
  });

  it("runs the output check as part of preparing a run, before any credential or registry work", async () => {
    await expect(prepareRepackRun(base, fakeFs(["/o/sources.json"]).fs)).rejects.toThrow(/already exists/u);
    await expect(prepareRepackRun(base, fakeFs([], ["/o"]).fs)).rejects.toThrow(/cannot be created/u);
    expect(await prepareRepackRun([...base, "--overwrite"], fakeFs(["/o/sources.json"]).fs)).toMatchObject({ overwrite: true });
  });

  it("refuses one file reached through a symbolic link to its directory", async () => {
    const fs = fakeFs([], [], { "/link": "/real" }).fs;
    await expect(preflightOutputs({ sourcesFile: "/link/x.json", provenanceFile: "/real/x.json", overwrite: true }, fs)).rejects.toThrow(/different files/u);
    await expect(preflightOutputs({ sourcesFile: "/link/x.json", provenanceFile: "/real/y.json", overwrite: true }, fs)).resolves.toBeUndefined();
  });

  it("refuses names that differ only in case in the same directory (a case-folding file system), but not in different directories", async () => {
    await expect(preflightOutputs({ sourcesFile: "/o/Sources.json", provenanceFile: "/o/sources.json", overwrite: true }, fakeFs().fs)).rejects.toThrow(/different files/u);
    await expect(preflightOutputs({ sourcesFile: "/a/Sources.json", provenanceFile: "/b/sources.json", overwrite: true }, fakeFs().fs)).resolves.toBeUndefined();
  });

  it("refuses two existing paths that are the same file (device and inode), and accepts two different files", async () => {
    const input = { sourcesFile: "/a/s.json", provenanceFile: "/b/p.json", overwrite: true };
    await expect(preflightOutputs(input, fakeFs([], [], {}, { "/a/s.json": { dev: 1, ino: 7 }, "/b/p.json": { dev: 1, ino: 7 } }).fs)).rejects.toThrow(/different files/u);
    await expect(preflightOutputs(input, fakeFs([], [], {}, { "/a/s.json": { dev: 1, ino: 7 }, "/b/p.json": { dev: 1, ino: 8 } }).fs)).resolves.toBeUndefined();
    await expect(preflightOutputs(input, fakeFs([], [], {}, { "/a/s.json": { dev: 1, ino: 7 }, "/b/p.json": { dev: 2, ino: 7 } }).fs)).resolves.toBeUndefined();
  });

  it("on a real directory: a symbolic link to the directory and a hard link are caught, and distinct files pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "repack-preflight-"));
    try {
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "link"));
      await expect(preflightOutputs({ sourcesFile: join(root, "link", "x.json"), provenanceFile: join(root, "real", "x.json"), overwrite: true }, nodeOutputCheckFs)).rejects.toThrow(/different files/u);
      await writeFile(join(root, "real", "a.json"), "{}");
      await link(join(root, "real", "a.json"), join(root, "real", "b.json"));
      await expect(preflightOutputs({ sourcesFile: join(root, "real", "a.json"), provenanceFile: join(root, "real", "b.json"), overwrite: true }, nodeOutputCheckFs)).rejects.toThrow(/different files/u);
      await expect(preflightOutputs({ sourcesFile: join(root, "real", "a.json"), provenanceFile: join(root, "new", "p.json"), overwrite: true }, nodeOutputCheckFs)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses identical output files", async () => {
    await expect(preflightOutputs({ sourcesFile: "/a/x.json", provenanceFile: "/a/../a/x.json", overwrite: true }, fakeFs().fs)).rejects.toThrow(/different files/u);
  });

  it("does not overwrite an existing sources or provenance file unless --overwrite is given", async () => {
    const input = { sourcesFile: "/a/sources.json", provenanceFile: "/a/provenance.json" };
    await expect(preflightOutputs({ ...input, overwrite: false }, fakeFs(["/a/sources.json"]).fs)).rejects.toThrow(/already exists/u);
    await expect(preflightOutputs({ ...input, overwrite: false }, fakeFs(["/a/provenance.json"]).fs)).rejects.toThrow(/already exists/u);
    await expect(preflightOutputs({ ...input, overwrite: true }, fakeFs(["/a/sources.json", "/a/provenance.json"]).fs)).resolves.toBeUndefined();
  });
});
