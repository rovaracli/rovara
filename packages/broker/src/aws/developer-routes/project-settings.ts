import { readAllowedDomainActorConditions } from "../../org/second-person-evidence.js";
import { AgentXNameSchema, agentXError, type AppProjectDetail } from "@agentx/contracts";
import { updateProjectSettings, type UpdateProjectSettingsOptions } from "../../org/project-settings.js";
import { routeMetaConfig } from "../../meta-repo/config-import.js";
import { StatusReply } from "../status-reply.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";
import { PROJECT_NOT_FOUND_IN_APP } from "./common.js";
import { latestProjectRecord, repositoryFullName, visibleProjectRoles } from "./project-list.js";
import { egressDepsOf, getAppProject } from "./project-archive-setup.js";

/**
 * `GET /v1/app/github/repositories?installation=<id>` (Plan 2, Task 15): the repositories one of the org's installations reaches, each marked with
 * the project of the caller's that already uses it. An installation that is not the org's answers NOT_FOUND, as a missing one does.
 */
export async function listGithubRepositories(deps: DeveloperRouteDependencies, caller: DeveloperCaller, installation: string | null): Promise<{ repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string; project?: string }> }> {
  if (deps.githubConnect === undefined) throw agentXError("NOT_FOUND", "connecting GitHub is not set up in this deployment");
  if (installation === null || !/^[1-9][0-9]{0,14}$/.test(installation)) throw agentXError("CONFIG_INVALID", "installation: give the installation's id, from agentx github list");
  const { repositories } = await deps.githubConnect.listRepositories(caller, Number(installation));
  // Only the caller's own visible projects are named: another project's name is not theirs to learn.
  const roles = await visibleProjectRoles(deps, caller);
  const projectOf = new Map<string, string>();
  for (const name of [...roles.keys()].sort()) {
    const record = await latestProjectRecord(deps, caller.orgId, name);
    for (const repository of record?.definition.repositories ?? []) {
      const key = repositoryFullName(repository).toLowerCase();
      if (!projectOf.has(key)) projectOf.set(key, name);
    }
  }
  return { repositories: repositories.map((repository) => {
    const project = projectOf.get(repository.fullName.toLowerCase());
    return { ...repository, ...(project === undefined ? {} : { project }) };
  }) };
}

/** `PUT /v1/app/projects/{name}/settings` (Plan 2, Task 17): a maintainer's change to the project's settings, as a new revision. */
export async function putProjectSettings(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown, options: UpdateProjectSettingsOptions = {}): Promise<{ project: AppProjectDetail; warnings: string[] }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  if (deps.projectSettings === undefined) throw agentXError("NOT_FOUND", "project settings are not set up in this deployment");
  return updateProjectSettings({
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    cloud: deps.cloud === true,
    egress: egressDepsOf(deps),
    ...deps.projectSettings,
    allowedDomainAuthorityConditions: (who, project) => readAllowedDomainActorConditions({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName: deps.developer?.signInTableName ?? "", now: deps.now }, { orgId: who.orgId, project, actorId: who.developerId }),
    effectiveRole: async (who, project) => (await visibleProjectRoles(deps, who, project)).get(project),
    readProject: (who, project) => getAppProject(deps, who, project),
  }, caller, name, body, options);
}

/**
 * Meta repo lane A: `GET /v1/app/projects/{name}/meta-config` (what the file manages and the pending change), `POST .../apply`, `.../dismiss` and `.../check`
 * (a maintainer asks Rovara to read the meta repo's head again). The project's role comes from the same place the settings route reads it.
 */
export async function projectMetaConfigRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, action: string | undefined, method: string, body: unknown): Promise<StatusReply> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  if (deps.metaConfig === undefined) throw agentXError("NOT_FOUND", "the meta repo is not set up in this deployment");
  const answer = await routeMetaConfig({
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    now: deps.now,
    cloud: deps.cloud === true,
    effectiveRole: async (who, project) => (await visibleProjectRoles(deps, who, project)).get(project),
    ...deps.metaConfig,
  }, caller, name, { method, action, body });
  return new StatusReply(answer.status, answer.body as object);
}
