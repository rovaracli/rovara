// Task 13: the Slack orchestrator calls models with a key minted for one turn, for the org its Slack team is bound to.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { agentXError, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import type { OrgId } from "../../packages/contracts/src/org-node.js";
import type { MemberSpend, MintKeyInput, MintedKey, ModelAccess } from "../../packages/broker/src/model-proxy/access.js";
import { slackBindingKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { orgBanKey, orgMemberKey, orgRemovedKey } from "../../packages/contracts/src/index.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { createModelClassifier } from "../../packages/orchestrator/src/action-classifier.js";
import { ClassifierError } from "@agentx/orchestrator/action-classifier";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { createModelRequestRouter } from "../../packages/orchestrator/src/request-router.js";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { TURN_ACCESS_MARGIN_MS, turnModelAccessSource, turnModelProxy } from "../../packages/slack-service/src/model-access.js";
import { createProxiedModels } from "../../packages/slack-service/src/proxied-models.js";
import { routeSlackRequest } from "../../packages/slack-service/src/request-routing.js";
import { createHostedClassifier, createHostedRequestRouter } from "../../packages/slack-service/src/runtime.js";
import { runTaskAnswer } from "../../packages/slack-service/src/task-question.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, loadSlackBroker, orchestratorPrincipal, registerSlackProject, type Handler } from "../support/slack-broker.js";

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

/** What the proxy says has been spent so far this month, against the placeholder limits of $29 a member and $500 an org (a cloud install's). */
interface Spent { member?: number; org?: number }

function fakeModelAccess(failure?: Error, spent: Spent = {}) {
  const mintKey = vi.fn<(input: MintKeyInput) => Promise<MintedKey>>(async () => {
    if (failure !== undefined) throw failure;
    return { key: TURN_KEY, expiresAt: Date.now() + 900_000 };
  });
  const orgFigures = () => ({ spentUsd: spent.org ?? 0, limitUsd: 500 });
  const spend = vi.fn(async (): Promise<MemberSpend> => ({ member: { spentUsd: spent.member ?? 0, limitUsd: 29 }, org: orgFigures() }));
  const orgSpend = vi.fn(async () => orgFigures());
  const access: ModelAccess = { upsertOrg: vi.fn(), upsertMember: vi.fn(), spend, orgSpend, keySpend: vi.fn(), mintKey, revokeKey: vi.fn(), blockKey: vi.fn(), upsertSource: vi.fn(), removeSource: vi.fn(), checkSource: vi.fn(), listSources: vi.fn(), auditKeys: vi.fn() };
  return { access, mintKey, spend, orgSpend };
}

/** A cloud install whose channel is bound, so the thread's team is bound to the install's org. */
async function boundInstall(failure?: Error, spent: Spent = {}) {
  const { access, mintKey, spend, orgSpend } = fakeModelAccess(failure, spent);
  const harness = createBroker({ extra: { modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  await registerSlackProject(harness.handler);
  return { ...harness, mintKey, spend, orgSpend };
}

const bodyText = (init: RequestInit | undefined): string => typeof init?.body === "string" ? init.body : "";

const askFor = (handler: Handler, body: unknown, options: { thread?: string; principal?: string; user?: string } = {}) => call(handler, {
  method: "POST",
  path: "/v1/service/model-access",
  service: { principal: options.principal ?? orchestratorPrincipal, thread: options.thread ?? THREAD, slackUser: options.user ?? SLACK_USER },
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

  it("refuses an Auditor, a removed member, a banned member and a record with no role before routing, admitting or minting: no key, no spend read, nothing reserved", async () => {
    const guest = developerIdForSlackUser(SLACK_USER);
    const cases: Array<[string, (h: Awaited<ReturnType<typeof boundInstall>>) => void]> = [
      ["an Auditor", (h) => seedMembership(h.db, guest, { orgId: TEST_ORG, role: "auditor" })],
      ["a removed member", (h) => h.db.set({ ...orgRemovedKey(TEST_ORG, guest), orgId: TEST_ORG, developerId: guest })],
      ["a banned member", (h) => h.db.set({ ...orgBanKey(TEST_ORG, guest), orgId: TEST_ORG, developerId: guest })],
      ["a record with no role", (h) => h.db.set({ ...orgMemberKey(TEST_ORG, guest), orgId: TEST_ORG, developerId: guest })],
    ];
    for (const [label, arrange] of cases) {
      const h = await boundInstall();
      arrange(h);
      const refused = await askFor(h.handler, { turnId: "Ev1" });
      expect(refused.status, label).toBe(403);
      expect(h.mintKey, label).not.toHaveBeenCalled();
      expect(h.spend, label).not.toHaveBeenCalled();
      expect(h.orgSpend, label).not.toHaveBeenCalled();
      expect(h.db.find((item) => String(item.entityType).includes("RESERV") || String(item.entityType).includes("KEY")), label).toEqual([]);
    }
  });

  it("mints for the team's org when the body names no org (R32), and for the org alone", async () => {
    const h = await boundInstall();
    expect((await askFor(h.handler, { turnId: "Ev1" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, purpose: "turn", refId: "Ev1", maxBudgetUsd: 2, ttlSeconds: 900 });
  });

  it("mints in the name of the member the signed Slack user header names, when the org has them as a member", async () => {
    const h = await boundInstall();
    seedMembership(h.db, developerIdForSlackUser(SLACK_USER), { orgId: TEST_ORG, role: "member" });
    expect((await askFor(h.handler, { turnId: "Ev1" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, developerId: developerIdForSlackUser(SLACK_USER), purpose: "turn", refId: "Ev1", maxBudgetUsd: 2, ttlSeconds: 900 });
  });

  it("clamps the key to what the linked member has left when that is under a turn's $2 (R50), and admits the turn as chat work", async () => {
    const h = await boundInstall(undefined, { member: 28 });
    seedMembership(h.db, developerIdForSlackUser(SLACK_USER), { orgId: TEST_ORG, role: "member" });
    expect((await askFor(h.handler, { turnId: "Ev1" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith(expect.objectContaining({ developerId: developerIdForSlackUser(SLACK_USER), maxBudgetUsd: 1 }));
    // Plenty left: the turn's own allowance.
    const rich = await boundInstall(undefined, { member: 5 });
    seedMembership(rich.db, developerIdForSlackUser(SLACK_USER), { orgId: TEST_ORG, role: "member" });
    expect((await askFor(rich.handler, { turnId: "Ev1" })).status).toBe(200);
    expect(rich.mintKey).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 2 }));
  });

  it("clamps an unlinked requester's key to what the org has left, asking the proxy about the org alone", async () => {
    const h = await boundInstall(undefined, { org: 499.25, member: 29 });
    expect((await askFor(h.handler, { turnId: "Ev1" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledWith(expect.objectContaining({ maxBudgetUsd: 0.75 }));
    expect(h.mintKey.mock.calls[0]![0]).not.toHaveProperty("developerId");
    expect(h.spend).not.toHaveBeenCalled();
    expect(h.orgSpend).toHaveBeenCalled();
  });

  it("answers 402 and mints nothing when the member or the org has nothing left, or less than a chat turn's minimum", async () => {
    const member = await boundInstall(undefined, { member: 29 });
    seedMembership(member.db, developerIdForSlackUser(SLACK_USER), { orgId: TEST_ORG, role: "member" });
    expect(await askFor(member.handler, { turnId: "Ev1" })).toMatchObject({ status: 402, body: { error: { code: "BUDGET_EXCEEDED" } } });
    const org = await boundInstall(undefined, { org: 500 });
    expect(await askFor(org.handler, { turnId: "Ev1" })).toMatchObject({ status: 402, body: { error: { code: "ORG_BUDGET_EXCEEDED" } } });
    const nearly = await boundInstall(undefined, { org: 499.97 });
    expect((await askFor(nearly.handler, { turnId: "Ev1" })).status).toBe(402);
    for (const h of [member, org, nearly]) expect(h.mintKey).not.toHaveBeenCalled();
  });

  it("takes the member from the header alone: another member's key cannot be asked for in the body", async () => {
    const h = await boundInstall();
    const other = "U0OTHERUSER1";
    seedMembership(h.db, developerIdForSlackUser(other), { orgId: TEST_ORG, role: "member" });
    expect(await askFor(h.handler, { orgId: TEST_ORG, slackUserId: other, turnId: "Ev1" })).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
    // The header's own user is no member, so the key answers to the org alone, whoever else the org has.
    expect((await askFor(h.handler, { turnId: "Ev2" })).status).toBe(200);
    expect(h.mintKey.mock.calls[0]![0]).not.toHaveProperty("developerId");
    expect((await askFor(h.handler, { turnId: "Ev3" }, { user: other })).status).toBe(200);
    expect(h.mintKey.mock.calls[1]![0]).toMatchObject({ developerId: developerIdForSlackUser(other) });
  });

  it("mints for the org alone when the Slack user is no member of it, or of any org", async () => {
    const h = await boundInstall();
    expect((await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" })).status).toBe(200);
    seedMembership(h.db, developerIdForSlackUser(SLACK_USER), { orgId: ORG_B, role: "member" });
    expect((await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev2" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenCalledTimes(2);
    for (const [input] of h.mintKey.mock.calls) expect(input).not.toHaveProperty("developerId");
  });

  it("refuses a body whose org is not the team's org with FORBIDDEN, and mints nothing", async () => {
    const h = await boundInstall();
    const refused = await askFor(h.handler, { orgId: ORG_B, turnId: "Ev1" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
    expect(JSON.stringify(refused.body)).not.toContain(TURN_KEY);
  });

  it("answers for the org of each team in a two-org install, and refuses the other's", async () => {
    const h = await boundInstall();
    const store = new OrgStore({ documentClient: h.db, tableName: "state", now: Date.now });
    await store.bindSlackTeam({ orgId: ORG_A, teamId: "T0TEAMAAAA1" });
    const channelOfA = { ...slackBindingKey(ORG_A, "T0TEAMAAAA1", SLACK_CHANNEL), teamId: "T0TEAMAAAA1", channelId: SLACK_CHANNEL, projectName: "payments", entityType: "SLACK_BINDING", updatedAt: "2026-09-23T21:00:00.000Z" };
    h.db.set(channelOfA);
    const otherThread = `T0TEAMAAAA1/${SLACK_CHANNEL}/1695500000.000001`;
    expect((await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" }, { thread: otherThread })).status).toBe(403);
    expect(h.mintKey).not.toHaveBeenCalled();
    expect((await askFor(h.handler, { orgId: ORG_A, turnId: "Ev1" }, { thread: otherThread })).status).toBe(200);
    expect(h.mintKey).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: ORG_A }));
    // With no org in the body, each team's key is for its own org.
    expect((await askFor(h.handler, { turnId: "Ev3" }, { thread: otherThread })).status).toBe(200);
    expect(h.mintKey).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: ORG_A }));
    expect((await askFor(h.handler, { turnId: "Ev4" })).status).toBe(200);
    expect(h.mintKey).toHaveBeenLastCalledWith(expect.objectContaining({ orgId: TEST_ORG }));
    // The first team's own org is refused from the second team's thread.
    expect((await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev2" }, { thread: otherThread })).status).toBe(403);
    expect(h.mintKey).toHaveBeenCalledTimes(3);
  });

  it("refuses a thread from a team bound to no org, minting nothing", async () => {
    const h = await boundInstall();
    const refused = await askFor(h.handler, { orgId: TEST_ORG, turnId: "Ev1" }, { thread: `T0UNBOUND01/${SLACK_CHANNEL}/1695500000.000001` });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "SLACK_TEAM_NOT_BOUND" } } });
    expect(h.mintKey).not.toHaveBeenCalled();
  });

  it("refuses a channel bound to no project in the team's org, with or without an org in the body, minting nothing", async () => {
    const h = await boundInstall();
    const unbound = `${SLACK_TEAM}/C0UNBOUND01/1695500000.000001`;
    for (const body of [{ turnId: "Ev1" }, { orgId: TEST_ORG, turnId: "Ev1" }]) {
      expect(await askFor(h.handler, body, { thread: unbound })).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Slack channel is not bound to a project" } } });
    }
    // A binding another org holds for that channel name does not make it bound in this team's org.
    h.db.set({ ...slackBindingKey(ORG_B, SLACK_TEAM, "C0UNBOUND01"), teamId: SLACK_TEAM, channelId: "C0UNBOUND01", projectName: "payments", entityType: "SLACK_BINDING", updatedAt: "2026-09-23T21:00:00.000Z" });
    expect((await askFor(h.handler, { turnId: "Ev1" }, { thread: unbound })).status).toBe(403);
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
    ["a malformed org", { orgId: "not-an-org", turnId: "Ev1" }],
    ["a Slack user in the body", { orgId: TEST_ORG, slackUserId: "U0123456789", turnId: "Ev1" }],
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

/** The orchestrator's signed fetch, answered by the broker: the service prefix and the thread headers, as createSignedServiceFetch adds them. */
function signedFetchTo(handler: Handler, onRequest?: (body: unknown) => void, as: { thread: string; user: string } = { thread: THREAD, user: SLACK_USER }): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    onRequest?.(body);
    const response = await call(handler, {
      method: init?.method ?? "GET", path: `/v1/service${url.pathname.slice("/v1".length)}`,
      service: { principal: orchestratorPrincipal, thread: as.thread, slackUser: as.user }, ...(body === undefined ? {} : { body }),
    });
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
  };
}

describe("a turn's model access in the Slack service", () => {
  it("asks once for the turn and builds the runtime with the key the control plane returned", async () => {
    const h = await boundInstall();
    const requests: unknown[] = [];
    const source = turnModelAccessSource({ controlPlaneUrl: "https://api.example.test/", signedFetch: signedFetchTo(h.handler, (body) => requests.push(body)), turnId: "Ev42" });
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
    expect(requests).toEqual([{ turnId: "Ev42" }]);
    expect(h.mintKey).toHaveBeenCalledTimes(1);
  });

  it("builds the orchestrator, the classifier and the router of one turn from the same single mint", async () => {
    const h = await boundInstall();
    const source = turnModelAccessSource({ controlPlaneUrl: "https://api.example.test", signedFetch: signedFetchTo(h.handler), turnId: "Ev42" });
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
  const input = (signedFetch: typeof fetch, now: () => number) => ({ controlPlaneUrl: "https://api.example.test/", signedFetch, orgId: TEST_ORG, turnId: "Ev1", now });

  it("posts the org and turn to the model-access route, and caches until a minute before expiry", async () => {
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
    expect(JSON.parse(bodyText(init))).toEqual({ orgId: TEST_ORG, turnId: "Ev1" });
    now = expiresAt - TURN_ACCESS_MARGIN_MS - 1;
    await source();
    expect(signed).toHaveBeenCalledTimes(1);
    now = expiresAt - TURN_ACCESS_MARGIN_MS;
    signed.mockImplementationOnce(async () => answer("sk-proxy-b", expiresAt + 900_000));
    expect(await source()).toMatchObject({ apiKey: "sk-proxy-b" });
    expect(signed).toHaveBeenCalledTimes(2);
  });

  it("tells the control plane the models the turn will call, so it can route the orchestrator's and keep the classifier on Rovara's catalog (Task 26)", async () => {
    const signed = vi.fn<typeof fetch>(async () => answer("sk-proxy-a", Date.now() + 900_000));
    const orchestrator = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
    const classifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" };
    await turnModelAccessSource({ ...input(signed, Date.now), models: { orchestrator, classifier } })();
    expect(JSON.parse(bodyText(signed.mock.calls[0]![1]))).toEqual({ orgId: TEST_ORG, turnId: "Ev1", model: orchestrator, classifierModel: classifier });
    // A service that names none sends none: the control plane assumes the install's defaults.
    const bare = vi.fn<typeof fetch>(async () => answer("sk-proxy-b", Date.now() + 900_000));
    await turnModelAccessSource({ ...input(bare, Date.now), models: { classifier } })();
    expect(JSON.parse(bodyText(bare.mock.calls[0]![1]))).toEqual({ orgId: TEST_ORG, turnId: "Ev1", classifierModel: classifier });
  });

  describe("a refusal for want of a model (Task 26 review I3)", () => {
    const TEXT = "Your company's AI sources don't include Rovara's AI, so Slack has no model to answer with. Ask an admin to set an assistant model.";
    const refused = (status: number, code: string, message: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code, message } }), { status }));
    const failure = async (signed: typeof fetch): Promise<{ code: string; message: string }> => {
      try { await turnModelAccessSource(input(signed, Date.now))(); } catch (error) { return error as { code: string; message: string }; }
      throw new Error("expected a refusal");
    };

    it("passes MODEL_NOT_ALLOWED and its words through, so the member is told what to ask for", async () => {
      expect(await failure(refused(403, "MODEL_NOT_ALLOWED", TEXT))).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: `MODEL_NOT_ALLOWED: ${TEXT}` });
    });

    it("keeps the words bounded and free of control characters", async () => {
      const error = await failure(refused(403, "MODEL_NOT_ALLOWED", `Ask\u001b[31m an\u0000 admin ${"x".repeat(900)}`));
      expect(error.code).toBe("MODEL_NOT_ALLOWED");
      expect(error.message).not.toMatch(/\p{Cc}/u);
      expect(error.message.length).toBeLessThanOrEqual(330);
    });

    it("shows a user mention, a channel mention or a link in the words as plain text", async () => {
      const error = await failure(refused(403, "MODEL_NOT_ALLOWED", "Ask <@U123ABC> or <!here> in <#C0123|ops>, see <https://evil.example/x|the docs>."));
      expect(error.message).toBe("MODEL_NOT_ALLOWED: Ask @U123ABC or !here in #C0123|ops, see https://evil.example/x|the docs.");
    });

    it("still hides every other refusal behind its code alone", async () => {
      expect(await failure(refused(403, "FORBIDDEN", "secret detail"))).toMatchObject({ code: "FORBIDDEN", message: expect.not.stringContaining("secret detail") as unknown });
      expect(await failure(refused(503, "MODEL_PROXY_UNAVAILABLE", "secret detail"))).toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE", message: expect.not.stringContaining("secret detail") as unknown });
      expect(await failure(refused(403, "MODEL_NOT_ALLOWED", 5))).toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
    });
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

describe("the model access of one Slack message (R32)", () => {
  const message: SlackRequestMessage = {
    version: 1, eventId: "EvONE0000001", receivedAt: "2026-10-19T10:00:00.000Z", userId: SLACK_USER,
    thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }, text: "fix the bug",
  };
  const logs: Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }> = [];

  async function wired() {
    const h = await boundInstall();
    const models = createProxiedModels({
      controlPlaneUrl: "https://api.example.test",
      signedFetchFor: (m) => signedFetchTo(h.handler, undefined, { thread: `${m.thread.teamId}/${m.thread.channelId}/${m.thread.threadTs}`, user: m.userId }),
      classifierModel: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }, classifierTimeoutMs: 8_000,
      log: (event, fields) => { logs.push({ event, fields }); },
      createClassifier: createHostedClassifier,
      // The real router is built (it asks for its key); the stub only keeps the test off the network when it routes.
      createRouter: async (options) => { await createHostedRequestRouter(options); return async () => ({ kind: "question", outcome: "ok" }); },
    });
    return { ...h, models };
  }

  it("mints once for a routed request: the router, then the chat turn's runtime and classifier, share one key", async () => {
    const h = await wired();
    const turns: string[] = [];
    await routeSlackRequest(message, {
      route: h.models.routerFor(message),
      offer: vi.fn(), notify: vi.fn(), finish: vi.fn(async () => undefined), log: () => undefined,
      // What processRequest does next: runTurn asks for the turn's models for the same message.
      answer: async (routed) => { const { proxy } = await h.models.turnModels(routed); turns.push(await proxy.apiKey()); },
    });
    expect(turns).toEqual([TURN_KEY]);
    expect(h.mintKey).toHaveBeenCalledTimes(1);
    expect(h.mintKey).toHaveBeenCalledWith({ orgId: TEST_ORG, purpose: "turn", refId: message.eventId, maxBudgetUsd: 2, ttlSeconds: 900 });
  });

  it("sends the orchestrator's and the classifier's models with the turn's one request", async () => {
    const h = await boundInstall();
    const bodies: string[] = [];
    const models = createProxiedModels({
      controlPlaneUrl: "https://api.example.test",
      signedFetchFor: (m) => signedFetchTo(h.handler, (body) => bodies.push(JSON.stringify(body)), { thread: `${m.thread.teamId}/${m.thread.channelId}/${m.thread.threadTs}`, user: m.userId }),
      classifierModel: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
      orchestratorModel: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" }, classifierTimeoutMs: 8_000,
      log: () => undefined, createClassifier: createHostedClassifier, createRouter: async () => undefined,
    });
    await models.proxyFor(message).then((proxy) => proxy.apiKey());
    expect(JSON.parse(bodies[0]!)).toMatchObject({ turnId: message.eventId, model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" }, classifierModel: { modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" } });
  });

  it("mints once for a task answer too, and once more for a different message", async () => {
    const h = await wired();
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const taskId = "22222222-2222-4222-8222-222222222222";
    const api = { taskAnswerWorkspace: async () => ({ outcome: "WORKSPACE" as const, workspaceId, status: "READY" as const, operationId: null, created: false, orchestratorInstructions: "Answer.", mode: "task-answer" as const, taskContext: "context" }) };
    const runTurn = async (input: { message: SlackRequestMessage }) => { await h.models.routerFor(input.message)("is it done?"); await h.models.turnModels(input.message); return "yes"; };
    expect(await runTaskAnswer(message, { taskId } as never, "is it done?", { api: api as never, runTurn })).toBe("yes");
    expect(h.mintKey).toHaveBeenCalledTimes(1);
    await h.models.turnModels({ ...message, eventId: "EvTWO0000002" });
    expect(h.mintKey).toHaveBeenCalledTimes(2);
  });

  it("makes the router unavailable, never a throw, when no key can be had, and mints nothing for an unbound channel", async () => {
    const h = await wired();
    const unbound: SlackRequestMessage = { ...message, thread: { ...message.thread, channelId: "C0UNBOUND01" } };
    expect(await h.models.routerFor(unbound)("fix it")).toEqual({ kind: "unclear", outcome: "unavailable" });
    expect(logs).toContainEqual(expect.objectContaining({ event: "route.router_unavailable" }));
    expect(h.mintKey).not.toHaveBeenCalled();
    await expect(h.models.turnModels(unbound)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// RP-4: when the company forbids the classifier's model, the control plane names the model to use instead (or none), and the service follows.
describe("the classifier model the control plane names (RP-4)", () => {
  const HAIKU = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0" };
  const STAND_IN = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-fable-5" };
  const message: SlackRequestMessage = {
    version: 1, eventId: "EvRP4000001", receivedAt: "2026-11-02T10:00:00.000Z", userId: SLACK_USER,
    thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }, text: "fix the bug",
  };
  const answerWith = (extra: Record<string, unknown>) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ baseUrl: PROXY_URL, apiKey: TURN_KEY, expiresAt: Date.now() + 900_000, ...extra }), { status: 200, headers: { "content-type": "application/json" } }));
  const access = (extra: Record<string, unknown>) => turnModelAccessSource({ controlPlaneUrl: "https://api.example.test", signedFetch: answerWith(extra), turnId: "Ev1" });
  function proxied(extra: Record<string, unknown>) {
    const createClassifier = vi.fn<typeof createHostedClassifier>(async () => ({ classifier: async () => { throw new Error("not called"); }, available: true }));
    const createRouter = vi.fn<typeof createHostedRequestRouter>(async () => async () => ({ kind: "question", outcome: "ok" }));
    const logs: string[] = [];
    const models = createProxiedModels({
      controlPlaneUrl: "https://api.example.test", signedFetchFor: () => answerWith(extra), classifierModel: HAIKU, classifierTimeoutMs: 8_000,
      log: (event) => { logs.push(event); }, createClassifier, createRouter,
    });
    return { models, createClassifier, createRouter, logs };
  }

  it("reads the model named for the classifier, a null that means none, and an answer that says nothing of it", async () => {
    expect((await access({ classifierModel: STAND_IN })()).classifierModel).toEqual(STAND_IN);
    expect((await access({ classifierModel: null })()).classifierModel).toBeNull();
    expect(await access({})()).not.toHaveProperty("classifierModel");
    await expect(access({ classifierModel: { provider: "amazon-bedrock" } })()).rejects.toMatchObject({ code: "MODEL_PROXY_UNAVAILABLE" });
  });

  it("builds the classifier and the router on the model the control plane named instead of the configured one", async () => {
    const h = proxied({ classifierModel: STAND_IN });
    await h.models.turnModels(message);
    expect(h.createClassifier).toHaveBeenCalledWith(expect.objectContaining({ model: STAND_IN }));
    await h.models.routerFor(message)("fix it");
    expect(h.createRouter).toHaveBeenCalledWith(expect.objectContaining({ model: STAND_IN }));
  });

  it("keeps the configured classifier model when the control plane says nothing of it", async () => {
    const h = proxied({});
    await h.models.turnModels(message);
    await h.models.routerFor(message)("fix it");
    expect(h.createClassifier).toHaveBeenCalledWith(expect.objectContaining({ model: HAIKU }));
    expect(h.createRouter).toHaveBeenCalledWith(expect.objectContaining({ model: HAIKU }));
  });

  it("has no classifier and no router when the control plane names none: the gate asks a person and a request gets the three-choice card, and no model is called", async () => {
    const h = proxied({ classifierModel: null });
    const { classifier } = await h.models.turnModels(message);
    await expect(classifier({} as never, undefined as never)).rejects.toBeInstanceOf(ClassifierError);
    expect(await h.models.routerFor(message)("fix it")).toEqual({ kind: "unclear", outcome: "unavailable" });
    expect(h.createClassifier).not.toHaveBeenCalled();
    expect(h.createRouter).not.toHaveBeenCalled();
    expect(h.logs).toContain("gate.classifier_blocked");
  });
});
