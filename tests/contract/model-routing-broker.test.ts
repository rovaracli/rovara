// Plan 3 Task 26 at the broker: a task's operation is routed to a source when it is built (the invocation carries `modelRoute` only for a model the worker
// cannot reach by its own name), the key the worker asks for is scoped to that route and checked again against the live sources, and a Slack turn is routed
// from the org's assistant model or the orchestrator's own. Everything here goes through the real broker over a fake table and a fake proxy.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ModelSourceSchema, modelCounter, modelKeyKey, scopeKey, sourceAlias, spendCounterKey, type ModelSource } from "@agentx/contracts";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { settleKey, type LedgerDependencies, type ModelKeyRecord } from "../../packages/broker/src/spend/ledger.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { seedMembership } from "../support/developer-task-broker.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const SRC_ANTHROPIC = "src_aaaaaaaaaaaaaaaaaaaa";
const SRC_OPENAI = "src_oooooooooooooooooooo";
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const GPT = { provider: "openai", modelId: "gpt-5.4" };
const DEFAULT_ID = "us.anthropic.claude-sonnet-4-6";
const CLASSIFIER_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const LAUNCH = { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] };
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };

const anthropic = (): ModelSource => ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_ANTHROPIC, label: "Anthropic", models: [{ catalog: SONNET }] });
const openai = (): ModelSource => ModelSourceSchema.parse({ kind: "openai", sourceId: SRC_OPENAI, label: "OpenAI", models: [{ catalog: GPT }] });

interface Db { set(item: Record<string, unknown>): void; get(pk: string, sk: string): Record<string, unknown> | undefined; get(key: { pk: string; sk: string }): Record<string, unknown> | undefined; find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }

/** Seeds the org's sources and order the way an admin would have, through the store. */
async function seedSources(db: unknown, setup: { sources?: ModelSource[]; order: string[]; assistantModel?: { provider: string; modelId: string } }) {
  const store = new ModelSourceStore({ documentClient: db as never, tableName: "state", now: Date.now, chatgptSwitch: async () => false });
  for (const source of setup.sources ?? []) await store.save({ orgId: TEST_ORG, source, mode: "create", by: "dev-owner" });
  await store.setOrder({ orgId: TEST_ORG, order: setup.order, by: "dev-owner" });
  if (setup.assistantModel !== undefined) {
    // The assistant model has no route yet (read-only by ruling); the record carries it the way a later route will write it.
    const stored = (db as Db).get(`ORG#${TEST_ORG}#MODEL_SOURCES`, "META")!;
    (db as Db).set({ ...stored, assistantModel: setup.assistantModel });
  }
  return store;
}

async function taskSetup(options: { agents?: boolean } = {}) {
  const access = fakeModelAccess();
  const h = await createDeveloperTaskBroker({ brokerExtra: { ...(options.agents === false ? {} : { agents: { modelSources: { launch: LAUNCH } } }), modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  const start = () => h.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const active = (workspaceId: string) => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const capabilityOf = (operationId: string) => ((h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation) as { callbackCapability: string }).callbackCapability;
  /** Starts a task, finishes its preparation, and returns what its first coding operation was built as. */
  const running = async () => {
    const reply = await start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const workspaceId = (h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
    const prepareId = active(workspaceId);
    await h.finish(workspaceId, prepareId, "SUCCEEDED", PREPARED);
    const operationId = active(workspaceId);
    const outbox = () => h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
    const operation = () => h.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) as Record<string, unknown>;
    const ask = () => call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": capabilityOf(operationId) } });
    return { taskId, workspaceId, prepareId, operationId, outbox, operation, ask, payload: () => (outbox()!.invocation as { payload: Record<string, unknown> }).payload };
  };
  const ledger: LedgerDependencies = { documentClient: h.db, tableName: "state", access, now: Date.now, cloud: true };
  return { ...h, access, seed: (setup: Parameters<typeof seedSources>[1]) => seedSources(h.db, setup), start, running, ledger };
}

describe("a task's operation is routed to the first source that serves its model", () => {
  it("sends modelRoute for a company source, records the route on the operation, and scopes the key to the alias with the source in its tags", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const r = await t.running();
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
    expect(r.payload().modelRoute).toEqual({ alias, api: "anthropic-messages", catalog: "claude-sonnet-4-6" });
    expect(r.operation().modelRoute).toEqual({ sourceId: SRC_ANTHROPIC, alias, model: { provider: "amazon-bedrock", modelId: DEFAULT_ID } });
    const reply = await r.ask();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const minted = t.access.mintKey.mock.calls[0]![0];
    expect(minted.models).toEqual([alias]);
    expect(minted.tags).toMatchObject({ source: SRC_ANTHROPIC, taskId: r.taskId, operationId: r.operationId });
    const record = t.db.get(modelKeyKey(TEST_ORG, keyIdOf(t.access.mintedKeys()[0]!))) as unknown as ModelKeyRecord;
    expect(record).toMatchObject({ model: alias, reserved: true, tags: { source: SRC_ANTHROPIC } });
  });

  it("fills the model counter and the source counter when the key settles", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const r = await t.running();
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
    expect((await r.ask()).status).toBe(200);
    const key = t.access.mintedKeys()[0]!;
    t.access.setKeySpent(key, 1.5);
    await settleKey(t.ledger, TEST_ORG, keyIdOf(key));
    const month = new Date().toISOString().slice(0, 7);
    expect(t.db.get(spendCounterKey(TEST_ORG, month, modelCounter(alias)))).toMatchObject({ spentUsd: 1.5 });
    expect(t.db.get(spendCounterKey(TEST_ORG, month, `SOURCE#${SRC_ANTHROPIC}`))).toMatchObject({ spentUsd: 1.5 });
    expect(scopeKey({ kind: "org" })).toBeDefined();
  });

  it("sends no modelRoute when Rovara serves the default model by its own name, and scopes the key to the catalog id", async () => {
    const t = await taskSetup();
    await t.seed({ order: ["rovara"] });
    const r = await t.running();
    expect(r.payload()).not.toHaveProperty("modelRoute");
    expect(r.operation().modelRoute).toEqual({ sourceId: "rovara", alias: DEFAULT_ID, model: { provider: "amazon-bedrock", modelId: DEFAULT_ID } });
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0]).toMatchObject({ models: [DEFAULT_ID], tags: { source: "rovara" } });
  });

  it("an org with no record routes to Rovara like the default order says", async () => {
    const t = await taskSetup();
    const r = await t.running();
    expect(r.payload()).not.toHaveProperty("modelRoute");
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].models).toEqual([DEFAULT_ID]);
  });

  it("ends the preparation with the exact refusal when no source in the order serves the model, and mints nothing", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [openai()], order: [SRC_OPENAI] });
    const reply = await t.start();
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const taskId = (reply.body.task as { taskId: string }).taskId;
    const workspaceId = (t.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
    const prepareId = t.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string };
    await t.finish(workspaceId, prepareId.activeOperationId, "SUCCEEDED", PREPARED);
    const prepare = t.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId.activeOperationId}`) as { status: string; startRefused?: boolean; error?: string };
    expect(prepare).toMatchObject({ status: "FAILED", startRefused: true });
    expect(prepare.error).toBe("Rovara Code's Build step uses amazon-bedrock/us.anthropic.claude-sonnet-4-6, which isn't allowed on payments. Ask the agent's owner to pick another model.");
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });

  it("does nothing on an install without agents set up: the key is minted unscoped, as it always was", async () => {
    const t = await taskSetup({ agents: false });
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const r = await t.running();
    expect(r.payload()).not.toHaveProperty("modelRoute");
    expect(r.operation()).not.toHaveProperty("modelRoute");
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0]).not.toHaveProperty("models");
  });
});

describe("the key is checked against the live sources each time it is asked for", () => {
  it("refuses a key for a route whose source has left the order since the operation was built", async () => {
    const t = await taskSetup();
    const store = await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"] });
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    await store.setOrder({ orgId: TEST_ORG, order: ["rovara"], by: "dev-owner" });
    const refused = await r.ask();
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "MODEL_NOT_ALLOWED" } });
    expect(t.access.mintKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a key for a route whose source was removed", async () => {
    const t = await taskSetup();
    const store = await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"] });
    const r = await t.running();
    await store.remove({ orgId: TEST_ORG, sourceId: SRC_ANTHROPIC, by: "dev-owner" });
    expect((await r.ask()).status).toBe(403);
  });

  it("still serves a route when the order changed but the route's source is still in it", async () => {
    const t = await taskSetup();
    const store = await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"] });
    const r = await t.running();
    await store.setOrder({ orgId: TEST_ORG, order: ["rovara", SRC_ANTHROPIC], by: "dev-owner" });
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].models).toEqual([sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET)]);
  });

  it("answers a retryable 503 when the org's sources cannot be read, and mints nothing", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const r = await t.running();
    t.db.set({ pk: `ORG#${TEST_ORG}#MODEL_SOURCES`, sk: "META", entityType: "MODEL_SOURCES", sources: "garbage", order: ["rovara"], revision: 9 });
    const reply = await r.ask();
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ error: { code: "MODEL_PROXY_UNAVAILABLE" } });
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });

  it("keys an operation that was built before routing existed exactly as before", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const r = await t.running();
    const operation = r.operation();
    delete operation.modelRoute;
    t.db.set(operation);
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0]).not.toHaveProperty("models");
  });
});

describe("a Slack turn is routed from the assistant model or the orchestrator's own", () => {
  const SLACK_USER = "U0123456789";
  const THREAD = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  beforeAll(loadSlackBroker);

  async function install() {
    const access = fakeModelAccess();
    const { handler, db } = createBroker({ extra: { agents: { modelSources: { launch: LAUNCH } }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
    await registerSlackProject(handler);
    access.setOrgSpent(TEST_ORG, 0);
    const linked = developerIdForSlackUser(SLACK_USER);
    seedMembership(db, linked, { orgId: TEST_ORG, role: "member" });
    access.setMemberSpent(TEST_ORG, linked, 0);
    const turn = (body: Record<string, unknown> = {}) => serviceCall(handler, THREAD, SLACK_USER, "POST", "/v1/service/model-access", { turnId: randomUUID(), ...body });
    return { handler, db, access, turn, seed: (setup: Parameters<typeof seedSources>[1]) => seedSources(db, setup) };
  }

  it("scopes the key to the orchestrator's catalog model and the classifier's, and returns no route for Rovara's own model", async () => {
    const h = await install();
    await h.seed({ order: ["rovara"] });
    const reply = await h.turn({ model: { provider: "amazon-bedrock", modelId: DEFAULT_ID }, classifierModel: { provider: "amazon-bedrock", modelId: CLASSIFIER_ID } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).not.toHaveProperty("route");
    expect(h.access.mintKey.mock.calls[0]![0]).toMatchObject({ models: [DEFAULT_ID, CLASSIFIER_ID], tags: { source: "rovara", origin: "slack" } });
  });

  it("assumes the install's default models when the service names none", async () => {
    const h = await install();
    expect((await h.turn()).status).toBe(200);
    expect(h.access.mintKey.mock.calls[0]![0].models).toEqual([DEFAULT_ID, CLASSIFIER_ID]);
  });

  it("routes the org's assistant model to a company source, returns the route, and leaves the classifier off the key when Rovara is not in the order", async () => {
    const h = await install();
    await h.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC], assistantModel: SONNET });
    const reply = await h.turn({ classifierModel: { provider: "amazon-bedrock", modelId: CLASSIFIER_ID } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
    expect(reply.body.route).toEqual({ alias, api: "anthropic-messages", catalog: "claude-sonnet-4-6" });
    expect(h.access.mintKey.mock.calls[0]![0]).toMatchObject({ models: [alias], tags: { source: SRC_ANTHROPIC } });
  });

  it("refuses a turn for an org without Rovara in its order and without an assistant model, saying to set one", async () => {
    const h = await install();
    await h.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const reply = await h.turn();
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ error: { code: "MODEL_NOT_ALLOWED" } });
    expect(String((reply.body.error as { message: string }).message)).toContain("assistant model");
    expect(h.access.mintKey).not.toHaveBeenCalled();
  });

  it("refuses an assistant model that no source in the order serves, and a classifier that is not Rovara's is simply left off the key", async () => {
    const h = await install();
    await h.seed({ sources: [openai()], order: [SRC_OPENAI, "rovara"], assistantModel: SONNET });
    const refused = await h.turn();
    expect(refused.status).toBe(200);
    expect(h.access.mintKey.mock.calls[0]![0].models).toEqual([DEFAULT_ID, CLASSIFIER_ID]);
    const stranger = await h.turn({ classifierModel: { provider: "openai", modelId: "gpt-5.4" } });
    expect(stranger.status).toBe(200);
    expect(h.access.mintKey.mock.calls[1]![0].models).toEqual([DEFAULT_ID]);
  });

  it("refuses a turn when the org's sources cannot be read, with a retryable 503 and no key", async () => {
    const h = await install();
    h.db.set({ pk: `ORG#${TEST_ORG}#MODEL_SOURCES`, sk: "META", entityType: "MODEL_SOURCES", sources: "garbage", order: ["rovara"], revision: 3 });
    const reply = await h.turn();
    expect(reply.status).toBe(503);
    expect(h.access.mintKey).not.toHaveBeenCalled();
  });

  it("routes a Slack thread operation like any task operation", async () => {
    const h = await install();
    await h.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const workspace = await ensureWorkspace(h.handler, THREAD, SLACK_USER);
    expect(workspace.status).toBe(200);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(h.db, workspaceId);
    const conversation = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await serviceCall(h.handler, THREAD, SLACK_USER, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    const operationId = (task.body.operation as { id: string }).id;
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const invocation = outbox.invocation as { callbackCapability: string; payload: Record<string, unknown> };
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
    expect(invocation.payload.modelRoute).toEqual({ alias, api: "anthropic-messages", catalog: "claude-sonnet-4-6" });
    const reply = await call(h.handler, { method: "GET", path: "/v1/internal/model-access", headers: { "x-agentx-callback-capability": invocation.callbackCapability } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(h.access.mintKey.mock.calls[0]![0].models).toEqual([alias]);
  });
});
