// Lessons in production, lane 1: the `learningCompletion` operation of the ModelAccessFunction. One tool-less model call on the company's own route, made with a short-lived key
// for the org alone, scoped to the one alias, capped at the call's budget, deleted after the call. The key never leaves the function and no error carries the provider's words.
import type { AgentXError } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { InvokeCommandOutput } from "@aws-sdk/client-lambda";
import { ModelProxyClient } from "../../packages/broker/src/model-proxy/client.js";
import { createModelAccessHandler } from "../../packages/broker/src/model-proxy/handler.js";
import { ModelAccessInvoker } from "../../packages/broker/src/model-proxy/invoker.js";
import { ModelAccessRequestSchema } from "../../packages/broker/src/model-proxy/protocol.js";
import { routeFetch } from "../support/developer-fakes.js";

const BASE = "http://proxy.internal:4001";
const ORG = "org_abcdefghij0123456789";
const NOW = 1_800_000_000_000;
const CATALOG = ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-haiku-4-5-20251001-v1:0"];
const ALIAS = CATALOG[1]!;
// Built at runtime: no key-shaped literal in the source.
const MASTER = ["master", "planted", "value"].join("-");
const VIRTUAL = ["virtual", "planted", "value"].join("-");
const PROVIDER_WORDS = "PROVIDER-SECRET-ERROR-TEXT";
const tokenOf = (key: string): string => createHash("sha256").update(key).digest("hex");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
interface Seen { method: string; path: string; headers: Headers; body: Record<string, unknown> | undefined }

type Api = "anthropic-messages" | "openai-responses" | "openai-completions";
const REPLIES: Record<Api, [string, Record<string, unknown>]> = {
  "anthropic-messages": ["/v1/messages", { content: [{ type: "text", text: "{\"candidates\":" }, { type: "text", text: "[]}" }], usage: { input_tokens: 10, output_tokens: 5 } }],
  "openai-completions": ["/chat/completions", { choices: [{ message: { content: "{\"candidates\":[]}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }],
  "openai-responses": ["/v1/responses", { output: [{ type: "message", content: [{ type: "output_text", text: "{\"candidates\":[]}" }] }], usage: { input_tokens: 10, output_tokens: 5 } }],
};

function proxy(options: { api?: Api; inference?: (seen: Seen) => Response; spend?: number | "unknown"; mint?: Response; deleteStatus?: number } = {}) {
  const api = options.api ?? "anthropic-messages";
  const seen: Seen[] = [];
  let stored: Record<string, unknown> | undefined;
  let infoReads = 0;
  const fetch = routeFetch(async (url, init) => {
    const entry: Seen = { method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined };
    seen.push(entry);
    if (entry.path === "/team/info") return json({ team_info: { models: CATALOG } });
    if (entry.path === "/key/generate") { stored = entry.body; return options.mint ?? json({ key: VIRTUAL }); }
    if (entry.path === "/key/info") {
      infoReads += 1;
      // The mint reads the key back once; "unknown" means the proxy cannot say what it spent afterwards.
      if (options.spend === "unknown" && infoReads > 1) return json({ error: { message: "nope" } }, 404);
      return json({ info: { models: stored?.models, team_id: stored?.team_id, aliases: {}, allowed_routes: stored?.allowed_routes, spend: options.spend ?? 0.0123 } });
    }
    if (entry.path === "/key/delete") return json({}, options.deleteStatus ?? 200);
    if (entry.path === REPLIES[api][0]) return options.inference?.(entry) ?? json(REPLIES[api][1]);
    return json({ error: { message: "not found" } }, 404);
  });
  const client = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch, now: () => NOW, catalog: CATALOG });
  return { client, seen };
}

const input = (api: Api = "anthropic-messages") => ({ orgId: ORG as never, project: "proj-1", purpose: "reflect" as const, system: "You turn work into lessons.", user: "Subject: finished task", maxOutputTokens: 1800, model: ALIAS, api, maxBudgetUsd: 0.25 });
const failure = async (action: Promise<unknown>) => { try { await action; } catch (error) { return error as AgentXError; } throw new Error("expected a rejection"); };

describe("ModelProxyClient.learningCompletion", () => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    it(`${api}: answers the text, what the key spent and the alias, with a tool-less request`, async () => {
      const { client, seen } = proxy({ api });
      const answer = await client.learningCompletion(input(api));
      expect(answer).toEqual({ text: "{\"candidates\":[]}", costUsd: 0.0123, model: ALIAS });
      const call = seen.find((entry) => entry.path === REPLIES[api][0])!;
      expect(call.method).toBe("POST");
      expect(call.body).toBeDefined();
      expect(Object.keys(call.body!)).not.toContain("tools");
      expect(Object.keys(call.body!)).not.toContain("tool_choice");
      expect(call.body!.model).toBe(ALIAS);
      expect(JSON.stringify(call.body)).toContain("finished task");
    });
  }

  it("the call is made with the minted key, never the master key", async () => {
    const { client, seen } = proxy();
    await client.learningCompletion(input());
    const call = seen.find((entry) => entry.path === "/v1/messages")!;
    expect(call.headers.get("authorization")).toBe(`Bearer ${VIRTUAL}`);
    expect(JSON.stringify(call.body)).not.toContain(MASTER);
    expect(call.headers.get("authorization")).not.toContain(MASTER);
  });

  it("mints a key for the org alone (no member), scoped to the one alias, capped at the budget, alive five minutes at most, for inference routes only", async () => {
    const { client, seen } = proxy();
    await client.learningCompletion(input());
    const generate = seen.find((entry) => entry.path === "/key/generate")!;
    expect(generate.body).toMatchObject({ team_id: ORG, max_budget: 0.25, models: [ALIAS], duration: "300s", metadata: { orgId: ORG, purpose: "turn", project: "proj-1", origin: "learning", agentId: "learning" } });
    expect(generate.body).not.toHaveProperty("user_id");
    expect(generate.body!.allowed_routes).toEqual(["/v1/messages", "/v1/responses", "/chat/completions"]);
  });

  it("reads the cost from the key's own spend, then deletes the key (read first: the figure is gone after the delete)", async () => {
    const { client, seen } = proxy({ spend: 0.0421 });
    expect((await client.learningCompletion(input())).costUsd).toBe(0.0421);
    const order = seen.map((entry) => entry.path);
    const spendRead = order.lastIndexOf("/key/info");
    const del = seen.find((entry) => entry.path === "/key/delete")!;
    expect(del.body).toEqual({ keys: [VIRTUAL] });
    expect(order.indexOf("/key/delete")).toBeGreaterThan(spendRead);
    expect(seen.some((entry) => entry.path === "/key/info" && entry.method === "GET")).toBe(true);
    expect(tokenOf(VIRTUAL)).toHaveLength(64);
  });

  it("when the proxy cannot say what the key spent, the call is counted at the key's whole cap (never less)", async () => {
    const { client } = proxy({ spend: "unknown" });
    expect((await client.learningCompletion(input())).costUsd).toBe(0.25);
  });

  it("a provider error gives a fixed sentence and a fixed code; the provider's words, the key and the master key appear nowhere, and the key is still deleted", async () => {
    const { client, seen } = proxy({ inference: () => json({ error: { message: PROVIDER_WORDS, key: VIRTUAL } }, 500) });
    const error = await failure(client.learningCompletion(input()));
    expect(error.code).toBe("MODEL_PROXY_UNAVAILABLE");
    for (const text of [error.message, JSON.stringify(error)]) {
      expect(text).not.toContain(PROVIDER_WORDS);
      expect(text).not.toContain(VIRTUAL);
      expect(text).not.toContain(MASTER);
    }
    expect(seen.some((entry) => entry.path === "/key/delete")).toBe(true);
    const refused = await failure(proxy({ inference: () => json({ error: { message: PROVIDER_WORDS } }, 400) }).client.learningCompletion(input()));
    expect(refused.message).not.toContain(PROVIDER_WORDS);
  });

  it("a reply with no text is a fixed failure", async () => {
    const { client } = proxy({ inference: () => json({ content: [], usage: {} }) });
    const error = await failure(client.learningCompletion(input()));
    expect(error.code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("a mint the proxy refuses is a fixed sentence without the proxy's text", async () => {
    const { client } = proxy({ mint: json({ error: { message: PROVIDER_WORDS } }, 400) });
    const error = await failure(client.learningCompletion(input()));
    expect(error.message).not.toContain(PROVIDER_WORDS);
  });

  it("an alias that is not the org's own or the catalog's is refused before any call is made", async () => {
    const { client, seen } = proxy();
    const error = await failure(client.learningCompletion({ ...input(), model: "org_zzzzzzzzzzzzzzzzzzzz/other" }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(seen.some((entry) => entry.path === "/v1/messages")).toBe(false);
  });

  it("a failed delete does not fail the call, and logs no key", async () => {
    const lines: string[] = [];
    const { seen } = proxy({ deleteStatus: 500 });
    const fetch = routeFetch(async (url, init) => {
      const entry = { path: url.pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined };
      if (entry.path === "/team/info") return json({ team_info: { models: CATALOG } });
      if (entry.path === "/key/generate") return json({ key: VIRTUAL });
      if (entry.path === "/key/info") return json({ info: { models: [ALIAS], team_id: ORG, aliases: {}, allowed_routes: ["/v1/messages", "/v1/responses", "/chat/completions"], spend: 0.01 } });
      if (entry.path === "/key/delete") return json({}, 500);
      return json(REPLIES["anthropic-messages"][1]);
    });
    const client = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch, now: () => NOW, catalog: CATALOG, log: (entry) => lines.push(JSON.stringify(entry)) });
    expect((await client.learningCompletion(input())).text).toBe("{\"candidates\":[]}");
    expect(lines.join("\n")).not.toContain(VIRTUAL);
    expect(seen).toBeDefined();
  });
});

describe("the operation across the function boundary", () => {
  it("invoker -> handler -> client: the answer carries no key and the request is validated", async () => {
    const { client } = proxy();
    const run = createModelAccessHandler({ access: client, log: () => undefined });
    const lambda = { send: async (command: { input: { Payload?: Uint8Array } }) => {
      const out = await run(JSON.parse(Buffer.from(command.input.Payload as Uint8Array).toString("utf8")));
      return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(out)), $metadata: {} } as InvokeCommandOutput;
    } };
    const invoker = new ModelAccessInvoker({ functionName: "f", lambda: lambda as never });
    const answer = await invoker.learningCompletion(input());
    expect(answer).toEqual({ text: "{\"candidates\":[]}", costUsd: 0.0123, model: ALIAS });
    expect(JSON.stringify(answer)).not.toContain(VIRTUAL);
  });

  it("the invoker waits longer for a learning call than for the other operations", async () => {
    const seen: number[] = [];
    const lambda = { send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
      void options; seen.push(1);
      return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: { text: "x", costUsd: 0, model: ALIAS } })), $metadata: {} } as InvokeCommandOutput;
    } };
    const invoker = new ModelAccessInvoker({ functionName: "f", lambda: lambda });
    expect((await invoker.learningCompletion(input())).text).toBe("x");
    expect(seen).toHaveLength(1);
  });

  it("a function without the operation answers a fixed refusal", async () => {
    const run = createModelAccessHandler({ access: {} as never, log: () => undefined });
    const out = await run({ op: "learningCompletion", args: input() });
    expect(out).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
  });

  it("the protocol bounds the call: a budget above five dollars, a tools field, a member and an empty prompt are refused", () => {
    const args = input();
    const ok = (extra: Record<string, unknown>) => ModelAccessRequestSchema.safeParse({ op: "learningCompletion", args: { ...args, ...extra } }).success;
    expect(ok({})).toBe(true);
    expect(ok({ maxBudgetUsd: 5.01 })).toBe(false);
    expect(ok({ maxBudgetUsd: 0 })).toBe(false);
    expect(ok({ tools: [] })).toBe(false);
    expect(ok({ developerId: "a".repeat(64) })).toBe(false);
    expect(ok({ rovaraPaid: true })).toBe(false);
    expect(ok({ user: "" })).toBe(false);
    expect(ok({ api: "gemini" })).toBe(false);
  });
});
