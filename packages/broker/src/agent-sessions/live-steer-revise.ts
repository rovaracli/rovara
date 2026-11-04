// Live steer: "Revise the plan with this change". Coding stopped because the owner's live message asked for a change outside the approved plan (blocked with `liveSteerReapprovalRevise`, and the stop
// recorded the owner's message ids with the blocked revision: `live-steer-reapproval.ts`). The owner's one press, from Slack, the task page or the route, does this and nothing else:
//   - reads those messages (they must be steer messages of this task's session, written by the task's owner, still marked "needs re-approval"),
//   - moves the workflow from coding back to PLANNING with the owner's request for changes recorded (`revisePlanWithLiveChange`), and starts the planning run with the owner's words as the change to make,
//     in ONE transaction that is conditional on the blocked revision (so a double press, or a press after anything moved, commits once or not at all),
//   - leaves everything after that to the existing machinery: the plan self-check and plan check, the plan waiting for the owner at PLAN_REVIEW, and the owner's approval (fresh sign-in, audited, the same
//     rules), which alone starts coding again from the revised plan.
// Only the owner may press; the request id makes a repeat the same press; every unusual input is refused with fixed words and writes nothing. The message's text goes into the planning prompt only (the
// same place the words of a Request changes go): never into a log, an event, an error, a decision or the workflow. The press changes no budget, tool or permission: it starts a planning run exactly as a
// person's Retry starts a coding run (`requireMayGoOn`, the new cap window). The task's own helpers are handed in (`RevisePlanHost`), so this module never reaches into the task module.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
  LIVE_STEER_REAPPROVAL_REASON,
  LIVE_STEER_TEXT_MAX_CHARS,
  WORKFLOW_BLOCK_REASONS,
  WORKFLOW_REVISE_PLAN_DECISION_REASON,
  WorkflowTransitionError,
  agentXError,
  redactText,
  revisePlanWithLiveChange,
  liveSteerCodingBlockReason,
  workflowOwnerAuthorized,
  workflowReviseOffered,
  type DeveloperTaskView,
  type WorkflowOwnerAuthority,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import type { OrgId, SessionId } from "@agentx/contracts";
import type { TransactItems } from "../aws/developer-task-actions.js";
import { loadWorkflowDocument, type LoadedDocument } from "../developer/plan-artifacts.js";
import { developerTaskIdentity, taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { reapprovalMessageIds } from "./live-steer-reapproval.js";
import { markSteerRevised, readSteerMessage } from "./steer.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";
import { requireProjectSendBackRole } from "../developer/task-access.js";

/** What a press carries: the same two values every owner button sends (the request's id, the revision the owner saw). Nothing else rides along. */
export const RevisePlanRequestSchema = z.object({ requestId: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict();

/** The words of a refusal (fixed; nothing from a message). */
export const REVISE_PLAN_REFUSALS = Object.freeze({
  invalid: "the request to revise the plan is not valid",
  notOffered: "this task did not stop for a change the plan can take in, so its plan cannot be revised with it",
  noChange: "the message that asked for the change can no longer be found, so the plan cannot be revised with it; retry coding or close the task",
  stale: "this action is out of date; refresh the task and try again",
  planUnreadable: "the approved coding plan failed its check, so it cannot be revised",
});

/** The longest change text one press hands the planner (the messages' own bound). */
const CHANGE_TEXT_MAX_CHARS = LIVE_STEER_TEXT_MAX_CHARS;

interface RevisePlanAccess { task: DeveloperTaskRecord; actorId: string; authority: WorkflowOwnerAuthority }

/** The task module's own helpers this press uses, handed in by the one wiring function (`reviseTaskWorkflowPlan`). */
export interface RevisePlanHost<A extends RevisePlanAccess = RevisePlanAccess> {
  /** The authority Send back asks for (`work`): throws for anyone who may not. */
  authorize(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<A>;
  /** A person's go-on never skips an approval (`requireMayGoOn`). */
  requireMayGoOn(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, task: DeveloperTaskRecord): Promise<void>;
  /** The new window of the task's cap a person's retry starts (`capWindowUpdate(capWindowBaseline(...))`). */
  capWindow(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<{ clause: string; values: Record<string, number> }>;
  /** The workspace can take a run now (throws WORKSPACE_* otherwise). */
  actionableWorkspace(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord): Promise<unknown>;
  /** The claim ids earlier versions of the plan dropped, so the planner does not reuse one. */
  retiredClaimIds(deps: DeveloperTaskRouteDependencies, workflow: WorkflowSnapshot): Promise<string[]>;
  /** The planning prompt of a request for changes to a structured plan, and the data block a legacy Markdown plan is given as. */
  structuredPrompt(loaded: Extract<LoadedDocument, { format: "structured" }>, reason: string, phase: WorkflowSnapshot["reviewPhase"], comments: string): string;
  markdownBlock(markdown: string): string;
  /**
   * Runs `accept` as every other person-started planning run does (`withCurrentThreadNotes`): the removed-owner guard (Ruling R60) first, then the thread replies no step has been given, which the
   * planner reads after the request, and the update that moves the task's mark past them (`fed`), retried when a reply is saved meanwhile.
   */
  withNotes<T>(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, requestId: string,
    accept: (current: DeveloperTaskRecord, notes: { suffix: string; fed: { clause: string; condition: string; values: Record<string, string | number> } }) => Promise<T>,
    /** Stop & redirect: message ids the prompt leaves out of the notes it carries. */
    skipMessageIds?: readonly string[]): Promise<T>;
  /** The turn record and the access fence that go in the one transaction. */
  acceptItems(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: A, input: { request: string; response: string; operationId: string; at: string }): TransactItems;
  /** Turns a refused acceptance into the words the task module says (busy workspace, closing). */
  refuse(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, error: unknown): Promise<never>;
  /** The task as the caller sees it now (and its index kept current). */
  view(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<{ task: DeveloperTaskView }>;
}

/** Where the stop keeps the owner's message ids for the press: one item per task, written in the transaction that blocks coding, so a card that offers Revise always has its record. */
export const liveSteerChangeKey = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "LIVE_STEER_CHANGE" });

/**
 * The block reason coding stops with when the owner's live message asked for a change outside the approved plan: the one that offers Revise the plan only when the plan can take the change in AND
 * the owner's message ids are known (they are what the press plans with); otherwise the round-2 words.
 */
export function liveSteerCodingStop(workflow: Parameters<typeof liveSteerCodingBlockReason>[0], error: string | undefined): string {
  return reapprovalMessageIds(error).length === 0 ? WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding : liveSteerCodingBlockReason(workflow);
}

/** The record item, to go in the same transaction as the block (`next` is the blocked workflow being stored); nothing for any other block. Ids only, never text. */
export function liveSteerChangeItems(tableName: string, taskId: string, next: Pick<WorkflowSnapshot, "stage" | "state" | "blockReason" | "revision">, error: string | undefined, at: string): TransactItems {
  const messageIds = reapprovalMessageIds(error);
  if (next.stage !== "IMPLEMENT" || next.state !== "BLOCKED" || next.blockReason !== WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise || messageIds.length === 0) return [];
  return [{ Put: { TableName: tableName, Item: { ...liveSteerChangeKey(taskId), entityType: "LIVE_STEER_CHANGE", taskId, workflowRevision: next.revision, messageIds, at } } }];
}

/** The owner's words as the planner reads them: redacted, on one line, cut. */
const oneLine = (text: string): string => redactText(text).replace(/\s+/gu, " ").trim().slice(0, CHANGE_TEXT_MAX_CHARS).trim();

/** The text of the requested change (one line per message), from the messages the stop recorded; `undefined` unless every one is the task owner's steer message that stopped coding. */
async function requestedChange(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, ids: readonly string[]): Promise<string | undefined> {
  const owner = tryEffectiveTaskOwner(task)?.developerId;
  if (owner === undefined || task.orgId === undefined || task.sessionId === undefined || ids.length === 0) return undefined;
  const parts: string[] = [];
  for (const id of ids) {
    const message = await readSteerMessage(deps, task.orgId, task.sessionId, id);
    if (message === undefined || message.author.developerId !== owner || message.deletedAt !== undefined || message.delivery?.state !== "delivered" || message.delivery.reason !== LIVE_STEER_REAPPROVAL_REASON) return undefined;
    const text = oneLine(message.text);
    if (text === "") return undefined;
    parts.push(text);
  }
  return parts.length === 1 ? parts[0] : parts.map((part) => `\n- ${part}`).join("");
}


const transitionRefusal = (error: unknown): never => {
  if (error instanceof WorkflowTransitionError) {
    // The task page says "owners only" for a person who is not the owner; every other refusal is its fixed sentence.
    if (/only the task owner/u.test(error.message)) throw Object.assign(agentXError("FORBIDDEN", error.message), { pageReason: "owners_only" });
    throw agentXError("CONFIG_INVALID", error.message);
  }
  throw error;
};

/**
 * The owner's press of "Revise the plan". Answers the task as it is after: planning running with the owner's change, or (a repeat of the same request) as it already was. Throws, writing nothing,
 * when the press is not the owner's, is out of date, or the task is not stopped for a change the plan can take in.
 */
export async function reviseTaskPlan<A extends RevisePlanAccess>(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, value: unknown, host: RevisePlanHost<A>): Promise<{ task: DeveloperTaskView }> {
  const parsed = RevisePlanRequestSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.invalid);
  const request = parsed.data;
  const access = await host.authorize(deps, caller, taskId);
  const { task } = access;
  const workflow = task.workflow;
  if (workflow === undefined) throw agentXError("NOT_FOUND", "this task does not have a workflow record");
  // The owner, first: anyone else hears "owners only" and nothing about the task's state.
  if (!workflowOwnerAuthorized(workflow.ownerId, access.actorId, access.authority)) {
    throw Object.assign(agentXError("FORBIDDEN", "only the task owner can revise the plan with this change"), { pageReason: "owners_only" });
  }
  const recordItem = async () => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: liveSteerChangeKey(taskId), ConsistentRead: true }))) as { Item?: { workflowRevision?: unknown; messageIds?: unknown; usedBy?: unknown } }).Item;
  const idsOf = (item: { messageIds?: unknown } | undefined): string[] => (Array.isArray(item?.messageIds) ? item.messageIds.filter((id): id is string => typeof id === "string") : []);
  // A repeat of a press that was taken is that press: it answers as it did and starts nothing. If the first answer lost the messages' own mark, the repeat makes it (it is idempotent).
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.reason !== WORKFLOW_REVISE_PLAN_DECISION_REASON || prior.decision !== "REQUEST_CHANGES" || prior.actorId !== access.actorId) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another decision on this task; use a new one");
    }
    const used = await recordItem();
    if (used?.usedBy === request.requestId) for (const id of idsOf(used)) await markSteerRevised(deps, task.orgId as OrgId, task.sessionId as SessionId, id);
    return host.view(deps, caller, taskId);
  }
  if (request.expectedRevision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", REVISE_PLAN_REFUSALS.stale);
  await host.requireMayGoOn(deps, caller, task);
  // An archived project takes no new work: revising the plan restarts planning (as a plan change request does in decide.ts).
  await requireNewWorkAllowed(deps, deps.orgId, task.project, "contributor", "task");
  // S2 (any path): revising the plan restarts planning for this person, so it meets the send-back's project access rule too.
  await requireProjectSendBackRole(deps, task, caller);
  if (!workflowReviseOffered(workflow)) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.notOffered);
  const recorded = await recordItem();
  const messageIds = idsOf(recorded);
  if (recorded === undefined || recorded.workflowRevision !== workflow.revision || recorded.usedBy !== undefined || messageIds.length === 0) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.noChange);
  const change = await requestedChange(deps, task, messageIds);
  if (change === undefined) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.noChange);
  const started = await startRevisedPlan(deps, caller, taskId, host, access, {
    requestId: request.requestId, change,
    source: `The owner sent this as a live message while coding ran; coding stopped because it asks for a change outside the approved plan. Write the change into the revised document. The owner approves the revised plan before any coding.`,
    turnRequest: "Revise the plan with the owner's live message",
    stoppedReason: WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise,
    // The record is spent by this press (and only by it): a second press, even a newer request, finds it used.
    spent: (revision) => [{ Update: {
      TableName: deps.tableName, Key: liveSteerChangeKey(taskId), UpdateExpression: "SET usedBy = :request",
      ConditionExpression: "workflowRevision = :revision AND attribute_not_exists(usedBy)", ExpressionAttributeValues: { ":request": request.requestId, ":revision": revision },
    } }],
  });
  if (started !== "started") return started;
  // The messages say what became of them (best effort and after the commit: the revised plan is already being written whatever happens here; a repeat of this request makes the mark again).
  for (const id of messageIds) await markSteerRevised(deps, task.orgId as OrgId, task.sessionId as SessionId, id);
  return host.view(deps, caller, taskId);
}

/** What starting the revised plan needs beyond the press: the owner's words as the change, why the step is stopped, and (a live message's press) the record that is spent in the same transaction. */
export interface RevisedPlanStart {
  requestId: string;
  /** The owner's words as the planner reads them (already redacted, on one line, cut). */
  change: string;
  /** Why the change is here, written after the document so the planner knows what its answer is for. */
  source: string;
  turnRequest: string;
  /** The block reason the coding step must still have when the transaction commits. */
  stoppedReason: string;
  /** Items to commit with the start, built from the workflow revision the press read (the live message's spent record). */
  spent?: (revision: number) => TransactItems;
  /**
   * Stop & redirect "this changes the plan": the transition is the redirect's (the step was stopped by the owner), the cap window is kept (a redirect never resets it), a pause that waits for an approval is
   * refused rather than skipped, and the messages in `skipNoteIds` are left out of the prompt's notes (the change already holds them).
   */
  redirect?: { skipNoteIds: readonly string[] };
  /** Who is authorised as owner for the transition. The press passes the task's own authority; a redirect, which checked the owner itself, passes the person. */
  authority?: WorkflowOwnerAuthority;
}

/**
 * The part of the press that starts the planning run: the workflow goes from coding to PLAN with the owner's request for changes recorded, and the planner is asked to write the revised document,
 * in ONE transaction that is conditional on the revision and the stopped coding step (so a double press, or a press after anything moved, commits once or not at all). Answers `started`, or the view
 * when another press of the same request got there first; refuses (writing nothing) otherwise.
 */
export async function startRevisedPlan<A extends RevisePlanAccess>(
  deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string, host: RevisePlanHost<A>, access: A, start: RevisedPlanStart,
): Promise<"started" | { task: DeveloperTaskView }> {
  const { task } = access;
  const workflow = task.workflow!;
  const receivedAt = new Date(deps.now()).toISOString();
  let returned: WorkflowSnapshot;
  try {
    returned = revisePlanWithLiveChange(workflow, { requestId: start.requestId, actorId: access.actorId, now: receivedAt, ...(start.redirect === undefined ? {} : { redirect: true as const }) }, start.authority ?? access.authority);
  } catch (error) {
    return transitionRefusal(error);
  }
  await host.actionableWorkspace(deps, task);
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1)!;
  const loaded = await loadWorkflowDocument((objectKey, maxBytes) => deps.actions.readArtifact(objectKey, maxBytes), artifact, {});
  if (loaded === undefined) throw agentXError("WORKSPACE_NOT_READY", REVISE_PLAN_REFUSALS.planUnreadable);
  // The owner's words, and why they are here, after the document (the planner is told what its answer is for; only the owner's approval of what it writes starts coding).
  const comments = `\n\n${start.source}`;
  const prompt = loaded.format === "structured"
    ? host.structuredPrompt(loaded, start.change, workflow.reviewPhase, comments)
    : `Revise the current coding plan. Requested changes: ${start.change}\n\nReturn the complete revised document. Do not edit files.\n\n${host.markdownBlock(loaded.markdown)}${comments}`;
  const retired = await host.retiredClaimIds(deps, workflow);
  // A redirect keeps the person's cap window and does not go on over a pause that waits for an approval; the press (a person's go-on) starts a new window as every retry does.
  if (start.redirect !== undefined && task.budgetPause !== undefined) throw agentXError("IDEMPOTENCY_CONFLICT", "this task is waiting for an approval of more spend; Rovara does not go on by itself");
  const cap = start.redirect === undefined ? await host.capWindow(deps, task) : { clause: "", values: {} };
  const next: WorkflowSnapshot = { ...returned, revision: returned.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  try {
    await host.withNotes(deps, task, start.requestId, (current, notes) => deps.actions.acceptTask(developerTaskIdentity(current, deps.orgId), current.workspaceId,
      { requestId: start.requestId, conversationId: current.conversationId, prompt: prompt + notes.suffix }, (operation) => [
        { Update: {
          TableName: deps.tableName, Key: taskKey(taskId),
          UpdateExpression: `SET workflow = :workflow, updatedAt = :now${notes.fed.clause}${cap.clause}`,
          ConditionExpression: `workflow.revision = :revision AND workflow.#stage = :implement AND workflow.#state = :blocked AND workflow.blockReason = :reason AND attribute_not_exists(closedAt)${notes.fed.condition}`,
          ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
          ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":implement": "IMPLEMENT", ":blocked": "BLOCKED", ":reason": start.stoppedReason, ...notes.fed.values, ...cap.values },
        } },
        ...(start.spent === undefined ? [] : start.spent(workflow.revision)),
        ...host.acceptItems(deps, caller, access, { request: start.turnRequest, response: `Planning the revised plan started as operation ${operation.id}`, operationId: operation.id, at: receivedAt }),
      ], { sharedTask: current.shared === true, workflowMode: "PLAN", ...(retired.length === 0 ? {} : { retiredClaimIds: retired }), ...(workflow.reviewPhase === undefined ? {} : { workflowPhase: workflow.reviewPhase }) }),
    start.redirect?.skipNoteIds);
  } catch (error) {
    // Another press, or anything else that moved the task, got there first: the same request is that press; any other is out of date.
    const fresh = await host.authorize(deps, caller, taskId);
    if (fresh.task.workflow?.decisions.some((decision) => decision.requestId === start.requestId) === true) return host.view(deps, caller, taskId);
    if (fresh.task.workflow !== undefined && fresh.task.workflow.revision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", REVISE_PLAN_REFUSALS.stale);
    return host.refuse(deps, task, error);
  }
  return "started";
}

/** The owner's Revise the plan press from Slack. Its own event kind (not a flag on Send back), so a broker that does not know it drops it instead of sending the work back to coding. */
export interface SlackWorkflowRevisePlanEvent { source: "agentx.slack-ingress"; action: "workflow-revise-plan"; taskId: string; userId: string; thread: { teamId: string; channelId: string; threadTs: string }; requestId: string; expectedRevision: number }

export function isSlackWorkflowRevisePlanEvent(event: unknown): event is SlackWorkflowRevisePlanEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-revise-plan" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.thread === "object" && value.thread !== null;
}
