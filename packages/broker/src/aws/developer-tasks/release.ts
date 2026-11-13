import { createHash } from "node:crypto";
import { DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError } from "@rovara-code/contracts";
import { recordRunCost } from "../../spend/estimate.js";
import { noteFinishedTaskDuration } from "../../rovara-code/duration.js";
import type { ModelAccess } from "../../model-proxy/access.js";
import { chargeFormOf, chargedTaskIds, releaseConflict, releaseItems, type ChargeForm } from "../../developer/limits.js";
import { aiToolTurn, partyOfTask, taskIndexKey, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { isConditional } from "../broker-shared.js";
import type { DeveloperTaskActions, TransactItems } from "../developer-task-actions.js";
import { leaveTaskEndRow } from "../task-end-row.js";
import { get } from "./common.js";
import { ownerIndexRowOf } from "./task-index.js";
import { noteTaskEnded, workflowEndOutcome, workflowTaskFinished } from "./close.js";
import { type EndedPullRequestReader, abandonTaskOutcomes, outcomeDepsOf, settleTaskOutcomes } from "../../rovara-code/outcome-hooks.js";

/** Workspace states whose compute a finished task can remove: nothing is starting, stopping, closing or running there. */
const RELEASABLE_WORKSPACE = new Set(["READY", "STOPPED", "UNHEALTHY"]);

export type FinishedTaskRelease = "released" | "already_released" | "not_finished" | "busy";

export type ReleaseDeps = {
  tableName: string; actions: DeveloperTaskActions; documentClient: { send(command: unknown): Promise<unknown> };
  /** The model proxy: what a finished run's keys spent, for the estimates (Task 34). Without it no cost is written. */
  modelAccess?: ModelAccess;
  /** Track record: a fresh GitHub read of one of the task's pull requests, for settling a merged candidate's samples when the task ends. Without it such samples are `code_host_unavailable`. */
  outcomeReader?: (task: DeveloperTaskRecord) => EndedPullRequestReader | undefined;
  /** How long the settle's reads may take in all (default 8 seconds). */
  outcomeSettleBudgetMs?: number;
  /** An absolute time (ms) after which a pass over many tasks settles no more: the rest stay open, with their release mark, for the next pass. */
  outcomeSettleUntil?: number;
};

/**
 * Plan 3, Task 34: a run that merged (a workflow task whose pull requests all merged), passed every step of its own sequence, or completed (an agent-step run)
 * writes what its keys cost, for the next estimate (`recordRunCost`). A run that failed, was cancelled or closed with its plan rejected writes nothing, and a
 * task with no workflow is never recorded (the TASK estimate stays at its default until that has an end signal and a planned golden change). Never throws: a
 * proxy that can't say is logged; the next release of the task before it is released tries again, and after that the run's cost is not in the history.
 */
export async function recordFinishedRunCost(deps: ReleaseDeps, task: DeveloperTaskRecord): Promise<void> {
  // A task with a purpose (a setup draft, a diagnosis, a setup run) is no run of the agent's kind of work: its cost never feeds the estimates. An ALLOW-list: only a task with no purpose is recorded, so a purpose added later is out by default.
  if (deps.modelAccess === undefined || task.orgId === undefined || task.runCostRecordedAt !== undefined || task.purpose !== undefined) return;
  let ended: { path: "QUICK" | "FULL" | "AGENT"; endedAt: string };
  if (task.agentRunEnd !== undefined) {
    if (task.agentRunEnd.state !== "COMPLETE") return;
    ended = { path: "AGENT", endedAt: task.agentRunEnd.at };
  } else {
    const outcome = workflowEndOutcome(task);
    if ((outcome !== "merged" && outcome !== "succeeded") || task.workflow === undefined) return;
    // The workflow's last change is the merge (or the last step); the clock would make the order of two runs depend on when their release ran.
    ended = { path: task.workflow.path, endedAt: task.workflow.updatedAt };
  }
  try {
    await recordRunCost({ documentClient: deps.documentClient, tableName: deps.tableName, modelAccess: deps.modelAccess }, task, ended);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "run_cost.not_recorded", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
}

/** The release's own audit record ID for a task: one per task, so a repeated release writes it once. */
function releaseTurnId(taskId: string): string {
  const hex = createHash("sha256").update(`agentx-release\0${taskId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A finished workflow task (all its pull requests merged, or its plan rejected) gives back its workspace slot and its
 * workspace, in the order a close uses. First it claims the workspace: CLOSING, with the claim recorded on the task
 * (`releaseClaimedAt`), only while nothing runs there, so no operation can start meanwhile. Then it deletes the compute.
 * Then one transaction releases the counters the task charged, marks the workspace and the index row CLOSED, sets the
 * task's `releasedAt` and writes the audit record a close writes, with the reason. The task stays complete, not closed.
 *
 * Idempotent and self-guarding as the close is: the member counter's `contains(#tasks, taskId)` condition, the task's
 * `releasedAt` and the audit record's key make a second release a no-op, never a second decrement. A claim left by a
 * release that stopped part way is taken up again by the next call. A workspace something still runs on is left alone
 * ("busy"): that operation's result, the recovery sweep or the owner's next start tries again.
 * A task closed in the usual way gave its slot back with its close; one still holding it (an older record) gives back
 * the slot alone.
 */
export async function releaseFinishedTask(deps: ReleaseDeps, task: DeveloperTaskRecord): Promise<FinishedTaskRelease> {
  const outcome = await releaseFinishedTaskNow(deps, task);
  if (outcome === "released" || outcome === "already_released") await settleReleasedTask(deps, task);
  return outcome;
}

/**
 * Track record, after the release is done (it never waits on GitHub): samples still open when the task ends are settled, from fresh reads that share one short deadline (and, in a pass over many
 * tasks, the pass's own: `outcomeSettleUntil`). `done` when nothing is left open; `skipped` when the pass's time was up (nothing was touched); else `incomplete`. Never throws.
 */
async function settleReleasedTask(deps: ReleaseDeps, task: DeveloperTaskRecord): Promise<"done" | "incomplete" | "skipped"> {
  return settleTaskOutcomes(outcomeDepsOf({ documentClient: deps.documentClient, tableName: deps.tableName }), task, new Date().toISOString(), deps.outcomeReader?.(task), deps.outcomeSettleBudgetMs, deps.outcomeSettleUntil);
}

async function releaseFinishedTaskNow(deps: ReleaseDeps, task: DeveloperTaskRecord): Promise<FinishedTaskRelease> {
  const closed = task.closedAt !== undefined;
  if (!closed && !workflowTaskFinished(task)) return "not_finished";
  await recordFinishedRunCost(deps, task);
  // Plan 6 Task 7: a version 2 task's duration, if the pull request's write didn't get there first.
  await noteFinishedTaskDuration({ documentClient: deps.documentClient, tableName: deps.tableName }, task);
  // A merged or closed workflow task has ended: its end handlers hear it (an agent-step run's end is told by its engine).
  if (!closed && task.agentRunEnd === undefined) {
    const outcome = workflowEndOutcome(task);
    if (outcome !== undefined) {
      // Plan 5 Task 7b (the Task 22 hand-off): the release goes on whatever the handlers did, so an end that was not finished leaves its own row for the sweep.
      const told = await noteTaskEnded(deps, task, outcome);
      if (told !== "told") await leaveTaskEndRow(deps, task, "workflow", told);
    }
  }
  if (task.releasedAt !== undefined) return "already_released";
  let releaseWorkspace = false;
  if (!closed) {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status !== "CLOSED") {
      // Ours when the task records the claim and the workspace is CLOSING with no close of its own.
      const claimed = task.releaseClaimedAt !== undefined && workspace.status === "CLOSING" && workspace.closeOperationId === undefined;
      if (!claimed) {
        if (!RELEASABLE_WORKSPACE.has(workspace.status) || workspace.activeOperationId != null) return "busy";
        // A workspace whose compute can't be deleted (a retired storage mode) is never claimed, so it is not left CLOSING;
        // its mark is put off and tried again later.
        if (deps.actions.canDeleteCompute?.(workspace) === false) return "busy";
        const now = new Date().toISOString();
        try {
          await deps.actions.transact([
            { Update: {
              TableName: deps.tableName, Key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" },
              // A close the owner asked for earlier and that was refused may have left its ID: it is over, and only
              // this release's claim may stand on a CLOSING workspace with no close of its own.
              UpdateExpression: "SET #status = :closing, updatedAt = :now REMOVE closeOperationId",
              ConditionExpression: "#status = :was AND attribute_not_exists(activeOperationId)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":closing": "CLOSING", ":now": now, ":was": workspace.status },
            } },
            { Update: {
              TableName: deps.tableName, Key: taskKey(task.taskId),
              UpdateExpression: "SET releaseClaimedAt = :now",
              ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(releasedAt) AND attribute_not_exists(closedAt)",
              ExpressionAttributeValues: { ":now": now },
            } },
          ]);
        } catch (error) {
          if (!isConditional(error)) throw error;
          const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
          return fresh?.releasedAt !== undefined || fresh?.closedAt !== undefined ? "already_released" : "busy";
        }
      }
      try {
        await deps.actions.deleteCompute(workspace);
      } catch (error) {
        // Compute that is starting or stopping refuses; the claim stays, and the next call takes it up.
        if (error instanceof AgentXError && error.code === "WORKSPACE_BUSY") return "busy";
        throw error;
      }
      releaseWorkspace = true;
    }
  }
  const now = new Date().toISOString();
  const reason = task.agentRunEnd !== undefined ? "its run ended" : task.workflow?.stage !== "CLOSED" ? "its pull request merged" : task.workflow.outcome === "PASSED" ? "it finished every step" : task.workflow.outcome === "CLOSED" ? "it was stopped before any code was written" : "its plan was rejected";
  const rest = (): TransactItems => [
    ...(releaseWorkspace ? [{ Update: {
      TableName: deps.tableName,
      Key: { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" },
      UpdateExpression: "SET #status = :closed, closedAt = :now, updatedAt = :now REMOVE closeError",
      ConditionExpression: "#status = :closing AND attribute_not_exists(activeOperationId) AND attribute_not_exists(closeOperationId)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now, ":closing": "CLOSING" },
    } }] : []),
    ...(closed ? [] : [
      { Update: {
        TableName: deps.tableName, Key: taskKey(task.taskId),
        UpdateExpression: "SET releasedAt = :now REMOVE releaseClaimedAt",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(releasedAt) AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":now": now },
      } },
      // As a close does: the open-task list no longer counts it.
      { Update: {
        TableName: deps.tableName, Key: taskIndexKey(task.developerId, task.createdAt, task.taskId),
        UpdateExpression: "SET #status = :closed, updatedAt = :now", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now },
      } },
      // The row of the person who took the task over, too (Plan 5 Task 12a).
      ...(ownerIndexRowOf(task) === undefined ? [] : [{ Update: {
        TableName: deps.tableName, Key: ownerIndexRowOf(task)!,
        UpdateExpression: "SET #status = :closed, updatedAt = :now", ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now },
      } }]),
      // The audit record a close writes, saying why: one per task.
      ...(deps.actions.turnRecordsTableName === undefined ? [] : [{ Put: {
        TableName: deps.actions.turnRecordsTableName,
        Item: aiToolTurn({
          party: partyOfTask(task), turnId: releaseTurnId(task.taskId), action: "close", phase: "completed", outcome: "succeeded",
          receivedAt: now, finishedAt: now, request: "close",
          response: `The task is complete (${reason}), and its workspace is released.`,
        }),
        ConditionExpression: "attribute_not_exists(pk)",
      } }]),
    ]),
  ];
  let release = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // The form the slot was charged in (a marker, or the counter's old `tasks` set), read again on each try.
    const form: ChargeForm | undefined = release ? await chargeFormOf(deps.documentClient, deps.tableName, task.charge, task.taskId) : undefined;
    const items = [...(form !== undefined ? releaseItems(deps.tableName, task.charge, task.taskId, form) : []), ...rest()];
    if (items.length === 0) return "already_released";
    try {
      // First (positions 0 to 2): releaseConflict reads the cancellation reasons by position.
      await deps.actions.transact(items);
      return release ? "released" : "already_released";
    } catch (error) {
      if (!isConditional(error)) throw error;
      const fresh = await get<DeveloperTaskRecord>(deps, taskKey(task.taskId));
      if (fresh === undefined || fresh.releasedAt !== undefined || (!closed && fresh.closedAt !== undefined)) return "already_released";
      if (!release) return "busy";
      try {
        // Counters that no longer hold this task: given back already; the rest is sent again without them.
        await releaseConflict(deps.documentClient, deps.tableName, task.charge, task.taskId, error, form ?? "set");
      } catch {
        // Not the counters: something else moved meanwhile; the next call tries again.
        return "busy";
      }
      release = false;
    }
  }
  return "busy";
}

/** The most finished tasks one limit-refused start gives back, so the start stays quick. */
const SELF_HEAL_MAX = 10;

/**
 * Self-heal for slots finished tasks kept (tasks merged or rejected before releases ran then, or whose release found the
 * workspace busy): each task the member counter holds that is finished or closed gives its slot back, by
 * releaseFinishedTask, at most SELF_HEAL_MAX per call. Answers how many it released. Best effort: a task that cannot be
 * released now is left for the next time.
 */
export async function releaseFinishedTasksOf(deps: ReleaseDeps, member: { pk: string; sk: string }): Promise<number> {
  let released = 0;
  // Both forms: the markers that name this counter and the counter's old `tasks` set (before the one-time migration).
  for (const taskId of await chargedTaskIds(deps.documentClient, deps.tableName, member, 50)) {
    if (released >= SELF_HEAL_MAX) break;
    const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
    if (task === undefined) continue;
    // A finished task goes through the marked release, so a claim it leaves (the compute refused, say) is the sweep's to
    // finish; a closed task only gives back its slot.
    try {
      const outcome = task.closedAt === undefined ? await releaseFinishedTaskQuietly(deps, taskId) : await releaseFinishedTask(deps, task);
      if (outcome === "released") released += 1;
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "developer.finished_task_release_failed", taskId, error: error instanceof Error ? error.name : "unknown" }));
    }
  }
  return released;
}

/** Where a finished task waits for its release until one goes through: the recovery sweep reads this partition. */
export const FINISHED_RELEASE_PK = "FINISHED_RELEASE";
const finishedReleaseKey = (taskId: string) => ({ pk: FINISHED_RELEASE_PK, sk: `TASK#${taskId}` });
/** The most finished tasks one recovery sweep tries to release, and the most marks it reads to choose them. */
const RELEASE_SWEEP_MAX = 10;
const RELEASE_SWEEP_SCAN = 200;
/** After a release that did not go through, the next try waits this long, doubling each time up to the cap. */
const RELEASE_RETRY_FIRST_MS = 5 * 60_000;
const RELEASE_RETRY_MAX_MS = 6 * 3_600_000;
/** After this many settles of their own that did not finish, a released task's open samples are closed out as `code_host_unavailable` by writes alone, and its mark goes. */
const SETTLE_ATTEMPTS_MAX = 5;

interface FinishedReleaseMark { taskId: string; markedAt?: string; attempts?: number; settleAttempts?: number; nextAttemptAt?: string }

/**
 * Durably queues a finished task for the existing release worker. This intentionally performs no workspace or compute
 * work: a merge-recovery poll only establishes the hand-off, and the release sweep owns the destructive operation.
 */
/** The mark `enqueueFinishedTaskRelease` writes, as a transaction item, for a caller that ends a task in a commit of its own and must not lose the release if it stops right after. */
export function finishedReleaseMarkItem(tableName: string, taskId: string, now: string): TransactItems[number] {
  return { Update: {
    TableName: tableName, Key: finishedReleaseKey(taskId),
    UpdateExpression: "SET entityType = :entity, taskId = :task, markedAt = if_not_exists(markedAt, :now)",
    ExpressionAttributeValues: { ":entity": FINISHED_RELEASE_PK, ":task": taskId, ":now": now },
  } };
}

export async function enqueueFinishedTaskRelease(deps: Pick<ReleaseDeps, "documentClient" | "tableName">, taskId: string): Promise<void> {
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName,
    Key: finishedReleaseKey(taskId),
    UpdateExpression: "SET entityType = :entity, taskId = :task, markedAt = if_not_exists(markedAt, :now)",
    ExpressionAttributeValues: { ":entity": FINISHED_RELEASE_PK, ":task": taskId, ":now": new Date().toISOString() },
  }));
}

/**
 * releaseFinishedTask, logged and never thrown: for callers whose own work is done (a decision, a webhook, an operation's
 * result, a self-heal, the sweep). A finished task is marked as waiting for its release first and unmarked once it is
 * released, so a release that found the workspace busy, failed, or never ran (the process stopped) is tried again by the
 * recovery sweep. A try that did not go through puts the mark's next try off, with backoff, so marks that keep failing
 * never hold back the others.
 */
export async function releaseFinishedTaskQuietly(deps: ReleaseDeps, taskId: string): Promise<FinishedTaskRelease | undefined> {
  const key = finishedReleaseKey(taskId);
  const putOff = async () => {
    const mark = await get<FinishedReleaseMark>(deps, key);
    const attempts = (mark?.attempts ?? 0) + 1;
    const wait = Math.min(RELEASE_RETRY_FIRST_MS * 2 ** (attempts - 1), RELEASE_RETRY_MAX_MS);
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key,
      UpdateExpression: "SET attempts = :attempts, nextAttemptAt = :next",
      ExpressionAttributeValues: { ":attempts": attempts, ":next": new Date(Date.now() + wait).toISOString() } }));
  };
  /** A settle that did not finish: tried again later, counted on its own (a task that was busy before keeps its full tries), with the same backoff. */
  const putOffSettle = async (tries: number) => {
    const wait = Math.min(RELEASE_RETRY_FIRST_MS * 2 ** (tries - 1), RELEASE_RETRY_MAX_MS);
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key,
      UpdateExpression: "SET settleAttempts = :tries, nextAttemptAt = :next", ExpressionAttributeValues: { ":tries": tries, ":next": new Date(Date.now() + wait).toISOString() } }));
  };
  /** A settle the pass had no time for: due again at once, but behind the marks already waiting. */
  const requeue = async () => {
    await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, UpdateExpression: "SET nextAttemptAt = :now", ExpressionAttributeValues: { ":now": new Date().toISOString() } }));
  };
  let marked = false;
  try {
    const task = await get<DeveloperTaskRecord>(deps, taskKey(taskId));
    if (task !== undefined && task.closedAt === undefined && task.releasedAt === undefined && !workflowTaskFinished(task)) return "not_finished";
    if (task === undefined) {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
      return undefined;
    }
    if (task.closedAt !== undefined || task.releasedAt !== undefined) {
      // Nothing to release (any more). A mark the sweep left is removed once the task's track record is settled (a release that stopped before its settle ended leaves its mark for this).
      const left = await get<FinishedReleaseMark>(deps, key);
      if (left === undefined) return undefined;
      const settled = await settleReleasedTask(deps, task);
      const tries = (left.settleAttempts ?? 0) + 1;
      if (settled === "incomplete" && tries >= SETTLE_ATTEMPTS_MAX) {
        // The settle keeps failing: what is still open is closed out by writes alone, and the mark goes.
        await abandonTaskOutcomes(outcomeDepsOf({ documentClient: deps.documentClient, tableName: deps.tableName }), task, new Date().toISOString());
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
      } else if (settled === "done") await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
      else if (settled === "incomplete") await putOffSettle(tries);
      else await requeue();
      return undefined;
    }
    await enqueueFinishedTaskRelease(deps, taskId);
    marked = true;
    const outcome = await releaseFinishedTaskNow(deps, task);
    // The mark stays until the release is done AND the task's open samples are settled (or the pass ran out of time for it: then it stays due).
    const settled = outcome === "released" || outcome === "already_released" ? await settleReleasedTask(deps, task) : "done";
    if (outcome === "busy") await putOff();
    else if (settled === "incomplete") await putOffSettle(1);
    else if (settled === "skipped") await requeue();
    else await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: key }));
    if (outcome === "released" || outcome === "busy") console.log(JSON.stringify({ component: "broker", event: `developer.finished_task_${outcome}`, taskId }));
    return outcome;
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "developer.finished_task_release_failed", taskId, error: error instanceof Error ? error.name : "unknown" }));
    if (marked) await putOff().catch(() => undefined);
    return undefined;
  }
}

/**
 * The recovery sweep's part: the finished tasks still waiting for their release whose next try is due, those waiting
 * longest first, at most RELEASE_SWEEP_MAX per run (of the first RELEASE_SWEEP_SCAN marks read).
 */
export async function releasePendingFinishedTasks(deps: ReleaseDeps): Promise<{ attempted: number; released: number }> {
  const marks: FinishedReleaseMark[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": FINISHED_RELEASE_PK },
      Limit: 100, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: FinishedReleaseMark[]; LastEvaluatedKey?: Record<string, unknown> };
    marks.push(...(response.Items ?? []).filter((item) => typeof item.taskId === "string"));
    start = response.LastEvaluatedKey;
  } while (start !== undefined && marks.length < RELEASE_SWEEP_SCAN);
  const now = new Date().toISOString();
  const dueAt = (mark: FinishedReleaseMark) => mark.nextAttemptAt ?? mark.markedAt ?? "";
  const due = marks.filter((mark) => mark.nextAttemptAt === undefined || mark.nextAttemptAt <= now)
    .sort((left, right) => dueAt(left).localeCompare(dueAt(right))).slice(0, RELEASE_SWEEP_MAX);
  let released = 0;
  for (const mark of due) if (await releaseFinishedTaskQuietly(deps, mark.taskId) === "released") released += 1;
  return { attempted: due.length, released };
}
