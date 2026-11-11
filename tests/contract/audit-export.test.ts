// tests/contract/audit-export.test.ts
// Task 11 of the Audit Ledger plan: reading the ledger and exporting it as a bundle that the standalone verifier checks
// offline. The bench is the anchor's (FakeDynamoDb for every table, FakeLockedS3 for the ledger bucket) plus a plain fake
// exports bucket, a fake KMS, and records appended by the real appender so their details are really sealed. The fakes do not
// enforce IAM: the broker's grants are pinned in audit-ledger-infrastructure.test.ts.
import type { X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { parseBundle, verifyBundle, type AuditBundleV1, type AuditRecordV1 } from "@rovara/audit-verifier";
import { runCli } from "../../packages/audit-verifier/src/cli.js";
import { AUDIT_EXPORT_AVAILABLE_DAYS, AUDIT_EXPORT_FILE_LIFECYCLE_DAYS, AUDIT_EXPORT_MAX_RECORDS, AUDIT_EXPORT_URL_SECONDS, AUDIT_FILTER_SCAN_MAX, AuditEventInputSchema, auditEventId, type AuditEventInput } from "@agentx/cloud-contracts";
import { appendEvent, type AppenderDeps } from "../../packages/broker/src/audit/appender.js";
import {
  AUDIT_EXPORT_SOURCE,
  AUDIT_EXPORT_STALE_MS,
  AUDIT_EXPORT_MAX_AGE_MS,
  AuditExportBuildError,
  auditExportId,
  buildAuditBundle,
  exportDownloadUrl,
  exportObjectKey,
  getAuditExport,
  runAuditExport,
  startAuditExport,
  type AuditExportClientDeps,
  type AuditExportDeps,
  type AuditExportEvent,
} from "../../packages/broker/src/audit/export.js";
import { AuditKeyring } from "../../packages/broker/src/audit/keyring.js";
import { exportInvoker, exportLinkSigner } from "../../packages/broker/src/audit/export-wiring.js";
import { handleAuditExportEvent } from "../../packages/broker/src/audit/export-handler.js";
import { decodeAuditCursor, readAuditRecords, readAuditStatus, type AuditReadDeps } from "../../packages/broker/src/audit/reader.js";
import { leavesObjectKey, recordsObjectKey, sealObjectKey, statementObjectKey } from "../../packages/broker/src/audit/anchor.js";
import { FakeAuditSqs } from "../support/fake-audit-sqs.js";
import { FakeKms } from "../support/fake-kms.js";
import { makePki } from "../support/fake-tsa.js";
import { fakeTsaHost, type FakeTsaHost } from "../support/fake-tsa-server.js";
import { routeFetch } from "../support/developer-fakes.js";
import { AUDIT_TSA_ENDPOINTS, AUDIT_TSA_SPACING_MS } from "@agentx/cloud-contracts";
import type { TsaSettings } from "../../packages/broker/src/audit/tsa-client.js";
import {
  A, B, BUCKET, E0, E1, LEDGER, SEALS, at, harness, iso, pad12, run, metaOf,
  type Harness,
} from "../support/audit-anchor-harness.js";

const C = "org_cccccccccccccccccccc";
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const KEYS = "keys";
const STATE = "state";
const EXPORTS_BUCKET = "audit-exports-bucket";
const QUEUE_URL = "https://sqs.test/agentx-test-audit-intake.fifo";
const PLAINTEXT = "Alice Example";

/** The exports bucket: put, get and delete of whole objects, with every call kept. */
class FakeExportsBucket {
  readonly objects = new Map<string, Buffer>();
  readonly calls: Array<{ command: string; key: string | undefined }> = [];
  /** Runs inside a put, before it takes effect: a concurrent run's commit, say. */
  beforePut: ((key: string) => void | Promise<void>) | undefined;
  async send(command: unknown): Promise<unknown> {
    await Promise.resolve();
    const input = (command as { input: Record<string, unknown> }).input;
    const key = String(input.Key);
    if (command instanceof PutObjectCommand) {
      this.calls.push({ command: "PutObject", key });
      await this.beforePut?.(key);
      // `If-None-Match: *` fails with 412 when the key exists, as S3 does.
      if (input.IfNoneMatch === "*" && this.objects.has(key)) throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      this.objects.set(key, Buffer.from(input.Body as Uint8Array));
      return { $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof GetObjectCommand) {
      this.calls.push({ command: "GetObject", key });
      const body = this.objects.get(key);
      if (body === undefined) throw Object.assign(new Error("no such key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    }
    if (command instanceof DeleteObjectCommand) {
      this.calls.push({ command: "DeleteObject", key });
      this.objects.delete(key);
      return { $metadata: { httpStatusCode: 204 } };
    }
    throw new Error("FakeExportsBucket supports put, get and delete only");
  }
}

interface Bench {
  h: Harness;
  kms: FakeKms;
  deps: AuditExportDeps & AuditExportClientDeps;
  readDeps: AuditReadDeps;
  appender: AppenderDeps;
  exportsBucket: FakeExportsBucket;
  sqs: FakeAuditSqs;
  invocations: AuditExportEvent[];
  logs: Array<Record<string, unknown>>;
  /** Appends `count` events to an org (with details unless told otherwise), one second apart. */
  append: (orgId: string, count: number, options?: { details?: boolean }) => Promise<void>;
  /** Moves the clock to slot `n` and runs the anchor. */
  seal: (n: number) => Promise<void>;
}

function bench(options: { anchors?: Record<string, readonly X509Certificate[]>; tsa?: (h: Harness) => void } = {}): Bench {
  const h = harness();
  options.tsa?.(h);
  const kms = new FakeKms(KEY_ARN);
  const keyring = (caller: "appender" | "broker") => new AuditKeyring({ documentClient: h.deps.documentClient, keysTable: KEYS, kms: kms.as(caller).client, keyId: KEY_ARN, now: () => h.clock.now });
  const logs: Array<Record<string, unknown>> = [];
  const appender: AppenderDeps = { documentClient: h.deps.documentClient, ledgerTable: LEDGER, keyring: keyring("appender"), now: () => h.clock.now, log: (entry) => logs.push(entry), sleep: async () => undefined };
  const exportsBucket = new FakeExportsBucket();
  const sqs = new FakeAuditSqs();
  const invocations: AuditExportEvent[] = [];
  const s3 = { send: (command: { input: { Bucket?: string } }) => (command.input.Bucket === EXPORTS_BUCKET ? exportsBucket.send(command) : h.s3.client.send(command as never)) } as unknown as S3Client;
  const readDeps: AuditReadDeps = { documentClient: h.deps.documentClient, ledgerTable: LEDGER, sealsTable: SEALS, keyring: keyring("broker") };
  const deps: AuditExportDeps & AuditExportClientDeps = {
    ...readDeps,
    s3,
    ledgerBucket: BUCKET,
    exportsBucket: EXPORTS_BUCKET,
    tableName: STATE,
    audit: { sqs: sqs.client, queueUrl: QUEUE_URL, documentClient: h.deps.documentClient, tableName: STATE, now: () => h.clock.now, log: (entry) => logs.push(entry) },
    anchors: options.anchors ?? {},
    now: () => h.clock.now,
    log: (entry) => logs.push(entry),
    invokeExport: async (event) => { invocations.push(event); },
    presign: async (input) => ({ url: `https://signed.test/${input.bucket}/${input.key}?expires=${String(input.expiresInSeconds)}`, expiresInSeconds: input.expiresInSeconds }),
  };
  const counters = new Map<string, number>();
  const append = async (orgId: string, count: number, appendOptions: { details?: boolean } = {}): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      const n = (counters.get(orgId) ?? 0) + 1;
      counters.set(orgId, n);
      h.clock.now += 1000;
      const event: AuditEventInput = AuditEventInputSchema.parse({
        eventId: auditEventId("pull_request.opened", `${orgId}-${String(n)}`),
        orgId,
        action: "pull_request.opened",
        actor: { kind: "member", id: n % 2 === 0 ? "dev_2" : "dev_1" },
        target: { kind: "pull_request", id: `pr_${String(n)}` },
        occurredAt: iso(h.clock.now - 500),
        facts: { number: n },
        ...(appendOptions.details === false ? {} : { details: [{ subject: "org", fields: { repository: "acme/widgets" } }, { subject: "dev_1", fields: { name: PLAINTEXT, email: "alice@example.test" } }, { subject: "dev_2", fields: { name: "Bob Example" } }] }),
      });
      expect(await appendEvent(appender, event)).toMatchObject({ result: "appended" });
    }
  };
  const seal = async (n: number): Promise<void> => {
    h.clock.now = at(n);
    await run(h, at(n));
  };
  return { h, kms, deps, readDeps, appender, exportsBucket, sqs, invocations, logs, append, seal };
}

/** Org A has 6 records sealed in epoch 0 (org B has 3, so the epoch has two seals), 4 more sealed in epoch 1, and 2 not sealed yet. */
async function world(options: Parameters<typeof bench>[0] = {}): Promise<Bench> {
  const b = bench(options);
  b.h.clock.now = at(0) - 60_000;
  await b.append(A, 6);
  await b.append(B, 3);
  await b.seal(0);
  b.h.clock.now = at(1) - 60_000;
  await b.append(A, 4);
  await b.seal(1);
  b.h.clock.now = at(2) - 60_000;
  await b.append(A, 2);
  return b;
}

const RANGE_INVALID = { code: "AUDIT_RANGE_INVALID" };
const bundleText = (bundle: AuditBundleV1): string => JSON.stringify(bundle);
const requester = (orgId = A) => ({ orgId: orgId as never, actor: { kind: "member" as const, id: "dev_1" } });
/** The file a ready export's record names. */
const fileKey = (b: Bench, orgId: string, exportId: string): string => String(b.h.db.get(`ORG#${orgId}#AUDIT_EXPORT#${exportId}`, "META")!.objectKey);
const gunzipped = (b: Bench, orgId: string, exportId: string): AuditBundleV1 => parseBundle(JSON.parse(gunzipSync(b.exportsBucket.objects.get(fileKey(b, orgId, exportId))!).toString("utf8")));

describe("buildAuditBundle", () => {
  it("builds org A's bundle so that the standalone verifier passes it, with no record of org B in it", async () => {
    const b = await world();
    const bundle = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 12, withDetails: false });
    const report = verifyBundle(bundle, { anchors: {} });
    expect(report.checks.filter((check) => !check.ok), JSON.stringify(report.checks)).toStrictEqual([]);
    expect(report).toMatchObject({ ok: true, sealedThroughSeq: 10, unsealedCount: 2 });
    expect(bundle.records.map((record) => record.seq)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bundle.unsealed.map((record) => record.seq)).toStrictEqual([11, 12]);
    expect(bundle.seals.map((entry) => entry.epoch.epochId)).toStrictEqual([E0, E1]);
    expect(bundle.previous).toMatchObject({ seq: 0 });
    expect(bundle.previousSeal).toBeNull();
    // The epoch shares its seals root with org B, and the proof still holds.
    expect(bundle.seals[0]!.inclusion.size).toBe(2);
    const everything = bundleText(bundle);
    expect(everything).not.toContain(B);
    for (const record of [...bundle.records, ...bundle.unsealed]) expect(record.orgId).toBe(A);
    // The same bundle, as an auditor would run it, through the verifier's own command.
    const other = await buildAuditBundle(b.deps, B, { fromSeq: 1, toSeq: 3, withDetails: false });
    expect(verifyBundle(other, { anchors: {} }).ok).toBe(true);
    expect(bundleText(other)).not.toContain(A);
  });

  it("widens the range to the seals around it and keeps the records after the last seal as `unsealed`", async () => {
    const b = await world();
    const middle = await buildAuditBundle(b.deps, A, { fromSeq: 3, toSeq: 8, withDetails: false });
    expect(middle.seals.map((entry) => [entry.seal.fromSeq, entry.seal.toSeq])).toStrictEqual([[1, 6], [7, 10]]);
    expect(middle.unsealed).toStrictEqual([]);
    expect(verifyBundle(middle, { anchors: {} })).toMatchObject({ ok: true, sealedThroughSeq: 10, unsealedCount: 0 });
    const second = await buildAuditBundle(b.deps, A, { fromSeq: 8, toSeq: 9, withDetails: false });
    expect(second.seals.map((entry) => [entry.seal.fromSeq, entry.seal.toSeq])).toStrictEqual([[7, 10]]);
    expect(second.previous).toMatchObject({ seq: 6 });
    expect(second.previousSeal).toMatchObject({ fromSeq: 1, toSeq: 6 });
    expect(verifyBundle(second, { anchors: {} }).ok).toBe(true);
  });

  it("a range inside the unsealed tail starts right after the last seal, and still verifies", async () => {
    const b = await world();
    const tail = await buildAuditBundle(b.deps, A, { fromSeq: 12, toSeq: 12, withDetails: false });
    expect(tail.seals).toStrictEqual([]);
    expect(tail.records).toStrictEqual([]);
    expect(tail.unsealed.map((record) => record.seq)).toStrictEqual([11, 12]);
    expect(tail.previous).toMatchObject({ seq: 10 });
    expect(tail.previousSeal).toMatchObject({ toSeq: 10 });
    expect(verifyBundle(tail, { anchors: {} })).toMatchObject({ ok: true, sealedThroughSeq: 10, unsealedCount: 2 });
  });

  it("an export that reaches past the head stops at the head, and one that starts after it is refused", async () => {
    const b = await world();
    const all = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 5000, withDetails: false });
    expect([...all.records, ...all.unsealed]).toHaveLength(12);
    await expect(buildAuditBundle(b.deps, A, { fromSeq: 13, toSeq: 20, withDetails: false })).rejects.toMatchObject(RANGE_INVALID);
    await expect(buildAuditBundle(b.deps, A, { fromSeq: 5, toSeq: 2, withDetails: false })).rejects.toMatchObject(RANGE_INVALID);
    await expect(buildAuditBundle(b.deps, A, { fromSeq: 0, toSeq: 2, withDetails: false })).rejects.toMatchObject(RANGE_INVALID);
    await expect(buildAuditBundle(b.deps, C, { fromSeq: 1, toSeq: 2, withDetails: false })).rejects.toMatchObject(RANGE_INVALID);
  });

  it("refuses more than 200,000 records, before it reads a single object", async () => {
    const b = bench();
    b.h.db.set({ pk: `AUDIT#${C}`, sk: "HEAD", seq: AUDIT_EXPORT_MAX_RECORDS + 1, hash: "0".repeat(64), updatedAt: iso(at(0)) });
    await expect(buildAuditBundle(b.deps, C, { fromSeq: 1, toSeq: AUDIT_EXPORT_MAX_RECORDS + 1, withDetails: false })).rejects.toMatchObject(RANGE_INVALID);
    expect(b.h.s3.calls).toStrictEqual([]);
    expect(b.h.operations.filter((operation) => operation.action === "Query")).toStrictEqual([]);
    // 200,000 exactly is allowed to go on (it fails here only for want of records, which is a problem with what is stored).
    b.h.db.set({ pk: `AUDIT#${C}`, sk: "HEAD", seq: AUDIT_EXPORT_MAX_RECORDS, hash: "0".repeat(64), updatedAt: iso(at(0)) });
    await expect(buildAuditBundle(b.deps, C, { fromSeq: 1, toSeq: AUDIT_EXPORT_MAX_RECORDS, withDetails: false })).rejects.toMatchObject({ name: "AuditExportBuildError" });
  });

  it("reads every sealed object by the version id the anchor recorded, and a later version or a delete marker changes nothing", async () => {
    const b = await world();
    const before = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 12, withDetails: false });
    // Someone writes a second version of a sealed key, and a delete marker on another.
    b.h.s3.forceVersion(sealObjectKey(A, 1), "{\"tampered\":true}");
    b.h.s3.forceVersion(recordsObjectKey(A, 7), "not even json\n");
    b.h.s3.addDeleteMarker(statementObjectKey(E0));
    b.h.s3.addDeleteMarker(leavesObjectKey(E1));
    b.h.s3.calls.length = 0;
    const after = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 12, withDetails: false });
    expect({ ...after, exportedAt: "" }).toStrictEqual({ ...before, exportedAt: "" });
    const asked = b.h.s3.calls.filter((call) => call.command === "GetObject");
    expect(asked.length).toBeGreaterThanOrEqual(8);
    for (const call of asked) expect(call.input.VersionId, call.key).toMatch(/^v\d+-/);
    expect(b.h.s3.calls.map((call) => call.command).filter((command) => command !== "GetObject")).toStrictEqual([]);
    // The version asked for is the one recorded in the index.
    const index = b.h.db.get(`SEALS#${A}`, pad12(1))!;
    const recorded = (index.objects as { seal: { versionId: string } }).seal.versionId;
    expect(asked.some((call) => call.key === sealObjectKey(A, 1) && call.input.VersionId === recorded)).toBe(true);
  });

  it("never reads another org's objects, even when the seal index is changed to point at them", async () => {
    const b = await world();
    const index = b.h.db.get(`SEALS#${A}`, pad12(1))!;
    const other = b.h.db.get(`SEALS#${B}`, pad12(1))!;
    b.h.db.set({ ...index, objects: other.objects });
    b.h.s3.calls.length = 0;
    await expect(buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 6, withDetails: false })).rejects.toBeInstanceOf(AuditExportBuildError);
    expect(b.h.s3.calls.filter((call) => String(call.key).includes(B))).toStrictEqual([]);
    // An index item that keeps org A's version ids but names org B's keys is refused as well: a recorded key must be the derived one.
    const c = await world();
    const mine = c.h.db.get(`SEALS#${A}`, pad12(1))!;
    const theirs = c.h.db.get(`SEALS#${B}`, pad12(1))!.objects as { seal: { key: string } };
    c.h.db.set({ ...mine, objects: { ...(mine.objects as object), seal: { ...(mine.objects as { seal: object }).seal, key: theirs.seal.key } } });
    c.h.s3.calls.length = 0;
    await expect(buildAuditBundle(c.deps, A, { fromSeq: 1, toSeq: 6, withDetails: false })).rejects.toMatchObject({ code: "SEAL_INDEX_INCONSISTENT" });
    expect(c.h.s3.calls.filter((call) => String(call.key).includes(B))).toStrictEqual([]);
  });

  it("refuses an index with a gap, and a sealed object that is gone, as problems with what is stored", async () => {
    const b = await world();
    b.h.db.delete(`SEALS#${A}`, pad12(7));
    await expect(buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 10, withDetails: false })).rejects.toMatchObject({ name: "AuditExportBuildError", code: "SEAL_INDEX_INCONSISTENT" });
    const c = await world();
    const index = c.h.db.get(`SEALS#${A}`, pad12(1))!;
    c.h.db.set({ ...index, objects: { ...(index.objects as object), seal: { ...((index.objects as { seal: object }).seal), versionId: "v-missing" } } });
    await expect(buildAuditBundle(c.deps, A, { fromSeq: 1, toSeq: 6, withDetails: false })).rejects.toMatchObject({ code: "SEALED_OBJECT_MISSING" });
  });
});

describe("details in a bundle", () => {
  it("without details there is no plaintext anywhere in the bundle, and with details the commitments verify", async () => {
    const b = await world();
    const plain = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 12, withDetails: false });
    expect(plain.details).toBeUndefined();
    const text = bundleText(plain);
    for (const secret of [PLAINTEXT, "Bob Example", "alice@example.test", "acme/widgets"]) expect(text).not.toContain(secret);

    const detailed = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 12, withDetails: true });
    const report = verifyBundle(detailed, { anchors: {} });
    expect(report.checks.filter((check) => !check.ok), JSON.stringify(report.checks)).toStrictEqual([]);
    // Three parts on each of twelve records.
    expect(detailed.details).toHaveLength(36);
    expect(detailed.details!.find((part) => part.seq === 1 && part.subject === "dev_1")).toMatchObject({ fields: { name: PLAINTEXT, email: "alice@example.test" } });
    expect(report.checks.find((check) => check.name === "details")!.detail).toBe("36 details match their commitments; 0 erased");
    // Sealed and unsealed records both carry theirs.
    expect(detailed.details!.some((part) => part.seq === 12)).toBe(true);
  });

  it("shows a person's erased parts as erased, and the rest still verify", async () => {
    const b = await world();
    b.h.db.set({ pk: `ORG#${A}`, sk: "SUBJECT#dev_1", erasedAt: iso(at(3)) });
    const detailed = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 12, withDetails: true });
    const forDev1 = detailed.details!.filter((part) => part.subject === "dev_1");
    expect(forDev1).toHaveLength(12);
    for (const part of forDev1) expect(part).toStrictEqual({ seq: part.seq, subject: "dev_1", erased: true });
    expect(JSON.stringify(detailed)).not.toContain(PLAINTEXT);
    expect(detailed.details!.find((part) => part.seq === 1 && part.subject === "dev_2")).toMatchObject({ fields: { name: "Bob Example" } });
    const report = verifyBundle(detailed, { anchors: {} });
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "details")!.detail).toBe("24 details match their commitments; 12 erased");
  });

  it("shows every part as erased after the org is shredded", async () => {
    const b = await world();
    b.h.db.set({ pk: `ORG#${A}`, sk: "SHREDDED", at: iso(at(3)) });
    const detailed = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 12, withDetails: true });
    expect(detailed.details!.every((part) => "erased" in part)).toBe(true);
    expect(JSON.stringify(detailed)).not.toContain(PLAINTEXT);
    expect(verifyBundle(detailed, { anchors: {} }).ok).toBe(true);
  });

  it("uses the org it is asked about for every key: org A's key never opens org B's details", async () => {
    const b = await world();
    await b.append(B, 1);
    const detailed = await buildAuditBundle(b.deps, B, { fromSeq: 1, toSeq: 4, withDetails: true });
    for (const call of b.kms.calls.filter((entry) => entry.caller === "broker")) expect(call.context["rovara:org"]).toBe(B);
    expect(detailed.details!.every((part) => !("erased" in part))).toBe(true);
  });
});

describe("startAuditExport", () => {
  it("records the request as running and starts the build in the background, for the org it was given", async () => {
    const b = await world();
    const started = await startAuditExport(b.deps, requester(), { requestId: "req_1", fromSeq: 1, toSeq: 12, withDetails: true });
    expect(started).toStrictEqual({ exportId: auditExportId(A, "req_1"), status: "running" });
    expect(started.exportId).toMatch(/^aex_[0-9a-f]{32}$/);
    const item = b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${started.exportId}`, "META")!;
    expect(item).toMatchObject({ status: "running", requestedBy: { kind: "member", id: "dev_1" }, range: { fromSeq: 1, toSeq: 12 }, withDetails: true });
    expect(b.invocations).toStrictEqual([{ source: AUDIT_EXPORT_SOURCE, orgId: A, exportId: started.exportId }]);
    expect(AUDIT_EXPORT_SOURCE).toBe("agentx.audit-export");
    // The same request again is the same export and starts nothing.
    expect(await startAuditExport(b.deps, requester(), { requestId: "req_1", fromSeq: 1, toSeq: 12 })).toStrictEqual(started);
    expect(b.invocations).toHaveLength(1);
    // The same request id in another org is another export.
    expect(auditExportId(B, "req_1")).not.toBe(started.exportId);
  });

  it("refuses a range over 200,000 records, a backwards range and an empty request id, and records nothing", async () => {
    const b = await world();
    for (const request of [
      { requestId: "r", fromSeq: 1, toSeq: AUDIT_EXPORT_MAX_RECORDS + 1 },
      { requestId: "r", fromSeq: 9, toSeq: 3 },
      { requestId: "r", fromSeq: 0, toSeq: 3 },
      { requestId: "", fromSeq: 1, toSeq: 3 },
    ]) {
      await expect(startAuditExport(b.deps, requester(), request)).rejects.toMatchObject(request.requestId === "" ? { code: "CONFIG_INVALID" } : RANGE_INVALID);
    }
    await expect(startAuditExport(b.deps, requester(), { requestId: "x".repeat(201), fromSeq: 1, toSeq: 3 })).rejects.toMatchObject({ code: "CONFIG_INVALID", statusCode: 400 });
    expect(b.h.db.find((item) => String(item.pk).includes("AUDIT_EXPORT#"))).toStrictEqual([]);
    expect(b.invocations).toStrictEqual([]);
  });

  it("records a staff member by their op_ id, and marks the export failed when the background start fails", async () => {
    const b = await world();
    const operator = { orgId: A as never, actor: { kind: "operator" as const, id: `op_${"ab".repeat(12)}` } };
    b.deps.invokeExport = async () => { throw Object.assign(new Error("no"), { name: "ServiceException" }); };
    const started = await startAuditExport(b.deps, operator, { requestId: "req_op", fromSeq: 1, toSeq: 4 });
    expect(started.status).toBe("failed");
    const view = await getAuditExport(b.deps, A, started.exportId);
    expect(view).toMatchObject({ status: "failed", requestedBy: operator.actor, failure: { code: "COULD_NOT_START" } });
  });

  it("reports an export another org asked for as unknown, and a running one that lost its worker as failed", async () => {
    const b = await world();
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "req_2", fromSeq: 1, toSeq: 4 });
    expect(await getAuditExport(b.deps, B, exportId)).toBeUndefined();
    expect(await getAuditExport(b.deps, A, "aex_not-an-id")).toBeUndefined();
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "running" });
    b.h.clock.now += AUDIT_EXPORT_STALE_MS + 1;
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "failed", failure: { code: "TIMED_OUT" } });
    // The stored record is not changed by being looked at.
    expect(b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")).toMatchObject({ status: "running" });
  });
});

describe("runAuditExport", () => {
  async function started(b: Bench, request: { fromSeq: number; toSeq: number; withDetails?: boolean }, id = "req"): Promise<string> {
    return (await startAuditExport(b.deps, requester(), { requestId: id, ...request })).exportId;
  }
  const pendingItems = (b: Bench) => b.h.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"));

  it("writes a gzipped bundle the verifier passes, to <orgId>/<exportId>.<attempt>.rovara-audit.json.gz, and sets ready with the audit.exported pending item in one transaction", async () => {
    const b = await world();
    const exportId = await started(b, { fromSeq: 1, toSeq: 12 });
    b.h.transactions.length = 0;
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");

    // Each attempt has a key of its own: the export's prefix and a random suffix.
    const [key] = [...b.exportsBucket.objects.keys()];
    expect(key).toMatch(new RegExp(`^${A}/${exportId}\\.[0-9a-f]{16}\\.rovara-audit\\.json\\.gz$`));
    expect(b.exportsBucket.objects.size).toBe(1);
    expect(exportObjectKey(A, exportId, "0123456789abcdef")).toBe(`${A}/${exportId}.0123456789abcdef.rovara-audit.json.gz`);
    const bundle = gunzipped(b, A, exportId);
    expect(verifyBundle(bundle, { anchors: {} })).toMatchObject({ ok: true, sealedThroughSeq: 10, unsealedCount: 2 });
    expect(bundle.details).toBeUndefined();

    const meta = b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")!;
    expect(meta).toMatchObject({ status: "ready", objectKey: key });
    expect((meta.summary as { bytes: number }).bytes).toBe(b.exportsBucket.objects.get(key!)!.length);
    expect(meta.summary).toMatchObject({ fromSeq: 1, toSeq: 12, records: 12, sealedThroughSeq: 10, unsealedCount: 2, epochsWithoutTimestamp: [E0, E1], coveredEpochs: [], unverifiedAuthorities: [], lockModes: ["COMPLIANCE"] });
    expect((meta.summary as { timestampedThrough?: string }).timestampedThrough).toBeUndefined();

    // One transaction holds the ready update and the pending item for audit.exported.
    const together = b.h.transactions.filter((entry) => entry.operations.some((operation) => operation.pk.includes("AUDIT_EXPORT#")));
    expect(together).toHaveLength(1);
    expect(together[0]!.operations.map((operation) => [operation.action, operation.pk.startsWith("AUDIT_PENDING#") ? "AUDIT_PENDING#" : operation.pk.includes("AUDIT_EXPORT#") ? "export" : operation.pk])).toStrictEqual([["UpdateItem", "export"], ["PutItem", "AUDIT_PENDING#"]]);
    const pending = pendingItems(b);
    expect(pending).toHaveLength(0); // the flush after the commit sent it and deleted it
    expect(b.sqs.queue).toHaveLength(1);
    const sent = JSON.parse(b.sqs.queue[0]!.body) as AuditEventInput;
    expect(sent).toMatchObject({ action: "audit.exported", orgId: A, actor: { kind: "member", id: "dev_1" }, target: { kind: "audit", id: exportId }, facts: { fromSeq: 1, toSeq: 12, withDetails: false } });
  });

  it("the export passes the verifier's own command, as an auditor would run it", async () => {
    const b = await world();
    const exportId = await started(b, { fromSeq: 1, toSeq: 12, withDetails: true });
    await runAuditExport(b.deps, { orgId: A, exportId });
    const directory = mkdtempSync(join(tmpdir(), "audit-export-"));
    const file = join(directory, `${exportId}.rovara-audit.json.gz`);
    writeFileSync(file, b.exportsBucket.objects.get(fileKey(b, A, exportId))!);
    let out = "";
    const exit = runCli([file], { stdout: (text) => { out += text; }, stderr: (text) => { out += text; } });
    expect(exit, out).toBe(0);
    expect(out).toContain("Sealed and checked through record 10.");
    expect(out).toContain("2 newer records are not sealed yet.");
    expect(out).toContain("Sealed copies are locked in compliance mode.");
    expect(out).toContain("36 details match their commitments");
  });

  it("a later export extends an earlier one, as the auditor's --extends checks", async () => {
    const b = await world();
    const first = await started(b, { fromSeq: 1, toSeq: 12 }, "one");
    await runAuditExport(b.deps, { orgId: A, exportId: first });
    await b.append(A, 3);
    await b.seal(3);
    const second = await started(b, { fromSeq: 1, toSeq: 100 }, "two");
    await runAuditExport(b.deps, { orgId: A, exportId: second });
    const directory = mkdtempSync(join(tmpdir(), "audit-export-"));
    const [older, newer] = [first, second].map((id) => {
      const file = join(directory, `${id}.gz`);
      writeFileSync(file, b.exportsBucket.objects.get(fileKey(b, A, id))!);
      return file;
    });
    let out = "";
    expect(runCli([newer!, "--extends", older!], { stdout: (text) => { out += text; }, stderr: (text) => { out += text; } }), out).toBe(0);
    expect(out).toContain("extends");
  });

  it("a sealed record that was changed makes the export fail, naming the check, with the report and no file and no audit.exported item", async () => {
    const b = await world();
    // The records object of org A's first seal is replaced by a changed copy, and the index is made to name it.
    const original = b.h.s3.currentText(recordsObjectKey(A, 1))!;
    const lines = original.trim().split("\n").map((line) => JSON.parse(line) as AuditRecordV1);
    lines[2] = { ...lines[2]!, facts: { number: 999 } };
    const changed = b.h.s3.forceVersion(recordsObjectKey(A, 1), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const index = b.h.db.get(`SEALS#${A}`, pad12(1))!;
    const objects = index.objects as { records: { versionId: string } };
    b.h.db.set({ ...index, objects: { ...objects, records: { ...objects.records, versionId: changed } } });

    const exportId = await started(b, { fromSeq: 1, toSeq: 12 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("failed");
    const meta = b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")!;
    expect(meta).toMatchObject({ status: "failed", failure: { code: "BUNDLE_CHECK_FAILED" } });
    const failure = meta.failure as { failedChecks: string[]; report: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> } };
    expect(failure.failedChecks).toContain("chain");
    expect(failure.report.ok).toBe(false);
    expect(failure.report.checks.find((check) => check.name === "chain")).toMatchObject({ ok: false, detail: "record 3 fails the hash check" });
    expect(b.exportsBucket.objects.size).toBe(0);
    expect(b.exportsBucket.calls).toStrictEqual([]);
    expect(pendingItems(b)).toStrictEqual([]);
    expect(b.sqs.offered()).toBe(0);
    expect(b.logs.filter((entry) => entry.event === "audit.export_verification_failed")).toMatchObject([{ failedChecks: expect.arrayContaining(["chain"]) as unknown }]);
    // No download is offered for a failed export.
    await expect(exportDownloadUrl(b.deps, A, exportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a tampered unsealed record in the table fails the export too", async () => {
    const b = await world();
    const item = b.h.db.get(`AUDIT#${A}`, `SEQ#${pad12(12)}`)!;
    b.h.db.set({ ...item, facts: { number: 1000 } });
    const exportId = await started(b, { fromSeq: 11, toSeq: 12 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("failed");
    expect(b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")).toMatchObject({ status: "failed", failure: { failedChecks: ["chain"] } });
    expect(b.exportsBucket.objects.size).toBe(0);
  });

  it("a range over the limit, or one that starts past the head, is failed with its code and nothing is written", async () => {
    const b = await world();
    const exportId = await started(b, { fromSeq: 40, toSeq: 50 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("failed");
    expect(b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")).toMatchObject({ status: "failed", failure: { code: "AUDIT_RANGE_INVALID" } });
    expect(b.exportsBucket.calls).toStrictEqual([]);
  });

  it("ready and its audit.exported item commit together: a commit that is refused (cancelled) leaves no file, no item and a running export that the retry finishes", async () => {
    const b = await world();
    const exportId = await started(b, { fromSeq: 1, toSeq: 12 });
    b.h.hooks.before = (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("AUDIT_EXPORT#")) {
        throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] });
      }
    };
    await expect(runAuditExport(b.deps, { orgId: A, exportId })).rejects.toMatchObject({ name: "TransactionCanceledException" });
    b.h.hooks.before = undefined;
    expect(b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")).toMatchObject({ status: "running" });
    expect(pendingItems(b)).toStrictEqual([]);
    // The cancellation is definite: nothing was committed, so this run's own file is removed.
    expect(b.exportsBucket.objects.size).toBe(0);
    expect(b.exportsBucket.calls.map((call) => call.command)).toStrictEqual(["PutObject", "DeleteObject"]);
    // The platform's retry of the background invoke: the whole thing is made again.
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    expect(b.exportsBucket.objects.size).toBe(1);
    expect(b.sqs.queue).toHaveLength(1);
  });

  it("any other commit error keeps the file, whatever the record shows, and rethrows so the platform retries: a late commit can never point at a deleted file", async () => {
    const b = await world();
    const exportId = await started(b, { fromSeq: 1, toSeq: 12 });
    // The answer is lost; the record still reads running (the commit may yet land).
    b.h.hooks.before = (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("AUDIT_EXPORT#")) throw Object.assign(new Error("the process died"), { name: "ProcessDied" });
    };
    await expect(runAuditExport(b.deps, { orgId: A, exportId })).rejects.toMatchObject({ name: "ProcessDied" });
    b.h.hooks.before = undefined;
    expect(metaOf2b(b, exportId)).toMatchObject({ status: "running" });
    expect(b.exportsBucket.calls.map((call) => call.command)).toStrictEqual(["PutObject"]);
    expect(b.exportsBucket.objects.size).toBe(1);
    // The retry writes a file of its own; the first stays an orphan for the lifecycle, and the ready record names the retry's.
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    expect(b.exportsBucket.objects.size).toBe(2);
    expect(b.exportsBucket.objects.has(fileKey(b, A, exportId))).toBe(true);
  });

  it("does not rebuild a finished export, ignores an unknown one, and never looks at another org's", async () => {
    const b = await world();
    const exportId = await started(b, { fromSeq: 1, toSeq: 12 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    b.h.s3.calls.length = 0;
    b.exportsBucket.calls.length = 0;
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("already_ready");
    expect(b.h.s3.calls).toStrictEqual([]);
    expect(b.exportsBucket.calls).toStrictEqual([]);
    expect(await runAuditExport(b.deps, { orgId: B, exportId })).toBe("unknown");
    expect(await runAuditExport(b.deps, { orgId: A, exportId: "aex_00000000000000000000000000000000" })).toBe("unknown");
    expect(b.sqs.queue).toHaveLength(1);
  });

  it("keeps the audit.exported item for the drain when the flush does not deliver it", async () => {
    const b = await world();
    b.sqs.mode = "throw";
    const exportId = await started(b, { fromSeq: 1, toSeq: 4 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    expect(pendingItems(b)).toHaveLength(1);
    expect(pendingItems(b)[0]!.event).toMatchObject({ action: "audit.exported", target: { id: exportId } });
  });

  it("with details, the export carries them and the audit.exported fact says so", async () => {
    const b = await world();
    const exportId = await started(b, { fromSeq: 1, toSeq: 12, withDetails: true });
    await runAuditExport(b.deps, { orgId: A, exportId });
    const bundle = gunzipped(b, A, exportId);
    expect(bundle.details).toHaveLength(36);
    expect(JSON.parse(b.sqs.queue[0]!.body)).toMatchObject({ facts: { withDetails: true } });
  });
});

describe("runAuditExport: late, retried and ambiguous runs", () => {
  const started = async (b: Bench, id = "late") => (await startAuditExport(b.deps, requester(), { requestId: id, fromSeq: 1, toSeq: 12 })).exportId;
  const metaOf2 = (b: Bench, exportId: string) => b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")!;
  const pendingItems = (b: Bench) => b.h.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#"));

  it("an attempt that starts after the platform's event age has passed is failed as timed out, builds nothing, and can never become ready later", async () => {
    const b = await world();
    const exportId = await started(b);
    b.h.clock.now += AUDIT_EXPORT_MAX_AGE_MS + 1000;
    b.h.s3.calls.length = 0;
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("failed");
    expect(metaOf2(b, exportId)).toMatchObject({ status: "failed", failure: { code: "TIMED_OUT" } });
    expect(b.h.s3.calls).toStrictEqual([]);
    expect(b.exportsBucket.calls).toStrictEqual([]);
    expect(pendingItems(b)).toStrictEqual([]);
    // The retry that the platform may still deliver finds it failed, and the view agrees.
    b.h.clock.now -= AUDIT_EXPORT_MAX_AGE_MS;
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("already_failed");
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "failed", failure: { code: "TIMED_OUT" } });
    expect(b.exportsBucket.objects.size).toBe(0);
  });

  it("the view calls an export failed only after the last attempt the platform can still start has had its whole timeout", async () => {
    const b = await world();
    const exportId = await started(b, "view");
    // An attempt may start up to AUDIT_EXPORT_MAX_AGE_MS after the request and run 15 minutes, with a minute to spare: until then the export is running.
    b.h.clock.now += AUDIT_EXPORT_STALE_MS;
    // Plus a minute's margin for the start-up and the clocks of the machines involved.
    expect(AUDIT_EXPORT_STALE_MS).toBe(AUDIT_EXPORT_MAX_AGE_MS + 15 * 60_000 + 60_000);
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "running" });
    b.h.clock.now += 1;
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "failed", failure: { code: "TIMED_OUT" } });
  });

  it("an attempt that starts just inside the event age still builds and commits", async () => {
    const b = await world();
    const exportId = await started(b, "inside");
    b.h.clock.now += AUDIT_EXPORT_MAX_AGE_MS - 1000;
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
  });

  it("a commit that went through but answered with an error keeps the file: the export is ready, and the retry finds it so", async () => {
    const b = await world();
    const exportId = await started(b, "ambiguous");
    const real = b.deps.documentClient;
    let lost = true;
    b.deps.documentClient = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const out = await (real as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
      if (lost && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("AUDIT_EXPORT#")) {
        lost = false;
        throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
      }
      return out;
    } } as never;
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    expect(metaOf2(b, exportId)).toMatchObject({ status: "ready" });
    expect(b.exportsBucket.objects.has(fileKey(b, A, exportId))).toBe(true);
    expect(b.exportsBucket.calls.map((call) => call.command)).toStrictEqual(["PutObject"]);
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("already_ready");
    await expect(exportDownloadUrl(b.deps, A, exportId)).resolves.toMatchObject({ expiresInSeconds: 900 });
    expect(gunzipped(b, A, exportId).orgId).toBe(A);
  });

  it("two runs at once each write a file of their own, the first to commit wins, and the loser deletes only its own file", async () => {
    const b = await world();
    const exportId = await started(b, "twice");
    const winnerKey = `${A}/${exportId}.aaaaaaaaaaaaaaaa.rovara-audit.json.gz`;
    // Between this run's build and its commit, another run commits the same export with its own file.
    b.exportsBucket.beforePut = async () => {
      b.exportsBucket.beforePut = undefined;
      b.exportsBucket.objects.set(winnerKey, Buffer.from("the winner's file"));
      b.h.db.set({ ...metaOf2(b, exportId), status: "ready", objectKey: winnerKey, summary: { bytes: 17 }, expiresAt: iso(b.h.clock.now + 6 * 86_400_000) });
    };
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("already_ready");
    expect(b.exportsBucket.objects.get(winnerKey)!.toString()).toBe("the winner's file");
    expect([...b.exportsBucket.objects.keys()]).toStrictEqual([winnerKey]);
    const calls = b.exportsBucket.calls;
    expect(calls.map((call) => call.command)).toStrictEqual(["PutObject", "DeleteObject"]);
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[0]!.key).not.toBe(winnerKey);
    // The download is of the file the record names.
    expect((await exportDownloadUrl(b.deps, A, exportId)).url).toContain(winnerKey);
  });

  it("never deletes a file it did not write: an earlier attempt's leftover stays where it is, and this run uses its own key", async () => {
    const b = await world();
    const exportId = await started(b, "leftover");
    const leftover = `${A}/${exportId}.bbbbbbbbbbbbbbbb.rovara-audit.json.gz`;
    b.exportsBucket.objects.set(leftover, Buffer.from("half a file"));
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    expect(b.exportsBucket.calls.map((call) => call.command)).toStrictEqual(["PutObject"]);
    expect(b.exportsBucket.objects.get(leftover)!.toString()).toBe("half a file");
    expect(fileKey(b, A, exportId)).not.toBe(leftover);
    expect(gunzipped(b, A, exportId).orgId).toBe(A);
    expect((metaOf2(b, exportId).summary as { bytes: number }).bytes).toBe(b.exportsBucket.objects.get(fileKey(b, A, exportId))!.length);
  });

  it("retries a put that S3 answers with 409 ConditionalRequestConflict, and leaves the export running when it keeps doing so", async () => {
    const conflict = () => Object.assign(new Error("conflicting conditional operation"), { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } });
    const b = await world();
    const exportId = await started(b, "conflict");
    let refusals = 2;
    b.exportsBucket.beforePut = () => { if (refusals > 0) { refusals -= 1; throw conflict(); } };
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    expect(b.exportsBucket.calls.map((call) => call.command)).toStrictEqual(["PutObject", "PutObject", "PutObject"]);
    // Past the retries it throws, so the platform retries the invoke; the export stays running and nothing is left.
    const c = await world();
    const second = await started(c, "conflict2");
    c.exportsBucket.beforePut = () => { throw conflict(); };
    await expect(runAuditExport(c.deps, { orgId: A, exportId: second })).rejects.toMatchObject({ name: "ConditionalRequestConflict" });
    expect(metaOf2(c, second)).toMatchObject({ status: "running" });
    expect(c.exportsBucket.objects.size).toBe(0);
    expect(c.exportsBucket.calls.every((call) => call.command === "PutObject")).toBe(true);
  });

  it("an export that was failed while this run built it is reported failed, and this run's file does not stay behind", async () => {
    const b = await world();
    const exportId = await started(b, "failedmeanwhile");
    b.exportsBucket.beforePut = async () => {
      b.exportsBucket.beforePut = undefined;
      b.h.db.set({ ...metaOf2(b, exportId), status: "failed", failure: { code: "TIMED_OUT" } });
    };
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("already_failed");
    expect(b.exportsBucket.objects.size).toBe(0);
    expect(b.exportsBucket.calls.map((call) => call.command)).toStrictEqual(["PutObject", "DeleteObject"]);
    expect(metaOf2(b, exportId)).toMatchObject({ status: "failed" });
    expect(pendingItems(b)).toStrictEqual([]);
  });
});

const metaOf2b = (b: Bench, exportId: string) => b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")!;

describe("exportDownloadUrl", () => {
  it("presigns the export's file for 900 seconds, for a ready export of this org only", async () => {
    const b = await world();
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "d", fromSeq: 1, toSeq: 4 });
    await expect(exportDownloadUrl(b.deps, A, exportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await runAuditExport(b.deps, { orgId: A, exportId });
    expect(AUDIT_EXPORT_URL_SECONDS).toBe(900);
    expect(await exportDownloadUrl(b.deps, A, exportId)).toStrictEqual({ url: `https://signed.test/${EXPORTS_BUCKET}/${fileKey(b, A, exportId)}?expires=900`, expiresInSeconds: 900 });
    await expect(exportDownloadUrl(b.deps, B, exportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(exportDownloadUrl(b.deps, A, "aex_../../x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a ready export is available for 6 days (a day less than the bucket keeps its files), then it is expired: the view says so and no link is made", async () => {
    const b = await world();
    expect(AUDIT_EXPORT_AVAILABLE_DAYS).toBe(AUDIT_EXPORT_FILE_LIFECYCLE_DAYS - 1);
    expect(AUDIT_EXPORT_AVAILABLE_DAYS).toBe(6);
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "expiry", fromSeq: 1, toSeq: 4 });
    await runAuditExport(b.deps, { orgId: A, exportId });
    const meta = metaOf2b(b, exportId);
    const completed = Date.parse(String(meta.completedAt));
    expect(meta.expiresAt).toBe(new Date(completed + 6 * 86_400_000).toISOString());
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "ready", expiresAt: meta.expiresAt });
    b.h.clock.now = completed + 6 * 86_400_000 - 1;
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "ready" });
    await expect(exportDownloadUrl(b.deps, A, exportId)).resolves.toMatchObject({ expiresInSeconds: 900 });
    let signed = 0;
    b.deps.presign = async (input) => { signed += 1; return { url: input.key, expiresInSeconds: 1 }; };
    b.h.clock.now = completed + 6 * 86_400_000;
    expect(await getAuditExport(b.deps, A, exportId)).toMatchObject({ status: "expired", expiresAt: meta.expiresAt, summary: expect.anything() as unknown });
    await expect(exportDownloadUrl(b.deps, A, exportId)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: expect.stringMatching(/expired.*again/i) as unknown });
    expect(signed).toBe(0);
    // The stored record is not changed by being looked at, and a record with no expiry is never signed.
    expect(metaOf2b(b, exportId)).toMatchObject({ status: "ready" });
    b.h.clock.now = completed;
    const { expiresAt: _gone, ...without } = metaOf2b(b, exportId);
    void _gone;
    b.h.db.set(without);
    await expect(exportDownloadUrl(b.deps, A, exportId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("signs the file the record names, and only when that key is under this org's export prefix", async () => {
    const b = await world();
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "prefix", fromSeq: 1, toSeq: 4 });
    await runAuditExport(b.deps, { orgId: A, exportId });
    const meta = b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")!;
    let signed = 0;
    b.deps.presign = async (input) => { signed += 1; return { url: `https://signed.test/${input.key}`, expiresInSeconds: input.expiresInSeconds }; };
    const sound = `${A}/${exportId}.0123456789abcdef.rovara-audit.json.gz`;
    const bads = [
      `${B}/${exportId}.0123456789abcdef.rovara-audit.json.gz`, `${A}/aex_other.0123456789abcdef.rovara-audit.json.gz`, `${A}/${exportId}/../x`, "", undefined,
      // Anything but exactly <org>/<export>.<16 lowercase hex>.rovara-audit.json.gz is refused, however close.
      `${A}/${exportId}.x/y.rovara-audit.json.gz`, `${A}/${exportId}.0123456789ABCDEF.rovara-audit.json.gz`, `${A}/${exportId}.0123456789abcde.rovara-audit.json.gz`,
      `${A}/${exportId}.0123456789abcdef0.rovara-audit.json.gz`, `${sound}.bak`, `${sound}\n`, ` ${sound}`, `${A}/${exportId}.rovara-audit.json.gz`, `${A}//${exportId}.0123456789abcdef.rovara-audit.json.gz`,
    ];
    for (const bad of bads) {
      b.h.db.set({ ...meta, objectKey: bad });
      await expect(exportDownloadUrl(b.deps, A, exportId), String(bad)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(signed).toBe(0);
    b.h.db.set(meta);
    expect((await exportDownloadUrl(b.deps, A, exportId)).url).toBe(`https://signed.test/${String(meta.objectKey)}`);
  });
});

describe("the broker's wiring: the download link and the start of an export", () => {
  const credentials = (expiration?: Date) => ({ accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", sessionToken: "token", ...(expiration === undefined ? {} : { expiration }) });
  const clientWith = (expiration?: Date) => new S3Client({ region: "us-east-1", credentials: credentials(expiration) });
  const NOW = Date.parse("2026-10-20T12:00:00Z");

  it("signs the export's object with the SDK's presigner for the lifetime asked, and says what it signed", async () => {
    const sign = exportLinkSigner(clientWith(), () => NOW);
    const link = await sign({ bucket: EXPORTS_BUCKET, key: `${A}/aex_1.rovara-audit.json.gz`, expiresInSeconds: AUDIT_EXPORT_URL_SECONDS });
    const parsed = new URL(link.url);
    expect(parsed.hostname).toBe(`${EXPORTS_BUCKET}.s3.us-east-1.amazonaws.com`);
    expect(parsed.pathname).toBe(`/${A}/aex_1.rovara-audit.json.gz`);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(link.expiresInSeconds).toBe(900);
  });

  it("never lets a link outlive the credentials that sign it: the lifetime is cut to what they have left, and the answer says so", async () => {
    const sign = exportLinkSigner(clientWith(new Date(NOW + 300_000)), () => NOW);
    const link = await sign({ bucket: EXPORTS_BUCKET, key: "k", expiresInSeconds: 900 });
    expect(link.expiresInSeconds).toBe(300);
    expect(new URL(link.url).searchParams.get("X-Amz-Expires")).toBe("300");
    // Credentials with more than the link asks for leave it alone; credentials that are over refuse to sign.
    expect((await exportLinkSigner(clientWith(new Date(NOW + 3_600_000)), () => NOW)({ bucket: EXPORTS_BUCKET, key: "k", expiresInSeconds: 900 })).expiresInSeconds).toBe(900);
    for (const left of [-1000, 0, 1000, 59_000]) {
      await expect(exportLinkSigner(clientWith(new Date(NOW + left)), () => NOW)({ bucket: EXPORTS_BUCKET, key: "k", expiresInSeconds: 900 }), String(left)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503 });
    }
    // A link needs a minute of life: exactly a minute is signed.
    expect((await exportLinkSigner(clientWith(new Date(NOW + 60_000)), () => NOW)({ bucket: EXPORTS_BUCKET, key: "k", expiresInSeconds: 900 })).expiresInSeconds).toBe(60);
    // An expiration that is not a date is no reason to hand out a link either.
    await expect(exportLinkSigner(clientWith(new Date(Number.NaN)), () => NOW)({ bucket: EXPORTS_BUCKET, key: "k", expiresInSeconds: 900 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503 });
  });

  it("downloads report the lifetime the link really has", async () => {
    const b = await world();
    b.deps.presign = exportLinkSigner(clientWith(new Date(b.h.clock.now + 120_000)), () => b.h.clock.now);
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "link", fromSeq: 1, toSeq: 4 });
    await runAuditExport(b.deps, { orgId: A, exportId });
    const link = await exportDownloadUrl(b.deps, A, exportId);
    expect(link.expiresInSeconds).toBe(120);
    expect(new URL(link.url).searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("starts an export by an asynchronous invoke of the export function, with the event as the payload, and insists on the 202", async () => {
    const sent: Array<{ input: Record<string, unknown> }> = [];
    let status = 202;
    const lambda = { send: async (command: unknown) => { sent.push(command as { input: Record<string, unknown> }); return { StatusCode: status }; } };
    const invoke = exportInvoker(lambda as never, "agentx-acme-AuditExport");
    const event = { source: AUDIT_EXPORT_SOURCE, orgId: A, exportId: "aex_1" } as const;
    await invoke(event);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(InvokeCommand);
    expect(sent[0]!.input).toMatchObject({ FunctionName: "agentx-acme-AuditExport", InvocationType: "Event" });
    expect(JSON.parse(Buffer.from(sent[0]!.input.Payload as Uint8Array).toString("utf8"))).toStrictEqual(event);
    status = 200;
    await expect(invoke(event)).rejects.toThrow(/answered 200/);
  });

  it("is what a failed start marks as failed: a start the platform refuses leaves a failed export", async () => {
    const b = await world();
    b.deps.invokeExport = exportInvoker({ send: async () => ({ StatusCode: 500 }) } as never, "fn");
    expect(await startAuditExport(b.deps, requester(), { requestId: "refused", fromSeq: 1, toSeq: 4 })).toMatchObject({ status: "failed" });
  });
});

/** Raw records for scale tests: no hashes, no seals; the reader only needs the stored shape. */
function seedRaw(b: Bench, orgId: string, count: number, action = (seq: number) => (seq % 100 === 0 ? "member.joined" : "pull_request.opened")): void {
  for (let seq = 1; seq <= count; seq += 1) {
    b.h.db.set({ pk: `AUDIT#${orgId}`, sk: `SEQ#${pad12(seq)}`, v: 1, orgId, seq, action: action(seq), actor: { kind: "member", id: seq % 2 === 0 ? "dev_2" : "dev_1" }, recordedAt: iso(Date.parse("2026-10-20T00:00:00Z") + seq * 1000), details: [] });
  }
  b.h.db.set({ pk: `AUDIT#${orgId}`, sk: "HEAD", seq: count, hash: "0".repeat(64), updatedAt: iso(at(0)) });
}

describe("readAuditRecords", () => {
  it("returns a page of records with their details opened, and the sealed-through seq, the lock mode and the open epochs", async () => {
    const b = await world();
    const page = await readAuditRecords(b.readDeps, A, { limit: 2 });
    expect(page.records.map((entry) => entry.record.seq)).toStrictEqual([1, 2]);
    const salt = expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string;
    expect(page.records[0]!.details).toStrictEqual([
      { subject: "org", salt, fields: { repository: "acme/widgets" } },
      { subject: "dev_1", salt, fields: { name: PLAINTEXT, email: "alice@example.test" } },
      { subject: "dev_2", salt, fields: { name: "Bob Example" } },
    ]);
    expect(page).toMatchObject({ headSeq: 12, sealedThroughSeq: 10, lockMode: "COMPLIANCE", epochsWithoutTimestamp: [E0, E1] });
    expect(page.latestTimestamp).toBeUndefined();
    expect(JSON.stringify(page.records[0]!.record)).not.toContain(PLAINTEXT);
  });

  it("pages with a cursor that holds only a sequence number, and ends without one", async () => {
    const b = await world();
    const first = await readAuditRecords(b.readDeps, A, { limit: 5 });
    expect(decodeAuditCursor(first.nextCursor!)).toBe(5);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"))).toStrictEqual({ seq: 5 });
    const second = await readAuditRecords(b.readDeps, A, { limit: 5, cursor: first.nextCursor! });
    expect(second.records.map((entry) => entry.record.seq)).toStrictEqual([6, 7, 8, 9, 10]);
    const third = await readAuditRecords(b.readDeps, A, { limit: 5, cursor: second.nextCursor! });
    expect(third.records.map((entry) => entry.record.seq)).toStrictEqual([11, 12]);
    expect(third.nextCursor).toBeUndefined();
    const exact = await readAuditRecords(b.readDeps, A, { limit: 12 });
    expect(exact.records).toHaveLength(12);
    expect(exact.nextCursor).toBeUndefined();
  });

  it("an org's cursor, range or filter shows another org only that org's own records", async () => {
    const b = await world();
    const cursorOfA = (await readAuditRecords(b.readDeps, A, { limit: 2 })).nextCursor!;
    const asB = await readAuditRecords(b.readDeps, B, { cursor: cursorOfA, fromSeq: 1, toSeq: 50, limit: 200 });
    expect(asB.records.map((entry) => [entry.record.orgId, entry.record.seq])).toStrictEqual([[B, 3]]);
    expect(asB.headSeq).toBe(3);
    // No call read org A's partition on B's behalf.
    expect(b.h.operations.filter((operation) => operation.pk === `AUDIT#${A}`).length).toBeGreaterThan(0);
    b.h.operations.length = 0;
    await readAuditRecords(b.readDeps, B, { cursor: cursorOfA });
    expect(b.h.operations.filter((operation) => operation.pk.includes(A))).toStrictEqual([]);
    await expect(readAuditRecords(b.readDeps, "org_not-an-org", {})).rejects.toThrow(/organization id/);
  });

  it("locates a time range by binary search over recordedAt", async () => {
    const b = bench();
    seedRaw(b, C, 4000);
    b.h.operations.length = 0;
    const from = iso(Date.parse("2026-10-20T00:00:00Z") + 1500 * 1000);
    const to = iso(Date.parse("2026-10-20T00:00:00Z") + 1502 * 1000);
    const page = await readAuditRecords(b.readDeps, C, { from, to });
    expect(page.records.map((entry) => entry.record.seq)).toStrictEqual([1500, 1501, 1502]);
    const probes = b.h.operations.filter((operation) => operation.action === "GetItem" && operation.pk === `AUDIT#${C}`).length;
    // Two searches of log2(4000) ~ 12 probes each, plus the head and the like: nowhere near a scan.
    expect(probes).toBeLessThan(40);
    expect(b.h.operations.filter((operation) => operation.action === "Query" && operation.pk === `AUDIT#${C}`).length).toBeLessThan(5);
    // A range with no record in it, one before the start and one after the end.
    expect((await readAuditRecords(b.readDeps, C, { from: iso(Date.parse("2026-10-20T00:00:00Z") + 1500_500), to: iso(Date.parse("2026-10-20T00:00:00Z") + 1500_900) })).records).toStrictEqual([]);
    expect((await readAuditRecords(b.readDeps, C, { to: "2020-01-01T00:00:00Z" })).records).toStrictEqual([]);
    expect((await readAuditRecords(b.readDeps, C, { from: "2030-01-01T00:00:00Z" })).records).toStrictEqual([]);
    // Combined with a sequence range, the two intersect.
    expect((await readAuditRecords(b.readDeps, C, { from, fromSeq: 1501, toSeq: 1600, limit: 2 })).records.map((entry) => entry.record.seq)).toStrictEqual([1501, 1502]);
  });

  it("filters by action and by actor", async () => {
    const b = bench();
    seedRaw(b, C, 450);
    const joined = await readAuditRecords(b.readDeps, C, { action: "member.joined", limit: 10 });
    expect(joined.records.map((entry) => entry.record.seq)).toStrictEqual([100, 200, 300, 400]);
    expect(joined.nextCursor).toBeUndefined();
    const dev2 = await readAuditRecords(b.readDeps, C, { actorId: "dev_2", action: "member.joined", limit: 10 });
    expect(dev2.records.map((entry) => entry.record.seq)).toStrictEqual([100, 200, 300, 400]);
    const dev1 = await readAuditRecords(b.readDeps, C, { actorId: "dev_1", limit: 3 });
    expect(dev1.records.map((entry) => entry.record.seq)).toStrictEqual([1, 3, 5]);
    const next = await readAuditRecords(b.readDeps, C, { actorId: "dev_1", limit: 3, cursor: dev1.nextCursor! });
    expect(next.records.map((entry) => entry.record.seq)).toStrictEqual([7, 9, 11]);
  });

  it("refuses a filter over more than 20,000 records with AUDIT_FILTER_TOO_WIDE, and allows exactly 20,000", async () => {
    const b = bench();
    seedRaw(b, C, AUDIT_FILTER_SCAN_MAX + 1);
    for (const filter of [{ action: "member.joined" }, { actorId: "dev_1" }]) {
      await expect(readAuditRecords(b.readDeps, C, filter)).rejects.toMatchObject({ code: "AUDIT_FILTER_TOO_WIDE", statusCode: 400 });
    }
    // The same on a later page, where the cursor leaves fewer to read.
    await expect(readAuditRecords(b.readDeps, C, { action: "member.joined", cursor: Buffer.from(JSON.stringify({ seq: 15000 })).toString("base64url") })).rejects.toMatchObject({ code: "AUDIT_FILTER_TOO_WIDE" });
    const exactly = await readAuditRecords(b.readDeps, C, { action: "member.joined", fromSeq: 2, toSeq: AUDIT_FILTER_SCAN_MAX + 1, limit: 200 });
    expect(exactly.records).toHaveLength(200);
    // Without a filter any range reads.
    expect((await readAuditRecords(b.readDeps, C, { limit: 3 })).records).toHaveLength(3);
    // A time range narrows it under the limit.
    const narrow = await readAuditRecords(b.readDeps, C, { action: "member.joined", from: iso(Date.parse("2026-10-20T00:00:00Z") + 100_000), to: iso(Date.parse("2026-10-20T00:00:00Z") + 500_000) });
    expect(narrow.records.map((entry) => entry.record.seq)).toStrictEqual([100, 200, 300, 400, 500]);
  });

  it("returns at most 200 records a page whatever limit is asked for, and refuses a range or cursor it cannot read", async () => {
    const b = bench();
    seedRaw(b, C, 250);
    expect((await readAuditRecords(b.readDeps, C, { limit: 5000 })).records).toHaveLength(200);
    expect((await readAuditRecords(b.readDeps, C, {})).records).toHaveLength(50);
    for (const query of [{ limit: 0 }, { limit: 1.5 }, { fromSeq: 5, toSeq: 2 }, { fromSeq: 0 }, { from: "2026-10-21T00:00:00Z", to: "2026-10-20T00:00:00Z" }, { from: "yesterday" }, { cursor: "not a cursor" }, { cursor: Buffer.from(JSON.stringify({ seq: -1 })).toString("base64url") }, { action: "" }]) {
      await expect(readAuditRecords(b.readDeps, C, query), JSON.stringify(query)).rejects.toMatchObject(RANGE_INVALID);
    }
  });

  it("reads an org with no records, and reports nothing sealed", async () => {
    const b = bench();
    expect(await readAuditRecords(b.readDeps, C, {})).toStrictEqual({ records: [], headSeq: 0, sealedThroughSeq: 0, epochsWithoutTimestamp: [] });
  });
});

describe("timestamps in what the reader and the export report", () => {
  interface TsaWorld { b: Bench; digicert: FakeTsaHost; sectigo: FakeTsaHost }

  async function tsaWorld(): Promise<TsaWorld> {
    let digicert!: FakeTsaHost;
    let sectigo!: FakeTsaHost;
    const b = bench({
      tsa: (h) => {
        digicert = fakeTsaHost({ url: AUDIT_TSA_ENDPOINTS.digicert, pki: makePki("DigiCert"), now: () => h.clock.now, behavior: "grant" });
        sectigo = fakeTsaHost({ url: AUDIT_TSA_ENDPOINTS.sectigo, pki: makePki("Sectigo"), now: () => h.clock.now, behavior: "grant" });
        const settings: TsaSettings = {
          kind: "public", timeoutMs: 2000, spacingMs: AUDIT_TSA_SPACING_MS,
          targets: [
            { label: "digicert", url: AUDIT_TSA_ENDPOINTS.digicert, anchors: [digicert.pki.root.x509] },
            { label: "sectigo", url: AUDIT_TSA_ENDPOINTS.sectigo, anchors: [sectigo.pki.root.x509] },
          ],
        };
        h.deps.tsa = { settings, fetch: routeFetch(digicert.handler, sectigo.handler), sleep: async (ms: number) => { h.clock.now += ms; }, clock: () => h.clock.now };
      },
    });
    b.deps.anchors = { digicert: [digicert.pki.root.x509], sectigo: [sectigo.pki.root.x509] };
    return { b, digicert, sectigo };
  }

  it("an epoch that no authority answered is covered by a later one, and the export, the verifier and the reader all say so", async () => {
    const { b, digicert, sectigo } = await tsaWorld();
    digicert.behavior = "http-500";
    sectigo.behavior = "http-500";
    b.h.clock.now = at(0) - 60_000;
    await b.append(A, 3);
    await b.seal(0);
    b.h.clock.now = at(1) - 60_000;
    await b.append(A, 2);
    await b.seal(1);
    expect([E0, E1].map((id) => metaOf(b.h, id)?.status)).toStrictEqual(["stamp_pending", "stamp_pending"]);
    // The reader says the epochs have no time yet.
    expect(await readAuditStatus(b.readDeps, A)).toMatchObject({ sealedThroughSeq: 5, epochsWithoutTimestamp: [E0, E1] });
    expect((await readAuditStatus(b.readDeps, A)).latestTimestamp).toBeUndefined();

    digicert.behavior = "grant";
    sectigo.behavior = "grant";
    b.h.clock.now = at(2) - 60_000;
    await b.append(A, 2);
    await b.seal(2);
    // This run stamps the newest waiting epoch (E1) and its own (E2); E1 covers E0.
    expect(metaOf(b.h, E0)).toMatchObject({ status: "sealed", covered_by: E1 });

    const bundle = await buildAuditBundle(b.deps, A, { fromSeq: 1, toSeq: 7, withDetails: false });
    expect(bundle.seals.map((entry) => entry.timestamps.map((stamp) => stamp.tsa))).toStrictEqual([[], ["digicert", "sectigo"], ["digicert", "sectigo"]]);
    expect(bundle.seals[0]!.coveredBy!.epochs.map((epoch) => epoch.epochId)).toStrictEqual([E1]);
    expect(bundle.seals[0]!.coveredBy!.timestamps.map((stamp) => stamp.tsa)).toStrictEqual(["digicert", "sectigo"]);
    const report = verifyBundle(bundle, { anchors: b.deps.anchors });
    expect(report.checks.filter((check) => !check.ok), JSON.stringify(report.checks)).toStrictEqual([]);
    expect(report).toMatchObject({ ok: true, coveredEpochs: [E0], epochsWithoutTimestamp: [] });
    expect(report.timestampedThrough).toBeDefined();

    // The same through the export: both fields are in what it stores.
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "tsa", fromSeq: 1, toSeq: 7 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    const summary = (await getAuditExport(b.deps, A, exportId))!.summary!;
    expect(summary).toMatchObject({ coveredEpochs: [E0], epochsWithoutTimestamp: [], unverifiedAuthorities: [] });
    expect(summary.timestampedThrough).toBe(report.timestampedThrough);

    const status = await readAuditStatus(b.readDeps, A);
    expect(status).toMatchObject({ epochsWithoutTimestamp: [], lockMode: "COMPLIANCE" });
    expect(status.latestTimestamp).toBe(report.timestampedThrough);
  });

  it("an epoch with no time of its own and no covering one is reported, beside a timestampedThrough for the rest, and is not a failure", async () => {
    const { b, digicert, sectigo } = await tsaWorld();
    b.h.clock.now = at(0) - 60_000;
    await b.append(A, 3);
    await b.seal(0);
    digicert.behavior = "http-500";
    sectigo.behavior = "http-500";
    b.h.clock.now = at(1) - 60_000;
    await b.append(A, 2);
    await b.seal(1);
    expect(metaOf(b.h, E1)).toMatchObject({ status: "stamp_pending" });

    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "tsa2", fromSeq: 1, toSeq: 5 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    const summary = (await getAuditExport(b.deps, A, exportId))!.summary!;
    expect(summary.epochsWithoutTimestamp).toStrictEqual([E1]);
    expect(summary.timestampedThrough).toBeDefined();
    expect(summary.coveredEpochs).toStrictEqual([]);
    const status = await readAuditStatus(b.readDeps, A);
    expect(status.epochsWithoutTimestamp).toStrictEqual([E1]);
    expect(status.latestTimestamp).toBe(summary.timestampedThrough);
  });

  it("tokens of an authority the broker holds no roots for are reported as unverified, not as a failure", async () => {
    const { b } = await tsaWorld();
    b.h.clock.now = at(0) - 60_000;
    await b.append(A, 3);
    await b.seal(0);
    b.deps.anchors = {};
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "tsa3", fromSeq: 1, toSeq: 3 });
    expect(await runAuditExport(b.deps, { orgId: A, exportId })).toBe("ready");
    expect((await getAuditExport(b.deps, A, exportId))!.summary!.unverifiedAuthorities).toStrictEqual(["digicert", "sectigo"]);
  });
});

describe("the export function's handler", () => {
  it("builds an export when it is invoked with the export event, throws a failure that a retry may cure, and ignores any other event", async () => {
    const b = await world();
    const { exportId } = await startAuditExport(b.deps, requester(), { requestId: "handler", fromSeq: 1, toSeq: 12 });
    const event = { source: AUDIT_EXPORT_SOURCE, orgId: A, exportId } as const;

    // A commit that fails is thrown, so the platform retries the invoke.
    b.h.hooks.before = (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("AUDIT_EXPORT#")) throw Object.assign(new Error("the process died"), { name: "ProcessDied" });
    };
    await expect(handleAuditExportEvent(b.deps, event)).rejects.toMatchObject({ name: "ProcessDied" });
    expect(b.logs.filter((entry) => entry.event === "audit.export_failed")).toMatchObject([{ orgId: A, exportId, error: "ProcessDied" }]);
    b.h.hooks.before = undefined;
    expect(await handleAuditExportEvent(b.deps, event)).toStrictEqual({ outcome: "ready" });
    expect(b.h.db.get(`ORG#${A}#AUDIT_EXPORT#${exportId}`, "META")).toMatchObject({ status: "ready" });

    // Nothing but an export event runs an export.
    for (const other of [{ source: "agentx.audit-drain" }, { source: AUDIT_EXPORT_SOURCE }, { orgId: A, exportId }]) {
      expect(await handleAuditExportEvent(b.deps, other)).toStrictEqual({ status: "ignored" });
    }
  });
});
