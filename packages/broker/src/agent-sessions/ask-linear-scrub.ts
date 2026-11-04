// Lane ask-linear: the comments Rovara posted on Linear issues that hold the name of a person who was erased. `eraseAskPerson` (ask-erase.ts) scrubs the stored Ask and leaves a waiting item for each of its Linear
// comments (ids only, in the org's `ASKLINEARFIX` partition). The Ask upkeep (`runAskMaintenance`) calls `settleLinearScrubs`: it rewrites the comment from the Ask's already-scrubbed record, or deletes the
// comment when there is no scrubbed text to rewrite it from, and removes the waiting item. Only comments Rovara's own account wrote are touched (the port checks the author).
//
// What a rewrite is (S3): the text is built from the STORED Ask, where the writer has already replaced the name of every person of the session (not only the erased one) with a person tag (`person p_a1b2c3`) and
// the erased person's mention with `@former-member`. So a rewrite also turns the other people's names in the public comment into opaque tags. That is safe, though it can read oddly. The words that were posted
// are not stored (by design), so rewriting only the erased person's name in a copy of them is not possible.
//
// Timing: every waiting item of the org is visited in one run, in key order, within a time budget; a run that runs out of time keeps where it stopped (a cursor item) and the next run goes on from there and
// wraps round, so an item that keeps failing cannot hold the others back and nothing waits behind a page of 25. A failing item is tried once per run and given up on after `LINEAR_SCRUB_ATTEMPTS` runs.
//
// A comment that could not be rewritten when the tries ran out is NOT dropped quietly (B1): a lasting record is written (an `ASKLINEARKEPT` item an admin can read, and an `ask.linear_comment_kept` audit
// event), with ids, a fixed reason word and the count only. A comment counts as gone only on Linear's real not-found answer (linear-write.ts); every other fault keeps the item and retries.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, askLinearKeptKey, askLinearScrubPk, sessionAskKey, type OrgId } from "@agentx/contracts";
import { auditAskLinearCommentKept, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { linearAnswerText } from "./ask.js";
import { askRecordFromItem, type AskItem, type AskStoreTable } from "./ask-erase.js";

export const LINEAR_SCRUB_ATTEMPTS = 10;
/** The most time one run spends on one org's waiting items. */
export const LINEAR_SCRUB_BUDGET_MS = 20_000;
const PAGE = 50;
const CURSOR_SK = "CURSOR";
/** How long the lasting record of a comment that could not be rewritten is kept. */
const KEPT_TTL_SECONDS = 400 * 86_400;

/** What the upkeep needs of Linear: both calls refuse a comment that is not Rovara's own. */
export interface LinearScrubPort {
  /** `workspace` is the Linear workspace the comment was posted in, when the post recorded it (AL-1): only a connection to it can say the comment is gone. */
  update(input: { orgId: OrgId; commentId: string; text: string; workspace?: string | undefined }): Promise<void>;
  remove(input: { orgId: OrgId; commentId: string; workspace?: string | undefined }): Promise<void>;
}

export interface LinearScrubDependencies extends AskStoreTable {
  port: LinearScrubPort;
  /** The audit outbox, for the event that records a give-up. Absent: the lasting item is still written. */
  audit?: AuditRuntime;
  /** The time budget of one run (default `LINEAR_SCRUB_BUDGET_MS`) and the clock it is measured on. */
  budgetMs?: number | undefined;
  clock?: (() => number) | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface LinearScrubResult { rewritten: number; removed: number; waiting: number; gaveUp: number; complete: boolean }

const codeOf = (error: unknown): string | undefined => (typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined);

/** The fixed word that says why a comment could not be rewritten. */
const reasonOf = (code: string | undefined): "not_rovaras" | "no_connection" | "unavailable" =>
  code === "FORBIDDEN" ? "not_rovaras" : code === "CONFIG_INVALID" ? "no_connection" : "unavailable";

export async function settleLinearScrubs(deps: LinearScrubDependencies, orgId: OrgId): Promise<LinearScrubResult> {
  const result: LinearScrubResult = { rewritten: 0, removed: 0, waiting: 0, gaveUp: 0, complete: true };
  const pk = askLinearScrubPk(orgId);
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + (deps.budgetMs ?? LINEAR_SCRUB_BUDGET_MS);
  const cursorKey = { pk, sk: CURSOR_SK };
  const cursor = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: cursorKey, ConsistentRead: true }))) as { Item?: AskItem }).Item;
  const startSk = typeof cursor?.["after"] === "string" ? cursor["after"] : undefined;
  const done = (item: AskItem) => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));

  /** Settles one item. Answers "stop" when Linear asked to slow down (the rest waits for the next run). */
  const settle = async (item: AskItem): Promise<"next" | "stop"> => {
    const sessionId = item["sessionId"], askId = item["askId"], commentId = item["commentId"];
    // AL-1: the workspace the comment was posted in goes with it, so another workspace's connection can never read it as gone.
    const workspace = typeof item["workspace"] === "string" && item["workspace"] !== "" ? item["workspace"] : undefined;
    if (item["orgId"] !== orgId || typeof commentId !== "string" || commentId === "" || typeof sessionId !== "string" || typeof askId !== "string") { await done(item); return "next"; }
    try {
      const found = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: sessionAskKey(orgId, sessionId, askId), ConsistentRead: true }))) as { Item?: AskItem }).Item;
      const record = found?.["orgId"] === orgId ? askRecordFromItem(found) : undefined;
      if (record?.answer !== undefined && record.answer.trim() !== "") {
        await deps.port.update({ orgId, commentId, text: linearAnswerText(record.answer), ...(workspace === undefined ? {} : { workspace }) });
        result.rewritten += 1;
      } else {
        // No scrubbed words to put back (the Ask is gone, or kept none): the comment goes.
        await deps.port.remove({ orgId, commentId, ...(workspace === undefined ? {} : { workspace }) });
        result.removed += 1;
      }
      await done(item);
      return "next";
    } catch (error) {
      const code = codeOf(error);
      // Linear's real "no such comment" (the port says so only then): done.
      if (code === "NOT_FOUND") { await done(item); return "next"; }
      // Linear asked Rovara to slow down: this is not the item's fault. It is not counted; the run stops and the next one goes on from here.
      if (code === "TOO_MANY_REQUESTS") { deps.log?.({ event: "ask.linear_scrub_rate_limited", orgId }); result.waiting += 1; return "stop"; }
      const attempts = (typeof item["attempts"] === "number" ? item["attempts"] : 0) + 1;
      if (attempts >= LINEAR_SCRUB_ATTEMPTS) {
        if (await giveUp(item, sessionId, askId, reasonOf(code), attempts)) { result.gaveUp += 1; return "next"; }
        // The lasting record could not be written: the item stays and is given up on again at the next run.
      }
      deps.log?.({ event: "ask.linear_scrub_waiting", orgId, attempts, code: code ?? "unknown" });
      await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] }, UpdateExpression: "SET attempts = :n", ExpressionAttributeValues: { ":n": attempts } })).catch(() => undefined);
      result.waiting += 1;
      return "next";
    }
  };

  /** Writes the lasting record (the item an admin reads and the audit event) and removes the waiting item, in one transaction. False when it could not. */
  const giveUp = async (item: AskItem, sessionId: string, askId: string, reason: string, attempts: number): Promise<boolean> => {
    try {
      const nowMs = clock();
      const events = deps.audit === undefined ? [] : await tryAuditEvents(deps, () => [auditAskLinearCommentKept({
        orgId, actor: auditActorOf("system"), occurredAt: new Date(nowMs).toISOString(), occurrence: auditOccurrence(askId, "linear-comment-kept"), sessionId, askId, reason, attempts,
      })]);
      const kept = { ...askLinearKeptKey(orgId, sessionId, askId), entityType: "ASK_LINEAR_KEPT", orgId, sessionId, askId, issueKey: item["issueKey"], reason, attempts, at: new Date(nowMs).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + KEPT_TTL_SECONDS };
      const audited = deps.audit === undefined ? [] : events.flatMap((event) => auditPending(deps, event));
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: deps.tableName, Item: kept } },
        { Delete: { TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } } },
        ...audited,
      ] as never }));
      if (deps.audit !== undefined) await flushAuditEvents(deps, events).catch(() => undefined);
      deps.log?.({ event: "ask.linear_scrub_gave_up", orgId, attempts, reason });
      return true;
    } catch (error) {
      deps.log?.({ event: "ask.linear_scrub_gave_up_not_recorded", orgId, error: error instanceof Error ? error.name : "unknown" });
      return false;
    }
  };

  /** Visits the partition in key order from `after` (exclusive) while `inside` holds for the item's key. Answers the last key it settled, or "end" when the pass reached its end. */
  const pass = async (after: string | undefined, inside: (sk: string) => boolean): Promise<{ last?: string; stopped: boolean }> => {
    let start: Record<string, unknown> | undefined = after === undefined ? undefined : { pk, sk: after };
    let last: string | undefined;
    for (;;) {
      const page = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, Limit: PAGE, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) })) as { Items?: AskItem[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        const sk = String(item["sk"]);
        if (sk === CURSOR_SK) continue;
        if (!inside(sk)) return { ...(last === undefined ? {} : { last }), stopped: false };
        if (clock() >= deadline) return { ...(last === undefined ? {} : { last }), stopped: true };
        const next = await settle(item);
        // A stop (Linear said "slow down") leaves this item to be the first of the next run.
        if (next === "stop") return { ...(last === undefined ? {} : { last }), stopped: true };
        last = sk;
      }
      if (page.LastEvaluatedKey === undefined) return { ...(last === undefined ? {} : { last }), stopped: false };
      start = page.LastEvaluatedKey;
    }
  };

  // From where the last run stopped to the end, then round to the beginning up to that point.
  let resumeAfter: string | undefined = startSk;
  const first = await pass(startSk, () => true);
  let stoppedAt = first.stopped ? (first.last ?? startSk ?? "") : undefined;
  if (!first.stopped && startSk !== undefined) {
    const second = await pass(undefined, (sk) => sk <= startSk);
    if (second.stopped) stoppedAt = second.last ?? "";
  }
  result.complete = stoppedAt === undefined;
  if (stoppedAt === undefined) {
    // Everything was visited: the next run starts at the beginning again.
    if (resumeAfter !== undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: cursorKey })).catch(() => undefined);
  } else {
    resumeAfter = stoppedAt === "" ? undefined : stoppedAt;
    if (resumeAfter === undefined) await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: cursorKey })).catch(() => undefined);
    else await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...cursorKey, entityType: "ASK_LINEAR_FIX_CURSOR", orgId, after: resumeAfter, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(clock() / 1000) + 30 * 86_400 } }));
  }
  return result;
}
