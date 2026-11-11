// Plan 5 Task 7a review fixes (task-7a-review.md): the spend-request slot a paused task waits on is read under the writer's key; a workflow stage waits on a
// person only when a person is what it waits for; an unreadable source leaves the summary as it was; a late-found end files its work item where the drain
// looks; one bad work item never stops the drain; a summary is validated before it is written and the chain and device facts are validated at the seam.
import { describe, expect, it, vi } from "vitest";
import { SESSION_RETENTION_DAYS, SessionSummarySchema, agentSessionKey, endedSessionWorkKey, mySessionsKey } from "@rovara-code/contracts";
import { scopeKey, spendRequestKey, spendRequestSlotKey } from "@agentx/cloud-contracts";
import { ENDED_DRAIN_CURSOR_KEY, drainEndedSessions } from "../../packages/broker/src/agent-sessions/sweep.js";
import { ARJUN, ORG_A, ORG_B, PRIYA, T0 } from "../support/agent-session-world.js";
import { iso, projectorWorld, workflow, type PW } from "../support/agent-session-projector-world.js";

type Item = Record<string, unknown>;
const DAY = 86_400;
const REQUEST = "spr_0123456789abcdefghij";

const request = (p: PW, taskId: string, subject: string, kind: string, patch: Item = {}) => {
  p.w.db.set({
    ...spendRequestKey(ORG_A, REQUEST), entityType: "SPEND_REQUEST", orgId: ORG_A, spendRequestId: REQUEST, kind, taskId, status: "PENDING", approverIds: [ARJUN],
    amountUsd: 5, reason: "x", requestedBy: PRIYA, createdAt: iso(T0), expiresAt: iso(T0 + 3_600_000), ...patch,
  });
  p.w.db.set({ ...spendRequestSlotKey(ORG_A, subject, kind), entityType: "SPEND_REQUEST_SLOT", orgId: ORG_A, spendRequestId: REQUEST, createdAt: iso(T0) });
};

describe("I-1: the slot is read under the writer's key", () => {
  it.each([["run_limit", { kind: "task" }], ["max_per_run", { kind: "max_per_run" }], ["planning", { kind: "planning" }]] as const)("a task paused on %s finds the request kept under TASK#<id>", async (kind, scope) => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    p.patchTask(s.taskId, { budgetPause: { scope, at: iso(T0) } });
    request(p, s.taskId, `TASK#${s.taskId}`, kind);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "paused", needsPeople: [ARJUN], pendingApprovals: 1 });
  });

  it("a request kept under the bare task id (a key nothing writes) is not found", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    p.patchTask(s.taskId, { budgetPause: { scope: { kind: "task" }, at: iso(T0) } });
    request(p, s.taskId, s.taskId, "run_limit");
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ needsPeople: [], pendingApprovals: 0 });
  });

  it("a task paused on a month's budget finds the month's request, kept under the month's subject", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    const scope = { kind: "member", developerId: PRIYA };
    p.patchTask(s.taskId, { budgetPause: { scope, at: iso(T0) } });
    request(p, s.taskId, `MONTH#${iso(T0).slice(0, 7)}#${scopeKey(scope as never)}#system`, "month");
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ status: "paused", needsPeople: [ARJUN], pendingApprovals: 1 });
  });
});

describe("I-1 (months): a pause raised late in a month is found in the month the request was made", () => {
  it("a pause written last month whose request was made this month is found under this month's subject", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    const scope = { kind: "member", developerId: PRIYA };
    p.patchTask(s.taskId, { budgetPause: { scope, at: "2026-09-30T23:00:00.000Z" } });
    request(p, s.taskId, `MONTH#${iso(T0).slice(0, 7)}#${scopeKey(scope as never)}#system`, "month");
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ needsPeople: [ARJUN], pendingApprovals: 1 });
  });
});

describe("I-2: only a stage that waits on a person is 'waiting'", () => {
  it.each([["VERIFY"], ["REVIEW"], ["PLAN"], ["IMPLEMENT"], ["PULL_REQUEST"]])("%s/WAITING is automatic work: running, with no 'Waiting for you' event", async (stage) => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { workflow: workflow(stage, "WAITING") });
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("running");
    expect(p.events(s.sessionId).map((event) => event.text).join("|")).not.toContain("Waiting for you");
  });

  it("WAIT_FOR_MERGE/WAITING waits for a person to merge; PLAN_REVIEW/WAITING still needs the owner", async () => {
    const p = projectorWorld();
    const merge = p.open();
    p.patchTask(merge.taskId, { workflow: workflow("WAIT_FOR_MERGE", "WAITING") });
    await p.refresh(merge.sessionId);
    expect(p.sessionOf(merge.sessionId).summary.status).toBe("waiting");
    const review = p.open();
    p.patchTask(review.taskId, { workflow: workflow("PLAN_REVIEW", "WAITING") });
    await p.refresh(review.sessionId);
    expect(p.sessionOf(review.sessionId).summary).toMatchObject({ status: "needs_person", needsPeople: [PRIYA] });
  });
});

describe("I-3: an unreadable source leaves the summary as it was", () => {
  const throttled = () => Object.assign(new Error("slow down"), { name: "ThrottlingException" });
  const agentTask = () => {
    const p = projectorWorld();
    const s = p.open({ task: { agent: { agentId: "triage", name: "Triage", version: 1 }, origin: "app", startedBy: { developerId: PRIYA } } });
    p.operation(s.workspaceId, "task", "RUNNING");
    p.w.db.set({
      pk: `DEVTASK#${s.taskId}`, sk: "AGENT_RUN", entityType: "AGENT_RUN", orgId: ORG_A, revision: 1, state: "WAITING_FOR_APPROVAL", cursor: 0, input: { text: "Triage the inbox" },
      steps: [{ id: "work", status: "waiting", operationIds: [], approvalIds: [] }], reports: [],
    });
    return { p, s };
  };

  it("a throttled read of the run does not turn needs_person into running, and writes no event", async () => {
    const { p, s } = agentTask();
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("needs_person");
    const events = p.events(s.sessionId).length;
    const revision = p.sessionOf(s.sessionId).summaryRevision;
    const send = p.w.db.send.bind(p.w.db);
    const spy = vi.spyOn(p.w.db, "send").mockImplementation(async (command: unknown) => {
      const key = (command as { input?: { Key?: { sk?: string } } }).input?.Key;
      if (key?.sk === "AGENT_RUN") throw throttled();
      return send(command as never);
    });
    await expect(p.refresh(s.sessionId)).rejects.toMatchObject({ name: "ThrottlingException" });
    spy.mockRestore();
    expect(p.sessionOf(s.sessionId).summary.status).toBe("needs_person");
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(revision);
    expect(p.events(s.sessionId)).toHaveLength(events);
  });

  it("a read that fails while the projector refreshes is counted failed, and the sessions beside it are still refreshed", async () => {
    const { p, s } = agentTask();
    const other = p.open();
    p.operation(other.workspaceId, "task", "RUNNING");
    await p.refresh(s.sessionId);
    const send = p.w.db.send.bind(p.w.db);
    const spy = vi.spyOn(p.w.db, "send").mockImplementation(async (command: unknown) => {
      if ((command as { input?: { Key?: { sk?: string } } }).input?.Key?.sk === "AGENT_RUN") throw throttled();
      return send(command as never);
    });
    const result = await p.project([p.w.db.get({ pk: `DEVTASK#${s.taskId}`, sk: "META" })!, p.w.db.get({ pk: `DEVTASK#${other.taskId}`, sk: "META" })!]);
    spy.mockRestore();
    expect(result).toMatchObject({ failed: 1, refreshed: 1 });
    expect(p.sessionOf(s.sessionId).summary.status).toBe("needs_person");
    expect(p.sessionOf(other.sessionId).summary.status).toBe("running");
  });

  it("an unreadable event log keeps the peek the summary had", async () => {
    const p = projectorWorld();
    const s = p.open();
    const op = p.operation(s.workspaceId, "task", "RUNNING");
    p.eventOf(String(op.id), 1, "Reading the repository");
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.peek).toBe("Reading the repository");
    p.spent(s.taskId, 1);
    const send = p.w.db.send.bind(p.w.db);
    const spy = vi.spyOn(p.w.db, "send").mockImplementation(async (command: unknown) => {
      const input = (command as { input?: { KeyConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } }).input;
      const partition = input?.ExpressionAttributeValues?.[":pk"];
      if (typeof partition === "string" && partition.startsWith("OPERATION#")) throw throttled();
      return send(command as never);
    });
    await p.refresh(s.sessionId);
    spy.mockRestore();
    expect(p.sessionOf(s.sessionId).summary).toMatchObject({ peek: "Reading the repository", costUsd: 1 });
  });
});

describe("I-4: an end found late is filed where the drain looks", () => {
  const seedShare = (p: PW, sessionId: string) => {
    const share = agentSessionKey(ORG_A, sessionId, "SHARE#MEMBER#x");
    p.w.db.set({ ...share, orgId: ORG_A, sessionId, entityType: "AGENT_SESSION_SHARE", principal: { kind: "member", developerId: "x".repeat(64) }, level: "view" });
    const mine = mySessionsKey(ORG_A, PRIYA, "2026-10-22T08:00:00.000Z", sessionId);
    p.w.db.set({ ...mine, orgId: ORG_A, sessionId });
    return { share, mine };
  };

  it("a session of an old closed task, ended after the drain's saved day moved on, still has its items given an expiry", async () => {
    const p = projectorWorld();
    // An end on 2026-10-21 moves the drain's day to that day.
    const first = p.open();
    p.operation(first.workspaceId, "task", "SUCCEEDED");
    p.patchTask(first.taskId, { closedAt: "2026-10-21T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-21T09:00:00.000Z");
    await p.refresh(first.sessionId);
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    // Now an old task (closed on the 18th) is first looked at.
    const old = p.open();
    p.operation(old.workspaceId, "task", "SUCCEEDED");
    p.patchTask(old.taskId, { closedAt: "2026-10-18T08:30:00.000Z" });
    const keys = seedShare(p, old.sessionId);
    await p.refresh(old.sessionId);
    expect(p.sessionOf(old.sessionId).endedAt).toBe("2026-10-18T08:30:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    await drainEndedSessions(p.deps, p.w.clock.now);
    const expires = Math.floor(Date.parse("2026-10-18T08:30:00.000Z") / 1000) + SESSION_RETENTION_DAYS * DAY;
    expect(p.w.db.get(keys.share)?.indexExpiresAt).toBe(expires);
    expect(p.w.db.get(keys.mine)?.indexExpiresAt).toBe(expires);
    expect(p.w.db.find((item) => String(item.pk).startsWith("ENDED_AGENT_SESSIONS#") && item.sessionId === old.sessionId)).toHaveLength(0);
  });

  it("files the work item under the day of the refresh, whatever day the end was", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-18T08:30:00.000Z" });
    await p.refresh(s.sessionId);
    expect(p.w.db.get(endedSessionWorkKey("2026-10-22", ORG_A, s.sessionId))).toMatchObject({ endedAt: "2026-10-18T08:30:00.000Z" });
  });

  it("an end writes no drain cursor inside its transaction (the cursor is not a hot item)", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-18T08:30:00.000Z" });
    await p.refresh(s.sessionId);
    const ending = p.w.db.transactions().at(-1)!;
    expect(ending.some((entry) => JSON.stringify(entry).includes(ENDED_DRAIN_CURSOR_KEY.pk))).toBe(false);
  });

  it("a drain with no saved day starts two days back, so the first end is never missed", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-21T08:30:00.000Z" });
    const keys = seedShare(p, s.sessionId);
    // Refreshed yesterday (the work item is filed under yesterday), the saved day lost, drained today.
    p.w.clock.now = Date.parse("2026-10-21T09:00:00.000Z");
    await p.refresh(s.sessionId);
    p.w.clock.now = Date.parse("2026-10-22T09:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    expect(p.w.db.get(keys.share)?.indexExpiresAt).toBeDefined();
  });
});

describe("I-5: one bad work item never stops the drain", () => {
  it("logs it, skips it, and drains the sessions behind it", async () => {
    const p = projectorWorld();
    const bad = p.open();
    const good = p.open();
    for (const s of [bad, good]) {
      p.operation(s.workspaceId, "task", "SUCCEEDED");
      p.patchTask(s.taskId, { closedAt: "2026-10-21T08:30:00.000Z" });
    }
    p.w.clock.now = Date.parse("2026-10-21T09:00:00.000Z");
    await p.refresh(bad.sessionId);
    await p.refresh(good.sessionId);
    // The one that sorts first has a META that no longer parses; the other has a share to give an expiry to.
    const [corrupt, sound] = [bad, good].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    p.w.db.set({ ...p.w.db.get(agentSessionKey(ORG_A, corrupt!.sessionId, "META"))!, summary: { nonsense: true } });
    p.w.db.set({ ...agentSessionKey(ORG_A, sound!.sessionId, "SHARE#MEMBER#x"), orgId: ORG_A, sessionId: sound!.sessionId, principal: { kind: "member", developerId: "x".repeat(64) }, level: "view" });
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    const result = await drainEndedSessions(p.deps, p.w.clock.now);
    expect(result).toMatchObject({ drained: 1, pending: true });
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.drain_failed");
    expect(p.w.db.get(agentSessionKey(ORG_A, sound!.sessionId, "SHARE#MEMBER#x"))?.indexExpiresAt).toBeDefined();
    expect(p.w.db.find((item) => String(item.pk).startsWith("ENDED_AGENT_SESSIONS#") && item.sessionId === sound!.sessionId)).toHaveLength(0);
  });

  it("deletes a work item that names another org than its key (after logging it)", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-21T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-21T09:00:00.000Z");
    await p.refresh(s.sessionId);
    const work = endedSessionWorkKey("2026-10-21", ORG_A, s.sessionId);
    p.w.db.set({ ...p.w.db.get(work)!, orgId: ORG_B });
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.drain_org_mismatch");
    expect(p.w.db.get(work)).toBeUndefined();
  });

  it("gives up on an item that keeps failing: after five tries it is parked with an expiry and no longer read", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-21T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-21T09:00:00.000Z");
    await p.refresh(s.sessionId);
    p.w.db.set({ ...p.w.db.get(agentSessionKey(ORG_A, s.sessionId, "META"))!, summary: { nonsense: true } });
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    for (let run = 0; run < 7; run += 1) await drainEndedSessions(p.deps, p.w.clock.now);
    const failures = p.logs.filter((entry) => entry.event === "agent_session.drain_failed");
    expect(failures).toHaveLength(5);
    const work = p.w.db.get(endedSessionWorkKey("2026-10-21", ORG_A, s.sessionId))!;
    expect(work.failures).toBe(5);
    expect(typeof work.indexExpiresAt).toBe("number");
  });

  it("keeps retrying a work item of an older day until it is parked: the saved day does not pass it", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-18T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-18T09:00:00.000Z");
    await p.refresh(s.sessionId);
    p.w.db.set({ ...p.w.db.get(agentSessionKey(ORG_A, s.sessionId, "META"))!, summary: { nonsense: true } });
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    for (let run = 1; run <= 7; run += 1) {
      await drainEndedSessions(p.deps, p.w.clock.now);
      // The saved day stays at the failed item's day for the four runs that leave it to try again, and moves on in the run that parks it.
      expect(p.w.db.get(ENDED_DRAIN_CURSOR_KEY)?.day, `run ${String(run)}`).toBe(run < 5 ? "2026-10-18" : "2026-10-21");
    }
    expect(p.logs.filter((entry) => entry.event === "agent_session.drain_failed")).toHaveLength(5);
    const work = p.w.db.get(endedSessionWorkKey("2026-10-18", ORG_A, s.sessionId))!;
    expect(work.failures).toBe(5);
    expect(typeof work.indexExpiresAt).toBe("number");
    // Once parked it no longer holds the saved day back.
    expect(p.w.db.get(ENDED_DRAIN_CURSOR_KEY)?.day).toBe("2026-10-21");
  });

  it("an item another run finished meanwhile (its tally can't be written) does not hold the saved day back", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-18T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-18T09:00:00.000Z");
    await p.refresh(s.sessionId);
    p.w.db.set({ ...p.w.db.get(agentSessionKey(ORG_A, s.sessionId, "META"))!, summary: { nonsense: true } });
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    const gone = { send: async (command: { constructor: { name: string }; input: { Key?: { pk: string } } }) => {
      if (command.constructor.name === "UpdateCommand" && command.input.Key?.pk.startsWith("ENDED_AGENT_SESSIONS#")) throw Object.assign(new Error("gone"), { name: "ConditionalCheckFailedException" });
      return p.w.db.send(command);
    } };
    await drainEndedSessions({ ...p.deps, documentClient: gone }, p.w.clock.now);
    expect(p.w.db.get(ENDED_DRAIN_CURSOR_KEY)?.day).toBe("2026-10-21");
  });

  it("a failed item of an older day does not stop the days after it from being drained", async () => {
    const p = projectorWorld();
    const bad = p.open();
    const good = p.open();
    p.operation(bad.workspaceId, "task", "SUCCEEDED");
    p.operation(good.workspaceId, "task", "SUCCEEDED");
    p.patchTask(bad.taskId, { closedAt: "2026-10-18T08:30:00.000Z" });
    p.patchTask(good.taskId, { closedAt: "2026-10-20T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-18T09:00:00.000Z");
    await p.refresh(bad.sessionId);
    p.w.clock.now = Date.parse("2026-10-20T09:00:00.000Z");
    await p.refresh(good.sessionId);
    p.w.db.set({ ...p.w.db.get(agentSessionKey(ORG_A, bad.sessionId, "META"))!, summary: { nonsense: true } });
    p.w.db.set({ ...agentSessionKey(ORG_A, good.sessionId, "SHARE#MEMBER#x"), orgId: ORG_A, sessionId: good.sessionId, principal: { kind: "member", developerId: "x".repeat(64) }, level: "view" });
    p.w.db.set({ ...ENDED_DRAIN_CURSOR_KEY, entityType: "ENDED_DRAIN_CURSOR", day: "2026-10-18" });
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    await drainEndedSessions(p.deps, p.w.clock.now);
    expect(p.w.db.get(agentSessionKey(ORG_A, good.sessionId, "SHARE#MEMBER#x"))?.indexExpiresAt).toBeDefined();
    // The saved day stays at the failed item's day.
    expect(p.w.db.get(ENDED_DRAIN_CURSOR_KEY)?.day).toBe("2026-10-18");
  });

  it("every work item carries an expiry of its own, so a lost drain cannot keep it for ever", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-21T08:30:00.000Z" });
    await p.refresh(s.sessionId);
    const work = p.w.db.find((item) => String(item.pk).startsWith("ENDED_AGENT_SESSIONS#"))[0]!;
    expect(typeof work.indexExpiresAt).toBe("number");
  });
});

describe("I-6: a summary is validated before it is written, and the seams are validated", () => {
  const chain = () => {
    const p = projectorWorld();
    const session = p.w.seedSession({ kind: "chain" });
    return { p, session };
  };
  const facts = (extra: Item = {}) => ({ orgId: ORG_A, status: "running" as const, stepName: "Build", spentUsd: 1, ...extra });

  it("a chain fact that would make the summary invalid writes nothing and logs it; the session stays readable", async () => {
    const { p, session } = chain();
    await p.refresh(session.sessionId, ORG_A, { chains: { read: async () => facts({ needsPeople: ["a\nb"] }) } });
    // The control characters are cleaned, so what is written is valid.
    expect(SessionSummarySchema.safeParse(p.sessionOf(session.sessionId).summary).success).toBe(true);
    expect(p.sessionOf(session.sessionId).summary.needsPeople).toEqual(["a b"]);
  });

  it.each([
    ["a status that is not one", { status: "exploded" }],
    ["a negative cost", { spentUsd: -4 }],
    ["a cost that is not a number", { spentUsd: Number.NaN }],
    ["an end that is not an instant", { status: "succeeded", endedAt: "yesterday" }],
    ["another org's facts", { orgId: ORG_B }],
    ["no org", { orgId: undefined }],
  ])("%s leaves the session as it was", async (_label, patch) => {
    const { p, session } = chain();
    const before = JSON.stringify(p.sessionOf(session.sessionId));
    await p.refresh(session.sessionId, ORG_A, { chains: { read: async () => facts(patch) } });
    expect(JSON.stringify(p.sessionOf(session.sessionId))).toBe(before);
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.facts_invalid");
  });

  it.each([
    ["a status that is not one", { status: "exploded" }],
    ["an update time that does not parse", { updatedAt: "later" }],
    ["an end that does not parse", { status: "succeeded", endedAt: "soon" }],
    ["an infinite cost", { costUsd: Number.POSITIVE_INFINITY }],
    ["another org's facts", { orgId: ORG_B }],
  ])("a device fact with %s leaves the session as it was", async (_label, patch) => {
    const p = projectorWorld();
    const local = p.w.seedSession({ kind: "local", owner: PRIYA });
    const before = JSON.stringify(p.sessionOf(local.sessionId));
    await p.refresh(local.sessionId, ORG_A, { local: { read: async () => ({ orgId: ORG_A, status: "running", costUsd: 1, updatedAt: iso(T0), ...patch }) } });
    expect(JSON.stringify(p.sessionOf(local.sessionId))).toBe(before);
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.facts_invalid");
  });

  it("a device that is silent past the limit is offline, and a valid fact is used as it was", async () => {
    const p = projectorWorld();
    const local = p.w.seedSession({ kind: "local", owner: PRIYA });
    await p.refresh(local.sessionId, ORG_A, { local: { read: async () => ({ orgId: ORG_A, status: "running", step: "Writing", costUsd: 0.5, updatedAt: iso(T0 - 11 * 60_000) }) } });
    expect(p.sessionOf(local.sessionId).summary).toMatchObject({ status: "running", offline: true, costUsd: 0.5 });
  });

  it("a summary the schema refuses is not written: nothing changes and the refresh logs it", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "RUNNING");
    // A corrupt run limit on the task (negative) would make the summary invalid.
    p.patchTask(s.taskId, { budgetUsd: -5 });
    const before = JSON.stringify(p.sessionOf(s.sessionId));
    expect(await p.refresh(s.sessionId)).toBe("unchanged");
    expect(JSON.stringify(p.sessionOf(s.sessionId))).toBe(before);
    expect(p.logs.map((entry) => entry.event)).toContain("agent_session.summary_invalid");
    // The session is still readable, and a task that is sound again is refreshed.
    p.patchTask(s.taskId, { budgetUsd: 5 });
    expect(await p.refresh(s.sessionId)).toBe("updated");
    expect(SessionSummarySchema.safeParse(p.sessionOf(s.sessionId).summary).success).toBe(true);
  });
});

describe("minors", () => {
  it("an end does not rewrite the session's legs (a take-over between the read and the write is never overwritten)", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: iso(T0) });
    await p.refresh(s.sessionId);
    expect(JSON.stringify(p.w.db.transactions().at(-1))).not.toContain("legs");
  });

  it("the drain's budget can be cut by the caller, so the broker's event stays inside its timeout", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: "2026-10-21T08:30:00.000Z" });
    p.w.clock.now = Date.parse("2026-10-21T09:00:00.000Z");
    await p.refresh(s.sessionId);
    p.w.clock.now = Date.parse("2026-10-22T12:00:00.000Z");
    expect(await drainEndedSessions(p.deps, p.w.clock.now, { budgetMs: 0 })).toMatchObject({ drained: 0, pending: true });
    expect(p.w.db.get(endedSessionWorkKey("2026-10-21", ORG_A, s.sessionId))).toBeDefined();
  });
});
