// Setup agent (design setup-test-health 3.1-3.6; task SH11): the broker's start and stop of a `setup_agent` run, modelled on the setup draft (setup-draft.ts) and the deep diagnosis (diagnosis/deep.ts).
// A setup run is a task with `purpose: "setup_agent"`: the agent has a shell in a setup sandbox and runs the project's setup and test commands, reads the errors and tries again, inside fixed limits, and
// ends with a proposal. This module is the broker's side only. It is NOT wired to a route, a switch or the task start (SH14): it exports the functions and the shapes the wiring calls.
//
// What this module decides, and what it leaves to the shared task start:
//   - WHO may start or stop a run: a project maintainer (`edit_settings`), as the setup draft; the `su` switch (`deps.enabled`) must be on, else every route is "not found".
//   - WHO PAYS: the payer rules of any task (the project when it pays, else the member who started it), asked of `deps.payerFor`. Never Rovara, never an agent or a chain. The money itself is the shared start's:
//     the budget floor, the allowed-model checks and the run limit. This module only says WHICH run limit: the setup budget of the run's limits ($4 by default, owner decision 13), so a task start for a setup run
//     must use `request.runLimitUsd` as its starting limit and not the planning limit of a Quick plan.
//   - THE LIMITS: `effectiveSetupAgentLimits(project setting, company lock)` (SH2). A lock only lowers. The limits are fixed when the run starts and kept on the pointer, so the run ends against the
//     limits it began with even when a setting changes meanwhile. They never come from the client's request (the body is a request id and nothing else).
//   - ONE RUN PER PROJECT: the pointer item (`setupAgentPointerItem`) is written in the task's start transaction and holds only while the pointer is the one the route read. Two starts at once: one is refused.
//   - THE RESULT: `setupAgentEndItems` goes into the task's terminal result transaction (as `setupDraftEndItems` does). The worker's answer is READ AGAIN there: the proposal by `sanitizeSetupProposal` and the
//     summary by `SetupRunSummarySchema`; the stop word is the broker's own where it knows one (a person's stop, the budget, a fault) and the worker's only where it finished and said a word a worker may say.
//     No error text, no log line and no command output is ever stored: only fixed sentences.
//
// What is stored where:
//   `SETUP_DRAFT#<project>` / AGENT   the project's pointer: which task is the current run, who asked (the run's owner), when, and the limits it started with. One item, replaced by a new run once the last ended.
//   the task (`DEVTASK#<id>`)         `setupAgentResult` and `agentRunEnd`, written by the task's own result transaction.
// The status is never stored: `setupAgentState` derives it from the pointer and the task on every read.
//
// WIRING (SH14), listed in the lane report: the task start's `run.setupAgent` hunk (purpose, `pendingWorkflowMode: "SETUP_AGENT"`, `setupAgentPointerItem`, the starting limit); the dispatch mode and the
// worker feature string; the terminal result hooks (`completedWorkflowItems`, the cancel path); `release.ts`'s purpose list; the routes and the `su` switch.
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentXError,
  BUDGET_EXHAUSTED_FAILURE_MESSAGE,
  SETUP_HOST_WAIT_MAX_HOURS,
  SETUP_RUN_LIMIT_STOPS,
  SetupRunSummarySchema,
  WorkflowReviewBaseSchema,
  agentXError,
  effectiveSetupAgentLimits,
  isSetupRunLimitStop,
  projectAllows,
  runRequestKey,
  sanitizeSetupProposal,
  setupDraftKey,
  type OrgId,
  type Payer,
  type ProjectRole,
  type SetupAgentLimits,
  type SetupAgentWire,
  type SetupProposal,
  type SetupVerification,
  type SetupRunEndWord,
  type SetupRunSummary,
  type StoredProjectDefinition,
} from "@agentx/contracts";
import type { AgentRunResult } from "../agents/runs.js";
import type { TransactItem } from "../agents/table-writes.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { StatusReply } from "../aws/status-reply.js";
import { taskKey, taskPointerKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { SetupDraftRepositories } from "./setup-draft.js";
import { verifyProposalDetailed, type CitationFileReader } from "./setup-proposal-verify.js";

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;

/** The operation mode of a setup run's own step, as `SETUP_DRAFT` is the draft's. SH14 adds it to the dispatch modes and the invocation schema. */
export const SETUP_AGENT_WORKFLOW_MODE = "SETUP_AGENT" as const;

// ---- the words a person is told (fixed: never a model's, a worker's or a repository's)

export const SETUP_AGENT_BUSY = "Rovara is already setting up this project.";
export const SETUP_AGENT_FAILURES = {
  attempts_used: "Rovara used up its tries before the setup worked. It kept what it learned.",
  time_used: "Rovara ran out of time before the setup worked. It kept what it learned.",
  budget_used: "The setup run reached its spending limit before it finished. It kept what it learned.",
  hosts_waiting: "The setup needs websites that nobody has allowed yet. Allow them, then run the setup again.",
  stopped_by_person: "The setup run was stopped.",
  needs_code_change: "The setup needs a change in the code. Ask Rovara to make it as a normal task.",
  changed_repository_files: "The setup changed files that are tracked in the repository. Rovara did not keep that change.",
  infrastructure: "The setup run could not go on. Try again.",
  machine: "Rovara couldn't set up a machine to run the setup. Try again.",
  unreadable: "Rovara ran the setup but couldn't read its answer. Try again.",
  stale: "The setup run didn't finish. Try again.",
} as const;
const WHO_MAY = "only a project maintainer can set up a project with Rovara";

/** The sentence the run is asked: the project's own name and nothing from a repository, the same for every run of a project. */
export function setupAgentRequestText(project: string): string {
  return `Set up the dev environment for the project ${project} by running its setup and test commands.`;
}

/** A stop only the worker can report when it finished: the limit words, "proposed", and the two ways a run can find that setup cannot be proposed. The broker alone says a person stopped it, or a fault. */
const WORKER_STOPS: ReadonlySet<SetupRunEndWord> = new Set<SetupRunEndWord>([...SETUP_RUN_LIMIT_STOPS, "proposed", "needs_code_change", "changed_repository_files"]);

// ---- request bodies (a request id and nothing else: limits, payer and goal never come from the client)

export const SetupAgentStartBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export const SetupAgentStopBodySchema = z.object({ requestId: z.string().uuid() }).strict();

// ---- the pointer item

export interface SetupAgentPointer {
  orgId: OrgId;
  project: string;
  taskId: string;
  requestId: string;
  /** The run's owner: the person who started it. A stop by another maintainer cancels as this person. */
  requestedBy: string;
  basedOnRevision: number;
  startedAt: string;
  /** The limits the run started with. */
  limits: SetupAgentLimits;
}

/** The pointer sits beside the setup draft's, in the project's `SETUP_DRAFT#` partition, so a walk that removes the project's setup items finds it. */
export function setupAgentKey(orgId: OrgId, project: string): { pk: string; sk: string } {
  return { pk: setupDraftKey(orgId, project).pk, sk: "AGENT" };
}

/**
 * The pointer's write, for the setup run's start transaction (the shared task start includes it, as it does `setupDraftPointerItem`). It holds only while the pointer is the one the route read
 * (`seenTaskId`; none: no pointer yet), so two runs that start together cannot both win. A refusal cancels the whole start; the route then tells the person a run is already going.
 */
export function setupAgentPointerItem(
  tableName: string,
  input: { orgId: OrgId; project: string; taskId: string; requestId: string; requestedBy: string; basedOnRevision: number; startedAt: string; limits: SetupAgentLimits; seenTaskId: string | undefined },
): TransactItem {
  return { Put: {
    TableName: tableName,
    Item: {
      ...setupAgentKey(input.orgId, input.project), entityType: "SETUP_AGENT", orgId: input.orgId, project: input.project, taskId: input.taskId, requestId: input.requestId,
      requestedBy: input.requestedBy, basedOnRevision: input.basedOnRevision, startedAt: input.startedAt, limits: input.limits,
    },
    ...(input.seenTaskId === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "taskId = :seen", ExpressionAttributeValues: { ":seen": input.seenTaskId } }),
  } };
}

async function getItem(client: Client, tableName: string, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

// ---- the view

export const SETUP_AGENT_STATUSES = ["none", "running", "ready", "failed"] as const;
export type SetupAgentStatus = (typeof SETUP_AGENT_STATUSES)[number];

/** What the routes answer. No payer, no owner, no raw worker answer. */
export interface SetupAgentView {
  status: SetupAgentStatus;
  basedOnRevision: number;
  /** The limits of the run (the ones it started with), or those a run would start with now when there is none. */
  limits: SetupAgentLimits;
  taskId?: string;
  startedAt?: string;
  /** The run's session, when it has one: the Live wall's steer messages go to it (SH13). */
  sessionId?: string;
  /** How the run ended. `proposed`, or a limit's word (a partial proposal), when `ready`. */
  stop?: SetupRunEndWord;
  summary?: SetupRunSummary;
  proposal?: SetupProposal;
  failure?: string;
  /**
   * What re-reading the proposal's citations from the code host at the commits the run read found, per item (`holds`, `fails`, `unchecked`): the proposal is shown with these and never without them
   * (`verifiedView`). `verified` says every verdict is final (nothing was left unread).
   */
  verification?: Record<string, SetupVerification>;
  verified?: boolean;
}

/** What a run may take at the longest: its wall clock, the longest wait on an administrator, and an hour of grace for the end to be reported. Past it with no result the run reads as failed. */
function staleAfterMs(limits: SetupAgentLimits): number {
  return (limits.wallClockMin + SETUP_HOST_WAIT_MAX_HOURS * 60 + 60) * 60_000;
}

/** Where the project's run stands, read now. See the file header: the pointer, then the task. */
export async function setupAgentState(
  deps: Pick<SetupAgentDependencies, "documentClient" | "tableName" | "now" | "limitSettings">,
  orgId: OrgId,
  project: string,
  latestRevision: number,
): Promise<SetupAgentView> {
  return (await readState(deps, orgId, project, latestRevision)).view;
}

export async function readState(
  deps: Pick<SetupAgentDependencies, "documentClient" | "tableName" | "now" | "limitSettings">,
  orgId: OrgId,
  project: string,
  latestRevision: number,
): Promise<{ view: SetupAgentView; pointer?: SetupAgentPointer }> {
  const item = await getItem(deps.documentClient, deps.tableName, setupAgentKey(orgId, project));
  if (item === undefined || item["entityType"] !== "SETUP_AGENT" || item["orgId"] !== orgId) {
    const settings = await deps.limitSettings(orgId, project);
    return { view: { status: "none", basedOnRevision: latestRevision, limits: effectiveSetupAgentLimits(settings.project, settings.companyLock) } };
  }
  const pointer = item as unknown as SetupAgentPointer;
  // The limits the run started with. A pointer whose limits do not read is held to the defaults (never looser).
  const limits = effectiveSetupAgentLimits(pointer.limits);
  const base: Pick<SetupAgentView, "basedOnRevision" | "limits" | "taskId" | "startedAt" | "sessionId"> = { basedOnRevision: pointer.basedOnRevision, limits, taskId: pointer.taskId, startedAt: pointer.startedAt };
  const failed = (stop: SetupRunEndWord, failure: string, extra: Partial<SetupAgentView> = {}): { view: SetupAgentView; pointer: SetupAgentPointer } => ({ view: { status: "failed", ...base, stop, failure, ...extra }, pointer });
  const task = (await getItem(deps.documentClient, deps.tableName, taskKey(pointer.taskId))) as DeveloperTaskRecord | undefined;
  if (task === undefined || task.orgId !== orgId || task.purpose !== "setup_agent") return failed("infrastructure", SETUP_AGENT_FAILURES.stale);
  if (typeof task.sessionId === "string") base.sessionId = task.sessionId;
  const result = task.setupAgentResult;
  if (result?.status === "ready") {
    return { view: { status: "ready", ...base, stop: result.stop, summary: result.summary, proposal: result.proposal }, pointer };
  }
  if (result?.status === "failed") {
    return failed(result.stop, result.failure, { ...(result.summary === undefined ? {} : { summary: result.summary }), ...(result.proposal === undefined ? {} : { proposal: result.proposal }) });
  }
  // A person's stop only when one was recorded; a task closed or cancelled any other way is a run that could not go on.
  const cancelledWord = task.setupAgentStop === undefined ? ({ stop: "infrastructure", failure: SETUP_AGENT_FAILURES.infrastructure } as const) : ({ stop: "stopped_by_person", failure: SETUP_AGENT_FAILURES.stopped_by_person } as const);
  if (task.closedAt !== undefined) return failed(cancelledWord.stop, cancelledWord.failure);
  const workspace = await getItem(deps.documentClient, deps.tableName, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" });
  if (workspace?.["status"] === "PREPARATION_FAILED") return failed("infrastructure", SETUP_AGENT_FAILURES.machine);
  if (workspace?.["status"] === "CLOSED") return failed(cancelledWord.stop, cancelledWord.failure);
  const taskPointer = await getItem(deps.documentClient, deps.tableName, taskPointerKey(task.workspaceId));
  if (taskPointer?.["cancelledAt"] !== undefined) return failed(cancelledWord.stop, cancelledWord.failure);
  const started = Date.parse(pointer.startedAt);
  if (Number.isFinite(started) && deps.now() - started > staleAfterMs(limits)) return failed("infrastructure", SETUP_AGENT_FAILURES.stale);
  return { view: { status: "running", ...base }, pointer };
}

// ---- the task's end

/** What the terminal result transaction is told. */
export interface SetupAgentEndOutcome { status: string; result: unknown; error: string | undefined; repositories: SetupDraftRepositories }

type StoredResult = NonNullable<DeveloperTaskRecord["setupAgentResult"]>;

function readProposal(reported: unknown, task: Pick<DeveloperTaskRecord, "startingRevision">, repositories: SetupDraftRepositories): SetupProposal | undefined {
  const reportedMeta = typeof reported === "object" && reported !== null ? (reported as { metaRepo?: { name?: unknown; commit?: unknown } }).metaRepo : undefined;
  const metaRepo = repositories.meta !== undefined && reportedMeta?.name === repositories.meta && typeof reportedMeta.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(reportedMeta.commit)
    ? { name: repositories.meta, commit: reportedMeta.commit } : undefined;
  const read = sanitizeSetupProposal(reported, {
    basedOnRevision: task.startingRevision,
    repositories: repositories.names.map((name) => ({ name, ...(repositories.urls[name] === undefined ? {} : { url: repositories.urls[name] }) })),
    ...(metaRepo === undefined ? {} : { metaRepo }),
  });
  return read.ok ? read.proposal : undefined;
}

/** What the worker said, read again: `{ setupProposal, setupRunSummary }`. Either part may be missing or unreadable. */
function readWorkerAnswer(result: unknown, task: Pick<DeveloperTaskRecord, "startingRevision">, repositories: SetupDraftRepositories): { proposal?: SetupProposal; summary?: SetupRunSummary } {
  const answer = typeof result === "object" && result !== null ? (result as { setupProposal?: unknown; setupRunSummary?: unknown }) : {};
  const proposal = answer.setupProposal === undefined ? undefined : readProposal(answer.setupProposal, task, repositories);
  const summary = answer.setupRunSummary === undefined ? undefined : SetupRunSummarySchema.safeParse(answer.setupRunSummary);
  return { ...(proposal === undefined ? {} : { proposal }), ...(summary?.success === true ? { summary: summary.data } : {}) };
}

/** The result for an outcome: which stop word, which fixed sentence, and what the run learned. Pure. */
function resultOf(task: Pick<DeveloperTaskRecord, "startingRevision"> & { setupAgentStop?: DeveloperTaskRecord["setupAgentStop"] | undefined }, operation: { kind: string }, outcome: SetupAgentEndOutcome): StoredResult {
  const failed = (stop: SetupRunEndWord, failure: string, learned: { proposal?: SetupProposal; summary?: SetupRunSummary } = {}): StoredResult => ({
    status: "failed", stop, failure, ...(learned.proposal === undefined ? {} : { proposal: learned.proposal }), ...(learned.summary === undefined ? {} : { summary: learned.summary }),
  });
  if (operation.kind === "prepare") return failed("infrastructure", SETUP_AGENT_FAILURES.machine);
  const learned = readWorkerAnswer(outcome.result, task, outcome.repositories);
  // The broker's own knowledge first: a person's stop, and the budget running out, whatever the worker says.
  // What the run learned before it was cut short is kept: the proposal and its summary.
  const kept = { ...(learned.proposal === undefined ? {} : { proposal: learned.proposal }), ...(learned.summary === undefined ? {} : { summary: learned.summary }) };
  // A cancel is a person's stop only when Stop was pressed (recorded on the task before the cancel). Any other cancel (a sweep, a closed workspace) is a run that could not go on.
  if (outcome.status === "CANCELLED" && task.setupAgentStop !== undefined) return failed("stopped_by_person", SETUP_AGENT_FAILURES.stopped_by_person, kept);
  if (outcome.status !== "SUCCEEDED") {
    const stop = outcome.status !== "CANCELLED" && outcome.error === BUDGET_EXHAUSTED_FAILURE_MESSAGE ? "budget_used" : "infrastructure";
    return failed(stop, SETUP_AGENT_FAILURES[stop], kept);
  }
  const { proposal, summary } = learned;
  if (summary === undefined || !WORKER_STOPS.has(summary.stop)) return failed("infrastructure", SETUP_AGENT_FAILURES.unreadable);
  // Two stops mean there is nothing to confirm: setup needs a code change, or it changed tracked files (which are never kept).
  if (summary.stop === "needs_code_change") return failed("needs_code_change", SETUP_AGENT_FAILURES.needs_code_change, { summary });
  if (summary.stop === "changed_repository_files") return failed("changed_repository_files", SETUP_AGENT_FAILURES.changed_repository_files, { summary });
  if (proposal === undefined) {
    // A limit stop with nothing a person could use still says which limit it was; any other answer without a proposal is unreadable.
    return isSetupRunLimitStop(summary.stop) ? failed(summary.stop, SETUP_AGENT_FAILURES[summary.stop], { summary }) : failed("infrastructure", SETUP_AGENT_FAILURES.unreadable);
  }
  return { status: "ready", proposal, summary, stop: summary.stop };
}

/**
 * The items that end a setup-agent task, for the transaction of its terminal result (the broker's `completedWorkflowItems`): its `agentRunEnd` (which gives back its workspace) and `setupAgentResult`.
 * Never conditioned on anything but the task being there, and each attribute keeps the first value (`if_not_exists`), so a result is never refused because the project's pointer moved and a late or
 * repeated end changes nothing. A task that is not a setup run, or an operation that is not the run's own (or its preparation failing), writes nothing.
 */
export function setupAgentEndItems(
  tableName: string,
  task: Pick<DeveloperTaskRecord, "taskId" | "purpose" | "project" | "startingRevision"> & { orgId?: OrgId | undefined; setupAgentStop?: DeveloperTaskRecord["setupAgentStop"] | undefined },
  operation: { kind: string; workflowMode?: string | undefined },
  outcome: SetupAgentEndOutcome,
  now: string,
): TransactItem[] {
  if (task.purpose !== "setup_agent") return [];
  const own = operation.kind === "task" && operation.workflowMode === SETUP_AGENT_WORKFLOW_MODE;
  const prepareFailed = operation.kind === "prepare" && outcome.status !== "SUCCEEDED";
  if (!own && !prepareFailed) return [];
  const result = resultOf(task, operation, outcome);
  const state = result.status === "ready" ? "COMPLETE" : outcome.status === "CANCELLED" ? "CANCELLED" : "FAILED";
  return [{ Update: {
    TableName: tableName,
    Key: taskKey(task.taskId),
    UpdateExpression: "SET agentRunEnd = if_not_exists(agentRunEnd, :end), setupAgentResult = if_not_exists(setupAgentResult, :result), updatedAt = :now",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":end": { state, at: now }, ":result": result, ":now": now },
  } }];
}

/**
 * P1: keeps the prepare's report of where each repository was checked out (`preparedBase`) on the setup task, BEFORE the task's first operation is built from it in the same terminal transaction (the
 * terminal result calls this for a prepare that succeeded whose task pointer still waits to start `SETUP_AGENT`). The first report stands; a report that does not read keeps nothing, and the worker then
 * refuses the run for want of commits.
 */
export async function keepSetupPreparedBase(deps: Pick<SetupAgentDependencies, "documentClient" | "tableName">, taskId: string, result: unknown, now: string): Promise<void> {
  const reported = typeof result === "object" && result !== null ? (result as { preparedBase?: unknown }).preparedBase : undefined;
  const base = WorkflowReviewBaseSchema.safeParse(reported);
  if (!base.success) return;
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: taskKey(taskId), UpdateExpression: "SET preparedBase = if_not_exists(preparedBase, :base), updatedAt = :now",
    ConditionExpression: "attribute_exists(pk) AND purpose = :purpose", ExpressionAttributeValues: { ":base": base.data, ":now": now, ":purpose": "setup_agent" },
  }));
}

/**
 * What a setup run's invocation carries (P1): the limits it started with, read again through the contract, and the commits the broker recorded when the preparation reported. Without a record there are no
 * commits and the worker refuses the run.
 */
export function setupAgentWireOf(task: Pick<DeveloperTaskRecord, "setupAgentLimits" | "preparedBase"> | undefined): SetupAgentWire {
  const commits = task?.preparedBase?.map((entry) => ({ repository: entry.repositoryId, commit: entry.baseCommitSha }));
  return { limits: effectiveSetupAgentLimits(task?.setupAgentLimits), ...(commits === undefined || commits.length === 0 ? {} : { commits }) };
}

// ---- routes (not wired: SH14)

/** What the task start of a setup run is given. The shared start turns it into the task, its pointer item (`setupAgentPointerItem`) and its starting limit (`runLimitUsd`, not the planning limit). */
export interface SetupAgentRunRequest {
  requestId: string;
  orgId: OrgId;
  project: string;
  text: string;
  /** Who pays: worked out here from the payer rules and checked again by the start. Project or member only. */
  payer: Payer;
  /** The run's money limit in dollars: the limits' budget. */
  runLimitUsd: number;
  limits: SetupAgentLimits;
  /** The run the project's pointer named when the route read it (none: no pointer yet); the pointer item holds only while it still does. */
  seenTaskId: string | undefined;
}

/** The shared task start and cancel, as a setup run uses them. SH14 builds this from `startAgentRun` and the task cancel. */
export interface SetupAgentStarter {
  /** Starts the run as `caller`. A repeat of `request.requestId` answers the first run's result and starts nothing. */
  start(caller: DeveloperCaller, request: SetupAgentRunRequest): Promise<AgentRunResult>;
  /**
   * Cancels the run's task. `stoppedBy` is the maintainer who pressed Stop: the cancel is recorded as THEIR action (the audit names the actual stopper), and it works when the run's owner has been
   * removed (the maintainer's own authority, which the route has just checked, is what stops it). `ownerDeveloperId` is the run's owner, for the record only. A task that is already over is left as it is.
   */
  cancel(request: { orgId: OrgId; ownerDeveloperId: string; taskId: string; requestId: string; stoppedBy: DeveloperCaller }): Promise<void>;
}

/**
 * The view with its proposal re-read: every citation of the run's proposal is read again from the code host at the commit the run read (the agent worked in a tree it could write, so what it cites is checked against the
 * repository, not against its workspace). The verdicts are kept on the task once final. A view with no proposal is returned as it is; with no reader, every item is `unchecked`.
 */
export async function verifiedView(deps: SetupAgentDependencies, caller: DeveloperCaller, definition: StoredProjectDefinition, view: SetupAgentView): Promise<SetupAgentView> {
  if (view.proposal === undefined || view.taskId === undefined) return view;
  const task = (await getItem(deps.documentClient, deps.tableName, taskKey(view.taskId))) as (DeveloperTaskRecord & { setupAgentVerification?: { items: Record<string, SetupVerification> } }) | undefined;
  if (task?.setupAgentVerification !== undefined) return { ...view, verification: task.setupAgentVerification.items, verified: true };
  const urlOf = new Map(definition.repositories.map((repository) => [repository.name, repository.url]));
  const reader: CitationFileReader | undefined = deps.readFile === undefined ? undefined : async (repository, path, commit, options) => {
    const url = urlOf.get(repository);
    if (url === undefined) throw new Error("unknown repository");
    return deps.readFile!(caller.orgId, url, path, commit, options);
  };
  const { items, final } = await verifyProposalDetailed(reader, view.proposal, { now: deps.now });
  if (final) {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: taskKey(view.taskId), UpdateExpression: "SET setupAgentVerification = :v", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(setupAgentVerification)",
      ExpressionAttributeValues: { ":v": { at: new Date(deps.now()).toISOString(), items } },
    })).catch((error: unknown) => { if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error; });
  }
  return { ...view, verification: items, verified: final };
}

export interface SetupAgentDependencies {
  documentClient: Client;
  tableName: string;
  now: () => number;
  /** The `su` switch. Off: every route is "not found" and nothing is read or written. */
  enabled: boolean;
  /** Undefined where tasks are not set up. */
  starter: SetupAgentStarter | undefined;
  /** The caller's role in the project: the project's name, or the one 404 `PROJECT_NOT_FOUND` for no access, no such project and another org's. */
  projectFor(caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
  /** An archived project takes no new work (`requireNewWorkAllowed`). */
  requireNewWork(caller: DeveloperCaller, project: string, role: ProjectRole): Promise<void>;
  latest(orgId: OrgId, project: string): Promise<{ revision: number; definition: StoredProjectDefinition } | undefined>;
  /** The project's own setup-run limits and the company's lock, as stored (any shape: `effectiveSetupAgentLimits` reads them and never throws). */
  limitSettings(orgId: OrgId, project: string): Promise<{ project?: unknown; companyLock?: unknown }>;
  /** SH14: throws unless the caller has a fresh browser sign-in (within 10 minutes), as the test-environment approvals ask. Absent: a person's command is refused. */
  requireFreshSignIn?(caller: DeveloperCaller): Promise<void>;
  /** Who pays for a task this person starts in this project: `resolveRunPayer`'s answer for an app start. */
  payerFor(caller: DeveloperCaller, project: string): Promise<Payer>;
  /** SH14: the citation reader (GitHub's file read at a commit). Absent: a proposal is shown with every item `unchecked`. */
  readFile?: ((orgId: OrgId, repositoryUrl: string, path: string, commit: string, options: { untilLine?: number; timeoutMs: number }) => Promise<string | undefined>) | undefined;
  /** SH14: the install has a model proxy, which meters and prices a setup run. Without it a run is refused. */
  modelAccessConfigured?: boolean | undefined;
}

const bodyError = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) => {
  const issue = error.issues[0];
  // Field names only: the values are the person's.
  return agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};

/** A request id for a request this one makes in turn (the stop), the same every time this one is repeated. */
function derivedRequestId(requestId: string, purpose: string): string {
  const hex = createHash("sha256").update(`rovara-setup-agent\0${purpose}\0${requestId}`, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function maintainerOf(deps: SetupAgentDependencies, caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }> {
  if (!deps.enabled) throw agentXError("NOT_FOUND", "route not found");
  const found = await deps.projectFor(caller, rawName);
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", WHO_MAY);
  return found;
}

const isTransactionCancelled = (error: unknown): boolean => error instanceof Error && error.name === "TransactionCanceledException";

/**
 * `POST /v1/app/projects/{name}/setup-agent`: asks Rovara to set the project up by running its commands. Only a maintainer (`edit_settings`), only with the `su` switch on. A repeat of the request id
 * answers the first request (200) and starts nothing; one run goes at a time (`409 WORKSPACE_BUSY`); the run is paid for like any task and limited by the run's own limits.
 */
export async function startSetupAgent(deps: SetupAgentDependencies, caller: DeveloperCaller, rawName: string, rawBody: unknown): Promise<StatusReply> {
  const { name, role } = await maintainerOf(deps, caller, rawName);
  const parsed = SetupAgentStartBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError(parsed.error);
  const { requestId } = parsed.data;
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "setting up a project with Rovara is not set up in this deployment");
  // A setup run spends model money by the minute: it needs the model proxy that meters it (and the price table the worker stops it by).
  if (deps.modelAccessConfigured !== true) throw agentXError("NOT_FOUND", "setting up a project with Rovara needs this installation's model proxy");
  const latest = await deps.latest(caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const starter = deps.starter;
  const settings = await deps.limitSettings(caller.orgId, name);
  const limits = effectiveSetupAgentLimits(settings.project, settings.companyLock);
  const payer = await deps.payerFor(caller, name);
  // Whose money: the project's, or the member who asked. Never an agent's, a chain's, or another member's.
  if (!((payer.kind === "project" && payer.project === name) || (payer.kind === "member" && payer.developerId === caller.developerId))) {
    throw agentXError("CONFIG_INVALID", "payer: a setup run is paid for by the project or by the person who starts it");
  }
  const run = (seenTaskId: string | undefined) => starter.start(caller, {
    requestId, orgId: caller.orgId, project: name, text: setupAgentRequestText(name), payer, runLimitUsd: limits.budgetCents / 100, limits, seenTaskId,
  });
  // A repeat of a request already made is answered from the run's own record (and a different person's use of the id is refused there).
  const previous = await getItem(deps.documentClient, deps.tableName, runRequestKey(caller.orgId, requestId));
  if (previous !== undefined) {
    await run(undefined);
    return new StatusReply(200, await verifiedView(deps, caller, latest.definition, await setupAgentState(deps, caller.orgId, name, latest.revision)));
  }
  await deps.requireNewWork(caller, name, role);
  const before = await readState(deps, caller.orgId, name, latest.revision);
  if (before.view.status === "running") throw agentXError("WORKSPACE_BUSY", SETUP_AGENT_BUSY);
  try {
    await run(before.pointer?.taskId);
  } catch (error) {
    // The pointer moved between the read and the write: another run started first.
    if ((error instanceof AgentXError && error.code === "WORKSPACE_BUSY") || isTransactionCancelled(error)) {
      if ((await setupAgentState(deps, caller.orgId, name, latest.revision)).status === "running") throw agentXError("WORKSPACE_BUSY", SETUP_AGENT_BUSY);
    }
    throw error;
  }
  return new StatusReply(202, await verifiedView(deps, caller, latest.definition, await setupAgentState(deps, caller.orgId, name, latest.revision)));
}

/** `GET /v1/app/projects/{name}/setup-agent`: where the project's run stands. A maintainer only (the proposal is a maintainer's to read, as the draft's). */
export async function getSetupAgent(deps: SetupAgentDependencies, caller: DeveloperCaller, rawName: string): Promise<StatusReply> {
  const { name } = await maintainerOf(deps, caller, rawName);
  const latest = await deps.latest(caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  return new StatusReply(200, await verifiedView(deps, caller, latest.definition, await setupAgentState(deps, caller.orgId, name, latest.revision)));
}

/**
 * `POST /v1/app/projects/{name}/setup-agent/stop`: stops the project's running setup run. A maintainer; the task is cancelled AS ITS OWNER (the person who started it), so another maintainer can stop it.
 * What the run learned so far is kept (the end items). Nothing is cancelled when no run is going: the state is answered as it is. A repeat of the request id cancels the same way.
 */
export async function stopSetupAgent(deps: SetupAgentDependencies, caller: DeveloperCaller, rawName: string, rawBody: unknown): Promise<StatusReply> {
  const { name } = await maintainerOf(deps, caller, rawName);
  const parsed = SetupAgentStopBodySchema.safeParse(rawBody);
  if (!parsed.success) throw bodyError(parsed.error);
  const latest = await deps.latest(caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const state = await readState(deps, caller.orgId, name, latest.revision);
  // A run that reads as stale ("failed", never reported an end) may still have a live task: Stop reaches it too, so a maintainer is never left with a run they cannot end.
  const staleButLive = state.view.status === "failed" && state.view.failure === SETUP_AGENT_FAILURES.stale && state.view.summary === undefined;
  if ((state.view.status !== "running" && !staleButLive) || state.pointer === undefined) return new StatusReply(200, await verifiedView(deps, caller, latest.definition, state.view));
  if (deps.starter === undefined) throw agentXError("NOT_FOUND", "setting up a project with Rovara is not set up in this deployment");
  // Who pressed Stop is written BEFORE the cancel (the first stop stands), so the end can tell a person's stop from a cancel the system made; a write that fails cancels nothing.
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: taskKey(state.pointer.taskId), UpdateExpression: "SET setupAgentStop = if_not_exists(setupAgentStop, :stop)",
    ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":stop": { by: caller.developerId, at: new Date(deps.now()).toISOString() } },
  }));
  await deps.starter.cancel({
    orgId: caller.orgId, ownerDeveloperId: state.pointer.requestedBy, taskId: state.pointer.taskId, requestId: derivedRequestId(`${state.pointer.taskId}|${parsed.data.requestId}`, "stop"), stoppedBy: caller,
  });
  return new StatusReply(202, await verifiedView(deps, caller, latest.definition, await setupAgentState(deps, caller.orgId, name, latest.revision)));
}
