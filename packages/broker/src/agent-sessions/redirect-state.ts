// Stop & redirect, the stored state (live-interaction design 3.1). Three kinds of item, all about ids, counts, revisions and states, never the owner's instruction (it lives in the steer message and its note):
//   - `REDIRECT#<requestId>` on the task's partition: the record `RedirectRecordSchema` describes, written in phase 1's transaction and ended by exactly one of the phase 2 outcomes;
//   - `REDIRECT_OPEN` / `<taskId>`: the one redirect in flight for a task. It is the guard (a second redirect finds it and is refused), the single read the terminal-result hook makes (no search of the
//     task's items), and the list the sweep walks to close a redirect nobody finished;
//   - the counters of the rates (5 redirects per task per hour, 3 per step attempt), conditional on the count that was read, so two requests cannot both take the last place.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, REDIRECT_ITEM_TTL_SECONDS, RedirectRecordSchema, type OrgId, type RedirectRecord, type RedirectState } from "@agentx/contracts";
import { failedIndexes, type Item, type TransactItem } from "../agents/table-writes.js";

export interface RedirectStateDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

export const REDIRECT_OPEN_PK = "REDIRECT_OPEN";
export const redirectKey = (taskId: string, requestId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `REDIRECT#${requestId}` });
export const redirectOpenKey = (taskId: string) => ({ pk: REDIRECT_OPEN_PK, sk: taskId });
const HOUR_COUNTER = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "REDIRECT_RATE#HOUR" });
const STEP_COUNTER = (taskId: string, step: string, attempt: number) => ({ pk: `DEVTASK#${taskId}`, sk: `REDIRECT_RATE#STEP#${step}#${String(attempt)}` });

const secondsOf = (ms: number) => Math.floor(ms / 1000);
const HOUSEKEEPING = new Set(["pk", "sk", "entityType", INDEX_EXPIRY_ATTRIBUTE]);

const getItem = async (deps: Pick<RedirectStateDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** The two items phase 1 writes: the record and the in-flight marker. The marker's condition is what refuses a second redirect while one is being carried out. */
export function redirectCreateItems(deps: Pick<RedirectStateDependencies, "tableName">, record: RedirectRecord): { record: TransactItem; open: TransactItem } {
  const expires = record.ttl;
  return {
    record: { Put: { TableName: deps.tableName, Item: { ...redirectKey(record.taskId, record.requestId), entityType: "REDIRECT", ...record, [INDEX_EXPIRY_ATTRIBUTE]: expires }, ConditionExpression: "attribute_not_exists(pk)" } },
    open: {
      Put: {
        TableName: deps.tableName,
        Item: { ...redirectOpenKey(record.taskId), entityType: "REDIRECT_OPEN", orgId: record.orgId, taskId: record.taskId, requestId: record.requestId, sessionId: record.sessionId, createdAt: record.createdAt, [INDEX_EXPIRY_ATTRIBUTE]: expires },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
  };
}

/** The ttl a new record carries (epoch seconds). */
export const redirectTtl = (nowMs: number): number => secondsOf(nowMs) + REDIRECT_ITEM_TTL_SECONDS;

/** A stored record, or undefined when it is not there or does not parse (a record that does not read is never acted on). */
export async function readRedirect(deps: RedirectStateDependencies, taskId: string, requestId: string): Promise<RedirectRecord | undefined> {
  const item = await getItem(deps, redirectKey(taskId, requestId));
  if (item === undefined) return undefined;
  const parsed = RedirectRecordSchema.safeParse(Object.fromEntries(Object.entries(item).filter(([key]) => !HOUSEKEEPING.has(key))));
  return parsed.success && parsed.data.taskId === taskId ? parsed.data : undefined;
}

export interface OpenRedirect { orgId: OrgId; taskId: string; requestId: string; sessionId: string; createdAt: string }

function openOf(item: Item | undefined): OpenRedirect | undefined {
  if (item === undefined || item["entityType"] !== "REDIRECT_OPEN") return undefined;
  const { orgId, taskId, requestId, sessionId, createdAt } = item;
  if (typeof orgId !== "string" || typeof taskId !== "string" || typeof requestId !== "string" || typeof sessionId !== "string" || typeof createdAt !== "string") return undefined;
  return { orgId, taskId, requestId, sessionId, createdAt };
}

/** The redirect in flight for a task: one strongly consistent read. */
export async function readOpenRedirect(deps: RedirectStateDependencies, taskId: string): Promise<OpenRedirect | undefined> {
  return openOf(await getItem(deps, redirectOpenKey(taskId)));
}

/** The redirects in flight, oldest first by their id order, at most `limit` (the sweep reads a page). */
export async function listOpenRedirects(deps: RedirectStateDependencies, limit: number): Promise<OpenRedirect[]> {
  const found: OpenRedirect[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": REDIRECT_OPEN_PK }, ConsistentRead: true, Limit: limit,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const open = openOf(item);
      if (open !== undefined && found.length < limit) found.push(open);
    }
    start = found.length >= limit ? undefined : page.LastEvaluatedKey;
  } while (start !== undefined);
  return found;
}

/**
 * Takes the right to restart: `stopping` becomes `restarting`, conditional on `stopping`. Of two hooks that find the same stopped step, one wins; the other gets `false` and does nothing, so a step is
 * never restarted twice. Answers whether this call took it.
 */
export async function claimRedirect(deps: RedirectStateDependencies, record: Pick<RedirectRecord, "taskId" | "requestId">): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{
      Update: {
        TableName: deps.tableName, Key: redirectKey(record.taskId, record.requestId), UpdateExpression: "SET #state = :restarting, claimedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #state = :stopping", ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":restarting": "restarting", ":stopping": "stopping", ":now": new Date(deps.now()).toISOString() },
      },
    }] }));
    return true;
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    return false;
  }
}

/**
 * The items that end a redirect: its state becomes `to` (conditional on being one of `from`) and the in-flight marker goes (conditional on being this redirect's). For the transaction of the
 * restart itself, so the step starts and the redirect ends together, or neither does.
 */
export function redirectEndItems(deps: Pick<RedirectStateDependencies, "tableName">, record: Pick<RedirectRecord, "taskId" | "requestId">, from: readonly RedirectState[], to: RedirectState): TransactItem[] {
  return [
    {
      Update: {
        TableName: deps.tableName, Key: redirectKey(record.taskId, record.requestId), UpdateExpression: "SET #state = :to",
        ConditionExpression: `attribute_exists(pk) AND (${from.map((_, index) => `#state = :from${String(index)}`).join(" OR ")})`, ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":to": to, ...Object.fromEntries(from.map((state, index) => [`:from${String(index)}`, state])) },
      },
    },
    { Delete: { TableName: deps.tableName, Key: redirectOpenKey(record.taskId), ConditionExpression: "attribute_exists(pk) AND requestId = :id", ExpressionAttributeValues: { ":id": record.requestId } } },
  ];
}

/** Ends a redirect on its own (with `extra` items in the same transaction, such as its audit item): `true` when this call ended it, `false` when another call had (the state was not one of `from`). */
export async function endRedirect(deps: RedirectStateDependencies, record: Pick<RedirectRecord, "taskId" | "requestId">, from: readonly RedirectState[], to: RedirectState, extra: readonly TransactItem[] = []): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...redirectEndItems(deps, record, from, to), ...extra] }));
    return true;
  } catch (error) {
    if (failedIndexes(error) === undefined) throw error;
    return false;
  }
}

/**
 * A Stop wins over a redirect that is still `stopping` (fix round 1, B1): the person pressed Stop after redirecting, so the step must stay stopped. Called by the task's cancel (the one Stop,
 * the session's Stop and the task route all run) before it asks for the stop, with the request id of that cancel: the redirect's own cancel has the redirect's request id and does not end itself.
 * Ends the open redirect `failed` and removes its marker, conditional on it still being `stopping`; a redirect already being restarted (`restarting`) is left to its restart, whose run the Stop then
 * cancels like any running step. Never throws. Answers whether it ended one.
 */
export async function endRedirectForStop(deps: RedirectStateDependencies, taskId: string, cancelRequestId: string): Promise<boolean> {
  try {
    const open = await readOpenRedirect(deps, taskId);
    if (open === undefined || open.requestId === cancelRequestId) return false;
    return await endRedirect(deps, { taskId, requestId: open.requestId }, ["stopping"], "failed");
  } catch {
    // A redirect that could not be ended here is ended by the sweep; the Stop is not failed for it.
    return false;
  }
}

// ---- the rates

export interface CounterStep { room: boolean; count: number; item: TransactItem }

async function counterStep(deps: RedirectStateDependencies, key: { pk: string; sk: string }, orgId: OrgId, limit: number, nowMs: number, windowMs: number | undefined): Promise<CounterStep> {
  const stored = await getItem(deps, key);
  const window = windowMs === undefined ? 0 : Math.floor(nowMs / windowMs) * windowMs;
  const seenWindow = stored?.["windowStart"];
  const seenCount = stored?.["count"];
  // A counter that does not read is not guessed at: the transaction is built conditional on exactly what is stored, so a write over a broken item fails and the request is refused by the caller.
  const readable = stored === undefined || (typeof seenWindow === "number" && typeof seenCount === "number");
  const count = readable && typeof seenWindow === "number" && seenWindow === window && typeof seenCount === "number" ? seenCount : 0;
  const lifetime = windowMs === undefined ? REDIRECT_ITEM_TTL_SECONDS : Math.ceil((2 * windowMs) / 1000);
  return {
    room: readable && count < limit, count,
    item: {
      Update: {
        TableName: deps.tableName, Key: key,
        UpdateExpression: "SET entityType = :type, orgId = :org, windowStart = :window, #count = :next, #expires = :expires",
        ConditionExpression: stored === undefined ? "attribute_not_exists(pk)" : "windowStart = :seenWindow AND #count = :seenCount",
        ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
        ExpressionAttributeValues: {
          ":type": "REDIRECT_RATE", ":org": orgId, ":window": window, ":next": count + 1, ":expires": secondsOf(nowMs) + lifetime,
          ...(stored === undefined ? {} : { ":seenWindow": seenWindow, ":seenCount": seenCount }),
        },
      },
    },
  };
}

/** Redirects of one task in the current hour (the limit is `REDIRECT_RATE.perTaskPerHour`). */
export const hourlyRedirects = (deps: RedirectStateDependencies, orgId: OrgId, taskId: string, limit: number, windowMs: number) => counterStep(deps, HOUR_COUNTER(taskId), orgId, limit, deps.now(), windowMs);
/**
 * Redirects of one step attempt (the limit is `REDIRECT_RATE.perStepAttempt`). An attempt is the step as the workflow entered it: its stage and the number of decisions the workflow holds. A restart by
 * a redirect leaves both as they were (it is the same attempt, so a loop of redirects is counted together); a send-back, a plan approval or a revised plan add a decision and begin a new attempt.
 */
export const stepRedirects = (deps: RedirectStateDependencies, orgId: OrgId, taskId: string, step: string, attempt: number, limit: number) => counterStep(deps, STEP_COUNTER(taskId, step, attempt), orgId, limit, deps.now(), undefined);
