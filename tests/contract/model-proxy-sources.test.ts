// Plan 3 Task 25: company sources in the model proxy. A fake LiteLLM keeps models, credentials and teams the way the real one does
// (docs/learnings/model-sources-spike.md), and a fake STS evaluates a role's trust policy, so the Bedrock probe tests prove something.
import { INFERENCE_PATHS, ModelSourceSchema, agentXError, sourceAlias, type AgentXError, type ModelSource } from "@agentx/contracts";
import type * as NodeCrypto from "node:crypto";
import { createHash, randomInt } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { ModelAccess } from "../../packages/broker/src/model-proxy/access.js";
import { ModelProxyClient, type RoleAssumer } from "../../packages/broker/src/model-proxy/client.js";
import { createModelAccessHandler, endpointSecretReader, stsRoleAssumer } from "../../packages/broker/src/model-proxy/handler.js";
import { endpointQualificationDigest } from "../../packages/broker/src/model-sources/endpoint-digest.js";
import { ModelAccessInvoker } from "../../packages/broker/src/model-proxy/invoker.js";

// A passthrough spy, so the probe's random id can be shown to come from randomInt (no modulo bias).
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const BASE = "http://proxy.internal:4001";
const MASTER = "sk-master-planted-value";
const ORG = "org_abcdefghij0123456789";
const OTHER_ORG = "org_zzzzzzzzzz9876543210";
const SRC = "src_abcdefghij0123456789";
const SRC_TWO = "src_klmnopqrst0123456789";
const VENDOR_KEY = "sk-ant-planted-vendor-key-1234567890";
const ROLE = "arn:aws:iam::123456789012:role/rovara/proxy-access";
const CATALOG = ["us.anthropic.claude-sonnet-4-6", "us.anthropic.claude-haiku-4-5-20251001-v1:0"];

const sonnet = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const haiku = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const bedrockModel = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" };

const anthropicSource = (models = [sonnet, haiku], sourceId = SRC): ModelSource => ModelSourceSchema.parse({ kind: "anthropic", sourceId, label: "Company Anthropic", models: models.map((catalog) => ({ catalog })) });
const bedrockSource = (tested = false, sourceId = SRC): ModelSource => ModelSourceSchema.parse({
  kind: "bedrock", sourceId, label: "Our AWS", roleArn: ROLE, region: "us-east-1", externalId: `rovara-${ORG}`, models: [{ catalog: bedrockModel }], tested,
});
const REF = `rovara/model-endpoints/${ORG}/llm.example.com/gateway-key`;
/** An endpoint source as stored: with the secret reference N8 requires for a key, and (when `qualified`) the digest a passing check wrote. */
const endpointSource = (api = "openai-completions", options: { qualified?: boolean; keyRef?: string | null } = {}): ModelSource => {
  const base = { kind: "endpoint", sourceId: SRC, label: "Gateway", baseUrl: "https://llm.example.com/v1", api, models: [{ name: "our-model", catalog: sonnet }], ...(options.keyRef === null ? {} : { keyRef: options.keyRef ?? REF }) };
  const parsed = ModelSourceSchema.parse(base);
  return options.qualified === true && parsed.kind === "endpoint" ? ModelSourceSchema.parse({ ...base, qualifiedDigest: endpointQualificationDigest(parsed) }) : parsed;
};
/** The secret the fake reader holds for each reference. */
const resolver = (secrets: Record<string, string> = { [REF]: VENDOR_KEY }) => vi.fn(async (reference: string) => {
  const value = secrets[reference];
  if (value === undefined) throw new Error(`no secret ${reference} value=${VENDOR_KEY}`);
  return value;
});

/** Pi's catalog prices for a model, in USD per million tokens. */
const prices = (model: { modelId: string }) => (model.modelId.includes("unpriced") ? undefined : { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Seen { method: string; path: string; search: string; body: Record<string, unknown> | undefined }
/** Every body field the fake reads, typed once; the registry's real bodies carry the fields each route needs. */
interface Body { id: string; model_name: string; litellm_params: Record<string, unknown>; model_info: Record<string, unknown>; credential_name: string; credential_values: Record<string, unknown>; credential_info: unknown; team_id: string; models: string[] }
interface StoredModel { id: string; model_name: string; litellm_params: Record<string, unknown>; model_info: Record<string, unknown> }
interface StoredCredential { credential_name: string; credential_values: Record<string, unknown>; credential_info: unknown }

/** A stateful fake of the LiteLLM routes the registry uses. */
function litellm(options: { health?: (id: string) => { healthy: number; unhealthy: number }; failOn?: (seen: Seen) => Response | undefined; /** The usage a test completion reports; absent means a usual one. */ usage?: (seen: Seen) => Record<string, unknown> | undefined | null; completion?: (seen: Seen) => Response | undefined } = {}) {
  const models: StoredModel[] = [];
  const credentials = new Map<string, StoredCredential>();
  const teams = new Map<string, string[] | undefined>();
  const seen: Seen[] = [];
  const keys: Array<Record<string, unknown>> = [];
  let counter = 0;
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const entry: Seen = {
      method: init?.method ?? "GET", path: url.pathname, search: url.search,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    seen.push(entry);
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${MASTER}`) return json({ error: "unauthorized" }, 401);
    const failure = options.failOn?.(entry);
    if (failure !== undefined) return failure;
    const { method, path } = entry;
    const body = entry.body as unknown as Body;
    if (method === "GET" && path === "/model/info") {
      // The real listing returns litellm_params with secrets masked; this fake returns none, which the registry must not need.
      return json({ data: models.map(({ id, model_name, model_info, litellm_params }) => ({ model_name, litellm_params: { model: "masked", ...(typeof litellm_params.api_base === "string" ? { api_base: litellm_params.api_base } : {}) }, model_info: { ...model_info, id } })) });
    }
    if (method === "POST" && path === "/model/new") {
      counter += 1;
      const id = `model-id-${String(counter)}`;
      models.push({ id, model_name: body.model_name, litellm_params: body.litellm_params, model_info: body.model_info });
      return json({ model_id: id });
    }
    if (method === "POST" && path === "/model/delete") {
      const at = models.findIndex((model) => model.id === body.id);
      if (at < 0) return json({ error: { message: "model not found" } }, 404);
      models.splice(at, 1);
      return json({ message: "deleted" });
    }
    if (method === "GET" && path === "/credentials") {
      return json({ credentials: [...credentials].map(([credential_name, value]) => ({ credential_name, credential_info: value.credential_info, credential_values: { api_key: "sk****", ...(typeof value.credential_values.api_base === "string" ? { api_base: value.credential_values.api_base } : {}) } })) });
    }
    if (method === "POST" && path === "/credentials") {
      if (credentials.has(body.credential_name)) return json({ error: { message: "credential already exists" } }, 400);
      credentials.set(body.credential_name, body);
      return json({ success: true });
    }
    if (method === "PATCH" && path.startsWith("/credentials/")) {
      const name = decodeURIComponent(path.slice("/credentials/".length));
      if (!credentials.has(name)) return json({ error: { message: "not found" } }, 404);
      if (body.credential_name !== name) return json({ error: { message: "credential_name is required in the body" } }, 400);
      credentials.set(name, body);
      return json({ success: true });
    }
    if (method === "DELETE" && path.startsWith("/credentials/")) {
      const name = decodeURIComponent(path.slice("/credentials/".length));
      return credentials.delete(name) ? json({ success: true }) : json({ error: { message: "not found" } }, 404);
    }
    if (method === "POST" && path === "/team/new") {
      if (teams.has(body.team_id)) return json({ error: { message: `Team id = ${body.team_id} already exists. Please use a different team id.` } }, 400);
      // A team created with no models can call every model: the fake records that as undefined.
      teams.set(body.team_id, body.models);
      return json({ team_id: body.team_id });
    }
    if (method === "POST" && path === "/team/update") {
      if (Object.hasOwn(entry.body ?? {}, "models")) teams.set(body.team_id, body.models);
      return json({ team_id: body.team_id });
    }
    if (method === "GET" && path === "/team/info") {
      const id = new URLSearchParams(url.search).get("team_id") ?? "";
      return teams.has(id) ? json({ team_id: id, team_info: { team_id: id, models: teams.get(id) } }) : json({ error: { message: "team not found" } }, 404);
    }
    if (method === "POST" && path === "/key/generate") {
      counter += 1;
      const key = `sk-virtual-${String(counter)}`;
      keys.push({ key, token: createHash("sha256").update(key).digest("hex"), models: entry.body!.models, team_id: entry.body!.team_id, allowed_routes: entry.body!.allowed_routes, aliases: {} });
      return json({ key });
    }
    if (method === "GET" && path === "/key/info") {
      const found = keys.find((candidate) => candidate.token === new URLSearchParams(url.search).get("key"));
      return found === undefined ? json({ error: { message: "key not found" } }, 404) : json({ info: found });
    }
    if (method === "POST" && (path === "/chat/completions" || path === "/v1/messages" || path === "/v1/responses")) {
      const answered = options.completion?.(entry);
      if (answered !== undefined) return answered;
      const reported = options.usage === undefined ? (path === "/v1/messages" ? { input_tokens: 5, output_tokens: 2 } : { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }) : options.usage(entry);
      return json({ id: "reply", ...(reported === null || reported === undefined ? {} : { usage: reported }) });
    }
    if (method === "GET" && path === "/health") {
      const id = new URLSearchParams(url.search).get("model_id") ?? "";
      const figures = options.health?.(id) ?? { healthy: 1, unhealthy: 0 };
      return json({ healthy_endpoints: [], unhealthy_endpoints: [{ error: "stack trace with sk-up****yz", raw_request_typed_dict: {} }].slice(0, figures.unhealthy), healthy_count: figures.healthy, unhealthy_count: figures.unhealthy });
    }
    return json({ error: { message: `unexpected ${method} ${path}` } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch: fetchFake, models, credentials, teams, seen, calls: () => seen.map((entry) => `${entry.method} ${entry.path}`) };
}

// ---------------------------------------------------------------- the fake STS: it evaluates the role's trust policy

type Condition = Record<string, Record<string, string | string[]>>;
interface Trust { Effect: "Allow" | "Deny"; Condition?: Condition }

const globToRegExp = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);

/** Whether a trust statement's conditions hold for the external id; an absent external id never satisfies a condition on it. */
function conditionsHold(condition: Condition | undefined, externalId: string | undefined): boolean {
  for (const [operator, keys] of Object.entries(condition ?? {})) {
    for (const [key, expected] of Object.entries(keys)) {
      if (key !== "sts:ExternalId") throw new Error(`test setup: the fake STS does not evaluate ${key}`);
      const values = [expected].flat();
      if (externalId === undefined) return false;
      if (operator === "StringEquals" && !values.includes(externalId)) return false;
      if (operator === "StringLike" && !values.some((pattern) => globToRegExp(pattern).test(externalId))) return false;
      if (operator !== "StringEquals" && operator !== "StringLike") throw new Error(`test setup: the fake STS does not evaluate ${operator}`);
    }
  }
  return true;
}

function fakeSts(trust: Trust[] | undefined) {
  const attempts: Array<{ roleArn: string; externalId: string; sessionName: string }> = [];
  const roles: RoleAssumer = {
    async assumeRole(input) {
      attempts.push(input);
      if (trust === undefined) return false;
      return trust.some((statement) => statement.Effect === "Allow" && conditionsHold(statement.Condition, input.externalId));
    },
  };
  return { roles, attempts };
}

function client(proxy: ReturnType<typeof litellm>, extra: Partial<ConstructorParameters<typeof ModelProxyClient>[0]> = {}) {
  return new ModelProxyClient({
    baseUrl: BASE, masterKey: async () => MASTER, fetch: proxy.fetch, now: () => 1_800_000_000_000,
    prices, catalog: CATALOG, random: () => "randomwrongid0123456", ...extra,
  });
}

const failure = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { return error as AgentXError; }
  throw new Error("expected a rejection");
};

const aliasOf = (source: ModelSource, index: number) => sourceAlias(ORG, source.sourceId, source.models[index]!.catalog);

describe("upsertSource", () => {
  it("stores the key as a proxy credential and registers one org-aliased model per source model, with no raw key in any model body", async () => {
    const proxy = litellm();
    const source = anthropicSource();
    await client(proxy).upsertSource({ orgId: ORG, source, apiKey: VENDOR_KEY });

    expect(proxy.credentials.get(`${ORG}.${SRC}`)).toEqual({
      credential_name: `${ORG}.${SRC}`,
      credential_values: { api_key: VENDOR_KEY },
      credential_info: { rovara_org: ORG, rovara_source: SRC },
    });
    expect(proxy.models.map((model) => model.model_name).sort()).toEqual([aliasOf(source, 0), aliasOf(source, 1)].sort());
    const sonnetModel = proxy.models.find((model) => model.model_name === aliasOf(source, 0))!;
    expect(sonnetModel.litellm_params).toEqual({
      model: "anthropic/claude-sonnet-4-5",
      litellm_credential_name: `${ORG}.${SRC}`,
      ssl_verify: true,
      input_cost_per_token: 3 / 1_000_000,
      output_cost_per_token: 15 / 1_000_000,
      cache_read_input_token_cost: 0.3 / 1_000_000,
      cache_creation_input_token_cost: 3.75 / 1_000_000,
    });
    expect(sonnetModel.model_info).toMatchObject({ rovara_org: ORG, input_cost_per_token: 3 / 1_000_000, output_cost_per_token: 15 / 1_000_000 });
    // The key travels once, in the credential call, and in no model body.
    for (const entry of proxy.seen.filter((seen) => seen.path === "/model/new")) expect(JSON.stringify(entry.body)).not.toContain(VENDOR_KEY);
    expect(proxy.seen.filter((seen) => JSON.stringify(seen.body ?? {}).includes(VENDOR_KEY)).map((seen) => `${seen.method} ${seen.path}`)).toEqual(["POST /credentials"]);
  });

  it("sets the org team's models to its aliases plus the Rovara AI catalog, keeping its other sources' aliases", async () => {
    const proxy = litellm();
    const first = anthropicSource([sonnet], SRC);
    const second = anthropicSource([haiku], SRC_TWO);
    await client(proxy).upsertSource({ orgId: ORG, source: first, apiKey: VENDOR_KEY });
    await client(proxy).upsertSource({ orgId: ORG, source: second, apiKey: VENDOR_KEY });
    expect([...proxy.teams.get(ORG)!].sort()).toEqual([sourceAlias(ORG, SRC, sonnet), sourceAlias(ORG, SRC_TWO, haiku), ...CATALOG].sort());
    expect(proxy.teams.has(OTHER_ORG)).toBe(false);
  });

  it("rotates the key with PATCH, naming the credential in the body, when it is already stored", async () => {
    const proxy = litellm();
    const source = anthropicSource();
    await client(proxy).upsertSource({ orgId: ORG, source, apiKey: VENDOR_KEY });
    await client(proxy).upsertSource({ orgId: ORG, source, apiKey: "sk-ant-rotated-key-0987654321" });
    expect(proxy.calls().filter((call) => call.includes("/credentials"))).toEqual(["GET /credentials", "POST /credentials", "GET /credentials", "PATCH /credentials/" + `${ORG}.${SRC}`]);
    expect(proxy.credentials.get(`${ORG}.${SRC}`)!.credential_values.api_key).toBe("sk-ant-rotated-key-0987654321");
  });

  it("changes models without a key when one is stored", async () => {
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: anthropicSource([sonnet]), apiKey: VENDOR_KEY });
    proxy.seen.length = 0;
    await client(proxy).upsertSource({ orgId: ORG, source: anthropicSource([sonnet, haiku]) });
    expect(proxy.seen.filter((entry) => entry.path.startsWith("/credentials") && entry.method !== "GET")).toEqual([]);
    expect(proxy.models.filter((model) => model.litellm_params.litellm_credential_name === `${ORG}.${SRC}`)).toHaveLength(2);
    expect(proxy.credentials.get(`${ORG}.${SRC}`)!.credential_values.api_key).toBe(VENDOR_KEY);
  });

  it("refuses a keyed source that has no key, stored or sent, before writing anything", async () => {
    const proxy = litellm();
    const error = await failure(client(proxy).upsertSource({ orgId: ORG, source: anthropicSource() }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(proxy.seen.filter((entry) => entry.method !== "GET")).toEqual([]);
  });

  it("deletes the aliases the source no longer lists, creating the new deployments first, and leaves other sources and orgs alone", async () => {
    const proxy = litellm();
    const other = anthropicSource([sonnet], SRC_TWO);
    await client(proxy).upsertSource({ orgId: ORG, source: other, apiKey: VENDOR_KEY });
    // Another org's model, put there by the same registry.
    const foreign = ModelSourceSchema.parse({ kind: "anthropic", sourceId: SRC, label: "Theirs", models: [{ catalog: sonnet }] });
    await client(proxy).upsertSource({ orgId: OTHER_ORG, source: foreign, apiKey: VENDOR_KEY });
    const source = anthropicSource([sonnet, haiku]);
    await client(proxy).upsertSource({ orgId: ORG, source, apiKey: VENDOR_KEY });
    const idsBefore = proxy.models.filter((model) => model.model_name.startsWith(`${ORG}.${SRC}.`)).map((model) => model.id);
    expect(idsBefore).toHaveLength(2);

    const trimmed = anthropicSource([sonnet]);
    proxy.seen.length = 0;
    await client(proxy).upsertSource({ orgId: ORG, source: trimmed });
    const names = proxy.models.map((model) => model.model_name).sort();
    expect(names).toEqual([sourceAlias(ORG, SRC_TWO, sonnet), aliasOf(trimmed, 0), sourceAlias(OTHER_ORG, SRC, sonnet)].sort());
    expect(proxy.models.filter((model) => model.model_name === aliasOf(trimmed, 0))).toHaveLength(1);
    // New first, then the old ones (both of the earlier two) go.
    const writes = proxy.seen.filter((entry) => entry.method === "POST" && entry.path.startsWith("/model/")).map((entry) => entry.path);
    expect(writes).toEqual(["/model/new", "/model/delete", "/model/delete"]);
    expect(proxy.seen.filter((entry) => entry.path === "/model/delete").map((entry) => entry.body!.id).sort()).toEqual([...idsBefore].sort());
    expect([...proxy.teams.get(ORG)!].sort()).toEqual([sourceAlias(ORG, SRC_TWO, sonnet), aliasOf(trimmed, 0), ...CATALOG].sort());
  });

  it("registers a Bedrock source with its role, region and external id and no credential", async () => {
    const proxy = litellm();
    const source = bedrockSource();
    await client(proxy).upsertSource({ orgId: ORG, source });
    expect(proxy.calls().some((call) => call.includes("/credentials"))).toBe(false);
    expect(proxy.models).toHaveLength(1);
    expect(proxy.models[0]!.litellm_params).toMatchObject({
      model: "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      aws_region_name: "us-east-1",
      aws_role_name: ROLE,
      aws_external_id: `rovara-${ORG}`,
      ssl_verify: true,
    });
    expect(proxy.models[0]!.litellm_params).not.toHaveProperty("litellm_credential_name");
    expect(proxy.models[0]!.model_name).toBe(aliasOf(source, 0));
  });

  it("registers an endpoint with its base address, the transport's provider prefix and the reasoning flag", async () => {
    const completions = litellm();
    await client(completions, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource("openai-completions") });
    expect(completions.models[0]!.litellm_params).toMatchObject({ model: "openai/our-model", api_base: "https://llm.example.com/v1", litellm_credential_name: `${ORG}.${SRC}` });
    expect(completions.models[0]!.model_info.supports_reasoning).toBe(true);
    expect(completions.credentials.get(`${ORG}.${SRC}`)!.credential_values).toEqual({ api_key: VENDOR_KEY, api_base: "https://llm.example.com/v1" });
    const messages = litellm();
    await client(messages, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource("anthropic-messages") });
    expect(messages.models[0]!.litellm_params.model).toBe("anthropic/our-model");
  });

  it("refuses, before any write, a model without a list price, a source of another org, and a missing catalog", async () => {
    const proxy = litellm();
    const unpriced = anthropicSource([{ provider: "anthropic", modelId: "claude-unpriced-9" }]);
    expect((await failure(client(proxy).upsertSource({ orgId: ORG, source: unpriced, apiKey: VENDOR_KEY }))).code).toBe("CONFIG_INVALID");
    const wrongOrg = ModelSourceSchema.parse({ ...bedrockSource(), externalId: `rovara-${OTHER_ORG}` });
    expect((await failure(client(proxy).upsertSource({ orgId: ORG, source: wrongOrg }))).message).toContain("external id");
    // A team with empty models can call every model, so without the catalog the registry does not touch a team at all.
    expect((await failure(client(proxy, { catalog: [] }).upsertSource({ orgId: ORG, source: anthropicSource(), apiKey: VENDOR_KEY }))).code).toBe("CONFIG_INVALID");
    expect(proxy.seen.filter((entry) => entry.method !== "GET")).toEqual([]);
  });

  it("refuses an alias that another org's deployment already carries", async () => {
    const proxy = litellm();
    const source = anthropicSource([sonnet]);
    proxy.models.push({ id: "squatter", model_name: aliasOf(source, 0), litellm_params: {}, model_info: { rovara_org: OTHER_ORG } });
    const error = await failure(client(proxy).upsertSource({ orgId: ORG, source, apiKey: VENDOR_KEY }));
    expect(error.message).toContain("already exists");
    expect(proxy.seen.filter((entry) => entry.method !== "GET")).toEqual([]);
  });

  it("never echoes the vendor key when the proxy refuses a call that quoted it", async () => {
    const proxy = litellm({ failOn: (seen) => (seen.path === "/credentials" && seen.method === "POST" ? json({ error: { message: `bad credential ${VENDOR_KEY} rejected` } }, 400) : undefined) });
    const error = await failure(client(proxy).upsertSource({ orgId: ORG, source: anthropicSource(), apiKey: VENDOR_KEY }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toContain("rejected");
    expect(error.message).not.toContain(VENDOR_KEY);
    expect(error.message).not.toContain("sk-ant");
  });
});

describe("upsertOrg: every org team is scoped", () => {
  it("creates a team with no sources limited to the Rovara AI catalog, never to an empty list", async () => {
    const proxy = litellm();
    await client(proxy).upsertOrg(ORG, 100);
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
    const created = proxy.seen.find((entry) => entry.path === "/team/new")!;
    expect(created.body).toEqual({ team_id: ORG, max_budget: 100, budget_duration: "1mo", models: CATALOG });
  });

  it("brings an existing unscoped team in line on its next upsert, and keeps the org's own aliases there", async () => {
    const proxy = litellm();
    const source = anthropicSource([sonnet]);
    await client(proxy).upsertSource({ orgId: ORG, source, apiKey: VENDOR_KEY });
    await client(proxy).upsertSource({ orgId: OTHER_ORG, source: ModelSourceSchema.parse({ ...source, label: "Theirs" }), apiKey: VENDOR_KEY });
    // The team as an older deploy left it: it exists and `models` is empty (every model).
    proxy.teams.set(ORG, []);
    proxy.teams.set(OTHER_ORG, undefined);
    await client(proxy).upsertOrg(ORG, 250);
    expect([...proxy.teams.get(ORG)!].sort()).toEqual([sourceAlias(ORG, SRC, sonnet), ...CATALOG].sort());
    const update = proxy.seen.filter((entry) => entry.path === "/team/update").at(-1)!;
    expect(update.body).toEqual({ team_id: ORG, max_budget: 250, budget_duration: "1mo", models: update.body!.models });
    // Another org's team is not touched by this org's upsert.
    expect(proxy.teams.get(OTHER_ORG)).toBeUndefined();
    await client(proxy).upsertOrg(OTHER_ORG, 250);
    expect(proxy.teams.get(OTHER_ORG)).not.toContain(sourceAlias(ORG, SRC, sonnet));
    expect([...proxy.teams.get(OTHER_ORG)!].sort()).toEqual([sourceAlias(OTHER_ORG, SRC, sonnet), ...CATALOG].sort());
  });

  it("leaves out a proxy model that claims the org but is not named as one of its aliases", async () => {
    const proxy = litellm();
    await proxy.fetch(`${BASE}/model/new`, { method: "POST", headers: { authorization: `Bearer ${MASTER}` }, body: JSON.stringify({ model_name: "stray-model", litellm_params: {}, model_info: { rovara_org: ORG } }) });
    await client(proxy).upsertOrg(ORG, 100);
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
  });

  it("is idempotent and leaves a Bedrock alias out until its probe has passed", async () => {
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource(false) });
    await client(proxy).upsertOrg(ORG, 10);
    await client(proxy).upsertOrg(ORG, 10);
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
  });

  it("writes nothing, and no team, when the catalog is not configured (an empty list would mean every model)", async () => {
    const proxy = litellm();
    expect((await failure(client(proxy, { catalog: [] }).upsertOrg(ORG, 100))).code).toBe("CONFIG_INVALID");
    expect(proxy.seen.filter((entry) => entry.method !== "GET")).toEqual([]);
    expect(proxy.teams.size).toBe(0);
  });
});

describe("source safety", () => {
  it("refuses an api key on a Bedrock source before anything is read or written", async () => {
    const proxy = litellm();
    const error = await failure(client(proxy).upsertSource({ orgId: ORG, source: bedrockSource(), apiKey: VENDOR_KEY }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).not.toContain(VENDOR_KEY);
    expect(proxy.seen).toEqual([]);
  });

  it("serves a Bedrock source only after its probe has passed: registered for the probe, not in the team until tested", async () => {
    const proxy = litellm();
    const untested = bedrockSource(false);
    await client(proxy).upsertSource({ orgId: ORG, source: untested });
    expect(proxy.models.map((model) => model.model_name)).toEqual([aliasOf(untested, 0)]);
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
    // The probe can still find the role.
    const sts = fakeSts([{ Effect: "Allow", Condition: { StringEquals: { "sts:ExternalId": `rovara-${ORG}` } } }]);
    expect(await client(proxy, { roles: sts.roles }).checkSource(ORG, SRC)).toEqual({ ok: true, health: "healthy" });

    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource(true) });
    expect(proxy.teams.get(ORG)).toEqual([aliasOf(untested, 0), ...CATALOG]);
    expect(proxy.models).toHaveLength(1);
  });

  it("does not add an untested Bedrock alias to the team when the org changes another source, and takes one away on removal", async () => {
    const proxy = litellm();
    const SRC_BEDROCK = "src_bbbbbbbbbb0123456789";
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource(false, SRC_BEDROCK) });
    const other = anthropicSource([sonnet]);
    await client(proxy).upsertSource({ orgId: ORG, source: other, apiKey: VENDOR_KEY });
    expect([...proxy.teams.get(ORG)!].sort()).toEqual([aliasOf(other, 0), ...CATALOG].sort());
    await client(proxy).removeSource(ORG, SRC);
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
    expect(proxy.models.map((model) => model.model_name)).toEqual([sourceAlias(ORG, SRC_BEDROCK, bedrockModel)]);
  });

  it("scrubs the vendor key before truncating a refusal, even when the key straddles the cut", async () => {
    // No sk- prefix, so only the exact-key scrub can catch it; it starts a few characters before the 300-character cut.
    const plain = "vendorkey-planted-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const message = `${"x".repeat(292)}${plain} and more`;
    for (const path of ["/credentials", "/model/new", "/team/update"]) {
      const proxy = litellm({ failOn: (seen) => (seen.path === path && seen.method === "POST" ? json({ error: { message } }, 400) : undefined) });
      const error = await failure(client(proxy).upsertSource({ orgId: ORG, source: anthropicSource([sonnet]), apiKey: plain }));
      expect(error.message, path).toContain("[key]");
      expect(error.message, path).not.toContain("vendorkey");
      expect(error.message, path).not.toContain(plain.slice(0, 5));
    }
  });
});

describe("removeSource", () => {
  it("takes the aliases out of the team, deletes the source's models and its credential, and touches nothing else", async () => {
    const proxy = litellm();
    const keep = anthropicSource([haiku], SRC_TWO);
    const gone = anthropicSource([sonnet, haiku]);
    await client(proxy).upsertSource({ orgId: ORG, source: keep, apiKey: VENDOR_KEY });
    await client(proxy).upsertSource({ orgId: ORG, source: gone, apiKey: VENDOR_KEY });
    proxy.seen.length = 0;
    await client(proxy).removeSource(ORG, SRC);
    expect(proxy.models.map((model) => model.model_name)).toEqual([sourceAlias(ORG, SRC_TWO, haiku)]);
    expect([...proxy.credentials.keys()]).toEqual([`${ORG}.${SRC_TWO}`]);
    expect([...proxy.teams.get(ORG)!].sort()).toEqual([sourceAlias(ORG, SRC_TWO, haiku), ...CATALOG].sort());
    // The team loses the aliases before the deployments are deleted (a deleted alias lingers on a replica for about 30 seconds).
    const order = proxy.calls().filter((call) => call.startsWith("POST"));
    expect(order.indexOf("POST /team/update")).toBeLessThan(order.indexOf("POST /model/delete"));
  });

  it("is a no-op for a source the proxy does not know, and a Bedrock source has no credential to delete", async () => {
    const proxy = litellm();
    await client(proxy).removeSource(ORG, SRC);
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource() });
    await client(proxy).removeSource(ORG, SRC);
    expect(proxy.models).toEqual([]);
  });
});

describe("listSources", () => {
  it("lists every org and source the proxy holds a model or a credential for, once each, and nothing else", async () => {
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: anthropicSource(), apiKey: VENDOR_KEY });
    await client(proxy).upsertSource({ orgId: OTHER_ORG, source: anthropicSource([haiku], SRC_TWO), apiKey: VENDOR_KEY });
    // A credential whose models never registered (the registration stopped half-way), and a model of the proxy's own that no org owns.
    proxy.credentials.set(`${ORG}.src_stopped0123456789abc`, { credential_name: `${ORG}.src_stopped0123456789abc`, credential_values: {}, credential_info: {} });
    proxy.credentials.set("unrelated-credential", { credential_name: "unrelated-credential", credential_values: {}, credential_info: {} });
    proxy.models.push({ id: "own", model_name: "us.anthropic.claude-sonnet-4-6", litellm_params: {}, model_info: {} });
    // A source with no key at all (Bedrock) is known by its models alone.
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource(false, "src_bedrock0123456789abc") });
    const listed = await client(proxy).listSources();
    expect(listed.map((entry) => `${entry.orgId}/${entry.sourceId}`).sort()).toEqual([`${ORG}/${SRC}`, `${ORG}/src_stopped0123456789abc`, `${OTHER_ORG}/${SRC_TWO}`, `${ORG}/src_bedrock0123456789abc`].sort());
  });

  it("is a request of its own for the handler and the invoker, and the handler refuses an argument", async () => {
    const entries = [{ orgId: ORG, sourceId: SRC }];
    const never = async () => { throw new Error("not used"); };
    const access: ModelAccess = {
      upsertOrg: never, upsertMember: never, spend: never, orgSpend: never, keySpend: never, mintKey: never, revokeKey: never, blockKey: never,
      upsertSource: never, removeSource: never, checkSource: never, listSources: vi.fn(async () => entries), auditKeys: never,
    };
    const run = createModelAccessHandler({ access, log: () => undefined });
    expect(await run({ op: "listSources", args: {} })).toEqual({ ok: true, result: entries });
    expect(await run({ op: "listSources", args: { orgId: ORG } })).toMatchObject({ ok: false });
    const lambda = { send: vi.fn(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: entries })) })) };
    expect(await new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).listSources()).toEqual(entries);
    lambda.send.mockImplementationOnce(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: [{ orgId: "nope", sourceId: SRC }] })) }));
    await expect(new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).listSources()).rejects.toThrow("unexpected result");
  });
});

describe("listSources: the hosts a registration points at", () => {
  it("returns the hosts of an endpoint's models and credential, and never a key", async () => {
    const proxy = litellm();
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource() });
    await client(proxy).upsertSource({ orgId: ORG, source: anthropicSource([haiku], SRC_TWO), apiKey: VENDOR_KEY });
    const [endpointEntry, keyedEntry] = [(await client(proxy).listSources()).find((entry) => entry.sourceId === SRC)!, (await client(proxy).listSources()).find((entry) => entry.sourceId === SRC_TWO)!];
    expect(endpointEntry.hosts).toEqual(["llm.example.com"]);
    expect(keyedEntry.hosts ?? []).toEqual([]);
    // A credential moved to another host shows next to the models' own.
    proxy.credentials.get(`${ORG}.${SRC}`)!.credential_values.api_base = "https://evil.example.net/v1";
    expect([...(await client(proxy).listSources()).find((entry) => entry.sourceId === SRC)!.hosts!].sort()).toEqual(["evil.example.net", "llm.example.com"]);
    expect(JSON.stringify(await client(proxy).listSources())).not.toContain(VENDOR_KEY);
  });

  it("carries the hosts through the invoker and refuses a host list that is not hosts", async () => {
    const entries = [{ orgId: ORG, sourceId: SRC, hosts: ["llm.example.com"] }];
    const lambda = { send: vi.fn(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: entries })) })) };
    expect(await new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).listSources()).toEqual(entries);
    lambda.send.mockImplementationOnce(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: [{ orgId: ORG, sourceId: SRC, hosts: [1] }] })) }));
    await expect(new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never }).listSources()).rejects.toThrow("unexpected result");
  });
});

describe("mintKey with sources", () => {
  const tags = { taskId: "task-1", operationId: "op-1", stepId: "build", agentId: "agt_1", project: "web", payerKind: "member" as const, payerId: "dev-1", source: SRC, origin: "slack" };
  const mint = (models: string[], extra: Partial<Parameters<ModelAccess["mintKey"]>[0]> = {}) => ({
    orgId: ORG as typeof ORG, developerId: "dev-1", purpose: "task" as const, refId: "task-1", maxBudgetUsd: 2.5, ttlSeconds: 3600, models, tags, ...extra,
  });

  /** A proxy whose org team exists, scoped to the catalog as `upsertOrg` leaves it, with the calls so far forgotten. */
  async function scoped() {
    const proxy = litellm();
    await client(proxy).upsertOrg(ORG, 500);
    proxy.seen.length = 0;
    return proxy;
  }
  const generated = (proxy: ReturnType<typeof litellm>) => proxy.seen.find((entry) => entry.path === "/key/generate")!.body!;

  it("sends models, the exact inference routes and every tag as metadata", async () => {
    const proxy = await scoped();
    const alias = sourceAlias(ORG, SRC, sonnet);
    await client(proxy).mintKey(mint([alias]));
    const body = generated(proxy);
    expect(body.models).toEqual([alias]);
    expect(body.allowed_routes).toEqual(INFERENCE_PATHS.map((entry) => entry.path));
    expect(body.allowed_routes).toEqual(["/v1/messages", "/v1/responses", "/chat/completions"]);
    expect(body.metadata).toEqual({ orgId: ORG, developerId: "dev-1", purpose: "task", refId: "task-1", ...tags });
    expect(body.team_id).toBe(ORG);
    expect(body).not.toHaveProperty("user_role");
    expect(body).not.toHaveProperty("aliases");
  });

  it("omits the tags a caller left out, and still carries the required ones", async () => {
    const proxy = await scoped();
    await client(proxy).mintKey(mint(["us.anthropic.claude-sonnet-4-6"], { tags: { agentId: "agt_1", payerKind: "agent", payerId: "agt_1", source: "rovara", origin: "api" } }));
    expect(generated(proxy).metadata).toEqual({ orgId: ORG, developerId: "dev-1", purpose: "task", refId: "task-1", agentId: "agt_1", payerKind: "agent", payerId: "agt_1", source: "rovara", origin: "api" });
  });

  it("refuses anything but this org's own aliases and exact catalog ids, sending nothing", async () => {
    const proxy = litellm({ failOn: () => json({ key: "sk-virtual-3" }) });
    const refused: Array<[string, string[]]> = [
      ["a bare wildcard", ["*"]],
      ["the all-models access group", ["all-proxy-models"]],
      ["an access group by name", ["team-shared-models"]],
      ["a raw provider name", ["anthropic/claude-sonnet-4-5"]],
      ["a raw provider wildcard", ["openai/*"]],
      ["a catalog wildcard", ["us.anthropic.claude-*"]],
      ["an own-prefixed wildcard", [`${ORG}.*`]],
      ["an own source wildcard", [`${ORG}.${SRC}.*`]],
      ["a wildcard beside a valid alias", [sourceAlias(ORG, SRC, sonnet), "*"]],
      ["another org's alias", [sourceAlias(OTHER_ORG, SRC, sonnet)]],
      ["another org's alias beside a valid one", [sourceAlias(ORG, SRC, sonnet), sourceAlias(OTHER_ORG, SRC, sonnet)]],
      ["another org's wildcard", [`${OTHER_ORG}.*`]],
      ["an id that is not in the catalog", ["us.anthropic.claude-opus-9"]],
      ["the org prefix alone", [`${ORG}.`]],
      ["the org id itself", [ORG]],
      ["an empty list", []],
    ];
    for (const [what, models] of refused) expect((await failure(client(proxy).mintKey(mint(models)))).code, what).toBe("CONFIG_INVALID");
    expect(proxy.seen).toEqual([]);
  });

  it("accepts this org's own aliases and exact catalog ids, together", async () => {
    const proxy = await scoped();
    const models = [sourceAlias(ORG, SRC, sonnet), CATALOG[0]!, CATALOG[1]!];
    await client(proxy).mintKey(mint(models));
    expect(generated(proxy).models).toEqual(models);
  });

  it("refuses a keyed mint when the catalog is not configured, since it could not tell a catalog id from a stranger's model", async () => {
    const proxy = litellm({ failOn: () => json({ key: "sk-virtual-5" }) });
    expect((await failure(client(proxy, { catalog: [] }).mintKey(mint([sourceAlias(ORG, SRC, sonnet)])))).code).toBe("CONFIG_INVALID");
    expect(proxy.seen).toEqual([]);
  });
});

describe("checkSource: the Bedrock probe", () => {
  const trustFor = (condition?: Condition): Trust[] => [{ Effect: "Allow", ...(condition === undefined ? {} : { Condition: condition }) }];

  async function probe(trust: Trust[] | undefined) {
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource() });
    const sts = fakeSts(trust);
    proxy.seen.length = 0;
    const result = await client(proxy, { roles: sts.roles }).checkSource(ORG, SRC);
    return { result, sts, proxy };
  }

  it("passes a role whose trust policy requires this org's external id, trying that id and then a random wrong one", async () => {
    const { result, sts } = await probe(trustFor({ StringEquals: { "sts:ExternalId": `rovara-${ORG}` } }));
    expect(result).toEqual({ ok: true, health: "healthy" });
    expect(sts.attempts.map((attempt) => attempt.externalId)).toEqual([`rovara-${ORG}`, "rovara-org_randomwrongid0123456"]);
    expect(sts.attempts.every((attempt) => attempt.roleArn === ROLE)).toBe(true);
  });

  it("refuses a role that accepts the random wrong external id: no condition at all", async () => {
    const { result, proxy } = await probe(trustFor());
    expect(result).toEqual({ ok: false, message: `this role's trust policy must require the external id rovara-${ORG}` });
    // A refused trust policy is not tested for health: nothing is called through a role that anyone could assume.
    expect(proxy.calls().filter((call) => call.includes("/health"))).toEqual([]);
  });

  it("refuses a trust policy written as StringLike sts:ExternalId rovara-*", async () => {
    const { result } = await probe(trustFor({ StringLike: { "sts:ExternalId": "rovara-*" } }));
    expect(result).toEqual({ ok: false, message: `this role's trust policy must require the external id rovara-${ORG}` });
  });

  it("refuses a role that does not accept this org's external id, saying so, without trying the wrong one", async () => {
    const { result, sts } = await probe(trustFor({ StringEquals: { "sts:ExternalId": "rovara-org_someoneelse0123456" } }));
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain(`rovara-${ORG}`);
    expect(sts.attempts).toHaveLength(1);
    expect((await probe(undefined)).result).toMatchObject({ ok: false });
  });

  it("uses twenty lowercase base-36 characters after rovara-org_ by default, and the wrong id is never the real one", async () => {
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource() });
    const sts = fakeSts(trustFor({ StringEquals: { "sts:ExternalId": `rovara-${ORG}` } }));
    const real = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch: proxy.fetch, now: () => 0, prices, catalog: CATALOG, roles: sts.roles });
    await real.checkSource(ORG, SRC);
    await real.checkSource(ORG, SRC);
    const wrong = sts.attempts.filter((attempt) => attempt.externalId !== `rovara-${ORG}`).map((attempt) => attempt.externalId);
    expect(wrong).toHaveLength(2);
    for (const id of wrong) expect(id).toMatch(/^rovara-org_[0-9a-z]{20}$/);
    expect(new Set(wrong).size).toBe(2);
  });

  it("draws every character of the wrong external id from randomInt(36), so no value is more likely than another", async () => {
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource() });
    const sts = fakeSts(trustFor({ StringEquals: { "sts:ExternalId": `rovara-${ORG}` } }));
    const draws = randomInt as unknown as Mock<(max: number) => number>;
    let next = 0;
    const maxes: number[] = [];
    draws.mockClear();
    draws.mockImplementation(() => next++ % 36);
    try {
      const real = new ModelProxyClient({ baseUrl: BASE, masterKey: async () => MASTER, fetch: proxy.fetch, now: () => 0, prices, catalog: CATALOG, roles: sts.roles });
      await real.checkSource(ORG, SRC);
      maxes.push(...draws.mock.calls.map(([max]) => max));
    } finally {
      draws.mockRestore();
    }
    expect(sts.attempts.at(-1)!.externalId).toBe("rovara-org_0123456789abcdefghij");
    expect(maxes).toEqual(Array.from({ length: 20 }, () => 36));
  });

  it("reports an unreachable STS as unavailable, not as a verdict on the trust policy", async () => {
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: bedrockSource() });
    const roles: RoleAssumer = { assumeRole: async () => { throw new Error("socket hang up"); } };
    expect((await failure(client(proxy, { roles }).checkSource(ORG, SRC))).code).toBe("MODEL_PROXY_UNAVAILABLE");
  });

  it("answers NOT_FOUND for a source the proxy does not hold", async () => {
    const proxy = litellm();
    expect((await failure(client(proxy).checkSource(ORG, SRC))).code).toBe("NOT_FOUND");
  });
});

describe("checkSource: health", () => {
  it("makes no STS call for a keyed source and maps the proxy's health answers without ever returning its body", async () => {
    let figures = { healthy: 1, unhealthy: 0 };
    const proxy = litellm({ health: () => figures });
    await client(proxy).upsertSource({ orgId: ORG, source: anthropicSource(), apiKey: VENDOR_KEY });
    const sts = fakeSts(undefined);
    const check = () => client(proxy, { roles: sts.roles }).checkSource(ORG, SRC);
    expect(await check()).toEqual({ ok: true, health: "healthy" });
    figures = { healthy: 0, unhealthy: 0 };
    expect(await check()).toEqual({ ok: true, health: "unknown" });
    figures = { healthy: 0, unhealthy: 1 };
    const unhealthy = await check();
    expect(unhealthy).toEqual({ ok: false, message: "this source did not answer a test call" });
    expect(JSON.stringify(unhealthy)).not.toContain("sk-up");
    expect(sts.attempts).toEqual([]);
  });
});

describe("the handler and the invoker carry the new operations", () => {
  function fakeAccess() {
    const never = async () => { throw new Error("not used"); };
    const upsertSource = vi.fn(async () => undefined);
    const access: ModelAccess = {
      upsertOrg: never, upsertMember: never, spend: never, orgSpend: never, keySpend: never, mintKey: never, revokeKey: never, blockKey: never,
      upsertSource, removeSource: vi.fn(async () => undefined), checkSource: vi.fn(async () => ({ ok: true as const, health: "healthy" as const })), listSources: never, auditKeys: never,
    };
    return { access, upsertSource };
  }

  it("runs upsertSource, removeSource and checkSource, and logs the operation without the key", async () => {
    const { access, upsertSource } = fakeAccess();
    const logged: Array<Record<string, unknown>> = [];
    const run = createModelAccessHandler({ access, log: (entry) => logged.push(entry) });
    const source = anthropicSource();
    expect(await run({ op: "upsertSource", args: { orgId: ORG, source, apiKey: VENDOR_KEY } })).toEqual({ ok: true, result: null });
    expect(await run({ op: "removeSource", args: { orgId: ORG, sourceId: SRC } })).toEqual({ ok: true, result: null });
    expect(await run({ op: "checkSource", args: { orgId: ORG, sourceId: SRC } })).toEqual({ ok: true, result: { ok: true, health: "healthy" } });
    expect(upsertSource).toHaveBeenCalledWith({ orgId: ORG, source, apiKey: VENDOR_KEY });
    expect(JSON.stringify(logged)).not.toContain(VENDOR_KEY);
  });

  it("refuses a malformed source request by field path, never quoting the key", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const run = createModelAccessHandler({ access: fakeAccess().access, log: (entry) => logged.push(entry) });
    const rejected = await run({ op: "upsertSource", args: { orgId: ORG, source: { ...anthropicSource(), extra: 1 }, apiKey: VENDOR_KEY } });
    expect(rejected).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(JSON.stringify([rejected, logged])).not.toContain(VENDOR_KEY);
    expect(await run({ op: "removeSource", args: { orgId: ORG, sourceId: "src_short" } })).toMatchObject({ ok: false });
    expect(await run({ op: "mintKey", args: { orgId: ORG, purpose: "task", refId: "r", maxBudgetUsd: 1, ttlSeconds: 60, models: [], tags: undefined } })).toMatchObject({ ok: false });
    expect(await run({ op: "mintKey", args: { orgId: ORG, purpose: "task", refId: "r", maxBudgetUsd: 1, ttlSeconds: 60, models: ["a"], tags: { agentId: "a", payerKind: "robot", payerId: "p", source: "s", origin: "o" } } })).toMatchObject({ ok: false });
  });

  it("the invoker sends the operations as one Invoke each and reads the check back", async () => {
    const sent: unknown[] = [];
    const lambda = {
      send: vi.fn(async (command: { input: { Payload: Uint8Array } }) => {
        const request = JSON.parse(Buffer.from(command.input.Payload).toString("utf8")) as { op: string };
        sent.push(request);
        const result = request.op === "checkSource" ? { ok: false, message: "no" } : null;
        return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result })) };
      }),
    };
    const invoker = new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never });
    await invoker.upsertSource({ orgId: ORG, source: anthropicSource(), apiKey: VENDOR_KEY });
    await invoker.upsertSource({ orgId: ORG, source: anthropicSource() });
    await invoker.removeSource(ORG, SRC);
    expect(await invoker.checkSource(ORG, SRC)).toEqual({ ok: false, message: "no" });
    expect(sent.map((request) => (request as { op: string }).op)).toEqual(["upsertSource", "upsertSource", "removeSource", "checkSource"]);
    expect((sent[1] as { args: object }).args).not.toHaveProperty("apiKey");
    const minted = { key: "sk-v", expiresAt: 5 };
    lambda.send.mockImplementationOnce(async (command: { input: { Payload: Uint8Array } }) => {
      sent.push(JSON.parse(Buffer.from(command.input.Payload).toString("utf8")));
      return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: minted })) };
    });
    await invoker.mintKey({ orgId: ORG, purpose: "task", refId: "r", maxBudgetUsd: 1, ttlSeconds: 60, models: ["m"], tags: { agentId: "a", payerKind: "agent", payerId: "a", source: "rovara", origin: "api", project: undefined } });
    expect((sent.at(-1) as { args: Record<string, unknown> }).args).toMatchObject({ models: ["m"], tags: { agentId: "a", payerKind: "agent", payerId: "a", source: "rovara", origin: "api" } });
    expect(JSON.stringify(sent.at(-1))).not.toContain("project");
  });
});

describe("stsRoleAssumer", () => {
  it("assumes with the external id and drops the session, answers false to an access denial, and rethrows anything else", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const ok = stsRoleAssumer({ send: async (command) => { sent.push({ ...command.input }); return { Credentials: { SecretAccessKey: "planted-session-secret" } }; } });
    await expect(ok.assumeRole({ roleArn: ROLE, sessionName: "rovara-probe", externalId: "rovara-x" })).resolves.toBe(true);
    expect(sent).toEqual([{ RoleArn: ROLE, RoleSessionName: "rovara-probe", ExternalId: "rovara-x", DurationSeconds: 900 }]);
    const denied = stsRoleAssumer({ send: async () => { throw Object.assign(new Error("not authorized"), { name: "AccessDenied" }); } });
    await expect(denied.assumeRole({ roleArn: ROLE, sessionName: "s", externalId: "e" })).resolves.toBe(false);
    const down = stsRoleAssumer({ send: async () => { throw Object.assign(new Error("throttled"), { name: "Throttling" }); } });
    await expect(down.assumeRole({ roleArn: ROLE, sessionName: "s", externalId: "e" })).rejects.toThrow("throttled");
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// N8: a company's own model endpoint. The record holds a secret REFERENCE; the access function reads the secret when it registers the source and gives it to the
// proxy's credential store alone. Its models are not served to the org's team until a check qualified exactly these settings.
// ---------------------------------------------------------------------------------------------------------------------
describe("an endpoint source's secret reference (N8)", () => {
  it("reads the secret from its reference, writes it to the proxy's credential with the endpoint's address, and keeps it out of every model body", async () => {
    const proxy = litellm();
    const read = resolver();
    await client(proxy, { resolveSecret: read }).upsertSource({ orgId: ORG, source: endpointSource() });
    expect(read).toHaveBeenCalledWith(REF);
    expect(proxy.credentials.get(`${ORG}.${SRC}`)).toEqual({
      credential_name: `${ORG}.${SRC}`, credential_values: { api_key: VENDOR_KEY, api_base: "https://llm.example.com/v1" }, credential_info: { rovara_org: ORG, rovara_source: SRC },
    });
    expect(JSON.stringify(proxy.models)).not.toContain(VENDOR_KEY);
    // The model carries the credential's name and nothing that could be the secret or where it lives.
    expect(JSON.stringify(proxy.models)).not.toContain(REF);
  });

  it("reads the secret again on every registration, so a rotated secret reaches the proxy with the next save or check", async () => {
    const proxy = litellm();
    const secrets = { [REF]: VENDOR_KEY };
    const read = resolver(secrets);
    const registry = client(proxy, { resolveSecret: read });
    await registry.upsertSource({ orgId: ORG, source: endpointSource() });
    secrets[REF] = "rotated-secret-0123456789";
    await registry.upsertSource({ orgId: ORG, source: endpointSource() });
    expect(read).toHaveBeenCalledTimes(2);
    expect(proxy.credentials.get(`${ORG}.${SRC}`)!.credential_values.api_key).toBe("rotated-secret-0123456789");
  });

  it("refuses a pasted key beside an endpoint, before anything is read or written", async () => {
    const proxy = litellm();
    const read = resolver();
    const error = await failure(client(proxy, { resolveSecret: read }).upsertSource({ orgId: ORG, source: endpointSource(), apiKey: VENDOR_KEY }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).not.toContain(VENDOR_KEY);
    expect(read).not.toHaveBeenCalled();
    expect(proxy.seen).toEqual([]);
  });

  it("refuses when the function has no secret reader, and says nothing about the reference's value", async () => {
    const proxy = litellm();
    const error = await failure(client(proxy).upsertSource({ orgId: ORG, source: endpointSource() }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(proxy.seen).toEqual([]);
  });

  it("never carries a reader's own error text: a missing secret is a fixed refusal, and an unexpected failure is an unavailable proxy", async () => {
    const proxy = litellm();
    const missing = await failure(client(proxy, { resolveSecret: resolver({}) }).upsertSource({ orgId: ORG, source: endpointSource() }));
    expect(missing.code).toBe("MODEL_PROXY_UNAVAILABLE");
    expect(missing.message).not.toContain(VENDOR_KEY);
    expect(missing.message).not.toContain(REF);
    const fixed = await failure(client(proxy, { resolveSecret: async () => { throw agentXError("CONFIG_INVALID", "the endpoint's secret could not be read; check it"); } }).upsertSource({ orgId: ORG, source: endpointSource() }));
    expect([fixed.code, fixed.message]).toEqual(["CONFIG_INVALID", "CONFIG_INVALID: the endpoint's secret could not be read; check it"]);
    expect(proxy.seen).toEqual([]);
  });

  it.each(["", "short", "has a space in it 0123456789", "{\"json\":\"document-0123456789\"}x y"])("sends no value that is not a plain key (%j) to the proxy", async (value) => {
    const proxy = litellm();
    const error = await failure(client(proxy, { resolveSecret: async () => value }).upsertSource({ orgId: ORG, source: endpointSource() }));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(proxy.credentials.size).toBe(0);
    expect(proxy.seen.filter((entry) => entry.method !== "GET")).toEqual([]);
  });

  it("scrubs the resolved secret from a refusal that quoted it", async () => {
    const proxy = litellm({ failOn: (seen) => (seen.path === "/credentials" && seen.method === "POST" ? json({ error: { message: `bad credential ${VENDOR_KEY} rejected` } }, 400) : undefined) });
    const error = await failure(client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource() }));
    expect(error.message).toContain("rejected");
    expect(error.message).not.toContain(VENDOR_KEY);
  });

  it("removes the credential left from an earlier reference when the source no longer names one, and does not use it", async () => {
    const proxy = litellm();
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource() });
    expect(proxy.credentials.size).toBe(1);
    await client(proxy).upsertSource({ orgId: ORG, source: endpointSource("openai-completions", { keyRef: null }) });
    expect(proxy.credentials.size).toBe(0);
    expect(proxy.models[0]!.litellm_params).not.toHaveProperty("litellm_credential_name");
  });
});

describe("an endpoint's models are served only once a check qualified exactly these settings (N8)", () => {
  it("registers an unqualified endpoint's models for the probe but leaves them out of the org's team, so no key can call them", async () => {
    const proxy = litellm();
    const unqualified = endpointSource("openai-completions");
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: unqualified });
    expect(proxy.models.map((model) => model.model_name)).toEqual([aliasOf(unqualified, 0)]);
    expect(proxy.models[0]!.model_info).toMatchObject({ rovara_kind: "endpoint", rovara_tested: false });
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
    // The probe can still find the model.
    expect(await client(proxy).checkSource(ORG, SRC)).toEqual({ ok: true, health: "healthy" });
  });

  it("serves them once qualified, and takes them out again when a changed source is registered unqualified", async () => {
    const proxy = litellm();
    const qualified = endpointSource("openai-completions", { qualified: true });
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: qualified });
    expect(proxy.models[0]!.model_info).toMatchObject({ rovara_kind: "endpoint", rovara_tested: true });
    expect(proxy.teams.get(ORG)).toEqual([aliasOf(qualified, 0), ...CATALOG]);
    // The same digest on a source whose address changed is stale: unqualified again.
    const moved = ModelSourceSchema.parse({ ...qualified, baseUrl: "https://elsewhere.example.com/v1", keyRef: undefined });
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: moved });
    expect(proxy.models[0]!.model_info.rovara_tested).toBe(false);
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
  });

  it("does not add an unqualified endpoint's alias to the team when the org changes another source", async () => {
    const proxy = litellm();
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource() });
    const other = anthropicSource([sonnet], SRC_TWO);
    await client(proxy).upsertSource({ orgId: ORG, source: other, apiKey: VENDOR_KEY });
    expect(proxy.teams.get(ORG)).toEqual([sourceAlias(ORG, SRC_TWO, sonnet), ...CATALOG]);
  });

  it("prices an endpoint's models from the catalog entry they stand for and ties them to the org, like any company source", async () => {
    const proxy = litellm();
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource("openai-completions", { qualified: true }) });
    expect(proxy.models[0]!.litellm_params).toMatchObject({ input_cost_per_token: 3 / 1e6, output_cost_per_token: 15 / 1e6, ssl_verify: true });
    expect(proxy.models[0]!.model_info).toMatchObject({ rovara_org: ORG, rovara_source: SRC, input_cost_per_token: 3 / 1e6, output_cost_per_token: 15 / 1e6 });
    // A model the catalog cannot price is refused: its spend could not be counted.
    const unpriced = ModelSourceSchema.parse({ kind: "endpoint", sourceId: SRC, label: "G", baseUrl: "https://llm.example.com/v1", api: "openai-completions", models: [{ name: "m", catalog: { provider: "anthropic", modelId: "claude-unpriced-9" } }] });
    expect((await failure(client(litellm(), { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: unpriced }))).message).toContain("no list price");
  });

  it("reports an endpoint whose models did not all answer as not healthy, so it is never qualified", async () => {
    let figures = { healthy: 1, unhealthy: 0 };
    const proxy = litellm({ health: () => figures });
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource() });
    expect(await client(proxy).checkSource(ORG, SRC)).toEqual({ ok: true, health: "healthy" });
    figures = { healthy: 0, unhealthy: 0 };
    expect(await client(proxy).checkSource(ORG, SRC)).toEqual({ ok: true, health: "unknown" });
    figures = { healthy: 0, unhealthy: 1 };
    expect(await client(proxy).checkSource(ORG, SRC)).toEqual({ ok: false, message: "this source did not answer a test call" });
  });
});

describe("endpointSecretReader (N8)", () => {
  const secretsOf = (answer: (id: string) => { SecretString?: string } | Error) => {
    const asked: string[] = [];
    return { asked, secrets: { send: vi.fn(async (command: { input: { SecretId: string } }) => {
      asked.push(command.input.SecretId);
      const result = answer(command.input.SecretId);
      if (result instanceof Error) throw result;
      return result;
    }) } };
  };
  const named = (name: string) => Object.assign(new Error("denied with " + VENDOR_KEY), { name });

  it("asks only for a name under rovara/model-endpoints/, refusing every other secret before it calls AWS", async () => {
    const { asked, secrets } = secretsOf(() => ({ SecretString: VENDOR_KEY }));
    const read = endpointSecretReader(secrets as never);
    for (const bad of ["agentx/staging/model-proxy-master-key", "arn:aws:secretsmanager:us-east-1:123456789012:secret:rovara/model-endpoints/x-AbCdEf", "rovara/model-endpoints/", "rovara/model-endpoints/../master", "rovara/model-endpoints//x", "rovara/other/x", "rovara/model-endpoints/gateway-key", "", `${VENDOR_KEY}`]) {
      expect((await failure(read(bad))).code, bad).toBe("CONFIG_INVALID");
    }
    expect(asked).toEqual([]);
    expect(await read(REF)).toBe(VENDOR_KEY);
    expect(asked).toEqual([REF]);
  });

  it("trims the value, and turns a missing secret, a denial and an empty value into fixed refusals that never carry AWS's text", async () => {
    expect(await endpointSecretReader(secretsOf(() => ({ SecretString: `  ${VENDOR_KEY}\n` })).secrets as never)(REF)).toBe(VENDOR_KEY);
    for (const answer of [() => named("ResourceNotFoundException"), () => named("AccessDeniedException"), () => ({ SecretString: "  " }), () => ({})]) {
      const error = await failure(endpointSecretReader(secretsOf(answer).secrets as never)(REF));
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).not.toContain(VENDOR_KEY);
    }
    // Any other failure is left to the caller as a read that may work later.
    const throttled = await failure(endpointSecretReader(secretsOf(() => named("ThrottlingException")).secrets as never)(REF));
    expect(throttled.name).toBe("ThrottlingException");
  });
});

describe("the handler and the invoker carry an endpoint's secret reference (N8)", () => {
  const sourceArgs = (source: unknown) => ({ op: "upsertSource", args: { orgId: ORG, source } });
  const withReference = (keyRef: unknown) => ({ ...(endpointSource("openai-completions", { qualified: true }) as unknown as Record<string, unknown>), keyRef });

  it("passes the reference and the qualification to the proxy client as they are, with no value beside them", async () => {
    const upsertSource = vi.fn(async () => undefined);
    const handler = createModelAccessHandler({ access: { upsertSource } as unknown as ModelAccess, log: () => undefined });
    const source = endpointSource("openai-completions", { qualified: true });
    expect(await handler(sourceArgs(source))).toEqual({ ok: true, result: null });
    expect(upsertSource).toHaveBeenCalledWith({ orgId: ORG, source });
    expect(JSON.stringify(upsertSource.mock.calls)).toContain(REF);
  });

  it("refuses a reference that is an ARN, another secret, or a pasted value by its field path, never quoting it", async () => {
    const upsertSource = vi.fn(async () => undefined);
    const handler = createModelAccessHandler({ access: { upsertSource } as unknown as ModelAccess, log: () => undefined });
    for (const value of ["arn:aws:secretsmanager:us-east-1:123456789012:secret:rovara/model-endpoints/x-AbCdEf", "agentx/staging/master-key", VENDOR_KEY]) {
      const answer = await handler(sourceArgs(withReference(value)));
      expect(answer).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
      expect(JSON.stringify(answer)).not.toContain(value);
    }
    expect(upsertSource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// N8 fix round 1 (Opus review): S1 org-bound secrets, S5 order of a host change, N1 health text, N2 usage, N5 old deployments, S4 the in-VPC address check.
// ---------------------------------------------------------------------------------------------------------------------
describe("an endpoint's secret belongs to its org and its host (S1, S3)", () => {
  it("refuses another org's secret, and a secret named for another host, before the reader is asked", async () => {
    const proxy = litellm();
    for (const keyRef of [`rovara/model-endpoints/${OTHER_ORG}/llm.example.com/gateway-key`, `rovara/model-endpoints/${ORG}/other.example.org/gateway-key`]) {
      const read = resolver();
      const error = await failure(client(proxy, { resolveSecret: read }).upsertSource({ orgId: ORG, source: endpointSource("openai-completions", { keyRef }) }));
      expect(error.code, keyRef).toBe("CONFIG_INVALID");
      expect(error.message).not.toContain(keyRef);
      expect(read).not.toHaveBeenCalled();
    }
    expect(proxy.seen.filter((entry) => entry.method !== "GET")).toEqual([]);
  });
});

describe("a host change takes the alias out of the team before any deployment changes (S5)", () => {
  it("removes the alias first when the new settings are not served, so the alias never reaches an unapproved host", async () => {
    const proxy = litellm();
    const qualified = endpointSource("openai-completions", { qualified: true });
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: qualified });
    expect(proxy.teams.get(ORG)).toEqual([aliasOf(qualified, 0), ...CATALOG]);
    proxy.seen.length = 0;
    const otherRef = `rovara/model-endpoints/${ORG}/other.example.org/other-key`;
    const moved = ModelSourceSchema.parse({ ...qualified, baseUrl: "https://other.example.org/v1", keyRef: otherRef });
    await client(proxy, { resolveSecret: resolver({ [otherRef]: "second-secret-0123456789" }) }).upsertSource({ orgId: ORG, source: moved });
    const writes = proxy.seen.filter((entry) => entry.method !== "GET").map((entry) => `${entry.method} ${entry.path}`);
    expect(writes.indexOf("POST /team/update"), writes.join(", ")).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf("POST /team/update")).toBeLessThan(writes.indexOf("POST /model/new"));
    // The team update that came first no longer holds the alias.
    const first = proxy.seen.find((entry) => entry.path === "/team/update")!;
    expect(first.body!.models).toEqual(CATALOG);
    expect(proxy.teams.get(ORG)).toEqual(CATALOG);
  });

  it("keeps a served source's alias in the team throughout when its settings do not change what is served", async () => {
    const proxy = litellm();
    const qualified = endpointSource("openai-completions", { qualified: true });
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: qualified });
    proxy.seen.length = 0;
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: qualified });
    expect(proxy.seen.filter((entry) => entry.path === "/team/update").every((entry) => (entry.body!.models as string[]).includes(aliasOf(qualified, 0)))).toBe(true);
  });
});

describe("an old deployment is never read as served (N5)", () => {
  it("leaves out an endpoint deployment that has an address and no flags, when the org changes another source", async () => {
    const proxy = litellm();
    const old = endpointSource("openai-completions", { qualified: true });
    proxy.models.push({ id: "old-1", model_name: aliasOf(old, 0), litellm_params: { api_base: "https://llm.example.com/v1" }, model_info: { rovara_org: ORG } });
    const other = anthropicSource([haiku], SRC_TWO);
    await client(proxy).upsertSource({ orgId: ORG, source: other, apiKey: VENDOR_KEY });
    expect(proxy.teams.get(ORG)).toEqual([aliasOf(other, 0), ...CATALOG]);
  });
});

describe("checkSource for an endpoint (N1, N2)", () => {
  const checked = async (options: Parameters<typeof litellm>[0], api = "openai-completions") => {
    const proxy = litellm(options);
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource(api) });
    return { proxy, answer: await client(proxy).checkSource(ORG, SRC) };
  };

  it("asks each model for one small reply in the endpoint's own wire format and passes a reply that reports usage", async () => {
    for (const [api, path] of [["openai-completions", "/chat/completions"], ["openai-responses", "/v1/responses"], ["anthropic-messages", "/v1/messages"]] as const) {
      const { proxy, answer } = await checked({}, api);
      expect(answer, api).toEqual({ ok: true, health: "healthy" });
      const probe = proxy.seen.find((entry) => entry.method === "POST" && entry.path === path)!;
      expect(probe.body!.model).toBe(aliasOf(endpointSource(api), 0));
    }
  });

  it("refuses a reply with no usage, or usage of zero, so spend is never counted as nothing", async () => {
    const message = "this endpoint's replies carry no token usage, so its spend could not be counted";
    for (const usage of [() => undefined, () => ({}), () => ({ total_tokens: 0 }), () => ({ prompt_tokens: 0, completion_tokens: 0 }), () => ({ total_tokens: "7" })]) {
      expect((await checked({ usage })).answer).toEqual({ ok: false, message });
    }
    expect((await checked({ usage: () => ({ input_tokens: 3, output_tokens: 1 }) }, "anthropic-messages")).answer).toEqual({ ok: true, health: "healthy" });
    expect((await checked({ usage: () => undefined }, "anthropic-messages")).answer).toEqual({ ok: false, message });
  });

  it("says the source did not answer when the test reply fails, and does not ask a source that is not an endpoint", async () => {
    expect((await checked({ completion: () => json({ error: { message: "boom" } }, 400) })).answer).toEqual({ ok: false, message: "this source did not answer a test call" });
    expect((await checked({ completion: () => json({ error: { message: "down" } }, 503) })).answer).toEqual({ ok: false, message: "this source did not answer a test call" });
    const proxy = litellm();
    await client(proxy).upsertSource({ orgId: ORG, source: anthropicSource(), apiKey: VENDOR_KEY });
    await client(proxy).checkSource(ORG, SRC);
    expect(proxy.seen.some((entry) => entry.path === "/chat/completions" || entry.path === "/v1/messages")).toBe(false);
  });

  it("does not repeat the proxy's words when the health call is refused", async () => {
    const proxy = litellm({ failOn: (seen) => (seen.path === "/health" ? json({ error: { message: `request failed with key ${VENDOR_KEY} for the endpoint` } }, 400) : undefined) });
    await client(proxy, { resolveSecret: resolver() }).upsertSource({ orgId: ORG, source: endpointSource() });
    const error = await failure(client(proxy).checkSource(ORG, SRC));
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.message).toBe("CONFIG_INVALID: model proxy refused the health check (400)");
    expect(error.message).not.toContain(VENDOR_KEY);
  });
});

describe("the endpoint address is judged inside the VPC (S4)", () => {
  it("is judged by the function's own checker, and an access function with none refuses every address", async () => {
    const seenUrls: string[] = [];
    const proxy = litellm();
    await client(proxy, { checkEndpointHost: async (url) => { seenUrls.push(url); } }).checkEndpoint("https://llm.example.com/v1");
    expect(seenUrls).toEqual(["https://llm.example.com/v1"]);
    const refused = await failure(client(proxy).checkEndpoint("https://llm.example.com/v1"));
    expect([refused.code, refused.message]).toEqual(["CONFIG_INVALID", "CONFIG_INVALID: custom model endpoints are not set up on this install"]);
  });

  it("is a request of its own for the handler and the invoker, and the handler refuses when its access has no checker", async () => {
    const check = vi.fn(async () => undefined);
    const handler = createModelAccessHandler({ access: { checkEndpoint: check } as unknown as ModelAccess, log: () => undefined });
    expect(await handler({ op: "checkEndpoint", args: { url: "https://llm.example.com/v1" } })).toEqual({ ok: true, result: null });
    expect(check).toHaveBeenCalledWith("https://llm.example.com/v1");
    expect(await handler({ op: "checkEndpoint", args: { url: "" } })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    expect(await handler({ op: "checkEndpoint", args: { url: "https://x.example.com", extra: 1 } })).toMatchObject({ ok: false, code: "CONFIG_INVALID" });
    const bare = createModelAccessHandler({ access: {} as unknown as ModelAccess, log: () => undefined });
    expect(await bare({ op: "checkEndpoint", args: { url: "https://llm.example.com/v1" } })).toEqual({ ok: false, code: "CONFIG_INVALID", message: "custom model endpoints are not set up on this install" });

    const lambda = { send: vi.fn(async () => ({ Payload: new TextEncoder().encode(JSON.stringify({ ok: false, code: "CONFIG_INVALID", message: "the endpoint host resolves to an address Rovara never calls" })) })) };
    const invoker = new ModelAccessInvoker({ functionName: "fn", lambda: lambda as never });
    const refused = await failure(invoker.checkEndpoint("https://llm.example.com/v1"));
    expect([refused.code, refused.message]).toEqual(["CONFIG_INVALID", "CONFIG_INVALID: the endpoint host resolves to an address Rovara never calls"]);
    expect(JSON.parse(Buffer.from((lambda.send.mock.calls[0] as unknown as [{ input: { Payload: Buffer } }])[0].input.Payload).toString())).toEqual({ op: "checkEndpoint", args: { url: "https://llm.example.com/v1" } });
  });

  it("builds its checker only when the switch is on and the ranges parse, and a bad range leaves none", async () => {
    const { endpointAddressChecker } = await import("../../packages/broker/src/model-proxy/handler.js");
    expect(endpointAddressChecker({})).toEqual({});
    expect(endpointAddressChecker({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "0" })).toEqual({});
    expect(typeof endpointAddressChecker({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1" }).checkEndpointHost).toBe("function");
    expect(typeof endpointAddressChecker({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "10.4.0.0/16", ROVARA_VPC_CIDRS: "10.42.0.0/16" }).checkEndpointHost).toBe("function");
    expect(endpointAddressChecker({ ROVARA_CUSTOM_MODEL_ENDPOINTS: "1", ROVARA_MODEL_ENDPOINT_CIDRS: "8.8.8.0/24", ROVARA_VPC_CIDRS: "10.42.0.0/16" })).toEqual({});
  });
});
