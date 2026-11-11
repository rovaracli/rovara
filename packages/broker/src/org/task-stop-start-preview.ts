// Read-only policy preview for the project's own start path. No work or money effects.
import { PER_TASK_BUDGET_USD, TaskStopStartPreviewBodySchema, TaskStopStartPreviewSchema } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { projectRoleForRoute } from "../aws/developer-routes/project-members.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";
import { projectProcessOf } from "../playbook/project-process.js";
import { requireAgentAccess } from "../agents/access.js";
import { planningLimit, readProjectAi } from "../spend/settings.js";
import { effectiveSources } from "../model-sources/routing.js";
import { companySource } from "./task-stop-enrollment-common.js";
import { continueAdmissionIdentity } from "./task-stop-window.js";
import { captureTaskStopAdmission } from "./task-stop-admission.js";
export async function previewTaskStartStop(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawProject: string, value: unknown) {
 const { name: project, role } = await projectRoleForRoute(deps, caller, rawProject);
 await requireNewWorkAllowed(deps, caller.orgId, project, role, "task");
 const body = TaskStopStartPreviewBodySchema.safeParse(value);if (!body.success) throw agentXError("CONFIG_INVALID", "Review the start preview request.");
 const scope = { orgId: caller.orgId, project }, source = await companySource(deps, caller, false);
 if (source.state !== "enabled") return TaskStopStartPreviewSchema.parse({ ...scope, kind: "disabled" });
 const process = await projectProcessOf({ ...deps, store: deps.agents?.store }, caller.orgId, project);
 if (deps.agents !== undefined) await requireAgentAccess(deps.agents, caller, process.agentId, "use");
 if (deps.agents?.modelRouting !== undefined) {
  const sources = await effectiveSources(deps.agents.modelRouting, caller.orgId, project);
  // A new task may qualify for own-source exemption only after its recipe is pinned.
  // Until then no stop is promised for an exclusive own-source configuration.
  if (sources !== undefined && !sources.order.includes("rovara")) return TaskStopStartPreviewSchema.parse({ ...scope, kind: "unknown" });
 }
 const budgetUsd = deps.modelAccess === undefined ? PER_TASK_BUDGET_USD : planningLimit(await readProjectAi(deps, caller.orgId, project), body.data.path ?? "QUICK");
 // The existing request-building read represents $0; real start still refuses it.
 const captured = await captureTaskStopAdmission({ ...deps, purpose: "approval_terms", requireScopeAccess: async () => {
  const fresh = await projectRoleForRoute(deps, caller, rawProject);await requireNewWorkAllowed(deps, caller.orgId, project, fresh.role, "task");
 } }, { ...scope, developerId: caller.developerId, role: caller.orgRole, agentId: process.agentId, ...continueAdmissionIdentity({ budgetUsd }) });
 return TaskStopStartPreviewSchema.parse(captured.kind === "disabled" ? { ...scope, kind: "disabled" } : { ...scope, kind: "captured", effectiveStopMicrousd: captured.effectiveStopMicrousd });
}
