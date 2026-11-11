// Live interaction A3: Ask about this task, the broker's side. "Can use" is required and read live; the rates, the one-at-a-time lock and the idempotent request are spent only on an admitted Ask;
// the question travels in the queue message and is never kept while the Ask waits; the service's three routes (turn, model access, answered) name the Ask and trust nothing else; an answer is
// stored per edition and audited (Enterprise: every Ask; Public: a daily count), once; the switch is OFF by default.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASK_RATE, ASK_TURN_RULES, AskStatusSchema, askRequestKey, askLockKey, sessionAskKey, sessionRateKey, askCountKey, type OrgId } from "@rovara-code/contracts";
import {
  ASK_BUSY_TEXT, ASK_RATE_TEXT, RATE_RACE_ATTEMPTS, askIdFor, takeSlackAskRates, askStatusFor, completeAsk, prepareAskTurn, submitAsk, type AskDependencies,
} from "../../packages/broker/src/agent-sessions/ask.js";
import { flushDailyAskCounts } from "../../packages/broker/src/agent-sessions/ask-audit.js";
import { ARJUN, MIA, ORG_A, PRIYA, sessionWorld } from "../support/agent-session-world.js";
import { capturingAuditDeps } from "../support/audit-capture.js";

const SECRET_TOKEN = `ghp_${"Zy9Xw8Vu7T".repeat(4)}`;
const QUESTION = "Why did it change the retry logic?";
const ANSWER = "It added a retry because the call failed twice in the logs.";
const KEY = "k".repeat(48);

type Sent = { body: string; groupId: string; deduplicationId: string; attributes: Record<string, { DataType: "String"; StringValue: string }> };

/** A refusal with its code and its fixed words (an Error's message is not an own property, so `toMatchObject` cannot see it). */
async function refused(promise: Promise<unknown>, code: string, message: string): Promise<void> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught as { code?: string; message?: string });
  expect(error?.code).toBe(code);
  expect(error?.message).toBe(`${code}: ${message}`);
}

function setup(options: { edition?: "enterprise" | "public"; enabled?: boolean; queue?: "none" | "fails"; erased?: string[]; aliases?: Array<{ developerId: string; names: string[]; handles?: string[]; tag?: string }> } = {}) {
  const w = sessionWorld();
  const made = w.seedSession({ kind: "task", owner: PRIYA });
  w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: ARJUN }, "use");
  w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: MIA }, "view");
  // A task with a workflow, so there is something to ask about.
  w.db.set({
    ...w.db.get({ pk: `DEVTASK#${made.taskId}`, sk: "META" })!,
    title: "Bump the Stripe SDK",
    workflow: { revision: 1, stage: "IMPLEMENT", state: "RUNNING", artifacts: [], decisions: [], pullRequests: [], checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } },
  });
  const sent: Sent[] = [];
  const erased = new Set(options.erased ?? []);
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.now });
  const readers = { diff: vi.fn(async () => undefined) };
  const access = { documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members };
  const deps: AskDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, edition: options.edition ?? "enterprise", enabled: options.enabled ?? true,
    queue: options.queue === "none" ? undefined : { send: async (message) => { if (options.queue === "fails") throw new Error("queue down"); sent.push(message); } },
    access, actions: { readArtifact: async () => { throw new Error("no document"); } } as never, readers,
    store: () => ({ documentClient: w.db, tableName: "state", questionHashKey: KEY, isErased: async (id: string) => erased.has(id), erasedPeople: async () => options.aliases ?? [] }),
    audit: { ...audit.deps, documentClient: w.db, tableName: "state" },
    people: async () => [{ developerId: PRIYA, names: ["Priya Raman"], handles: ["priya@example.com"] }, { developerId: ARJUN, names: ["Arjun Rao"] }],
    orchestratorInstructions: async () => "Be brief.",
    defaultModel: "chat-runtime",
  };
  const ask = (who: string, question = QUESTION, requestId: string = randomUUID(), sessionId = made.sessionId) => submitAsk(deps, w.caller(who), sessionId, { requestId, question });
  const table = () => (w.db.find(() => true) as Array<Record<string, unknown>>).map((item) => JSON.stringify(item)).sort();
  return { w, made, deps, sent, ask, erased, audit, readers, table };
}

describe("the switch and who may ask", () => {
  it("is OFF: every route answers NOT_FOUND and nothing is written or queued", async () => {
    const t = setup({ enabled: false });
    const before = t.table();
    await expect(t.ask(PRIYA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(askStatusFor(t.deps, t.w.caller(PRIYA), t.made.sessionId, "ask_aaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepareAskTurn(t.deps, { orgId: ORG_A, sessionId: t.made.sessionId, askId: "ask_aaaaaaaaaaaaaaaaaaaa" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(completeAsk(t.deps, { orgId: ORG_A, sessionId: t.made.sessionId, askId: "ask_aaaaaaaaaaaaaaaaaaaa", outcome: "FAILED" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(t.sent).toEqual([]);
    expect(t.table()).toEqual(before);
  });

  it("needs 'can use': the owner and a 'use' share ask; a 'view' share, a stranger and an unknown session are refused and write nothing", async () => {
    const t = setup();
    expect((await t.ask(PRIYA)).state).toBe("queued");
    expect((await t.ask(ARJUN)).state).toBe("queued");
    const before = t.table();
    const sentBefore = t.sent.length;
    await expect(t.ask(MIA)).rejects.toMatchObject({ code: "SESSION_LEVEL_REQUIRED" });
    await expect(t.ask(PRIYA, QUESTION, randomUUID(), "ses_zzzzzzzzzzzzzzzzzzzz")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const stranger = t.w.caller("9".repeat(64));
    await expect(submitAsk(t.deps, stranger, t.made.sessionId, { requestId: randomUUID(), question: QUESTION })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(t.table()).toEqual(before);
    expect(t.sent).toHaveLength(sentBefore);
  });

  it("reads the level live: a share that ended after the first Ask refuses the next one", async () => {
    const t = setup();
    await t.ask(ARJUN);
    t.w.db.delete({ ...t.w.db.find((item) => String(item.sk).startsWith("SHARE#MEMBER#" + ARJUN))[0]! } as never);
    await expect(t.ask(ARJUN)).rejects.toSatisfy((error: { code?: string }) => ["SESSION_LEVEL_REQUIRED", "NOT_FOUND"].includes(String(error.code)));
  });

  it("refuses a strict body: an extra field, an empty or too long question, a bad request id", async () => {
    const t = setup();
    const before = t.table();
    for (const body of [{ requestId: randomUUID(), question: QUESTION, tools: ["bash"] }, { requestId: randomUUID(), question: "" }, { requestId: randomUUID(), question: "x".repeat(1001) }, { requestId: "nope", question: QUESTION }, { question: QUESTION }]) {
      await expect(submitAsk(t.deps, t.w.caller(PRIYA), t.made.sessionId, body)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(t.table()).toEqual(before);
  });

  it("refuses an asker who was erased, a closed task, a chain session, and an install with no chat queue", async () => {
    const erased = setup({ erased: [PRIYA] });
    await expect(erased.ask(PRIYA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(erased.sent).toEqual([]);
    const closed = setup();
    closed.w.db.set({ ...closed.w.db.get({ pk: `DEVTASK#${closed.made.taskId}`, sk: "META" })!, closedAt: "2026-10-30T00:00:00.000Z" });
    await expect(closed.ask(PRIYA)).rejects.toMatchObject({ code: "SESSION_ENDED" });
    const chain = setup();
    const crn = chain.w.seedSession({ kind: "chain", owner: PRIYA });
    await expect(chain.ask(PRIYA, QUESTION, randomUUID(), crn.sessionId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(setup({ queue: "none" }).ask(PRIYA)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("queueing, the question, the rates and the lock", () => {
  it("queues the question under the Ask route and keeps it out of the table while the Ask waits", async () => {
    const t = setup();
    const status = await t.ask(PRIYA, `${QUESTION} token ${SECRET_TOKEN}`);
    expect(AskStatusSchema.parse(status)).toEqual({ askId: status.askId, state: "queued" });
    expect(t.sent).toHaveLength(1);
    const message = JSON.parse(t.sent[0]!.body) as { ask: { askId: string; audience: string; orgId: string; sessionId: string }; text: string };
    expect(message.ask).toEqual({ orgId: ORG_A, sessionId: t.made.sessionId, askId: status.askId, audience: "web" });
    expect(t.sent[0]!.attributes).toEqual({ agentxRoute: { DataType: "String", StringValue: "ask" } });
    const request = t.w.db.get(askRequestKey(ORG_A, t.made.sessionId, status.askId)) as Record<string, unknown>;
    expect(request).toMatchObject({ state: "queued", audience: "web", askedBy: PRIYA, taskId: t.made.taskId });
    expect(JSON.stringify(t.table())).not.toContain("retry logic");
    expect(JSON.stringify(t.table())).not.toContain(SECRET_TOKEN);
  });

  it("a repeat of the same request is the same Ask: nothing is queued twice and no second place is spent", async () => {
    const t = setup();
    const requestId = randomUUID();
    const first = await t.ask(PRIYA, QUESTION, requestId);
    const rate = () => t.w.db.get(sessionRateKey(ORG_A, t.made.sessionId, PRIYA, "ask"))!["count"];
    expect(rate()).toBe(1);
    expect(await t.ask(PRIYA, QUESTION, requestId)).toEqual(first);
    expect(t.sent).toHaveLength(1);
    expect(rate()).toBe(1);
    // The same request id from another person is another Ask (the person is part of its id).
    expect(askIdFor(ORG_A, ARJUN, requestId)).not.toBe(askIdFor(ORG_A, PRIYA, requestId));
  });

  it("one at a time per person per task: a second question while the first waits is refused; another person is not held; the lock lets go when the Ask ends and when it expires", async () => {
    const t = setup();
    const first = await t.ask(PRIYA);
    await refused(t.ask(PRIYA), "TASK_BUSY", ASK_BUSY_TEXT);
    expect((await t.ask(ARJUN)).state).toBe("queued");
    await completeAsk(t.deps, { orgId: ORG_A, sessionId: t.made.sessionId, askId: first.askId, outcome: "ANSWERED", text: ANSWER, question: QUESTION });
    expect((await t.ask(PRIYA)).state).toBe("queued");
    // A lock whose Ask never answered lapses on its own.
    const t2 = setup();
    await t2.ask(PRIYA);
    t2.w.clock.now += 16 * 60_000;
    expect((await t2.ask(PRIYA)).state).toBe("queued");
  });

  it("the person's rate: the 21st Ask in an hour is refused and queues nothing; the next hour starts again", async () => {
    const t = setup();
    for (let index = 0; index < ASK_RATE.perPersonPerHour; index += 1) {
      const asked = await t.ask(PRIYA);
      await completeAsk(t.deps, { orgId: ORG_A, sessionId: t.made.sessionId, askId: asked.askId, outcome: "FAILED" });
    }
    const sentBefore = t.sent.length;
    await refused(t.ask(PRIYA), "TOO_MANY_REQUESTS", ASK_RATE_TEXT);
    expect(t.sent).toHaveLength(sentBefore);
    t.w.clock.now += 3_600_000;
    expect((await t.ask(PRIYA)).state).toBe("queued");
  });

  it("the task's rate: the 101st Ask of the day on one task is refused, whoever asks", async () => {
    const t = setup();
    t.w.db.set({ ...sessionRateKey(ORG_A, t.made.sessionId, "task", "ask_day"), entityType: "SESSION_RATE", windowStart: Math.floor(t.w.clock.now / 86_400_000) * 86_400_000, count: ASK_RATE.perTaskPerDay });
    await expect(t.ask(PRIYA)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(t.sent).toEqual([]);
  });

  it("two people asking at the same moment are both admitted: a lost race on the shared counters is retried, not blamed on the asker (S1)", async () => {
    const t = setup();
    const direct = t.deps.documentClient;
    let interleave: (() => Promise<unknown>) | undefined = () => submitAsk({ ...t.deps, documentClient: direct }, t.w.caller(PRIYA), t.made.sessionId, { requestId: randomUUID(), question: "first" });
    t.deps.documentClient = { send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand && interleave !== undefined) { const run = interleave; interleave = undefined; await run(); }
      return direct.send(command);
    } };
    expect((await t.ask(ARJUN)).state).toBe("queued");
    expect(t.sent).toHaveLength(2);
    expect(t.w.db.get(sessionRateKey(ORG_A, t.made.sessionId as never, "task", "ask_day"))!["count"]).toBe(2);
    expect(t.w.db.get(sessionRateKey(ORG_A, t.made.sessionId as never, ARJUN, "ask"))!["count"]).toBe(1);
  });

  it("the same person asking twice at the same moment is told about the question that is waiting (TASK_BUSY), not blamed on a race", async () => {
    const t = setup();
    const direct = t.deps.documentClient;
    let interleave: (() => Promise<unknown>) | undefined = () => submitAsk({ ...t.deps, documentClient: direct }, t.w.caller(ARJUN), t.made.sessionId, { requestId: randomUUID(), question: "first" });
    t.deps.documentClient = { send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand && interleave !== undefined) { const run = interleave; interleave = undefined; await run(); }
      return direct.send(command);
    } };
    await refused(t.ask(ARJUN), "TASK_BUSY", ASK_BUSY_TEXT);
    expect(t.sent).toHaveLength(1);
  });

  it("a counter that keeps changing is tried a bounded number of times, then the asker is told to try again (not that they have a question waiting) and holds no lock", async () => {
    const t = setup();
    const direct = t.deps.documentClient;
    let races = 0;
    t.deps.documentClient = { send: async (command: unknown) => {
      if (command instanceof TransactWriteCommand) {
        races += 1;
        // Somebody else's Ask lands before every attempt.
        await takeSlackAskRates({ ...t.deps, documentClient: direct }, t.w.db.get({ pk: `DEVTASK#${t.made.taskId}`, sk: "META" }) as never, PRIYA);
      }
      return direct.send(command);
    } };
    await refused(t.ask(ARJUN), "RUNTIME_UNAVAILABLE", "Couldn't answer that just now.");
    expect(races).toBeGreaterThanOrEqual(RATE_RACE_ATTEMPTS);
    expect(t.w.db.get(askLockKey(ORG_A, t.made.sessionId as never, ARJUN))).toBeUndefined();
  });

  it("a queue that refuses ends the Ask in fixed words, lets the lock go, and queues nothing", async () => {
    const t = setup({ queue: "fails" });
    await refused(t.ask(PRIYA), "RUNTIME_UNAVAILABLE", "Couldn't answer that just now.");
    const lock = t.w.db.get(askLockKey(ORG_A, t.made.sessionId, PRIYA));
    expect(lock?.["expiresAt"]).toBe(0);
    const request = t.w.db.find((item) => String(item.sk).startsWith("ASKREQ#"))[0]!;
    expect(request["state"]).toBe("failed");
  });
});

describe("the service routes", () => {
  async function queued(t: ReturnType<typeof setup>, who = PRIYA) {
    const status = await t.ask(who);
    return { ref: { orgId: ORG_A, sessionId: t.made.sessionId, askId: status.askId }, askId: status.askId };
  }

  it("turn: the rules first, then the web context built for the asker; the asker's level is read now", async () => {
    const t = setup();
    const { ref } = await queued(t);
    const turn = await prepareAskTurn(t.deps, ref);
    expect(turn.taskContext.startsWith(ASK_TURN_RULES)).toBe(true);
    expect(turn.taskContext).toContain("Bump the Stripe SDK");
    expect(turn.workspaceId).toBe(t.w.db.get({ pk: `DEVTASK#${t.made.taskId}`, sk: "META" })!["workspaceId"]);
    expect(turn.orchestratorInstructions).toBe("Be brief.");
    expect(t.readers.diff).toHaveBeenCalled();
  });

  it("turn: an asker who lost 'can use' since asking gets no context (the Ask fails), and so does an erased one", async () => {
    const t = setup();
    const { ref } = await queued(t, ARJUN);
    t.w.db.delete({ ...t.w.db.find((item) => String(item.sk) === `SHARE#MEMBER#${ARJUN}`)[0]! } as never);
    await expect(prepareAskTurn(t.deps, ref)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const erased = setup();
    const e = await queued(erased);
    erased.erased.add(PRIYA);
    await expect(prepareAskTurn(erased.deps, e.ref)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("names only an Ask the broker queued: an unknown id, another org's, another session's and an already answered one are NOT_FOUND", async () => {
    const t = setup();
    const { ref, askId } = await queued(t);
    await expect(prepareAskTurn(t.deps, { ...ref, askId: "ask_zzzzzzzzzzzzzzzzzzzz" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepareAskTurn(t.deps, { ...ref, orgId: "org_bbbbbbbbbbbbbbbbbbbb" as OrgId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepareAskTurn(t.deps, { ...ref, sessionId: "ses_zzzzzzzzzzzzzzzzzzzz" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prepareAskTurn(t.deps, { ...ref, extra: 1 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: ANSWER, question: QUESTION });
    await expect(prepareAskTurn(t.deps, ref)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(askId).toBe(ref.askId);
  });

  it("answered (Enterprise): stores the words scrubbed of secrets and of the session's people, readable by the asker alone, and audits the Ask once with no text", async () => {
    const t = setup({ edition: "enterprise" });
    const { ref, askId } = await queued(t);
    const answer = `Priya Raman asked this. ${ANSWER} Key ${SECRET_TOKEN}. Ask arjun@example.com`;
    expect(await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: answer, question: `${QUESTION} (from Priya Raman)`, contextBytes: 1234, model: "claude-test" })).toEqual({ outcome: "ANSWERED" });
    const record = t.w.db.get(sessionAskKey(ORG_A, t.made.sessionId, askId)) as Record<string, unknown>;
    expect(record).toMatchObject({ audience: "web", askedBy: PRIYA, contextBytes: 1234, model: "claude-test" });
    expect(String(record["answer"])).not.toContain(SECRET_TOKEN);
    expect(String(record["answer"])).not.toContain("Priya Raman");
    expect(String(record["question"])).not.toContain("Priya Raman");
    expect(String(record["answer"])).not.toContain("arjun@example.com");
    // The asker reads it; nobody else does (not the owner of another Ask, not a teammate with 'use').
    expect(await askStatusFor(t.deps, t.w.caller(PRIYA), t.made.sessionId, askId)).toMatchObject({ state: "answered" });
    await expect(askStatusFor(t.deps, t.w.caller(ARJUN), t.made.sessionId, askId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // One audit event per Ask, ids and sizes only.
    const events = t.audit.recordedBy("task.asked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: { kind: "session", id: t.made.sessionId }, facts: { audience: "web", scope: "each", contextBytes: 1234, model: "claude-test" } });
    expect(JSON.stringify(events)).not.toContain("retry");
    // A redelivery of the answer writes and audits nothing new.
    const items = t.table();
    expect(await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: "A DIFFERENT ANSWER", question: QUESTION })).toEqual({ outcome: "ANSWERED" });
    expect(t.table()).toEqual(items);
    expect(t.audit.recordedBy("task.asked")).toHaveLength(1);
  });

  it("answered (Public): the web answer is stored; the Ask is counted by project and day, and one event per day comes from the count", async () => {
    const t = setup({ edition: "public" });
    const { ref, askId } = await queued(t);
    await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: ANSWER, question: QUESTION });
    expect(t.w.db.get(sessionAskKey(ORG_A, t.made.sessionId as never, askId))).toMatchObject({ audience: "web" });
    expect(t.audit.recordedBy("task.asked")).toEqual([]);
    const day = new Date(t.w.clock.now).toISOString().slice(0, 10);
    expect(t.w.db.get(askCountKey(ORG_A, day, "web"))).toMatchObject({ count: 1, projectName: "web" });
    // A redelivery of the answer counts nothing more, and neither do two deliveries at the same moment (only the call that ends the waiting Ask counts it).
    await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: ANSWER, question: QUESTION });
    expect(t.w.db.get(askCountKey(ORG_A, day, "web"))).toMatchObject({ count: 1 });
    const racing = setup({ edition: "public" });
    const raced = await queued(racing);
    await Promise.all([1, 2, 3].map(() => completeAsk(racing.deps, { ...raced.ref, outcome: "ANSWERED", text: ANSWER, question: QUESTION })));
    expect(racing.w.db.get(askCountKey(ORG_A, day, "web"))).toMatchObject({ count: 1 });
    // The day is not over: no event yet. The next day: one event, a count, no text.
    expect(await flushDailyAskCounts({ ...t.deps.audit }, "public", ORG_A, t.w.clock.now)).toBe(0);
    expect(await flushDailyAskCounts({ ...t.deps.audit }, "public", ORG_A, t.w.clock.now + 86_400_000)).toBe(1);
    expect(await flushDailyAskCounts({ ...t.deps.audit }, "public", ORG_A, t.w.clock.now + 86_400_000)).toBe(1);
    const events = t.audit.recordedBy("task.asked");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ target: { kind: "project" }, facts: { scope: "daily", count: 1 } });
    expect(await flushDailyAskCounts({ ...t.deps.audit }, "enterprise", ORG_A, t.w.clock.now + 86_400_000)).toBe(0);
  });

  it("answered (FAILED): ends the Ask, lets the lock go, and stores and audits nothing; a late 'answered' for it finds it ended", async () => {
    const t = setup();
    const { ref, askId } = await queued(t);
    expect(await completeAsk(t.deps, { ...ref, outcome: "FAILED" })).toEqual({ outcome: "FAILED" });
    expect(t.w.db.get(sessionAskKey(ORG_A, t.made.sessionId as never, askId))).toBeUndefined();
    expect(t.audit.recordedBy("task.asked")).toEqual([]);
    expect(await askStatusFor(t.deps, t.w.caller(PRIYA), t.made.sessionId, askId)).toEqual({ askId, state: "failed" });
    expect((await t.ask(PRIYA)).state).toBe("queued");
    expect(await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: ANSWER, question: QUESTION })).toEqual({ outcome: "FAILED" });
  });

  it("answered: an answer needs its text and the question, and a person erased meanwhile gets nothing stored", async () => {
    const t = setup();
    const { ref, askId } = await queued(t);
    await expect(completeAsk(t.deps, { ...ref, outcome: "ANSWERED" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: ANSWER })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    t.erased.add(PRIYA);
    expect(await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: ANSWER, question: QUESTION })).toEqual({ outcome: "FAILED" });
    expect(t.w.db.get(sessionAskKey(ORG_A, t.made.sessionId as never, askId))).toBeUndefined();
    expect(JSON.stringify(t.table())).not.toContain("retry");
  });

  it("answered: an erased person's kept aliases are scrubbed from the words (the alias list is read on the server, not given by the caller)", async () => {
    const t = setup({ aliases: [{ developerId: "erased:p_ffffff", tag: "p_ffffff", names: ["Dana Whitfield"], handles: ["U0DANA0001"] }] });
    const { ref, askId } = await queued(t);
    await completeAsk(t.deps, { ...ref, outcome: "ANSWERED", text: "Dana Whitfield (U0DANA0001) reviewed it, said person p_ffffff.", question: QUESTION });
    const record = t.w.db.get(sessionAskKey(ORG_A, t.made.sessionId, askId)) as Record<string, unknown>;
    expect(String(record["answer"])).toContain("@former-member");
    for (const gone of ["Dana Whitfield", "U0DANA0001", "p_ffffff"]) expect(String(record["answer"]), gone).not.toContain(gone);
  });
});

beforeEach(() => { vi.restoreAllMocks(); });
