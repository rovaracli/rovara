// Design review stage, DR7 slice B2 (design-review-stage.md 3.2, 3.7): a person answers the question card, and the planner runs again. Two parts:
//   - `designAnswersCommitItems`: the contract move `answerDesignQuestions` and the CRITIC_REPLAN row that makes the planner's resolve run due, at the NEW revision, in ONE transaction (the answers and the next step can never differ);
//   - `designAnswersHandler`: every permission check, so a route is one line. The audience is the requester, and for a high-risk design the high-risk approver too (`designQuestionAudience`); an Auditor, a viewer or a
//     non-member is never in it. The first answer counts. Nobody answers for the person: this never builds an answer.
import { WorkflowTransitionError, agentXError, isHighRiskDesign, type DesignReason } from "@rovara-code/contracts";
import { answerDesignQuestions, type EditionPolicy, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { taskKey } from "../developer/task-records.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../aws/broker-shared.js";
import { designQuestionAudience, type DesignApproverDirectory } from "./approval.js";
import type { EffectiveDesignReviewSetting } from "./effective-setting.js";

export interface DesignAnswersCommit { workflow: WorkflowSnapshot; items: unknown[] }

export function designAnswersCommitItems(
  input: { tableName: string; taskId: string; workflow: WorkflowSnapshot; answers: readonly unknown[]; actorId: string; now: string },
): DesignAnswersCommit {
  const next = answerDesignQuestions(input.workflow, { expectedRevision: input.workflow.revision, answers: input.answers, by: { actorId: input.actorId }, now: input.now });
  return {
    workflow: next,
    items: [
      { Update: {
        TableName: input.tableName, Key: taskKey(input.taskId), UpdateExpression: "SET workflow = :workflow, updatedAt = :now",
        ConditionExpression: "workflow.revision = :revision AND attribute_not_exists(closedAt)",
        ExpressionAttributeValues: { ":workflow": next, ":now": input.now, ":revision": input.workflow.revision },
      } },
      workflowDispatchItem(input.tableName, input.taskId, next.revision, "CRITIC_REPLAN", WORKFLOW_NO_CANDIDATE_DIGEST, input.now),
    ],
  };
}

/** The broker's record of the task, read fresh for this request. Nothing in it comes from the request body. */
export interface DesignAnswersContext {
  taskId: string;
  requesterId: string;
  workflow: WorkflowSnapshot;
  setting: EffectiveDesignReviewSetting;
  /** Every design version's own §6 `touches`. A question about a design that touches a high-risk area is the high-risk approver's too, whatever Understand's reasons said (the union only raises). */
  touches: readonly DesignReason[];
  directory: DesignApproverDirectory;
  edition: EditionPolicy | undefined;
}

export interface DesignAnswersPorts<C extends { developerId: string }> {
  context(caller: C, taskId: string): Promise<DesignAnswersContext | undefined>;
  /** Runs `designAnswersCommitItems` in a transaction with the caller's fence and the request's record. "stale": the task moved. */
  commit(caller: C, write: { taskId: string; requestId: string; actorId: string; answers: readonly unknown[]; workflow: WorkflowSnapshot }): Promise<"done" | "stale">;
  now(): number;
}

const same = (left: string, right: string): boolean => left.normalize("NFC").trim().toLowerCase() === right.normalize("NFC").trim().toLowerCase();

export function designAnswersHandler<C extends { developerId: string }>(ports: DesignAnswersPorts<C>): (caller: C, request: { taskId: string; requestId: string; answers: readonly unknown[] }) => Promise<{ kind: "done" }> {
  return async (caller, request) => {
    const context = await ports.context(caller, request.taskId);
    // A task the caller cannot see, one that is not waiting for answers, and one the caller may not answer for are the same answer.
    const gone = (): never => { throw agentXError("NOT_FOUND", "This decision is no longer waiting for you."); };
    if (context === undefined || context.workflow.designReview?.status !== "waiting_answers" || context.workflow.stage !== "PLAN" || context.workflow.state !== "WAITING") return gone();
    const { directory } = context;
    const member = directory.people.eligibleIds.some((id) => same(id, caller.developerId)) || directory.projectMemberIds.some((id) => same(id, caller.developerId));
    if (!member || directory.notApproverIds.some((id) => same(id, caller.developerId))) return gone();
    const audience = designQuestionAudience({
      requesterId: context.requesterId, aboutHighRisk: isHighRiskDesign([...context.workflow.designReview.reasons, ...context.touches]), setting: context.setting, directory, edition: context.edition,
    });
    if (!audience.some((id) => same(id, caller.developerId))) throw agentXError("FORBIDDEN", "You can't answer these questions.");
    try {
      // The answers are checked by the contract move itself (every question once, an option of that question, cleaned text); a refusal is the request's, not a server fault.
      designAnswersCommitItems({ tableName: "check", taskId: context.taskId, workflow: context.workflow, answers: request.answers, actorId: caller.developerId, now: new Date(ports.now()).toISOString() });
    } catch (error) {
      if (error instanceof WorkflowTransitionError) throw agentXError("CONFIG_INVALID", error.message);
      throw error;
    }
    const written = await ports.commit(caller, { taskId: context.taskId, requestId: request.requestId, actorId: caller.developerId, answers: request.answers, workflow: context.workflow });
    if (written !== "done") throw agentXError("CHANGE_STALE", "This changed while you were looking. Open it again.");
    return { kind: "done" };
  };
}
