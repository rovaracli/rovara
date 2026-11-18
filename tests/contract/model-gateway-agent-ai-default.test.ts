// L4-AIDEF: the gateway's default source rule (agent-ai.ts defaultAgentSource, what every call uses) and Cloud's copy for the settings screen
// (company-store.ts effectiveAgentSource) say the same thing for every combination, and the exempt list parses the same way in both (the same ids
// go to GATEWAY_ROVARA_AI_EXEMPT and CLOUD_ROVARA_AI_EXEMPT).
import { describe, expect, it } from "vitest";
import { effectiveAgentSource, parseRovaraAiExempt as cloudParse, ROVARA_AI_EXEMPT_MAX as CLOUD_MAX } from "../../packages/cloud-server/src/company-store.js";
import { defaultAgentSource, parseRovaraAiExempt as gatewayParse, ROVARA_AI_EXEMPT_MAX as GATEWAY_MAX } from "../../packages/model-gateway/src/agent-ai.js";

describe("the default rule is the same in the gateway and in Cloud", () => {
  it("every key/Bedrock combination", () => {
    for (const keyConnected of [true, false]) for (const bedrockConnected of [true, false]) {
      const gateway = defaultAgentSource({ keyConnected, bedrockConnected });
      const cloud = effectiveAgentSource({ saved: undefined, exempt: true, keyConnected, bedrockConnected });
      // The gateway's undefined source is company-key mode, which Cloud names as the own Anthropic key.
      expect(cloud.source).toBe(gateway.source ?? "anthropic_key");
      expect(cloud.isDefault).toBe(true);
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
