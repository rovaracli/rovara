// DEC 254t (a): the per-install switch for company AI source kinds. The code supports five kinds (the contracts' SOURCE_KINDS_AT_LAUNCH);
// each install names the kinds its owner switched on after the kind's real-key check passed (scripts/real-key-check.ts), in Cloud
// (CLOUD_AI_SOURCE_KINDS: what an admin may choose) and in the gateway (GATEWAY_AI_SOURCE_KINDS: what a call may use), both from one
// CDK context value. Default: none. The two sources that were live before the switch (own Anthropic key, own Bedrock) and Rovara's AI
// keep working exactly as before.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, type Stack } from "aws-cdk-lib";
import { Code } from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { PRODUCTION_SOURCE_KINDS, PRODUCTION_SOURCE_KINDS_REFUSAL, SOURCE_KINDS_AT_LAUNCH, parseSourceKindsSwitch, productionSourceKindsAllowed } from "../../packages/contracts/src/model-sources.js";
import {
  AGENT_SOURCE_OF_KIND as CLOUD_SOURCE_OF_KIND, AI_SOURCE_KINDS as CLOUD_KINDS, PRE_SWITCH_AGENT_SOURCES as CLOUD_PRE_SWITCH,
  agentSourceSwitchedOn as cloudSwitchedOn, parseAiSourceKinds as parseCloudKinds,
} from "../../packages/cloud-server/src/index.js";
import {
  AGENT_AI_SOURCES, AGENT_SOURCE_OF_KIND as GATEWAY_SOURCE_OF_KIND, resolveAgentSource, AI_SOURCE_KINDS as GATEWAY_KINDS, PRE_SWITCH_AGENT_SOURCES as GATEWAY_PRE_SWITCH,
  agentSourceSwitchedOn as gatewaySwitchedOn, parseAiSourceKinds as parseGatewayKinds, type AgentAiSource,
} from "../../packages/model-gateway/src/agent-ai.js";
import { GATEWAY_ENV } from "../../packages/model-gateway/src/deploy.js";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach } from "vitest";
import { Dynamo } from "../../packages/model-gateway/src/dynamo.js";
import { GatewayConfigError, readGatewayConfig, startServe, type RunningGateway, type ServeConfig } from "../../packages/model-gateway/src/process.js";
import { WireDynamo } from "./model-gateway-wire-dynamo.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import type { ProviderRequest } from "../../packages/model-gateway/src/provider.js";
import { AGENT_CHAT_NOT_OFFERED, AGENT_SOURCE_SWITCHED_OFF } from "../../packages/model-gateway/src/server.js";
import { AI_SOURCE_KINDS_CONTEXT_KEY, aiSourceKindsContext, buildAgentXApp } from "../../infra/lib/app.js";
import { CLOUD_AI_SOURCE_KINDS_ENV, CloudWebStack } from "../../infra/lib/cloud-web.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_ENV, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "../../infra/lib/model-gateway.js";
import { loadSwitches } from "../../ops/pipeline/switches.js";
import { answer, call, claims, jwk, kid, mint, now, requestBody, setup } from "./model-gateway-fixture.js";
import { A, world } from "./product-ai-world.js";

const BAD = ["OpenAI", "openai,", ",openai", "openai,openai", "openai, openrouter", "rovara", "personal-chatgpt", "gemini", "openai;openrouter", " openai", "openai,openrouter,anthropic,bedrock,endpoint,openai", "sk-ant-api03-looks-like-a-key"];

describe("one list of supported kinds, held equal in three places", () => {
  it("contracts, Cloud and the gateway name the same five kinds and the same agent source for each", () => {
    expect([...GATEWAY_KINDS]).toEqual([...SOURCE_KINDS_AT_LAUNCH]);
    expect([...CLOUD_KINDS]).toEqual([...SOURCE_KINDS_AT_LAUNCH]);
    expect(CLOUD_SOURCE_OF_KIND).toEqual(GATEWAY_SOURCE_OF_KIND);
    expect(GATEWAY_SOURCE_OF_KIND).toEqual({ anthropic: "anthropic_key", openai: "openai_key", openrouter: "openrouter_key", bedrock: "bedrock_byo", endpoint: "custom_endpoint" });
    expect([...CLOUD_PRE_SWITCH]).toEqual([...GATEWAY_PRE_SWITCH]);
    expect([...GATEWAY_PRE_SWITCH]).toEqual(["anthropic_key", "bedrock_byo"]);
  });

  it("the three parsers accept and refuse exactly the same values, with fixed words", () => {
    for (const good of [undefined, "", "openai", "openrouter,anthropic", "anthropic,openai,openrouter,bedrock,endpoint"]) {
      expect([...parseGatewayKinds(good)]).toEqual(parseSourceKindsSwitch(good));
      expect([...parseCloudKinds(good)]).toEqual(parseSourceKindsSwitch(good));
    }
    for (const bad of BAD) {
      for (const parse of [parseGatewayKinds, parseCloudKinds, parseSourceKindsSwitch]) {
        let thrown: unknown;
        try { parse(bad); } catch (error) { thrown = error; }
        expect(String(thrown)).toBe("Error: invalid AI source kinds");
      }
    }
  });
});

describe("which saved sources a switch lets through", () => {
  for (const [name, switchedOn] of [["gateway", gatewaySwitchedOn], ["cloud", cloudSwitchedOn]] as const) {
    it(`${name}: Rovara's AI and the pre-switch sources always; a new source only when its kind is on; anything unknown never`, () => {
      const none = new Set<string>();
      for (const source of ["rovara", "anthropic_key", "bedrock_byo"]) expect(switchedOn(source, none)).toBe(true);
      // DEC 254zzz520: own Bedrock for the AGENTS is pre-switch only on an install that names no kinds. Once kinds are named (beta and production
      // always are), it needs `bedrock` among them; the own Anthropic key and Rovara's AI stay exempt.
      const production = new Set(["openai"]);
      expect(switchedOn("bedrock_byo", production)).toBe(false);
      expect(switchedOn("bedrock_byo", new Set(["openai", "bedrock"]))).toBe(true);
      expect(switchedOn("anthropic_key", production)).toBe(true);
      expect(switchedOn("rovara", production)).toBe(true);
      for (const source of ["openai_key", "openrouter_key", "custom_endpoint"]) expect(switchedOn(source, none)).toBe(false);
      expect(switchedOn("openai_key", new Set(["openai"]))).toBe(true);
      expect(switchedOn("openrouter_key", new Set(["openai"]))).toBe(false);
      expect(switchedOn("custom_endpoint", new Set(["endpoint"]))).toBe(true);
      // A kind name is not a source name, and nothing else passes.
      for (const source of ["openai", "endpoint", "", "OPENAI_KEY", "personal-chatgpt", "__proto__"]) expect(switchedOn(source, new Set(GATEWAY_KINDS))).toBe(false);
    });
  }
});

// ---- the gateway

const ENV = {
  [GATEWAY_ENV.mode]: "serve", AWS_REGION: "us-west-2", [GATEWAY_ENV.port]: "8080",
  [GATEWAY_ENV.installIssuer]: claims.iss, [GATEWAY_ENV.installJwksUrl]: `${claims.iss}/.well-known/jwks.json`, [GATEWAY_ENV.installTaskKids]: kid,
  [GATEWAY_ENV.meterTable]: "gw-meter", [GATEWAY_ENV.ledgerTable]: "gw-ledger", [GATEWAY_ENV.markersTable]: "gw-markers", [GATEWAY_ENV.pricesTable]: "gw-prices", [GATEWAY_ENV.companyTable]: "cloud-companies",
  [GATEWAY_ENV.anthropicKeySecret]: "arn:aws:secretsmanager:us-west-2:123456789012:secret:rovara-cloud/test/model-gateway/provider/anthropic-AbCdEf",
};
const PRODUCT = {
  [GATEWAY_ENV.productKeysTable]: "gw-product-keys", [GATEWAY_ENV.productKeysKey]: "arn:aws:kms:us-west-2:123456789012:key/11111111-2222-3333-4444-555555555555",
  [GATEWAY_ENV.productMeterTable]: "gw-product-meter", [GATEWAY_ENV.productLedgerTable]: "gw-product-ledger", [GATEWAY_ENV.productMarkersTable]: "gw-product-markers", [GATEWAY_ENV.evalStagesTable]: "gw-eval-stages",
};
const COMPANY_MODE = { ...ENV, ...PRODUCT, [GATEWAY_ENV.agentKeys]: "company" };

describe("GATEWAY_AI_SOURCE_KINDS", () => {
  it("absent: the config is exactly as before (no setting, none switched on)", () => {
    const config = readGatewayConfig(COMPANY_MODE) as ServeConfig;
    expect("aiSourceKinds" in config).toBe(false);
  });

  it("set: the parsed kinds, only in company-key mode", () => {
    expect([...(readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.aiSourceKinds]: "openai,openrouter" }) as ServeConfig).aiSourceKinds!]).toEqual(["openai", "openrouter"]);
    expect([...(readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.aiSourceKinds]: "" }) as ServeConfig).aiSourceKinds!]).toEqual([]);
    expect(() => readGatewayConfig({ ...ENV, [GATEWAY_ENV.aiSourceKinds]: "openai" })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentKeys));
    expect(() => readGatewayConfig({ ...ENV, ...PRODUCT, [GATEWAY_ENV.agentKeys]: "install", [GATEWAY_ENV.aiSourceKinds]: "openai" })).toThrow(new GatewayConfigError(GATEWAY_ENV.agentKeys));
  });

  it("a malformed value stops the gateway by the setting's name, never its value", () => {
    for (const bad of BAD) {
      let thrown: unknown;
      try { readGatewayConfig({ ...COMPANY_MODE, [GATEWAY_ENV.aiSourceKinds]: bad }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(GatewayConfigError);
      expect(String(thrown)).toBe(`GatewayConfigError: gateway setting missing or invalid: ${GATEWAY_ENV.aiSourceKinds}`);
    }
  });
});

const keyOf = (cid: string) => `customer-key-${cid}`;
class CompanyKeys implements LearningKeySource {
  reads: string[] = []; asked: string[] = [];
  async connected(_iss: string, cid: string): Promise<boolean> { this.asked.push(cid); return true; }
  async keyFor(_iss: string, cid: string): Promise<string | undefined> { this.reads.push(cid); return keyOf(cid); }
}
function gateway(saved: string | undefined, switchedOn?: ReadonlySet<string>) {
  const keys = new CompanyKeys();
  const sent: ProviderRequest[] = [];
  const base = setup({
    agentKeys: keys,
    // A reader that returns what a later row's store may hold (cast: today's store refuses anything else).
    agentAi: { sources: { sourceFor: async () => saved as AgentAiSource | undefined }, ...(switchedOn === undefined ? {} : { switchedOn }) },
    transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
  });
  return { ...base, keys, sent };
}

describe("the agent route with the switch (gateway, defence in depth)", () => {
  it("a saved source whose kind is off is refused before anything is read, held or sent, in fixed words", async () => {
    for (const source of ["openai_key", "openrouter_key", "custom_endpoint"]) {
      for (const switchedOn of [undefined, new Set<string>(), new Set(["anthropic", "bedrock"])]) {
        const g = gateway(source, switchedOn);
        const sink = await call(g.deps);
        expect(sink.status).toBe(AGENT_SOURCE_SWITCHED_OFF.status);
        expect(JSON.parse(sink.text())).toEqual({ error: { type: AGENT_SOURCE_SWITCHED_OFF.code, message: AGENT_SOURCE_SWITCHED_OFF.message } });
        expect(sink.text()).not.toContain(source);
        expect(g.sent).toEqual([]); expect(g.keys.asked).toEqual([]); expect(g.keys.reads).toEqual([]);
        expect((await g.meter.read({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid, per: claims.per })).every((row) => row.reservedMicros === 0 && row.committed === 0 && row.spentMicros === 0)).toBe(true);
      }
    }
  });

  it("switched on but not built on this gateway: refused (not offered), never sent on the company's Anthropic key", async () => {
    const g = gateway("custom_endpoint", new Set(["endpoint"]));
    const sink = await call(g.deps);
    expect(sink.status).toBe(403);
    expect(JSON.parse(sink.text())).toEqual({ error: { type: AGENT_CHAT_NOT_OFFERED.code, message: AGENT_CHAT_NOT_OFFERED.message } });
    expect(g.sent).toEqual([]); expect(g.keys.asked).toEqual([]); expect(g.keys.reads).toEqual([]);
  });

  it("an explicit own Anthropic choice works unchanged regardless of the kind switch", async () => {
    const answers: string[] = [];
    for (const saved of ["anthropic_key"]) {
      for (const switchedOn of [undefined, new Set<string>(), new Set(GATEWAY_KINDS)]) {
        const g = gateway(saved, switchedOn);
        const sink = await call(g.deps);
        expect(sink.status).toBe(200);
        expect(g.sent.map((request) => request.key)).toEqual([keyOf(claims.cid)]);
        answers.push(`${String(sink.status)}\n${JSON.stringify(sink.headers)}\n${sink.text()}`);
      }
    }
    expect(new Set(answers).size).toBe(1);
  });

  it("of the sources the store can hold, only the own OpenAI, OpenRouter and endpoint sources (A2, A3) wait for the switch", () => {
    expect(AGENT_AI_SOURCES.filter((source) => !gatewaySwitchedOn(source, new Set()))).toEqual(["openai_key", "openrouter_key", "custom_endpoint"]);
  });

  it("DEC 254zzz520 (production-shaped): a saved own-Bedrock agent source is refused at admission when the install names kinds without `bedrock`, before anything is read, held or sent", async () => {
    for (const switchedOn of [new Set(["openai"]), new Set(["anthropic", "openai"])]) {
      const g = gateway("bedrock_byo", switchedOn);
      const sink = await call(g.deps);
      expect(sink.status).toBe(AGENT_SOURCE_SWITCHED_OFF.status);
      expect(JSON.parse(sink.text())).toEqual({ error: { type: AGENT_SOURCE_SWITCHED_OFF.code, message: AGENT_SOURCE_SWITCHED_OFF.message } });
      expect(g.sent).toEqual([]); expect(g.keys.reads).toEqual([]);
    }
    // Not the switch's refusal where it is on (the source is then refused only because this gateway built no Bedrock for it).
    for (const switchedOn of [undefined, new Set<string>(), new Set(["bedrock"])]) {
      const sink = await call(gateway("bedrock_byo", switchedOn).deps);
      expect((JSON.parse(sink.text()) as { error: { message: string } }).error.message).not.toBe(AGENT_SOURCE_SWITCHED_OFF.message);
    }
  });

  it("DEC 254zzz525: a connected company Bedrock role never becomes the agents' DEFAULT, whatever the kinds; the default stays Rovara's AI (an own Anthropic key still precedes it)", async () => {
    const ports = (keyConnected = false) => ({ sources: { sourceFor: async () => undefined }, keys: { connected: async () => keyConnected, bedrockConnected: async () => true } });
    expect(await resolveAgentSource(ports(), claims.iss, claims.cid)).toEqual({ source: "rovara", via: "default" });
    expect(await resolveAgentSource(ports(true), claims.iss, claims.cid)).toEqual({ source: "anthropic_key", via: "own_key" });
  });
});

class FakeResponse extends EventEmitter {
  statusCode = 0; chunks: Buffer[] = []; headersSent = false; destroyed = false;
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  write(bytes: Uint8Array) { this.chunks.push(Buffer.from(bytes)); return true; }
  end(bytes?: Uint8Array | string) { if (bytes !== undefined) this.chunks.push(Buffer.from(bytes)); this.emit("finish"); this.emit("close"); return this; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
  text() { return Buffer.concat(this.chunks).toString(); }
}
const running: RunningGateway[] = [];
afterEach(async () => { for (const g of running.splice(0)) await g.drain(); });

describe("the deployed gateway process passes the install's switch to the agent route", () => {
  async function serve(aiSourceKinds: string | undefined) {
    const tables = ["gw-meter", "gw-ledger", "gw-markers", "gw-prices", "cloud-companies", ...Object.values(PRODUCT).filter((v) => v.startsWith("gw-"))];
    const wire = new WireDynamo(tables, { namespaceTables: true });
    const db = new Dynamo({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "test-secret-not-real" }), transport: wire.transport });
    const sent: ProviderRequest[] = [];
    const env = { ...COMPANY_MODE, ...(aiSourceKinds === undefined ? {} : { [GATEWAY_ENV.aiSourceKinds]: aiSourceKinds }) };
    const config: ServeConfig = { ...(readGatewayConfig(env) as ServeConfig), port: 0 };
    delete (config as { product?: unknown }).product;
    const gateway = await startServe(config, {
      db, fetch: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }), now: () => now, listen: false, log: () => undefined,
      keys: { keyFor: async () => "rovara-install-key" }, agentKeys: new CompanyKeys(),
      agentAiSources: { sourceFor: async () => "custom_endpoint" },
      transport: async (request) => { sent.push(request); return { status: 200, body: answer() }; },
    });
    running.push(gateway);
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(requestBody))]), { method: "POST", url: "/v1/messages", headers: { "content-type": "application/json", "x-api-key": mint() } });
    const res = new FakeResponse();
    const done = new Promise<FakeResponse>((resolve) => res.once("close", () => resolve(res)));
    gateway.server.emit("request", req, res);
    return { res: await done, sent };
  }

  it("unset: a source of a kind that is off is refused; set: it passes the switch (and is then refused because this company's connection is unreadable, never sent)", async () => {
    const off = await serve(undefined);
    expect(off.res.statusCode).toBe(403);
    expect(JSON.parse(off.res.text())).toEqual({ error: { type: AGENT_SOURCE_SWITCHED_OFF.code, message: AGENT_SOURCE_SWITCHED_OFF.message } });
    const on = await serve("endpoint");
    expect(on.res.statusCode).toBe(503);
    expect([...off.sent, ...on.sent]).toEqual([]);
  });
});

// ---- Cloud

describe("AI for your agents with the switch (Cloud)", () => {
  it("today's choices and answers are byte-identical with no switch, an empty one and every kind on", async () => {
    const answers: string[] = [];
    // Switching on only the pre-switch kinds lists nothing new; a new kind adds its own choice (A2), never changes these.
    for (const aiSourceKinds of [undefined, new Set<string>(), new Set<string>(["anthropic", "bedrock"])]) {
      const w = world({ company: true, ...(aiSourceKinds === undefined ? {} : { aiSourceKinds }) });
      const ada = await w.signIn("ada", 30);
      const read = await w.call(ada, "GET", "/org/agent-ai");
      const saved = await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "anthropic_key" });
      expect(saved.status).toBe(200);
      expect(await w.companies.agentAi(A)).toMatchObject({ source: "anthropic_key", version: 1 });
      answers.push(`${read.raw}\n${saved.raw}`);
    }
    expect(new Set(answers).size).toBe(1);
  });

  it("DEC 254zzz525: a connected Bedrock role never becomes the agents' default, whatever the kinds; only an explicit choice does, and only where `bedrock` is on", async () => {
    const model = "us.anthropic.claude-sonnet-5-5";
    const connect = { bedrock: { setup: async () => undefined, command: () => { throw new Error("not used"); }, presets: () => ({}) }, bedrockCheck: async () => ({ result: "ok" as const, models: { [model]: "ready" as const } }) };
    const body = (expectedRevision: number) => ({ requestId: crypto.randomUUID(), expectedRevision, roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-test", region: "us-west-2", models: { "claude-sonnet-5-5": model }, allowGlobal: false });
    // DEC 254zzz524: the kinds beta names (ops/pipeline/switches.json; production joins in its own commit) are one of the cases, so the row is what is tested.
    const rowKinds = (env: "beta" | "production") => new Set(loadSwitches().environments[env].aiSourceKinds.split(","));
    for (const [kinds, billedDefault] of [[new Set(["openai"]), true], [undefined, false], [new Set(["bedrock"]), false], [rowKinds("beta"), false]] as const) {
      const w = world({ company: true, ...(kinds === undefined ? {} : { aiSourceKinds: kinds }), ...connect });
      const ada = await w.signIn("ada");
      // The company's role connects (that is the product route's, DEC 254zzz520) ...
      expect((await w.call(ada, "PUT", "/org/bedrock", body(0))).status).toBe(200);
      const read = await w.call(ada, "GET", "/org/agent-ai");
      expect(read.body).toMatchObject({ bedrockConnected: true, source: null });
      // ... and the agents stay on Rovara's AI as the default everywhere (the role alone changes nothing); the choice is explicit, and open only where `bedrock` is on.
      expect(read.body).toMatchObject({ effectiveSource: "rovara", sourceIsDefault: true });
      const put = await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 0, source: "bedrock_byo" });
      expect(put.status).toBe(billedDefault ? 400 : 200);
      if (billedDefault) expect(await w.companies.agentAi(A)).toBeUndefined();
      else {
        expect(put.body).toMatchObject({ source: "bedrock_byo" });
        expect(Object.keys(put.body)).not.toContain("sourceIsDefault");
      }
    }
  });

  it("DEC 254zzz525: a bedrock_byo row the old backfill wrote is not a choice: it reads as no choice (Rovara's AI), keeps its version for the next save, and a real save replaces it", async () => {
    const model = "us.anthropic.claude-sonnet-5-5";
    const connect = { bedrock: { setup: async () => undefined, command: () => { throw new Error("not used"); }, presets: () => ({}) }, bedrockCheck: async () => ({ result: "ok" as const, models: { [model]: "ready" as const } }) };
    const w = world({ company: true, aiSourceKinds: new Set(["openai", "bedrock"]), ...connect });
    const ada = await w.signIn("ada");
    expect((await w.call(ada, "PUT", "/org/bedrock", { requestId: crypto.randomUUID(), expectedRevision: 0, roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-test", region: "us-west-2", models: { "claude-sonnet-5-5": model }, allowGlobal: false })).status).toBe(200);
    await w.companies.putAgentAi({ companyId: A, source: "bedrock_byo", updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "backfill:DEC254zzz279" }, 0);
    const read = await w.call(ada, "GET", "/org/agent-ai");
    expect(read.body).toMatchObject({ source: null, version: 1, effectiveSource: "rovara", sourceIsDefault: true, bedrockConnected: true });
    // The order screen shows no order; its revision is the row's.
    expect((await w.call(ada, "GET", "/org/model-sources")).body).toMatchObject({ order: [], revision: 1 });
    // A company's own save (the same source, by a person) is then a real choice.
    const put = await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 1, source: "bedrock_byo" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ source: "bedrock_byo", version: 2 });
    expect(await w.companies.agentAi(A)).toMatchObject({ source: "bedrock_byo", version: 2 });
    expect((await w.call(ada, "GET", "/org/agent-ai")).body).toMatchObject({ source: "bedrock_byo" });
  });

  it("a kind's name, an unbuilt source, or an own-key source without its key is never choosable, switched on or not", async () => {
    const w = world({ company: true, aiSourceKinds: new Set<string>(CLOUD_KINDS) });
    const ada = await w.signIn("ada", 30);
    for (const source of ["openai", "openai_key", "openrouter_key", "custom_endpoint"]) {
      const refused = await w.call(ada, "PUT", "/org/agent-ai", { expectedVersion: 0, source });
      expect(refused.status).toBe(400);
      expect(refused.raw).not.toContain(source);
    }
    expect(await w.companies.agentAi(A)).toBeUndefined();
  });
});

// ---- infra: one context value, both stacks

type Resource = { Type: string; Properties: Record<string, unknown> };
const gatewayEnv = (context: Record<string, string>, env = "staging") => {
  const app = buildAgentXApp({ [MODEL_GATEWAY_CONTEXT_KEY]: env, agentxRegion: "us-west-2", ...context });
  const t = Template.fromStack(app.node.findChild("RovaraModelGateway") as Stack).toJSON() as { Resources: Record<string, Resource> };
  const task = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::ECS::TaskDefinition" && id.startsWith("ServeTask"))![1];
  const container = (task.Properties.ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>)[0]!;
  return Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value]));
};
// Cloud's stack straight from its class with a stand-in app and code (as cloud-web.test.ts does), with what app.ts passes for the context.
const built = (() => { const dir = mkdtempSync(join(tmpdir(), "ai-source-switch-app-")); mkdirSync(join(dir, "assets")); writeFileSync(join(dir, "index.html"), "<!doctype html>"); writeFileSync(join(dir, "assets", "index-abc.js"), "export {};"); return dir; })();
const cloudEnv = (context: Record<string, string>, env = "staging") => {
  const stack = new CloudWebStack(new App(), "RovaraCloudWeb", { environmentName: env, env: { region: "us-east-1" }, appDirectory: built, code: Code.fromInline("export const handler = async () => ({});"), ...aiSourceKindsContext(context[AI_SOURCE_KINDS_CONTEXT_KEY]) });
  const t = Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> };
  const server = Object.entries(t.Resources).find(([id, r]) => r.Type === "AWS::Lambda::Function" && id.startsWith("Server"))![1];
  return (server.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
};

describe(`-c ${AI_SOURCE_KINDS_CONTEXT_KEY}`, () => {
  const productOn = { [MODEL_GATEWAY_PRODUCT_CONTEXT_KEY]: "on" };

  it("absent: neither stack sets anything (the templates as before)", () => {
    expect(aiSourceKindsContext(undefined)).toEqual({});
    expect(gatewayEnv(productOn)[GATEWAY_ENV.aiSourceKinds]).toBeUndefined();
    expect(cloudEnv({})[CLOUD_AI_SOURCE_KINDS_ENV]).toBeUndefined();
  });

  it("set: the same value reaches Cloud's server and the gateway's tasks", () => {
    expect(MODEL_GATEWAY_ENV.aiSourceKinds).toBe(GATEWAY_ENV.aiSourceKinds);
    expect(CLOUD_AI_SOURCE_KINDS_ENV).toBe("CLOUD_AI_SOURCE_KINDS");
    const context = { [AI_SOURCE_KINDS_CONTEXT_KEY]: "openai,openrouter" };
    expect(gatewayEnv({ ...productOn, ...context })[GATEWAY_ENV.aiSourceKinds]).toBe("openai,openrouter");
    expect(cloudEnv(context)[CLOUD_AI_SOURCE_KINDS_ENV]).toBe("openai,openrouter");
  });

  it("refuses a malformed value, a gateway without product AI, and production", () => {
    for (const bad of BAD) expect(() => aiSourceKindsContext(bad)).toThrow(`${AI_SOURCE_KINDS_CONTEXT_KEY} must be AI source kinds`);
    expect(() => aiSourceKindsContext(1)).toThrow(AI_SOURCE_KINDS_CONTEXT_KEY);
    expect(() => gatewayEnv({ [AI_SOURCE_KINDS_CONTEXT_KEY]: "openai" })).toThrow("company AI source kinds need the product AI additions");
    for (const kinds of ["openrouter", "openai,openrouter", "bedrock,endpoint", "endpoint", "anthropic", "openai,bedrock,openrouter"]) {
      expect(() => cloudEnv({ [AI_SOURCE_KINDS_CONTEXT_KEY]: kinds }, "production"), kinds).toThrow(PRODUCTION_SOURCE_KINDS_REFUSAL);
      expect(() => gatewayEnv({ ...productOn, [AI_SOURCE_KINDS_CONTEXT_KEY]: kinds }, "production"), kinds).toThrow(PRODUCTION_SOURCE_KINDS_REFUSAL);
    }
  });

  it("Rovara-cloud#308 + DEC 254zzz524: production may switch on OpenAI and the company's own Bedrock (agents), and the same value reaches both stacks", () => {
    expect(PRODUCTION_SOURCE_KINDS).toEqual(["openai", "bedrock"]);
    expect(productionSourceKindsAllowed("bedrock")).toBe(true);
    expect(productionSourceKindsAllowed("openai,bedrock")).toBe(true);
    expect(productionSourceKindsAllowed("bedrock,endpoint")).toBe(false);
    const both = { [AI_SOURCE_KINDS_CONTEXT_KEY]: "openai,bedrock" };
    expect(cloudEnv(both, "production")[CLOUD_AI_SOURCE_KINDS_ENV]).toBe("openai,bedrock");
    expect(gatewayEnv({ ...productOn, ...both }, "production")[GATEWAY_ENV.aiSourceKinds]).toBe("openai,bedrock");
    expect(productionSourceKindsAllowed(undefined)).toBe(true);
    expect(productionSourceKindsAllowed("")).toBe(true);
    expect(productionSourceKindsAllowed("openai")).toBe(true);
    expect(productionSourceKindsAllowed("openai,openrouter")).toBe(false);
    const context = { [AI_SOURCE_KINDS_CONTEXT_KEY]: "openai" };
    expect(cloudEnv(context, "production")[CLOUD_AI_SOURCE_KINDS_ENV]).toBe("openai");
    expect(gatewayEnv({ ...productOn, ...context }, "production")[GATEWAY_ENV.aiSourceKinds]).toBe("openai");
  });
});

it("R-1: no-choice own keys work without operator AI; no connection still refuses before send, independent of source switches", async () => {
 for (const switchedOn of [undefined, new Set<string>(), new Set(GATEWAY_KINDS)]) {
  const g = gateway(undefined, switchedOn);
  expect((await call(g.deps)).status).toBe(200);
  expect(g.sent.map(r => r.key)).toEqual([keyOf(claims.cid)]);
  const missing = gateway(undefined, switchedOn);
  missing.keys.connected = async () => false;
  expect((await call(missing.deps)).status).toBe(403);
  expect(missing.sent).toEqual([]); expect(missing.keys.reads).toEqual([]);
 }
});
