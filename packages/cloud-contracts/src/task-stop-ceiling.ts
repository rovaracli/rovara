// Narrow read alias for the existing company ceiling, not a complete task-stop policy.
import { z } from "zod";
import { OrgIdSchema, TaskStopMicrousdSchema } from "@rovara-code/contracts";
import { DEFAULT_MAX_PER_RUN_CEILING_MICROUSD } from "./spend.js";
export const TaskStopCeilingReadSchema = z.object({
  orgId: OrgIdSchema,
  checkedAt: z.string().datetime(),
  ceilingMicrousd: TaskStopMicrousdSchema,
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  ceilingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.enum(["configured", "rovara_default"]),
  backing: z.literal("legacy_guardrails_alias"),
  coverage: z.literal("company_ceiling_only"),
  companyDefault: z.literal("not_loaded"),
  projectOverride: z.literal("not_loaded"),
  agentOverride: z.literal("not_loaded"),
  locks: z.literal("not_loaded"),
  calculation: z.literal("unavailable"),
  enforcement: z.literal("not_connected"),
}).strict().superRefine((value, context) => {
  if (value.source === "configured" ? value.revision < 1 : value.revision !== 0 || value.ceilingMicrousd !== DEFAULT_MAX_PER_RUN_CEILING_MICROUSD) {
    context.addIssue({ code: "custom", message: "Ceiling source and revision do not agree." });
  }
});
export type TaskStopCeilingRead = z.infer<typeof TaskStopCeilingReadSchema>;
