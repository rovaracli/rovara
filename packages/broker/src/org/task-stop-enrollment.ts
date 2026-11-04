// Owner-only, receipt-backed enrollment edges. No task is stopped or mutated here.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
 AuditEventInputSchema, INDEX_EXPIRY_ATTRIBUTE, TaskStopEnrollmentBodySchema, TaskStopEnrollmentReadSchema,
 TaskStopEnrollmentResultSchema, TaskStopReviewBodySchema, TaskStopReviewSchema, agentXError, auditEventId,
 canonicalJson, taskStopReviewKey, type TaskStopReview,
} from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { commit, isTransactionConflict, readRequest, type TransactItem } from "../agents/table-writes.js";
import { auditPending } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { captureCompanyCutover } from "./task-stop-cutover-review.js";
import {
 checks, companySource, decodeBody, digest, forbidden, freshChecks, invalid, mergeChecks, ownerChecks, read, reauth, stale,
 tooLarge, transactionBounds, type EnrollmentDeps, type Key, type Row,
} from "./task-stop-enrollment-common.js";
const period = 300_000;
const id = (table: string | undefined, key: unknown) => canonicalJson([table, key]);
function keyOf(item: TransactItem): Key | undefined {
 const key = item.ConditionCheck?.Key ?? item.Put?.Item;
 return typeof key?.pk === "string" && typeof key.sk === "string" ? { pk: key.pk, sk: key.sk } : undefined;
}
function classifier(authority: TransactItem[], sessions: TransactItem[], items: TransactItem[]) {
 const group = (input: TransactItem[]) => new Set(input.map(item => id(item.ConditionCheck?.TableName, keyOf(item))));
 const actors = group(authority), fresh = group(sessions);
 return (failed: Set<number>) => {
  const keys = [...failed].map(index => { const item = items[index];return item === undefined ? "" : id(item.ConditionCheck?.TableName ?? item.Put?.TableName, keyOf(item)); });
  if (keys.some(key => actors.has(key))) return forbidden();
  if (keys.some(key => fresh.has(key))) return reauth();
  return stale();
 };
}
async function replay(deps: EnrollmentDeps, caller: DeveloperCaller, requestId: string, fingerprint: string) {
 const earlier = await readRequest(deps, caller.orgId, caller.developerId, requestId);
 if (earlier === undefined) return undefined;if (earlier.fingerprint !== fingerprint) throw invalid();return earlier.result;
}
async function write(deps: EnrollmentDeps, caller: DeveloperCaller, requestId: string, fingerprint: string, result: unknown,
 items: TransactItem[], authority: TransactItem[], sessions: TransactItem[]) {
 transactionBounds(items);
 for (let attempt = 0; attempt < 3; attempt += 1) {
  try { await commit(deps, items, classifier(authority, sessions, items), { orgId: caller.orgId, developerId: caller.developerId, requestId, fingerprint }, result);return result; }
  catch (error) {
   await ownerChecks(deps, caller);
   const committed = await replay(deps, caller, requestId, fingerprint);if (committed !== undefined) return committed;
   if (isTransactionConflict(error) && attempt < 2) continue;throw error;
  }
 }
 throw stale();
}
export async function getTaskStopEnrollment(deps: EnrollmentDeps, caller: DeveloperCaller, fresh = false) {
 await ownerChecks(deps, caller);if (fresh) await freshChecks(deps, caller);
 const source = await companySource(deps, caller, false);await ownerChecks(deps, caller);
 return TaskStopEnrollmentReadSchema.parse({ orgId: caller.orgId, state: source.state, revision: source.revision });
}
export async function reviewTaskStopEnrollment(deps: EnrollmentDeps, caller: DeveloperCaller, value: unknown) {
 const authority = await ownerChecks(deps, caller), parsed = TaskStopReviewBodySchema.safeParse(decodeBody(value));if (!parsed.success) throw invalid();
 const body = parsed.data, fingerprint = digest({ op: "task-stop-review", orgId: caller.orgId, body });
 const earlier = await replay(deps, caller, body.requestId, fingerprint);if (earlier !== undefined) return TaskStopReviewSchema.parse(earlier);
 const captured = await captureCompanyCutover(deps, caller);
 if (captured.source.state === "enabled" || captured.source.revision !== body.expectedRevision) throw stale();
 const at = deps.now(), review = TaskStopReviewSchema.parse({ orgId: caller.orgId, reviewId: randomUUID(), digest: captured.digest, revision: captured.source.revision,
  complete: true, capturedAt: new Date(at).toISOString(), expiresAt: new Date(at + period).toISOString(), tasks: captured.tasks, counts: captured.counts, truncated: captured.truncated });
 const key = taskStopReviewKey(caller.orgId, review.reviewId), row = { ...key, entityType: "TASK_STOP_REVIEW", by: caller.developerId, sourceDigest: captured.sourceDigest,
  taskIds: captured.allTasks.map(task => task.taskId), review, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((at + period) / 1000) };
 if (Buffer.byteLength(JSON.stringify(row)) > 128 * 1024) throw tooLarge();
 const items = [...mergeChecks([...authority, ...captured.checks]), { Put: { TableName: deps.tableName, Item: row, ConditionExpression: "attribute_not_exists(pk)" } }];
 return TaskStopReviewSchema.parse(await write(deps, caller, body.requestId, fingerprint, review, items, authority, []));
}
const Binding = z.object({ reviewId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), by: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime(), tasksReviewed: z.number().int().min(0).max(100) }).strict();
async function reviewed(deps: EnrollmentDeps, caller: DeveloperCaller, reviewId: string, expectedDigest: string) {
 const key = taskStopReviewKey(caller.orgId, reviewId), row = await read(deps, key);
 if (row === undefined) throw agentXError("NOT_FOUND", "No enforcement review belongs to this company.");
 if (row.by !== caller.developerId) throw forbidden();
 const review = TaskStopReviewSchema.safeParse(row.review);
 if (!review.success || row.entityType !== "TASK_STOP_REVIEW" || review.data.orgId !== caller.orgId || review.data.reviewId !== reviewId || review.data.digest !== expectedDigest
  || Date.parse(review.data.capturedAt) > deps.now() || Date.parse(review.data.expiresAt) <= deps.now() || typeof row.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.sourceDigest)) throw stale();
 return { key, row, review: review.data, sourceDigest: row.sourceDigest };
}
export async function writeTaskStopEnrollment(deps: EnrollmentDeps, caller: DeveloperCaller, value: unknown) {
 const authority = await ownerChecks(deps, caller), parsed = TaskStopEnrollmentBodySchema.safeParse(decodeBody(value));if (!parsed.success) throw invalid();
 const body = parsed.data, fingerprint = digest({ op: "task-stop-enrollment", orgId: caller.orgId, body });
 const earlier = await replay(deps, caller, body.requestId, fingerprint);if (earlier !== undefined) return TaskStopEnrollmentResultSchema.parse(earlier);
 // Read state only to decide whether this request loosens money. No revision/review verdict precedes REAUTH.
 const source = await companySource(deps, caller, body.state !== "disabled"), sessions = body.state === "enabled" || body.state === "disabled" && source.state === "enabled" ? await freshChecks(deps, caller) : [];
 if (source.revision !== body.expectedRevision || source.revision >= Number.MAX_SAFE_INTEGER) throw stale();
 const edge = `${source.state}:${body.state}`;
 if (!["disabled:ready", "ready:enabled", "ready:disabled", "enabled:disabled"].includes(edge)) throw stale();
 if (body.state !== "disabled" && source.row.pendingTaskStopChange !== undefined) throw stale();
 const next: Row = { ...source.row, revision: source.revision + 1, enrollment: { version: 1, state: body.state }, updatedBy: caller.developerId, updatedAt: new Date(deps.now()).toISOString() };
 const native = checks(deps, source.key, source.row);
 let used: TaskStopReview | undefined, tasksReviewed = 0, tasksAtEnable = 0, newImpacts = 0;
 if (body.state !== "disabled" && "reviewId" in body) {
  const r = await reviewed(deps, caller, body.reviewId, body.expectedReviewDigest);used = r.review;
  native.push(...checks(deps, r.key, r.row));
  let fresh: Awaited<ReturnType<typeof captureCompanyCutover>>;
  try { fresh = await captureCompanyCutover(deps, caller); }
  catch (error) { if (body.state === "enabled" && error instanceof Error && "code" in error && String(error.code).startsWith("TASK_STOP_CONFIG_")) throw stale();throw error; }
  native.push(...fresh.checks);
  // Never compare policyDigest across a company revision bump, or fence task/workspace rows.
  if (r.sourceDigest !== fresh.sourceDigest) throw stale();
  if (body.state === "ready") {
   if (r.review.revision !== source.revision) throw stale();tasksReviewed = Object.values(r.review.counts).reduce((sum, count) => sum + count, 0);tasksAtEnable = fresh.allTasks.length;
   next.enrollmentReview = Binding.parse({ reviewId: r.review.reviewId, digest: r.review.digest, sourceDigest: r.sourceDigest, by: caller.developerId, at: r.review.capturedAt, tasksReviewed });
  } else {
   const binding = Binding.safeParse(source.row.enrollmentReview);if (!binding.success || binding.data.sourceDigest !== r.sourceDigest) throw stale();
   const bound = binding.data.reviewId === r.review.reviewId && binding.data.digest === r.review.digest && r.review.revision === source.revision - 1;
   if (!bound && r.review.revision !== source.revision) throw stale();
   tasksReviewed = Object.values(r.review.counts).reduce((sum, count) => sum + count, 0);tasksAtEnable = fresh.allTasks.length;
   const oldIds = new Set(z.array(z.string().uuid()).max(100).parse(r.row.taskIds));
   newImpacts = fresh.allTasks.filter(task => !oldIds.has(task.taskId) && (task.outcome === "refuse_next_admission" || task.outcome === "new_window_at_stop")).length;
   next.enrollmentReview = Binding.parse({ ...binding.data, reviewId: r.review.reviewId, digest: r.review.digest, by: caller.developerId, at: r.review.capturedAt, tasksReviewed });
  }
 } else if (body.state !== "disabled") throw invalid();
 const pendingExpired = source.row.pendingTaskStopChange !== undefined;
 if (body.state === "disabled") {
  delete next.enrollmentReview;
  if (pendingExpired) {
   const pending = source.row.pendingTaskStopChange as Row;
   delete next.pendingTaskStopChange;next.lastTaskStopChange = { ...(typeof pending.proposalId === "string" ? { proposalId: pending.proposalId } : {}), state: "expired", reason: "enrollment_changed", endedAt: new Date(deps.now()).toISOString() };
  }
 }
 if (deps.audit === undefined || deps.audit.tableName !== deps.tableName || deps.audit.documentClient !== deps.documentClient) throw agentXError("AUDIT_UNAVAILABLE", "Enforcement changes require the audit ledger.");
 const boundForAudit = Binding.safeParse(source.row.enrollmentReview);
 const auditReview = used === undefined && boundForAudit.success ? { reviewId: boundForAudit.data.reviewId, digest: boundForAudit.data.digest } : used;
 const event = AuditEventInputSchema.parse({ eventId: auditEventId("spending.enrollment_changed", body.requestId), orgId: caller.orgId, action: "spending.enrollment_changed", actor: { kind: "member", id: caller.developerId },
  target: { kind: "org", id: caller.orgId }, occurredAt: new Date(deps.now()).toISOString(), facts: { requestId: body.requestId, before: source.state, after: body.state, revision: next.revision,
   ...(auditReview === undefined ? {} : { reviewId: auditReview.reviewId, reviewDigest: auditReview.digest }), tasksReviewed, tasksAtEnable, newImpacts, pendingExpired: body.state === "disabled" && pendingExpired } });
 const items = mergeChecks([...authority, ...sessions, ...native]);
 const index = items.findIndex(item => item.ConditionCheck?.Key?.pk === source.key.pk && item.ConditionCheck.Key.sk === source.key.sk), policyCheck = items[index]?.ConditionCheck;
 if (policyCheck === undefined) throw stale();
 items[index] = { Put: { TableName: deps.tableName, Item: next, ConditionExpression: policyCheck.ConditionExpression, ExpressionAttributeNames: policyCheck.ExpressionAttributeNames, ExpressionAttributeValues: policyCheck.ExpressionAttributeValues } };
 items.push(...auditPending(deps, event));
 const result = TaskStopEnrollmentResultSchema.parse({ orgId: caller.orgId, state: body.state, revision: next.revision, tasksReviewed, tasksAtEnable, newImpacts });
 const answer = TaskStopEnrollmentResultSchema.parse(await write(deps, caller, body.requestId, fingerprint, result, items, authority, sessions));
 await flushAuditEvents(deps, [event]);return answer;
}
