// DEC 254zzz84(4): the company's saved AI source ORDER (COMPANY#<org>/AGENT_AI `source` then `fallback`). The gateway admits each agent call on the first
// source of that order that can take it now (switched on, offered here, connected, serving the token's model), decided before anything is held or sent.
// A read that fails refuses the call (never slid onto the next source). A row without a fallback is exactly the single choice of before.
import { denyNetwork } from "./model-gateway-no-network.js";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT_AI_FALLBACK_MAX, CompanyAgentAiSource, validFallback, type AgentAiSource, type AgentAiSourceReader, type RovaraAi } from "../../packages/model-gateway/src/agent-ai.js";
import type { CredentialSource } from "../../packages/model-gateway/src/aws.js";
import type { BedrockConnection } from "../../packages/model-gateway/src/bedrock-byo.js";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { answerOfferedModels, type OfferedModelsHandlerOptions } from "../../packages/model-gateway/src/offered-models.js";
import type { ProviderRequest, ProviderTransport } from "../../packages/model-gateway/src/provider.js";
import { AGENT_KEY_MISSING, AGENT_MODEL_NOT_SERVED, BYO_BEDROCK_NOT_CONNECTED, ROVARA_AI_OFF } from "../../packages/model-gateway/src/server.js";
import { answer, call, claims, mint, setup } from "./model-gateway-fixture.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import { AGENT_AI_FALLBACK_MAX as CLOUD_FALLBACK_MAX, validAgentAiFallback } from "../../packages/cloud-server/src/company-store.js";
beforeAll(denyNetwork);

const cidA = claims.cid;
const cidB = `org_${"b".repeat(20)}`;
// A model both Rovara's AI (below) and an own Anthropic key serve (the key's list is ANTHROPIC_KEY_AGENT_MODELS).
const SHARED = "claude-sonnet-5-5";
// A model only Rovara's AI serves.
const ROVARA_ONLY = "claude-sonnet-4-5";
const BEDROCK_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const BEDROCK_ID_2 = "us.anthropic.claude-sonnet-5-5-v1:0";
const body = (model: string) => ({ model, messages: [{ role: "user", content: "hello" }], max_tokens: 10, stream: true });
const keyOf = (cid: string) => `customer-key-${cid}`;
const error = (sink: { text(): string }) => (JSON.parse(sink.text()) as { error: { type: string; message: string } }).error;

class CompanyKeys implements LearningKeySource {
  connectedTo = new Set<string>();
  fail = false;
  async connected(_iss: string, cid: string): Promise<boolean> { if (this.fail) throw new Error("store down"); return this.connectedTo.has(cid); }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { return keyOf(cid); }
}
class Orders implements AgentAiSourceReader {
  readonly saved = new Map<string, { source: AgentAiSource; fallback: AgentAiSource[] }>();
  fail = false;
  async sourceFor(cid: string) { return (await this.orderFor(cid))?.source; }
  async orderFor(cid: string) { if (this.fail) throw new Error("store down"); const o = this.saved.get(cid); return o === undefined ? undefined : { source: o.source, fallback: o.fallback.slice() }; }
}
const conn = (): BedrockConnection => ({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke", region: "us-west-2", models: { [SHARED]: BEDROCK_ID }, allowGlobal: false });

function gateway(options: { rovaraModels?: string[]; noRovara?: boolean; disabled?: string[] } = {}) {
  const keys = new CompanyKeys();
  const orders = new Orders();
  const bedrockConnected = new Set<string>();
  let byoFail = false;
  const rovaraSent: ProviderRequest[] = []; const keySent: ProviderRequest[] = []; const byoSent: ProviderRequest[] = [];
  const rovara: RovaraAi = { models: new Map((options.rovaraModels ?? [SHARED, ROVARA_ONLY]).map((m) => [m, m === SHARED ? BEDROCK_ID_2 : BEDROCK_ID])), exempt: new Set(), transport: async (request) => { rovaraSent.push(request); return { status: 200, body: answer() }; } };
  const byo = {
    async connection(iss: string, cid: string) { if (byoFail) throw new Error("down"); return bedrockConnected.has(cid) ? { row: { iss, cid, owner: "_company", sourceId: "src_bedrock", versionId: "11111111-1111-4111-8111-111111111111" }, connection: conn() } : undefined; },
    sessions: { credentials: async () => ({ ok: true as const, credentials: { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "s", sessionToken: "t", expiresAt: Date.now() + 3_600_000 } }), forget: () => undefined },
    transport: (_region: string, credentials: CredentialSource): ProviderTransport => async (request) => { await credentials(); byoSent.push(request); return { status: 200, body: answer() }; },
  };
  const base = setup({
    agentKeys: keys,
    agentAi: { sources: orders, ...(options.noRovara === true ? {} : { rovara }), byo, ...(options.disabled === undefined ? {} : { rovaraDisabled: new Set(options.disabled) }) },
    transport: async (request) => { keySent.push(request); return { status: 200, body: answer() }; },
    prices: { priceFor: () => ({ inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }) },
  });
  return { ...base, byo, keys, orders, bedrockConnected, rovara, rovaraSent, keySent, byoSent, failByo: () => { byoFail = true; } };
}
type G = ReturnType<typeof gateway>;
const sources = (g: G) => g.logs.filter((e) => (e as { event?: string }).event === "agent_source");
const nothingSent = (g: G) => { expect(g.rovaraSent).toEqual([]); expect(g.keySent).toEqual([]); expect(g.byoSent).toEqual([]); };
const agent = (g: G, model: string, cid = cidA) => call(g.deps, body(model), mint({ cid, mdl: [model] }));

describe("agent route: the company's saved order", () => {
  it("own key first, then Rovara's AI: the key is used while it is connected", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: ["rovara"] });
    g.keys.connectedTo.add(cidA);
    expect((await agent(g, SHARED)).status).toBe(200);
    expect(g.keySent.map((r) => r.key)).toEqual([keyOf(cidA)]);
    expect(g.rovaraSent).toEqual([]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidA, source: "company_key", via: "chosen" }]);
  });

  it("own key first, then Rovara's AI: with no key connected the call goes to Rovara's AI, billed to the company, logged as a fallback", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: ["rovara"] });
    expect((await agent(g, SHARED)).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1);
    expect(g.keySent).toEqual([]);
    expect(g.meter.billedCalls(claims.iss, cidA)).toMatchObject([{ line: { source: "rovara_ai", charge: "customer" } }]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidA, source: "rovara", via: "fallback" }]);
  });

  it("a source that does not serve the token's model is passed over (own key first, a model only Rovara's AI serves)", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: ["rovara"] });
    g.keys.connectedTo.add(cidA);
    expect((await agent(g, ROVARA_ONLY)).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1); expect(g.keySent).toEqual([]);
  });

  it("Rovara's AI first, then own key: a model Rovara's AI has not enabled yet goes to the key", async () => {
    const g = gateway({ disabled: [SHARED] });
    g.orders.saved.set(cidA, { source: "rovara", fallback: ["anthropic_key"] });
    g.keys.connectedTo.add(cidA);
    expect((await agent(g, SHARED)).status).toBe(200);
    expect(g.keySent).toHaveLength(1); expect(g.rovaraSent).toEqual([]);
    expect(sources(g)).toEqual([{ event: "agent_source", company: cidA, source: "company_key", via: "fallback" }]);
  });

  it("own Bedrock not connected, then Rovara's AI", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "bedrock_byo", fallback: ["rovara"] });
    expect((await agent(g, SHARED)).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1); expect(g.byoSent).toEqual([]);
  });

  it("Rovara's AI not offered on this gateway is passed over too", async () => {
    const g = gateway({ noRovara: true });
    g.orders.saved.set(cidA, { source: "rovara", fallback: ["anthropic_key"] });
    g.keys.connectedTo.add(cidA);
    expect((await agent(g, SHARED)).status).toBe(200);
    expect(g.keySent).toHaveLength(1);
  });

  it("no source in the order can take the call: the FIRST source's refusal, nothing sent", async () => {
    const g = gateway({ noRovara: true });
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: ["rovara"] });
    const sink = await agent(g, SHARED);
    expect(error(sink)).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    nothingSent(g);
    const h = gateway({ rovaraModels: [ROVARA_ONLY] });
    h.orders.saved.set(cidA, { source: "rovara", fallback: ["bedrock_byo"] });
    expect(error(await agent(h, SHARED))).toEqual({ type: AGENT_MODEL_NOT_SERVED.code, message: AGENT_MODEL_NOT_SERVED.message });
    nothingSent(h);
  });

  it("a read that FAILS refuses the call at once: never slid onto Rovara's AI", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: ["rovara"] });
    g.keys.fail = true;
    const sink = await agent(g, SHARED);
    expect(sink.status).toBe(503);
    nothingSent(g);
    const h = gateway();
    h.orders.saved.set(cidA, { source: "bedrock_byo", fallback: ["rovara"] });
    h.failByo();
    expect((await agent(h, SHARED)).status).toBe(503);
    nothingSent(h);
    const k = gateway();
    k.orders.fail = true;
    expect((await agent(k, SHARED)).status).toBe(503);
    nothingSent(k);
  });

  it("without a saved fallback a source is never passed over (exactly as before): no key connected is refused, Rovara's AI unused", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: [] });
    expect(error(await agent(g, SHARED))).toEqual({ type: AGENT_KEY_MISSING.code, message: AGENT_KEY_MISSING.message });
    nothingSent(g);
    const h = gateway({ noRovara: true });
    h.orders.saved.set(cidA, { source: "rovara", fallback: [] });
    expect(error(await agent(h, SHARED))).toEqual({ type: ROVARA_AI_OFF.code, message: ROVARA_AI_OFF.message });
    const b = gateway();
    b.orders.saved.set(cidA, { source: "bedrock_byo", fallback: [] });
    expect(error(await agent(b, SHARED))).toEqual({ type: BYO_BEDROCK_NOT_CONNECTED.code, message: BYO_BEDROCK_NOT_CONNECTED.message });
    // The model is not checked at admission without a fallback (the guard decides, as before): a model Rovara's AI does not list is not refused here.
    const r = gateway({ rovaraModels: [ROVARA_ONLY] });
    r.orders.saved.set(cidA, { source: "rovara", fallback: [] });
    expect(error(await agent(r, SHARED)).message).not.toBe(AGENT_MODEL_NOT_SERVED.message);
  });

  it("two companies: A's order never moves B", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: ["rovara"] });
    g.orders.saved.set(cidB, { source: "anthropic_key", fallback: [] });
    expect((await agent(g, SHARED, cidB)).status).toBe(AGENT_KEY_MISSING.status);
    nothingSent(g);
    expect((await agent(g, SHARED, cidA)).status).toBe(200);
    expect(g.rovaraSent).toHaveLength(1);
    expect(g.meter.billedCalls(claims.iss, cidB)).toEqual([]);
  });
});

describe("the saved order in Cloud's Companies table", () => {
  const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real", sessionToken: "test-session" });
  async function table() {
    const wire = new WireDynamo(["cloud-companies"]);
    const db = new Dynamo({ region: "us-west-2", credentials, transport: wire.transport });
    return { db, reader: new CompanyAgentAiSource(db, "cloud-companies") };
  }
  it("reads each company's own order; a row without a fallback is the first choice alone", async () => {
    const { db, reader } = await table();
    await db.put("cloud-companies", { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidA, source: "anthropic_key", fallback: ["rovara"], version: 2 });
    await db.put("cloud-companies", { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidB, source: "rovara", version: 1 });
    expect(await reader.orderFor(cidA)).toEqual({ source: "anthropic_key", fallback: ["rovara"] });
    expect(await reader.orderFor(cidB)).toEqual({ source: "rovara", fallback: [] });
    expect(await reader.sourceFor(cidA)).toBe("anthropic_key");
  });
  it("fails closed on a fallback that is not a valid list, and on another company's row", async () => {
    const { db, reader } = await table();
    for (const fallback of [["rovara", "rovara"], ["anthropic_key"], ["openai"], "rovara", ["rovara", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint", "anthropic_key"]]) {
      await db.put("cloud-companies", { pk: `COMPANY#${cidA}`, sk: "AGENT_AI", companyId: cidA, source: "anthropic_key", fallback, version: 1 });
      await expect(reader.orderFor(cidA)).rejects.toThrow();
      await expect(reader.sourceFor(cidA)).rejects.toThrow();
    }
    await db.put("cloud-companies", { pk: `COMPANY#${cidB}`, sk: "AGENT_AI", companyId: cidA, source: "rovara", fallback: ["anthropic_key"], version: 1 });
    await expect(reader.orderFor(cidB)).rejects.toThrow();
  });
  it("Cloud's copy of the rule is the gateway's (Cloud writes, the gateway reads)", () => {
    expect(CLOUD_FALLBACK_MAX).toBe(AGENT_AI_FALLBACK_MAX);
    const cases: Array<[unknown, AgentAiSource]> = [[[], "rovara"], [["anthropic_key"], "rovara"], [["rovara"], "rovara"], [["a"], "rovara"], [["anthropic_key", "anthropic_key"], "rovara"], ["rovara", "anthropic_key"], [["rovara", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint"], "anthropic_key"], [["rovara", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint", "x"], "anthropic_key"]];
    for (const [value, first] of cases) expect(validAgentAiFallback(value, first)).toBe(validFallback(value, first) !== undefined);
  });
  it("validFallback", () => {
    expect(validFallback([], "rovara")).toEqual([]);
    expect(validFallback(["anthropic_key", "bedrock_byo"], "rovara")).toEqual(["anthropic_key", "bedrock_byo"]);
    expect(validFallback(["rovara"], "rovara")).toBeUndefined();
    expect(validFallback(["x"], "rovara")).toBeUndefined();
    expect(validFallback(null, "rovara")).toBeUndefined();
  });
});

describe("offered models over the saved order", () => {
  const offered = async (g: G, cid: string, options: { noRovara?: boolean } = {}) => answerOfferedModels({
    verify: async () => ({ iss: claims.iss, aud: "rovara-model-gateway-offered-models", jti: "00000000-0000-4000-8000-000000000000", iat: 0, nbf: 0, exp: 0, cid }),
    sources: g.orders, ...(options.noRovara === true ? {} : { rovara: { models: g.rovara.models, exempt: g.rovara.exempt } }), disabled: new Set(), keys: g.keys, byo: g.byo,
  } satisfies OfferedModelsHandlerOptions, { method: "GET", url: `/v1/service/companies/${cid}/offered-models`, headers: { authorization: "Bearer x" } });
  const names = (out: { body: unknown }) => (out.body as { models: Array<{ model: string }> }).models.map((m) => m.model);

  it("the models of every usable source in order, each once", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "bedrock_byo", fallback: ["rovara"] });
    g.bedrockConnected.add(cidA);
    const out = await offered(g, cidA);
    expect(out.status).toBe(200);
    expect(names(out)).toEqual([SHARED, ROVARA_ONLY]);
  });
  it("an unusable first source is left out; the fallback's models are offered", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "bedrock_byo", fallback: ["rovara"] });
    expect(names(await offered(g, cidA))).toEqual([SHARED, ROVARA_ONLY]);
  });
  it("without a fallback: exactly the first choice's answer as before (a refusal stays a refusal)", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "bedrock_byo", fallback: [] });
    expect((await offered(g, cidA)).status).toBe(403);
    g.orders.saved.set(cidA, { source: "rovara", fallback: [] });
    expect(await offered(g, cidA)).toEqual({ status: 200, body: { version: 1, models: [{ model: SHARED }, { model: ROVARA_ONLY }] } });
  });
  it("an own key that is not connected is left out of a saved order (the agent route would pass it over)", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "anthropic_key", fallback: ["rovara"] });
    expect(names(await offered(g, cidA))).toEqual([SHARED, ROVARA_ONLY]);
    g.keys.connectedTo.add(cidA);
    const both = names(await offered(g, cidA));
    expect(both).toContain("claude-haiku-5-5");
    expect(both.indexOf(SHARED)).toBeLessThan(both.indexOf(ROVARA_ONLY));
    g.keys.fail = true;
    expect((await offered(g, cidA)).status).toBe(503);
  });
  it("no usable source at all: the first source's refusal", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "bedrock_byo", fallback: ["rovara"] });
    expect((await offered(g, cidA, { noRovara: true })).status).toBe(403);
  });
  it("a read that fails anywhere in the order: the fixed 503, never a partial list", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "rovara", fallback: ["bedrock_byo"] });
    g.failByo();
    expect((await offered(g, cidA)).status).toBe(503);
  });
  it("two companies: each company's own order", async () => {
    const g = gateway();
    g.orders.saved.set(cidA, { source: "bedrock_byo", fallback: ["rovara"] });
    g.orders.saved.set(cidB, { source: "bedrock_byo", fallback: [] });
    g.bedrockConnected.add(cidA);
    expect(names(await offered(g, cidA))).toEqual([SHARED, ROVARA_ONLY]);
    expect((await offered(g, cidB)).status).toBe(403);
  });
});
