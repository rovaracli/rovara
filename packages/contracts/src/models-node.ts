import { z } from "zod";
import { E2E_MODEL_FAILURE_CLASSES, type E2EModelFailureClass } from "./e2e-model-failure-classes.js";
import type { ModelSelectionSchema } from "./models.js";
import { ModelIdentifierSchema, ThinkingLevelSchema } from "./models.js";
import { isKeyedModelProvider, KEYED_MODEL_PROVIDERS } from "./model-providers.js";

/**
 * The last single-call check of a project model (Task 4.10D, MODEL1), written by the CLI when a project revision is registered. `ok`: it answered. `failed`: the check found something about
 * the model itself (not found, not in the catalog, the key refused, a Bedrock quota of 0), named by `class`. `unchecked`: the check could not tell (a throttle, an outage, unreachable, the
 * caller's own access); `class` says why, and the first use checks it again. `acceptedReason` is the administrator's reason for registering a failed model anyway
 * (`--accept-unchecked-model`); who accepted it is the registration's own record. Never a message, a signal or provider text. Absent on a model nobody has checked.
 */
export const ModelCheckRecordSchema = z.object({
  status: z.enum(["ok", "failed", "unchecked"]),
  class: z.enum(E2E_MODEL_FAILURE_CLASSES).optional(),
  checkedAt: z.string().datetime(),
  acceptedReason: z.string().trim().min(1).max(200).optional(),
}).strict().superRefine((record, context) => {
  if (record.status === "failed" && record.class === undefined) context.addIssue({ code: "custom", path: ["class"], message: "a failed check names its class" });
  if (record.status === "ok" && record.class !== undefined) context.addIssue({ code: "custom", path: ["class"], message: "a passed check has no class" });
  if (record.status === "ok" && record.acceptedReason !== undefined) context.addIssue({ code: "custom", path: ["acceptedReason"], message: "a passed check needs no acceptance" });
});

export type ModelCheckRecord = z.infer<typeof ModelCheckRecordSchema>;

export const ModelRefSchema = ModelIdentifierSchema.extend({
  thinkingLevel: ThinkingLevelSchema.optional(),
  label: z.string().trim().min(1).max(64).optional(),
  lastCheck: ModelCheckRecordSchema.optional(),
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

/**
 * The geographies Amazon Bedrock's cross-region inference profiles put in front of a model id (`jp.anthropic.claude-opus-5`). One closed list, checked against the pinned catalog by a contract test:
 * a prefix missing here would let a forbidden model, a "different model" rule or a price miss the same model on another geography.
 */
export const BEDROCK_REGION_PREFIXES = ["us-gov", "us", "eu", "apac", "global", "au", "jp", "in", "ca"] as const;

/** The model makers whose ids Bedrock lists without a geography (`anthropic.claude-opus-5`, `deepseek.v3.2`), as the pinned catalog names them. */
export const BEDROCK_VENDOR_PREFIXES = [
  "ai21", "amazon", "anthropic", "cohere", "deepseek", "google", "luma", "meta", "minimax", "mistral", "moonshot", "moonshotai", "nvidia", "openai", "qwen", "stability", "twelvelabs", "writer", "xai", "zai",
] as const;

const BEDROCK_REGION_PREFIX = new RegExp(`^(?:${BEDROCK_REGION_PREFIXES.join("|")})\\.`);
const bedrockWithoutRegion = (modelId: string): string => modelId.toLowerCase().replace(BEDROCK_REGION_PREFIX, "");
const isBedrock = (model: ModelIdentifier): boolean => model.provider.toLowerCase() === "amazon-bedrock";

/**
 * Whether `model` is a Bedrock id shaped `<segment>.<known vendor>.*` whose first segment is neither a listed geography nor a vendor: a geography Rovara has not learned. Its model cannot be read,
 * so callers fail closed: refuse it whenever any model is forbidden, and never take it as a different model from another.
 */
export function isUnrecognisedBedrockModel(model: ModelIdentifier): boolean {
  if (!isBedrock(model)) return false;
  const [first, second, ...rest] = model.modelId.toLowerCase().split(".");
  if (first === undefined || second === undefined || rest.length === 0) return false;
  return !(BEDROCK_REGION_PREFIXES as readonly string[]).includes(first) && !(BEDROCK_VENDOR_PREFIXES as readonly string[]).includes(first) && (BEDROCK_VENDOR_PREFIXES as readonly string[]).includes(second);
}

/** Whether a model is forbidden: it has a forbidden entry's canonical name, or it is an unrecognised Bedrock id and anything at all is forbidden. Build once per list. */
export function forbiddenModelMatcher(forbidden: readonly ModelIdentifier[]): (model: ModelIdentifier) => boolean {
  const names = new Set(forbidden.map(canonicalModelName));
  return (model) => forbidden.length > 0 && (names.has(canonicalModelName(model)) || isUnrecognisedBedrockModel(model));
}

/** Whether two models read as the same one for an independence rule: equal canonical names, or either is an unrecognised Bedrock id, which can never be shown to differ. */
export function sameModelOrUnrecognised(left: ModelIdentifier, right: ModelIdentifier): boolean {
  return canonicalModelName(left) === canonicalModelName(right) || isUnrecognisedBedrockModel(left) || isUnrecognisedBedrockModel(right);
}

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
  if (provider === "amazon-bedrock" && bedrockWithoutRegion(id).startsWith("anthropic.")) return "anthropic";
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
  if (isBedrock(model)) id = bedrockWithoutRegion(id).replace(/^anthropic\./, "");
  if (model.provider === "openrouter") id = id.replace(/^[^/]+\//, "");
  return id.replace(/-v\d+:\d+$/, "").replace(/-\d{8}$/, "").toLowerCase().replaceAll(".", "-");
}

/** The provider's name as people read it: a keyed provider's label, Amazon Bedrock otherwise. */
const providerLabel = (provider: string): string => (isKeyedModelProvider(provider) ? KEYED_MODEL_PROVIDERS[provider].label : provider === "amazon-bedrock" ? "Amazon Bedrock" : provider);

/** One fixed sentence per failure class, naming the provider and the model, for a check that is stored or listed. It never quotes the provider. */
export function modelCheckClassSentence(input: { provider: string; modelId: string; class: E2EModelFailureClass }): string {
  const label = providerLabel(input.provider);
  const { modelId } = input;
  switch (input.class) {
    case "limit-or-rate-limited": return `${label}'s limit for ${modelId} is reached or set to 0; raise the limit (for Amazon Bedrock, in Service Quotas), or choose another model.`;
    case "key-rejected": return `${label} refused the key for ${modelId}; check the key, and that it may use this model.`;
    case "model-not-found": return `${label} does not have ${modelId} for this account; check the model id, or choose another model.`;
    case "unreachable": return `${label} could not be reached for ${modelId}; check the network, then check again.`;
    case "request-rejected": return `${label} refused the check request for ${modelId}; check the model id and its settings.`;
    case "provider-outage": return `${label} did not answer the check of ${modelId} in time or reported a problem; try again later.`;
    case "secret-unreadable": return `${label}'s key for ${modelId} could not be read; check that the key's secret exists and Rovara can read it, then check again.`;
    case "not-in-catalog": return `Rovara does not know how to call ${modelId} on ${label}; choose a model from Rovara's model catalog.`;
    case "unknown": return `The check of ${modelId} on ${label} failed for a reason Rovara could not tell; check the model, then check again.`;
  }
}

export { ModelIdentifierSchema, ThinkingLevelSchema, ModelSelectionSchema } from "./models.js";
