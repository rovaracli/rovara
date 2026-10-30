// Plan 3 Task 21: deciding an approval of any kind and the sweep. One state machine: a decision claims the record with ONE conditional transaction; what comes
// after the claim (applying a change, running a write, telling the subject's handler) is repeatable and found again by the sweep through the OPEN_APPROVALS
// index. `approvals.ts` re-exports it.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ApprovalIdSchema, AgentXError, REMOVAL_FORBIDDEN_MESSAGE, agentXError, approvalKey, type ApprovalId, type OrgId } from "@agentx/contracts";
import { auditApprovalDecided, auditApprovalExpired, auditWriteExecuted } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf, decisionProofOf } from "../audit/plan3-hooks.js";
import { ownerFenceOf, taskKey, tryEffectiveTaskOwner } from "../developer/task-records.js";
import { deciderStillMemberCheck } from "../org/member-removal/guards.js";
import { sameMember } from "./lifecycle.js";
import { type AnyApprovalRecord, type ApprovalCaller, approverRefusalFor, type ApprovalDependencies, type ApprovalStatus, DUE_SK, MAX_APPROVAL_ATTEMPTS, PAGE_LIMIT, RETRY_MS, type TransactItem, type WriteApprovalRecord, approverDrops, commitOrLost, counterDrop, dropItem, dueItems, errorNameOf, forbiddenText, getAnyApproval, getApprovalGaveUpHandler, getApprovalSubjectHandler, hasHandlerPhase, iso, log, mayDecideApproval, parseDecideBody, runApprovalDecisionGuards, runOfApproval, shownText, stripCode, taskOfApproval, updateRecord, withFields } from "./approvals-store.js";

// ---- deciding

/** What driving a record's work came to. `unfinished` leaves it `EXECUTING` for the sweep. */
export type Execution = { outcome: "done"; result?: WriteApprovalRecord["result"] } | { outcome: "failed"; failure: string } | { outcome: "unfinished" };

/** Runs an approved write: the re-checks, then the connector call. Task 21's write-gate registers it when it loads. */
export interface WriteApprovalDriver {
  execute(deps: ApprovalDependencies, record: WriteApprovalRecord): Promise<Execution>;
}
let writeDriver: WriteApprovalDriver | undefined;
export function registerWriteApprovalDriver(driver: WriteApprovalDriver): void {
  writeDriver = driver;
}

type Executor = (deps: ApprovalDependencies, record: AnyApprovalRecord) => Promise<Execution>;

/** How an approved record of this kind is carried out; undefined when it needs a driver that isn't there (a write with none refuses before anything is claimed). */
function executorFor(record: AnyApprovalRecord): Executor | undefined {
  if (record.kind === "write") {
    const driver = writeDriver;
    return driver === undefined ? undefined : (deps, current) => driver.execute(deps, current as WriteApprovalRecord);
  }
  if (record.kind === "step") return async () => ({ outcome: "done" });
  return async (deps, current) => {
    const handler = getApprovalSubjectHandler(current.subject.kind);
    if (handler === undefined) return { outcome: "failed", failure: "Nothing can apply this change any more." };
    await handler(deps, current, current.decisionProof === undefined ? undefined : { proof: current.decisionProof });
    return { outcome: "done" };
  };
}

function unconfirmedMessage(record: AnyApprovalRecord): string {
  return record.kind === "write"
    ? `Rovara couldn't confirm that this ran. Check ${record.connector} before asking again.`
    : "Rovara couldn't confirm that this change was applied. Check it, then ask for it again.";
}

/** Runs the executor; a refusal in AgentX's own words ends the record, anything else (a crash, an outage) leaves it for the sweep. */
async function execute(deps: ApprovalDependencies, executor: Executor, record: AnyApprovalRecord): Promise<Execution> {
  try {
    return await executor(deps, record);
  } catch (error) {
    if (error instanceof AgentXError && error.code !== "RUNTIME_UNAVAILABLE") return { outcome: "failed", failure: shownText(stripCode(error), 400) };
    log(deps, "approval.execution_interrupted", { orgId: record.orgId, approvalId: record.approvalId, kind: record.kind, error: errorNameOf(error) });
    return { outcome: "unfinished" };
  }
}


/** Tells the subject's handler how the record ended, once: it takes the lease, runs, and marks the record handled and drops its due items. A failure leaves the lease to run out and the sweep calls again. */
async function tellHandler(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<boolean> {
  const handler = getApprovalSubjectHandler(record.subject.kind);
  if (handler === undefined) {
    log(deps, "approval.handler_missing", { orgId: record.orgId, approvalId: record.approvalId, kind: record.subject.kind });
    // Nothing is registered yet (Task 22 registers it): wait, without counting it against the handler.
    await deferHandler(deps, record, false);
    return false;
  }
  try {
    await handler(deps, record, record.decisionProof === undefined ? undefined : { proof: record.decisionProof });
  } catch (error) {
    log(deps, "approval.handler_failed", { orgId: record.orgId, approvalId: record.approvalId, kind: record.subject.kind, error: errorNameOf(error) });
    await deferHandler(deps, record, true);
    return false;
  }
  const items: TransactItem[] = [updateRecord(deps, record, { handlerDone: true }, [["status", record.status], ["handlerDone", false]])];
  for (const at of new Set([record.handlerDueAt, record.executingAt === undefined ? undefined : iso(Date.parse(record.executingAt) + RETRY_MS)])) {
    if (at !== undefined) items.push(dropItem(deps, record.orgId, record.approvalId, at));
  }
  await commitOrLost(deps, items);
  return true;
}

/** The handler is tried this many times; then the sweep stops (`approval.handler_gave_up`) and the record is left as it ended. */
export const MAX_HANDLER_TRIES = 8;
const MAX_HANDLER_DELAY_MS = 6 * 3_600_000;

/**
 * A handler that did not finish: the record's due item moves forward, doubling the wait each time (5 minutes, 10, 20, ... up to 6 hours), so a handler that
 * always fails does not sit at the head of the index and use the sweep's time. After `MAX_HANDLER_TRIES` it is given up: the record is marked handled
 * and logged. Best effort: if this write is lost or fails, the item stays where it was and the next run tries again.
 */
async function deferHandler(deps: ApprovalDependencies, record: AnyApprovalRecord, counts: boolean): Promise<void> {
  try {
    const now = deps.now();
    const tries = (record.handlerTries ?? 0) + (counts ? 1 : 0);
    const claimDue = record.executingAt === undefined ? undefined : iso(Date.parse(record.executingAt) + RETRY_MS);
    const when: Array<[string, unknown]> = [["status", record.status], ["handlerDone", false]];
    if (counts && tries >= MAX_HANDLER_TRIES) {
      log(deps, "approval.handler_gave_up", { orgId: record.orgId, approvalId: record.approvalId, kind: record.subject.kind, tries });
      // Whoever waits on this decision is told it will not come (Task 22 fails the run); only once that is done is the record let go. If it fails, the sweep tries again.
      let told = true;
      const hook = getApprovalGaveUpHandler(record.subject.kind);
      if (hook !== undefined) {
        try {
          await hook(deps, record);
        } catch (error) {
          told = false;
          log(deps, "approval.gave_up_hook_failed", { orgId: record.orgId, approvalId: record.approvalId, kind: record.subject.kind, error: errorNameOf(error) });
        }
      }
      if (told) {
        await commitOrLost(deps, [updateRecord(deps, record, { handlerDone: true, handlerTries: tries }, when), ...dueItems(deps, record, [record.handlerDueAt, claimDue].filter((at): at is string => at !== undefined), undefined)]);
        return;
      }
    }
    const dueAt = iso(now + Math.min(MAX_HANDLER_DELAY_MS, RETRY_MS * 2 ** Math.max(0, tries - 1)));
    await commitOrLost(deps, [updateRecord(deps, record, { handlerTries: tries, handlerDueAt: dueAt }, when), ...dueItems(deps, record, [record.handlerDueAt, claimDue].filter((at): at is string => at !== undefined), dueAt)]);
  } catch (error) {
    log(deps, "approval.handler_defer_failed", { orgId: record.orgId, approvalId: record.approvalId, error: errorNameOf(error) });
  }
}

/** Takes the lease on telling the handler (the sweep's path): refused while another run holds it, taken again once it is older than the retry time. */
async function leaseHandler(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<AnyApprovalRecord | undefined> {
  const now = deps.now();
  // A lease younger than the retry time is someone else's.
  if (record.handlerClaimedAt !== undefined && record.handlerClaimedAt > iso(now - RETRY_MS)) return undefined;
  const names: Record<string, string> = { "#status": "status", "#done": "handlerDone", "#claimed": "handlerClaimedAt" };
  const values: Record<string, unknown> = { ":status": record.status, ":false": false, ":now": iso(now) };
  if (record.handlerClaimedAt !== undefined) values[":seen"] = record.handlerClaimedAt;
  const won = await commitOrLost(deps, [{
    Update: {
      TableName: deps.tableName, Key: approvalKey(record.orgId, record.approvalId), UpdateExpression: "SET #claimed = :now",
      ConditionExpression: `#status = :status AND #done = :false AND ${record.handlerClaimedAt === undefined ? "attribute_not_exists(#claimed)" : "#claimed = :seen"}`,
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    },
  }]);
  return won ? withFields(record, { handlerClaimedAt: iso(now) }) : undefined;
}

/** Ends an EXECUTING record (conditional on the claim it was driven under), recording the outcome and what is owed after it. */
async function finish(deps: ApprovalDependencies, record: AnyApprovalRecord, stamp: string, outcome: { status: "APPROVED_DONE" | "APPROVED_FAILED"; failure?: string; result?: WriteApprovalRecord["result"] }): Promise<AnyApprovalRecord | undefined> {
  const now = deps.now();
  const handler = hasHandlerPhase(record);
  const dueAt = iso(now + RETRY_MS);
  const fields = {
    status: outcome.status, failure: outcome.failure, result: outcome.result,
    handlerDone: !handler, ...(handler ? { handlerClaimedAt: iso(now), handlerDueAt: dueAt } : {}),
  };
  const events = record.kind === "write"
    ? await tryAuditEvents(deps, () => [auditWriteExecuted({
      orgId: record.orgId, actor: auditActorOf("system"), occurredAt: iso(now), occurrence: record.approvalId, approvalId: record.approvalId,
      connectorType: record.connectorType, tool: record.tool, status: outcome.status, argumentsHash: record.argumentsHash,
    })])
    : [];
  const items: TransactItem[] = [
    updateRecord(deps, record, fields, [["status", "EXECUTING"], ["executingAt", stamp]]),
    ...dueItems(deps, record, [iso(Date.parse(stamp) + RETRY_MS)], handler ? dueAt : undefined),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (!await commitOrLost(deps, items)) return undefined;
  await flushAuditEvents(deps, events);
  return withFields(record, fields);
}

/** Drives an EXECUTING record (claimed under `record.executingAt`) to its end. */
async function drive(deps: ApprovalDependencies, record: AnyApprovalRecord, executor: Executor): Promise<{ status: ApprovalStatus }> {
  const stamp = record.executingAt!;
  const result = await execute(deps, executor, record);
  let ended: AnyApprovalRecord | undefined;
  if (result.outcome === "done") ended = await finish(deps, record, stamp, { status: "APPROVED_DONE", ...(result.result === undefined ? {} : { result: result.result }) });
  else if (result.outcome === "failed") ended = await finish(deps, record, stamp, { status: "APPROVED_FAILED", failure: result.failure });
  else if ((record.attempts ?? 1) >= MAX_APPROVAL_ATTEMPTS) ended = await finish(deps, record, stamp, { status: "APPROVED_FAILED", failure: unconfirmedMessage(record) });
  else return { status: "EXECUTING" };
  if (ended === undefined) return { status: (await getAnyApproval(deps, record.orgId, record.approvalId))?.status ?? "EXECUTING" };
  if (hasHandlerPhase(ended)) await tellHandler(deps, ended);
  return { status: ended.status };
}

/**
 * Decides `record` as `caller`, for any kind. A repeat of the decision's own request id by the same person answers the stored outcome; else the caller
 * must satisfy the record's approvers now (`FORBIDDEN`), and it must still be PENDING (`APPROVAL_CLOSED`). The claim is one conditional transaction,
 * so of two decisions at once exactly one wins.
 */
export async function runApprovalDecision(deps: ApprovalDependencies, caller: ApprovalCaller, record: AnyApprovalRecord, rawBody: unknown, executor?: Executor, attempt = 0): Promise<{ status: ApprovalStatus }> {
  const body = parseDecideBody(rawBody);
  if (record.status !== "PENDING" && record.decisionRequestId === body.requestId && record.decidedBy !== undefined && await sameMember(deps, record.orgId, record.decidedBy, caller.developerId)) {
    return { status: record.status };
  }
  // The task is read BEFORE the check, and the claim is conditional on its owner being the one read here: a take-over that commits after this read fails the claim, so a
  // decision judged under the old owner never lands under the new one (12a review M-4). The check reads the task again, and is the one that decides.
  const fenceTask = record.kind === "change" ? undefined : await taskOfApproval(deps, record);
  const fence = fenceTask === undefined || tryEffectiveTaskOwner(fenceTask) === undefined ? undefined : { task: fenceTask, ...ownerFenceOf(fenceTask) };
  if (!await mayDecideApproval(deps, caller, record)) {
    const refusal = await approverRefusalFor(deps, record);
    throw agentXError(refusal?.code ?? "FORBIDDEN", refusal?.text ?? forbiddenText(record, (await runOfApproval(deps, record))?.owner.name ?? "the task owner"));
  }
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  // The sweep ends an approval whose time ran out only when it reaches it; until then the record is still PENDING, but it can no longer be decided (re-check N1).
  if (Date.parse(record.expiresAt) <= deps.now()) throw agentXError("APPROVAL_CLOSED", "this request has expired");
  await runApprovalDecisionGuards(deps, caller, record, body.decision);
  const run = executor ?? executorFor(record);
  if (record.kind === "write" && body.decision === "APPROVE" && deps.writeGate === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "writes by agents are not set up in this deployment");
  if (body.decision === "APPROVE" && run === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this kind of approval can't be decided in this deployment");

  const now = deps.now();
  const at = iso(now);
  const status: ApprovalStatus = body.decision === "DECLINE" ? "DECLINED" : record.kind === "step" ? "APPROVED" : "EXECUTING";
  const proof = decisionProofOf(caller);
  const handler = status !== "EXECUTING" && hasHandlerPhase(record);
  const fields = {
    status, decidedBy: caller.developerId, decidedAt: at, decision: body.decision, decisionRequestId: body.requestId, decisionProof: proof,
    ...(status === "EXECUTING" ? { executingAt: at, attempts: 1 } : {}),
    ...(status === "EXECUTING" ? {} : { handlerDone: !handler, ...(handler ? { handlerClaimedAt: at, handlerDueAt: iso(now + RETRY_MS) } : {}) }),
  };
  const events = await tryAuditEvents(deps, () => [auditApprovalDecided({
    orgId: record.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: record.approvalId, proof, approvalId: record.approvalId,
    kind: record.kind, decision: body.decision, subjectKind: record.subject.kind, ...(record.kind === "write" ? { class: record.class } : {}),
  })]);
  const items: TransactItem[] = [
    updateRecord(deps, record, fields, "pending", at),
    ...dueItems(deps, record, [record.expiresAt], status === "EXECUTING" || handler ? iso(now + RETRY_MS) : undefined),
    ...counterDrop(deps, record),
    ...approverDrops(deps, record),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (fence !== undefined) {
    items.push({
      ConditionCheck: {
        TableName: deps.tableName, Key: taskKey(fence.task.taskId), ConditionExpression: `attribute_exists(pk) AND ${fence.expression}`, ExpressionAttributeNames: fence.names,
        ...(Object.keys(fence.values).length === 0 ? {} : { ExpressionAttributeValues: fence.values }),
      },
    });
  }
  // The decider is still a member when the claim commits: a removal (or a demotion) that lands after the check and before the
  // claim fails it, so a click judged before it never counts after it.
  items.push(deciderStillMemberCheck(deps.tableName, record.orgId, caller.developerId));
  const claimed = await claim(deps, items, fence === undefined ? undefined : items.length - 2, items.length - 1);
  if (claimed === "forbidden") throw agentXError("FORBIDDEN", REMOVAL_FORBIDDEN_MESSAGE);
  if (claimed === "owner_changed") {
    // The owner changed between the check and the claim. Judge again under the new owner (the record is read again), a few times at most.
    const fresh = await getAnyApproval(deps, record.orgId, record.approvalId);
    if (fresh === undefined || fresh.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
    if (attempt >= OWNER_CHANGE_TRIES) throw agentXError("RUNTIME_UNAVAILABLE", "The task's owner keeps changing. Try again in a moment.");
    return runApprovalDecision(deps, caller, fresh, rawBody, executor, attempt + 1);
  }
  if (claimed === "lost") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  await flushAuditEvents(deps, events);

  const decided = withFields(record, fields);
  if (status === "EXECUTING") return drive(deps, decided, run!);
  if (handler) await tellHandler(deps, decided);
  return { status };
}

/** How many times a decision is judged again when the task's owner changes under it. */
const OWNER_CHANGE_TRIES = 3;

/** Commits the claim: `lost` when the record is no longer pending, `owner_changed` when only the owner fence (the item at `fenceAt`) failed. */
async function claim(deps: ApprovalDependencies, items: TransactItem[], fenceAt: number | undefined, deciderAt: number): Promise<"claimed" | "lost" | "owner_changed" | "forbidden"> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return "claimed";
  } catch (error) {
    if (errorNameOf(error) !== "TransactionCanceledException") throw error;
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
    if (reasons?.[0]?.Code === "ConditionalCheckFailed") return "lost";
    if (reasons?.[deciderAt]?.Code === "ConditionalCheckFailed") return "forbidden";
    if (fenceAt !== undefined && reasons?.[fenceAt]?.Code === "ConditionalCheckFailed") return "owner_changed";
    throw error;
  }
}

/** Decides an approval of any kind as `caller` (a write goes through the write driver, a step through the rule or the id check and then its subject's handler, a change through its handler). */
export async function decideApproval(deps: ApprovalDependencies, caller: ApprovalCaller, approvalId: string, body: unknown): Promise<{ status: ApprovalStatus }> {
  const id = ApprovalIdSchema.safeParse(approvalId);
  const record = id.success ? await getAnyApproval(deps, caller.orgId, id.data) : undefined;
  if (record === undefined) throw agentXError("NOT_FOUND", "approval not found");
  return runApprovalDecision(deps, caller, record, body);
}

// ---- the sweep

export interface ApprovalSweepReport {
  /** Records that expired, stuck ones driven again, handlers told, and items left alone because they failed (they are tried again next run). */
  expired: number;
  redriven: number;
  handled: number;
  failed: number;
  next?: string;
  stopped?: true;
}

/** Ends a PENDING record whose time has run out (conditional on it still being PENDING), freeing its place in its step, then tells its handler. */
async function expireOne(deps: ApprovalDependencies, record: AnyApprovalRecord, closed?: { reason: string }): Promise<AnyApprovalRecord | undefined> {
  const now = deps.now();
  const handler = hasHandlerPhase(record);
  const dueAt = iso(now + RETRY_MS);
  const fields = { status: "EXPIRED" as const, handlerDone: !handler, ...(handler ? { handlerClaimedAt: iso(now), handlerDueAt: dueAt } : {}), ...(closed === undefined ? {} : { closedBy: "system" as const, closedReason: closed.reason, closedAt: iso(now) }) };
  const events = await tryAuditEvents(deps, () => [auditApprovalExpired({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: iso(now), occurrence: record.approvalId, approvalId: record.approvalId, kind: record.kind, subjectKind: record.subject.kind,
  })]);
  const items: TransactItem[] = [
    updateRecord(deps, record, fields, "pending"),
    ...dueItems(deps, record, [record.expiresAt], handler ? dueAt : undefined),
    ...counterDrop(deps, record),
    ...approverDrops(deps, record),
    ...events.flatMap((event) => auditPending(deps, event)),
  ];
  if (!await commitOrLost(deps, items)) return undefined;
  await flushAuditEvents(deps, events);
  return withFields(record, fields);
}

/**
 * Ends a PENDING record now, as its time running out does (Task 22: a run that ended leaves nothing PENDING behind it). A record that is no longer PENDING is left
 * as it is. Its handler is told by the sweep, as for any expiry.
 */
export async function expireApprovalNow(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<boolean> {
  const current = await getAnyApproval(deps, record.orgId, record.approvalId);
  if (current === undefined || current.status !== "PENDING") return false;
  return await expireOne(deps, current) !== undefined;
}

/**
 * Ends a PENDING record now because nobody who could decide it is left (Plan 5 Task 21, review M-5): as its time running out does, with the reason on the record (`closedBy`
 * "system", `closedReason`, `closedAt`) for the person who asked to read. Its handler is told by the sweep. Never a decision. False when it was no longer PENDING.
 */
export async function expireApprovalWithReason(deps: ApprovalDependencies, record: AnyApprovalRecord, reason: string): Promise<boolean> {
  const current = await getAnyApproval(deps, record.orgId, record.approvalId);
  if (current === undefined || current.status !== "PENDING") return false;
  return await expireOne(deps, current, { reason }) !== undefined;
}

/** Drives a record that stayed EXECUTING past the retry time again: claimed by a conditional update of `executingAt`, so two sweeps never both run it. */
async function redrive(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<boolean> {
  const stamp = record.executingAt!;
  if ((record.attempts ?? 1) >= MAX_APPROVAL_ATTEMPTS) {
    const ended = await finish(deps, record, stamp, { status: "APPROVED_FAILED", failure: unconfirmedMessage(record) });
    if (ended !== undefined && hasHandlerPhase(ended)) await tellHandler(deps, ended);
    return ended !== undefined;
  }
  const executor = executorFor(record);
  if (executor === undefined) {
    log(deps, "approval.driver_missing", { orgId: record.orgId, approvalId: record.approvalId, kind: record.kind });
    return false;
  }
  const now = deps.now();
  const fields = { executingAt: iso(now), attempts: (record.attempts ?? 1) + 1 };
  const claimed = await commitOrLost(deps, [
    updateRecord(deps, record, fields, [["status", "EXECUTING"], ["executingAt", stamp]]),
    ...dueItems(deps, record, [iso(Date.parse(stamp) + RETRY_MS)], iso(now + RETRY_MS)),
  ]);
  if (!claimed) return false;
  await drive(deps, withFields(record, fields), executor);
  return true;
}

/**
 * One page of the open index (`OPEN_APPROVALS`: `<due time>#<org>#<id>`, ids only), up to `now`. For each due item the record decides what is owed:
 * a PENDING record past `expiresAt` becomes EXPIRED (its handler is told); an EXECUTING one more than APPROVAL_EXECUTING_RETRY_MINUTES past
 * `executingAt` is driven again (after 5 attempts it ends APPROVED_FAILED); a finished one whose handler never heard is told again. EXPIRY NEVER
 * TOUCHES AN EXECUTING RECORD. `cursor` is the sort key to start after; `options.deadline` stops the page before the next item once it has passed.
 */
export async function expireApprovals(deps: ApprovalDependencies, now: number, cursor?: string, options: { deadline?: number; limit?: number; redriveUntil?: number } = {}): Promise<ApprovalSweepReport> {
  const report: ApprovalSweepReport = { expired: 0, redriven: 0, handled: 0, failed: 0 };
  const until = iso(now);
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "OPEN_APPROVALS" }, ConsistentRead: true,
    Limit: options.limit ?? PAGE_LIMIT, ...(cursor === undefined ? {} : { ExclusiveStartKey: { pk: "OPEN_APPROVALS", sk: cursor } }),
  })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: { sk?: unknown } };
  let resumeAfter = cursor;
  const remove = (item: Record<string, unknown>) => deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } } }] }));
  for (const item of page.Items ?? []) {
    const sk = String(item["sk"]);
    const parts = DUE_SK.exec(sk);
    if (parts !== null && sk.slice(0, 24) > until) return report;
    if (options.deadline !== undefined && deps.now() >= options.deadline) return { ...report, ...(resumeAfter === undefined ? {} : { next: resumeAfter }), stopped: true };
    resumeAfter = sk;
    if (parts === null || item["orgId"] !== parts[2] || item["approvalId"] !== parts[3]) {
      log(deps, "approval.open_item_rejected", { reason: "malformed" });
      await remove(item);
      continue;
    }
    try {
      const record = await getAnyApproval(deps, parts[2] as OrgId, parts[3] as ApprovalId);
      if (record === undefined) {
        // Gone, or there but not readable: only a record that is truly absent loses its item (an unreadable one may still be PENDING and holding its place).
        const raw = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(parts[2] as OrgId, parts[3] as ApprovalId), ConsistentRead: true })) as { Item?: unknown };
        if (raw.Item === undefined) { await remove(item); continue; }
        report.failed += 1;
        log(deps, "approval.record_unreadable", { orgId: parts[2], approvalId: parts[3] });
        continue;
      }
      if (record.status === "PENDING") {
        // Not yet its time (this item is then the record's own expiry item, early by a clock's difference, or a stale one that the check below drops).
        if (Date.parse(record.expiresAt) <= now) {
          const ended = await expireOne(deps, record);
          if (ended !== undefined) {
            report.expired += 1;
            if (hasHandlerPhase(ended) && await tellHandler(deps, ended)) report.handled += 1;
          }
        }
      } else if (record.status === "EXECUTING") {
        if (record.executingAt !== undefined && Date.parse(record.executingAt) + RETRY_MS <= now) {
          // A re-drive can take as long as the connector's timeout: it starts only while that much of the function's time is left, else it waits for the next run.
          if (options.redriveUntil === undefined || deps.now() <= options.redriveUntil) {
            if (await redrive(deps, record)) report.redriven += 1;
          }
        }
      } else if (record.handlerDone !== true && hasHandlerPhase(record) && (record.handlerDueAt === undefined || Date.parse(record.handlerDueAt) <= now)) {
        const leased = await leaseHandler(deps, record);
        if (leased !== undefined && await tellHandler(deps, leased)) report.handled += 1;
      }
      // This item is kept only while it is still what the record is waiting on; a settled record, or one driven past this item's time, drops it.
      const after = await getAnyApproval(deps, parts[2] as OrgId, parts[3] as ApprovalId);
      const owed = after !== undefined && ((after.status === "PENDING" && iso(Date.parse(after.expiresAt)) === sk.slice(0, 24))
        || (after.status === "EXECUTING" && after.executingAt !== undefined && iso(Date.parse(after.executingAt) + RETRY_MS) === sk.slice(0, 24))
        || (hasHandlerPhase(after) && after.handlerDone !== true && after.status !== "EXECUTING" && after.status !== "PENDING" && (after.handlerDueAt === undefined || after.handlerDueAt === sk.slice(0, 24))));
      if (!owed) await remove(item);
    } catch (error) {
      report.failed += 1;
      log(deps, "approval.sweep_item_failed", { orgId: parts[2], approvalId: parts[3], error: errorNameOf(error) });
    }
  }
  const next = page.LastEvaluatedKey?.sk;
  return typeof next === "string" ? { ...report, next } : report;
}

const SWEEP_CURSOR_KEY = { pk: "SWEEP_CURSOR#approvals", sk: "META" } as const;

async function saveSweepCursor(deps: ApprovalDependencies, cursor: string | undefined): Promise<void> {
  try {
    await deps.documentClient.send(cursor === undefined
      ? new DeleteCommand({ TableName: deps.tableName, Key: SWEEP_CURSOR_KEY })
      : new PutCommand({ TableName: deps.tableName, Item: { ...SWEEP_CURSOR_KEY, entityType: "SWEEP_CURSOR", cursor, at: iso(deps.now()) } }));
  } catch (error) {
    // Only where the next run starts: losing it starts from the head of the index, which is correct, only less fair.
    log(deps, "approval.sweep_cursor_not_kept", { error: errorNameOf(error) });
  }
}

/**
 * The settlement job: pages of `expireApprovals` until the open index is read to now or `budgetMs` has passed. Where a run stopped is kept in a small item
 * (`SWEEP_CURSOR#approvals`), so the next run starts there instead of at the head of the index, and a run that reaches the end of the index goes round once
 * from the head to catch what sorted before the cursor. `options.pageSize` is the page's size (100 by default).
 */
export async function runApprovalSweep(deps: ApprovalDependencies, options: { budgetMs: number; pageSize?: number; redriveUntil?: number }): Promise<ApprovalSweepReport & { pages: number; complete: boolean }> {
  const deadline = deps.now() + options.budgetMs;
  const total = { expired: 0, redriven: 0, handled: 0, failed: 0, pages: 0, complete: false };
  const stored = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: SWEEP_CURSOR_KEY, ConsistentRead: true })) as { Item?: { cursor?: unknown } };
  let cursor = typeof stored.Item?.cursor === "string" && DUE_SK.test(stored.Item.cursor) ? stored.Item.cursor : undefined;
  let wrapped = cursor === undefined;
  for (;;) {
    if (deps.now() >= deadline) { await saveSweepCursor(deps, cursor); return total; }
    const page = await expireApprovals(deps, deps.now(), cursor, { deadline, ...(options.pageSize === undefined ? {} : { limit: options.pageSize }), ...(options.redriveUntil === undefined ? {} : { redriveUntil: options.redriveUntil }) });
    total.pages += 1;
    total.expired += page.expired;
    total.redriven += page.redriven;
    total.handled += page.handled;
    total.failed += page.failed;
    if (page.stopped === true) { await saveSweepCursor(deps, page.next ?? cursor); return total; }
    cursor = page.next;
    if (cursor === undefined) {
      if (!wrapped) { wrapped = true; continue; }
      await saveSweepCursor(deps, undefined);
      return { ...total, complete: true };
    }
  }
}
