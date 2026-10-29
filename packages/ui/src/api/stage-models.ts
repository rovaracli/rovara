// Temporary copy of lane C's C53 contract; replace with its export at integration.
// The version-1 read of `GET /v1/app/projects/{p}/stage-models?draft=<rev>`. The page holds no model logic: it shows these answers and sends the project's choices through the existing draft save.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ProjectOverviewProjectSchema, StepThinkingLevelSchema, ThinkingLevelSchema } from "@agentx/contracts/web";
export { ThinkingLevelSchema };
import { useAppHost, type AppHost } from "../host.js";
import { safeAppPath } from "../text/links.js";
import { createApiClient } from "./client.js";
import { howWeWorkKey } from "./how-we-work.js";

export const STAGE_IDS = ["plan", "plan_check", "build", "code_review", "security_review", "understand", "pull_request"] as const;
export const StageIdSchema = z.enum(STAGE_IDS);
export type StageId = z.infer<typeof StageIdSchema>;
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
/** The refusal codes of the relay-2 table. */
export const REFUSAL_CODES = ["MODEL_NOT_VERIFIED", "MODEL_STALE", "MODEL_FORBIDDEN", "MODEL_NOT_ALLOWED_IN_PROJECT", "STAGE_LOCKED", "DIFFERENT_FROM_UNSATISFIABLE", "LOCK_UNSATISFIABLE", "NO_VERIFIED_CANDIDATE", "POLICY_STALE", "NEEDS_CONFIRMATION"] as const;
export const RefusalCodeSchema = z.enum(REFUSAL_CODES);
export type RefusalCode = z.infer<typeof RefusalCodeSchema>;
/** The code of the 409 a draft read gets when the revision it named is no longer the layer's (§9b: its own code, not POLICY_STALE). */
export const DRAFT_STALE_CODE = "DRAFT_STALE";
export const REASONS = ["PROJECT_CHOICE", "PROJECT_SELECTION", "PROJECT_DEFAULT", "COMPANY_DEFAULT", "COMPANY_LOCK", "BUILTIN_DEFAULT", "APPROVED_SAME_MODEL"] as const;
export const ReasonSchema = z.enum(REASONS);
export type Reason = z.infer<typeof ReasonSchema>;

const ModelSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._:@+/-]{1,256}$/u);
const TimeSchema = z.string().min(1).max(64);
const FixHrefSchema = z.string().max(300).refine(safeAppPath, "Not an app path");
const LabelSchema = z.string().min(1).refine(value => Array.from(value).length <= 64, "Too long");
const StageChoiceSchema = z.object({ model: ModelSchema.optional(), effort: ThinkingLevelSchema.nullable().optional(), differentFrom: z.object({ stage: StageIdSchema, level: z.enum(["model", "vendor"]) }).strict().optional() }).strict();
const CandidateSchema = z.object({ model: ModelSchema, label: LabelSchema, provider: z.string().min(1).max(128), company: z.string().min(1).max(128), status: z.enum(["verified", "unverified", "stale", "denied"]), checkedAt: TimeSchema.optional(), blockedReason: RefusalCodeSchema.optional() }).strict();
const ResultSchema = z.discriminatedUnion("kind", [
 z.object({ kind: z.literal("effective"), model: ModelSchema, sourceId: z.string().min(1).max(128), effort: ThinkingLevelSchema.nullable(), decidedBy: z.enum(["rovara", "company", "project"]), locked: z.boolean(), reason: ReasonSchema, checkedAt: TimeSchema, expiresAt: TimeSchema.optional() }).strict(),
 z.object({ kind: z.literal("refusal"), code: RefusalCodeSchema, fixHref: FixHrefSchema.optional() }).strict(),
 z.object({ kind: z.literal("not_applicable"), reason: z.literal("NO_MODEL_INVOCATION") }).strict(),
]);
const StageSchema = z.object({
 stage: StageIdSchema, projectChoice: StageChoiceSchema.nullable(), companyDefault: z.object({ choice: StageChoiceSchema.nullable(), locked: z.boolean() }).strict(), result: ResultSchema,
 candidates: z.array(CandidateSchema).max(30), candidatesState: z.enum(["complete", "unavailable"]), candidatesReason: z.string().max(64).optional(),
 editable: z.boolean(), notice: z.object({ code: z.literal("STAGE_LOCKED"), fixHref: FixHrefSchema }).strict().optional(),
}).strict();
export const StageModelsSchema = z.object({
 version: z.literal(1), checkedAt: TimeSchema, companyRevision: z.number().int().min(0), projectRevision: z.number().int().min(0),
 process: z.object({ agentId: z.string().min(1).max(64), version: z.number().int().min(1).optional(), draftRevision: z.number().int().min(0).optional(), digest: z.string().min(1).max(128) }).strict(),
 referenceMode: z.literal("prospective"), rankingVersion: z.string().min(1).max(32), stages: z.array(StageSchema).max(7),
}).strict();
export type StageModels = z.infer<typeof StageModelsSchema>;
export type StageModelsStage = StageModels["stages"][number];
export type StageCandidate = StageModelsStage["candidates"][number];
export type StageChoice = z.infer<typeof StageChoiceSchema>;
export const StageModelsReader = StageModelsSchema;

/** Temporary copy of the stage-to-card mapping lane C exports: which stage ids of the read a How we work card (by its step kind) shows, in order. A review step hosts both reviewers. */
export const CARD_STAGES: Readonly<Record<string, readonly StageId[]>> = { plan: ["plan"], plan_critic: ["plan_check"], build: ["build"], review: ["code_review", "security_review"], pull_request: ["pull_request"] };
/** The step kind a checking card is compared with ("Different vendor than Build" / "than Plan"). */
export const REFERENCE_KIND: Readonly<Record<string, "plan" | "build">> = { plan_critic: "plan", review: "build" };

/** Without a draft revision it reads the published process (what a viewer sees); with one, the process layer's draft. */
export function getStageModels(host: AppHost, project: string, draftRevision?: number): Promise<StageModels> {
 const path = "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/stage-models" + (draftRevision === undefined ? "" : "?draft=" + String(draftRevision));
 return createApiClient(host).get(path, StageModelsReader);
}
export const stageModelsKey = (project: string, draftRevision?: number) => [...howWeWorkKey(project), "stage-models", draftRevision ?? "published"] as const;
export function useStageModels(project: string, draftRevision: number | undefined, enabled: boolean) {
 const host = useAppHost(), key = useMemo(() => stageModelsKey(project, draftRevision), [project, draftRevision]);
 return useQuery({ queryKey: key, enabled, placeholderData: keepPreviousData, queryFn: () => getStageModels(host, project, draftRevision) });
}

// ---- Company scope (C53 "Company GET / PUT /v1/app/org/model-selection-policy" and "Company affected-project preview"). Temporary until lane C's export. ----
/** The effort levels the step settings schema accepts today; the company page offers only these (plus "Model default", null) until lane C widens the schema. */
export const COMPANY_EFFORT_LEVELS = StepThinkingLevelSchema.options;
const CompanyEffortSchema = StepThinkingLevelSchema;
export const CompanyOverrideSchema = z.object({
 model: ModelSchema.optional(), effort: CompanyEffortSchema.nullable().optional(),
 differentFrom: z.object({ stage: StageIdSchema, level: z.enum(["model", "vendor"]) }).strict().optional(), locked: z.boolean(),
}).strict();
export type CompanyOverride = z.infer<typeof CompanyOverrideSchema>;
export type CompanyOverrides = Partial<Record<StageId, CompanyOverride>>;
const OverridesSchema = z.partialRecord(StageIdSchema, CompanyOverrideSchema);
export const CompanyPolicySchema = z.object({ version: z.literal(1), revision: z.number().int().min(0), rankingVersion: z.string().min(1).max(32), stepOverrides: OverridesSchema }).strict();
export type CompanyPolicy = z.infer<typeof CompanyPolicySchema>;
/** The PUT body: the full set of overrides, at most seven stages. */
export const CompanyPolicyPutSchema = z.object({ version: z.literal(1), requestId: z.string().uuid(), expectedRevision: z.number().int().min(0), stepOverrides: OverridesSchema }).strict();
export const CompanyPreviewBodySchema = z.object({ version: z.literal(1), expectedRevision: z.number().int().min(0), stepOverrides: OverridesSchema, cursor: z.string().min(1).max(2048).optional() }).strict();
export type CompanyPreviewBody = z.infer<typeof CompanyPreviewBodySchema>;
export const IMPACTS = ["unchanged", "changed", "blocked", "unavailable"] as const;
export const CompanyPreviewSchema = z.object({
 version: z.literal(1), checkedAt: TimeSchema, policyRevision: z.number().int().min(0), coverage: z.enum(["page", "unavailable"]),
 projects: z.array(z.object({ project: z.string().min(1).max(128), impact: z.enum(IMPACTS), reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)).max(10) }).strict()).max(5),
 nextCursor: z.string().min(1).max(2048).optional(),
}).strict();
export type CompanyPreview = z.infer<typeof CompanyPreviewSchema>;
export const CompanyAppliedSchema = z.object({ version: z.literal(1), status: z.literal("APPLIED"), revision: z.number().int().min(0), requestId: z.string().uuid() }).strict();
/** 202. `soleOwner` is the owner's decision for a company with one admin (a 24-hour safety wait, then the requester may confirm); lane C's field name to be matched at integration. */
export const CompanyNeedsConfirmationSchema = z.object({
 version: z.literal(1), status: z.literal("NEEDS_CONFIRMATION"), confirmationId: z.string().min(1).max(128), confirmUrl: z.string().min(1).max(2048).optional(),
 reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u)).max(20), requestId: z.string().uuid(), soleOwner: z.object({ availableAt: TimeSchema }).strict().optional(),
}).strict();
export type CompanyNeedsConfirmation = z.infer<typeof CompanyNeedsConfirmationSchema>;
/** The stages the company page shows, in order; Review is one row that writes both reviewers. */
export const COMPANY_ROWS = [
 { id: "understand", stages: ["understand"], title: "Understand", reference: undefined },
 { id: "plan", stages: ["plan"], title: "Plan", reference: undefined },
 { id: "plan_check", stages: ["plan_check"], title: "Plan check", reference: "plan" },
 { id: "build", stages: ["build"], title: "Build", reference: undefined },
 { id: "review", stages: ["code_review", "security_review"], title: "Review (code and security)", reference: "build" },
 { id: "pull_request", stages: ["pull_request"], title: "Pull request", reference: undefined },
] as const satisfies ReadonlyArray<{ id: string; stages: readonly StageId[]; title: string; reference: "plan" | "build" | undefined }>;
