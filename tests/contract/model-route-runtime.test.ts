// Task 27: the runtime, the worker and the orchestrator call a model through the route the broker chose.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import type { InvocationModelRoute } from "../../packages/contracts/src/index.js";
import { ROUTE_PROVIDER, createConfiguredModelRuntime, createModelRuntimeWithFallback, routeUsageIdentity } from "../../packages/model-runtime/src/index.js";
import { turnModelAccessSource, turnModelRoute } from "../../packages/slack-service/src/model-access.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";
import { createFixtureDirectory } from "../fixtures/index.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PROXY_KEY = "sk-proxy-route-key-0001";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const anthropicRoute: InvocationModelRoute = { alias: "org_aaaaaaaaaaaaaaaaaaaa.src_bbbbbbbbbbbbbbbbbbbb.claude-sonnet-4-6", api: "anthropic-messages", catalog: "claude-sonnet-4-6" };
const responsesRoute: InvocationModelRoute = { alias: "org_aaaaaaaaaaaaaaaaaaaa.src_cccccccccccccccccccc.gpt-5-4", api: "openai-responses", catalog: "gpt-5.4" };
const completionsRoute: InvocationModelRoute = { alias: "org_aaaaaaaaaaaaaaaaaaaa.src_dddddddddddddddddddd.gpt-5-4", api: "openai-completions", catalog: "gpt-5.4" };

function sse(events: Array<{ type: string } & Record<string, unknown>>) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
function anthropicText(text: string) {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "served", content: [], stop_reason: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}

function recordingTransport(respond: () => Response) {
  const requests: Array<{ url: URL; headers: Headers; body: Record<string, unknown> }> = [];
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    requests.push({ url: new URL(String(input instanceof Request ? input.url : input)), headers: new Headers(init?.headers), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
    return respond();
  });
  return { requests, transport };
}

describe("the model runtime with a route", () => {
  it("registers rovara-route with the route's api, the proxy and the alias, and never reads a provider secret", async () => {
    const readSecret = vi.fn(async () => "sk-never-read-0000");
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, {
      readSecret, proxy: { baseUrl: PROXY_URL, apiKey: async () => PROXY_KEY, route: anthropicRoute },
    });
    expect(readSecret).not.toHaveBeenCalled();
    const served = runtime.getModels(ROUTE_PROVIDER);
    expect(served.map((model) => model.id)).toEqual([anthropicRoute.alias]);
    expect(served[0]).toMatchObject({ api: "anthropic-messages", baseUrl: PROXY_URL });
    expect(served[0]!.contextWindow).toBeGreaterThan(0);
  });

  it("sends an anthropic-messages route to /v1/messages under the alias, and reports usage under the catalog provider and id", async () => {
    const { requests, transport } = recordingTransport(() => anthropicText("hi"));
    const onUsage = vi.fn();
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, {
      fetch: transport, onUsage, proxy: { baseUrl: PROXY_URL, apiKey: async () => PROXY_KEY, route: anthropicRoute },
    });
    const model = runtime.getModel(ROUTE_PROVIDER, anthropicRoute.alias)!;
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.origin).toBe(PROXY_URL);
    expect(requests[0]!.url.pathname).toBe("/v1/messages");
    expect(requests[0]!.headers.get("x-api-key")).toBe(PROXY_KEY);
    expect(requests[0]!.body.model).toBe(anthropicRoute.alias);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]![0]).toMatchObject({ event: "model_request_usage", provider: "anthropic", requestedModel: "claude-sonnet-4-6" });
    expect(JSON.stringify(onUsage.mock.calls)).not.toContain(PROXY_KEY);
    expect(JSON.stringify(onUsage.mock.calls)).not.toContain(anthropicRoute.alias);
  });

  it("asks for the key before every request", async () => {
    const { requests, transport } = recordingTransport(() => anthropicText("hi"));
    let current = "sk-proxy-first-key-0001";
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, {
      fetch: transport, proxy: { baseUrl: PROXY_URL, apiKey: async () => current, route: anthropicRoute },
    });
    const model = runtime.getModel(ROUTE_PROVIDER, anthropicRoute.alias)!;
    await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    current = "sk-proxy-second-key-0002";
    await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(requests.map((request) => request.headers.get("x-api-key"))).toEqual(["sk-proxy-first-key-0001", "sk-proxy-second-key-0002"]);
  });

  it.each([
    { route: responsesRoute, path: "/v1/responses", label: "openai-responses" },
    { route: completionsRoute, path: "/v1/chat/completions", label: "openai-completions" },
  ])("sends an $label route to $path under the alias", async ({ route, path }) => {
    const { requests, transport } = recordingTransport(() => new Response("{}", { status: 400 }));
    const onUsage = vi.fn();
    const runtime = await createConfiguredModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, {
      fetch: transport, onUsage, proxy: { baseUrl: PROXY_URL, apiKey: async () => PROXY_KEY, route },
    });
    const model = runtime.getModel(ROUTE_PROVIDER, route.alias)!;
    expect(model).toMatchObject({ api: route.api, baseUrl: `${PROXY_URL}/v1` });
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result.stopReason).toBe("error");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.url.origin).toBe(PROXY_URL);
    expect(requests[0]!.url.pathname).toBe(path);
    expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${PROXY_KEY}`);
    expect(requests[0]!.body.model).toBe(route.alias);
    expect(onUsage.mock.calls[0]![0]).toMatchObject({ provider: "openai", requestedModel: "gpt-5.4" });
  });

  it("streams a successful openai-completions route and reports tokens under the catalog provider and id", async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "served", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
    const body = chunk({ role: "assistant", content: "hi" }, null) + chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + "data: [DONE]\n\n";
    const { requests, transport } = recordingTransport(() => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    const onUsage = vi.fn();
    const runtime = await createConfiguredModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, { fetch: transport, onUsage, proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, route: completionsRoute } });
    const result = await runtime.streamSimple(runtime.getModel(ROUTE_PROVIDER, completionsRoute.alias)!, context, { maxTokens: 64 }).result();
    expect(result.stopReason).toBe("stop");
    expect(requests[0]!.url.pathname).toBe("/v1/chat/completions");
    expect(onUsage.mock.calls[0]![0]).toMatchObject({ provider: "openai", requestedModel: "gpt-5.4", outcome: "stop", tokens: { input: 10, output: 2 } });
  });

  it("runs a routed model that does not reason with thinking off, whatever level the project chose", async () => {
    const unlisted: InvocationModelRoute = { alias: "org_aaaaaaaaaaaaaaaaaaaa.src_eeeeeeeeeeeeeeeeeeee.house-model", api: "openai-completions", catalog: "house-model" };
    const configured = { provider: "amazon-bedrock", modelId: BEDROCK_MODEL, thinkingLevel: "high" as const };
    const runtime = await createConfiguredModelRuntime(configured, { proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, route: unlisted } });
    expect(runtime.getModel(ROUTE_PROVIDER, unlisted.alias)).toBeDefined();
    const resolved = await createModelRuntimeWithFallback(configured, "worker", { proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, route: unlisted } });
    expect(resolved.model).toEqual({ provider: ROUTE_PROVIDER, modelId: unlisted.alias, thinkingLevel: "off" });
    // A model that reasons keeps the level.
    const reasoning = await createModelRuntimeWithFallback(configured, "worker", { proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, route: anthropicRoute } });
    expect(reasoning.model).toMatchObject({ thinkingLevel: "high" });
  });

  it("gives a catalog entry the installed catalog does not know a plain model under the catalog name", async () => {
    const route: InvocationModelRoute = { alias: "org_aaaaaaaaaaaaaaaaaaaa.src_eeeeeeeeeeeeeeeeeeee.house-model", api: "openai-completions", catalog: "house-model" };
    expect(routeUsageIdentity(route)).toEqual({ provider: ROUTE_PROVIDER, modelId: "house-model" });
    const runtime = await createConfiguredModelRuntime({ provider: "openai", modelId: "x" }, { proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, route } });
    expect(runtime.getModel(ROUTE_PROVIDER, route.alias)).toMatchObject({ reasoning: false, api: "openai-completions" });
  });

  it("names the catalog entry by id, by canonical name, and by Bedrock inference-profile id", () => {
    expect(routeUsageIdentity(anthropicRoute)).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    expect(routeUsageIdentity(responsesRoute)).toEqual({ provider: "openai", modelId: "gpt-5.4" });
    expect(routeUsageIdentity({ ...anthropicRoute, catalog: BEDROCK_MODEL })).toEqual({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL });
    expect(routeUsageIdentity({ ...anthropicRoute, catalog: "gpt-5-4" })).toEqual({ provider: "openai", modelId: "gpt-5.4" });
  });

  it("serves the route's model whatever model was configured, and reports it as rovara-route", async () => {
    const resolved = await createModelRuntimeWithFallback({ provider: "openai", modelId: "gpt-5.4", thinkingLevel: "high" }, "worker", {
      proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, route: anthropicRoute },
    });
    expect(resolved.model).toEqual({ provider: ROUTE_PROVIDER, modelId: anthropicRoute.alias, thinkingLevel: "high" });
  });

  it("leaves a ChatGPT plan's requests direct, route or not", async () => {
    const runtime = await createConfiguredModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, {
      apiKey: async () => "chatgpt-token", proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, route: responsesRoute },
    });
    expect(runtime.getModel("openai", "gpt-5.4")!.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("without a route, serves the proxy's Bedrock models exactly as before", async () => {
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY } });
    expect(runtime.getModels(ROUTE_PROVIDER)).toEqual([]);
    expect(runtime.getModel("amazon-bedrock", BEDROCK_MODEL)).toMatchObject({ api: "anthropic-messages", baseUrl: PROXY_URL });
    const resolved = await createModelRuntimeWithFallback({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, "worker", { proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY } });
    expect(resolved.model).toEqual({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL });
  });
});

describe("the worker with a modelRoute", () => {
  const proxy = { baseUrl: PROXY_URL, apiKey: async () => PROXY_KEY };
  const environment = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: BEDROCK_MODEL } as NodeJS.ProcessEnv;

  it("runs the task on rovara-route with the route's alias, and its session reports the catalog provider and id", async () => {
    const session = await resolveTaskSessionModel({ model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL, thinkingLevel: "low" }, modelRoute: anthropicRoute }, undefined, environment, undefined, proxy);
    expect(session.model).toMatchObject({ provider: ROUTE_PROVIDER, modelId: anthropicRoute.alias, thinkingLevel: "low" });
    expect(session.piAdapter).toBeDefined();
    const handle = await createWorkspacePiSession({ rootPath: await createFixtureDirectory("agentx-route-"), model: session.model }, session.piAdapter);
    try {
      expect(handle.getModel()).toMatchObject({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
    } finally {
      handle.dispose();
    }
  });

  it("starts a task routed to a model that does not reason though the project chose a thinking level", async () => {
    const unlisted: InvocationModelRoute = { alias: "org_aaaaaaaaaaaaaaaaaaaa.src_eeeeeeeeeeeeeeeeeeee.house-model", api: "openai-completions", catalog: "house-model" };
    const session = await resolveTaskSessionModel({ model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL, thinkingLevel: "high" }, modelRoute: unlisted }, undefined, environment, undefined, proxy);
    expect(session.model).toMatchObject({ provider: ROUTE_PROVIDER, modelId: unlisted.alias, thinkingLevel: "off" });
    const handle = await createWorkspacePiSession({ rootPath: await createFixtureDirectory("agentx-route-"), model: session.model }, session.piAdapter);
    try {
      expect(handle.getModel()).toMatchObject({ provider: ROUTE_PROVIDER, modelId: "house-model", thinkingLevel: "off" });
    } finally {
      handle.dispose();
    }
  });

  it("without a route is the task it always was", async () => {
    const session = await resolveTaskSessionModel({ model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL } }, undefined, environment, undefined, proxy);
    expect(session.model).toMatchObject({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL });
    const handle = await createWorkspacePiSession({ rootPath: await createFixtureDirectory("agentx-route-"), model: session.model }, session.piAdapter);
    try {
      expect(handle.getModel()).toMatchObject({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL });
    } finally {
      handle.dispose();
    }
  });

  it("refuses a route when the worker has no model proxy to send it through, rather than using the default model", async () => {
    await expect(resolveTaskSessionModel({ modelRoute: anthropicRoute }, undefined, environment)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("sends a ChatGPT task's fallback through the route", async () => {
    const session = await resolveTaskSessionModel({ chatgpt: { model: { provider: "openai", modelId: "gpt-5.4" } }, modelRoute: anthropicRoute }, async () => { throw new Error("revoked"); }, environment, undefined, proxy);
    expect(session.model).toMatchObject({ provider: ROUTE_PROVIDER, modelId: anthropicRoute.alias });
  });
});

describe("the orchestrator with a returned route", () => {
  it("runs the turn on rovara-route with the route's alias and the proxy's key", async () => {
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-route-turn-"), projectInstructions: "Delegate.", api: {} as never,
      context: { workspaceId: randomUUID(), conversationId: randomUUID() }, model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL },
      answerOnly: true, proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY }, modelRoute: anthropicRoute,
    });
    try {
      expect(runtime.session.model).toMatchObject({ provider: ROUTE_PROVIDER, id: anthropicRoute.alias, api: "anthropic-messages", baseUrl: PROXY_URL });
    } finally {
      await runtime.dispose();
    }
  });

  it("starts a turn routed to a model that does not reason though a thinking level was configured", async () => {
    const unlisted: InvocationModelRoute = { alias: "org_aaaaaaaaaaaaaaaaaaaa.src_eeeeeeeeeeeeeeeeeeee.house-model", api: "openai-completions", catalog: "house-model" };
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-route-turn-"), projectInstructions: "Delegate.", api: {} as never,
      context: { workspaceId: randomUUID(), conversationId: randomUUID() }, model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL, thinkingLevel: "high" },
      answerOnly: true, proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY }, modelRoute: unlisted,
    });
    try {
      expect(runtime.session.model).toMatchObject({ provider: ROUTE_PROVIDER, id: unlisted.alias });
    } finally {
      await runtime.dispose();
    }
  });

  it("refuses a route when there is no proxy to send it through", async () => {
    await expect(createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-route-turn-"), projectInstructions: "Delegate.", api: {} as never,
      context: { workspaceId: randomUUID(), conversationId: randomUUID() }, model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL },
      answerOnly: true, modelRoute: anthropicRoute,
    })).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
  });

  it("without a route runs the configured model", async () => {
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-route-turn-"), projectInstructions: "Delegate.", api: {} as never,
      context: { workspaceId: randomUUID(), conversationId: randomUUID() }, model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL },
      answerOnly: true, proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY },
    });
    try {
      expect(runtime.session.model).toMatchObject({ provider: "amazon-bedrock", id: BEDROCK_MODEL });
    } finally {
      await runtime.dispose();
    }
  });
});

describe("a Slack turn's model access", () => {
  const access = (extra: Record<string, unknown>) => new Response(JSON.stringify({ baseUrl: PROXY_URL, apiKey: PROXY_KEY, expiresAt: Date.now() + 900_000, ...extra }), { status: 200 });
  const source = (respond: () => Response) => turnModelAccessSource({ controlPlaneUrl: "https://api.example.test", signedFetch: vi.fn<typeof fetch>(async () => respond()), turnId: "Ev1" });

  it("carries the route the broker returned, from the same request as the key", async () => {
    const signed = vi.fn<typeof fetch>(async () => access({ route: anthropicRoute }));
    const turn = turnModelAccessSource({ controlPlaneUrl: "https://api.example.test", signedFetch: signed, turnId: "Ev1" });
    expect(await turnModelRoute(turn)).toEqual(anthropicRoute);
    expect(await turn()).toMatchObject({ apiKey: PROXY_KEY, route: anthropicRoute });
    expect(signed).toHaveBeenCalledTimes(1);
  });

  it("refuses a removed or banned member as a forbidden one, and still reports any other refusal as the proxy being unavailable", async () => {
    const refused = (code: string) => source(() => new Response(JSON.stringify({ error: { code, message: "refused" } }), { status: 403 }))();
    await expect(refused("REMOVED_FROM_ORG")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refused("FORBIDDEN")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(refused("TASK_ACCESS_DENIED")).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
  });

  it("has no route when the answer has none, and refuses a malformed one", async () => {
    expect(await turnModelRoute(source(() => access({})))).toBeUndefined();
    await expect(source(() => access({ route: { alias: "a", api: "grpc", catalog: "c" } }))()).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
  });
});
