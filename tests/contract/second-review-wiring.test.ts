// SH34 wiring, the two key rules first: (1) a second review's result NEVER reaches the workflow, so a second-review PASS cannot clear a first-review FINDINGS; (2) shadow findings never reach the pull request.
// Then: the opinion is stored beside the workflow and nothing else; the pull request carries only an `on` second review's block or "did not run" line; with `cr` off the description is byte for byte today's.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorkflowSnapshot, createCandidateManifest, WorkflowSnapshotSchema, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { reviewCleared, type ModelIdentifier, type SecondOpinion, type WorkflowReviewReport } from "@agentx/contracts";
import { completedWorkflowItems } from "../../packages/broker/src/aws/broker/workflow-items.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { planSecondReview, secondOpinionOf, secondOpinionUnavailable } from "../../packages/broker/src/rovara-code/second-review.js";
import { secondOpinionOfTask, secondReviewEndItems, secondReviewExpiredItems, secondReviewPullRequestLines, type SecondReviewPending } from "../../packages/broker/src/rovara-code/second-review-store.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = "2026-11-02T12:00:00.000Z";
const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const NOVA: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-premier-v1:0" };
const OFF = {} as NodeJS.ProcessEnv;
const ENABLED = { SECOND_REVIEW_ENABLED: "1" } as NodeJS.ProcessEnv;

const review = (role: "CRITIC" | "SECURITY", more: Record<string, unknown> = {}) => ({
  operationId: randomUUID(), candidateDigest: code.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW, ...more,
});
const BLOCKING = { text: "off by one in the loop bound", origin: "INTRODUCED" as const };
function workflowWith(extra: Record<string, unknown> = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now: NOW, definitionVersion: "1.1.0" }),
    stage: "REVIEW", state: "RUNNING", candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    ...extra,
  });
}

const plan = () => {
  const planned = planSecondReview({
    switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [NOVA], drivingTestPassed: () => true, verdicts: [], replayRuns: [],
  });
  if (!planned.run) throw new Error("expected a plan");
  return planned;
};
const pending = (operationId: string, mode: "shadow" | "on" = "on", deadlineAt = "2026-11-02T13:00:00.000Z"): SecondReviewPending => {
  const planned = plan();
  return { operationId, candidateDigest: code.digest, startedAt: NOW, deadlineAt, attempts: [], plan: { mode, company: planned.company, model: planned.model, against: planned.against } };
};
const secondReport = (operationId: string, status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = []): WorkflowReviewReport => ({
  operationId, candidateDigest: code.digest, role: "CRITIC", provider: "amazon-bedrock", version: "us.amazon.nova-premier-v1:0", status, findings, readOnly: true, recordedAt: NOW,
});

function harness(taskExtra: Record<string, unknown> = {}) {
  const db = new FakeDynamoDb();
  const workflow = workflowWith({ reviews: [review("CRITIC", { status: "FINDINGS", findings: [{ text: "first reviewer: missing null check", origin: "INTRODUCED" }] })] });
  db.set({ ...taskKey(taskId), taskId, workflow, ...taskExtra });
  const dependencies = { documentClient: db, tableName: "state" } as unknown as AwsBrokerDependencies;
  return { db, dependencies, workflow };
}

describe("key rule 1: a second review never reaches the workflow", () => {
  it("a second-review PASS ends in one write that touches only the second-review attributes, never the workflow", async () => {
    const operationId = randomUUID();
    const { dependencies, workflow } = harness({ secondReviewPending: pending(operationId) });
    const items = await completedWorkflowItems(dependencies, { id: operationId, kind: "task", workflowMode: "REVIEW", secondReview: true, model: NOVA } as never, { taskId } as never, "SUCCEEDED", NOW, { workflowReviews: [secondReport(operationId, "PASS")] });
    expect(items).toHaveLength(1);
    const update = (items[0] as { Update: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> } }).Update;
    expect(update.UpdateExpression).toBe("SET secondOpinion = :opinion, updatedAt = :now REMOVE secondReviewPending");
    expect(update.UpdateExpression).not.toMatch(/workflow/u);
    expect(Object.keys(update.ExpressionAttributeValues)).not.toContain(":workflow");
    // The first review's FINDINGS still block: nothing about the workflow changed, and a second PASS is not a review of it.
    const first = workflow.reviews![0]!;
    expect(first.status).toBe("FINDINGS");
    expect(reviewCleared(first, undefined)).toBe(false);
    expect((update.ExpressionAttributeValues[":opinion"] as { opinion: SecondOpinion }).opinion).toMatchObject({ unavailable: false, blocked: false });
  });

  it("the same holds when the second review fails, is stopped, or returns garbage: only the second-review attributes are written", async () => {
    for (const [status, result] of [["FAILED", undefined], ["CANCELLED", null], ["SUCCEEDED", { workflowReviews: "nonsense" }], ["SUCCEEDED", { workflowReviews: [] }], ["SUCCEEDED", { workflowReviews: [{ nope: 1 }] }]] as const) {
      const operationId = randomUUID();
      const { dependencies } = harness({ secondReviewPending: pending(operationId) });
      const items = await completedWorkflowItems(dependencies, { id: operationId, kind: "task", workflowMode: "REVIEW", secondReview: true } as never, { taskId } as never, status, NOW, result);
      expect(items).toHaveLength(1);
      const update = (items[0] as { Update: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> } }).Update;
      expect(update.UpdateExpression).not.toMatch(/workflow/u);
      expect((update.ExpressionAttributeValues[":opinion"] as { opinion: SecondOpinion }).opinion).toMatchObject({ unavailable: true, unavailableReason: "no-answer", blocked: false });
    }
  });

  it("a second review that is not the pending one writes nothing (a late or duplicate end)", async () => {
    const { dependencies } = harness({ secondReviewPending: pending(randomUUID()) });
    expect(await completedWorkflowItems(dependencies, { id: randomUUID(), kind: "task", workflowMode: "REVIEW", secondReview: true } as never, { taskId } as never, "SUCCEEDED", NOW, { workflowReviews: [] })).toEqual([]);
    const none = harness();
    expect(await completedWorkflowItems(none.dependencies, { id: randomUUID(), kind: "task", workflowMode: "REVIEW", secondReview: true } as never, { taskId } as never, "SUCCEEDED", NOW, {})).toEqual([]);
  });

  it("a report for another candidate, another model or the security role is stored as unavailable, never as an answer", () => {
    const operationId = randomUUID();
    const base = { tableName: "state", task: { taskId, secondReviewPending: pending(operationId), workflow: { candidate: { digest: code.digest } } }, operation: { id: operationId, model: NOVA }, terminalStatus: "SUCCEEDED", now: NOW, taskKey };
    const opinionOf = (over: Partial<Parameters<typeof secondReviewEndItems>[0]>, report: WorkflowReviewReport) => {
      const items = secondReviewEndItems({ ...base, ...over, result: { workflowReviews: [report] } });
      return ((items[0] as { Update: { ExpressionAttributeValues: Record<string, unknown> } }).Update.ExpressionAttributeValues[":opinion"] as { opinion: SecondOpinion }).opinion;
    };
    expect(opinionOf({}, secondReport(operationId, "PASS"))).toMatchObject({ unavailable: false });
    expect(opinionOf({}, { ...secondReport(operationId, "PASS"), candidateDigest: "c".repeat(64) })).toMatchObject({ unavailable: true, unavailableReason: "wrong-candidate" });
    expect(opinionOf({}, { ...secondReport(operationId, "PASS"), role: "SECURITY" })).toMatchObject({ unavailable: true, unavailableReason: "wrong-role" });
    expect(opinionOf({ operation: { id: operationId, model: SONNET } }, secondReport(operationId, "FINDINGS", [BLOCKING]))).toMatchObject({ unavailable: true, unavailableReason: "wrong-model", wouldHaveBlocked: false });
  });
});

describe("the wait is bounded: a review that never ends is given up on, flagged, never hung", () => {
  it("past its deadline the sweep writes 'did not run' for that candidate and removes the pending record", () => {
    const operationId = randomUUID();
    const task = { taskId, secondReviewPending: pending(operationId, "on", "2026-11-02T12:30:00.000Z") };
    expect(secondReviewExpiredItems({ tableName: "state", task, now: "2026-11-02T12:29:59.000Z", taskKey })).toEqual([]);
    const items = secondReviewExpiredItems({ tableName: "state", task, now: "2026-11-02T12:30:00.000Z", taskKey });
    expect(items).toHaveLength(1);
    const update = (items[0] as { Update: { UpdateExpression: string; ConditionExpression: string; ExpressionAttributeValues: Record<string, unknown> } }).Update;
    expect(update.UpdateExpression).toContain("REMOVE secondReviewPending");
    expect(update.UpdateExpression).not.toMatch(/workflow/u);
    expect(update.ConditionExpression).toContain("secondReviewPending.operationId = :operation");
    expect((update.ExpressionAttributeValues[":opinion"] as { opinion: SecondOpinion }).opinion).toMatchObject({ mode: "on", unavailable: true, unavailableReason: "no-answer", blocked: false });
  });

  it("nothing is pending, nothing is written", () => {
    expect(secondReviewExpiredItems({ tableName: "state", task: { taskId }, now: NOW, taskKey })).toEqual([]);
  });
});

const prBody = (task: Record<string, unknown>, workflow = workflowWith({ stage: "PULL_REQUEST", state: "READY", reviews: [review("CRITIC"), review("SECURITY")] })) =>
  workflowPullRequestBody({ title: "Add a retry flag", ...task } as never, workflow, "# Plan\n\n1. Add the flag.\n", "https://rovara.example/task", { changedFiles: { files: [{ repository: "payments", path: "src/a.ts", added: 3, removed: 1 }], complete: true } });
const stored = (opinion: SecondOpinion) => ({ secondOpinion: { candidateDigest: code.digest, opinion, recordedAt: NOW } });
const onPlan = { ...plan(), mode: "on" as const };

describe("key rule 2: shadow findings never reach the pull request", () => {
  const withEnv = <T,>(run: () => T): T => { const before = process.env.SECOND_REVIEW_ENABLED; process.env.SECOND_REVIEW_ENABLED = "1"; try { return run(); } finally { if (before === undefined) delete process.env.SECOND_REVIEW_ENABLED; else process.env.SECOND_REVIEW_ENABLED = before; } };

  it("a shadow opinion with blocking findings adds nothing to the description, even with cr on", () => {
    const shadow = secondOpinionOf({ plan: plan(), report: secondReport(randomUUID(), "FINDINGS", [{ text: "SHADOW-SECRET-FINDING", origin: "INTRODUCED" }]), currentCandidateDigest: code.digest, ranModel: NOVA });
    expect(shadow).toMatchObject({ mode: "shadow", wouldHaveBlocked: true });
    withEnv(() => {
      const body = prBody(stored(shadow));
      expect(body).not.toContain("SHADOW-SECRET-FINDING");
      expect(body).not.toMatch(/Second review/u);
      expect(body).toBe(prBody({}));
    });
  });

  it("a shadow review that did not run is silent too", () => {
    withEnv(() => expect(prBody(stored(secondOpinionUnavailable({ mode: "shadow", company: "amazon" }, "no-answer")))).toBe(prBody({})));
  });

  it("an on review that did not run puts exactly one fixed line in the Reviews section", () => {
    withEnv(() => {
      const body = prBody(stored(secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer")));
      expect(body).toContain("Second review did not run: the reviewer gave no usable answer after retrying");
      const reviews = body.slice(body.indexOf("## Reviews"), body.indexOf("## Risk"));
      expect(reviews).toContain("Second review did not run");
    });
  });

  it("an on review that blocked lists its blocking findings made inert", () => {
    const blocked = secondOpinionOf({ plan: { ...onPlan, against: [SONNET] }, report: secondReport(randomUUID(), "FINDINGS", [{ text: "ping @octocat see [x](https://evil.example) #12", origin: "INTRODUCED" }]), currentCandidateDigest: code.digest, ranModel: NOVA });
    expect(blocked).toMatchObject({ mode: "on", blocked: true });
    withEnv(() => {
      const body = prBody(stored(blocked));
      expect(body).toContain("Second review (");
      expect(body).not.toMatch(/\]\(https/u);
      expect(body).not.toMatch(/(?<!‍)@octocat/u);
    });
  });

  it("with cr off the description is exactly today's, whatever is stored", () => {
    const flagged = secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer");
    expect(secondReviewPullRequestLines(stored(flagged), code.digest, OFF)).toEqual([]);
    expect(secondReviewPullRequestLines(stored(flagged), code.digest, ENABLED)).toHaveLength(1);
    expect(prBody(stored(flagged))).toBe(prBody({}));
  });

  it("an opinion about other code is not shown", () => {
    const flagged = secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer");
    expect(secondReviewPullRequestLines({ secondOpinion: { candidateDigest: "f".repeat(64), opinion: flagged, recordedAt: NOW } }, code.digest, ENABLED)).toEqual([]);
    expect(secondOpinionOfTask({ secondOpinion: { candidateDigest: code.digest, opinion: { junk: true }, recordedAt: NOW } }, code.digest)).toBeUndefined();
    expect(secondOpinionOfTask({}, undefined)).toBeUndefined();
  });

});
