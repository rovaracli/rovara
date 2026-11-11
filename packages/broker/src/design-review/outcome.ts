// Design review stage, DR7 slice B: what a design-review operation's END does to the workflow. `planCritiqueOutcome` (plan-answers.ts) hands a task whose plan-check stage is the design review's here; the plan check's own moves
// (`submitPlanCritique`, `closePlanCritique`, `retryPlanCritique`) refuse such a workflow, so every end of the stage that the plan check has is answered here with the design review's own move:
//
//   a result that SUCCEEDED   -> the round is recorded (round-record.ts): findings, runs, measured spend, the planner next, or the person;
//   the budget ran out        -> the review stops at the cost cap, with what the keys spent;
//   rule files unverified, leftover programs -> BLOCKED with the plan check's own reasons (Retry resumes it: `resumeBlockedDesignReview`);
//   the model was refused     -> the same round again on the next model (`retryDesignReview`), bounded like the plan check's;
//   any other end             -> the review did not run (`worker_failed`), with what its keys already cost.
//
// Every end releases the round: the stored packets are removed and each slot key is blocked and finalized, so nothing a worker still holds can spend or be served. A late result for a workflow that is no longer running this
// round changes nothing.
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, WORKFLOW_LEFTOVER_PROCESSES_MESSAGE, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, addDesignUsd, type OperationStatus } from "@rovara-code/contracts";
import { WORKFLOW_BLOCK_REASONS, blockWorkflow, closeDesignReview, retryDesignReview, WorkflowSnapshotSchema, type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { queryAllItems, type AdminReadDependencies } from "../aws/admin-reads.js";
import type { OperationRecord } from "../aws/cancellation.js";
import type { AwsBrokerDependencies } from "../aws/broker/definitions.js";
import { readObjectText, loadWorkflowDocument } from "../developer/plan-artifacts.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { criticFailures } from "../model-selection/task-failures.js";
import { scopedTaskOperations } from "../model-selection/task-references.js";
import { CRITIC_MODEL_ATTEMPTS_MAX, criticModelUnusable } from "../rovara-code/critic.js";
import { recordDesignReviewRound, releaseDesignReviewRound, type RoundRecordPorts } from "./round-record.js";
import { roundRecordPortsOf } from "./wiring.js";

/** The retry on the next model is allowed while fewer than the plan check's number of attempts have failed since the latest planning run. */
async function mayTryNextModel(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, operation: OperationRecord): Promise<boolean> {
  const operations = (await queryAllItems(dependencies, `WORKSPACE#${operation.workspaceId}`, "OPERATION#")).filter((item) => item.entityType === "OPERATION" && item.kind === "task");
  const planner = operations.filter((item) => item.workflowMode === "PLAN" && item.conversationId === task.conversationId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).at(-1);
  // This operation is not yet stored as failed: it is one more try than the stored ones.
  return criticFailures(operations.filter((item) => item.id !== operation.id), planner).sinceLatestPlan + 1 < CRITIC_MODEL_ATTEMPTS_MAX;
}

/**
 * DR-KEY-1 review: whether the plan-check stage has used its model tries since the latest planning run, by the dispatch's own rule (task-operations.ts: the task's scoped operations, `criticFailures` since the
 * latest PLAN, refused at CRITIC_MODEL_ATTEMPTS_MAX). A "Retry review" then could only be refused when it dispatches, so it is not offered. An unreadable history offers nothing either (fail closed).
 */
export async function planCheckModelTriesUsed(dependencies: Pick<AdminReadDependencies, "documentClient" | "tableName">, task: Pick<DeveloperTaskRecord, "orgId" | "workspaceId" | "conversationId" | "taskId">): Promise<boolean> {
  if (task.orgId === undefined) return true;
  try {
    const operations = scopedTaskOperations(await queryAllItems(dependencies, `WORKSPACE#${task.workspaceId}`, "OPERATION#"), { orgId: task.orgId, workspaceId: task.workspaceId, conversationId: task.conversationId, taskId: task.taskId });
    const planner = operations.filter((item) => item.workflowMode === "PLAN").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    return criticFailures(operations, planner).sinceLatestPlan >= CRITIC_MODEL_ATTEMPTS_MAX;
  } catch { return true; }
}

/**
 * The workflow after the design review's operation ended. `ports` defaults to the broker's own; a test gives others. Never throws for an end it cannot read.
 */
export async function designReviewOutcome(
  dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord & { workflow: WorkflowSnapshot }, operation: OperationRecord, terminalStatus: OperationStatus, terminalError: string | undefined, now: string,
  ports: RoundRecordPorts = roundRecordPortsOf(dependencies),
  /** B-M2: collects the Delete items that remove the round's packets, for the commit that records the round. */
  release?: unknown[],
): Promise<WorkflowSnapshot> {
  const workflow = task.workflow;
  const review = workflow.designReview;
  // A result counts only while the task waits for exactly this round (RUNNING, "running"); a late one changes nothing.
  if (review === undefined || workflow.state !== "RUNNING" || review.status !== "running") return workflow;
  const expectedRevision = workflow.revision;

  if (terminalStatus === "SUCCEEDED") {
    const read = (key: string, maxBytes: number) => readObjectText(dependencies.s3, dependencies.artifactBucketName, key, maxBytes);
    const designArtifact = workflow.artifacts.filter((artifact) => artifact.type === "design").at(-1);
    const requirementsArtifact = workflow.artifacts.filter((artifact) => artifact.type === "requirements").at(-1);
    const [design, requirements] = [designArtifact === undefined ? undefined : await loadWorkflowDocument(read, designArtifact, {}), requirementsArtifact === undefined ? undefined : await loadWorkflowDocument(read, requirementsArtifact, {})];
    if (designArtifact === undefined || design === undefined) {
      // The design that was reviewed cannot be read back: nothing can be checked against it.
      const released = await releaseDesignReviewRound(ports, operation);
      return closeDesignReview(workflow, { expectedRevision, outcome: "not_run", notRunReason: "inputs_unverified", addedSpendUsd: released.spentUsd, now });
    }
    return recordDesignReviewRound(ports, { workflow, operation, design: { text: design.markdown, sha256: designArtifact.sha256 }, requirementsText: requirements?.markdown ?? "", ...(release === undefined ? {} : { release }), now });
  }

  // The operation ended without a result to read: what its keys cost is added to the review's total either way (a lost run still spent it), and the round is released.
  const { spentUsd } = await releaseDesignReviewRound(ports, operation);
  if (terminalError === BUDGET_EXHAUSTED_FAILURE_MESSAGE) return closeDesignReview(workflow, { expectedRevision, outcome: "stopped_at_cap", addedSpendUsd: spentUsd, now });
  // B-m3: a blocked round keeps what its keys cost (the block would otherwise drop it, and a Retry would have to guess it again).
  const blockedWith = (reason: string): WorkflowSnapshot => {
    const blocked = blockWorkflow(workflow, reason, now);
    return blocked.designReview === undefined ? blocked : WorkflowSnapshotSchema.parse({ ...blocked, designReview: { ...blocked.designReview, spentUsd: addDesignUsd(blocked.designReview.spentUsd, spentUsd) } });
  };
  if (terminalError?.includes(WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE) === true) return blockedWith(WORKFLOW_BLOCK_REASONS.stepRuleFilesUnverified);
  if (terminalError?.includes(WORKFLOW_LEFTOVER_PROCESSES_MESSAGE) === true) return blockedWith(WORKFLOW_BLOCK_REASONS.leftoverProcesses);
  // The account could not use the model: the same round again on the next-ranked one, bounded; with none left the review did not run.
  if (terminalStatus === "FAILED" && criticModelUnusable(terminalError) && await mayTryNextModel(dependencies, task, operation)) return retryDesignReview(workflow, { expectedRevision, addedSpendUsd: spentUsd, now });
  return closeDesignReview(workflow, { expectedRevision, outcome: "not_run", notRunReason: criticModelUnusable(terminalError) ? "no_model_source" : terminalStatus === "CANCELLED" ? "cancelled" : "worker_failed", addedSpendUsd: spentUsd, now });
}
