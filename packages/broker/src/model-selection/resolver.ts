// G3: one choice function. Callers supply server-read policy and source evidence, never browser attestations.
import { StageModelChoiceSchema, canonicalModelName, modelCompany, type ModelSelection, type ModelIdentifier, type StageId, type StageModelChoice, type StageModelRefusalCode, type ModelFallback, type ThinkingLevel } from "@agentx/contracts";
import { reviewerModelFor } from "../rovara-code/reviewer-model.js";

export { STAGE_OPERATION_MAPPING, STAGE_EDIT_GROUPS, STAGE_EDIT_RULES } from "@agentx/contracts";
export interface SourceModelEvidence {
  orgId: string;
  sourcesRevision: number;
  kind: "rovara_catalog" | "tested_bedrock_role" | "stored_key" | "qualified_endpoint" | "chatgpt_connection";
  payerDeveloperId?: string;
  connectionRevision?: string;
}
export interface VerifiedStageCandidate {
  model: ModelIdentifier;
  sourceId: string;
  enabled: boolean;
  inEffectiveOrder: boolean;
  evidence?: SourceModelEvidence | undefined;
}
export interface StageModelInput {
  orgId: string;
  stage: StageId;
  sourcesRevision: number;
  payerDeveloperId?: string | undefined;
  connectionRevision?: string | undefined;
  candidates: readonly VerifiedStageCandidate[];
  forbidden: readonly ModelIdentifier[];
  approved?: readonly ModelIdentifier[] | undefined;
  companyLock?: StageModelChoice | undefined;
  projectChoice?: StageModelChoice | undefined;
  companyDefault?: StageModelChoice | undefined;
  /** Provenance of a model inherited below partial company metadata. Server-only. */
  companyDefaultOrigin?: "recipe" | undefined;
  projectSelection?: ModelSelection | undefined;
  projectDefault?: ModelSelection | undefined;
  builtinDefault?: ModelIdentifier | undefined;
  defaultFallbacks?: readonly ModelIdentifier[] | undefined;
  /** Verified server-selected default preference (for example the payer's personal plan). */
  defaultPreferred?: ModelIdentifier | undefined;
  referenceModel?: ModelIdentifier | undefined;
  /** Default-only historical reviewer/critic fallback, never set for an explicit stage choice. */
  allowLegacyDefaultFallback?: boolean | undefined;
  defaultLastAttempt?: boolean | undefined;
  requireDifferentVendor?: boolean | undefined;
  deniedModels?: readonly ModelIdentifier[] | undefined;
  /** Only an approval validated against the task's frozen recipe and pinned policy may populate this input. */
  sameModelApproval?: { model: ModelIdentifier; referenceModel: ModelIdentifier } | undefined;
}
export type StageDecisionReason = "COMPANY_LOCK" | "PROJECT_CHOICE" | "COMPANY_DEFAULT" | "PROJECT_SELECTION" | "PROJECT_DEFAULT" | "BUILTIN_DEFAULT" | "PERSONAL_PLAN_DEFAULT" | "RECIPE_DEFAULT" | "APPROVED_SAME_MODEL";
export type StageModelResult = { kind: "refusal"; code: StageModelRefusalCode } | {
  kind: "resolved"; model: ModelIdentifier; sourceId: string; thinkingLevel: ThinkingLevel | null;
  reason: StageDecisionReason; locked: boolean; fallback?: ModelFallback;
};
const same = (a: ModelIdentifier, b: ModelIdentifier): boolean => canonicalModelName(a) === canonicalModelName(b);
const label = (model: ModelIdentifier): string => `${model.provider}/${model.modelId}`;
const checking = (stage: StageId): boolean => stage === "plan_check" || stage === "code_review" || stage === "security_review";

/** Evidence proves source-level access per the owner's v1.1 rule, not a per-model successful test or future provider availability. */
export function stageCandidateVerified(input: StageModelInput, candidate: VerifiedStageCandidate): boolean {
  const evidence = candidate.evidence;
  if (!candidate.enabled || !candidate.inEffectiveOrder || evidence === undefined || evidence.orgId !== input.orgId || evidence.sourcesRevision !== input.sourcesRevision) return false;
  if ((input.deniedModels ?? []).some((model) => same(model, candidate.model))) return false;
  if (candidate.sourceId === "personal-chatgpt") return evidence.kind === "chatgpt_connection" && input.payerDeveloperId !== undefined && evidence.payerDeveloperId === input.payerDeveloperId && input.connectionRevision !== undefined && evidence.connectionRevision === input.connectionRevision;
  if (candidate.sourceId === "rovara") return evidence.kind === "rovara_catalog";
  return /^src_[a-z0-9]{20}$/u.test(candidate.sourceId) && (evidence.kind === "tested_bedrock_role" || evidence.kind === "stored_key" || evidence.kind === "qualified_endpoint");
}

const projectDefaultChoice=(model:ModelSelection)=>StageModelChoiceSchema.safeParse({model:{provider:model.provider,modelId:model.modelId},...(model.thinkingLevel===undefined?{}:{thinkingLevel:model.thinkingLevel})});

export function resolveStageModel(input: StageModelInput): StageModelResult {
  const locked = input.companyLock !== undefined;
  const candidates = input.candidates.filter((candidate) => stageCandidateVerified(input, candidate));
  const permitted = (model: ModelIdentifier): StageModelRefusalCode | undefined => {
    if (input.forbidden.some((forbidden) => same(model, forbidden))) return "MODEL_FORBIDDEN";
    if (input.approved !== undefined && !input.approved.some((allowed) => same(model, allowed))) return "MODEL_NOT_ALLOWED_IN_PROJECT";
    return undefined;
  };
  const eligible = candidates.filter((candidate) => permitted(candidate.model) === undefined);
  const independent = (model: ModelIdentifier): boolean => {
    if (!checking(input.stage)) return true;
    const reference = input.referenceModel;
    if (reference === undefined) return false;
    if (input.requireDifferentVendor === true || choice?.differentFrom?.level === "vendor") {
      const own = modelCompany(model), prior = modelCompany(reference);
      return own !== "other" && prior !== "other" && own !== prior;
    }
    if (!same(model, reference)) return true;
    const approval = input.sameModelApproval;
    return approval !== undefined && same(approval.model, model) && same(approval.referenceModel, reference);
  };
  const refusal = (code: StageModelRefusalCode): StageModelResult => ({ kind: "refusal", code: locked ? "LOCK_UNSATISFIABLE" : code });
  const finish = (candidate: VerifiedStageCandidate, choice: StageModelChoice, reason: StageDecisionReason, wanted?: ModelIdentifier, fallbackCode?: ModelFallback["reasonCode"]): Extract<StageModelResult, { kind: "resolved" }> => ({
    kind: "resolved", model: candidate.model, sourceId: candidate.sourceId, thinkingLevel: choice.thinkingLevel ?? null, locked,
    reason: fallbackCode !== "DEFAULT_MODEL_UNAVAILABLE" && checking(input.stage) && input.referenceModel !== undefined && input.sameModelApproval !== undefined && same(candidate.model, input.referenceModel) && same(input.sameModelApproval.model, candidate.model) && same(input.sameModelApproval.referenceModel, input.referenceModel) ? "APPROVED_SAME_MODEL" : reason,
    ...(fallbackCode === undefined ? {} : { fallback: { stage: input.stage, used: label(candidate.model), wanted: wanted === undefined ? null : label(wanted), reasonCode: fallbackCode } }),
  });
  let choice: StageModelChoice | undefined;
  let reason: StageDecisionReason = "BUILTIN_DEFAULT";
  let explicit = false;
  if (input.companyLock !== undefined) { choice = input.companyLock; reason = "COMPANY_LOCK"; explicit = true; }
  else if (input.projectChoice?.model !== undefined) { choice = input.projectChoice; reason = "PROJECT_CHOICE"; explicit = true; }
  else if (input.companyDefault?.model !== undefined) { choice = input.companyDefault; reason = input.companyDefaultOrigin === "recipe" ? "RECIPE_DEFAULT" : "COMPANY_DEFAULT"; explicit = true; }
  else if (!checking(input.stage) && input.projectSelection !== undefined) { const parsed=projectDefaultChoice(input.projectSelection);if(!parsed.success)return refusal("MODEL_NOT_VERIFIED");choice=parsed.data; reason = "PROJECT_SELECTION"; }
  else if (!checking(input.stage) && input.defaultPreferred !== undefined) { choice = { model: input.defaultPreferred }; reason = "PERSONAL_PLAN_DEFAULT"; }
  else if (!checking(input.stage) && input.projectDefault !== undefined) { const parsed=projectDefaultChoice(input.projectDefault);if(!parsed.success)return refusal("MODEL_NOT_VERIFIED");choice=parsed.data; reason = "PROJECT_DEFAULT"; }
  else if (!checking(input.stage) && input.builtinDefault !== undefined) choice = { model: input.builtinDefault };

  // Model precedence and field inheritance are separate: metadata-only settings still apply.
  // Undefined inherits; null explicitly resets effort to the model default. A lock freezes the tuple.
  if (!locked) {
    const inherited: StageModelChoice = { ...choice };
    for (const layer of [input.companyDefault, input.projectChoice]) {
      if (layer === undefined) continue;
      if (layer.thinkingLevel !== undefined) inherited.thinkingLevel = layer.thinkingLevel;
      if (layer.fallbackModel !== undefined) inherited.fallbackModel = layer.fallbackModel;
      if (layer.differentFrom !== undefined) inherited.differentFrom = layer.differentFrom;
    }
    choice = inherited;
  }
  if (checking(input.stage) && input.referenceModel === undefined) return refusal("MODEL_NOT_VERIFIED");
  const wanted = choice?.model;
  if (wanted !== undefined) {
    const problem = permitted(wanted);
    const found = eligible.find((candidate) => candidate.model.provider === wanted.provider && candidate.model.modelId === wanted.modelId);
    if (problem === undefined && found !== undefined && independent(found.model)) return finish(found, choice ?? {}, reason);
    const fallback = choice?.fallbackModel;
    if (fallback !== undefined) {
      const next = eligible.find((candidate) => candidate.model.provider === fallback.provider && candidate.model.modelId === fallback.modelId && independent(candidate.model));
      if (next !== undefined) return finish(next, choice ?? {}, reason, wanted, "CONFIGURED_FALLBACK");
    }
    if (explicit) return refusal(problem ?? (found !== undefined ? "DIFFERENT_FROM_UNSATISFIABLE" : "MODEL_NOT_VERIFIED"));
  }
  if (checking(input.stage)) {
    if (!explicit && input.allowLegacyDefaultFallback === true && input.defaultLastAttempt === true && input.requireDifferentVendor !== true && choice?.differentFrom?.level !== "vendor") {
      const last = reviewerModelFor({ step: undefined, builderModel: input.referenceModel, unusable: input.deniedModels, lastAttempt: true, project: { approved: eligible.map(entry => entry.model) }, guardrails: { forbiddenModels: [...input.forbidden] }, sources: eligible.map(entry => entry.model) });
      if (last?.chosenBy === "rovara" && input.referenceModel !== undefined && same(last.model, input.referenceModel)) {
        const candidate = eligible.find(entry => entry.model.provider === last.model.provider && entry.model.modelId === last.model.modelId);
        if (candidate !== undefined) return finish(candidate, choice ?? {}, reason, input.referenceModel, "DEFAULT_MODEL_UNAVAILABLE");
      }
    }
    // Reuse the existing interim rule, but pass only verified eligible candidates. Its implicit same-model result cannot waive approval.
    const pool = eligible.filter((candidate) => independent(candidate.model));
    const chosen = reviewerModelFor({ step: undefined, builderModel: input.referenceModel, unusable: input.deniedModels, project: { approved: pool.map((candidate) => candidate.model) }, guardrails: { forbiddenModels: [...input.forbidden] }, sources: pool.map((candidate) => candidate.model) });
    if (chosen?.chosenBy === "rovara") {
      const candidate = pool.find((entry) => entry.model.provider === chosen.model.provider && entry.model.modelId === chosen.model.modelId);
      if (candidate !== undefined) return finish(candidate, choice ?? {}, reason);
    }
    if (!explicit && input.allowLegacyDefaultFallback === true && input.requireDifferentVendor !== true && choice?.differentFrom?.level !== "vendor") {
      const legacy = reviewerModelFor({ step: undefined, builderModel: input.referenceModel, unusable: input.deniedModels, project: { approved: eligible.map((entry) => entry.model) }, guardrails: { forbiddenModels: [...input.forbidden] }, sources: eligible.map((entry) => entry.model) });
      if (legacy?.chosenBy === "rovara") {
        const candidate = eligible.find((entry) => entry.model.provider === legacy.model.provider && entry.model.modelId === legacy.model.modelId);
        if (candidate !== undefined) return { ...finish(candidate, choice ?? {}, reason, input.referenceModel, "DEFAULT_MODEL_UNAVAILABLE"), reason };
      }
    }
    return refusal(eligible.length === 0 ? "NO_VERIFIED_CANDIDATE" : "DIFFERENT_FROM_UNSATISFIABLE");
  }
  for (const fallback of input.defaultFallbacks ?? []) {
    const candidate = eligible.find((entry) => entry.model.provider === fallback.provider && entry.model.modelId === fallback.modelId);
    if (candidate !== undefined) return finish(candidate, choice ?? {}, reason, wanted, "DEFAULT_MODEL_UNAVAILABLE");
  }
  return refusal("NO_VERIFIED_CANDIDATE");
}

export { classifyStageChoiceChange } from "./classify.js";
