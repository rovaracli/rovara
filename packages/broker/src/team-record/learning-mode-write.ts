// UX-4b: the writer of a project's learning mode (Off, Collect, Suggest, On), the value `mode.ts` and `lessons/dynamo-settings.ts` read. Before this file only tests wrote it, while the
// app told people to "turn learning on".
//   GET  /v1/app/projects/{p}/record/learning-mode   anyone with a role in the project: the project's own value, the company lock and what runs
//   POST /v1/app/projects/{p}/record/learning-mode   { requestId, mode, expectedMode }
// WHO: the people who may change the project's sources (`mayEditSources`: a maintainer of the project, or a company admin, who is a maintainer there), on a live browser session. This does
// not widen who decides: the mode only says how much the record captures and suggests, and every lesson still needs the people it needed before.
// THE COMPANY LOCK wins (owner decision M8: a lock only makes the mode stricter): a value looser than the lock is refused with LEARNING_LOCKED, never stored to wait under it.
// ONE TRANSACTION: the mode item (conditional on the value the person read), the request item (a repeat answers the same; a late repeat after another change changes nothing), and the
// `lesson.mode_changed` audit item. Refusals are fixed codes; nothing the client sent is echoed.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LEARNING_MODE_DEFAULT, LearningModeSchema, LearningModeWriteBodySchema, agentXError, auditEventId, canonicalJson, learningModeKey, learningModeLockKey,
  type AuditEventInput, type LearningMode, type LearningModeView, type OrgId,
} from "@agentx/contracts";
import { errorName, isTransactionConflict } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending } from "../audit/outbox.js";
import { stricter } from "./mode.js";
import type { RecordQueryDependencies } from "./query.js";
import type { RecordRouteReply, RecordRouteRequest } from "./routes.js";
import { mayEditSources } from "./source-write.js";
import { readSourceRequest, requestPut } from "./source-store.js";
import type { TeamRecordTable } from "./types.js";

export const LEARNING_MODE_WORDS = {
  browser: "Use a live browser session to change how this project learns.",
  notEditor: "Only a maintainer of this project, or a company admin, can change how it learns.",
  invalid: "The request is not valid.",
  locked: "Your company keeps learning stricter than that for every project.",
  stale: "Someone changed how this project learns. Reload and try again.",
  audit: "This change needs the audit ledger.",
} as const;

/** `raw`: the stored value as it is, so a write can be conditional on exactly it, even one that does not read (review fix 6: such a value reads as Off and can be reset from the page). */
interface Stored { present: boolean; mode?: LearningMode; raw?: unknown }
async function readMode(table: TeamRecordTable, key: { pk: string; sk: string }): Promise<Stored> {
  const response = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: { mode?: unknown } };
  if (response.Item === undefined) return { present: false };
  const parsed = LearningModeSchema.safeParse(response.Item.mode);
  return parsed.success ? { present: true, mode: parsed.data, raw: response.Item.mode } : { present: true, raw: response.Item.mode };
}

/** The project's own value as the readers see it: the stored one, the default when none is stored, Off when what is stored does not read (fail closed, as `mode.ts`). */
const ownOf = (stored: Stored): LearningMode => (stored.present ? stored.mode ?? "off" : LEARNING_MODE_DEFAULT);

async function viewOf(table: TeamRecordTable, orgId: OrgId, project: string, canChange: boolean): Promise<LearningModeView> {
  const [own, lock] = await Promise.all([readMode(table, learningModeKey(orgId, project)), readMode(table, learningModeLockKey(orgId))]);
  const mode = ownOf(own);
  const lockMode = lock.present ? lock.mode ?? "off" : undefined;
  return { mode, ...(lockMode === undefined ? {} : { lock: lockMode }), effective: lockMode === undefined ? mode : stricter(lockMode, mode), canChange };
}

export async function learningModeRead(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<RecordRouteReply> {
  if (request.caller.projectRole === undefined) throw agentXError("PROJECT_NOT_FOUND", "No such project.");
  const canChange = request.write !== undefined && request.write.browserSession && mayEditSources(request.caller, request.write);
  return { status: 200, body: await viewOf(deps.table, request.caller.orgId, project, canChange) };
}

export async function learningModeWrite(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<RecordRouteReply> {
  const ctx = request.write;
  if (ctx === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The team record can't be changed right now.");
  if (request.caller.projectRole === undefined) throw agentXError("PROJECT_NOT_FOUND", "No such project.");
  if (!mayEditSources(request.caller, ctx)) throw agentXError("FORBIDDEN", LEARNING_MODE_WORDS.notEditor);
  if (!ctx.browserSession) throw agentXError("FORBIDDEN", LEARNING_MODE_WORDS.browser);
  let raw: unknown;
  try { raw = ctx.body(); } catch { throw agentXError("CONFIG_INVALID", LEARNING_MODE_WORDS.invalid); }
  const parsed = LearningModeWriteBodySchema.safeParse(raw);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", LEARNING_MODE_WORDS.invalid);
  const body = parsed.data;
  const { orgId, developerId } = request.caller;
  const now = deps.now ?? Date.now;
  const hash = createHash("sha256").update(canonicalJson({ learningMode: body })).digest("hex");
  const again = await readSourceRequest(deps.table, orgId, project, developerId, body.requestId, now());
  if (again !== undefined) {
    if (again.bodyHash !== hash) throw agentXError("CONFIG_INVALID", LEARNING_MODE_WORDS.invalid);
    return { status: again.status, body: again.reply };
  }
  const key = learningModeKey(orgId, project);
  const [own, lock] = await Promise.all([readMode(deps.table, key), readMode(deps.table, learningModeLockKey(orgId))]);
  const was = ownOf(own);
  if (was !== body.expectedMode) throw agentXError("CHANGE_STALE", LEARNING_MODE_WORDS.stale);
  const lockMode = lock.present ? lock.mode ?? "off" : undefined;
  if (lockMode !== undefined && stricter(lockMode, body.mode) !== body.mode) throw agentXError("LEARNING_LOCKED", LEARNING_MODE_WORDS.locked);
  const reply: LearningModeView = { mode: body.mode, ...(lockMode === undefined ? {} : { lock: lockMode }), effective: lockMode === undefined ? body.mode : stricter(lockMode, body.mode), canChange: true };
  if (was === body.mode) return { status: 200, body: reply };
  const at = new Date(now()).toISOString();
  const event: AuditEventInput = {
    eventId: auditEventId("lesson.mode_changed", body.requestId), orgId, action: "lesson.mode_changed", actor: { kind: "member", id: developerId }, occurredAt: at,
    target: { kind: "lesson", id: createHash("sha256").update(`mode\0${project}`).digest("hex").slice(0, 40) }, facts: { fromMode: was, toMode: body.mode, locked: lockMode !== undefined },
  };
  const audit = ctx.audit === undefined ? [] : auditPending(ctx.audit, event);
  // Turning learning on or looser widens what is captured, so a change that cannot be audited is refused; making it stricter goes on without the ledger on a legacy install.
  const loosens = stricter(was, body.mode) === was && was !== body.mode;
  if (loosens && audit.length === 0) throw agentXError("AUDIT_UNAVAILABLE", LEARNING_MODE_WORDS.audit);
  // On the value exactly as read: a stored value that does not read (it reads as Off) is replaced only if it is still that value, or still missing its mode.
  const condition = !own.present ? { ConditionExpression: "attribute_not_exists(pk)" }
    : own.raw === undefined ? { ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#m)", ExpressionAttributeNames: { "#m": "mode" } }
    : { ConditionExpression: "#m = :was", ExpressionAttributeNames: { "#m": "mode" }, ExpressionAttributeValues: { ":was": own.raw } };
  try {
    await deps.table.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.table.tableName, Item: { ...key, entityType: "LEARNING_MODE", mode: body.mode, updatedBy: developerId, updatedAt: at }, ...condition } },
      requestPut(deps.table, orgId, project, developerId, body.requestId, { bodyHash: hash, status: 200, reply }, now()),
      ...audit,
    ] }));
  } catch (error) {
    // A cancelled transaction wrote nothing: the mode moved under the person, or the same request is being answered at once.
    if (isTransactionConflict(error) || errorName(error) === "TransactionCanceledException") throw agentXError("CHANGE_STALE", LEARNING_MODE_WORDS.stale);
    throw error;
  }
  if (ctx.audit !== undefined) { try { await flushAuditEvents(ctx.audit, [event]); } catch { /* the pending item stays for the drain */ } }
  return { status: 200, body: reply };
}
