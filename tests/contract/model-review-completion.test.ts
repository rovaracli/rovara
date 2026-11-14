// S3-9: the `reviewCompletion` operation of the ModelAccessFunction, the lighter flow's reviewer call on a core task. As with `learningCompletion`, the BROKER mints the key for the task's payer and reserves
// its cap; the function makes ONE tool-less call with that key on the company's route and answers the text. The prompt is the whole user message (Code's reviewer adds no system text). It is not a
// learning call: the lessons switch does not gate it, but the function's long timeout does, and it goes through the single-attempt client.
import type { AgentXError } from "@rovara-code/contracts";
import { describe, expect, it, vi } from "vitest";
import type { InvokeCommandOutput } from "@aws-sdk/client-lambda";
import type { ReviewCompletionInput } from "../../packages/broker/src/model-proxy/access.js";
import { ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
import { createModelAccessHandler } from "../../packages/broker/src/model-proxy/handler.js";
import { LEARNING_INVOKE_TIMEOUT_MS, ModelAccessInvoker, REVIEW_NEEDS_SINGLE_ATTEMPT } from "../../packages/broker/src/model-proxy/invoker.js";
import { ModelAccessRequestSchema, REVIEW_LIMITS } from "../../packages/broker/src/model-proxy/protocol.js";
import { routeFetch } from "../support/developer-fakes.js";

const BASE = "http://proxy.internal:4001";
const NOW = 1_800_000_000_000;
const CATALOG = ["us.anthropic.claude-sonnet-4-6"];
const ALIAS = CATALOG[0]!;
const MASTER = ["master", "planted", "value"].join("-");
const VIRTUAL = ["virtual", "planted", "value"].join("-");
const PROVIDER_WORDS = "PROVIDER-SECRET-ERROR-TEXT";
const PROMPT = "Answer each question about the change with yes or no.";

type Api = "anthropic-messages" | "openai-responses" | "openai-completions";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REPLIES: Record<Api, [string, Record<string, unknown>]> = {
  "anthropic-messages": ["/v1/messages", { content: [{ type: "text", text: "[]" }] }],
  "openai-completions": ["/chat/completions", { choices: [{ message: { content: "[]" } }] }],
  "openai-responses": ["/v1/responses", { output: [{ type: "message", content: [{ type: "output_text", text: "[]" }] }] }],
};

function proxy(options: { api?: Api; inference?: () => Response } = {}) {
  const api = options.api ?? "anthropic-messages";
  const seen: Array<{ path: string; headers: Headers; body: Record<string, unknown> | undefined }> = [];
  const fetch = routeFetch(async (url, init) => {
    seen.push({ path: url.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined });
    if (url.pathname === "/team/info") return json({ team_info: { models: CATALOG } });
    if (url.pathname === REPLIES[api][0]) return options.inference?.() ?? json(REPLIES[api][1]);
    return json({ error: { message: "not found" } }, 404);
  });
  return { client: new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch, now: () => NOW, catalog: CATALOG }), seen };
}
const input = (api: Api = "anthropic-messages"): ReviewCompletionInput => ({ key: VIRTUAL, purpose: "questions", user: PROMPT, maxOutputTokens: 4000, model: ALIAS, api });
const failure = async (action: Promise<unknown>) => { try { await action; } catch (error) { return error as AgentXError; } throw new Error("expected a rejection"); };
const lambdaOver = (run: (event: unknown) => Promise<unknown>, sent: unknown[] = []) => ({ send: async (command: { input: { Payload?: Uint8Array } }) => {
  const event = JSON.parse(Buffer.from(command.input.Payload as Uint8Array).toString("utf8")) as unknown;
  sent.push(event);
  return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(await run(event))), $metadata: {} } as InvokeCommandOutput;
} });

describe("ModelProxyClient.reviewCompletion", () => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    it(`${api}: the prompt is the one user message, no system text and no tools; the broker's key signs it; the text comes back`, async () => {
      const { client, seen } = proxy({ api });
      expect(await client.reviewCompletion(input(api))).toEqual({ text: "[]", model: ALIAS });
      const call = seen.find((entry) => entry.path === REPLIES[api][0])!;
      expect(call.headers.get("authorization")).toBe(`Bearer ${VIRTUAL}`);
      const body = JSON.stringify(call.body);
      expect(body).toContain(PROMPT);
      expect(call.body).not.toHaveProperty("system");
      expect(call.body).not.toHaveProperty("instructions");
      expect(call.body).not.toHaveProperty("tools");
      if (api === "openai-completions") expect(call.body?.["messages"]).toEqual([{ role: "user", content: PROMPT }]);
    });
  }

  it("a provider error or an answer with no text is a fixed failure; the provider's words and the keys appear nowhere", async () => {
    for (const inference of [() => json({ error: { message: PROVIDER_WORDS } }, 500), () => json({ content: [] })]) {
      const { client } = proxy({ inference });
      const error = await failure(client.reviewCompletion(input()));
      expect(error.code).toBe("MODEL_PROXY_UNAVAILABLE");
      for (const secret of [PROVIDER_WORDS, VIRTUAL, MASTER]) expect(error.message).not.toContain(secret);
    }
  });
});

describe("the operation across the function boundary", () => {
  it("invoker -> handler -> client, on the single-attempt client with the long wait; the lessons switch being off does not stop it", async () => {
    const { client } = proxy();
    const run = createModelAccessHandler({ access: client, log: () => undefined, learning: true });
    const ordinary: unknown[] = [];
    const once: unknown[] = [];
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return real(ms); });
    const invoker = new ModelAccessInvoker({ functionName: "f", lambda: lambdaOver(run, ordinary) as never, learningLambda: lambdaOver(run, once) as never, lessonsSwitchOn: () => false });
    expect(await invoker.reviewCompletion(input())).toEqual({ text: "[]", model: ALIAS });
    expect(once).toHaveLength(1);
    expect(ordinary).toHaveLength(0);
    expect(timeouts[0]).toBe(LEARNING_INVOKE_TIMEOUT_MS);
    vi.restoreAllMocks();
  });

  it("an invoker without the single-attempt client refuses with fixed words and sends nothing", async () => {
    const sent: unknown[] = [];
    const invoker = new ModelAccessInvoker({ functionName: "f", lambda: lambdaOver(async () => ({ ok: true, result: { text: "[]", model: ALIAS } }), sent) as never });
    const error = await failure(invoker.reviewCompletion(input()));
    expect(error.message).toContain(REVIEW_NEEDS_SINGLE_ATTEMPT);
    expect(sent).toEqual([]);
  });

  it("a function without the long timeout (or a client with no operation) refuses, and makes no call", async () => {
    const called = vi.fn();
    const withOp = { reviewCompletion: async () => { called(); return { text: "[]", model: ALIAS }; } };
    expect(await createModelAccessHandler({ access: withOp as never, log: () => undefined })({ op: "reviewCompletion", args: input() })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await createModelAccessHandler({ access: {} as never, log: () => undefined, learning: true })({ op: "reviewCompletion", args: input() })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(called).not.toHaveBeenCalled();
    expect(await createModelAccessHandler({ access: withOp as never, log: () => undefined, learning: true })({ op: "reviewCompletion", args: input() })).toMatchObject({ ok: true });
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("the protocol: no system text, tools, member, budget or org field; a known purpose; the prompt and the answer within the reviewer's bounds", () => {
    const args = { ...input() } as Record<string, unknown>;
    delete args["signal"];
    const ok = (extra: Record<string, unknown>) => ModelAccessRequestSchema.safeParse({ op: "reviewCompletion", args: { ...args, ...extra } }).success;
    expect(ok({})).toBe(true);
    for (const extra of [{ system: "x" }, { tools: [] }, { developerId: "a".repeat(64) }, { maxBudgetUsd: 1 }, { orgId: "org_abcdefghij0123456789" }, { purpose: "reflect" }, { user: "" }, { key: "" }, { api: "gemini" }]) expect(ok(extra)).toBe(false);
    expect(ok({ user: "x".repeat(REVIEW_LIMITS.userChars) })).toBe(true);
    expect(ok({ user: "x".repeat(REVIEW_LIMITS.userChars + 1) })).toBe(false);
    expect(ok({ maxOutputTokens: REVIEW_LIMITS.outputTokens + 1 })).toBe(false);
  });
});
