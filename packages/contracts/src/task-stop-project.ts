// Additive project money intent. This payload alone is not runtime enforcement.
import { z } from "zod";
import { OrgIdSchema } from "./org.js";
import { AgentXNameSchema } from "./names.js";
import { TaskStopMicrousdSchema } from "./task-stop.js";
export const TaskStopProjectPolicySchema = z.discriminatedUnion("schemaVersion", [
  z.object({ schemaVersion: z.literal(1), stopMicrousd: TaskStopMicrousdSchema }).strict(),
  z.object({ schemaVersion: z.literal(2), kind: z.literal("inherit") }).strict(),
]);
export type TaskStopProjectPolicy = z.infer<typeof TaskStopProjectPolicySchema>;

// A scoped source projection, not a complete effective policy or start authorization.
export const TaskStopProjectReadSchema = z.object({
  orgId: OrgIdSchema,
  project: AgentXNameSchema,
  checkedAt: z.string().datetime(),
  companyPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  catalogRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  settingsRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sourceKind: z.enum(["project_ai", "project_settings_absent"]),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  projectOverride: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inherit") }).strict(),
    z.object({ kind: z.literal("limited"), stopMicrousd: TaskStopMicrousdSchema }).strict(),
  ]),
  coverage: z.literal("project_override_only"),
  agentOverride: z.literal("not_loaded"),
  locks: z.literal("not_loaded"),
  projectLifecycle: z.literal("not_loaded"),
  calculation: z.literal("unavailable"),
  enforcement: z.literal("not_connected"),
}).strict().superRefine((value, context) => {
  if (value.sourceKind === "project_settings_absent"
    ? value.settingsRevision !== 0 || value.projectOverride.kind !== "inherit"
    : value.settingsRevision < 1) {
    context.addIssue({ code: "custom", message: "Project source and revision do not agree." });
  }
});
export type TaskStopProjectRead = z.infer<typeof TaskStopProjectReadSchema>;
