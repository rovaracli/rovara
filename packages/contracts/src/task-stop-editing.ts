import { z } from "zod";
import { OrgIdSchema } from "./browser-ids.js";
import { TaskStopMicrousdSchema } from "./task-stop.js";
import { TaskStopCompanyPolicySchema, TaskStopCompanyReadSchema } from "./task-stop-company.js";
import { TaskStopProjectPolicySchema } from "./task-stop-project.js";
export const TaskStopEditablePolicySchema = z.discriminatedUnion("kind", [
 z.object({ kind: z.literal("limited"), stopMicrousd: TaskStopMicrousdSchema }).strict(),
 z.object({ kind: z.literal("rovara_estimate") }).strict(), z.object({ kind: z.literal("inherit") }).strict(),
]);
export type TaskStopEditablePolicy = z.infer<typeof TaskStopEditablePolicySchema>;
const sha = z.string().regex(/^[a-f0-9]{64}$/), settingsRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const TaskStopPendingChangeSchema = z.object({
 version: z.literal(1), proposalId: z.string().uuid(), requestedBy: sha, createdAt: z.string().datetime(), baseRevision: revision,
 beforePolicy: z.union([TaskStopCompanyPolicySchema, TaskStopProjectPolicySchema]), proposedPolicy: TaskStopEditablePolicySchema,
 proposalDigest: sha, sourceDigest: sha, scopeKind: z.enum(["company", "project"]), project: z.string().min(1).max(256).optional(),
}).strict();
export const TaskStopEditingContextSchema = z.object({ orgId: OrgIdSchema, scopeKind: z.enum(["company", "project"]), project: z.string().min(1).max(256).optional(),
 revision: settingsRevision, sourceState: z.enum(["present", "missing"]).optional(), lastTaskStopChange: z.object({ proposalId: z.string().uuid(), state: z.literal("expired"), reason: z.enum(["tightening_applied", "enrollment_changed"]), endedAt: z.string().datetime() }).strict().optional(), sourceDigest: sha, policy: TaskStopEditablePolicySchema, seedReview: TaskStopCompanyReadSchema.shape.seedReview, pending: TaskStopPendingChangeSchema.optional() }).strict();
export const TaskStopEditBodySchema = z.object({ requestId: z.string().uuid(), expectedRevision: settingsRevision, expectedPolicyDigest: sha, policy: TaskStopEditablePolicySchema }).strict();
export const TaskStopDecisionBodySchema = z.object({ requestId: z.string().uuid(), proposalId: z.string().uuid(), decision: z.enum(["approve", "reject", "cancel"]), expectedProposalDigest: sha.optional() }).strict();
export const TaskStopEditResultSchema = z.object({ requestId: z.string().uuid(), state: z.enum(["applied", "pending", "unchanged", "rejected", "cancelled"]), revision, proposalId: z.string().uuid().optional() }).strict();
/** Compare restrictions across ALL future paths, never a sample preview. */
export function taskStopEditKind(before: TaskStopEditablePolicy, after: TaskStopEditablePolicy): "unchanged" | "tightening" | "loosening" {
 if (before.kind === after.kind && (before.kind !== "limited" || after.kind !== "limited" || before.stopMicrousd === after.stopMicrousd)) return "unchanged";
 if (after.kind !== "limited") return "loosening";
 return before.kind !== "limited" || after.stopMicrousd < before.stopMicrousd ? "tightening" : "loosening";
}
