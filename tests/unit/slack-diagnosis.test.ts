// Live interaction F2: the chat service answers a light diagnosis with the read-only turn and writes the answer back to the broker. No Slack thread, member or channel is involved, nothing is posted in
// Slack, the context text is never logged, and an older service discards the message.
import { describe, expect, it, vi } from "vitest";
import {
  DIAGNOSIS_TURN_QUESTION, DiagnosisQueueMessageSchema, SlackRequestMessageSchema, diagnosisRouteAttributes, isDiagnosisRoute,
  type DiagnosisAnsweredRequest, type DiagnosisQueueMessage, type DiagnosisTurnResult,
} from "../../packages/contracts/src/index.js";
import { NO_TEXT_RESPONSE } from "../../packages/orchestrator/src/orchestrator.js";
import { processGroup, type QueueClient } from "../../packages/slack-service/src/consumer.js";
import { handleDiagnosis, type DiagnosisServiceApi } from "../../packages/slack-service/src/diagnosis-question.js";
import { createDiagnosisApi } from "../../packages/slack-service/src/thread-api.js";

const message: DiagnosisQueueMessage = {
  version: 1, eventId: "Ev0123456789abcdef0123456789abcdef", diagnosis: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", diagnosisId: "dgn_aaaaaaaaaaaaaaaaaaaa" }, receivedAt: "2026-11-01T12:00:00.000Z",
};
const ref = message.diagnosis;
const turn: DiagnosisTurnResult = { workspaceId: "11111111-1111-4111-8111-111111111111", orchestratorInstructions: "Be brief.", taskContext: "RULES\nZEBRA-CONTEXT-TEXT-88 the error data." };

function setup(options: { turnResult?: unknown; answer?: () => Promise<string>; answeredFails?: number } = {}) {
  const written: DiagnosisAnsweredRequest[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let failures = options.answeredFails ?? 0;
  const api: DiagnosisServiceApi = {
    turn: async () => (options.turnResult ?? turn) as DiagnosisTurnResult,
    answered: async (request) => { if (failures > 0) { failures -= 1; throw new Error("broker down"); } written.push(request); },
  };
  const runTurn = vi.fn(async (input: { ref: unknown; question: string; eventId: string; turn: DiagnosisTurnResult }) => { void input; return options.answer === undefined ? '{"summary":"The test failed."}' : options.answer(); });
  return { api, runTurn, written, logs, deps: { api, runTurn, log: (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); } } };
}

describe("answering a queued diagnosis", () => {
  it("asks the broker for the context by the diagnosis's id, runs the turn on a fixed question, and writes the answer back", async () => {
    const t = setup();
    await handleDiagnosis(message, t.deps);
    expect(t.runTurn).toHaveBeenCalledWith({ ref, question: DIAGNOSIS_TURN_QUESTION, eventId: message.eventId, turn });
    expect(t.written).toEqual([{ ...ref, outcome: "ANSWERED", text: '{"summary":"The test failed."}', contextBytes: Buffer.byteLength(turn.taskContext, "utf8") }]);
    expect(JSON.stringify(t.logs)).not.toContain("ZEBRA-CONTEXT-TEXT-88");
    expect(JSON.stringify(t.logs)).not.toContain("The test failed");
  });

  it("writes FAILED, with no text, when the broker refuses the context, the model gives nothing or throws, or the context is not what it should be", async () => {
    for (const options of [
      { turnResult: { workspaceId: "nope" } },
      { answer: async () => "   " },
      { answer: async () => NO_TEXT_RESPONSE },
      { answer: async (): Promise<string> => { throw new Error("model down ZEBRA-CONTEXT-TEXT-88"); } },
    ]) {
      const t = setup(options);
      await handleDiagnosis(message, t.deps);
      expect(t.written, JSON.stringify(options)).toEqual([{ ...ref, outcome: "FAILED" }]);
      expect(JSON.stringify(t.logs)).not.toContain("ZEBRA-CONTEXT-TEXT-88");
    }
    const refused = setup();
    refused.api.turn = async () => { throw new Error("FORBIDDEN"); };
    await handleDiagnosis(message, refused.deps);
    expect(refused.written).toEqual([{ ...ref, outcome: "FAILED" }]);
    expect(refused.runTurn).not.toHaveBeenCalled();
  });

  it("when the broker does not take the answer, says once that there is none; and never throws", async () => {
    const t = setup({ answeredFails: 1 });
    await expect(handleDiagnosis(message, t.deps as never)).resolves.toBeUndefined();
    expect(t.written).toEqual([{ ...ref, outcome: "FAILED" }]);
    const down = setup({ answeredFails: 5 });
    await expect(handleDiagnosis(message, down.deps as never)).resolves.toBeUndefined();
    expect(down.written).toEqual([]);
  });

  it("cuts a long answer to what the broker takes, never through a character pair", async () => {
    const t = setup({ answer: async () => `${"a".repeat(11_999)}😀tail` });
    await handleDiagnosis(message, t.deps);
    const text = t.written[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text.endsWith("\ud83d")).toBe(false);
  });
});

describe("QA6-14: a model the provider refuses", () => {
  const refused = () => Object.assign(new Error("Model source request failed; check the API key and its permissions"), { name: "AgentXError" });

  it("tries once more, on a fresh turn flagged as the retry, and answers when the second model works", async () => {
    let calls = 0;
    const t = setup({ answer: async () => { calls += 1; if (calls === 1) throw refused(); return '{"summary":"ok"}'; } });
    await handleDiagnosis(message, t.deps);
    expect(t.runTurn).toHaveBeenCalledTimes(2);
    const [first, second] = t.runTurn.mock.calls.map((call) => call[0] as { eventId: string; retry?: true });
    expect(first).toEqual({ ref, question: DIAGNOSIS_TURN_QUESTION, eventId: message.eventId, turn });
    expect(second?.retry).toBe(true);
    expect(second?.eventId).not.toBe(message.eventId);
    expect(second?.eventId).toMatch(/^Ev[A-Za-z0-9]{4,64}$/u);
    expect(t.written).toEqual([{ ...ref, outcome: "ANSWERED", text: '{"summary":"ok"}', contextBytes: Buffer.byteLength(turn.taskContext, "utf8") }]);
  });

  it("when the second model is refused too, stops there and writes FAILED with the reason (never the error text)", async () => {
    const t = setup({ answer: async () => { throw refused(); } });
    await handleDiagnosis(message, t.deps);
    expect(t.runTurn).toHaveBeenCalledTimes(2);
    expect(t.written).toEqual([{ ...ref, outcome: "FAILED", reason: "model_rejected" }]);
    expect(JSON.stringify(t.logs)).not.toContain("API key");
  });

  it("a 404 from the provider is the same refusal; a limit or an outage is told apart and not retried; anything else has no reason", async () => {
    const cases: Array<[string, string | undefined, number]> = [
      ["Model source request failed; check the model ID and that the key's organization can use it", "model_rejected", 2],
      ["Model source request failed; the API key was refused; check that it is valid and has not expired", "key_invalid", 1],
      ["Model source request failed; check the key's credit balance and spending limit", "limit_reached", 1],
      ["Model source request failed; rate limited; wait before retrying", "limit_reached", 1],
      ["Model source request failed; upstream unavailable; check provider status before retrying", "provider_unavailable", 1],
      ["Model source request failed; the provider is overloaded; wait before retrying", "provider_unavailable", 1],
      ["something else entirely", undefined, 1],
    ];
    for (const [text, reason, runs] of cases) {
      const t = setup({ answer: async (): Promise<string> => { throw new Error(text); } });
      await handleDiagnosis(message, t.deps);
      expect(t.runTurn, text).toHaveBeenCalledTimes(runs);
      expect(t.written, text).toEqual([{ ...ref, outcome: "FAILED", ...(reason === undefined ? {} : { reason }) }]);
    }
  });
});

describe("the queue: the diagnosis route, and an older service", () => {
  it("is its own route; an older service's chat schema refuses the body, and the body carries ids only", () => {
    expect(DiagnosisQueueMessageSchema.safeParse(message).success).toBe(true);
    expect(SlackRequestMessageSchema.safeParse(message).success).toBe(false);
    expect(isDiagnosisRoute(diagnosisRouteAttributes())).toBe(true);
    expect(isDiagnosisRoute({ agentxRoute: { StringValue: "ask" } })).toBe(false);
    expect(DiagnosisQueueMessageSchema.safeParse({ ...message, text: "anything" }).success).toBe(false);
    expect(DiagnosisQueueMessageSchema.safeParse({ ...message, diagnosis: { ...message.diagnosis, context: "x" } }).success).toBe(false);
  });

  it("is handed to the diagnosis handler and never run as a chat request; without a handler, or with a body that is not one, it is discarded", async () => {
    const deleted = vi.fn(async () => undefined);
    const queue: QueueClient = { receive: async () => [], delete: deleted, extendVisibility: async () => undefined };
    const chat = vi.fn(async () => undefined);
    const handled: DiagnosisQueueMessage[] = [];
    const logs: string[] = [];
    const options = { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 };
    const log = (event: string) => { logs.push(event); };
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r1", groupId: "g", receiveCount: 1, diagnosis: true }], { ...options, diagnosis: async (received) => { handled.push(received); } }, log);
    expect(handled).toEqual([message]);
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r2", groupId: "g", receiveCount: 1, diagnosis: true }], options, log);
    await processGroup(queue, chat, [{ body: JSON.stringify({ ...message, diagnosis: undefined }), receiptHandle: "r3", groupId: "g", receiveCount: 1, diagnosis: true }], { ...options, diagnosis: async (received) => { handled.push(received); } }, log);
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r4", groupId: "g", receiveCount: 1 }], options, log);
    expect(chat).not.toHaveBeenCalled();
    expect(handled).toHaveLength(1);
    expect(logs.filter((event) => event === "message.discarded")).toHaveLength(3);
    expect(deleted).toHaveBeenCalledTimes(4);
  });
});

describe("the service's calls to the broker", () => {
  it("posts the diagnosis to /diagnoses/turn and /diagnoses/answered with no Slack headers, and validates both sides", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const signedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(url.endsWith("/turn") ? turn : { outcome: "ANSWERED" }), { status: 200 });
    }) as typeof fetch;
    const api = createDiagnosisApi({ controlPlaneUrl: "https://cp.example.invalid", signedFetch });
    expect(await api.turn(ref)).toEqual(turn);
    await api.answered({ ...ref, outcome: "FAILED" });
    expect(calls.map((call) => call.url)).toEqual(["https://cp.example.invalid/v1/diagnoses/turn", "https://cp.example.invalid/v1/diagnoses/answered"]);
    expect(calls[0]!.body).toEqual(ref);
    await expect(api.answered({ ...ref, outcome: "FAILED", payer: "rovara" } as never)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});
