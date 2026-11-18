// L4-AIDEF (owner DEC 254zzz3(1)): what the settings screen's route says for a company the operator named exempt (the pilot list, CLOUD_ROVARA_AI_EXEMPT, the same
// ids as the gateway's GATEWAY_ROVARA_AI_EXEMPT). The gateway decides every call (tests/unit/model-gateway-rovara-default.test.ts); this is the same rule shown to the admin:
// no saved choice + exempt: Rovara's AI unless its own Anthropic key or Bedrock is connected. A saved choice, or a company that is not exempt, is answered byte for byte as before
// (neither new field is added). Two companies never meet.
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
  it("not exempt and nothing saved: nothing is said", () => {
    for (const keyConnected of [true, false, null]) for (const bedrockConnected of [true, false, null]) expect(effectiveAgentSource({ saved: undefined, exempt: false, keyConnected, bedrockConnected })).toEqual({ source: null, isDefault: false });
  });
  it("exempt: own key, then own Bedrock, then Rovara's AI; a connection it cannot read is never guessed", () => {
    expect(effectiveAgentSource({ saved: undefined, exempt: true, keyConnected: true, bedrockConnected: true })).toEqual({ source: "anthropic_key", isDefault: true });
    expect(effectiveAgentSource({ saved: undefined, exempt: true, keyConnected: true, bedrockConnected: null })).toEqual({ source: "anthropic_key", isDefault: true });
    expect(effectiveAgentSource({ saved: undefined, exempt: true, keyConnected: false, bedrockConnected: true })).toEqual({ source: "bedrock_byo", isDefault: true });
    expect(effectiveAgentSource({ saved: undefined, exempt: true, keyConnected: false, bedrockConnected: false })).toEqual({ source: "rovara", isDefault: true });
    expect(effectiveAgentSource({ saved: undefined, exempt: true, keyConnected: null, bedrockConnected: false })).toEqual({ source: null, isDefault: false });
    expect(effectiveAgentSource({ saved: undefined, exempt: true, keyConnected: false, bedrockConnected: null })).toEqual({ source: null, isDefault: false });
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

  it("its own connected Anthropic key is the default at once (the key wins)", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const ada = await w.signIn("ada", 30);
    await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: fakeKey() }));
    expect((await w.call(ada, "GET", PATH)).body).toMatchObject({ source: null, effectiveSource: "anthropic_key", sourceIsDefault: true });
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

  it("a company that is NOT exempt is answered exactly as before (no new field), and the exempt list is per company (two companies)", async () => {
    const w = world({ company: true, rovaraAiExempt: new Set([A]) });
    const ada = await w.signIn("ada", 30); const bea = await w.signIn("bea", 30);
    const a = await w.call(ada, "GET", PATH);
    const b = await w.call(bea, "GET", PATH);
    expect(a.body).toMatchObject({ effectiveSource: "rovara", sourceIsDefault: true });
    expect(b.body).toEqual({ source: null, version: 0, canChange: true, anthropicKeyConnected: false, bedrockConnected: null, choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }] });
    // A's own key never makes B's default.
    await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: fakeKey() }));
    expect((await w.call(bea, "GET", PATH)).body).toEqual(b.body);
  });

  it("with no exempt list at all (a Cloud that was not given one) every answer is as before", async () => {
    const w = world({ company: true });
    const ada = await w.signIn("ada", 30);
    expect(Object.keys((await w.call(ada, "GET", PATH)).body)).not.toContain("effectiveSource");
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
  it("a company that is not exempt keeps today's reading (no choice means its own Anthropic key)", async () => {
    expect(await agentAiConnected(context([B]), A)).toBe(false);
    expect(await agentAiConnected(context([], { anthropic: true }), A)).toBe(true);
  });
  it("cannot tell when its Bedrock cannot be read; a saved choice is read as before", async () => {
    expect(await agentAiConnected(context([A], { bedrock: "throws" }), A)).toBeNull();
    expect(await agentAiConnected(context([A], { saved: "anthropic_key" }), A)).toBe(false);
  });
});
