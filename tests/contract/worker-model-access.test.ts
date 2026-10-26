// Task 12: a worker calls models through the proxy with a per-task key, never with provider secrets.
import { developerOrgKey, orgMemberKey, orgRemovedKey } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { PER_TASK_BUDGET_USD, agentXError } from "../../packages/contracts/src/index.js";
import { bedrockClaudeModelIds } from "../../packages/model-runtime/src/catalog.js";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { MODEL_ACCESS_MARGIN_MS, lazyModelProxy, modelAccessSource } from "../../packages/worker/src/model-access.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { MAYA, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { fakeModelAccess as sharedFakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PROXY_KEY = "sk-proxy-per-task-key-0001";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

function sse(events: Array<{ type: string } & Record<string, unknown>>) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
function anthropicText(text: string) {
  const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return sse([
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: BEDROCK_MODEL, content: [], stop_reason: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]);
}

describe("the model runtime with a proxy", () => {
  function recordingTransport() {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
      return anthropicText("hi");
    });
    return { requests, transport };
  }

  it("registers the served Claude models against the proxy and never reads a provider secret", async () => {
    const readSecret = vi.fn(async () => "sk-ant-never-read-this-0000");
    const environment = { AGENTX_ANTHROPIC_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/anthropic-AbCdEf" };
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { environment, readSecret, proxy: { baseUrl: PROXY_URL, apiKey: async () => PROXY_KEY } });
    expect(readSecret).not.toHaveBeenCalled();
    const served = runtime.getModels("amazon-bedrock");
    expect(served.map((model) => model.id).sort()).toEqual(bedrockClaudeModelIds());
    for (const model of served) expect(model).toMatchObject({ api: "anthropic-messages", baseUrl: PROXY_URL });
  });

  it("sends a request to the proxy's messages route with the task key and the Bedrock model id", async () => {
    const { requests, transport } = recordingTransport();
    const usage = vi.fn();
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { fetch: transport, onUsage: usage, proxy: { baseUrl: PROXY_URL, apiKey: async () => PROXY_KEY } });
    const model = runtime.getModel("amazon-bedrock", BEDROCK_MODEL)!;
    const result = await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(new URL(request!.url).origin).toBe(PROXY_URL);
    expect(new URL(request!.url).pathname).toBe("/v1/messages");
    expect(request!.headers.get("x-api-key")).toBe(PROXY_KEY);
    expect(request!.body.model).toBe(BEDROCK_MODEL);
    expect(JSON.stringify(usage.mock.calls)).not.toContain(PROXY_KEY);
  });

  it("asks for the key before every request, so a renewed key replaces an expiring one", async () => {
    const { requests, transport } = recordingTransport();
    let current = "sk-proxy-first-key-0001";
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { fetch: transport, proxy: { baseUrl: PROXY_URL, apiKey: async () => current } });
    const model = runtime.getModel("amazon-bedrock", BEDROCK_MODEL)!;
    await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    current = "sk-proxy-second-key-0002";
    await runtime.streamSimple(model, context, { maxTokens: 64 }).result();
    expect(requests.map((request) => request.headers.get("x-api-key"))).toEqual(["sk-proxy-first-key-0001", "sk-proxy-second-key-0002"]);
  });

  it("accepts a fixed key too", async () => {
    const { requests, transport } = recordingTransport();
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { fetch: transport, proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY } });
    await runtime.streamSimple(runtime.getModel("amazon-bedrock", BEDROCK_MODEL)!, context, { maxTokens: 64 }).result();
    expect(requests[0]!.headers.get("x-api-key")).toBe(PROXY_KEY);
  });

  it.each([
    { provider: "openai", modelId: "gpt-5.4" },
    { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" },
  ])("refuses $provider/$modelId, which the proxy does not serve", async (selected) => {
    const readSecret = vi.fn(async () => undefined);
    const error = await createConfiguredModelRuntime(selected, { readSecret, proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY } }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((error as Error).message).toContain(`model ${selected.modelId} is not available on this install`);
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("leaves a ChatGPT plan's requests direct to OpenAI", async () => {
    const requests: string[] = [];
    const transport = vi.fn<typeof fetch>(async (input) => { requests.push(String(input instanceof Request ? input.url : input)); return new Response("{}", { status: 500 }); });
    const apiKey = vi.fn(async () => "chatgpt-access-token-0001");
    const runtime = await createConfiguredModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, { fetch: transport, apiKey, proxy: { baseUrl: PROXY_URL, apiKey: PROXY_KEY } });
    const model = runtime.getModel("openai", "gpt-5.4")!;
    expect(model.baseUrl).toBe("https://api.openai.com/v1");
    await runtime.streamSimple(model, context, { maxTokens: 16 }).result();
    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) expect(url.startsWith("https://api.openai.com/")).toBe(true);
  });
});

describe("modelAccessSource", () => {
  const answer = (key: string, expiresAt: number) => new Response(JSON.stringify({ baseUrl: PROXY_URL, apiKey: key, expiresAt }), { status: 200, headers: { "content-type": "application/json" } });

  it("asks the control plane with the capability and caches until a minute before expiry", async () => {
    let now = 1_000_000;
    const expiresAt = now + 3_600_000;
    const fetchModelAccess = vi.fn<typeof fetch>(async () => answer("sk-proxy-a", expiresAt));
    const source = modelAccessSource({ controlPlaneUrl: "https://api.example.test/", capability: "cap.sig", fetch: fetchModelAccess, now: () => now });
    expect(await source()).toEqual({ baseUrl: PROXY_URL, apiKey: "sk-proxy-a", expiresAt });
    expect(await source()).toMatchObject({ apiKey: "sk-proxy-a" });
    expect(fetchModelAccess).toHaveBeenCalledTimes(1);
    const [url, init] = fetchModelAccess.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/internal/model-access");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("x-agentx-callback-capability")).toBe("cap.sig");
    now = expiresAt - MODEL_ACCESS_MARGIN_MS - 1;
    await source();
    expect(fetchModelAccess).toHaveBeenCalledTimes(1);
    now = expiresAt - MODEL_ACCESS_MARGIN_MS;
    fetchModelAccess.mockImplementationOnce(async () => answer("sk-proxy-b", expiresAt + 3_600_000));
    expect(await source()).toMatchObject({ apiKey: "sk-proxy-b" });
    expect(fetchModelAccess).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const fetchModelAccess = vi.fn<typeof fetch>(async () => answer("sk-proxy-a", Date.now() + 3_600_000));
    const source = modelAccessSource({ controlPlaneUrl: "https://api.example.test", capability: "cap.sig", fetch: fetchModelAccess });
    await Promise.all([source(), source(), source()]);
    expect(fetchModelAccess).toHaveBeenCalledTimes(1);
  });

  it("refuses a refusal or an odd answer without echoing the body, and never logs the key", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((spy) => spy.mockImplementation(() => undefined));
    try {
      const refused = modelAccessSource({ controlPlaneUrl: "https://api.example.test", capability: "cap.sig", fetch: async () => new Response("sk-proxy-secret-echo", { status: 503 }) });
      const refusal = await refused().catch((caught: unknown) => caught);
      expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect((refusal as Error).message).not.toContain("sk-proxy-secret-echo");
      const odd = modelAccessSource({ controlPlaneUrl: "https://api.example.test", capability: "cap.sig", fetch: async () => new Response(JSON.stringify({ baseUrl: PROXY_URL, apiKey: "sk proxy with spaces", expiresAt: Date.now() + 1000 }), { status: 200 }) });
      const oddity = await odd().catch((caught: unknown) => caught);
      expect(oddity).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect((oddity as Error).message).not.toContain("sk proxy");
      const good = modelAccessSource({ controlPlaneUrl: "https://api.example.test", capability: "cap.sig", fetch: async () => answer("sk-proxy-never-logged", Date.now() + 3_600_000) });
      await good();
      for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain("sk-proxy");
    } finally { for (const spy of logs) spy.mockRestore(); }
  });
});

describe("a worker task on an install with a model proxy", () => {
  const environment = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: BEDROCK_MODEL };

  it("takes the proxy's address from the worker's configuration and its key at every request, asking for none before one is needed", async () => {
    let key = "sk-proxy-a";
    const source = vi.fn(async () => ({ baseUrl: PROXY_URL, apiKey: key, expiresAt: Date.now() + 3_600_000 }));
    const proxy = lazyModelProxy({ baseUrl: PROXY_URL, source });
    expect(proxy.baseUrl).toBe(PROXY_URL);
    expect(source).not.toHaveBeenCalled();
    expect(await proxy.apiKey()).toBe("sk-proxy-a");
    key = "sk-proxy-b";
    expect(await proxy.apiKey()).toBe("sk-proxy-b");
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("refuses a proxy address that is not an http or https URL", () => {
    for (const baseUrl of ["", "not a url", "file:///etc/passwd"]) {
      expect(() => lazyModelProxy({ baseUrl, source: async () => { throw new Error("unreachable"); } }), baseUrl).toThrow(/model proxy address/);
    }
  });

  it("runs a ChatGPT-plan task's requests with the proxy down: no key is asked for unless the plan falls back to it", async () => {
    const source = vi.fn(async (): Promise<never> => { throw agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable"); });
    const proxy = lazyModelProxy({ baseUrl: PROXY_URL, source });
    const requests: string[] = [];
    const transport = vi.fn<typeof fetch>(async (input) => { requests.push(String(input instanceof Request ? input.url : input)); return new Response("{}", { status: 500 }); });
    const apiKey = vi.fn(async () => "chatgpt-access-token-0001");
    const runtime = await createConfiguredModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, { fetch: transport, apiKey, proxy });
    await runtime.streamSimple(runtime.getModel("openai", "gpt-5.4")!, context, { maxTokens: 16 }).result();
    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) expect(url.startsWith("https://api.openai.com/")).toBe(true);
    const payload = { model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, chatgpt: { model: { provider: "openai", modelId: "gpt-5.4" } } };
    expect((await resolveTaskSessionModel(payload, async () => "chatgpt-access-0001", environment, undefined, proxy)).model).toMatchObject({ provider: "openai", modelId: "gpt-5.4" });
    expect(source).not.toHaveBeenCalled();
  });

  it("runs its session on the proxy adapter, and leaves a task without a proxy on the default one", async () => {
    const proxied = await resolveTaskSessionModel({}, undefined, environment, undefined, { baseUrl: PROXY_URL, apiKey: PROXY_KEY });
    expect(proxied.piAdapter).toBeDefined();
    expect((await resolveTaskSessionModel({}, undefined, environment)).piAdapter).toBeUndefined();
  });

  it("keeps a ChatGPT task's plan direct, with the proxy only behind its fallback", async () => {
    const payload = { model: { provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, chatgpt: { model: { provider: "openai", modelId: "gpt-5.4" } } };
    const onPlan = await resolveTaskSessionModel(payload, async () => "chatgpt-access-0001", environment, undefined, { baseUrl: PROXY_URL, apiKey: PROXY_KEY });
    expect(onPlan.model).toMatchObject({ provider: "openai", modelId: "gpt-5.4" });
    expect(onPlan.piAdapter).toBeDefined();
  });
});

describe("GET /v1/internal/model-access", () => {
  function fakeModelAccess(failure?: Error) {
    const access = sharedFakeModelAccess({ key: PROXY_KEY, ...(failure === undefined ? {} : { mintFailure: failure }) });
    return { access, mintKey: access.mintKey };
  }

  async function runningTask(failure?: Error) {
    const { access, mintKey } = fakeModelAccess(failure);
    const harness = await createDeveloperTaskBroker({ brokerExtra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
    const taskId = (started.body.task as { taskId: string }).taskId;
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string };
    const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await harness.finish(task.workspaceId, active(), "SUCCEEDED");
    const operationId = active();
    const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    const ask = (header: string | null = capability) => call(harness.handler, { method: "GET", path: "/v1/internal/model-access", ...(header === null ? {} : { headers: { "x-agentx-callback-capability": header } }) });
    return { ...harness, task, taskId, operationId, capability, ask, mintKey };
  }

  // A task with no workflow starts at the TASK estimate's run limit, $10 without history (Task 34).
  it("mints a key for the task's org, developer and task, and answers where the proxy is", async () => {
    const h = await runningTask();
    const response = await h.ask();
    expect(response).toMatchObject({ status: 200, body: { baseUrl: PROXY_URL, apiKey: PROXY_KEY, expiresAt: Date.parse("2026-10-19T13:00:00.000Z") } });
    expect(h.mintKey).toHaveBeenCalledTimes(1);
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, developerId: MAYA.developerId, purpose: "task", refId: h.taskId, maxBudgetUsd: 10, ttlSeconds: 3600 });
  });

  it("uses the task record's own budget when it has one", async () => {
    const h = await runningTask();
    h.db.set({ ...h.task, budgetUsd: 7.5 });
    expect((await h.ask()).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 7.5 }));
  });

  it("grants the capability to a task operation and keeps the key out of the table", async () => {
    const h = await runningTask();
    const claims = JSON.parse(Buffer.from(h.capability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] };
    expect(claims.actions).toContain("model-access");
    await h.ask();
    expect(JSON.stringify(h.db.find(() => true))).not.toContain(PROXY_KEY);
  });

  it("refuses a missing, forged or wrongly scoped capability with 401, minting nothing", async () => {
    const h = await runningTask();
    const [body] = h.capability.split(".");
    expect((await h.ask(null)).status).toBe(401);
    expect((await h.ask("not-a-capability")).status).toBe(401);
    expect((await h.ask(`${body}.${Buffer.from("forged").toString("base64url")}`)).status).toBe(401);
    // A capability that does not grant model access (a signed one without the action) is refused too.
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as { actions: string[] };
    const resigned = Buffer.from(JSON.stringify({ ...claims, actions: claims.actions.filter((action) => action !== "model-access") })).toString("base64url");
    expect((await h.ask(`${resigned}.${h.capability.split(".")[1]}`)).status).toBe(401);
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it("answers 404 for a task whose record carries no org", async () => {
    const h = await runningTask();
    const withoutOrg = { ...h.task };
    delete withoutOrg.orgId;
    h.db.set(withoutOrg);
    const response = await h.ask();
    expect(response).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it("answers 503 MODEL_PROXY_UNAVAILABLE when the key cannot be minted", async () => {
    const h = await runningTask(agentXError("MODEL_PROXY_UNAVAILABLE", "model access could not be invoked"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await h.ask()).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE", message: "the model proxy could not issue a key" } } });
    } finally { log.mockRestore(); }
  });

  it("answers 503 MODEL_PROXY_UNAVAILABLE for any other failure of the invoker, without its detail", async () => {
    const h = await runningTask(new Error("socket hang up to 10.0.0.7"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await h.ask();
      expect(response).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
      expect(JSON.stringify(response.body)).not.toContain("10.0.0.7");
    } finally { log.mockRestore(); }
  });
});

describe("GET /v1/internal/model-access for a Slack thread's task, which has no developer task record", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  const slackUser = "U0123456789";
  beforeAll(loadSlackBroker);

  async function slackTask(agents = false, withIdentity = false) {
    const identity = withIdentity ? await createDeveloperTaskBroker({ register: false }) : undefined;
    const access = sharedFakeModelAccess({ key: PROXY_KEY });
    const mintKey = access.mintKey;
    const { handler, db } = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL }, ...(agents ? { agents: {} } : {}), ...(identity === undefined ? {} : { developer: identity.brokerInput.developer }) } });
    await registerSlackProject(handler);
    const workspace = await ensureWorkspace(handler, thread, slackUser);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, slackUser, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await serviceCall(handler, thread, slackUser, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    expect(task.status).toBe(202);
    const operationId = (task.body.operation as { id: string }).id;
    const capability = ((db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
    const ask = () => call(handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capability } });
    return { db, workspaceId, operationId, mintKey, ask };
  }

  it("mints an org-only key from the signed operation when the requester is no known member", async () => {
    const h = await slackTask();
    expect(await h.ask()).toMatchObject({ status: 200, body: { baseUrl: PROXY_URL, apiKey: PROXY_KEY } });
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, purpose: "task", refId: h.operationId, maxBudgetUsd: PER_TASK_BUDGET_USD, ttlSeconds: 3600 });
    expect(h.mintKey.mock.calls[0]![0]).not.toHaveProperty("developerId");
  });

  it("mints for the member the Slack requester is linked to", async () => {
    const h = await slackTask();
    seedMembership(h.db, developerIdForSlackUser(slackUser), { orgId: TEST_ORG, role: "member" });
    expect((await h.ask()).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, developerId: developerIdForSlackUser(slackUser), purpose: "task", refId: h.operationId, maxBudgetUsd: PER_TASK_BUDGET_USD, ttlSeconds: 3600 });
  });

  it.each([false, true])("refuses a new key after the Slack requester is removed, even without a payer setting (C1, agents=%s)", async (agents) => {
    const h = await slackTask(agents);
    const developerId = developerIdForSlackUser(slackUser);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "member" });
    expect((await h.ask()).status).toBe(200);
    h.mintKey.mockClear();
    h.db.delete(orgMemberKey(TEST_ORG, developerId));
    h.db.delete(developerOrgKey(developerId));
    h.db.set({ ...orgRemovedKey(TEST_ORG, developerId), orgId: TEST_ORG, developerId });
    const reply = await h.ask();
    expect(reply).toMatchObject({ status: 403, body: { error: { code: "TASK_ACCESS_DENIED" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it.each([false, true])("I1 refuses new keys after the merged requester account leaves (agents=%s)", async (agents) => {
    const h = await slackTask(agents, true);
    const raw = developerIdForSlackUser(slackUser);
    const survivor = "7".repeat(64);
    h.db.set({ pk: `DEVELOPER#${raw}`, sk: "META", developerId: raw, provider: "slack", displayName: "Synthetic requester", revoked: false, firstSignInAt: "x", lastSignInAt: "x", mergedInto: survivor });
    h.db.set({ pk: `DEVELOPER#${survivor}`, sk: "META", developerId: survivor, provider: "oidc", displayName: "Synthetic survivor", revoked: false, firstSignInAt: "x", lastSignInAt: "x" });
    seedMembership(h.db, survivor, { orgId: TEST_ORG, role: "member" });
    expect((await h.ask()).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledOnce();
    h.mintKey.mockClear();
    h.db.delete(orgMemberKey(TEST_ORG, survivor));
    h.db.delete(developerOrgKey(survivor));
    h.db.set({ ...orgRemovedKey(TEST_ORG, survivor), orgId: TEST_ORG, developerId: survivor });
    const before = h.db.commandNames().length;
    expect(await h.ask()).toMatchObject({ status: 403, body: { error: { code: "TASK_ACCESS_DENIED" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
    expect(h.db.commandNames().slice(before).filter((name) => /^(Put|Update|Delete|TransactWrite)/.test(name))).toEqual([]);
  });

  it("answers 404 when the operation names no org", async () => {
    const h = await slackTask();
    const operation = { ...(h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${h.operationId}`) as Record<string, unknown>) };
    delete operation.orgId;
    h.db.set(operation);
    expect(await h.ask()).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
  });
});
