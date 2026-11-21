// DEC 263 / R-1: own connections precede the billed default; explicit choices win; exemption is billing only.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentAiConnected } from "../../packages/cloud-server/src/agent-ai-presence.js";
import { effectiveAgentSource, parseRovaraAiExempt, ROVARA_AI_EXEMPT_MAX } from "../../packages/cloud-server/src/company-store.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";
import { A, B, world, write } from "./product-ai-world.js";

const PATH = "/org/agent-ai";
const fakeKey = () => ["sk", "ant", randomBytes(16).toString("hex")].join("-");

describe("effectiveAgentSource (the pure rule)", () => {
  it("a saved choice is the source, never a default", () => {
    for (const saved of ["rovara", "anthropic_key", "bedrock_byo", "openai_key"] as const) expect(effectiveAgentSource({ saved, exempt: true, keyConnected: true, bedrockConnected: true })).toEqual({ source: saved, isDefault: false });
  });
  it.each([
    [true, true, "anthropic_key"], [true, false, "anthropic_key"], [true, null, "anthropic_key"],
    [false, true, "bedrock_byo"], [false, false, "rovara"], [false, null, null],
    [null, true, null], [null, false, null], [null, null, null],
  ] as const)("unsaved choice: key=%s Bedrock=%s reports %s without guessing on read faults", (keyConnected, bedrockConnected, source) => {
    for (const exempt of [true, false]) expect(effectiveAgentSource({ saved: undefined, exempt, keyConnected, bedrockConnected })).toEqual({ source, isDefault: source !== null });
  });
});

describe("parseRovaraAiExempt", () => {
  it("absent or empty is none; a list of company ids is a set; anything else throws in fixed words", () => {
    expect(parseRovaraAiExempt(undefined).size).toBe(0);
    expect(parseRovaraAiExempt("").size).toBe(0);
    expect([...parseRovaraAiExempt(`${A},${B}`)]).toEqual([A, B]);
    for (const bad of ["org_x", `${A},${A}`, `${A},`, "<b>", Array.from({ length: ROVARA_AI_EXEMPT_MAX + 1 }, (_, i) => `org_${String(i).padStart(20, "a")}`).join(",")]) {
      expect(() => parseRovaraAiExempt(bad)).toThrow("invalid rovara ai exempt companies");
    }
  });
});

describe("GET /org/agent-ai for the default", () => {
  it("an exempt company with nothing saved and nothing connected is on Rovara's AI by default; nothing is written", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const ada = await w.signIn("ada", 30);
    const got = await w.call(ada, "GET", PATH);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ source: null, version: 0, effectiveSource: "rovara", sourceIsDefault: true });
    expect(await w.companies.agentAi(A)).toBeUndefined();
  });

  it("connected Anthropic credentials report the own key without saving a choice", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: fakeKey() }));
    expect((await w.call(ada, "GET", PATH)).body).toMatchObject({ source: null, version: 0, effectiveSource: "anthropic_key", sourceIsDefault: true, anthropicKeyConnected: true });
    expect(await w.companies.agentAi(A)).toBeUndefined();
  });

  it("own Bedrock is reported until an Anthropic key is connected, for both billing classes", async () => {
    for (const exempt of [true, false]) {
      const model = "us.anthropic.claude-sonnet-5-5";
      const w = world({ company: true, rovaraAiExempt: new Set(exempt ? [A] : []), bedrock: { setup: async () => undefined, command: () => { throw new Error("not used"); }, presets: () => ({}) }, bedrockCheck: async () => ({ result: "ok", models: { [model]: "ready" } }) });
      const ada = await w.signIn("ada");
      expect((await w.call(ada, "PUT", "/org/bedrock", write(0, { roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-test", region: "us-west-2", models: { "claude-sonnet-5-5": model }, allowGlobal: false }))).status).toBe(200);
      expect((await w.call(ada, "GET", PATH)).body).toMatchObject({ source: null, version: 0, effectiveSource: "bedrock_byo", sourceIsDefault: true, bedrockConnected: true });
      expect((await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: fakeKey() }))).status).toBe(200);
      expect((await w.call(ada, "GET", PATH)).body).toMatchObject({ source: null, effectiveSource: "anthropic_key", sourceIsDefault: true });
      expect(await w.companies.agentAi(A)).toBeUndefined();
    }
  });

  it.each(["_learning", "_company"])("an unreadable %s connection never claims billed Rovara AI", async (owner) => {
    const w = world({ company: true, bedrock: { setup: async () => undefined, command: () => { throw new Error("not used"); }, presets: () => ({}) } });
    const ada = await w.signIn("ada");
    const view = w.store.view.bind(w.store);
    w.store.view = async (iss, cid, readOwner) => { if (readOwner === owner) throw new Error("unreadable"); return view(iss, cid, readOwner); };
    const got = await w.call(ada, "GET", PATH);
    expect(got.status).toBe(503);
    expect(got.body).not.toHaveProperty("effectiveSource");
    expect(got.body).not.toHaveProperty("sourceIsDefault");
  });

  it("switching back to Rovara's AI is an explicit save; afterwards it is a saved choice, not a default", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: fakeKey() }));
    const saved = await w.call(ada, "PUT", PATH, { expectedVersion: 0, source: "rovara" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ source: "rovara", version: 1 });
    expect(Object.keys(saved.body)).not.toContain("effectiveSource");
    expect(Object.keys(saved.body)).not.toContain("sourceIsDefault");
  });

  it("a saved own-key choice is never reported as a default", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: fakeKey() }));
    await w.call(ada, "PUT", PATH, { expectedVersion: 0, source: "anthropic_key" });
    const got = await w.call(ada, "GET", PATH);
    expect(got.body).toMatchObject({ source: "anthropic_key" });
    expect(Object.keys(got.body)).not.toContain("sourceIsDefault");
  });

  it("a NON-exempt company receives the same default, isolated from another company's choice", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    const a = await w.call(ada, "GET", PATH);
    const b = await w.call(bea, "GET", PATH);
    expect(a.body).toMatchObject({ effectiveSource: "rovara", sourceIsDefault: true });
    expect(b.body).toMatchObject({ source: null, version: 0, effectiveSource: "rovara", sourceIsDefault: true });
    // A's own key never makes B's default.
    await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: fakeKey() }));
    expect((await w.call(bea, "GET", PATH)).body).toEqual(b.body);
  });

  it("no exemption configuration is required for the default", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30);
    expect((await w.call(ada, "GET", PATH)).body).toMatchObject({ effectiveSource: "rovara", sourceIsDefault: true });
  });

  it("still company admins only: a plain member of an exempt company learns nothing", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const pam = await w.signIn("pam", 30);
    expect((await w.call(pam, "GET", PATH)).status).toBe(403);
  });
});

describe("agentAiConnected for an exempt company with no saved choice", () => {
  type Ctx = Pick<RouteContext, "company" | "productAi">;
  const context = (exempt: string[], extra: { anthropic?: boolean; bedrock?: boolean | "throws"; noBedrockBackend?: boolean; saved?: string } = {}) => ({
    company: { rovaraAiExempt: new Set(exempt), store: { agentAi: async () => extra.saved === undefined ? undefined : { source: extra.saved } } },
    productAi: {
      issuer: "iss", ...(extra.noBedrockBackend === true ? {} : { bedrock: {} }),
      store: { view: async (_i: string, _c: string, owner: string) => {
        if (owner === "_learning") return { sources: [{ provider: "anthropic", hasKey: true, available: extra.anthropic === true }] };
        if (extra.bedrock === "throws") throw new Error("down");
        return { sources: [{ provider: "bedrock", hasKey: true, available: extra.bedrock === true }] };
      } },
    },
  }) as unknown as Ctx;
  it("is connected while nothing is connected (Rovara's AI is the default), and still for its own key or Bedrock", async () => {
    expect(await agentAiConnected(context([A]), A)).toBe(true);
    expect(await agentAiConnected(context([A], { anthropic: true }), A)).toBe(true);
    expect(await agentAiConnected(context([A], { bedrock: true }), A)).toBe(true);
    expect(await agentAiConnected(context([A], { noBedrockBackend: true }), A)).toBe(true);
  });
  it("a non-exempt company needs no key to satisfy presence", async () => {
    expect(await agentAiConnected(context([B]), A)).toBe(true);
    expect(await agentAiConnected(context([], { anthropic: true }), A)).toBe(true);
  });
  it("required connection faults stay unknown; irrelevant Bedrock faults and explicit choices keep readiness checks", async () => {
    // R-1 / DEC 254zzz279: Bedrock is required when Anthropic is absent; a read fault cannot prove the billed Rovara default.
    expect(await agentAiConnected(context([A], { bedrock: "throws" }), A)).toBeNull();
    expect(await agentAiConnected(context([A], { noBedrockBackend: true, bedrock: "throws" }), A)).toBeNull();
    expect(await agentAiConnected(context([A], { anthropic: true, bedrock: "throws" }), A)).toBe(true);
    expect(await agentAiConnected(context([A], { saved: "anthropic_key" }), A)).toBe(false);
  });
});

it("an unreadable saved choice never becomes a default or connected fact", async () => {
  const w = world({ company: true }); const ada = await w.signIn("ada", 30);
  w.companies.agentAi = async () => { throw new Error("unreadable"); };
  expect((await w.call(ada, "GET", PATH)).status).toBe(503);
  expect(await agentAiConnected({ company: { store: w.companies } }, A)).toBeNull();
});
