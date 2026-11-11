// srv/automations: what the web app reads and sends for automations (chains and their triggers), shaped exactly as the broker's existing routes answer
// (`packages/broker/src/chains/routes.ts`, `packages/broker/src/triggers/routes.ts`) and the project's automations list
// (`packages/broker/src/chains/project-automations.ts`). The run list, a run's view, its events and a step's task are Rovara Code's
// (`ChainRunListReaderSchema` and the others in `@rovara-code/contracts`), not repeated here. Each response has a browser-safe reader (`forwardReader`).
// Who may do what is the broker's to decide (experience review decision 16 (final-experience-proposal.md, 2026-11-10); owner decision 92); `access` and `canEdit` only say what the screen should offer.
import { z } from "zod";
import {
  AGENT_DESCRIPTION_MAX, AGENT_NAME_MAX, AgentAccessLevelSchema, AgentOwnerSchema, ChainIdSchema, TRIGGER_MAX_RUNS_PER_HOUR, TRIGGER_OUTCOMES, TriggerIdSchema, TriggerSpecSchema, TriggerTargetSchema, forwardReader,
} from "@rovara-code/contracts";

const Version = z.number().int().positive();
const Usd = z.number().finite().nonnegative();
const Iso = z.string().min(1).max(40);
const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/);
const ProjectName = z.string().min(1).max(200);
const RequestId = z.string().uuid();

export const AutomationChainStatusSchema = z.enum(["active", "archived"]);

/** One row of a chain list (`GET /v1/app/chains`, and the chains of `GET /v1/app/projects/{p}/automations`). */
export const AutomationChainSummarySchema = z.object({
  chainId: ChainIdSchema, name: z.string(), description: z.string(), owner: AgentOwnerSchema, currentVersion: Version.optional(), status: AutomationChainStatusSchema,
  access: AgentAccessLevelSchema, monthlyBudgetUsd: Usd.optional(),
}).strict();

/** A chain as its page shows it (`GET /v1/app/chains/{id}` and the answers of the writes). */
export const AutomationChainViewSchema = z.object({
  chainId: ChainIdSchema, name: z.string(), description: z.string(), owner: AgentOwnerSchema, accountable: z.object({ developerId: DeveloperId }).strict().optional(),
  currentVersion: Version.optional(), latestVersion: z.number().int().nonnegative(), draftRevision: Version, status: AutomationChainStatusSchema, monthlyBudgetUsd: Usd.optional(),
  openRuns: z.number().int().nonnegative(), createdBy: z.string(), createdAt: Iso, updatedAt: Iso, access: AgentAccessLevelSchema,
}).strict();

export const AutomationChainListResponseSchema = z.object({ chains: z.array(AutomationChainSummarySchema) }).strict();
export const AutomationChainResponseSchema = z.object({ chain: AutomationChainViewSchema, current: z.object({ version: Version, definition: z.unknown() }).strict().optional() }).strict();
export const AutomationChainWriteResponseSchema = z.object({ chain: AutomationChainViewSchema }).strict();

/** A trigger as every trigger read answers it. `lastFiredAt`, `lastRunId` and `lastTaskId` are its last result. */
export const AutomationTriggerViewSchema = z.object({
  triggerId: TriggerIdSchema, target: TriggerTargetSchema, project: ProjectName, spec: TriggerSpecSchema, hookId: z.string().optional(), enabled: z.boolean(),
  disabledReason: z.string().optional(), maxRunsPerHour: z.number().int().min(1).max(TRIGGER_MAX_RUNS_PER_HOUR), scheduleStatus: z.enum(["ok", "pending"]).optional(),
  lastFiredAt: Iso.optional(), lastRunId: z.string().optional(), lastTaskId: z.string().optional(), createdBy: z.object({ developerId: z.string(), name: z.string() }).strict(),
  createdAt: Iso, updatedAt: z.string(),
}).strict();

export const AutomationTriggerListResponseSchema = z.object({ triggers: z.array(AutomationTriggerViewSchema) }).strict();
export const AutomationTriggerWriteResponseSchema = z.object({ trigger: AutomationTriggerViewSchema }).strict();
export const AutomationTriggerActivitySchema = z.object({
  at: Iso, eventKey: z.string().max(200), outcome: z.enum(TRIGGER_OUTCOMES), runId: z.string().optional(), taskId: z.string().optional(), reason: z.string().max(300).optional(),
}).strict();
export const AutomationTriggerActivityResponseSchema = z.object({ activity: z.array(AutomationTriggerActivitySchema) }).strict();
export const AutomationDeletedResponseSchema = z.object({ deleted: z.literal(true) }).strict();

/** A trigger in a project's list, with what its target is called when the caller can see the target (otherwise `targetName` is left out). */
export const ProjectAutomationTriggerSchema = AutomationTriggerViewSchema.extend({ targetName: z.string().optional() }).strict();

/**
 * `GET /v1/app/projects/{p}/automations`: everything that runs on its own in a project, for everyone with a role on it (experience review decision 16). `canEdit` is
 * true for its maintainers and org owners and admins; a company-shared chain is still changed only by an org owner or admin (decision 92, `access`).
 */
export const ProjectAutomationsResponseSchema = z.object({
  project: ProjectName, canEdit: z.boolean(), chains: z.array(AutomationChainSummarySchema), triggers: z.array(ProjectAutomationTriggerSchema),
}).strict();

// ---- what the screens send (every write carries a fresh requestId; a repeat with the same body is answered from the first, a different body is refused)

export const AutomationChainCreateBodySchema = z.object({
  requestId: RequestId, name: z.string().min(1).max(AGENT_NAME_MAX), description: z.string().max(AGENT_DESCRIPTION_MAX).optional(), owner: AgentOwnerSchema.optional(),
  accountable: z.object({ developerId: DeveloperId }).strict().optional(), definition: z.unknown().optional(),
}).strict();
export const AutomationChainDraftPutBodySchema = z.object({ requestId: RequestId, expectedRevision: Version, definition: z.unknown() }).strict();
export const AutomationChainPublishBodySchema = z.object({ requestId: RequestId, expectedDraftRevision: Version, note: z.string().trim().min(1).max(200).optional() }).strict();
export const AutomationChainRollbackBodySchema = z.object({ requestId: RequestId, version: Version }).strict();
/** Archive (pause the chain: it starts nothing and its triggers go off), unarchive, and a trigger's delete. */
export const AutomationRequestOnlyBodySchema = z.object({ requestId: RequestId }).strict();
export const AutomationChainBudgetPutBodySchema = z.object({ requestId: RequestId, monthlyUsd: Usd.nullable() }).strict();
/** `PUT /v1/app/chains/{id}/triggers/{triggerId}`: creates or changes a trigger; `enabled: false` pauses it at once, `enabled: true` waits for a confirmation. */
export const AutomationTriggerPutBodySchema = z.object({
  requestId: RequestId, project: ProjectName, spec: TriggerSpecSchema, hookId: z.string().regex(/^hk_[0-9a-z]{26}$/).optional(), enabled: z.boolean().optional(),
  maxRunsPerHour: z.number().int().min(1).max(TRIGGER_MAX_RUNS_PER_HOUR).optional(),
}).strict();

export type AutomationChainSummary = z.infer<typeof AutomationChainSummarySchema>;
export type AutomationChainView = z.infer<typeof AutomationChainViewSchema>;
export type AutomationTriggerView = z.infer<typeof AutomationTriggerViewSchema>;
export type ProjectAutomationsResponse = z.infer<typeof ProjectAutomationsResponseSchema>;

export const AutomationChainListResponseReaderSchema = forwardReader(AutomationChainListResponseSchema);
export const AutomationChainResponseReaderSchema = forwardReader(AutomationChainResponseSchema);
export const AutomationChainWriteResponseReaderSchema = forwardReader(AutomationChainWriteResponseSchema);
export const AutomationTriggerListResponseReaderSchema = forwardReader(AutomationTriggerListResponseSchema);
export const AutomationTriggerWriteResponseReaderSchema = forwardReader(AutomationTriggerWriteResponseSchema);
export const AutomationTriggerActivityResponseReaderSchema = forwardReader(AutomationTriggerActivityResponseSchema);
export const AutomationDeletedResponseReaderSchema = forwardReader(AutomationDeletedResponseSchema);
export const ProjectAutomationsResponseReaderSchema = forwardReader(ProjectAutomationsResponseSchema);
