// Lessons in production, lane 1 (fix round 1): the `learningCompletion` operation of the ModelAccessFunction. The BROKER mints the key and reserves its cap in the spend ledger; the function makes ONE tool-less model
// call with that key on the company's own route and answers the text. It does not mint, read spend or delete anything, so it cannot read a spend figure before the proxy has flushed it. No error carries the provider's words.
import type { AgentXError } from "@agentx/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeCommandOutput } from "@aws-sdk/client-lambda";
import { LEARNING_CALL_TIMEOUT_MS, ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
import { createModelAccessHandler } from "../../packages/broker/src/model-proxy/handler.js";
import { LEARNING_INVOKE_TIMEOUT_MS, ModelAccessInvoker } from "../../packages/broker/src/model-proxy/invoker.js";
import { LEARNING_LIMITS, ModelAccessRequestSchema } from "../../packages/broker/src/model-proxy/protocol.js";
import { routeFetch } from "../support/developer-fakes.js";

const BASE = "http://proxy.internal:4001";
const ORG = "org_abcdefghij0123456789";
const OTHER_ORG = "org_zzzzzzzzzzzzzzzzzzzz";
const NOW = 1_800_000_000_000;
const CATALOG = ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-haiku-4-5-20251001-v1:0"];
const ALIAS = CATALOG[1]!;
// Built at runtime: no key-shaped literal in the source.
const MASTER = ["master", "planted", "value"].join("-");
const VIRTUAL = ["virtual", "planted", "value"].join("-");
const PROVIDER_WORDS = "PROVIDER-SECRET-ERROR-TEXT";
/** The function's own timeout in the control plane (infra/lib/control-plane.ts): a learning call and the broker's wait are sized against it. */
const FUNCTION_TIMEOUT_MS = 120_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
interface Seen { method: string; path: string; headers: Headers; body: Record<string, unknown> | undefined }

type Api = "anthropic-messages" | "openai-responses" | "openai-completions";
const REPLIES: Record<Api, [string, Record<string, unknown>]> = {
  "anthropic-messages": ["/v1/messages", { content: [{ type: "text", text: "{\"candidates\":" }, { type: "text", text: "[]}" }], usage: { input_tokens: 10, output_tokens: 5 } }],
  "openai-completions": ["/chat/completions", { choices: [{ message: { content: "{\"candidates\":[]}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }],
  "openai-responses": ["/v1/responses", { output: [{ type: "message", content: [{ type: "output_text", text: "{\"candidates\":[]}" }] }], usage: { input_tokens: 10, output_tokens: 5 } }],
};

function proxy(options: { api?: Api; inference?: (seen: Seen) => Response } = {}) {
  const api = options.api ?? "anthropic-messages";
  const seen: Seen[] = [];
  const fetch = routeFetch(async (url, init) => {
    const entry: Seen = { method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined };
    seen.push(entry);
    if (entry.path === "/team/info") return json({ team_info: { models: CATALOG } });
    if (entry.path === REPLIES[api][0]) return options.inference?.(entry) ?? json(REPLIES[api][1]);
    return json({ error: { message: "not found" } }, 404);
  });
  const client = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch, now: () => NOW, catalog: CATALOG });
  return { client, seen };
}

const input = (api: Api = "anthropic-messages") => ({ key: VIRTUAL, purpose: "reflect" as const, system: "You turn work into lessons.", user: "Subject: finished task", maxOutputTokens: 1800, model: ALIAS, api });
const failure = async (action: Promise<unknown>) => { try { await action; } catch (error) { return error as AgentXError; } throw new Error("expected a rejection"); };

afterEach(() => { vi.restoreAllMocks(); });

describe("ModelProxyClient.learningCompletion", () => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    it(`${api}: answers the text and the alias, with a tool-less request`, async () => {
      const { client, seen } = proxy({ api });
      const answer = await client.learningCompletion(input(api));
      expect(answer).toEqual({ text: "{\"candidates\":[]}", model: ALIAS });
      const call = seen.find((entry) => entry.path === REPLIES[api][0])!;
      expect(call.method).toBe("POST");
      expect(call.body).toBeDefined();
      expect(Object.keys(call.body!)).not.toContain("tools");
      expect(Object.keys(call.body!)).not.toContain("tool_choice");
      expect(call.body!.model).toBe(ALIAS);
      expect(JSON.stringify(call.body)).toContain("finished task");
    });
  }

  it("H2: a reasoning effort is sent in each OpenAI transport's own field, and never on the Messages transport or when none is asked for", async () => {
    const responses = proxy({ api: "openai-responses" });
    await responses.client.learningCompletion({ ...input("openai-responses"), reasoningEffort: "minimal" });
    expect(responses.seen.find((entry) => entry.path === "/v1/responses")!.body).toMatchObject({ reasoning: { effort: "minimal" } });
    const completions = proxy({ api: "openai-completions" });
    await completions.client.learningCompletion({ ...input("openai-completions"), reasoningEffort: "low" });
    expect(completions.seen.find((entry) => entry.path === "/chat/completions")!.body).toMatchObject({ reasoning_effort: "low" });
    for (const api of ["openai-responses", "openai-completions", "anthropic-messages"] as const) {
      const plain = proxy({ api });
      await plain.client.learningCompletion(input(api));
      expect(JSON.stringify(plain.seen.find((entry) => entry.path === REPLIES[api][0])!.body)).not.toMatch(/reasoning/u);
    }
    const messages = proxy();
    await messages.client.learningCompletion({ ...input(), reasoningEffort: "low" });
    expect(JSON.stringify(messages.seen.find((entry) => entry.path === "/v1/messages")!.body)).not.toMatch(/reasoning/u);
  });

  it("H2: the function's request schema takes a minimal or low effort and nothing else", () => {
    const request = (reasoningEffort: unknown) => ModelAccessRequestSchema.safeParse({ op: "learningCompletion", args: { ...input("openai-responses"), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }).success;
    expect([request(undefined), request("minimal"), request("low"), request("high"), request("")]).toEqual([true, true, true, false, false]);
  });

  it("H2: a reply with no text (a reasoning model that spent the whole budget) is a failure with fixed words, never an empty answer", async () => {
    const { client } = proxy({ api: "openai-responses", inference: () => json({ output: [{ type: "reasoning", summary: [] }], usage: { output_tokens: 120 } }) });
    expect((await failure(client.learningCompletion(input("openai-responses")))).message).toMatch(/no text/u);
  });

  it("the call is made with the broker's key, never the master key, and the function does nothing else: it mints, reads and deletes no key", async () => {
    const { client, seen } = proxy();
    await client.learningCompletion(input());
    const call = seen.find((entry) => entry.path === "/v1/messages")!;
    expect(call.headers.get("authorization")).toBe(`Bearer ${VIRTUAL}`);
    expect(JSON.stringify(call.body)).not.toContain(MASTER);
    expect(call.headers.get("authorization")).not.toContain(MASTER);
    // No /key/generate, /key/info or /key/delete: it cannot read a spend figure the proxy has not flushed yet, and it cannot delete the figure away.
    expect(seen.map((entry) => entry.path)).toEqual(["/v1/messages"]);
  });

  it("gives the provider a bounded wait that fits inside the function's own timeout, and the broker waits longer than the function can run", async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return real(ms); });
    const { client } = proxy();
    await client.learningCompletion(input());
    expect(timeouts).toEqual([LEARNING_CALL_TIMEOUT_MS]);
    expect(LEARNING_CALL_TIMEOUT_MS).toBeLessThan(FUNCTION_TIMEOUT_MS);
    expect(LEARNING_INVOKE_TIMEOUT_MS).toBeGreaterThan(FUNCTION_TIMEOUT_MS);
  });

  it("a provider error gives a fixed sentence and a fixed code; the provider's words, the key and the master key appear nowhere", async () => {
    const { client } = proxy({ inference: () => json({ error: { message: PROVIDER_WORDS, key: VIRTUAL } }, 500) });
    const error = await failure(client.learningCompletion(input()));
    expect(error.code).toBe("MODEL_PROXY_UNAVAILABLE");
    for (const text of [error.message, JSON.stringify(error)]) {
      expect(text).not.toContain(PROVIDER_WORDS);
      expect(text).not.toContain(VIRTUAL);
      expect(text).not.toContain(MASTER);
    }
    const refused = await failure(proxy({ inference: () => json({ error: { message: PROVIDER_WORDS } }, 400) }).client.learningCompletion(input()));
    expect(refused.message).not.toContain(PROVIDER_WORDS);
  });

  it("a reply with no text is a fixed failure", async () => {
    const { client } = proxy({ inference: () => json({ content: [], usage: {} }) });
    const error = await failure(client.learningCompletion(input()));
    expect(error.code).toBe("MODEL_PROXY_UNAVAILABLE");
  });
});

describe("what a key may name (the mint is where a learning call's alias is fenced)", () => {
  const mint = (models: string[]) => {
    const { client, seen } = proxy();
    const result = client.mintKey({ orgId: ORG, purpose: "task", refId: "learning-op", maxBudgetUsd: 0.25, ttlSeconds: 300, models });
    return { result, seen };
  };

  it("another org's real alias, an own-prefixed wildcard and a bare wildcard are refused before any key is made", async () => {
    for (const models of [[`${OTHER_ORG}.src_aaaaaaaaaaaaaaaaaaaa.claude-sonnet-4-6`], [`${ORG}.*`], [`${ORG}.src_aaaaaaaaaaaaaaaaaaaa.*`], ["*"], [ALIAS, `${OTHER_ORG}.src_aaaaaaaaaaaaaaaaaaaa.claude-sonnet-4-6`]]) {
      const { result, seen } = mint(models);
      const error = await failure(result);
      expect(error.code, models.join(",")).toBe("CONFIG_INVALID");
      expect(seen.some((entry) => entry.path === "/key/generate")).toBe(false);
    }
  });

  it("positive control: a catalog alias passes the same check (it reaches the proxy's mint)", async () => {
    const { result, seen } = mint([ALIAS]);
    await result.catch(() => undefined);
    expect(seen.some((entry) => entry.path === "/team/info")).toBe(true);
  });
});

describe("the operation across the function boundary", () => {
  const lambdaOver = (run: (event: unknown) => Promise<unknown>) => ({ send: async (command: { input: { Payload?: Uint8Array } }) => {
    const out = await run(JSON.parse(Buffer.from(command.input.Payload as Uint8Array).toString("utf8")));
    return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(out)), $metadata: {} } as InvokeCommandOutput;
  } });

  it("invoker -> handler -> client: the answer carries no key, no key id and no cost, and the request is validated", async () => {
    const { client } = proxy();
    const run = createModelAccessHandler({ access: client, log: () => undefined, learning: true });
    const invoker = new ModelAccessInvoker({ functionName: "f", lambda: lambdaOver(run) as never });
    const answer = await invoker.learningCompletion(input());
    expect(answer).toEqual({ text: "{\"candidates\":[]}", model: ALIAS });
    expect(JSON.stringify(answer)).not.toContain(VIRTUAL);
  });

  it("the invoker waits for a learning call as long as it says and for the other operations the short default", async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return real(ms); });
    const lambda = { send: async () => ({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: { text: "x", model: ALIAS } })), $metadata: {} }) as InvokeCommandOutput };
    const invoker = new ModelAccessInvoker({ functionName: "f", lambda: lambda });
    expect((await invoker.learningCompletion(input())).text).toBe("x");
    expect(timeouts).toEqual([LEARNING_INVOKE_TIMEOUT_MS]);
    // The short default for any other operation is much shorter than a learning call's wait.
    const other = { send: async () => ({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: null })), $metadata: {} }) as InvokeCommandOutput };
    timeouts.length = 0;
    await new ModelAccessInvoker({ functionName: "f", lambda: other }).blockKey("a".repeat(64));
    expect(timeouts[0]).toBeLessThan(LEARNING_INVOKE_TIMEOUT_MS);
  });

  it("a function that is not set up for learning refuses (the switch is off, or the client has no operation), and makes no call", async () => {
    const called = vi.fn();
    const withOp = { learningCompletion: async () => { called(); return { text: "x", model: ALIAS }; } };
    const off = createModelAccessHandler({ access: withOp as never, log: () => undefined });
    expect(await off({ op: "learningCompletion", args: input() })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(called).not.toHaveBeenCalled();
    const noOp = createModelAccessHandler({ access: {} as never, log: () => undefined, learning: true });
    expect(await noOp({ op: "learningCompletion", args: input() })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    const on = createModelAccessHandler({ access: withOp as never, log: () => undefined, learning: true });
    expect(await on({ op: "learningCompletion", args: input() })).toMatchObject({ ok: true });
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("the protocol bounds the call per purpose: a tools field, a member, a budget field, an empty prompt, a prompt or an answer over the purpose's limit are refused", () => {
    const args = input();
    const ok = (extra: Record<string, unknown>) => ModelAccessRequestSchema.safeParse({ op: "learningCompletion", args: { ...args, ...extra } }).success;
    expect(ok({})).toBe(true);
    expect(ok({ tools: [] })).toBe(false);
    expect(ok({ developerId: "a".repeat(64) })).toBe(false);
    expect(ok({ maxBudgetUsd: 0.25 })).toBe(false);
    expect(ok({ orgId: ORG })).toBe(false);
    expect(ok({ rovaraPaid: true })).toBe(false);
    expect(ok({ user: "" })).toBe(false);
    expect(ok({ key: "" })).toBe(false);
    expect(ok({ api: "gemini" })).toBe(false);
    expect(ok({ purpose: "judge", user: "x".repeat(LEARNING_LIMITS.judge.userChars + 1) })).toBe(false);
    expect(ok({ purpose: "judge", user: "x".repeat(LEARNING_LIMITS.judge.userChars) , maxOutputTokens: LEARNING_LIMITS.judge.outputTokens })).toBe(true);
    expect(ok({ purpose: "judge", maxOutputTokens: LEARNING_LIMITS.judge.outputTokens + 1 })).toBe(false);
    expect(ok({ purpose: "reflect", maxOutputTokens: LEARNING_LIMITS.reflect.outputTokens + 1 })).toBe(false);
  });
});
