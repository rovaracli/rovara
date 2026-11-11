// Rovara Code (Plan 6 Task 1): the milestone hook. A milestone ("questions", "plan_ready", "pr_ready", "merged", ...) is one item in the task's partition, written in
// the same transaction as the change that caused it (`codeMilestoneItems`), together with a line on the task's session. After the commit, `deliverCodeMilestones` tells
// every handler registered with `registerCodeMilestoneHandler` (Plan 9 posts to Slack and Linear from them); a handler that was not told, or threw, is told again by
// the dispatch sweep (`deliverDueCodeMilestones`), at most `CODE_MILESTONE_ATTEMPTS_MAX` times. A handler can be told twice (the process can stop between the handler
// returning and the record being written), so it must be safe to hear a milestone again.
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { CODE_MILESTONES_BEFORE_PR, CodeMilestoneSchema, INDEX_EXPIRY_ATTRIBUTE, WORKFLOW_DISPATCH_DUE_INDEX, codeMilestoneKey, sessionEventId, type CodeMilestone, type CodeMilestoneKind } from "@rovara-code/contracts";
import { NOT_EXISTS, errorName, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { sessionEventItem } from "../agent-sessions/store.js";

/** How many times one handler is told one milestone before the broker gives up on it. */
export const CODE_MILESTONE_ATTEMPTS_MAX = 5;
/** The sweep's partition in the due-time index (`dispatchDuePk`), apart from the dispatch rows' and the plan evidence rows'. */
export const CODE_MILESTONE_DUE_PK = "CODE_MILESTONE";
/** How long a handler's claim on a milestone holds; a process that dies mid-run holds it no longer. */
export const CODE_MILESTONE_LEASE_MS = 60_000;
/** A failed handler is told again after this long, times the attempts so far. */
export const CODE_MILESTONE_RETRY_MS = 60_000;
/** A milestone is kept this long after it happened (the table's expiry). */
const CODE_MILESTONE_RETENTION_SECONDS = 30 * 86_400;
const SWEEP_LIMIT = 25;
const KEY_PREFIX = "CODE_MILESTONE#";

export interface CodeMilestoneDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export interface CodeMilestoneHandler {
  /** Lowercase letters, digits and underscores: the name is part of the attributes that record what the handler was told. */
  name: string;
  on(deps: CodeMilestoneDependencies, milestone: CodeMilestone): Promise<void>;
}

const handlers: CodeMilestoneHandler[] = [];

/** Registers a handler for every milestone. Register at module start, in the same Lambda that runs the sweep: a milestone written while no handler is registered is marked delivered and a handler registered later never hears it. Handlers are told in the order registered. Returns the function that removes it again (tests use it; a deployment registers once at start-up). */
export function registerCodeMilestoneHandler(handler: CodeMilestoneHandler): () => void {
  if (!/^[a-z][a-z0-9_]{0,30}$/u.test(handler.name)) throw new Error("a milestone handler's name is lowercase letters, digits and underscores");
  if (handlers.some((existing) => existing.name === handler.name)) throw new Error("a milestone handler with this name is already registered");
  handlers.push(handler);
  return () => {
    const at = handlers.indexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}

/** Whether a milestone of this kind is written for a task of this definition version: before the pull request only for 1.1.0, so version 1 records stay as they were. */
export function codeMilestoneWrittenFor(kind: CodeMilestoneKind, definitionVersion: string): boolean {
  return definitionVersion !== "1.0.0" || !CODE_MILESTONES_BEFORE_PR.includes(kind);
}

/** A due time as an index sort key: fixed width, so text order is time order. */
const dueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");

/**
 * The items that record the `n`th milestone of its kind: a Put that only succeeds when absent, and, when the milestone names a session, one line on that session's
 * timeline (the same line again on a repeat). Add them to the transaction of the change that caused the milestone. A milestone before the pull request needs
 * `options.definitionVersion` (it throws without), and one that version does not get gives no items.
 */
export function codeMilestoneItems(table: Pick<TableInput, "tableName">, milestone: CodeMilestone, n: number, options: { definitionVersion?: string } = {}): TransactItem[] {
  const clean = CodeMilestoneSchema.parse(milestone);
  // Fail closed: a milestone before the pull request is written only for a 1.1.0 task, so a caller that does not say which version the task is does not get to guess.
  if (options.definitionVersion === undefined && CODE_MILESTONES_BEFORE_PR.includes(clean.kind)) {
    throw new Error(`a ${clean.kind} milestone needs the task's definition version`);
  }
  if (options.definitionVersion !== undefined && !codeMilestoneWrittenFor(clean.kind, options.definitionVersion)) return [];
  const key = codeMilestoneKey(clean.taskId, clean.kind, n);
  const at = Date.parse(clean.at);
  const put: TransactItem = {
    Put: {
      TableName: table.tableName,
      Item: {
        ...key, entityType: "CODE_MILESTONE", n, ...clean,
        dispatchDuePk: CODE_MILESTONE_DUE_PK, dispatchDueSk: `${dueKey(at)}#${key.pk}#${key.sk}`,
        [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + CODE_MILESTONE_RETENTION_SECONDS,
      },
      ConditionExpression: NOT_EXISTS,
    },
  };
  if (clean.sessionId === undefined) return [put];
  const event = sessionEventItem(table, { orgId: clean.orgId, sessionId: clean.sessionId }, {
    eventId: sessionEventId("code_milestone", `${clean.taskId}\n${clean.kind}\n${String(n)}`), at: clean.at, type: "status", actor: { kind: "system" }, text: clean.text,
  });
  return [put, event];
}

type Item = Record<string, unknown>;

const log = (deps: Pick<CodeMilestoneDependencies, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);

async function milestonesOf(deps: CodeMilestoneDependencies, taskId: string): Promise<Item[]> {
  const found: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": KEY_PREFIX }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    found.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

const milestoneOf = (item: Item): CodeMilestone | undefined => {
  const parsed = CodeMilestoneSchema.safeParse({
    kind: item["kind"], orgId: item["orgId"], taskId: item["taskId"], at: item["at"], text: item["text"],
    ...(item["sessionId"] === undefined ? {} : { sessionId: item["sessionId"] }),
    ...(item["pullRequests"] === undefined ? {} : { pullRequests: item["pullRequests"] }),
    ...(item["bindings"] === undefined ? {} : { bindings: item["bindings"] }),
    ...(item["to"] === undefined ? {} : { to: item["to"] }),
  });
  return parsed.success ? parsed.data : undefined;
};

async function update(deps: CodeMilestoneDependencies, item: Item, input: { expression: string; condition: string; names?: Record<string, string>; values?: Record<string, unknown> }): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] }, UpdateExpression: input.expression, ConditionExpression: input.condition,
      ...(input.names === undefined ? {} : { ExpressionAttributeNames: input.names }), ...(input.values === undefined ? {} : { ExpressionAttributeValues: input.values }),
    }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/**
 * Tells the registered handlers each milestone of the task they have not yet heard. A handler takes a claim on the milestone first (a lease and an attempt counted
 * in one conditional write), so two deliveries that meet tell it once; a handler that threw is told again by the next delivery, until it has had
 * `CODE_MILESTONE_ATTEMPTS_MAX` attempts. A milestone every handler has heard or been given up on leaves the sweep's index. Never throws for a handler's failure.
 */
export async function deliverCodeMilestones(deps: CodeMilestoneDependencies, taskId: string): Promise<void> {
  const registered = [...handlers];
  for (const item of await milestonesOf(deps, taskId)) {
    if (item["deliveredAt"] !== undefined) continue;
    const milestone = item["taskId"] === taskId ? milestoneOf(item) : undefined;
    if (milestone === undefined) {
      log(deps, "code_milestone.unreadable", { taskId });
      await update(deps, item, { expression: "SET deliveredAt = :now REMOVE dispatchDuePk, dispatchDueSk", condition: "attribute_exists(pk) AND attribute_not_exists(deliveredAt)", values: { ":now": new Date(deps.now()).toISOString() } });
      continue;
    }
    let settled = true;
    let attempts = 0;
    for (const handler of registered) {
      const [tries, done, lease] = [`tries_${handler.name}`, `done_${handler.name}`, `lease_${handler.name}`];
      let used = typeof item[tries] === "number" ? item[tries] : 0;
      if (item[done] !== true && used < CODE_MILESTONE_ATTEMPTS_MAX) {
        const now = deps.now();
        const names = { "#tries": tries, "#done": done, "#lease": lease };
        const claimed = await update(deps, item, {
          expression: "SET #lease = :until ADD #tries :one",
          condition: "attribute_exists(pk) AND attribute_not_exists(#done) AND (attribute_not_exists(#lease) OR #lease < :now) AND (attribute_not_exists(#tries) OR #tries < :max)",
          names, values: { ":until": now + CODE_MILESTONE_LEASE_MS, ":now": now, ":one": 1, ":max": CODE_MILESTONE_ATTEMPTS_MAX },
        });
        if (!claimed) {
          settled = false;
          continue;
        }
        used += 1;
        try {
          await handler.on(deps, milestone);
          await update(deps, item, { expression: "SET #done = :yes REMOVE #lease", condition: "attribute_exists(pk)", names: { "#done": done, "#lease": lease }, values: { ":yes": true } });
          continue;
        } catch (error) {
          log(deps, "code_milestone.handler_failed", { taskId, kind: milestone.kind, handler: handler.name, attempt: used, error: error instanceof Error ? error.name : "unknown" });
          await update(deps, item, { expression: "REMOVE #lease", condition: "attribute_exists(pk)", names: { "#lease": lease } });
        }
      }
      if (item[done] !== true && used < CODE_MILESTONE_ATTEMPTS_MAX) {
        settled = false;
        attempts = Math.max(attempts, used);
      }
    }
    const key = { pk: item["pk"], sk: item["sk"] };
    if (settled) {
      await update(deps, item, { expression: "SET deliveredAt = :now REMOVE dispatchDuePk, dispatchDueSk", condition: "attribute_exists(pk) AND attribute_not_exists(deliveredAt)", values: { ":now": new Date(deps.now()).toISOString() } });
    } else {
      await update(deps, item, {
        expression: "SET dispatchDueSk = :due", condition: "attribute_exists(pk) AND attribute_not_exists(deliveredAt)",
        values: { ":due": `${dueKey(deps.now() + CODE_MILESTONE_RETRY_MS * Math.max(1, attempts))}#${String(key.pk)}#${String(key.sk)}` },
      });
    }
  }
}

/**
 * The sweep: up to 25 milestones that are due, oldest first, from the due-time index under `CODE_MILESTONE_DUE_PK`. Each task's milestones are delivered as
 * after a commit. The index is eventually consistent; a row read just as it changed is only delivered again later, which the claims make harmless.
 */
export async function deliverDueCodeMilestones(deps: CodeMilestoneDependencies): Promise<{ attempted: number }> {
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, IndexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
    KeyConditionExpression: `${WORKFLOW_DISPATCH_DUE_INDEX.partitionKey} = :pk AND ${WORKFLOW_DISPATCH_DUE_INDEX.sortKey} BETWEEN :from AND :due`,
    // ":" sorts after the "#" that follows each due time, so `${due(now)}:` includes every row due at or before now.
    ExpressionAttributeValues: { ":pk": CODE_MILESTONE_DUE_PK, ":from": "0", ":due": `${dueKey(deps.now())}:` }, Limit: SWEEP_LIMIT,
  })) as { Items?: Item[] };
  const rows = page.Items ?? [];
  const tasks = new Set(rows.map((row) => row["taskId"]).filter((id): id is string => typeof id === "string"));
  for (const taskId of tasks) {
    try {
      await deliverCodeMilestones(deps, taskId);
    } catch (error) {
      log(deps, "code_milestone.sweep_failed", { taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { attempted: rows.length };
}
