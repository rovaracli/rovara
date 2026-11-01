// Live interaction A3: the chat service answers an Ask about a task (the web's or Linear's) with the read-only turn, and writes the answer back to the broker. No Slack thread, member or channel is
// involved, nothing is posted in Slack, the question's text is never logged, and an older service discards the message.
import { describe, expect, it, vi } from "vitest";
import {
  AskQueueMessageSchema, SlackRequestMessageSchema, askRouteAttributes, isAskRoute, type AskAnsweredRequest, type AskQueueMessage, type AskTurnResult,
} from "../../packages/contracts/src/index.js";
import { NO_TEXT_RESPONSE } from "../../packages/orchestrator/src/orchestrator.js";
import { processGroup, type QueueClient } from "../../packages/slack-service/src/consumer.js";
import { handleAsk, type AskServiceApi } from "../../packages/slack-service/src/ask-question.js";
import { createAskApi } from "../../packages/slack-service/src/thread-api.js";
import { turnModelAccessSource } from "../../packages/slack-service/src/model-access.js";

const SECRET_QUESTION = "Why was ZEBRA-QUESTION-TEXT-77 changed?";
const message: AskQueueMessage = {
  version: 1, eventId: "Ev0123456789abcdef0123456789abcdef", ask: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", askId: "ask_aaaaaaaaaaaaaaaaaaaa", audience: "web" },
  text: SECRET_QUESTION, receivedAt: "2026-11-01T12:00:00.000Z",
};
const ref = message.ask && { orgId: message.ask.orgId, sessionId: message.ask.sessionId, askId: message.ask.askId };
const turn: AskTurnResult = { workspaceId: "11111111-1111-4111-8111-111111111111", orchestratorInstructions: "Be brief.", taskContext: "RULES\nThe task data." };

function setup(options: { turnResult?: unknown; answer?: () => Promise<string>; answeredFails?: number } = {}) {
  const written: AskAnsweredRequest[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let failures = options.answeredFails ?? 0;
  const api: AskServiceApi = {
    turn: async () => (options.turnResult ?? turn) as AskTurnResult,
    answered: async (request) => { if (failures > 0) { failures -= 1; throw new Error("broker down"); } written.push(request); },
  };
  const runTurn = vi.fn(async (input: { ref: unknown; question: string; eventId: string; turn: AskTurnResult }) => (input.question === "" ? "" : options.answer === undefined ? "The retry was added because the call failed twice." : options.answer()));
  return { api, runTurn, written, logs, deps: { api, runTurn, log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); } } };
}

describe("answering a queued Ask", () => {
  it("asks the broker for the context by the Ask's id, runs the turn on it, and writes the answer, the question and the context size back", async () => {
    const t = setup();
    await handleAsk(message, t.deps);
    expect(t.runTurn).toHaveBeenCalledWith({ ref, question: SECRET_QUESTION, eventId: message.eventId, turn });
    expect(t.written).toEqual([{ ...ref, outcome: "ANSWERED", text: "The retry was added because the call failed twice.", question: SECRET_QUESTION, contextBytes: Buffer.byteLength(turn.taskContext, "utf8") }]);
    expect(JSON.stringify(t.logs)).not.toContain("ZEBRA-QUESTION-TEXT-77");
    expect(JSON.stringify(t.logs)).not.toContain("retry was added");
  });

  it("writes FAILED, with no text, when the broker refuses the context, the model gives nothing or throws, or the context is not what it should be", async () => {
    for (const options of [
      { turnResult: { workspaceId: "nope" } },
      { answer: async () => "   " },
      { answer: async () => NO_TEXT_RESPONSE },
      { answer: async (): Promise<string> => { throw new Error("model down ZEBRA-QUESTION-TEXT-77"); } },
    ]) {
      const t = setup(options);
      await handleAsk(message, t.deps);
      expect(t.written, JSON.stringify(options)).toEqual([{ ...ref, outcome: "FAILED" }]);
      expect(JSON.stringify(t.logs)).not.toContain("ZEBRA-QUESTION-TEXT-77");
    }
    const refused = setup();
    refused.api.turn = async () => { throw new Error("FORBIDDEN"); };
    await handleAsk(message, refused.deps);
    expect(refused.written).toEqual([{ ...ref, outcome: "FAILED" }]);
    expect(refused.runTurn).not.toHaveBeenCalled();
  });

  it("when the broker does not take the answer, says once that there is none; and never throws", async () => {
    const t = setup({ answeredFails: 1 });
    await expect(handleAsk(message, t.deps as never)).resolves.toBeUndefined();
    expect(t.written).toEqual([{ ...ref, outcome: "FAILED" }]);
    const down = setup({ answeredFails: 5 });
    await expect(handleAsk(message, down.deps as never)).resolves.toBeUndefined();
    expect(down.written).toEqual([]);
  });

  it("cuts a long answer to what the broker takes, never through a character pair", async () => {
    const t = setup({ answer: async () => `${"a".repeat(7_999)}😀tail` });
    await handleAsk(message, t.deps);
    const text = t.written[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text.endsWith("\ud83d")).toBe(false);
  });
});

describe("the queue: the Ask route, and an older service", () => {
  it("is its own route; an older service's chat schema refuses the body", () => {
    expect(AskQueueMessageSchema.safeParse(message).success).toBe(true);
    expect(SlackRequestMessageSchema.safeParse(message).success).toBe(false);
    expect(isAskRoute(askRouteAttributes())).toBe(true);
    expect(isAskRoute({ agentxRoute: { StringValue: "page-comment" } })).toBe(false);
    expect(isAskRoute(undefined)).toBe(false);
    expect(AskQueueMessageSchema.safeParse({ ...message, extra: 1 }).success).toBe(false);
    expect(AskQueueMessageSchema.safeParse({ ...message, ask: { ...message.ask, audience: "slack" } }).success).toBe(false);
  });

  it("is handed to the Ask handler and never run as a chat request; without a handler, or with a body that is not one, it is discarded", async () => {
    const deleted = vi.fn(async () => undefined);
    const queue: QueueClient = { receive: async () => [], delete: deleted, extendVisibility: async () => undefined };
    const chat = vi.fn(async () => undefined);
    const handled: AskQueueMessage[] = [];
    const logs: string[] = [];
    const options = { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 };
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r1", groupId: "g", receiveCount: 1, ask: true }], { ...options, ask: async (received) => { handled.push(received); } }, (event) => { logs.push(event); });
    expect(handled).toEqual([message]);
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r2", groupId: "g", receiveCount: 1, ask: true }], options, (event) => { logs.push(event); });
    await processGroup(queue, chat, [{ body: JSON.stringify({ ...message, ask: undefined }), receiptHandle: "r3", groupId: "g", receiveCount: 1, ask: true }], { ...options, ask: async (received) => { handled.push(received); } }, (event) => { logs.push(event); });
    // The same body on no route is refused by the chat schema, as an older service does.
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r4", groupId: "g", receiveCount: 1 }], options, (event) => { logs.push(event); });
    expect(chat).not.toHaveBeenCalled();
    expect(handled).toHaveLength(1);
    expect(logs.filter((event) => event === "message.discarded")).toHaveLength(3);
    expect(deleted).toHaveBeenCalledTimes(4);
  });
});

describe("the service's calls to the broker", () => {
  it("posts the Ask to /asks/turn and /asks/answered with no Slack headers, and validates both sides", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const signedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(url.endsWith("/turn") ? turn : { outcome: "ANSWERED" }), { status: 200 });
    }) as typeof fetch;
    const api = createAskApi({ controlPlaneUrl: "https://cp.example.invalid", signedFetch });
    expect(await api.turn(ref)).toEqual(turn);
    await api.answered({ ...ref, outcome: "FAILED" });
    expect(calls.map((call) => call.url)).toEqual(["https://cp.example.invalid/v1/asks/turn", "https://cp.example.invalid/v1/asks/answered"]);
    expect(calls[0]!.body).toEqual(ref);
    // A request with a field it does not know is never sent.
    await expect(api.answered({ ...ref, outcome: "FAILED", budget: 5 } as never)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it("asks for the turn's model key on the Ask's own route, naming the Ask", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const signedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
      return new Response(JSON.stringify({ baseUrl: "https://proxy.example.invalid", apiKey: "fake-key", expiresAt: Date.now() + 3_600_000 }), { status: 200 });
    }) as typeof fetch;
    const source = turnModelAccessSource({ controlPlaneUrl: "https://cp.example.invalid", signedFetch, turnId: message.eventId, orgId: ref.orgId, route: { path: "/v1/asks/model-access", body: { sessionId: ref.sessionId, askId: ref.askId } } });
    await source();
    expect(calls[0]!.url).toBe("https://cp.example.invalid/v1/asks/model-access");
    expect(calls[0]!.body).toMatchObject({ orgId: ref.orgId, sessionId: ref.sessionId, askId: ref.askId, turnId: message.eventId });
    // A Slack turn keeps its route and body.
    calls.length = 0;
    await turnModelAccessSource({ controlPlaneUrl: "https://cp.example.invalid", signedFetch, turnId: "Ev1" })();
    expect(calls[0]!.url).toBe("https://cp.example.invalid/v1/model-access");
    expect(calls[0]!.body).toEqual({ turnId: "Ev1" });
  });
});
