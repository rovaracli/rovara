import { personNameForText } from "../../developer/requester-text.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PLAN_WHY_REQUEST_MAX_CHARS, type ProjectCommand, type TestEnvironmentBody, agentXError, SYSTEM_OWNER_PROVIDER, isSystemOwnerId, developerTaskPolicy, redactText, taskTitle, type StartDeveloperTaskRequest, type WorkflowReviewBase, type WorkflowCheckPolicy, FEEDBACK_STOPPED_REASON, isRunLimitBlockReason } from "@rovara-code/contracts";
import { type ProjectDefinition } from "@agentx/cloud-contracts";
import { type WorkflowSnapshot, stopWorkflowFeedbackRound, blockWorkflow, isBaseMergedRetry, WORKFLOW_BLOCK_REASONS } from "@agentx/cloud-contracts";
import type { z } from "zod";
import type { EstimateDependencies } from "../../spend/estimate.js";
import { TASK_OWNER_LABEL, taskKey, taskOwnerLabel, type DeveloperTaskRecord, type TurnParty } from "../../developer/task-records.js";
import { isConditional } from "../broker-shared.js";
import type { DeveloperCaller } from "../developer-routes.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import type { TaskDocumentKind } from "../task-web.js";
import { requireCreatorStillMember } from "../../developer/creator-member.js";
import { inertPlanLine } from "../../rovara-code/inert-text.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

/** Ruling R60: refuses a task whose creator is no longer a member of its org, before any other access check (see developer/creator-member.ts). */
export const creatorGuard = (deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord) =>
  requireCreatorStillMember({ documentClient: deps.documentClient, tableName: deps.tableName, orgId: deps.orgId, now: () => deps.now() }, task);

export const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const iso = (deps: Pick<DeveloperTaskRouteDependencies, "now">) => new Date(deps.now()).toISOString();
export const log = (deps: Pick<DeveloperTaskRouteDependencies, "log">, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

export function parse<T>(schema: z.ZodType<T>, body: unknown, deps: Pick<DeveloperTaskRouteDependencies, "log">, route: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".") || "body";
  // Field names only: the values are the developer's text (R12).
  log(deps, { event: "developer.task_request_invalid", route, field });
  throw agentXError("CONFIG_INVALID", `${field}: ${issue?.message ?? "invalid"}`);
}

/**
 * The checks a task is held to. Without an approved test environment they are the project's own readiness commands. With one (test environment, wire-testenv) they are the environment's checks, in its order, each with
 * its kind, FOLLOWED BY any readiness command the environment does not already run, so approving an environment never silently drops a check the project had. The worker's selection plan relies on that order: the
 * first checks are the environment's.
 */
export function taskWorkflowCheckPolicy(project: ProjectDefinition, environment?: TestEnvironmentBody): WorkflowCheckPolicy {
  const label = (command: { executable: string; args: string[] }) => `${command.executable} ${command.args.join(" ")}`.trim().slice(0, 80);
  const same = (left: ProjectCommand, right: ProjectCommand) => left.cwd === right.cwd && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args);
  const owned = environment?.repos.flatMap((repo) => repo.checks) ?? [];
  const commands = [...owned.map((check) => ({ command: check.command, text: check.label, kind: check.kind })), ...project.readiness.filter((command) => !owned.some((check) => same(check.command, command))).map((command) => ({ command, text: label(command), kind: undefined }))];
  const required = commands.map((entry, index) => ({ id: `required-${index + 1}`, label: entry.text.slice(0, 80), command: entry.command, ...(entry.kind === undefined ? {} : { kind: entry.kind }) }));
  const optional = developerTaskPolicy(project).optionalWorkflowChecks ?? [];
  if (required.length + optional.length > 64) throw agentXError("CONFIG_INVALID", "project workflow checks exceed the supported limit of 64");
  const ids = new Set(required.map((check) => check.id));
  if (optional.some((check) => ids.has(check.id))) throw agentXError("CONFIG_INVALID", "optional workflow check IDs cannot reuse required check IDs");
  return { required, optional, selectedOptionalIds: [], proposed: [] };
}

export function body(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw agentXError("CONFIG_INVALID", "the request body is not JSON");
  }
}

export async function get<T>(deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

export const putNew = (tableName: string, item: Record<string, unknown>) => ({ Put: { TableName: tableName, Item: item, ConditionExpression: "attribute_not_exists(pk)" } });

export function turnTable(deps: Pick<DeveloperTaskRouteDependencies, "actions">): string {
  const table = deps.actions.turnRecordsTableName;
  // FR-037: an action that cannot be audited does not run.
  if (table === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "turn records are not configured in this deployment; developer tasks are off");
  return table;
}

/** One EMF line for the RecordingFailures alarm, which already sums TurnRecordWriteFailed. */
export function turnRecordFailed(deps: DeveloperTaskRouteDependencies, error: unknown) {
  console.log(JSON.stringify({
    _aws: { Timestamp: deps.now(), CloudWatchMetrics: [{ Namespace: process.env.AGENTX_METRICS_NAMESPACE || "AgentX", Dimensions: [[]], Metrics: [{ Name: "TurnRecordWriteFailed", Unit: "Count" }] }] },
    component: "broker", event: "developer.turn_record_failed", error: error instanceof Error ? error.name : "unknown", TurnRecordWriteFailed: 1,
  }));
}

export function partyOf(caller: DeveloperCaller, taskId: string, client: string): TurnParty {
  return {
    taskId, developerId: caller.developerId, provider: isSystemOwnerId(caller.developerId) ? SYSTEM_OWNER_PROVIDER : caller.amr, developerName: caller.name, client,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
  };
}

/** A human action is attributed to its authenticated caller while retaining the task's runtime fields. */
export function partyOfTaskActor(task: DeveloperTaskRecord, caller: DeveloperCaller): TurnParty {
  return {
    ...partyOf(caller, task.taskId, task.client),
    workspaceId: task.workspaceId,
    settingsRevision: task.startingRevision,
  };
}

/**
 * FR-030's title, redacted before taskTitle cuts it: the title is stored in the task and index
 * rows, shown in views and listed in WORKSPACE_LIMIT messages, so a secret on the instructions'
 * first line must not reach any of them. Redacting first means the cut cannot leave half a token
 * the redactor would miss; taskTitle's cut counts code points, so it never splits an emoji.
 */
export function redactedTitle(request: StartDeveloperTaskRequest): string {
  return taskTitle(redactText(request.instructions), request.title === undefined ? undefined : redactText(request.title));
}

/** The most characters of the owner's request a task keeps, and the most one thread reply may add to a plan's "why". */
const REQUEST_TEXT_MAX_CHARS = PLAN_WHY_REQUEST_MAX_CHARS;
export const WHY_NOTE_MAX_CHARS = 500;
/** A plan's "why" holds the request and at most this many thread replies. */
export const WHY_NOTES_MAX = 9;
/** The author shown on a "why" entry that the planner wrote, for a task that did not keep its request. */
export const PLANNER_WHY_AUTHOR = "AgentX's summary";

/**
 * Redacted first, so the cut cannot leave half a token. Cut to at most `max` UTF-16 code units (what the stored plan's
 * schema counts), never between the two halves of a surrogate pair, so the stored plan always reads back.
 */
export function cutText(value: string, max: number): string {
  const text = redactText(value).trim();
  if (text.length <= max) return text;
  let end = max - 3;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}...`;
}

/** What a "who said it" reads when the owner's name is the Slack-ID fallback of a Slack-started task (or empty): no name anyone knows. */
export const OWNER_LABEL = TASK_OWNER_LABEL;
export function ownerLabel(developerName: string, githubLogin?: string): string {
  // C60: a person is named to others by their display name without any email address (a sign-in provider with no name for someone uses their address), else their linked GitHub login, else "the task owner".
  return taskOwnerLabel(cutText(personNameForText(developerName, githubLogin) ?? "", 80));
}

/** The owner's request as a task keeps it: redacted and cut to 4,000 characters. */
export function storedRequestText(instructions: string): string {
  return cutText(instructions, REQUEST_TEXT_MAX_CHARS);
}

export const FEEDBACK_REPORT_MAX_BYTES = 1_000_000;

/** Whether the task's running round is one Rovara decided itself (the newest decision is Rovara's, and a fix is marked). */
function isAutomaticFeedbackRound(workflow: WorkflowSnapshot): boolean {
  return workflow.fixSource === "feedback" && workflow.feedbackDecisions?.at(-1)?.actorRole === "ROVARA_AUTONOMY";
}

/**
 * Whether the task is at the reviews of a merged base's automatic re-run (decision 70(c)): the newest decision is Rovara's re-run after a merge of the base, for the candidate now at REVIEW, which an open pull
 * request holds. The reviews that follow are paid work of a round Rovara decided itself.
 */
function isBaseMergedRecheckRound(workflow: WorkflowSnapshot): boolean {
  const candidate = workflow.candidate;
  const last = workflow.decisions.at(-1);
  return workflow.stage === "REVIEW" && workflow.state === "WAITING" && workflow.fixSource === undefined && candidate !== undefined && last !== undefined && isBaseMergedRetry(last)
    && last.auto?.candidateDigest === candidate.digest
    && (workflow.pullRequests ?? []).some((pullRequest) => (pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN") && pullRequest.candidateDigest === candidate.digest);
}

/**
 * Before each paid step of a round Rovara decided itself (a send-back run, a review, the push; the reviews after an automatic re-run of a merged base's checks too): how far Rovara may go on its own is read again (the stricter of the frozen recipe and the company's
 * limit now). If it has been lowered to `suggest`, the round stops here, cleanly: the workflow is blocked at the step it was at, with a message that says why, and nothing more is run, paid for or
 * pushed. The owner's Retry is their own go-ahead. Answers whether it stopped; a task that is not in such a round, or a dependency that is not wired, is never stopped.
 */
export async function stoppedByLoweredAutonomy(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, workflow: WorkflowSnapshot): Promise<boolean> {
  const recheck = isBaseMergedRecheckRound(workflow);
  if ((!isAutomaticFeedbackRound(workflow) && !recheck) || deps.taskAutonomyNow === undefined) return false;
  const now = await deps.taskAutonomyNow(task);
  if (now === "prepare" || now === "run") return false;
  const at = iso(deps);
  try {
    await deps.actions.transact([{ Update: {
      TableName: deps.tableName, Key: taskKey(task.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
      // A merged base's re-run stops before its paid reviews, blocked at the review step; a feedback round stops as it always did.
      ExpressionAttributeValues: { ":workflow": recheck ? blockWorkflow(workflow, WORKFLOW_BLOCK_REASONS.recheckAutonomyLowered, at) : stopWorkflowFeedbackRound(workflow, FEEDBACK_STOPPED_REASON, at), ":now": at, ":revision": workflow.revision },
    } }]);
  } catch (error) {
    // Someone else moved the task: it is theirs now, and this step does not run on the revision read.
    if (!isConditional(error)) throw error;
  }
  return true;
}

/** What a start needs left to be admitted: an agent-step run, a coding workflow (quick or full), a coding run an agent was chosen for, or a plain task. */
/** What the spend settings and history are read through at a start. */
export const estimateDependencies = (deps: DeveloperTaskRouteDependencies): EstimateDependencies => ({
  documentClient: deps.documentClient, tableName: deps.tableName, ...(deps.cloud === true ? { cloud: true } : {}), now: () => deps.now(),
});

export const CLOSED_TASK = "this task is closed; start a new one with agentx_start_task";
// #213: a failed setup gives its slot back at once; the close only tidies the task away.
export const NEVER_STARTED = "this task never started and its workspace was released, so it no longer counts toward your workspace limit; start a new task with agentx_start_task, and close this one with agentx_close_task";
export const CLOSING_TASK = "this task is closing; check it with agentx_get_task, and if the close is refused for unpublished work you can continue it";

/** Said to anyone who tries to restart coding on a plan whose run limit nobody has accepted. */
export const RUN_LIMIT_NOT_APPROVED_REFUSAL = "Coding starts once the run limit is approved.";

/** A plan blocked on its run limit (Task 34) is unblocked by the run-limit approval only (`resumeAfterRunLimitApproval`), never by a retry or a send-back. */
export const blockedOnRunLimit = (workflow: WorkflowSnapshot): boolean =>
  workflow.stage === "IMPLEMENT" && workflow.state === "BLOCKED" && isRunLimitBlockReason(workflow.blockReason);

/** The task's page, which the draft pull request's description links to. */
export function taskPageUrl(issuer: string, taskId: string): string {
  return new URL(`/review/${encodeURIComponent(taskId)}/task`, new URL(issuer).origin).href;
}

/** Ruling R60: why the task ended, when its creator was removed from the org (an open task only). */
export const removedReasonOf = (task: DeveloperTaskRecord) => (task.outcome === "creator_removed" && task.closedAt === undefined ? task.outcomeReason : undefined);

export const TASK_PAGE_DOCUMENTS: ReadonlyArray<{ type: "requirements" | "design" | "plan"; kind: TaskDocumentKind; label: string; anchor: string }> = [
  { type: "requirements", kind: "requirements", label: "Requirements", anchor: "requirements" },
  { type: "design", kind: "design", label: "Design", anchor: "design" },
  { type: "plan", kind: "coding plan", label: "Coding plan", anchor: "coding-plan" },
];

/**
 * The task's title as the pull request shows it: Slack's markup (a mention, a channel, a link with its label, a
 * broadcast) reduced to plain words first, then made inert for GitHub as a plan line is. A Slack-started task's title is
 * the requester's words, so nothing in it may mention anyone or link anywhere on GitHub.
 */
export function inertTaskTitle(title: string): string {
  const plain = title
    .replace(/<(?:https?|mailto):[^|>]*\|([^>]*)>/giu, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/gu, "#$1")
    .replace(/<[@#!][^>]*>/gu, "")
    .replace(/\s+/gu, " ");
  return inertPlanLine(plain);
}

/**
 * The base commit the worker reads the task's code against: the workflow's pinned base, or before the first pin
 * the commit preparation checked out (recorded from the prepare result, never from a candidate the worker reports).
 */
export function taskBaseOption(task: DeveloperTaskRecord, workflow: WorkflowSnapshot): { workflowBase?: WorkflowReviewBase } {
  const base = workflow.reviewBase ?? task.preparedBase;
  return base === undefined ? {} : { workflowBase: base };
}

/** The caller's own developer token from an `Authorization: Bearer <token>` header (the core's decide presents it as the caller's credential); undefined without one. Never logged, never stored. */
export const bearerOf = (header: string | undefined): string | undefined => /^Bearer (.+)$/iu.exec(header ?? "")?.[1];
