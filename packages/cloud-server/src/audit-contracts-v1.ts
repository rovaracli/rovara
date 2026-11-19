// Private hosted AUD-0 contracts and pure transformations only. v1 refuses
// every ReplayRole delivery; recovery is only an original relay resending
// retained pending bytes. Successful-replay origin proof is deferred to the
// controller. This module implements no transport, authority attestation,
// persistence, routes or worker behavior.
import { createHash } from "node:crypto";
import { z } from "zod";
import { statementHash } from "@rovara/audit-verifier";
import {
  AuditHexV1Schema as Hex, AuditIdV1Schema as Id, AuditTimeV1Schema as Time,
  AuditSourceV1Schema, AuditRecordContentV1Schema, AuditRecordV1Schema,
  auditDetailCommitmentV1, auditRecordDigestV1, encodeAuditEventIdV1,
  type AuditSourceV1, type AuditRecordContentV1, type AuditRecordV1,
} from "@agentx/contracts/audit-record-v1";
import { CLOUD_AUDIT_ACTIONS } from "./audit-log.js";

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Seq = Count.min(1);
const ActorType = z.enum(["person", "agent", "system"]);
const Text = z.string().min(1).max(256);
const Action = AuditRecordContentV1Schema.shape.action;
const CodeSource = z.strictObject({
  eventId: Text, companyId: Id, at: Time, actor: z.strictObject({ type: ActorType, id: Text }), action: Action,
  subject: z.strictObject({ type: Text, id: Text }).optional(), details: z.record(z.string(), z.json()).optional(),
});
const CloudSource = z.strictObject({
  id: z.string().regex(/^aud_[0-9a-z]{20}$/u), companyId: Id, at: Time,
  actor: z.strictObject({ type: ActorType, developerId: Text, name: z.string().min(1).max(200) }),
  action: z.enum(CLOUD_AUDIT_ACTIONS), subject: z.string().max(321), project: z.string().max(63).optional(),
  outcome: z.enum(["ok", "refused"]), via: z.string().max(64).optional(), detail: z.string().max(200).optional(),
});
export type AuditCaptureContextV1 = { installId: string; salt: Uint8Array };
export type MappedAuditV1 = { source: AuditSourceV1; factsDigest: string; event: AuditRecordContentV1 };

// Source JSON may contain finite decimal costs. Commit its canonical JSON TEXT,
// preserving those facts while keeping the existing verifier's integer-only JSON
// format. Undefined optional properties are normalized to absent at capture.
function sourceJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    if (!(value as string & { isWellFormed(): boolean }).isWellFormed()) throw new TypeError("audit: invalid source Unicode");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item: unknown) => sourceJson(item)).join(",")}]`;
  if (typeof value !== "object" || value === null) throw new TypeError("audit: invalid source JSON");
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("audit: invalid source object");
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${sourceJson(key)}:${sourceJson(item)}`).join(",")}}`;
}

function mapSource(
  raw: object, sourceKind: AuditSourceV1["sourceKind"], rawId: string, companyId: string, at: string,
  action: string, actor: { type: "person" | "agent" | "system"; id: string }, target: object | null,
  context: AuditCaptureContextV1,
): MappedAuditV1 {
  const binding = { installId: Id.parse(context.installId), companyId, sourceKind };
  const commit = (subject: string, fields: object): string => auditDetailCommitmentV1(context.salt, subject, { ...binding, ...fields });
  const source = AuditSourceV1Schema.parse({ ...binding, eventId: commit("event-id", { eventId: rawId }) });
  const factsDigest = commit("source", { sourceJson: sourceJson(raw) });
  const event = AuditRecordContentV1Schema.parse({
    v: 1, orgId: companyId, eventId: encodeAuditEventIdV1(source), action,
    actor: { kind: actor.type, id: commit("actor", actor) },
    target: target === null ? { kind: "none", id: "none" } : { kind: "commitment", id: commit("target", target) },
    occurredAt: at, related: [], facts: { sourceKind, sourceInstall: binding.installId },
    details: [{ subject: "source", commit: factsDigest }],
  });
  return { source, factsDigest, event };
}

/** Both mappings run on durable source rows, never on the bounded activity reader. */
export function mapCodeAuditV1(input: unknown, context: AuditCaptureContextV1): MappedAuditV1 {
  const event = CodeSource.parse(input);
  return mapSource(event, "code", event.eventId, event.companyId, event.at, event.action, event.actor, event.subject ?? null, context);
}
export function mapCloudAuditV1(input: unknown, context: AuditCaptureContextV1): MappedAuditV1 {
  const event = CloudSource.parse(input);
  return mapSource(event, "cloud", event.id, event.companyId, event.at, event.action,
    { type: event.actor.type, id: event.actor.developerId }, event.subject === "" ? null : { subject: event.subject }, context);
}

export const PendingAuditV1Schema = z.strictObject({
  v: z.literal(1), kind: z.literal("pending"), source: AuditSourceV1Schema,
  factsDigest: Hex, capturedAt: Time, event: AuditRecordContentV1Schema,
}).superRefine((item, ctx) => {
  if (encodeAuditEventIdV1(item.source) !== item.event.eventId || item.factsDigest !== item.event.details[0].commit) {
    ctx.addIssue({ code: "custom", message: "audit: pending identity/digest mismatch" });
  }
});
export type PendingAuditV1 = z.infer<typeof PendingAuditV1Schema>;
export function pendingAuditV1(mapped: MappedAuditV1, capturedAt: string): PendingAuditV1 {
  return PendingAuditV1Schema.parse({ v: 1, kind: "pending", ...mapped, capturedAt });
}
export const ReceiptAuditV1Schema = z.strictObject({
  v: z.literal(1), kind: z.literal("receipt"), source: AuditSourceV1Schema, factsDigest: Hex,
  seq: Seq, recordHash: Hex, committedAt: Time,
});
export type ReceiptAuditV1 = z.infer<typeof ReceiptAuditV1Schema>;

/** A receipt is meaningful only when read from the separately authorized receipt
 * store. Matching untrusted bytes is not proof of append or source authority. */
export function receiptMatchesPendingV1(pending: unknown, receipt: unknown): boolean {
  const p = PendingAuditV1Schema.safeParse(pending);
  const r = ReceiptAuditV1Schema.safeParse(receipt);
  return p.success && r.success && encodeAuditEventIdV1(p.data.source) === encodeAuditEventIdV1(r.data.source) && p.data.factsDigest === r.data.factsDigest;
}
export function materializeAuditRecordV1(mapped: MappedAuditV1, position: { seq: number; recordedAt: string; prevHash: string }): AuditRecordV1 {
  // Validate all three mapped components before allocating a chain position.
  const pending = pendingAuditV1(mapped, position.recordedAt);
  const body = { ...pending.event, ...position };
  return AuditRecordV1Schema.parse({ ...body, hash: auditRecordDigestV1(body) });
}
export function pendingKeyV1(input: AuditSourceV1): { pk: string; sk: string } {
  const source = AuditSourceV1Schema.parse(input);
  // Sixteen fixed partitions. No GSI or scan is needed; the relay queries 00..0f.
  const shard = (parseInt(createHash("sha256").update(encodeAuditEventIdV1(source)).digest("hex").slice(0, 2), 16) % 16).toString(16).padStart(2, "0");
  return { pk: `AUDIT_PENDING#${shard}`, sk: encodeAuditEventIdV1(source) };
}
export function receiptKeyV1(input: AuditSourceV1): { pk: string; sk: string } {
  const source = AuditSourceV1Schema.parse(input);
  return { pk: `RECEIPT#${source.installId}#${source.companyId}`, sk: encodeAuditEventIdV1(source) };
}

const EpochId = z.string().regex(/^e\d{8}T\d{4}Z$/u);
export const AuditCheckpointV1Schema = z.strictObject({
  fromSeq: Seq, toSeq: Seq, headHash: Hex, prevSealHash: Hex, epochId: EpochId,
}).refine((range) => range.fromSeq <= range.toSeq, "audit: invalid range");
// Exact immutable S3 version, not a mutable current-object pointer. These values
// must come from readback in AUD-4; parsing alone does not establish S3 retention.
export const LockedEvidenceV1Schema = z.strictObject({
  key: z.string().min(1).max(1024).startsWith("audit/"), versionId: z.string().min(1).max(1024).refine((id) => id !== "null", "audit: unversioned evidence"), sha256: Hex,
  writtenAt: Time, lockMode: z.literal("COMPLIANCE"), retainUntil: Time,
}).refine((ref) => Date.parse(ref.retainUntil) - Date.parse(ref.writtenAt) >= 365 * 86_400_000, "audit: insufficient retention");
const SealBase = z.strictObject({ v: z.literal(1), kind: z.literal("seal-progress"), companyId: Id, checkpoint: AuditCheckpointV1Schema, batchRoot: Hex, updatedAt: Time });
export const SealProgressV1Schema = z.discriminatedUnion("phase", [
  SealBase.extend({ phase: z.literal("planned") }),
  SealBase.extend({ phase: z.literal("batch-locked"), batch: LockedEvidenceV1Schema }),
  SealBase.extend({ phase: z.literal("locked"), batch: LockedEvidenceV1Schema, seal: LockedEvidenceV1Schema }),
]);
const EpochBase = z.strictObject({
  v: z.literal(1), kind: z.literal("epoch-progress"), epochId: EpochId, statementHash: Hex,
  prevEpochId: EpochId.nullable(), prevStatementHash: Hex.nullable(), sealsRoot: Hex, sealCount: Seq, closedAt: Time, updatedAt: Time,
});
const Provider = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const EpochProgressV1Schema = z.discriminatedUnion("phase", [
  EpochBase.extend({ phase: z.literal("planned") }),
  EpochBase.extend({ phase: z.literal("waiting-timestamp"), statement: LockedEvidenceV1Schema, tsaProvider: Provider }),
  EpochBase.extend({ phase: z.literal("timestamp-received"), statement: LockedEvidenceV1Schema, tsaProvider: Provider, tokenBase64: z.string().min(4).max(262144).regex(/^[A-Za-z0-9+/]+={0,2}$/u), tokenHash: Hex }),
  EpochBase.extend({ phase: z.literal("timestamped"), statement: LockedEvidenceV1Schema, tsaProvider: Provider, token: LockedEvidenceV1Schema }),
 ]).superRefine((epoch, ctx) => {
  if ((epoch.prevEpochId === null) !== (epoch.prevStatementHash === null) || statementHash(epoch) !== epoch.statementHash) {
    ctx.addIssue({ code: "custom", message: "audit: epoch statement mismatch" });
  }
  if (epoch.phase === "timestamp-received") {
    const token = Buffer.from(epoch.tokenBase64, "base64");
    if (token.toString("base64") !== epoch.tokenBase64 || createHash("sha256").update(token).digest("hex") !== epoch.tokenHash) {
      ctx.addIssue({ code: "custom", message: "audit: timestamp bytes mismatch" });
    }
  }
});
export type SealProgressV1 = z.infer<typeof SealProgressV1Schema>;
export type EpochProgressV1 = z.infer<typeof EpochProgressV1Schema>;

const JobBase = z.strictObject({
  v: z.literal(1), kind: z.literal("verify-job"), jobId: Id, companyId: Id,
  checkpoint: AuditCheckpointV1Schema, requestedAt: Time,
});
const Coverage = z.strictObject({
  checkedFrom: Seq, checkedThrough: Count, asOf: Time, pendingDelivery: Count, unsealed: Count, timestampedThrough: Count,
});
const Result = z.discriminatedUnion("verdict", [
  Coverage.extend({ verdict: z.literal("passed") }),
  Coverage.extend({ verdict: z.literal("waiting-timestamp") }),
  Coverage.extend({ verdict: z.literal("broken"), firstBrokenSeq: Seq, problem: z.enum(["hash", "link", "gap", "org", "seal", "timestamp", "lock", "version"]) }),
]);
export const VerifyJobV1Schema = z.discriminatedUnion("state", [
  JobBase.extend({ state: z.literal("queued") }),
  JobBase.extend({ state: z.literal("running"), startedAt: Time }),
  JobBase.extend({ state: z.literal("incomplete"), finishedAt: Time, reason: z.enum(["read-unavailable", "limit", "missing-evidence"]) }),
  JobBase.extend({ state: z.literal("complete"), finishedAt: Time, result: Result }),
]).superRefine((job, ctx) => {
  if (job.state !== "complete") return;
  const r = job.result;
  const c = job.checkpoint;
  if (r.checkedFrom !== c.fromSeq || r.checkedThrough > c.toSeq || r.checkedThrough < c.fromSeq - 1 ||
      (r.verdict === "broken" && (r.firstBrokenSeq < c.fromSeq || r.firstBrokenSeq > c.toSeq)) ||
      (r.verdict === "passed" && (r.checkedThrough !== c.toSeq || r.timestampedThrough < c.toSeq || r.pendingDelivery !== 0 || r.unsealed !== 0))) {
    ctx.addIssue({ code: "custom", message: "audit: invalid verification coverage" });
  }
});
export type VerifyJobV1 = z.infer<typeof VerifyJobV1Schema>;
export type CurrentAuditAuthorityV1 = { companyId: string; role: string };
function checkAuthority(auth: CurrentAuditAuthorityV1): string {
  if (auth.role !== "owner" && auth.role !== "admin") throw new TypeError("audit: refused");
  return Id.parse(auth.companyId);
}
export function newVerifyJobV1(input: { jobId: string; checkpoint: z.infer<typeof AuditCheckpointV1Schema>; requestedAt: string }, current: CurrentAuditAuthorityV1): VerifyJobV1 {
  const companyId = checkAuthority(current);
  return VerifyJobV1Schema.parse({ ...input, v: 1, kind: "verify-job", companyId, state: "queued" });
}
/** Call with CURRENT server authority at start, result read and download. A stored
 * role, a request-body company or a job token cannot supply current authority. */
export function authorizeVerifyJobV1(input: unknown, current: CurrentAuditAuthorityV1): void {
  const companyId = checkAuthority(current);
  if (VerifyJobV1Schema.parse(input).companyId !== companyId) throw new TypeError("audit: refused");
}
export const AuditDeploymentV1Schema = z.strictObject({
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u), minimumRetentionDays: Count.min(365), tsaProvider: Provider,
});

export const VerifyInvocationV1Schema = z.strictObject({ v: z.literal(1), companyId: Id, jobId: Id });
/** Worker invocation contains only a job identity. Evidence selection comes from
 * that stored company-bound job, never caller-chosen object keys or ranges. */
export function verifyJobKeyV1(companyId: string, jobId: string): { pk: string; sk: string } {
  return { pk: `VERIFYJOB#${Id.parse(companyId)}`, sk: Id.parse(jobId) };
}
export function sealProgressKeyV1(companyId: string, fromSeq: number, toSeq: number): { pk: string; sk: string } {
  const from = Seq.parse(fromSeq);
  const to = Seq.parse(toSeq);
  if (from > to) throw new TypeError("audit: invalid range");
  return { pk: `SEALSTATE#${Id.parse(companyId)}`, sk: `${String(from).padStart(16, "0")}#${String(to).padStart(16, "0")}` };
}
export function epochProgressKeyV1(epochId: string): { pk: string; sk: string } {
  return { pk: `EPOCHSTATE#${EpochId.parse(epochId)}`, sk: "STATE" };
}
