// Stop & redirect, phase 1 (R2): the route that records the owner's instruction and stops the step. Every guard here has a test that fails without it: the owner check (and that a refusal writes
// nothing at all), the strict body, the rates (3 per step attempt, 5 per task per hour, and the person's steer rate), the worker feature check, the task-state guard inside the transaction,
// the in-flight marker, idempotency by request id, and the cancel that must follow the commit. Phase 2 (the restart) is `redirect-continue.test.ts`.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OWNER_REDIRECT_FEATURE, REDIRECT_REFUSAL_MESSAGES, REDIRECT_SLACK_STATUS_LINE, agentSessionKey, agentXError, type OrgId } from "@rovara-code/contracts";
import { WORKFLOW_BLOCK_REASONS } from "@agentx/cloud-contracts";
import { redirectSession, type RedirectConfig, type RedirectDependencies } from "../../packages/broker/src/agent-sessions/redirect.js";
import { endRedirect, readOpenRedirect, readRedirect, redirectKey } from "../../packages/broker/src/agent-sessions/redirect-state.js";
import { stopSession } from "../../packages/broker/src/agent-sessions/stop.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, MAX, MIA, OLA, ORG_A, ORG_B, BO, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const TEXT = "use the retry helper in payments.ts instead, REDIRECT-SECRET-TEXT-5521";

function world(options: { features?: readonly string[] | "down" | undefined; stage?: string; state?: string; workflow?: Record<string, unknown>; planChanges?: false; people?: Array<{ developerId: string; role: "owner" | "commenter" | "viewer" | "denied" }>; currentOwner?: string } = {}) {
  const w = sessionWorld();
  const made = w.seedSession({ kind: "task", ...(options.people === undefined ? {} : { people: options.people }), ...(options.currentOwner === undefined ? {} : { currentOwner: options.currentOwner }) });
  const patchTask = (fields: Record<string, unknown>) => w.db.set({ ...(w.db.get(taskKey(made.taskId)) as Item), ...fields });
  patchTask({ workflow: { revision: 3, stage: options.stage ?? "IMPLEMENT", state: options.state ?? "RUNNING", decisions: [], definitionVersion: "1.0.0", ...options.workflow } });
  const calls = { cancel: [] as Array<{ taskId: string; requestId: string }>, features: 0, gate: [] as Array<{ taskId: string; who: string }>, continued: [] as string[], plan: [] as Array<Record<string, unknown>> };
  const live = { cancelFailure: undefined as Error | undefined, sendBackRefusal: undefined as Error | undefined };
  const redirect: RedirectConfig = {
    workerFeatures: async () => { calls.features += 1; if (options.features === "down") throw new Error("ping failed"); return options.features ?? [OWNER_REDIRECT_FEATURE]; },
    sendBackAllowed: async (task, who) => { calls.gate.push({ taskId: task.taskId, who: who.developerId }); if (live.sendBackRefusal !== undefined) throw live.sendBackRefusal; },
    continueRedirect: async (taskId) => { calls.continued.push(taskId); },
  };
  const deps = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: "https://cell.example.com", cursorKey: "k".repeat(64),
    taskView: async (task: { taskId: string; project: string }) => ({ taskId: task.taskId, title: "Fix", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
    control: {
      cancelTask: async (task: { taskId: string }, requestId: string) => { calls.cancel.push({ taskId: task.taskId, requestId }); if (live.cancelFailure !== undefined) throw live.cancelFailure; },
      ...(options.planChanges === false ? {} : { requestPlanChanges: async (_task: unknown, input: Record<string, unknown>) => { calls.plan.push(input); } }),
      retryWorkflow: async () => undefined, startAgentRun: async () => { throw new Error("not asked"); },
    },
    redirect,
  } as unknown as RedirectDependencies;
  const body = (fields: Record<string, unknown> = {}) => ({ requestId: randomUUID(), text: TEXT, mode: "keep_plan", ...fields });
  const go = (who: string, fields: Record<string, unknown> = {}, orgId: OrgId = ORG_A, sessionId: string = made.sessionId) => redirectSession(deps, w.caller(who, orgId), sessionId, body(fields));
  const table = () => JSON.stringify([...w.db.items.entries()].sort(([left], [right]) => (left < right ? -1 : 1)));
  const sessionItems = (prefix: string) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, made.sessionId, "META").pk && String(item.sk).startsWith(prefix));
  const records = () => w.db.find((item) => item.pk === `DEVTASK#${made.taskId}` && String(item.sk).startsWith("REDIRECT#")) as Item[];
  const notes = () => w.db.find((item) => item.pk === `DEVTASK#${made.taskId}` && String(item.sk).startsWith("NOTE#"));
  const task = () => w.db.get(taskKey(made.taskId)) as Item;
  /** Ends the redirect in flight, as phase 2 does, so the next request is not refused as busy. */
  const finish = async (requestId: string, to: "restarted" | "left_blocked" = "restarted") => { await endRedirect({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, { taskId: made.taskId, requestId }, ["stopping"], to); };
  return { w, made, deps, calls, live, redirect, go, table, sessionItems, records, notes, patchTask, task, finish, body };
}

describe("a redirect from the owner (R2, phase 1)", () => {
  it("records the instruction as the owner's steer message and note, writes the record and the in-flight marker, stops the task with the request id, and answers `stopping`", async () => {
    const s = world();
    const requestId = randomUUID();
    const answer = await s.go(PRIYA, { requestId, mode: "keep_plan" });
    expect(answer.redirect).toMatchObject({ requestId, mode: "keep_plan", state: "stopping" });
    expect(answer.session.sessionId).toBe(s.made.sessionId);
    // The stop is the same cancel as Stop, asked once, with the redirect's request id.
    expect(s.calls.cancel).toEqual([{ taskId: s.made.taskId, requestId }]);
    // The message: a steer message from the owner, queued, with the text; its note is the owner's.
    const messages = s.sessionItems("MESSAGE#msg_");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "steer", source: "app", text: TEXT, delivery: { state: "queued" }, author: { developerId: PRIYA } });
    const [note] = s.notes();
    expect(note).toMatchObject({ isOwner: true, developerId: PRIYA, text: TEXT, messageId: (messages[0] as Item).messageId });
    // The record: ids, a mode, the revision the stop will have, a state. No text.
    const [record] = s.records();
    expect(record).toMatchObject({ requestId, orgId: ORG_A, sessionId: s.made.sessionId, taskId: s.made.taskId, actorId: PRIYA, messageId: (messages[0] as Item).messageId, mode: "keep_plan", step: "IMPLEMENT", blockedRevision: 4, state: "stopping" });
    expect(JSON.stringify(record)).not.toContain("REDIRECT-SECRET-TEXT-5521");
    expect(await readOpenRedirect({ documentClient: s.w.db, tableName: "state", now: () => s.w.clock.now }, s.made.taskId)).toMatchObject({ requestId, taskId: s.made.taskId });
    // The session's timeline says it without the text.
    const events = s.sessionItems("EVENT#").filter((event) => event.type === "stopped");
    expect(events.map((event) => event.text)).toEqual([`Priya ${REDIRECT_SLACK_STATUS_LINE}.`]);
    expect(JSON.stringify(events)).not.toContain("REDIRECT-SECRET-TEXT-5521");
    // The workflow row is untouched by phase 1 (the cancel changes it, not this).
    expect(s.task()["workflow"]).toMatchObject({ revision: 3, stage: "IMPLEMENT", state: "RUNNING" });
    // The hook for phase 2 was asked once after the cancel.
    expect(s.calls.continued).toEqual([s.made.taskId]);
  });

  it("refuses everyone but the owner and co-owners, and writes nothing at all (the whole table is compared)", async () => {
    const s = world({ people: [{ developerId: MAX, role: "commenter" }] });
    const before = s.table();
    // Arjun can use it (a share), Max can edit it (a maintainer), Mia only views, Ola is an org admin, Zed is nobody, Bo is in another org.
    s.w.seedShare(ORG_A, s.made.sessionId, { kind: "member", developerId: ARJUN }, "use");
    const afterShare = s.table();
    expect(afterShare).not.toBe(before);
    const outcomes = {
      arjun: await code(s.go(ARJUN)), max: await code(s.go(MAX)), mia: await code(s.go(MIA)), ola: await code(s.go(OLA)), zed: await code(s.go(ZED)), bo: await code(s.go(BO, {}, ORG_B)),
    };
    expect(outcomes.max).toEqual({ code: "FORBIDDEN", message: REDIRECT_REFUSAL_MESSAGES.not_owner });
    // Below "can edit" the session level is the refusal; a stranger and another org's person never learn the session exists.
    expect(outcomes.arjun).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(outcomes.mia).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(outcomes.ola).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(outcomes.zed).toMatchObject({ code: "NOT_FOUND" });
    expect(outcomes.bo).toMatchObject({ code: "NOT_FOUND" });
    expect(s.table()).toBe(afterShare);
    expect(s.calls.cancel).toEqual([]);
    expect(s.calls.features).toBe(0);
  });

  it("accepts a co-owner of the task, and not once the task was taken over", async () => {
    const co = world({ people: [{ developerId: ARJUN, role: "owner" }] });
    co.w.seedShare(ORG_A, co.made.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    await expect(co.go(ARJUN)).resolves.toMatchObject({ redirect: { state: "stopping" } });
    expect(co.records()[0]).toMatchObject({ actorId: ARJUN });
    // Mia took the task over: she is the owner, and the earlier co-owner is not one any more.
    const taken = world({ people: [{ developerId: ARJUN, role: "owner" }], currentOwner: MIA });
    taken.w.seedShare(ORG_A, taken.made.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    expect(await code(taken.go(ARJUN))).toMatchObject({ code: "FORBIDDEN" });
    expect(taken.records()).toEqual([]);
  });

  it("takes a body of requestId, text and mode only: budget, tools, permissions or anything else is refused and nothing is written", async () => {
    const s = world();
    const before = s.table();
    for (const extra of [{ budget: 100 }, { tools: ["bash"] }, { permissions: { write: true } }, { approve: true }, { authority: "owner_instruction" }]) {
      expect(await code(s.go(PRIYA, extra)), JSON.stringify(extra)).toMatchObject({ code: "CONFIG_INVALID", message: "body: has a field this route does not take" });
    }
    expect(await code(s.go(PRIYA, { text: "" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.go(PRIYA, { mode: "discard_work" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(s.go(PRIYA, { requestId: "nope" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(s.table()).toBe(before);
  });

  it("does not exist while the switch is off", async () => {
    const s = world();
    const off = { ...s.deps, redirect: undefined } as RedirectDependencies;
    const before = s.table();
    expect(await code(redirectSession(off, s.w.caller(PRIYA), s.made.sessionId, s.body()))).toMatchObject({ code: "NOT_FOUND" });
    expect(s.table()).toBe(before);
  });

  it("answers a repeat of the same request with the stored record, writes nothing new and asks for the stop again while it is still `stopping`", async () => {
    const s = world();
    const requestId = randomUUID();
    await s.go(PRIYA, { requestId });
    const before = s.table();
    const again = await s.go(PRIYA, { requestId });
    expect(again.redirect).toMatchObject({ requestId, state: "stopping" });
    expect(s.table()).toBe(before);
    // The cancel is idempotent by the request id; a crash after the commit may have lost the first one, so the repeat asks again.
    expect(s.calls.cancel).toEqual([{ taskId: s.made.taskId, requestId }, { taskId: s.made.taskId, requestId }]);
    // Once the redirect ended, a repeat does not touch the task.
    await s.finish(requestId);
    const ended = await s.go(PRIYA, { requestId });
    expect(ended.redirect.state).toBe("restarted");
    expect(s.calls.cancel).toHaveLength(2);
    // The same request id for another action, or from another person, is a mistake.
    expect(await code(stopSession(s.deps, s.w.caller(PRIYA), s.made.sessionId, { requestId }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    s.w.seedShare(ORG_A, s.made.sessionId, { kind: "member", developerId: MAX }, "edit");
  });

  it("refuses a second redirect while one is being carried out (one in flight per task) and allows the next once it ended", async () => {
    const s = world();
    const first = randomUUID();
    await s.go(PRIYA, { requestId: first });
    const before = s.table();
    expect(await code(s.go(PRIYA))).toEqual({ code: "IDEMPOTENCY_CONFLICT", message: REDIRECT_REFUSAL_MESSAGES.busy });
    expect(s.table()).toBe(before);
    await s.finish(first);
    s.w.clock.now += 1_000;
    s.patchTask({ workflow: { revision: 5, stage: "IMPLEMENT", state: "RUNNING", decisions: [], definitionVersion: "1.0.0" } });
    await expect(s.go(PRIYA)).resolves.toMatchObject({ redirect: { state: "stopping" } });
  });

  it("allows 3 redirects per step attempt and refuses the 4th, then begins again when a decision starts a new attempt", async () => {
    const s = world();
    for (let index = 0; index < 3; index += 1) {
      const requestId = randomUUID();
      await s.go(PRIYA, { requestId });
      await s.finish(requestId);
      s.w.clock.now += 1_000;
    }
    const before = s.table();
    expect(await code(s.go(PRIYA))).toEqual({ code: "TOO_MANY_REQUESTS", message: REDIRECT_REFUSAL_MESSAGES.rate_limited });
    expect(s.table()).toBe(before);
    // A decision (a send-back, an approval, a revised plan) is a new attempt of the step.
    s.patchTask({ workflow: { revision: 6, stage: "IMPLEMENT", state: "RUNNING", decisions: [{ requestId: randomUUID() }], definitionVersion: "1.0.0" } });
    await expect(s.go(PRIYA)).resolves.toMatchObject({ redirect: { state: "stopping" } });
  });

  it("allows 5 redirects per task per hour and refuses the 6th, then allows one in the next hour", async () => {
    const s = world();
    for (let index = 0; index < 5; index += 1) {
      // A new attempt each time, so only the hour binds.
      s.patchTask({ workflow: { revision: 3 + index, stage: "IMPLEMENT", state: "RUNNING", decisions: Array.from({ length: index }, () => ({ requestId: randomUUID() })), definitionVersion: "1.0.0" } });
      const requestId = randomUUID();
      await s.go(PRIYA, { requestId });
      await s.finish(requestId);
      s.w.clock.now += 1_000;
    }
    s.patchTask({ workflow: { revision: 9, stage: "IMPLEMENT", state: "RUNNING", decisions: Array.from({ length: 9 }, () => ({ requestId: randomUUID() })), definitionVersion: "1.0.0" } });
    const before = s.table();
    expect(await code(s.go(PRIYA))).toEqual({ code: "TOO_MANY_REQUESTS", message: REDIRECT_REFUSAL_MESSAGES.rate_limited });
    expect(s.table()).toBe(before);
    s.w.clock.now += 3_600_000;
    await expect(s.go(PRIYA)).resolves.toMatchObject({ redirect: { state: "stopping" } });
  });

  it("stops nothing for a task that ended or a step a redirect does not reach, and writes nothing", async () => {
    const closed = world();
    closed.patchTask({ closedAt: "2026-10-22T09:00:00.000Z" });
    const before = closed.table();
    expect(await code(closed.go(PRIYA))).toMatchObject({ code: "SESSION_ENDED" });
    expect(closed.table()).toBe(before);
    const merged = world({ stage: "MERGED", state: "COMPLETE" });
    expect(await code(merged.go(PRIYA))).toMatchObject({ code: "SESSION_ENDED" });
    const critique = world({ stage: "PLAN_CRITIQUE", state: "RUNNING" });
    expect(await code(critique.go(PRIYA))).toEqual({ code: "CONFIG_INVALID", message: REDIRECT_REFUSAL_MESSAGES.step_not_redirectable });
    expect(critique.records()).toEqual([]);
  });

  it("ends the redirect `failed` and keeps the instruction as a note when the stop is refused, and raises the stop's own error", async () => {
    const s = world();
    s.live.cancelFailure = agentXError("WORKSPACE_BUSY", "the task changed while cancelling; try agentx_cancel_task again");
    const requestId = randomUUID();
    expect(await code(s.go(PRIYA, { requestId }))).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await readRedirect({ documentClient: s.w.db, tableName: "state", now: () => s.w.clock.now }, s.made.taskId, requestId)).toMatchObject({ state: "failed" });
    expect(await readOpenRedirect({ documentClient: s.w.db, tableName: "state", now: () => s.w.clock.now }, s.made.taskId)).toBeUndefined();
    expect(s.notes()).toHaveLength(1);
    expect(s.w.db.get(redirectKey(s.made.taskId, requestId))).toBeDefined();
  });
});

describe("the worker must support the redirect (LI-1: fail closed on an older worker)", () => {
  it("refuses a keep-the-plan redirect at coding when the worker does not list the feature, and writes nothing", async () => {
    const s = world({ features: ["task.liveSteer.v1"] });
    const before = s.table();
    expect(await code(s.go(PRIYA))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: REDIRECT_REFUSAL_MESSAGES.old_worker });
    expect(s.calls.features).toBe(1);
    expect(s.table()).toBe(before);
    expect(s.calls.cancel).toEqual([]);
  });

  it("treats a worker that cannot be asked, or an answer of nothing, as an older worker", async () => {
    const down = world({ features: "down" });
    const before = down.table();
    expect(await code(down.go(PRIYA))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(down.table()).toBe(before);
    const none = world();
    (none.deps.redirect as RedirectConfig).workerFeatures = async () => undefined;
    expect(await code(none.go(PRIYA))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(none.records()).toEqual([]);
  });

  it("asks only when a coding run will carry the instruction: not for Understand, Plan, or a changed plan at coding; always for the checks and the review", async () => {
    const plan = world({ features: [], stage: "PLAN" });
    await expect(plan.go(PRIYA, { mode: "keep_plan" })).resolves.toMatchObject({ redirect: { state: "stopping" } });
    expect(plan.calls.features).toBe(0);
    const understand = world({ features: [], stage: "UNDERSTAND" });
    await expect(understand.go(PRIYA)).resolves.toMatchObject({ redirect: { state: "stopping" } });
    const changed = world({ features: [], stage: "IMPLEMENT" });
    await expect(changed.go(PRIYA, { mode: "change_plan" })).resolves.toMatchObject({ redirect: { mode: "change_plan", state: "stopping" } });
    expect(changed.calls.features).toBe(0);
    for (const stage of ["VERIFY", "REVIEW"]) {
      for (const mode of ["keep_plan", "change_plan"]) {
        const step = world({ features: [], stage });
        expect(await code(step.go(PRIYA, { mode })), `${stage} ${mode}`).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
        expect(step.records()).toEqual([]);
      }
    }
  });
});

describe("the task must still be where the redirect read it", () => {
  it("reads the task again when it moves between the read and the commit, and records the revision it found (not the one it first read)", async () => {
    const s = world();
    // The task moves on (a new revision of the same running step) just before the first commit.
    let moved = false;
    const original = s.w.db.send.bind(s.w.db);
    (s.deps as unknown as { documentClient: { send: typeof original } }).documentClient = {
      send: async (command: Parameters<typeof original>[0]) => {
        if (!moved && command.constructor.name === "TransactWriteCommand") { moved = true; s.patchTask({ workflow: { revision: 8, stage: "IMPLEMENT", state: "RUNNING", decisions: [], definitionVersion: "1.0.0" } }); }
        return original(command);
      },
    };
    const requestId = randomUUID();
    await s.go(PRIYA, { requestId });
    expect(moved).toBe(true);
    expect(s.records()[0]).toMatchObject({ requestId, blockedRevision: 9, state: "stopping" });
    // One message and one note only: the first attempt wrote nothing.
    expect(s.sessionItems("MESSAGE#msg_")).toHaveLength(1);
    expect(s.notes()).toHaveLength(1);
  });

  it("refuses when the task ended while it was read again", async () => {
    const s = world();
    let moved = false;
    const original = s.w.db.send.bind(s.w.db);
    (s.deps as unknown as { documentClient: { send: typeof original } }).documentClient = {
      send: async (command: Parameters<typeof original>[0]) => {
        if (!moved && command.constructor.name === "TransactWriteCommand") { moved = true; s.patchTask({ workflow: { revision: 4, stage: "MERGED", state: "COMPLETE", decisions: [] }, closedAt: "2026-10-22T09:00:00.000Z" }); }
        return original(command);
      },
    };
    expect(await code(s.go(PRIYA))).toMatchObject({ code: "SESSION_ENDED" });
    expect(s.records()).toEqual([]);
    expect(s.sessionItems("MESSAGE#msg_")).toEqual([]);
  });
});

describe("nothing is running (R4)", () => {
  const STOPPED = "implementation operation ended failed";

  it("a blocked step has nothing to stop: it records the redirect against the step's own revision, asks for no cancel, and carries on at once", async () => {
    const s = world({ state: "BLOCKED", workflow: { blockReason: STOPPED } });
    const requestId = randomUUID();
    const answer = await s.go(PRIYA, { requestId });
    expect(answer.redirect).toMatchObject({ requestId, state: "stopping" });
    expect(s.calls.cancel).toEqual([]);
    expect(s.records()[0]).toMatchObject({ kind: "blocked", blockedRevision: 3, step: "IMPLEMENT", state: "stopping" });
    // Phase 2 is asked for straight away, since no run has to end first.
    expect(s.calls.continued).toEqual([s.made.taskId]);
    expect(s.sessionItems("MESSAGE#msg_")).toHaveLength(1);
    expect(s.notes()).toHaveLength(1);
    // The same worker rule as a running step.
    const old = world({ state: "BLOCKED", workflow: { blockReason: STOPPED }, features: [] });
    expect(await code(old.go(PRIYA))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(old.records()).toEqual([]);
  });

  it("a blocked step is guarded like a running one: the transaction fails if the task moved, and the redirect is recorded against what is found then", async () => {
    const s = world({ state: "BLOCKED", workflow: { blockReason: STOPPED } });
    let moved = false;
    const original = s.w.db.send.bind(s.w.db);
    (s.deps as unknown as { documentClient: { send: typeof original } }).documentClient = {
      send: async (command: Parameters<typeof original>[0]) => {
        if (!moved && command.constructor.name === "TransactWriteCommand") { moved = true; s.patchTask({ workflow: { revision: 7, stage: "IMPLEMENT", state: "BLOCKED", blockReason: STOPPED, decisions: [], definitionVersion: "1.0.0" } }); }
        return original(command);
      },
    };
    await s.go(PRIYA);
    expect(moved).toBe(true);
    expect(s.records()[0]).toMatchObject({ kind: "blocked", blockedRevision: 7 });
  });

  it("'this changes the plan' on a coding step blocked by something that is not a stop is refused (the Revise move takes only a stopped step), writing nothing", async () => {
    const s = world({ state: "BLOCKED", workflow: { blockReason: STOPPED } });
    const before = s.table();
    expect(await code(s.go(PRIYA, { mode: "change_plan" }))).toEqual({ code: "CONFIG_INVALID", message: REDIRECT_REFUSAL_MESSAGES.not_available });
    expect(s.table()).toBe(before);
    // A coding step blocked by a stop can take it.
    const stopped = world({ state: "BLOCKED", workflow: { blockReason: "implementation operation ended cancelled", artifacts: [{ id: "p", type: "plan", version: 1, sha256: "c".repeat(64) }] } });
    await expect(stopped.go(PRIYA, { mode: "change_plan" })).resolves.toMatchObject({ redirect: { state: "stopping" } });
  });

  it("a step waiting to start is cancelled (the cancel blocks it) and recorded against the revision the block will have", async () => {
    const s = world({ stage: "PLAN", state: "READY", workflow: { definitionVersion: "1.1.0" } });
    await s.go(PRIYA);
    expect(s.calls.cancel).toHaveLength(1);
    expect(s.records()[0]).toMatchObject({ kind: "queued", step: "PLAN", blockedRevision: 4 });
    // A version 1 workflow's ready step is not a queued dispatch the cancel can remove.
    const old = world({ stage: "PLAN", state: "READY" });
    expect(await code(old.go(PRIYA))).toMatchObject({ code: "CONFIG_INVALID", message: REDIRECT_REFUSAL_MESSAGES.not_available });
  });

  it("a paused task is not stopped or restarted: the instruction is saved as the owner's note, the answer says so in fixed words, and a repeat answers the same without a second message", async () => {
    const s = world();
    s.patchTask({ budgetPause: { at: "2026-10-22T09:00:00.000Z" } });
    const requestId = randomUUID();
    const answer = await s.go(PRIYA, { requestId });
    expect(answer.redirect).toEqual({ requestId, mode: "keep_plan", state: "refused", message: REDIRECT_REFUSAL_MESSAGES.paused_for_budget });
    expect(s.calls.cancel).toEqual([]);
    expect(s.calls.features).toBe(0);
    expect(s.records()).toEqual([]);
    expect(s.sessionItems("MESSAGE#msg_")).toHaveLength(1);
    expect(s.notes()[0]).toMatchObject({ isOwner: true, text: TEXT });
    const before = s.table();
    expect((await s.go(PRIYA, { requestId })).redirect).toMatchObject({ state: "refused", message: REDIRECT_REFUSAL_MESSAGES.paused_for_budget });
    expect(s.table()).toBe(before);
    // A step blocked for the pause is the same.
    const blocked = world({ state: "BLOCKED", workflow: { blockReason: "Paused: this task needs more AI budget. I've asked for it." } });
    expect((await blocked.go(PRIYA)).redirect.state).toBe("refused");
    expect(blocked.records()).toEqual([]);
  });

  it("a plan waiting for approval becomes the owner's request for changes with the text, through the task's own decision, and a repeat answers the same without deciding again", async () => {
    const plan = { id: "p", type: "plan", version: 1, sha256: "c".repeat(64) };
    const s = world({ stage: "PLAN_REVIEW", state: "WAITING", workflow: { artifacts: [plan] } });
    const requestId = randomUUID();
    const answer = await s.go(PRIYA, { requestId, text: "also cover the v2 endpoint" });
    expect(answer.redirect).toEqual({ requestId, mode: "keep_plan", state: "revise_started" });
    expect(s.calls.plan).toEqual([{ requestId, expectedRevision: 3, artifactDigest: "c".repeat(64), reason: "also cover the v2 endpoint" }]);
    expect(s.calls.cancel).toEqual([]);
    expect(s.records()).toEqual([]);
    expect((await s.go(PRIYA, { requestId, text: "also cover the v2 endpoint" })).redirect).toEqual({ requestId, mode: "keep_plan", state: "revise_started" });
    expect(s.calls.plan).toHaveLength(1);
    // Only the owner: the decision is not reached for anyone else.
    const other = world({ stage: "PLAN_REVIEW", state: "WAITING", workflow: { artifacts: [plan] } });
    other.w.seedShare(ORG_A, other.made.sessionId, { kind: "member", developerId: MAX }, "edit");
    expect(await code(other.go(MAX))).toMatchObject({ code: "FORBIDDEN" });
    expect(other.calls.plan).toEqual([]);
  });

  it("takes a plan-review instruction as long as any other redirect (2,000 characters), whole (LR-2), and refuses one longer than that at the body", async () => {
    const plan = { id: "p", type: "plan", version: 1, sha256: "c".repeat(64) };
    const long = world({ stage: "PLAN_REVIEW", state: "WAITING", workflow: { artifacts: [plan] } });
    await expect(long.go(PRIYA, { text: "x".repeat(2_000) })).resolves.toMatchObject({ redirect: { state: "revise_started" } });
    expect(long.calls.plan).toHaveLength(1);
    expect(String(long.calls.plan[0]!["reason"])).toHaveLength(2_000);
    const tooLong = world({ stage: "PLAN_REVIEW", state: "WAITING", workflow: { artifacts: [plan] } });
    const beforeTooLong = tooLong.table();
    expect(await code(tooLong.go(PRIYA, { text: "x".repeat(2_001) }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(tooLong.table()).toBe(beforeTooLong);
    expect(tooLong.calls.plan).toEqual([]);
  });

  it("refuses a plan with no document, and a deployment with no decision seam, writing nothing", async () => {
    const plan = { id: "p", type: "plan", version: 1, sha256: "c".repeat(64) };
    const none = world({ stage: "PLAN_REVIEW", state: "WAITING", workflow: { artifacts: [] } });
    expect(await code(none.go(PRIYA))).toMatchObject({ code: "CONFIG_INVALID", message: REDIRECT_REFUSAL_MESSAGES.not_available });
    const bare = world({ stage: "PLAN_REVIEW", state: "WAITING", workflow: { artifacts: [plan] }, planChanges: false });
    const bareBefore = bare.table();
    expect(await code(bare.go(PRIYA))).toMatchObject({ code: "CONFIG_INVALID", message: REDIRECT_REFUSAL_MESSAGES.not_available });
    expect(bare.table()).toBe(bareBefore);
  });
});

describe("the steps a redirect does not reach say so in their own words (LR-2)", () => {
  it("refuses the check of a plan and the review of a pull request's comments with a sentence that names them and points to Stop, writing nothing", async () => {
    for (const [stage, state] of [["PLAN_CRITIQUE", "RUNNING"], ["PLAN_CRITIQUE", "BLOCKED"], ["WAIT_FOR_MERGE", "RUNNING"], ["WAIT_FOR_MERGE", "BLOCKED"]] as const) {
      const s = world({ stage, state });
      const before = s.table();
      expect(await code(s.go(PRIYA)), `${stage} ${state}`).toEqual({ code: "CONFIG_INVALID", message: REDIRECT_REFUSAL_MESSAGES.step_not_redirectable });
      expect(s.table(), `${stage} ${state}`).toBe(before);
      expect(s.calls.cancel).toEqual([]);
    }
    expect(REDIRECT_REFUSAL_MESSAGES.step_not_redirectable).toContain("plan");
    expect(REDIRECT_REFUSAL_MESSAGES.step_not_redirectable).toContain("pull request");
    expect(REDIRECT_REFUSAL_MESSAGES.step_not_redirectable).toContain("stop it");
    // A step this does not know stays the general sentence.
    const other = world({ stage: "SOMETHING_NEW", state: "RUNNING" });
    expect(await code(other.go(PRIYA))).toMatchObject({ message: REDIRECT_REFUSAL_MESSAGES.not_available });
  });
});

describe("a check or review redirect needs the send-back gate before anything is stopped (SB-1)", () => {
  const refusal = () => agentXError("PROJECT_ACCESS_DENIED", "You don't have access to start tasks in `payments`, so you can't send this task back to coding. Ask a maintainer to make you a contributor.");

  it("refuses with the gate's own words and writes, stops and counts nothing, for a running or a blocked check or review", async () => {
    const cases = [
      { stage: "VERIFY", state: "RUNNING" }, { stage: "REVIEW", state: "RUNNING" },
      { stage: "VERIFY", state: "BLOCKED", workflow: { blockReason: WORKFLOW_BLOCK_REASONS.regressionFound } },
    ];
    for (const one of cases) {
      const s = world({ ...one });
      s.live.sendBackRefusal = refusal();
      const before = s.table();
      expect(await code(s.go(PRIYA)), `${one.stage} ${one.state}`).toEqual({ code: "PROJECT_ACCESS_DENIED", message: refusal().message.replace("PROJECT_ACCESS_DENIED: ", "") });
      // The whole table is unchanged: no message, note, record, marker, rate or event; no cancel; the worker was never asked.
      expect(s.table(), `${one.stage} ${one.state}`).toBe(before);
      expect(s.calls.cancel).toEqual([]);
      expect(s.calls.features).toBe(0);
      expect(s.calls.gate).toEqual([{ taskId: s.made.taskId, who: PRIYA }]);
    }
  });

  it("keeps the refused person's redirect rate: after the refusals a permitted redirect still has all of its places", async () => {
    const s = world({ stage: "REVIEW", state: "RUNNING" });
    s.live.sendBackRefusal = refusal();
    for (let attempt = 0; attempt < 4; attempt += 1) await code(s.go(PRIYA));
    s.live.sendBackRefusal = undefined;
    await expect(s.go(PRIYA)).resolves.toMatchObject({ redirect: { state: "stopping" } });
  });

  it("an unreadable role is the gate's retryable error, and also writes nothing", async () => {
    const s = world({ stage: "VERIFY", state: "RUNNING" });
    s.live.sendBackRefusal = agentXError("RUNTIME_UNAVAILABLE", "your role in this project could not be checked; try again in a moment");
    const before = s.table();
    expect(await code(s.go(PRIYA))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(s.table()).toBe(before);
  });

  it("is asked only where a send-back happens: not for coding, planning, Understand, a changed plan, or a plan that waits", async () => {
    for (const options of [{ stage: "IMPLEMENT" }, { stage: "PLAN" }, { stage: "UNDERSTAND" }, { stage: "IMPLEMENT", mode: "change_plan" }]) {
      const s = world({ stage: options.stage });
      s.live.sendBackRefusal = refusal();
      await expect(s.go(PRIYA, options.mode === undefined ? {} : { mode: options.mode }), options.stage).resolves.toMatchObject({ redirect: { state: "stopping" } });
      expect(s.calls.gate).toEqual([]);
    }
  });
});

describe("a blocked check or review needs what a send-back needs (fix round 1, S3)", () => {
  it("is refused with the send-back's own sentence when there is no failed check or review finding to send back, writing nothing", async () => {
    for (const stage of ["VERIFY", "REVIEW"]) {
      const s = world({ stage, state: "BLOCKED", workflow: { blockReason: "The checks could not start on this machine. Retry once it works." } });
      const before = s.table();
      expect(await code(s.go(PRIYA)), stage).toEqual({ code: "CONFIG_INVALID", message: REDIRECT_REFUSAL_MESSAGES.nothing_to_send_back });
      expect(s.table(), stage).toBe(before);
      expect(s.calls.features).toBe(0);
    }
  });

  it("is accepted where the owner's own send-back is offered (a regression found by the checks), and a blocked planning step is not held to it", async () => {
    const offered = world({ stage: "VERIFY", state: "BLOCKED", workflow: { blockReason: WORKFLOW_BLOCK_REASONS.regressionFound } });
    await expect(offered.go(PRIYA)).resolves.toMatchObject({ redirect: { state: "stopping" } });
    expect(offered.records()[0]).toMatchObject({ kind: "blocked", step: "VERIFY" });
    const planning = world({ stage: "PLAN", state: "BLOCKED", features: [], workflow: { blockReason: "planning operation ended failed" } });
    await expect(planning.go(PRIYA)).resolves.toMatchObject({ redirect: { state: "stopping" } });
  });
});
