// Design review stage, DR10 (3.7, owner Q5): reminders at 24 h and 72 h, park at 7 days, close at 30 days parked, resume from a card, the approver who left, and the guarantee that nothing is ever approved, answered or skipped
// by a clock. The workflow's moves (contracts), the clock (pure), the sweep over a fake table, the stream's arming, the notice's words and the notifier's delivery.
import { describe, expect, it, vi } from "vitest";
import {
  DESIGN_REVIEW_DEFAULT_SETTING, WorkflowSnapshotSchema, answerDesignQuestions, askDesignQuestions, closeDesignReview, closeParkedDesignReview, createWorkflowSnapshot, decideWorkflow, designWaitOf, enableDesignReview,
  holdDesignReviewForCost, parkDesignReview, resumeParkedDesignReview, startDesignReview, submitDesignReview, submitWorkflowArtifact,
  type DesignReviewSetting, type WorkflowProgram, type WorkflowSnapshot,
} from "../../packages/contracts/src/index.js";
import { markEffective } from "../../packages/broker/src/design-review/effective-setting.js";
import { designWaitStep, nextDesignWaitDueAt } from "../../packages/broker/src/design-review/wait-clock.js";
import { waitAudienceOf, waitRecipients } from "../../packages/broker/src/design-review/wait-audience.js";
import { DESIGN_WAIT_DUE_PK, designWaitArmOf, designWaitNoticeId, type WaitPerson } from "../../packages/broker/src/design-review/wait-rows.js";
import { settleDesignWait, sweepDesignWaits, type DesignWaitSweepDeps } from "../../packages/broker/src/design-review/wait-sweep.js";
import { designWaitWords } from "../../packages/broker/src/design-review/wait-words.js";
import { designResumeHandler, mayResumeDesignReview, type DesignResumeContext } from "../../packages/broker/src/design-review/wait-resume.js";
import { noticesOf } from "../../packages/broker/src/developer/notifications.js";
import type { DesignApproverDirectory } from "../../packages/broker/src/design-review/approval.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { recordStream } from "../support/developer-task-broker.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = "2026-11-03T12:00:00.000Z";
const T0 = Date.parse(NOW);
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const ORG = "org_aaaaaaaaaaaaaaaaaaaa";
const REQUESTER = "a".repeat(64);
const PRIYA = "b".repeat(64);
const SAM = "c".repeat(64);
const OWNER = "d".repeat(64);
const hex = (n: number): string => n.toString(16).padStart(64, "0");

const PROGRAM: WorkflowProgram = { steps: [
  { id: "plan", kind: "plan" }, { id: "plan_critic", kind: "plan_critic" }, { id: "build", kind: "build" }, { id: "check", kind: "check" },
  { id: "review", kind: "review", reviewers: ["code", "security"], onFindings: { backTo: "build", maxRounds: 3 } }, { id: "pull_request", kind: "pull_request" },
] };
const artifact = (type: "requirements" | "design", version = 1) => ({
  id: `artifact-${type}-${version}`, type, version, sha256: hex((type === "requirements" ? 1000 : 2000) + version), producer: "agentx-worker-untrusted" as const, objectKey: `k/${type}-${version}.json`, createdAt: NOW, format: "structured" as const,
});
const running = (workflow: WorkflowSnapshot): WorkflowSnapshot => ({ ...workflow, revision: workflow.revision + 1, state: "RUNNING" });

/** A Full task whose design was just submitted: PLAN_CRITIQUE/READY, review "estimating". */
function designSubmitted(reasons: Array<"new_api" | "money" | "auth"> = ["new_api"]): WorkflowSnapshot {
  const base = createWorkflowSnapshot({ taskId: TASK_ID, ownerId: REQUESTER, now: NOW, path: "QUICK", definitionVersion: "1.1.0", program: PROGRAM });
  let workflow: WorkflowSnapshot = enableDesignReview({ ...base, state: "READY" }, { expectedRevision: base.revision, start: { decidedBy: "auto", reasons, note: "Adds an API.", tier: "standard", capUsd: 10 }, now: NOW });
  workflow = submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("requirements"), now: NOW });
  workflow = decideWorkflow(workflow, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: workflow.revision, decision: "APPROVE", reason: "ok", artifactDigest: artifact("requirements").sha256 }, { actorId: REQUESTER, role: "TASK_OWNER" }, { now: NOW, allowedSkipStages: [] });
  return submitWorkflowArtifact(running(workflow), { expectedRevision: workflow.revision + 1, artifact: artifact("design"), now: NOW });
}
const started = (workflow: WorkflowSnapshot): WorkflowSnapshot => startDesignReview(workflow, { expectedRevision: workflow.revision, estimateUsd: 1, now: NOW });
const question = { id: "q1" as const, unclear: "Which queue?", evidence: [], options: [{ id: "a", label: "SQS", consequence: "Managed." }, { id: "b", label: "Own table", consequence: "More code." }], recommended: "a", why: "Fewer parts." };
const finding = { id: "f1", severity: "blocker" as const, section: "§3" as const, text: "Which queue do we use?", citations: [{ kind: "design", section: "§3" }], fromReviewers: ["critic" as const], rawIds: ["critic-f1"], fingerprint: hex(1) };
const reviewerRun = (role: "critic" | "codebase") => ({
  role, promptId: `design-${role}`, promptVersion: 1, promptDigest: hex(7), model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-5-5-v1" }, sourceId: "src_1", sessionId: `ses_${role}`, modelKeyId: `key_${role}`, packetDigest: hex(8),
  packet: [{ kind: "design", ref: "design.md", commitOrFetchedAt: "a".repeat(40), digest: hex(9), bytes: 1200 }], filesRead: [], verified: true, inputProof: "digest_only", tokensIn: 1000, tokensOut: 200, costUsd: 0.1, startedAt: NOW, endedAt: NOW,
});

/** The three waits on people, each entered at NOW. */
function answersWait(reasons: Array<"new_api" | "money" | "auth"> = ["new_api"]): WorkflowSnapshot {
  const live = started(designSubmitted(reasons));
  const round = submitDesignReview(live, { expectedRevision: live.revision, designDigest: artifact("design").sha256, reviewers: [reviewerRun("critic"), reviewerRun("codebase")], findings: [finding], now: NOW });
  const planner = running(round);
  return askDesignQuestions(planner, { expectedRevision: planner.revision, questions: [question], now: NOW });
}
const costWait = (reasons: Array<"new_api" | "money" | "auth"> = ["new_api"]): WorkflowSnapshot => holdDesignReviewForCost(designSubmitted(reasons), { expectedRevision: designSubmitted(reasons).revision, estimateUsd: 12, now: NOW });
function decisionWait(reasons: Array<"new_api" | "money" | "auth"> = ["new_api"]): WorkflowSnapshot {
  const live = started(designSubmitted(reasons));
  return closeDesignReview(live, { expectedRevision: live.revision, outcome: "not_run", notRunReason: "worker_failed", now: NOW });
}
const WAITS = { answers: answersWait, cost: costWait, decision: decisionWait } as const;

describe("the workflow's park, resume and close work on all three waits on people", () => {
  for (const kind of ["answers", "cost", "decision"] as const) {
    it(`${kind}: parks after 7 days, resumes with the clock restarted, and closes 30 days after the park as not decided`, () => {
      const wait = WAITS[kind]();
      expect(designWaitOf(wait)).toMatchObject({ kind, since: NOW });
      expect(() => parkDesignReview(wait, { expectedRevision: wait.revision, now: at(7 * DAY - 1000) })).toThrow(/long enough/);
      const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: at(7 * DAY) });
      expect(designWaitOf(parked)).toMatchObject({ kind, since: NOW, parkedAt: at(7 * DAY) });
      expect(parked.decisions).toHaveLength(wait.decisions.length);
      expect(parked.outcome).toBeUndefined();
      expect(() => parkDesignReview(parked, { expectedRevision: parked.revision, now: at(8 * DAY) })).toThrow(/already parked/);
      expect(() => closeParkedDesignReview(parked, { expectedRevision: parked.revision, now: at(37 * DAY - 1000) })).toThrow(/long enough/);
      const resumed = resumeParkedDesignReview(parked, { expectedRevision: parked.revision, by: { actorId: PRIYA }, now: at(8 * DAY) });
      expect(designWaitOf(resumed)).toMatchObject({ kind, since: at(8 * DAY), resumedBy: { actorId: PRIYA } });
      expect(designWaitOf(resumed)!.parkedAt).toBeUndefined();
      expect(() => parkDesignReview(resumed, { expectedRevision: resumed.revision, now: at(14 * DAY) })).toThrow(/long enough/);
      const closed = closeParkedDesignReview(parked, { expectedRevision: parked.revision, now: at(37 * DAY) });
      expect(closed).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED", blockReason: "Closed: nobody decided the design." });
      expect(closed.decisions).toHaveLength(wait.decisions.length);
      expect(designWaitOf(closed)).toBeUndefined();
      for (const snapshot of [parked, resumed, closed]) expect(WorkflowSnapshotSchema.safeParse(JSON.parse(JSON.stringify(snapshot))).success).toBe(true);
    });
  }

  it("a wait record left behind by an earlier wait is never read: a later wait at another revision starts from its own time", () => {
    const wait = decisionWait();
    const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: at(7 * DAY) });
    // The design was decided and sent back, and a later review ended again: the stale record names an older revision.
    const later = { ...parked, revision: parked.revision + 5, updatedAt: at(20 * DAY) };
    expect(designWaitOf(later)).toEqual({ kind: "decision", since: at(20 * DAY) });
  });

  it("an answer on a parked wait for answers still resolves it, and a decision on a parked design card is still the person's (no resume needed)", () => {
    const answers = answersWait();
    const parked = parkDesignReview(answers, { expectedRevision: answers.revision, now: at(7 * DAY) });
    expect(answerDesignQuestions(parked, { expectedRevision: parked.revision, answers: [{ questionId: "q1", optionId: "a" }], by: { actorId: PRIYA }, now: at(8 * DAY) })).toMatchObject({ state: "READY", designReview: { status: "resolving" } });
    const decision = decisionWait();
    const parkedDecision = parkDesignReview(decision, { expectedRevision: decision.revision, now: at(7 * DAY) });
    const approved = decideWorkflow(parkedDecision, { requestId: "33333333-3333-4333-8333-333333333333", expectedRevision: parkedDecision.revision, decision: "APPROVE", reason: "ok", artifactDigest: artifact("design").sha256 }, { actorId: REQUESTER, role: "TASK_OWNER" }, { now: at(8 * DAY), allowedSkipStages: [] });
    expect(approved.decisions.length).toBe(parkedDecision.decisions.length + 1);
    expect(approved.stage).not.toBe("PLAN_REVIEW");
  });
});

describe("the clock: 23 h, 24 h, 72 h, 7 days, 30 days parked", () => {
  const stepAt = (workflow: WorkflowSnapshot, ms: number) => designWaitStep(workflow, T0 + ms)?.step;
  for (const kind of ["answers", "cost", "decision"] as const) {
    it(`${kind}: nothing at 23 h, a reminder at 24 h, the second at 72 h, a park at 7 d`, () => {
      const wait = WAITS[kind]();
      expect(stepAt(wait, 23 * HOUR)).toEqual({ kind: "none" });
      expect(stepAt(wait, 24 * HOUR)).toEqual({ kind: "remind", hours: 24 });
      expect(stepAt(wait, 71 * HOUR)).toEqual({ kind: "remind", hours: 24 });
      expect(stepAt(wait, 72 * HOUR)).toEqual({ kind: "remind", hours: 72 });
      expect(stepAt(wait, 7 * DAY - 1)).toEqual({ kind: "remind", hours: 72 });
      expect(stepAt(wait, 7 * DAY)).toEqual({ kind: "park" });
      const parked = parkDesignReview(wait, { expectedRevision: wait.revision, now: at(7 * DAY) });
      expect(stepAt(parked, 37 * DAY - 1)).toEqual({ kind: "none" });
      expect(stepAt(parked, 37 * DAY)).toEqual({ kind: "close" });
    });
  }
  it("says when the next thing is due, and a task that is not waiting has no step", () => {
    const wait = answersWait();
    const waiting = designWaitOf(wait)!;
    expect(nextDesignWaitDueAt(waiting, T0)).toBe(T0 + 24 * HOUR);
    expect(nextDesignWaitDueAt(waiting, T0 + 24 * HOUR)).toBe(T0 + 72 * HOUR);
    expect(nextDesignWaitDueAt(waiting, T0 + 72 * HOUR)).toBe(T0 + 7 * DAY);
    expect(nextDesignWaitDueAt(waiting, T0 + 7 * DAY)).toBeUndefined();
    expect(designWaitStep(designSubmitted(), T0 + 40 * DAY)).toBeUndefined();
  });
});

const dir = (extra: Partial<DesignApproverDirectory> = {}, eligible: string[] = [PRIYA, SAM]): DesignApproverDirectory => ({
  people: { complete: true, membershipVersion: 3, ownerIds: [OWNER], eligibleIds: eligible, lastEligibleLossAtMs: null },
  projectMemberIds: [REQUESTER, ...eligible], notApproverIds: [], ...extra,
});
const setting = (approver: DesignReviewSetting["highRiskApprover"] = { kind: "maintainers" }) => markEffective({ ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: approver });

describe("who is told", () => {
  const base = { requesterId: REQUESTER, edition: undefined };
  it("a low-risk wait is on the requester at 24 h, and the maintainers are told from 72 h", () => {
    const audience = waitAudienceOf({ ...base, kind: "decision", reasons: ["new_api"], setting: setting(), directory: dir() });
    expect(audience).toMatchObject({ asked: [REQUESTER], maintainers: [PRIYA, SAM], code: "normal" });
    expect(waitRecipients(audience, "24h", REQUESTER)).toEqual([REQUESTER]);
    expect(waitRecipients(audience, "72h", REQUESTER)).toEqual([REQUESTER, PRIYA, SAM]);
  });
  it("a high-risk design is on the configured approver", () => {
    const audience = waitAudienceOf({ ...base, kind: "decision", reasons: ["money"], setting: setting({ kind: "people", memberIds: [PRIYA] }), directory: dir() });
    expect(audience.asked).toEqual([PRIYA, REQUESTER]);
    expect(audience.code).toBe("normal");
  });
  it("THE APPROVER LEFT: the named approver is no longer a member, so the remaining eligible people (the maintainers) are asked", () => {
    const audience = waitAudienceOf({ ...base, kind: "decision", reasons: ["auth"], setting: setting({ kind: "people", memberIds: ["e".repeat(64)] }), directory: dir() });
    expect(audience.code).toBe("approver_left");
    expect(audience.asked).toEqual([PRIYA, SAM, REQUESTER]);
    // One of two named approvers left: the other is asked and it is said that one left.
    const partly = waitAudienceOf({ ...base, kind: "decision", reasons: ["auth"], setting: setting({ kind: "people", memberIds: [PRIYA, "e".repeat(64)] }), directory: dir() });
    expect(partly).toMatchObject({ code: "approver_left", asked: [PRIYA, REQUESTER] });
  });
  it("with nobody eligible, the requester and the company's owners are told so", () => {
    const audience = waitAudienceOf({ ...base, kind: "decision", reasons: ["money"], setting: setting({ kind: "people", memberIds: ["e".repeat(64)] }), directory: dir({}, []) });
    expect(audience).toMatchObject({ code: "nobody_eligible", asked: [REQUESTER], escalate: [OWNER] });
    expect(waitRecipients(audience, "24h", REQUESTER)).toEqual([REQUESTER, OWNER]);
  });
  it("a directory that cannot be read tells the requester alone and guesses nobody", () => {
    expect(waitAudienceOf({ ...base, kind: "answers", reasons: ["money"], setting: setting(), directory: undefined })).toEqual({ asked: [REQUESTER], maintainers: [], escalate: [], code: "unreadable" });
    const incomplete = dir(); incomplete.people = { ...incomplete.people, complete: false };
    expect(waitAudienceOf({ ...base, kind: "answers", reasons: ["money"], setting: setting(), directory: incomplete }).code).toBe("unreadable");
  });
});

describe("the notice's words", () => {
  const link = "<https://app.example.test/review/t/task|Open the task>";
  it("says what is waiting, who can act and where, in plain words, once per step", () => {
    const text = designWaitWords({ step: "24h", kind: "decision", audience: "normal", title: "Retry payments", people: ["Priya", "Sam"], link });
    expect(text).toContain("a decision on its design");
    expect(text).toContain("Waiting on Priya and Sam.");
    expect(text).toContain(link);
    expect(designWaitWords({ step: "72h", kind: "answers", audience: "normal", title: "T", people: [], link: undefined })).toContain("three days");
    expect(designWaitWords({ step: "parked", kind: "cost", audience: "normal", title: "T", people: [], link })).toContain("closed as not decided");
    expect(designWaitWords({ step: "closed", kind: "decision", audience: "normal", title: "T", people: [], link })).toMatch(/^Closed: nobody decided the design/);
  });
  it("says so when the approver left, and when nobody can decide", () => {
    expect(designWaitWords({ step: "72h", kind: "decision", audience: "approver_left", title: "T", people: ["Priya"], link })).toContain("went to Priya, who can");
    expect(designWaitWords({ step: "24h", kind: "decision", audience: "nobody_eligible", title: "T", people: [], link })).toContain("A project owner needs to name a new approver");
  });
});

// ---- the sweep over a fake table

interface World { db: FakeDynamoDb; now: { ms: number }; deps: DesignWaitSweepDeps; released: string[]; enabled: { on: boolean }; log: Array<Record<string, unknown>> }
const PEOPLE = new Map<string, WaitPerson>([
  [REQUESTER, { name: "Maya", slackUserId: "UREQUESTER" }], [PRIYA, { name: "Priya", slackUserId: "UPRIYA" }], [SAM, { name: "Sam", slackUserId: "USAM" }], [OWNER, { name: "Olu", slackUserId: "UOWNER" }],
]);

function world(workflow: WorkflowSnapshot, options: { setting?: ReturnType<typeof setting>; directory?: DesignApproverDirectory | undefined } = {}): World {
  const db = new FakeDynamoDb();
  const now = { ms: T0 };
  const enabled = { on: true };
  const released: string[] = [];
  const log: Array<Record<string, unknown>> = [];
  db.set({
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: ORG, project: "payments", title: "Retry payments", workspaceId: "ws1", developerId: REQUESTER, developerName: "Maya", provider: "slack",
    slackUserId: "UREQUESTER", ownerKey: REQUESTER, workflow,
  });
  const deps: DesignWaitSweepDeps = {
    documentClient: db, tableName: "state", now: () => now.ms, enabledFor: async () => enabled.on, edition: undefined,
    setting: async () => options.setting ?? setting(),
    directory: async () => ("directory" in options ? options.directory : dir()),
    people: async (_org, ids) => new Map(ids.flatMap((id) => (PEOPLE.has(id) ? [[id, PEOPLE.get(id)!] as const] : []))),
    releaseKeys: async (task) => { released.push(task.taskId); },
    log: (entry) => log.push(entry),
  };
  return { db, now, deps, released, enabled, log };
}
/** The stream arms the wait row, as the notifier does when the task's workflow changes. */
const armed = async (w: World): Promise<void> => {
  const task = w.db.get(`DEVTASK#${TASK_ID}`, "META") as { workflow: WorkflowSnapshot };
  const update = designWaitArmOf({ tableName: "state", taskId: TASK_ID, orgId: ORG, workflow: task.workflow, nowMs: w.now.ms })!;
  const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
  await w.db.send(new UpdateCommand(update as never));
};
const taskOf = (w: World) => w.db.get(`DEVTASK#${TASK_ID}`, "META") as { workflow: WorkflowSnapshot; closedAt?: string };
const notifyRows = (w: World) => w.db.find((item) => item.entityType === "DESIGN_WAIT_NOTIFY").sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
const waitRow = (w: World) => w.db.get(`DEVTASK#${TASK_ID}`, "DESIGN_WAIT")!;

describe("the sweep", () => {
  it("arming puts the wait in the due index at 24 h; a task that is not waiting is not armed", async () => {
    const w = world(answersWait());
    await armed(w);
    expect(waitRow(w)).toMatchObject({ entityType: "DESIGN_WAIT", workflowRevision: taskOf(w).workflow.revision, waitKind: "answers", dispatchDuePk: DESIGN_WAIT_DUE_PK, dispatchDueSk: `${at(24 * HOUR)}#${TASK_ID}` });
    expect(designWaitArmOf({ tableName: "state", taskId: TASK_ID, workflow: designSubmitted(), nowMs: T0 })).toBeUndefined();
  });

  for (const kind of ["answers", "cost", "decision"] as const) {
    it(`${kind}: nothing at 23 h; the reminder at 24 h; the second at 72 h (to the maintainers too); the park at 7 d with the keys released; the close at 30 d parked`, async () => {
      const w = world(WAITS[kind]());
      await armed(w);
      w.now.ms = T0 + 23 * HOUR;
      expect(await sweepDesignWaits(w.deps)).toMatchObject({ attempted: 0 });
      expect(notifyRows(w)).toHaveLength(0);

      w.now.ms = T0 + 24 * HOUR;
      expect(await sweepDesignWaits(w.deps)).toMatchObject({ attempted: 1, reminded: 1 });
      expect(notifyRows(w)).toHaveLength(1);
      expect(notifyRows(w)[0]).toMatchObject({ step: "24h", waitKind: kind, audience: "normal", dm: ["UREQUESTER"], status: "PENDING" });
      expect(waitRow(w).dispatchDueSk).toBe(`${at(72 * HOUR)}#${TASK_ID}`);

      w.now.ms = T0 + 72 * HOUR;
      expect(await sweepDesignWaits(w.deps)).toMatchObject({ reminded: 1 });
      expect(notifyRows(w).map((row) => row.step)).toEqual(["24h", "72h"]);
      expect(notifyRows(w)[1]!.dm).toEqual(["UREQUESTER", "UPRIYA", "USAM"]);
      expect(w.released).toEqual([]);

      w.now.ms = T0 + 7 * DAY;
      const before = taskOf(w).workflow;
      expect(await sweepDesignWaits(w.deps)).toMatchObject({ parked: 1 });
      const parked = taskOf(w).workflow;
      expect(designWaitOf(parked)).toMatchObject({ kind, parkedAt: at(7 * DAY) });
      expect(w.released).toEqual([TASK_ID]);
      expect(parked.decisions).toHaveLength(before.decisions.length);
      expect(parked.outcome).toBeUndefined();
      expect(notifyRows(w).map((row) => row.step)).toContain("parked");
      expect(waitRow(w).dispatchDueSk).toBe(`${at(37 * DAY)}#${TASK_ID}`);

      w.now.ms = T0 + 37 * DAY;
      expect(await sweepDesignWaits(w.deps)).toMatchObject({ closed: 1 });
      expect(taskOf(w).workflow).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "CLOSED" });
      expect(taskOf(w).workflow.decisions).toHaveLength(before.decisions.length);
      expect(w.released).toEqual([TASK_ID, TASK_ID]);
      expect(w.db.get("FINISHED_RELEASE", `TASK#${TASK_ID}`)).toMatchObject({ taskId: TASK_ID });
      expect(notifyRows(w).map((row) => row.step)).toContain("closed");
      expect(waitRow(w).dispatchDuePk).toBeUndefined();
    });
  }

  it("never approves, answers or skips: after every step the decisions, the answers and the review's status are as they were", async () => {
    const w = world(answersWait());
    await armed(w);
    const first = taskOf(w).workflow;
    for (const ms of [24 * HOUR, 72 * HOUR, 7 * DAY, 37 * DAY]) { w.now.ms = T0 + ms; await sweepDesignWaits(w.deps); }
    const last = taskOf(w).workflow;
    expect(last.decisions).toEqual(first.decisions);
    expect(last.designReview!.rounds[0]!.answers).toBeUndefined();
    expect(last.designReview!.status).toBe("waiting_answers");
    expect(last.designReview!.skippedBy).toBeUndefined();
    expect(last.outcome).toBe("CLOSED");
  });

  it("reminders are idempotent across repeated sweeps, and a sweep with nothing due does nothing", async () => {
    const w = world(decisionWait());
    await armed(w);
    w.now.ms = T0 + 25 * HOUR;
    await sweepDesignWaits(w.deps);
    // The same wait looked at again (a concurrent sweep, a retry): the row, put back in the index by hand, sends nothing new.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await armed(w);
      w.db.set({ ...waitRow(w), dispatchDueSk: `${at(24 * HOUR)}#${TASK_ID}` });
      const result = await sweepDesignWaits(w.deps);
      expect(result.reminded).toBe(0);
    }
    expect(notifyRows(w)).toHaveLength(1);
    expect(await sweepDesignWaits(w.deps)).toMatchObject({ attempted: 0 });
  });

  it("the second reminder is not preceded by a late first one when the sweep was down", async () => {
    const w = world(decisionWait());
    await armed(w);
    w.now.ms = T0 + 73 * HOUR;
    await sweepDesignWaits(w.deps);
    expect(notifyRows(w).map((row) => row.step)).toEqual(["72h"]);
  });

  it("OFF: with the switch off for the project nothing is written, parked or closed, and the row is looked at again in an hour", async () => {
    const w = world(decisionWait());
    await armed(w);
    w.enabled.on = false;
    w.now.ms = T0 + 40 * DAY;
    const before = structuredClone(taskOf(w));
    expect(await sweepDesignWaits(w.deps)).toMatchObject({ attempted: 1, reminded: 0, parked: 0, closed: 0 });
    expect(taskOf(w)).toEqual(before);
    expect(notifyRows(w)).toHaveLength(0);
    expect(waitRow(w).dispatchDueSk).toBe(`${at(40 * DAY + HOUR)}#${TASK_ID}`);
    expect(w.released).toEqual([]);
    // Switched on again, the wait is picked up where it stands.
    w.enabled.on = true;
    w.now.ms = T0 + 40 * DAY + HOUR;
    expect(await sweepDesignWaits(w.deps)).toMatchObject({ parked: 1 });
  });

  it("OFF and a cost hold: the hold ends as every step of a switched-off review does, not run (switched_off), at the person's card; a wait for answers or a decision is left alone", async () => {
    const w = world(costWait());
    await armed(w);
    w.enabled.on = false;
    w.now.ms = T0 + 25 * HOUR;
    const decisions = taskOf(w).workflow.decisions.length;
    await sweepDesignWaits(w.deps);
    expect(taskOf(w).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "not_run", notRunReason: "switched_off" } });
    expect(taskOf(w).workflow.decisions).toHaveLength(decisions);
    expect(notifyRows(w)).toHaveLength(0);
    for (const kind of ["answers", "decision"] as const) {
      const other = world(WAITS[kind]());
      await armed(other);
      other.enabled.on = false;
      other.now.ms = T0 + 25 * HOUR;
      const before = structuredClone(taskOf(other));
      await sweepDesignWaits(other.deps);
      expect(taskOf(other)).toEqual(before);
    }
  });

  it("THE APPROVER LEFT: a high-risk design's reminder goes to the remaining eligible people, and says so", async () => {
    const w = world(decisionWait(["auth"]), { setting: setting({ kind: "people", memberIds: ["e".repeat(64)] }) });
    await armed(w);
    w.now.ms = T0 + 24 * HOUR;
    await sweepDesignWaits(w.deps);
    expect(notifyRows(w)[0]).toMatchObject({ audience: "approver_left", dm: ["UREQUESTER", "UPRIYA", "USAM"] });
  });

  it("with nobody eligible the notice says so to the requester and an owner", async () => {
    const w = world(decisionWait(["money"]), { setting: setting({ kind: "people", memberIds: ["e".repeat(64)] }), directory: dir({}, []) });
    await armed(w);
    w.now.ms = T0 + 24 * HOUR;
    await sweepDesignWaits(w.deps);
    expect(notifyRows(w)[0]).toMatchObject({ audience: "nobody_eligible", dm: ["UREQUESTER", "UOWNER"] });
  });

  it("a directory that cannot be read tells the requester alone", async () => {
    const w = world(answersWait(["money"]), { directory: undefined });
    await armed(w);
    w.now.ms = T0 + 72 * HOUR;
    await sweepDesignWaits(w.deps);
    expect(notifyRows(w)[0]).toMatchObject({ audience: "unreadable", dm: ["UREQUESTER"] });
  });

  it("a task that moved on (a person answered) is left alone: the row is dropped from the index and nothing is sent", async () => {
    const w = world(answersWait());
    await armed(w);
    const wait = taskOf(w).workflow;
    const answered = answerDesignQuestions(wait, { expectedRevision: wait.revision, answers: [{ questionId: "q1", optionId: "a" }], by: { actorId: PRIYA }, now: at(2 * HOUR) });
    w.db.set({ ...(w.db.get(`DEVTASK#${TASK_ID}`, "META")!), workflow: answered });
    w.now.ms = T0 + 25 * HOUR;
    expect(await sweepDesignWaits(w.deps)).toMatchObject({ attempted: 1, reminded: 0 });
    expect(notifyRows(w)).toHaveLength(0);
    expect(waitRow(w).dispatchDuePk).toBeUndefined();
  });

  it("a park that loses a race with a person's answer changes nothing", async () => {
    const w = world(answersWait());
    await armed(w);
    w.now.ms = T0 + 7 * DAY;
    const wait = taskOf(w).workflow;
    const answered = answerDesignQuestions(wait, { expectedRevision: wait.revision, answers: [{ questionId: "q1", optionId: "a" }], by: { actorId: PRIYA }, now: at(7 * DAY - 1) });
    // The sweep read the task before the answer landed: its write is conditional on the old revision.
    const read = w.db.send;
    let first = true;
    w.deps.documentClient = { send: async (command: unknown) => {
      const result = await read(command as never);
      if (first && (command as { constructor: { name: string } }).constructor.name === "GetCommand") { first = false; w.db.set({ ...(w.db.get(`DEVTASK#${TASK_ID}`, "META")!), workflow: answered }); }
      return result;
    } };
    const outcome = await settleDesignWait(w.deps, TASK_ID, wait.revision);
    expect(outcome).toBe("stale");
    expect(taskOf(w).workflow.designReview!.status).toBe("resolving");
    expect(notifyRows(w)).toHaveLength(0);
  });

  it("a NOTIFY row becomes one design_wait notice, once, with a stable id", () => {
    const row = { entityType: "DESIGN_WAIT_NOTIFY", taskId: TASK_ID, workflowRevision: 7, step: "72h", status: "PENDING", pk: `DEVTASK#${TASK_ID}`, sk: "DESIGN_WAIT_NOTIFY#7#72h" };
    expect(noticesOf(undefined, row, NOW, "e1")).toEqual([{ id: designWaitNoticeId(TASK_ID, 7, "72h"), kind: "design_wait", taskId: TASK_ID, at: NOW, workflowRevision: 7, designWaitStep: "72h" }]);
    expect(noticesOf(row, row, NOW, "e2")).toEqual([]);
    expect(noticesOf(undefined, { ...row, step: "later" }, NOW, "e3")).toEqual([]);
  });
});

describe("end to end: the stream arms the wait, the sweep writes the reminder, the notifier says it once", () => {
  async function line(options: { shared?: boolean } = {}) {
    const w = world(decisionWait());
    const stream = recordStream(w.db);
    const posts: Array<{ channel: string; threadTs?: string; text: string }> = [];
    const queue: Notice[] = [];
    const logs: Array<Record<string, unknown>> = [];
    if (options.shared !== false) w.db.set({ ...(w.db.get(`DEVTASK#${TASK_ID}`, "META")!), share: { channelId: "C1", threadTs: "1.1", sharedAt: "2020-01-01T00:00:00.000Z", teamId: "T1" } });
    const handle = createNotifierHandler({
      documentClient: w.db, tableName: "state", enqueue: async (notices) => { queue.push(...notices); }, retryLater: async () => undefined,
      post: async (input) => { posts.push(input); return { ts: "9.9" }; }, now: () => w.now.ms, log: (entry) => logs.push(entry), deliveryFailed: () => undefined, reviewUrlBase: "https://app.example.test",
    });
    const pump = async (): Promise<void> => {
      await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
      const batch = queue.splice(0, queue.length);
      await handle({ Records: batch.map((notice, index) => ({ eventSource: "aws:sqs", messageId: `m${String(index)}`, receiptHandle: `r${String(index)}`, body: JSON.stringify(notice) })) });
    };
    return { w, pump, posts, logs, stream };
  }

  it("a task that enters a wait is armed from its own change; the reminder is posted to the people and the thread, once", async () => {
    const { w, pump, posts } = await line();
    // The task changes (the design review ends and waits): the stream's record arms it.
    const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
    await w.db.send(new UpdateCommand({ TableName: "state", Key: { pk: `DEVTASK#${TASK_ID}`, sk: "META" }, UpdateExpression: "SET updatedAt = :now", ExpressionAttributeValues: { ":now": NOW } }));
    await pump();
    expect(waitRow(w)).toMatchObject({ dispatchDuePk: DESIGN_WAIT_DUE_PK, dispatchDueSk: `${at(24 * HOUR)}#${TASK_ID}`, waitKind: "decision" });

    w.now.ms = T0 + 24 * HOUR;
    await sweepDesignWaits(w.deps);
    await pump();
    expect(posts.map((post) => post.channel)).toEqual(["UREQUESTER", "C1"]);
    expect(posts[0]!.text).toContain('"Retry payments"');
    expect(posts[0]!.text).toContain("a decision on its design");
    expect(posts[0]!.text).toContain(`<https://app.example.test/review/${TASK_ID}/task|Open the task>`);
    expect(posts[1]!.threadTs).toBe("1.1");

    // The same notice delivered again (a redelivery) posts nothing more.
    const again: Notice = { id: designWaitNoticeId(TASK_ID, taskOf(w).workflow.revision, "24h"), kind: "design_wait", taskId: TASK_ID, at: NOW, workflowRevision: taskOf(w).workflow.revision, designWaitStep: "24h" };
    await createNotifierHandler({ documentClient: w.db, tableName: "state", enqueue: async () => undefined, retryLater: async () => undefined, post: async (input) => { posts.push(input); return { ts: "9.9" }; }, now: () => w.now.ms, log: () => undefined, deliveryFailed: () => undefined })({ Records: [{ eventSource: "aws:sqs", messageId: "x", receiptHandle: "x", body: JSON.stringify(again) }] });
    expect(posts).toHaveLength(2);
  });

  it("a person who decided meanwhile is not told a stale reminder", async () => {
    const { w, pump, posts } = await line();
    await armed(w);
    w.now.ms = T0 + 24 * HOUR;
    await sweepDesignWaits(w.deps);
    const wait = taskOf(w).workflow;
    const decided = decideWorkflow(wait, { requestId: "44444444-4444-4444-8444-444444444444", expectedRevision: wait.revision, decision: "APPROVE", reason: "ok", artifactDigest: artifact("design").sha256 }, { actorId: REQUESTER, role: "TASK_OWNER" }, { now: at(24 * HOUR + 5), allowedSkipStages: [] });
    w.db.set({ ...(w.db.get(`DEVTASK#${TASK_ID}`, "META")!), workflow: decided });
    await pump();
    expect(posts).toHaveLength(0);
  });

  it("only the broker's rows reach the notice: a park says it paused, the close says nobody decided", async () => {
    const { w, pump, posts } = await line({ shared: false });
    await armed(w);
    w.now.ms = T0 + 7 * DAY;
    await sweepDesignWaits(w.deps);
    await pump();
    expect(posts.map((post) => post.channel)).toEqual(["UREQUESTER", "UPRIYA", "USAM"]);
    expect(posts[0]!.text).toMatch(/^Paused: "Retry payments" has waited a week/);
    w.now.ms = T0 + 37 * DAY;
    await sweepDesignWaits(w.deps);
    await pump();
    expect(posts.at(-1)!.text).toMatch(/^Closed: nobody decided the design/);
  });
});

describe("resume from a card", () => {
  const parkedOf = (workflow: WorkflowSnapshot): WorkflowSnapshot => parkDesignReview(workflow, { expectedRevision: workflow.revision, now: at(7 * DAY) });
  const context = (workflow: WorkflowSnapshot, extra: Partial<DesignResumeContext> = {}): DesignResumeContext => ({ taskId: TASK_ID, requesterId: REQUESTER, workflow, setting: setting(), directory: dir(), edition: undefined, ...extra });

  it("the people the wait is on, and the maintainers, may resume; an outsider, a viewer and an Auditor may not; a wait that is not parked cannot be resumed", () => {
    const parked = parkedOf(decisionWait());
    expect(mayResumeDesignReview({ callerId: REQUESTER, context: context(parked) })).toBe(true);
    expect(mayResumeDesignReview({ callerId: PRIYA, context: context(parked) })).toBe(true);
    expect(mayResumeDesignReview({ callerId: "f".repeat(64), context: context(parked) })).toBe(false);
    expect(mayResumeDesignReview({ callerId: PRIYA, context: context(parked, { directory: dir({ notApproverIds: [PRIYA] }) }) })).toBe(false);
    expect(mayResumeDesignReview({ callerId: REQUESTER, context: context(decisionWait()) })).toBe(false);
  });

  it("the approver who left: a maintainer can resume a high-risk design; the named approver who left cannot", () => {
    const parked = parkedOf(decisionWait(["auth"]));
    const left = { setting: setting({ kind: "people" as const, memberIds: ["e".repeat(64)] }) };
    expect(mayResumeDesignReview({ callerId: SAM, context: context(parked, left) })).toBe(true);
    expect(mayResumeDesignReview({ callerId: "e".repeat(64), context: context(parked, { ...left, directory: dir({ projectMemberIds: [REQUESTER, PRIYA, SAM] }) }) })).toBe(false);
  });

  it("resumes the review, records who, and commits conditionally on the revision; it answers and approves nothing", async () => {
    const parked = parkedOf(answersWait());
    const commit = vi.fn(async () => "done" as const);
    const handler = designResumeHandler({ context: async () => context(parked), commit, now: () => T0 + 8 * DAY });
    await expect(handler({ developerId: PRIYA }, { taskId: TASK_ID, requestId: "r1" })).resolves.toEqual({ kind: "done" });
    expect(commit).toHaveBeenCalledWith({ developerId: PRIYA }, expect.objectContaining({ taskId: TASK_ID, actorId: PRIYA, workflow: parked }));
    const outsider = designResumeHandler({ context: async () => context(parked), commit, now: () => T0 + 8 * DAY });
    await expect(outsider({ developerId: "f".repeat(64) }, { taskId: TASK_ID, requestId: "r2" })).rejects.toThrow(/no longer waiting/);
    const stale = designResumeHandler({ context: async () => context(parked), commit: async () => "stale", now: () => T0 + 8 * DAY });
    await expect(stale({ developerId: PRIYA }, { taskId: TASK_ID, requestId: "r3" })).rejects.toThrow(/changed/);
  });
});
