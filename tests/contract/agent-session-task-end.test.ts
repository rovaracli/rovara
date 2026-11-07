// Plan 5 Task 7b: a session follows a task's end and a budget pause as they happen. Plan 3 tells every registered handler once when a task ends
// (`onTaskEnded`) and when a run is paused for money (`onTaskPaused`); Task 7b registers one handler for each that refreshes the task's session (or its
// chain's) at once, so the session no longer waits for the stream or the sweep. `isEnded` stays the rule: a handler only moves the refresh earlier, so an
// end event for a task that is still open (a plain task between turns) leaves its session open, and a pause is a pause (never an end).
// A handler never fails Plan 3's telling: what it could not do the stream and the sweep do.
// UX2 slice 2: the timeline says the one status model's words (`taskStatusFromSession`): a run that succeeded and ended reads "Closed", a budget pause "Paused: needs more budget".
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionKey, openAgentSessionKey, type PauseScope } from "../../packages/contracts/src/index.js";
import { registerAgentSessionTaskHandlers, sessionTaskEndHandler, sessionTaskPauseHandler } from "../../packages/broker/src/agent-sessions/index.js";
import { sweepAgentSessions } from "../../packages/broker/src/agent-sessions/sweep.js";
import { hasTaskEndHandlers, onTaskEnded, onTaskPaused, registerTaskEndHandler, type TaskEndOutcome } from "../../packages/broker/src/agents/task-end.js";
import { taskEndKey } from "../../packages/broker/src/agents/task-end.js";
import { taskKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, ORG_A, ORG_B, T0 } from "../support/agent-session-world.js";
import { iso, projectorWorld, workflow, type PW } from "../support/agent-session-projector-world.js";

type Item = Record<string, unknown>;
const unregister: Array<() => void> = [];
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });

const TASK_SCOPE: PauseScope = { kind: "task", taskId: "x" };

/** What Plan 3's end and pause calls are given: the table client (which a test may break) and the clock. */
function plan3(p: PW, options: { failTransactions?: { on: boolean } } = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const client = options.failTransactions === undefined ? p.w.db : {
    send: async (command: { constructor: { name: string } }) => {
      if (options.failTransactions!.on && command.constructor.name === "TransactWriteCommand") throw Object.assign(new Error("table down"), { name: "ServiceUnavailable" });
      return p.w.db.send(command as never);
    },
  };
  const deps = { documentClient: client as typeof p.w.db, tableName: "state", now: () => p.w.clock.now, log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, ...fields }); } };
  const taskOf = (taskId: string) => p.w.db.get(taskKey(taskId)) as unknown as DeveloperTaskRecord;
  return {
    logs, deps, taskOf,
    end: (taskId: string, outcome: TaskEndOutcome = "succeeded") => onTaskEnded(deps, taskOf(taskId), outcome, {}, { record: true }),
    pause: (taskId: string) => onTaskPaused(deps, taskOf(taskId), TASK_SCOPE),
  };
}

const eventTexts = (p: PW, sessionId: string) => p.events(sessionId).map((event) => event.text);
const isOpen = (p: PW, sessionId: string) => p.w.db.get(openAgentSessionKey(ORG_A, sessionId)) !== undefined;
const workItems = (p: PW) => p.w.db.find((item) => String(item.pk).startsWith("ENDED_AGENT_SESSIONS#"));

beforeEach(() => { unregister.push(registerAgentSessionTaskHandlers()); });

describe("a task's end reaches its session at once", () => {
  it("an agent run that ended COMPLETE ends its session when the end is told, before any stream record or sweep", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    const t = plan3(p);
    expect(await t.end(s.taskId)).toBe("called");
    const session = p.sessionOf(s.sessionId);
    expect(session.summary.status).toBe("succeeded");
    expect(session.endedAt).toBe(iso(T0));
    expect(session.indexExpiresAt).toBeDefined();
    expect(isOpen(p, s.sessionId)).toBe(false);
    expect(p.tile(s.sessionId)).toMatchObject({ status: "succeeded", endedAt: iso(T0) });
    expect(workItems(p)).toHaveLength(1);
    expect(eventTexts(p, s.sessionId)).toEqual(["Closed"]);
  });

  it.each([["FAILED", "failed", "failed"], ["CANCELLED", "cancelled", "cancelled"]] as const)("an agent run that ended %s ends its session %s", async (state, status, outcome) => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", status === "failed" ? "FAILED" : "CANCELLED");
    p.patchTask(s.taskId, { agentRunEnd: { state, at: iso(T0) } });
    await plan3(p).end(s.taskId, outcome);
    expect(p.sessionOf(s.sessionId)).toMatchObject({ summary: { status }, endedAt: iso(T0) });
    expect(isOpen(p, s.sessionId)).toBe(false);
  });

  it("a merged and a closed workflow end their sessions, and a creator removed ends it as failed", async () => {
    const p = projectorWorld();
    const merged = p.open();
    p.patchTask(merged.taskId, { workflow: workflow("MERGED", "COMPLETE", { outcome: "MERGED" }) });
    const closed = p.open();
    p.patchTask(closed.taskId, { workflow: workflow("CLOSED", "COMPLETE", { outcome: "REJECTED" }) });
    const removed = p.open();
    p.patchTask(removed.taskId, { outcome: "creator_removed", outcomeAt: iso(T0) });
    const t = plan3(p);
    await t.end(merged.taskId, "merged");
    await t.end(closed.taskId, "closed");
    await t.end(removed.taskId, "creator_removed");
    expect(p.sessionOf(merged.sessionId).summary.status).toBe("succeeded");
    expect(p.sessionOf(closed.sessionId).summary.status).toBe("cancelled");
    expect(p.sessionOf(removed.sessionId).summary.status).toBe("failed");
    for (const entry of [merged, closed, removed]) expect(isOpen(p, entry.sessionId)).toBe(false);
  });

  it("tells each end once: a repeat of the end, and a retry after a later handler failed, write one end event and one end", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    let failures = 1;
    const later = vi.fn(async () => { if (failures > 0) { failures -= 1; throw new Error("down"); } });
    unregister.push(registerTaskEndHandler(later));
    const t = plan3(p);
    await expect(t.end(s.taskId)).rejects.toThrow("down");
    // The session heard it in that first call; Plan 3 takes up the retry at the handler that failed, not at ours.
    expect(p.sessionOf(s.sessionId).summaryRevision).toBe(2);
    expect(await t.end(s.taskId)).toBe("called");
    expect(await t.end(s.taskId)).toBe("already_ended");
    expect(later).toHaveBeenCalledTimes(2);
    const session = p.sessionOf(s.sessionId);
    expect(session.summaryRevision).toBe(2);
    expect(eventTexts(p, s.sessionId)).toEqual(["Closed"]);
    expect(workItems(p)).toHaveLength(1);
    expect(p.w.db.get(taskEndKey(s.taskId))).toMatchObject({ done: true });
  });

  it("an end heard twice (a handler retried whole) changes nothing the second time", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.patchTask(s.taskId, { agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    const t = plan3(p);
    await t.end(s.taskId);
    const before = p.w.db.transactions().length;
    // Plan 3's own record is removed so the call tells again, as a process that stopped after the handler returned would.
    await p.w.db.send(new DeleteCommand({ TableName: "state", Key: taskEndKey(s.taskId) }));
    await t.end(s.taskId);
    expect(p.w.db.transactions().length).toBe(before);
    expect(eventTexts(p, s.sessionId)).toEqual(["Closed"]);
  });

  it("leaves a plain task's session open when its first turn ends: isEnded stays the rule", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    const t = plan3(p);
    expect(await t.end(s.taskId, "succeeded")).toBe("called");
    const session = p.sessionOf(s.sessionId);
    expect(session.summary.status).toBe("waiting");
    expect(session.endedAt).toBeUndefined();
    expect(session.indexExpiresAt).toBeUndefined();
    expect(isOpen(p, s.sessionId)).toBe(true);
    expect(workItems(p)).toHaveLength(0);
    const failed = p.open();
    p.operation(failed.workspaceId, "task", "FAILED", 0, "the worker crashed");
    await t.end(failed.taskId, "failed");
    expect(p.sessionOf(failed.sessionId)).toMatchObject({ summary: { status: "waiting", lastRunFailed: true } });
    expect(p.sessionOf(failed.sessionId).endedAt).toBeUndefined();
    expect(isOpen(p, failed.sessionId)).toBe(true);
  });

  it("a plain task closed after its end ends its session, as the close says", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { closedAt: iso(T0) });
    await plan3(p).end(s.taskId, "closed");
    expect(p.sessionOf(s.sessionId)).toMatchObject({ summary: { status: "succeeded" }, endedAt: iso(T0) });
  });
});

describe("a budget pause is a pause", () => {
  const paused = (p: PW) => {
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    p.patchTask(s.taskId, { budgetPause: { scope: { kind: "task", taskId: s.taskId }, at: iso(T0) }, budgetUsd: 5 });
    return s;
  };

  it("sets paused at once, keeps the session open with no end, and is not told as a failure", async () => {
    const p = projectorWorld();
    const s = paused(p);
    await plan3(p).pause(s.taskId);
    const session = p.sessionOf(s.sessionId);
    expect(session.summary.status).toBe("paused");
    expect(session.summary.lastRunFailed).toBeUndefined();
    expect(session.endedAt).toBeUndefined();
    expect(isOpen(p, s.sessionId)).toBe(true);
    expect(workItems(p)).toHaveLength(0);
    expect(eventTexts(p, s.sessionId)).toEqual(["Paused: needs more budget"]);
  });

  it("a pause heard twice writes one event, and a task resumed after it is running again, never ended", async () => {
    const p = projectorWorld();
    const s = paused(p);
    const t = plan3(p);
    await t.pause(s.taskId);
    await t.pause(s.taskId);
    expect(eventTexts(p, s.sessionId)).toEqual(["Paused: needs more budget"]);
    // Task 32's approval removed the pause and started the next operation.
    p.patchTask(s.taskId, { budgetPause: undefined });
    p.operation(s.workspaceId, "task", "RUNNING", 60_000);
    await p.refresh(s.sessionId);
    expect(p.sessionOf(s.sessionId).summary.status).toBe("running");
    expect(p.sessionOf(s.sessionId).endedAt).toBeUndefined();
  });
});

describe("whose end it is", () => {
  it("an event naming another org changes nothing: no write, and the other org's session is never touched", async () => {
    const p = projectorWorld();
    const mine = p.open();
    p.patchTask(mine.taskId, { agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    const theirs = p.open({ orgId: ORG_B });
    p.patchTask(theirs.taskId, { agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    const t = plan3(p);
    const before = p.w.db.transactions().length;
    // An end for org B about org A's task, a pause for org A about org B's task, and an end naming a task that does not exist.
    await sessionTaskEndHandler()(t.deps, { orgId: ORG_B, taskId: mine.taskId, outcome: "succeeded", runLimitUsd: 5, spentUsd: 0 });
    await sessionTaskPauseHandler()(t.deps, { orgId: ORG_A, taskId: theirs.taskId, scope: TASK_SCOPE });
    await sessionTaskEndHandler()(t.deps, { orgId: ORG_A, taskId: "00000000-0000-4000-8000-000000000000", outcome: "succeeded", runLimitUsd: 5, spentUsd: 0 });
    expect(p.w.db.transactions().length).toBe(before);
    expect(p.sessionOf(mine.sessionId).endedAt).toBeUndefined();
    expect(isOpen(p, mine.sessionId)).toBe(true);
    expect((p.w.db.get(agentSessionKey(ORG_B, theirs.sessionId, "META")) as Item).endedAt).toBeUndefined();
    expect(t.logs.filter((entry) => entry.event === "agent_session.task_event_org_mismatch")).toHaveLength(2);
    // The same event with the right org does it.
    await sessionTaskEndHandler()(t.deps, { orgId: ORG_A, taskId: mine.taskId, outcome: "succeeded", runLimitUsd: 5, spentUsd: 0 });
    expect(p.sessionOf(mine.sessionId).endedAt).toBeDefined();
    expect((p.w.db.get(agentSessionKey(ORG_B, theirs.sessionId, "META")) as Item).endedAt).toBeUndefined();
  });

  it("a task with no session (it began before sessions) and an unknown task are skipped without a word of failure", async () => {
    const p = projectorWorld();
    const s = p.open();
    const { sessionId: _sessionId, ...withoutSession } = p.w.db.get(taskKey(s.taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- only the session id is dropped
    p.w.db.set(withoutSession);
    const t = plan3(p);
    const before = p.w.db.transactions().length;
    expect(await t.end(s.taskId)).toBe("called");
    expect(p.w.db.transactions().length).toBe(before);
    expect(t.logs.filter((entry) => String(entry.event).includes("failed"))).toEqual([]);
  });

  it("a chain step's end refreshes its chain's session through the chain's own facts", async () => {
    const p = projectorWorld();
    const chain = p.w.seedSession({ kind: "chain" });
    const step = p.open();
    p.patchTask(step.taskId, { chain: { chainRunId: chain.sessionId, stepId: "review" }, agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    const { sessionId: _sessionId, ...stepTask } = p.w.db.get(taskKey(step.taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- a chain step's task has no session of its own
    p.w.db.set(stepTask);
    const read = vi.fn(async () => ({ orgId: ORG_A, status: "gate" as const, stepName: "Review gate", spentUsd: 1, needsPeople: [ARJUN] }));
    unregister.push(registerAgentSessionTaskHandlers({ chains: { read } }));
    await plan3(p).end(step.taskId);
    expect(read).toHaveBeenCalledTimes(1);
    expect(p.sessionOf(chain.sessionId).summary).toMatchObject({ status: "needs_person", step: "Review gate", needsPeople: [ARJUN] });
    // The step's own session was not made up from it.
    expect(p.sessionOf(step.sessionId).endedAt).toBeUndefined();
  });
});

describe("registration", () => {
  it("registering again replaces the earlier registration: one refresh a task, not two", async () => {
    const p = projectorWorld();
    const chain = p.w.seedSession({ kind: "chain" });
    const step = p.open();
    p.patchTask(step.taskId, { chain: { chainRunId: chain.sessionId, stepId: "s" } });
    const { sessionId: _sessionId, ...stepTask } = p.w.db.get(taskKey(step.taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- a chain step's task has no session of its own
    p.w.db.set(stepTask);
    const read = vi.fn(async () => ({ orgId: ORG_A, status: "running" as const, stepName: "Build", spentUsd: 0 }));
    registerAgentSessionTaskHandlers({ chains: { read } });
    unregister.push(registerAgentSessionTaskHandlers({ chains: { read } }));
    await plan3(p).end(step.taskId);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("the function it returns removes both handlers", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.patchTask(s.taskId, { agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    while (unregister.length > 0) unregister.pop()!();
    expect(hasTaskEndHandlers()).toBe(false);
    await plan3(p).end(s.taskId);
    expect(p.sessionOf(s.sessionId).endedAt).toBeUndefined();
  });
});

describe("a handler's failure never breaks Plan 3's telling", () => {
  it("a session store that is down: the end is still told to every handler, recorded done, and the sweep ends the session afterwards", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "SUCCEEDED");
    p.patchTask(s.taskId, { agentRunEnd: { state: "COMPLETE", at: iso(T0) } });
    const down = { on: true };
    const heard = vi.fn(async () => undefined);
    unregister.push(registerTaskEndHandler(heard));
    const t = plan3(p, { failTransactions: down });
    expect(await t.end(s.taskId)).toBe("called");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(p.w.db.get(taskEndKey(s.taskId))).toMatchObject({ done: true, handlersTold: 2 });
    expect(t.logs.find((entry) => entry.event === "agent_session.task_event_refresh_failed")).toMatchObject({ taskId: s.taskId, error: "ServiceUnavailable" });
    expect(p.sessionOf(s.sessionId).endedAt).toBeUndefined();
    // The table is back: the sweep finds the open session and ends it.
    down.on = false;
    await sweepAgentSessions(p.deps, p.w.clock.now);
    expect(p.sessionOf(s.sessionId)).toMatchObject({ summary: { status: "succeeded" }, endedAt: iso(T0) });
  });

  it("a pause handled while the store is down still answers, and logs it", async () => {
    const p = projectorWorld();
    const s = p.open();
    p.operation(s.workspaceId, "task", "FAILED", 0, "RUNTIME_UNAVAILABLE: budget");
    p.patchTask(s.taskId, { budgetPause: { scope: { kind: "task", taskId: s.taskId }, at: iso(T0) } });
    const t = plan3(p, { failTransactions: { on: true } });
    await expect(t.pause(s.taskId)).resolves.toBeUndefined();
    expect(t.logs.some((entry) => entry.event === "agent_session.task_event_refresh_failed")).toBe(true);
  });
});
