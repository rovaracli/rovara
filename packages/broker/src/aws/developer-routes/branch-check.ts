// The default-branch check's routes (0.5.16): `GET /v1/app/projects/{name}/branch-check`, `POST .../branch-check/continue` and `PUT .../default-branch`. The rules are in `org/branch-check.ts`; this file builds
// its dependencies from the developer API's (the same role read, GitHub reads and revision registration the settings save uses) and is the one place the setup draft and the setup run take their gate from.
import { AgentXNameSchema, agentXError } from "@rovara-code/contracts";
import { checkProjectBranches, continueWithBranch, requireBranchesReady, setProjectDefaultBranch, type BranchCheckDependencies } from "../../org/branch-check.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { PROJECT_NOT_FOUND_IN_APP } from "./common.js";
import { jsonBody } from "./organization.js";
import { getAppProject } from "./project-archive-setup.js";
import { visibleProjectRoles } from "./project-list.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const BRANCH_CHECK_PATH = /^\/v1\/app\/projects\/([^/]+)\/(branch-check|branch-check\/continue|default-branch)$/u;

export function branchCheckDepsOf(deps: DeveloperRouteDependencies): BranchCheckDependencies<DeveloperCaller> {
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, cloud: deps.cloud === true, now: deps.now,
    effectiveRole: async (who, project) => (await visibleProjectRoles(deps, who, project)).get(project),
    probe: deps.branchProbe,
    registerRevision: deps.projectSettings?.registerRevision === undefined ? undefined : (actor, input, extra) => deps.projectSettings!.registerRevision(actor, input, extra),
    readProject: (who, project) => getAppProject(deps, who, project),
  };
}

/** The gate a setup draft or run starts through: refuses while the project's default branch has no files and the person has not chosen to go on. */
export const branchGateOf = (deps: DeveloperRouteDependencies) => (who: DeveloperCaller, project: string): Promise<void> => requireBranchesReady(branchCheckDepsOf(deps), who, project);

/** Routes a branch-check request, or answers undefined when the path is not one. */
export async function routeBranchCheck(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<object | undefined> {
  const match = BRANCH_CHECK_PATH.exec(url.pathname);
  if (match === null) return undefined;
  let name: string;
  try { name = decodeURIComponent(match[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP); }
  if (!AgentXNameSchema.safeParse(name).success) throw agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  const branch = branchCheckDepsOf(deps);
  if (match[2] === "branch-check" && request.method === "GET") return checkProjectBranches(branch, caller, name);
  if (match[2] === "branch-check/continue" && request.method === "POST") return continueWithBranch(branch, caller, name, jsonBody(request));
  if (match[2] === "default-branch" && request.method === "PUT") return setProjectDefaultBranch(branch, caller, name, jsonBody(request));
  return undefined;
}
