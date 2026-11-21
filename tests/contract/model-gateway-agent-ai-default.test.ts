// Cloud and gateway must report the same source, including connections made after backfill.
import { describe, expect, it } from "vitest";
import { effectiveAgentSource, parseRovaraAiExempt as cloudParse, ROVARA_AI_EXEMPT_MAX as CLOUD_MAX } from "../../packages/cloud-server/src/company-store.js";
import { resolveAgentSource, defaultAgentSource, parseRovaraAiExempt as gatewayParse, ROVARA_AI_EXEMPT_MAX as GATEWAY_MAX } from "../../packages/model-gateway/src/agent-ai.js";

describe("gateway R-1 preservation and the full Cloud source contract", () => {
  it.each([
    [false, false, "rovara"],
    [true, false, "anthropic_key"], [false, true, "bedrock_byo"], [true, true, "anthropic_key"],
    [true, null, "anthropic_key"], [false, null, null],
    [null, true, null], [null, false, null], [null, null, null],
  ] as const)("Cloud and gateway agree: Anthropic=%s Bedrock=%s", async (keyConnected, bedrockConnected, source) => {
    const via = source === "rovara" ? "default" : "own_key";
    if (source !== null) expect(defaultAgentSource({ keyConnected: keyConnected === true, bedrockConnected: bedrockConnected === true })).toEqual({ source, via });
    for (const exempt of [true, false]) {
      const cloud = effectiveAgentSource({ saved: undefined, exempt, keyConnected, bedrockConnected });
      const gateway = resolveAgentSource({ sources: { sourceFor: async () => undefined }, keys: { connected: async () => { if (keyConnected === null) throw new Error("connection unreadable"); return keyConnected; } }, byo: { connection: async (iss, cid) => { if (bedrockConnected === null) throw new Error("connection unreadable"); return bedrockConnected ? {
        row: { iss, cid, owner: "_company", sourceId: "src_bedrock", versionId: "v1" },
        connection: { scheme: "assume_role", roleArn: "arn:aws:iam::111111111111:role/Agents", region: "us-west-2", models: { "claude-sonnet-5-5": "us.anthropic.claude-sonnet-5-5" }, allowGlobal: false },
      } : undefined; } } }, "issuer", `org_${"a".repeat(20)}`);
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
      expect(effectiveAgentSource({ saved: source, exempt, keyConnected: null, bedrockConnected: null })).toEqual({ source, isDefault: false });
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
