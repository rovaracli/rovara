// Company AI sources (Plan 3 Task 24a): where an org's models can come from besides Rovara's own, the
// shapes a client may send and the server stores, and the launch gates that keep each kind off until its
// real-key checklist passes. The store, the routes and the ChatGPT settings are Task 24b.
import { z } from "zod";
import { ModelSourceIdSchema } from "./agent.js";
import { type ModelSourceId } from "./agent-node.js";
import { ChatGptModelIdSchema } from "./chatgpt.js";
import { ModelIdentifierSchema } from "./models.js";
import { legacyAliasModelName, type ModelIdentifier } from "./models-node.js";
import type { OrgId } from "./org.js";

export const ModelSourceKindSchema = z.enum(["rovara", "personal-chatgpt", "anthropic", "openai", "openrouter", "bedrock", "endpoint"]);
export type ModelSourceKind = z.infer<typeof ModelSourceKindSchema>;

/** The kinds an org can add as its own source; `rovara` and `personal-chatgpt` are always there. */
export const CUSTOM_SOURCE_KINDS = ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] as const;
export type CustomSourceKind = (typeof CUSTOM_SOURCE_KINDS)[number];

/**
 * The custom kinds an org can use today. Empty on purpose (human decision): the target is
 * ["anthropic", "openai", "openrouter"], each added by a one-line change only after its real-key checklist
 * passes in the combined final round. `bedrock` waits for Task 37 Step 10 and `endpoint` is not at launch.
 */
export const SOURCE_KINDS_AT_LAUNCH: readonly CustomSourceKind[] = [];

/** The wire formats the model proxy serves (docs/learnings/model-sources-spike.md, question 4). */
export const TRANSPORTS_AT_LAUNCH = ["anthropic-messages", "openai-responses", "openai-completions"] as const;
export type Transport = (typeof TRANSPORTS_AT_LAUNCH)[number];

/**
 * The only requests the model proxy's inference listener forwards (docs/learnings/model-sources-spike.md, question 2a): exact
 * paths, POST only, one per transport. A path with a wildcard would reach the pass-through and management routes.
 */
export const INFERENCE_PATHS = [
  { method: "POST", path: "/v1/messages", transport: "anthropic-messages" },
  { method: "POST", path: "/v1/responses", transport: "openai-responses" },
  { method: "POST", path: "/chat/completions", transport: "openai-completions" },
] as const satisfies ReadonlyArray<{ method: "POST"; path: string; transport: Transport }>;

export const MAX_MODELS_PER_SOURCE = 20;
export const MAX_CUSTOM_SOURCES_PER_ORG = 10;

export interface SourceLaunch {
  kinds?: readonly CustomSourceKind[];
  transports?: readonly string[];
}

/**
 * The refusal for a company source that is not available yet, or undefined when it is. A kind outside the
 * launch list is refused, and so is an endpoint whose `api` is missing or outside the transports. Rovara's own
 * models and a member's ChatGPT plan are not company sources, so they are never refused here. `launch` lets a
 * test (or a build that turns a kind on early) supply its own lists.
 */
export function sourceKindProblem(kind: ModelSourceKind, api?: string, launch: SourceLaunch = {}): string | undefined {
  if (kind === "rovara" || kind === "personal-chatgpt") return undefined;
  const refusal = `${kind} sources aren't available yet`;
  if (!(launch.kinds ?? SOURCE_KINDS_AT_LAUNCH).includes(kind)) return refusal;
  if (kind === "endpoint" && (api === undefined || !(launch.transports ?? TRANSPORTS_AT_LAUNCH).includes(api))) return refusal;
  return undefined;
}

/** The refusal for adding sources to an org that already has `existing` custom ones, when the total would pass the limit. */
export function customSourceLimitProblem(existing: number, adding = 1): string | undefined {
  return existing + adding > MAX_CUSTOM_SOURCES_PER_ORG ? `an organization can have at most ${MAX_CUSTOM_SOURCES_PER_ORG} AI sources` : undefined;
}

/** An IAM role in the org's own AWS account, with no wildcard: the proxy assumes it for Bedrock. */
export const BEDROCK_ROLE_ARN_PATTERN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const SOURCE_ID_PATTERN = /^src_[0-9a-z]{20}$/;
const EXTERNAL_ID_PATTERN = /^rovara-org_[0-9a-z]{20}$/;

/** The STS external id the org's trust policy must require: server-set, never sent by a client. */
export function bedrockExternalId(orgId: OrgId): string {
  return `rovara-${orgId}`;
}

/** The Pi catalog provider that serves a kind's models. */
const CATALOG_PROVIDER = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  bedrock: "amazon-bedrock",
} as const;

export interface ModelSourceOptions {
  /**
   * Whether Pi's catalog knows a model. Pi's catalogs live in model-runtime, which contracts cannot import, so
   * the broker supplies this (`catalogModel(model) !== undefined`). Without it only the shape is checked.
   */
  isKnownCatalog?: (model: ModelIdentifier) => boolean;
}

/** A name shown on a page and in a terminal: counted in code points, with no control or invisible formatting characters (a label cannot hide or rewrite text around it). */
function displayName(maxCodePoints: number) {
  return z.string().trim().min(1)
    .refine((value) => [...value].length <= maxCodePoints, { message: `must be at most ${String(maxCodePoints)} characters` })
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), { message: "must not hold control or invisible characters" });
}

const LabelSchema = displayName(64);

function catalogSchema(provider: string | undefined, options: ModelSourceOptions) {
  return ModelIdentifierSchema
    .refine((model) => provider === undefined || model.provider === provider, { message: provider === undefined ? "" : `must be a ${provider} catalog model` })
    .refine((model) => options.isKnownCatalog?.(model) ?? true, { message: "must be a model in the catalog" });
}

/** `identities` are the models an entry claims; each position is unique across entries by `legacyAliasModelName` (stored sources must keep reading). */
function modelsSchema<T extends z.ZodType>(model: T, identities: (entry: z.infer<T>) => ModelIdentifier[]) {
  return z.array(model).min(1).max(MAX_MODELS_PER_SOURCE).superRefine((models, context) => {
    const seen: Array<Set<string>> = [];
    for (const [index, entry] of models.entries()) {
      for (const [position, identity] of identities(entry).entries()) {
        const names = (seen[position] ??= new Set<string>());
        const name = legacyAliasModelName(identity);
        if (names.has(name)) context.addIssue({ code: "custom", path: [index], message: "models must be unique" });
        names.add(name);
      }
    }
  });
}

function keyedModels(kind: keyof typeof CATALOG_PROVIDER, options: ModelSourceOptions) {
  return modelsSchema(z.object({ catalog: catalogSchema(CATALOG_PROVIDER[kind], options) }).strict(), (entry) => [entry.catalog]);
}

function inputShapes(options: ModelSourceOptions) {
  const keyed = (kind: "anthropic" | "openai" | "openrouter") => z.object({ kind: z.literal(kind), label: LabelSchema, models: keyedModels(kind, options) }).strict();
  const bedrock = z.object({
    kind: z.literal("bedrock"),
    label: LabelSchema,
    roleArn: z.string().regex(BEDROCK_ROLE_ARN_PATTERN),
    region: z.string().regex(REGION_PATTERN),
    models: keyedModels("bedrock", options),
  }).strict();
  const endpoint = z.object({
    kind: z.literal("endpoint"),
    label: LabelSchema,
    baseUrl: z.url({ protocol: /^https?$/ }).max(2048),
    // The wire format; sourceKindProblem decides which are available, so an unavailable one refuses with its text.
    api: z.string().trim().min(1).max(64),
    // `name` is what the endpoint calls the model; `catalog` is the Pi model it behaves like, for prices and limits.
    models: modelsSchema(
      z.object({ name: displayName(256), catalog: catalogSchema(undefined, options) }).strict(),
      // Unique by the name the endpoint serves and by the catalog model it stands for, since routing matches on either.
      (entry) => [{ provider: "endpoint", modelId: entry.name }, entry.catalog],
    ),
  }).strict();
  return [keyed("anthropic"), keyed("openai"), keyed("openrouter"), bedrock, endpoint] as const;
}

/**
 * What a client may send to add or change a source. Strict, so a client-sent `sourceId`, `externalId` or
 * `tested` is refused rather than ignored.
 */
export function modelSourceInputSchema(options: ModelSourceOptions = {}) {
  return z.discriminatedUnion("kind", inputShapes(options));
}

/** What the server stores: the input plus its generated `sourceId` and, for Bedrock, the server-set `externalId` and `tested`. */
export function modelSourceSchema(options: ModelSourceOptions = {}) {
  const [anthropic, openai, openrouter, bedrock, endpoint] = inputShapes(options);
  const sourceId = z.string().regex(SOURCE_ID_PATTERN);
  return z.discriminatedUnion("kind", [
    anthropic.extend({ sourceId }).strict(),
    openai.extend({ sourceId }).strict(),
    openrouter.extend({ sourceId }).strict(),
    bedrock.extend({ sourceId, externalId: z.string().regex(EXTERNAL_ID_PATTERN), tested: z.boolean().default(false) }).strict(),
    endpoint.extend({ sourceId }).strict(),
  ]);
}

/** The shape-only schemas; a caller with Pi's catalog uses `modelSourceInputSchema({ isKnownCatalog })`. */
export const ModelSourceInputSchema = modelSourceInputSchema();
export const ModelSourceSchema = modelSourceSchema();
/** The refusal when a stored source is not this org's: a Bedrock source's external id must be `rovara-<orgId>`. */
export function modelSourceOrgProblem(orgId: OrgId, source: ModelSource): string | undefined {
  if (source.kind === "bedrock" && source.externalId !== bedrockExternalId(orgId)) return "the external id does not belong to this organization";
  return undefined;
}

export type ModelSourceInput = z.infer<typeof ModelSourceInputSchema>;
export type ModelSource = z.infer<typeof ModelSourceSchema>;

export const OrgModelSourcesSchema = z.object({
  sources: z.array(ModelSourceSchema).max(MAX_CUSTOM_SOURCES_PER_ORG),
  /** Which source serves a task first; the rest are fallbacks in order. */
  order: z.array(ModelSourceIdSchema).superRefine((order, context) => {
    if (new Set(order).size !== order.length) context.addIssue({ code: "custom", message: "order must not repeat a source" });
  }),
  assistantModel: ModelIdentifierSchema.optional(),
  chatgptPreferredModel: ChatGptModelIdSchema.optional(),
}).strict().superRefine((record, context) => {
  const known = new Set<string>(record.sources.map((source) => source.sourceId));
  for (const [index, id] of record.order.entries()) {
    if (id !== "rovara" && id !== "personal-chatgpt" && !known.has(id)) context.addIssue({ code: "custom", path: ["order", index], message: "order names a source the organization does not have" });
  }
});
export type OrgModelSources = z.infer<typeof OrgModelSourcesSchema>;

/** A new org's source order: ChatGPT first when the install-wide switch is on, so today's ChatGPT tasks do not change. */
export function defaultModelSourceOrder(chatgptSwitchOn: boolean): ModelSourceId[] {
  return chatgptSwitchOn ? ["personal-chatgpt", "rovara"] : ["rovara"];
}

/** The name the proxy serves a source's model under: unique across orgs and sources, and the same for the same model on any route. */
export function sourceAlias(orgId: OrgId, sourceId: string, model: ModelIdentifier): string {
  return `${orgId}.${sourceId}.${legacyAliasModelName(model)}`;
}

// ---- the texts the admin routes show (Task 24b)

/** What every company AI source route answers on an install with no model proxy (private installs today). */
export const MODEL_SOURCES_NEED_PROXY = "company AI sources need Rovara's model proxy, which this install doesn't run";
/** Shown beside every Bedrock source until Task 37's live test has passed. */
export const BEDROCK_NOT_TESTED_NOTE = "NOT TESTED: Bedrock in your own AWS account hasn't been tested yet.";
/** An endpoint's host was approved, but the DNS firewall does not serve it yet. */
export const MODEL_SOURCE_STILL_APPLYING = "Rovara is still applying this address; try again in 5 minutes.";

/**
 * The trust policy an admin pastes into the role a Bedrock source names: the proxy's own roles may assume it, and only with the org's external
 * id. `principals` are Rovara's role ARNs (the model proxy's task role and the function that probes the policy).
 */
export function bedrockTrustPolicy(orgId: OrgId, principals: readonly string[]): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: [...principals] },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "sts:ExternalId": bedrockExternalId(orgId) } },
    }],
  };
}
