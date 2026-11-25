// Cloud and gateway must report the same source, including connections made after backfill.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { effectiveAgentSource, parseRovaraAiExempt as cloudParse, ROVARA_AI_EXEMPT_MAX as CLOUD_MAX } from "../../packages/cloud-server/src/company-store.js";
import { resolveAgentSource, defaultAgentSource, parseRovaraAiExempt as gatewayParse, ROVARA_AI_EXEMPT_MAX as GATEWAY_MAX } from "../../packages/model-gateway/src/agent-ai.js";
import { storedLearningKeys } from "../../packages/model-gateway/src/learning-keys.js";
import { BEDROCK_SOURCE_ID, PRODUCT_COMPANY_OWNER } from "../../packages/model-gateway/src/product-keys.js";
import { readAgentAi } from "../../packages/ui/src/api/admin-agent-ai.js";
import { A, B, ISS, world, write } from "../unit/product-ai-world.js";

describe("gateway R-1 preservation and the full Cloud source contract", () => {
  for (const adapters of [false, true]) it.each([
    [false, false, "rovara"],
    // DEC 254zzz525: a connected (or unreadable) Bedrock role never changes the default; only the own Anthropic key read decides.
    [true, false, "anthropic_key"], [false, true, "rovara"], [true, true, "anthropic_key"],
    [true, null, "anthropic_key"], [false, null, "rovara"],
    [null, true, null], [null, false, null], [null, null, null],
  ] as const)(`real Cloud route and gateway agree with adapters=${adapters}: Anthropic=%s Bedrock=%s`, async (keyConnected, bedrockConnected, source) => {
    for (const exempt of [false, true]) {
      const id = "us.anthropic.claude-sonnet-5-5";
      const w = world({ company: true, rovaraAiExempt: new Set(exempt ? [A] : []),
        ...(adapters ? { bedrock: { setup: async () => undefined, command: () => { throw new Error("not used"); }, presets: () => ({}) } } : {}),
        bedrockCheck: async () => ({ result: "ok", models: { [id]: "ready" } }),
      });
      const ada = await w.signIn("ada");
      if (keyConnected === true) expect((await w.call(ada, "PUT", "/org/learning-ai/key", write(0, { provider: "anthropic", key: "fixture-anthropic-key" }))).status).toBe(200);
      if (bedrockConnected === true) await w.store.connect({ iss: ISS, cid: A, owner: PRODUCT_COMPANY_OWNER, sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", expectedRevision: 0, requestId: randomUUID(), actor: { id: "d".repeat(64), role: "company_admin" }, key: JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-test", region: "us-west-2", models: { "claude-sonnet-5-5": id }, allowGlobal: false }) });
      const get = w.table.get.bind(w.table);
      vi.spyOn(w.table, "get").mockImplementation(async (key, stage) => {
        if ((keyConnected === null && key.endsWith("#doc#_learning")) || (bedrockConnected === null && key.endsWith("#doc#_company"))) throw new Error("connection unreadable");
        return get(key, stage);
      });
      const useKey = vi.spyOn(w.store, "useKey");
      if (!adapters) useKey.mockImplementation(async () => { throw new Error("metadata must not open credentials"); });
      const ports = { sources: { sourceFor: async () => undefined }, keys: storedLearningKeys(w.store) };
      const gateway = resolveAgentSource(ports, ISS, A);
      if (source === null) await expect(gateway).rejects.toThrow();
      else expect(await gateway).toEqual({ source, via: source === "rovara" ? "default" : "own_key" });
      const cloud = await w.call(ada, "GET", "/org/agent-ai");
      if (source === null) {
        expect(cloud.status).toBe(503);
        expect(cloud.body).not.toHaveProperty("effectiveSource");
        expect(cloud.body).not.toHaveProperty("sourceIsDefault");
      } else {
        expect(cloud.status).toBe(200);
        expect(cloud.body).toMatchObject({ source: null, version: 0, effectiveSource: source, sourceIsDefault: true });
        expect(readAgentAi(cloud.body).effectiveSource).toBe(source);
        if (!adapters) expect(cloud.body.choices).toContainEqual({ source: "bedrock_byo", available: false });
      }
      expect(await w.companies.agentAi(A)).toBeUndefined();
      if (!adapters) expect(useKey).not.toHaveBeenCalled();
    }
  });

  it("absent adapters do not reuse another company or issuer's Bedrock metadata", async () => {
    const id = "us.anthropic.claude-sonnet-5-5";
    const w = world({ company: true, bedrockCheck: async () => ({ result: "ok", models: { [id]: "ready" } }) });
    await w.store.connect({ iss: ISS, cid: A, owner: PRODUCT_COMPANY_OWNER, sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", expectedRevision: 0, requestId: randomUUID(), actor: { id: "d".repeat(64), role: "company_admin" }, key: JSON.stringify({ scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/RovaraBedrockInvoke-test", region: "us-west-2", models: { "claude-sonnet-5-5": id }, allowGlobal: false }) });
    const ports = { sources: { sourceFor: async () => undefined }, keys: storedLearningKeys(w.store) };
    expect(await resolveAgentSource(ports, ISS, B)).toEqual({ source: "rovara", via: "default" });
    expect(await resolveAgentSource(ports, "https://other.example.test/v1/auth", A)).toEqual({ source: "rovara", via: "default" });
    const bea = await w.signIn("bea");
    expect((await w.call(bea, "GET", "/org/agent-ai")).body).toMatchObject({ effectiveSource: "rovara" });
  });
  it.each([
    [false, false, "rovara"],
    // DEC 254zzz525: a connected (or unreadable) Bedrock role never changes the default; only the own Anthropic key read decides.
    [true, false, "anthropic_key"], [false, true, "rovara"], [true, true, "anthropic_key"],
    [true, null, "anthropic_key"], [false, null, "rovara"],
    [null, true, null], [null, false, null], [null, null, null],
  ] as const)("Cloud and gateway agree: Anthropic=%s Bedrock=%s", async (keyConnected, bedrockConnected, source) => {
    const via = source === "rovara" ? "default" : "own_key";
    if (source !== null) expect(defaultAgentSource({ keyConnected: keyConnected === true })).toEqual({ source, via });
    for (const exempt of [true, false]) {
      const cloud = effectiveAgentSource({ saved: undefined, exempt, keyConnected });
      const gateway = resolveAgentSource({ sources: { sourceFor: async () => undefined }, keys: { connected: async () => { if (keyConnected === null) throw new Error("connection unreadable"); return keyConnected; } } }, "issuer", `org_${"a".repeat(20)}`);
      expect(cloud).toEqual({ source, isDefault: source !== null });
      if (source === null) await expect(gateway).rejects.toThrow("connection unreadable");
      else {
        const resolved = await gateway;
        expect(resolved).toEqual({ source, via });
        expect(cloud.source).toBe(resolved.source);
      }
    }
  });
  it("explicit choices win for every company", async () => {
    for (const source of ["rovara", "anthropic_key", "bedrock_byo", "openai_key", "openrouter_key", "custom_endpoint"] as const) for (const exempt of [true, false]) {
      expect(effectiveAgentSource({ saved: source, exempt, keyConnected: null })).toEqual({ source, isDefault: false });
      expect(await resolveAgentSource({ sources: { sourceFor: async () => source }, keys: { connected: async () => { throw new Error("must not read"); } } }, "issuer", `org_${"a".repeat(20)}`)).toEqual({ source, via: "chosen" });
    }
  });
  it("the exempt list: the same limit and the same accepted and refused values", () => {
    expect(CLOUD_MAX).toBe(GATEWAY_MAX);
    const a = `org_${"a".repeat(20)}`; const b = `org_${"b".repeat(20)}`;
    for (const value of [undefined, "", a, `${a},${b}`, ` ${a} , ${b}`, `${a},${a}`, "org_short", `${a},`, "x".repeat(300), Array.from({ length: GATEWAY_MAX + 1 }, (_, i) => `org_${String(i).padStart(20, "a")}`).join(",")]) {
      let g: string[] | "throws"; let c: string[] | "throws";
      try { g = [...gatewayParse(value)]; } catch { g = "throws"; }
      try { c = [...cloudParse(value)]; } catch { c = "throws"; }
      expect(c).toEqual(g);
    }
  });
});
