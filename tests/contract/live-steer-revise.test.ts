// Revise the plan with this change (broker side). The owner's live message stopped coding for re-approval; the owner can press one action that plans again with that message and asks them to
// approve the revised plan through the existing plan approval. These tests: what the stop records (the owner's message ids, bound to the blocked revision), the message's own mark, and the press
// itself on the real broker (owner only, idempotent, fail closed, nothing about the message's text in a log, an event, a decision or the workflow).
import { describe, expect, it } from "vitest";
import { LIVE_STEER_REAPPROVAL_REASON, LIVE_STEER_REVISED_REASON, WORKFLOW_BLOCK_REASONS, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, agentSessionKey } from "../../packages/contracts/src/index.js";
import { settleLiveSteerReapproval } from "../../packages/broker/src/agent-sessions/live-steer-reapproval.js";
import { deliverSteerLive, markSteerRevised } from "../../packages/broker/src/agent-sessions/steer.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ORG_A, PRIYA } from "../support/agent-session-world.js";
import { liveSteerWorld } from "../support/live-steer-world.js";

const stop = (messageId: string) => `CONFIG_INVALID: ${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE} (${messageId})`;

/** A world whose message to the running step was taken live, and whose task's coding step then stopped with `reason` at revision 4. */
async function blockedWorld(reason: string = WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise, stage = "IMPLEMENT") {
  const f = liveSteerWorld();
  const message = await f.send(PRIYA);
  const deps = { documentClient: f.w.db, tableName: "state", now: () => f.w.clock.now };
  await deliverSteerLive(deps, ORG_A, f.made.sessionId, message.messageId, f.made.taskId);
  f.w.db.set({ ...f.w.db.get(taskKey(f.made.taskId))!, workflow: { revision: 4, stage, state: "BLOCKED", blockReason: reason } });
  const messageRow = () => f.w.db.get({ pk: agentSessionKey(ORG_A, f.made.sessionId, "META").pk, sk: `MESSAGE#${message.messageId}` }) as Record<string, unknown>;
  const task = () => f.w.db.get(taskKey(f.made.taskId)) as Record<string, unknown>;
  return { f, message, deps, messageRow, task };
}

describe("what a re-approval stop records for Revise the plan", () => {
  it("records the owner's message ids with the blocked revision, for a coding step blocked with the revise reason, and never the text", async () => {
    const s = await blockedWorld();
    await settleLiveSteerReapproval(s.deps, s.f.made.taskId, stop(s.message.messageId));
    expect(s.task()["liveSteerChange"]).toEqual({ workflowRevision: 4, messageIds: [s.message.messageId], at: new Date(s.f.w.clock.now).toISOString() });
    expect(JSON.stringify(s.task()["liveSteerChange"])).not.toContain("LIVE-TEXT-4471");
    // A repeat is the same record.
    await settleLiveSteerReapproval(s.deps, s.f.made.taskId, stop(s.message.messageId));
    expect((s.task()["liveSteerChange"] as { messageIds: string[] }).messageIds).toEqual([s.message.messageId]);
  });

  it("records nothing for any other block: the round-2 coding reason (the plan cannot take the change), Understand, Plan, or a workflow that moved on", async () => {
    for (const [reason, stage] of [[WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding, "IMPLEMENT"], [WORKFLOW_BLOCK_REASONS.liveSteerReapproval, "PLAN"], [WORKFLOW_BLOCK_REASONS.liveSteerReapproval, "UNDERSTAND"]] as const) {
      const s = await blockedWorld(reason, stage);
      await settleLiveSteerReapproval(s.deps, s.f.made.taskId, stop(s.message.messageId));
      expect(s.task()["liveSteerChange"], `${stage} ${reason}`).toBeUndefined();
      // The message is still marked: the stop's own mark does not depend on the record.
      expect(s.messageRow()["delivery"]).toMatchObject({ reason: LIVE_STEER_REAPPROVAL_REASON });
    }
    const moved = await blockedWorld();
    moved.f.w.db.set({ ...moved.task(), workflow: { revision: 5, stage: "IMPLEMENT", state: "RUNNING" } });
    await settleLiveSteerReapproval(moved.deps, moved.f.made.taskId, stop(moved.message.messageId));
    expect(moved.task()["liveSteerChange"]).toBeUndefined();
  });
});

describe("the message's own mark when its owner chose Revise the plan", () => {
  it("a message that stopped coding becomes 'plan being revised' once, the timeline says so without the text, and any other message is left alone", async () => {
    const s = await blockedWorld();
    await settleLiveSteerReapproval(s.deps, s.f.made.taskId, stop(s.message.messageId));
    expect(await markSteerRevised(s.deps, ORG_A, s.f.made.sessionId, s.message.messageId)).toBe(true);
    expect(s.messageRow()["delivery"]).toMatchObject({ state: "delivered", reason: LIVE_STEER_REVISED_REASON });
    const events = s.f.w.db.find((item) => item.pk === agentSessionKey(ORG_A, s.f.made.sessionId, "META").pk && String(item.sk).startsWith("EVENT#") && item["messageId"] === s.message.messageId);
    expect(events.find((item) => String(item["text"]).includes("revising the plan"))).toMatchObject({ type: "status", actor: { kind: "agent" } });
    expect(JSON.stringify(events)).not.toContain("LIVE-TEXT-4471");
    // Once: a repeat changes nothing.
    expect(await markSteerRevised(s.deps, ORG_A, s.f.made.sessionId, s.message.messageId)).toBe(false);
    // A message that never stopped coding (delivered with no reason) is not moved.
    const plain = await blockedWorld();
    expect(await markSteerRevised(plain.deps, ORG_A, plain.f.made.sessionId, plain.message.messageId)).toBe(false);
    expect(plain.messageRow()["delivery"]).not.toHaveProperty("reason");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The press, on the real broker: a Quick task whose approved plan is being coded, the owner's live message stops coding for re-approval, and the owner presses Revise the plan.
import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { WORKFLOW_REVISE_PLAN_DECISION_REASON, createCandidateManifest, type WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import { developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, type Developer } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { REVISE_PLAN_REFUSALS } from "../../packages/broker/src/agent-sessions/live-steer-revise.js";
import { getTaskDocumentView } from "../../packages/broker/src/aws/developer-tasks.js";
import { createTaskWebApi, type TaskWebApiDependencies } from "../../packages/broker/src/aws/task-web-api.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { DEV_ISSUER } from "../support/developer-task-broker.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const MESSAGE_ID = "msg_0123456789abcdefghij";
const SESSION_ID = "ses_00000000000000000001";
const TEXT = "also add a retry to the v2 endpoint, token LIVE-TEXT-4471";
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const taskRow = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; orgId: string };
const workflowOf = (harness: Harness, taskId: string) => taskRow(harness, taskId).workflow;
const outboxPrompt = (harness: Harness, operationId: string) => String((harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { payload: { prompt?: string } }).payload.prompt);
const messageKey = (orgId: string, id = MESSAGE_ID) => agentSessionKey(orgId, SESSION_ID, `MESSAGE#${id}`);

/**
 * A Quick task whose coding plan was approved, with the owner's (or `author`'s) live message given to the running coding step, which then stopped for re-approval. `seed: false` leaves the session
 * and message unwritten (a stop that recorded nothing usable).
 */
async function codingStoppedForLiveChange(options: { author?: Developer; messageReason?: string | null; pullRequest?: boolean; slack?: boolean } = {}) {
  const harness = await createSingleAnswerPlanBroker();
  const thread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000087" };
  const started = options.slack === true
    ? await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread, userId: MAYA.slackUserId, instructions: "Fix the retry bug", workflowPath: "QUICK", requestId: randomUUID() })
    : await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = options.slack === true ? String((JSON.parse((started as { body: string }).body) as { taskId: string }).taskId)
    : String(((started as unknown as { body: { task: { taskId: string } } }).body.task).taskId);
  const workspaceId = String(taskRow(harness, taskId)["workspaceId"]);
  const orgId = String(taskRow(harness, taskId).orgId);
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
  const digest = createHash("sha256").update(plan).digest("hex");
  const approval = { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest };
  if (options.slack === true) await harness.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId, userId: MAYA.slackUserId, thread, selectedOptionalCheckIds: [], ...approval });
  else await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, approval);
  const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
  // The session, and the owner's message given live to this coding step.
  // The owner is whoever the task's record says (a Slack-started task has its own developer id for the person).
  const ownerId = String(taskRow(harness, taskId)["developerId"]);
  const author = options.author ?? { developerId: ownerId, name: MAYA.name };
  const createdAt = "2026-10-30T09:00:00.000Z";
  harness.db.set({
    ...agentSessionKey(orgId, SESSION_ID, "META"), entityType: "AGENT_SESSION", orgId, sessionId: SESSION_ID, kind: "task", mode: "delegate", subject: { kind: "task", taskId }, legs: [], where: { kind: "cloud" },
    project: "payments", title: "Fix the retry bug", owner: { developerId: ownerId, name: MAYA.name }, startedBy: { kind: "member", developerId: ownerId }, origin: "app", followerCount: 0,
    summaryRevision: 1, revision: 1, createdAt, updatedAt: createdAt, summary: { status: "running", costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: "d".repeat(64), computedAt: createdAt },
  });
  harness.db.set({ ...messageKey(orgId), entityType: "AGENT_SESSION_MESSAGE", orgId, sessionId: SESSION_ID, messageId: MESSAGE_ID, kind: "steer", source: "app", author: { developerId: author.developerId, name: author.name }, text: TEXT,
    createdAt, rev: 1, delivery: { state: "delivered", at: createdAt, ...(options.messageReason === null ? {} : options.messageReason === undefined ? {} : { reason: options.messageReason }) } });
  harness.db.set({ ...taskRow(harness, taskId), sessionId: SESSION_ID });
  if (options.pullRequest === true) {
    const row = taskRow(harness, taskId);
    harness.db.set({ ...row, workflow: { ...row.workflow, pullRequests: [{ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", state: "OPEN", required: true, candidateDigest: "d".repeat(64), headSha: "e".repeat(40), observedAt: createdAt }] } });
  }
  await harness.finish(workspaceId, String(implementation.id), "FAILED", { error: `CONFIG_INVALID: ${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE} (${MESSAGE_ID})` });
  const press = (who: Developer, body: Record<string, unknown> = {}) => harness.dev(who, "POST", `/v1/dev/tasks/${taskId}/workflow/revise-plan`, { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, ...body });
  const messageRow = () => harness.db.get(messageKey(orgId).pk, messageKey(orgId).sk) as Record<string, unknown>;
  const everything = () => JSON.stringify(harness.db.find(() => true));
  return { harness, taskId, workspaceId, orgId, plan, digest, implementation, press, messageRow, everything, thread };
}

describe("Revise the plan, pressed by the owner on the real broker", () => {
  it("plans again with the owner's words, records the owner's request for changes, and starts nothing else; coding waits for the owner's approval of the revised plan", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const s = await codingStoppedForLiveChange();
      expect(workflowOf(s.harness, s.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.liveSteerReapprovalRevise });
      expect(s.messageRow()["delivery"]).toMatchObject({ reason: LIVE_STEER_REAPPROVAL_REASON });
      expect(taskRow(s.harness, s.taskId)["liveSteerChange"]).toMatchObject({ messageIds: [MESSAGE_ID] });
      const blocked = workflowOf(s.harness, s.taskId);
      const requestId = randomUUID();
      const answered = await s.press(MAYA, { requestId });
      expect(answered.status).toBe(200);
      // Planning runs, with the revision the press committed.
      const after = workflowOf(s.harness, s.taskId);
      expect(after).toMatchObject({ stage: "PLAN", state: "RUNNING", revision: blocked.revision + 2, outcome: "CHANGES_REQUESTED" });
      expect(after.blockReason).toBeUndefined();
      expect(after.decisions.at(-1)).toMatchObject({ requestId, decision: "REQUEST_CHANGES", actorId: after.ownerId, actorRole: "TASK_OWNER", reason: WORKFLOW_REVISE_PLAN_DECISION_REASON, workflowRevision: blocked.revision });
      const planning = operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "PLAN");
      expect(planning).toHaveLength(2);
      const revision = planning.find((item) => item.requestId === requestId)!;
      // The owner's own words reach the planner (the positive control for the "nothing else" checks below), as the change to make to the approved plan.
      const prompt = outboxPrompt(s.harness, String(revision.id));
      expect(prompt).toContain("Revise the current");
      expect(prompt).toContain(TEXT);
      expect(prompt).toContain("The owner approves the revised plan before any coding");
      expect(prompt).toContain("Fix retry handling.");
      // No coding is running or queued.
      expect(operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
      // The record the press used is spent, and the message says what became of it.
      expect(taskRow(s.harness, s.taskId)["liveSteerChange"]).toBeUndefined();
      expect(s.messageRow()["delivery"]).toMatchObject({ state: "delivered", reason: LIVE_STEER_REVISED_REASON });
      // The words are in the planner's prompt and the message's own row, and nowhere else: not the workflow, its decisions, the task's events or notes, the turn records, or a log line. Every stored
      // item that holds them is named: the message's own row and the planning run's outbox item (its prompt), nothing more.
      const holding = s.harness.db.find((item) => JSON.stringify(item).includes("LIVE-TEXT-4471")).map((item) => String(item.entityType)).sort();
      expect(holding).toEqual(["AGENT_SESSION_MESSAGE", "OUTBOX"]);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("LIVE-TEXT-4471");
      expect(JSON.stringify(after)).not.toContain("LIVE-TEXT-4471");
      // Positive control: the scan sees the press's own records (its turn record and its decision), so "nothing else holds the words" is not an empty search.
      expect(s.harness.db.find((item) => JSON.stringify(item).includes("Revise the plan with the owner's live message")).length).toBeGreaterThan(0);
      expect(JSON.stringify(after.decisions.at(-1))).toContain(WORKFLOW_REVISE_PLAN_DECISION_REASON);
    } finally {
      logs.mockRestore();
    }
  });

  it("is idempotent: the same request again answers as it did and starts nothing; a second press with another id after it committed is out of date", async () => {
    const s = await codingStoppedForLiveChange();
    const requestId = randomUUID();
    const expectedRevision = workflowOf(s.harness, s.taskId).revision;
    expect((await s.press(MAYA, { requestId, expectedRevision })).status).toBe(200);
    expect((await s.press(MAYA, { requestId, expectedRevision })).status).toBe(200);
    expect(operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
    const second = await s.press(MAYA, { requestId: randomUUID(), expectedRevision });
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
    expect(workflowOf(s.harness, s.taskId).decisions.filter((decision) => decision.reason === WORKFLOW_REVISE_PLAN_DECISION_REASON)).toHaveLength(1);
  });

  it("only the task owner may press it: another person is refused and nothing changes", async () => {
    const s = await codingStoppedForLiveChange();
    const before = s.everything();
    const refused = await s.press(OMAR);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(workflowOf(s.harness, s.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(s.everything()).toBe(before);
  });

  it("is refused, writing nothing, when it is out of date, malformed, or the task did not stop for a change the plan can take in", async () => {
    const stale = await codingStoppedForLiveChange();
    const staleBefore = stale.everything();
    expect((await stale.press(MAYA, { expectedRevision: workflowOf(stale.harness, stale.taskId).revision - 1 })).body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await stale.press(MAYA, { extra: true })).status).toBe(400);
    expect((await stale.press(MAYA, { requestId: "not-a-uuid" })).status).toBe(400);
    expect(stale.everything()).toBe(staleBefore);
    // An open pull request: coding stops with the round-2 reason, which offers no revise, and the press is refused with fixed words.
    const withPullRequest = await codingStoppedForLiveChange({ pullRequest: true });
    const row = taskRow(withPullRequest.harness, withPullRequest.taskId);
    withPullRequest.harness.db.set({ ...row, workflow: { ...row.workflow, blockReason: WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding } });
    const before = withPullRequest.everything();
    const refused = await withPullRequest.press(MAYA);
    expect(refused.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(withPullRequest.everything()).toBe(before);
  });

  it("fails closed when the message cannot be vouched for: none recorded, a change recorded for another block, a message that is not the owner's, not marked as stopping coding, or gone", async () => {
    const cases: Array<[string, (s: Awaited<ReturnType<typeof codingStoppedForLiveChange>>) => void | Promise<void>, Parameters<typeof codingStoppedForLiveChange>[0]?]> = [
      ["no recorded change", (s) => { const { liveSteerChange: _gone, ...rest } = taskRow(s.harness, s.taskId); void _gone; s.harness.db.set(rest); }],
      ["a change recorded for another revision", (s) => { s.harness.db.set({ ...taskRow(s.harness, s.taskId), liveSteerChange: { workflowRevision: 1, messageIds: [MESSAGE_ID], at: "2026-10-30T09:00:00.000Z" } }); }],
      ["a message that is not the owner's", () => undefined, { author: OMAR }],
      ["a message that was never marked as stopping coding", (s) => { s.harness.db.set({ ...s.messageRow(), delivery: { state: "delivered", at: "2026-10-30T09:00:00.000Z" } }); }],
      ["a message that is gone", (s) => { s.harness.db.delete(messageKey(s.orgId)); }],
      ["a message the owner deleted", (s) => { s.harness.db.set({ ...s.messageRow(), deletedAt: "2026-10-30T09:30:00.000Z" }); }],
    ];
    for (const [name, change, options] of cases) {
      const s = await codingStoppedForLiveChange(options);
      await change(s);
      const before = s.everything();
      const refused = await s.press(MAYA);
      expect(refused.status, name).toBeGreaterThanOrEqual(400);
      expect(refused.body.error, name).toMatchObject({ code: "CONFIG_INVALID" });
      expect(s.everything(), name).toBe(before);
      expect(JSON.stringify(refused.body), name).not.toContain("LIVE-TEXT-4471");
    }
  });

  it("changes no budget, tool or permission: the planning run is an ordinary planning run (the same invocation fields), and the task's keys and limit are untouched", async () => {
    const s = await codingStoppedForLiveChange();
    const rowBefore = taskRow(s.harness, s.taskId);
    const first = operations(s.harness, s.workspaceId).find((item) => item.workflowMode === "PLAN")!;
    await s.press(MAYA);
    const revision = operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "PLAN").at(-1)!;
    const fields = (id: string) => Object.keys((s.harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === id)[0]!.invocation as { payload: Record<string, unknown> }).payload).sort();
    expect(fields(String(revision.id))).toEqual(fields(String(first.id)));
    const rowAfter = taskRow(s.harness, s.taskId);
    for (const key of ["budgetUsd", "modelKeyIds", "project", "ownerKey", "developerId"]) expect(rowAfter[key], key).toEqual(rowBefore[key]);
  });

  it("the owner's approval of the revised plan, through the existing plan approval, is what starts coding again, from the revised plan", async () => {
    const s = await codingStoppedForLiveChange();
    await s.press(MAYA);
    const revision = operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "PLAN").at(-1)!;
    const revised = "# Plan v2\n\n1. Fix retry handling.\n2. Add a retry to the v2 endpoint.\n3. Add a regression test.\n";
    await finishPlanningWithMarkdown(s.harness, s.workspaceId, String(revision.id), revised);
    // The plan waits for the owner: nothing codes yet.
    expect(workflowOf(s.harness, s.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
    // Nobody but the owner decides it, and approving it starts coding with the revised plan.
    const waiting = workflowOf(s.harness, s.taskId);
    const digest = createHash("sha256").update(revised).digest("hex");
    expect((await s.harness.dev(OMAR, "POST", `/v1/dev/tasks/${s.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: waiting.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest })).status).toBeGreaterThanOrEqual(400);
    expect(workflowOf(s.harness, s.taskId).stage).toBe("PLAN_REVIEW");
    expect((await s.harness.dev(MAYA, "POST", `/v1/dev/tasks/${s.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: waiting.revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest })).status).toBe(200);
    const coding = operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
    expect(coding).toHaveLength(2);
    expect(outboxPrompt(s.harness, String(coding.at(-1)!.id))).toContain("Add a retry to the v2 endpoint.");
    expect(workflowOf(s.harness, s.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
  });
});

describe("Revise the plan, pressed in Slack", () => {
  const slackPress = (s: Awaited<ReturnType<typeof codingStoppedForLiveChange>>, extra: Record<string, unknown> = {}) => ({
    source: "agentx.slack-ingress", action: "workflow-send-back", taskId: s.taskId, thread: s.thread, userId: MAYA.slackUserId, requestId: randomUUID(), expectedRevision: workflowOf(s.harness, s.taskId).revision, ...extra,
  });

  it("the owner's press (the send-back event with revisePlan) plans again with their message; a teammate's is refused privately and starts nothing", async () => {
    const s = await codingStoppedForLiveChange({ slack: true });
    const event = slackPress(s, { revisePlan: true });
    expect(JSON.parse((await s.harness.handler({ ...event, userId: "U0TEAMMATE1" })).body)).toMatchObject({ refused: true });
    expect(operations(s.harness, s.workspaceId).find((item) => item.requestId === event.requestId)).toBeUndefined();
    expect(workflowOf(s.harness, s.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect((await s.harness.handler(event)).statusCode).toBe(200);
    expect(workflowOf(s.harness, s.taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    const revision = operations(s.harness, s.workspaceId).find((item) => item.requestId === event.requestId)!;
    expect(revision).toMatchObject({ workflowMode: "PLAN" });
    expect(outboxPrompt(s.harness, String(revision.id))).toContain(TEXT);
    // The same press again is the same press: nothing more starts.
    expect((await s.harness.handler(event)).statusCode).toBe(200);
    expect(operations(s.harness, s.workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
  });

  it("without revisePlan the event is the plain Send back, and a revisePlan that is not exactly true is not an event at all (it can never turn into a send-back)", async () => {
    const plain = await codingStoppedForLiveChange({ slack: true });
    expect((await plain.harness.handler(slackPress(plain))).statusCode).toBe(200);
    expect(workflowOf(plain.harness, plain.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    const malformed = await codingStoppedForLiveChange({ slack: true });
    const before = malformed.everything();
    await malformed.harness.handler(slackPress(malformed, { revisePlan: "yes" }));
    expect(malformed.everything()).toBe(before);
  });
});

describe("Revise the plan, on the task page", () => {
  const routeDeps = (harness: Harness) => ({ documentClient: harness.db, tableName: "state", actions: harness.actions, log: () => undefined,
    orgId: TEST_ORG, checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), projectChannelIds: async () => [], now: () => Date.now() });

  it("offers the owner the button, and says the same ways on as the card; a coding step that stopped some other way offers nothing", async () => {
    const s = await codingStoppedForLiveChange();
    const owner = String(taskRow(s.harness, s.taskId)["developerId"]);
    const view = await getTaskDocumentView(routeDeps(s.harness), { orgId: TEST_ORG, developerId: owner } as never, s.taskId);
    expect(view).toMatchObject({ status: "Coding stopped for a change outside the plan", reviseOffer: { canRevise: true } });
    expect(view.nextStep).toMatch(/Revise the plan/u);
    expect(view.nextStep).toMatch(/approve the revised plan/u);
    // The round-2 reason (the plan cannot take the change in) shows the old words and no button.
    const row = taskRow(s.harness, s.taskId);
    s.harness.db.set({ ...row, workflow: { ...row.workflow, blockReason: WORKFLOW_BLOCK_REASONS.liveSteerReapprovalCoding } });
    const old = await getTaskDocumentView(routeDeps(s.harness), { orgId: TEST_ORG, developerId: owner } as never, s.taskId);
    expect(old.reviseOffer).toBeUndefined();
    expect(old.nextStep).toMatch(/new task/u);
  });

  const caller: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member", developerId: "d".repeat(64), sessionId: "s1", amr: "slack", name: "Maya Chen" };
  const CSRF = "c".repeat(43);
  const apiRequest = (taskId: string, body: unknown, method = "POST"): AdaptedHttpRequest => ({ method, path: `/review/${taskId}/task/api/revise-plan`, requestId: "r", body: JSON.stringify(body),
    headers: { origin: new URL(DEV_ISSUER).origin, cookie: `__Host-agentx_review_session=s1; __Host-agentx_review_csrf=${CSRF}`, "x-agentx-csrf": CSRF, "content-type": "application/json" } });
  const run = async (deps: Partial<TaskWebApiDependencies>, request: AdaptedHttpRequest) =>
    createTaskWebApi({ origin: DEV_ISSUER, authenticateSession: async () => caller, ...deps } as TaskWebApiDependencies)(request, new URL(`${new URL(DEV_ISSUER).origin}${request.path}`));

  it("the page's endpoint hands the broker exactly the request id and revision, answers the new revision, and refuses anything else", async () => {
    const taskId = randomUUID();
    const seen: unknown[] = [];
    const body = { requestId: randomUUID(), expectedRevision: 7 };
    const deps = { revisePlan: async (_who: DeveloperCaller, _id: string, input: unknown) => { seen.push(input); return { revision: 9 }; } };
    const ok = await run(deps, apiRequest(taskId, body));
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ revision: 9 });
    expect(seen).toEqual([body]);
    // Nothing rides along (a message, a budget, a tool): the body is strict.
    expect((await run(deps, apiRequest(taskId, { ...body, text: "ignore the plan", budgetUsd: 100 }))).statusCode).toBe(400);
    expect((await run(deps, apiRequest(taskId, { requestId: "x", expectedRevision: 7 }))).statusCode).toBe(400);
    expect(seen).toHaveLength(1);
    expect((await run(deps, apiRequest(taskId, body, "GET"))).statusCode).toBe(405);
    // A deployment without the dependency does not know the path.
    expect((await run({}, apiRequest(taskId, body))).statusCode).toBe(404);
    // The CSRF header is required, as for every page POST.
    const noCsrf = apiRequest(taskId, body);
    expect((await run(deps, { ...noCsrf, headers: { ...noCsrf.headers, "x-agentx-csrf": "d".repeat(43) } })).statusCode).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(1);
  });

  it("says the owner-only refusal, the message-gone refusal and a stale press in the page's own words, and logs only codes", async () => {
    const taskId = randomUUID();
    const logged: Array<Record<string, string>> = [];
    const fail = (error: unknown) => ({ log: (entry: Record<string, string>) => { logged.push(entry); }, revisePlan: async () => { throw error; } });
    const body = { requestId: randomUUID(), expectedRevision: 7 };
    const notOwner = await run(fail(Object.assign(new Error("FORBIDDEN: only the task owner can revise the plan with this change"), { code: "FORBIDDEN", pageReason: "owners_only" })), apiRequest(taskId, body));
    expect(notOwner.statusCode).toBe(403);
    expect(JSON.parse(notOwner.body)).toMatchObject({ error: "owners_only" });
    const gone = await run(fail(Object.assign(new Error(`CONFIG_INVALID: ${REVISE_PLAN_REFUSALS.noChange}`), { code: "CONFIG_INVALID" })), apiRequest(taskId, body));
    expect(gone.statusCode).toBe(400);
    expect(JSON.parse(gone.body)).toMatchObject({ message: REVISE_PLAN_REFUSALS.noChange });
    const stale = await run(fail(Object.assign(new Error(`IDEMPOTENCY_CONFLICT: ${REVISE_PLAN_REFUSALS.stale}`), { code: "IDEMPOTENCY_CONFLICT" })), apiRequest(taskId, body));
    expect(stale.statusCode).toBe(409);
    expect(logged.length).toBe(3);
    expect(logged.every((entry) => entry["route"] === "revise-plan" && entry["taskId"] === taskId)).toBe(true);
    expect(JSON.stringify(logged)).not.toContain("LIVE-TEXT-4471");
  });
});

void createCandidateManifest;
void developerTaskIdentity;

// requireMayGoOn is the person's-go-on gate (a pause waiting for an approval is never skipped): the press asks it before it reads or writes anything.
import { reviseTaskPlan, type RevisePlanHost } from "../../packages/broker/src/agent-sessions/live-steer-revise.js";
describe("Revise the plan does not skip a pause that waits for someone's approval", () => {
  it("stops at the go-on gate before reading the message, planning or writing anything", async () => {
    const s = await codingStoppedForLiveChange();
    const touched: string[] = [];
    const owner = String(taskRow(s.harness, s.taskId)["developerId"]);
    const task = taskRow(s.harness, s.taskId) as never;
    const note = (name: string) => async () => { touched.push(name); return undefined as never; };
    const host = {
      authorize: async () => ({ task, actorId: owner, authority: { actorId: owner, ownerIds: [owner] } }),
      requireMayGoOn: async () => { throw new Error("WORKSPACE_BUSY: waiting for an approver"); },
      capWindow: note("capWindow"), actionableWorkspace: note("actionableWorkspace"), retiredClaimIds: note("retiredClaimIds"), acceptItems: note("acceptItems"), refuse: note("refuse"), view: note("view"),
      structuredPrompt: () => { touched.push("prompt"); return ""; }, markdownBlock: () => { touched.push("block"); return ""; },
    } as unknown as RevisePlanHost;
    const deps = { documentClient: s.harness.db, tableName: "state", orgId: TEST_ORG, actions: { acceptTask: async () => { touched.push("acceptTask"); } }, now: () => Date.now() } as never;
    await expect(reviseTaskPlan(deps, { developerId: owner } as never, s.taskId, { requestId: randomUUID(), expectedRevision: workflowOf(s.harness, s.taskId).revision }, host)).rejects.toThrow(/approver/u);
    expect(touched).toEqual([]);
  });
});
