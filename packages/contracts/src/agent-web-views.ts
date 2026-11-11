// RULING Q43: additive shared views of the existing agents and spend route projections.
// These readers do not change broker policy or the stored agent records.
import { z } from "zod";
import { ModelListSchema, AutonomySchema, SkillIdSchema, AgentIdSchema, AgentOwnerSchema, AgentPrincipalSchema, AgentAccessLevelSchema, BaseRefSchema } from "./agent.js";
import { ResolvedRecipeSchema, RecipeOverlaySchema } from "./agent-recipe.js";
import { AgentOriginViewSchema, SessionMakeAgentCopiedSchema } from "./agent-sessions.js";
import { RunInputSchema } from "./agent-run.js";
import { SPEND_ORIGIN_KINDS } from "./spend.js";
import { forwardReader } from "./forward-reader.js";
import { AgentPublicationSchema } from "./app-agent-publish.js";
const Version = z.number().int().positive(), Usd = z.number().finite().nonnegative();
export const AgentScopeSchema = z.enum(["all", "mine", "shared", "builtin"]);
export const AgentMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const AgentDeveloperRefSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const AgentViewSchema = z.object({
 agentId: AgentIdSchema, name: z.string(), description: z.string(), builtin: z.boolean(), access: AgentAccessLevelSchema, status: z.enum(["active", "archived"]),
 owner: AgentOwnerSchema.optional(), accountable: AgentDeveloperRefSchema.optional(), currentVersion: Version.optional(), pinnedVersion: Version.optional(), latestVersion: z.number().int().nonnegative(), draftRevision: Version.optional(),
 monthlyBudgetUsd: Usd.optional(), maxPerRunUsd: Usd.optional(), createdBy: z.string().optional(), createdAt: z.string().optional(), updatedAt: z.string().optional(),
 disabled: z.boolean().optional(), needsLaterConnectors: z.string().optional(), extends: BaseRefSchema.optional(), updateAvailable: z.object({ from: Version, to: Version }).strict().optional(),
 publication: AgentPublicationSchema.optional(),
}).strict();
export const AgentDirectoryResponseSchema = z.object({ agents: z.array(AgentViewSchema) }).strict();
export const AgentProfileResponseSchema = z.object({ agent: AgentViewSchema, current: z.object({ version: Version, recipe: ResolvedRecipeSchema.optional(), changed: z.boolean(), problem: z.string().optional() }).strict().optional(), suggestedMaxPerRunUsd: Usd, maxPerRunUsd: Usd.optional() }).strict();
export const AgentWriteResponseSchema = z.object({ agent: AgentViewSchema }).strict();
export const AgentDraftViewSchema = z.object({ overlay: RecipeOverlaySchema, extends: BaseRefSchema.optional(), origin: AgentOriginViewSchema.optional(), revision: Version, updatedBy: z.string(), updatedAt: z.string() }).strict();
export const AgentDraftResponseSchema = z.object({ draft: AgentDraftViewSchema, resolved: ResolvedRecipeSchema.optional(), base: ResolvedRecipeSchema.optional(), updateAvailable: z.object({ from: Version, to: Version }).strict().optional(), problems: z.array(z.object({ path: z.string(), message: z.string() }).strict()).optional() }).strict();
export const AgentVersionViewSchema = z.object({ version: Version, digest: z.string().optional(), name: z.string().optional(), description: z.string().optional(), publishedBy: z.string().optional(), publishedAt: z.string().optional(), note: z.string().optional(), releasedIn: z.string().optional(), notes: z.string().optional(), extends: BaseRefSchema.optional(), origin: AgentOriginViewSchema.optional(), current: z.boolean().optional(), safety: z.enum(["current", "same_or_safer", "less_safe", "unknown"]).optional(), needsOwnerOk: z.boolean().optional(), problem: z.string().optional(), lessSafe: z.array(z.string()).optional() }).strict();
export const AgentVersionsResponseSchema = z.object({ versions: z.array(AgentVersionViewSchema) }).strict();
export const AgentShareViewSchema = z.object({ principal: AgentPrincipalSchema, level: z.enum(["view", "use", "edit"]), grantedBy: z.string(), grantedAt: z.string() }).strict();
export const AgentSharesResponseSchema = z.object({ shares: z.array(AgentShareViewSchema) }).strict();
export const AgentShareInputSchema = AgentShareViewSchema.pick({ principal: true, level: true });
export const AgentSharesPutResponseSchema = z.object({ shares: z.array(AgentShareInputSchema) }).strict();
export const AgentOwnerPutBodySchema = z.object({ requestId: z.string().uuid(), owner: AgentOwnerSchema, accountable: AgentDeveloperRefSchema.optional() }).strict();
export const AgentAccountablePutBodySchema = z.object({ requestId: z.string().uuid(), accountable: AgentDeveloperRefSchema }).strict();
export const AgentAccountableResponseSchema = z.object({ accountable: AgentDeveloperRefSchema }).strict();
export const AgentAdoptResponseSchema = z.object({ pinnedVersion: Version, changes: z.array(z.string()) }).strict();
export const AgentUpdateBaseResponseSchema = z.object({ draft: AgentDraftViewSchema, changes: z.array(z.string()) }).strict();
export const AgentSpendResponseSchema = z.object({ month: AgentMonthSchema, totalUsd: Usd, byOrigin: z.object({ person: Usd, autonomous: Usd, test: Usd }).strict(), recentRuns: z.array(z.object({ taskId: z.string().optional(), project: z.string(), origin: z.enum(SPEND_ORIGIN_KINDS), usd: Usd, lastAt: z.string() }).strict()).max(20), budget: z.object({ limitUsd: Usd, spentUsd: Usd }).strict().optional(), maxPerRunUsd: Usd.optional() }).strict();
export const AgentDiffResponseSchema = z.object({ from: z.union([Version, z.literal("base"), z.literal("draft")]), to: z.union([Version, z.literal("draft")]), changes: z.array(z.string()), lessSafe: z.array(z.string()), comparison: z.object({ before: ResolvedRecipeSchema, after: ResolvedRecipeSchema }).strict().optional() }).strict();
const MadeAgent = AgentWriteResponseSchema.extend({ draft: AgentDraftViewSchema.optional() });
export const SessionMakeAgentResponseSchema = z.union([MadeAgent.extend(SessionMakeAgentCopiedSchema.options[0].shape), MadeAgent.extend(SessionMakeAgentCopiedSchema.options[1].shape)]);
export const AgentDirectoryResponseReaderSchema = forwardReader(AgentDirectoryResponseSchema);
export const AgentProfileResponseReaderSchema = forwardReader(AgentProfileResponseSchema);
export const AgentWriteResponseReaderSchema = forwardReader(AgentWriteResponseSchema);
export const AgentDraftResponseReaderSchema = forwardReader(AgentDraftResponseSchema);
export const AgentVersionsResponseReaderSchema = forwardReader(AgentVersionsResponseSchema);
export const AgentSharesResponseReaderSchema = forwardReader(AgentSharesResponseSchema);
export const AgentSharesPutResponseReaderSchema = forwardReader(AgentSharesPutResponseSchema);
export const AgentAccountableResponseReaderSchema = forwardReader(AgentAccountableResponseSchema);
export const AgentAdoptResponseReaderSchema = forwardReader(AgentAdoptResponseSchema);
export const AgentUpdateBaseResponseReaderSchema = forwardReader(AgentUpdateBaseResponseSchema);
export const AgentSpendResponseReaderSchema = forwardReader(AgentSpendResponseSchema);
export const AgentDiffResponseReaderSchema = forwardReader(AgentDiffResponseSchema);
export const SessionMakeAgentResponseReaderSchema = forwardReader(SessionMakeAgentResponseSchema);

export const ModelListReaderSchema = forwardReader(ModelListSchema);
export const AgentCreateBodySchema = z.object({ requestId: z.string().uuid(), name:z.string(), description:z.string().optional(), owner:AgentOwnerSchema.optional(), accountable:AgentDeveloperRefSchema.optional(), extends:AgentIdSchema.optional(), overlay:RecipeOverlaySchema.optional() }).strict();
export const AgentDraftPutBodySchema = z.object({requestId:z.string().uuid(),expectedRevision:Version,overlay:RecipeOverlaySchema,extends:AgentIdSchema.nullable().optional()}).strict();

export const BuilderGuardrailsReaderSchema = forwardReader(z.object({guardrails:z.object({maxAutonomy:AutonomySchema}).strict()}).strict());
export const BuilderSkillsReaderSchema = forwardReader(z.object({skills:z.array(z.object({skillId:SkillIdSchema,name:z.string(),currentDigest:z.string()}).strict())}).strict());

export const AgentPublishBodySchema = z.object({requestId:z.string().uuid(),expectedRevision:Version,note:z.string().trim().min(1).max(200).optional()}).strict();
export const AgentRollbackBodySchema = z.object({requestId:z.string().uuid(),version:Version}).strict();
export const AgentBudgetBodySchema = z.object({requestId:z.string().uuid(),monthlyUsd:z.number().finite().nullable().optional(),maxPerRunUsd:z.number().finite().nullable().optional()}).strict();
export const AgentRunBodySchema = z.object({requestId:z.string().uuid(),project:z.string().min(1).max(200),version:z.union([Version,z.literal("draft")]).optional(),input:RunInputSchema}).strict();
export const AgentPublishResponseSchema = AgentWriteResponseSchema.extend({version:AgentVersionViewSchema});
export const AgentPublishResponseReaderSchema = forwardReader(AgentPublishResponseSchema);
export const BuilderTestingBudgetSchema = z.object({month:AgentMonthSchema,perTestCapUsd:Usd.optional(),testing:z.object({spentUsd:Usd,committedUsd:Usd,limitUsd:Usd.optional()}).strict()}).strict();
export const BuilderTestingBudgetReaderSchema = forwardReader(BuilderTestingBudgetSchema);
