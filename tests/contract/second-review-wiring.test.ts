// SH34 wiring, the two key rules first: (1) a second review's result NEVER reaches the workflow, so a second-review PASS cannot clear a first-review FINDINGS; (2) shadow findings never reach the pull request.
// Then: the opinion is stored beside the workflow and nothing else; the pull request carries only an `on` second review's block or "did not run" line; with `cr` off the description is byte for byte today's.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWorkflowSnapshot, WorkflowSnapshotSchema, type WorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { createCandidateManifest } from "@rovara-code/contracts";
import { WORKFLOW_SECOND_REVIEW_LINE_MAX, WorkflowSecondReviewBlockSchema, secondReviewBlockFinding, type ModelIdentifier, type SecondOpinion, type WorkflowReviewReport } from "@rovara-code/contracts";
import { workflowPullRequestBody } from "../../packages/broker/src/aws/developer-tasks.js";
import { planSecondReview, secondOpinionOf, secondOpinionUnavailable, secondReviewAcknowledgement } from "../../packages/broker/src/rovara-code/second-review.js";
import { secondOpinionOfTask, secondReviewPullRequestLines, secondReviewTaskView } from "../../packages/broker/src/rovara-code/second-review-store.js";

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
    switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [NOVA], verdicts: [], replayRuns: [],
  });
  if (!planned.run) throw new Error("expected a plan");
  return planned;
};
const secondReport = (operationId: string, status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = []): WorkflowReviewReport => ({
  operationId, candidateDigest: code.digest, role: "CRITIC", provider: "amazon-bedrock", version: "us.amazon.nova-premier-v1:0", status, findings, readOnly: true, recordedAt: NOW,
});


const prBody = (task: Record<string, unknown>, workflow = workflowWith({ stage: "PULL_REQUEST", state: "READY", reviews: [review("CRITIC"), review("SECURITY")] })) =>
  workflowPullRequestBody({ title: "Add a retry flag", ...task } as never, workflow, "# Plan\n\n1. Add the flag.\n", "https://rovara.example/task", { changedFiles: { files: [{ repository: "payments", path: "src/a.ts", added: 3, removed: 1 }], complete: true } });
const stored = (opinion: SecondOpinion) => ({ secondOpinion: { candidateDigest: code.digest, opinion, recordedAt: NOW } });
const onPlan = { ...plan(), mode: "on" as const };

describe("key rule 2: shadow findings never reach the pull request", () => {
  const withEnv = <T,>(run: () => T): T => { const before = process.env.SECOND_REVIEW_ENABLED; process.env.SECOND_REVIEW_ENABLED = "1"; try { return run(); } finally { if (before === undefined) delete process.env.SECOND_REVIEW_ENABLED; else process.env.SECOND_REVIEW_ENABLED = before; } };

  it("a shadow opinion with blocking findings adds nothing to the description, even with cr on", () => {
    const shadow = secondOpinionOf({ plan: plan(), report: secondReport(randomUUID(), "FINDINGS", [{ text: "SHADOW-SECRET-FINDING", origin: "INTRODUCED" }]), currentCandidateDigest: code.digest});
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
    const blocked = secondOpinionOf({ plan: { ...onPlan, against: [SONNET] }, report: secondReport(randomUUID(), "FINDINGS", [{ text: "ping @octocat see [x](https://evil.example) #12", origin: "INTRODUCED" }]), currentCandidateDigest: code.digest});
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
    secondOpinionOf({ plan: mode === "on" ? { ...plan(), mode: "on" } : plan(), report: secondReport(randomUUID(), findings.length === 0 ? "PASS" : "FINDINGS", findings), currentCandidateDigest: code.digest});

  it("is empty while cr is off, whatever is stored", () => {
    expect(secondReviewTaskView(stored(secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer")), code.digest, OFF)).toBeUndefined();
  });

  it("shows a shadow opinion's findings as not blocking, with plain single lines", () => {
    const view = secondReviewTaskView(stored(answered("shadow", [{ text: "line one\nline two with a secret " + "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789", origin: "INTRODUCED" }])), code.digest, ENABLED)!;
    expect(view.lines[0]).toContain("Second opinion (not blocking)");
    expect(view.lines).toHaveLength(3);
    expect(view.lines[1]).not.toMatch(/\n|ghp_/u);
    expect(view.lines[2]).toMatch(/^Using default: /u);
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

describe("a version 1 task shows the second review too (N5)", () => {
  const v1 = () => WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now: NOW }),
    stage: "PULL_REQUEST", state: "READY", candidate: code,
    checkPolicy: { required: [{ id: "unit", label: "Unit", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
    verification: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: [review("CRITIC"), review("SECURITY")],
  });
  const withEnv = <T,>(run: () => T): T => { const before = process.env.SECOND_REVIEW_ENABLED; process.env.SECOND_REVIEW_ENABLED = "1"; try { return run(); } finally { if (before === undefined) delete process.env.SECOND_REVIEW_ENABLED; else process.env.SECOND_REVIEW_ENABLED = before; } };

  it("the description says an `on` review did not run, and lists a blocking review's findings (inert); a shadow one adds nothing; cr off is today's", () => {
    expect(v1().definitionVersion).toBe("1.0.0");
    const flagged = stored(secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer"));
    const blocked = stored(secondOpinionOf({ plan: { ...onPlan, against: [SONNET] }, report: secondReport(randomUUID(), "FINDINGS", [{ text: "ping @octocat #12", origin: "INTRODUCED" }]), currentCandidateDigest: code.digest }));
    withEnv(() => {
      expect(prBody(flagged, v1())).toContain("Second review did not run: the reviewer gave no usable answer after retrying");
      const body = prBody(blocked, v1());
      expect(body).toContain("Second review (");
      expect(body).not.toMatch(/(?<!‍)@octocat/u);
      expect(prBody(stored(secondOpinionUnavailable({ mode: "shadow", company: "amazon" }, "no-answer")), v1())).toBe(prBody({}, v1()));
    });
    expect(prBody(flagged, v1())).toBe(prBody({}, v1()));
  });
});

describe("the block keeps within its own limits (N4)", () => {
  it("drops a line number over the cap and cuts a long path and text, so a model's odd finding can never make the workflow unreadable", () => {
    const odd = secondReviewBlockFinding({ text: "x".repeat(900), file: "p".repeat(900), line: WORKFLOW_SECOND_REVIEW_LINE_MAX + 1 });
    expect(odd).toEqual({ text: "x".repeat(600), file: "p".repeat(500) });
    expect(secondReviewBlockFinding({ text: "t", file: "a.ts", line: 7 })).toEqual({ text: "t", file: "a.ts", line: 7 });
    expect(secondReviewBlockFinding({ text: "t", line: WORKFLOW_SECOND_REVIEW_LINE_MAX })).toEqual({ text: "t", line: WORKFLOW_SECOND_REVIEW_LINE_MAX });
    expect(WorkflowSecondReviewBlockSchema.safeParse({ candidateDigest: code.digest, findings: [odd] }).success).toBe(true);
  });
});
