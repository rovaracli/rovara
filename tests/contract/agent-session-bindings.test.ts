// Plan 5 Task 20: a Slack thread or a Linear issue follows exactly one session. The binding is two items written together (the session's own
// `BINDING#<kind>` and the reverse surface item), each only if absent; a task shared later is bound in the same transaction that records its thread;
// a lookup is by org. Plan 9 posts through these.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agentSessionKey, sessionBindingKey, sessionSurfaceKey, type SessionBinding } from "@rovara-code/contracts";
import { createTaskSessionItems, ensureTaskSession } from "../../packages/broker/src/agent-sessions/create.js";
import { bindSessionSurface, sessionForSurface } from "../../packages/broker/src/agent-sessions/bindings.js";
import { sessionView, type SessionReadDependencies } from "../../packages/broker/src/agent-sessions/read.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice } from "../../packages/broker/src/developer/notifications.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createDeveloperTaskBroker, recordStream } from "../support/developer-task-broker.js";
import { ARJUN, BO, ORG_A, ORG_B, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const THREAD: SessionBinding = { kind: "slack_thread", teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000031" };
const OTHER_THREAD: SessionBinding = { kind: "slack_thread", teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000099" };
const ISSUE: SessionBinding = { kind: "linear_issue", issueId: "ENG-142", url: "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug" };
const OTHER_ISSUE: SessionBinding = { kind: "linear_issue", issueId: "ENG-143", url: "https://linear.app/acme/issue/ENG-143/another" };
const NOTIFIED_TS = "1695500000.000500";

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

function world() {
  const w = sessionWorld();
  const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
  const sessionBindings = (sessionId: string) => w.db.find((item) => typeof item.pk === "string" && item.pk.includes("SESSION_BINDING#") && item.pk.includes(sessionId));
  const surfaceItems = () => w.db.find((item) => typeof item.pk === "string" && item.pk.includes("SESSION_SURFACE"));
  return { w, table, sessionBindings, surfaceItems };
}

describe("binding a surface to a session", () => {
  it("writes the session's binding and the surface's reverse item together", async () => {
    const { w, table } = world();
    const { sessionId } = w.seedSession();
    const before = w.db.transactions().length;
    await expect(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: THREAD })).resolves.toBe("bound");
    expect(w.db.transactions()).toHaveLength(before + 1);
    expect(w.db.get(sessionBindingKey(ORG_A, sessionId, "slack_thread"))).toMatchObject({ orgId: ORG_A, sessionId, binding: THREAD });
    expect(w.db.get(sessionSurfaceKey(ORG_A, THREAD))).toMatchObject({ orgId: ORG_A, sessionId, kind: "slack_thread" });
  });

  it("answers already_bound to the same surface again and writes nothing", async () => {
    const { w, table } = world();
    const { sessionId } = w.seedSession();
    await bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: ISSUE });
    const before = structuredClone(w.db.find(() => true));
    await expect(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: ISSUE })).resolves.toBe("already_bound");
    expect(w.db.find(() => true)).toEqual(before);
  });

  it("refuses a surface that already follows another session, and leaves the second session unbound", async () => {
    const { w, table, sessionBindings } = world();
    const first = w.seedSession().sessionId;
    const second = w.seedSession().sessionId;
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: first, binding: THREAD });
    expect(await code(bindSessionSurface(table, { orgId: ORG_A, sessionId: second, binding: THREAD }))).toEqual({ code: "CONFIG_INVALID", message: "This thread already follows another session." });
    expect(sessionBindings(second)).toEqual([]);
    expect(w.db.get(sessionSurfaceKey(ORG_A, THREAD))).toMatchObject({ sessionId: first });
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: first, binding: ISSUE });
    expect(await code(bindSessionSurface(table, { orgId: ORG_A, sessionId: second, binding: ISSUE }))).toEqual({ code: "CONFIG_INVALID", message: "This issue already follows another session." });
  });

  it("allows one binding per kind per session: a second thread or a second issue is refused, one of each is fine", async () => {
    const { w, table } = world();
    const { sessionId } = w.seedSession();
    await bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: THREAD });
    expect(await code(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: OTHER_THREAD }))).toEqual({ code: "CONFIG_INVALID", message: "This session already follows another thread." });
    expect(w.db.get(sessionSurfaceKey(ORG_A, OTHER_THREAD))).toBeUndefined();
    await expect(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: ISSUE })).resolves.toBe("bound");
    expect(await code(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: OTHER_ISSUE }))).toEqual({ code: "CONFIG_INVALID", message: "This session already follows another issue." });
    expect(w.db.get(sessionSurfaceKey(ORG_A, OTHER_ISSUE))).toBeUndefined();
  });

  it("lets only one of two sessions racing for a thread win", async () => {
    const { w, table } = world();
    const a = w.seedSession().sessionId;
    const b = w.seedSession().sessionId;
    const results = await Promise.allSettled([bindSessionSurface(table, { orgId: ORG_A, sessionId: a, binding: THREAD }), bindSessionSurface(table, { orgId: ORG_A, sessionId: b, binding: THREAD })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "CONFIG_INVALID" });
    const winner = (w.db.get(sessionSurfaceKey(ORG_A, THREAD)) as { sessionId: string }).sessionId;
    expect([a, b]).toContain(winner);
    expect(w.db.get(sessionBindingKey(ORG_A, winner === a ? b : a, "slack_thread"))).toBeUndefined();
  });

  it("answers a retryable error, not 'follows another session', when a transaction conflict hides the outcome", async () => {
    const { w, table } = world();
    const { sessionId } = w.seedSession();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }, { Code: "None" }] } });
    const refused = await code(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: THREAD }));
    expect(refused?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(refused?.message).not.toContain("another session");
    await expect(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: THREAD })).resolves.toBe("bound");
  });

  it("never binds to a session of another org, a missing one or an ended one", async () => {
    const { w, table, surfaceItems } = world();
    const a = w.seedSession().sessionId;
    const ended = w.seedSession({ ended: true }).sessionId;
    const b = w.seedSession({ orgId: ORG_B, owner: BO }).sessionId;
    expect(await code(bindSessionSurface(table, { orgId: ORG_B, sessionId: a, binding: THREAD }))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(await code(bindSessionSurface(table, { orgId: ORG_A, sessionId: b, binding: THREAD }))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(await code(bindSessionSurface(table, { orgId: ORG_A, sessionId: "ses_zzzzzzzzzzzzzzzzzzzz", binding: THREAD }))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect((await code(bindSessionSurface(table, { orgId: ORG_A, sessionId: ended, binding: THREAD })))?.code).toBe("SESSION_ENDED");
    // A record under org A's key that says it is org B's (a corrupted row) is not A's session either.
    const odd = w.seedSession().sessionId;
    w.db.set({ ...w.db.get(agentSessionKey(ORG_A, odd, "META"))!, orgId: ORG_B });
    expect(await code(bindSessionSurface(table, { orgId: ORG_A, sessionId: odd, binding: THREAD }))).toEqual({ code: "NOT_FOUND", message: "session not found" });
    expect(surfaceItems()).toEqual([]);
  });

  it("refuses a binding that is not well formed, and never echoes it", async () => {
    const { w, table, surfaceItems } = world();
    const { sessionId } = w.seedSession();
    for (const bad of [
      { kind: "linear_issue", issueId: "ENG-1", url: "http://linear.app/acme/issue/ENG-1" },
      { kind: "linear_issue", issueId: "ENG 1‮", url: "https://linear.app/x" },
      { kind: "slack_thread", teamId: "nope", channelId: SLACK_CHANNEL, threadTs: "1.2" },
      { kind: "email", address: "a@b.c" },
    ]) {
      const refused = await code(bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: bad as never }));
      expect(refused?.code).toBe("CONFIG_INVALID");
      expect(refused?.message).not.toContain("ENG");
    }
    expect(surfaceItems()).toEqual([]);
  });
});

describe("finding the session a surface follows", () => {
  it("finds it by org, and gives undefined for an unbound surface or another org's", async () => {
    const { w, table } = world();
    const { sessionId } = w.seedSession();
    const other = w.seedSession({ orgId: ORG_B, owner: BO }).sessionId;
    await bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: THREAD });
    expect((await sessionForSurface(table, ORG_A, THREAD))?.sessionId).toBe(sessionId);
    expect(await sessionForSurface(table, ORG_A, OTHER_THREAD)).toBeUndefined();
    expect(await sessionForSurface(table, ORG_B, THREAD)).toBeUndefined();
    // The same thread in org B is a different surface: org B can bind it to its own session.
    await expect(bindSessionSurface(table, { orgId: ORG_B, sessionId: other, binding: THREAD })).resolves.toBe("bound");
    expect((await sessionForSurface(table, ORG_B, THREAD))?.sessionId).toBe(other);
    expect((await sessionForSurface(table, ORG_A, THREAD))?.sessionId).toBe(sessionId);
  });

  it("gives undefined when the session is gone, or the two items disagree", async () => {
    const { w, table } = world();
    const gone = w.seedSession().sessionId;
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: gone, binding: THREAD });
    w.db.delete(agentSessionKey(ORG_A, gone, "META"));
    expect(await sessionForSurface(table, ORG_A, THREAD)).toBeUndefined();

    const left = w.seedSession().sessionId;
    const right = w.seedSession().sessionId;
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: left, binding: ISSUE });
    // The surface item names a session whose own binding is not this issue: the lookup does not trust it.
    w.db.set({ ...w.db.get(sessionSurfaceKey(ORG_A, ISSUE))!, sessionId: right });
    expect(await sessionForSurface(table, ORG_A, ISSUE)).toBeUndefined();
    // A surface item that names another org is not read as this org's.
    w.db.set({ ...w.db.get(sessionSurfaceKey(ORG_A, ISSUE))!, sessionId: left, orgId: ORG_B });
    expect(await sessionForSurface(table, ORG_A, ISSUE)).toBeUndefined();
  });

  it("fails closed: a read that errors is an error, not 'unbound'", async () => {
    const { w, table } = world();
    const { sessionId } = w.seedSession();
    await bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: THREAD });
    w.db.injectFault({ command: "GetCommand", error: { name: "InternalServerError" } });
    await expect(sessionForSurface(table, ORG_A, THREAD)).rejects.toThrow();
  });
});

describe("what the session view shows of its bindings", () => {
  it("shows the Slack thread's link and the Linear issue's link, to a viewer", async () => {
    const { w, table } = world();
    const { sessionId } = w.seedSession();
    await bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: THREAD });
    await bindSessionSurface(table, { orgId: ORG_A, sessionId, binding: ISSUE });
    const deps = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: "https://cell.example.com", cursorKey: "k".repeat(64),
      taskView: async (task: { taskId: string; project: string }) => ({ taskId: task.taskId, title: "Bump", project: task.project, status: "RUNNING", startingRevision: 1, client: "test", shared: false, createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:05:00.000Z", events: [] }),
    } as unknown as SessionReadDependencies;
    const session = await sessionView(deps, w.caller(ARJUN), sessionId);
    expect(session.bindings).toEqual([
      { kind: "slack_thread", url: `https://app.slack.com/client/${SLACK_TEAM}/${SLACK_CHANNEL}/thread/${SLACK_CHANNEL}-1695500000.000031` },
      { kind: "linear_issue", url: "https://linear.app/acme/issue/ENG-142/fix-the-retry-bug" },
    ]);
  });
});

describe("a task from before sessions that is already shared to a thread", () => {
  it("is bound to that thread when it is given its session", async () => {
    const w = sessionWorld();
    const { sessionId: seeded, taskId } = w.seedSession();
    w.db.delete(agentSessionKey(ORG_A, seeded, "META"));
    const { sessionId: _gone, ...rest } = w.db.get(taskKey(taskId))!; // eslint-disable-line @typescript-eslint/no-unused-vars -- the task has none
    const full = {
      ...rest, agent: { agentId: "rovara-code", name: "Rovara Code", version: 3, builtin: true }, origin: "app", title: "Bump the Stripe SDK",
      startedBy: { developerId: PRIYA }, payer: { kind: "member", developerId: PRIYA }, createdAt: "2026-10-20T08:00:00.000Z",
      share: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000031", mode: "continue", sharedAt: "2026-10-20T08:01:00.000Z" },
    };
    w.db.set(full);
    const table = { documentClient: w.db, tableName: "state", now: () => w.clock.now };
    const id = await ensureTaskSession(table, full as never, { ownerName: "Priya", title: "Bump the Stripe SDK" });
    expect(id).toMatch(/^ses_/);
    expect(w.db.get(sessionSurfaceKey(ORG_A, THREAD))).toMatchObject({ sessionId: id, kind: "slack_thread" });
    expect(w.db.get(sessionBindingKey(ORG_A, id as never, "slack_thread"))).toMatchObject({ binding: THREAD });
  });
});

// ---- a task shared after it started: the notifier records the thread

type Post = (input: { channel: string; threadTs?: string; text: string }) => Promise<{ ts: string }>;

async function notifierWorld(post: Post = async () => ({ ts: NOTIFIED_TS }), wrap?: (db: FakeDynamoDb) => { send(command: unknown): Promise<unknown> }) {
  const harness = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
  const stream = recordStream(harness.db);
  const queue: Notice[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const handle = createNotifierHandler({
    documentClient: wrap?.(harness.db) ?? harness.db, tableName: "state", enqueue: async (notices) => { queue.push(...notices); }, retryLater: async () => undefined, post,
    now: () => Date.now(), log: (entry) => logs.push(entry), deliveryFailed: vi.fn(),
  });
  const pump = async () => {
    await handle({ Records: stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const batch = queue.splice(0, queue.length);
    await handle({ Records: batch.map((notice, index) => ({ eventSource: "aws:sqs", messageId: `m${String(index)}`, receiptHandle: `r${String(index)}`, body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } })) });
  };
  const start = async () => {
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", shareToChannel: true });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const meta = () => harness.db.get(`DEVTASK#${taskId}`, "META") as { sessionId?: string; share: { threadTs?: string } };
    return { taskId, meta };
  };
  return { ...harness, pump, logs, start };
}

describe("a task shared after it started", () => {
  beforeAll(async () => { await loadSlackBroker(); });
  const surfaceOf = (db: FakeDynamoDb, threadTs = NOTIFIED_TS) => db.get(sessionSurfaceKey(TEST_ORG, { kind: "slack_thread", teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs }));

  it("is bound to its thread in the transaction that records the thread", async () => {
    const n = await notifierWorld();
    const { meta } = await n.start();
    const sessionId = meta().sessionId!;
    expect(sessionId).toMatch(/^ses_/);
    await n.pump();
    expect(meta().share.threadTs).toBe(NOTIFIED_TS);
    expect(surfaceOf(n.db)).toMatchObject({ orgId: TEST_ORG, sessionId, kind: "slack_thread" });
    expect(n.db.get(sessionBindingKey(TEST_ORG, sessionId, "slack_thread"))).toMatchObject({ binding: { kind: "slack_thread", threadTs: NOTIFIED_TS } });
    const recording = n.db.transactions().filter((items) => items.some((entry) => (entry.Put as { Item?: { entityType?: string } } | undefined)?.Item?.entityType === "SHARED_TASK"));
    expect(recording, "one transaction records the thread").toHaveLength(1);
    const surface = sessionSurfaceKey(TEST_ORG, { kind: "slack_thread", teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: NOTIFIED_TS });
    const written = recording[0]!.flatMap((entry) => ((entry.Put as { Item?: { pk?: string; sk?: string } } | undefined)?.Item === undefined ? [] : [(entry.Put as { Item: { pk: string; sk: string } }).Item]));
    expect(written.some((item) => item.pk === surface.pk && item.sk === surface.sk)).toBe(true);
    expect(written.some((item) => item.pk === sessionBindingKey(TEST_ORG, sessionId, "slack_thread").pk && item.sk === "BINDING#slack_thread")).toBe(true);
    // The notifier's IAM grant limits it by partition key, so nothing it puts may sit in the session's own partition.
    expect(written.filter((item) => item.pk.includes("AGENT_SESSION#"))).toEqual([]);
  });

  it("still records its thread when the thread already follows another session, and says so in the log", async () => {
    const n = await notifierWorld();
    const { meta, taskId } = await n.start();
    const otherId = "ses_0123456789abcdefghij" as never;
    const table = { documentClient: n.db, tableName: "state", now: Date.now };
    await n.db.send(new TransactWriteCommand({ TransactItems: createTaskSessionItems(table, {
      orgId: TEST_ORG, sessionId: otherId, taskId: randomUUID(), project: "payments", agent: { agentId: "rovara-code", name: "Rovara Code", version: 3 }, title: "Another",
      owner: { developerId: MAYA.developerId, name: "Maya" }, startedBy: { kind: "member", developerId: MAYA.developerId }, origin: "app", payer: { kind: "member", developerId: MAYA.developerId }, now: "2026-10-22T09:30:00.000Z",
    }) }));
    await bindSessionSurface(table, { orgId: TEST_ORG, sessionId: otherId, binding: { kind: "slack_thread", teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: NOTIFIED_TS } });
    await n.pump();
    expect(meta().share.threadTs).toBe(NOTIFIED_TS);
    expect(n.db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/${NOTIFIED_TS}`, "META")).toMatchObject({ taskId });
    expect(surfaceOf(n.db)).toMatchObject({ sessionId: otherId });
    expect(n.db.get(sessionBindingKey(TEST_ORG, meta().sessionId as never, "slack_thread"))).toBeUndefined();
    expect(n.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.session_binding_skipped", taskId }));
    expect(JSON.stringify(n.logs.filter((entry) => entry.event === "developer_notifier.session_binding_skipped"))).not.toContain(NOTIFIED_TS);
  });

  it("records the thread and binds nothing for a task with no session", async () => {
    const n = await notifierWorld();
    const { meta, taskId } = await n.start();
    const { sessionId: _none, ...rest } = n.db.get(`DEVTASK#${taskId}`, "META")!; // eslint-disable-line @typescript-eslint/no-unused-vars -- the point is that it has none
    n.db.set(rest);
    await n.pump();
    expect(meta().share.threadTs).toBe(NOTIFIED_TS);
    expect(surfaceOf(n.db)).toBeUndefined();
    expect(n.logs.filter((entry) => entry.event === "developer_notifier.session_binding_skipped")).toEqual([]);
  });

  it("records the thread and binds nothing when the session has ended", async () => {
    const n = await notifierWorld();
    const { meta } = await n.start();
    const sessionKey = agentSessionKey(TEST_ORG, meta().sessionId as never, "META");
    n.db.set({ ...n.db.get(sessionKey)!, endedAt: "2026-10-22T09:00:00.000Z" });
    await n.pump();
    expect(meta().share.threadTs).toBe(NOTIFIED_TS);
    expect(surfaceOf(n.db)).toBeUndefined();
    expect(n.logs).toContainEqual(expect.objectContaining({ event: "developer_notifier.session_binding_skipped" }));
  });

  it("binds a session that was given to the task while its thread was being recorded", async () => {
    // The notifier read the task with no session; the session is attached before its transaction commits. The task's update is conditioned on that, so it is refused,
    // read again, and the thread is recorded with the binding.
    const attach: { taskId: string; sessionId?: string } = { taskId: "" };
    let injected = false;
    const n = await notifierWorld(undefined, (db) => ({
      send: async (command: unknown) => {
        const input = (command as { input?: { TransactItems?: unknown[] } }).input;
        if (!injected && JSON.stringify(input?.TransactItems ?? []).includes("SHARED_TASK")) {
          injected = true;
          db.set({ ...db.get(`DEVTASK#${attach.taskId}`, "META")!, sessionId: attach.sessionId });
        }
        return db.send(command as never);
      },
    }));
    const started = await n.start();
    const { taskId } = started;
    const sessionId = started.meta().sessionId!;
    attach.taskId = taskId;
    attach.sessionId = sessionId;
    const { sessionId: _none, ...rest } = n.db.get(`DEVTASK#${taskId}`, "META")!; // eslint-disable-line @typescript-eslint/no-unused-vars -- the task has none when the notifier reads it
    n.db.set(rest);
    await n.pump();
    expect(injected).toBe(true);
    expect(started.meta().share.threadTs).toBe(NOTIFIED_TS);
    expect(surfaceOf(n.db)).toMatchObject({ sessionId });
    expect(n.db.get(sessionBindingKey(TEST_ORG, sessionId as never, "slack_thread"))).toBeDefined();
  });

  it("writes the binding only with the thread: a conflict that cancels the transaction leaves neither", async () => {
    const n = await notifierWorld();
    const { meta } = await n.start();
    const sessionId = meta().sessionId!;
    n.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("SHARED_TASK"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }] }, times: 4 });
    await n.pump();
    expect(meta().share.threadTs).toBeUndefined();
    expect(surfaceOf(n.db)).toBeUndefined();
    expect(n.db.get(sessionBindingKey(TEST_ORG, sessionId, "slack_thread"))).toBeUndefined();
  });
});

describe("the bindings of org A are not org B's", () => {
  it("does not let org B find A's thread, and writes nothing under org B", async () => {
    const { w, table } = world();
    const a = w.seedSession().sessionId;
    await bindSessionSurface(table, { orgId: ORG_A, sessionId: a, binding: THREAD });
    expect(await sessionForSurface(table, ORG_B, THREAD)).toBeUndefined();
    expect(w.db.find((item) => typeof item.pk === "string" && item.pk.includes(ORG_B) && item.pk.includes("SESSION_SURFACE"))).toEqual([]);
  });
});
