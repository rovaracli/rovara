// R-1 hardens gateway admission for connections made after backfill. Cloud reports the saved choice/default;
// both agree for unconnected companies and explicit choices. Exemption parsing stays equal.
import { describe, expect, it } from "vitest";
import { effectiveAgentSource, parseRovaraAiExempt as cloudParse, ROVARA_AI_EXEMPT_MAX as CLOUD_MAX } from "../../packages/cloud-server/src/company-store.js";
import { resolveAgentSource, defaultAgentSource, parseRovaraAiExempt as gatewayParse, ROVARA_AI_EXEMPT_MAX as GATEWAY_MAX } from "../../packages/model-gateway/src/agent-ai.js";

describe("gateway R-1 preservation and the Cloud saved-choice contract", () => {
  it("unconnected companies default to Rovara AI in both layers, regardless of exemption", () => {
    expect(defaultAgentSource({ keyConnected: false, bedrockConnected: false })).toEqual({ source: "rovara", via: "default" });
    for (const exempt of [true, false]) expect(effectiveAgentSource({ saved: undefined, exempt, keyConnected: false, bedrockConnected: false })).toEqual({ source: "rovara", isDefault: true });
  });
  it.each([
    [true, false, "anthropic_key"], [false, true, "bedrock_byo"], [true, true, "anthropic_key"],
  ] as const)("gateway preserves connected own sources: Anthropic=%s Bedrock=%s", (keyConnected, bedrockConnected, source) => {
    expect(defaultAgentSource({ keyConnected, bedrockConnected })).toEqual({ source, via: "own_key" });
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
