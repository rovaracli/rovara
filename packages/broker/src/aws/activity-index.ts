import { slackThreadKey } from "./slack-thread-key.js";
// packages/broker/src/aws/activity-index.ts
// Spec 025 A4, A5: the failure index (FR-038) and the usage index, from the state table's stream.
// The outbox publisher runs it after dispatching; it is best effort, and never fails the batch.
// Logs carry event names, IDs and error names only: an operation's error can quote anything.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ADMIN_ERROR_TEXT_MAX,
  AdminRequesterSchema,
  FailureIndexRecordSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  TaskUsageTelemetrySchema,
  UsageIndexRecordSchema,
  OrgIdSchema,
  indexExpiresAt,
  personalCounter,
  spendCounterKey,
  orgFailureIndexKey,
  orgUsageIndexKey,
  redactAndCap,
  type AdminRequester,
  type FailureIndexRecord,
  type OrgId,
  type UsageIndexRecord,
} from "@agentx/contracts";
import { installOrgIdFromEnvironment, orgOf } from "../org/resolve.js";
import { failureCategory, taskKey, taskPointerKey } from "../developer/task-records.js";
import type { StreamRecord } from "../developer/notifications.js";

/** A4: aborted at the index's deadline; a store passes it to each request it sends. */
export interface IndexStoreOptions { signal?: AbortSignal }

export interface IndexStore {
  get(key: { pk: string; sk: string }, options?: IndexStoreOptions): Promise<Record<string, unknown> | undefined>;
  /** Conditioned attribute_not_exists(pk): a replayed record writes nothing twice. */
  put(item: Record<string, unknown>, options?: IndexStoreOptions): Promise<void>;
  /**
   * Plan 3 Task 30: the same write, in one transaction with an ADD of `tokens` to the counter at `counter` (a ChatGPT-plan task's tokens, counted per
   * person and month), so a replayed record adds its tokens once. A store without it writes the item alone.
   */
  putCounting?(item: Record<string, unknown>, counter: { key: { pk: string; sk: string }; tokens: number }, options?: IndexStoreOptions): Promise<void>;
}

/**
 * Writes a usage row and adds its tokens to a counter in one transaction. The row is created only if absent, so a record the stream delivers again
 * (the row is there already) writes nothing and adds no tokens: the tokens are counted once.
 */
export async function putCountedUsage(
  client: { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> },
  tableName: string,
  item: Record<string, unknown>,
  counter: { key: { pk: string; sk: string }; tokens: number },
  options: { abortSignal?: AbortSignal } = {},
): Promise<void> {
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: {
        TableName: tableName, Key: counter.key, UpdateExpression: "SET #type = if_not_exists(#type, :type) ADD #tokens :tokens",
        ExpressionAttributeNames: { "#type": "entityType", "#tokens": "tokens" }, ExpressionAttributeValues: { ":type": "SPEND_COUNTER", ":tokens": counter.tokens },
      } },
    ] }), options);
  } catch (error) {
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
    if (error instanceof Error && error.name === "TransactionCanceledException" && reasons?.[0]?.Code === "ConditionalCheckFailed") return;
    throw error;
  }
}

/** Settles by `deadline` (epoch milliseconds): rejects with a TimeoutError when `run` has not answered by then. */
export function byDeadline<T>(deadline: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
  return Promise.race([run(signal), timedOut]);
}

/** Settles when `signal` aborts: rejects with its reason when `run` has not answered by then. */
function untilAborted<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });
  return Promise.race([run(signal), aborted]);
}

/**
 * A4: every store call is bounded by one deadline signal for the whole batch, so a hung request
 * cannot outlive the publisher, and once that signal has fired no further record is started, even
 * when its timer fired before Date.now() reached the deadline.
 */
function bounded(store: IndexStore, signal: AbortSignal): IndexStore {
  return {
    get: (key) => untilAborted(signal, (callSignal) => store.get(key, { signal: callSignal })),
    put: (item) => untilAborted(signal, (callSignal) => store.put(item, { signal: callSignal })),
    ...(store.putCounting === undefined ? {} : { putCounting: (item, counter) => untilAborted(signal, (callSignal) => store.putCounting!(item, counter, { signal: callSignal })) }),
  };
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const FAILED = new Set(["FAILED", "INTERRUPTED"]);
/** The index schemas' limits: a field over one is cut or dropped, so the row is still written. */
const REQUESTER_NAME_MAX = 200;
const PROJECT_MAX = 63;
const THREAD_MAX = 128;
/** Without a deadline from the caller, the index stops this long after it starts (A4). */
export const INDEX_DEFAULT_BUDGET_MS = 10_000;
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

interface Context { project: string; origin: "slack" | "ai_tool"; orgId?: OrgId; taskId?: string; thread?: string; developerName?: string }

/** A5: the project, the origin and the turn record link, from the workspace's own records. */
async function contextOf(store: IndexStore, workspaceId: string, fallbackOrg: OrgId): Promise<Context> {
  const workspace = await store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" });
  const project = text(workspace?.projectName)?.slice(0, PROJECT_MAX) ?? "unknown";
  const stored = OrgIdSchema.safeParse(workspace?.orgId);
  const orgId = stored.success ? { orgId: stored.data } : {};
  const pointer = await store.get(taskPointerKey(workspaceId));
  const taskId = text(pointer?.taskId);
  if (taskId !== undefined) {
    const task = await store.get(taskKey(taskId));
    const developerName = text(task?.developerName);
    return { project, origin: "ai_tool", ...orgId, taskId, ...(developerName === undefined ? {} : { developerName }) };
  }
  const ownerKey = text(workspace?.ownerKey);
  let storedThread: string | undefined;
  const threadOrg = OrgIdSchema.safeParse(workspace?.orgId ?? fallbackOrg);
  if (ownerKey !== undefined && threadOrg.success) {
    const scoped = await store.get(slackThreadKey(threadOrg.data, ownerKey));
    const legacy = scoped === undefined ? await store.get({ pk: `SLACK_THREAD#${ownerKey}`, sk: "META" }) : undefined;
    const row = scoped ?? (legacy?.workspaceId === workspaceId && (legacy.orgId === undefined || legacy.orgId === threadOrg.data) ? legacy : undefined);
    storedThread = text(row?.thread);
  }
  // A thread subject too long to parse is left out: the failure is still listed, without its link.
  const thread = storedThread !== undefined && storedThread.length <= THREAD_MAX ? storedThread : undefined;
  return { project, origin: "slack", ...orgId, ...(thread === undefined ? {} : { thread }) };
}

/** The operation's requestedBy as the strict requester schema accepts it; anything else is none. */
function requesterOf(value: unknown, developerName: string | undefined): AdminRequester {
  const requester = record(value);
  let candidate: unknown = { kind: "none" };
  if (requester?.kind === "developer") {
    const name = developerName?.slice(0, REQUESTER_NAME_MAX);
    candidate = { kind: "developer", developerId: requester.developerId, provider: requester.provider, ...(name === undefined ? {} : { name }) };
  } else if (requester !== undefined && requester.teamId !== undefined && requester.userId !== undefined) {
    candidate = { kind: "slack", teamId: requester.teamId, userId: requester.userId };
  }
  const parsed = AdminRequesterSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { kind: "none" };
}

const link = (context: Context) => ({ ...(context.taskId === undefined ? {} : { taskId: context.taskId }), ...(context.thread === undefined ? {} : { thread: context.thread }) });

async function failureItem(store: IndexStore, fallbackOrg: OrgId, next: Record<string, unknown>): Promise<Record<string, unknown> | "invalid"> {
  const workspaceId = String(next.workspaceId);
  const context = await contextOf(store, workspaceId, fallbackOrg);
  const kind = text(next.kind) ?? "unknown";
  const status = String(next.status) as FailureIndexRecord["status"];
  const error = text(next.error);
  const endedAt = new Date(text(next.updatedAt) ?? Date.now()).toISOString();
  const indexed: FailureIndexRecord = {
    operationId: String(next.id), workspaceId, project: context.project, origin: context.origin,
    requester: requesterOf(next.requestedBy, context.developerName),
    kind, status, category: failureCategory(kind, status, error),
    error: redactAndCap(error ?? `the ${kind} operation ended ${status}`, ADMIN_ERROR_TEXT_MAX).text,
    endedAt, ...link(context),
  };
  // The admin failures route parses items with this schema; one it would skip is not written.
  if (!FailureIndexRecordSchema.safeParse(indexed).success) return "invalid";
  return { ...orgFailureIndexKey(orgOf(fallbackOrg, next, { orgId: context.orgId }), endedAt, indexed.operationId), entityType: "FAILURE_INDEX", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(endedAt), ...indexed };
}

/** A usage row, and the counter its tokens also go to when the task ran on a person's ChatGPT plan. */
interface UsageRow { item: Record<string, unknown>; personal?: { key: { pk: string; sk: string }; tokens: number } }

const asRow = (found: Record<string, unknown> | "invalid"): UsageRow | "invalid" => (found === "invalid" ? found : { item: found });

async function usageItem(store: IndexStore, fallbackOrg: OrgId, event: Record<string, unknown>): Promise<UsageRow | "unreadable" | "invalid"> {
  const telemetry = TaskUsageTelemetrySchema.safeParse(event.payload);
  if (!telemetry.success) return "unreadable";
  const workspaceId = String(event.workspaceId);
  const operationId = String(event.operationId);
  const at = new Date(text(event.timestamp) ?? Date.now()).toISOString();
  const [context, operation] = await Promise.all([contextOf(store, workspaceId, fallbackOrg), store.get({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` })]);
  const created = Date.parse(text(operation?.createdAt) ?? at);
  const indexed: UsageIndexRecord = {
    operationId, workspaceId, project: context.project, origin: context.origin,
    requester: requesterOf(operation?.requestedBy, context.developerName), ...link(context),
    at, durationMs: Math.max(0, Date.parse(at) - (Number.isFinite(created) ? created : Date.parse(at))),
    inputTokens: telemetry.data.tokens.input + telemetry.data.tokens.cacheRead + telemetry.data.tokens.cacheWrite,
    outputTokens: telemetry.data.tokens.output, costUsd: telemetry.data.costUsd,
  };
  if (!UsageIndexRecordSchema.safeParse(indexed).success) return "invalid";
  const orgId = orgOf(fallbackOrg, event, operation, { orgId: context.orgId });
  const item = { ...orgUsageIndexKey(orgId, at, operationId), entityType: "USAGE_INDEX", [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(at), ...indexed };
  // Plan 3 Task 30: what a task ran on a person's ChatGPT plan is counted on that person (it costs the company nothing, so it is tokens, not dollars). A task
  // that fell back to the company's models is not: its usage is not all the plan's, and the proxy's spend already counts what it cost.
  // Not for a record that carries no timestamp: its row key is then made from the clock, a replay would get another key, and its tokens would be counted twice.
  const planOwner = text(operation?.chatgptDeveloperId);
  if (planOwner === undefined || operation?.chatgptFallback !== undefined || text(event.timestamp) === undefined) return { item };
  return { item, personal: { key: spendCounterKey(orgId, at.slice(0, 7), personalCounter(planOwner)), tokens: indexed.inputTokens + indexed.outputTokens } };
}

/**
 * Indexes a batch's failures and usage events. `deadline` (epoch milliseconds) bounds the work so
 * the publisher never runs past its timeout (a timed-out batch would be dispatched again, A4):
 * once it passes, the records left are skipped and counted in one log line.
 */
export async function indexActivity(
  records: readonly StreamRecord[],
  unbounded: IndexStore,
  log: (entry: Record<string, unknown>) => void,
  deadline: number = Date.now() + INDEX_DEFAULT_BUDGET_MS,
  /** The org of rows whose records name none yet: the install's single org (ruling R3). */
  fallbackOrg: OrgId = installOrgIdFromEnvironment(),
): Promise<{ failures: number; usage: number; failed: number }> {
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const store = bounded(unbounded, deadlineSignal);
  const result = { failures: 0, usage: 0, failed: 0 };
  const work: Array<{ failure: boolean; next: Record<string, unknown> }> = [];
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    let next: Record<string, unknown>;
    let previous: Record<string, unknown> | undefined;
    try {
      next = unmarshall(image) as Record<string, unknown>;
      previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
    } catch {
      continue;
    }
    const failure = next.entityType === "OPERATION" && FAILED.has(String(next.status)) && !TERMINAL.has(String(previous?.status));
    const usage = next.entityType === "EVENT" && next.type === "usage" && entry.eventName === "INSERT";
    if (failure || usage) work.push({ failure, next });
  }
  for (const [position, { failure, next }] of work.entries()) {
    if (deadlineSignal.aborted || Date.now() >= deadline) {
      log({ event: "activity_index.deadline_reached", skipped: work.length - position });
      break;
    }
    const operationId = String(failure ? next.id : next.operationId);
    try {
      const found: UsageRow | "unreadable" | "invalid" = failure ? asRow(await failureItem(store, fallbackOrg, next)) : await usageItem(store, fallbackOrg, next);
      if (found === "unreadable" || found === "invalid") {
        log({ event: found === "unreadable" ? "activity_index.usage_unreadable" : "activity_index.record_invalid", operationId });
        result.failed += 1;
        continue;
      }
      if (found.personal !== undefined && store.putCounting !== undefined) await store.putCounting(found.item, found.personal);
      else await store.put(found.item);
      if (failure) result.failures += 1;
      else result.usage += 1;
    } catch (error) {
      log({ event: "activity_index.write_failed", operationId, error: errorName(error) });
      result.failed += 1;
    }
  }
  return result;
}
