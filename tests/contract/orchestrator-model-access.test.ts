// Task 13: the Slack orchestrator calls models with a key minted for one turn, for the org its Slack team is bound to.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { agentXError, type SlackRequestMessage, type SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import type { MintKeyInput, MintedKey, ModelAccess } from "../../packages/broker/src/model-proxy/access.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { createModelClassifier } from "../../packages/orchestrator/src/action-classifier.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { createModelRequestRouter } from "../../packages/orchestrator/src/request-router.js";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { TURN_ACCESS_MARGIN_MS, turnModelAccessSource, turnModelProxy } from "../../packages/slack-service/src/model-access.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { threadWorkspaceRequest } from "../../packages/slack-service/src/thread-workspace-request.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, orchestratorPrincipal, registerSlackProject, type Handler } from "../support/slack-broker.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const TURN_KEY = "sk-proxy-per-turn-key-0001";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-6";
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const SLACK_USER = "U0123456789";
const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

beforeAll(async () => { await loadSlackBroker(); });
beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

function fakeModelAccess(failure?: Error) {
  const mintKey = vi.fn<(input: MintKeyInput) => Promise<MintedKey>>(async () => {
    if (failure !== undefined) throw failure;
    return { key: TURN_KEY, expiresAt: Date.now() + 900_000 };
  });
  const access: ModelAccess = { upsertOrg: vi.fn(), upsertMember: vi.fn(), spend: vi.fn(), mintKey, revokeKey: vi.fn() };
  return { access, mintKey };
}

/** A single-org install whose channel is bound, so the thread's team is bound to the install's org. */
async function boundInstall(failure?: Error) {
  const { access, mintKey } = fakeModelAccess(failure);
  const harness = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL } } });
  await registerSlackProject(harness.handler);
  return { ...harness, mintKey };
}

const bodyText = (init: RequestInit | undefined): string => typeof init?.body === "string" ? init.body : "";

const askFor = (handler: Handler, body: unknown, options: { thread?: string; principal?: string } = {}) => call(handler, {
  method: "POST",
  path: "/v1/service/model-access",
  service: { principal: options.principal ?? orchestratorPrincipal, thread: options.thread ?? THREAD, slackUser: SLACK_USER },
  body,
});

describe("POST /v1/service/model-access", () => {
  it("mints a turn key for the org the thread's team is bound to, with the turn as its reference", async () => {
    const h = await boundInstall();
    const turnId = `Ev${randomUUID().slice(0, 8)}`;
    const answer = await askFor(h.handler, { orgId: TEST_ORG, turnId });
    expect(answer).toMatchObject({ status: 200, body: { baseUrl: PROXY_URL, apiKey: TURN_KEY, expiresAt: expect.any(Number) as number } });
    expect(h.mintKey).toHaveBeenCalledTimes(1);
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, purpose: "turn", refId: turnId, maxBudgetUsd: 2, ttlSeconds: 900 });
    expect(h.mintKey.mock.calls[0]![0]).not.toHaveProperty("developerId");
  });

  it("mints in the Slack user's name when the org has them as a member", async () => {
    const h = await boundInstall();
    seedMembership(h.db, developerIdForSlackUser(SLACK_USER), { orgId: TEST_ORG, role: "member" });
    expect((await askFor(h.handler, { orgId: TEST_ORG, slackUserId: SLACK_USER, turnId: "Ev1" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, developerId: developerIdForSlackUser(SLACK_USER), purpose: "turn", refId: "Ev1", maxBudgetUsd: 2, ttlSeconds: 900 });
  });

  it("mints for the org alone when the Slack user is no member of it, or of any org", async () => {
    const h = await boundInstall();
    expect((await askFor(h.handler, { orgId: TEST_ORG, slackUserId: SLACK_USER, turnId: "Ev1" })).status).toBe(200);
    seedMembership(h.db, developerIdForSlackUser(SLACK_USER), { orgId: ORG_B, role: "member" });
    expect((await askFor(h.handler, { orgId: TEST_ORG, slackUserId: SLACK_USER, turnId: "Ev2" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledTimes(2);
    for (const [input] of h.mintKey.mock.calls) expect(input).not.toHaveProperty("developerId");
  });

  it("refuses a body whose org is not the team's org with FORBIDDEN, and mints nothing", async () => {
    const h = await boundInstall();
    const refused = await askFor(h.handler, { orgId: ORG_B, slackUserId: SLACK_USER, turnId: "Ev1" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
    expect(JSON.stringify(refused.body)).not.toContain(TURN_KEY);
  });

  it("answers for the org of each team in a two-org install, and refuses the other's", async () => {
    const h = await boundInstall();
    const store = new OrgStore({ documentClient: h.db, tableName: "state", now: Date.now });
    await store.bindSlackTeam({ orgId: ORG_A, teamId: "T0TEAMAAAA1" });
    const otherThread = `T0TEAMAAAA1/${SLACK_CHANNEL}/1695500000.000001`;
    expect((await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" }, { thread: otherThread })).status).toBe(403);
    expect(h.mintKey).not.toHaveBeenCalled();
    expect((await askFor(h.handler, { orgId: ORG_A, turnId: "Ev1" }, { thread: otherThread })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_A }));
    // The first team's own org is refused from the second team's thread and answered from its own.
    expect((await askFor(h.handler, { orgId: ORG_A, turnId: "Ev2" })).status).toBe(403);
    expect(h.mintKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a thread from a team bound to no org, minting nothing", async () => {
    const h = await boundInstall();
    const refused = await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" }, { thread: `T0UNBOUND01/${SLACK_CHANNEL}/1695500000.000001` });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "SLACK_TEAM_NOT_BOUND" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it("is for the orchestrator role alone", async () => {
    const h = await boundInstall();
    const other = `arn:aws:sts::111122223333:assumed-role/SomeoneElse/session`;
    expect((await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" }, { principal: other })).status).toBe(403);
    expect((await call(h.handler, { method: "POST", path: "/v1/service/model-access", body: { orgId: TEST_ORG, turnId: "Ev1" } })).status).toBeGreaterThanOrEqual(401);
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown field", { orgId: TEST_ORG, turnId: "Ev1", maxBudgetUsd: 1000 }],
    ["no turn", { orgId: TEST_ORG }],
    ["no org", { turnId: "Ev1" }],
    ["a malformed org", { orgId: "not-an-org", turnId: "Ev1" }],
    ["a malformed Slack user", { orgId: TEST_ORG, slackUserId: "someone", turnId: "Ev1" }],
  ])("refuses %s with CONFIG_INVALID, minting nothing", async (_name, body) => {
    const h = await boundInstall();
    expect(await askFor(h.handler, body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it("answers 503 MODEL_PROXY_UNAVAILABLE when the key cannot be minted, without the invoker's detail or any key", async () => {
    const h = await boundInstall(new Error("socket hang up to 10.0.0.7"));
    const refused = await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" });
    expect(refused).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE", message: "the model proxy could not issue a key" } } });
    expect(JSON.stringify(refused.body)).not.toContain("10.0.0.7");
  });

  it("answers 503 MODEL_PROXY_UNAVAILABLE for the invoker's own coded failure", async () => {
    const h = await boundInstall(agentXError("MODEL_PROXY_UNAVAILABLE", "model access could not be invoked"));
    expect((await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" })).status).toBe(503);
  });

  it("answers 503 where no model proxy is set up, after the org check", async () => {
    const harness = createBroker();
    await registerSlackProject(harness.handler);
    expect(await askFor(harness.handler, { orgId: TEST_ORG, turnId: "Ev1" })).toMatchObject({ status: 503, body: { error: { code: "MODEL_PROXY_UNAVAILABLE" } } });
    expect(await askFor(harness.handler, { orgId: ORG_B, turnId: "Ev1" })).toMatchObject({ status: 403 });
  });

  it("never logs the key", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = await boundInstall();
    await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TURN_KEY);
    const failing = await boundInstall(new Error(`failed for ${TURN_KEY}`));
    await askFor(failing.handler, { orgId: TEST_ORG, turnId: "Ev1" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TURN_KEY);
  });
});

describe("POST /v1/service/threads/workspace tells the org only to a service that asks", () => {
  it("adds orgId to a WORKSPACE answer for includeOrgId: true, and leaves it out otherwise", async () => {
    const h = await boundInstall();
    const plain = await ensureWorkspace(h.handler, THREAD, SLACK_USER);
    expect(plain.body).toMatchObject({ outcome: "WORKSPACE" });
    expect(plain.body).not.toHaveProperty("orgId");
    const asked = await call(h.handler, {
      method: "POST", path: "/v1/service/threads/workspace", service: { principal: orchestratorPrincipal, thread: THREAD, slackUser: SLACK_USER },
      body: threadWorkspaceRequest(randomUUID(), { includeOrgId: true }),
    });
    expect(asked.body).toMatchObject({ outcome: "WORKSPACE", orgId: TEST_ORG });
  });

  it("is sent by the Slack service's thread API only when it is asked to", async () => {
    const sent: unknown[] = [];
    const respond = async (_url: unknown, init?: RequestInit): Promise<Response> => {
      sent.push(JSON.parse(bodyText(init)));
      return new Response(JSON.stringify({ outcome: "WORKSPACE", workspaceId: randomUUID(), status: "READY", operationId: null, created: false, orchestratorInstructions: "x", orgId: TEST_ORG }), { status: 200 });
    };
    await createThreadApi({ controlPlaneUrl: "https://api.example.test", signedFetch: respond }).ensureWorkspace(randomUUID());
    await createThreadApi({ controlPlaneUrl: "https://api.example.test", signedFetch: respond, includeOrgId: true }).ensureWorkspace(randomUUID());
    expect(sent[0]).not.toHaveProperty("includeOrgId");
    expect(sent[1]).toMatchObject({ includeOrgId: true });
  });
});

/** The orchestrator's signed fetch, answered by the broker: the service prefix and the thread headers, as createSignedServiceFetch adds them. */
function signedFetchTo(handler: Handler, onRequest?: (body: unknown) => void): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    onRequest?.(body);
    const response = await call(handler, {
      method: init?.method ?? "GET", path: `/v1/service${url.pathname.slice("/v1".length)}`,
      service: { principal: orchestratorPrincipal, thread: THREAD, slackUser: SLACK_USER }, ...(body === undefined ? {} : { body }),
    });
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
  };
}

describe("a turn's model access in the Slack service", () => {
  it("asks once for the turn and builds the runtime with the key the control plane returned", async () => {
    const h = await boundInstall();
    const requests: unknown[] = [];
    const source = turnModelAccessSource({ controlPlaneUrl: "https://api.example.test/", signedFetch: signedFetchTo(h.handler, (body) => requests.push(body)), orgId: TEST_ORG, slackUserId: SLACK_USER, turnId: "Ev42" });
    const proxy = await turnModelProxy(source);
    const seen: Array<{ url: string; key: string | null }> = [];
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      seen.push({ url: String(input instanceof Request ? input.url : input), key: new Headers(init?.headers).get("x-api-key") });
      return new Response("{}", { status: 500 });
    });
    const runtime = await createConfiguredModelRuntime({ provider: "amazon-bedrock", modelId: BEDROCK_MODEL }, { fetch: transport, proxy, onUsage: () => undefined });
    await runtime.streamSimple(runtime.getModel("amazon-bedrock", BEDROCK_MODEL)!, context, { maxTokens: 16 }).result();
    await runtime.streamSimple(runtime.getModel("amazon-bedrock", BEDROCK_MODEL)!, context, { maxTokens: 16 }).result();
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) expect(request).toMatchObject({ key: TURN_KEY });
    expect(new URL(seen[0]!.url).origin).toBe(PROXY_URL);
    expect(requests).toEqual([{ orgId: TEST_ORG, slackUserId: SLACK_USER, turnId: "Ev42" }]);
    expect(h.mintKey).toHaveBeenCalledTimes(1);
  });

  it("builds the orchestrator, the classifier and the router of one turn from the same single mint", async () => {
    const h = await boundInstall();
    const source = turnModelAccessSource({ controlPlaneUrl: "https://api.example.test", signedFetch: signedFetchTo(h.handler), orgId: TEST_ORG, turnId: "Ev42" });
    const proxy = await turnModelProxy(source);
    const model = { provider: "amazon-bedrock", modelId: BEDROCK_MODEL };
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-turn-access-"), projectInstructions: "Delegate.", api: {} as never,
      context: { workspaceId: randomUUID(), conversationId: randomUUID() }, model, answerOnly: true, proxy,
    });
    try {
      await createModelClassifier({ model, proxy, failOnUnknownModel: true });
      await createModelRequestRouter({ model, proxy, failOnUnknownModel: true });
    } finally {
      await runtime.dispose();
    }
    expect(h.mintKey).toHaveBeenCalledTimes(1);
  });

  it("passes the proxy to every runtime of the turn: a model the proxy does not serve is refused, and no secret is read", async () => {
    const apiKey = vi.fn(async () => TURN_KEY);
    const proxy = { baseUrl: PROXY_URL, apiKey };
    const unserved = { provider: "openai", modelId: "gpt-5.4" };
    const refusal = { code: "CONFIG_INVALID" };
    await expect(createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-turn-access-"), projectInstructions: "Delegate.", api: {} as never,
      context: { workspaceId: randomUUID(), conversationId: randomUUID() }, model: unserved, answerOnly: true, proxy,
    })).rejects.toMatchObject(refusal);
    await expect(createModelClassifier({ model: unserved, proxy })).rejects.toMatchObject(refusal);
    await expect(createModelRequestRouter({ model: unserved, proxy })).rejects.toMatchObject(refusal);
    expect(apiKey).not.toHaveBeenCalled();
  });

  it("keeps the current behaviour with no proxy: the runtimes are built as before", async () => {
    const model = { provider: "amazon-bedrock", modelId: BEDROCK_MODEL };
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-turn-access-"), projectInstructions: "Delegate.", api: {} as never,
      context: { workspaceId: randomUUID(), conversationId: randomUUID() }, model, answerOnly: true,
    });
    await runtime.dispose();
    await expect(createModelClassifier({ model, failOnUnknownModel: true })).resolves.toBeTypeOf("function");
    await expect(createModelRequestRouter({ model, failOnUnknownModel: true })).resolves.toBeTypeOf("function");
  });
});

describe("turnModelAccessSource", () => {
  const answer = (key: string, expiresAt: number) => new Response(JSON.stringify({ baseUrl: PROXY_URL, apiKey: key, expiresAt }), { status: 200, headers: { "content-type": "application/json" } });
  const input = (signedFetch: typeof fetch, now: () => number) => ({ controlPlaneUrl: "https://api.example.test/", signedFetch, orgId: TEST_ORG, slackUserId: SLACK_USER, turnId: "Ev1", now });

  it("posts the org, user and turn to the model-access route, and caches until a minute before expiry", async () => {
    let now = 1_000_000;
    const expiresAt = now + 900_000;
    const signed = vi.fn<typeof fetch>(async () => answer("sk-proxy-a", expiresAt));
    const source = turnModelAccessSource(input(signed, () => now));
    expect(await source()).toEqual({ baseUrl: PROXY_URL, apiKey: "sk-proxy-a", expiresAt });
    await source();
    expect(signed).toHaveBeenCalledTimes(1);
    const [url, init] = signed.mock.calls[0]!;
    expect(url).toBe("https://api.example.test/v1/model-access");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(bodyText(init))).toEqual({ orgId: TEST_ORG, slackUserId: SLACK_USER, turnId: "Ev1" });
    now = expiresAt - TURN_ACCESS_MARGIN_MS - 1;
    await source();
    expect(signed).toHaveBeenCalledTimes(1);
    now = expiresAt - TURN_ACCESS_MARGIN_MS;
    signed.mockImplementationOnce(async () => answer("sk-proxy-b", expiresAt + 900_000));
    expect(await source()).toMatchObject({ apiKey: "sk-proxy-b" });
    expect(signed).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const signed = vi.fn<typeof fetch>(async () => answer("sk-proxy-a", Date.now() + 900_000));
    const source = turnModelAccessSource(input(signed, Date.now));
    await Promise.all([source(), source(), source()]);
    expect(signed).toHaveBeenCalledTimes(1);
  });

  it("fails without echoing the control plane's words, and tries again after a failure", async () => {
    const signed = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "MODEL_PROXY_UNAVAILABLE", message: `secret detail ${TURN_KEY}` } }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "other org" } }), { status: 403 }))
      .mockResolvedValueOnce(answer("sk-proxy-a", Date.now() + 900_000));
    const source = turnModelAccessSource(input(signed, Date.now));
    const unavailable = await source().catch((error: unknown) => error as Error);
    expect(unavailable).toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
    expect(String((unavailable as Error).message)).not.toContain("secret detail");
    expect(await source().catch((error: unknown) => error)).toMatchObject({ code: "FORBIDDEN" });
    expect(await source()).toMatchObject({ apiKey: "sk-proxy-a" });
  });

  it.each([
    ["no key", { baseUrl: PROXY_URL, expiresAt: 1 }],
    ["a key with a space", { baseUrl: PROXY_URL, apiKey: "sk bad", expiresAt: 1 }],
    ["a base URL that is not http(s)", { baseUrl: "file:///etc/passwd", apiKey: "sk-ok-key", expiresAt: 1 }],
    ["no expiry", { baseUrl: PROXY_URL, apiKey: "sk-ok-key" }],
  ])("refuses an answer with %s", async (_name, body) => {
    const source = turnModelAccessSource(input(async () => new Response(JSON.stringify(body), { status: 200 }), Date.now));
    await expect(source()).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
  });
});

describe("the turn the processor hands the Slack service", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const conversationId = "33333333-3333-4333-8333-333333333333";
  const message: SlackRequestMessage = {
    version: 1, eventId: "EvORG000001", receivedAt: "2026-09-24T10:00:00.000Z", userId: SLACK_USER,
    thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }, text: "list open items",
  };
  const turnFor = async (workspace: SlackThreadWorkspaceResult) => {
    const turns: TurnInput[] = [];
    const dependencies: ProcessorDependencies = {
      api: () => ({
        ensureWorkspace: async () => workspace, startClose: async () => ({ outcome: "NOT_FOUND" }), completeClose: vi.fn(), waitForOperation: vi.fn(),
        createConversation: async () => conversationId,
      }),
      threads: { load: async () => ({ workspaceId, conversationId }), saveConversation: vi.fn(), saveSettingsRevision: vi.fn(), close: vi.fn(), finish: vi.fn(async () => undefined) },
      runTurn: async (input) => { turns.push(input); return "done"; },
      post: async () => undefined,
    };
    await processSlackRequest(message, dependencies, { finalAttempt: false });
    return turns[0]!;
  };
  const answered = { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate coding." } as const;

  it("carries the org the control plane named, so the key is asked for in it", async () => {
    expect(await turnFor({ ...answered, orgId: TEST_ORG })).toMatchObject({ orgId: TEST_ORG });
  });

  it("carries no org when the control plane named none", async () => {
    expect(await turnFor(answered)).not.toHaveProperty("orgId");
  });
});
