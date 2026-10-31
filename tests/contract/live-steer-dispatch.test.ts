// Live steer, dispatcher side: a `steer` outbox item is delivered to the worker that runs the step, the message is `delivered` only when the worker's session took it, a worker that says
// nothing runs (or a stale item) leaves the message as a note, and everything is bounded: a worker that cannot be reached is retried up to the dispatcher's attempt limit and then only the item
// ends FAILED. Compute is never started for a message, no operation record is touched, and the text is never in a log or an error.
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppNoteSchema, LIVE_STEER_REAPPROVAL_REASON, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, workspaceSessionKey } from "../../packages/contracts/src/index.js";
import { createDispatcherHandler } from "../../packages/broker/src/aws/dispatcher.js";
import { createLiveSteerDispatch } from "../../packages/broker/src/agent-sessions/live-steer-dispatch.js";
import { clearLiveDeliveredSince, deliverSteerLive } from "../../packages/broker/src/agent-sessions/steer.js";
import { reapprovalMessageIds, settleLiveSteerReapproval } from "../../packages/broker/src/agent-sessions/live-steer-reapproval.js";
import { threadNotesPromptSection } from "../../packages/broker/src/aws/developer-tasks.js";
import { verifyInvokeAuthorization, invocationMatchesClaims } from "../../packages/worker/src/invoke-auth.js";
import { agentSessionKey } from "../../packages/contracts/src/index.js";
import { ORG_A, PRIYA } from "../support/agent-session-world.js";
import { liveSteerWorld, type Item } from "../support/live-steer-world.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const kmsSign = async (message: Uint8Array) => new Uint8Array(sign("sha256", message, keys.privateKey));

async function setup(options: Parameters<typeof liveSteerWorld>[0] & { session?: Partial<Item> | null; features?: string[] | "down"; answer?: unknown; status?: number } = {}) {
  const f = liveSteerWorld(options);
  if (options.session !== null) f.w.db.set({ ...workspaceSessionKey(f.workspaceId), entityType: "WORKSPACE_SESSION", workspaceId: f.workspaceId, state: "READY", generation: 7, privateIp: "10.42.1.9", ...options.session });
  const message = await f.send(PRIYA);
  const record = f.outbox()[0] as Record<string, unknown>;
  const posts: Array<{ url: string; authorization: string; body: string }> = [];
  const pings: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const answer = options.answer ?? { accepted: true, outcome: "steered" };
  const dispatch = createLiveSteerDispatch({
    documentClient: f.w.db, tableName: "state", now: () => f.w.clock.now, sign: kmsSign, log: (entry) => logs.push(entry),
    workerFeatures: async (url) => { pings.push(url); if (options.features === "down") throw new Error("ping failed"); return options.features ?? ["task.liveSteer.v1"]; },
    post: async (url, init) => { posts.push({ url, ...init }); return { status: options.status ?? 200, body: typeof answer === "string" ? answer : JSON.stringify(answer) }; },
  });
  const ensureSession = vi.fn();
  const failures: Array<Record<string, unknown>> = [];
  const markFailed = vi.fn(async () => undefined);
  const handler = (attempt: number, maxAttempts = 3) => createDispatcherHandler({
    markDispatching: async () => { throw new Error("an operation must never be touched for a live steer"); }, markDelivered: async () => { throw new Error("no operation"); }, markFailed,
    liveSteer: dispatch, maxAttempts, log: (entry) => failures.push(entry as unknown as Record<string, unknown>),
    deliverEc2: async () => { ensureSession(); return "DELIVERED"; },
  })({ Records: [{ messageId: "m1", body: JSON.stringify(record), attributes: { ApproximateReceiveCount: String(attempt) } }] });
  const outboxNow = () => f.w.db.get({ pk: String(record["pk"]), sk: "OUTBOX" }) as Item;
  const messageNow = () => f.w.db.get({ pk: agentSessionKey(ORG_A, f.made.sessionId, "META").pk, sk: `MESSAGE#${message.messageId}` }) as Item;
  return { f, message, record, posts, pings, logs, failures, handler, outboxNow, messageNow, ensureSession, markFailed, dispatch };
}

describe("the dispatcher delivering a live steer", () => {
  it("posts the signed invocation to the step's worker and, when its session took it, marks the message delivered and the item delivered", async () => {
    const s = await setup();
    expect(await s.handler(1)).toEqual({ batchItemFailures: [] });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.url).toBe("http://10.42.1.9:8080/invocations");
    // The token is the ordinary one for the workspace, its generation and the steer's own operation, and verifies for exactly this invocation.
    const invocation = JSON.parse(s.posts[0]!.body) as { kind: string; operationId: string; workspaceId: string; fence: number; payload: { text: string } };
    expect(invocation).toMatchObject({ kind: "steer", workspaceId: s.f.workspaceId, fence: 4 });
    const verified = verifyInvokeAuthorization(s.posts[0]!.authorization, { publicKey: keys.publicKey, workspaceId: s.f.workspaceId, generation: 7, now: () => Math.floor(s.f.w.clock.now / 1000) });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(invocationMatchesClaims(invocation as never, verified.claims)).toBe(true);
    expect(s.messageNow()["delivery"]).toMatchObject({ state: "delivered" });
    expect(s.outboxNow()).toMatchObject({ status: "DELIVERED", liveSteerOutcome: "steered" });
    // The session says so, in the usual words, and never what was said.
    const events = s.f.w.db.find((item) => item.pk === agentSessionKey(ORG_A, s.f.made.sessionId, "META").pk && String(item.sk).startsWith("EVENT#"));
    expect(events.some((item) => item["type"] === "steer_delivered")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("LIVE-TEXT-4471");
    expect(s.ensureSession).not.toHaveBeenCalled();
    expect(s.markFailed).not.toHaveBeenCalled();
  });

  it("when nothing runs on the worker (not_running) the item is finished and the message stays queued: its note is the delivery", async () => {
    const s = await setup({ answer: { accepted: true, outcome: "not_running" } });
    expect(await s.handler(1)).toEqual({ batchItemFailures: [] });
    expect(s.outboxNow()).toMatchObject({ status: "DELIVERED", liveSteerOutcome: "not_running" });
    expect(s.messageNow()["delivery"]).toMatchObject({ state: "queued" });
    expect(s.f.notes()).toHaveLength(1);
  });

  it("retries a worker whose session is not open yet or that cannot be reached, up to the attempt limit, and then only the item fails; the message stays queued and no operation is touched", async () => {
    for (const options of [{ answer: { accepted: true, outcome: "not_ready" } }, { status: 503, answer: "<html>busy</html>" }, { answer: "not json" }, { features: "down" as const }]) {
      const s = await setup(options);
      expect(await s.handler(1)).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      expect(s.outboxNow()["status"]).toBe("PENDING");
      expect(await s.handler(2)).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
      // The last attempt: the dispatcher gives up, and only the item ends FAILED.
      expect(await s.handler(3)).toEqual({ batchItemFailures: [] });
      expect(s.outboxNow()).toMatchObject({ status: "FAILED", error: "RUNTIME_UNAVAILABLE: the live message could not be delivered" });
      expect(s.messageNow()["delivery"]).toMatchObject({ state: "queued" });
      expect(s.markFailed).not.toHaveBeenCalled();
      // Positive control: the failed attempts were logged, so the check below looks at real entries.
      expect(s.failures.length).toBeGreaterThan(0);
      expect(JSON.stringify([s.logs, s.failures, s.outboxNow()["error"], s.f.logs])).not.toContain("LIVE-TEXT-4471");
    }
  });

  it("never starts compute: a worker that is not READY, or does not list the feature, is not sent anything and the message stays a note", async () => {
    for (const [options, outcome] of [[{ session: { state: "STOPPED", privateIp: undefined } }, "no_worker"], [{ session: { state: "PROVISIONING" } }, "no_worker"], [{ session: null }, "no_worker"], [{ features: [] as string[] }, "old_worker"]] as const) {
      const s = await setup(options);
      expect(await s.handler(1)).toEqual({ batchItemFailures: [] });
      expect(s.posts).toHaveLength(0);
      expect(s.ensureSession).not.toHaveBeenCalled();
      expect(s.outboxNow()).toMatchObject({ status: "DELIVERED", liveSteerOutcome: outcome });
      expect(s.messageNow()["delivery"]).toMatchObject({ state: "queued" });
    }
  });

  it("a stale item is not sent: the message was answered already, or the step it was for is over", async () => {
    const answered = await setup();
    await deliverSteerLive({ documentClient: answered.f.w.db, tableName: "state", now: () => answered.f.w.clock.now }, ORG_A, answered.f.made.sessionId, answered.message.messageId);
    expect(await answered.handler(1)).toEqual({ batchItemFailures: [] });
    expect(answered.posts).toHaveLength(0);
    expect(answered.outboxNow()).toMatchObject({ status: "DELIVERED", liveSteerOutcome: "stale" });
    for (const workspace of [{ status: "READY" }, { activeOperationId: "00000000-0000-4000-8000-000000000000" }, { fence: 5 }]) {
      const s = await setup();
      s.f.w.db.set({ ...(s.f.w.db.get({ pk: `WORKSPACE#${s.f.workspaceId}`, sk: "META" }) as Item), ...workspace });
      expect(await s.handler(1)).toEqual({ batchItemFailures: [] });
      expect(s.posts).toHaveLength(0);
      expect(s.outboxNow()).toMatchObject({ liveSteerOutcome: "stale" });
    }
  });

  it("an item that is not what it says (another message's id, a mismatched record) is never sent", async () => {
    const s = await setup();
    const forged = { ...s.record, liveSteer: { ...(s.record["liveSteer"] as object), messageId: "msg_aaaaaaaaaaaaaaaaaaaa" } };
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined, markFailed: async () => undefined, liveSteer: s.dispatch, maxAttempts: 3 });
    expect(await handler({ Records: [{ messageId: "m2", body: JSON.stringify(forged), attributes: { ApproximateReceiveCount: "1" } }] })).toEqual({ batchItemFailures: [] });
    expect(s.posts).toHaveLength(0);
    expect(s.outboxNow()).toMatchObject({ liveSteerOutcome: "invalid" });
  });

  it("a dispatcher without live steer fails closed: the item is retried and ends in the dispatcher's own failure, never delivered by the ordinary path", async () => {
    const s = await setup();
    const markFailed = vi.fn(async () => undefined);
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined, markFailed, maxAttempts: 2, deliverEc2: async () => "DELIVERED" });
    const event = (attempt: number) => ({ Records: [{ messageId: "m3", body: JSON.stringify(s.record), attributes: { ApproximateReceiveCount: String(attempt) } }] });
    expect(await handler(event(1))).toEqual({ batchItemFailures: [{ itemIdentifier: "m3" }] });
    await handler(event(2));
    expect(s.posts).toHaveLength(0);
  });

  it("M9: a dispatcher without live steer never calls the operation's markFailed for a steer item (it has no operation record): the last attempt is acknowledged with a fixed log event and the message stays a note", async () => {
    const s = await setup();
    const markFailed = vi.fn(async () => undefined);
    const logs: Array<Record<string, unknown>> = [];
    const handler = createDispatcherHandler({ markDispatching: async () => true, markDelivered: async () => undefined, markFailed, maxAttempts: 2, deliverEc2: async () => "DELIVERED", log: (entry) => logs.push(entry as unknown as Record<string, unknown>) });
    const event = (attempt: number) => ({ Records: [{ messageId: "m4", body: JSON.stringify(s.record), attributes: { ApproximateReceiveCount: String(attempt) } }] });
    expect(await handler(event(2))).toEqual({ batchItemFailures: [] });
    expect(markFailed).not.toHaveBeenCalled();
    expect(logs.find((entry) => entry["event"] === "dispatch.live_steer_unconfigured")).toMatchObject({ terminal: true, level: "warn" });
    expect(JSON.stringify(logs)).not.toContain("LIVE-TEXT-4471");
    expect(s.messageNow()["delivery"]).toMatchObject({ state: "queued" });
    expect(s.f.notes()).toHaveLength(1);
  });
});

describe("a message given live is not shown again as a fresh message (I4)", () => {
  const noteOf = (f: Awaited<ReturnType<typeof setup>>["f"]) => AppNoteSchema.parse(Object.fromEntries(Object.entries(f.notes()[0]!).filter(([key]) => key !== "pk" && key !== "sk" && key !== "entityType")));

  it("when the worker's session took it, its note is marked liveDeliveredAt, and the next step's prompt shows it as already given to the running step", async () => {
    const s = await setup();
    await s.handler(1);
    const note = noteOf(s.f);
    expect(note.liveDeliveredAt).toBe(new Date(s.f.w.clock.now).toISOString());
    const section = threadNotesPromptSection([note], "n0nce");
    expect(section).toContain('live_delivered="already given to the running step when it was sent; not a new message"');
    // The note is still there for a step that fails and runs again.
    expect(section).toContain("LIVE-TEXT-4471");
  });

  it("a message the worker did not take (not_running) stays an ordinary note, shown as before", async () => {
    const s = await setup({ answer: { accepted: true, outcome: "not_running" } });
    await s.handler(1);
    const note = noteOf(s.f);
    expect(note.liveDeliveredAt).toBeUndefined();
    expect(threadNotesPromptSection([note], "n0nce")).not.toContain("live_delivered");
  });

  it("delivering still marks the message when its note cannot be marked (the note is gone): the message is answered without it", async () => {
    const s = await setup();
    s.f.w.db.delete({ pk: `DEVTASK#${s.f.made.taskId}`, sk: `NOTE#${s.message.messageId}` });
    await s.handler(1);
    expect(s.messageNow()["delivery"]).toMatchObject({ state: "delivered" });
  });
});

describe("a live mark is scoped to the step attempt that took the message (minor c)", () => {
  const noteOf = (f: Awaited<ReturnType<typeof setup>>["f"]) => AppNoteSchema.parse(Object.fromEntries(Object.entries(f.notes()[0]!).filter(([key]) => key !== "pk" && key !== "sk" && key !== "entityType")));
  const deps = (s: Awaited<ReturnType<typeof setup>>) => ({ documentClient: s.f.w.db, tableName: "state", now: () => s.f.w.clock.now });

  it("a note given live during an attempt that did not succeed loses its mark, so the re-run's prompt shows it as an ordinary message, text kept", async () => {
    const s = await setup();
    await s.handler(1);
    expect(noteOf(s.f).liveDeliveredAt).toBeDefined();
    const attemptStart = new Date(s.f.w.clock.now - 1000).toISOString();
    expect(await clearLiveDeliveredSince(deps(s), s.f.made.taskId, attemptStart)).toBe(1);
    const note = noteOf(s.f);
    expect(note.liveDeliveredAt).toBeUndefined();
    const section = threadNotesPromptSection([note], "n0nce");
    expect(section).not.toContain("live_delivered");
    expect(section).not.toContain("already given");
    expect(section).toContain("LIVE-TEXT-4471");
    expect(await clearLiveDeliveredSince(deps(s), s.f.made.taskId, attemptStart)).toBe(0);
  });

  it("a note given live before the failed attempt began (an earlier step that succeeded) keeps its mark", async () => {
    const s = await setup();
    await s.handler(1);
    const marked = noteOf(s.f).liveDeliveredAt;
    expect(await clearLiveDeliveredSince(deps(s), s.f.made.taskId, new Date(s.f.w.clock.now + 60_000).toISOString())).toBe(0);
    expect(noteOf(s.f).liveDeliveredAt).toBe(marked);
  });

  it("never throws: an unknown task clears nothing", async () => {
    const s = await setup();
    expect(await clearLiveDeliveredSince(deps(s), "00000000-0000-4000-8000-000000000000", new Date(0).toISOString())).toBe(0);
  });
});

describe("a step that stopped for re-approval marks the owner's message (I2)", () => {
  const stop = (messageId: string) => `CONFIG_INVALID: ${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE} (${messageId})`;

  it("reads the ids a stop names, and nothing from any other error", () => {
    expect(reapprovalMessageIds(stop("msg_0123456789abcdefghij"))).toEqual(["msg_0123456789abcdefghij"]);
    expect(reapprovalMessageIds(`msg_0123456789abcdefghij ${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE}`)).toEqual(["msg_0123456789abcdefghij"]);
    expect(reapprovalMessageIds("the model stopped (msg_0123456789abcdefghij)")).toEqual([]);
    expect(reapprovalMessageIds(undefined)).toEqual([]);
  });

  it("the delivered message keeps delivered and gains the fixed reason, the session's timeline says so without the text, and a repeat changes nothing", async () => {
    const s = await setup();
    await s.handler(1);
    const deps = { documentClient: s.f.w.db, tableName: "state", now: () => s.f.w.clock.now };
    expect(await settleLiveSteerReapproval(deps, s.f.made.taskId, stop(s.message.messageId))).toBe(1);
    expect(s.messageNow()["delivery"]).toMatchObject({ state: "delivered", reason: LIVE_STEER_REAPPROVAL_REASON });
    const events = s.f.w.db.find((item) => item.pk === agentSessionKey(ORG_A, s.f.made.sessionId, "META").pk && String(item.sk).startsWith("EVENT#") && item["messageId"] === s.message.messageId);
    const told = events.find((item) => String(item["text"]).includes("needs the owner's approval"));
    expect(told).toMatchObject({ type: "status", actor: { kind: "agent" } });
    expect(JSON.stringify(events)).not.toContain("LIVE-TEXT-4471");
    expect(await settleLiveSteerReapproval(deps, s.f.made.taskId, stop(s.message.messageId))).toBe(0);
    expect(events.filter((item) => String(item["text"]).includes("needs the owner's approval"))).toHaveLength(1);
  });

  it("leaves a message that is still queued, another error, and an unknown task alone", async () => {
    const s = await setup({ answer: { accepted: true, outcome: "not_running" } });
    await s.handler(1);
    const deps = { documentClient: s.f.w.db, tableName: "state", now: () => s.f.w.clock.now };
    expect(await settleLiveSteerReapproval(deps, s.f.made.taskId, stop(s.message.messageId))).toBe(0);
    expect(s.messageNow()["delivery"]).toMatchObject({ state: "queued" });
    expect(await settleLiveSteerReapproval(deps, s.f.made.taskId, "the model stopped")).toBe(0);
    expect(await settleLiveSteerReapproval(deps, "00000000-0000-4000-8000-000000000000", stop(s.message.messageId))).toBe(0);
  });
});
