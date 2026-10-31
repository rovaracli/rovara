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


// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Revise the plan with this change: the action offered for a coding step blocked with the revise reason, on every surface, and described truthfully.
import { WORKFLOW_ACTION_IDS, workflowSlackHandlers, type SlackBlockAction } from "../../packages/broker/src/aws/slack-interactivity.js";

const REVISE = WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise;
const owner = "U0123456789";
const stranger = "U0456789012";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const nowSeconds = 1_758_657_600;
const press = (actionId: string, value: Record<string, unknown>, userId = owner): SlackBlockAction => ({ actionId, value: JSON.stringify(value),
  userId, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
  requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "blocked", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3", actionTs: "1695500001.000009" });

describe("Revise the plan is offered, and described truthfully, where coding stopped for a change the plan can take in", () => {
  it("the reason names the action and what follows it (the owner approves the revised plan before coding continues), and Retry coding as the other way", () => {
    expect(REVISE).toMatch(/Revise the plan/u);
    expect(REVISE).toMatch(/approve the revised plan before coding continues/u);
    expect(REVISE).toMatch(/Retry coding/u);
    expect(REVISE).not.toMatch(/new task|put it in a note|send the task back|send it back/iu);
  });

  it("Slack: the blocked coding card carries Revise the plan beside Retry coding and Close, and its text says what the button does; the round-2 card (a plan that cannot take the change in) does not", () => {
    const workflow = blocked("IMPLEMENT", REVISE);
    const message = workflowMessage({ taskId, workflow })!;
    expect(buttonsOf(message)).toEqual(["Revise the plan", "Retry coding", "Close task"]);
    expect(message.text).toContain("Revise the plan");
    expect(message.text).toContain("approve the revised plan before coding continues");
    expect(message.text).not.toMatch(WRONG);
    const revise = (message.blocks.flatMap((block) => (block as { elements?: Array<{ action_id: string; value: string }> }).elements ?? [])).find((element) => element.action_id === "agentx_workflow_revise_plan")!;
    expect(JSON.parse(revise.value)).toEqual({ taskId, revision: workflow.revision });
    const old = workflowMessage({ taskId, workflow: blocked("IMPLEMENT", WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding) })!;
    expect(buttonsOf(old)).toEqual(["Retry coding", "Close task"]);
    expect(old.text).not.toContain("Revise the plan");
    expect(WORKFLOW_ACTION_IDS.has("agentx_workflow_revise_plan")).toBe(true);
  });

  it("the task page tells the owner the same ways on (the page button, the Slack thread, Retry coding, close), and a teammate that it is the owner's call", () => {
    const step = taskPageStage(blocked("IMPLEMENT", REVISE), false, true);
    expect(step.status).toBe("Coding stopped for a change outside the plan");
    expect(step.nextStep).toMatch(/Revise the plan/u);
    expect(step.nextStep).toMatch(/approve the revised plan/u);
    expect(step.nextStep).toMatch(/retry coding/iu);
    expect(step.nextStep).not.toMatch(WRONG);
    expect(taskPageStage(blocked("IMPLEMENT", REVISE), false, false).nextStep).toMatch(/owner/u);
    expect(taskPageStage(blocked("IMPLEMENT", REVISE), false, false).nextStep).not.toMatch(/Press/u);
  });

  const task = (workflow: unknown) => ({ taskId, slackUserId: owner, share: thread, workflow });

  it("Slack press: the owner, at the exact revision, on a coding step blocked with the revise reason, hands the broker a revise-plan request (its own event kind); anyone else, a stale card or another block is refused and sends nothing", async () => {
    const workflow = blocked("IMPLEMENT", REVISE);
    let loaded: Record<string, unknown> = task(workflow);
    const sent: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async () => undefined, submit: async () => undefined, revisePlan: async (input) => { sent.push(input); } });
    await handlers.handleAction(press("agentx_workflow_revise_plan", { taskId, revision: workflow.revision }));
    expect(sent).toEqual([{ taskId, userId: owner, thread, expectedRevision: workflow.revision, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown }]);
    await expect(handlers.handleAction(press("agentx_workflow_revise_plan", { taskId, revision: workflow.revision }, stranger))).rejects.toThrow(/Only .* can revise the plan/u);
    await expect(handlers.handleAction(press("agentx_workflow_revise_plan", { taskId, revision: workflow.revision - 1 }))).rejects.toThrow(/out of date/u);
    for (const other of [blocked("IMPLEMENT", WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding), blocked("PLAN", REVISE), blocked("IMPLEMENT", "Coding stopped")]) {
      loaded = task(other);
      await expect(handlers.handleAction(press("agentx_workflow_revise_plan", { taskId, revision: other.revision }))).rejects.toThrow(/out of date/u);
    }
    loaded = task({ ...workflow, state: "RUNNING", blockReason: undefined });
    await expect(handlers.handleAction(press("agentx_workflow_revise_plan", { taskId, revision: workflow.revision }))).rejects.toThrow(/out of date/u);
    expect(sent).toHaveLength(1);
    // A deployment that did not wire it never claims to have started it, and sends nothing.
    const unwired = workflowSlackHandlers({ loadTask: async () => task(workflow), openView: async () => undefined, submit: async () => undefined, sendBack: async (input) => { sent.push(input); } });
    await expect(unwired.handleAction(press("agentx_workflow_revise_plan", { taskId, revision: workflow.revision }))).rejects.toThrow(/not configured/u);
    expect(sent).toHaveLength(1);
  });

  it("the reason says where the action is (so a client without it is not told of a button it lacks), and the worker's frame only says the owner may be able to", () => {
    expect(REVISE).toMatch(/\(in the task's Slack thread or on the task page\)/u);
  });
});
