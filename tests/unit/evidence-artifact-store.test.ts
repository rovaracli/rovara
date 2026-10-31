// Proof and evidence P6: the evidence store (magic bytes, caps, tags per class), the download rule (only what the current pack names as available, checked on every request), the audit event of a download,
// and the lifecycle rules on the artifact bucket.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { E2E_ARTIFACT_RETENTION_TAG_KEY, EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_ARTIFACT_RETENTION, buildApiSample, type ArtifactLink, type EvidenceView } from "../../packages/contracts/src/index.js";
import { EVIDENCE_PRESIGN_SECONDS, deleteEvidenceArtifacts, evidenceArtifactKey, evidenceBytesAreKind, evidenceTagging, serveEvidenceArtifact, statEvidenceArtifacts, storeEvidenceArtifacts, type EvidenceDownloadDependencies } from "../../packages/broker/src/aws/evidence-artifacts.js";
import { evidenceDownloadAudit, evidenceDownloadResponse, handleEvidenceDownload } from "../../packages/broker/src/aws/evidence-download-route.js";
import { evidenceViewOf } from "../../packages/broker/src/rovara-code/evidence-pack.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 3)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(500, 4)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(500, 5)]);
const SAMPLE = Buffer.from(buildApiSample({ method: "GET", path: "/o", status: 200, responseHeaders: { "content-type": "application/json" }, responseBody: Buffer.from('{"a":1}') }).bytes!);
const TAIL = Buffer.from("3 failed\nAssertionError: expected 1 to be 2\n");
const OWNER = { ownerKey: "owner-1", workspaceId: "ws-1" };

/** An in-memory S3 that records tags and metadata, as the calls the store makes need. */
function memoryS3() {
  const objects = new Map<string, { body: Uint8Array; tagging?: string; contentType?: string; metadata?: Record<string, string> }>();
  const sent: string[] = [];
  return { objects, sent, s3: { async send(command: unknown) {
    if (command instanceof PutObjectCommand) { const i = command.input; objects.set(i.Key!, { body: i.Body as Uint8Array, tagging: i.Tagging, contentType: i.ContentType, metadata: i.Metadata }); sent.push("put"); return {}; }
    if (command instanceof HeadObjectCommand) { const o = objects.get(command.input.Key!); if (!o) throw new Error("NotFound"); sent.push("head"); return { ContentLength: o.body.byteLength, Metadata: o.metadata }; }
    if (command instanceof GetObjectCommand) { const o = objects.get(command.input.Key!); if (!o) throw new Error("NoSuchKey"); sent.push("get"); return { ContentLength: o.body.byteLength, Body: { transformToByteArray: async () => o.body } }; }
    if (command instanceof DeleteObjectCommand) { objects.delete(command.input.Key!); sent.push("delete"); return {}; }
    throw new Error("unexpected command");
  } } };
}

describe("what the store keeps", () => {
  it("checks each kind by its bytes: magic numbers, caps, and that JSON and text really parse", () => {
    expect(evidenceBytesAreKind("jpeg", JPEG)).toBe(true);
    expect(evidenceBytesAreKind("webm", WEBM)).toBe(true);
    expect(evidenceBytesAreKind("trace_zip", ZIP)).toBe(true);
    expect(evidenceBytesAreKind("api_sample_json", SAMPLE)).toBe(true);
    expect(evidenceBytesAreKind("log_txt", TAIL)).toBe(true);
    expect(evidenceBytesAreKind("jpeg", WEBM)).toBe(false);
    expect(evidenceBytesAreKind("webm", JPEG)).toBe(false);
    expect(evidenceBytesAreKind("trace_zip", WEBM)).toBe(false);
    expect(evidenceBytesAreKind("api_sample_json", Buffer.from('{"a":1}'))).toBe(false);
    expect(evidenceBytesAreKind("api_sample_json", Buffer.from("not json"))).toBe(false);
    expect(evidenceBytesAreKind("log_txt", Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(evidenceBytesAreKind("log_txt", Buffer.from([0xc3, 0x28]))).toBe(false);
    expect(evidenceBytesAreKind("jpeg", new Uint8Array())).toBe(false);
    expect(evidenceBytesAreKind("jpeg", Buffer.concat([JPEG, Buffer.alloc(EVIDENCE_ARTIFACT_MAX_BYTES.jpeg)]))).toBe(false);
    expect(evidenceBytesAreKind("log_txt", Buffer.alloc(EVIDENCE_ARTIFACT_MAX_BYTES.log_txt + 1, 0x61))).toBe(false);
  });
  it("writes under the task's owner and workspace, by digest, with the content type and the tag of the kind's class", async () => {
    const memory = memoryS3();
    const stored = await storeEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "bucket" }, OWNER, [{ kind: "jpeg", bytes: JPEG }, { kind: "webm", bytes: WEBM }, { kind: "trace_zip", bytes: ZIP }, { kind: "api_sample_json", bytes: SAMPLE }, { kind: "log_txt", bytes: TAIL }]);
    expect(stored.size).toBe(5);
    expect(memory.objects.get(`private/owner-1/ws-1/evidence/${sha(JPEG)}`)).toMatchObject({ contentType: "image/jpeg", tagging: "rovara-retention=evidence-std", metadata: { sha256: sha(JPEG), kind: "jpeg" } });
    expect(memory.objects.get(`private/owner-1/ws-1/evidence/${sha(WEBM)}`)).toMatchObject({ contentType: "video/webm", tagging: "rovara-retention=evidence-short" });
    expect(memory.objects.get(`private/owner-1/ws-1/evidence/${sha(ZIP)}`)).toMatchObject({ contentType: "application/zip", tagging: "rovara-retention=evidence-short" });
    expect(memory.objects.get(`private/owner-1/ws-1/evidence/${sha(SAMPLE)}`)?.tagging).toBe("rovara-retention=evidence-std");
    expect(memory.objects.get(`private/owner-1/ws-1/evidence/${sha(TAIL)}`)?.tagging).toBe("rovara-retention=evidence-std");
    expect(stored.get(sha(WEBM))).toEqual({ kind: "webm", sha256: sha(WEBM), bytes: WEBM.length, retentionClass: "evidence-short" });
    expect(evidenceTagging("evidence-short")).toBe(`${E2E_ARTIFACT_RETENTION_TAG_KEY}=evidence-short`);
  });
  it("tags EVERY object it writes (the tag is the only thing that makes it expire)", async () => {
    const memory = memoryS3();
    await storeEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, [{ kind: "jpeg", bytes: JPEG }, { kind: "log_txt", bytes: TAIL }, { kind: "webm", bytes: WEBM }]);
    expect([...memory.objects.values()].every((object) => /^rovara-retention=evidence-(short|std)$/u.test(object.tagging ?? ""))).toBe(true);
  });
  it("skips bytes that are not the kind they claim, a digest that is not theirs, and a second write changes nothing", async () => {
    const memory = memoryS3();
    const stored = await storeEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, [
      { kind: "jpeg", bytes: WEBM }, { kind: "jpeg", bytes: JPEG, sha256: "f".repeat(64) }, { kind: "webm", bytes: Buffer.from("junk") }, { kind: "jpeg", bytes: JPEG }, { kind: "jpeg", bytes: JPEG }]);
    expect([...stored.keys()]).toEqual([sha(JPEG)]);
    expect(memory.objects.size).toBe(1);
  });
  it("never stores the pack itself, whose class has no tag", async () => {
    expect(EVIDENCE_ARTIFACT_RETENTION.jpeg).not.toBe("evidence-record");
    for (const kind of Object.keys(EVIDENCE_ARTIFACT_RETENTION) as Array<keyof typeof EVIDENCE_ARTIFACT_RETENTION>) expect(EVIDENCE_ARTIFACT_RETENTION[kind]).not.toBe("evidence-record");
  });
  it("reports what it really holds, kind and size from the object, and nothing for a digest it does not", async () => {
    const memory = memoryS3();
    await storeEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, [{ kind: "jpeg", bytes: JPEG }]);
    const held = await statEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, [sha(JPEG), "e".repeat(64), "not a digest", sha(JPEG)]);
    expect([...held.entries()]).toEqual([[sha(JPEG), { kind: "jpeg", bytes: JPEG.length }]]);
    expect((await statEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, { ownerKey: "other", workspaceId: "ws-1" }, [sha(JPEG)])).size).toBe(0);
  });
  it("deletes withheld artifacts, and reports the ones it could not", async () => {
    const memory = memoryS3();
    await storeEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, [{ kind: "webm", bytes: WEBM }]);
    expect(await deleteEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, [{ sha256: sha(WEBM) }, { sha256: "bad" }])).toEqual([]);
    expect(memory.objects.size).toBe(0);
    const failing = { send: async () => { throw new Error("denied"); } };
    expect(await deleteEvidenceArtifacts({ s3: failing, artifactBucketName: "b" }, OWNER, [{ sha256: sha(WEBM) }])).toEqual([sha(WEBM)]);
  });
});

// ---- the download

const DIGEST = "c".repeat(64);
function viewWith(links: Array<{ kind: keyof typeof EVIDENCE_ARTIFACT_RETENTION; bytes: Uint8Array; state?: "available" | "expired" }>, candidateDigest = DIGEST): EvidenceView {
  const refs = links.map((item) => ({ kind: item.kind, sha256: sha(item.bytes), bytes: item.bytes.byteLength, retentionClass: EVIDENCE_ARTIFACT_RETENTION[item.kind] }));
  const pack = { schemaVersion: 1 as const, candidateDigest, environment: { tier: "sandbox" as const, envRevision: 1, services: [], data: "synthetic" as const, accounts: [{ profileId: "buyer", kind: "run_scoped" as const }] },
    checks: [], selection: { method: "full" as const, selected: 0, total: 0 }, notTested: [],
    api: [{ scenarioId: "orders", samples: refs.filter((ref) => ref.kind === "api_sample_json"), diff: "none" as const, changedPaths: [] }],
    browser: [{ scenarioId: "checkout", strip: { before: [], after: refs.filter((ref) => ref.kind === "jpeg") }, consoleErrors: 0,
      ...(refs.find((ref) => ref.kind === "webm") === undefined ? {} : { video: refs.find((ref) => ref.kind === "webm") }), ...(refs.find((ref) => ref.kind === "trace_zip") === undefined ? {} : { trace: refs.find((ref) => ref.kind === "trace_zip") }) }] };
  const states = new Map(links.map((item) => [sha(item.bytes), item.state ?? "available"] as const));
  return evidenceViewOf(pack, "t-1", (ref) => states.get(ref.sha256) ?? "available")!;
}
async function setup(links: Parameters<typeof viewWith>[0], over: Partial<{ authorize: EvidenceDownloadDependencies["authorize"]; presign: EvidenceDownloadDependencies["presign"]; view: EvidenceView | undefined; candidateDigest: string | undefined }> = {}) {
  const memory = memoryS3();
  await storeEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, links.map((item) => ({ kind: item.kind, bytes: item.bytes })));
  const presigned: Array<{ key: string; contentType: string; disposition: string; expiresInSeconds: number }> = [];
  const deps: EvidenceDownloadDependencies = {
    authorize: over.authorize ?? (async () => ({ ...OWNER, candidateDigest: "candidateDigest" in over ? over.candidateDigest : DIGEST, view: "view" in over ? over.view : viewWith(links) })),
    store: { s3: memory.s3, artifactBucketName: "b" },
    presign: over.presign ?? (async (input) => { presigned.push(input); return `https://bucket.s3.example/${input.key}?X-Amz-Expires=${input.expiresInSeconds}`; }),
  };
  return { memory, deps, presigned };
}

describe("the download rule", () => {
  const all = [{ kind: "jpeg" as const, bytes: JPEG }, { kind: "api_sample_json" as const, bytes: SAMPLE }, { kind: "webm" as const, bytes: WEBM }, { kind: "trace_zip" as const, bytes: ZIP }];
  it("serves an image inline, as bytes checked against the pack's own ref", async () => {
    const { deps } = await setup(all);
    const answer = await serveEvidenceArtifact(deps, sha(JPEG));
    expect(answer).toMatchObject({ status: 200, kind: "jpeg", contentType: "image/jpeg", disposition: "inline", retentionClass: "evidence-std" });
    expect(answer.status === 200 && Buffer.from(answer.bytes).equals(JPEG)).toBe(true);
  });
  it("serves a sample as an attachment, and video and trace by a 60-second presigned URL, a trace as a download", async () => {
    const { deps, presigned } = await setup(all);
    expect(await serveEvidenceArtifact(deps, sha(SAMPLE))).toMatchObject({ status: 200, contentType: "application/json", disposition: "attachment" });
    const video = await serveEvidenceArtifact(deps, sha(WEBM));
    const trace = await serveEvidenceArtifact(deps, sha(ZIP));
    expect(video).toMatchObject({ status: 302, kind: "webm", expiresInSeconds: EVIDENCE_PRESIGN_SECONDS });
    expect(trace).toMatchObject({ status: 302, kind: "trace_zip" });
    expect(EVIDENCE_PRESIGN_SECONDS).toBe(60);
    expect(presigned).toEqual([{ key: evidenceArtifactKey("owner-1", "ws-1", sha(WEBM)), contentType: "video/webm", disposition: "inline", expiresInSeconds: 60 },
      { key: evidenceArtifactKey("owner-1", "ws-1", sha(ZIP)), contentType: "application/zip", disposition: "attachment", expiresInSeconds: 60 }]);
  });
  it("is 404 for a hash the store holds but the current pack does not name (a withheld video, another candidate's file)", async () => {
    const { deps, memory } = await setup(all);
    const strayWebm = Buffer.concat([WEBM, Buffer.from("stray")]);
    await storeEvidenceArtifacts({ s3: memory.s3, artifactBucketName: "b" }, OWNER, [{ kind: "webm", bytes: strayWebm }]);
    expect(memory.objects.has(evidenceArtifactKey("owner-1", "ws-1", sha(strayWebm)))).toBe(true);
    expect(await serveEvidenceArtifact(deps, sha(strayWebm))).toEqual({ status: 404 });
    expect(await serveEvidenceArtifact(deps, sha(Buffer.from("anything")))).toEqual({ status: 404 });
  });
  it("is 404 for an expired artifact, though the object may still be there", async () => {
    const { deps } = await setup([{ kind: "jpeg", bytes: JPEG, state: "expired" }]);
    expect(await serveEvidenceArtifact(deps, sha(JPEG))).toEqual({ status: 404 });
  });
  it("is 404 when the pack is for other code than the task's current candidate, and when there is no pack", async () => {
    expect(await serveEvidenceArtifact((await setup(all, { candidateDigest: "d".repeat(64) })).deps, sha(JPEG))).toEqual({ status: 404 });
    expect(await serveEvidenceArtifact((await setup(all, { candidateDigest: undefined })).deps, sha(JPEG))).toEqual({ status: 404 });
    expect(await serveEvidenceArtifact((await setup(all, { view: undefined })).deps, sha(JPEG))).toEqual({ status: 404 });
  });
  it("is 404 when the object differs from what the pack says (size or digest), and nothing leaves", async () => {
    const { deps, memory } = await setup(all);
    memory.objects.set(evidenceArtifactKey("owner-1", "ws-1", sha(JPEG)), { body: Buffer.concat([JPEG, Buffer.from("x")]) });
    expect(await serveEvidenceArtifact(deps, sha(JPEG))).toEqual({ status: 404 });
    memory.objects.set(evidenceArtifactKey("owner-1", "ws-1", sha(JPEG)), { body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(JPEG.length - 4, 9)]) });
    expect(await serveEvidenceArtifact(deps, sha(JPEG))).toEqual({ status: 404 });
    memory.objects.set(evidenceArtifactKey("owner-1", "ws-1", sha(WEBM)), { body: WEBM, metadata: { sha256: "0".repeat(64), kind: "webm" } });
    expect(await serveEvidenceArtifact(deps, sha(WEBM))).toEqual({ status: 404 });
  });
  it("reads only the caller's task: another owner's or workspace's copy is never the answer", async () => {
    const { deps, memory } = await setup(all);
    memory.objects.delete(evidenceArtifactKey("owner-1", "ws-1", sha(JPEG)));
    memory.objects.set(evidenceArtifactKey("owner-2", "ws-1", sha(JPEG)), { body: JPEG });
    expect(await serveEvidenceArtifact(deps, sha(JPEG))).toEqual({ status: 404 });
  });
  it("is 403 for someone who may not read the task, whatever the code of the refusal, and 503 for any other failure", async () => {
    for (const code of ["FORBIDDEN", "TASK_NOT_FOUND", "TASK_ACCESS_DENIED", "NOT_FOUND"]) {
      expect(await serveEvidenceArtifact((await setup(all, { authorize: async () => { throw Object.assign(new Error("no"), { code }); } })).deps, sha(JPEG))).toEqual({ status: 403 });
    }
    expect(await serveEvidenceArtifact((await setup(all, { authorize: async () => undefined })).deps, sha(JPEG))).toEqual({ status: 403 });
    expect(await serveEvidenceArtifact((await setup(all, { authorize: async () => { throw new Error("db down"); } })).deps, sha(JPEG))).toEqual({ status: 503 });
  });
  it("checks the caller on every request, before it looks at the store", async () => {
    const { deps, memory } = await setup(all, { authorize: async () => undefined });
    memory.sent.length = 0;
    await serveEvidenceArtifact(deps, sha(JPEG));
    expect(memory.sent).toEqual([]);
  });
  it("is 503 when the signer fails, and 404 for a malformed digest", async () => {
    expect(await serveEvidenceArtifact((await setup(all, { presign: async () => { throw new Error("kms"); } })).deps, sha(WEBM))).toEqual({ status: 503 });
    expect(await serveEvidenceArtifact((await setup(all)).deps, "../../etc/passwd")).toEqual({ status: 404 });
    expect(await serveEvidenceArtifact((await setup(all)).deps, sha(JPEG).toUpperCase())).toEqual({ status: 404 });
  });
});

describe("the route's answer and its audit event", () => {
  const base = { orgId: "org-1", actor: { type: "user", id: "u-1" } as never, occurredAt: "2026-11-03T10:00:00.000Z", occurrence: "req-1" };
  it("answers an image with a private, sandboxed, no-sniff response and nothing else with a body", async () => {
    const { deps } = await setup([{ kind: "jpeg", bytes: JPEG }]);
    const response = evidenceDownloadResponse(await serveEvidenceArtifact(deps, sha(JPEG)));
    expect(response.statusCode).toBe(200);
    expect(response.isBase64Encoded).toBe(true);
    expect(Buffer.from(response.body, "base64").equals(JPEG)).toBe(true);
    expect(response.headers).toMatchObject({ "content-type": "image/jpeg", "content-disposition": "inline", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; sandbox; frame-ancestors 'none'" });
    expect(response.headers.pragma).toBeUndefined();
    for (const status of [403, 404, 503] as const) expect(JSON.parse(evidenceDownloadResponse({ status }).body)).toBeTypeOf("object");
    expect(evidenceDownloadResponse({ status: 404 }).body).not.toContain(sha(JPEG));
  });
  it("redirects a video to its signed address, and says nothing about the task in the redirect", async () => {
    const { deps } = await setup([{ kind: "webm", bytes: WEBM }]);
    const response = evidenceDownloadResponse(await serveEvidenceArtifact(deps, sha(WEBM)));
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/bucket\.s3\.example\/private\/owner-1\/ws-1\/evidence\//u);
    expect(response.body).toBe("");
  });
  it("audits a served download by kind and class, never by name or path, and a refusal leaves none", async () => {
    const served = await serveEvidenceArtifact((await setup([{ kind: "webm", bytes: WEBM }])).deps, sha(WEBM));
    const event = evidenceDownloadAudit(served, base, "t-1")!;
    expect(event).toMatchObject({ action: "evidence.downloaded", target: { kind: "task", id: "t-1" } });
    expect(JSON.stringify(event)).not.toContain(sha(WEBM));
    expect(JSON.stringify(event)).toContain("evidence-short");
    for (const status of [403, 404, 503] as const) expect(evidenceDownloadAudit({ status }, base, "t-1")).toBeUndefined();
  });
  it("does not serve a download it could not audit", async () => {
    const { deps } = await setup([{ kind: "jpeg", bytes: JPEG }]);
    const recorded: unknown[] = [];
    const ok = await handleEvidenceDownload({ deps, sha256: sha(JPEG), taskId: "t-1", auditBase: base, record: async (event) => { recorded.push(event); } });
    expect(ok.statusCode).toBe(200);
    expect(recorded).toHaveLength(1);
    const failed = await handleEvidenceDownload({ deps, sha256: sha(JPEG), taskId: "t-1", auditBase: base, record: async () => { throw new Error("ledger down"); } });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain("ledger");
    const refused = await handleEvidenceDownload({ deps: (await setup([{ kind: "jpeg", bytes: JPEG }], { authorize: async () => undefined })).deps, sha256: sha(JPEG), taskId: "t-1", auditBase: base, record: async (event) => { recorded.push(event); } });
    expect(refused.statusCode).toBe(403);
    expect(recorded).toHaveLength(1);
  });
});

describe("the lifecycle rules on the artifact bucket", () => {
  type Rule = { Id?: string; Status: string; ExpirationInDays?: number; TagFilters?: Array<{ Key: string; Value: string }> };
  type Bucket = { Properties: { LifecycleConfiguration?: { Rules: Rule[] } } };
  const rulesOf = (context?: Record<string, unknown>) => {
    const template = Template.fromStack(new ControlPlaneStack(new App({ context }), "EvidenceRetention", { naming: environmentNaming("live25d") }));
    const buckets = Object.values(template.findResources("AWS::S3::Bucket") as Record<string, Bucket>);
    return buckets.flatMap((bucket) => bucket.Properties.LifecycleConfiguration?.Rules ?? []).filter((rule) => rule.TagFilters !== undefined);
  };
  it("expires evidence-short after 14 days and evidence-std after 30 by default, each on its own tag, and keeps the screenshot rule", () => {
    const rules = rulesOf();
    expect(rules.map((rule) => [rule.Id, rule.ExpirationInDays, rule.TagFilters])).toEqual([
      ["ExpireE2EScreenshots", 30, [{ Key: "rovara-retention", Value: "e2e-screenshot" }]],
      ["ExpireEvidenceShort", 14, [{ Key: "rovara-retention", Value: "evidence-short" }]],
      ["ExpireEvidenceStd", 30, [{ Key: "rovara-retention", Value: "evidence-std" }]],
    ]);
    expect(rules.every((rule) => rule.Status === "Enabled")).toBe(true);
  });
  it("takes a company's days inside the allowed range, and clamps the rest", () => {
    expect(rulesOf({ evidenceRetentionDays: { "evidence-short": 3, "evidence-std": 90 } }).slice(1).map((rule) => rule.ExpirationInDays)).toEqual([3, 90]);
    expect(rulesOf({ evidenceRetentionDays: { "evidence-short": 5000, "evidence-std": 1 } }).slice(1).map((rule) => rule.ExpirationInDays)).toEqual([90, 7]);
    expect(rulesOf({ evidenceRetentionDays: { "evidence-short": "x", "evidence-std": null } }).slice(1).map((rule) => rule.ExpirationInDays)).toEqual([14, 30]);
  });
  it("is not added to the legacy production template", () => {
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "EvidenceLegacy"));
    for (const bucket of Object.values(legacy.findResources("AWS::S3::Bucket") as Record<string, Bucket>)) expect((bucket.Properties.LifecycleConfiguration?.Rules ?? []).filter((rule) => rule.TagFilters !== undefined)).toEqual([]);
  });
});
