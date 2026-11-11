// Shared company money data: no second persisted ceiling or start permission.
import { z } from "zod";
import { OrgIdSchema, TaskStopAdmissionInputSchema, TaskStopMicrousdSchema } from "@rovara-code/contracts";
import { DEFAULT_MAX_PER_RUN_CEILING_MICROUSD } from "./spend.js";
export const TaskStopCompanyPolicySchema = z.discriminatedUnion("schemaVersion", [
  z.object({ schemaVersion: z.literal(1), defaultStopMicrousd: TaskStopMicrousdSchema }).strict(),
  z.object({ schemaVersion: z.literal(2), defaultPolicy: TaskStopAdmissionInputSchema.shape.companyDefault }).strict(),
]);
export const TaskStopCompanyReadSchema = z.object({
  orgId: OrgIdSchema,
  checkedAt: z.string().datetime(),
  defaultStopMicrousd: TaskStopMicrousdSchema.optional(),
  defaultPolicy: TaskStopAdmissionInputSchema.shape.companyDefault.optional(),
  seedReview: z.object({ source: z.enum(["bootstrap", "upgrade"]), reviewRequired: z.boolean(), seededAt: z.string().datetime() }).strict().optional(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  defaultSource: z.literal("configured"),
  ceilingMicrousd: TaskStopMicrousdSchema,
  ceilingRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ceilingSource: z.enum(["configured", "rovara_default"]),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.literal("company_default_and_ceiling"),
  projectOverride: z.literal("not_loaded"),
  agentOverride: z.literal("not_loaded"),
  locks: z.literal("not_loaded"),
  calculation: z.literal("unavailable"),
  enforcement: z.literal("not_connected"),
}).strict().superRefine((value, context) => {
  if ((value.defaultStopMicrousd === undefined) === (value.defaultPolicy === undefined)) context.addIssue({ code: "custom", message: "Exactly one company default representation is required." });
  if (value.ceilingSource === "configured" ? value.ceilingRevision < 1 : value.ceilingRevision !== 0 || value.ceilingMicrousd !== DEFAULT_MAX_PER_RUN_CEILING_MICROUSD) {
    context.addIssue({ code: "custom", message: "Ceiling source and revision do not agree." });
  }
});
export type TaskStopCompanyRead = z.infer<typeof TaskStopCompanyReadSchema>;
