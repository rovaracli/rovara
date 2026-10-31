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
import { markSteerRevised, readSteerMessage } from "./steer.js";

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
  /** The turn record and the access fence that go in the one transaction. */
  acceptItems(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, access: A, input: { request: string; response: string; operationId: string; at: string }): TransactItems;
  /** Turns a refused acceptance into the words the task module says (busy workspace, closing). */
  refuse(deps: DeveloperTaskRouteDependencies, task: DeveloperTaskRecord, error: unknown): Promise<never>;
  /** The task as the caller sees it now (and its index kept current). */
  view(deps: DeveloperTaskRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<{ task: DeveloperTaskView }>;
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

/** `REMOVE liveSteerChange` after the cap window's own clause, whichever clause it is (a REMOVE of its own already, or none). */
const withChangeRemoved = (clause: string): string => (clause.includes(" REMOVE ") ? `${clause}, liveSteerChange` : `${clause} REMOVE liveSteerChange`);

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
  // A repeat of a press that was taken is that press: it answers as it did and starts nothing.
  const prior = workflow.decisions.find((decision) => decision.requestId === request.requestId);
  if (prior !== undefined) {
    if (prior.reason !== WORKFLOW_REVISE_PLAN_DECISION_REASON || prior.decision !== "REQUEST_CHANGES" || prior.actorId !== access.actorId) {
      throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID was already used for another decision on this task; use a new one");
    }
    return host.view(deps, caller, taskId);
  }
  if (request.expectedRevision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", REVISE_PLAN_REFUSALS.stale);
  await host.requireMayGoOn(deps, caller, task);
  if (!workflowReviseOffered(workflow)) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.notOffered);
  const recorded = task.liveSteerChange;
  if (recorded === undefined || recorded.workflowRevision !== workflow.revision) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.noChange);
  const change = await requestedChange(deps, task, recorded.messageIds);
  if (change === undefined) throw agentXError("CONFIG_INVALID", REVISE_PLAN_REFUSALS.noChange);
  const receivedAt = new Date(deps.now()).toISOString();
  let returned: WorkflowSnapshot;
  try {
    returned = revisePlanWithLiveChange(workflow, { requestId: request.requestId, actorId: access.actorId, now: receivedAt }, access.authority);
  } catch (error) {
    return transitionRefusal(error);
  }
  await host.actionableWorkspace(deps, task);
  const artifact = workflow.artifacts.filter((entry) => entry.type === "plan").at(-1)!;
  const loaded = await loadWorkflowDocument((objectKey, maxBytes) => deps.actions.readArtifact(objectKey, maxBytes), artifact, {});
  if (loaded === undefined) throw agentXError("WORKSPACE_NOT_READY", REVISE_PLAN_REFUSALS.planUnreadable);
  // The owner's words, and why they are here, after the document (the planner is told what its answer is for; only the owner's approval of what it writes starts coding).
  const source = `The owner sent this as a live message while coding ran; coding stopped because it asks for a change outside the approved plan. Write the change into the revised document. The owner approves the revised plan before any coding.`;
  const comments = `\n\n${source}`;
  const prompt = loaded.format === "structured"
    ? host.structuredPrompt(loaded, change, workflow.reviewPhase, comments)
    : `Revise the current coding plan. Requested changes: ${change}\n\nReturn the complete revised document. Do not edit files.\n\n${host.markdownBlock(loaded.markdown)}${comments}`;
  const retired = await host.retiredClaimIds(deps, workflow);
  const cap = await host.capWindow(deps, task);
  const next: WorkflowSnapshot = { ...returned, revision: returned.revision + 1, state: "RUNNING", updatedAt: receivedAt };
  try {
    await deps.actions.acceptTask(developerTaskIdentity(task, deps.orgId), task.workspaceId, { requestId: request.requestId, conversationId: task.conversationId, prompt }, (operation) => [
      { Update: {
        TableName: deps.tableName, Key: taskKey(taskId),
        UpdateExpression: `SET workflow = :workflow, updatedAt = :now${withChangeRemoved(cap.clause)}`,
        ConditionExpression: "workflow.revision = :revision AND workflow.#stage = :implement AND workflow.#state = :blocked AND workflow.blockReason = :reason AND liveSteerChange.workflowRevision = :revision AND attribute_not_exists(closedAt)",
        ExpressionAttributeNames: { "#stage": "stage", "#state": "state" },
        ExpressionAttributeValues: { ":workflow": next, ":now": receivedAt, ":revision": workflow.revision, ":implement": "IMPLEMENT", ":blocked": "BLOCKED", ":reason": WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise, ...cap.values },
      } },
      ...host.acceptItems(deps, caller, access, { request: "Revise the plan with the owner's live message", response: `Planning the revised plan started as operation ${operation.id}`, operationId: operation.id, at: receivedAt }),
    ], { sharedTask: task.shared === true, workflowMode: "PLAN", ...(retired.length === 0 ? {} : { retiredClaimIds: retired }), ...(workflow.reviewPhase === undefined ? {} : { workflowPhase: workflow.reviewPhase }) });
  } catch (error) {
    // Another press, or anything else that moved the task, got there first: the same request is that press; any other is out of date.
    const fresh = await host.authorize(deps, caller, taskId);
    if (fresh.task.workflow?.decisions.some((decision) => decision.requestId === request.requestId) === true) return host.view(deps, caller, taskId);
    if (fresh.task.workflow !== undefined && fresh.task.workflow.revision !== workflow.revision) throw agentXError("IDEMPOTENCY_CONFLICT", REVISE_PLAN_REFUSALS.stale);
    return host.refuse(deps, task, error);
  }
  // The messages say what became of them (best effort and after the commit: the revised plan is already being written whatever happens here).
  for (const id of recorded.messageIds) await markSteerRevised(deps, task.orgId as OrgId, task.sessionId as SessionId, id);
  return host.view(deps, caller, taskId);
}
