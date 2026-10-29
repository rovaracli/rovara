// G3 v1: the How we work UI reads server decisions; it never selects or classifies models.
import { z } from "zod";
import { ModelIdentifierSchema, ThinkingLevelSchema } from "./models.js";
import { forwardReader } from "./forward-reader.js";

export const STAGE_IDS = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"] as const;
export const StageIdSchema = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageIdSchema>;
export const STAGE_MODEL_REFUSAL_CODES = ["MODEL_NOT_VERIFIED", "MODEL_STALE", "MODEL_FORBIDDEN", "MODEL_NOT_ALLOWED_IN_PROJECT", "STAGE_LOCKED", "DIFFERENT_FROM_UNSATISFIABLE", "LOCK_UNSATISFIABLE", "NO_VERIFIED_CANDIDATE", "POLICY_STALE", "DRAFT_STALE", "NEEDS_CONFIRMATION"] as const;
export const StageModelRefusalCodeSchema = z.enum(STAGE_MODEL_REFUSAL_CODES);
export type StageModelRefusalCode = z.infer<typeof StageModelRefusalCodeSchema>;
export const ModelFallbackReasonCodeSchema = z.enum([...STAGE_MODEL_REFUSAL_CODES, "DEFAULT_MODEL_UNAVAILABLE", "CHATGPT_PLAN_UNAVAILABLE", "MODEL_CALL_REFUSED", "CONFIGURED_FALLBACK"]);
const Revision = z.number().int().min(0);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Instant = z.string().datetime();
const Line = z.string().min(1).max(400).refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "must be plain text");
const SourceId = z.union([z.literal("rovara"), z.literal("personal-chatgpt"), z.string().regex(/^src_[a-z0-9]{20}$/u)]);
/** Only existing same-origin app paths, with no bearer query, fragment or encoded redirect. */
export const StageModelFixHrefSchema = z.string().max(512).regex(/^\/app\/[a-zA-Z0-9_/-]+$/u);
export const StageModelRefusalSchema = z.object({ code: StageModelRefusalCodeSchema, fixHref: StageModelFixHrefSchema.optional() }).strict();
export type StageModelRefusal = z.infer<typeof StageModelRefusalSchema>;
export const StageDifferentFromSchema = z.object({ stage: StageIdSchema, level: z.enum(["model", "vendor"]) }).strict();
export const StageModelChoiceSchema = z.object({
  model: ModelIdentifierSchema.optional(), thinkingLevel: ThinkingLevelSchema.nullable().optional(),
  fallbackModel: ModelIdentifierSchema.optional(), differentFrom: StageDifferentFromSchema.optional(),
}).strict();
export type StageModelChoice = z.infer<typeof StageModelChoiceSchema>;
export const CompanyStageModelOverrideSchema = StageModelChoiceSchema.extend({ locked: z.boolean().default(false) }).strict();
const CheckingStages = new Set<string>(["plan_check", "code_review", "security_review"]);
/** Validate structural references here; actual callability, independence and permission are server decisions. */
export const StageModelOverridesSchema = z.partialRecord(StageIdSchema, CompanyStageModelOverrideSchema).superRefine((rows, context) => {
  for (const [stage, row] of Object.entries(rows)) {
    if (row === undefined) continue;
    if (row.locked && (row.model === undefined || row.thinkingLevel === undefined)) context.addIssue({ code: "custom", path: [stage], message: "a lock requires model and thinkingLevel (null means model default)" });
    const reference = stage === "plan_check" ? "plan" : "build";
    if (row.differentFrom !== undefined && (!CheckingStages.has(stage) || row.differentFrom.stage !== reference)) context.addIssue({ code: "custom", path: [stage, "differentFrom"], message: "invalid stage reference" });
  }
});
export const StageModelCandidateSchema = z.object({
  model: ModelIdentifierSchema, label: Line.max(64), provider: z.string().min(1).max(128),
  company: z.enum(["anthropic", "openai", "google", "other"]),
  status: z.enum(["verified", "unverified", "stale", "denied"]), checkedAt: Instant.optional(),
  blockedReason: StageModelRefusalCodeSchema.optional(),
}).strict();
export const EffectiveStageModelSchema = z.object({
  model: ModelIdentifierSchema, sourceId: SourceId, thinkingLevel: ThinkingLevelSchema.nullable(),
  decidedBy: z.enum(["rovara", "company", "project"]), locked: z.boolean(),
  reason: z.enum(["COMPANY_LOCK", "PROJECT_CHOICE", "COMPANY_DEFAULT", "BUILTIN_DEFAULT", "PROJECT_SELECTION", "PROJECT_DEFAULT", "APPROVED_SAME_MODEL"]),
}).strict();
const StageRowBase = z.object({
  stage: StageIdSchema, projectChoice: StageModelChoiceSchema.nullable(), companyDefault: StageModelChoiceSchema.nullable(),
  locked: z.boolean(), editable: z.boolean(), candidates: z.array(StageModelCandidateSchema).max(23),
  candidatesState: z.enum(["complete", "unavailable"]), candidatesReason: StageModelRefusalCodeSchema.optional(),
  notice: StageModelRefusalSchema.optional(),
});
export const StageModelRowSchema = z.union([
  StageRowBase.extend({ effective: EffectiveStageModelSchema }).strict(),
  StageRowBase.extend({ refusal: StageModelRefusalSchema }).strict(),
  StageRowBase.extend({ notApplicable: z.literal(true) }).strict(),
]);
export type StageModelRow = z.infer<typeof StageModelRowSchema>;
export const StageModelsResponseSchema = z.object({
  version: z.literal(1), checkedAt: Instant, companyRevision: Revision, projectRevision: Revision,
  process: z.object({ agentId: z.string().min(1).max(128), version: z.number().int().min(1).optional(), draftRevision: Revision.optional(), digest: Digest }).strict(),
  rankingVersion: z.literal("g3-v1"), stages: z.array(StageModelRowSchema).max(7),
}).strict().superRefine((value, context) => {
  if (new Set(value.stages.map((stage) => stage.stage)).size !== value.stages.length) context.addIssue({ code: "custom", path: ["stages"], message: "stages must be unique" });
});
export type StageModelsResponse = z.infer<typeof StageModelsResponseSchema>;
export const StageModelsResponseReaderSchema = forwardReader(StageModelsResponseSchema);
export const StageModelsQuerySchema = z.object({ draft: Revision.optional() }).strict();
export const ModelSelectionPolicyResponseSchema = z.object({ version: z.literal(1), revision: Revision, rankingVersion: z.literal("g3-v1"), stepOverrides: StageModelOverridesSchema }).strict();
export const ModelSelectionPolicyPutSchema = z.object({ version: z.literal(1), requestId: z.uuid(), expectedRevision: Revision, stepOverrides: StageModelOverridesSchema }).strict();
export type ModelSelectionPolicyResponse = z.infer<typeof ModelSelectionPolicyResponseSchema>;
export type ModelSelectionPolicyPut = z.infer<typeof ModelSelectionPolicyPutSchema>;
export const ModelSelectionPolicyResponseReaderSchema = forwardReader(ModelSelectionPolicyResponseSchema);
export const ModelPolicyPreviewRequestSchema = z.object({ version: z.literal(1), expectedRevision: Revision, stepOverrides: StageModelOverridesSchema, cursor: z.string().min(1).max(4096).optional() }).strict();
export const ModelPolicyPreviewResponseSchema = z.object({
  version: z.literal(1), checkedAt: Instant, policyRevision: Revision, mayBeIncomplete: z.literal(true),
  projects: z.array(z.object({ project: z.string().min(1).max(63), impact: z.enum(["unchanged", "changed", "blocked", "unavailable"]), reasonCodes: z.array(StageModelRefusalCodeSchema).max(11) }).strict()).max(5),
  nextCursor: z.string().min(1).max(4096).optional(),
}).strict();
export type ModelPolicyPreviewRequest = z.infer<typeof ModelPolicyPreviewRequestSchema>;
export type ModelPolicyPreviewResponse = z.infer<typeof ModelPolicyPreviewResponseSchema>;
export const ModelPolicyPreviewResponseReaderSchema = forwardReader(ModelPolicyPreviewResponseSchema);
export const ModelFallbackSchema = z.object({ stage: StageIdSchema, used: Line, wanted: Line.nullable(), reasonCode: ModelFallbackReasonCodeSchema }).strict();
export type ModelFallback = z.infer<typeof ModelFallbackSchema>;
export const ModelFallbacksSchema = z.array(ModelFallbackSchema).max(64);
