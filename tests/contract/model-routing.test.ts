// Plan 3 Task 26: which source serves a step's model. `routeModel` walks the project's source order (else the org's) and answers the first source that serves
// the model by its canonical name; a source that cannot be proved usable is skipped, a record that cannot be read refuses (never falls back to Rovara's AI).
// The broker side (the operation's route, the key's `models`, the live re-check, Slack turns) is tests/contract/model-routing-broker.test.ts.
import { describe, expect, it } from "vitest";
import { ModelSourceSchema, defaultModelSourceOrder, egressDomainsKey, modelSourcesKey, sourceAlias, type ModelIdentifier, type ModelSource, type OrgId } from "@agentx/contracts";
import { singleOrgIdForEnv } from "../../packages/contracts/src/org-node.js";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import { chatGptServing, modelNotAllowedText, routeModel, routeOnWire, servableModels, servingRoutes, type RoutingDependencies } from "../../packages/broker/src/model-sources/routing.js";
import { defaultWorkerModel, routeStep } from "../../packages/broker/src/agents/dispatch.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG = singleOrgIdForEnv("other-install");
const SRC_BEDROCK = "src_bbbbbbbbbbbbbbbbbbbb";
const SRC_ANTHROPIC = "src_aaaaaaaaaaaaaaaaaaaa";
const SRC_OPENAI = "src_oooooooooooooooooooo";
const SRC_ENDPOINT = "src_eeeeeeeeeeeeeeeeeeee";
const SRC_OTHER = "src_zzzzzzzzzzzzzzzzzzzz";
const ROLE = "arn:aws:iam::123456789012:role/rovara/proxy-access";

const DEFAULT_MODEL: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const GPT = { provider: "openai", modelId: "gpt-5.4" };
const ALL_KINDS = { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] } as const;

const anthropic = (sourceId = SRC_ANTHROPIC): ModelSource => ModelSourceSchema.parse({ kind: "anthropic", sourceId, label: "Anthropic", models: [{ catalog: SONNET }] });
const openai = (sourceId = SRC_OPENAI): ModelSource => ModelSourceSchema.parse({ kind: "openai", sourceId, label: "OpenAI", models: [{ catalog: GPT }] });
const bedrock = (tested: boolean, sourceId = SRC_BEDROCK): ModelSource => ModelSourceSchema.parse({
  kind: "bedrock", sourceId, label: "Our AWS", roleArn: ROLE, region: "us-east-1", externalId: `rovara-${TEST_ORG}`, models: [{ catalog: DEFAULT_MODEL }], tested,
});
const endpoint = (api = "openai-completions", sourceId = SRC_ENDPOINT): ModelSource => ModelSourceSchema.parse({
  kind: "endpoint", sourceId, label: "Gateway", baseUrl: "https://llm.example.com/v1", api, models: [{ name: "our-model", catalog: SONNET }],
});

function install(options: { chatgpt?: RoutingDependencies["chatgpt"]; launch?: RoutingDependencies["launch"]; projectOrder?: RoutingDependencies["projectSourceOrder"] } = {}) {
  const db = new FakeDynamoDb();
  const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: Date.now, chatgptSwitch: async () => options.chatgpt !== undefined });
  const deps: RoutingDependencies = {
    sources: store, egress: { documentClient: db, tableName: "state" }, launch: options.launch ?? ALL_KINDS,
    ...(options.chatgpt === undefined ? {} : { chatgpt: options.chatgpt }),
    ...(options.projectOrder === undefined ? {} : { projectSourceOrder: options.projectOrder }),
  };
  const add = async (source: ModelSource, orgId: OrgId = TEST_ORG) => { await store.save({ orgId, source, mode: "create", by: "dev-owner" }); };
  const order = async (ids: string[], orgId: OrgId = TEST_ORG) => { await store.setOrder({ orgId, order: ids, by: "dev-owner" }); };
  const egress = (sourceId: string, status: "pending" | "approved" | "rejected" | "none", host = "llm.example.com", extra: { active?: boolean; orgId?: OrgId } = {}) => {
    if (status === "none") return;
    db.set({
      ...egressDomainsKey(extra.orgId ?? TEST_ORG, { kind: "model-source", sourceId }), orgId: extra.orgId ?? TEST_ORG, owner: { kind: "model-source", sourceId }, active: extra.active ?? true,
      domains: [{ domain: host, status, requestedAt: "2026-10-21T00:00:00.000Z", requestedBy: "dev-owner" }], updatedAt: "2026-10-21T00:00:00.000Z",
    });
  };
  const route = (model: ModelIdentifier = DEFAULT_MODEL, extra: Partial<Parameters<typeof routeModel>[1]> = {}) => routeModel(deps, { orgId: TEST_ORG, project: "web", model, ...extra });
  return { db, store, deps, add, order, egress, route };
}

const failure = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as { code: string; message: string }; }
  throw new Error("expected a refusal");
};

describe("routeModel: the order decides, the canonical name matches", () => {
  it("routes the default model to the org's Bedrock source when it comes first, and to Rovara's catalog when Rovara does", async () => {
    const t = install();
    await t.add(bedrock(true));
    await t.order([SRC_BEDROCK, "rovara"]);
    expect(await t.route()).toEqual({ sourceId: SRC_BEDROCK, alias: sourceAlias(TEST_ORG, SRC_BEDROCK, DEFAULT_MODEL), api: "anthropic-messages", catalog: DEFAULT_MODEL.modelId });
    await t.order(["rovara", SRC_BEDROCK]);
    expect(await t.route()).toEqual({ sourceId: "rovara", alias: "us.anthropic.claude-sonnet-4-6", api: "anthropic-messages", catalog: "us.anthropic.claude-sonnet-4-6" });
  });

  it("routes the same default to a direct Anthropic source by canonical match, under the source's own catalog name", async () => {
    const t = install();
    await t.add(anthropic());
    await t.order([SRC_ANTHROPIC]);
    expect(await t.route()).toEqual({ sourceId: SRC_ANTHROPIC, alias: `${TEST_ORG}.${SRC_ANTHROPIC}.claude-sonnet-4-6`, api: "anthropic-messages", catalog: "claude-sonnet-4-6" });
  });

  it("uses each kind's transport: OpenAI on responses, OpenRouter on completions, an endpoint on its own api", async () => {
    const t = install();
    await t.add(openai());
    await t.add(ModelSourceSchema.parse({ kind: "openrouter", sourceId: "src_rrrrrrrrrrrrrrrrrrrr", label: "OpenRouter", models: [{ catalog: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" } }] }));
    await t.add(endpoint("openai-responses"));
    await t.order([SRC_OPENAI, "src_rrrrrrrrrrrrrrrrrrrr", SRC_ENDPOINT]);
    expect(await t.route(GPT)).toMatchObject({ sourceId: SRC_OPENAI, api: "openai-responses" });
    expect(await t.route({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.6" })).toMatchObject({ sourceId: "src_rrrrrrrrrrrrrrrrrrrr", api: "openai-completions" });
    t.egress(SRC_ENDPOINT, "approved");
    await t.order([SRC_ENDPOINT]);
    expect(await t.route(SONNET)).toMatchObject({ sourceId: SRC_ENDPOINT, api: "openai-responses", alias: sourceAlias(TEST_ORG, SRC_ENDPOINT, SONNET) });
  });

  it("falls to the next source when the first does not serve the model, and refuses with the exact text when none does", async () => {
    const t = install();
    await t.add(openai());
    await t.order([SRC_OPENAI]);
    const refused = await failure(t.route(DEFAULT_MODEL, { subject: { agent: "Ticket Triage", step: "Build" } }));
    expect(refused).toMatchObject({ code: "MODEL_NOT_ALLOWED", message: "MODEL_NOT_ALLOWED: Ticket Triage's Build step uses amazon-bedrock/us.anthropic.claude-sonnet-4-6, which isn't allowed on web. Ask the agent's owner to pick another model." });
    expect(modelNotAllowedText({ agent: "Ticket Triage", step: "Build" }, DEFAULT_MODEL, "web")).toBe("Ticket Triage's Build step uses amazon-bedrock/us.anthropic.claude-sonnet-4-6, which isn't allowed on web. Ask the agent's owner to pick another model.");
    await t.order([SRC_OPENAI, "rovara"]);
    expect(await t.route()).toMatchObject({ sourceId: "rovara" });
    // Rovara's catalog is Bedrock's Claude models: a model outside it is not served by Rovara.
    expect((await failure(t.route({ provider: "openai", modelId: "gpt-9" }))).code).toBe("MODEL_NOT_ALLOWED");
  });

  it("serves a model Rovara's catalog holds under another name by canonical match, with the catalog id as alias", async () => {
    const t = install();
    await t.order(["rovara"]);
    expect(await t.route(SONNET)).toEqual({ sourceId: "rovara", alias: "us.anthropic.claude-sonnet-4-6", api: "anthropic-messages", catalog: "us.anthropic.claude-sonnet-4-6" });
  });
});

describe("routeModel: sources that cannot be proved usable are skipped", () => {
  it("never routes a Bedrock source that has not been tested", async () => {
    const t = install();
    await t.add(bedrock(false));
    await t.order([SRC_BEDROCK, "rovara"]);
    expect(await t.route()).toMatchObject({ sourceId: "rovara" });
    await t.order([SRC_BEDROCK]);
    expect((await failure(t.route())).code).toBe("MODEL_NOT_ALLOWED");
  });

  it("skips a kind that is not at launch, and an endpoint whose api is not", async () => {
    const t = install({ launch: { kinds: ["openai"] } });
    await t.add(anthropic());
    await t.order([SRC_ANTHROPIC, "rovara"]);
    expect(await t.route()).toMatchObject({ sourceId: "rovara" });
    const none = install();
    await none.add(anthropic());
    await none.order([SRC_ANTHROPIC, "rovara"]);
    // The shipped launch list is empty today, so a company source is never routed until a kind joins it.
    const shipped: RoutingDependencies = { ...none.deps };
    delete (shipped as { launch?: unknown }).launch;
    expect(await routeModel(shipped, { orgId: TEST_ORG, project: "web", model: DEFAULT_MODEL })).toMatchObject({ sourceId: "rovara" });
    const odd = install({ launch: { kinds: ["endpoint"], transports: ["openai-completions"] } });
    await odd.add(endpoint("anthropic-messages"));
    odd.egress(SRC_ENDPOINT, "approved");
    await odd.order([SRC_ENDPOINT, "rovara"]);
    expect(await odd.route(SONNET)).toMatchObject({ sourceId: "rovara" });
  });

  it("skips an endpoint until its host is approved for that source's own egress entry", async () => {
    const t = install();
    await t.add(endpoint());
    await t.order([SRC_ENDPOINT, "rovara"]);
    for (const status of ["pending", "rejected", "none"] as const) {
      t.db.delete(egressDomainsKey(TEST_ORG, { kind: "model-source", sourceId: SRC_ENDPOINT }));
      t.egress(SRC_ENDPOINT, status);
      expect((await t.route(SONNET)).sourceId, status).toBe("rovara");
    }
    t.db.delete(egressDomainsKey(TEST_ORG, { kind: "model-source", sourceId: SRC_ENDPOINT }));
    t.egress(SRC_ENDPOINT, "approved");
    expect((await t.route(SONNET)).sourceId).toBe(SRC_ENDPOINT);
  });

  it("skips an endpoint whose host is approved only for another owner or another host, and one whose entry is switched off", async () => {
    const t = install();
    await t.add(endpoint());
    await t.add(endpoint("openai-completions", SRC_OTHER));
    await t.order([SRC_ENDPOINT, "rovara"]);
    // The same host is approved for another source of the org: that is not this source's approval.
    t.egress(SRC_OTHER, "approved");
    expect((await t.route(SONNET)).sourceId).toBe("rovara");
    t.egress(SRC_ENDPOINT, "approved", "elsewhere.example.com");
    expect((await t.route(SONNET)).sourceId).toBe("rovara");
    t.egress(SRC_ENDPOINT, "approved", "llm.example.com", { active: false });
    expect((await t.route(SONNET)).sourceId).toBe("rovara");
    // Another org's approval of the same owner id is another org's item.
    t.egress(SRC_ENDPOINT, "approved", "llm.example.com", { orgId: OTHER_ORG });
    expect((await t.route(SONNET)).sourceId).toBe("rovara");
  });

  it("treats a project order entry that names a removed source, or a source under a removal tombstone, as unserved", async () => {
    const t = install({ projectOrder: async () => [SRC_ANTHROPIC, "rovara"] });
    await t.add(anthropic());
    await t.order([SRC_ANTHROPIC, "rovara"]);
    expect((await t.route()).sourceId).toBe(SRC_ANTHROPIC);
    await t.store.remove({ orgId: TEST_ORG, sourceId: SRC_ANTHROPIC, by: "dev-owner" });
    expect((await t.store.read(TEST_ORG)).removing.map((entry) => entry.sourceId)).toEqual([SRC_ANTHROPIC]);
    expect((await t.route()).sourceId).toBe("rovara");
    // A record that still lists the source beside a removal tombstone for it (a removal mid-cleanup) does not serve it either.
    const mid = install();
    await mid.add(anthropic());
    await mid.order([SRC_ANTHROPIC, "rovara"]);
    mid.db.set({ ...mid.db.get(modelSourcesKey(TEST_ORG))!, removing: [{ sourceId: SRC_ANTHROPIC, kind: "anthropic" }] });
    expect((await mid.route()).sourceId).toBe("rovara");
    // Only the project asked for the dead source: with nothing else in its order the model is unserved, not served by something it did not list.
    const only = install({ projectOrder: async () => [SRC_ANTHROPIC] });
    await only.order(["rovara"]);
    expect((await failure(only.route())).code).toBe("MODEL_NOT_ALLOWED");
  });
});

describe("routeModel: the project's order and the org's order", () => {
  it("uses the project's own order when it has one, and the org's when it does not", async () => {
    const t = install({ projectOrder: async (_org, project) => (project === "web" ? ["rovara", SRC_ANTHROPIC] : undefined) });
    await t.add(anthropic());
    await t.order([SRC_ANTHROPIC, "rovara"]);
    expect((await t.route()).sourceId).toBe("rovara");
    expect((await t.route(DEFAULT_MODEL, { project: "api" })).sourceId).toBe(SRC_ANTHROPIC);
  });

  it("never serves from a source the org's own order leaves out, even if the project's order still lists it", async () => {
    const t = install({ projectOrder: async () => [SRC_ANTHROPIC, "rovara"] });
    await t.add(anthropic());
    await t.order(["rovara"]);
    expect((await t.route()).sourceId).toBe("rovara");
  });

  it("serves an org with no record from the default order, and never from another org's sources", async () => {
    const t = install();
    await t.add(anthropic(), OTHER_ORG);
    await t.order([SRC_ANTHROPIC], OTHER_ORG);
    expect(await t.route()).toMatchObject({ sourceId: "rovara" });
    expect(defaultModelSourceOrder(false)).toEqual(["rovara"]);
    // The other org's own route is its own source.
    expect(await routeModel(t.deps, { orgId: OTHER_ORG, project: "web", model: DEFAULT_MODEL })).toMatchObject({ sourceId: SRC_ANTHROPIC, alias: `${OTHER_ORG}.${SRC_ANTHROPIC}.claude-sonnet-4-6` });
  });
});

describe("routeModel: failing closed", () => {
  it("refuses with a retryable error when the org's record cannot be read, and never falls back to Rovara's AI", async () => {
    const t = install();
    t.db.set({ pk: `ORG#${TEST_ORG}#MODEL_SOURCES`, sk: "META", entityType: "MODEL_SOURCES", sources: "garbage", order: ["rovara"], revision: 1 });
    const refused = await failure(t.route());
    expect(refused.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(refused.message).not.toContain("garbage");
    expect((await failure(servingRoutes(t.deps, { orgId: TEST_ORG, project: "web", model: DEFAULT_MODEL }))).code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect((await failure(servableModels(t.deps, TEST_ORG))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("refuses with a retryable error when the project's order or an endpoint's egress item cannot be read", async () => {
    const broken = install({ projectOrder: async () => { throw new Error("table down"); } });
    await broken.order(["rovara"]);
    expect((await failure(broken.route())).code).toBe("MODEL_PROXY_UNAVAILABLE");
    const egress = install();
    await egress.add(endpoint());
    await egress.order([SRC_ENDPOINT, "rovara"]);
    egress.db.set({ ...egressDomainsKey(TEST_ORG, { kind: "model-source", sourceId: SRC_ENDPOINT }), garbage: true });
    expect((await failure(egress.route(SONNET))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("returns the model unchanged on an install with no model proxy", async () => {
    expect(await routeModel({}, { orgId: TEST_ORG, project: "web", model: DEFAULT_MODEL })).toEqual({ sourceId: "rovara", catalog: "us.anthropic.claude-sonnet-4-6" });
  });
});

describe("personal-chatgpt", () => {
  const plan = (allowed: Record<string, string>) => ({ serves: async (developerId: string, model: ModelIdentifier) => (allowed[developerId] !== undefined && model.provider === "openai" && model.modelId === allowed[developerId] ? allowed[developerId] : undefined) });

  it("serves only an OpenAI model the payer's connection allows, and only when the order lists it", async () => {
    const t = install({ chatgpt: plan({ maya: "gpt-5.4" }) });
    await t.add(openai());
    await t.order(["personal-chatgpt", SRC_OPENAI, "rovara"]);
    expect(await t.route(GPT, { payerDeveloperId: "maya" })).toEqual({ sourceId: "personal-chatgpt", catalog: "gpt-5.4" });
    // Another payer's plan does not serve this one, and without a payer there is no plan.
    expect((await t.route(GPT, { payerDeveloperId: "kit" })).sourceId).toBe(SRC_OPENAI);
    expect((await t.route(GPT)).sourceId).toBe(SRC_OPENAI);
    // A model the plan does not allow, and a model of another company, fall past it.
    expect((await failure(t.route({ provider: "openai", modelId: "gpt-5.5" }, { payerDeveloperId: "maya" }))).code).toBe("MODEL_NOT_ALLOWED");
    expect((await t.route(DEFAULT_MODEL, { payerDeveloperId: "maya" })).sourceId).toBe("rovara");
    await t.order([SRC_OPENAI, "personal-chatgpt"]);
    expect((await t.route(GPT, { payerDeveloperId: "maya" })).sourceId).toBe(SRC_OPENAI);
    await t.order(["rovara"]);
    expect((await failure(t.route(GPT, { payerDeveloperId: "maya" }))).code).toBe("MODEL_NOT_ALLOWED");
  });

  it("is built from the connections: the install switch, the connection's status and its allowed models", async () => {
    const connections = (state: { enabled: boolean; connected?: boolean; status?: string; statusAt?: string; models?: string[]; fail?: boolean }) => ({
      settings: async () => { if (state.fail) throw new Error("down"); return { enabled: state.enabled }; },
      view: async () => ({ connected: state.connected ?? true, status: state.status ?? "connected", models: state.models ?? ["gpt-5.4", "gpt-5.5"], ...(state.statusAt === undefined ? {} : { statusAt: state.statusAt }) }),
    });
    const serves = (state: Parameters<typeof connections>[0], now = Date.parse("2026-10-21T12:00:00Z")) => chatGptServing(connections(state) as never, () => now).serves("maya", GPT);
    expect(await serves({ enabled: true })).toBe("gpt-5.4");
    expect(await serves({ enabled: false })).toBeUndefined();
    expect(await serves({ enabled: true, connected: false })).toBeUndefined();
    expect(await serves({ enabled: true, status: "revoked" })).toBeUndefined();
    expect(await serves({ enabled: true, models: ["gpt-5.5"] })).toBeUndefined();
    // A plan at its limit is left alone for an hour, then tried again.
    expect(await serves({ enabled: true, status: "limit-reached", statusAt: "2026-10-21T11:30:00Z" })).toBeUndefined();
    expect(await serves({ enabled: true, status: "limit-reached", statusAt: "2026-10-21T10:30:00Z" })).toBe("gpt-5.4");
    // A connection that cannot be read serves nothing; the task never fails for it.
    expect(await serves({ enabled: true, fail: true })).toBeUndefined();
  });
});

describe("servableModels and the wire form", () => {
  it("lists what the org's usable sources serve: Rovara's catalog only when Rovara is in the order, and a company source's models", async () => {
    const t = install();
    await t.add(anthropic());
    await t.add(bedrock(false));
    await t.order([SRC_ANTHROPIC, SRC_BEDROCK]);
    const names = (models: ModelIdentifier[]) => models.map((model) => `${model.provider}/${model.modelId}`);
    expect(names(await servableModels(t.deps, TEST_ORG))).toEqual(["anthropic/claude-sonnet-4-6"]);
    await t.order([SRC_ANTHROPIC, "rovara"]);
    const withRovara = names(await servableModels(t.deps, TEST_ORG));
    expect(withRovara).toContain("anthropic/claude-sonnet-4-6");
    expect(withRovara).toContain("amazon-bedrock/us.anthropic.claude-sonnet-4-6");
    // A pending endpoint serves nothing yet.
    await t.add(endpoint());
    await t.order([SRC_ANTHROPIC, SRC_ENDPOINT]);
    expect(names(await servableModels(t.deps, TEST_ORG))).toEqual(["anthropic/claude-sonnet-4-6"]);
    t.egress(SRC_ENDPOINT, "approved");
    expect(names(await servableModels(t.deps, TEST_ORG))).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("is Rovara's catalog on an install with no model proxy", async () => {
    const models = await servableModels({}, TEST_ORG);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.provider === "amazon-bedrock")).toBe(true);
  });

  it("puts a route on the wire only when the worker cannot already reach the model by its own name", () => {
    // Rovara's catalog model asked for by its own Bedrock id is the worker's default path: no modelRoute, so the payload does not change.
    expect(routeOnWire({ sourceId: "rovara", alias: "us.anthropic.claude-sonnet-4-6", api: "anthropic-messages", catalog: "us.anthropic.claude-sonnet-4-6" }, DEFAULT_MODEL)).toBeUndefined();
    expect(routeOnWire({ sourceId: "rovara", catalog: "us.anthropic.claude-sonnet-4-6" }, DEFAULT_MODEL)).toBeUndefined();
    expect(routeOnWire({ sourceId: "personal-chatgpt", catalog: "gpt-5.4" }, GPT)).toBeUndefined();
    // The same catalog model asked for by another name must be called by its alias.
    expect(routeOnWire({ sourceId: "rovara", alias: "us.anthropic.claude-sonnet-4-6", api: "anthropic-messages", catalog: "us.anthropic.claude-sonnet-4-6" }, SONNET))
      .toEqual({ alias: "us.anthropic.claude-sonnet-4-6", api: "anthropic-messages", catalog: "us.anthropic.claude-sonnet-4-6" });
    expect(routeOnWire({ sourceId: SRC_ANTHROPIC, alias: "a.b.c", api: "anthropic-messages", catalog: "claude-sonnet-4-6" }, DEFAULT_MODEL)).toEqual({ alias: "a.b.c", api: "anthropic-messages", catalog: "claude-sonnet-4-6" });
  });
});

describe("routeStep: the operation's model, the plan and the install's geography", () => {
  const plan = { serves: async (developerId: string, model: ModelIdentifier) => (developerId === "maya" && model.provider === "openai" && model.modelId === "gpt-5.4" ? "gpt-5.4" : undefined) };
  const step = (model: ModelIdentifier | undefined, extra: Partial<Parameters<typeof routeStep>[1]> = {}) => ({ orgId: TEST_ORG, project: "web", agent: "Rovara Code", step: "Build", model, ...extra });

  it("routes a step that names no model as the install's default worker model", async () => {
    const t = install();
    await t.order(["rovara"]);
    const routed = await routeStep(t.deps, step(undefined));
    expect(routed.requested).toEqual(DEFAULT_MODEL);
    expect(routed.route).toMatchObject({ sourceId: "rovara", alias: "us.anthropic.claude-sonnet-4-6" });
    expect(routed.wire).toBeUndefined();
    expect(routed.keepChatgpt).toBe(false);
  });

  it("serves the default from a company source that comes first, and sends that route to the worker", async () => {
    const t = install();
    await t.add(anthropic());
    await t.order([SRC_ANTHROPIC, "rovara"]);
    const routed = await routeStep(t.deps, step(undefined));
    expect(routed.route).toMatchObject({ sourceId: SRC_ANTHROPIC });
    expect(routed.wire).toEqual({ alias: `${TEST_ORG}.${SRC_ANTHROPIC}.claude-sonnet-4-6`, api: "anthropic-messages", catalog: "claude-sonnet-4-6" });
  });

  it("refuses with the step's words when nothing serves the model, naming the model it would have run", async () => {
    const t = install();
    await t.add(openai());
    await t.order([SRC_OPENAI]);
    expect(await failure(routeStep(t.deps, step(undefined, { agent: "Ticket Triage", step: "Plan" })))).toMatchObject({
      code: "MODEL_NOT_ALLOWED", message: "MODEL_NOT_ALLOWED: Ticket Triage's Plan step uses amazon-bedrock/us.anthropic.claude-sonnet-4-6, which isn't allowed on web. Ask the agent's owner to pick another model.",
    });
  });

  it("keeps the ChatGPT plan only while it is the first source in the order that serves the plan's model", async () => {
    const t = install({ chatgpt: plan });
    await t.add(openai());
    // Governed routing verifies the same stored-key presence as the C53 resolver.
    const sourceKey=modelSourcesKey(TEST_ORG);t.db.set({...t.db.get(sourceKey)!,credentials:[SRC_OPENAI]});
    const withPlan = { plan: { developerId: "maya", model: GPT } };
    await t.order(["personal-chatgpt", SRC_OPENAI, "rovara"]);
    expect(await routeStep(t.deps, step(DEFAULT_MODEL, withPlan))).toMatchObject({ keepChatgpt: true, route: { sourceId: "rovara" } });
    await expect(routeStep(t.deps,step(DEFAULT_MODEL,{...withPlan,expectedSourceId:"personal-chatgpt"}))).resolves.toMatchObject({keepChatgpt:true});
    await expect(routeStep(t.deps,step(DEFAULT_MODEL,{...withPlan,expectedSourceId:"rovara"}))).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});
    await t.order([SRC_OPENAI, "personal-chatgpt", "rovara"]);
    expect(await routeStep(t.deps, step(DEFAULT_MODEL, withPlan))).toMatchObject({ keepChatgpt: false, route: { sourceId: "rovara" } });
    await expect(routeStep(t.deps,step(DEFAULT_MODEL,{...withPlan,expectedSourceId:"personal-chatgpt"}))).rejects.toMatchObject({code:"MODEL_NOT_ALLOWED"});
  });

  it("lets a plan's backup go unserved without refusing the task, and records that no company key may stand in", async () => {
    const t = install({ chatgpt: plan });
    await t.order(["personal-chatgpt"]);
    const routed = await routeStep(t.deps, step(DEFAULT_MODEL, { plan: { developerId: "maya", model: GPT } }));
    expect(routed).toMatchObject({ keepChatgpt: true, route: null });
    expect(routed.wire).toBeUndefined();
    // The same unserved model without a plan is a refusal.
    expect((await failure(routeStep(t.deps, step(DEFAULT_MODEL)))).code).toBe("MODEL_NOT_ALLOWED");
  });

  it("never lets the plan serve the model a task runs through the proxy", async () => {
    const t = install({ chatgpt: plan });
    await t.order(["personal-chatgpt", "rovara"]);
    // GPT is served by the plan alone; the proxy-side route needs an alias, so an operation off the plan cannot be routed to it.
    expect((await failure(routeStep(t.deps, step(GPT)))).code).toBe("MODEL_NOT_ALLOWED");
  });

  it("uses the install's Bedrock geography: an eu install's default and catalog are the eu profiles", async () => {
    const t = install();
    await t.order(["rovara"]);
    const eu = { ...t.deps, rovaraGeography: "eu" as const };
    expect(defaultWorkerModel("eu")).toEqual({ provider: "amazon-bedrock", modelId: "eu.anthropic.claude-sonnet-4-6" });
    expect(defaultWorkerModel()).toEqual(DEFAULT_MODEL);
    const routed = await routeStep(eu, step(undefined));
    expect(routed.requested.modelId).toBe("eu.anthropic.claude-sonnet-4-6");
    expect(routed.route).toMatchObject({ sourceId: "rovara", alias: "eu.anthropic.claude-sonnet-4-6" });
    // A model named by another route is served from the geography's profile.
    expect(await routeModel(eu, { orgId: TEST_ORG, project: "web", model: SONNET })).toMatchObject({ sourceId: "rovara", alias: "eu.anthropic.claude-sonnet-4-6" });
    // A model that names its own geography keeps it.
    expect(await routeModel(eu, { orgId: TEST_ORG, project: "web", model: DEFAULT_MODEL })).toMatchObject({ alias: "us.anthropic.claude-sonnet-4-6" });
  });
});
