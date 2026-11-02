// SH34 wiring, the two key rules first: (1) a second review's result NEVER reaches the workflow, so a second-review PASS cannot clear a first-review FINDINGS; (2) shadow findings never reach the pull request.
// Then: the opinion is stored beside the workflow and nothing else; the pull request carries only an `on` second review's block or "did not run" line; with `cr` off the description is byte for byte today's.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorkflowSnapshot, createCandidateManifest, WorkflowSnapshotSchema, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { reviewCleared, workflowFindingFingerprint, type ModelIdentifier, type SecondOpinion, type WorkflowReviewReport } from "@agentx/contracts";
import { completedWorkflowItems } from "../../packages/broker/src/aws/broker/workflow-items.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { specReviewRecordItems } from "../../packages/broker/src/spec/review-record.js";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { planSecondReview, secondOpinionOf, secondOpinionUnavailable, secondReviewAcknowledgement } from "../../packages/broker/src/rovara-code/second-review.js";
import { secondOpinionOfTask, secondReviewEndItems, secondReviewPullRequestLines, secondReviewTaskView, type SecondReviewOperationPlan } from "../../packages/broker/src/rovara-code/second-review-store.js";
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
const planned = plan();
const operationPlan = (mode: "shadow" | "on" = "on", candidateDigest = code.digest): SecondReviewOperationPlan => ({ candidateDigest, plan: { mode, company: planned.company, model: planned.model, against: planned.against } });
/** A second-review operation as the broker records it when it starts one. */
const secondOp = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "task", workflowMode: "REVIEW", secondReview: true, model: NOVA, secondReviewPlan: operationPlan(), ...over });
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
  const update = (items: unknown[]) => (items[0] as { Update: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> } }).Update;
  const opinionIn = (items: unknown[]) => (update(items).ExpressionAttributeValues[":opinion"] as { opinion: SecondOpinion }).opinion;

  it("a second-review PASS ends in one write that touches only the second opinion, never the workflow", async () => {
    const operationId = randomUUID();
    const { dependencies, workflow } = harness();
    const items = await completedWorkflowItems(dependencies, secondOp(operationId) as never, { taskId } as never, "SUCCEEDED", NOW, { workflowReviews: [secondReport(operationId, "PASS")] });
    expect(items).toHaveLength(1);
    expect(update(items).UpdateExpression).toBe("SET secondOpinion = :opinion, updatedAt = :now");
    expect(update(items).UpdateExpression).not.toMatch(/workflow/u);
    expect(Object.keys(update(items).ExpressionAttributeValues)).not.toContain(":workflow");
    // The first review's FINDINGS still block: nothing about the workflow changed, and a second PASS is not a review of it.
    const first = workflow.reviews![0]!;
    expect(first.status).toBe("FINDINGS");
    expect(reviewCleared(first, undefined)).toBe(false);
    expect(opinionIn(items)).toMatchObject({ unavailable: false, blocked: false });
  });

  it("the same holds when the second review fails, is stopped, or returns garbage: only the second opinion is written", async () => {
    for (const [status, result] of [["FAILED", undefined], ["CANCELLED", null], ["SUCCEEDED", { workflowReviews: "nonsense" }], ["SUCCEEDED", { workflowReviews: [] }], ["SUCCEEDED", { workflowReviews: [{ nope: 1 }] }]] as const) {
      const operationId = randomUUID();
      const { dependencies } = harness();
      const items = await completedWorkflowItems(dependencies, secondOp(operationId) as never, { taskId } as never, status, NOW, result);
      expect(items).toHaveLength(1);
      expect(update(items).UpdateExpression).not.toMatch(/workflow/u);
      expect(opinionIn(items)).toMatchObject({ unavailable: true, unavailableReason: "no-answer", blocked: false });
    }
  });

  it("a second-review operation with no recorded plan writes nothing, and never falls through to the first review's branch", async () => {
    const { dependencies } = harness();
    expect(await completedWorkflowItems(dependencies, secondOp(randomUUID(), { secondReviewPlan: undefined }) as never, { taskId } as never, "SUCCEEDED", NOW, { workflowReviews: [] })).toEqual([]);
  });

  describe("what makes an answer an answer", () => {
    const operationId = randomUUID();
    const base = { tableName: "state", task: { taskId, workflow: { candidate: { digest: code.digest } } }, operation: { id: operationId, model: NOVA, secondReviewPlan: operationPlan() }, terminalStatus: "SUCCEEDED", now: NOW, taskKey };
    const opinionOf = (over: Partial<Parameters<typeof secondReviewEndItems>[0]>, report: WorkflowReviewReport) => opinionIn(secondReviewEndItems({ ...base, ...over, result: { workflowReviews: [report] } }));

    it("accepts the code review of the planned candidate from the planned model", () => {
      expect(opinionOf({}, secondReport(operationId, "PASS"))).toMatchObject({ unavailable: false });
    });

    it("a report for another candidate than the plan's (even if it is the task's current one) is unavailable: wrong-candidate", () => {
      const other = "c".repeat(64);
      expect(opinionOf({}, { ...secondReport(operationId, "PASS"), candidateDigest: other })).toMatchObject({ unavailable: true, unavailableReason: "wrong-candidate" });
      // The plan names an earlier candidate, the report agrees with it, but the task has moved on: not the current code.
      expect(opinionOf({ operation: { ...base.operation, secondReviewPlan: operationPlan("on", other) } }, { ...secondReport(operationId, "PASS"), candidateDigest: other })).toMatchObject({ unavailable: true, unavailableReason: "wrong-candidate" });
    });

    it("the security role is wrong-role", () => {
      expect(opinionOf({}, { ...secondReport(operationId, "PASS"), role: "SECURITY" })).toMatchObject({ unavailable: true, unavailableReason: "wrong-role" });
    });

    it("another model is wrong-model, whether the operation record or the report itself names it", () => {
      expect(opinionOf({ operation: { ...base.operation, model: SONNET } }, secondReport(operationId, "FINDINGS", [BLOCKING]))).toMatchObject({ unavailable: true, unavailableReason: "wrong-model", wouldHaveBlocked: false });
      // The operation record says the planned model, but the report's own provider/version says a different one.
      expect(opinionOf({}, { ...secondReport(operationId, "FINDINGS", [BLOCKING]), version: "us.amazon.nova-pro-v1:0" })).toMatchObject({ unavailable: true, unavailableReason: "wrong-model" });
      expect(opinionOf({}, { ...secondReport(operationId, "FINDINGS", [BLOCKING]), provider: "openai", version: "gpt-5.5" })).toMatchObject({ unavailable: true, unavailableReason: "wrong-model" });
      // The same model through another geography is the same revision.
      expect(opinionOf({}, { ...secondReport(operationId, "PASS"), version: "eu.amazon.nova-premier-v1:0" })).toMatchObject({ unavailable: false });
    });

    it("a finding the owner accepted as a risk is neither blocking nor listed, on the opinion, the task page and the pull request", () => {
      const fingerprint = workflowFindingFingerprint("CRITIC", { text: BLOCKING.text });
      const accepted = [{ candidateDigest: code.digest, role: "CRITIC", fingerprint, text: BLOCKING.text, reason: "ok", actorId: ownerId, at: NOW }];
      const items = secondReviewEndItems({ ...base, task: { ...base.task, workflow: { candidate: { digest: code.digest }, acceptedFindings: accepted } }, operation: { ...base.operation, secondReviewPlan: operationPlan("on") }, result: { workflowReviews: [secondReport(operationId, "FINDINGS", [BLOCKING])] } });
      expect(opinionIn(items)).toMatchObject({ mode: "on", blocked: false, wouldHaveBlocked: false, blockingCount: 0 });
      // Not accepted: it blocks.
      expect(opinionOf({ operation: { ...base.operation, secondReviewPlan: operationPlan("on") } }, secondReport(operationId, "FINDINGS", [BLOCKING]))).toMatchObject({ blocked: true, blockingCount: 1 });
      // Accepted AFTER the review ended: the page and the description are rendered from the same filtered list, so it is gone from both.
      const blockedOpinion = opinionOf({ operation: { ...base.operation, secondReviewPlan: operationPlan("on") } }, secondReport(operationId, "FINDINGS", [BLOCKING]));
      const task = { ...stored(blockedOpinion), workflow: { acceptedFindings: accepted } };
      expect(secondReviewTaskView({ ...stored(blockedOpinion), workflow: {} }, code.digest, ENABLED)?.lines.join("\n")).toContain(BLOCKING.text);
      expect(secondReviewTaskView(task, code.digest, ENABLED)).toBeUndefined();
      expect(secondReviewPullRequestLines(stored(blockedOpinion), code.digest, [], ENABLED).join("\n")).toContain(BLOCKING.text);
      expect(secondReviewPullRequestLines(stored(blockedOpinion), code.digest, accepted, ENABLED)).toEqual([]);
    });
  });
});

describe("a second review is never given the spec to walk", () => {
  it("records no spec walk for a second-review operation, and still does for the first review's", async () => {
    const store = { load: () => Promise.resolve({ state: { specPullRequest: { commit: "s".repeat(40) } } }) } as never;
    const env = { tableName: "state", store, now: () => NOW };
    const walk = { specCommit: "s".repeat(40), requirements: [] };
    const result = { specReview: walk };
    expect(await specReviewRecordItems(env, taskId, { id: "op", kind: "task", workflowMode: "REVIEW", secondReview: true }, { status: "SUCCEEDED", result })).toEqual([]);
    // The guard is the only difference: the same call without the tag reaches the schema (a walk that does not parse is also none, so this checks the tag is not what stops it by accident).
    const first = await specReviewRecordItems(env, taskId, { id: "op", kind: "task", workflowMode: "REVIEW" }, { status: "SUCCEEDED", result });
    expect(Array.isArray(first)).toBe(true);
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
    expect(secondReviewPullRequestLines(stored(flagged), code.digest, [], OFF)).toEqual([]);
    expect(secondReviewPullRequestLines(stored(flagged), code.digest, [], ENABLED)).toHaveLength(1);
    expect(prBody(stored(flagged))).toBe(prBody({}));
  });

  it("an opinion about other code is not shown", () => {
    const flagged = secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer");
    expect(secondReviewPullRequestLines({ secondOpinion: { candidateDigest: "f".repeat(64), opinion: flagged, recordedAt: NOW } }, code.digest, [], ENABLED)).toEqual([]);
    expect(secondOpinionOfTask({ secondOpinion: { candidateDigest: code.digest, opinion: { junk: true }, recordedAt: NOW } }, code.digest)).toBeUndefined();
    expect(secondOpinionOfTask({}, undefined)).toBeUndefined();
  });

});

describe("the task page", () => {
  const answered = (mode: "shadow" | "on", findings: WorkflowReviewReport["findings"]) =>
    secondOpinionOf({ plan: mode === "on" ? { ...plan(), mode: "on" } : plan(), report: secondReport(randomUUID(), findings.length === 0 ? "PASS" : "FINDINGS", findings), currentCandidateDigest: code.digest, ranModel: NOVA });

  it("is empty while cr is off, whatever is stored", () => {
    expect(secondReviewTaskView(stored(secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer")), code.digest, OFF)).toBeUndefined();
  });

  it("shows a shadow opinion's findings as not blocking, with plain single lines", () => {
    const view = secondReviewTaskView(stored(answered("shadow", [{ text: "line one\nline two with a secret " + "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789", origin: "INTRODUCED" }])), code.digest, ENABLED)!;
    expect(view.lines[0]).toContain("Second opinion (not blocking)");
    expect(view.lines).toHaveLength(2);
    expect(view.lines[1]).not.toMatch(/\n|ghp_/u);
    expect(view).toMatchObject({ needsAcknowledgement: false, acknowledged: false });
  });

  it("a shadow review that did not run is silent; an on review that did not run says so and needs the owner's acknowledgement", () => {
    expect(secondReviewTaskView(stored(secondOpinionUnavailable({ mode: "shadow", company: "amazon" }, "no-answer")), code.digest, ENABLED)).toBeUndefined();
    const flagged = stored(secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-candidate"));
    expect(secondReviewTaskView(flagged, code.digest, ENABLED)).toEqual({ lines: ["Second review did not run: no allowed model from a different AI company could be used"], needsAcknowledgement: true, acknowledged: false });
  });

  it("an acknowledgement is for that candidate and reason only", () => {
    const opinion = secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer");
    const ack = secondReviewAcknowledgement(opinion, code.digest);
    if (!ack.required) throw new Error("expected an ask");
    expect(secondReviewTaskView({ ...stored(opinion), secondReviewAcknowledged: [ack.key] }, code.digest, ENABLED)).toMatchObject({ needsAcknowledgement: true, acknowledged: true });
    expect(secondReviewTaskView({ ...stored(opinion), secondReviewAcknowledged: ["0".repeat(64)] }, code.digest, ENABLED)).toMatchObject({ acknowledged: false });
  });
});
