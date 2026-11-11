// Rovara Code (Plan 6) Task 1: the contracts, the tolerant client view of a task, and the keys.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CODE_REVIEWERS_MAX, CodeMilestoneSchema, CodeSettingsSchema, DEFAULT_CODE_SETTINGS, FixSourceSchema, INTENT_QUESTIONS_MAX, IntentAssessmentSchema, IntentQuestionSchema, PlanCritiqueSchema, RiskAssessmentSchema, SECRET_FILE_PATTERNS, SetupDraftSchema, TASK_VIEW_HEADER, TASK_VIEW_VERSION, VerificationReportSchema, WorkflowCritiqueSchema, WorkflowFixRoundsSchema, WorkflowIntentSchema, formatMinutes } from "@rovara-code/contracts";
import { MergeTrackingItemSchema } from "../../packages/cloud-contracts/src/rovara-code.js";
import { mergeTrackingDecisionDigest } from "../../packages/cloud-contracts/src/rovara-code-node.js";
import { WorkflowSnapshotReaderSchema } from "../../packages/cloud-contracts/src/task-workflow.js";
import { WorkflowPathSchema, WorkflowStageSchema } from "@rovara-code/contracts";
import { WorkflowSnapshotSchema, createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { DeveloperTaskViewSchema } from "../../packages/cloud-contracts/src/developer-tasks.js";
import { DeveloperTaskResponseSchema } from "../../packages/cloud-contracts/src/developer-tasks-node.js";
import { AgentXErrorCodeSchema, errorStatus } from "@rovara-code/contracts";
import { WORKER_INVOCATION_FEATURES } from "@agentx/cloud-contracts";
import { WorkerInvocationSchema } from "../../packages/cloud-contracts/src/protocol.js";
import { codeMilestoneKey, codeSettingsKey, durationHistoryKey, githubMemberKey, memberGithubKey, mergeTrackingKey, prHeadKey, mergeCommitIndexKey, setupDraftKey, trashKey } from "@rovara-code/contracts";
import { OrgIdSchema, type OrgId } from "@rovara-code/contracts";
import { taskViewForClient, taskResponseForClient } from "../../packages/broker/src/rovara-code/task-view-compat.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const now = "2026-10-24T12:00:00.000Z";
const orgA = OrgIdSchema.parse("org_aaaaaaaaaaaaaaaaaaaa");
const orgB = OrgIdSchema.parse("org_bbbbbbbbbbbbbbbbbbbb");

const base = () => createWorkflowSnapshot({ taskId, ownerId, now });
const intent = {
  rounds: 1,
  pathFrom: "understand" as const,
  assessment: { kind: "questions" as const, restatement: "Add a retry flag", questions: [{ id: "q1", text: "Which service?" }] },
  answers: [],
};
const critique = {
  status: "done" as const,
  critiques: [{ verdict: "revise" as const, points: [{ id: "c1", severity: "note" as const, text: "Say how it is tested." }], model: { provider: "openai", modelId: "gpt-x", company: "openai" as const } }],
  revisions: 0,
};
const risk = { level: "low" as const, reasons: ["Small change"], candidateDigest: "c".repeat(64) };
const v2 = (extra: Record<string, unknown> = {}) => ({ ...base(), definitionVersion: "1.1.0", ...extra });

describe("the two definition versions", () => {
  it("refuses a 1.0.0 snapshot at UNDERSTAND or PLAN_CRITIQUE, and reads the same 1.1.0 snapshot", () => {
    for (const stage of ["UNDERSTAND", "PLAN_CRITIQUE"]) {
      expect(WorkflowSnapshotSchema.safeParse({ ...base(), stage, state: "WAITING" }).success).toBe(false);
      expect(WorkflowSnapshotSchema.safeParse(v2({ stage, state: "WAITING" })).success).toBe(true);
    }
    expect(WorkflowStageSchema.options).toContain("UNDERSTAND");
    expect(WorkflowStageSchema.options).toContain("PLAN_CRITIQUE");
  });

  it("allows the outcome ANSWERED only on 1.1.0", () => {
    const answered = { stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED" };
    expect(WorkflowSnapshotSchema.safeParse({ ...base(), ...answered }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse(v2(answered)).success).toBe(true);
  });

  it("allows intent, critique and risk only on 1.1.0", () => {
    for (const extra of [{ intent }, { critique }, { risk }]) {
      expect(WorkflowSnapshotSchema.safeParse({ ...base(), ...extra }).success).toBe(false);
      expect(WorkflowSnapshotSchema.safeParse(v2(extra)).success).toBe(true);
    }
  });

  it("allows the after-PR fields on both versions", () => {
    const fixes = { fixRounds: { ci: 1, conflict: 0, feedbackAuto: 2 }, fixSource: "ci" };
    expect(WorkflowSnapshotSchema.safeParse({ ...base(), ...fixes }).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse(v2(fixes)).success).toBe(true);
    expect(WorkflowSnapshotSchema.safeParse({ ...base(), fixSource: "nonsense" }).success).toBe(false);
  });

  it("allows syncedFrom on a pull request of either version, and refuses other unknown keys on it", () => {
    const pullRequest = { repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7", candidateDigest: "d".repeat(64), required: true, state: "OPEN" };
    const withSync = { ...pullRequest, syncedFrom: "e".repeat(40) };
    // The strict schema keeps the key: a snapshot with a synced pull request round-trips on both versions.
    for (const definitionVersion of ["1.0.0", "1.1.0"]) {
      const parsed = WorkflowSnapshotSchema.safeParse({ ...base(), definitionVersion, pullRequests: [withSync] });
      // A snapshot that has a pull request but is still at PLAN is allowed by the schema (it only checks later stages).
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.pullRequests?.[0]).toMatchObject({ syncedFrom: "e".repeat(40) });
    }
    expect(WorkflowSnapshotSchema.safeParse({ ...base(), pullRequests: [{ ...pullRequest, surprise: 1 }] }).success).toBe(false);
  });
});

describe("limits", () => {
  const question = (id: string) => ({ id, text: "Which one?" });
  it("refuses 4 questions, and an empty list", () => {
    expect(INTENT_QUESTIONS_MAX).toBe(3);
    const ask = (questions: unknown[]) => IntentAssessmentSchema.safeParse({ kind: "questions", restatement: "x", questions });
    expect(ask([question("q1"), question("q2"), question("q3")]).success).toBe(true);
    expect(ask([question("q1"), question("q2"), question("q3"), question("q1")]).success).toBe(false);
    expect(ask([]).success).toBe(false);
  });

  it("holds a question to its id pattern, 2 to 4 options and a recommendation that is one of them", () => {
    const options = [{ id: "a", label: "One" }, { id: "b", label: "Two" }];
    expect(IntentQuestionSchema.safeParse({ id: "q4", text: "x" }).success).toBe(false);
    expect(IntentQuestionSchema.safeParse({ id: "q1", text: "x", options: [options[0]] }).success).toBe(false);
    expect(IntentQuestionSchema.safeParse({ id: "q1", text: "x", options, recommended: "b" }).success).toBe(true);
    expect(IntentQuestionSchema.safeParse({ id: "q1", text: "x", options, recommended: "c" }).success).toBe(false);
    expect(IntentQuestionSchema.safeParse({ id: "q1", text: "x".repeat(301) }).success).toBe(false);
  });

  it("reads the three kinds of assessment, and an answer that cites at most 10 sources", () => {
    expect(IntentAssessmentSchema.safeParse({ kind: "ready", path: "QUICK", restatement: "x", assumptions: ["a"] }).success).toBe(true);
    expect(IntentAssessmentSchema.safeParse({ kind: "ready", path: "QUICK", restatement: "x", assumptions: Array(6).fill("a") }).success).toBe(false);
    const sources = Array.from({ length: 10 }, (_, line) => ({ repository: "payments", path: "src/a.ts", line: line + 1 }));
    expect(IntentAssessmentSchema.safeParse({ kind: "answer", restatement: "x", answer: "It retries.", sources }).success).toBe(true);
    expect(IntentAssessmentSchema.safeParse({ kind: "answer", restatement: "x", answer: "It retries.", sources: [...sources, sources[0]] }).success).toBe(false);
  });

  it("takes the same two paths as the workflow", () => {
    for (const path of WorkflowPathSchema.options) expect(IntentAssessmentSchema.safeParse({ kind: "ready", path, restatement: "x", assumptions: [] }).success).toBe(true);
    expect(IntentAssessmentSchema.safeParse({ kind: "ready", path: "SLOW", restatement: "x", assumptions: [] }).success).toBe(false);
  });

  it("reads an intent record with rounds, who answered and from where", () => {
    const answered = { ...intent, answers: [{ round: 1, by: { actorId: ownerId, name: "Ana" }, source: "app", answers: [{ questionId: "q1", optionId: "a" }], at: now }] };
    expect(WorkflowIntentSchema.safeParse(answered).success).toBe(true);
    expect(WorkflowIntentSchema.safeParse({ ...intent, rounds: 3 }).success).toBe(false);
    expect(WorkflowIntentSchema.safeParse({ ...intent, pathFrom: "guess" }).success).toBe(false);
  });

  it("holds code settings to squash or merge and 10 reviewers", () => {
    expect(CODE_REVIEWERS_MAX).toBe(10);
    expect(CodeSettingsSchema.safeParse(DEFAULT_CODE_SETTINGS).success).toBe(true);
    expect(DEFAULT_CODE_SETTINGS).toEqual({ allowSelfApproval: false, mergeMethod: "squash", codeReviewers: [], revision: 0 });
    expect(CodeSettingsSchema.safeParse({ ...DEFAULT_CODE_SETTINGS, mergeMethod: "rebase" }).success).toBe(false);
    const reviewers = (count: number) => Array.from({ length: count }, (_, index) => `reviewer-${index}`);
    expect(CodeSettingsSchema.safeParse({ ...DEFAULT_CODE_SETTINGS, codeReviewers: reviewers(10) }).success).toBe(true);
    expect(CodeSettingsSchema.safeParse({ ...DEFAULT_CODE_SETTINGS, codeReviewers: reviewers(11) }).success).toBe(false);
    expect(CodeSettingsSchema.safeParse({ ...DEFAULT_CODE_SETTINGS, codeReviewers: ["bad name\n"] }).success).toBe(false);
  });

  it("holds a critique to 10 points and at most 2 critiques", () => {
    const point = (id: number) => ({ id: `c${id}`, severity: "blocking" as const, text: "x" });
    const model = { provider: "openai", modelId: "gpt-x", company: "openai" as const };
    expect(PlanCritiqueSchema.safeParse({ verdict: "revise", points: Array.from({ length: 10 }, (_, index) => point(index)), model }).success).toBe(true);
    expect(PlanCritiqueSchema.safeParse({ verdict: "revise", points: Array.from({ length: 11 }, (_, index) => point(index)), model }).success).toBe(false);
    expect(PlanCritiqueSchema.safeParse({ verdict: "ok", points: [{ ...point(1), text: "x".repeat(501) }], model }).success).toBe(false);
    expect(WorkflowCritiqueSchema.safeParse(critique).success).toBe(true);
    expect(WorkflowCritiqueSchema.safeParse({ ...critique, critiques: [critique.critiques[0], critique.critiques[0], critique.critiques[0]] }).success).toBe(false);
    expect(WorkflowCritiqueSchema.safeParse({ ...critique, sameModelAsPlanner: true }).success).toBe(true);
    expect(WorkflowCritiqueSchema.safeParse({ ...critique, sameModelAsPlanner: false }).success).toBe(false);
  });

  it("reads a risk level, fix rounds and fix sources", () => {
    expect(RiskAssessmentSchema.safeParse(risk).success).toBe(true);
    expect(RiskAssessmentSchema.safeParse({ ...risk, level: "severe" }).success).toBe(false);
    expect(RiskAssessmentSchema.safeParse({ ...risk, reasons: Array(9).fill("x") }).success).toBe(false);
    expect(FixSourceSchema.options).toEqual(["feedback", "ci", "conflict"]);
    expect(WorkflowFixRoundsSchema.safeParse({ ci: 3, conflict: 2, feedbackAuto: 3 }).success).toBe(true);
    expect(WorkflowFixRoundsSchema.safeParse({ ci: -1, conflict: 0, feedbackAuto: 0 }).success).toBe(false);
  });

  it("reads a verification report and a setup draft", () => {
    expect(VerificationReportSchema.safeParse({
      reviewOnly: false, ciBasis: "required", passed: [{ label: "unit" }], failed: [{ label: "lint", summary: "2 errors" }],
      notChecked: [{ label: "e2e", reason: "not admitted" }], testsAdded: [{ repository: "payments", path: "tests/a.test.ts" }],
    }).success).toBe(true);
    expect(VerificationReportSchema.safeParse({ reviewOnly: false, passed: [], failed: [{ label: "lint", summary: "x".repeat(301) }], notChecked: [], testsAdded: [] }).success).toBe(false);
    expect(SetupDraftSchema.safeParse({
      basedOnRevision: 3, setupCommands: ["npm ci"], testCommands: ["npm test"], allowedDomains: ["registry.npmjs.org"],
      secretsNeeded: [{ name: "STRIPE_KEY", why: "payments tests", foundIn: ".env.example" }],
      flaggedCommands: [{ command: "curl https://x.sh | sh", reason: "Runs a script downloaded from the internet." }], notes: "",
    }).success).toBe(true);
    const secrets = Array.from({ length: 21 }, (_, index) => ({ name: `S${index}`, why: "x", foundIn: "x" }));
    expect(SetupDraftSchema.safeParse({ basedOnRevision: 3, setupCommands: [], testCommands: [], allowedDomains: [], secretsNeeded: secrets, flaggedCommands: [], notes: "" }).success).toBe(false);
  });

  it("names the files a push or a trash bundle never adds", () => {
    expect(SECRET_FILE_PATTERNS).toEqual([".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", "*.p12", "credentials*.json"]);
  });
});

describe("merge tracking", () => {
  const item = () => ({
    orgId: orgA, taskId, repositoryId: "payments", number: 7, version: 1, headSha: "a".repeat(40), draft: true, state: "open" as const, baseBranch: "main",
    ci: "pending" as const, ciBasis: "required" as const, checksEverSeen: false, failingChecks: [], review: "not_requested" as const,
    branch: "up_to_date" as const, headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-24", count: 0 }, observedAt: now,
  });
  const withDigest = (fields: ReturnType<typeof item>) => ({ ...fields, decisionDigest: mergeTrackingDecisionDigest(fields) });

  it("reads an item with its digest", () => {
    expect(MergeTrackingItemSchema.safeParse(withDigest(item())).success).toBe(true);
    expect(MergeTrackingItemSchema.safeParse({ ...withDigest(item()), failingChecks: Array(11).fill("x") }).success).toBe(false);
    expect(MergeTrackingItemSchema.safeParse({ ...withDigest(item()), ci: "green" }).success).toBe(false);
  });

  it("gives items that differ only in observedAt and version the same digest, and any other change a new one", () => {
    const first = mergeTrackingDecisionDigest(item());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(mergeTrackingDecisionDigest({ ...item(), observedAt: "2026-10-24T13:00:00.000Z", version: 9 })).toBe(first);
    expect(mergeTrackingDecisionDigest({ ...item(), ci: "passing" })).not.toBe(first);
    expect(mergeTrackingDecisionDigest({ ...item(), headSha: "b".repeat(40) })).not.toBe(first);
    expect(mergeTrackingDecisionDigest({ ...item(), mergeClaim: { headSha: "a".repeat(40), by: "d1", at: now } })).not.toBe(first);
    // The digest field itself is not hashed: a stored item hashes to the digest it carries.
    expect(mergeTrackingDecisionDigest(withDigest(item()))).toBe(first);
  });

  it("is independent of key order", () => {
    const fields = item();
    const shuffled = Object.fromEntries(Object.entries(fields).reverse()) as typeof fields;
    expect(mergeTrackingDecisionDigest(shuffled)).toBe(mergeTrackingDecisionDigest(fields));
  });
});

describe("milestones", () => {
  it("reads a milestone of each kind and refuses text over 500 characters", () => {
    const milestone = { kind: "pr_ready" as const, orgId: orgA, taskId, at: now, text: "The pull request is ready." };
    for (const kind of ["questions", "answered", "plan_ready", "pr_ready", "review_nudge", "fixing", "stuck", "approved", "merged"]) {
      expect(CodeMilestoneSchema.safeParse({ ...milestone, kind }).success).toBe(true);
    }
    expect(CodeMilestoneSchema.safeParse({ ...milestone, kind: "deployed" }).success).toBe(false);
    expect(CodeMilestoneSchema.safeParse({ ...milestone, text: "x".repeat(501) }).success).toBe(false);
    expect(CodeMilestoneSchema.safeParse({ ...milestone, pullRequests: [{ repository: "payments", number: 7, url: "https://github.com/a/b/pull/7" }], to: ["d1"] }).success).toBe(true);
  });
});

describe("formatMinutes", () => {
  it("says minutes below 90, whole hours from there, with an en dash", () => {
    expect(formatMinutes(20, 45)).toBe("about 20–45 minutes");
    expect(formatMinutes(60, 180)).toBe("about 1–3 hours");
    expect(formatMinutes(60, 180)).not.toContain("-");
  });
});

describe("error codes and worker features", () => {
  it("adds the three codes with their statuses", () => {
    expect(AgentXErrorCodeSchema.options).toEqual(expect.arrayContaining(["INTENT_NOT_WAITING", "MERGE_NOT_READY", "TRASH_EXPIRED"]));
    expect(errorStatus("INTENT_NOT_WAITING")).toBe(409);
    expect(errorStatus("MERGE_NOT_READY")).toBe(409);
    expect(errorStatus("TRASH_EXPIRED")).toBe(410);
  });

  it("lists the nine worker features", () => {
    for (const feature of ["task.workflowUnderstand", "task.workflowPlanCritique", "task.workflowParallelParts", "task.workflowFix", "task.workflowFeedbackAutonomy", "maintain.workflowSync", "task.setupDraft", "publish.branchOnly", "close.trashBundle"]) {
      expect(WORKER_INVOCATION_FEATURES).toContain(feature);
    }
  });

  it("lets a task invocation name the two new workflow modes", () => {
    const invocation = {
      protocolVersion: 1, kind: "task", operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
      fence: 1, projectRevision: 1, callbackCapability: "c".repeat(32),
      payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Plan the requested change." },
    };
    const task = (workflowMode: string) => WorkerInvocationSchema.safeParse({ ...invocation, payload: { ...invocation.payload, workflowMode } });
    expect(task("UNDERSTAND").success).toBe(true);
    expect(task("PLAN_CRITIQUE").success).toBe(true);
    expect(task("NOT_A_MODE").success).toBe(false);
  });
});

describe("keys", () => {
  const builders: Array<[string, (org: OrgId) => { pk: string; sk: string }]> = [
    ["codeSettingsKey", (org) => codeSettingsKey(org, "web")],
    ["durationHistoryKey", (org) => durationHistoryKey(org, "web", "QUICK")],
    ["githubMemberKey", (org) => githubMemberKey(org, "12345")],
    ["memberGithubKey", (org) => memberGithubKey(org, "d1")],
    ["setupDraftKey", (org) => setupDraftKey(org, "web")],
    ["trashKey", (org) => trashKey(org, "d1", taskId)],
    ["prHeadKey", (org) => prHeadKey(org, "payments", "a".repeat(40))],
    ["mergeCommitIndexKey", (org) => mergeCommitIndexKey(org, "acme/api", "a".repeat(40))],
  ];

  it.each(builders)("%s puts the org in the partition key, so two orgs never share an item", (_name, build) => {
    expect(build(orgA).pk).toContain(orgA);
    expect(build(orgA).pk).not.toContain(orgB);
    expect(build(orgA)).not.toEqual(build(orgB));
    expect(build(orgA).sk.length).toBeGreaterThan(0);
  });

  it("refuses a part that would break the key apart", () => {
    expect(() => codeSettingsKey(orgA, "we#b")).toThrow();
    expect(() => githubMemberKey(orgA, "")).toThrow();
    expect(() => trashKey(orgA, "d1", "x\u0000y")).toThrow();
    expect(() => prHeadKey(orgA, "pay#ments", "a".repeat(40))).toThrow();
    expect(() => mergeCommitIndexKey(orgA, "acme/a#pi", "a".repeat(40))).toThrow();
    expect(mergeCommitIndexKey(orgA, "Acme/API", "A".repeat(40))).toEqual({ pk: `ORG#${orgA}#GITHUB_MERGE`, sk: `acme/api#${"a".repeat(40)}` });
  });

  it("keeps merge tracking and milestones in the task's partition, ordered", () => {
    expect(mergeTrackingKey(taskId, "payments", 7)).toEqual({ pk: `DEVTASK#${taskId}`, sk: "MERGE_TRACKING#payments#7" });
    expect(codeMilestoneKey(taskId, "review_nudge", 2)).toEqual({ pk: `DEVTASK#${taskId}`, sk: "CODE_MILESTONE#review_nudge#000002" });
    expect(codeMilestoneKey(taskId, "merged", 1).sk < codeMilestoneKey(taskId, "merged", 10).sk).toBe(true);
    expect(() => mergeTrackingKey(taskId, "a#b", 1)).toThrow();
    expect(() => codeMilestoneKey(taskId, "merged", -1)).toThrow();
  });
});

/** The part of Ajv this test uses (the package is CommonJS and exports the class itself). */
type AjvClass = new (options: object) => { compile(schema: object): ((value: unknown) => boolean) & { errors?: unknown } };

describe("a task read by an older client (Finding 13)", () => {
  const view = (workflow: Record<string, unknown>) => ({
    taskId, title: "Add a retry flag", project: "payments", status: "RUNNING", startingRevision: 1, client: "Claude Code", shared: false,
    createdAt: now, updatedAt: now, events: [], workflow,
  });

  // What a client built before Plan 6 parsed: the JSON Schema of the real `DeveloperTaskResponseSchema` as it was at 09da2b0e (version a fixed "1.0.0", nine stages, six
  // outcomes, a strict pull request, every strict nested object of the view), generated from that commit with `z.toJSONSchema(schema, { io: "input", unrepresentable: "any",
  // target: "draft-7" })` and frozen in tests/fixtures. It is the whole view, so a later task that adds a field to any strict object of it fails here until
  // `taskViewForClient` projects it away.
  const legacySchema = JSON.parse(readFileSync("tests/fixtures/pre-plan6-task-response.schema.json", "utf8")) as object;
  const validateLegacy = new (createRequire(import.meta.url)("ajv") as AjvClass)({ strict: false, validateFormats: false }).compile(legacySchema);
  const LegacyResponse = { safeParse: (value: unknown) => ({ success: validateLegacy(value), errors: validateLegacy.errors }) };
  const pullRequest = { repositoryId: "payments", number: 7, url: "https://github.com/acme/payments/pull/7", candidateDigest: "d".repeat(64), required: true, state: "OPEN", syncedFrom: "e".repeat(40) };

  const understanding = () => view(v2({ stage: "UNDERSTAND", state: "WAITING", intent, fixRounds: { ci: 0, conflict: 0, feedbackAuto: 0 }, fixSource: "ci", pullRequests: [pullRequest] }));

  it("is parsed by the old reader once the broker projects it, and not before (positive control)", () => {
    expect(LegacyResponse.safeParse({ task: understanding() }).success).toBe(false);
    const projected = taskViewForClient(understanding() as never, {});
    const parsed = LegacyResponse.safeParse({ task: projected });
    expect(parsed.errors ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    expect(projected.workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN" });
  });

  it("projects each new stage, the answered outcome and every new field away", () => {
    const stage = (name: string) => taskViewForClient(view(v2({ stage: name, state: "RUNNING" })) as never, {}).workflow?.stage;
    expect(stage("UNDERSTAND")).toBe("PLAN");
    expect(stage("PLAN_CRITIQUE")).toBe("PLAN");
    expect(stage("IMPLEMENT")).toBe("IMPLEMENT");
    const answered = taskViewForClient(view(v2({ stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED" })) as never, {}).workflow;
    expect(answered).toMatchObject({ stage: "CLOSED", outcome: "CLOSED", definitionVersion: "1.0.0" });
    const workflow = taskViewForClient(understanding() as never, {}).workflow as Record<string, unknown>;
    for (const field of ["intent", "critique", "risk", "fixRounds", "fixSource"]) expect(workflow).not.toHaveProperty(field);
    expect((workflow.pullRequests as Array<Record<string, unknown>>)[0]).not.toHaveProperty("syncedFrom");
    // A version 1.0.0 snapshot is only filtered for the fields an old reader does not know.
    const old = taskViewForClient(view({ ...base(), fixRounds: { ci: 1, conflict: 0, feedbackAuto: 0 } }) as never, {}).workflow as Record<string, unknown>;
    expect(old).not.toHaveProperty("fixRounds");
  });

  it("does not change the view when the client says it reads version 2", () => {
    const original = understanding();
    expect(TASK_VIEW_HEADER).toBe("x-agentx-task-view");
    expect(TASK_VIEW_VERSION).toBe("2");
    expect(taskViewForClient(original as never, { [TASK_VIEW_HEADER]: "2" })).toEqual(original);
    // Header names arrive in any case; any other value is the old projection.
    expect(taskViewForClient(original as never, { "X-AgentX-Task-View": "2" })).toEqual(original);
    expect(taskViewForClient(original as never, { [TASK_VIEW_HEADER]: "3" }).workflow?.stage).toBe("PLAN");
  });

  it("leaves a view with no workflow alone, and projects every task in a route's answer", () => {
    const plain = { ...view({}), workflow: undefined };
    expect(taskViewForClient(plain as never, {})).toEqual(plain);
    const answer = { task: understanding(), closed: true };
    expect(taskResponseForClient(answer, {}).task.workflow?.stage).toBe("PLAN");
    expect(taskResponseForClient(answer, {}).closed).toBe(true);
    const events = { events: [] };
    expect(taskResponseForClient(events, {})).toBe(events);
    expect(taskResponseForClient("text", {})).toBe("text");
  });

  it("is parsed by today's client schema when it is served without the header", () => {
    const projected = taskResponseForClient({ task: understanding() }, {});
    expect(DeveloperTaskResponseSchema.safeParse(projected).success).toBe(true);
  });

  it("is read by the tolerant reader with the header, keeping the stage", () => {
    const parsed = DeveloperTaskResponseSchema.safeParse({ task: understanding() });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.task.workflow).toMatchObject({ stage: "UNDERSTAND", definitionVersion: "1.1.0" });
    // The strict server schema accepts the same view.
    expect(DeveloperTaskViewSchema.safeParse(understanding()).success).toBe(true);
  });

  it("reads a stage a newer server added as unknown, and keeps fields it does not know", () => {
    const future = view({ ...v2({ stage: "CELEBRATE", state: "RUNNING", outcome: "PARTY", definitionVersion: "2.7.0" }), shiny: { a: 1 } });
    const parsed = DeveloperTaskResponseSchema.safeParse({ task: future });
    expect(parsed.success).toBe(true);
    const workflow = parsed.success ? (parsed.data.task.workflow as unknown as Record<string, unknown>) : {};
    expect(workflow).toMatchObject({ stage: "unknown", outcome: "unknown", definitionVersion: "2.7.0", shiny: { a: 1 } });
    // The strict server schema still refuses it.
    expect(DeveloperTaskViewSchema.safeParse(future).success).toBe(false);
  });

  it("reads a stage that is missing as an error, not as unknown", () => {
    const withoutStage: Record<string, unknown> = v2({ state: "RUNNING" });
    delete withoutStage.stage;
    expect(WorkflowSnapshotReaderSchema.safeParse(withoutStage).success).toBe(false);
  });
});
