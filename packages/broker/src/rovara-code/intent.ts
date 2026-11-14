// Rovara Code (Plan 6 Task 3): the one entry point for an intent. Every surface that starts Rovara Code work (the app route, Slack today; Linear, an accepted offer, the CLI and MCP
// through Plan 9 and Task 25) calls `startCodeIntent`, which starts the work through the same run start every task uses (`startAgentRun`, then `startTask`). Nothing here decides
// access or money: the project role and `requireNewWorkAllowed` are `startTask`'s, the payer is `resolvePayer`'s (a person named as the payer must still be allowed to start work
// on the project), and the budget floor and the planning limit are `admitWork`'s and `startingLimitUsd`'s. This file only says what kind of start it is.
import { AgentXError, CodeIntentRequestSchema, PROCESS_START_REFUSED_MESSAGE, SessionIdSchema, agentXError, sessionLink, type CodeIntentRequest, type CodeIntentResult, type OrgId } from "@rovara-code/contracts";
import { type DeveloperTaskView } from "@agentx/cloud-contracts";
import { startAgentRun, type AgentRunRequest, type AgentRunStarter } from "../agents/runs.js";
import { SLACK_WORKFLOW_SESSION_ID } from "../developer/task-records.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { PayerFacts } from "../spend/payer.js";
import type { ProjectProcess } from "../playbook/project-process.js";
import { CHANGE_ANYWAY_UNAVAILABLE, FOLLOW_UP_UNAVAILABLE_MESSAGE } from "./change-anyway.js";

/**
 * S3 item a (decision 130): where a person's own Rovara Code start may begin on Rovara Code's core instead. Built by the broker only where the Cloud root is on
 * (`CLOUD_CORE_ENGINE`); absent, `startCodeIntent` is exactly what it was. It answers `undefined` for a start that stays on Cloud's path (the switch says Cloud for this company,
 * the source or the request is one the core does not take, or the root could not be built), and it throws an `AgentXError` for a refusal, which the caller answers as any refusal.
 */
export interface CoreIntentHook {
  /** `ownedTask`: the person's own task as the view Cloud's clients read (the core writes the same task rows, so Cloud's reader answers for a core task). */
  start(input: { caller: DeveloperCaller; request: CodeIntentRequest; ownedTask: (caller: DeveloperCaller, taskId: string) => Promise<DeveloperTaskView> }): Promise<CodeIntentResult<DeveloperTaskView> | undefined>;
}

/** What `startCodeIntent` needs from the developer API, built for one caller (see `codeIntentDependenciesOf`). */
export interface CodeIntentDependencies {
  /** Plan 3's run start for a person; undefined where agents are not set up. Only a plain task start is possible then (see `startCodeIntent`). */
  starter: AgentRunStarter | undefined;
  /** The plain task start, for a deployment without agents. */
  startPlainTask(caller: DeveloperCaller, body: unknown, thread?: { teamId: string; channelId: string; threadTs: string }): Promise<{ task: DeveloperTaskView }>;
  /** The person's own task, as the view a client reads; another person's or another org's is `TASK_NOT_FOUND`. */
  ownedTask(caller: DeveloperCaller, taskId: string): Promise<DeveloperTaskView>;
  /** "How we work": the process the project runs (the built-in Rovara Code unless its playbook points at a process layer). `PROCESS_UNAVAILABLE` when the pointer no longer holds. */
  projectProcess(orgId: OrgId, project: string): Promise<ProjectProcess>;
  /** The origin session links are made from (the cell's own). */
  origin: string;
  /** S3 item a: the core start (see `CoreIntentHook`). */
  coreStart?: CoreIntentHook | undefined;
  /** Whether `taskId` is a task a follow-up may follow for this caller: in their org, its session visible to them, and ended Answered. Without it no follow-up starts (fail closed). */
  retryable?(caller: DeveloperCaller, taskId: string): Promise<boolean>;
}

/** The sources that are a person's own start, so a deployment without agents (no payer rules, no sessions) may still start them. */
const PLAIN_SOURCES: ReadonlySet<CodeIntentRequest["source"]> = new Set(["app", "cli", "mcp", "slack"]);

/** The facts a source hands the payer rules, from the request and the caller (never from a request body: the app route's body cannot carry them). */
function payerFactsOf(request: CodeIntentRequest, caller: DeveloperCaller): PayerFacts | undefined {
  if (request.source === "linear" && request.assignedBy !== undefined) {
    return { assignedBy: { bot: request.assignedBy.bot, ...(request.assignedBy.developerId === undefined ? {} : { developerId: request.assignedBy.developerId }) } };
  }
  // The person who accepted an offer is the one asking, and pays.
  if (request.source === "offer") return { acceptedBy: { developerId: caller.developerId } };
  return undefined;
}

function parsed(value: unknown): CodeIntentRequest {
  const result = CodeIntentRequestSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  // Field names only: the values are the person's text.
  throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "request"}: ${issue?.message ?? "is not valid"}`);
}

/**
 * Starts Rovara Code work for `caller` in `caller.orgId`. Idempotent on `requestId`: a repeat returns the first task and its session and writes nothing, and the same id with
 * another request is `IDEMPOTENCY_CONFLICT`. On a version 2 org the task starts at UNDERSTAND/READY; on version 1 it starts as it always did, and a request with no path is refused.
 *
 * `retryOf` (the "change anyway" start after an answered task) is trusted input from broker code and is kept on the new task as a link; nothing about the old task is read here (the
 * caller checked it). `startAt` (a hand-off from the Mac) is accepted by shape and refused here until the task that acts on it exists. A Slack intent is
 * accepted only from the Slack workflow's own caller. A Linear or offered intent needs the payer rules, so it needs agents to be set up.
 */
export async function startCodeIntent(deps: CodeIntentDependencies, caller: DeveloperCaller, value: unknown): Promise<CodeIntentResult<DeveloperTaskView>> {
  const request = parsed(value);
  if (request.startAt !== undefined) throw agentXError("RUNTIME_UNAVAILABLE", "starting from a hand-off isn't available yet");
  if (request.retryOf !== undefined) {
    // A follow-up needs sessions and the payer rules, so a deployment without agents says so plainly.
    if (deps.starter === undefined) throw agentXError("RUNTIME_UNAVAILABLE", CHANGE_ANYWAY_UNAVAILABLE);
    // Checked, not trusted: the task must be in the caller's org, visible to them and ended Answered. Anything else, or a check that cannot be made, refuses with one message.
    const followable = await (deps.retryable?.(caller, request.retryOf) ?? Promise.resolve(false)).catch(() => false);
    if (!followable) throw agentXError("CONFIG_INVALID", FOLLOW_UP_UNAVAILABLE_MESSAGE);
  }
  if (request.source === "slack" && (caller.sessionId !== SLACK_WORKFLOW_SESSION_ID || caller.slackUserId === undefined)) {
    throw agentXError("FORBIDDEN", "only a Slack member's own request can start work as Slack");
  }
  const orgId: OrgId = caller.orgId;
  // S3 item a: the combined switch (decision 130). Only here, after the request and the caller are checked and before the agent, the payer rules and any write; the core does its own access,
  // admission and records. `undefined`: this start stays on Cloud's path, below.
  if (deps.coreStart !== undefined) {
    const onCore = await deps.coreStart.start({ caller, request, ownedTask: (who, taskId) => deps.ownedTask(who, taskId) });
    if (onCore !== undefined) return onCore;
  }
  const intent = {
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(request.binding === undefined ? {} : { binding: request.binding }),
    ...(request.retryOf === undefined ? {} : { retryOf: request.retryOf }),
    ...(request.designFirst === true ? { designFirst: true as const } : {}),
  };
  if (deps.starter === undefined) return startWithoutAgents(deps, caller, request);
  // The project's way of working decides which agent runs. A pointer that no longer holds stops the start (`PROCESS_UNAVAILABLE`); it never runs the built-in instead.
  // Only the id is named: the run pins the agent's current published version as it starts, which the task records. (Naming the version too would move the request's
  // fingerprint with every publish and make a repeat of a start already made a conflict.)
  const process = await deps.projectProcess(orgId, request.project).catch((error: unknown) => {
    // The same code, in words for the person starting work (the playbook's own words are for the person changing it).
    if (error instanceof AgentXError && error.code === "PROCESS_UNAVAILABLE") throw agentXError("PROCESS_UNAVAILABLE", PROCESS_START_REFUSED_MESSAGE);
    throw error;
  });
  const payerFacts = payerFactsOf(request, caller);
  const run: AgentRunRequest = {
    requestId: request.requestId, orgId, project: request.project, agent: { agentId: process.agentId }, input: request.input, origin: request.source,
    owner: { developerId: caller.developerId }, startedBy: { developerId: caller.developerId }, caller,
    ...(payerFacts === undefined ? {} : { payerFacts }),
    codeIntent: intent,
  };
  const started = await startAgentRun(deps.starter, run);
  const task = await deps.ownedTask(caller, started.taskId);
  // A start by a person always has a session (`startTask` creates it in the same transaction), so this is a guard on the type, not a state.
  if (task.sessionId === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "the task started without a session");
  return { task, sessionId: task.sessionId, sessionUrl: task.sessionUrl ?? sessionLink(deps.origin, SessionIdSchema.parse(task.sessionId)) };
}

/** A deployment where agents are not set up: no payer rules and no sessions, so only a person's own plain start, as the Slack workflow made before agents existed. */
async function startWithoutAgents(deps: CodeIntentDependencies, caller: DeveloperCaller, request: CodeIntentRequest): Promise<CodeIntentResult<DeveloperTaskView>> {
  if (!PLAIN_SOURCES.has(request.source)) throw agentXError("RUNTIME_UNAVAILABLE", "starting work from here isn't set up in this deployment");
  if (request.input.context !== undefined && request.input.context.length > 0) throw agentXError("CONFIG_INVALID", "agents are not set up in this deployment");
  // The plain start has no way to record the ask with the task, so it is refused rather than dropped.
  if (request.designFirst === true) throw agentXError("RUNTIME_UNAVAILABLE", "starting work with a design review isn't set up in this deployment");
  const answer = await deps.startPlainTask(caller, {
    requestId: request.requestId, project: request.project, instructions: request.input.text, client: request.source, workflow: true,
    ...(request.path === undefined ? {} : { workflowPath: request.path }),
    ...(request.binding?.kind === "slack_thread" ? { shareToChannel: true, channel: request.binding.channelId } : {}),
  }, request.binding?.kind === "slack_thread" ? { teamId: request.binding.teamId, channelId: request.binding.channelId, threadTs: request.binding.threadTs } : undefined);
  return { task: answer.task };
}
