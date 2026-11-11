// Plan 5 Task 7a: a session's summary is recomputed from its source records (the task, its operations and run, its approvals and spend requests, its
// counter), written with the live tile and a status or step event when it changed, and told to the notice sink. The projector maps stream records to the
// sessions they touch (an allowlist of source keys: it never reacts to Plan 5's own writes), within the publisher's deadline.
// A session ends only when its work is over (a closed task, a creator-removed outcome, a merged or closed workflow, an ended run, a terminal chain run,
// a local session that reported its end): a stopped task or one between turns stays open.
import { randomUUID } from "node:crypto";
import { marshall } from "@aws-sdk/util-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_ENDED_KEEP_HOURS, SESSION_RETENTION_DAYS, agentSessionKey, endedSessionWorkKey, liveSessionKey, openAgentSessionKey, sessionEventId, planRunLimitSubject, taskSpendKey, PROJECTOR_CONCURRENCY } from "@rovara-code/contracts";
import { spendRequestKey, spendRequestSlotKey } from "@agentx/cloud-contracts";
import { registerSessionNoticeSink, type SessionChange } from "../../packages/broker/src/agent-sessions/notice-sink.js";
import { projectSessions } from "../../packages/broker/src/agent-sessions/projector.js";
import { computeSessionSummary, sessionSummaryDigest } from "../../packages/broker/src/agent-sessions/summary.js";
import { sessionView } from "../../packages/broker/src/agent-sessions/read.js";
import { AgentSessionStore } from "../../packages/broker/src/agent-sessions/store.js";
import { createWriteApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { createOutboxPublisherHandler, indexTogether } from "../../packages/broker/src/aws/outbox-publisher.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, CELL, ORG_A, ORG_B, PRIYA, T0 } from "../support/agent-session-world.js";
import { DAY_MS, iso, projectorWorld, workflow, type PW } from "../support/agent-session-projector-world.js";


type Item = Record<string, unknown>;
const taskOf = (p: PW, taskId: string) => p.w.db.get(taskKey(taskId))!;

afterEach(() => registerSessionNoticeSink(undefined));

describe("what a session shows while its work goes on", () => {
  it("a task moving to IMPLEMENT/RUNNING gives the tile running with step Coding and one step event; the same batch again writes nothing", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    const task = p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    expect(await p.project([task])).toMatchObject({ refreshed: 1 });
    const session = p.sessionOf(s.sessionId);
    expect(session.summary).toMatchObject({ status: "running", step: "Coding" });
    expect(session.summaryRevision).toBe(2);
    expect(p.tile(s.sessionId)).toMatchObject({ orgId: ORG_A, sessionId: s.sessionId, summary: { status: "running", step: "Coding" } });
    expect(p.events(s.sessionId).map((event) => [event.type, event.text])).toEqual([["step", "Step: Coding"]]);
    const before = p.w.db.transactions().length;
    expect(await p.project([task])).toMatchObject({ refreshed: 0, unchanged: 1 });
    expect(p.w.db.transactions().length).toBe(before);
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(2);
    expect(await p.refresh(s.sessionId)).toBe("unchanged");
  });

  it("stop then continue: a cancelled latest operation is 'stopped' and the session stays open with no end and no expiry; a continue makes it running again", async () => {
    const p = projectorWorld();
    const s = p.open();
    const first = p.operation(s.workspaceId, "task", "RUNNING", 0);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("running");
    p.setOperation(first, "CANCELLED");
    expect(await p.refresh(s.sessionId)).toBe("updated");
    const stopped = p.sessionOf(s.sessionId);
    expect(stopped.summary.status).toBe("stopped");
    expect(stopped.endedAt).toBeUndefined();
    expect(stopped.indexExpiresAt).toBeUndefined();
    expect(p.tile(s.sessionId)?.indexExpiresAt).toBeUndefined();
    expect(p.tile(s.sessionId)?.endedAt).toBeUndefined();
    expect(p.w.db.get(openAgentSessionKey(ORG_A, s.sessionId))).toBeDefined();
    expect(p.w.db.find((item) => String(item.pk).startsWith("ENDED_AGENT_SESSIONS#"))).toHaveLength(0);
    p.operation(s.workspaceId, "task", "RUNNING", 60_000);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("running");
    expect(p.sessionOf(s.sessionId).endedAt).toBeUndefined();
  });

  it("a plain task between turns is 'waiting' and open; a failed turn is 'waiting' with lastRunFailed and the failure as its step", async () => {
    const p = projectorWorld();
    const ok = p.open();
    p.operation(ok.workspaceId, "task", "SUCCEEDED");
    await p.refresh(ok.sessionId);
    expect(p.sessionOf(ok.sessionId)).toMatchObject({ summary: { status: "waiting" } });
    expect(p.sessionOf(ok.sessionId).endedAt).toBeUndefined();
    expect(p.w.db.get(openAgentSessionKey(ORG_A, ok.sessionId))).toBeDefined();
    const bad = p.open();
    p.operation(bad.workspaceId, "task", "FAILED", 0, "the worker crashed");
    await p.refresh(bad.sessionId);
    const failed = p.sessionOf(bad.sessionId);
    expect(failed.summary).toMatchObject({ status: "waiting", lastRunFailed: true });
    expect(failed.summary.step).toMatch(/^Failed: /);
    expect(failed.endedAt).toBeUndefined();
  });

  it("setup running is 'starting'", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.w.db.set({ pk: `WORKSPACE#${s.workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "PREPARING" });
    p.operation(s.workspaceId, "prepare", "RUNNING");
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("starting");
  });

  it("a task paused for budget is 'paused', told as a pause and not a failure, with its spend request's approvers in needsPeople", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    p.patchTask(s.taskId, { budgetPause: { scope: { kind: "task" }, at: iso(T0) }, budgetUsd: 5, maxPerRunUsd: 3 });
    const requestId = "spr_0123456789abcdefghij";
    p.w.db.set({ ...spendRequestKey(ORG_A, requestId), entityType: "SPEND_REQUEST", orgId: ORG_A, spendRequestId: requestId, kind: "run_limit", taskId: s.taskId, status: "PENDING", approverIds: [ARJUN], amountUsd: 5, reason: "x", requestedBy: { kind: "system" }, approverRole: "payer", createdAt: iso(T0), expiresAt: iso(T0 + DAY_MS) });
    p.w.db.set({ ...spendRequestSlotKey(ORG_A, `TASK#${s.taskId}`, "run_limit"), entityType: "SPEND_REQUEST_SLOT", orgId: ORG_A, spendRequestId: requestId, createdAt: iso(T0) });
    p.spent(s.taskId, 2.5);
    await p.refresh(s.sessionId);
    const session = p.sessionOf(s.sessionId);
    expect(session.summary).toMatchObject({ status: "paused", costUsd: 2.5, runLimitUsd: 5, stopAtUsd: 3, needsPeople: [ARJUN] });
    expect(session.summary.lastRunFailed).toBeUndefined();
    expect(session.endedAt).toBeUndefined();
    expect(p.events(s.sessionId).map((event) => event.text)).toEqual(["Paused: needs more budget"]);
    expect(p.w.db.get(openAgentSessionKey(ORG_A, s.sessionId))).toBeDefined();
  });

  it("peeks at the newest readable line of the running operation, redacted and cut", async () => {
    const p = projectorWorld();
    const s = p.open();
    const op = p.operation(s.workspaceId, "task", "RUNNING");
    p.eventOf(String(op.id), 1, "Reading the repository");
    p.eventOf(String(op.id), 2, `Using ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)} ${"x".repeat(400)}`);
    await p.refresh(s.sessionId);
    const peek = String(p.sessionOf(s.sessionId).summary.peek);
    expect(peek).not.toContain("ghp_");
    expect([...peek].length).toBeLessThanOrEqual(280);
    expect(peek).toContain("[REDACTED]");
  });
});

describe("when a session ends", () => {
  it("a closed task after a succeeded run is 'succeeded' with its end, retention and the work item for the drain", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    const closedAt = "2026-10-22T08:30:00.000Z";
    const task = p.patchTask(s.taskId, { closedAt });
    await p.project([task]);
    const session = p.sessionOf(s.sessionId);
    expect(session.summary.status).toBe("succeeded");
    expect(session.endedAt).toBe(closedAt);
    expect(session.indexExpiresAt).toBe(Math.floor(Date.parse(closedAt) / 1000) + SESSION_RETENTION_DAYS * 86_400);
    // The end leaves the session's legs alone (a take-over between the read and the write must not be overwritten; the leg's end is Task 11's).
    expect(session.legs.at(-1)?.endedAt).toBeUndefined();
    expect(p.w.db.get(openAgentSessionKey(ORG_A, s.sessionId))).toBeUndefined();
    expect(p.w.db.get(endedSessionWorkKey("2026-10-22", ORG_A, s.sessionId))).toMatchObject({ orgId: ORG_A, sessionId: s.sessionId });
    expect(p.tile(s.sessionId)).toMatchObject({ endedAt: closedAt, indexExpiresAt: Math.floor(Date.parse(closedAt) / 1000) + LIVE_ENDED_KEEP_HOURS * 3600 });
    expect(p.events(s.sessionId).map((event) => event.type)).toEqual(["status"]);
    // UX2 slice 2: a task its owner closed reads Closed on its timeline too, whatever its last run did.
    expect(p.events(s.sessionId)[0]!.text).toBe("Closed");
  });

  it("is failed for a task whose creator was removed and for one closed after a failed run, and cancelled for one closed with no run", async () => {
    const p = projectorWorld();
    const removed = p.open();
    p.operation(removed.workspaceId, "task", "RUNNING");
    p.patchTask(removed.taskId, { outcome: "creator_removed", outcomeAt: "2026-10-22T08:20:00.000Z" });
    const failedRun = p.open();
    p.operation(failedRun.workspaceId, "task", "FAILED", 0, "boom");
    p.patchTask(failedRun.taskId, { closedAt: "2026-10-22T08:31:00.000Z" });
    const noRun = p.open();
    p.patchTask(noRun.taskId, { closedAt: "2026-10-22T08:32:00.000Z" });
    for (const s of [removed, failedRun, noRun]) await p.refresh(s.sessionId);
    expect([removed, failedRun, noRun].map((s) => p.sessionOf(s.sessionId).summary.status)).toEqual(["failed", "failed", "cancelled"]);
    for (const s of [removed, failedRun, noRun]) expect(p.sessionOf(s.sessionId).endedAt).toBeDefined();
  });

  it("is succeeded for a merged workflow, and cancelled for a closed one", async () => {
    const p = projectorWorld();
    const merged = p.open();
    p.patchTask(merged.taskId, { workflow: workflow("MERGED", "COMPLETE", { outcome: "MERGED" }) });
    const closed = p.open();
    p.patchTask(closed.taskId, { workflow: workflow("CLOSED", "COMPLETE", { outcome: "REJECTED" }) });
    await p.refresh(merged.sessionId);
    await p.refresh(closed.sessionId);
    expect(p.sessionOf(merged.sessionId).summary).toMatchObject({ status: "succeeded", step: "Complete" });
    expect(p.sessionOf(closed.sessionId).summary.status).toBe("cancelled");
  });

  it("a workflow session whose workspace failed to prepare ends failed at once, and does not read running at its plan step (v0.4.9 staging: every clone failed and the sessions stayed 'Running: Coding plan', a stop changed nothing)", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.w.db.set({ ...p.w.db.get({ pk: `WORKSPACE#${s.workspaceId}`, sk: "META" })!, status: "PREPARATION_FAILED" });
    p.operation(s.workspaceId, "prepare", "FAILED", 0, "Command failed: git clone ... remote: Repository not found.");
    p.patchTask(s.taskId, { workflow: workflow("PLAN", "RUNNING") });
    await p.refresh(s.sessionId);
    const session = p.sessionOf(s.sessionId);
    expect(session.summary).toMatchObject({ status: "failed", step: "Coding plan" });
    expect(session.endedAt).toBeDefined();
    // The same session before the preparation fails is still starting or running, and one whose task has no workflow keeps reading as it did.
    const plain = p.open();
    p.w.db.set({ ...p.w.db.get({ pk: `WORKSPACE#${plain.workspaceId}`, sk: "META" })!, status: "PREPARATION_FAILED" });
    p.operation(plain.workspaceId, "prepare", "FAILED", 0, "boom");
    await p.refresh(plain.sessionId);
    expect(p.sessionOf(plain.sessionId).summary.status).toBe("waiting");
  });

  it("never reopens: a session that ended and now looks open is left alone and the refusal is logged", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-22T08:30:00.000Z" });
    await p.refresh(s.sessionId);
    const ended = p.sessionOf(s.sessionId);
    const { closedAt: _closed, ...open } = taskOf(p, s.taskId); // eslint-disable-line @typescript-eslint/no-unused-vars -- removed on purpose
    p.w.db.set(open);
    const before = p.w.db.transactions().length;
    expect(await p.refresh(s.sessionId)).toBe("unchanged");
    expect(p.w.db.transactions().length).toBe(before);
    expect(p.sessionOf(s.sessionId)).toEqual(ended);
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.reopen_refused");
    expect(p.w.db.get(openAgentSessionKey(ORG_A, s.sessionId))).toBeUndefined();
  });

  it("reads a task of another org as no task: the summary stays as it was", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    p.patchTask(s.taskId, { orgId: ORG_B, closedAt: "2026-10-22T08:30:00.000Z" });
    expect(await p.refresh(s.sessionId)).toBe("unchanged");
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(1);
    expect(p.sessionOf(s.sessionId).endedAt).toBeUndefined();
  });

  it("an ended session keeps the status it ended with, whatever the source says later", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-22T08:30:00.000Z" });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("succeeded");
    // The creator is removed afterwards: the source now reads 'failed', the session stays 'succeeded' (and its cost still moves).
    p.patchTask(s.taskId, { outcome: "creator_removed", outcomeAt: "2026-10-22T09:00:00.000Z" });
    p.spent(s.taskId, 1);
    expect(await p.refresh(s.sessionId)).toBe("updated");
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "succeeded", costUsd: 1 });
    expect(p.events(s.sessionId)).toHaveLength(1);
  });

  it("keeps its end and its words while its cost catches up from a key settled an hour late", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-22T08:30:00.000Z" });
    await p.refresh(s.sessionId);
    const ended = p.sessionOf(s.sessionId);
    p.w.clock.now += 3_600_000;
    p.spent(s.taskId, 4.2);
    expect(await p.refresh(s.sessionId)).toBe("updated");
    const after = p.sessionOf(s.sessionId);
    expect(after.summary).toMatchObject({ status: "succeeded", costUsd: 4.2 });
    expect(after.endedAt).toBe(ended.endedAt);
    expect(after.indexExpiresAt).toBe(ended.indexExpiresAt);
    expect(p.tile(s.sessionId)?.indexExpiresAt).toBeDefined();
    expect(p.events(s.sessionId)).toHaveLength(1); // no second telling of the end
  });

  it("a local session ends when its device says so, and shows 'offline' after ten silent minutes (read through its source)", async () => {
    const p = projectorWorld();
    const local = p.w.seedSession({ kind: "local", owner: PRIYA });
    const facts = { orgId: ORG_A, status: "running" as const, step: "Writing tests", costUsd: 0.5, updatedAt: iso(T0) };
    const source = { read: vi.fn(async () => facts as Item) };
    await p.refresh(local.sessionId, ORG_A, { local: source });
    expect(p.sessionOf(local.sessionId).summary).toMatchObject({ status: "running", step: "Writing tests", costUsd: 0.5 });
    expect(p.sessionOf(local.sessionId).summary.offline).toBeUndefined();
    p.w.clock.now = T0 + 11 * 60_000;
    await p.refresh(local.sessionId, ORG_A, { local: source });
    expect(p.sessionOf(local.sessionId).summary.offline).toBe(true);
    source.read.mockResolvedValue({ ...facts, status: "succeeded", endedAt: iso(T0 + 12 * 60_000) });
    await p.refresh(local.sessionId, ORG_A, { local: source });
    expect(p.sessionOf(local.sessionId)).toMatchObject({ summary: { status: "succeeded" }, endedAt: iso(T0 + 12 * 60_000) });
    expect(p.sessionOf(local.sessionId).summary.offline).toBeUndefined();
  });

  it("a chain run at its gate is 'needs_person', timed_out is 'failed', and the cost adds the running step's own", async () => {
    const p = projectorWorld();
    const chain = p.w.seedSession({ kind: "chain" });
    const step = p.open();
    p.spent(step.taskId, 1.5);
    const facts = { orgId: ORG_A, status: "gate" as const, stepName: "Review gate", spentUsd: 2, stepTaskId: step.taskId, needsPeople: [ARJUN] };
    const source = { read: vi.fn(async () => facts as Item), targetOf: () => undefined };
    await p.refresh(chain.sessionId, ORG_A, { chains: source });
    expect(p.sessionOf(chain.sessionId).summary).toMatchObject({ status: "needs_person", step: "Review gate", costUsd: 3.5, needsPeople: [ARJUN] });
    source.read.mockResolvedValue({ orgId: ORG_A, status: "timed_out", stepName: "Review gate", spentUsd: 2 });
    await p.refresh(chain.sessionId, ORG_A, { chains: source });
    expect(p.sessionOf(chain.sessionId)).toMatchObject({ summary: { status: "failed" } });
    expect(p.sessionOf(chain.sessionId).endedAt).toBeDefined();
  });
});

describe("who is needed", () => {
  it("a plan waiting for review needs the effective owner, and a taken-over task needs the taker", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { workflow: workflow("PLAN_REVIEW", "WAITING") });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "needs_person", step: "Coding plan", needsPeople: [PRIYA] });
    p.patchTask(s.taskId, { currentOwner: { developerId: ARJUN, name: "Arjun", provider: "oidc", since: iso(T0) } });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.needsPeople).toEqual([ARJUN]);
  });

  it("a pending write approval puts its candidates there and a count of one; deciding it removes them", async () => {
    const p = projectorWorld();
    const s = p.open({ task: { agent: { agentId: "triage", name: "Triage", version: 1 }, origin: "app", startedBy: { developerId: PRIYA } } });
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.w.db.set({
      pk: `DEVTASK#${s.taskId}`, sk: "AGENT_RUN", entityType: "AGENT_RUN", orgId: ORG_A, revision: 1, state: "WAITING_FOR_APPROVAL", cursor: 0, input: { text: "Triage the inbox" },
      steps: [{ id: "work", status: "waiting", operationIds: [], approvalIds: ["apr_aaaaaaaaaaaaaaaaaaaa"] }], reports: [],
    });
    const approvalId = "apr_aaaaaaaaaaaaaaaaaaaa";
    expect(await createWriteApprovalRecord({ documentClient: p.w.db, tableName: "state", now: () => T0 }, {
      orgId: ORG_A, approvalId, kind: "write", subject: { kind: "agent_run", taskId: s.taskId, stepId: "work" }, operationId: randomUUID(), connector: "linear", connectorType: "linear",
      tool: "save_issue", toolAccess: "write", scope: "eng", schemaHash: "a".repeat(64), projectRevision: 1, scopeDigest: "b".repeat(64), arguments: {}, argumentsHash: "c".repeat(64),
      summary: "Create a Linear issue", class: "consequential", approvers: { kind: "ids", ids: [ARJUN, PRIYA] }, status: "PENDING", project: "web", owner: { developerId: PRIYA, name: "Priya" },
      attempts: 0, createdAt: iso(T0), expiresAt: iso(T0 + 3_600_000),
    } as never, [], 8)).toBe("created");
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "needs_person", pendingApprovals: 1 });
    expect([...p.sessionOf(s.sessionId).summary.needsPeople].sort()).toEqual([ARJUN, PRIYA].sort());
    // The run's own state says RUNNING (the step is still working) while an approval waits: the person is still needed.
    p.w.db.set({ ...p.w.db.get({ pk: `DEVTASK#${s.taskId}`, sk: "AGENT_RUN" })!, state: "RUNNING" });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "needs_person", pendingApprovals: 1 });
    p.w.db.set({ ...p.w.db.get({ pk: `DEVTASK#${s.taskId}`, sk: "AGENT_RUN" })!, state: "WAITING_FOR_APPROVAL" });
    // Decided: the record is no longer PENDING and the run goes on.
    const record = p.w.db.get({ pk: `ORG#${ORG_A}#APPROVAL#${approvalId}`, sk: "META" })!;
    p.w.db.set({ ...record, status: "APPROVED_DONE" });
    p.w.db.set({ ...p.w.db.get({ pk: `DEVTASK#${s.taskId}`, sk: "AGENT_RUN" })!, state: "RUNNING" });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "running", pendingApprovals: 0, needsPeople: [] });
  });
});

describe("a plan blocked on its run limit (Task 7a concern 2, Task 7b)", () => {
  const BLOCKED = (text = "This plan's run limit is $12, which needs a project maintainer's approval. I've asked for it.") => workflow("IMPLEMENT", "BLOCKED", { blockReason: text });
  const requestOf = (p: PW, taskId: string, patch: Item = {}, options: { subject?: string; slotOrg?: string } = {}) => {
    const requestId = "spr_0123456789abcdefghij";
    p.w.db.set({
      ...spendRequestKey(ORG_A, requestId), entityType: "SPEND_REQUEST", orgId: ORG_A, spendRequestId: requestId, kind: "run_limit", taskId, status: "PENDING", approverIds: [ARJUN],
      amountUsd: 12, reason: "x", requestedBy: PRIYA, createdAt: iso(T0), expiresAt: iso(T0 + 3_600_000), ...patch,
    });
    p.w.db.set({ ...spendRequestSlotKey(ORG_A, options.subject ?? planRunLimitSubject(taskId), "run_limit"), entityType: "SPEND_REQUEST_SLOT", orgId: options.slotOrg ?? ORG_A, spendRequestId: requestId, createdAt: iso(T0) });
  };

  it("shows the plan's run-limit request: its approvers are needed and one decision waits", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { workflow: BLOCKED() });
    requestOf(p, s.taskId);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "needs_person", needsPeople: [ARJUN], pendingApprovals: 1 });
    expect(p.sessionOf(s.sessionId).endedAt).toBeUndefined();
  });

  it("also in the words used when the agent's owner or the project's maintainer pays", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.patchTask(s.taskId, { workflow: BLOCKED("Waiting for the agent's owner to accept the $12 run limit.") });
    requestOf(p, s.taskId);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "needs_person", needsPeople: [ARJUN], pendingApprovals: 1 });
  });

  it("does not list a request that is decided, out of time, another org's, or kept under another subject; the owner is needed instead", async () => {
    const p = projectorWorld();
    const cases: Array<[string, Item, { subject?: string; slotOrg?: string }]> = [
      ["decided", { status: "APPROVED" }, {}],
      ["out of time", { expiresAt: iso(T0 - 1) }, {}],
      ["another org's", { orgId: ORG_B }, {}],
      ["slot of another org", {}, { slotOrg: ORG_B }],
      ["another subject", {}, { subject: "TASK#someone-else#IMPLEMENT" }],
    ];
    for (const [label, patch, options] of cases) {
      const s = p.open();
      p.patchTask(s.taskId, { workflow: BLOCKED() });
      requestOf(p, s.taskId, patch, options);
      await p.refresh(s.sessionId);
      expect(p.sessionOf(s.sessionId).summary, label).toMatchObject({ status: "needs_person", needsPeople: [PRIYA], pendingApprovals: 0 });
    }
  });

  it("looks for the request only while the plan is blocked on its run limit", async () => {
    const p = projectorWorld();
    const running = p.open();
    p.operation(running.workspaceId, "task", "RUNNING");
    p.patchTask(running.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    requestOf(p, running.taskId);
    await p.refresh(running.sessionId);
    expect(p.sessionOf(running.sessionId).summary).toMatchObject({ status: "running", needsPeople: [], pendingApprovals: 0 });
    const other = p.open();
    p.patchTask(other.taskId, { workflow: BLOCKED("The checks could not run.") });
    requestOf(p, other.taskId);
    await p.refresh(other.sessionId);
    expect(p.sessionOf(other.sessionId).summary).toMatchObject({ status: "needs_person", needsPeople: [PRIYA], pendingApprovals: 0 });
  });

  it("drops out of needsPeople when the request is decided and the plan moves on", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { workflow: BLOCKED() });
    requestOf(p, s.taskId);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.needsPeople).toEqual([ARJUN]);
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    p.operation(s.workspaceId, "task", "RUNNING", 60_000);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "running", needsPeople: [], pendingApprovals: 0 });
  });

  it("a paused task that is also blocked reads the plan's slot with its three", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    p.patchTask(s.taskId, { budgetPause: { scope: { kind: "task" }, at: iso(T0) }, workflow: BLOCKED() });
    requestOf(p, s.taskId);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "paused", needsPeople: [ARJUN], pendingApprovals: 1 });
  });
});

describe("a blocked workflow carries a flag so the session can offer retry (Task 14 ruling)", () => {
  it("sets workflowBlocked on a budget-paused task whose workflow is also blocked", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.patchTask(s.taskId, { budgetPause: { scope: { kind: "task" }, at: iso(T0) }, workflow: workflow("IMPLEMENT", "BLOCKED") });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "paused", workflowBlocked: true });
    const plain = p.open();
    p.patchTask(plain.taskId, { budgetPause: { scope: { kind: "task" }, at: iso(T0) } });
    await p.refresh(plain.sessionId);
    expect(p.sessionOf(plain.sessionId).summary.status).toBe("paused");
    expect(p.sessionOf(plain.sessionId).summary.workflowBlocked).toBeUndefined();
  });


  it("sets workflowBlocked while the workflow is BLOCKED, whatever the reason, and clears it when the workflow moves on", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "BLOCKED", { blockReason: "The checks could not run." }) });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "needs_person", workflowBlocked: true });
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.workflowBlocked).toBeUndefined();
    expect("workflowBlocked" in p.sessionOf(s.sessionId).summary).toBe(false);
  });

  it("does not set it for a plan under review, a plain task or a finished workflow", async () => {
    const p = projectorWorld();
    const review = p.open();
    p.patchTask(review.taskId, { workflow: workflow("PLAN_REVIEW", "WAITING") });
    await p.refresh(review.sessionId);
    expect(p.sessionOf(review.sessionId).summary).toMatchObject({ status: "needs_person" });
    expect(p.sessionOf(review.sessionId).summary.workflowBlocked).toBeUndefined();
    const plain = p.open();
    await p.refresh(plain.sessionId);
    expect(p.sessionOf(plain.sessionId).summary.workflowBlocked).toBeUndefined();
  });

  it("changes the digest, so the refresh writes it, and an ended session never carries it", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    await p.refresh(s.sessionId);
    const before = p.sessionOf(s.sessionId).summary.digest;
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "BLOCKED", { blockReason: "x" }) });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.digest).not.toBe(before);
    p.patchTask(s.taskId, { workflow: workflow("MERGED", "COMPLETE") });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.workflowBlocked).toBeUndefined();
  });
});

describe("cost, order and the notice sink", () => {
  it("raises costUsd from the per-task counter with one read, and an old record afterwards leaves the newer summary", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    const oldTask = { ...taskOf(p, s.taskId) };
    await p.refresh(s.sessionId);
    p.spent(s.taskId, 1.25);
    const counterKey = taskSpendKey(ORG_A, s.taskId);
    const reads = vi.spyOn(p.w.db, "send");
    expect(await p.project([{ ...counterKey, entityType: "TASK_SPENT", orgId: ORG_A, settledUsd: 1.25 }])).toMatchObject({ refreshed: 1 });
    const counterReads = reads.mock.calls.filter(([command]) => (command as { input?: { Key?: { pk?: string } } }).input?.Key?.pk === counterKey.pk);
    expect(counterReads).toHaveLength(1);
    expect(p.sessionOf(s.sessionId).summary.costUsd).toBe(1.25);
    const revision = p.sessionOf(s.sessionId).summaryRevision;
    // A stale batch (the task record as it was) is just a reason to look again: nothing moves backwards.
    expect(await p.project([oldTask])).toMatchObject({ refreshed: 0, unchanged: 1 });
    expect(p.sessionOf(s.sessionId).summary.costUsd).toBe(1.25);
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(revision);
    reads.mockRestore();
  });

  it("hands each change to the registered sink once, after the commit, and a failing sink changes nothing", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    const seen: SessionChange[] = [];
    registerSessionNoticeSink(async (_deps, change) => { seen.push(change); throw new Error("sink down"); });
    expect(await p.refresh(s.sessionId)).toBe("updated");
    expect(await p.refresh(s.sessionId)).toBe("unchanged");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ orgId: ORG_A, sessionId: s.sessionId, statusChanged: false, stepChanged: true, ended: false, summaryRevision: 2, summary: { status: "running", step: "Coding" } });
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.notice_sink_failed");
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(2);
  });

  it("two refreshes at once make one update and one event", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    const results = await Promise.all([p.refresh(s.sessionId), p.refresh(s.sessionId)]);
    expect(results.filter((result) => result === "updated")).toHaveLength(1);
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(2);
    expect(p.events(s.sessionId)).toHaveLength(1);
  });

  it("the view shows the real status and cost once the summary has been computed", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    p.spent(s.taskId, 0.75);
    await p.refresh(s.sessionId);
    const view = await sessionView({
      ...p.deps, projectMembers: p.w.members, signInStore: p.w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
      taskView: async (task: { taskId: string; project: string }) => ({ taskId: task.taskId, title: "t", project: task.project, status: "RUNNING", startingRevision: 1, client: "x", shared: false, createdAt: iso(T0), updatedAt: iso(T0), events: [] }) as never,
    }, p.w.caller(PRIYA), s.sessionId);
    expect(view.status).toBe("running");
    expect(view.cost.spentUsd).toBe(0.75);
  });

  it("the summary's digest ignores computedAt, and is the SHA-256 of its canonical JSON", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    const session = (await new AgentSessionStore(p.deps).get(ORG_A, s.sessionId))!;
    const one = await computeSessionSummary(p.deps, session);
    p.w.clock.now += 5000;
    const two = await computeSessionSummary(p.deps, session);
    expect(one.digest).toBe(two.digest);
    expect(one.computedAt).not.toBe(two.computedAt);
    const { digest: _d, computedAt: _c, ...rest } = one; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    expect(sessionSummaryDigest(rest)).toBe(one.digest);
    expect(sessionSummaryDigest({ ...rest, costUsd: 1 })).not.toBe(one.digest);
  });

  it("uses the event ids of the summary revision, so a retry of a lost race writes the same event", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    p.patchTask(s.taskId, { workflow: workflow("IMPLEMENT", "RUNNING") });
    await p.refresh(s.sessionId);
    expect(p.events(s.sessionId)[0]!.eventId).toBe(sessionEventId("step", `${s.sessionId}:2`));
  });
});

describe("what the projector reads", () => {
  it("maps an operation, a run, an approval and the counter to their session, and the task itself", async () => {
    const p = projectorWorld();
    const s = p.open();
    const op = p.operation(s.workspaceId, "task", "RUNNING");
    expect(await p.project([op])).toMatchObject({ refreshed: 1 }); // operation -> pointer -> task -> session
    expect(p.sessionOf(s.sessionId).summary.status).toBe("running");
    p.setOperation(op, "CANCELLED");
    expect(await p.project([{ pk: `DEVTASK#${s.taskId}`, sk: "AGENT_RUN", entityType: "AGENT_RUN", orgId: ORG_A }])).toMatchObject({ refreshed: 1 });
    expect(p.sessionOf(s.sessionId).summary.status).toBe("stopped");
  });

  it("never reacts to Plan 5's own writes", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    const own = [
      p.w.db.get(agentSessionKey(ORG_A, s.sessionId, "META"))!,
      p.w.db.get(liveSessionKey(ORG_A, s.sessionId))!,
      p.w.db.get(openAgentSessionKey(ORG_A, s.sessionId))!,
      { pk: `ORG#${ORG_A}#CHANGES#${PRIYA}`, sk: `${iso(T0)}#000001`, entityType: "CHANGE", orgId: ORG_A, sessionId: s.sessionId },
      { pk: "ENDED_AGENT_SESSIONS#2026-10-22", sk: `${ORG_A}#${s.sessionId}`, entityType: "ENDED_AGENT_SESSION", orgId: ORG_A, sessionId: s.sessionId },
      { pk: `ORG#${ORG_A}#DEVICE#dvc_0123456789abcdefghij`, sk: "META", entityType: "DEVICE", orgId: ORG_A },
      { pk: `ORG#${ORG_A}#AGENT_SESSION#${s.sessionId}`, sk: `EVENT#${iso(T0)}#evt_000000000000000000000000`, entityType: "AGENT_SESSION_EVENT", orgId: ORG_A, sessionId: s.sessionId },
    ];
    const before = p.w.db.commandNames().length;
    expect(await p.project(own)).toMatchObject({ refreshed: 0, skipped: 0 });
    expect(p.w.db.commandNames().length).toBe(before); // not even a read
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(1);
  });

  it("skips a record whose own org disagrees with its key, and logs it", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    expect(await p.project([{ ...taskSpendKey(ORG_A, s.taskId), entityType: "TASK_SPENT", orgId: ORG_B, settledUsd: 9 }])).toMatchObject({ refreshed: 0 });
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.projector_org_mismatch");
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(1);
  });

  it("skips a counter whose key org is not the org of the task it names", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    expect(await p.project([{ ...taskSpendKey(ORG_B, s.taskId), entityType: "TASK_SPENT", orgId: ORG_B, settledUsd: 9 }])).toMatchObject({ refreshed: 0, unchanged: 0 });
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.projector_org_mismatch");
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(1);
  });

  it("does not refresh another org's session through a task that says it belongs elsewhere", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    const task = p.patchTask(s.taskId, { orgId: ORG_B });
    expect(await p.project([task])).toMatchObject({ refreshed: 0 });
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(1);
  });

  it("de-duplicates sessions and refreshes a session once per batch", async () => {
    const p = projectorWorld();
    const s = p.open();
    const op = p.operation(s.workspaceId, "task", "RUNNING");
    const task = taskOf(p, s.taskId);
    expect(await p.project([task, op, task, { ...taskSpendKey(ORG_A, s.taskId), entityType: "TASK_SPENT", orgId: ORG_A, settledUsd: 1 }])).toMatchObject({ refreshed: 1 });
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(2);
    const calls: string[] = [];
    const refresh = async (_deps: unknown, _org: unknown, id: string) => { calls.push(id); return "unchanged" as const; };
    await p.project([task, op, task, { ...taskSpendKey(ORG_A, s.taskId), entityType: "TASK_SPENT", orgId: ORG_A, settledUsd: 1 }], Date.now() + 60_000, { refresh });
    expect(calls).toEqual([s.sessionId]);
  });
});

describe("the projector's budget", () => {
  it("starts no refresh after its deadline, runs at most 8 at once, and reports the rest skipped for the sweep to bring up to date", async () => {
    const p = projectorWorld();
    const sessions = Array.from({ length: 100 }, () => p.open());
    for (const s of sessions) p.operation(s.workspaceId, "task", "RUNNING");
    // A fake clock that moves 50 ms for every read.
    const clock = { now: T0 };
    const base = p.w.db.send.bind(p.w.db);
    const timed = { send: async (command: unknown) => { clock.now += 50; return base(command as never); } };
    const started: string[] = [];
    let running = 0;
    let peak = 0;
    const refresh = async (_deps: unknown, _org: unknown, id: string) => {
      started.push(id);
      running += 1;
      peak = Math.max(peak, running);
      try {
        for (let n = 0; n < 4; n += 1) await timed.send({ constructor: { name: "GetCommand" }, input: { TableName: "state", Key: agentSessionKey(ORG_A, id, "META"), ConsistentRead: true } });
        return "updated" as const;
      } finally { running -= 1; }
    };
    const deadline = T0 + 2000;
    const deps = { ...p.deps, now: () => clock.now, refresh };
    const result = await projectSessions(sessions.map((s) => p.stream(taskOf(p, s.taskId))), deps, { deadline });
    expect(peak).toBeLessThanOrEqual(PROJECTOR_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(started.length).toBeGreaterThan(0);
    expect(result.skipped).toBe(100 - started.length);
    expect(started.length).toBeLessThan(100);
    // Every refresh began before the deadline; none after.
    expect(result.skipped).toBeGreaterThan(0);
    // The next sweep brings the rest up to date (see agent-session-sweep.test.ts); a refresh on its own does.
    for (const s of sessions) await p.refresh(s.sessionId);
    expect(sessions.every((s) => p.sessionOf(s.sessionId).summary.status === "running")).toBe(true);
  });

  it("counts a refresh that throws as failed, logs it by name, and still refreshes the others", async () => {
    const p = projectorWorld();
    const [one, two, three] = [p.open(), p.open(), p.open()];
    const seen: string[] = [];
    const refresh = async (_deps: unknown, _org: unknown, id: string) => {
      if (id === two.sessionId) throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      seen.push(id);
      return "updated" as const;
    };
    const result = await projectSessions([one, two, three].map((s) => p.stream(taskOf(p, s.taskId))), { ...p.deps, refresh }, { deadline: Date.now() + 60_000 });
    expect(result).toMatchObject({ refreshed: 2, failed: 1 });
    expect(seen.sort()).toEqual([one.sessionId, three.sessionId].sort());
    expect(p.logs).toContainEqual(expect.objectContaining({ event: "agent_session.projector_refresh_failed", error: "ThrottlingException" }));
  });

  it("refreshes at most PROJECTOR_SESSIONS_PER_BATCH_MAX sessions and counts the others skipped", async () => {
    const p = projectorWorld();
    const sessions = Array.from({ length: 105 }, () => p.open());
    const calls: string[] = [];
    const refresh = async (_deps: unknown, _org: unknown, id: string) => { calls.push(id); return "unchanged" as const; };
    const result = await projectSessions(sessions.map((s) => p.stream(taskOf(p, s.taskId))), { ...p.deps, refresh }, { deadline: Date.now() + 60_000 });
    expect(calls).toHaveLength(100);
    expect(result.skipped).toBe(5);
  });
});

describe("the publisher with the projector", () => {
  it("runs both indexes together; one failing is logged by name and never fails the batch or changes what was published", async () => {
    const send = vi.fn(async () => undefined);
    const markQueued = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const outbox = { eventName: "INSERT", dynamodb: { NewImage: marshall({ pk: "OUTBOX#o1", sk: "OUTBOX", entityType: "OUTBOX", status: "PENDING", id: "o1", operationId: "op", workspaceId: "ws" }) } };
    const activity = vi.fn(async () => ({ failures: 0 }));
    const sessions = vi.fn(async (...args: unknown[]) => { void args; throw Object.assign(new Error("slow down"), { name: "ThrottlingException" }); });
    const handler = createOutboxPublisherHandler({ send, markQueued, index: indexTogether({ activity, sessions }) });
    expect(await handler({ Records: [outbox] })).toEqual({ published: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(markQueued).toHaveBeenCalledWith("o1");
    expect(activity).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(JSON.stringify({ component: "outbox-publisher", event: "session_projector.failed", error: "ThrottlingException" }));
    // The other way round: the activity index fails, the sessions are still projected.
    activity.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "ValidationException" }));
    sessions.mockResolvedValueOnce(undefined as never);
    expect(await handler({ Records: [outbox] }, { getRemainingTimeInMillis: () => 30_000 })).toEqual({ published: 1 });
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(sessions.mock.calls[1]![1]).toEqual({ deadline: expect.any(Number) as number });
    expect(log.mock.calls.map((call) => String(call[0]))).toContain(JSON.stringify({ component: "outbox-publisher", event: "activity_index.write_failed", error: "ValidationException" }));
    log.mockRestore();
  });
});
