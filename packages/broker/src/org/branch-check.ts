// The default-branch check (0.5.16): before any setup work starts, Rovara reads each code repository's default branch on GitHub and says when it holds no files. Three things live here:
//   - `checkProjectBranches`  `GET /v1/app/projects/{name}/branch-check`: the answer (has files, empty, missing, no code at all, or unchecked) with the branches that do have code.
//   - `setProjectDefaultBranch`  `PUT /v1/app/projects/{name}/default-branch`: use another branch of one repository (a new project revision), with the same check on the branch chosen.
//   - `continueWithBranch`  `POST /v1/app/projects/{name}/branch-check/continue`: the person explicitly goes on with a branch that has no files. Stored as one item in the project's setup partition
//     (`SETUP_DRAFT#<project>` / `BRANCH_OK#<repository>`), good only for that exact repository and branch, so a new branch asks again and the project's erasure walk reaches it.
// `requireBranchesReady` is the gate a setup draft and a setup run start through: it refuses (WORKSPACE_NOT_READY) while a code repository's branch is empty, missing or has no code and the person has not
// chosen to continue. GitHub that cannot answer never blocks anything (the check is `unchecked`); only a repository another company's installation holds is refused. Every read goes through the asking
// company's own installation (decision 131): the repository is the project's own, and the probe's scope is the caller's org.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, codeRepositoriesOf, projectArchivedMessage, projectAllows, setupDraftKey, settingOriginOf, withSettingOrigins, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import {
  BRANCH_CHECK_REPOSITORIES_MAX, BRANCH_GATE_MESSAGE, ProjectDefinitionSchema, ContinueBranchBodySchema, SetDefaultBranchBodySchema, repositoryHostOf,
  type AppProjectDetail, type BranchCheckResponse, type RepositoryBranchCheck, type StoredProjectDefinition,
} from "@agentx/cloud-contracts";
import type { RepositoryBranchProbe } from "../github-app.js";
import { latestRevision, ManagedByFileError, PROJECT_SETTINGS_ADMIN_MANAGED, PROJECT_SETTINGS_INSTALL_MANAGED, resolveRepository, SETTINGS_STALE_MESSAGE } from "./project-settings.js";
import { readProjectMeta } from "../developer/project-roles.js";
import type { TransactItem } from "../audit/outbox.js";

type Repository = StoredProjectDefinition["repositories"][number];
export interface BranchCheckCaller { developerId: string; orgId: OrgId }

export interface BranchCheckDependencies<Caller extends BranchCheckCaller = BranchCheckCaller> {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Rovara Cloud only: another install's projects are changed by an administrator. */
  cloud: boolean;
  now: () => number;
  /** The caller's role in the project, or undefined when they have no access (an org owner or admin is a maintainer of every project of the org). */
  effectiveRole(caller: Caller, project: string): Promise<ProjectRole | undefined>;
  /** What GitHub holds for one repository's branch, read through the org's own installation. Absent where GitHub cannot be asked: every repository is then `unchecked`. */
  probe?: ((orgId: OrgId, repositoryUrl: string, branch: string) => Promise<RepositoryBranchProbe>) | undefined;
  /** Registers one revision (the settings save's own registration). Absent: choosing another branch answers NOT_FOUND. */
  registerRevision?: ((actor: { orgId: OrgId; ownerKey: string }, input: { definition: ReturnType<typeof ProjectDefinitionSchema.parse>; runtimeBinding: unknown }, extraItems?: TransactItem[]) => Promise<void>) | undefined;
  /** What the app shows of the project once the change is saved. */
  readProject?: ((caller: Caller, project: string) => Promise<AppProjectDetail>) | undefined;
}

const okKey = (orgId: OrgId, project: string, repository: string) => ({ pk: setupDraftKey(orgId, project).pk, sk: `BRANCH_OK#${repository}` });
const fullNameOf = (repository: { name: string; url: string }): string => {
  try {
    const parts = new URL(repository.url).pathname.replace(/\.git$/u, "").split("/").filter(Boolean);
    if (parts.length === 2) return parts.join("/");
  } catch { /* fall through to the name */ }
  return repository.name;
};
const isGithub = (repository: Repository): boolean => repositoryHostOf(repository).kind === "github";

async function maintainerOf<Caller extends BranchCheckCaller>(deps: BranchCheckDependencies<Caller>, caller: Caller, name: string): Promise<ProjectRole> {
  const role = await deps.effectiveRole(caller, name);
  if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can check or change its default branch");
  return role;
}

/** The state of a repository's branch from what GitHub said. `no_code` only when every branch was looked at and none has files. */
export function branchStateOf(probe: RepositoryBranchProbe): RepositoryBranchCheck["state"] {
  if (probe.branch !== undefined && !probe.branch.empty) return "has_files";
  if (probe.others.length === 0 && probe.searchedAll) return "no_code";
  return probe.branch === undefined ? "missing" : "empty";
}

async function probeOne(deps: Pick<BranchCheckDependencies, "probe">, orgId: OrgId, repository: Repository): Promise<RepositoryBranchProbe | undefined> {
  if (deps.probe === undefined) return undefined;
  try {
    return await deps.probe(orgId, repository.url, repository.defaultBranch);
  } catch (error) {
    // A repository another company's installation holds, or one this company's connection no longer reaches, is refused. Everything else (GitHub down, slow, odd answers) fails open as `unchecked`.
    if (error instanceof AgentXError && error.code === "GITHUB_NOT_CONNECTED") throw error;
    console.log(JSON.stringify({ component: "broker", event: "branch_check.unchecked", orgId, code: error instanceof AgentXError ? error.code : "UNKNOWN" }));
    return undefined;
  }
}

async function continuedOn(deps: Pick<BranchCheckDependencies, "documentClient" | "tableName">, orgId: OrgId, project: string, repository: Repository): Promise<boolean> {
  const stored = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: okKey(orgId, project, repository.name), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  return stored.Item?.["branch"] === repository.defaultBranch;
}

async function checkRepositories(deps: Pick<BranchCheckDependencies, "documentClient" | "tableName" | "probe">, orgId: OrgId, project: string, definition: StoredProjectDefinition): Promise<BranchCheckResponse> {
  const repositories = codeRepositoriesOf(definition).filter(isGithub).slice(0, BRANCH_CHECK_REPOSITORIES_MAX);
  const rows = await Promise.all(repositories.map(async (repository): Promise<RepositoryBranchCheck> => {
    const probe = await probeOne(deps, orgId, repository);
    const continued = await continuedOn(deps, orgId, project, repository);
    const base = { repository: repository.name, fullName: fullNameOf(repository), branch: repository.defaultBranch, continued };
    if (probe === undefined) return { ...base, state: "unchecked", alternatives: [], searchedAll: false };
    const state = branchStateOf(probe);
    return { ...base, state, alternatives: state === "has_files" ? [] : probe.others.map(({ name, lastCommitAt }) => ({ name, ...(lastCommitAt === undefined ? {} : { lastCommitAt }) })), searchedAll: probe.searchedAll };
  }));
  const blocked = rows.some((row) => (row.state === "empty" || row.state === "missing" || row.state === "no_code") && !row.continued);
  return { revision: definition.revision, repositories: rows, blocked };
}

/** `GET /v1/app/projects/{name}/branch-check`: a maintainer's view of each code repository's default branch. */
export async function checkProjectBranches<Caller extends BranchCheckCaller>(deps: BranchCheckDependencies<Caller>, caller: Caller, name: string): Promise<BranchCheckResponse> {
  await maintainerOf(deps, caller, name);
  const latest = await latestRevision(deps, caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  return checkRepositories(deps, caller.orgId, name, latest.definition);
}

/**
 * The gate a setup draft and a setup run start through (the caller has already been checked as a maintainer). Refuses with WORKSPACE_NOT_READY while a code repository's branch is empty, missing or has no
 * code and the person has not chosen to go on; an `unchecked` answer lets the start through, because it is the person's own press and GitHub being down is no reason to stop it.
 */
export async function requireBranchesReady<Caller extends BranchCheckCaller>(deps: BranchCheckDependencies<Caller>, caller: Caller, name: string): Promise<void> {
  const latest = await latestRevision(deps, caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  if ((await checkRepositories(deps, caller.orgId, name, latest.definition)).blocked) throw agentXError("WORKSPACE_NOT_READY", BRANCH_GATE_MESSAGE);
}

/** `POST /v1/app/projects/{name}/branch-check/continue`: the person goes on with the repository's current branch as it is. */
export async function continueWithBranch<Caller extends BranchCheckCaller>(deps: BranchCheckDependencies<Caller>, caller: Caller, name: string, rawBody: unknown): Promise<BranchCheckResponse> {
  await maintainerOf(deps, caller, name);
  const parsed = ContinueBranchBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const latest = await latestRevision(deps, caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const repository = resolveRepository(latest.definition.repositories, parsed.data.repository);
  if (repository === undefined || !isGithub(repository)) throw agentXError("CONFIG_INVALID", "repository: is not a repository of this project");
  // Only the branch the project has now: a choice made for a branch the project has since left is not a choice for this one.
  if (repository.defaultBranch !== parsed.data.branch) throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
  await deps.documentClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: { ...okKey(caller.orgId, name, repository.name), entityType: "SETUP_BRANCH_OK", orgId: caller.orgId, project: name, repository: repository.name, branch: repository.defaultBranch, by: caller.developerId, at: new Date(deps.now()).toISOString() },
  }));
  return checkRepositories(deps, caller.orgId, name, latest.definition);
}

/** `PUT /v1/app/projects/{name}/default-branch`: use another branch of one repository, as the project's next revision. The branch must be in the repository; whether it has files is told in the answer, not refused. */
export async function setProjectDefaultBranch<Caller extends BranchCheckCaller>(deps: BranchCheckDependencies<Caller>, caller: Caller, name: string, rawBody: unknown): Promise<{ project: AppProjectDetail; check: BranchCheckResponse }> {
  await maintainerOf(deps, caller, name);
  if (!deps.cloud) throw agentXError("FORBIDDEN", PROJECT_SETTINGS_INSTALL_MANAGED);
  if (deps.registerRevision === undefined || deps.readProject === undefined || deps.probe === undefined) throw agentXError("NOT_FOUND", "changing the default branch is not set up in this deployment");
  const parsed = SetDefaultBranchBodySchema.safeParse(rawBody);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", `${parsed.error.issues[0]?.path.join(".") || "body"}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const body = parsed.data;
  if ((await readProjectMeta(deps, caller.orgId, name))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(name));
  const latest = await latestRevision(deps, caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const current = latest.definition;
  if (current.revision !== body.expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
  if (current.e2e !== undefined || latest.setupApproval !== undefined) throw agentXError("FORBIDDEN", PROJECT_SETTINGS_ADMIN_MANAGED);
  if (settingOriginOf(current, "repositories") === "file") throw new ManagedByFileError(["repositories"]);
  const repository = resolveRepository(current.repositories, body.repository);
  if (repository === undefined || !isGithub(repository)) throw agentXError("CONFIG_INVALID", "repository: is not a repository of this project");
  if (repository.defaultBranch === body.branch) return { project: await deps.readProject(caller, name), check: await checkRepositories(deps, caller.orgId, name, current) };
  // The same check, on the branch chosen: it has to be in the repository, and a GitHub that cannot answer is a retry (the branch is not guessed).
  let probe: RepositoryBranchProbe;
  try {
    probe = await deps.probe(caller.orgId, repository.url, body.branch);
  } catch (error) {
    if (error instanceof AgentXError && error.code === "GITHUB_NOT_CONNECTED") throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "GitHub could not be reached just now; try again in a moment");
  }
  if (probe.branch === undefined) throw agentXError("CONFIG_INVALID", "branch: is not a branch of this repository");
  const next: Record<string, unknown> = { ...current, revision: current.revision + 1, repositories: current.repositories.map((entry) => entry === repository ? { ...entry, defaultBranch: body.branch } : entry) };
  const changedOrigins = withSettingOrigins(current.origins, ["repositories"], "person");
  if (changedOrigins === undefined) delete next["origins"]; else next["origins"] = changedOrigins;
  const definition = ProjectDefinitionSchema.safeParse(next);
  if (!definition.success) throw agentXError("CONFIG_INVALID", `${definition.error.issues[0]?.path.join(".") || "body"}: ${definition.error.issues[0]?.message ?? "invalid"}`);
  try {
    await deps.registerRevision({ orgId: caller.orgId, ownerKey: caller.developerId }, { definition: definition.data, runtimeBinding: latest.runtimeBinding });
  } catch (error) {
    if (error instanceof AgentXError && error.code === "PROJECT_REVISION_MISMATCH") throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
    throw error;
  }
  console.log(JSON.stringify({ component: "broker", event: "developer.project_default_branch_changed", orgId: caller.orgId, project: name, revision: definition.data.revision }));
  const row: RepositoryBranchCheck = {
    repository: repository.name, fullName: fullNameOf(repository), branch: body.branch, state: branchStateOf(probe), continued: false, searchedAll: probe.searchedAll,
    alternatives: probe.branch.empty ? probe.others.map(({ name, lastCommitAt }) => ({ name, ...(lastCommitAt === undefined ? {} : { lastCommitAt }) })) : [],
  };
  const others = (await checkRepositories(deps, caller.orgId, name, definition.data)).repositories.filter((entry) => entry.repository !== repository.name);
  const rows = [row, ...others];
  return { project: await deps.readProject(caller, name), check: { revision: definition.data.revision, repositories: rows, blocked: rows.some((entry) => (entry.state === "empty" || entry.state === "missing" || entry.state === "no_code") && !entry.continued) } };
}
