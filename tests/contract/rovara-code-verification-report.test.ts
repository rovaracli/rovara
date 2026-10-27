// Plan 6 Task 12: what a version 2 task shows after its checks and reviews: what passed, what failed, what could not be checked, which tests were added, and
// which review round is being fixed. The report is built from the worker's recorded results (untrusted output): bounded, schema-validated and redacted, and it is
// plain text for every reader, never HTML. Version 1 tasks show neither field, and a client that does not ask for the version 2 view never receives them.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VerificationReportSchema, redactText } from "../../packages/contracts/src/index.js";
import { DeveloperTaskViewSchema } from "../../packages/contracts/src/developer-tasks.js";
import { codingProgram } from "../../packages/contracts/src/agent-recipe-node.js";
import { builtinRecipe } from "../../packages/contracts/src/agent-templates.js";
import { WorkflowSnapshotSchema, blockWorkflow, createCandidateManifest, createWorkflowSnapshot, decideWorkflow, recordWorkflowVerification, returnWorkflowToImplementation, submitWorkflowArtifact, submitPlanCritique, submitWorkflowReview, type WorkflowProgram, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import {
  IMPLEMENT_TEST_RULE, TEST_PATH_PATTERNS, isTestPath, verificationReport, withTestRule, workflowReviewRound,
} from "../../packages/broker/src/rovara-code/verification-report.js";
import { taskResponseForClient, taskViewForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";

import type { createDeveloperTaskBroker} from "../support/developer-task-broker.js";
import { MAYA, bearerFor, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { resumeAfterRunLimitApproval, startTaskWorkflowImplementationFromSystem } from "../../packages/broker/src/aws/developer-tasks.js";

import { loadSlackBroker } from "../support/slack-broker.js";
import { runLimitBlockText } from "../../packages/contracts/src/spend.js";
import { taskGraphDigest } from "../../packages/contracts/src/workflow-dependencies-node.js";
import { DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import { agentGuardrailsKey, builtinSettingsKey, orgProjectCatalogKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { planAnswer, planDocument, turnPlanIntoMarkdown } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { createHash } from "node:crypto";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-25T12:00:00.000Z";
const digest = (letter: string) => letter.repeat(64);
const check = (id: string, label: string) => ({ id, label, command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } });
const candidate = (letter: string) => createCandidateManifest([{ repositoryId: "payments", commitSha: letter.repeat(40), treeSha: letter.repeat(40), baseCommitSha: "e".repeat(40) }]);
/** The digest the candidate manifest computes for itself. */
const codeDigest = (letter: string) => candidate(letter).digest;
const v2Program = (): WorkflowProgram => codingProgram(builtinRecipe("rovara-code", 2)) as WorkflowProgram;

/** A version 2 plan names what changes, which files and how it is tested (Task 7). */
const TESTED_PLAN = planDocument({
  claims: [
    { id: "1", text: "Payments that fail with a timeout are retried.", evidence: [{ kind: "code", path: "payments/src/charge.ts", startLine: 10, endLine: 24, note: "Today a timeout throws." }] },
    { id: "2", text: "A test proves a timed-out payment is retried once and never charged twice." },
  ],
});
/** A version 2 task's planning step, finished with a plan that has its parts and then put back to the Markdown a task started before structured plans holds; returns that Markdown's digest. */
async function finishPlanningWithMarkdown(harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, workspaceId: string, operationId: string, markdown: string): Promise<string> {
  await harness.artifact(workspaceId, operationId, "plan.md", planAnswer(TESTED_PLAN));
  await harness.finish(workspaceId, operationId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  return turnPlanIntoMarkdown(harness, workspaceId, operationId, markdown).sha256;
}

/** The plan check of a version 2 task (Task 8), finished with an ok verdict so that the plan reaches its owner. */
async function finishPlanCheck(harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, workspaceId: string): Promise<void> {
  const check = harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "PLAN_CRITIQUE").at(-1);
  expect(check, "the plan check was started").toBeDefined();
  await harness.artifact(workspaceId, String(check!.id), "plan-critique.md", `I read the plan.\n\n\`\`\`rovara-plan-critique\n{"verdict":"ok","points":[]}\n\`\`\`\n`);
  await harness.finish(workspaceId, String(check!.id), "SUCCEEDED", { result: { workflowMode: "PLAN_CRITIQUE" } });
}

/** A version 2 workflow in the checks stage with the given policy, verification and extra fields; parsed by the real schema so a fixture can't drift from it. */
function workflowWith(extra: Record<string, unknown>, definitionVersion: "1.0.0" | "1.1.0" = "1.1.0"): WorkflowSnapshot {
  const created = createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion });
  return WorkflowSnapshotSchema.parse({ ...created, ...extra });
}
const verification = (results: unknown[], extra: Record<string, unknown> = {}, candidateDigest = codeDigest("1")) => ({
  candidateDigest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results, ...extra,
});
const policy = (overrides: Record<string, unknown> = {}) => ({
  required: [check("unit", "Unit tests"), check("lint", "Lint")], optional: [], selectedOptionalIds: [], proposed: [check("proposed-1", "Retry test")], ...overrides,
});
const e2e = (extra: Record<string, unknown> = {}) => ({
  contractDigest: digest("a"), policyDigest: digest("b"), bundleDigest: digest("c"), executionPlanDigest: digest("d"), required: true, currentGroupRunIds: [], resultRefs: [], ...extra,
});

describe("verificationReport", () => {
  it("lists passed, failed, notChecked and testsAdded exactly for a fixture", () => {
    const workflow = workflowWith({
      stage: "REVIEW", state: "WAITING", candidate: candidate("1"),
      checkPolicy: policy({ required: [check("unit", "Unit tests"), check("lint", "Lint"), check("types", "Types"), check("build", "Build"), check("e2e-smoke", "Smoke")], proposed: [check("proposed-1", "Retry test")] }),
      verification: verification([
        { checkId: "unit", status: "PASS" },
        { checkId: "lint", status: "FAILED" },
        { checkId: "types", status: "FAILED", programNotFound: true },
        { checkId: "build", status: "FAILED", broken: true },
        { checkId: "e2e-smoke", status: "UNKNOWN" },
        { checkId: "proposed-1", status: "PASS" },
      ]),
    });
    const changed = [
      { repository: "payments", path: "src/retry.ts", added: 10, removed: 2 },
      { repository: "payments", path: "src/retry.test.ts", added: 30, removed: 0 },
      { repository: "payments", path: "tests/a.py", added: 5, removed: 0 },
      { repository: "payments", path: "src/testing.ts", added: 4, removed: 0 },
    ];
    const report = verificationReport(workflow, changed, {});
    expect(report).toEqual({
      reviewOnly: false,
      passed: [{ label: "Unit tests" }, { label: "Retry test" }],
      failed: [{ label: "Lint", summary: "It failed on the latest code." }],
      notChecked: [
        { label: "Types", reason: "Its program isn't installed on Rovara's machine, so it did not run." },
        { label: "Build", reason: "Its command couldn't run, so it did not check the code." },
        { label: "Smoke", reason: "Rovara couldn't tell whether it passed." },
      ],
      testsAdded: [{ repository: "payments", path: "src/retry.test.ts" }, { repository: "payments", path: "tests/a.py" }],
    });
    expect(VerificationReportSchema.safeParse(report).success).toBe(true);
  });

  it("says a selected check with no result, and one whose process never started, was not checked", () => {
    const workflow = workflowWith({
      stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ proposed: [] }),
      verification: verification([{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "FAILED", neverStarted: true }]),
    });
    expect(verificationReport(workflow, [], {})).toMatchObject({
      passed: [{ label: "Unit tests" }], failed: [], notChecked: [{ label: "Lint", reason: "It never started." }],
    });
    const missing = workflowWith({ stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ proposed: [] }), verification: verification([{ checkId: "unit", status: "PASS" }]) });
    expect(verificationReport(missing, [], {}).notChecked).toEqual([{ label: "Lint", reason: "No result was recorded for it." }]);
  });

  it("a review-only change is not checked, with the plan's reason (redacted)", () => {
    const reasoned = workflowWith({
      stage: "REVIEW", state: "WAITING", candidate: candidate("1"),
      checkPolicy: policy({ required: [], proposed: [], noneReason: "Documentation only; token ghp_abcdefghijklmnopqrstuvwxyz0123456789 in the notes" }),
      verification: verification([], { reviewOnly: true }),
    });
    const report = verificationReport(reasoned, [], {});
    expect(report.reviewOnly).toBe(true);
    expect(report.passed).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.notChecked).toHaveLength(1);
    expect(report.notChecked[0]!.label).toBe("Automated checks");
    expect(report.notChecked[0]!.reason).toContain("Documentation only");
    expect(report.notChecked[0]!.reason).not.toContain("ghp_");
    const bare = workflowWith({ stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ required: [], proposed: [] }), verification: verification([], { reviewOnly: true }) });
    expect(verificationReport(bare, [], {}).notChecked).toEqual([{ label: "Automated checks", reason: "No automated check applied to this change." }]);
  });

  it("browser and API checks: passed when qualified for this code, failed when they failed, not checked when they were not admitted", () => {
    // A required browser and API round is qualified before review, so the not-admitted and failed cases are checks-stage snapshots.
    const base = { stage: "VERIFY", state: "BLOCKED", blockReason: "candidate checks failed or have unknown results", candidate: candidate("1"), checkPolicy: policy({ required: [check("unit", "Unit tests")], proposed: [] }), verification: verification([{ checkId: "unit", status: "PASS" }]) };
    const roundId = "11111111-1111-4111-8111-111111111111";
    const qualified = { candidateDigest: codeDigest("1"), contractDigest: digest("a"), policyDigest: digest("b"), bundleDigest: digest("c"), executionPlanDigest: digest("d"), roundId, groupRunIds: [roundId], admissionSha256: digest("e"), evidenceSha256: digest("f") };
    const reviewing = { ...base, stage: "REVIEW", state: "WAITING" };
    delete (reviewing as { blockReason?: string }).blockReason;
    expect(verificationReport(workflowWith({ ...reviewing, e2e: e2e({ qualifiedRound: qualified, currentRoundId: roundId, currentGroupRunIds: [roundId] }) }), [], {}).passed)
      .toEqual([{ label: "Unit tests" }, { label: "Browser and API checks" }]);
    const failedRound = { status: "FAILED", candidateDigest: codeDigest("1"), roundId, groupRunIds: [roundId], admissionSha256: digest("e"), evidenceSha256: digest("f") };
    expect(verificationReport(workflowWith({ ...base, e2e: e2e({ failedRound }) }), [], {}).failed).toEqual([{ label: "Browser and API checks", summary: "They failed on the latest code." }]);
    expect(verificationReport(workflowWith({ ...base, e2e: e2e() }), [], {}).notChecked).toEqual([{ label: "Browser and API checks", reason: "They were not admitted to run on the latest code." }]);
    expect(verificationReport(workflowWith({ ...base, e2e: e2e({ currentRoundId: roundId, currentGroupRunIds: [roundId] }) }), [], {}).notChecked)
      .toEqual([{ label: "Browser and API checks", reason: "They have not finished on the latest code." }]);
    // A failed round for older code does not count for this code.
    expect(verificationReport(workflowWith({ ...base, e2e: e2e({ failedRound: { ...failedRound, candidateDigest: codeDigest("2") } }) }), [], {}).notChecked)
      .toEqual([{ label: "Browser and API checks", reason: "They were not admitted to run on the latest code." }]);
    // A task that doesn't require them says nothing about them.
    expect(verificationReport(workflowWith({ ...base, e2e: e2e({ required: false }) }), [], {}).notChecked).toEqual([]);
  });

  it("results recorded for other code are not this code's results", () => {
    const workflow = workflowWith({
      stage: "REVIEW", state: "WAITING", candidate: candidate("2"), checkPolicy: policy({ proposed: [] }), verification: verification([{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }], {}, codeDigest("1")),
    });
    const report = verificationReport(workflow, [], {});
    expect(report.passed).toEqual([]);
    expect(report.notChecked.map((entry) => entry.label)).toEqual(["Unit tests", "Lint"]);
  });

  it("carries the CI basis the pull request was judged on, when the project says it", () => {
    const workflow = workflowWith({ stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ proposed: [] }), verification: verification([{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }]) });
    expect(verificationReport(workflow, [], {})).not.toHaveProperty("ciBasis");
    expect(verificationReport(workflow, [], { ciBasis: "all_checks" }).ciBasis).toBe("all_checks");
  });

  it("treats model-written labels and worker paths as untrusted: redacted, one line, bounded, plain text", () => {
    const label = `Retry\n\u202etest ghp_abcdefghijklmnopqrstuvwxyz0123456789 <script>alert(1)</script> ${"x".repeat(500)}`;
    const workflow = workflowWith({
      stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ required: [], proposed: [check("proposed-1", label.slice(0, 80))] }),
      verification: verification([{ checkId: "proposed-1", status: "PASS" }]),
    });
    const changed = [
      { repository: "pay\nments", path: `tests/${"deep/".repeat(200)}x.test.ts`, added: 1, removed: 0 },
      { repository: "payments", path: "tests/\u0007bell ghp_abcdefghijklmnopqrstuvwxyz0123456789.test.ts", added: 1, removed: 0 },
    ];
    const report = verificationReport(workflow, changed, {});
    expect(VerificationReportSchema.safeParse(report).success).toBe(true);
    const text = JSON.stringify(report);
    expect(text).not.toContain("ghp_");
    expect(text).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(text).not.toContain("\\n");
    for (const entry of report.testsAdded) expect([...entry.path].length).toBeLessThanOrEqual(500);
    // Nothing renders it as markup: it stays the plain string the model wrote, for each reader to escape.
    expect(typeof report.passed[0]!.label).toBe("string");
    expect(redactText("ok")).toBe("ok");
  });

  it("redacts a secret split by a zero-width character (Review M5)", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const split = `${secret.slice(0, 12)}\u200b${secret.slice(12)}`;
    const workflow = workflowWith({
      stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ required: [check("unit", `Run ${split}`)], proposed: [] }),
      verification: verification([{ checkId: "unit", status: "PASS" }]),
    });
    const text = JSON.stringify(verificationReport(workflow, [{ repository: "payments", path: `tests/${split}.test.ts`, added: 1 }], {}));
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("qrstuvwxyz0123");
  });

  it("bounds every list and never fails on a flood of changed files", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ repository: "payments", path: `tests/t${index}.test.ts`, added: 1, removed: 0 }));
    const workflow = workflowWith({ stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ proposed: [] }), verification: verification([{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }]) });
    const report = verificationReport(workflow, many, {});
    expect(report.testsAdded).toHaveLength(50);
    expect(report.testsAdded[0]).toEqual({ repository: "payments", path: "tests/t0.test.ts" });
    // The same file twice is listed once.
    const twice = verificationReport(workflow, [many[0]!, many[0]!], {});
    expect(twice.testsAdded).toHaveLength(1);
  });
});

describe("which changed files are tests", () => {
  it("matches the plan's four patterns, and only whole path segments", () => {
    expect(TEST_PATH_PATTERNS).toHaveLength(4);
    for (const path of ["tests/a.py", "test/unit/a.js", "spec/a.rb", "src/__tests__/a.ts", "src/retry.test.ts", "src/retry.spec.tsx", "a/b.test.mjs", "pkg/x_test.go", "pkg/x_test.py", "pkg/test_x.py", "test_y.py"]) {
      expect(isTestPath(path), path).toBe(true);
    }
    for (const path of ["src/testing.ts", "src/contest/a.ts", "src/latest/a.ts", "src/attest.ts", "docs/inspect.md", "src/a_test.ts", "src/mytest_x.py", "src/retry.test.json", "docs/api.spec.md"]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it("does not count a deleted or only-trimmed test file as an added test", () => {
    const workflow = workflowWith({ stage: "REVIEW", state: "WAITING", candidate: candidate("1"), checkPolicy: policy({ proposed: [] }), verification: verification([{ checkId: "unit", status: "PASS" }, { checkId: "lint", status: "PASS" }]) });
    const report = verificationReport(workflow, [
      { repository: "payments", path: "tests/old.test.ts", added: 0, removed: 40 },
      { repository: "payments", path: "tests/new.test.ts", added: 12, removed: 0 },
      { repository: "payments", path: "tests/unknown.test.ts" },
    ], {});
    expect(report.testsAdded).toEqual([{ repository: "payments", path: "tests/new.test.ts" }, { repository: "payments", path: "tests/unknown.test.ts" }]);
  });
});

describe("the test rule of a version 2 build", () => {
  it("is exact, and ends a version 2 prompt, which a version 1 prompt never gets", () => {
    expect(IMPLEMENT_TEST_RULE).toBe("Add or update tests for every behaviour you change. If a change can't be tested, say why in your final message.");
    const prompt = "Implement the human-approved plan below.\n\nApproved plan:\nDo it.\n\nThread replies: keep the flag.";
    expect(withTestRule(prompt, { definitionVersion: "1.1.0" }).endsWith(`\n\n${IMPLEMENT_TEST_RULE}`)).toBe(true);
    expect(withTestRule(prompt, { definitionVersion: "1.1.0" }).startsWith(prompt)).toBe(true);
    expect(withTestRule(prompt, { definitionVersion: "1.0.0" })).toBe(prompt);
  });
});

const OPERATION = "11111111-1111-4111-8111-111111111111";
const finding = { text: "The token is logged.", origin: "INTRODUCED" as const, file: "src/log.ts", line: 4 };
const reviewReport = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS", codeDigest: string, findings: unknown[] = []) =>
  ({ operationId: OPERATION, candidateDigest: codeDigest, role, provider: "scripted", version: "1", status, findings, readOnly: true, recordedAt: now });
const planArtifact = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "b".repeat(64), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.md`, createdAt: now };
/** The real engine, so the round tests stand on what it does: a version 2 workflow with its plan approved, the build ready. */
function approvedV2(): WorkflowSnapshot {
  const created = createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion: "1.1.0", program: v2Program() });
  const submitted = submitWorkflowArtifact(created, { expectedRevision: created.revision, artifact: planArtifact, now });
  // The version 2 recipe has a plan check (Task 8): the plan is checked by a second model before its owner decides.
  const running: WorkflowSnapshot = { ...submitted, revision: submitted.revision + 1, state: "RUNNING" };
  const waiting = submitPlanCritique(running, { expectedRevision: running.revision, critique: { verdict: "ok", points: [], model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-6-v1", company: "anthropic" } }, now });
  return decideWorkflow(waiting, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: waiting.revision, decision: "APPROVE", reason: "Go", artifactDigest: planArtifact.sha256 },
    { actorId: ownerId, role: "TASK_OWNER" }, { now, allowedSkipStages: [] });
}
const checkedOn = (workflow: WorkflowSnapshot, code: ReturnType<typeof candidate>): WorkflowSnapshot => recordWorkflowVerification(
  { ...blockWorkflow(workflow, "candidate checks are being recorded", now), stage: "VERIFY" as const },
  { candidate: code, checks: { candidateDigest: code.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] }, now },
);
const reviewedOn = (workflow: WorkflowSnapshot, code: ReturnType<typeof candidate>, findings: unknown[]): WorkflowSnapshot =>
  (["CRITIC", "SECURITY"] as const).map((role) => reviewReport(role, findings.length > 0 ? "FINDINGS" : "PASS", code.digest, findings))
    .reduce<WorkflowSnapshot>((current, next) => submitWorkflowReview(current, next, now), workflow);
const sendBack = (workflow: WorkflowSnapshot, requestId: string) => returnWorkflowToImplementation(workflow, { requestId, actorId: ownerId, reason: "One more change", now });

describe("the review round being fixed", () => {
  // Not parsed: these are the positions the engine passes through, and a version 1 task with a program is one the schema refuses (the function must still say nothing).
  // A round found problems when the review it counts still holds findings for the code being rewritten, so that is what the default carries.
  const code = candidate("1");
  const found = [reviewReport("CRITIC", "FINDINGS", code.digest, [finding]), reviewReport("SECURITY", "FINDINGS", code.digest, [finding])];
  const rounded = (rounds: number, extra: Record<string, unknown> = {}, definitionVersion: "1.0.0" | "1.1.0" = "1.1.0") => ({
    ...createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion }),
    program: v2Program(), programStepId: "build", stage: "IMPLEMENT", state: "READY", candidate: code, reviews: found, ...(rounds === 0 ? {} : { programRounds: { review: rounds } }), ...extra,
  }) as unknown as WorkflowSnapshot;

  it("says round 2 of 3 exactly while the fix for round 2 is under way", () => {
    expect(workflowReviewRound(rounded(2))).toEqual({ round: 2, max: 3, message: "Review round 2 of 3 found problems; I'm fixing them." });
    expect(workflowReviewRound(rounded(1))).toEqual({ round: 1, max: 3, message: "Review round 1 of 3 found problems; I'm fixing them." });
  });

  it("not before any review, while the checks or a review run, once the pull request is next, or while the step is blocked", () => {
    expect(workflowReviewRound(rounded(0))).toBeUndefined();
    expect(workflowReviewRound(rounded(1, { stage: "VERIFY", state: "WAITING", programStepId: "check" }))).toBeUndefined();
    expect(workflowReviewRound(rounded(1, { stage: "REVIEW", state: "WAITING", programStepId: "review" }))).toBeUndefined();
    expect(workflowReviewRound(rounded(2, { stage: "PULL_REQUEST", state: "READY", programStepId: "pull_request" }))).toBeUndefined();
    expect(workflowReviewRound(rounded(1, { state: "BLOCKED", blockReason: "coding stopped" }))).toBeUndefined();
    // Only the build the findings go back to: not the steps before it, nor the review itself.
    expect(workflowReviewRound(rounded(1, { programStepId: "plan_critic" }))).toBeUndefined();
    expect(workflowReviewRound(rounded(1, { programStepId: "review" }))).toBeUndefined();
    // Findings on other code, or none held, are not findings being fixed.
    expect(workflowReviewRound(rounded(1, { reviews: [reviewReport("CRITIC", "FINDINGS", candidate("2").digest, [finding])] }))).toBeUndefined();
    expect(workflowReviewRound(rounded(1, { reviews: [reviewReport("CRITIC", "PASS", code.digest)] }))).toBeUndefined();
  });

  it("a version 1 task has no round counter, whatever its snapshot holds", () => {
    expect(workflowReviewRound(rounded(2, {}, "1.0.0"))).toBeUndefined();
    const noProgram = workflowWith({ stage: "IMPLEMENT", state: "READY" });
    expect(workflowReviewRound(noProgram)).toBeUndefined();
  });

  it("counts a round only when it found problems: findings in the engine give round 1 and 2, a clean review gives none, and a send-back after one is not a round (Review I1)", () => {
    const first = candidate("1");
    const second = candidate("2");
    const third = candidate("3");
    expect(workflowReviewRound(approvedV2())).toBeUndefined();
    const afterFirst = reviewedOn(checkedOn(approvedV2(), first), first, [finding]);
    expect(afterFirst).toMatchObject({ stage: "IMPLEMENT", state: "READY", programRounds: { review: 1 } });
    expect(workflowReviewRound(afterFirst)).toMatchObject({ round: 1, max: 3 });
    const afterSecond = reviewedOn(checkedOn(afterFirst, second), second, [finding]);
    expect(workflowReviewRound(afterSecond)).toMatchObject({ round: 2, max: 3, message: "Review round 2 of 3 found problems; I'm fixing them." });
    // The fix of round 2 passes its review: the counter still says two reviews finished, but neither is being fixed.
    const clean = reviewedOn(checkedOn(afterSecond, third), third, []);
    expect(clean).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    const owner = sendBack(clean, "33333333-3333-4333-8333-333333333333");
    expect(owner).toMatchObject({ stage: "IMPLEMENT", state: "READY", programStepId: "build" });
    expect(workflowReviewRound(owner)).toBeUndefined();
    // A clean first review and then an owner send-back: the same.
    const onceClean = reviewedOn(checkedOn(approvedV2(), first), first, []);
    expect(workflowReviewRound(sendBack(onceClean, "44444444-4444-4444-8444-444444444444"))).toBeUndefined();
  });

  it("a fix made for a CI failure, a conflict or comments is not a review round", () => {
    for (const fixSource of ["ci", "conflict", "feedback"]) expect(workflowReviewRound(rounded(2, { fixSource })), fixSource).toBeUndefined();
  });
});

describe("the task view carries the two fields, and an older client never sees them", () => {
  const report = { reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [{ repository: "payments", path: "tests/a.py" }] };
  const round = { round: 2, max: 3, message: "Review round 2 of 3 found problems; I'm fixing them." };
  const view = (extra: Record<string, unknown> = {}) => ({
    taskId, title: "Add a retry flag", project: "payments", status: "RUNNING", startingRevision: 1, client: "Claude Code", shared: false, createdAt: now, updatedAt: now, events: [],
    workflow: workflowWith({ stage: "IMPLEMENT", state: "READY" }), verificationReport: report, reviewRound: round, ...extra,
  });

  it("the view schema accepts both fields and refuses anything else in them", () => {
    expect(DeveloperTaskViewSchema.safeParse(view()).success).toBe(true);
    expect(DeveloperTaskViewSchema.safeParse(view({ reviewRound: { ...round, html: "<b>" } })).success).toBe(false);
    expect(DeveloperTaskViewSchema.safeParse(view({ reviewRound: { ...round, round: 0 } })).success).toBe(false);
    expect(DeveloperTaskViewSchema.safeParse(view({ verificationReport: { ...report, extra: 1 } })).success).toBe(false);
    expect(DeveloperTaskViewSchema.safeParse(view({ verificationReport: { ...report, passed: [{ label: "x".repeat(201) }] } })).success).toBe(false);
  });

  it("taskViewForClient drops them without the version 2 header, and keeps them with it", () => {
    const original = view();
    const projected = taskViewForClient(original as never, {}) as unknown as Record<string, unknown>;
    expect(projected).not.toHaveProperty("verificationReport");
    expect(projected).not.toHaveProperty("reviewRound");
    expect(taskViewForClient(original as never, { "x-agentx-task-view": "2" })).toEqual(original);
    // A view with no workflow is projected too, so the fields can never reach an old client by that path.
    const bare = taskViewForClient({ ...original, workflow: undefined } as never, {}) as unknown as Record<string, unknown>;
    expect(bare).not.toHaveProperty("verificationReport");
    expect(bare).not.toHaveProperty("reviewRound");
    // The rest of the view is untouched.
    expect(projected).toMatchObject({ taskId, title: "Add a retry flag", project: "payments", status: "RUNNING" });
  });
});

describe("the thread says which review round is being fixed", () => {
  const code = candidate("1");
  const found = [reviewReport("CRITIC", "FINDINGS", code.digest, [finding]), reviewReport("SECURITY", "FINDINGS", code.digest, [finding])];
  const rounded = (rounds: number, extra: Record<string, unknown> = {}, definitionVersion: "1.0.0" | "1.1.0" = "1.1.0") => ({
    ...createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion }),
    program: v2Program(), programStepId: "build", stage: "IMPLEMENT", state: "RUNNING", candidate: code, reviews: found, programRounds: { review: rounds }, ...extra,
  }) as unknown as WorkflowSnapshot;
  const said = (workflow: WorkflowSnapshot) => workflowMessage({ taskId, workflow })?.text;

  it("round 2 of a version 2 task reads exactly, and a round found by an owner's send-back keeps its own wording", () => {
    expect(said(rounded(2))).toBe("Review round 2 of 3 found problems; I'm fixing them.");
    const sentBack = rounded(2, { revision: 9, decisions: [{ requestId: "22222222-2222-4222-8222-222222222222", workflowRevision: 8, decision: "REQUEST_CHANGES", actorId: ownerId, actorRole: "TASK_OWNER", reason: "Fix it", source: "SEND_BACK", at: now }] });
    expect(said(sentBack)).not.toContain("Review round");
  });

  it("a clean review followed by an owner's send-back says the send-back, never a round (Review I1)", () => {
    const first = candidate("1");
    const clean = reviewedOn(checkedOn(approvedV2(), first), first, []);
    const owner = { ...sendBack(clean, "33333333-3333-4333-8333-333333333333"), state: "RUNNING" as const };
    expect(said(owner)).toBe("Sent back to coding with your note. Checks and reviews will run again after.");
  });

  it("an approved PR feedback fix and a fix for CI keep their own words, whatever the round counter holds (Review I1)", () => {
    const feedback = rounded(2, { revision: 12, feedbackDecisions: [{ decision: "APPROVE", workflowRevision: 11, at: now }] });
    expect(said(feedback)).toBe("PR feedback approved. Updating the code now; the checks and reviews run again after.");
    expect(said(rounded(2, { fixSource: "ci" }))).not.toContain("Review round");
  });

  it("a version 1 task never says a round", () => {
    const v1 = { ...createWorkflowSnapshot({ taskId, ownerId, now }), stage: "IMPLEMENT", state: "RUNNING" } as unknown as WorkflowSnapshot;
    expect(said(v1)).toBe("Trying the coding step again.");
  });
});

describe("a route's answer", () => {
  it("projects a task that has the version 2 fields but no workflow, for a client without the header", () => {
    const task = { taskId, title: "t", project: "payments", status: "RUNNING", startingRevision: 1, client: "c", shared: false, createdAt: now, updatedAt: now, events: [],
      reviewRound: { round: 1, max: 3, message: "Review round 1 of 3 found problems; I'm fixing them." } };
    const plain = taskResponseForClient({ task }, {}).task as Record<string, unknown>;
    expect(plain).not.toHaveProperty("reviewRound");
    expect(taskResponseForClient({ task }, { "x-agentx-task-view": "2" }).task).toBe(task);
  });
});

describe("a version 2 task through the broker", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  async function v2Task() {
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { agents: {} } });
    const store = new AgentStore({ documentClient: harness.db, tableName: "state", now: Date.now });
    await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
    harness.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: now });
    const reply = await harness.dev(MAYA, "POST", "/v1/app/agents/rovara-code/runs", { requestId: randomUUID(), project: "payments", input: { text: "Fix the retry bug" } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const id = (reply.body.task as { taskId: string }).taskId;
    const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
    return { harness, id, record };
  }

  const read = async (harness: Awaited<ReturnType<typeof v2Task>>["harness"], id: string, headers: Record<string, string> = {}) => {
    const org = await harness.orgOf(MAYA);
    const response = await harness.handler({
      version: "2.0", rawPath: `/v1/dev/tasks/${id}`, rawQueryString: "", headers: { authorization: await bearerFor(MAYA, org), ...headers },
      requestContext: { requestId: randomUUID(), http: { method: "GET" } },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (JSON.parse(response.body) as { task: Record<string, unknown> }).task;
  };

  it("shows the review round to a version 2 client only, and none while the first build runs", async () => {
    const { harness, id, record } = await v2Task();
    expect((await read(harness, id, { "x-agentx-task-view": "2" })).reviewRound).toBeUndefined();
    const code = candidate("1");
    const found = ["CRITIC", "SECURITY"].map((role) => reviewReport(role as "CRITIC" | "SECURITY", "FINDINGS", code.digest, [finding]));
    harness.db.set({ ...record(), workflow: { ...record().workflow, stage: "IMPLEMENT", state: "READY", programStepId: "build", programRounds: { review: 2 }, candidate: code, reviews: found } });
    expect((await read(harness, id, { "x-agentx-task-view": "2" })).reviewRound).toEqual({ round: 2, max: 3, message: "Review round 2 of 3 found problems; I'm fixing them." });
    expect(await read(harness, id)).not.toHaveProperty("reviewRound");
  });

  it("shows the verification report once checks ran on the current code, to a version 2 client only", async () => {
    const { harness, id, record } = await v2Task();
    const code = candidate("1");
    const policyOf = { required: [check("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] };
    harness.db.set({ ...record(), workflow: { ...record().workflow, stage: "REVIEW", state: "WAITING", programStepId: "review", candidate: code, checkPolicy: policyOf,
      verification: verification([{ checkId: "unit", status: "PASS" }], {}, code.digest) }, closedAt: now, outcome: "CLOSED" });
    const v2View = await read(harness, id, { "x-agentx-task-view": "2" });
    expect(v2View.verificationReport).toEqual({ reviewOnly: false, passed: [{ label: "Unit tests" }], failed: [], notChecked: [], testsAdded: [] });
    expect(await read(harness, id)).not.toHaveProperty("verificationReport");
  });

  it("a version 1 task shows neither field, even with checks and a program-free round counter in its snapshot", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Add a greeting", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const id = (started.body.task as { taskId: string }).taskId;
    const record = harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
    const code = candidate("1");
    harness.db.set({ ...record, workflow: { ...record.workflow, stage: "REVIEW", state: "WAITING", candidate: code,
      checkPolicy: { required: [check("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] }, verification: verification([{ checkId: "unit", status: "PASS" }], {}, code.digest) } });
    const view = await read(harness, id, { "x-agentx-task-view": "2" });
    expect(view).not.toHaveProperty("verificationReport");
    expect(view).not.toHaveProperty("reviewRound");
  });

  /** A version 2 task whose plan was approved: the first build is running. */
  async function approvedBuild() {
    const task = await v2Task();
    const { harness, id, record } = task;
    const workspaceId = record().workspaceId;
    const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const planning = operations().find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED");
    expect(planning).toBeDefined();
    const content = "1. Add the flag. 2. Add a test.";
    await finishPlanningWithMarkdown(harness, workspaceId, String(planning!.id), content);
    await finishPlanCheck(harness, workspaceId);
    const waiting = await read(harness, id);
    const approve = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${id}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: (waiting.workflow as { revision: number }).revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(content).digest("hex"),
    });
    expect(approve.status, JSON.stringify(approve.body)).toBe(200);
    const builds = () => operations().filter((item) => item.workflowMode === "IMPLEMENT");
    const promptOf = (operation: Record<string, unknown>) => (harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation.id)[0]?.invocation as { payload: { prompt: string } }).payload.prompt;
    return { ...task, workspaceId, builds, promptOf };
  }
  const deps = (harness: Awaited<ReturnType<typeof v2Task>>["harness"]) => ({ documentClient: harness.db, tableName: "state", actions: harness.actions, log: () => undefined,
    orgId: TEST_ORG, checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() });

  it("hides the report while the code is being rewritten (Review M3)", async () => {
    const { harness, id, record } = await v2Task();
    const code = candidate("1");
    const reviewing = { ...record().workflow, stage: "REVIEW", state: "WAITING", programStepId: "review", candidate: code, checkPolicy: { required: [check("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] },
      verification: verification([{ checkId: "unit", status: "PASS" }], {}, code.digest) };
    harness.db.set({ ...record(), workflow: reviewing, closedAt: now, outcome: "CLOSED" });
    expect((await read(harness, id, { "x-agentx-task-view": "2" })).verificationReport).toBeDefined();
    // After a send-back the old candidate and its results stay until the next candidate replaces them; they are not shown as this code's results.
    harness.db.set({ ...record(), workflow: { ...reviewing, stage: "IMPLEMENT", state: "READY", programStepId: "build" }, closedAt: now, outcome: "CLOSED" });
    expect(await read(harness, id, { "x-agentx-task-view": "2" })).not.toHaveProperty("verificationReport");
  });

  it("hides the report while the task's operation is running, when the changed files are not known (Review M4)", async () => {
    const { harness, id, record, workspaceId, builds } = await approvedBuild();
    expect(builds()).toHaveLength(1);
    const code = candidate("1");
    harness.db.set({ ...record(), workflow: { ...record().workflow, stage: "REVIEW", state: "WAITING", programStepId: "review", candidate: code,
      checkPolicy: { required: [check("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] }, verification: verification([{ checkId: "unit", status: "PASS" }], {}, code.digest) } });
    const running = await read(harness, id, { "x-agentx-task-view": "2" });
    expect(running.status).toBe("RUNNING");
    expect("verificationReport" in running).toBe(false);
    expect(workspaceId).toBeDefined();
  });

  it("the build prompt after the plan's approval ends with the test rule", async () => {
    const { builds, promptOf } = await approvedBuild();
    expect(builds()).toHaveLength(1);
    const prompt = promptOf(builds()[0]!);
    expect(prompt.endsWith(`\n\n${IMPLEMENT_TEST_RULE}`)).toBe(true);
    expect(prompt).toContain("Do not push branches or create pull requests");
    expect(prompt.split(IMPLEMENT_TEST_RULE)).toHaveLength(2);
  });

  it("a retried build, and the next step of the program, end with it too", async () => {
    const { harness, id, record, workspaceId, builds, promptOf } = await approvedBuild();
    await harness.finish(workspaceId, String(builds()[0]!.id), "FAILED", { error: "the model stopped" });
    expect(record().workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    const retry = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${id}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: record().workflow.revision });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(builds()).toHaveLength(2);
    const retried = promptOf(builds()[1]!);
    expect(retried).toContain("The previous coding run stopped before it finished");
    expect(retried.endsWith(`\n\n${IMPLEMENT_TEST_RULE}`)).toBe(true);
    await harness.finish(workspaceId, String(builds()[1]!.id), "FAILED", { error: "again" });
    // The program's own next coding step (what a review's findings send the work back to) starts with no one asking.
    const { blockReason: _blockReason, ...blocked } = record().workflow;
    void _blockReason;
    harness.db.set({ ...record(), workflow: { ...blocked, state: "READY", programStepId: "build", programRounds: { review: 1 } } });
    await expect(startTaskWorkflowImplementationFromSystem(deps(harness) as never, id, { workflowRevision: record().workflow.revision })).resolves.toBe("STARTED");
    expect(builds()).toHaveLength(3);
    const stepPrompt = promptOf(builds()[2]!);
    expect(stepPrompt).toContain("one coding step of a longer sequence");
    expect(stepPrompt.endsWith(`\n\n${IMPLEMENT_TEST_RULE}`)).toBe(true);
  });

  it("the prompt after a run-limit-approved start ends with the rule, and a version 1 task's does not (Review M1)", async () => {
    const v2 = await approvedBuild();
    const blockOnRunLimit = (task: Awaited<ReturnType<typeof approvedBuild>>, mutate: (workflow: Record<string, unknown>) => Record<string, unknown>) => {
      task.harness.db.set({ ...task.record(), workflow: mutate({ ...task.record().workflow, state: "BLOCKED", blockReason: runLimitBlockText(5, "maintainer") }) });
    };
    await v2.harness.finish(v2.workspaceId, String(v2.builds()[0]!.id), "FAILED", { error: "stopped" });
    blockOnRunLimit(v2, (workflow) => workflow);
    await expect(resumeAfterRunLimitApproval(deps(v2.harness) as never, v2.id, { requestId: randomUUID(), runLimitUsd: 5 })).resolves.toBe("STARTED");
    expect(v2.builds()).toHaveLength(2);
    const prompt = v2.promptOf(v2.builds()[1]!);
    expect(prompt).toContain("Implement the human-approved plan below");
    expect(prompt.endsWith(`\n\n${IMPLEMENT_TEST_RULE}`)).toBe(true);

    const v1 = await approvedBuild();
    await v1.harness.finish(v1.workspaceId, String(v1.builds()[0]!.id), "FAILED", { error: "stopped" });
    // The same task as a version 1 task: no program, the old definition version.
    blockOnRunLimit(v1, ({ program: _program, programStepId: _programStepId, ...workflow }) => ({ ...workflow, definitionVersion: "1.0.0" })); // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    await expect(resumeAfterRunLimitApproval(deps(v1.harness) as never, v1.id, { requestId: randomUUID(), runLimitUsd: 5 })).resolves.toBe("STARTED");
    const older = v1.promptOf(v1.builds()[1]!);
    expect(older).toContain("Implement the human-approved plan below");
    expect(older).not.toContain(IMPLEMENT_TEST_RULE);
  });
});

describe("the retained-source recovery prompt of a version 2 task (Review M2)", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  it("tells the worker to finalize without editing, and never adds the test rule, which would contradict it", async () => {
    const harness = await createSingleAnswerPlanBroker({ developerExtra: { workflowDependenciesEnabled: true }, brokerExtra: { githubPullRequests: { getCommitTree: vi.fn(async () => "a".repeat(40)) } } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Implement the ordered change", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const id = String((started.body.task as { taskId: string }).taskId);
    const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> & { revision: number } };
    const workspaceId = record().workspaceId;
    const operations = () => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
    await harness.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")?.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const graph = { schemaVersion: 1 as const, taskId: id, version: 1, items: [{ id: "11111111-1111-4111-8111-111111111111", title: "Implement first", description: "Implement the first change", repository: "demo", dependsOn: [] as string[] }] };
    const planning = operations().find((item) => item.workflowMode === "PLAN")!;
    await harness.artifact(workspaceId, String(planning.id), "plan.md", planAnswer(planDocument({ workBreakdown: graph })));
    await harness.finish(workspaceId, String(planning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${id}/workflow/decision`, {
      requestId: randomUUID(), expectedRevision: record().workflow.revision, decision: "APPROVE", reason: "Approved", artifactDigest: (record().workflow.artifacts as Array<{ sha256: string }>).at(-1)!.sha256, workBreakdownDigest: taskGraphDigest(graph),
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const sourceOperationId = String(operations().find((item) => item.workflowMode === "IMPLEMENT")!.id);
    const approval = record().workflow.workflowDependenciesApproval as { runId: string; graphDigest: string; workflowRevision: number };
    harness.db.set({ ...record(), workflow: { ...record().workflow, e2e: { contractDigest: "1".repeat(64), policyDigest: "2".repeat(64), bundleDigest: "3".repeat(64), executionPlanDigest: "4".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } } });
    const implemented = { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: graph.items[0]!.id, sequence: 2, state: "IMPLEMENTED" as const, operationId: sourceOperationId,
      baseTreeSha: "a".repeat(40), candidateTreeSha: "b".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" };
    await harness.events(workspaceId, sourceOperationId, [
      { type: "progress", payload: { workItemProgress: { schemaVersion: 1, graphDigest: approval.graphDigest, runId: approval.runId, itemId: graph.items[0]!.id, sequence: 1, state: "STARTED", operationId: sourceOperationId, baseTreeSha: "a".repeat(40), at: new Date().toISOString(), producer: "agentx-worker" } } },
      { type: "progress", payload: { workItemProgress: implemented } },
    ]);
    const code = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    await harness.finish(workspaceId, sourceOperationId, "SUCCEEDED", { result: {
      workflowCandidateRepositories: code.repositories, workflowCheckCandidateRepositories: code.repositories,
      checks: { status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" },
      workflowDependenciesResult: { schemaVersion: 1, taskId: id, graphDigest: approval.graphDigest, runId: approval.runId, operationId: sourceOperationId, workflowRevision: approval.workflowRevision, status: "SUCCEEDED", items: [implemented], candidateDigest: code.digest, at: new Date().toISOString() },
    } });
    expect(record().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: "the final candidate has no first-party committed source export" });
    // The same task as a version 2 task (no program is needed for the recovery path).
    harness.db.set({ ...record(), workflow: { ...record().workflow, definitionVersion: "1.1.0" } });

    const requestId = randomUUID();
    const response = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${id}/workflow/retry`, { requestId, expectedRevision: record().workflow.revision, instructions: "Finalize the retained source without editing it." });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const recovery = operations().find((operation) => operation.requestId === requestId)!;
    const prompt = (harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === recovery.id)[0]?.invocation as { payload: { prompt: string } }).payload.prompt;
    expect(prompt).toContain("Finalize the approved implementation");
    expect(prompt).toContain("Do not edit");
    expect(prompt).not.toContain(IMPLEMENT_TEST_RULE);
  });
});

describe("the chain step's task route (Review I2)", () => {
  beforeAll(async () => { await loadSlackBroker(); });

  it("projects the task for a client without the version 2 header: no report, no round, no Task 1 fields", async () => {
    const members = new FakeProjectMembers();
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { agents: { projectMembers: members } } });
    members.setOrgRole(TEST_ORG, MAYA.developerId, "owner");
    members.grant(TEST_ORG, "payments", MAYA.developerId, "maintainer");
    harness.db.set({ ...orgProjectCatalogKey(TEST_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments" });
    harness.db.set({ ...agentGuardrailsKey(TEST_ORG), entityType: "AGENT_GUARDRAILS", revision: 1, updatedBy: MAYA.developerId, updatedAt: now, guardrails: { ...DEFAULT_AGENT_GUARDRAILS } });
    const call = async (method: string, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const org = await harness.orgOf(MAYA);
      const response = await harness.handler({
        version: "2.0", rawPath: path.split("?")[0]!, rawQueryString: "", headers: { authorization: await bearerFor(MAYA, org), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify({ requestId: randomUUID(), ...body }) }), requestContext: { requestId: randomUUID(), http: { method } },
      });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    const definition = { start: "look", steps: [{ kind: "agent", id: "look", name: "Look into it", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] };
    const created = await call("POST", "/v1/app/chains", { name: "Look into it", definition });
    const chainId = (created.body.chain as { chainId: string }).chainId;
    const draft = await call("GET", `/v1/app/chains/${chainId}/draft`);
    await call("POST", `/v1/app/chains/${chainId}/publish`, { expectedDraftRevision: (draft.body.draft as { revision: number }).revision });
    const started = await call("POST", `/v1/app/chains/${chainId}/runs`, { project: "payments" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const runId = (started.body.run as { runId: string }).runId;
    const path = `/v1/app/chain-runs/${runId}/sections/1/task`;
    const taskId = ((await call("GET", path, undefined, { "x-agentx-task-view": "2" })).body.task as { taskId: string }).taskId;

    // The step's task becomes a version 2 task that has been checked and is being fixed after a review round.
    const code = candidate("1");
    const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
    const workflow = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId, ownerId, now, definitionVersion: "1.1.0" }), stage: "REVIEW", state: "WAITING", candidate: code,
      checkPolicy: { required: [check("unit", "Unit tests")], optional: [], selectedOptionalIds: [], proposed: [] }, verification: verification([{ checkId: "unit", status: "PASS" }], {}, code.digest),
      fixRounds: { ci: 0, conflict: 0, feedbackAuto: 0 },
    });
    // A task that has ended reads its details in full (a starting or running one does not), so its report can be shown.
    harness.db.set({ ...record, workflow, closedAt: now, outcome: "CLOSED" });
    const full = (await call("GET", path, undefined, { "x-agentx-task-view": "2" })).body.task as Record<string, unknown>;
    expect(full.verificationReport).toBeDefined();
    expect(full.workflow).toMatchObject({ definitionVersion: "1.1.0", fixRounds: { ci: 0 } });

    const plain = (await call("GET", path)).body.task as Record<string, unknown>;
    expect(plain).not.toHaveProperty("verificationReport");
    expect(plain).not.toHaveProperty("reviewRound");
    expect(plain.workflow).toMatchObject({ definitionVersion: "1.0.0" });
    expect(plain.workflow).not.toHaveProperty("fixRounds");
  });
});
