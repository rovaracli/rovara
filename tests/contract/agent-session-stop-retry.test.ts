// Plan 5 Task 13: stop and retry a session. Both act on paid work, so authority is a session level read live (stop needs "can edit", or an org owner or admin; retry needs
// "can edit" and a project role that starts work), stop is Plan 3's real cancel and idempotent by request id, a retry starts at most one run, and the chain parts stay behind
// Plan 4's seams and fail closed. Part 1 runs the two functions over a fake company with recording stand-ins for Plan 3 (the host) and Plan 4 (the chain seam); part 2 goes
// through the real broker, where stop is the cancel the dev route runs.
import { chainRunViewOf } from "../support/chain-run-view.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionKey, agentXError, changesKey, runRequestKey, sessionEventId, type OrgId, type Payer } from "@rovara-code/contracts";
import { sessionChannel, userChannel } from "@agentx/cloud-contracts";
import { SessionEventSchema } from "@rovara-code/contracts";
import { SessionResponseReaderSchema, SessionCloseResponseReaderSchema } from "@agentx/cloud-contracts";
import { closeSession, stopSession, type ChainControl, type SessionControlHost } from "../../packages/broker/src/agent-sessions/stop.js";
import { RUN_RECORD_MEMORY_DAYS } from "../../packages/broker/src/agents/runs.js";
import { retryRunRequestId, retrySession } from "../../packages/broker/src/agent-sessions/retry.js";
import type { SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { taskAgentRunKey, taskKey } from "../../packages/broker/src/developer/task-records.js";
import { cancelTaskFor, retryTaskWorkflowFor } from "../../packages/broker/src/aws/developer-tasks.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { ARJUN, BO, CELL, MAX, MIA, OLA, ORG_A, ORG_B, PRIYA, ZED, sessionWorld } from "../support/agent-session-world.js";

type Item = Record<string, unknown>;
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));
const CHAIN_RUN = "crn_00000000000000000001";
const NOTHING = "There's nothing to retry right now.";
const START_WORK = "You need a role on web that can start work to retry this.";

interface StartedRun { taskId: string; sessionId: string; owner: string }

function world(options: { audit?: boolean } = {}) {
  const w = sessionWorld();
  const audit = options.audit === true ? capturingAuditDeps({ db: w.db, now: () => w.clock.now }) : undefined;
  const calls = {
    cancel: [] as Array<{ taskId: string; requestId: string }>, workflow: [] as Array<{ taskId: string; requestId: string }>, close: [] as Array<{ taskId: string; requestId: string; discardUnpublished: boolean }>, start: [] as Array<Record<string, unknown>>,
    chainCancel: [] as Array<{ orgId: string; actor: unknown; runId: string; requestId: string }>, chainRetry: [] as Array<{ orgId: string; actor: unknown; runId: string; requestId: string }>,
    admissions: [] as Array<{ payer: Payer; project: string }>, paths: [] as string[], published: [] as Array<{ channel: string; events: string[] }>,
  };
  const live = { budgetRefusal: undefined as string | undefined, startFailure: undefined as Error | undefined, cancelFailure: undefined as Error | undefined, nothingRunning: false, closeAnswer: { closed: true } as { closed: boolean; unpublished?: Array<{ repository: string; reasons: string[] }>; message?: string } };
  const started = new Map<string, StartedRun>();
  const control: SessionControlHost = {
    cancelTask: async (task, requestId) => { calls.cancel.push({ taskId: task.taskId, requestId }); if (live.cancelFailure !== undefined) throw live.cancelFailure; return { nothingRunning: live.nothingRunning }; },
    closeTask: async (task, input) => { calls.close.push({ taskId: task.taskId, ...input }); return live.closeAnswer; },
    retryWorkflow: async (task, requestId) => { calls.workflow.push({ taskId: task.taskId, requestId }); },
    // Plan 3's start, as far as a retry sees it: one run per request id, another owner's use of the id is a conflict, and the start writes the new task and its session.
    startAgentRun: async (request) => {
      calls.start.push(request as unknown as Record<string, unknown>);
      const previous = started.get(request.requestId);
      if (previous !== undefined) {
        if (previous.owner !== request.owner.developerId) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another run; use a new request_id");
        return { taskId: previous.taskId, runLimitUsd: 5, stopAtUsd: 5, paused: false };
      }
      if (live.startFailure !== undefined) throw live.startFailure;
      const seeded = w.seedSession({ owner: request.owner.developerId });
      const meta = w.db.get(agentSessionKey(ORG_A, seeded.sessionId, "META")) as Item;
      w.db.set({ ...meta, payer: { kind: "member", developerId: request.owner.developerId }, agent: { agentId: request.agent.agentId, name: "Ticket triage", version: request.agent.version ?? 1 }, origin: request.origin });
      started.set(request.requestId, { taskId: seeded.taskId, sessionId: seeded.sessionId, owner: request.owner.developerId });
      // As Plan 3's start leaves it: the request's own item, naming the run, its session and its starter.
      w.db.set({ ...runRequestKey(ORG_A, request.requestId), entityType: "RUN_REQUEST", orgId: ORG_A, taskId: seeded.taskId, developerId: request.owner.developerId, sessionId: seeded.sessionId });
      return { taskId: seeded.taskId, runLimitUsd: 5, stopAtUsd: 5, paused: false };
    },
  };
  const chainControl: ChainControl = {
    cancel: async (orgId, actor, runId, requestId) => { calls.chainCancel.push({ orgId, actor, runId, requestId }); },
    retry: async (orgId, actor, runId, requestId) => {
      calls.chainRetry.push({ orgId, actor, runId, requestId });
      const seeded = w.seedSession({ kind: "chain", owner: actor.developerId });
      return { sessionId: seeded.sessionId };
    },
  };
  const deps: SessionReadDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async (task) => ({ taskId: task.taskId, title: "Bump the Stripe SDK", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }) as never,
    control, chainControl, chain: { runView: async (_actor, runId) => chainRunViewOf(runId), stepTask: async () => { throw new Error("not asked"); } },
    admitPayer: async (input) => { calls.admissions.push({ payer: input.payer, project: input.project }); calls.paths.push(input.path); if (live.budgetRefusal !== undefined) throw agentXError("BUDGET_EXCEEDED", live.budgetRefusal); },
    realtimePublish: {
      endpoint: "https://events.example.com/event", region: "us-east-1", credentials: async () => ({ accessKeyId: "AKIA", secretAccessKey: "secret" }),
      fetch: (async (_url: unknown, init: { body: string }) => { calls.published.push(JSON.parse(init.body) as { channel: string; events: string[] }); return new Response("{}", { status: 200 }); }) as never,
    },
    ...(audit === undefined ? {} : { audit: audit.audit }),
  };
  const events = (sessionId: string) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, sessionId, "META").pk && String(item.sk).startsWith("EVENT#"));
  /** The session's `stopped` and `retried` events (the summary refresh adds its own status events beside them). */
  const eventTexts = (sessionId: string) => events(sessionId).filter((event) => event.type === "stopped" || event.type === "retried").map((event) => event.text);
  const meta = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as Item;
  const taskOf = (taskId: string) => w.db.get(taskKey(taskId)) as Item;
  const patchTask = (taskId: string, fields: Record<string, unknown>) => w.db.set({ ...taskOf(taskId), ...fields });
  const patchSession = (sessionId: string, fields: Record<string, unknown>) => w.db.set({ ...meta(sessionId), ...fields });
  const stop = (who: string, sessionId: string, requestId: string = randomUUID(), orgId: OrgId = ORG_A) => stopSession(deps, w.caller(who, orgId), sessionId, { requestId });
  const close = (who: string, sessionId: string, body: Record<string, unknown> = { requestId: randomUUID() }, orgId: OrgId = ORG_A) => closeSession(deps, w.caller(who, orgId), sessionId, body);
  const retry = (who: string, sessionId: string, requestId: string = randomUUID(), orgId: OrgId = ORG_A) => retrySession(deps, w.caller(who, orgId), sessionId, { requestId });
  /** A Rovara Code task whose workflow is blocked, with the people who may act: Max holds a maintainer grant. */
  const blocked = () => {
    const seeded = w.seedSession();
    patchTask(seeded.taskId, { workflow: { revision: 3, stage: "PLAN", state: "BLOCKED" }, client: "Claude Code" });
    return seeded;
  };
  /** An agent-step run that ended: its recipe, its input and its end are what a retry starts from. */
  const agentRun = (end: "FAILED" | "CANCELLED" | "COMPLETE" | undefined, input: Record<string, unknown> = { text: "Triage ticket 42", context: [{ kind: "text", ref: "ticket-42", title: "Ticket 42" }] }) => {
    const seeded = w.seedSession();
    patchTask(seeded.taskId, {
      agent: { agentId: "ticket-triage", name: "Ticket triage", version: 2, builtin: false, digest: "d".repeat(64) }, origin: "app", payer: { kind: "member", developerId: PRIYA },
      startedBy: { developerId: PRIYA }, ...(end === undefined ? {} : { agentRunEnd: { state: end, at: "2026-10-22T08:30:00.000Z" } }),
    });
    w.db.set({
      ...taskAgentRunKey(seeded.taskId), entityType: "AGENT_RUN", orgId: ORG_A, revision: 4, state: end ?? "RUNNING", cursor: 1, input, steps: [], reports: [],
      ...(end === undefined ? {} : { endedAt: "2026-10-22T08:30:00.000Z" }),
    });
    patchSession(seeded.sessionId, {
      agent: { agentId: "ticket-triage", name: "Ticket triage", version: 2 }, payer: { kind: "member", developerId: PRIYA },
      ...(end === undefined || end === "COMPLETE" ? {} : { endedAt: "2026-10-22T08:30:00.000Z", summary: { ...(meta(seeded.sessionId).summary as Item), status: end === "FAILED" ? "failed" : "cancelled" } }),
    });
    return seeded;
  };
  const feed = (developerId: string) => w.db.find((item) => item.pk === changesKey(ORG_A, developerId, "2026-10-22T09:00:00.000Z", 0).pk);
  return { ...w, audit, calls, live, started, control, deps, events, eventTexts, meta, taskOf, patchTask, patchSession, stop, close, retry, blocked, agentRun, feed };
}

describe("closing a session's task", () => {
  it("asks the task's own close with the request id, and passes the person's answer about unpublished work on only when they gave it", async () => {
    const w = world();
    const { sessionId, taskId } = w.blocked();
    const first = randomUUID();
    const reply = await w.close(MAX, sessionId, { requestId: first });
    expect(SessionCloseResponseReaderSchema.safeParse(reply).success).toBe(true);
    expect(reply).toMatchObject({ closed: true, session: { sessionId } });
    expect(w.calls.close).toEqual([{ taskId, requestId: first, discardUnpublished: false }]);
    w.live.closeAnswer = { closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }], message: "not closed" };
    expect(await w.close(MAX, sessionId)).toMatchObject({ closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }], message: "not closed" });
    const discard = randomUUID();
    await w.close(MAX, sessionId, { requestId: discard, discardUnpublished: true });
    expect(w.calls.close.at(-1)).toEqual({ taskId, requestId: discard, discardUnpublished: true });
  });

  it("needs 'can edit' on the session, and refuses a body it does not take, a bad request id and a chain run, before the task is asked", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    expect(await code(w.close(OLA, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(await code(w.close(MAX, sessionId, { requestId: randomUUID(), extra: true }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(w.close(MAX, sessionId, { requestId: "not-a-uuid" }))).toMatchObject({ code: "CONFIG_INVALID" });
    const chain = w.seedSession({ kind: "chain", owner: PRIYA });
    expect(await code(w.close(MAX, chain.sessionId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.calls.close).toEqual([]);
  });
});

describe("stopping a session", () => {
  it("cancels the task through Plan 3, leaves the session open, writes the exact event and the request, and answers the session", async () => {
    const w = world();
    const { sessionId, taskId } = w.blocked();
    const requestId = randomUUID();
    const reply = await w.stop(MAX, sessionId, requestId);
    expect(SessionResponseReaderSchema.safeParse(reply).success).toBe(true);
    expect(reply.session).toMatchObject({ sessionId, owner: { developerId: PRIYA } });
    expect(w.calls.cancel).toEqual([{ taskId, requestId }]);
    expect(w.eventTexts(sessionId)).toEqual(["Max stopped this session."]);
    const [event] = w.events(sessionId);
    expect(SessionEventSchema.parse(Object.fromEntries(Object.entries(event!).filter(([key]) => !["pk", "sk", "entityType", "orgId", "sessionId", "indexExpiresAt"].includes(key))))).toMatchObject({
      type: "stopped", actor: { kind: "member", developerId: MAX, name: "Max" }, eventId: sessionEventId("stopped", requestId),
    });
    expect(w.meta(sessionId).endedAt).toBeUndefined();
    expect(w.meta(sessionId).owner).toMatchObject({ developerId: PRIYA });
  });

  it("lets an org admin with only view stop it, and refuses a viewer naming 'can edit' and the owner", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    await w.stop(OLA, sessionId);
    expect(w.calls.cancel).toHaveLength(1);
    expect(await code(w.stop(ARJUN, sessionId))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: 'You need "can edit" on this session to stop it. Ask Priya to share it with you.' });
    expect(await code(w.stop(MIA, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    expect(w.calls.cancel).toHaveLength(1);
  });

  it("answers 404 to another org's person and to someone with no level, and runs nothing", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    expect(await code(w.stop(BO, sessionId, randomUUID(), ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.stop(ZED, sessionId))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(w.stop(PRIYA, "ses_00000000000000009999"))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.calls.cancel).toEqual([]);
  });

  it("writes nothing for a repeated request id: Plan 3 is not asked again and the answer is the stored one", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    await w.stop(MAX, sessionId, requestId);
    const before = w.db.items.size;
    const again = await w.stop(MAX, sessionId, requestId);
    expect(w.db.items.size).toBe(before);
    expect(w.calls.cancel).toHaveLength(1);
    expect(again.session.sessionId).toBe(sessionId);
    // The same id for a retry is another action.
    expect(await code(w.retry(MAX, sessionId, requestId))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("says NOTHING_RUNNING in the answer when the cancel found nothing to stop, and answers the same to a repeat of the request; a stop that stopped something says nothing of the kind", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    expect((await w.stop(MAX, sessionId, randomUUID())).stop).toBeUndefined();
    w.live.nothingRunning = true;
    const idle = await w.stop(MAX, sessionId, requestId);
    expect(idle.stop).toBe("NOTHING_RUNNING");
    expect(SessionResponseReaderSchema.safeParse(idle).success).toBe(true);
    const again = await w.stop(MAX, sessionId, requestId);
    expect(again.stop).toBe("NOTHING_RUNNING");
    expect(w.calls.cancel).toHaveLength(2);
  });

  it("answers a repeat after the stop ended the session with the stored answer, and a new request on an ended session with SESSION_ENDED", async () => {
    const w = world();
    const { sessionId } = w.agentRun(undefined);
    const requestId = randomUUID();
    await w.stop(MAX, sessionId, requestId);
    // The run ended CANCELLED meanwhile (Plan 3 ends it), and the session with it.
    w.patchSession(sessionId, { endedAt: "2026-10-22T09:01:00.000Z", summary: { ...(w.meta(sessionId).summary as Item), status: "cancelled" } });
    await expect(w.stop(MAX, sessionId, requestId)).resolves.toMatchObject({ session: { sessionId } });
    expect(await code(w.stop(MAX, sessionId))).toMatchObject({ code: "SESSION_ENDED", message: "This session has ended." });
    expect(w.calls.cancel).toHaveLength(1);
  });

  it("finishes after a cancel whose answer was lost: the same request id asks Plan 3 again (it is idempotent) and writes the event once", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.stop(MAX, sessionId, requestId)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(w.eventTexts(sessionId)).toEqual([]);
    await w.stop(MAX, sessionId, requestId);
    await w.stop(MAX, sessionId, requestId);
    expect(w.calls.cancel).toHaveLength(2);
    expect(w.eventTexts(sessionId)).toEqual(["Max stopped this session."]);
  });

  it("writes nothing when Plan 3 refuses the cancel, and the same request can be tried again", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    w.live.cancelFailure = agentXError("WORKSPACE_BUSY", "the task changed while cancelling; try agentx_cancel_task again");
    expect(await code(w.stop(MAX, sessionId, requestId))).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(w.eventTexts(sessionId)).toEqual([]);
    w.live.cancelFailure = undefined;
    await w.stop(MAX, sessionId, requestId);
    expect(w.eventTexts(sessionId)).toEqual(["Max stopped this session."]);
  });

  it("refuses a body with a field it does not take or a bad request id", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    expect(await code(stopSession(w.deps, w.caller(MAX), sessionId, { requestId: randomUUID(), extra: 1 }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(stopSession(w.deps, w.caller(MAX), sessionId, { requestId: "nope" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(stopSession(w.deps, w.caller(MAX), sessionId, undefined))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.calls.cancel).toEqual([]);
  });

  it("tells the owner and the followers, not the person who stopped it, with ids and a revision only", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    w.follower(ORG_A, sessionId, ARJUN);
    w.follower(ORG_A, sessionId, MAX);
    await w.stop(MAX, sessionId);
    const channels = w.calls.published.map((entry) => entry.channel);
    expect(channels).toEqual(expect.arrayContaining([sessionChannel(ORG_A, sessionId as never), userChannel(ORG_A, PRIYA), userChannel(ORG_A, ARJUN)]));
    expect(w.feed(PRIYA).length).toBeGreaterThan(0);
    expect(w.feed(ARJUN).length).toBeGreaterThan(0);
    expect(w.feed(MAX)).toEqual([]);
    expect(JSON.stringify(w.calls.published)).not.toMatch(/Priya|Max|Stripe/u);
  });

  it("audits it once with the kind of session and the task, never a name", async () => {
    const w = world({ audit: true });
    const { sessionId, taskId } = w.blocked();
    const requestId = randomUUID();
    await w.stop(MAX, sessionId, requestId);
    await w.stop(MAX, sessionId, requestId);
    const audited = w.audit!.recordedBy("session.stopped");
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actor: { kind: "member" }, target: { kind: "session", id: sessionId }, facts: { sessionKind: "task" }, related: [taskId] });
    expect(JSON.stringify(audited[0])).not.toMatch(/Priya|Max|Stripe/u);
  });

  it("stops a chain session through Plan 4 with the session actor and the request id, and refuses before writing anything when the chain seam is not wired", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ kind: "chain", owner: PRIYA });
    w.db.set({ ...w.db.get(agentSessionKey(ORG_A, sessionId, "META"))!, subject: { kind: "chain", chainRunId: CHAIN_RUN } });
    const requestId = randomUUID();
    const chain = w.seedSession({ kind: "chain", owner: PRIYA });
    const run = chain.sessionId;
    // A grant maintainer reaches a chain session at edit.
    await w.stop(MAX, run, requestId);
    expect(w.calls.chainCancel).toEqual([{ orgId: ORG_A, actor: { kind: "session", developerId: MAX }, runId: run, requestId }]);
    expect(w.eventTexts(run)).toEqual(["Max stopped this session."]);
    expect(w.calls.cancel).toEqual([]);
    const without = world();
    const bare = without.seedSession({ kind: "chain", owner: PRIYA });
    const deps = { ...without.deps };
    delete (deps as { chainControl?: unknown }).chainControl;
    expect(await code(stopSession(deps, without.caller(MAX), bare.sessionId, { requestId: randomUUID() }))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "Stopping a chain run isn't available right now." });
    expect(without.eventTexts(bare.sessionId)).toEqual([]);
  });

  it("does not stop a session on a Mac whose device is not there (Task 18: the working path is in agent-session-local) and says so, writing nothing", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ kind: "local" });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MAX }, "edit");
    expect(await code(w.stop(MAX, sessionId))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "This session's Mac isn't available right now." });
    expect(w.eventTexts(sessionId)).toEqual([]);
  });

  it("reads old data: a task with no payer, no People list and a session with no payer stops", async () => {
    const w = world();
    const { sessionId, taskId } = w.seedSession();
    expect(w.taskOf(taskId).payer).toBeUndefined();
    await expect(w.stop(MAX, sessionId)).resolves.toBeDefined();
  });
});

describe("retrying a session", () => {
  it("retries a blocked workflow in the same session through Plan 3 and writes the event and the request", async () => {
    const w = world();
    const { sessionId, taskId } = w.blocked();
    const requestId = randomUUID();
    const reply = await w.retry(MAX, sessionId, requestId);
    expect(w.calls.workflow).toEqual([{ taskId, requestId }]);
    expect(w.calls.start).toEqual([]);
    expect(reply.session.sessionId).toBe(sessionId);
    expect(w.eventTexts(sessionId)).toEqual(["Max retried this."]);
    // The same run continues: nobody else's session was made, and the owner and the payer are not Max's.
    expect(w.meta(sessionId)).toMatchObject({ owner: { developerId: PRIYA } });
    expect(w.db.find((item) => item.entityType === "AGENT_SESSION")).toHaveLength(1);
    expect(w.taskOf(taskId).payer).toBeUndefined();
  });

  it("re-checks the budget of the payer who keeps paying before it asks Plan 3, and writes nothing when there is no room", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    w.live.budgetRefusal = "Priya's monthly AI budget is used up, so Rovara can't start new work for them.";
    expect(await code(w.retry(MAX, sessionId))).toEqual({ code: "BUDGET_EXCEEDED", message: "Priya's monthly AI budget is used up, so Rovara can't start new work for them." });
    expect(w.calls.admissions).toEqual([{ payer: { kind: "member", developerId: PRIYA }, project: "web" }]);
    expect(w.calls.workflow).toEqual([]);
    expect(w.eventTexts(sessionId)).toEqual([]);
  });

  it("checks the budget of a process-layer task on the same floor as a Rovara Code task (TASK), not the agent-run floor", async () => {
    const w = world();
    const plain = w.blocked();
    await w.retry(MAX, plain.sessionId);
    const layer = w.blocked();
    w.patchTask(layer.taskId, { agent: { agentId: "agt_pppppppppppppppppppp", name: "web process", version: 1, builtin: false, process: true, digest: "d".repeat(64) } });
    await w.retry(MAX, layer.sessionId);
    expect(w.calls.paths).toEqual(["TASK", "TASK"]);
  });

  it("answers a repeated request id with the stored answer and asks Plan 3 once", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    await w.retry(MAX, sessionId, requestId);
    const before = w.db.items.size;
    await w.retry(MAX, sessionId, requestId);
    expect(w.db.items.size).toBe(before);
    expect(w.calls.workflow).toHaveLength(1);
    expect(w.eventTexts(sessionId)).toEqual(["Max retried this."]);
  });

  it("needs 'can edit' and a project role that starts work, with the exact words", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    expect(await code(w.retry(OLA, sessionId))).toEqual({ code: "SESSION_LEVEL_REQUIRED", message: 'You need "can edit" on this session to retry it. Ask Priya to share it with you.' });
    expect(await code(w.retry(ARJUN, sessionId))).toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ZED }, "edit");
    expect(await code(w.retry(ZED, sessionId))).toEqual({ code: "FORBIDDEN", message: START_WORK });
    expect(await code(w.retry(BO, sessionId, randomUUID(), ORG_B))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.calls.workflow).toEqual([]);
  });

  it("lets the owner retry their own session", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    await w.retry(PRIYA, sessionId);
    expect(w.calls.workflow).toHaveLength(1);
    expect(w.eventTexts(sessionId)).toEqual(["Priya retried this."]);
  });

  it("says there is nothing to retry for a workflow that is not blocked, a running run and a run that succeeded", async () => {
    const w = world();
    const running = w.seedSession();
    w.patchTask(running.taskId, { workflow: { revision: 2, stage: "IMPLEMENT", state: "RUNNING" } });
    expect(await code(w.retry(MAX, running.sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
    const live = w.agentRun(undefined);
    expect(await code(w.retry(MAX, live.sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
    const done = w.agentRun("COMPLETE");
    expect(await code(w.retry(MAX, done.sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
    const fresh = w.seedSession();
    expect(await code(w.retry(MAX, fresh.sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
    expect(w.calls.workflow).toEqual([]);
    expect(w.calls.start).toEqual([]);
  });

  it("tells a failed plain task to be continued from where it started", async () => {
    const w = world();
    const { sessionId, taskId } = w.seedSession();
    w.patchTask(taskId, { client: "Claude Code" });
    w.patchSession(sessionId, { summary: { ...(w.meta(sessionId).summary as Item), status: "waiting", lastRunFailed: true } });
    expect(await code(w.retry(MAX, sessionId))).toEqual({ code: "CONFIG_INVALID", message: "Continue this task from Claude Code." });
    expect(w.calls.workflow).toEqual([]);
    expect(w.eventTexts(sessionId)).toEqual([]);
  });

  it("starts a new run of the same agent version and input for a failed run: Max owns and pays, the new session says it is a retry, the old one says so", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    const requestId = randomUUID();
    const reply = await w.retry(MAX, old.sessionId, requestId);
    expect(w.calls.start).toHaveLength(1);
    expect(w.calls.start[0]).toEqual({
      requestId: retryRunRequestId(ORG_A, old.sessionId), orgId: ORG_A, project: "web", agent: { agentId: "ticket-triage", version: 2 }, input: { text: "Triage ticket 42", context: [{ kind: "text", ref: "ticket-42", title: "Ticket 42" }] },
      origin: "app", owner: { developerId: MAX }, startedBy: { developerId: MAX },
    });
    const created = w.started.get(retryRunRequestId(ORG_A, old.sessionId))!;
    expect(reply.session.sessionId).toBe(created.sessionId);
    expect(w.meta(created.sessionId)).toMatchObject({ retryOf: old.sessionId, owner: { developerId: MAX }, payer: { kind: "member", developerId: MAX }, revision: 2 });
    expect(reply.session).toMatchObject({ owner: { developerId: MAX }, retryOf: old.sessionId });
    expect(w.eventTexts(old.sessionId)).toEqual(["Max retried this in a new session."]);
    // The old session is untouched otherwise: still ended, still Priya's.
    expect(w.meta(old.sessionId)).toMatchObject({ owner: { developerId: PRIYA }, endedAt: "2026-10-22T08:30:00.000Z" });
    // A repeat of the request answers the same new session and starts nothing.
    const before = w.db.items.size;
    expect((await w.retry(MAX, old.sessionId, requestId)).session.sessionId).toBe(created.sessionId);
    expect(w.db.items.size).toBe(before);
    expect(w.calls.start).toHaveLength(1);
  });

  it("retries a cancelled run too, and starts at most one run: a second request id by the same person answers the same new session, another person's is refused", async () => {
    const w = world();
    const old = w.agentRun("CANCELLED");
    const first = await w.retry(MAX, old.sessionId);
    const second = await w.retry(MAX, old.sessionId);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(w.started.size).toBe(1);
    w.seedShare(ORG_A, old.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    expect(await code(w.retry(ARJUN, old.sessionId))).toEqual({ code: "CONFIG_INVALID", message: "This session was already retried." });
    expect(w.started.size).toBe(1);
    expect(w.eventTexts(old.sessionId)).toEqual(["Max retried this in a new session."]);
  });

  it("is refused whole, with nothing written and nothing marked, when the start refuses (no room, a version that is not safe): the same request can be tried again", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    w.live.startFailure = agentXError("BUDGET_EXCEEDED", "Max's monthly AI budget is used up, so Rovara can't start new work for them.");
    expect(await code(w.retry(MAX, old.sessionId))).toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(w.eventTexts(old.sessionId)).toEqual([]);
    expect(w.started.size).toBe(0);
    w.live.startFailure = undefined;
    await w.retry(MAX, old.sessionId);
    expect(w.started.size).toBe(1);
  });

  it("completes the link when the answer was lost after the run started: the same request id finds the run and links it, once", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    const requestId = randomUUID();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.retry(MAX, old.sessionId, requestId)).rejects.toMatchObject({ name: "InternalServerError" });
    const created = w.started.get(retryRunRequestId(ORG_A, old.sessionId))!;
    expect(w.meta(created.sessionId).retryOf).toBeUndefined();
    const reply = await w.retry(MAX, old.sessionId, requestId);
    expect(reply.session.sessionId).toBe(created.sessionId);
    expect(w.meta(created.sessionId)).toMatchObject({ retryOf: old.sessionId });
    expect(w.eventTexts(old.sessionId)).toEqual(["Max retried this in a new session."]);
    expect(w.started.size).toBe(1);
  });

  it("derives the run's request id from the session, so no two retries of one session can start two runs", () => {
    const first = retryRunRequestId(ORG_A, "ses_00000000000000000001");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(retryRunRequestId(ORG_A, "ses_00000000000000000001")).toBe(first);
    expect(retryRunRequestId(ORG_A, "ses_00000000000000000002")).not.toBe(first);
    expect(retryRunRequestId(ORG_B, "ses_00000000000000000001")).not.toBe(first);
  });

  it("reads old data: a run record with only the fields older runs had, and a session that was never given a payer", async () => {
    const w = world();
    const old = w.agentRun("FAILED", { text: "Triage ticket 7" });
    w.patchTask(old.taskId, { payer: undefined, startedBy: undefined, origin: undefined });
    await w.retry(MAX, old.sessionId);
    expect(w.calls.start[0]).toMatchObject({ input: { text: "Triage ticket 7" }, origin: "app" });
  });

  it("refuses a failed run whose recipe or input cannot be read, and says it is unavailable", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    w.db.set({ ...w.db.get(taskAgentRunKey(old.taskId))!, input: { nope: true } });
    expect(await code(w.retry(MAX, old.sessionId))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.calls.start).toEqual([]);
  });

  it("tells a session on a Mac to retry it there", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ kind: "local" });
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: MAX }, "edit");
    expect(await code(w.retry(MAX, sessionId))).toEqual({ code: "CONFIG_INVALID", message: "Retry it on your Mac." });
  });

  it("retries a failed chain run through Plan 4 with the session actor: a new session with retryOf, and refuses before writing when the seam is not wired", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ kind: "chain", owner: PRIYA });
    w.patchSession(sessionId, { endedAt: "2026-10-22T08:30:00.000Z", summary: { ...(w.meta(sessionId).summary as Item), status: "failed" } });
    const requestId = randomUUID();
    const reply = await w.retry(MAX, sessionId, requestId);
    expect(w.calls.chainRetry).toEqual([{ orgId: ORG_A, actor: { kind: "session", developerId: MAX }, runId: sessionId, requestId: retryRunRequestId(ORG_A, sessionId) }]);
    expect(w.meta(reply.session.sessionId)).toMatchObject({ retryOf: sessionId });
    expect(w.eventTexts(sessionId)).toEqual(["Max retried this in a new session."]);
    const bare = world();
    const chain = bare.seedSession({ kind: "chain", owner: PRIYA });
    bare.patchSession(chain.sessionId, { endedAt: "2026-10-22T08:30:00.000Z", summary: { ...(bare.meta(chain.sessionId).summary as Item), status: "failed" } });
    const deps = { ...bare.deps };
    delete (deps as { chainControl?: unknown }).chainControl;
    expect(await code(retrySession(deps, bare.caller(MAX), chain.sessionId, { requestId: randomUUID() }))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "Retrying a chain run isn't available right now." });
    expect(bare.eventTexts(chain.sessionId)).toEqual([]);
    // A chain run that is not failed has nothing to retry.
    const running = bare.seedSession({ kind: "chain", owner: PRIYA });
    expect(await code(bare.retry(MAX, running.sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
  });

  it("audits a retry once, saying which way it went", async () => {
    const w = world({ audit: true });
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    await w.retry(MAX, sessionId, requestId);
    await w.retry(MAX, sessionId, requestId);
    const old = w.agentRun("FAILED");
    await w.retry(MAX, old.sessionId);
    const audited = w.audit!.recordedBy("session.retried");
    expect(audited).toHaveLength(2);
    expect(audited.map((entry) => (entry as unknown as { facts: Record<string, unknown> }).facts)).toEqual([{ sessionKind: "task", branch: "workflow" }, { sessionKind: "task", branch: "new_run" }]);
    expect(JSON.stringify(audited)).not.toMatch(/Priya|Max|Stripe|Triage/u);
  });

  it("refuses a retry of a session that has ended for a reason that is not a failure, and a body it does not take", async () => {
    const w = world();
    const { sessionId } = w.seedSession({ ended: true });
    expect(await code(w.retry(MAX, sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
    expect(await code(retrySession(w.deps, w.caller(MAX), sessionId, { requestId: randomUUID(), extra: true }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(retrySession(w.deps, w.caller(MAX), sessionId, { requestId: "x" }))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("what the first round of mutation showed was not yet pinned", () => {
  it("refuses a stop whose request id a retry used, and a request id another person used", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    await w.retry(MAX, sessionId, requestId);
    expect(await code(w.stop(MAX, sessionId, requestId))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const other = randomUUID();
    await w.stop(MAX, sessionId, other);
    w.seedShare(ORG_A, sessionId, { kind: "member", developerId: ARJUN }, "edit");
    expect(await code(w.stop(ARJUN, sessionId, other))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const retried = randomUUID();
    await w.retry(MAX, sessionId, retried);
    expect(await code(w.retry(ARJUN, sessionId, retried))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(w.calls.cancel).toHaveLength(1);
  });

  it("does not stop a task session that runs on a Mac, and refuses a stop or a retry where Plan 3's host is not wired, before anything is written", async () => {
    const w = world();
    const mac = w.blocked();
    w.patchSession(mac.sessionId, { where: { kind: "mac", deviceId: "dvc_0123456789abcdefghij", label: "Priya's MacBook" } });
    expect(await code(w.stop(MAX, mac.sessionId))).toEqual({ code: "RUNTIME_UNAVAILABLE", message: "Stopping a session on a Mac isn't available yet." });
    expect(await code(w.retry(MAX, mac.sessionId))).toEqual({ code: "CONFIG_INVALID", message: "Retry it on your Mac." });
    const bare = world();
    const open = bare.blocked();
    const failed = bare.agentRun("FAILED");
    const deps = { ...bare.deps };
    delete (deps as { control?: unknown }).control;
    expect(await code(stopSession(deps, bare.caller(MAX), open.sessionId, { requestId: randomUUID() }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await code(retrySession(deps, bare.caller(MAX), open.sessionId, { requestId: randomUUID() }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await code(retrySession(deps, bare.caller(MAX), failed.sessionId, { requestId: randomUUID() }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(bare.eventTexts(open.sessionId)).toEqual([]);
  });

  it("tells a person whose task failed at setup that a new task is needed, in words that also name the setup commands (Bug F)", async () => {
    const w = world();
    const { sessionId, taskId } = w.blocked();
    // A workspace that could not be prepared never started the workflow: its step stays RUNNING and its session ends failed (summary.ts).
    w.patchTask(taskId, { workflow: { revision: 2, stage: "IMPLEMENT", state: "RUNNING" } });
    w.patchSession(sessionId, { endedAt: "2026-10-22T08:30:00.000Z", summary: { ...(w.meta(sessionId).summary as Item), status: "failed" } });
    expect(await code(w.retry(MAX, sessionId))).toEqual({
      code: "CONFIG_INVALID",
      message: "This task failed and has ended, so it can't be retried. Start a new task; if its setup failed, fix the project's setup or test command first.",
    });
    expect(w.calls.workflow).toEqual([]);
  });

  it("reads a session as ended by its end time alone, or by its ending status alone", async () => {
    const w = world();
    const byTime = w.blocked();
    w.patchSession(byTime.sessionId, { endedAt: "2026-10-22T08:30:00.000Z" });
    expect(await code(w.stop(MAX, byTime.sessionId))).toMatchObject({ code: "SESSION_ENDED" });
    expect(await code(w.retry(MAX, byTime.sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
    const byStatus = w.blocked();
    w.patchSession(byStatus.sessionId, { summary: { ...(w.meta(byStatus.sessionId).summary as Item), status: "cancelled" } });
    expect(await code(w.stop(MAX, byStatus.sessionId))).toMatchObject({ code: "SESSION_ENDED" });
    expect(await code(w.retry(MAX, byStatus.sessionId))).toEqual({ code: "CONFIG_INVALID", message: NOTHING });
    expect(w.calls.cancel).toEqual([]);
    expect(w.calls.workflow).toEqual([]);
  });

  it("recomputes the session's summary after a stop, so its status shows at once", async () => {
    const w = world();
    const { sessionId } = w.blocked();
    expect(w.meta(sessionId).summaryRevision).toBe(1);
    await w.stop(MAX, sessionId);
    expect(w.meta(sessionId)).toMatchObject({ summaryRevision: 2, summary: { status: "needs_person" } });
  });

  it("starts no second run even when Plan 3 no longer remembers the first one's request, and answers the same person the same session", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    const first = await w.retry(MAX, old.sessionId);
    w.started.clear();
    const again = await w.retry(MAX, old.sessionId);
    expect(again.session.sessionId).toBe(first.session.sessionId);
    expect(w.calls.start).toHaveLength(1);
    w.seedShare(ORG_A, old.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    expect(await code(w.retry(ARJUN, old.sessionId))).toEqual({ code: "CONFIG_INVALID", message: "This session was already retried." });
    expect(w.calls.start).toHaveLength(1);
  });

  it("tells another person whose retry meets the first one's run that it was already retried, and makes the link the first one's lost for them", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    w.seedShare(ORG_A, old.sessionId, { kind: "member", developerId: ARJUN }, "edit");
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.retry(MAX, old.sessionId)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(await code(w.retry(ARJUN, old.sessionId))).toEqual({ code: "CONFIG_INVALID", message: "This session was already retried." });
    expect(w.eventTexts(old.sessionId)).toEqual(["Max retried this in a new session."]);
  });

  it("never overwrites the link of a new session that already says which session it retries", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    // Plan 3's start answers a session that is already linked to another.
    const linked = w.seedSession({ owner: MAX });
    w.patchSession(linked.sessionId, { retryOf: "ses_00000000000000000099" });
    w.started.set(retryRunRequestId(ORG_A, old.sessionId), { taskId: linked.taskId, sessionId: linked.sessionId, owner: MAX });
    await expect(w.retry(MAX, old.sessionId)).rejects.toBeDefined();
    expect(w.meta(linked.sessionId).retryOf).toBe("ses_00000000000000000099");
    expect(w.eventTexts(old.sessionId)).toEqual([]);
  });

  it("answers the first retry's session when another request wrote the one-time mark first, and refuses it to another person", async () => {
    for (const markedBy of [MAX, ARJUN]) {
      const w = world();
      const old = w.agentRun("FAILED");
      const other = w.seedSession({ owner: markedBy });
      const original = w.db.send;
      let marked = false;
      w.db.send = async (command) => {
        if (!marked && command.constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("AGENT_SESSION_RETRIED")) {
          marked = true;
          w.db.set({ ...agentSessionKey(ORG_A, old.sessionId, "RETRIED"), entityType: "AGENT_SESSION_RETRIED", orgId: ORG_A, sessionId: other.sessionId, by: markedBy, requestId: randomUUID(), at: "2026-10-22T09:00:00.000Z" });
        }
        return original(command);
      };
      const result = await code(w.retry(MAX, old.sessionId));
      expect(marked).toBe(true);
      if (markedBy === MAX) expect(result).toBeUndefined();
      else expect(result).toEqual({ code: "CONFIG_INVALID", message: "This session was already retried." });
      expect(w.eventTexts(old.sessionId)).toEqual([]);
    }
  });

  it("tells a plain task that failed by its ended status alone, without the flag, to continue it where it started", async () => {
    const w = world();
    const { sessionId, taskId } = w.seedSession();
    w.patchTask(taskId, { client: "Codex" });
    w.patchSession(sessionId, { summary: { ...(w.meta(sessionId).summary as Item), status: "failed" } });
    expect(await code(w.retry(MAX, sessionId))).toEqual({ code: "CONFIG_INVALID", message: "Continue this task from Codex." });
    const nameless = w.seedSession();
    w.patchSession(nameless.sessionId, { summary: { ...(w.meta(nameless.sessionId).summary as Item), lastRunFailed: true } });
    w.patchTask(nameless.taskId, { client: "  " });
    expect(await code(w.retry(MAX, nameless.sessionId))).toEqual({ code: "CONFIG_INVALID", message: "Continue this task from where you started it." });
  });

  it("starts two concurrent retries of one session into one link: one retried event, one new session", async () => {
    const w = world();
    const old = w.agentRun("FAILED");
    const [first, second] = await Promise.all([w.retry(MAX, old.sessionId), w.retry(MAX, old.sessionId)]);
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(w.eventTexts(old.sessionId)).toEqual(["Max retried this in a new session."]);
    expect(w.started.size).toBe(1);
  });
});

describe("Plan 3's own entry points keep the checks they had", () => {
  /** Dependencies as far as the session actor's access reads them. */
  const taskDeps = (w: ReturnType<typeof world>, role: "viewer" | "contributor" | undefined = "contributor", orgId: OrgId = ORG_A) => ({
    documentClient: w.db, tableName: "state", orgId, now: () => w.clock.now, log: () => undefined,
    checkAccess: async () => ({ role, access: "granted" }),
  }) as never;
  const MAX_CALLER = (w: ReturnType<typeof world>, orgId: OrgId = ORG_A) => w.caller(MAX, orgId);

  it("asks a retry by the session actor for a role that starts work on the project", async () => {
    const w = world();
    const { taskId } = w.blocked();
    const task = w.taskOf(taskId) as never;
    await expect(retryTaskWorkflowFor(taskDeps(w, "viewer"), task, { requestId: randomUUID(), actor: { kind: "session", caller: MAX_CALLER(w) } })).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });

  it("refuses a retry by the session actor on a closed task, and on a task of another org, as not found", async () => {
    const w = world();
    const closed = w.blocked();
    w.patchTask(closed.taskId, { closedAt: "2026-10-22T08:40:00.000Z" });
    await expect(retryTaskWorkflowFor(taskDeps(w), w.taskOf(closed.taskId) as never, { requestId: randomUUID(), actor: { kind: "session", caller: MAX_CALLER(w) } })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const open = w.blocked();
    await expect(retryTaskWorkflowFor(taskDeps(w, "contributor", ORG_B), w.taskOf(open.taskId) as never, { requestId: randomUUID(), actor: { kind: "session", caller: w.caller(BO, ORG_B) } })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(cancelTaskFor(taskDeps(w, "contributor", ORG_B), w.taskOf(open.taskId) as never, { requestId: randomUUID(), actor: { kind: "session", caller: w.caller(BO, ORG_B) } })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("gives the session actor nothing for the other task actions: only the owner's rules reach them", async () => {
    const w = world();
    const { taskId } = w.blocked();
    // Without the flag, Max is no owner of Priya's task, so the owner's own rules refuse the cancel.
    await expect(cancelTaskFor(taskDeps(w), w.taskOf(taskId) as never, { requestId: randomUUID(), actor: { kind: "owner", caller: MAX_CALLER(w) } })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("a workflow retry that fails after Plan 3 committed it (13 review I-1)", () => {
  /** What Plan 3 writes in the transaction that starts the run: the idempotency item of the request that started it (here the fake writes it, or another person's). */
  const planThreeRequest = (w: ReturnType<typeof world>, taskId: string, requestId: string) => {
    const task = w.taskOf(taskId);
    w.db.set({ pk: `IDEMPOTENCY#${String(task.ownerKey)}#${String(task.workspaceId)}`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", payloadHash: "h" });
  };

  it("records the retry when the workflow moved on from the revision it read: the event, the request item and the audit item", async () => {
    const w = world({ audit: true });
    const { sessionId, taskId } = w.blocked();
    const requestId = randomUUID();
    w.control.retryWorkflow = async (task, id) => {
      w.calls.workflow.push({ taskId: task.taskId, requestId: id });
      // Plan 3 committed the run, then failed on something after it.
      planThreeRequest(w, taskId, id);
      w.patchTask(taskId, { workflow: { revision: 4, stage: "PLAN", state: "RUNNING" } });
      throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
    };
    await w.retry(MAX, sessionId, requestId);
    expect(w.eventTexts(sessionId)).toEqual(["Max retried this."]);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `REQUEST#${requestId}`))).toMatchObject({ action: "retry", by: MAX, sessionId });
    expect(w.audit!.recordedBy("session.retried")).toHaveLength(1);
  });

  it("records the retry of a run that stopped again before this call looked: the workflow is BLOCKED once more, with this request's own item (Task 14 review)", async () => {
    const w = world({ audit: true });
    const { sessionId, taskId } = w.blocked();
    const requestId = randomUUID();
    w.control.retryWorkflow = async (_task, id) => {
      planThreeRequest(w, taskId, id);
      w.patchTask(taskId, { workflow: { revision: 5, stage: "PLAN", state: "BLOCKED" } });
      throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
    };
    await w.retry(MAX, sessionId, requestId);
    expect(w.eventTexts(sessionId)).toEqual(["Max retried this."]);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `REQUEST#${requestId}`))).toMatchObject({ action: "retry", by: MAX, sessionId });
    expect(w.audit!.recordedBy("session.retried")).toHaveLength(1);
  });

  it("does not record a retry as the caller's when the workflow was moved by another request: no item of this request id (Task 14 review)", async () => {
    for (const after of [{ revision: 4, stage: "PLAN", state: "RUNNING" }, { revision: 5, stage: "PLAN", state: "BLOCKED" }]) {
      const w = world({ audit: true });
      const { sessionId, taskId } = w.blocked();
      const requestId = randomUUID();
      w.control.retryWorkflow = async () => {
        // Somebody else's retry (its own request id) started the run while this call was being refused.
        planThreeRequest(w, taskId, randomUUID());
        w.patchTask(taskId, { workflow: after });
        throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
      };
      expect(await code(w.retry(MAX, sessionId, requestId)), JSON.stringify(after)).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(w.eventTexts(sessionId)).toEqual([]);
      expect(w.db.get(agentSessionKey(ORG_A, sessionId, `REQUEST#${requestId}`))).toBeUndefined();
      expect(w.audit!.recordedBy("session.retried")).toHaveLength(0);
    }
  });

  it("does not read a workflow that changed in only one way as a retry that started: the revision alone, or the request item alone, is not enough", async () => {
    for (const after of [{ revision: 3, stage: "PLAN", state: "RUNNING" }, { revision: 4, stage: "PLAN", state: "BLOCKED" }]) {
      const w = world({ audit: true });
      const { sessionId, taskId } = w.blocked();
      const requestId = randomUUID();
      w.control.retryWorkflow = async (_task, id) => {
        // The item is there for the revision-unchanged case only; the other has a new revision and no item.
        if (after.revision === 3) planThreeRequest(w, taskId, id);
        w.patchTask(taskId, { workflow: after });
        throw agentXError("TASK_NOT_FOUND", "no task here that you can see");
      };
      expect(await code(w.retry(MAX, sessionId, requestId)), JSON.stringify(after)).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(w.eventTexts(sessionId)).toEqual([]);
      expect(w.db.get(agentSessionKey(ORG_A, sessionId, `REQUEST#${requestId}`))).toBeUndefined();
    }
  });

  it("writes nothing when the workflow did not move: a refusal stays a refusal", async () => {
    const w = world({ audit: true });
    const { sessionId } = w.blocked();
    const requestId = randomUUID();
    w.control.retryWorkflow = async () => { throw agentXError("TASK_NOT_FOUND", "no task here that you can see"); };
    expect(await code(w.retry(MAX, sessionId, requestId))).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(w.eventTexts(sessionId)).toEqual([]);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `REQUEST#${requestId}`))).toBeUndefined();
  });
});

describe("what a retry leaves behind (13 review minors)", () => {
  it("keeps the one-time RETRIED mark and the request item as long as Plan 3 keeps the run's own request", async () => {
    const w = world();
    const { sessionId } = w.agentRun("FAILED");
    await w.retry(MAX, sessionId);
    const expected = Math.floor(w.clock.now / 1000) + RUN_RECORD_MEMORY_DAYS * 86_400;
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, "RETRIED"))).toMatchObject({ indexExpiresAt: expected });
    const requests = w.db.find((item) => item.pk === agentSessionKey(ORG_A, sessionId, "META").pk && String(item.sk).startsWith("REQUEST#"));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ indexExpiresAt: expected });
  });

  it("repairs a link that was lost after the run started: the next retry of the session, by anyone, links it, and only the starter is answered with the new session", async () => {
    const w = world({ audit: true });
    const { sessionId } = w.agentRun("FAILED");
    // The link's transaction is lost once (the process died before it landed): Plan 3 already started the run.
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"RETRIED"'), error: { name: "InternalServerError" } });
    expect(await code(w.retry(MAX, sessionId))).toBeDefined();
    expect(w.calls.start).toHaveLength(1);
    expect(w.eventTexts(sessionId)).toEqual([]);
    const newSession = [...w.started.values()][0]!.sessionId;
    expect(w.meta(newSession).retryOf).toBeUndefined();
    // Another editor retries: the link is made for the person who started the run, and she is told it was already retried.
    expect(await code(w.retry(PRIYA, sessionId))).toEqual({ code: "CONFIG_INVALID", message: "This session was already retried." });
    expect(w.meta(newSession).retryOf).toBe(sessionId);
    expect(w.eventTexts(sessionId)).toEqual(["Max retried this in a new session."]);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, "RETRIED"))).toMatchObject({ by: MAX, sessionId: newSession });
    expect(w.calls.start).toHaveLength(1);
    // The starter asking again is answered with the new session, and nothing more is written.
    const before = w.db.items.size;
    const again = await w.retry(MAX, sessionId);
    expect(again.session.sessionId).toBe(newSession);
    expect(w.db.items.size).toBeLessThanOrEqual(before + 1);
    expect(w.eventTexts(sessionId)).toHaveLength(1);
  });

  it("repairs the link for the starter's own repeat too, under their request id", async () => {
    const w = world();
    const { sessionId } = w.agentRun("FAILED");
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes('"RETRIED"'), error: { name: "InternalServerError" } });
    const requestId = randomUUID();
    expect(await code(w.retry(MAX, sessionId, requestId))).toBeDefined();
    const answer = await w.retry(MAX, sessionId, requestId);
    expect(answer.session.retryOf).toBe(sessionId);
    expect(w.eventTexts(sessionId)).toEqual(["Max retried this in a new session."]);
    expect(w.db.get(agentSessionKey(ORG_A, sessionId, `REQUEST#${requestId}`))).toMatchObject({ action: "retry", by: MAX });
    expect(w.calls.start).toHaveLength(1);
  });
});
