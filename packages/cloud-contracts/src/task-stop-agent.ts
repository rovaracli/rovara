// A partial money-policy projection, not agent management or start permission.
import { z } from "zod";
import { AgentIdSchema, isBuiltinAgentId, OrgIdSchema, TaskStopMicrousdSchema } from "@rovara-code/contracts";
const OverrideSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inherit") }).strict(),
  z.object({ kind: z.literal("limited"), stopMicrousd: TaskStopMicrousdSchema }).strict(),
]);
export const TaskStopAgentReadSchema = z.object({
  orgId: OrgIdSchema,
  agentId: AgentIdSchema,
  checkedAt: z.string().datetime(),
  companyPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceKind: z.enum(["custom_agent", "builtin_settings", "builtin_absent"]),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agentOverride: OverrideSchema,
  coverage: z.literal("agent_override_only"),
  projectOverride: z.literal("not_loaded"),
  locks: z.literal("not_loaded"),
  calculation: z.literal("unavailable"),
  enforcement: z.literal("not_connected"),
}).strict().superRefine((value, context) => {
  if ((value.sourceKind === "custom_agent") === isBuiltinAgentId(value.agentId)
    || (value.sourceKind === "builtin_absent" && value.agentOverride.kind !== "inherit")) {
    context.addIssue({ code: "custom", message: "Agent source and override do not agree." });
  }
});
export type TaskStopAgentRead = z.infer<typeof TaskStopAgentReadSchema>;
