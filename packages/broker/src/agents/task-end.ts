// Plan 3, Task 22 (G7): the single place a task ends. Whatever ends a task (an agent-step run completing, failing or being cancelled; a workflow task
// merged or closed; a plain task's operation finishing; a creator removed), the ending calls `onTaskEnded` once. It gives the workspace back, blocks the
// model keys and tells every handler registered with `registerTaskEndHandler`, which is how Plan 4's chains and Plan 5's participants hear that work they
// started is over. A budget pause is not an end: it calls the handlers of `registerTaskPauseHandler` instead (`onTaskPaused`).
//
// Which end is told: the FIRST one a task has. An agent-step run and a workflow task end once, when the run or the workflow does. A plain task (no workflow, no
// run) ends when its first operation ends, so one that is continued afterwards tells its handlers `succeeded` once and never again (Plan 5 should read "a plain
// task's end" as "its first operation's end").
//
// The end is recorded on the task (`TASK_END`) first, so a second call finds it and tells nobody again; the number of handlers already told is kept
// with it, so a call that was cut short is taken up again from the first handler not told. Handlers must still be safe to hear twice: a process can stop
// between a handler returning and the record being written.
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isEvalRunMark } from "../lessons/eval-run.js";
import { PER_TASK_BUDGET_USD, type PauseScope } from "@agentx/cloud-contracts";
import { type OrgId, type SessionBinding } from "@rovara-code/contracts";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { sessionBindingsOf } from "../rovara-code/session-bindings.js";

/** How a task ended. `creator_removed` is Plan 2's R60 outcome; `merged` and `closed` are a workflow task's, and `answered` is a Rovara Code task that answered a question needing no code change (a success, with no pull request). */
export type TaskEndOutcome = "succeeded" | "failed" | "cancelled" | "creator_removed" | "merged" | "closed" | "answered";

/** What every end handler is told. `runLimitUsd` is the task's budget as it stands (every approved raise included). */
export interface TaskEndEvent {
  orgId: OrgId;
  taskId: string;
  chain?: { chainRunId: string; stepId: string };
  outcome: TaskEndOutcome;
  finalReport?: string;
  branch?: string;
  pullRequests?: Array<{ repository: string; number: number; url: string }>;
  /** The outside places the task's session follows (its Slack thread and its Linear issue), in this task's org; absent when it follows none (Plan 6 Task 20). */
  bindings?: SessionBinding[];
  runLimitUsd: number;
  stopAtUsd?: number;
  spentUsd: number;
}

/**
 * What a step approval's decision ends an agent-step run with, as the run records it: `<step> declined: <prompt>` or `<step> expired: <prompt>`. A run ended this way is
 * ended by a person's (or the clock's) answer to the approval, never by a cancel of the task, which `isDeclinedEndReason` lets a listener tell.
 */
export const approvalEndReason = (stepName: string, status: "DECLINED" | "EXPIRED", prompt: string): string => `${stepName} ${status === "DECLINED" ? "declined" : "expired"}: ${prompt}`;

/** Whether an end reason is a person's decline of a write approval (`approvalEndReason`). */
export const isDeclinedEndReason = (reason: string): boolean => / declined: /u.test(reason);

/** What a pause handler is told: the limit that was reached and, once Task 32 has asked for the raise, its request. */
export interface TaskPauseEvent { orgId: OrgId; taskId: string; chain?: { chainRunId: string; stepId: string }; scope: PauseScope; spendRequestId?: string }

/** What ending a task does besides telling handlers; the broker supplies it. Each part is optional: where it is absent that part is not done here. */
export interface TaskEndHost {
  /** Gives back the task's workspace slot and workspace (`releaseFinishedTask`, which waits while something still runs there); never throws. */
  releaseWorkspace?(taskId: string): Promise<unknown>;
  /** Blocks the task's model keys at the proxy so the ledger settles them (Task 30's `blockOperationKeys`); never throws. */
  blockKeys?(task: DeveloperTaskRecord): Promise<void>;
  /** What the task's keys have spent so far, in dollars. */
  spentUsd?(task: DeveloperTaskRecord): Promise<number>;
}

/** The part of the dependencies an end needs; every set of agent dependencies the broker builds has it. */
export interface TaskEndDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  agentRuns?: TaskEndHost | undefined;
}

/** What a resume handler is told: a task that was paused for money goes on because its limit was raised. */
export interface TaskResumeEvent { orgId: OrgId; taskId: string; chain?: { chainRunId: string; stepId: string } }

export type TaskEndHandler = (deps: TaskEndDependencies, event: TaskEndEvent) => Promise<void>;
export type TaskPauseHandler = (deps: TaskEndDependencies, event: TaskPauseEvent) => Promise<void>;
export type TaskResumeHandler = (deps: TaskEndDependencies, event: TaskResumeEvent) => Promise<void>;

const endHandlers: TaskEndHandler[] = [];
const pauseHandlers: TaskPauseHandler[] = [];
const resumeHandlers: TaskResumeHandler[] = [];

/**
 * Registers a handler that is told, once per task, how the task ended (`TaskEndEvent`). Handlers are called in the order they were registered. Returns
 * a function that removes it again (tests use it; a deployment registers once at start-up).
 */
export function registerTaskEndHandler(handler: TaskEndHandler): () => void {
  endHandlers.push(handler);
  return () => {
    const at = endHandlers.indexOf(handler);
    if (at >= 0) endHandlers.splice(at, 1);
  };
}

/** Registers a handler that is told when a task's run is paused for money (`TaskPauseEvent`). Returns the function that removes it. */
export function registerTaskPauseHandler(handler: TaskPauseHandler): () => void {
  pauseHandlers.push(handler);
  return () => {
    const at = pauseHandlers.indexOf(handler);
    if (at >= 0) pauseHandlers.splice(at, 1);
  };
}

/** Registers a handler that is told when a task paused for money goes on after its limit was raised (`TaskResumeEvent`). Returns the function that removes it. */
export function registerTaskResumeHandler(handler: TaskResumeHandler): () => void {
  resumeHandlers.push(handler);
  return () => {
    const at = resumeHandlers.indexOf(handler);
    if (at >= 0) resumeHandlers.splice(at, 1);
  };
}

/** Whether anything listens for a task's end. */
export const hasTaskEndHandlers = (): boolean => endHandlers.length > 0;

/** Whether anything listens for a task's pause. */
export const hasTaskPauseHandlers = (): boolean => pauseHandlers.length > 0;

/** DEVTASK#<task> / TASK_END: the task's end, recorded once. */
export const taskEndKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "TASK_END" as const });

interface EndRecord { orgId?: string | undefined; outcome?: TaskEndOutcome; handlersTold?: number; done?: boolean }

const log = (deps: Pick<TaskEndDependencies, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function get<T>(deps: TaskEndDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
}

/** How long a call that is telling the handlers keeps the others out; a process that dies holds it no longer than this. */
export const END_LEASE_MS = 60_000;

/** Takes the right to tell the handlers: one call does at a time, so two that meet do not tell twice. */
async function claimEnd(deps: TaskEndDependencies, key: { pk: string; sk: string }): Promise<boolean> {
  const now = deps.now();
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "SET leaseUntil = :until", ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
      ExpressionAttributeValues: { ":until": now + END_LEASE_MS, ":now": now },
    }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** The event the handlers are told, from the task as it is NOW (its budget may have been raised since the caller read it). */
async function eventOf(deps: TaskEndDependencies, task: DeveloperTaskRecord, outcome: TaskEndOutcome, detail: { finalReport?: string; branch?: string }): Promise<TaskEndEvent> {
  const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId)) ?? task;
  const runLimitUsd = fresh.budgetUsd ?? PER_TASK_BUDGET_USD;
  let spentUsd = 0;
  if (deps.agentRuns?.spentUsd !== undefined) {
    try {
      spentUsd = await deps.agentRuns.spentUsd(fresh);
    } catch (error) {
      // The ledger settles the keys later; what is told now is the figure the proxy had, or none.
      log(deps, "task_end.spend_unreadable", { taskId: task.taskId, error: errorName(error) });
    }
  }
  const pullRequests = (fresh.workflow?.pullRequests ?? []).flatMap((pullRequest) => (typeof pullRequest.url === "string"
    ? [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }] : []));
  const orgId: OrgId = fresh.orgId ?? (task.orgId as OrgId);
  // A read that fails is thrown: the end is recorded and tells its handlers again from the first one not told, so none is told a task that follows a Linear issue as if it followed none.
  const bindings = await sessionBindingsOf(deps, orgId, fresh.sessionId ?? task.sessionId);
  return {
    orgId,
    taskId: task.taskId,
    ...(fresh.chain === undefined ? {} : { chain: fresh.chain }),
    outcome,
    ...(detail.finalReport === undefined ? {} : { finalReport: detail.finalReport }),
    ...(detail.branch === undefined ? {} : { branch: detail.branch }),
    ...(pullRequests.length === 0 ? {} : { pullRequests }),
    ...(bindings.length === 0 ? {} : { bindings }),
    runLimitUsd,
    stopAtUsd: fresh.maxPerRunUsd === undefined ? runLimitUsd : Math.min(runLimitUsd, fresh.maxPerRunUsd),
    spentUsd,
  };
}

/**
 * The event a task's recorded end tells its handlers, built again from what is stored: the outcome the first call recorded (`TASK_END`) and the task as it is now. Plan 4's
 * sweep tells a handler that missed it. Undefined when the task has no recorded end, or the end or the task is another org's. `detail` is what the run ended with (its
 * report and its branch), which the end record does not keep.
 */
export async function readTaskEndEvent(deps: TaskEndDependencies, orgId: OrgId, taskId: string, detail: { finalReport?: string; branch?: string } = {}): Promise<TaskEndEvent | undefined> {
  const record = await get<EndRecord>(deps, taskEndKey(taskId));
  if (record === undefined || record.orgId !== orgId || record.outcome === undefined) return undefined;
  const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
  if (task === undefined || task.orgId !== orgId) return undefined;
  return eventOf(deps, task, record.outcome, detail);
}

/**
 * The task has ended. Records the end, blocks the task's model keys, gives its workspace back and tells every end handler, once. `"called"`: this call told
 * the handlers (or the rest of them); `"already_ended"`: an earlier call told all of them; `"in_progress"`: another call holds the lease and is telling them
 * now (the caller must look again once the lease could have run out: the end is not finished until a call answers `called` or `already_ended`);
 * `"not_listening"`: nothing is registered and the caller does not keep the end (`record`), so nothing was written. An agent-step run's own end is always kept (`record: true`): its workspace and keys depend on it. Throws when a
 * handler fails (the end stays recorded, with how many were told, so the next call goes on from there); callers that must not fail wrap it.
 */
export async function onTaskEnded(
  deps: TaskEndDependencies,
  task: DeveloperTaskRecord,
  outcome: TaskEndOutcome,
  detail: { finalReport?: string; branch?: string } = {},
  options: { record?: boolean } = {},
): Promise<"called" | "already_ended" | "in_progress" | "not_listening"> {
  if (!hasTaskEndHandlers() && options.record !== true) return "not_listening";
  // A task from before orgs has no one to tell (its handlers are the org's).
  if (task.orgId === undefined) return "not_listening";
  const key = taskEndKey(task.taskId);
  const orgId = task.orgId;
  let record = await get<EndRecord>(deps, key);
  if (record === undefined) {
    try {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...key, entityType: "TASK_END", orgId, outcome, at: new Date(deps.now()).toISOString(), handlersTold: 0, done: false },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      record = { orgId, outcome, handlersTold: 0, done: false };
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      record = await get<EndRecord>(deps, key);
    }
  }
  if (record === undefined || record.orgId !== orgId) return "already_ended";
  if (record.done !== true && !await claimEnd(deps, key)) return "in_progress";
  // What ending a task does besides telling: keys first (a request already admitted still settles), then the workspace. Done on every call that has the
  // means, also after the handlers were told: an earlier call without them (a creator check, a release) recorded the end and told, and this one finishes it.
  if (deps.agentRuns?.blockKeys !== undefined) await deps.agentRuns.blockKeys(task);
  if (deps.agentRuns?.releaseWorkspace !== undefined) await deps.agentRuns.releaseWorkspace(task.taskId);
  if (record.done === true) return "already_ended";
  const ended = record.outcome ?? outcome;
  // Lane 7: a replay copy of a past task tells nobody (no session note, no Team record row, no tracker comment, no Slack, no learning).
  const handlers = isEvalRunMark(task.evalRun) ? [] : [...endHandlers];
  if (handlers.length > 0) {
    const event = await eventOf(deps, task, ended, detail);
    for (let index = record.handlersTold ?? 0; index < handlers.length; index += 1) {
      try {
        await handlers[index]!(deps, event);
      } catch (error) {
        log(deps, "task_end.handler_failed", { taskId: task.taskId, orgId, error: errorName(error) });
        // The next call takes it up at once, not when the lease runs out.
        await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, UpdateExpression: "REMOVE leaseUntil", ConditionExpression: "attribute_exists(pk)" })).catch(() => undefined);
        throw error;
      }
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "SET handlersTold = :told", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":told": index + 1 },
      }));
    }
  }
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: key, UpdateExpression: "SET done = :done, doneAt = :at REMOVE leaseUntil", ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":done": true, ":at": new Date(deps.now()).toISOString() },
  }));
  return "called";
}

/** The run is paused for money (not ended): tells every pause handler, in order. A handler that fails is logged and the rest are still told; it rethrows the first failure so a caller that retries can. */
export async function onTaskPaused(deps: TaskEndDependencies, task: DeveloperTaskRecord, scope: PauseScope, spendRequestId?: string): Promise<void> {
  const event: TaskPauseEvent = {
    orgId: task.orgId as OrgId, taskId: task.taskId, ...(task.chain === undefined ? {} : { chain: task.chain }), scope,
    ...(spendRequestId === undefined ? {} : { spendRequestId }),
  };
  let failure: unknown;
  for (const handler of [...pauseHandlers]) {
    try {
      await handler(deps, event);
    } catch (error) {
      log(deps, "task_pause.handler_failed", { taskId: task.taskId, error: errorName(error) });
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("a pause handler failed");
}

/**
 * A task that was paused for money goes on (its raise was approved): tells every resume handler, in order. Best effort: a handler that fails is logged and the
 * rest are still told, and nothing is thrown, because the task must go on whatever a listener's view of it says (a listener that missed this is put right by the task's end).
 */
export async function onTaskResumed(deps: TaskEndDependencies, task: DeveloperTaskRecord): Promise<void> {
  if (task.orgId === undefined) return;
  const event: TaskResumeEvent = { orgId: task.orgId, taskId: task.taskId, ...(task.chain === undefined ? {} : { chain: task.chain }) };
  for (const handler of [...resumeHandlers]) {
    try {
      await handler(deps, event);
    } catch (error) {
      log(deps, "task_resume.handler_failed", { taskId: task.taskId, error: errorName(error) });
    }
  }
}
