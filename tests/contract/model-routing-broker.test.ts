// Plan 3 Task 26 at the broker: a task's operation is routed to a source when it is built (the invocation carries `modelRoute` only for a model the worker
// cannot reach by its own name), the key the worker asks for is scoped to that route and checked again against the live sources, and a Slack turn is routed
// from the org's assistant model or the orchestrator's own. Everything here goes through the real broker over a fake table and a fake proxy.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ModelSourceSchema, modelCounter, modelKeyKey, modelSourcesKey, scopeKey, sourceAlias, spendCounterKey, type ModelSource } from "@agentx/contracts";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import { keyIdOf } from "../../packages/broker/src/org/budget.js";
import { settleKey, type LedgerDependencies, type ModelKeyRecord } from "../../packages/broker/src/spend/ledger.js";
import { resolveTaskModel } from "../../packages/worker/src/task-model.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
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
    const stored = (db as Db).get(modelSourcesKey(TEST_ORG));
    if (stored === undefined) throw new Error("test setup: an assistant model needs a record, so name a source or an order that changes the default");
    (db as Db).set({ ...stored, assistantModel: setup.assistantModel });
  }
  // Stored credential presence is non-secret metadata; these fixtures never provision keys.
  if ((setup.sources?.length ?? 0) > 0) {
    const stored = (db as Db).get(modelSourcesKey(TEST_ORG));
    if (stored === undefined) throw new Error("test setup: saved sources need their State record");
    (db as Db).set({ ...stored, credentials: setup.sources!.filter(source => source.kind !== "bedrock").map(source => source.sourceId) });
  }
  return store;
}

const HAIKU_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const PROJECT_MODELS = {
  default: { provider: "amazon-bedrock", modelId: HAIKU_ID, label: "Fast" },
  approved: [{ provider: "amazon-bedrock", modelId: HAIKU_ID, label: "Fast" }, { provider: "amazon-bedrock", modelId: DEFAULT_ID, label: "Balanced" }],
};

/** Maya's ChatGPT plan, as the install's connections report it, with the install-wide switch on. */
const MAYA_PLAN = {
  settings: async () => ({ enabled: true, preferredModel: "gpt-5.4" }),
  view: async (developerId: string) => (developerId === MAYA.developerId ? { connected: true, status: "connected", connectedAt: "2026-10-01T00:00:00.000Z", models: ["gpt-5.4"] } : { connected: false }),
  accessToken: async () => ({ access: "token", expiresAt: Date.now() + 3_600_000, models: [] }),
  markStatus: async () => undefined,
  refreshModels: async () => undefined,
};

async function taskSetup(options: { agents?: boolean; models?: boolean; plan?: boolean } = {}) {
  const access = fakeModelAccess(), audit = capturingAuditDeps();
  const h = await createDeveloperTaskBroker({ audit, register: options.models !== true, brokerExtra: { ...(options.agents === false ? {} : { agents: { modelSources: { launch: LAUNCH } } }), ...(options.plan === true ? { chatgpt: MAYA_PLAN } : {}), modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  if (options.models === true) await registerSlackProject(h.handler, { models: PROJECT_MODELS });
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
    const payload = () => (outbox()!.invocation as { payload: Record<string, unknown> }).payload;
    const fallback = () => call(h.handler, { method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/model-fallback`, headers: { "x-agentx-callback-capability": capabilityOf(operationId) }, body: { version: 1, binding: payload().modelPolicy, reason: "unavailable", failedModel: GPT } });
    return { taskId, workspaceId, prepareId, operationId, outbox, operation, ask, payload, fallback };
  };
  const ledger: LedgerDependencies = { documentClient: h.db, tableName: "state", access, now: Date.now, cloud: true };
  return { ...h, access, audit, seed: (setup: Parameters<typeof seedSources>[1]) => seedSources(h.db, setup), start, running, ledger };
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
    // The worker is told the model its key allows, so it never falls back on its own install setting.
    expect(r.payload().model).toEqual({ provider: "amazon-bedrock", modelId: DEFAULT_ID });
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
    expect(prepare.error).toBe("The task's pinned stage model is unavailable. Check How we work.");
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });

  it("routes the project's own model, and scopes the key to it", async () => {
    const t = await taskSetup({ models: true });
    await t.seed({ order: ["rovara"] });
    const r = await t.running();
    expect(r.payload()).toMatchObject({ model: { provider: "amazon-bedrock", modelId: HAIKU_ID } });
    expect(r.payload()).not.toHaveProperty("modelRoute");
    expect(r.operation().modelRoute).toEqual({ sourceId: "rovara", alias: HAIKU_ID, model: { provider: "amazon-bedrock", modelId: HAIKU_ID } });
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0]).toMatchObject({ models: [HAIKU_ID], tags: { source: "rovara" } });
  });

  it("sends a company source's route for the project's own model when that source comes first, keeping the model for the worker's report", async () => {
    const t = await taskSetup({ models: true });
    const haiku = { provider: "anthropic", modelId: "claude-haiku-4-5" };
    await t.seed({ sources: [ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_ANTHROPIC, label: "Anthropic", models: [{ catalog: SONNET }, { catalog: haiku }] })], order: [SRC_ANTHROPIC, "rovara"] });
    const r = await t.running();
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, haiku);
    expect(r.payload()).toMatchObject({ model: { modelId: HAIKU_ID }, modelRoute: { alias, api: "anthropic-messages", catalog: "claude-haiku-4-5" } });
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].models).toEqual([alias]);
  });

  it("retains an unscoped key before agents are configured when no company model policy applies",async()=>{
    const t=await taskSetup({agents:false});const r=await t.running();
    expect((await r.ask()).status).toBe(200);expect(t.access.mintKey.mock.calls[0]![0]).not.toHaveProperty("models");
  });
  it("C53 refuses an unavailable governed default even before agents are configured", async () => {
    const t = await taskSetup({ agents: false });
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const r = await t.running();
    expect(t.db.find(item=>item.entityType==="OPERATION"&&item.workspaceId===r.workspaceId&&item.kind==="task")).toHaveLength(0);
    expect(r.outbox()).toBeUndefined();
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });
});

describe("the worker runs exactly the model its key allows", () => {
  const INSTALL = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "us.anthropic.claude-opus-4-6", PI_CACHE_RETENTION: "short" };

  it("names the model in the payload when the step and the project name none, so an install whose worker setting is another model still runs the key's model", async () => {
    const t = await taskSetup();
    await t.seed({ order: ["rovara"] });
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    const sent = r.payload().model as { provider: string; modelId: string };
    // What the worker resolves with its install setting on another model is the payload's, which is what the key allows.
    expect(resolveTaskModel(sent as never, INSTALL)).toMatchObject({ provider: "amazon-bedrock", modelId: DEFAULT_ID });
    expect(t.access.mintKey.mock.calls[0]![0].models).toEqual([sent.modelId]);
    // Without it the worker would have run its setting, which the key does not allow.
    expect(resolveTaskModel(undefined, INSTALL).modelId).toBe("us.anthropic.claude-opus-4-6");
  });

  it("names it beside a company source's route too, and keeps the project's own model and level when it has one", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const r = await t.running();
    expect(r.payload()).toMatchObject({ model: { provider: "amazon-bedrock", modelId: DEFAULT_ID }, modelRoute: { api: "anthropic-messages" } });
    const withModels = await taskSetup({ models: true });
    await withModels.seed({ order: ["rovara"] });
    expect((await withModels.running()).payload().model).toEqual({ provider: "amazon-bedrock", modelId: HAIKU_ID });
  });

  it("names the default of an eu install's own geography", async () => {
    const was = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-west-1";
    try {
      const t = await taskSetup();
      await t.seed({ order: ["rovara"] });
      const r = await t.running();
      expect(r.payload().model).toEqual({ provider: "amazon-bedrock", modelId: "eu.anthropic.claude-sonnet-4-6" });
      expect(r.operation().modelRoute).toMatchObject({ alias: "eu.anthropic.claude-sonnet-4-6" });
    } finally {
      if (was === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = was;
    }
  });

  it("leaves the model alone when no route was chosen (a plan with no backup)", async () => {
    const t = await taskSetup({ plan: true });
    const store = new ModelSourceStore({ documentClient: t.db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
    await store.setOrder({ orgId: TEST_ORG, order: ["personal-chatgpt"], by: "dev-owner" });
    const r = await t.running();
    expect(r.operation().modelRoute).toBeNull();
    expect(r.payload().model).toEqual(GPT);
  });
});

describe("a task on the owner's ChatGPT plan follows the order too", () => {
  /** The store with the switch on, since an order that lists the plan needs it. */
  async function planned(order: string[], sources: ModelSource[] = []) {
    const t = await taskSetup({ plan: true });
    const store = new ModelSourceStore({ documentClient: t.db, tableName: "state", now: Date.now, chatgptSwitch: async () => true });
    for (const source of sources) await store.save({ orgId: TEST_ORG, source, mode: "create", by: "dev-owner" });
    await store.setOrder({ orgId: TEST_ORG, order, by: "dev-owner" });
    if (sources.length > 0) t.db.set({ ...t.db.get(modelSourcesKey(TEST_ORG))!, credentials: sources.filter(source => source.kind !== "bedrock").map(source => source.sourceId) });
    return t;
  }

  it("keeps the plan first and grants the Rovara backup key only after atomic fallback authorization", async () => {
    const t = await planned(["personal-chatgpt", "rovara"]);
    const r = await t.running();
    expect(r.payload().chatgpt).toEqual({ model: GPT });
    expect(r.operation()).toMatchObject({ chatgptDeveloperId: MAYA.developerId, modelRoute: null });
    expect((await r.ask()).status).toBe(403);
    expect(t.access.mintKey).not.toHaveBeenCalled();
    expect((await r.fallback()).status).toBe(200);
    expect(r.operation().modelRoute).toMatchObject({ sourceId: "rovara", alias: DEFAULT_ID });
    expect(t.db.get(`DEVTASK#${r.taskId}`, "META")?.modelFallbacks).toHaveLength(1);
    expect(t.audit.flushed().filter(event => event.action === "model.fallback_used")).toHaveLength(1);
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0].models).toEqual([DEFAULT_ID]);
  });

  it("authorizes the company-source backup before minting its scoped alias key", async () => {
    const t = await planned(["personal-chatgpt", SRC_ANTHROPIC], [anthropic()]);
    const r = await t.running();
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, SONNET);
    expect(r.payload()).toMatchObject({ chatgpt: { model: GPT }, model: GPT });
    expect(r.operation().modelRoute).toBeNull();
    expect(t.access.mintKey).not.toHaveBeenCalled();
    expect((await r.fallback()).status).toBe(200);
    expect(r.operation()).toMatchObject({ modelRoute: { sourceId: SRC_ANTHROPIC, alias } });
    expect(r.operation()).not.toHaveProperty("chatgptDeveloperId");
    expect(t.db.get(`DEVTASK#${r.taskId}`, "META")?.modelFallbacks).toHaveLength(1);
    expect(t.audit.flushed().filter(event => event.action === "model.fallback_used")).toHaveLength(1);
    expect((await r.ask()).status).toBe(200);
    expect(t.access.mintKey.mock.calls[0]![0]).toMatchObject({ models: [alias], tags: { source: SRC_ANTHROPIC } });
  });

  it("uses the verified company source for the plan model when it precedes the personal plan", async () => {
    const t = await planned([SRC_OPENAI, "personal-chatgpt", "rovara"], [openai()]);
    const r = await t.running();
    expect(r.payload()).not.toHaveProperty("chatgpt");
    expect(r.operation().chatgptDeveloperId).toBeUndefined();
    expect(r.payload().model).toEqual(GPT);
    expect(r.operation().modelRoute).toMatchObject({ sourceId: SRC_OPENAI, alias: sourceAlias(TEST_ORG, SRC_OPENAI, GPT) });
  });

  it("keeps the plan with no company backup, and issues no company key for it", async () => {
    const t = await planned(["personal-chatgpt"]);
    const r = await t.running();
    expect(r.payload().chatgpt).toEqual({ model: GPT });
    expect(r.operation().modelRoute).toBeNull();
    const refused = await r.ask();
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "MODEL_NOT_ALLOWED" } });
    expect(t.access.mintKey).not.toHaveBeenCalled();
  });
});

describe("the project's own order", () => {
  const projectOrder = (db: { set(item: Record<string, unknown>): void }, order: string[]) =>
    db.set({ pk: `ORG#${TEST_ORG}#PROJECT_AI#payments`, sk: "SETTINGS", entityType: "PROJECT_AI", projectPays: false, sourceOrder: order, revision: 1 });

  it("decides over the org's order for work on that project", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"] });
    projectOrder(t.db, ["rovara", SRC_ANTHROPIC]);
    const r = await t.running();
    expect(r.payload()).not.toHaveProperty("modelRoute");
    expect(r.operation().modelRoute).toMatchObject({ sourceId: "rovara" });
  });

  it("is checked again when a key is asked for: a route its project has since left out gets none", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"] });
    const r = await t.running();
    expect((await r.ask()).status).toBe(200);
    projectOrder(t.db, ["rovara"]);
    expect((await r.ask()).status).toBe(403);
  });
});

describe("a project's AI settings follow the org's order", () => {
  it("shows the org's order as the project's effective order, and refuses a project order that names a source the org does not have in its own", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"] });
    const shown = await t.dev(MAYA, "GET", "/v1/app/projects/payments/ai");
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body).toMatchObject({ effective: { sourceOrder: [SRC_ANTHROPIC, "rovara"] } });
    seedMembership(t.db, MAYA.developerId, { orgId: TEST_ORG, role: "admin" });
    const refused = await t.dev(MAYA, "PUT", "/v1/app/projects/payments/ai", { requestId: randomUUID(), sourceOrder: [SRC_OPENAI] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    const allowed = await t.dev(MAYA, "PUT", "/v1/app/projects/payments/ai", { requestId: randomUUID(), sourceOrder: ["rovara", SRC_ANTHROPIC] });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
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

  it("routes the assistant model rather than the model the service names, and says which was meant when it is unserved", async () => {
    const h = await install();
    const haiku = { provider: "anthropic", modelId: "claude-haiku-4-5" };
    await h.seed({ sources: [ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC_ANTHROPIC, label: "Anthropic", models: [{ catalog: SONNET }, { catalog: haiku }] })], order: [SRC_ANTHROPIC, "rovara"], assistantModel: haiku });
    const reply = await h.turn({ model: { provider: "amazon-bedrock", modelId: DEFAULT_ID } });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const alias = sourceAlias(TEST_ORG, SRC_ANTHROPIC, haiku);
    expect(reply.body.route).toEqual({ alias, api: "anthropic-messages", catalog: "claude-haiku-4-5" });
    expect(h.access.mintKey.mock.calls[0]![0].models).toEqual([alias, CLASSIFIER_ID]);
    // An assistant model that nothing in the order serves is refused with the model named, and nothing is minted for it.
    const unserved = await install();
    await unserved.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"], assistantModel: { provider: "openai", modelId: "gpt-5.4" } });
    const refused = await unserved.turn();
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "MODEL_NOT_ALLOWED", message: "Slack's model openai/gpt-5.4 isn't served by any AI source your company can use. Ask an admin to set another assistant model." } });
    expect(unserved.access.mintKey).not.toHaveBeenCalled();
  });

  it("keeps the classifier off the key when it is not one of Rovara's catalog models", async () => {
    const h = await install();
    await h.seed({ order: ["rovara"] });
    const stranger = await h.turn({ classifierModel: { provider: "openai", modelId: "gpt-5.4" } });
    expect(stranger.status).toBe(200);
    expect(h.access.mintKey.mock.calls[0]![0].models).toEqual([DEFAULT_ID]);
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

describe("the models a recipe may name are the ones the org's sources serve", () => {
  const publishWith = async (t: Awaited<ReturnType<typeof taskSetup>>, model: { provider: string; modelId: string }) => {
    const overlay = { instructions: "Summarise.", sequence: [{ id: "work", name: "work", kind: "agent", workspace: "none", settings: { model } }] };
    const created = await t.dev(MAYA, "POST", "/v1/app/agents", { requestId: randomUUID(), name: `Agent ${randomUUID().slice(0, 8)}`, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agentId = (created.body.agent as { agentId: string }).agentId;
    const draft = await t.dev(MAYA, "GET", `/v1/app/agents/${agentId}/draft`);
    return t.dev(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { requestId: randomUUID(), expectedRevision: (draft.body.draft as { revision: number }).revision });
  };

  it("refuses a model no source in the order serves, and accepts it once a source does", async () => {
    const t = await taskSetup();
    await t.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    const refused = await publishWith(t, GPT);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { message: "steps.0.settings.model: openai/gpt-5.4 isn't served by any AI source your company can use; pick a model one of them serves" } });
    const served = await taskSetup();
    await served.seed({ sources: [anthropic(), openai()], order: [SRC_ANTHROPIC, SRC_OPENAI] });
    expect((await publishWith(served, GPT)).status).toBe(200);
  });

  it("serves Rovara's catalog only while Rovara is in the order", async () => {
    const opus = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-opus-4-7" };
    const without = await taskSetup();
    await without.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC] });
    expect((await publishWith(without, opus)).status).toBe(400);
    const withRovara = await taskSetup();
    await withRovara.seed({ sources: [anthropic()], order: [SRC_ANTHROPIC, "rovara"] });
    expect((await publishWith(withRovara, opus)).status).toBe(200);
  });
});

for(const policy of ["none","source-order","lock"] as const)it(`keeps the personal-plan key policy frozen while source eligibility is live (${policy})`,async()=>{
 const t=await taskSetup({agents:false,plan:true}),r=await t.running();
 if(policy==="source-order")t.db.set({...modelSourcesKey(TEST_ORG),revision:1,sources:[],credentials:[],removing:[],order:["rovara"]});
 if(policy==="lock")t.db.set({pk:`ORG#${TEST_ORG}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",entityType:"MODEL_SELECTION_POLICY",orgId:TEST_ORG,version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:{build:{model:SONNET,thinkingLevel:null,locked:true}}});
 const response=await r.ask();
 if(policy==="none"){expect(response.status).toBe(200);expect(t.access.mintKey.mock.calls[0]![0]).not.toHaveProperty("models");}
 else if(policy==="source-order"){expect(response).toMatchObject({status:409,body:{error:{code:"MODEL_NOT_VERIFIED",stage:"build",fixHref:"/app/admin/models/sources"}}});expect(t.access.mintKey).not.toHaveBeenCalled();}
 else{expect(response.status).toBe(200);expect(r.payload().modelPolicy).toMatchObject({companyRevision:0});}
});
