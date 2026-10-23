import type { ModelSelectionSchema } from "./models.js";
import { ModelIdentifierSchema, ThinkingLevelSchema } from "./models.js";
import { z } from "zod";


export const ModelRefSchema = ModelIdentifierSchema.extend({
  thinkingLevel: ThinkingLevelSchema.optional(),
  label: z.string().trim().min(1).max(64).optional(),
}).strict();


export const ProjectModelsSchema = z.object({
  default: ModelRefSchema,
  approved: z.array(ModelRefSchema).min(1).max(16),
}).strict().superRefine((models, context) => {
  const identifiers = new Set<string>();
  const labels = new Set<string>();
  for (const [index, model] of models.approved.entries()) {
    const identifier = modelKey(model);
    if (identifiers.has(identifier)) {
      context.addIssue({ code: "custom", path: ["approved", index], message: "approved models must have unique provider/modelId pairs" });
    }
    identifiers.add(identifier);
    if (model.label !== undefined) {
      const label = model.label.toLocaleLowerCase("en-US");
      if (labels.has(label)) {
        context.addIssue({ code: "custom", path: ["approved", index, "label"], message: "approved model labels must be unique ignoring case" });
      }
      labels.add(label);
    }
  }
  if (!identifiers.has(modelKey(models.default))) {
    context.addIssue({ code: "custom", path: ["default"], message: "default model must appear in approved" });
  }
});


export const ProjectModelOptionsSchema = z.object({
  projectName: z.string().min(1).max(63),
  approved: z.array(ModelRefSchema).min(1).max(16),
  current: ModelRefSchema,
  source: z.enum(["selection", "default"]),
}).strict();


export const ProjectModelSelectionRequestSchema = ModelIdentifierSchema;


export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export type ModelIdentifier = z.infer<typeof ModelIdentifierSchema>;

export type ModelRef = z.infer<typeof ModelRefSchema>;

export type ProjectModels = z.infer<typeof ProjectModelsSchema>;

export type ProjectModelOptions = z.infer<typeof ProjectModelOptionsSchema>;


export function modelKey(model: ModelIdentifier): string {
  return `${model.provider}\0${model.modelId}`;
}


export type ModelCompany = "anthropic" | "openai" | "google" | "other";


const BEDROCK_REGION_PREFIX = /^(?:us|eu|apac|global)\./;


/**
 * The company that trained a model, whichever route reaches it: an Anthropic id over Bedrock or OpenRouter is
 * still Anthropic's. Anything unrecognised is `other`, so a "different company" check never treats two
 * unknown models as the same company by accident of a shared route.
 */
export function modelCompany(model: ModelIdentifier): ModelCompany {
  const provider = model.provider.toLowerCase();
  const id = model.modelId.toLowerCase();
  if (provider === "anthropic") return "anthropic";
  if (provider === "openai") return "openai";
  if (provider === "amazon-bedrock" && id.replace(BEDROCK_REGION_PREFIX, "").startsWith("anthropic.")) return "anthropic";
  if (provider === "openrouter") {
    if (id.startsWith("anthropic/")) return "anthropic";
    if (id.startsWith("openai/")) return "openai";
    if (id.startsWith("google/")) return "google";
  }
  if (id.startsWith("gpt-")) return "openai";
  if (id.startsWith("gemini")) return "google";
  return "other";
}


/**
 * One name for the same model across routes, so a budget or a price list written once matches
 * `us.anthropic.claude-haiku-4-5-20251001-v1:0` on Bedrock and `anthropic/claude-haiku-4-5` on OpenRouter.
 */
export function canonicalModelName(model: ModelIdentifier): string {
  let id = model.modelId;
  if (model.provider === "amazon-bedrock") id = id.replace(BEDROCK_REGION_PREFIX, "").replace(/^anthropic\./, "");
  if (model.provider === "openrouter") id = id.replace(/^[^/]+\//, "");
  return id.replace(/-v\d+:\d+$/, "").replace(/-\d{8}$/, "").toLowerCase().replaceAll(".", "-");
}

export { ModelIdentifierSchema, ThinkingLevelSchema, ModelSelectionSchema } from "./models.js";
