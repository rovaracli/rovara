// Collaborator role (W11): the routes of the project's collaborator switch and its product decisions. Every write is browser-only (the dispatcher refuses any other caller before authentication's result
// is used, see `collaboratorBrowserOnly`); every read and write resolves the project from the caller's checked org and reads their EXACT role live (`visibleMemberRoles`), so a project of another org, or
// one the caller cannot see, is the same 404 as a missing one.
//   GET  /v1/app/projects/{name}/collaborator-approvals                 the switch (anyone who can see the project)
//   PUT  /v1/app/projects/{name}/collaborator-approvals                 change it (a maintainer)
//   GET  /v1/app/projects/{name}/product-decisions                      the project's product decisions, with what the reader may do
//   POST /v1/app/projects/{name}/product-decisions/{decisionId}         answer or approve one
import { AgentXNameSchema, agentXError } from "@rovara-code/contracts";
import type { CollaboratorApprovalsResponse, ProductDecisionDecideResponse, ProductDecisionsResponse, ProjectRole } from "@agentx/cloud-contracts";
import { PROJECT_NOT_FOUND_IN_APP } from "../aws/developer-routes/common.js";
import { latestDefinition, visibleMemberRoles } from "../aws/developer-routes/project-list.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes/types.js";
import { readCollaboratorApprovals, setCollaboratorApprovals } from "./approvals-setting.js";
import { decideProductDecision, listProductDecisions, type ProductDecisionDeps } from "../product-decisions/store.js";

const PATH = /^\/v1\/app\/projects\/([^/]+)\/(collaborator-approvals|product-decisions)(?:\/([^/]+))?$/u;
export const COLLABORATOR_BROWSER_MESSAGE = "Use a live browser session to change collaborator approvals or decide a product decision.";

/** Whether a request must come from a live browser session: every write on these paths. */
export const collaboratorBrowserOnly = (method: string, pathname: string): boolean => method !== "GET" && PATH.test(pathname);

/** The project named in the path and the caller's exact live role in it, or the one 404 for no access, no such project and another org's project. */
async function projectFor(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleMemberRoles(deps, caller, name)).get(name);
  if (role === undefined || await latestDefinition(deps, caller.orgId, name) === undefined) throw notFound();
  return { name, role };
}

const decisionDeps = (deps: DeveloperRouteDependencies): ProductDecisionDeps => ({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.audit === undefined ? {} : { audit: deps.audit }) });

/** Answers a request on these paths, or undefined when the path or method is not one of them (it then falls through as any unknown path). */
export async function routeCollaboratorRequest(deps: DeveloperRouteDependencies, caller: DeveloperCaller, method: string, pathname: string, body: () => unknown): Promise<CollaboratorApprovalsResponse | ProductDecisionsResponse | ProductDecisionDecideResponse | undefined> {
  const match = PATH.exec(pathname);
  if (match === null) return undefined;
  const [, rawName, kind, id] = match;
  const isSwitch = kind === "collaborator-approvals";
  if (isSwitch && id !== undefined) return undefined;
  if (isSwitch && method !== "GET" && method !== "PUT") return undefined;
  if (!isSwitch && !((method === "GET" && id === undefined) || (method === "POST" && id !== undefined))) return undefined;
  const { name, role } = await projectFor(deps, caller, rawName!);
  const store = decisionDeps(deps);
  if (isSwitch) {
    if (method === "GET") return { collaboratorApprovals: await readCollaboratorApprovals(store, caller.orgId, name, role) };
    return { collaboratorApprovals: await setCollaboratorApprovals(store, { orgId: caller.orgId, project: name, role, developerId: caller.developerId, body: body() }) };
  }
  const who = { orgId: caller.orgId, developerId: caller.developerId, name: caller.name, role };
  if (method === "GET") return { decisions: await listProductDecisions(store, who, name) };
  return { decision: await decideProductDecision(store, who, name, id!, body()) };
}
