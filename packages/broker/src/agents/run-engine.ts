import { budgetActorRefused } from "./budget-authority.js";
import { failedIndexes } from "./table-writes.js";
// Plan 3, Task 22: the agent-step engine. A run of an agent made of agent steps (`recipeRunner(recipe) === "agent_steps"`) is a task that holds ONE
// workspace. When its preparation is done the engine dispatches the steps in order, each as an ordinary task operation whose payload is
// `agentStep.kind === "agent"`; an `approval` step waits for a person in place; a step whose calls asked for write approvals waits for them too, and
// once they are decided the same step runs again with what came of each. The run's state is the one item `DEVTASK#<task> / AGENT_RUN`, and every change
// of it is a conditional write on its `revision`, in the same transaction as what the change owes (the operation, the task event, the dispatch row), so a
// repeated callback or a second process finds the work done and does nothing.
//
// What makes the engine run: the worker's terminal result and a decided approval, each of which calls it directly, and ONE row of the WORKFLOW_DISPATCH
// index (`kind: "agent_run"`), written in the same transaction as whatever made the engine owe something, run by the recovery sweep when the direct call
// was lost, and when a step's result never arrived, by the time it was due as a watchdog. Everything the sweep does is what the direct call does.
//
// Public surface (Plan 4 and Plan 5 build on these): `advanceAgentRun`, `onAgentStepFinished`, `onWriteDecided`, `cancelAgentRun`, `registerTaskEndHandler`,
// `registerTaskPauseHandler`, `onTaskEnded`, `prepareSlackReport`.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AGENT_REPORT_MAX_BYTES, AGENT_STEP_INPUTS_MAX_BYTES, AgentRunStateSchema, AgentStepGroundingSchema, AgentXError, BUDGET_EXHAUSTED_FAILURE_MESSAGE, SHORTENED_MARKER, UNVERIFIED_END_PREFIX,
  agentXError, redactText, renderRunInput, shortenToBytes,
  type AgentRunState, type AgentStepTools, type OrgId, type PauseScope, type ResolvedRecipe, type ResolvedStep, type ResultContract, type RunCheckout,
} from "@agentx/contracts";
import type { DeveloperTaskActions, TransactItems } from "../aws/developer-task-actions.js";
import { WORKFLOW_DISPATCH_PK, agentRunDispatchItem, agentRunDispatchKey } from "../aws/broker-shared.js";
import { effectiveTaskOwner, taskAgentRunKey, taskKey, taskPointerKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import {
  createStepApproval, getAnyApproval, pendingWriteApprovals, registerApprovalSubjectHandler,
  type AnyApprovalRecord, type ApprovalDependencies, type WriteApprovalRecord,
} from "./approvals.js";
import { expireApprovalNow } from "./approvals-decide.js";
import { commitOrLost, errorNameOf, iso, log, registerApprovalGaveUpHandler, shownText, type TransactItem } from "./approvals-store.js";
import { readGuardrails } from "./guardrails.js";
import { readTaskRecipe } from "./runs.js";
import { prepareSlackReport } from "./slack-report.js";
import { WRITE_APPROVER_RULE, writeApproversFor } from "./write-gate.js";
import { END_LEASE_MS, approvalEndReason, onTaskEnded, onTaskPaused, type TaskEndHost, type TaskEndOutcome } from "./task-end.js";

export type { TaskEndEvent, TaskEndHandler, TaskEndOutcome, TaskPauseEvent, TaskPauseHandler } from "./task-end.js";
export { hasTaskEndHandlers, onTaskEnded, onTaskPaused, onTaskResumed, registerTaskEndHandler, registerTaskPauseHandler, registerTaskResumeHandler } from "./task-end.js";
export { CHATOPS_PATTERNS, prepareSlackReport } from "./slack-report.js";
export type { PreparedSlackReport } from "./slack-report.js";

// ---- what the engine needs from the broker

export interface StartStepInput {
  task: DeveloperTaskRecord;
  /** Derived from the task, step and attempt, so a repeat of the same dispatch is the broker's duplicate of the first. */
  requestId: string;
  /** Known before the operation is made, so the run's own update (written in the operation's transaction) can name it. */
  operationId: string;
  prompt: string;
  step: Extract<ResolvedStep, { kind: "agent" }>;
  /** What the worker is given as the one user turn: the request, the earlier steps' reports and, on a continuation, what came of the approvals. */
  inputs: string;
  resultContract?: ResultContract;
  checkout?: readonly RunCheckout[];
  /** Items for the operation's own transaction: the run's update, its event and its dispatch row. */
  extra: (operationId: string) => TransactItems;
}

/**
 * What the broker supplies to the engine (`agentRouteDependencies` builds it). `startStep` is `acceptTask` with the step's payload; the rest is the broker's
 * own checks and the parts of an end that are not the engine's. Every method may be missing in a test that does not need it.
 */
export interface AgentRunHost extends TaskEndHost {
  startStep(input: StartStepInput): Promise<{ operationId: string; duplicate: boolean }>;
  /** `requireCreatorStillMember` (R60): throws `TASK_ACCESS_DENIED` and records `creator_removed` on the task when its creator has left the org. */
  requireCreator(task: DeveloperTaskRecord): Promise<void>;
  /** Task 10's `requireRecipeAllowed` against the company's guardrails as they are now. */
  requireRecipeAllowed(task: DeveloperTaskRecord, recipe: ResolvedRecipe): Promise<void>;
  /** Keeps a step's report with the task (`agent-step-<id>.md`); the object key, or undefined when it could not be kept. */
  saveReport?(input: { task: DeveloperTaskRecord; operationId: string; stepId: string; text: string }): Promise<string | undefined>;
  /** The task's page. */
  taskUrl?(taskId: string): string | undefined;
  /** The Slack channels bound to the project, sorted. */
  slackChannels?(orgId: OrgId, project: string): Promise<readonly string[]>;
  /** Asks the worker to stop an operation that is still running (never a finished one, which it leaves alone). A run that ends while its step runs calls it. */
  stopOperation?(task: DeveloperTaskRecord, operationId: string): Promise<void>;
  /**
   * Asks for the pause (and the spend request) a budget stop of `operationId` stands for, when the task has none yet: the broker works the scope out from the task's
   * own spend and writes it (`requestForPausedTask`). Never throws for a stop that has nothing to ask for. Called by the sweep for a run that waits for its pause.
   */
  askForPause?(task: DeveloperTaskRecord, operationId: string): Promise<void>;
  /**
   * Plan 5 Task 11b: the messages people sent to the run from its session, for the step about to be dispatched. `redoFrom` is the step's `notesFrom` when it runs again (a continuation
   * after approvals, a rerun after a pause), so it is handed the notes it was handed before as well as the new ones; absent for a step's first run. Without it a run gives no messages.
   */
  stepNotes?(task: DeveloperTaskRecord, requestId: string, redoFrom?: string): Promise<StepNotes>;
}

/**
 * The people's messages a step is given (Plan 5 Task 11b): `section` is the prompt section under Task 11a's header ("" when there are none), `before` is the task's mark of notes already
 * given when it was read ("" when none), `noteCount` the task's note count as read, and `markItem` the update that moves the mark past what was given, to go in the step's own transaction
 * (conditional on the count read, so a message saved meanwhile fails it and is read again). No `markItem` when the step is shown only notes an earlier step was given.
 */
export interface StepNotes { section: string; before: string; noteCount?: number; markItem?: TransactItems[number] }

export type AgentRunEngineDependencies = ApprovalDependencies;

// ---- vocabulary

const ENDED = new Set<AgentRunState["state"]>(["COMPLETE", "FAILED", "CANCELLED"]);
/** After a step's outcomes were handed back this many times, a step that asks for more approvals still waits for them, but its outcomes are not handed back again. */
const MAX_CONTINUATIONS = 4;
/** What a run keeps of the reports in its state item (DynamoDB's item limit is 400 KB, and the request and the steps share it). */
const REPORTS_TOTAL_MAX_BYTES = 150 * 1024;
const MINUTE = 60_000;
/** A step's watchdog is due this long after its time limit; a run waiting for a person is looked at every six hours. */
const WATCHDOG_GRACE_MS = 15 * MINUTE;
const DEFAULT_STEP_MINUTES = 60;
const WAITING_WATCHDOG_MS = 6 * 60 * MINUTE;
/** How many times a step is made again because a message was saved while it was being made. */
const NOTES_TRIES = 3;
const OUTCOMES_HEADER = "Outcomes of the actions that needed approval:";
const CANCELLED_REASON = "Cancelled.";
const CLOSED_REASON = "The task was closed.";
const FAILED_NO_REPORT = "The step ended without a report.";
/** How long a run waits for the pause of a budget stop the broker had not written one for, and how often it looks meanwhile (final fix wave, runs I-1). */
const PAUSE_WAIT_MS = 10 * MINUTE;
const PAUSE_LOOK_MS = 2 * MINUTE;
const NO_PAUSE_REASON = "The step ran out of budget, but no limit that could be raised was found, so the run stopped. Start the run again.";
const GAVE_UP_REASON = "Rovara couldn't continue this run after an approval was decided, so it stopped. Start the run again.";

export type AdvanceResult = "no_run" | "ended" | "paused" | "waiting" | "busy" | "dispatched" | "completed";

const utf8Length = (text: string): number => Buffer.byteLength(text, "utf8");
const sha = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** A UUID made from a seed alone, so the same dispatch always has the same request and operation ids. */
function uuidFrom(seed: string): string {
  const bytes = sha(`rovara-agent-run:${seed}`).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hostOf(deps: AgentRunEngineDependencies): AgentRunHost {
  const host = (deps as { agentRuns?: AgentRunHost }).agentRuns;
  if (host === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "agent runs are not set up in this deployment");
  return host;
}

// ---- reading

interface Loaded { task: DeveloperTaskRecord; run: AgentRunState }

async function getItem<T>(deps: AgentRunEngineDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
}

/** The task and its run, both read now. A task partition is global: an item that names another org reads as missing. */
async function load(deps: AgentRunEngineDependencies, taskId: string, orgId?: OrgId): Promise<Loaded | undefined> {
  const [task, raw] = await Promise.all([getItem<DeveloperTaskRecord>(deps, taskKey(taskId)), getItem<Record<string, unknown>>(deps, taskAgentRunKey(taskId))]);
  if (task === undefined || raw === undefined || task.orgId === undefined || raw["orgId"] !== task.orgId) return undefined;
  if (orgId !== undefined && task.orgId !== orgId) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only the key attributes are dropped
  const { pk: _pk, sk: _sk, entityType: _type, ...state } = raw;
  const run = AgentRunStateSchema.safeParse(state);
  if (!run.success) {
    log(deps, "agent_run.unreadable", { taskId, problem: run.error.issues[0]?.path.join(".") ?? "run" });
    return undefined;
  }
  return { task, run: run.data };
}

function stepOf(recipe: ResolvedRecipe, stepId: string): ResolvedStep | undefined {
  return recipe.steps.find((step) => step.id === stepId);
}

const lastAgentStepId = (recipe: ResolvedRecipe): string | undefined => recipe.steps.filter((step) => step.kind === "agent").at(-1)?.id;

async function recipeOf(deps: AgentRunEngineDependencies, task: DeveloperTaskRecord): Promise<ResolvedRecipe> {
  const frozen = await readTaskRecipe(deps, task.taskId, task.orgId as OrgId);
  if (frozen === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the agent snapshot of this task can't be read");
  return frozen.recipe;
}

// ---- the approvals of a task

const APPROVAL_EVENT_SK = /^EVENT#[^#]+#(apr_[0-9a-z]{20})$/;

/** The ids of the write approvals a task's steps asked for: each left one task event named by it (Task 21). The partition is global, so the org on each item is checked. */
async function writeApprovalIds(deps: AgentRunEngineDependencies, orgId: OrgId, taskId: string): Promise<string[]> {
  const ids = new Set<string>();
  let start: Record<string, unknown> | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": "EVENT#" },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const id = typeof item["sk"] === "string" ? APPROVAL_EVENT_SK.exec(item["sk"])?.[1] : undefined;
      if (id !== undefined && item["orgId"] === orgId) ids.add(id);
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return [...ids];
}

/** Every approval of the run, each read now and checked to be this task's in this org: the write approvals of its steps and the approvals its steps are waiting on. */
async function taskApprovals(deps: AgentRunEngineDependencies, task: DeveloperTaskRecord, run: AgentRunState): Promise<AnyApprovalRecord[]> {
  const orgId = task.orgId as OrgId;
  const ids = new Set([...await writeApprovalIds(deps, orgId, task.taskId), ...run.steps.flatMap((step) => step.approvalIds)]);
  const found: AnyApprovalRecord[] = [];
  for (const id of ids) {
    const record = await getAnyApproval(deps, orgId, id);
    if (record === undefined || record.kind === "change" || (record.subject as { taskId?: unknown }).taskId !== task.taskId) continue;
    found.push(record);
  }
  return found.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.approvalId.localeCompare(right.approvalId));
}

const isOpen = (record: AnyApprovalRecord): boolean => record.status === "PENDING" || record.status === "EXECUTING";

/** One line of what came of a write approval, in the words the model is handed. */
function outcomeLine(record: WriteApprovalRecord): string {
  switch (record.status) {
    case "APPROVED_DONE": return `Approved and done: ${record.summary}`;
    case "APPROVED_FAILED": return `Approved but not run: ${record.summary} (${record.failure ?? "it didn't go through"})`;
    case "DECLINED": return `Declined: ${record.summary}`;
    case "EXPIRED": return `Expired: ${record.summary}`;
    default: return `Waiting: ${record.summary}`;
  }
}

// ---- what the model is handed

/**
 * The one user turn of a step: the run's request, then each earlier report under `Report from <step name>:`, shortened to leave room (the payload carries at most
 * 256 KiB). A continuation also gets the step's own report from before the outcomes were known, and then the outcomes themselves.
 * The messages people sent to the run (`notesSection`, Task 11b) are always last.
 */
export function renderStepInputs(run: AgentRunState, stepId: string, continuation?: { ownReport?: string; lines: readonly string[] }, notesSection = ""): string {
  const base = renderRunInput(run.input);
  const notes = notesSection === "" ? "" : `\n\n${notesSection}`;
  const tail = continuation === undefined ? "" : `\n\n${OUTCOMES_HEADER}\n${continuation.lines.join("\n")}`;
  const earlier = run.reports.filter((report) => report.stepId !== stepId);
  const own = continuation?.ownReport === undefined ? undefined : `\n\nYour report for this step before the outcomes were known:\n${continuation.ownReport}`;
  const headers = earlier.reduce((total, report) => total + utf8Length(`\n\nReport from ${report.name}:\n`), 0);
  const room = AGENT_STEP_INPUTS_MAX_BYTES - utf8Length(base) - utf8Length(tail) - utf8Length(notes) - headers - (own === undefined ? 0 : utf8Length(own)) - 1024;
  const share = Math.max(utf8Length(SHORTENED_MARKER) + 64, Math.floor(room / Math.max(1, earlier.length + (own === undefined ? 0 : 1))));
  const reports = earlier.map((report) => `\n\nReport from ${report.name}:\n${shortenToBytes(report.text, share)}`).join("");
  const ownBlock = own === undefined ? "" : `\n\nYour report for this step before the outcomes were known:\n${shortenToBytes(continuation!.ownReport!, share)}`;
  // The people's messages are the end of the turn, after the earlier reports and the outcomes.
  return `${base}${reports}${ownBlock}${tail}${notes}`;
}

/** A report as the run keeps it: redacted, at most 32,768 bytes (cut inside no character), and non-empty. */
function reportText(report: string | undefined): string | undefined {
  if (report === undefined || report.trim() === "") return undefined;
  return shortenToBytes(redactText(report), AGENT_REPORT_MAX_BYTES);
}

/** The run's reports with `text` for `stepId` (replacing the step's earlier one), keeping the total the state item can hold. */
function withReport(run: AgentRunState, step: { id: string; name: string }, text: string): AgentRunState["reports"] {
  const others = run.reports.filter((report) => report.stepId !== step.id);
  const used = others.reduce((total, report) => total + utf8Length(report.text), 0);
  const kept = shortenToBytes(text, Math.max(1024, Math.min(AGENT_REPORT_MAX_BYTES, REPORTS_TOTAL_MAX_BYTES - used)));
  const entry = { stepId: step.id, name: step.name, text: kept };
  const at = run.reports.findIndex((report) => report.stepId === step.id);
  return at < 0 ? [...run.reports, entry] : run.reports.map((report, index) => (index === at ? entry : report));
}

// ---- writing

const stateItem = (taskId: string, state: AgentRunState): Record<string, unknown> => ({ ...taskAgentRunKey(taskId), entityType: "AGENT_RUN", ...state });

/** The run's next state as one conditional write on the revision that was read: a lost race changes nothing. */
function putRun(deps: AgentRunEngineDependencies, taskId: string, previous: AgentRunState, next: Omit<AgentRunState, "revision">): TransactItem {
  return {
    Put: {
      TableName: deps.tableName, Item: stateItem(taskId, { ...next, revision: previous.revision + 1 }),
      ConditionExpression: "#revision = :revision AND #org = :org", ExpressionAttributeNames: { "#revision": "revision", "#org": "orgId" }, ExpressionAttributeValues: { ":revision": previous.revision, ":org": previous.orgId },
    },
  };
}

function eventItem(deps: AgentRunEngineDependencies, task: DeveloperTaskRecord, revision: number, text: string, kind: "status" | "error" = "status", at = iso(deps.now())): TransactItem {
  return { Put: { TableName: deps.tableName, Item: { pk: `DEVTASK#${task.taskId}`, sk: `EVENT#${at}#run${String(revision)}`, entityType: "TASK_EVENT", orgId: task.orgId, kind, text: shownText(text, 500), at } } };
}

const dispatchRow = (deps: AgentRunEngineDependencies, task: DeveloperTaskRecord, revision: number, dueInMs: number, operationId?: string): TransactItem =>
  agentRunDispatchItem(deps.tableName, { taskId: task.taskId, orgId: task.orgId as string, revision, dueAt: iso(deps.now() + dueInMs), now: iso(deps.now()), ...(operationId === undefined ? {} : { operationId }) });

type StepChange = { [K in keyof AgentRunState["steps"][number]]?: AgentRunState["steps"][number][K] | undefined };
/** The steps with `change` applied to `stepId`; a field given as undefined is removed. */
const withStep = (run: AgentRunState, stepId: string, change: StepChange): AgentRunState["steps"] =>
  run.steps.map((step) => {
    if (step.id !== stepId) return step;
    const merged: Record<string, unknown> = { ...step, ...change };
    for (const [name, value] of Object.entries(change)) if (value === undefined) delete merged[name];
    return merged as AgentRunState["steps"][number];
  });

const withoutFields = (run: AgentRunState): Omit<AgentRunState, "revision"> => {
  const { revision: _revision, ...rest } = run; // eslint-disable-line @typescript-eslint/no-unused-vars -- putRun sets it
  return rest;
};

// ---- ending

const END_OUTCOME: Record<"COMPLETE" | "FAILED" | "CANCELLED", TaskEndOutcome> = { COMPLETE: "succeeded", FAILED: "failed", CANCELLED: "cancelled" };

/**
 * Ends the run in ONE transaction: its terminal state and reason, the mark on the task that gives its workspace back (`agentRunEnd`), the event and the
 * dispatch row that stays, due at once, until the follow-up (`finishEnd`) is done. Then does the follow-up. Answers false when another writer got there first.
 */
async function endRun(deps: AgentRunEngineDependencies, loaded: Loaded, end: { state: "COMPLETE" | "FAILED" | "CANCELLED"; reason?: string; outcome?: TaskEndOutcome; finalReport?: string; branch?: string; stepStatus?: "failed" | "done" }): Promise<boolean> {
  const { task, run } = loaded;
  const at = iso(deps.now());
  const steps = run.steps.map((step) => (step.status === "running" || step.status === "waiting" ? { ...step, status: end.stepStatus ?? (end.state === "COMPLETE" ? "done" as const : "failed" as const) } : step));
  const next: Omit<AgentRunState, "revision"> = {
    ...withoutFields(run), state: end.state, steps, endedAt: at,
    ...(end.reason === undefined ? {} : { endReason: end.reason }),
    ...(end.finalReport === undefined ? {} : { finalReport: end.finalReport }),
    ...(end.branch === undefined ? {} : { branch: end.branch }),
  };
  const words = end.state === "COMPLETE" ? "The run finished." : end.state === "CANCELLED" ? (end.reason ?? CANCELLED_REASON) : `The run failed. ${end.reason ?? ""}`.trim();
  const items: TransactItem[] = [
    putRun(deps, task.taskId, run, next),
    { Update: { TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET agentRunEnd = :end", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":end": { state: end.state, at } } } },
    eventItem(deps, task, run.revision + 1, words, end.state === "FAILED" ? "error" : "status", at),
    dispatchRow(deps, task, run.revision + 1, 0),
  ];
  if (!await commitOrLost(deps, items)) return false;
  const ended: Loaded = { task: { ...task, agentRunEnd: { state: end.state, at } }, run: { ...next, revision: run.revision + 1 } };
  await finishEnd(deps, ended, end.outcome ?? END_OUTCOME[end.state]);
  return true;
}

/**
 * A run that ends while a step is still running asks the worker to stop that step: its keys are blocked at the end, but a step left running would go on
 * working (and asking for approvals) for a run that is over. A step whose operation already ended is left alone (Task 22 review, I3). It is asked from
 * `finishEnd`, so a process that died between the end's commit and this call is made good by the sweep (final fix wave, runs minor 5): the end turned the
 * running step `failed`, and stopping an operation is idempotent. False when the worker could not be asked, and the end is then not finished.
 */
async function stopRunningSteps(deps: AgentRunEngineDependencies, task: DeveloperTaskRecord, run: AgentRunState): Promise<boolean> {
  const host = (deps as { agentRuns?: AgentRunHost }).agentRuns;
  if (host?.stopOperation === undefined || run.state === "COMPLETE") return true;
  let stopped = true;
  for (const step of run.steps) {
    const operationId = step.status === "running" || step.status === "failed" ? step.operationIds.at(-1) : undefined;
    if (operationId === undefined) continue;
    try {
      await host.stopOperation(task, operationId);
    } catch (error) {
      stopped = false;
      log(deps, "agent_run.stop_failed", { taskId: task.taskId, error: errorNameOf(error) });
    }
  }
  return stopped;
}

/**
 * What follows a run's end, each part safe to do again: the approvals still PENDING end, the task's end is told (its workspace, keys and handlers), the final
 * report is posted or noted, and the dispatch row goes. A failure leaves the row, so the sweep does the rest; so does an end another call is still telling.
 */
async function finishEnd(deps: AgentRunEngineDependencies, loaded: Loaded, outcome?: TaskEndOutcome): Promise<void> {
  const { task, run } = loaded;
  const host = hostOf(deps);
  const stopped = await stopRunningSteps(deps, task, run);
  for (const record of await taskApprovals(deps, task, run)) {
    if (record.status === "PENDING") await expireApprovalNow(deps, record);
  }
  const ended = outcome ?? (task.outcome === "creator_removed" ? "creator_removed" : END_OUTCOME[run.state as "COMPLETE" | "FAILED" | "CANCELLED"]);
  const told = await onTaskEnded({ ...deps, agentRuns: host }, task, ended, { ...(run.finalReport === undefined ? {} : { finalReport: run.finalReport }), ...(run.branch === undefined ? {} : { branch: run.branch }) }, { record: true });
  if (told === "in_progress") {
    // Another call holds the end and may die with it: the row stays, due when its lease could have run out, so whoever looks then finishes the end.
    await rearm(deps, task, run, END_LEASE_MS + 5_000);
    return;
  }
  if (run.state === "COMPLETE") await reportToSlack(deps, loaded);
  // A step the worker could not be asked to stop leaves the row, so the sweep asks again.
  if (!stopped) {
    await rearm(deps, task, run, PAUSE_LOOK_MS);
    return;
  }
  await dropRow(deps, task.taskId, run.revision);
}

/** The final report of a run whose last agent step reports to Slack: handed to the notifier for the project's channel, or noted on the task when there is none. Once per run. */
async function reportToSlack(deps: AgentRunEngineDependencies, loaded: Loaded): Promise<void> {
  const { task, run } = loaded;
  const host = hostOf(deps);
  const recipe = await recipeOf(deps, task);
  const reporting = [...recipe.steps].reverse().find((step) => step.kind === "agent" && run.reports.some((report) => report.stepId === step.id));
  if (reporting === undefined || reporting.kind !== "agent" || reporting.report?.slack !== true || run.finalReport === undefined) return;
  const orgId = task.orgId as OrgId;
  const at = run.endedAt ?? iso(deps.now());
  const channels = host.slackChannels === undefined ? [] : await host.slackChannels(orgId, task.project);
  const channel = channels[0];
  if (channel === undefined) {
    // No channel is bound: nothing is posted, and the owner is told why on the task's page (always so on Rovara Cloud until Slack is set up there).
    // The engine, not the notifier, appends this event: the binding is known here, and the page then does not depend on the notifier being deployed. The key
    // (`EVENT#<endedAt>#report`) is the same on every try, so a repeat overwrites the one event (a ruling of the Task 22 review, recorded as a deviation).
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { pk: `DEVTASK#${task.taskId}`, sk: `EVENT#${at}#report`, entityType: "TASK_EVENT", orgId, kind: "status", at,
      text: `No Slack channel is set up for ${task.project}, so the report is only on this page.` } }));
    return;
  }
  const taskUrl = host.taskUrl?.(task.taskId);
  if (taskUrl === undefined) return;
  const guardrails = await readGuardrails(deps, orgId);
  const prepared = prepareSlackReport(run.finalReport, { orgId, taskUrl, reportLinkDomains: guardrails.reportLinkDomains, extraCommandWords: guardrails.extraCommandWords });
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName, ConditionExpression: "attribute_not_exists(pk)",
      Item: { pk: `DEVTASK#${task.taskId}`, sk: "AGENT_REPORT", entityType: "AGENT_REPORT_POST", orgId, taskId: task.taskId, channelId: channel, kind: prepared.kind, text: prepared.text, status: "PENDING", attempts: 0, createdAt: at },
    }));
  } catch (error) {
    if (errorNameOf(error) !== "ConditionalCheckFailedException") throw error;
  }
}

/** The run ends because of how the task stands (closed, its creator removed): not a step's own failing. */
async function endFor(deps: AgentRunEngineDependencies, loaded: Loaded, error: unknown): Promise<boolean | undefined> {
  if (!(error instanceof AgentXError)) return undefined;
  const reason = error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message;
  if (error.code === "TASK_ACCESS_DENIED") return endRun(deps, loaded, { state: "CANCELLED", reason, outcome: "creator_removed" });
  // Refusals that trying again cannot change: the run ends with their own words instead of waiting through the sweep's tries.
  if (error.code === "MODEL_NOT_ALLOWED" || error.code === "CONFIG_INVALID" || error.code === "PROJECT_ACCESS_DENIED" || error.code === "FORBIDDEN") return endRun(deps, loaded, { state: "FAILED", reason });
  return undefined;
}

// ---- dispatching

/** What a try at moving the run on came to: it moved (or has its next work in the dispatch row), it ended, or it lost a race and must look again. */
type Moved = "moved" | "ended" | "retry";

/** Whether the task was closed or cancelled behind the run's back. */
async function taskIsOver(deps: AgentRunEngineDependencies, task: DeveloperTaskRecord): Promise<boolean> {
  if (task.closedAt !== undefined) return true;
  const pointer = await getItem<{ cancelledAt?: unknown }>(deps, taskPointerKey(task.workspaceId));
  return pointer?.cancelledAt !== undefined;
}

/** Why the run must not go on, in the words it ends with: a cancel was asked for while a step ran, or the task was closed or cancelled. Undefined: nothing stops it. */
async function overReason(deps: AgentRunEngineDependencies, loaded: Loaded): Promise<string | undefined> {
  if (loaded.run.cancelRequestedAt !== undefined) return CANCELLED_REASON;
  return await taskIsOver(deps, loaded.task) ? CLOSED_REASON : undefined;
}

/** Ends the run CANCELLED because it is over (see `overReason`). */
async function endOver(deps: AgentRunEngineDependencies, loaded: Loaded, reason: string): Promise<Moved> {
  return await endRun(deps, loaded, { state: "CANCELLED", reason }) ? "ended" : "retry";
}

/**
 * The one gate every dispatch goes through, the first of a step, a continuation after approvals and an approval step alike: the run is not over (cancelled or the
 * task closed), the task's creator is still a member, and the company's guardrails still allow the agent's recipe. A refusal that trying again cannot change ends
 * the run with its own words; a temporary one is thrown for the sweep to try again (Task 22 review, M1).
 */
async function gate(deps: AgentRunEngineDependencies, loaded: Loaded, known?: ResolvedRecipe): Promise<{ recipe: ResolvedRecipe } | { moved: Moved }> {
  const { task } = loaded;
  const over = await overReason(deps, loaded);
  if (over !== undefined) return { moved: await endOver(deps, loaded, over) };
  const host = hostOf(deps);
  try {
    await host.requireCreator(task);
    const recipe = known ?? await recipeOf(deps, task);
    await host.requireRecipeAllowed(task, recipe);
    return { recipe };
  } catch (error) {
    const ended = await endFor(deps, loaded, error);
    if (ended === undefined) throw error;
    return { moved: ended ? "ended" : "retry" };
  }
}

function watchdogMs(step: ResolvedStep): number {
  const minutes = (step.settings as { timeoutMinutes?: number | null }).timeoutMinutes ?? DEFAULT_STEP_MINUTES;
  return (minutes * MINUTE) + WATCHDOG_GRACE_MS;
}

/** How many times a step was handed the outcomes of its approved actions. A run from before the count has its operations less the first (a rerun after a budget pause was counted too, which only holds it back). */
const continuationsOf = (state: AgentRunState["steps"][number]): number => state.continuations ?? Math.max(0, state.operationIds.length - 1);

/** What a step is handed beyond its first inputs: the report it made before the outcomes were known, one line for each outcome, and which approvals those were. */
interface Continuation { ownReport?: string; lines: string[]; told: string[] }

/**
 * A step that is to run again after a budget pause is handed what came of the writes its earlier runs asked for (decided before or while it was paused), so it does
 * not ask for them again: the same lines a continuation has (Task 22 review, M7). The new run starts from the request alone, so every decided write is told again,
 * the ones an earlier continuation was told as well.
 */
async function rerunOutcomes(deps: AgentRunEngineDependencies, loaded: Loaded, step: ResolvedStep): Promise<Continuation | undefined> {
  const existing = loaded.run.steps.find((entry) => entry.id === step.id);
  if (existing === undefined || existing.operationIds.length === 0) return undefined;
  const approvals = (await taskApprovals(deps, loaded.task, loaded.run))
    .filter((record): record is WriteApprovalRecord => record.kind === "write" && record.subject.stepId === step.id && !isOpen(record));
  if (approvals.length === 0) return undefined;
  const own = loaded.run.reports.find((report) => report.stepId === step.id)?.text;
  return { ...(own === undefined ? {} : { ownReport: own }), lines: approvals.map(outcomeLine), told: approvals.map((record) => record.approvalId) };
}

/** Dispatches the step's operation (or a continuation of it): the operation, and with it the run's next state, its event and its watchdog, in one transaction. */
async function dispatchStep(
  deps: AgentRunEngineDependencies, loaded: Loaded, recipe: ResolvedRecipe, step: Extract<ResolvedStep, { kind: "agent" }>,
  options: { continuation?: Continuation; counted?: boolean; nativeRecoveryChecks?: readonly TransactItem[] } = {},
): Promise<Moved> {
  const { task, run } = loaded;
  const gated = await gate(deps, loaded, recipe);
  if ("moved" in gated) return gated.moved;
  const host = hostOf(deps);
  const existing = run.steps.find((entry) => entry.id === step.id)!;
  const attempt = existing.operationIds.length;
  const operationId = uuidFrom(`op|${task.taskId}|${step.id}|${String(attempt)}`);
  const requestId = uuidFrom(`request|${task.taskId}|${step.id}|${String(attempt)}`);
  // Plan 5 Task 11b: a step's first run is handed the notes no step has been handed yet; a run of it again (a continuation, a rerun) is handed the ones it was handed before as well.
  const redoFrom = attempt === 0 ? undefined : existing.notesFrom;
  const text = options.continuation === undefined ? `Started ${step.name}.` : `Carrying on with ${step.name} now that the outcomes of the actions that needed approval are known.`;
  for (let tries = 1; ; tries += 1) {
    const notes = host.stepNotes === undefined ? undefined : await host.stepNotes(task, requestId, redoFrom);
    const inputs = renderStepInputs(run, step.id, options.continuation, notes?.section);
    const next: Omit<AgentRunState, "revision"> = {
      ...withoutFields(run), state: "RUNNING",
      steps: withStep(run, step.id, {
        status: "running", operationIds: [...existing.operationIds, operationId], pendingBranch: undefined,
        ...(options.counted === true ? { continuations: continuationsOf(existing) + 1 } : {}),
        ...(options.continuation === undefined ? {} : { told: [...new Set([...(existing.told ?? []), ...options.continuation.told])] }),
        ...(notes === undefined || existing.notesFrom !== undefined ? {} : { notesFrom: notes.before }),
      }),
    };
    try {
      await host.startStep({
        task, requestId, operationId, prompt: `Agent step: ${step.name}`, step, inputs,
        ...(step.id === lastAgentStepId(recipe) && run.resultContract !== undefined ? { resultContract: run.resultContract } : {}),
        ...(run.checkout === undefined ? {} : { checkout: run.checkout }),
        // The messages' mark moves in the step's own transaction, last: it holds only while the task's note count is the one read.
        extra: (id) => [putRun(deps, task.taskId, run, next), eventItem(deps, task, run.revision + 1, text), dispatchRow(deps, task, run.revision + 1, watchdogMs(step), id), ...(notes?.markItem === undefined ? [] : [notes.markItem]), ...(options.nativeRecoveryChecks ?? [])],
      });
      return "moved";
    } catch (error) {
      const nativeCount = options.nativeRecoveryChecks?.length ?? 0;
      const extraCancellation = error instanceof AgentXError ? (error as { extraCancellation?: string[] }).extraCancellation : undefined;
      if (nativeCount > 0 && extraCancellation?.slice(-nativeCount).includes("ConditionalCheckFailed")) throw budgetActorRefused();
      // The run moved on while the operation was being made (another process dispatched it, or ended the run): look again.
      if (error instanceof AgentXError && (error.code === "WORKSPACE_BUSY" || error.code === "STALE_FENCE")) {
        const fresh = await load(deps, task.taskId);
        if (fresh !== undefined && (fresh.run.revision !== run.revision || ENDED.has(fresh.run.state))) return "retry";
        // A message was saved after the notes were read and before the step was made: the step is made again with them (a bounded number of times).
        if (notes?.markItem !== undefined && fresh !== undefined && tries < NOTES_TRIES && fresh.task.threadNoteCount !== notes.noteCount) continue;
      }
      // The operation can't be made for a reason that will not go away (a model the company now forbids, the creator's lost access): the run ends with it.
      const ended = await endFor(deps, loaded, error);
      if (ended !== undefined) return ended ? "ended" : "retry";
      throw error;
    }
  }
}

/** Asks the owner and the maintainers to let the run go on, and waits: the approval, then the run's waiting state, its event and its slow watchdog. */
async function askForApproval(deps: AgentRunEngineDependencies, loaded: Loaded, recipe: ResolvedRecipe, step: Extract<ResolvedStep, { kind: "approval" }>): Promise<Moved> {
  const { task, run } = loaded;
  const gated = await gate(deps, loaded, recipe);
  if ("moved" in gated) return gated.moved;
  const orgId = task.orgId as OrgId;
  // The approval is for the task's owner now: the person who took it over, else its creator (Plan 5 Task 12a, R3-4).
  const owner = { developerId: effectiveTaskOwner(task).developerId, name: effectiveTaskOwner(task).name };
  const record = await createStepApproval(deps, {
    orgId, subject: { kind: "agent_run", taskId: task.taskId, stepId: step.id }, prompt: step.prompt,
    approvers: { kind: "rule", rule: WRITE_APPROVER_RULE, candidates: await writeApproversFor(deps, { orgId, project: task.project, owner }) },
    project: task.project, owner,
  });
  const next: Omit<AgentRunState, "revision"> = { ...withoutFields(run), state: "WAITING_FOR_APPROVAL", steps: withStep(run, step.id, { status: "waiting", approvalIds: [record.approvalId] }) };
  const committed = await commitOrLost(deps, [
    putRun(deps, task.taskId, run, next),
    eventItem(deps, task, run.revision + 1, `Waiting for approval: ${step.prompt}`),
    dispatchRow(deps, task, run.revision + 1, WAITING_WATCHDOG_MS),
  ]);
  if (!committed) return "retry";
  // Decided in the moments before the run was waiting: the handler found the step not waiting yet, so it hears it now.
  const again = await getAnyApproval(deps, orgId, record.approvalId);
  if (again !== undefined && again.status !== "PENDING") await onWriteDecided(deps, again);
  return "moved";
}

/**
 * Takes the run as far as it can go with nothing to wait for: dispatches the next step, asks for an approval, ends the run when its steps are done or when the
 * task no longer lets it go on. Safe to call at any time and from any process: a run that is waiting, paused, busy or over is left as it is.
 * `PAUSED_BUDGET` runs again from the step that was cut off once the task's `budgetPause` has been cleared (Task 32's approval of the raise).
 */
export async function advanceAgentRun(deps: AgentRunEngineDependencies, taskId: string, expectedPausedRevision?: number, nativeRecoveryChecks: readonly TransactItem[] = []): Promise<AdvanceResult> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let loaded = await load(deps, taskId);
    if (loaded === undefined) return "no_run";
    const { task, run } = loaded;
    if (expectedPausedRevision !== undefined && (run.revision !== expectedPausedRevision || run.state !== "PAUSED_BUDGET")) return "busy";
    if (ENDED.has(run.state)) {
      await finishEnd(deps, loaded);
      return "ended";
    }
    if (run.state === "WAITING_FOR_APPROVAL") return "waiting";
    if (run.state === "PAUSED_BUDGET") {
      if (task.budgetPause !== undefined) return "paused";
      // A run goes on only after a real pause was told, or its stop was answered before it could be: never on a stop whose pause is not known yet.
      const answered = run.pause?.operationId !== undefined && task.budgetStopOf === run.pause.operationId;
      if (run.pause?.unconfirmed === true && !answered) return "paused";
      if (run.pause !== undefined && run.pause.unconfirmed !== true && run.pause.notifiedAt === undefined && !answered) {
        // The pause was lifted before the handlers heard it: they hear it now, and then the step runs again.
        await notifyPause(deps, loaded);
        continue;
      }
      const resumed: Omit<AgentRunState, "revision"> = { ...withoutFields(run), state: "RUNNING" };
      delete (resumed as { pause?: unknown }).pause;
      try {
        if (!await commitOrLost(deps, [putRun(deps, taskId, run, resumed), eventItem(deps, task, run.revision + 1, "The run's budget was raised, so it carries on."), dispatchRow(deps, task, run.revision + 1, 0), ...nativeRecoveryChecks])) continue;
      } catch (error) {
        if ([...(failedIndexes(error) ?? [])].some(index => index >= 3)) throw budgetActorRefused();
        throw error;
      }
      loaded = { task, run: { ...resumed, revision: run.revision + 1 } };
    }
    const current = loaded.run;
    if (current.steps.some((step) => step.status === "running")) return "busy";
    const index = current.steps.findIndex((step) => step.status !== "done");
    if (index < 0) {
      const reports = current.reports;
      await endRun(deps, loaded, { state: "COMPLETE", ...(reports.at(-1) === undefined ? {} : { finalReport: reports.at(-1)!.text }) });
      return "completed";
    }
    const recipe = await recipeOf(deps, task);
    const step = stepOf(recipe, current.steps[index]!.id);
    if (step === undefined) {
      await endRun(deps, loaded, { state: "FAILED", reason: "The agent's snapshot no longer matches this run." });
      return "ended";
    }
    // The checks before a step (the run is not over, the creator is still a member, the recipe is still allowed) are the gate's, inside each dispatch.
    const moved = step.kind === "approval" ? await askForApproval(deps, loaded, recipe, step)
      : step.kind === "agent" ? await dispatchStep(deps, loaded, recipe, step, { nativeRecoveryChecks, ...await rerunOutcomes(deps, loaded, step).then((continuation) => (continuation === undefined ? {} : { continuation })) })
      : undefined;
    if (moved === undefined) {
      await endRun(deps, loaded, { state: "FAILED", reason: `${step.name} is not a step an agent run can take.` });
      return "ended";
    }
    if (moved === "retry") continue;
    if (moved === "ended") return "ended";
    return step.kind === "approval" ? "waiting" : "dispatched";
  }
  return "busy";
}

// ---- a step ended

/** What the worker's terminal result came to, as the engine hears it. */
export interface AgentStepFinished {
  taskId: string;
  operationId: string;
  outcome: "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED" | "budget_exhausted";
  /** The step's report (`result.agentStepResult.report`). */
  report?: string;
  /** The branch the worker chose (`result.agentStepResult.branch`). */
  branch?: string;
  /**
   * The worker's comparison of the report with the tool calls the step made (`result.agentStepResult.grounding`, `AgentStepGroundingSchema`), as the worker sent it: absent from an
   * older worker (one that does not list `task.agentGrounding.v1`). Read here, so a shape the broker cannot read counts as unverified.
   */
  grounding?: unknown;
  /** The worker's error, for a failed step. */
  error?: string;
}

const UNREADABLE_GROUNDING = "Rovara could not read how the report was checked against the tool calls, so it was not trusted.";
/** What the end reason says of the reasons, cut so the whole stays inside the state's limit. */
const UNVERIFIED_REASON_MAX = 900;

/**
 * What a step's grounding comes to for the run: the tools to show with the step (kept when one failed or the report is unverified) and, when the report is not backed by what
 * the agent did, the reasons. Nothing for a step with no grounding. A grounding that does not parse is unverified: a report is never trusted on a check nobody could read.
 */
function groundingOf(raw: unknown): { tools?: AgentStepTools; unverified?: string[] } | undefined {
  if (raw === undefined) return undefined;
  const parsed = AgentStepGroundingSchema.safeParse(raw);
  if (!parsed.success) return { unverified: [UNREADABLE_GROUNDING] };
  const { verdict, reasons, tools } = parsed.data;
  const unverified = verdict === "unverified" ? (reasons.length > 0 ? reasons : [UNREADABLE_GROUNDING]) : undefined;
  return { ...(tools.failed > 0 || unverified !== undefined ? { tools } : {}), ...(unverified === undefined ? {} : { unverified }) };
}

/** The tools of a step's earlier operation and this one together (a continuation after approvals is another operation of the same step). */
function mergedTools(before: AgentStepTools | undefined, now: AgentStepTools): AgentStepTools {
  if (before === undefined) return now;
  return { calls: before.calls + now.calls, failed: before.failed + now.failed, failures: [...before.failures, ...now.failures].slice(0, 10) };
}

/** The branch the worker named, when it is one the run's contract allows and the step is the last agent step (the only one that may choose). */
function chosenBranch(recipe: ResolvedRecipe, run: AgentRunState, stepId: string, branch: string | undefined): string | undefined {
  return branch !== undefined && stepId === lastAgentStepId(recipe) && run.resultContract?.branches.some((entry) => entry.id === branch) === true ? branch : undefined;
}

/**
 * The step goes on to its continuation, or is done and the run moves to its next step. What the model hears of the approvals is ONE continuation of the SAME step
 * (its earlier report and an `Outcomes of the actions that needed approval:` block), the reading of the task's Interfaces text that the Task 22 review accepted
 * for the brief's "the next step's inputs".
 */
async function afterApprovals(deps: AgentRunEngineDependencies, loaded: Loaded, recipe: ResolvedRecipe, step: ResolvedStep, approvals: WriteApprovalRecord[], branch?: string): Promise<Moved> {
  const { run } = loaded;
  const state = run.steps.find((entry) => entry.id === step.id)!;
  const toTell = approvals.filter((record) => !(state.told ?? []).includes(record.approvalId));
  if (toTell.length > 0 && continuationsOf(state) < MAX_CONTINUATIONS && step.kind === "agent") {
    return dispatchStep(deps, loaded, recipe, step, {
      counted: true,
      continuation: { ...(run.reports.find((report) => report.stepId === step.id) === undefined ? {} : { ownReport: run.reports.find((report) => report.stepId === step.id)!.text }), lines: toTell.map(outcomeLine), told: toTell.map((record) => record.approvalId) },
    });
  }
  return stepDone(deps, loaded, recipe, step, branch ?? state.pendingBranch);
}

/** The step is done: the run moves on (the next step is dispatched by the caller's advance) or, past the last step, ends COMPLETE. */
async function stepDone(deps: AgentRunEngineDependencies, loaded: Loaded, recipe: ResolvedRecipe, step: ResolvedStep, branch?: string): Promise<Moved> {
  const { task, run } = loaded;
  const index = run.steps.findIndex((entry) => entry.id === step.id);
  const steps = withStep(run, step.id, { status: "done", pendingBranch: undefined });
  const last = index === run.steps.length - 1;
  const chosen = chosenBranch(recipe, run, step.id, branch);
  const next: Omit<AgentRunState, "revision"> = { ...withoutFields(run), state: "RUNNING", steps, cursor: Math.min(index + 1, run.steps.length), ...(chosen === undefined ? {} : { branch: chosen }) };
  if (last) {
    return await endRun(deps, { task, run }, { state: "COMPLETE", ...(run.reports.at(-1) === undefined ? {} : { finalReport: run.reports.at(-1)!.text }), ...(chosen === undefined ? {} : { branch: chosen }) }) ? "ended" : "retry";
  }
  return await commitOrLost(deps, [putRun(deps, task.taskId, run, next), eventItem(deps, task, run.revision + 1, `${step.name} is done.`), dispatchRow(deps, task, run.revision + 1, 0)]) ? "moved" : "retry";
}

/**
 * The worker's result for a step's operation. Hears each operation once: a result for an operation that is not the step's latest, or a step that is no longer
 * running, changes nothing. A run that was cancelled while the step ran (or whose task was closed) ends CANCELLED whatever the step came to. A successful step
 * whose calls asked for write approvals waits for them (the run is WAITING_FOR_APPROVAL), or, when they were all decided while it ran, goes on at once with what
 * came of each; any other successful step is done and the run goes on to the next. A step that ran out of budget pauses the run; a failed or interrupted one
 * fails it; a cancelled one cancels it.
 */
export async function onAgentStepFinished(deps: AgentRunEngineDependencies, input: AgentStepFinished): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const loaded = await load(deps, input.taskId);
    if (loaded === undefined) return;
    const { task, run } = loaded;
    const state = run.steps.find((entry) => entry.operationIds.at(-1) === input.operationId);
    if (state === undefined || state.status !== "running" || ENDED.has(run.state)) return;
    const recipe = await recipeOf(deps, task);
    const step = stepOf(recipe, state.id);
    if (step === undefined) return;
    const over = await overReason(deps, loaded);
    if (over !== undefined) {
      if (await endRun(deps, loaded, { state: "CANCELLED", reason: over })) return;
      continue;
    }
    if (input.outcome === "CANCELLED") {
      if (await endRun(deps, loaded, { state: "CANCELLED", reason: CANCELLED_REASON })) return;
      continue;
    }
    if (input.outcome === "budget_exhausted") {
      if (await pauseRun(deps, loaded, state.id)) return;
      continue;
    }
    if (input.outcome === "FAILED" || input.outcome === "INTERRUPTED") {
      const reason = input.outcome === "INTERRUPTED" ? "The step was interrupted before it finished." : shownText(input.error ?? "The step failed.", 400);
      if (input.error === BUDGET_EXHAUSTED_FAILURE_MESSAGE ? await pauseRun(deps, loaded, state.id) : await endRun(deps, loaded, { state: "FAILED", reason })) return;
      continue;
    }
    const text = reportText(input.report);
    if (text === undefined) {
      if (await endRun(deps, loaded, { state: "FAILED", reason: FAILED_NO_REPORT })) return;
      continue;
    }
    const host = hostOf(deps);
    const reportKey = host.saveReport === undefined ? undefined : await host.saveReport({ task, operationId: input.operationId, stepId: state.id, text }).catch((error: unknown) => {
      log(deps, "agent_run.report_not_kept", { taskId: task.taskId, error: errorNameOf(error) });
      return undefined;
    });
    const grounding = groundingOf(input.grounding);
    // A worker without `task.agentGrounding.v1` sends none: the report was not checked, and the run goes on as it always did (a worker that checks sends a verdict even for a clean step).
    if (input.grounding === undefined) log(deps, "agent_run.step_unchecked", { taskId: task.taskId });
    const reported: AgentRunState = {
      ...run, reports: withReport(run, step, text),
      steps: withStep(run, state.id, {
        ...(reportKey === undefined ? {} : { reportKey }),
        ...(grounding?.tools === undefined ? {} : { tools: mergedTools(state.tools, grounding.tools) }),
        ...(grounding?.unverified === undefined ? {} : { unverified: grounding.unverified }),
      }),
    };
    // A report nothing backs is never a success: the run ends FAILED with the reasons, keeping the report for a person to read. Whatever the step asked to write waits no longer
    // (the end expires its approvals), and no later step is handed it as a finding.
    if (grounding?.unverified !== undefined) {
      if (await endRun(deps, { task, run: reported }, { state: "FAILED", reason: shownText(`${UNVERIFIED_END_PREFIX}${grounding.unverified.join(" ")}`, UNVERIFIED_REASON_MAX), finalReport: text })) return;
      continue;
    }
    const approvals = (await taskApprovals(deps, task, reported)).filter((record): record is WriteApprovalRecord => record.kind === "write" && record.subject.stepId === state.id);
    const open = approvals.filter(isOpen);
    // The step's own counter of pending approvals is read too: an approval the task's events do not show (more events than are read) still holds the step.
    const counted = await pendingWriteApprovals(deps, task.orgId as OrgId, task.taskId, state.id);
    if (open.length > 0 || counted > 0) {
      const branch = chosenBranch(recipe, run, state.id, input.branch);
      const next: Omit<AgentRunState, "revision"> = {
        ...withoutFields(reported), state: "WAITING_FOR_APPROVAL",
        steps: withStep(reported, state.id, { status: "waiting", approvalIds: approvals.map((record) => record.approvalId), pendingBranch: branch }),
      };
      const waitingFor = Math.max(open.length, counted);
      if (!await commitOrLost(deps, [putRun(deps, task.taskId, run, next), eventItem(deps, task, run.revision + 1, `${step.name} is waiting for ${String(waitingFor)} ${waitingFor === 1 ? "action" : "actions"} to be approved.`), dispatchRow(deps, task, run.revision + 1, WAITING_WATCHDOG_MS)])) continue;
      return;
    }
    // Every approval the step asked for is decided: the report goes into the transaction that moves the step on (its continuation, or the next step).
    const withApprovals: AgentRunState = { ...reported, steps: withStep(reported, state.id, { approvalIds: approvals.map((record) => record.approvalId) }) };
    const moved = await afterApprovals(deps, { task, run: withApprovals }, recipe, step, approvals, chosenBranch(recipe, run, state.id, input.branch));
    if (moved === "retry") continue;
    if (moved === "ended") return;
    await advanceAgentRun(deps, task.taskId);
    return;
  }
}

// ---- a budget pause

/**
 * The step ran out of budget: the step is to run again and the run waits for the limit to be raised. The task is read again here (the one in hand may be older than
 * the stop's pause, or newer than its answer), and the answer decides:
 *   - the task has a `budgetPause`: the run is PAUSED_BUDGET with that scope, and the pause handlers hear it (not the end handlers);
 *   - it has none, and `budgetStopOf` names this operation: the stop was already answered (an approval cleared its pause before this result was driven), so the step
 *     simply runs again and no pause is told;
 *   - it has neither (the proxy's mid-step "budget exceeded": the broker had not written a pause): the run is PAUSED_BUDGET with an unconfirmed pause that nobody
 *     is told, and its row is due again in two minutes. The sweep asks for the pause, then tells it or, after a bounded wait, ends the run FAILED.
 */
async function pauseRun(deps: AgentRunEngineDependencies, loaded: Loaded, stepId: string): Promise<boolean> {
  const { run } = loaded;
  const task = await getItem<DeveloperTaskRecord>(deps, taskKey(loaded.task.taskId)) ?? loaded.task;
  const stopped = run.steps.find((entry) => entry.id === stepId)?.operationIds.at(-1);
  const at = iso(deps.now());
  const pending = withStep(run, stepId, { status: "pending" });
  if (task.budgetPause === undefined && stopped !== undefined && task.budgetStopOf === stopped) {
    const resumed: Omit<AgentRunState, "revision"> = { ...withoutFields(run), state: "RUNNING", steps: pending };
    delete (resumed as { pause?: unknown }).pause;
    return commitOrLost(deps, [putRun(deps, task.taskId, run, resumed), eventItem(deps, task, run.revision + 1, "The run's budget was raised, so it carries on."), dispatchRow(deps, task, run.revision + 1, 0)]);
  }
  const real = task.budgetPause?.scope;
  const pause: NonNullable<AgentRunState["pause"]> = real === undefined
    ? { scope: { kind: "task", taskId: task.taskId } satisfies PauseScope, at, ...(stopped === undefined ? {} : { operationId: stopped }), unconfirmed: true }
    : { scope: real, at, ...(stopped === undefined ? {} : { operationId: stopped }) };
  const next: Omit<AgentRunState, "revision"> = { ...withoutFields(run), state: "PAUSED_BUDGET", steps: pending, pause };
  if (!await commitOrLost(deps, [
    putRun(deps, task.taskId, run, next), eventItem(deps, task, run.revision + 1, "The run is paused: its budget ran out."),
    dispatchRow(deps, task, run.revision + 1, real === undefined ? PAUSE_LOOK_MS : 0),
  ])) return false;
  await notifyPause(deps, { task, run: { ...next, revision: run.revision + 1 } });
  return true;
}

/** Tells the pause handlers once; the row stays until they have been told. A pause that is not confirmed yet is told to nobody. */
async function notifyPause(deps: AgentRunEngineDependencies, loaded: Loaded): Promise<void> {
  const { task, run } = loaded;
  if (run.state !== "PAUSED_BUDGET" || run.pause === undefined || run.pause.unconfirmed === true) return;
  let seen = run.revision;
  if (run.pause.notifiedAt === undefined) {
    await onTaskPaused({ ...deps, agentRuns: hostOf(deps) }, task, run.pause.scope as PauseScope);
    const next: Omit<AgentRunState, "revision"> = { ...withoutFields(run), pause: { ...run.pause, notifiedAt: iso(deps.now()) } };
    if (await commitOrLost(deps, [putRun(deps, task.taskId, run, next)])) seen = run.revision + 1;
  }
  await dropRow(deps, task.taskId, seen);
}

/**
 * A run whose pause is not confirmed (`pause.unconfirmed`): looks for the pause the stop stands for. Asks for it (the broker's own ask may have failed), and then:
 *   - a pause exists: the run's pause becomes that scope and the handlers are told, once ("paused");
 *   - there is none and the stop was answered (`budgetStopOf`): the step may run again, and nothing is told ("answered");
 *   - neither within the bounded wait: the run ends FAILED with the budget words, as the plain-task path does ("ended");
 *   - neither yet: it waits, its row due again soon ("waiting").
 */
async function confirmPause(deps: AgentRunEngineDependencies, loaded: Loaded): Promise<"paused" | "answered" | "ended" | "waiting"> {
  const { run } = loaded;
  const pause = run.pause;
  if (pause === undefined || pause.unconfirmed !== true) return "paused";
  const read = async () => await getItem<DeveloperTaskRecord>(deps, taskKey(loaded.task.taskId)) ?? loaded.task;
  const answered = (task: DeveloperTaskRecord) => pause.operationId !== undefined && task.budgetStopOf === pause.operationId;
  let task = await read();
  if (task.budgetPause === undefined && !answered(task) && pause.operationId !== undefined) {
    const host = hostOf(deps);
    try {
      await host.askForPause?.(task, pause.operationId);
    } catch (error) {
      log(deps, "agent_run.pause_not_asked", { taskId: task.taskId, error: errorNameOf(error) });
    }
    task = await read();
  }
  if (task.budgetPause !== undefined) {
    const confirmed: Omit<AgentRunState, "revision"> = { ...withoutFields(run), pause: { scope: task.budgetPause.scope, at: pause.at, ...(pause.operationId === undefined ? {} : { operationId: pause.operationId }) } };
    if (!await commitOrLost(deps, [putRun(deps, task.taskId, run, confirmed)])) return "waiting";
    await notifyPause(deps, { task, run: { ...confirmed, revision: run.revision + 1 } });
    return "paused";
  }
  if (answered(task)) return "answered";
  if (deps.now() - Date.parse(pause.at) > PAUSE_WAIT_MS) return await endRun(deps, loaded, { state: "FAILED", reason: NO_PAUSE_REASON }) ? "ended" : "waiting";
  return "waiting";
}

// ---- an approval was decided

/**
 * The write approvals of a waiting agent step, once none is open: the step runs again (or is done) in the one transaction that takes the run out of its waiting
 * state. "open": something is still pending (a record, or the step's counter), so the run waits on.
 */
async function resumeWrites(deps: AgentRunEngineDependencies, loaded: Loaded, recipe: ResolvedRecipe, step: ResolvedStep): Promise<Moved | "open"> {
  const { task, run } = loaded;
  if (step.kind !== "agent") return "open";
  const approvals = (await taskApprovals(deps, task, run)).filter((entry): entry is WriteApprovalRecord => entry.kind === "write" && entry.subject.stepId === step.id);
  if (approvals.some(isOpen) || await pendingWriteApprovals(deps, task.orgId as OrgId, task.taskId, step.id) > 0) return "open";
  return afterApprovals(deps, loaded, recipe, step, approvals);
}

/** A waiting agent step whose write approvals have been decided goes on. Hears the same decision again without changing anything. */
async function resumeAfterWrites(deps: AgentRunEngineDependencies, taskId: string, orgId: OrgId, stepId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const loaded = await load(deps, taskId, orgId);
    if (loaded === undefined) return;
    const state = loaded.run.steps.find((entry) => entry.id === stepId);
    if (state === undefined || state.status !== "waiting" || ENDED.has(loaded.run.state)) return;
    const over = await overReason(deps, loaded);
    if (over !== undefined) {
      if (await endRun(deps, loaded, { state: "CANCELLED", reason: over })) return;
      continue;
    }
    const recipe = await recipeOf(deps, loaded.task);
    const step = stepOf(recipe, stepId);
    if (step === undefined) return;
    const moved = await resumeWrites(deps, loaded, recipe, step);
    if (moved === "open" || moved === "ended") return;
    if (moved === "retry") continue;
    await advanceAgentRun(deps, taskId);
    return;
  }
}

/**
 * The subject handler for `agent_run` approvals (registered for `write` and `step` records). The approvals core calls it up to 8 times for one decision, so it
 * changes nothing the second time:
 *   - a step approval that was APPROVED lets the run go on; DECLINED or EXPIRED ends it CANCELLED, with `<step name> declined: <prompt>` or `... expired: ...`;
 *   - a write approval for a step that waits: once every approval the step asked for is decided, the same step runs again with one line for each (see
 *     `outcomeLine`) and its report replaces the step's;
 *   - a write approval for a step that still runs, or a run that is over, is not the handler's business (the step hears it when it ends);
 *   - a run that was cancelled, or whose task was closed, ends instead of going on.
 * An approval of a task or run it does not know is ignored.
 */
export async function onWriteDecided(deps: AgentRunEngineDependencies, record: AnyApprovalRecord): Promise<void> {
  if (record.kind === "change" || record.subject.kind !== "agent_run") return;
  const subject = record.subject as { taskId?: string; stepId?: string };
  if (typeof subject.taskId !== "string" || typeof subject.stepId !== "string") return;
  if (record.kind === "write") {
    await resumeAfterWrites(deps, subject.taskId, record.orgId, subject.stepId);
    return;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const loaded = await load(deps, subject.taskId, record.orgId);
    if (loaded === undefined) return;
    const { task, run } = loaded;
    const state = run.steps.find((entry) => entry.id === subject.stepId);
    if (state === undefined || state.status !== "waiting" || ENDED.has(run.state)) return;
    if (!state.approvalIds.includes(record.approvalId)) return;
    const over = await overReason(deps, loaded);
    if (over !== undefined) {
      if (await endRun(deps, loaded, { state: "CANCELLED", reason: over })) return;
      continue;
    }
    const recipe = await recipeOf(deps, task);
    const step = stepOf(recipe, state.id);
    if (step === undefined) return;
    if (record.status === "APPROVED") {
      const moved = await stepDone(deps, loaded, recipe, step);
      if (moved === "retry") continue;
      if (moved === "moved") await advanceAgentRun(deps, task.taskId);
      return;
    }
    if (record.status === "DECLINED" || record.status === "EXPIRED") {
      if (await endRun(deps, loaded, { state: "CANCELLED", reason: approvalEndReason(step.name, record.status, record.prompt) })) return;
      continue;
    }
    return;
  }
}

/**
 * `approval.handler_gave_up` (Task 21's sweep stopped trying to tell the handler about a decision): the run can't be taken up again from that approval, so
 * it fails with a clear reason and the owner finds it on the task. It must never hang. Only a run that still waits on that very approval fails: one that has
 * moved on since (the sweep's own look found the decision and went on) is healthy, and the hook leaves it alone (Task 22 review, I3).
 */
export async function onApprovalGaveUp(deps: AgentRunEngineDependencies, record: AnyApprovalRecord): Promise<void> {
  if (record.kind === "change" || record.subject.kind !== "agent_run") return;
  const subject = record.subject as { taskId?: string; stepId?: string };
  if (typeof subject.taskId !== "string" || typeof subject.stepId !== "string") return;
  const loaded = await load(deps, subject.taskId, record.orgId);
  if (loaded === undefined || ENDED.has(loaded.run.state)) return;
  const state = loaded.run.steps.find((entry) => entry.id === subject.stepId);
  if (state === undefined || state.status !== "waiting") return;
  // A step approval is the one the step waits on; a write approval that was already handed back to the model belongs to an earlier round of the step.
  if (record.kind === "step" ? !state.approvalIds.includes(record.approvalId) : (state.told ?? []).includes(record.approvalId)) return;
  await endRun(deps, loaded, { state: "FAILED", reason: GAVE_UP_REASON });
}

registerApprovalSubjectHandler("agent_run", (deps, record) => onWriteDecided(deps, record));
registerApprovalGaveUpHandler("agent_run", (deps, record) => onApprovalGaveUp(deps, record));

// ---- cancelling

/** Ends the run CANCELLED now, whatever it is doing, when nothing is running for it to wait for (a cancel of a run that waits, or between steps). */
export async function cancelAgentRun(deps: AgentRunEngineDependencies, taskId: string, reason = CANCELLED_REASON): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const loaded = await load(deps, taskId);
    if (loaded === undefined) return false;
    if (ENDED.has(loaded.run.state)) {
      await finishEnd(deps, loaded);
      return false;
    }
    if (await endRun(deps, loaded, { state: "CANCELLED", reason })) return true;
  }
  return false;
}

// ---- driven by the sweep or by a result

/**
 * Writes the run's dispatch row again, due `inMs` from now: the run is looked at then, not before. Conditional on the row being none, or one written no later than
 * the state this pass read: a row a concurrent resume or result wrote (a fresh watchdog, or one due now) is never pushed out (final fix wave, runs minor 4).
 */
async function rearm(deps: AgentRunEngineDependencies, task: DeveloperTaskRecord, run: AgentRunState, inMs: number): Promise<void> {
  const item = agentRunDispatchItem(deps.tableName, { taskId: task.taskId, orgId: task.orgId as string, revision: run.revision, dueAt: iso(deps.now() + inMs), now: iso(deps.now()) });
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName, Item: (item as { Put: { Item: Record<string, unknown> } }).Put.Item,
      ConditionExpression: "attribute_not_exists(pk) OR workflowRevision <= :revision", ExpressionAttributeValues: { ":revision": run.revision },
    }));
  } catch (error) {
    if (errorNameOf(error) !== "ConditionalCheckFailedException") throw error;
  }
}

/** Deletes the run's dispatch row only when it was written no later than the state this pass last saw: a newer row belongs to work this pass did not see. */
async function dropRow(deps: AgentRunEngineDependencies, taskId: string, upToRevision: number): Promise<void> {
  try {
    await deps.documentClient.send(new DeleteCommand({
      TableName: deps.tableName, Key: agentRunDispatchKey(taskId), ConditionExpression: "attribute_not_exists(pk) OR workflowRevision <= :revision", ExpressionAttributeValues: { ":revision": upToRevision },
    }));
  } catch (error) {
    if (errorNameOf(error) !== "ConditionalCheckFailedException") throw error;
  }
}

/** The prepare operation of the task's workspace, for a run whose preparation did not succeed. */
async function preparation(deps: AgentRunEngineDependencies, task: DeveloperTaskRecord): Promise<{ status: string; error?: string } | undefined> {
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", FilterExpression: "kind = :prepare",
    ExpressionAttributeValues: { ":pk": `WORKSPACE#${task.workspaceId}`, ":prefix": "OPERATION#", ":prepare": "prepare" }, ConsistentRead: true,
  })) as { Items?: Array<{ status?: unknown; error?: unknown }> };
  const prepare = page.Items?.[0];
  return prepare === undefined ? undefined : { status: String(prepare.status), ...(typeof prepare.error === "string" ? { error: prepare.error } : {}) };
}

/**
 * A run that waits whose approvals have all been decided without anyone going on from them (the handler was not told, or gave up and its hook failed): the
 * handler's own work is done now, from the records. A step approval that was decided and a step whose write approvals are all closed (by their records and the
 * step's counter) are the cases.
 */
async function reconcileWaiting(deps: AgentRunEngineDependencies, loaded: Loaded): Promise<void> {
  const { task, run } = loaded;
  const waiting = run.steps.find((step) => step.status === "waiting");
  if (waiting === undefined) return;
  const approvals = await taskApprovals(deps, task, run);
  const mine = approvals.filter((record) => (record.subject as { stepId?: unknown }).stepId === waiting.id);
  const stepApproval = mine.find((record) => record.kind === "step");
  if (stepApproval !== undefined) {
    if (!isOpen(stepApproval)) await onWriteDecided(deps, stepApproval);
    return;
  }
  if (!mine.some(isOpen)) await resumeAfterWrites(deps, task.taskId, task.orgId as OrgId, waiting.id);
}

/**
 * What the dispatch row runs. First the end of a run that already ended (its follow-up may not have been done), then the pause's notice, then a preparation
 * that failed, then the step's own result when the operation has ended but nothing heard it (the callback was lost), then the approvals that were decided
 * without anyone going on from them, then the next step. A step whose operation is still running is left, and the row is looked at again after its
 * watchdog; a run that waits for a person is looked at again after six hours.
 */
export async function driveAgentRun(deps: AgentRunEngineDependencies, taskId: string): Promise<"DONE" | "WAIT" | "STALE"> {
  const loaded = await load(deps, taskId);
  if (loaded === undefined) {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: agentRunDispatchKey(taskId) }));
    return "STALE";
  }
  const { task, run } = loaded;
  if (ENDED.has(run.state)) {
    await finishEnd(deps, loaded);
    return "DONE";
  }
  if (run.state === "PAUSED_BUDGET") {
    if (run.pause?.unconfirmed === true) {
      const found = await confirmPause(deps, loaded);
      if (found === "paused") return "DONE";
      if (found === "ended") return "DONE";
      if (found === "waiting") {
        const waiting = await load(deps, taskId);
        if (waiting !== undefined && !ENDED.has(waiting.run.state)) await rearm(deps, waiting.task, waiting.run, PAUSE_LOOK_MS);
        return "WAIT";
      }
    } else if (task.budgetPause !== undefined) {
      await notifyPause(deps, loaded);
      return "DONE";
    }
    await advanceAgentRun(deps, taskId);
  } else if (run.state === "WAITING_FOR_APPROVAL") {
    // A task closed (or cancelled) while the run waited ends the run, whoever decides or never decides anything (Task 22 review, I1).
    const over = await overReason(deps, loaded);
    if (over !== undefined) await endRun(deps, loaded, { state: "CANCELLED", reason: over });
    else await reconcileWaiting(deps, loaded);
  } else {
    if (run.steps.every((step) => step.operationIds.length === 0)) {
      const workspace = await getItem<{ status?: unknown }>(deps, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
      if (workspace?.status === "PREPARATION_FAILED") {
        const prepare = await preparation(deps, task);
        const cancelled = prepare?.status === "CANCELLED";
        await endRun(deps, loaded, { state: cancelled ? "CANCELLED" : "FAILED", reason: cancelled ? CANCELLED_REASON : shownText(prepare?.error ?? "The workspace could not be prepared, so the run could not start.", 400) });
        return "DONE";
      }
    }
    for (const step of run.steps.filter((entry) => entry.status === "running")) {
      const operationId = step.operationIds.at(-1)!;
      const operation = await getItem<Record<string, unknown>>(deps, { pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${operationId}` });
      if (operation === undefined) continue;
      const status = String(operation["status"]);
      if (!["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(status)) continue;
      const result = (operation["result"] ?? undefined) as { agentStepResult?: { report?: unknown; branch?: unknown; grounding?: unknown } } | undefined;
      const error = typeof operation["error"] === "string" ? operation["error"] : undefined;
      await onAgentStepFinished(deps, {
        taskId, operationId, outcome: status as AgentStepFinished["outcome"],
        ...(typeof result?.agentStepResult?.report === "string" ? { report: result.agentStepResult.report } : {}),
        ...(typeof result?.agentStepResult?.branch === "string" ? { branch: result.agentStepResult.branch } : {}),
        ...(result?.agentStepResult?.grounding === undefined ? {} : { grounding: result.agentStepResult.grounding }),
        ...(error === undefined ? {} : { error }),
      });
    }
    await advanceAgentRun(deps, taskId);
  }
  const after = await load(deps, taskId);
  if (after === undefined) return "STALE";
  if (ENDED.has(after.run.state)) {
    await finishEnd(deps, after);
    return "DONE";
  }
  if (after.run.state === "PAUSED_BUDGET") return "DONE";
  // Nothing more to do now: the row is due again when the watchdog says, not at the next sweep.
  const stepRunning = after.run.steps.find((step) => step.status === "running");
  await rearm(deps, after.task, after.run, after.run.state === "WAITING_FOR_APPROVAL" ? WAITING_WATCHDOG_MS : (stepRunning === undefined ? 2 * MINUTE : 30 * MINUTE));
  return "WAIT";
}

/** Gives a run the sweep could not take forward a clear end: the row ran out of tries. */
export async function giveUpAgentRun(deps: AgentRunEngineDependencies, taskId: string): Promise<void> {
  const loaded = await load(deps, taskId);
  if (loaded === undefined) {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: agentRunDispatchKey(taskId) }));
    return;
  }
  if (ENDED.has(loaded.run.state)) {
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: agentRunDispatchKey(taskId) }));
    return;
  }
  await endRun(deps, loaded, { state: "FAILED", reason: "Rovara couldn't continue this run. Start it again." });
}

// ---- what the task shows

/** The run as the task view shows it; `confirmOrigin` is where approvals are decided. Undefined for a task with no run (or another org's). */
export async function agentRunView(deps: Pick<ApprovalDependencies, "documentClient" | "tableName" | "now" | "log">, task: DeveloperTaskRecord, confirmOrigin?: string): Promise<{
  state: AgentRunState["state"]; currentStep?: { id: string; name: string };
  steps: Array<{ id: string; name: string; status: AgentRunState["steps"][number]["status"]; report?: string; tools?: AgentStepTools; unverified?: string[] }>;
  pendingApprovals: Array<{ approvalId: string; kind: "write" | "step"; text: string; confirmUrl?: string }>;
  finalReport?: string; branch?: string; endReason?: string;
} | undefined> {
  const engine = deps as AgentRunEngineDependencies;
  const loaded = await load(engine, task.taskId, task.orgId);
  if (loaded === undefined) return undefined;
  const { run } = loaded;
  const recipe = await recipeOf(engine, task).catch(() => undefined);
  const nameOf = (id: string): string => (recipe === undefined ? undefined : stepOf(recipe, id)?.name) ?? id;
  const current = ENDED.has(run.state) ? undefined : run.steps.find((step) => step.status !== "done");
  const pending = ENDED.has(run.state) ? [] : (await taskApprovals(engine, task, run)).filter((record) => record.status === "PENDING");
  return {
    state: run.state,
    ...(current === undefined ? {} : { currentStep: { id: current.id, name: nameOf(current.id) } }),
    steps: run.steps.map((step) => {
      const report = run.reports.find((entry) => entry.stepId === step.id)?.text;
      return {
        id: step.id, name: nameOf(step.id), status: step.status, ...(report === undefined ? {} : { report: shownReport(report) }),
        ...(step.tools === undefined ? {} : { tools: step.tools }), ...(step.unverified === undefined ? {} : { unverified: step.unverified }),
      };
    }),
    pendingApprovals: pending.flatMap((record) => (record.kind === "write" || record.kind === "step") ? [{
      approvalId: record.approvalId, kind: record.kind, text: record.kind === "write" ? record.summary : (record).prompt,
      ...(confirmOrigin === undefined ? {} : { confirmUrl: `${confirmOrigin}/v1/app/approve/${record.approvalId}` }),
    }] : []),
    ...(run.finalReport === undefined ? {} : { finalReport: run.finalReport }),
    ...(run.branch === undefined ? {} : { branch: run.branch }),
    ...(run.endReason === undefined ? {} : { endReason: run.endReason }),
  };
}

/** A step's report in the view is cut to 8 KiB (the whole one is the task's artifact), so a run of many steps stays a view a client can read. */
const shownReport = (text: string): string => shortenToBytes(text, 8192);

/** The approval events of a task (Task 21 writes one per write approval, in the task's own partition), as the view's events; another org's items are left out. */
export async function taskLevelEvents(deps: Pick<ApprovalDependencies, "documentClient" | "tableName">, task: DeveloperTaskRecord): Promise<Array<{ at: string; kind: "status" | "error"; text: string }>> {
  const events: Array<{ at: string; kind: "status" | "error"; text: string }> = [];
  let start: Record<string, unknown> | undefined;
  for (let pages = 0; pages < 5; pages += 1) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVTASK#${task.taskId}`, ":prefix": "EVENT#" },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      if (item["orgId"] !== task.orgId || typeof item["text"] !== "string" || typeof item["at"] !== "string") continue;
      events.push({ at: item["at"], kind: item["kind"] === "error" ? "error" : "status", text: item["text"] });
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return events.sort((left, right) => left.at.localeCompare(right.at));
}

export { WORKFLOW_DISPATCH_PK };
export type { DeveloperTaskActions };
