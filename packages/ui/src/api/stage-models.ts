// The How we work model pages' reads. The schemas are lane C's (G3 v1, `@agentx/contracts/web`); this file only reads, maps and names things for the UI. The page holds no model logic: it shows these answers and sends the choices through the existing saves.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
 CompanyStageModelOverrideSchema, EffectiveStageModelSchema, ModelPolicyPreviewResponseReaderSchema, ModelSelectionPolicyResponseReaderSchema, ProjectOverviewProjectSchema,
 STAGE_IDS, STAGE_MODEL_REFUSAL_CODES, StageIdSchema, StageModelCandidateSchema, StageModelsResponseReaderSchema, StepThinkingLevelSchema, ThinkingLevelSchema,
 type ModelPolicyPreviewResponse, type ModelSelectionPolicyResponse, type StageId, type StageModelChoice, type StageModelRefusal, type StageModelRefusalCode, type StageModelRow, type StageModelsResponse,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { howWeWorkKey } from "./how-we-work.js";

export { STAGE_IDS, StageIdSchema, ThinkingLevelSchema };
export type { StageId };
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
export type RefusalCode = StageModelRefusalCode;
export const REFUSAL_CODES = STAGE_MODEL_REFUSAL_CODES;
export const isRefusalCode = (code: string): code is RefusalCode => (REFUSAL_CODES as readonly string[]).includes(code);
export type Reason = z.infer<typeof EffectiveStageModelSchema>["reason"];
export const REASONS = EffectiveStageModelSchema.shape.reason.options;
export const isReason = (reason: string): reason is Reason => (REASONS as readonly string[]).includes(reason);
export type StageModels = StageModelsResponse;
export type StageModelsStage = StageModelRow;
export type StageCandidate = z.infer<typeof StageModelCandidateSchema>;
export type StageChoice = StageModelChoice;
export type EffectiveResult = z.infer<typeof EffectiveStageModelSchema>;

/** A model as the page's pickers key it: `provider/modelId`. */
export const modelKey = (model: { provider: string; modelId: string }): string => model.provider + "/" + model.modelId;
export function modelOf(key: string): { provider: string; modelId: string } {
 const at = key.indexOf("/");
 return { provider: key.slice(0, at), modelId: key.slice(at + 1) };
}
/** One stage's answer under a single name, whichever of the three contract shapes it is. */
export type StageResult = ({ kind: "effective" } & EffectiveResult) | ({ kind: "refusal" } & StageModelRefusal) | { kind: "not_applicable" };
export function stageResult(row: StageModelRow): StageResult {
 if ("effective" in row) return { kind: "effective", ...row.effective };
 if ("refusal" in row) return { kind: "refusal", ...row.refusal };
 return { kind: "not_applicable" };
}

/** Which stage ids of the read a How we work card (by its step kind) shows, in order. A review step hosts both reviewers. Lane C names no card mapping, so this stays local. */
export const CARD_STAGES: Readonly<Record<string, readonly StageId[]>> = { plan: ["plan"], plan_critic: ["plan_check"], build: ["build"], review: ["code_review", "security_review"], pull_request: ["pull_request"] };
/** The step kind a checking card is compared with ("Different vendor than Build" / "than Plan"). */
export const REFERENCE_KIND: Readonly<Record<string, "plan" | "build">> = { plan_critic: "plan", review: "build" };

/** The reader keeps fields and codes a newer server adds; every lookup of a code or reason in this UI goes through `isRefusalCode` / `isReason`, so a value this build does not know gets the generic words. */
const readStageModels = { parse: (value: unknown): StageModelsResponse => StageModelsResponseReaderSchema.parse(value) as unknown as StageModelsResponse };
/** Without a draft revision it reads the published process (what a viewer sees); with one, the process layer's draft. */
export function getStageModels(host: AppHost, project: string, draftRevision?: number): Promise<StageModels> {
 const path = "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/stage-models" + (draftRevision === undefined ? "" : "?draft=" + String(draftRevision));
 return createApiClient(host).get(path, readStageModels);
}
export const stageModelsKey = (project: string, draftRevision?: number) => [...howWeWorkKey(project), "stage-models", draftRevision ?? "published"] as const;
export function useStageModels(project: string, draftRevision: number | undefined, enabled: boolean) {
 const host = useAppHost(), key = useMemo(() => stageModelsKey(project, draftRevision), [project, draftRevision]);
 return useQuery({ queryKey: key, enabled, placeholderData: keepPreviousData, queryFn: () => getStageModels(host, project, draftRevision) });
}

// ---- Company scope (lane C's policy read, write and preview). ----
/** The effort levels the step settings schema accepts today; the company page and the project rows offer only these (plus "Model default", null) although lane C's scale also holds xhigh (ruled). */
export const COMPANY_EFFORT_LEVELS = StepThinkingLevelSchema.options;
export type CompanyOverride = z.infer<typeof CompanyStageModelOverrideSchema>;
export type CompanyOverrides = Partial<Record<StageId, CompanyOverride>>;
export type CompanyPolicy = ModelSelectionPolicyResponse & { candidates: Partial<Record<StageId, StageCandidate[]>> };
export type CompanyPreview = ModelPolicyPreviewResponse;
/** LOCAL ADDITION (not in lane C's schema; ruled by the controller): the company GET's per-stage `candidates`, the verified-model lists a company model picker offers. Read leniently and separately: a missing or unreadable list only means "no picker", never a failed read. */
export const CompanyCandidatesSchema = z.object({ candidates: z.partialRecord(StageIdSchema, z.array(StageModelCandidateSchema).max(23)) });
export function readCompanyPolicy(body: unknown): CompanyPolicy {
 const policy = ModelSelectionPolicyResponseReaderSchema.parse(body) as unknown as ModelSelectionPolicyResponse, extra = CompanyCandidatesSchema.safeParse(body);
 return { ...policy, candidates: extra.success ? extra.data.candidates : {} };
}
export const CompanyPolicyReader = { parse: readCompanyPolicy };
export const readCompanyPreview = { parse: (value: unknown): CompanyPreview => ModelPolicyPreviewResponseReaderSchema.parse(value) as unknown as CompanyPreview };
export const IMPACTS = ["unchanged", "changed", "blocked", "unavailable"] as const;
/** LOCAL ADDITION: the 200 answer of the policy PUT (lane C names none). */
export const CompanyAppliedSchema = z.object({ version: z.literal(1), status: z.literal("APPLIED"), revision: z.number().int().min(0), requestId: z.uuid() }).strict();
/** LOCAL ADDITION (ruled by the controller): the 202's sole-owner field. The self-confirm time is shown only when `available` is true. */
export const SoleOwnerSchema = z.object({ available: z.boolean(), availableAt: z.string().min(1).max(64).nullable(), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).optional() }).strict();
export type SoleOwner = z.infer<typeof SoleOwnerSchema>;
/** The stages the company page shows, in order; Review is one row that writes both reviewers. */
export const COMPANY_ROWS = [
 { id: "understand", stages: ["understand"], title: "Understand", reference: undefined },
 { id: "plan", stages: ["plan"], title: "Plan", reference: undefined },
 { id: "plan_check", stages: ["plan_check"], title: "Plan check", reference: "plan" },
 { id: "build", stages: ["build"], title: "Build", reference: undefined },
 { id: "review", stages: ["code_review", "security_review"], title: "Review (code and security)", reference: "build" },
 { id: "pull_request", stages: ["pull_request"], title: "Pull request", reference: undefined },
] as const satisfies ReadonlyArray<{ id: string; stages: readonly StageId[]; title: string; reference: "plan" | "build" | undefined }>;
