// Live interaction A3: the audit of Asks (owner Q11). Enterprise: every Ask is one `task.asked` event, for the Auditor (ids, the audience, the context size and the model; never the question or the
// answer). Public: only a daily count per project: each Ask adds one to that project's counter for the day, and once the day is over `flushDailyAskCounts` writes ONE event per project and day from
// the counter. The event ids come from the Ask (Enterprise) or the project and day (Public), so a repeat of either writes nothing new.
import { UpdateCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, askCountKey, askCountPk, askAuditMode, type AskAudience, type OrgId } from "@agentx/contracts";
import { auditOccurrence, auditTaskAsked } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditDeps } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";

type Edition = "enterprise" | "public";
export interface AskAuditDependencies extends AuditDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

const DAY_MS = 86_400_000;
/** A day's counter lives three days: long enough for the flush to find it, short enough that it is not a record of who asked. */
const COUNT_TTL_SECONDS = 3 * 86_400;
/** How many finished days the flush looks back over. */
const FLUSH_LOOKBACK_DAYS = 3;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export interface AskedFacts {
  edition: Edition;
  orgId: OrgId;
  sessionId: string;
  askId: string;
  audience: AskAudience;
  contextBytes: number;
  model: string;
  /** The asker when they are a member; absent for an outsider (the event then names the system). */
  askedBy?: string | undefined;
  projectName: string;
  nowMs: number;
}

/** Records one Ask for the audit. Never throws (the Ask is already answered); a failure leaves no event and logs only a name. */
export async function auditAsk(deps: AskAuditDependencies, facts: AskedFacts): Promise<void> {
  try {
    if (askAuditMode(facts.edition) === "each") {
      const events = await tryAuditEvents(deps, () => [auditTaskAsked({
        scope: "each", orgId: facts.orgId, actor: auditActorOf(facts.askedBy ?? "system"), occurredAt: new Date(facts.nowMs).toISOString(), occurrence: facts.askId,
        sessionId: facts.sessionId, askId: facts.askId, audience: facts.audience, contextBytes: facts.contextBytes, model: facts.model,
      })]);
      const items = events.flatMap((event) => auditPending(deps, event));
      if (items.length > 0) await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      await flushAuditEvents(deps, events);
      return;
    }
    // Public: a counter per project and day. An Ask is counted once (its id is in the item's set), so a redelivered answer does not count twice.
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: askCountKey(facts.orgId, dayOf(facts.nowMs), facts.projectName),
      UpdateExpression: "SET entityType = :type, orgId = :org, projectName = :project, #day = :day, #expires = :expires ADD #count :one",
      ExpressionAttributeNames: { "#count": "count", "#day": "day", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":type": "ASK_COUNT", ":org": facts.orgId, ":project": facts.projectName, ":day": dayOf(facts.nowMs), ":expires": Math.floor(facts.nowMs / 1000) + COUNT_TTL_SECONDS, ":one": 1 },
    }));
  } catch (error) {
    deps.audit?.log({ event: "ask.audit_failed", level: "warn", error: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * Writes the daily count events of the days that are over (Public): one `task.asked` per project and day, with the day's count, never before the day has ended. Idempotent (the event id is the project
 * and day). Bounded: a page of each day's projects. Returns how many events it wrote. Call it at least daily, beside `sweepExpiredAsks`.
 */
export async function flushDailyAskCounts(deps: AskAuditDependencies, edition: Edition, orgId: OrgId, nowMs: number): Promise<number> {
  if (askAuditMode(edition) !== "daily_count") return 0;
  let written = 0;
  for (let back = 1; back <= FLUSH_LOOKBACK_DAYS; back += 1) {
    const day = dayOf(nowMs - back * DAY_MS);
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": askCountPk(orgId, day) }, Limit: 200, ConsistentRead: true,
    })) as { Items?: Array<Record<string, unknown>> };
    for (const item of response.Items ?? []) {
      const project = item["projectName"];
      const count = item["count"];
      if (typeof project !== "string" || typeof count !== "number" || count < 1) continue;
      const events = await tryAuditEvents(deps, () => [auditTaskAsked({
        scope: "daily", orgId, actor: auditActorOf("system"), occurredAt: `${day}T23:59:59.000Z`, occurrence: auditOccurrence(project, day), projectName: project, count,
      })]);
      const items = events.flatMap((event) => auditPending(deps, event));
      if (items.length === 0) continue;
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      await flushAuditEvents(deps, events);
      written += events.length;
    }
  }
  return written;
}
