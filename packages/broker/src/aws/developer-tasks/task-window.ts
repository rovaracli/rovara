import { AgentXError, agentXError, type WorkspaceInstance } from "@rovara-code/contracts";
import { taskSpendBaseline } from "../../org/budget.js";
import { inertName, sharedSubject, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import type { TransactItems } from "../developer-task-actions.js";
import type { DeveloperCaller } from "../developer-routes.js";
import { appendOperationEvent } from "../operation-events.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { CLOSED_TASK, CLOSING_TASK, NEVER_STARTED, iso, log } from "./common.js";
import { Aliases } from "../../agents/table-writes.js";
import { type CapturedTaskStop } from "../../org/task-stop-admission.js";
import { type SpendingAdmissionReference } from "@rovara-code/contracts";
import { taskMaxPerRunForAdmission } from "../../org/task-stop-window.js";
import { usdToWholeMicrodollars } from "../../org/budget-amount.js";

/**
 * What continue and a pull request need before they touch the workspace: an open task that got
 * past its setup (R17, for every setup failure, whatever its category) and is not closing. Access
 * is not checked again (R11): a developer who left the project's channels can still continue and
 * publish their own task. Callers load the owned task first, which is the ownership check.
 */
export async function actionableWorkspace(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<WorkspaceInstance> {
  if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  const workspace = await deps.actions.workspace(task.workspaceId);
  if (workspace.status === "CLOSED") throw agentXError("CONFIG_INVALID", CLOSED_TASK);
  if (workspace.status === "PREPARATION_FAILED") throw agentXError("CONFIG_INVALID", NEVER_STARTED);
  // A close in flight is not work to wait for or cancel: say so, not TASK_BUSY.
  if (workspace.status === "CLOSING") throw agentXError("CONFIG_INVALID", CLOSING_TASK);
  // Plan 2, Task 15: work on an existing task needs the org's GitHub connection too, so a continue, a retry, a review or a publication of a
  // project whose installation was uninstalled or disconnected is refused here, before anything is written or any machine woken.
  await requireTaskRepositoriesConnected(deps, task);
  return workspace;
}

/** The project revision the task started on must still be reachable through its org's GitHub connection (cloud installs). */
async function requireTaskRepositoriesConnected(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<void> {
  if (deps.requireRepositoriesConnected === undefined) return;
  const project = await deps.actions.projectRevision(deps.orgId, task.project, task.startingRevision);
  if (project !== undefined) await deps.requireRepositoriesConnected(deps.orgId, project.definition);
}

/**
 * A continue or pull request the handler refused as busy: when a close started after this route
 * checked the workspace, the answer is the closing message, not TASK_BUSY.
 */
export async function busyOrClosing(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, error: unknown): Promise<never> {
  if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.status === "CLOSING") throw agentXError("CONFIG_INVALID", CLOSING_TASK);
    const channel = await channelDriver(deps, task, workspace.activeOperationId);
    if (channel !== undefined) throw agentXError("TASK_BUSY", channel);
  }
  return busy(error, task.taskId);
}

/** C14, D4: the words for a developer's action that met a teammate's channel turn, or undefined. */
async function channelDriver(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, operationId: string | null): Promise<string | undefined> {
  if (operationId === null || task.share?.threadTs === undefined) return undefined;
  const activity = await deps.actions.channelActivity({ taskId: task.taskId, operationId, threadSubject: sharedSubject({ ...task.share, threadTs: task.share.threadTs }) });
  if (activity.driver === undefined) return undefined;
  // The name reaches the AI tool inert, as every other name there does.
  const who = activity.driver.name === undefined ? `Slack user ${activity.driver.slackUserId}` : inertName(activity.driver.name);
  // F18: a floor. The running turn may or may not still count among the thread's pending messages.
  const waiting = activity.waiting === 0 ? "" : `, and at least ${activity.waiting} more channel message${activity.waiting === 1 ? " is" : "s are"} waiting`;
  return `task ${task.taskId} is running a request from ${who} in its shared Slack thread${waiting}; wait with agentx_wait_for_task, stop it with agentx_cancel_task, or make the thread view only with agentx_share_task`;
}

/** The reasons of the caller's own extra items when only they cancelled an acceptance (the workspace was free), else undefined. */
export function extraItemsCancelled(error: unknown): string[] | undefined {
  return error instanceof AgentXError && error.code === "CONFIG_INVALID" ? (error as { extraCancellation?: string[] }).extraCancellation : undefined;
}

/** The existing handlers' busy answers, in the developer's words (FR-049's TASK_BUSY). */
export function busy(error: unknown, taskId: string): never {
  if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "WORKSPACE_NOT_READY")) {
    throw agentXError("TASK_BUSY", `task ${taskId} is still working; wait for it with agentx_wait_for_task, or stop it with agentx_cancel_task`);
  }
  throw error;
}

/**
 * Rulings R38 and R39: a human's Continue, workflow retry or send-back starts a new window of the task's own cap, at what its keys
 * have spent so far. A proxy that cannot say refuses the action before anything is written (MODEL_PROXY_UNAVAILABLE, 503).
 * Undefined on an install with no model proxy, where there is no cap to reset.
 */
export async function capWindowBaseline(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<number | undefined> {
  // A spend approval's resume keeps the window the approval left (Task 32).
  return deps.modelAccess === undefined || deps.spendResume?.keepWindow === true ? undefined
    : taskSpendBaseline({ documentClient: deps.documentClient, tableName: deps.tableName, access: deps.modelAccess }, task.modelKeyIds ?? []);
}

/** Task 32 (Task 31's concern 1): a pause written mid-run is stale once someone goes on with the task; a run held at its start keeps it until its approval. */
export const staleBudgetPause = (task: DeveloperTaskRecord): boolean => task.budgetPause !== undefined && task.budgetPause.firstDispatch === undefined;

/**
 * Owner decision 2 = A: a person's Continue, retry or send-back never skips an approval unless they may decide it themselves. Refused, naming who is asked, before
 * anything is read for or written to the task. A system resume (`spendResume`, a spend approval going on) is the approval itself.
 */
export async function requireMayGoOn(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord): Promise<void> {
  if (deps.spendResume !== undefined || deps.pausedTaskGate === undefined || !staleBudgetPause(task)) return;
  const gate = await deps.pausedTaskGate({ orgId: deps.orgId, developerId: caller.developerId }, task);
  if (!gate.allowed) throw agentXError("WORKSPACE_BUSY", `This run is waiting for ${gate.who} to approve more. Continuing can't skip that approval.`);
}

/** An agent-step run takes no free-form turn: the engine owns its steps, and a coding session in its workspace would break the run's no-shell guarantee. */
export const AGENT_RUN_TURN_REFUSAL = "An agent run takes no follow-up. Start a new run instead.";

/**
 * The clause and values that record the window in the same update that moves the task, since one transaction cannot touch a record twice. The clause comes
 * last in its update: with `task`, it also removes a stale mid-run pause (Task 32).
 */
export function capWindowUpdate(baseline: number | undefined, task?: DeveloperTaskRecord): { clause: string; values: Record<string, number> } {
  const pause = task !== undefined && staleBudgetPause(task) ? " REMOVE budgetPause" : "";
  return baseline === undefined ? { clause: pause, values: {} } : { clause: `, budgetBaselineUsd = :budgetBaseline${pause}`, values: { ":budgetBaseline": baseline } };
}

/** MONEY (mainline #408 sync): what Rovara's own moves (AUTOFIX) write for the cap window: nothing. Only a person's retry or send-back starts a new window. */
export const AUTOMATIC_KEEPS_WINDOW: { clause: string; values: Record<string, number> } = { clause: "", values: {} };

/** MONEY (mainline #408 sync): Rovara does not go on by itself while the task waits for someone to approve more money; the person who approves decides. Answered as the task having moved on ("STALE"). */
export function refuseAutomaticWhilePaused(task: DeveloperTaskRecord): void {
  if (task.budgetPause !== undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "this task is waiting for an approval of more spend; Rovara does not go on by itself");
}

/** The task's update in a Continue: the new cap window (R38) and, Task 32, the removal of a stale mid-run pause; nothing when neither applies. */
export function windowAndPauseUpdate(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, baseline: number | undefined, admission?: CapturedTaskStop, reference?: SpendingAdmissionReference): TransactItems {
  if (admission !== undefined) {
    const a = new Aliases(), values: Record<string, unknown> = { ":now": iso(deps), ":stop": admission, ":cap": admission.effectiveStopMicrousd / 1_000_000 };
    const sets = ["updatedAt = :now", "budgetUsd = :cap", "spendingStop = :stop"], removes: string[] = [];
    if (reference === undefined) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task admission reference is unavailable.");
    sets.push("spendingAdmission = :admission"); values[":admission"] = reference;
    if (baseline !== undefined) { sets.push("budgetBaselineUsd = :baseline"); values[":baseline"] = baseline; }
    if (staleBudgetPause(task)) removes.push("budgetPause");
    const maxPerRun = taskMaxPerRunForAdmission(admission);
    if (maxPerRun !== undefined) {
      const exactMaxUsd = maxPerRun / 1_000_000;
      if (usdToWholeMicrodollars(exactMaxUsd) !== maxPerRun) throw agentXError("TASK_STOP_CONFIG_INVALID", "The task per-run stop cannot be represented exactly.");
      sets.push("maxPerRunUsd = :taskStop"); values[":taskStop"] = exactMaxUsd;
    } else if (task.maxPerRunUsd !== undefined) removes.push("maxPerRunUsd");
    const conditions = ["attribute_exists(pk)", "attribute_not_exists(closedAt)"];
    for (const field of ["orgId", "project", "agent", "payer", "developerId", "ownerKey", "budgetUsd", "maxPerRunUsd", "budgetBaselineUsd", "spendingStop", "spendingAdmission"] as const) {
      const value = task[field]; conditions.push(value === undefined ? `attribute_not_exists(${a.name(field)})` : `${a.name(field)} = ${a.value(value)}`);
    }
    return [{ Update: { TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: `SET ${sets.join(", ")}${removes.length === 0 ? "" : ` REMOVE ${removes.join(", ")}`}`,
      ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: a.names, ExpressionAttributeValues: { ...values, ...a.values } } }];
  }
  const removes = staleBudgetPause(task) ? " REMOVE budgetPause" : "";
  if (baseline === undefined && removes === "") return [];
  return [{ Update: {
    TableName: deps.tableName, Key: taskKey(task.taskId),
    UpdateExpression: baseline === undefined ? `SET updatedAt = :now${removes}` : `SET budgetBaselineUsd = :baseline${removes}`,
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt)",
    ExpressionAttributeValues: baseline === undefined ? { ":now": iso(deps) } : { ":baseline": baseline },
  } }];
}

/** What a `continue` that only resumed a parked task tells the person: the parked operation runs as it was queued, so the new instructions were not used. */
export const RESUMED_WITH_ORIGINAL_INSTRUCTIONS = "This task was paused while you could only view the project. It has resumed with its original instructions; the instructions you just sent were not used, so send them again once it finishes.";

/**
 * A parked plain task is redriven exactly as it was queued (its invocation is not rewritten), so a `continue` that resumed it carries its new
 * instructions nowhere. Say so as an event on the resumed operation, once per request: the task view already shows events to every client. The task
 * has resumed whether or not this lands, so a failure here is logged (its name only) and never fails the continue.
 */
export async function noteResumedWithOriginal(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, requestId: string): Promise<void> {
  try {
    const workspace = await deps.actions.workspace(task.workspaceId);
    if (workspace.activeOperationId === null) return;
    await appendOperationEvent(deps.documentClient as never, deps.tableName, {
      workspaceId: task.workspaceId, operationId: workspace.activeOperationId, fence: workspace.fence, onceKey: `resumed-original-${requestId}`,
      event: { type: "progress", timestamp: iso(deps), payload: { message: RESUMED_WITH_ORIGINAL_INSTRUCTIONS } },
    });
  } catch (error) {
    log(deps, { event: "developer.resume_note_failed", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
  }
}
