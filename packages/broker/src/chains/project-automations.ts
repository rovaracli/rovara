// srv/automations: `GET /v1/app/projects/{p}/automations`, everything that runs on its own in one project, for everyone with a role on it (owner decision 16):
// the chains the project owns or is shared (as the chain access rules show them to the caller) and every trigger set on the project, with its last result.
// It reads only: who may change what stays with the chain and trigger routes. A project the caller has no role on, or another org's, is the same 404 as
// one that does not exist. A trigger's target is named only when the caller can see it; its id is shown either way, as the trigger is the project's.
import { ProjectAutomationsResponseSchema, type ProjectAutomationsResponse } from "@agentx/cloud-contracts";
import { AGENTX_NAME_PATTERN, agentXError, atLeast, isBuiltinAgentId, projectAllows } from "@rovara-code/contracts";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { agentAccess, type AgentCaller } from "../agents/access.js";
import { viewOf } from "../triggers/routes.js";
import type { TriggerRecord } from "../triggers/store.js";
import { chainAccess, listVisibleChains, type ChainAccessDeps } from "./access.js";
import type { ChainRouteDependencies } from "./routes.js";

const PROJECT_AUTOMATIONS_PATH = /^\/v1\/app\/projects\/([^/]+)\/automations$/;

/** Whether the path is a project's automations list (matched before Plan 2's own project paths). */
export const isProjectAutomationsRoute = (pathname: string): boolean => PROJECT_AUTOMATIONS_PATH.test(pathname);

const noProject = () => agentXError("NOT_FOUND", "no project has that name");

async function targetName(deps: ChainRouteDependencies, access: ChainAccessDeps, caller: AgentCaller, trigger: TriggerRecord): Promise<string | undefined> {
  if (trigger.target.kind === "chain") {
    const chain = await deps.chains.get(caller.orgId, trigger.target.chainId);
    return chain !== undefined && atLeast(await chainAccess(access, caller, chain), "view") ? chain.name : undefined;
  }
  const agentId = trigger.target.agentId;
  if (isBuiltinAgentId(agentId)) return deps.store.builtinName(agentId);
  const agent = await deps.store.get(caller.orgId, agentId);
  return agent !== undefined && atLeast(await agentAccess(deps, caller, agent), "view") ? agent.name : undefined;
}

/** The project's automations, for a caller with any role on it. */
export async function listProjectAutomations(deps: ChainRouteDependencies, caller: AgentCaller, project: string): Promise<ProjectAutomationsResponse> {
  if (!AGENTX_NAME_PATTERN.test(project)) throw noProject();
  // Live: the role is read on every request, never cached. No role (another org's project reads the same) is a 404.
  const role = await deps.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: caller.orgRole });
  if (role === undefined || !projectAllows(role, "view")) throw noProject();
  const access: ChainAccessDeps = { ...deps, store: deps.chains };
  const chains = (await listVisibleChains(access, caller, { project })).map(({ record, access: level }) => ({
    chainId: record.chainId, name: record.name, description: record.description, owner: record.owner,
    ...(record.currentVersion === undefined ? {} : { currentVersion: record.currentVersion }), status: record.status, access: level,
    ...(record.monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd: record.monthlyBudgetUsd }),
  }));
  // Every key is the caller's own org: another org's triggers are never read.
  const stored = deps.triggers === undefined ? [] : (await deps.triggers.listAll(caller.orgId)).filter((trigger) => trigger.orgId === caller.orgId && trigger.project === project);
  const triggers = [];
  for (const trigger of stored) {
    const name = await targetName(deps, access, caller, trigger);
    triggers.push({ ...await viewOf(deps, trigger), ...(name === undefined ? {} : { targetName: name }) });
  }
  return ProjectAutomationsResponseSchema.parse({ project, canEdit: projectAllows(role, "manage_agents") && projectAllows(role, "edit_settings"), chains, triggers });
}

/** `GET /v1/app/projects/{p}/automations`; any other method is a 404. */
export async function routeProjectAutomations(deps: ChainRouteDependencies, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<ProjectAutomationsResponse> {
  const matched = PROJECT_AUTOMATIONS_PATH.exec(url.pathname);
  if (matched === null || request.method !== "GET") throw agentXError("NOT_FOUND", "route not found");
  let project: string;
  try { project = decodeURIComponent(matched[1]!); } catch { throw noProject(); }
  return listProjectAutomations(deps, caller, project);
}
