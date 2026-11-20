// L4-AIDEF: the gateway's default source rule (agent-ai.ts defaultAgentSource, what every call uses) and Cloud's copy for the settings screen
// (company-store.ts effectiveAgentSource) say the same thing for every combination, and the exempt list parses the same way in both (the same ids
// go to GATEWAY_ROVARA_AI_EXEMPT and CLOUD_ROVARA_AI_EXEMPT).
import { describe, expect, it } from "vitest";
import { effectiveAgentSource, parseRovaraAiExempt as cloudParse, ROVARA_AI_EXEMPT_MAX as CLOUD_MAX } from "../../packages/cloud-server/src/company-store.js";
import { resolveAgentSource, defaultAgentSource, parseRovaraAiExempt as gatewayParse, ROVARA_AI_EXEMPT_MAX as GATEWAY_MAX } from "../../packages/model-gateway/src/agent-ai.js";

describe("the default rule is the same in the gateway and in Cloud", () => {
  it("every no-choice company defaults to Rovara despite connected or unreadable provider facts", () => {
    for (const exempt of [true, false]) for (const keyConnected of [true, false, null]) for (const bedrockConnected of [true, false, null]) {
      const gateway = defaultAgentSource({ keyConnected: keyConnected === true, bedrockConnected: bedrockConnected === true });
      expect(gateway).toEqual({ source: "rovara", via: "default" });
      expect(effectiveAgentSource({ saved: undefined, exempt, keyConnected, bedrockConnected })).toEqual({ source: "rovara", isDefault: true });
    }
  });
  it("explicit choices win for every company", async () => {
    for (const source of ["rovara", "anthropic_key", "bedrock_byo", "openrouter_key"] as const) for (const exempt of [true, false]) {
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
