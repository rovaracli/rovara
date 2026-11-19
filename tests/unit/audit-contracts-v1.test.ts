import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recordHash, detailCommit, canonicalJson, genesisHash, statementHash } from "../../packages/audit-verifier/src/index.js";
import { auditCanonicalV1, auditDetailCommitmentV1, auditGenesisHashV1, auditRecordDigestV1 } from "../../packages/contracts/src/audit-record-v1.js";
import {
  mapCodeAuditV1, mapCloudAuditV1, materializeAuditRecordV1, pendingAuditV1,
  PendingAuditV1Schema, ReceiptAuditV1Schema, receiptMatchesPendingV1,
  SealProgressV1Schema, EpochProgressV1Schema, VerifyJobV1Schema,
  newVerifyJobV1, authorizeVerifyJobV1, AuditDeploymentV1Schema, pendingKeyV1, receiptKeyV1,
  VerifyInvocationV1Schema, verifyJobKeyV1, sealProgressKeyV1, epochProgressKeyV1,
} from "../../packages/cloud-server/src/audit-contracts-v1.js";

const time = "2026-11-19T00:00:00.000Z";
const later = "2026-11-19T00:01:00.000Z";
const hex = "a".repeat(64);
const context = { installId: "install_1", salt: new Uint8Array(32).fill(7) };
const code = { eventId: "event#é", companyId: "org_1", at: time, actor: { type: "person" as const, id: "person-secret" }, action: "task.approved", subject: { type: "task", id: "private-task" }, details: { email: "erase@example.test", cost: 0.5 } };
const cloud = { id: "aud_00000000000000000000", companyId: "org_1", at: time, actor: { type: "agent" as const, developerId: "private-agent", name: "Personal Name" }, action: "company.budget.changed" as const, subject: "project:private-project", project: "private-project", outcome: "ok" as const, via: "web", detail: "fixed-code" };
const mapped = () => mapCodeAuditV1(code, context);
const pending = () => pendingAuditV1(mapped(), time);
const receipt = () => ({ v: 1 as const, kind: "receipt" as const, source: mapped().source, factsDigest: mapped().factsDigest, seq: 1, recordHash: hex, committedAt: later });
const checkpoint = { fromSeq: 1, toSeq: 10, headHash: hex, prevSealHash: hex, epochId: "e20261119T0000Z" };
const object = { key: `audit/batch/${hex}`, versionId: "version-1", sha256: hex, writtenAt: time, lockMode: "COMPLIANCE" as const, retainUntil: "2027-11-19T00:00:00.000Z" };

describe("private hosted audit contracts", () => {
  it("maps each source kind to pinned commitment-only v1 vectors and preserves the existing verifier format", () => {
    const golden = JSON.parse(readFileSync(new URL("../fixtures/audit-source-v1-golden.json", import.meta.url), "utf8")) as { code: unknown; cloud: unknown };
    expect(mapCodeAuditV1(code, context)).toEqual(golden.code);
    expect(mapCloudAuditV1(cloud, context)).toEqual(golden.cloud);
    const record = materializeAuditRecordV1(mapped(), { seq: 1, recordedAt: later, prevHash: auditGenesisHashV1("org_1") });
    expect(recordHash(record)).toBe(record.hash);
    expect(auditRecordDigestV1(record)).toBe(record.hash);
    expect(genesisHash("org_1")).toBe(auditGenesisHashV1("org_1"));
    expect(canonicalJson(record)).toBe(auditCanonicalV1(record));
    expect(detailCommit(context.salt, "source", { text: "erasable" })).toBe(auditDetailCommitmentV1(context.salt, "source", { text: "erasable" }));
    const locked = JSON.stringify(record);
    for (const secret of ["person-secret", "private-task", "erase@example.test", "event#é"]) expect(locked).not.toContain(secret);
    const cloudLocked = JSON.stringify(mapCloudAuditV1(cloud, context));
    for (const secret of ["Personal Name", "private-agent", "private-project", "fixed-code"]) expect(cloudLocked).not.toContain(secret);
  });

  it("represents absent targets explicitly and maps differing actor shapes without identifiers", () => {
    const withoutTarget = { ...code, subject: undefined };
    expect(mapCodeAuditV1(withoutTarget, context).event.target).toEqual({ kind: "none", id: "none" });
    expect(mapCloudAuditV1({ ...cloud, subject: "" }, context).event.target).toEqual({ kind: "none", id: "none" });
    for (const type of ["person", "agent", "system"] as const) {
      expect(mapCodeAuditV1({ ...code, actor: { type, id: "private" } }, context).event.actor.kind).toBe(type);
      expect(mapCloudAuditV1({ ...cloud, actor: { type, developerId: "private", name: "Private" } }, context).event.actor.kind).toBe(type);
    }
  });

  it("binds all original facts and source identity, keeping a deterministic captured retry", () => {
    const original = mapped();
    expect(mapped()).toEqual(original);
    for (const event of [ { ...code, at: later }, { ...code, action: "task.refused" }, { ...code, details: { email: "different" } }, { ...code, actor: { ...code.actor, id: "changed" } }, { ...code, subject: undefined } ]) {
      expect(mapCodeAuditV1(event, context).factsDigest).not.toBe(original.factsDigest);
    }
    expect(mapCodeAuditV1(code, { ...context, installId: "install_2" }).source.eventId).not.toBe(original.source.eventId);
    expect(mapCodeAuditV1(code, { ...context, salt: new Uint8Array(32).fill(8) }).factsDigest).not.toBe(original.factsDigest);
    expect(mapCloudAuditV1({ ...cloud, actor: { ...cloud.actor, name: "Changed" } }, context).factsDigest).not.toBe(mapCloudAuditV1(cloud, context).factsDigest);
    expect(() => mapCodeAuditV1({ ...code, unexpected: "private" }, context)).toThrow();
    expect(() => mapCloudAuditV1({ ...cloud, action: "unknown.action" }, context)).toThrow();
  });

  it("retains pending without TTL and acknowledges only a matching committed receipt", () => {
    const item = pending();
    expect(PendingAuditV1Schema.parse(item)).toEqual(item);
    expect(ReceiptAuditV1Schema.parse(receipt())).toEqual(receipt());
    expect(receiptMatchesPendingV1(item, receipt())).toBe(true);
    for (const changed of [{ ...receipt(), factsDigest: "b".repeat(64) }, { ...receipt(), source: { ...receipt().source, installId: "other" } }, { ...receipt(), source: { ...receipt().source, companyId: "other" } }, { ...receipt(), source: { ...receipt().source, sourceKind: "cloud" } }, { ...receipt(), source: { ...receipt().source, eventId: "b".repeat(64) } }]) expect(receiptMatchesPendingV1(item, changed)).toBe(false);
    for (const key of ["ttl", "expiresAt", "salt", "replay", "originalSource"]) expect(PendingAuditV1Schema.safeParse({ ...item, [key]: 1 }).success).toBe(false);
    expect(PendingAuditV1Schema.safeParse({ ...item, factsDigest: "b".repeat(64) }).success).toBe(false);
    expect(PendingAuditV1Schema.safeParse({ ...item, source: { ...item.source, companyId: "other" } }).success).toBe(false);
    expect(ReceiptAuditV1Schema.safeParse({ ...receipt(), seq: 0 }).success).toBe(false);
    expect(pendingKeyV1(item.source)).toEqual({ pk: "AUDIT_PENDING#05", sk: item.event.eventId });
    expect(receiptKeyV1(item.source)).toEqual({ pk: "RECEIPT#install_1#org_1", sk: item.event.eventId });
  });

  it("parses restart progress with fixed checkpoints and exact version references", () => {
    const base = { v: 1, kind: "seal-progress", companyId: "org_1", checkpoint, batchRoot: hex, updatedAt: time };
    expect(SealProgressV1Schema.safeParse({ ...base, phase: "planned" }).success).toBe(true);
    expect(SealProgressV1Schema.safeParse({ ...base, phase: "locked", batch: object, seal: object }).success).toBe(true);
    for (const changed of [ { ...base, phase: "locked" }, { ...base, phase: "planned", checkpoint: { ...checkpoint, toSeq: 0 } }, { ...base, phase: "locked", batch: { ...object, versionId: "" }, seal: object }, { ...base, phase: "locked", batch: { ...object, retainUntil: "2026-12-19T00:00:00.000Z" }, seal: object } ]) expect(SealProgressV1Schema.safeParse(changed).success).toBe(false);
    const epoch = { v: 1, kind: "epoch-progress", epochId: checkpoint.epochId, statementHash: statementHash({ v: 1, epochId: checkpoint.epochId, closedAt: time, prevEpochId: null, prevStatementHash: null, sealsRoot: hex, sealCount: 1 }), prevEpochId: null, prevStatementHash: null, sealsRoot: hex, sealCount: 1, closedAt: time, updatedAt: time };
    expect(EpochProgressV1Schema.safeParse({ ...epoch, phase: "planned" }).success).toBe(true);
    expect(EpochProgressV1Schema.safeParse({ ...epoch, phase: "waiting-timestamp", statement: object, tsaProvider: "freetsa" }).success).toBe(true);
    expect(EpochProgressV1Schema.safeParse({ ...epoch, phase: "timestamped", statement: object, tsaProvider: "freetsa", token: object }).success).toBe(true);
    expect(EpochProgressV1Schema.safeParse({ ...epoch, phase: "timestamped", statement: object, tsaProvider: "freetsa" }).success).toBe(false);
  });

  it("binds verify jobs to current owner/admin and company, with bounded evidence and no false pass", () => {
    const auth = { companyId: "org_1", role: "owner" };
    const job = newVerifyJobV1({ jobId: "job_1", checkpoint, requestedAt: time }, auth);
    expect(VerifyJobV1Schema.parse(job)).toEqual(job);
    expect(VerifyInvocationV1Schema.parse({ v: 1, companyId: "org_1", jobId: "job_1" })).toEqual({ v: 1, companyId: "org_1", jobId: "job_1" });
    expect(VerifyInvocationV1Schema.safeParse({ v: 1, companyId: "org_1", jobId: "job_1", key: "foreign" }).success).toBe(false);
    expect(verifyJobKeyV1("org_1", "job_1")).toEqual({ pk: "VERIFYJOB#org_1", sk: "job_1" });
    expect(sealProgressKeyV1("org_1", 1, 10)).toEqual({ pk: "SEALSTATE#org_1", sk: "0000000000000001#0000000000000010" });
    expect(epochProgressKeyV1(checkpoint.epochId)).toEqual({ pk: `EPOCHSTATE#${checkpoint.epochId}`, sk: "STATE" });
    expect(() => authorizeVerifyJobV1(job, { companyId: "org_1", role: "admin" })).not.toThrow();
    for (const denied of [ { ...auth, role: "member" }, { ...auth, companyId: "org_2" } ]) expect(() => authorizeVerifyJobV1(job, denied)).toThrow();
    expect(() => newVerifyJobV1({ jobId: "job_1", checkpoint, requestedAt: time }, { ...auth, role: "member" })).toThrow();
    const result = { checkedFrom: 1, checkedThrough: 10, asOf: later, pendingDelivery: 0, unsealed: 0, timestampedThrough: 10 };
    const done = { ...job, state: "complete", finishedAt: later, result: { ...result, verdict: "passed" } };
    expect(VerifyJobV1Schema.safeParse(done).success).toBe(true);
    for (const bad of [ { ...result, checkedThrough: 9 }, { ...result, timestampedThrough: 9 }, { ...result, unsealed: 1 }, { ...result, pendingDelivery: 1 } ]) expect(VerifyJobV1Schema.safeParse({ ...done, result: { ...bad, verdict: "passed" } }).success).toBe(false);
    expect(VerifyJobV1Schema.safeParse({ ...job, state: "incomplete", finishedAt: later, reason: "read-unavailable" }).success).toBe(true);
    expect(VerifyJobV1Schema.safeParse({ ...done, result: { ...result, verdict: "broken", firstBrokenSeq: 3, problem: "hash" } }).success).toBe(true);
    expect(VerifyJobV1Schema.safeParse({ ...job, arbitraryS3Key: "foreign" }).success).toBe(false);
  });

  it("requires explicit region, retention and configurable timestamp provider", () => {
    const input = { region: "us-west-2", minimumRetentionDays: 365, tsaProvider: "freetsa" };
    expect(AuditDeploymentV1Schema.parse(input)).toEqual(input);
    expect(AuditDeploymentV1Schema.safeParse({ minimumRetentionDays: 365, tsaProvider: "freetsa" }).success).toBe(false);
    expect(AuditDeploymentV1Schema.safeParse({ ...input, minimumRetentionDays: 364 }).success).toBe(false);
    expect(AuditDeploymentV1Schema.safeParse({ ...input, tsaProvider: "qualified-provider" }).success).toBe(true);
  });
});
