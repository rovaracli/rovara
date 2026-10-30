// Live steer: a step that stopped because the owner's live message asked for a change outside the approved plan tells the owner a way to decide that really exists, on every surface.
// Understand and Plan: Retry plans again with the message and the new plan is approved before anything is built. Coding: there is no way to approve a change to the plan from a blocked
// coding step (Send back and Retry both keep the approved plan), so the words say so: retry without the change, or close and start a new task that asks for it. Nothing here may
// promise a note or a send-back that cannot do it.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, workflowSendBackOffered } from "../../packages/contracts/src/task-workflow-node.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { taskPageStage } from "../../packages/broker/src/aws/developer-tasks.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-30T12:00:00.000Z";
const blocked = (stage: string, blockReason: string) => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now, definitionVersion: "1.1.0", understand: true, pathFrom: "understand" }), revision: 7, stage, state: "BLOCKED", blockReason,
  artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now }],
});
const buttonsOf = (message: NonNullable<ReturnType<typeof workflowMessage>>): string[] => message.blocks
  .flatMap((block) => ((block as { elements?: Array<{ text?: { text: string } }> }).elements ?? []).map((element) => element.text?.text ?? ""));
const WRONG = /put it in a note|send the task back|send it back|approve the change/iu;

describe("the owner's way to decide after a live message asked for a change outside the plan", () => {
  it("coding has its own words: nothing is built from the message, retry builds the approved plan without it, and a new task is the way to include it", () => {
    expect(WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding).not.toBe(WORKFLOW_BLOCK_REASONS.liveSteerReapproval);
    const reason = WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding;
    expect(reason).toMatch(/Retry coding/u);
    expect(reason).toMatch(/new task/u);
    expect(reason).not.toMatch(WRONG);
  });

  it("Slack: a blocked coding step offers exactly the actions its words name (Retry coding, Close), and the text names no action it lacks", () => {
    const workflow = blocked("IMPLEMENT", WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding);
    const message = workflowMessage({ taskId, workflow })!;
    expect(buttonsOf(message)).toEqual(["Retry coding", "Close task"]);
    expect(workflowSendBackOffered(workflow)).toBe(true); // the contract allows it, but the card does not carry it: it keeps the approved plan, so it could not approve the change
    expect(message.text).toContain("Retry coding");
    expect(message.text).toContain("new task");
    expect(message.text).not.toMatch(WRONG);
  });

  it("the task page says the same ways on for a blocked coding step, and not the generic ones", () => {
    const step = taskPageStage(blocked("IMPLEMENT", WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding), false, true);
    expect(step.status).toBe("Coding stopped for a change outside the plan");
    expect(step.nextStep).toMatch(/Retry coding/u);
    expect(step.nextStep).toMatch(/new task/u);
    expect(step.nextStep).not.toMatch(WRONG);
    // A teammate reading the page is told it is the owner's call.
    expect(taskPageStage(blocked("IMPLEMENT", WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding), false, false).nextStep).toMatch(/owner/u);
  });

  it("Understand and Plan: Retry re-plans with the message and the new plan is what the owner approves; the words say that and nothing about a note or a send-back", () => {
    const reason = WORKFLOW_BLOCK_REASONS.liveSteerReapproval;
    expect(reason).toMatch(/Retry/u);
    expect(reason).toMatch(/approve the new plan/u);
    expect(reason).not.toMatch(WRONG);
    const understand = workflowMessage({ taskId, workflow: blocked("UNDERSTAND", reason) })!;
    expect(buttonsOf(understand)).toEqual(["Retry understanding", "Close task"]);
    expect(understand.text).toContain("approve the new plan");
    const plan = workflowMessage({ taskId, workflow: blocked("PLAN", reason) })!;
    expect(buttonsOf(plan)).toEqual(["Retry planning", "Close task"]);
    expect(plan.text).toContain("approve the new plan");
    expect(taskPageStage(blocked("PLAN", reason), false, true).nextStep).toMatch(/Retry planning/u);
  });
});
