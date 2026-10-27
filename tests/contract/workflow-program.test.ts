// Plan 3 Task 17: a custom coding sequence runs on the workflow engine as a program; with no program the engine's own
// path is untouched.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_TEAM } from "../support/slack-broker.js";
import { slackLimitPk } from "../../packages/contracts/src/org-scoped-keys.js";
import { getTaskDocumentView } from "../../packages/broker/src/aws/developer-tasks.js";
import { EMPTY_RECIPE, codingProgram, type ResolvedRecipe, type ResolvedStep } from "../../packages/contracts/src/agent-recipe-node.js";
import {
  WorkflowProgramSchema, WorkflowSnapshotSchema, WorkflowTransitionError, advanceStage, blockWorkflow, completeWorkflowBuild, createCandidateManifest,
  createWorkflowSnapshot, decideWorkflow, nextProgramStep, recordWorkflowVerification, resolveWorkflowReviewFindings, returnWorkflowToImplementation,
  sendBackProblems, submitWorkflowArtifact, submitWorkflowReview, workflowFindingFingerprint, workflowReviewRoles, type WorkflowProgram, type WorkflowSnapshot,
} from "../../packages/contracts/src/task-workflow-node.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-05T12:00:00.000Z";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.md`, createdAt: now };

const NO_INSTRUCTIONS = { instructions: [] };
const build = (id: string, text?: string): ResolvedStep => ({ id, name: id, kind: "build", settings: { instructions: text === undefined ? [] : [{ agentName: "Custom", text }] } });
const check = (id = "check"): ResolvedStep => ({ id, name: id, kind: "check", settings: { ...NO_INSTRUCTIONS } });
const review = (id: string, reviewers: Array<"code" | "security">, onFindings?: { backTo: string; maxRounds: number }): ResolvedStep =>
  ({ id, name: id, kind: "review", reviewers, ...(onFindings === undefined ? {} : { onFindings }), settings: { ...NO_INSTRUCTIONS } });
const pullRequest = (): ResolvedStep => ({ id: "pull_request", name: "Pull request", kind: "pull_request", settings: { ...NO_INSTRUCTIONS } });
const recipeOf = (steps: ResolvedStep[]): ResolvedRecipe => ({ ...structuredClone(EMPTY_RECIPE), steps });

/** Task 4's own example: tests first, then the code, checks and a review, docs, and the same again before the pull request. */
const eightSteps = () => recipeOf([
  build("tests", "write the tests first"), build("code", "make the tests pass"), check(), review("review", ["code", "security"], { backTo: "code", maxRounds: 3 }),
  build("docs", "write the docs"), check("final_check"), review("final_review", ["code", "security"], { backTo: "docs", maxRounds: 3 }), pullRequest(),
]);
const programOf = (recipe: ResolvedRecipe): WorkflowProgram => WorkflowProgramSchema.parse(codingProgram(recipe));

const candidateOf = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
const checksFor = (digest: string, status: "PASS" | "FAILED" = "PASS") => ({ candidateDigest: digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status }] });
const report = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS", digest: string, findings: unknown[] = []) =>
  ({ operationId: OPERATION, candidateDigest: digest, role, provider: "scripted", version: "1", status, findings, readOnly: true, recordedAt: now });
const finding = { text: "The token is logged.", origin: "INTRODUCED" as const, file: "src/log.ts", line: 4 };

/** The workflow with its plan approved: coding is ready to start. */
function approved(program?: WorkflowProgram): WorkflowSnapshot {
  const created = createWorkflowSnapshot({ taskId, ownerId, now, ...(program === undefined ? {} : { program }) });
  const waiting = submitWorkflowArtifact(created, { expectedRevision: created.revision, artifact: plan, now });
  return decideWorkflow(waiting, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: waiting.revision, decision: "APPROVE", reason: "Go", artifactDigest: plan.sha256 },
    { actorId: ownerId, role: "TASK_OWNER" }, { now, allowedSkipStages: [] });
}

/** A coding run ends and the broker records its candidate with the checks it ran (the broker marks the workflow VERIFY first). */
function verified(workflow: WorkflowSnapshot, candidate: ReturnType<typeof candidateOf>, status: "PASS" | "FAILED" = "PASS"): WorkflowSnapshot {
  const verifying = { ...blockWorkflow(workflow, "candidate checks are being recorded", now), stage: "VERIFY" as const };
  return recordWorkflowVerification(verifying, { candidate, checks: checksFor(candidate.digest, status), now });
}
const reviewedBy = (workflow: WorkflowSnapshot, reports: unknown[]): WorkflowSnapshot => reports.reduce<WorkflowSnapshot>((current, next) => submitWorkflowReview(current, next, now), workflow);
const MODES = { IMPLEMENT: "IMPLEMENT", VERIFY: "CHECKS", REVIEW: "REVIEW", PULL_REQUEST: "PULL_REQUEST" } as const;

describe("WorkflowProgramSchema", () => {
  it("accepts what codingProgram builds for a custom sequence", () => {
    const program = programOf(eightSteps());
    expect(program.steps.map((step) => step.kind)).toEqual(["build", "build", "check", "review", "build", "check", "review", "pull_request"]);
    expect(program.steps[3]).toEqual({ id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "code", maxRounds: 3 } });
  });

  it("accepts a reordered Rovara Code recipe (a review straight after the build)", () => {
    const recipe = recipeOf([
      { id: "plan", name: "Plan", kind: "plan", settings: { ...NO_INSTRUCTIONS } }, build("build"), review("review", ["code", "security"], { backTo: "build", maxRounds: 3 }), check(), pullRequest()]);
    expect(WorkflowProgramSchema.safeParse(codingProgram(recipe)).success).toBe(true);
  });

  it("refuses programs the engine cannot follow", () => {
    const base = programOf(recipeOf([build("build"), check(), review("review", ["code", "security"], { backTo: "build", maxRounds: 2 })]));
    const bad = (steps: unknown[]) => WorkflowProgramSchema.safeParse({ steps }).success;
    expect(bad(base.steps)).toBe(true);
    expect(bad([])).toBe(false);
    expect(bad([{ id: "build", kind: "build" }, { id: "build", kind: "build" }])).toBe(false);
    expect(bad([{ id: "check", kind: "check" }])).toBe(false);
    expect(bad([{ id: "build", kind: "build" }, { id: "plan", kind: "plan" }])).toBe(false);
    expect(bad([{ id: "plan", kind: "plan" }, { id: "check", kind: "check" }, { id: "build", kind: "build" }])).toBe(false);
    expect(bad([{ id: "build", kind: "build" }, { id: "pr", kind: "pull_request" }, { id: "more", kind: "build" }])).toBe(false);
    expect(bad([{ id: "build", kind: "build" }, { id: "review", kind: "review" }])).toBe(false);
    expect(bad([{ id: "build", kind: "build", reviewers: ["code"] }])).toBe(false);
    expect(bad([{ id: "build", kind: "build" }, { id: "review", kind: "review", reviewers: ["code"], onFindings: { backTo: "later", maxRounds: 2 } }, { id: "later", kind: "build" }])).toBe(false);
    expect(bad([{ id: "build", kind: "build" }, { id: "review", kind: "review", reviewers: ["code"], onFindings: { backTo: "review", maxRounds: 2 } }])).toBe(false);
    expect(bad([{ id: "build", kind: "build", extra: true }])).toBe(false);
    // A pull request needs the checks and both reviews of the last build before it.
    expect(bad([{ id: "build", kind: "build" }, { id: "check", kind: "check" }, { id: "review", kind: "review", reviewers: ["security"] }, { id: "pr", kind: "pull_request" }])).toBe(false);
    expect(bad([{ id: "build", kind: "build" }, { id: "review", kind: "review", reviewers: ["code", "security"] }, { id: "pr", kind: "pull_request" }])).toBe(false);
  });
});

describe("advanceStage and nextProgramStep", () => {
  const program = programOf(eightSteps());

  it("returns the default stage, and nothing else, without a program", () => {
    expect(advanceStage({}, "IMPLEMENT")).toEqual({ stage: "IMPLEMENT" });
    expect(advanceStage({}, "PULL_REQUEST")).toEqual({ stage: "PULL_REQUEST" });
    expect(advanceStage({ programStepId: "code" }, "REVIEW")).toEqual({ stage: "REVIEW" });
  });

  it("moves to the next program step: build is IMPLEMENT, check VERIFY, review REVIEW, pull request PULL_REQUEST", () => {
    expect(advanceStage({ program }, "IMPLEMENT")).toEqual({ stage: "IMPLEMENT", programStepId: "tests" });
    expect(advanceStage({ program, programStepId: "tests" }, "REVIEW")).toEqual({ stage: "IMPLEMENT", programStepId: "code" });
    expect(advanceStage({ program, programStepId: "code" }, "REVIEW")).toEqual({ stage: "VERIFY", programStepId: "check" });
    expect(advanceStage({ program, programStepId: "check" }, "REVIEW")).toEqual({ stage: "REVIEW", programStepId: "review" });
    expect(advanceStage({ program, programStepId: "review" }, "PULL_REQUEST")).toEqual({ stage: "IMPLEMENT", programStepId: "docs" });
    expect(advanceStage({ program, programStepId: "final_review" }, "PULL_REQUEST")).toEqual({ stage: "PULL_REQUEST", programStepId: "pull_request" });
  });

  it("starts after the plan step when the program has one", () => {
    const withPlan = programOf(recipeOf([{ id: "plan", name: "Plan", kind: "plan", settings: { ...NO_INSTRUCTIONS } }, build("build"), check(), review("review", ["code", "security"]), pullRequest()]));
    expect(advanceStage({ program: withPlan, programStepId: "plan" }, "IMPLEMENT")).toEqual({ stage: "IMPLEMENT", programStepId: "build" });
    expect(advanceStage({ program: withPlan }, "IMPLEMENT")).toEqual({ stage: "IMPLEMENT", programStepId: "build" });
  });

  it("ends after the last step when there is no pull request step", () => {
    const short = programOf(recipeOf([build("build"), check(), review("review", ["code", "security"])]));
    expect(advanceStage({ program: short, programStepId: "review" }, "PULL_REQUEST")).toEqual({ stage: "CLOSED", complete: true });
  });

  it("sends findings back to backTo until maxRounds, then blocks with the review reason", () => {
    expect(nextProgramStep(program, "review", "done")).toEqual({ kind: "step", step: { id: "docs", kind: "build" } });
    expect(nextProgramStep(program, "review", "findings", 1)).toEqual({ kind: "step", step: { id: "code", kind: "build" } });
    expect(nextProgramStep(program, "review", "findings", 2)).toEqual({ kind: "step", step: { id: "code", kind: "build" } });
    expect(nextProgramStep(program, "review", "findings", 3)).toEqual({ kind: "blocked", reason: "the code and security reviews did not pass" });
    expect(nextProgramStep(program, "review", "findings", 3, ["SECURITY"])).toEqual({ kind: "blocked", reason: "the security review did not pass" });
    expect(nextProgramStep(program, "review", "findings", 3, ["CRITIC"])).toEqual({ kind: "blocked", reason: "the code review did not pass" });
    expect(nextProgramStep(program, "final_review", "findings", 1)).toEqual({ kind: "step", step: { id: "docs", kind: "build" } });
  });

  it("blocks findings from a review with no onFindings, and refuses findings from other steps or an unknown step", () => {
    const quiet = programOf(recipeOf([build("build"), check(), review("review", ["code", "security"])]));
    expect(nextProgramStep(quiet, "review", "findings", 1)).toEqual({ kind: "blocked", reason: "the code and security reviews did not pass" });
    expect(() => nextProgramStep(program, "tests", "findings", 1)).toThrow(WorkflowTransitionError);
    expect(() => nextProgramStep(program, "nowhere", "done")).toThrow(WorkflowTransitionError);
  });
});

describe("a workflow with no program", () => {
  it("keeps the engine's own path and stores nothing about a program", () => {
    const candidate = candidateOf("1");
    const approvedPlain = approved();
    expect(approvedPlain).toMatchObject({ stage: "IMPLEMENT", state: "READY" });
    const reviewing = verified(approvedPlain, candidate);
    expect(reviewing).toMatchObject({ stage: "REVIEW", state: "WAITING" });
    const done = reviewedBy(reviewing, [report("CRITIC", "PASS", candidate.digest), report("SECURITY", "PASS", candidate.digest)]);
    expect(done).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    for (const workflow of [approvedPlain, reviewing, done]) {
      expect(Object.keys(workflow).filter((key) => key.startsWith("program"))).toEqual([]);
      expect(workflowReviewRoles(workflow)).toEqual(["CRITIC", "SECURITY"]);
    }
    expect(() => completeWorkflowBuild(approvedPlain, now)).toThrow(WorkflowTransitionError);
  });
});

describe("the eight-step program", () => {
  const recipe = eightSteps();
  const program = programOf(recipe);

  it("goes IMPLEMENT, IMPLEMENT, CHECKS, REVIEW, IMPLEMENT, CHECKS, REVIEW, PULL_REQUEST, each build with its own instructions", () => {
    const dispatched: string[] = [];
    const instructions: string[] = [];
    const visit = (workflow: WorkflowSnapshot) => {
      dispatched.push(MODES[workflow.stage as keyof typeof MODES]);
      if (workflow.stage === "IMPLEMENT") {
        instructions.push(recipe.steps.find((step) => step.id === workflow.programStepId)!.settings.instructions.map((layer) => layer.text).join());
      }
    };
    const candidate = candidateOf("1");
    const second = candidateOf("2");
    const bothPass = (digest: string) => [report("CRITIC", "PASS", digest), report("SECURITY", "PASS", digest)];

    let workflow = approved(program);
    expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "tests", program });
    visit(workflow);
    workflow = completeWorkflowBuild(workflow, now);
    expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "code", revision: approved(program).revision + 1 });
    visit(workflow);
    // The last build before the checks: the broker marks the workflow VERIFY while it records the candidate and its checks.
    const checking = advanceStage(workflow, "REVIEW");
    visit({ ...workflow, stage: checking.stage });
    workflow = verified(workflow, candidate);
    expect(workflow).toMatchObject({ stage: "REVIEW", state: "WAITING", programStepId: "review", candidate: { digest: candidate.digest } });
    visit(workflow);
    workflow = reviewedBy(workflow, bothPass(candidate.digest));
    expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "docs" });
    visit(workflow);
    visit({ ...workflow, stage: advanceStage(workflow, "REVIEW").stage });
    workflow = verified(workflow, second);
    expect(workflow).toMatchObject({ stage: "REVIEW", state: "WAITING", programStepId: "final_review", reviews: [] });
    visit(workflow);
    workflow = reviewedBy(workflow, bothPass(second.digest));
    expect(workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY", programStepId: "pull_request", candidate: { digest: second.digest } });
    visit(workflow);

    expect(dispatched).toEqual(["IMPLEMENT", "IMPLEMENT", "CHECKS", "REVIEW", "IMPLEMENT", "CHECKS", "REVIEW", "PULL_REQUEST"]);
    expect(instructions).toEqual(["write the tests first", "make the tests pass", "write the docs"]);
  });

  it("keeps a failed check on the same step, and passes the same step on once the checks pass", () => {
    const candidate = candidateOf("1");
    const afterCode = completeWorkflowBuild(approved(program), now);
    const failed = verified(afterCode, candidate, "FAILED");
    expect(failed).toMatchObject({ stage: "VERIFY", state: "BLOCKED", programStepId: "check" });
    const sentBack = returnWorkflowToImplementation(failed, { requestId: "33333333-3333-4333-8333-333333333333", actorId: ownerId, reason: "Fix the failing test", now });
    expect(sentBack).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "code" });
    expect(verified(sentBack, candidateOf("2"))).toMatchObject({ stage: "REVIEW", programStepId: "review" });
  });

  it("only builds in the middle of a program need no check: a build followed by a build records no candidate", () => {
    const afterTests = completeWorkflowBuild(approved(program), now);
    expect(afterTests.candidate).toBeUndefined();
    expect(afterTests.verification).toBeUndefined();
    expect(() => completeWorkflowBuild(afterTests, now)).toThrow(/checks/);
    expect(() => completeWorkflowBuild({ ...afterTests, state: "BLOCKED", blockReason: "x" }, now)).toThrow(WorkflowTransitionError);
  });

  it("refuses a candidate changed after its last review at publish", () => {
    const candidate = candidateOf("1");
    const second = candidateOf("2");
    let workflow = completeWorkflowBuild(approved(program), now);
    workflow = verified(workflow, candidate);
    workflow = reviewedBy(workflow, [report("CRITIC", "PASS", candidate.digest), report("SECURITY", "PASS", candidate.digest)]);
    workflow = verified(workflow, second);
    workflow = reviewedBy(workflow, [report("CRITIC", "PASS", second.digest), report("SECURITY", "PASS", second.digest)]);
    expect(workflow.stage).toBe("PULL_REQUEST");
    expect(WorkflowSnapshotSchema.safeParse(workflow).success).toBe(true);
    // The code moved on after its reviews: the pull request stage no longer holds.
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, candidate: candidate }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, candidate: candidateOf("3") }).success).toBe(false);
    // A security review alone never makes the pull request ready.
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, reviews: workflow.reviews?.filter((entry) => entry.role === "SECURITY") }).success).toBe(false);
    // A new candidate clears every review, so the program cannot reach publication with stale ones.
    expect(verified({ ...workflow, stage: "IMPLEMENT", state: "READY", programStepId: "docs" }, candidateOf("4")).reviews).toEqual([]);
  });
});

describe("a security-only review", () => {
  const program = programOf(recipeOf([
    build("code"), check(), review("security_review", ["security"], { backTo: "code", maxRounds: 3 }), review("all", ["code", "security"], { backTo: "code", maxRounds: 3 }), pullRequest()]));

  it("asks only for the security review, and sends its findings back to backTo", () => {
    const candidate = candidateOf("1");
    const reviewing = verified(approved(program), candidate);
    expect(reviewing).toMatchObject({ stage: "REVIEW", state: "WAITING", programStepId: "security_review" });
    expect(workflowReviewRoles(reviewing)).toEqual(["SECURITY"]);
    expect(() => submitWorkflowReview(reviewing, report("CRITIC", "PASS", candidate.digest), now)).toThrow(/not one this step asked for/);
    const found = submitWorkflowReview(reviewing, report("SECURITY", "FINDINGS", candidate.digest, [finding]), now);
    expect(found).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "code", programRounds: { security_review: 1 } });
    expect(found.blockReason).toBeUndefined();
    expect(found.reviews).toHaveLength(1);
    // The coder is told what the review found, as a send-back tells it.
    expect(found.candidate?.digest).toBe(candidate.digest);
  });

  it("passes on to the next step when the only requested review passes", () => {
    const candidate = candidateOf("1");
    const passed = submitWorkflowReview(verified(approved(program), candidate), report("SECURITY", "PASS", candidate.digest), now);
    expect(passed).toMatchObject({ stage: "REVIEW", state: "WAITING", programStepId: "all", programRounds: { security_review: 1 } });
    expect(workflowReviewRoles(passed)).toEqual(["CRITIC", "SECURITY"]);
  });

  it("blocks the third round with today's review reason, and the owner can send it back or accept its findings", () => {
    let workflow = approved(program);
    for (const letter of ["1", "2"]) {
      const candidate = candidateOf(letter);
      workflow = submitWorkflowReview(verified(workflow, candidate), report("SECURITY", "FINDINGS", candidate.digest, [finding]), now);
      expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "code" });
    }
    const third = candidateOf("3");
    const blocked = submitWorkflowReview(verified(workflow, third), report("SECURITY", "FINDINGS", third.digest, [finding]), now);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "the security review did not pass", programStepId: "security_review", programRounds: { security_review: 3 } });

    const sentBack = returnWorkflowToImplementation(blocked, { requestId: "33333333-3333-4333-8333-333333333333", actorId: ownerId, reason: "Fix it", now });
    expect(sentBack).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "code" });

    const resolved = resolveWorkflowReviewFindings(blocked, {
      requestId: "44444444-4444-4444-8444-444444444444", expectedRevision: blocked.revision, candidateDigest: third.digest,
      resolutions: [{ findingId: workflowFindingFingerprint("SECURITY", finding), action: "ACCEPT", note: "Test token only." }],
    }, { actorId: ownerId }, { now });
    expect(resolved).toMatchObject({ stage: "REVIEW", state: "WAITING", programStepId: "all" });
  });

  it("does not spend a round, or go back to coding, when a review did not finish", () => {
    const candidate = candidateOf("1");
    const reviewing = verified(approved(program), candidate);
    const unknown = submitWorkflowReview(reviewing, { ...report("SECURITY", "PASS", candidate.digest), status: "FAILED", failureReason: "TIMEOUT" }, now);
    expect(unknown).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "the security review did not pass", programStepId: "security_review" });
    expect(unknown.programRounds).toBeUndefined();
  });

  it("waits for both reviewers before judging a two-reviewer step", () => {
    const both = programOf(recipeOf([build("code"), check(), review("review", ["code", "security"], { backTo: "code", maxRounds: 3 }), pullRequest()]));
    const candidate = candidateOf("1");
    const reviewing = verified(approved(both), candidate);
    const afterCode = submitWorkflowReview(reviewing, report("CRITIC", "FINDINGS", candidate.digest, [finding]), now);
    expect(afterCode).toMatchObject({ stage: "REVIEW", state: "BLOCKED", programStepId: "review", blockReason: "the code review did not pass" });
    const afterBoth = submitWorkflowReview(afterCode, report("SECURITY", "PASS", candidate.digest), now);
    expect(afterBoth).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "code", programRounds: { review: 1 } });
  });
});

describe("a build that follows a build", () => {
  const program = programOf(recipeOf([build("first"), build("second"), check(), review("review", ["code", "security"], { backTo: "first", maxRounds: 3 }), pullRequest()]));

  it("does not carry the earlier review's findings into its prompt as problems", () => {
    const candidate = candidateOf("1");
    const reviewing = verified(completeWorkflowBuild(approved(program), now), candidate);
    const sentBack = submitWorkflowReview(reviewing, report("CRITIC", "FINDINGS", candidate.digest, [finding]), now);
    const found = submitWorkflowReview(sentBack, report("SECURITY", "PASS", candidate.digest), now);
    expect(found).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "first" });
    // The first build is given the findings; once it is done, the second build is given only the plan.
    expect(sendBackProblems(found)).toHaveLength(1);
    const next = completeWorkflowBuild(found, now);
    expect(next).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "second" });
    expect(sendBackProblems(next)).toEqual([]);
  });
});

describe("the review round count", () => {
  it("stops at the most the record holds, so a step that keeps finding problems blocks instead of failing the record", () => {
    const program = programOf(recipeOf([build("code"), check(), review("review", ["code", "security"], { backTo: "code", maxRounds: 3 }), pullRequest()]));
    const candidate = candidateOf("1");
    const reviewing = { ...verified(approved(program), candidate), programRounds: { review: 100 } };
    const blocked = reviewedBy(reviewing, [report("CRITIC", "FINDINGS", candidate.digest, [finding]), report("SECURITY", "PASS", candidate.digest)]);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED", programRounds: { review: 100 } });
  });
});

describe("a program without a pull request step", () => {
  it("ends complete after its last step, keeping the candidate and its reviews", () => {
    const program = programOf(recipeOf([build("code"), check(), review("review", ["code", "security"])]));
    const candidate = candidateOf("1");
    const done = reviewedBy(verified(approved(program), candidate), [report("CRITIC", "PASS", candidate.digest), report("SECURITY", "PASS", candidate.digest)]);
    expect(done).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "PASSED", candidate: { digest: candidate.digest } });
    expect(done.reviews).toHaveLength(2);
    expect(done.blockReason).toBeUndefined();
    expect(WorkflowSnapshotSchema.safeParse(done).success).toBe(true);
  });

  it("ends complete after the checks when the checks are its last step", () => {
    const program = programOf(recipeOf([build("code"), check()]));
    const candidate = candidateOf("1");
    expect(verified(approved(program), candidate)).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "PASSED", candidate: { digest: candidate.digest } });
  });
});

describe("a program in the stored workflow", () => {
  const program = programOf(eightSteps());

  it("records the program and its position, and refuses a position outside it", () => {
    const workflow = approved(program);
    expect(WorkflowSnapshotSchema.safeParse(workflow).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, programStepId: "nowhere" }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, program: undefined }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, programRounds: { nowhere: 1 } }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, programRounds: { code: 1 } }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...workflow, programRounds: { review: 2 } }).success).toBe(true);
    expect(() => createWorkflowSnapshot({ taskId, ownerId, now, program: { steps: [] } })).toThrow(WorkflowTransitionError);
  });

  it("sends a change that is ready to publish back to the last build", () => {
    const candidate = candidateOf("1");
    let workflow = completeWorkflowBuild(approved(program), now);
    workflow = reviewedBy(verified(workflow, candidate), [report("CRITIC", "PASS", candidate.digest), report("SECURITY", "PASS", candidate.digest)]);
    const second = candidateOf("2");
    workflow = reviewedBy(verified(workflow, second), [report("CRITIC", "PASS", second.digest), report("SECURITY", "PASS", second.digest)]);
    expect(workflow.stage).toBe("PULL_REQUEST");
    expect(returnWorkflowToImplementation(workflow, { requestId: "33333333-3333-4333-8333-333333333333", actorId: ownerId, reason: "One more thing", now }))
      .toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "docs" });
  });
});

// The broker follows a program: each operation carries its step, reviews run only what the step asks for, and the next
// step starts with no one asking.
describe("the broker following a program", () => {
  type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
  const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
  const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
  const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const byMode = (harness: Harness, workspaceId: string, mode: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === mode).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const workflowOf = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as { workflow: WorkflowSnapshot }).workflow;
  const invocationOf = (harness: Harness, operationId: unknown) => (harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as unknown as { invocation: { payload: Record<string, unknown> } }).invocation;
  const sweep = (harness: Harness) => harness.handler({ source: "agentx.workflow-dispatch-recovery" });
  const passingChecks = { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" };
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const codingResult = { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks } };

  /** A task with a program whose plan was approved: its first coding step is dispatched. */
  async function startedWith(program: WorkflowProgram) {
    const harness = await createSingleAnswerPlanBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const record = harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
    const workspaceId = record.workspaceId;
    harness.db.set({ ...record, workflow: { ...record.workflow, program, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
    await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
    const plan = "# Plan\n\n1. Fix retry handling.\n";
    await finishPlanningWithMarkdown(harness, workspaceId, String(byMode(harness, workspaceId, "PLAN")[0]!.id), plan);
    const decided = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
    expect(decided.status).toBe(200);
    return { harness, taskId, workspaceId };
  }

  it("runs each coding step as its own operation, starts the next with no one asking, and sends review findings back to the step they name", async () => {
    const program = programOf(recipeOf([
      build("tests"), build("code"), check(), review("security_review", ["security"], { backTo: "code", maxRounds: 3 }), review("all", ["code", "security"]), pullRequest()]));
    const { harness, taskId, workspaceId } = await startedWith(program);

    const [first] = byMode(harness, workspaceId, "IMPLEMENT");
    expect(first).toMatchObject({ programStepId: "tests" });
    await harness.finish(workspaceId, String(first!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories } });
    // A build followed by a build records no candidate; the next build is queued and started.
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "IMPLEMENT", programStepId: "code" });
    expect(workflowOf(harness, taskId).candidate).toBeUndefined();
    if (byMode(harness, workspaceId, "IMPLEMENT").length === 1) await sweep(harness);
    const [, second] = byMode(harness, workspaceId, "IMPLEMENT");
    expect(second).toMatchObject({ programStepId: "code" });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(String(invocationOf(harness, second!.id).payload.prompt)).toContain("Fix retry handling.");

    // The last build before the checks records its candidate and checks and the security review starts alone.
    await harness.finish(workspaceId, String(second!.id), "SUCCEEDED", codingResult);
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "REVIEW", programStepId: "security_review", candidate: { digest: candidate.digest } });
    if (byMode(harness, workspaceId, "REVIEW").length === 0) await sweep(harness);
    const [securityReview] = byMode(harness, workspaceId, "REVIEW");
    expect(securityReview).toMatchObject({ programStepId: "security_review" });
    expect(invocationOf(harness, securityReview!.id).payload).toMatchObject({ workflowMode: "REVIEW", workflowReviewers: ["SECURITY"] });
    // The prompt, the audit line and the task page name the one review that runs, and do not promise a pull request after it.
    expect(String(invocationOf(harness, securityReview!.id).payload.prompt)).toContain("read-only security review");
    const owner = harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as { developerId: string };
    const pageNow = await getTaskDocumentView({ orgId: TEST_ORG, documentClient: harness.db, tableName: "state", actions: harness.actions, log: () => undefined,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() },
    { orgId: TEST_ORG, developerId: owner.developerId } as never, taskId);
    expect(pageNow).toMatchObject({ status: "The security review is running", nextStep: "The next step of the sequence starts when the review passes." });

    // Both reports for a step that asked for one is not a result the broker trusts.
    const report = (role: string, status: string, findings: unknown[], operationId: unknown) => ({ operationId, candidateDigest: candidate.digest, role, provider: "t", version: "1", status, findings, readOnly: true, recordedAt: new Date().toISOString() });
    // The security review finds a problem: back to the coding step it names, with the problem in its prompt.
    await harness.finish(workspaceId, String(securityReview!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories,
      workflowReviews: [report("SECURITY", "FINDINGS", [finding], securityReview!.id)] } });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "IMPLEMENT", programStepId: "code", programRounds: { security_review: 1 } });
    if (byMode(harness, workspaceId, "IMPLEMENT").length === 2) await sweep(harness);
    const [, , third] = byMode(harness, workspaceId, "IMPLEMENT");
    expect(third).toMatchObject({ programStepId: "code" });
    expect(String(invocationOf(harness, third!.id).payload.prompt)).toContain("The token is logged.");
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
  });

  it("refuses a review result that does not hold exactly the reviews the step asked for", async () => {
    const program = programOf(recipeOf([build("code"), check(), review("security_review", ["security"]), review("all", ["code", "security"]), pullRequest()]));
    const { harness, taskId, workspaceId } = await startedWith(program);
    await harness.finish(workspaceId, String(byMode(harness, workspaceId, "IMPLEMENT")[0]!.id), "SUCCEEDED", codingResult);
    if (byMode(harness, workspaceId, "REVIEW").length === 0) await sweep(harness);
    const [securityReview] = byMode(harness, workspaceId, "REVIEW");
    const both = ["CRITIC", "SECURITY"].map((role) => ({ operationId: securityReview!.id, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: new Date().toISOString() }));
    await harness.finish(workspaceId, String(securityReview!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: both } });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
  });

  it("ends complete after the last step, with no pull request, when the program has none", async () => {
    const program = programOf(recipeOf([build("code"), check(), review("review", ["code", "security"])]));
    const { harness, taskId, workspaceId } = await startedWith(program);
    await harness.finish(workspaceId, String(byMode(harness, workspaceId, "IMPLEMENT")[0]!.id), "SUCCEEDED", codingResult);
    if (byMode(harness, workspaceId, "REVIEW").length === 0) await sweep(harness);
    const [reviewing] = byMode(harness, workspaceId, "REVIEW");
    expect(invocationOf(harness, reviewing!.id).payload.workflowReviewers).toBeUndefined();
    const reports = ["CRITIC", "SECURITY"].map((role) => ({ operationId: reviewing!.id, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: new Date().toISOString() }));
    await harness.finish(workspaceId, String(reviewing!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: reports } });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "PASSED", candidate: { digest: candidate.digest } });
    expect(harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH")).toEqual([]);
    expect(operations(harness, workspaceId).filter((item) => item.kind === "publish")).toEqual([]);
    // Finished with its changes unpublished: the workspace and the owner's task slot are kept until the owner closes the task.
    expect((harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as { releasedAt?: string }).releasedAt).toBeUndefined();
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  describe("the owner accepts every finding of a review step in the middle of a program", () => {
    const FOUND = { text: "The token is logged.", origin: "INTRODUCED", severity: "HIGH", file: "src/log.ts", line: 4 };
    const reportOf = (operationId: unknown, role: "CRITIC" | "SECURITY", findings: unknown[]) =>
      ({ operationId, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: findings.length > 0 ? "FINDINGS" : "PASS", findings, readOnly: true, recordedAt: new Date().toISOString() });
    const recordOf = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as { releasedAt?: string; closedAt?: string; workspaceId: string };
    const dispatchRows = (harness: Harness) => harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH");

    /** The program's first review step blocks on a finding (it allows one round), and the owner accepts it: the answer the broker is tested on. */
    async function acceptedAtFirstReview(program: WorkflowProgram, reviewers: Array<"CRITIC" | "SECURITY">) {
      const started = await startedWith(program);
      const { harness, taskId, workspaceId } = started;
      await harness.finish(workspaceId, String(byMode(harness, workspaceId, "IMPLEMENT")[0]!.id), "SUCCEEDED", codingResult);
      if (byMode(harness, workspaceId, "REVIEW").length === 0) await sweep(harness);
      const [reviewing] = byMode(harness, workspaceId, "REVIEW");
      const reports = reviewers.map((role, index) => reportOf(reviewing!.id, role, index === 0 ? [FOUND] : []));
      await harness.finish(workspaceId, String(reviewing!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: reports } });
      const blocked = workflowOf(harness, taskId);
      expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
      const response = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/review-findings`, {
        requestId: randomUUID(), expectedRevision: blocked.revision, candidateDigest: candidate.digest,
        resolutions: [{ findingId: workflowFindingFingerprint(reviewers[0]!, FOUND), action: "ACCEPT", note: "Test token only." }],
      });
      expect(response.status).toBe(200);
      return { ...started, blocked };
    }

    it("runs the next build with that step's own instructions, never an empty fix prompt", async () => {
      const program = programOf(recipeOf([
        build("code"), check(), review("first", ["code", "security"], { backTo: "code", maxRounds: 1 }),
        build("docs", "write the docs"), check("final_check"), review("final", ["code", "security"], { backTo: "docs", maxRounds: 3 }), pullRequest()]));
      const { harness, taskId, workspaceId, blocked } = await acceptedAtFirstReview(program, ["CRITIC", "SECURITY"]);
      if (byMode(harness, workspaceId, "IMPLEMENT").length === 1) await sweep(harness);
      const implementations = byMode(harness, workspaceId, "IMPLEMENT");
      expect(implementations).toHaveLength(2);
      expect(implementations[1]).toMatchObject({ programStepId: "docs" });
      const prompt = String(invocationOf(harness, implementations[1]!.id).payload.prompt);
      expect(prompt).toContain("Fix retry handling.");
      expect(prompt).not.toContain("Address only the problems");
      expect(prompt).not.toContain("Address the problems");
      expect(workflowOf(harness, taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", programStepId: "docs" });
      expect(workflowOf(harness, taskId).revision).toBeGreaterThan(blocked.revision);
      expect(dispatchRows(harness)).toEqual([]);
      const turns = harness.db.find((item) => typeof item.request === "string" && /Fix 0 review/.test(item.request));
      expect(turns).toEqual([]);
    });

    it("runs the next review step instead of stalling in REVIEW/WAITING", async () => {
      const program = programOf(recipeOf([
        build("code"), check(), review("first", ["security"], { backTo: "code", maxRounds: 1 }),
        review("final", ["code", "security"], { backTo: "code", maxRounds: 3 }), pullRequest()]));
      const { harness, taskId, workspaceId } = await acceptedAtFirstReview(program, ["SECURITY"]);
      if (byMode(harness, workspaceId, "REVIEW").length === 1) await sweep(harness);
      const reviews = byMode(harness, workspaceId, "REVIEW");
      expect(reviews).toHaveLength(2);
      expect(reviews[1]).toMatchObject({ programStepId: "final" });
      expect(workflowOf(harness, taskId)).toMatchObject({ stage: "REVIEW", state: "RUNNING", programStepId: "final" });
      expect(dispatchRows(harness)).toEqual([]);
    });

    it("keeps the next step due for a sweep when its start fails", async () => {
      const program = programOf(recipeOf([
        build("code"), check(), review("first", ["security"], { backTo: "code", maxRounds: 1 }),
        review("final", ["code", "security"], { backTo: "code", maxRounds: 3 }), pullRequest()]));
      const started = await startedWith(program);
      const { harness, taskId, workspaceId } = started;
      await harness.finish(workspaceId, String(byMode(harness, workspaceId, "IMPLEMENT")[0]!.id), "SUCCEEDED", codingResult);
      if (byMode(harness, workspaceId, "REVIEW").length === 0) await sweep(harness);
      const [reviewing] = byMode(harness, workspaceId, "REVIEW");
      await harness.finish(workspaceId, String(reviewing!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: [reportOf(reviewing!.id, "SECURITY", [FOUND])] } });
      harness.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"programStepId":"final"') && JSON.stringify(input).includes('"status":"ACCEPTED"'), error: { name: "TransactionCanceledException" }, times: 1 });
      const blocked = workflowOf(harness, taskId);
      const response = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/review-findings`, {
        requestId: randomUUID(), expectedRevision: blocked.revision, candidateDigest: candidate.digest,
        resolutions: [{ findingId: workflowFindingFingerprint("SECURITY", FOUND), action: "ACCEPT", note: "Test token only." }],
      });
      expect(response.status).toBe(200);
      expect(workflowOf(harness, taskId)).toMatchObject({ stage: "REVIEW", state: "WAITING", programStepId: "final" });
      expect(byMode(harness, workspaceId, "REVIEW")).toHaveLength(1);
      const [row] = dispatchRows(harness);
      expect(row).toMatchObject({ kind: "REVIEW", taskId });
      const past = new Date(Date.now() - 1_000).toISOString();
      harness.db.set({ ...row!, nextAttemptAt: past, dispatchDueSk: `${past}#${String(row!.sk)}` });
      await sweep(harness);
      expect(byMode(harness, workspaceId, "REVIEW")).toHaveLength(2);
    });

    it("finishes a program with no pull request step, keeping the candidate and the workspace", async () => {
      const program = programOf(recipeOf([build("code"), check(), review("review", ["code", "security"], { backTo: "code", maxRounds: 1 })]));
      const { harness, taskId, workspaceId } = await acceptedAtFirstReview(program, ["CRITIC", "SECURITY"]);
      expect(workflowOf(harness, taskId)).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "PASSED", candidate: { digest: candidate.digest } });
      expect(dispatchRows(harness)).toEqual([]);
      expect(operations(harness, workspaceId).filter((item) => item.kind === "publish")).toEqual([]);
      // The changes stay in the workspace for the idle reaper: it is not released, and no one is told the plan was rejected.
      expect(recordOf(harness, taskId).releasedAt).toBeUndefined();
      expect(harness.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
      // The task page and the finished card say it finished, never that the plan was rejected.
      const record = harness.db.get(`DEVTASK#${taskId}`, "META") as unknown as { developerId: string };
      const page = await getTaskDocumentView({ orgId: TEST_ORG, documentClient: harness.db, tableName: "state", actions: harness.actions, log: () => undefined,
        checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() },
      { orgId: TEST_ORG, developerId: record.developerId } as never, taskId);
      expect(page).toMatchObject({ status: "Finished every step", nextStep: "The changes are kept in this task's workspace until you close the task." });
    });
  });

  describe("closing a task whose program finished with no pull request", () => {
    /** A task whose program has no pull request step and whose last review passed: finished, CLOSED / COMPLETE / PASSED. */
    async function finishedWithoutPullRequest() {
      const program = programOf(recipeOf([build("code"), check(), review("review", ["code", "security"])]));
      const started = await startedWith(program);
      const { harness, taskId, workspaceId } = started;
      await harness.finish(workspaceId, String(byMode(harness, workspaceId, "IMPLEMENT")[0]!.id), "SUCCEEDED", codingResult);
      if (byMode(harness, workspaceId, "REVIEW").length === 0) await sweep(harness);
      const [reviewing] = byMode(harness, workspaceId, "REVIEW");
      const reports = ["CRITIC", "SECURITY"].map((role) => ({ operationId: reviewing!.id, candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: new Date().toISOString() }));
      await harness.finish(workspaceId, String(reviewing!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: reports } });
      expect(workflowOf(harness, taskId)).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "PASSED" });
      const active = () => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as unknown as { activeOperationId: string }).activeOperationId);
      const member = () => harness.db.get(slackLimitPk(TEST_ORG, SLACK_TEAM), `MEMBER#${MAYA.slackUserId}`);
      const close = (discard = false) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID(), ...(discard ? { discard_unpublished: true } : {}) });
      return { ...started, active, member, close };
    }

    it("lets the owner close it: the workspace is released and the task slot freed", async () => {
      const { harness, taskId, workspaceId, active, member, close } = await finishedWithoutPullRequest();
      // Finished, not released: the slot and the workspace are still held.
      expect(member()).toMatchObject({ count: 1 });
      expect((await close()).body).toMatchObject({ closed: false, task: { closing: true } });
      await harness.finish(workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
      expect(harness.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
      expect(harness.db.get(`DEVTASK#${taskId}`, "META")).toHaveProperty("closedAt");
      expect(member()).toMatchObject({ count: 0 });
      expect(harness.deleteEc2Session).toHaveBeenCalledWith(workspaceId);
    });

    it("closes it when the owner agrees to discard the unpublished changes, and not before", async () => {
      const { harness, taskId, workspaceId, active, member, close } = await finishedWithoutPullRequest();
      const unpublished = { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } };
      await close();
      await harness.finish(workspaceId, active(), "SUCCEEDED", unpublished);
      expect(harness.db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("closedAt");
      expect(member()).toMatchObject({ count: 1 });
      await close(true);
      await harness.finish(workspaceId, active(), "SUCCEEDED", unpublished);
      expect(harness.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
      expect(harness.db.get(`DEVTASK#${taskId}`, "META")).toHaveProperty("closedAt");
      expect(member()).toMatchObject({ count: 0 });
    });
  });

  it("keeps the next coding step due when its start fails, and a later sweep starts it once", async () => {
    const program = programOf(recipeOf([build("tests"), build("code"), check(), review("review", ["code", "security"], { backTo: "code", maxRounds: 3 }), pullRequest()]));
    const { harness, taskId, workspaceId } = await startedWith(program);
    harness.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"programStepId":"code"') && JSON.stringify(input).includes('"status":"ACCEPTED"'), error: { name: "TransactionCanceledException" }, times: 1 });
    await harness.finish(workspaceId, String(byMode(harness, workspaceId, "IMPLEMENT")[0]!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories } });
    expect(workflowOf(harness, taskId)).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "code" });
    expect(byMode(harness, workspaceId, "IMPLEMENT")).toHaveLength(1);
    const [row] = harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
    expect(row).toMatchObject({ kind: "IMPLEMENT", taskId });
    const past = new Date(Date.now() - 1_000).toISOString();
    harness.db.set({ ...row!, nextAttemptAt: past, dispatchDueSk: `${past}#${String(row!.sk)}` });
    await sweep(harness);
    expect(byMode(harness, workspaceId, "IMPLEMENT")).toHaveLength(2);
    expect(byMode(harness, workspaceId, "IMPLEMENT")[1]).toMatchObject({ programStepId: "code" });
    await sweep(harness);
    expect(byMode(harness, workspaceId, "IMPLEMENT")).toHaveLength(2);
  });
});
