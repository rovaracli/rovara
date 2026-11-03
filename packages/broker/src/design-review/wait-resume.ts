// Design review stage, DR10 (3.7, money re-check W6): a person picks up a PARKED design review from its card. Slice C's route calls `designResumeHandler` (one line); EVERY check is in here: who may (the same people the
// handlers let act on this wait: the audience of the question card, the design card's approvers, the requester and the maintainers for a cost hold, and the maintainers when the configured approver has left), then the
// workflow's own move `resumeParkedDesignReview`, committed conditionally on the revision read. Resuming answers nothing, approves nothing and spends nothing: the review waits again and the clock starts over.
//
// An ANSWER or a DECISION on a parked review needs no resume: `answerDesignQuestions` and the design card's approval accept a parked wait directly (the wait record is simply gone or ignored afterwards), after the same
// eligibility checks their handlers make. This handler is for the "Resume" button, and for the person who wants it open again without deciding yet.
import { WorkflowTransitionError, agentXError, designWaitOf, resumeParkedDesignReview, type EditionPolicy, type WorkflowSnapshot } from "@agentx/contracts";
import { taskKey } from "../developer/task-records.js";
import type { DesignApproverDirectory } from "./approval.js";
import type { EffectiveDesignReviewSetting } from "./effective-setting.js";
import { waitAudienceOf } from "./wait-audience.js";

const same = (left: string, right: string): boolean => left.normalize("NFC").trim().toLowerCase() === right.normalize("NFC").trim().toLowerCase();
const has = (list: readonly string[], id: string): boolean => list.some((entry) => same(entry, id));

export interface DesignResumeContext {
  taskId: string;
  requesterId: string;
  workflow: WorkflowSnapshot;
  setting: EffectiveDesignReviewSetting;
  directory: DesignApproverDirectory;
  edition: EditionPolicy | undefined;
}

/** Whether this person may resume this parked wait. Members only (never an Auditor or a viewer), and only one of the people the wait is on or the maintainers who can act for it. Fails closed. */
export function mayResumeDesignReview(input: { callerId: string; context: DesignResumeContext }): boolean {
  const { context, callerId } = input;
  const wait = designWaitOf(context.workflow);
  const review = context.workflow.designReview;
  if (wait === undefined || review === undefined || wait.parkedAt === undefined) return false;
  const { directory } = context;
  const member = has(directory.people.eligibleIds, callerId) || has(directory.projectMemberIds, callerId);
  if (!member || has(directory.notApproverIds, callerId)) return false;
  const audience = waitAudienceOf({ kind: wait.kind, requesterId: context.requesterId, reasons: review.reasons, setting: context.setting, directory, edition: context.edition });
  return has([...audience.asked, ...audience.maintainers, ...audience.escalate], callerId);
}

export interface DesignResumeCommit { workflow: WorkflowSnapshot; items: unknown[] }

/** The resume move and its conditional write to the task, for one transaction with the caller's fence and the request's record. */
export function designResumeCommitItems(input: { tableName: string; taskId: string; workflow: WorkflowSnapshot; actorId: string; now: string }): DesignResumeCommit {
  const next = resumeParkedDesignReview(input.workflow, { expectedRevision: input.workflow.revision, by: { actorId: input.actorId }, now: input.now });
  return {
    workflow: next,
    items: [{ Update: {
      TableName: input.tableName, Key: taskKey(input.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
      ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
      ExpressionAttributeValues: { ":workflow": next, ":now": input.now, ":revision": input.workflow.revision },
    } }],
  };
}

export interface DesignResumePorts<C extends { developerId: string }> {
  /** The broker's record of the task, read fresh for this request. Nothing in it comes from the request body. */
  context(caller: C, taskId: string): Promise<DesignResumeContext | undefined>;
  /** Runs `designResumeCommitItems` in a transaction with the caller's fence and the request's record. "stale": the task moved. */
  commit(caller: C, write: { taskId: string; requestId: string; actorId: string; workflow: WorkflowSnapshot }): Promise<"done" | "stale">;
  now(): number;
}

export function designResumeHandler<C extends { developerId: string }>(ports: DesignResumePorts<C>): (caller: C, request: { taskId: string; requestId: string }) => Promise<{ kind: "done" }> {
  return async (caller, request) => {
    const context = await ports.context(caller, request.taskId);
    // A task the caller cannot see, one that is not parked, and one the caller may not resume are the same answer.
    if (context === undefined || !mayResumeDesignReview({ callerId: caller.developerId, context })) throw agentXError("NOT_FOUND", "This decision is no longer waiting for you.");
    try {
      designResumeCommitItems({ tableName: "check", taskId: context.taskId, workflow: context.workflow, actorId: caller.developerId, now: new Date(ports.now()).toISOString() });
    } catch (error) {
      if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
      throw error;
    }
    const written = await ports.commit(caller, { taskId: context.taskId, requestId: request.requestId, actorId: caller.developerId, workflow: context.workflow });
    if (written !== "done") throw agentXError("CHANGE_STALE", "This changed while you were looking. Open it again.");
    return { kind: "done" };
  };
}
