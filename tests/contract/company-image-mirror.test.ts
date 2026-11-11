// Company-approved images, 0.5.15: the mirror (copying an approved image into the install's own registry by digest), its state, the function that runs it, the authority that starts it (approve) and ends it (revoke), the
// company's own registry list, the counters that clamp at zero, and what a plan and a worker login are given.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompanyImageMirrorJobSchema, companyImageMirrorTag, companyImageRepositoryName, isSavedEnvRepositoryName, type CompanyImageMirrorJob } from "@agentx/contracts";
import { copyApprovedImage, verifiedParts, MIRROR_PART_BYTES, type CopyPorts, type EcrWriter } from "../../packages/broker/src/test-env/company-image-mirror.js";
import { claimMirror, deleteMirrorState, finishMirror, mirrorNeedsStart, readMirrorState } from "../../packages/broker/src/test-env/company-image-mirror-state.js";
import { readCompanyImageMirrors } from "../../packages/broker/src/test-env/company-image-mirrors.js";
import { createRegistryClient } from "../../packages/broker/src/test-env/company-image-registry-client.js";
import { runMirrorJob } from "../../packages/broker/src/aws/company-image-mirror-handler.js";
import { expectedRepositoryPolicy } from "../../packages/broker/src/test-env/saved-env-session.js";
import { dynamoCompanyImageStore, readCompanyImagePlanInputs } from "../../packages/broker/src/org/company-test-image-store.js";
import { addRegistry, approveImage, proposeImageAsAdmin, removeRegistry, revokeImage, type CompanyImageAuditEntry, type CompanyImageDeps } from "../../packages/broker/src/org/company-test-images.js";
import { companyImageIdOf, type CompanyImage } from "../../packages/broker/src/test-env/company-images.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { companyImageIdsOfPlan } from "../../packages/broker/src/test-env/fixture-lookup.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { pinnedCatalog, sha, verifiedCatalog } from "../support/catalog-pinning.js";
import { MANIFEST_TYPE, INDEX_TYPE, PUBLIC_HOSTS, fakeLookup, fakeRegistry, hex, makeImage, makeIndex, type FakeImage } from "../support/company-image-registry-fake.js";

const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const collect = async (parts: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> => { const out: Uint8Array[] = []; for await (const part of parts) out.push(part); return out; };

// ---- a fake of the install's registry for the copier

class FakeEcr implements EcrWriter {
  readonly blobs = new Map<string, Uint8Array>();
  readonly completed: string[] = [];
  readonly images = new Map<string, { manifest: string; tag: string; mediaType: string }>();
  readBackDigest: string | undefined = "real";
  async available(digests: readonly string[]) { return new Set(digests.filter((digest) => this.blobs.has(digest))); }
  async uploadBlob(digest: string, parts: AsyncIterable<Uint8Array>) {
    const got = await collect(parts);
    const bytes = Buffer.concat(got);
    this.blobs.set(digest, bytes);
    this.completed.push(digest);
  }
  async putImage(input: { manifest: string; mediaType: string; digest: string; tag: string }) { this.images.set(input.digest, { manifest: input.manifest, tag: input.tag, mediaType: input.mediaType }); }
  async readBack(digest: string) {
    if (this.readBackDigest !== "real") return this.readBackDigest;
    const found = this.images.get(digest);
    return found === undefined ? undefined : hash(new TextEncoder().encode(found.manifest));
  }
}

function copier(image: FakeImage, options: { registryOptions?: Partial<Parameters<typeof fakeRegistry>[0]>; ecr?: FakeEcr; now?: () => number; deadlineMs?: number; table?: Record<string, string[]> } = {}) {
  const reg = fakeRegistry({ repository: "library/postgres", images: [image], ...(options.registryOptions ?? {}) });
  const ecr = options.ecr ?? new FakeEcr();
  const created: string[] = [];
  const ports: CopyPorts = {
    registry: ({ registry, extra, repository }) => { created.push(registry); return createRegistryClient({ registry, extra, repository, fetchImpl: reg.fetchImpl, lookup: fakeLookup(options.table ?? PUBLIC_HOSTS).lookup }); },
    ecr, now: options.now ?? (() => NOW), deadlineMs: options.deadlineMs ?? NOW + 60_000,
  };
  return { reg, ecr, ports, created };
}
const input = (image: FakeImage, change: Partial<{ registry: string; extraRegistries: string[]; digest: string; repository: string }> = {}) => ({ registry: "docker.io", extraRegistries: [], digest: image.digest, repository: "library/postgres", ...change });

describe("verified upload parts", () => {
  it("cuts the stream into parts of the stated size (the last may be smaller) and holds the whole to its digest", async () => {
    const bytes = new Uint8Array(25).map((_, index) => index);
    const parts = await collect(verifiedParts((async function* () { yield bytes.subarray(0, 4); yield bytes.subarray(4, 19); yield bytes.subarray(19); })(), `sha256:${hash(bytes)}`, 10));
    expect(parts.map((part) => part.byteLength)).toEqual([10, 10, 5]);
    expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);
    expect(MIRROR_PART_BYTES).toBe(8 * 1024 * 1024);
  });

  it("fails with digest_mismatch when the bytes do not hash to the digest, so the upload is never completed with them", async () => {
    const bytes = new Uint8Array(25).map((_, index) => index);
    const ecr = new FakeEcr();
    await expect(ecr.uploadBlob(`sha256:${hex("something else")}`, verifiedParts((async function* () { yield bytes; })(), `sha256:${hex("something else")}`, 10))).rejects.toMatchObject({ reason: "digest_mismatch" });
    expect(ecr.completed).toEqual([]);
  });
});

describe("copying an approved image", () => {
  const image = makeImage();

  it("copies the manifest, the config and every layer, preserves the digest, tags it by the digest, and reads it back before it says ok", async () => {
    const { ecr, ports, reg } = copier(image);
    expect(await copyApprovedImage(ports, input(image))).toEqual({ ok: true });
    expect([...ecr.blobs.keys()].sort()).toEqual([`sha256:${hex(image.config)}`, ...image.layers.map((layer) => `sha256:${hex(layer)}`)].sort());
    for (const layer of image.layers) expect(Buffer.from(ecr.blobs.get(`sha256:${hex(layer)}`)!).equals(Buffer.from(layer))).toBe(true);
    const stored = ecr.images.get(`sha256:${image.digest}`)!;
    // The manifest is the very text that was approved: its sha256 is the digest, and the tag names it.
    expect(hash(new TextEncoder().encode(stored.manifest))).toBe(image.digest);
    expect(stored.tag).toBe(companyImageMirrorTag(image.digest));
    expect(stored.mediaType).toBe(MANIFEST_TYPE);
    // The source was asked only by the approved digest, never by a tag.
    expect(reg.requests.filter((request) => request.url.includes("/manifests/")).map((request) => request.url)).toEqual([`https://registry-1.docker.io/v2/library/postgres/manifests/sha256:${image.digest}`]);
  });

  it("leaves alone the blobs the repository already holds, and still puts the manifest", async () => {
    const ecr = new FakeEcr();
    for (const layer of image.layers) ecr.blobs.set(`sha256:${hex(layer)}`, layer);
    const { ports, reg } = copier(image, { ecr });
    expect(await copyApprovedImage(ports, input(image))).toEqual({ ok: true });
    expect(ecr.completed).toEqual([`sha256:${hex(image.config)}`]);
    expect(reg.requests.some((request) => request.url.includes(`/blobs/sha256:${hex(image.layers[0]!)}`))).toBe(false);
    expect(ecr.images.has(`sha256:${image.digest}`)).toBe(true);
  });

  it("refuses a manifest whose bytes are not the approved digest: nothing is uploaded", async () => {
    const lying = makeImage({ salt: "a different manifest" });
    const { ports, ecr } = copier(image, { registryOptions: { tags: { [`sha256:${image.digest}`]: { bytes: lying.manifestBytes, type: MANIFEST_TYPE } } } });
    expect(await copyApprovedImage(ports, input(image))).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(ecr.completed).toEqual([]);
    expect(ecr.images.size).toBe(0);
  });

  it("does not complete a layer whose bytes do not hash to its digest, and records no image", async () => {
    const reg = fakeRegistry({ repository: "library/postgres", images: [image] });
    reg.blobs.set(`sha256:${hex(image.layers[1]!)}`, new TextEncoder().encode("tampered layer in transit"));
    const ecr = new FakeEcr();
    const ports: CopyPorts = { registry: ({ registry, extra, repository }) => createRegistryClient({ registry, extra, repository, fetchImpl: reg.fetchImpl, lookup: fakeLookup(PUBLIC_HOSTS).lookup }), ecr, now: () => NOW, deadlineMs: NOW + 1000 };
    expect(await copyApprovedImage(ports, input(image))).toEqual({ ok: false, reason: "digest_mismatch" });
    expect(ecr.completed).not.toContain(`sha256:${hex(image.layers[1]!)}`);
    expect(ecr.images.size).toBe(0);
  });

  it("refuses what it cannot copy faithfully, each with its fixed reason: an index, a foreign layer, a schema 1 manifest, another platform", async () => {
    const index = makeIndex([{ image, os: "linux", architecture: "arm64" }]);
    const asIndex = copier(image, { registryOptions: { indexes: [index] } });
    expect(await copyApprovedImage(asIndex.ports, input(image, { digest: index.digest }))).toEqual({ ok: false, reason: "unsupported" });
    const foreign = makeImage({ foreign: true });
    expect(await copyApprovedImage(copier(foreign).ports, input(foreign))).toEqual({ ok: false, reason: "unsupported" });
    const schema1 = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, name: "library/postgres", fsLayers: [] }));
    const one = copier(image, { registryOptions: { tags: { [`sha256:${hex(schema1)}`]: { bytes: schema1, type: "application/vnd.docker.distribution.manifest.v1+json" } } } });
    expect(await copyApprovedImage(one.ports, input(image, { digest: hex(schema1) }))).toEqual({ ok: false, reason: "unsupported" });
    const amd = makeImage({ arch: "amd64" });
    const wrong = copier(amd);
    expect(await copyApprovedImage(wrong.ports, input(amd))).toEqual({ ok: false, reason: "no_arm64" });
    expect(wrong.ecr.completed).toEqual([]);
  });

  it("refuses an image over the size ceiling, and gives up with timeout when its time is spent", async () => {
    const huge = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: MANIFEST_TYPE, config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${hex(image.config)}`, size: image.config.byteLength }, layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: `sha256:${hex("x")}`, size: 3 * 1024 ** 3 }] }));
    const big = copier(image, { registryOptions: { tags: { [`sha256:${hash(huge)}`]: { bytes: huge, type: MANIFEST_TYPE } } } });
    expect(await copyApprovedImage(big.ports, input(image, { digest: hash(huge) }))).toEqual({ ok: false, reason: "too_large" });
    const slow = copier(image, { now: () => NOW + 120_000, deadlineMs: NOW + 1000 });
    expect(await copyApprovedImage(slow.ports, input(image))).toEqual({ ok: false, reason: "timeout" });
    expect(slow.ecr.images.size).toBe(0);
    // Time that runs out DURING the copy stops it before the next blob, not only before the manifest is put.
    let clock = NOW;
    class SlowEcr extends FakeEcr { override async uploadBlob(digest: string, parts: AsyncIterable<Uint8Array>) { await super.uploadBlob(digest, parts); clock = NOW + 120_000; } }
    const midway = copier(image, { ecr: new SlowEcr(), now: () => clock, deadlineMs: NOW + 1000 });
    expect(await copyApprovedImage(midway.ports, input(image))).toEqual({ ok: false, reason: "timeout" });
    expect(midway.ecr.completed).toHaveLength(1);
    expect(midway.ecr.images.size).toBe(0);
  });

  it("is not ok unless the registry holds the manifest by the approved digest afterwards", async () => {
    for (const readBack of [undefined, hex("another manifest")]) {
      const ecr = new FakeEcr();
      ecr.readBackDigest = readBack;
      expect(await copyApprovedImage(copier(image, { ecr }).ports, input(image))).toEqual({ ok: false, reason: "digest_mismatch" });
    }
  });

  it("contacts no registry that is not allowed for the company, and an extra registry only when it is listed", async () => {
    const closed = copier(image);
    for (const registry of ["ghcr.io.evil.example.com", "evil.example.com", "registry.example.com", "169.254.169.254"]) {
      expect(await copyApprovedImage(closed.ports, input(image, { registry })), registry).toEqual({ ok: false, reason: "registry_not_allowed" });
    }
    expect(closed.created).toEqual([]);
    expect(closed.reg.requests).toEqual([]);
    const own = copier(image, { registryOptions: { host: { apiHost: "registry.example.com" }, repository: "acme/postgres" } });
    expect(await copyApprovedImage(own.ports, input(image, { registry: "registry.example.com", repository: "acme/postgres" }))).toMatchObject({ ok: false });
    expect(await copyApprovedImage(own.ports, input(image, { registry: "registry.example.com", repository: "acme/postgres", extraRegistries: ["registry.example.com"] }))).toEqual({ ok: true });
  });

  it("refuses a registry whose name resolves to a private address, and says nothing of the registry's own words", async () => {
    const { ports, reg, ecr } = copier(image, { table: { ...PUBLIC_HOSTS, "registry-1.docker.io": ["10.0.0.9"] } });
    expect(await copyApprovedImage(ports, input(image))).toEqual({ ok: false, reason: "registry_not_allowed" });
    expect(reg.requests).toEqual([]);
    expect(ecr.completed).toEqual([]);
  });
});

describe("the mirror's names", () => {
  it("makes one repository per company and image, in the saved-environment family, that no project's repository can be", () => {
    const a = companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: "img_" + "1".repeat(20) });
    const b = companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: "img_" + "2".repeat(20) });
    const other = companyImageRepositoryName({ env: "staging", orgId: "org_bbbbbbbbbbbbbbbbbbbb", imageId: "img_" + "1".repeat(20) });
    expect(isSavedEnvRepositoryName(a)).toBe(true);
    expect(new Set([a, b, other]).size).toBe(3);
    expect(a.split("/")[2]).toBe(b.split("/")[2]);
    expect(a.split("/")[2]).not.toBe(other.split("/")[2]);
    expect(a).not.toContain(TEST_ORG);
    expect(() => companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: "img_*" })).toThrow();
    expect(() => companyImageRepositoryName({ env: "Staging!", orgId: TEST_ORG, imageId: "img_" + "1".repeat(20) })).toThrow();
  });
});

describe("the mirror's state", () => {
  const table = () => ({ documentClient: new FakeDynamoDb(), tableName: "state" });
  const ids = { orgId: TEST_ORG, imageId: "img_" + "1".repeat(20), digest: sha("platform"), repository: companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: "img_" + "1".repeat(20) }) };

  it("is claimed by one copier at a time, finished only by the copier that claimed it, and read back for the digest it names", async () => {
    const t = table();
    expect(await claimMirror(t, { ...ids, nowMs: NOW })).toBe(true);
    expect(await claimMirror(t, { ...ids, nowMs: NOW + 1000 })).toBe(false);
    expect(await readMirrorState(t, TEST_ORG, ids.imageId)).toMatchObject({ state: "copying", digest: ids.digest, attempts: 1, repository: ids.repository });
    const started = (await readMirrorState(t, TEST_ORG, ids.imageId))!.startedAt;
    await finishMirror(t, { orgId: TEST_ORG, imageId: ids.imageId, startedAt: "2020-01-01T00:00:00.000Z", nowMs: NOW, ok: true });
    expect((await readMirrorState(t, TEST_ORG, ids.imageId))!.state).toBe("copying");
    await finishMirror(t, { orgId: TEST_ORG, imageId: ids.imageId, startedAt: started, nowMs: NOW + 2000, ok: true });
    expect(await readMirrorState(t, TEST_ORG, ids.imageId)).toMatchObject({ state: "ready", digest: ids.digest });
    expect(await claimMirror(t, { ...ids, nowMs: NOW + 5000 })).toBe(false);
    await deleteMirrorState(t, TEST_ORG, ids.imageId);
    expect(await readMirrorState(t, TEST_ORG, ids.imageId)).toBeUndefined();
  });

  it("tries a failure again only after the retry wait, and takes a copy that has run too long for dead", async () => {
    const t = table();
    await claimMirror(t, { ...ids, nowMs: NOW });
    const started = (await readMirrorState(t, TEST_ORG, ids.imageId))!.startedAt;
    await finishMirror(t, { orgId: TEST_ORG, imageId: ids.imageId, startedAt: started, nowMs: NOW, ok: false, reason: "no_arm64" });
    expect(await readMirrorState(t, TEST_ORG, ids.imageId)).toMatchObject({ state: "failed", reason: "no_arm64" });
    expect(await claimMirror(t, { ...ids, nowMs: NOW + 5 * 60_000 })).toBe(false);
    expect(await claimMirror(t, { ...ids, nowMs: NOW + 11 * 60_000 })).toBe(true);
    expect((await readMirrorState(t, TEST_ORG, ids.imageId))!.attempts).toBe(2);
    expect(await claimMirror(t, { ...ids, nowMs: NOW + 20 * 60_000 })).toBe(false);
    expect(await claimMirror(t, { ...ids, nowMs: NOW + 40 * 60_000 })).toBe(true);
    const state = (await readMirrorState(t, TEST_ORG, ids.imageId))!;
    expect(mirrorNeedsStart(undefined, ids.digest, NOW)).toBe(true);
    expect(mirrorNeedsStart({ ...state, state: "ready" }, ids.digest, NOW + 1e9)).toBe(false);
    expect(mirrorNeedsStart({ ...state, state: "ready" }, sha("another digest"), NOW)).toBe(true);
  });

  it("reads a damaged or foreign row as no state", async () => {
    const t = table();
    t.documentClient.set({ pk: `COMPANY_IMAGE_MIRROR#${TEST_ORG}`, sk: ids.imageId, state: "ready", digest: "not a digest" });
    expect(await readMirrorState(t, TEST_ORG, ids.imageId)).toBeUndefined();
    expect(await readMirrorState(t, "org_bbbbbbbbbbbbbbbbbbbb", ids.imageId)).toBeUndefined();
  });
});

// ---- the function

const CONFIG = { enabled: true, env: "staging", scope: { partition: "aws", region: "us-east-1", account: "123456789012" }, kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000" } as const;

/** Fake AWS for the function: STS issues a session per call (recording its policy), and one in-memory ECR repository behaves as the template makes it. */
function fakeAws(options: { repositoryMatches?: boolean; mismatchAfterPush?: boolean } = {}) {
  const assumed: Array<{ roleArn: string; policy: string }> = [];
  const state = { exists: false, deleted: 0, layers: new Map<string, Uint8Array>(), uploads: new Map<string, Buffer[]>(), images: new Map<string, string>(), tags: new Map<string, string>() };
  const ecrSend = async (command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> => {
    const name = command.constructor.name;
    const exists = (): void => { if (!state.exists) throw Object.assign(new Error("gone"), { name: "RepositoryNotFoundException" }); };
    if (name === "DescribeRepositoriesCommand") { exists(); return { repositories: [{ encryptionConfiguration: { encryptionType: "KMS", kmsKey: options.repositoryMatches === false || (options.mismatchAfterPush === true && state.images.size > 0) ? "arn:aws:kms:us-east-1:123456789012:key/other" : CONFIG.kmsKeyArn }, imageTagMutability: "IMMUTABLE" }] }; }
    if (name === "GetRepositoryPolicyCommand") { exists(); return { policyText: JSON.stringify(expectedRepositoryPolicy(CONFIG)) }; }
    if (name === "BatchCheckLayerAvailabilityCommand") { exists(); return { layers: (command.input["layerDigests"] as string[]).map((layerDigest) => ({ layerDigest, layerAvailability: state.layers.has(layerDigest) ? "AVAILABLE" : "UNAVAILABLE" })) }; }
    if (name === "InitiateLayerUploadCommand") { state.exists = true; const uploadId = `upload-${String(state.uploads.size)}`; state.uploads.set(uploadId, []); return { uploadId }; }
    if (name === "UploadLayerPartCommand") { state.uploads.get(command.input["uploadId"] as string)!.push(Buffer.from(command.input["layerPartBlob"] as Uint8Array)); return {}; }
    if (name === "CompleteLayerUploadCommand") {
      const bytes = Buffer.concat(state.uploads.get(command.input["uploadId"] as string)!);
      if (`sha256:${hash(bytes)}` !== (command.input["layerDigests"] as string[])[0]) throw Object.assign(new Error("bad digest"), { name: "InvalidLayerException" });
      state.layers.set((command.input["layerDigests"] as string[])[0]!, bytes);
      return {};
    }
    if (name === "PutImageCommand") { state.images.set(command.input["imageDigest"] as string, command.input["imageManifest"] as string); state.tags.set(command.input["imageTag"] as string, command.input["imageDigest"] as string); return {}; }
    if (name === "BatchGetImageCommand") { const manifest = state.images.get((command.input["imageIds"] as Array<{ imageDigest: string }>)[0]!.imageDigest); return { images: manifest === undefined ? [] : [{ imageManifest: manifest }] }; }
    if (name === "DeleteRepositoryCommand") { exists(); state.exists = false; state.deleted += 1; return {}; }
    throw new Error(`unexpected ECR call ${name}`);
  };
  const clients = {
    sts: { send: async (command: { input: { RoleArn: string; Policy: string } }) => { assumed.push({ roleArn: command.input.RoleArn, policy: command.input.Policy }); return { Credentials: { AccessKeyId: "AKIAFAKE", SecretAccessKey: "secret-value-for-test", SessionToken: "session-token-for-test", Expiration: new Date(NOW + 3_600_000) } }; } },
    ecr: () => ({ send: ecrSend as (command: unknown) => Promise<unknown> }),
  };
  return { assumed, state, clients: clients as never };
}

describe("the mirror function", () => {
  const image = makeImage();
  const imageId = companyImageIdOf({ registry: "docker.io", repository: "library/postgres" }, image.digest);
  const copyJob = (change: Partial<Extract<CompanyImageMirrorJob, { action: "copy" }>> = {}): CompanyImageMirrorJob => ({ action: "copy", orgId: TEST_ORG, imageId, cycle: "c".repeat(16), registry: "docker.io", repository: "library/postgres", digest: image.digest, extraRegistries: [], ...change });
  function bench(awsOptions: { repositoryMatches?: boolean; mismatchAfterPush?: boolean } = {}) {
    const aws = fakeAws(awsOptions);
    const db = new FakeDynamoDb();
    const reg = fakeRegistry({ repository: "library/postgres", images: [image] });
    const logs: Array<Record<string, unknown>> = [];
    const dependencies = {
      table: { documentClient: db, tableName: "state" }, config: CONFIG, clients: aws.clients, now: () => NOW, log: (event: Record<string, unknown>) => { logs.push(event); },
      copyPorts: (ecr: EcrWriter): CopyPorts => ({ registry: ({ registry, extra, repository }) => createRegistryClient({ registry, extra, repository, fetchImpl: reg.fetchImpl, lookup: fakeLookup(PUBLIC_HOSTS).lookup }), ecr, now: () => NOW, deadlineMs: NOW + 60_000 }),
    };
    return { aws, db, reg, logs, dependencies, state: () => readMirrorState(dependencies.table, TEST_ORG, imageId) };
  }

  it("copies an approved image into the repository the company and image name, through a session for that one repository, and records it ready", async () => {
    const b = bench();
    expect(await runMirrorJob(b.dependencies, copyJob())).toBe("copied");
    const repository = companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId });
    expect(await b.state()).toMatchObject({ state: "ready", digest: image.digest, repository });
    expect(b.aws.state.images.has(`sha256:${image.digest}`)).toBe(true);
    expect(b.aws.state.tags.get(companyImageMirrorTag(image.digest))).toBe(`sha256:${image.digest}`);
    // Every session the function asked for names exactly this one repository and is of a saved-environment role: the push role, never a role of its own.
    const pushes = b.aws.assumed.filter((request) => request.roleArn.endsWith("-img-push"));
    expect(pushes).toHaveLength(1);
    for (const request of b.aws.assumed) {
      expect(request.roleArn).toMatch(/-img-(push|manage)$/u);
      const resources = (JSON.parse(request.policy) as { Statement: Array<{ Resource: string }> }).Statement.map((statement) => statement.Resource).filter((resource) => resource !== "*");
      expect(resources).toEqual([`arn:aws:ecr:us-east-1:123456789012:repository/${repository}`]);
    }
    expect(JSON.stringify(b.logs)).not.toMatch(/secret-value|session-token/u);
  });

  it("copies nothing a copier already finished or another copier is running, and refuses a job that does not parse", async () => {
    const b = bench();
    expect(await runMirrorJob(b.dependencies, copyJob())).toBe("copied");
    expect(await runMirrorJob(b.dependencies, copyJob())).toBe("skipped");
    for (const bad of [null, "x", { action: "copy" }, copyJob({ digest: "short" }), { ...copyJob(), repository: undefined }, { ...copyJob(), extra: 1 }, { action: "delete", orgId: TEST_ORG }]) expect(await runMirrorJob(b.dependencies, bad)).toBe("invalid");
  });

  it("records a failure with its fixed reason, and a registry that is not allowed for the company is never contacted", async () => {
    const closed = bench();
    expect(await runMirrorJob(closed.dependencies, copyJob({ registry: "registry.example.com" }))).toBe("failed");
    expect(await closed.state()).toMatchObject({ state: "failed", reason: "registry_not_allowed" });
    expect(closed.reg.requests).toEqual([]);
    const missing = bench();
    expect(await runMirrorJob(missing.dependencies, copyJob({ digest: hex("an image the registry does not have") }))).toBe("failed");
    expect(await missing.state()).toMatchObject({ state: "failed", reason: "not_found" });
  });

  it("refuses to push into a repository that is not the one the creation template makes, and never records a copy as ready then", async () => {
    const b = bench({ repositoryMatches: false });
    b.aws.state.exists = true;
    expect(await runMirrorJob(b.dependencies, copyJob())).toBe("failed");
    expect(await b.state()).toMatchObject({ state: "failed", reason: "unavailable" });
    expect(b.aws.state.images.size).toBe(0);
  });

  it("does not record a copy as ready when the repository the push created is not the one the creation template makes", async () => {
    const b = bench({ mismatchAfterPush: true });
    expect(await runMirrorJob(b.dependencies, copyJob())).toBe("failed");
    expect(await b.state()).toMatchObject({ state: "failed", reason: "unavailable" });
  });

  it("deletes a revoked image's repository and its state, and a repository that is already gone is fine", async () => {
    const b = bench();
    await runMirrorJob(b.dependencies, copyJob());
    expect(await runMirrorJob(b.dependencies, { action: "delete", orgId: TEST_ORG, imageId })).toBe("deleted");
    expect(b.aws.state.deleted).toBe(1);
    expect(await b.state()).toBeUndefined();
    expect(b.aws.assumed.at(-1)!.roleArn).toMatch(/-img-manage$/u);
    expect(await runMirrorJob(b.dependencies, { action: "delete", orgId: TEST_ORG, imageId })).toBe("deleted");
  });

  it("the job schema carries ids, a digest and the company's registries, and nothing else", () => {
    expect(CompanyImageMirrorJobSchema.safeParse(copyJob()).success).toBe(true);
    expect(CompanyImageMirrorJobSchema.safeParse({ ...copyJob(), password: "x" }).success).toBe(false);
    expect(CompanyImageMirrorJobSchema.safeParse(copyJob({ extraRegistries: Array.from({ length: 9 }, (_, index) => `r${String(index)}.example.com`) })).success).toBe(false);
  });
});

// ---- the authority

const ADMIN = "a".repeat(64);
const caller = { orgId: TEST_ORG, developerId: ADMIN, sessionId: "session-1" };
function authority(options: { noStart?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const capture = capturingAuditDeps({ db, now: () => NOW });
  const store = dynamoCompanyImageStore({ documentClient: db, tableName: "state", audit: capture.audit });
  const jobs: CompanyImageMirrorJob[] = [];
  const asked: Array<{ registry: string; extra: readonly string[] | undefined }> = [];
  const catalog = verifiedCatalog(pinnedCatalog());
  const arm = makeImage({ salt: "authority" });
  const deps: CompanyImageDeps = {
    store, edition: "public", now: () => new Date(NOW), catalog: async () => catalog,
    resolveDigest: async (name, extra) => { asked.push({ registry: name.registry, extra }); return arm.digest; },
    requireAdmin: async () => undefined,
    readSession: async () => ({ authTime: new Date(NOW).toISOString(), developerId: ADMIN }),
    ...(options.noStart === true ? {} : { startMirror: async (job: CompanyImageMirrorJob) => { jobs.push(job); } }),
  };
  return { db, capture, store, deps, jobs, asked, arm };
}
const countsOf = (db: FakeDynamoDb) => { const row = db.get(`ORG#${TEST_ORG}`, "TESTIMAGE_COUNTS"); return row === undefined ? undefined : { live: row["live"], waiting: row["waiting"] }; };

describe("the authority and the mirror", () => {
  it("approving starts the copy with the company's registries as they are, revoking deletes the copy, and neither blocks on the job", async () => {
    const a = authority();
    await addRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 0 });
    await proposeImageAsAdmin(a.deps, caller, { image: "registry.example.com/acme/postgres:18" });
    const [waiting] = await a.store.list(TEST_ORG);
    expect(a.jobs).toEqual([]);
    const approved = await approveImage(a.deps, caller, { imageId: waiting!.imageId, expectedRevision: 1, expectedDigest: waiting!.digest });
    expect(a.jobs).toEqual([{ action: "copy", orgId: TEST_ORG, imageId: approved.imageId, cycle: approved.cycle, registry: "registry.example.com", repository: "acme/postgres", digest: approved.digest, extraRegistries: ["registry.example.com"] }]);
    await revokeImage(a.deps, caller, { imageId: approved.imageId, expectedRevision: approved.revision });
    expect(a.jobs.at(-1)).toEqual({ action: "delete", orgId: TEST_ORG, imageId: approved.imageId });
    // A job that cannot start does not undo the approval or the revoke.
    const flaky = authority();
    const deps = { ...flaky.deps, startMirror: async () => { throw new Error("lambda unavailable"); } };
    await addRegistry(deps, caller, { host: "registry.example.com", expectedRevision: 0 });
    await proposeImageAsAdmin(deps, caller, { image: "registry.example.com/acme/postgres:18" });
    const [again] = await flaky.store.list(TEST_ORG);
    expect((await approveImage(deps, caller, { imageId: again!.imageId, expectedRevision: 1, expectedDigest: again!.digest })).status).toBe("approved");
    await revokeImage(deps, caller, { imageId: again!.imageId, expectedRevision: 2 });
    expect(await flaky.store.list(TEST_ORG)).toEqual([]);
  });

  it("looks nothing up and proposes nothing for a registry that is not on the company's list, and approves nothing from one that was taken off", async () => {
    const a = authority();
    await expect(proposeImageAsAdmin(a.deps, caller, { image: "registry.example.com/acme/postgres:18" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(proposeImageAsAdmin(a.deps, caller, { image: "ghcr.io.evil.example.com/acme/postgres:18" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(a.asked).toEqual([]);
    expect(await a.store.list(TEST_ORG)).toEqual([]);
    // The four built-in registries need no entry, and the lookup is given the company's list.
    await proposeImageAsAdmin(a.deps, caller, { image: "ghcr.io/acme/postgres:18" });
    expect(a.asked).toEqual([{ registry: "ghcr.io", extra: [] }]);
    await addRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 0 });
    await proposeImageAsAdmin(a.deps, caller, { image: "registry.example.com/acme/postgres:18" });
    const own = (await a.store.list(TEST_ORG)).find((image) => image.registry === "registry.example.com")!;
    await removeRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 1 });
    await expect(approveImage(a.deps, caller, { imageId: own.imageId, expectedRevision: 1, expectedDigest: own.digest })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(a.jobs).toEqual([]);
  });

  it("changes the company's registry list only for a live admin with a fresh sign-in, one valid public host at a time, at the revision read, and audits each change without a host in a fact", async () => {
    const a = authority();
    await expect(addRegistry({ ...a.deps, requireAdmin: async () => { throw new Error("FORBIDDEN"); } }, caller, { host: "registry.example.com", expectedRevision: 0 })).rejects.toThrow("FORBIDDEN");
    for (const session of [undefined, { developerId: "b".repeat(64), authTime: new Date(NOW).toISOString() }, { developerId: ADMIN }, { developerId: ADMIN, authTime: new Date(NOW - 11 * 60_000).toISOString() }]) {
      await expect(addRegistry({ ...a.deps, readSession: async () => session }, caller, { host: "registry.example.com", expectedRevision: 0 })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    for (const host of ["https://registry.example.com", "registry.example.com:5000", "10.0.0.1", "localhost", "ghcr.io", "Registry.example.com", "a.b", 7, undefined]) {
      await expect(addRegistry(a.deps, caller, { host, expectedRevision: 0 }), String(host)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(await a.store.registries(TEST_ORG)).toEqual({ revision: 0, hosts: [] });
    await expect(addRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 3 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await addRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 0 })).toEqual({ revision: 1, hosts: ["registry.example.com"] });
    // The same host again changes nothing; a stale revision is refused; a second company never sees it.
    expect(await addRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 1 })).toEqual({ revision: 1, hosts: ["registry.example.com"] });
    expect(await a.store.registries("org_bbbbbbbbbbbbbbbbbbbb")).toEqual({ revision: 0, hosts: [] });
    await expect(removeRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 9 })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(removeRegistry(a.deps, caller, { host: "other.example.com", expectedRevision: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await removeRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 1 })).toEqual({ revision: 2, hosts: [] });
    const events = a.capture.recordedBy("company_image.registries_changed");
    expect(events.map((event) => event.facts)).toEqual([{ registryCount: 1, authority: "fresh_sign_in" }, { registryCount: 0, authority: "fresh_sign_in" }]);
    expect(JSON.stringify(events.map((event) => event.facts))).not.toContain("example.com");
    expect(JSON.stringify(events.map((event) => event.details))).toContain("registry.example.com");
  });

  it("fences the registry list's write at the revision read, in the store itself", async () => {
    const a = authority();
    await addRegistry(a.deps, caller, { host: "registry.example.com", expectedRevision: 0 });
    const entry = { orgId: TEST_ORG, actor: ADMIN, at: new Date(NOW).toISOString(), revision: 6, count: 1, host: "x.example.com", change: "added" as const };
    expect(await a.store.commitRegistries(TEST_ORG, ["x.example.com"], 5, entry)).toBe(false);
    expect(await a.store.commitRegistries(TEST_ORG, ["x.example.com"], 0, { ...entry, revision: 1 })).toBe(false);
    expect(await a.store.registries(TEST_ORG)).toEqual({ revision: 1, hosts: ["registry.example.com"] });
  });

  it("holds the company to eight extra registries", async () => {
    const a = authority();
    for (let index = 0; index < 8; index += 1) await addRegistry(a.deps, caller, { host: `r${String(index)}.example.com`, expectedRevision: index });
    await expect(addRegistry(a.deps, caller, { host: "r8.example.com", expectedRevision: 8 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await a.store.registries(TEST_ORG)).hosts).toHaveLength(8);
  });

  it("a damaged stored registry list can only shrink: a host that is not a registry host is never on it", async () => {
    const a = authority();
    a.db.set({ pk: `ORG#${TEST_ORG}`, sk: "TESTIMAGE_REGISTRIES", revision: 4, hosts: ["good.example.com", "10.0.0.1", "ghcr.io", 5, "BAD.example.com"] });
    expect(await a.store.registries(TEST_ORG)).toEqual({ revision: 4, hosts: ["good.example.com"] });
  });
});

describe("the counters clamp at zero", () => {
  const prepare = async (a: ReturnType<typeof authority>) => {
    await proposeImageAsAdmin(a.deps, caller, { image: "ghcr.io/acme/postgres:18" });
    const [waiting] = await a.store.list(TEST_ORG);
    return waiting!;
  };

  it("lets an admin dismiss and revoke when the counter row is missing, and leaves zero (never a negative)", async () => {
    const a = authority();
    const waiting = await prepare(a);
    expect(countsOf(a.db)).toEqual({ live: 1, waiting: 1 });
    a.db.delete(`ORG#${TEST_ORG}`, "TESTIMAGE_COUNTS");
    await revokeImage(a.deps, caller, { imageId: waiting.imageId, expectedRevision: 1 });
    expect(await a.store.list(TEST_ORG)).toEqual([]);
    expect(countsOf(a.db)).toEqual({ live: 0, waiting: 0 });
    expect(a.capture.recordedBy("company_image.revoked")).toHaveLength(1);
  });

  it("clamps a low counter: approving a waiting image with a counter of zero and revoking with a live count of zero both work", async () => {
    const a = authority();
    const waiting = await prepare(a);
    a.db.set({ pk: `ORG#${TEST_ORG}`, sk: "TESTIMAGE_COUNTS", entityType: "TESTIMAGE_COUNTS", live: 0, waiting: 0 });
    const approved = await approveImage(a.deps, caller, { imageId: waiting.imageId, expectedRevision: 1, expectedDigest: waiting.digest });
    expect(countsOf(a.db)).toEqual({ live: 0, waiting: 0 });
    await revokeImage(a.deps, caller, { imageId: approved.imageId, expectedRevision: approved.revision });
    expect(countsOf(a.db)).toEqual({ live: 0, waiting: 0 });
    expect(await a.store.list(TEST_ORG)).toEqual([]);
  });

  it("still counts correctly when the counters are right, and a lost race on the counter is CHANGE_STALE, not a silent overwrite", async () => {
    const a = authority();
    const waiting = await prepare(a);
    const approved = await approveImage(a.deps, caller, { imageId: waiting.imageId, expectedRevision: 1, expectedDigest: waiting.digest });
    expect(countsOf(a.db)).toEqual({ live: 1, waiting: 0 });
    // The counter moves between the read and the write: the transaction is cancelled, and the row is untouched.
    a.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] }, times: 1 });
    await expect(revokeImage(a.deps, caller, { imageId: approved.imageId, expectedRevision: approved.revision })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await a.store.list(TEST_ORG)).toHaveLength(1);
    await revokeImage(a.deps, caller, { imageId: approved.imageId, expectedRevision: approved.revision });
    expect(countsOf(a.db)).toEqual({ live: 0, waiting: 0 });
  });
});

describe("what a plan is given", () => {
  const image = makeImage({ salt: "plan" });
  const row = (change: Partial<CompanyImage> = {}): CompanyImage => {
    const base = { registry: "ghcr.io", repository: "acme/postgres", digest: image.digest, ...change };
    return {
      orgId: TEST_ORG, revision: 2, status: "approved", tag: "18", family: "postgres", version: "18", origin: "admin", cycle: "c".repeat(16), proposedBy: ADMIN, proposedAt: new Date(NOW).toISOString(), approvedBy: ADMIN, approvedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
      ...base, imageId: companyImageIdOf(base, base.digest),
    };
  };
  const env = { AGENTX_ENV: "staging" } as NodeJS.ProcessEnv;
  const put = (db: FakeDynamoDb, value: CompanyImage) => db.set({ pk: `ORG#${TEST_ORG}`, sk: `TESTIMAGE#${value.imageId}`, entityType: "COMPANY_TEST_IMAGE", ...value });
  const mirrorRow = (db: FakeDynamoDb, value: CompanyImage, change: Record<string, unknown> = {}) => db.set({ pk: `COMPANY_IMAGE_MIRROR#${TEST_ORG}`, sk: value.imageId, entityType: "COMPANY_IMAGE_MIRROR", state: "ready", digest: value.digest, repository: companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: value.imageId }), attempts: 1, startedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...change });

  it("names the install's own repository only for an image whose copy is finished for exactly its digest, and starts the copier for the rest", async () => {
    const db = new FakeDynamoDb();
    const ready = row(), copying = row({ digest: sha("c") }), absent = row({ digest: sha("d") }), failedOld = row({ digest: sha("e") }), stale = row({ digest: sha("f") });
    for (const value of [ready, copying, absent, failedOld, stale]) put(db, value);
    mirrorRow(db, ready);
    mirrorRow(db, copying, { state: "copying", updatedAt: new Date(Date.now()).toISOString() });
    mirrorRow(db, failedOld, { state: "failed", reason: "unavailable", updatedAt: "2020-01-01T00:00:00.000Z" });
    mirrorRow(db, stale, { digest: sha("another digest"), updatedAt: new Date(Date.now()).toISOString() });
    const jobs: CompanyImageMirrorJob[] = [];
    const inputs = await readCompanyImagePlanInputs({ documentClient: db, tableName: "state" }, TEST_ORG, { env, start: async (job) => { jobs.push(job); } });
    expect([...inputs.companyMirrors.keys()]).toEqual([ready.imageId]);
    expect(inputs.companyMirrors.get(ready.imageId)).toEqual({ repository: companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: ready.imageId }), digest: image.digest });
    // The copier is started for the image with no state, the old failure and the state for another digest: not for a finished copy and not for one that is running.
    expect(jobs.map((job) => (job as { imageId: string }).imageId).sort()).toEqual([absent.imageId, failedOld.imageId, stale.imageId].sort());
    expect(inputs.companyImages).toHaveLength(5);
  });

  it("serves no image whose registry the company has since taken off its list, and a state that names another repository is no copy", async () => {
    const db = new FakeDynamoDb();
    const own = row({ registry: "registry.example.com", digest: sha("own") });
    const builtIn = row();
    put(db, own); put(db, builtIn);
    mirrorRow(db, own); mirrorRow(db, builtIn, { repository: "rovara-env/staging/o" + "a".repeat(32) + "/p" + "b".repeat(32) });
    expect((await readCompanyImagePlanInputs({ documentClient: db, tableName: "state" }, TEST_ORG, { env, start: undefined })).companyImages.map((value) => value.imageId)).toEqual([builtIn.imageId]);
    db.set({ pk: `ORG#${TEST_ORG}`, sk: "TESTIMAGE_REGISTRIES", revision: 1, hosts: ["registry.example.com"] });
    const inputs = await readCompanyImagePlanInputs({ documentClient: db, tableName: "state" }, TEST_ORG, { env, start: undefined });
    expect(inputs.companyImages).toHaveLength(2);
    expect([...inputs.companyMirrors.keys()]).toEqual([own.imageId]);
  });

  it("starts nothing and serves nothing where the install has no mirror, and never throws", async () => {
    const db = new FakeDynamoDb();
    put(db, row());
    expect([...(await readCompanyImageMirrors({ documentClient: db, tableName: "state" }, TEST_ORG, [row()], { env: {}, start: undefined })).keys()]).toEqual([]);
    const broken = { send: async () => { throw new Error("dynamo down"); } };
    expect(await readCompanyImagePlanInputs({ documentClient: broken, tableName: "state" }, TEST_ORG, { env, start: undefined })).toEqual({ companyImages: [], companyMirrors: new Map() });
  });
});

describe("the run's capability", () => {
  it("names the company image login only for a run whose plan names a company image, and the run may ask for those images only", () => {
    const key = { callbackSigningKey: "k".repeat(32) };
    const actions = (options: Parameters<typeof issueCapability>[4]) => (JSON.parse(Buffer.from(issueCapability(key, "w", "o", 1, options).split(".")[0]!, "base64url").toString()) as { actions: string[] }).actions;
    expect(actions({ companyImageLogin: true })).toContain("company-image-login");
    expect(actions({})).not.toContain("company-image-login");
    expect(actions({ fixtureDelivery: true })).not.toContain("company-image-login");
    const company = { id: "db", backing: "company", company: { imageId: "img_" + "1".repeat(20) } };
    const other = { id: "cache", backing: "local" };
    const duplicate = { id: "db2", backing: "company", company: { imageId: "img_" + "1".repeat(20) } };
    expect(companyImageIdsOfPlan({ dependencies: [company, other, duplicate] as never })).toEqual(["img_" + "1".repeat(20)]);
    expect(companyImageIdsOfPlan({ dependencies: [other] as never })).toEqual([]);
    expect(companyImageIdsOfPlan(undefined)).toEqual([]);
  });
});

void INDEX_TYPE;
void ({} as CompanyImageAuditEntry);
