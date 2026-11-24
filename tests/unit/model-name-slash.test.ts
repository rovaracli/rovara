// OpenRouter names its models `vendor/model` (one "/"). Cloud's model-name checks must accept that shape (the same rule as Code's AGENT_MODEL_NAME and the gateway's
// OFFERED_MODEL_NAME), or "Models you can use" fails as MODELS-FAILED; and a slash name must never be mapped to a provider Rovara bills.
import { describe, expect, it } from "vitest";
import { agentModelsChange, agentModelsView, engineModelView, learningModelView, modelIdentityOf, modelNameOf } from "../../packages/cloud-server/src/index.js";
import { readAgentModels } from "../../packages/ui/src/api/agent-models.js";
import { readEngineModel } from "../../packages/ui/src/api/ai-spend.js";
import { readLearningModel } from "../../packages/ui/src/api/learning-model.js";

const SLASH = "openai/gpt-oss-20b";
const BAD = ["a//b", "A/b", "a/b/c", "..", "/a", "a/", "a/-b", "a".repeat(64) + "/b", "a/" + "b".repeat(64), "a".repeat(129)];
const OR = { provider: "openrouter", modelId: SLASH };

describe("a vendor/model name (OpenRouter)", () => {
  it("maps to the openrouter identity, and every other name keeps its old mapping", () => {
    expect(modelIdentityOf(SLASH)).toEqual(OR);
    expect(modelIdentityOf("claude-sonnet-5-5")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(modelIdentityOf("gpt-5")).toEqual({ provider: "openai", modelId: "gpt-5" });
    expect(modelIdentityOf("zai.glm-5")).toEqual({ provider: "amazon-bedrock", modelId: "zai.glm-5" });
    // Even a name that looks like Claude or OpenAI is OpenRouter's once it has a "/".
    for (const name of ["claude-x/y", "gpt-5/mini", "anthropic/claude-sonnet-5"]) expect(modelIdentityOf(name).provider).toBe("openrouter");
  });

  it("round-trips through modelNameOf only with the openrouter identity", () => {
    expect(modelNameOf(OR)).toBe(SLASH);
    for (const provider of ["anthropic", "openai", "amazon-bedrock"]) expect(modelNameOf({ provider, modelId: SLASH })).toBeUndefined();
    expect(modelNameOf({ provider: "openrouter", modelId: "plain-name" })).toBeUndefined();
    for (const bad of BAD) expect(modelNameOf({ provider: "openrouter", modelId: bad })).toBeUndefined();
  });

  it("the offered list with OpenRouter rows parses end to end (the MODELS-FAILED case)", () => {
    const page = {
      state: { revision: 3, steps: [{ stage: "build", setting: { model: OR }, effective: { model: OR, reason: "COMPANY_DEFAULT" } }] },
      offered: { version: 1, models: [
        { model: SLASH, identity: OR, price: { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.2 } },
        { model: "meta-llama/llama-3.3-70b-instruct", identity: { provider: "openrouter", modelId: "meta-llama/llama-3.3-70b-instruct" } },
        { model: "claude-sonnet-5-5" },
      ] },
    };
    const view = agentModelsView(page);
    expect(view).toMatchObject({ revision: 3, offered: [SLASH, "meta-llama/llama-3.3-70b-instruct", "claude-sonnet-5-5"], steps: [{ stage: "build", setting: SLASH, effective: { model: SLASH, priceUsdPerMillion: { input: 0.05, output: 0.2 } } }] });
    // The answer Cloud sends the browser parses in the UI too.
    const browser = readAgentModels({ revision: 3, canChange: true, offered: view!.offered, steps: view!.steps });
    expect(browser.offered).toContain(SLASH);
    expect(browser.steps[0]?.setting).toBe(SLASH);
  });

  it("an offered row with a bad shape still makes the page unreadable", () => {
    for (const bad of BAD) {
      expect(agentModelsView({ state: { revision: 0, steps: [] }, offered: { version: 1, models: [{ model: bad }] } })).toBeUndefined();
      expect(() => readAgentModels({ revision: 0, canChange: true, steps: [], offered: [bad] })).toThrow();
    }
  });

  it("a step change to a slash model is forwarded as the openrouter identity; bad shapes are refused", () => {
    expect(agentModelsChange({ action: "set", stage: "build", model: SLASH, expectedRevision: 1 })).toEqual({ action: "set", stage: "build", choice: { model: OR }, expectedRevision: 1 });
    for (const bad of BAD) expect(agentModelsChange({ action: "set", stage: "build", model: bad, expectedRevision: 1 })).toBeUndefined();
  });

  it("the company's AI model accepts it on both sides", () => {
    const answer = { model: SLASH, source: "company", offered: [SLASH, "claude-sonnet-5-5"], preselect: SLASH };
    expect(engineModelView(answer)).toEqual(answer);
    expect(readEngineModel({ ...answer, canChange: true }).offered).toContain(SLASH);
    for (const bad of BAD) {
      expect(engineModelView({ ...answer, model: bad })).toBeUndefined();
      expect(engineModelView({ ...answer, offered: [bad], preselect: bad })).toBeUndefined();
      expect(() => readEngineModel({ ...answer, canChange: true, model: bad })).toThrow();
      expect(() => readEngineModel({ ...answer, canChange: true, offered: [bad], preselect: bad })).toThrow();
    }
  });

  it("the learning model stays without slash names (learning has no OpenRouter path)", () => {
    const answer = { model: null, source: "install", offered: [SLASH], preselect: SLASH };
    expect(learningModelView(answer)).toBeUndefined();
    expect(() => readLearningModel({ ...answer, canChange: true })).toThrow();
    const ok = { model: "claude-haiku-5-5", source: "company", offered: ["claude-haiku-5-5"], preselect: "claude-haiku-5-5" };
    expect(learningModelView(ok)).toEqual(ok);
    expect(readLearningModel({ ...ok, canChange: true }).model).toBe("claude-haiku-5-5");
  });
});
