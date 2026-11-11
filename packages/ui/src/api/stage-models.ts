// The How we work model pages' reads. The schemas are lane C's (G3 v1, `@agentx/contracts/web`); this file only reads, maps and names things for the UI. The page holds no model logic: it shows these answers and sends the choices through the existing saves.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { z } from "zod";
import { EffectiveStageModelSchema, ModelPolicyPreviewResponseReaderSchema, ModelSelectionPolicyResponseReaderSchema, ProjectOverviewProjectSchema, STAGE_IDS, STAGE_MODEL_REFUSAL_CODES, STAGE_MODEL_THINKING_LEVELS, StageIdSchema, StageModelsResponseReaderSchema, ThinkingLevelSchema, type ModelPolicyPreviewResponse, type ModelSelectionPolicyResponse, type StageId, type StageModelChoice, type StageModelRefusal, type StageModelRefusalCode, type StageModelRow, type StageModelsResponse } from "@agentx/cloud-contracts/web";
import type { CompanyStageModelOverrideSchema, StageModelCandidateSchema } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { howWeWorkKey } from "./how-we-work.js";

export { STAGE_IDS, STAGE_MODEL_THINKING_LEVELS, StageIdSchema, ThinkingLevelSchema };
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
export type CompanyOverride = z.infer<typeof CompanyStageModelOverrideSchema>;
export type CompanyOverrides = Partial<Record<StageId, CompanyOverride>>;
export type CompanyPolicy = ModelSelectionPolicyResponse;
export type CompanyPreview = ModelPolicyPreviewResponse;
/** Lane C's company read. `candidates` is optional there: absent for a stage means the model list is unavailable (not "no verified models"); an empty array means no verified candidates. */
export const readCompanyPolicy = (body: unknown): CompanyPolicy => ModelSelectionPolicyResponseReaderSchema.parse(body) as unknown as CompanyPolicy;
export const CompanyPolicyReader = { parse: readCompanyPolicy };
export const readCompanyPreview = { parse: (value: unknown): CompanyPreview => ModelPolicyPreviewResponseReaderSchema.parse(value) as unknown as CompanyPreview };
