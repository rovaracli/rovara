// Review pins for the vendor/model (OpenRouter) name change in Cloud:
// (1) Cloud's 4 widened checks accept exactly what the gateway's OFFERED_MODEL_NAME accepts (rule-4 debt: the rule is copied, so a drift fails here);
// (2) money: a slash name can never be one of Rovara's AI models (the gateway refuses it on Rovara's account before any hold or send).
import { describe, expect, it } from "vitest";
import { agentModelsChange, engineModelView, modelNameOf } from "../../packages/cloud-server/src/index.js";
import { readAgentModels } from "../../packages/ui/src/api/agent-models.js";
import { readEngineModel } from "../../packages/ui/src/api/ai-spend.js";
import { OFFERED_MODEL_NAME } from "../../packages/model-gateway/src/offered-models.js";
import { parseRovaraAiModels } from "../../packages/model-gateway/src/agent-ai.js";
import { ROVARA_AI_MODEL, rovaraGuard } from "../../packages/model-gateway/src/rovara-ai-call.js";

const NAMES = [
  "openai/gpt-oss-20b", "meta-llama/llama-3.3-70b-instruct", "a/b", "a..b/c", "x.y_z-1/q.r_s-2", "a".repeat(63) + "/" + "b".repeat(63),
  "claude-sonnet-5-5", "zai.glm-4.7", "gpt-5", "us.anthropic.claude-x:0", "a".repeat(128), "A_b:C",
  "a//b", "A/b", "a/B", "a/b/c", "..", "/a", "a/", "a/-b", "_a/b", "a:b/c", "a".repeat(64) + "/b", "a/" + "b".repeat(64), "a".repeat(129), "", "a b", "a/b ", "é/b",
];
const cloudServerAccepts = (name: string) => agentModelsChange({ action: "set", stage: "build", model: name, expectedRevision: 0 }) !== undefined;
const engineAccepts = (name: string) => engineModelView({ model: name, source: "company", offered: [name], preselect: name }) !== undefined;
const uiAgentAccepts = (name: string) => { try { readAgentModels({ revision: 0, canChange: true, steps: [], offered: [name] }); return true; } catch { return false; } };
const uiEngineAccepts = (name: string) => { try { readEngineModel({ model: name, source: "company", offered: [name], preselect: name, canChange: true }); return true; } catch { return false; } };

describe("Cloud's model-name checks match the gateway's OFFERED_MODEL_NAME exactly", () => {
  it.each(NAMES)("%s", (name) => {
    const gateway = OFFERED_MODEL_NAME.test(name);
    expect({ cloudServerAccepts: cloudServerAccepts(name), engineAccepts: engineAccepts(name), uiAgentAccepts: uiAgentAccepts(name), uiEngineAccepts: uiEngineAccepts(name) })
      .toEqual({ cloudServerAccepts: gateway, engineAccepts: gateway, uiAgentAccepts: gateway, uiEngineAccepts: gateway });
    if (gateway && name.includes("/")) expect(modelNameOf({ provider: "openrouter", modelId: name })).toBe(name);
  });
});

describe("a slash name is never Rovara's AI", () => {
  it("Rovara's AI model list cannot hold a slash name", () => {
    expect(() => parseRovaraAiModels("openai/gpt-oss-20b=openai.gpt-oss-20b-1:0", "us-west-2")).toThrow();
    expect(() => parseRovaraAiModels("openai/gpt-oss-20b=openai/gpt-oss-20b", "us-west-2")).toThrow();
  });

  it("the gateway's Rovara's AI guard refuses a slash model (before any hold: the guard runs first)", () => {
    const models = parseRovaraAiModels("openai.gpt-oss-20b-1:0=openai.gpt-oss-20b-1:0", "us-west-2");
    expect(rovaraGuard({ model: "openai/gpt-oss-20b" } as Parameters<typeof rovaraGuard>[0], { models })).toBe(ROVARA_AI_MODEL);
  });
});
