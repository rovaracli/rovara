import { describe, expect, it } from "vitest";
import { ModelRefSchema, ModelSelectionSchema, ProjectModelsSchema, ThinkingLevelSchema } from "@agentx/contracts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const sonnet = { provider: "anthropic", modelId: "claude-sonnet-4-6" };

describe("thinking level contracts (spec 053)", () => {
  it("ThinkingLevelSchema accepts exactly the six levels", () => {
    expect(ThinkingLevelSchema.options).toEqual(LEVELS);
    for (const level of LEVELS) expect(ThinkingLevelSchema.parse(level)).toBe(level);
    for (const bad of ["", "max", "HIGH", "none", 3]) expect(ThinkingLevelSchema.safeParse(bad).success).toBe(false);
  });

  it("ModelRefSchema accepts an optional level and refuses a bad one", () => {
    expect(ModelRefSchema.parse({ ...sonnet, thinkingLevel: "high" }).thinkingLevel).toBe("high");
    expect(ModelRefSchema.parse(sonnet).thinkingLevel).toBeUndefined();
    expect(ModelRefSchema.safeParse({ ...sonnet, thinkingLevel: "max" }).success).toBe(false);
  });

  it("ProjectModelsSchema keeps uniqueness and default-in-approved with levels present", () => {
    const other = { provider: "openrouter", modelId: "x/y", thinkingLevel: "low" };
    expect(ProjectModelsSchema.safeParse({ default: { ...sonnet, thinkingLevel: "high" }, approved: [{ ...sonnet, thinkingLevel: "high" }, other] }).success).toBe(true);
    expect(ProjectModelsSchema.safeParse({ default: sonnet, approved: [{ ...sonnet, thinkingLevel: "low" }, { ...sonnet, thinkingLevel: "high" }] }).success).toBe(false);
    expect(ProjectModelsSchema.safeParse({ default: sonnet, approved: [other] }).success).toBe(false);
  });

  it("ModelSelectionSchema takes an identifier with or without a level and refuses unknown keys", () => {
    expect(ModelSelectionSchema.parse(sonnet)).toEqual(sonnet);
    expect(ModelSelectionSchema.parse({ ...sonnet, thinkingLevel: "xhigh" }).thinkingLevel).toBe("xhigh");
    expect(ModelSelectionSchema.safeParse({ ...sonnet, label: "x" }).success).toBe(false);
    expect(ModelSelectionSchema.safeParse({ ...sonnet, thinkingLevel: "max" }).success).toBe(false);
  });
});
