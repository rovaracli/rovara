import { directDomainReceiptKey, domainRequestHash, planLegacyDomainNarrowing } from "./legacy-domain-narrowing.js";
import { flushAuditEvents } from "../audit/flush.js";
import type { TransactItem } from "../audit/outbox.js";
import { isAllowedDomainWidening, refuseAllowedDomainWidening } from "./allowed-domain-policy.js";
// Plan 2, Task 17: a project maintainer changes the project's commands, devcontainer, repositories, allowed domains and description.
// Each change but the description is a new immutable revision, built from the one the person was looking at (`expectedRevision`) and
// registered through the same code every project revision goes through. Cloud only: another install's projects change through an administrator.
import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, DEFAULT_AGENT_ALLOW_DOMAINS, PROJECT_REVISION_SK_PREFIX, ProjectDefinitionSchema, ProjectSettingsBodySchema, SETUP_TIMEOUT, StoredProjectDefinitionSchema, TEST_TIMEOUT, agentXError, errorStatus, projectArchivedMessage, canonicalJson, githubNotConnectedMessage, keepStoredOptions, orgPk, parseCommandLine, projectAllows, projectMetaKey, projectPk, settingOriginOf, withSettingOrigins, type ProjectOriginField, type AppProjectDetail, type OrgId, type ProjectCommand, type ProjectDefinition, type ProjectRole, type ProjectSettingsBody, type StoredProjectDefinition } from "@rovara-code/contracts";
import { githubInstallationKey, type OrgRole } from "@agentx/cloud-contracts";
import { readProjectMeta } from "../developer/project-roles.js";
import { cloudRepositoryEntry } from "./cloud-projects.js";
import { egressStatusWarnings, putEgressDomains, readEgressDomains, type EgressDomainsDependencies } from "./egress-domains.js";

/** Who changes the settings, and in which org. */
/**
 * UX-4b: the two refusals that used to end in a command line. They say who changes the setting and where, in words a maintainer can act on; the setup page names the company's administrators beside them.
 * (The administrator's own tool is `agentx admin project register`, which the operator docs describe.)
 */
export const PROJECT_SETTINGS_INSTALL_MANAGED = "This installation keeps project settings in its own configuration, so they can't be changed in the web app. A company administrator changes them for you.";
export const PROJECT_SETTINGS_ADMIN_MANAGED = "This project has an end-to-end policy or a setup approval, so only a company administrator can change its settings. Ask one of them to make this change.";

export interface ProjectSettingsCaller { developerId: string; orgId: OrgId; orgRole: OrgRole }

/** The repository GitHub's App sees, as `getRepositoryIdentity` describes it. */
export interface RepositoryIdentity { fullName: string; defaultBranch?: string | undefined; repositoryId?: number | undefined }

export interface ProjectSettingsDependencies<Caller extends ProjectSettingsCaller = ProjectSettingsCaller> {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Rovara Cloud only: another install's projects are changed by an administrator. */
  cloud: boolean;
  /** The caller's role in the project (an org owner or admin is a maintainer of every project of the org), or undefined when they have no access. */
  effectiveRole(caller: Caller, project: string): Promise<ProjectRole | undefined>;
  /** Registers one revision through the broker's registration (`registerProjectFor`, with no creator membership). */
  registerRevision(actor: { orgId: OrgId; ownerKey: string }, input: { definition: ProjectDefinition; runtimeBinding: unknown }, extraItems?: TransactItem[]): Promise<void>;
  allowedDomainAuthorityConditions?(caller: Caller, project: string): Promise<TransactItem[]>;
  /**
   * Plan 2, Task 18: where the allowed domains are recorded. A domain waits there for Rovara's approval (on cloud) and is audited. Required:
   * a save that cannot record its domains must not look as if it did.
   */
  egress: EgressDomainsDependencies;
  /** What the app shows of the project once the change is saved. */
  readProject(caller: Caller, project: string): Promise<AppProjectDetail>;
  /** Called once a save has removed repositories from the project (best effort; a failure never undoes the save). Lessons in the repo: the open Rovara pull requests of a repository that left are closed at once. */
  repositoriesRemoved?(caller: Caller, project: string): Promise<void>;
  /** The credential an added repository uses: the foundation's built-in GitHub App credential. */
  githubCredentialRef?: string;
  /** GitHub's own view of a repository (its spelling and default branch), through the App. Absent when GitHub cannot be asked. */
  repositoryIdentity?(url: string, orgId: OrgId): Promise<RepositoryIdentity | undefined>;
  /**
   * Whether the org's GitHub connection reaches a repository; throws GITHUB_NOT_CONNECTED when not. Defaults to
   * `requireRepositoryConnectedByRecords`; Plan 2, Task 15's `requireRepositoryConnected` replaces it.
   */
  requireRepositoryConnected?(orgId: OrgId, owner: string, repository: string): Promise<{ installationId: number; githubRepositoryId?: number }>;
}

export const SETTINGS_STALE_MESSAGE = "someone changed this project's settings; reload and try again";

/** What a refusal to reach a repository through the org's GitHub connection says (ruling: Plan 2, Task 15's wording). */
export { githubNotConnectedMessage };

const withoutCode = (error: AgentXError) => error.message.replace(new RegExp(`^${error.code}: `), "");
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);

/**
 * The commands a settings save stores for a list of command lines: each parsed to one program in the project's first repository's directory, with the list's own timeout and no env (a line that is one of the `stored` commands is that command, with its own timeout, env and directory). The save uses this and
 * so does the check of a setup draft's commands (rovara-code/setup-draft-check.ts), so what is checked is exactly what is stored.
 */
export function settingsCommands(field: "setupCommands" | "testCommands", lines: readonly string[], cwd: string, timeoutSeconds: number, stored: readonly ProjectCommand[] = []): ProjectCommand[] {
  return keepStoredOptions(lines.map((line, index) => {
    try {
      return parseCommandLine(line, cwd, timeoutSeconds);
    } catch (error) {
      if (error instanceof AgentXError) throw invalid(`${field}.${String(index)}: ${withoutCode(error)}`);
      throw error;
    }
  }), stored);
}

/** What a project's repository is called to a person: GitHub's `owner/name`, from its URL. */
function fullNameOf(repository: { name: string; url: string }): string {
  try {
    const parts = new URL(repository.url).pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length === 2) return parts.join("/");
  } catch { /* fall through to the name */ }
  return repository.name;
}

/**
 * The org's GitHub connection reaches a repository when an active installation bound to this org belongs to the repository's owner and covers
 * every repository of that account. Both bindings are read (the org's own and the global one that makes the installation one org's), so an
 * installation another org has claimed, or one that was suspended or removed, reaches nothing. An installation limited to selected
 * repositories needs GitHub to say which, which only Task 15's `requireRepositoryConnected` can ask: until then it is refused.
 */
export async function requireRepositoryConnectedByRecords(
  deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string },
  orgId: OrgId,
  owner: string,
  repository: string,
): Promise<{ installationId: number }> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "GITHUB_INSTALLATION#" },
    ConsistentRead: true,
  })) as { Items?: Array<{ entityType?: unknown; installationId?: unknown; accountLogin?: unknown; status?: unknown; repositorySelection?: unknown }> };
  for (const item of response.Items ?? []) {
    if (item.entityType !== "GITHUB_INSTALLATION" || item.status !== "active" || item.repositorySelection !== "all") continue;
    if (typeof item.accountLogin !== "string" || item.accountLogin.toLowerCase() !== owner.toLowerCase()) continue;
    if (typeof item.installationId !== "number" || !Number.isSafeInteger(item.installationId)) continue;
    const global = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: githubInstallationKey(item.installationId), ConsistentRead: true })) as { Item?: { orgId?: unknown; status?: unknown } };
    if (global.Item?.orgId === orgId && global.Item.status === "active") return { installationId: item.installationId };
  }
  throw agentXError("GITHUB_NOT_CONNECTED", githubNotConnectedMessage(`${owner}/${repository}`));
}

export interface LatestRevision { definition: StoredProjectDefinition; runtimeBinding: unknown; setupApproval?: unknown }

/** The project's newest revision, read consistently; undefined when it has none or the newest cannot be read. */
export async function latestRevision(deps: Pick<ProjectSettingsDependencies, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<LatestRevision | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition?: unknown; runtimeBinding?: unknown; setupApproval?: unknown }> };
  const item = response.Items?.[0];
  if (item === undefined) return undefined;
  const definition = StoredProjectDefinitionSchema.safeParse(item.definition);
  if (!definition.success) return undefined;
  return { definition: definition.data, runtimeBinding: item.runtimeBinding, ...(item.setupApproval === undefined ? {} : { setupApproval: item.setupApproval }) };
}

const SETTING_FIELDS = ["description", "setupCommands", "testCommands", "devcontainer", "allowedDomains", "addRepositories", "removeRepositories"] as const;

/** The body, or CONFIG_INVALID naming the field (and index) and what is wrong with it, never the value. */
export function parseProjectSettingsBody(body: unknown): ProjectSettingsBody {
  const parsed = ProjectSettingsBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  if (SETTING_FIELDS.every((field) => parsed.data[field] === undefined)) throw invalid("body: give at least one setting to change");
  return parsed.data;
}

type Repository = StoredProjectDefinition["repositories"][number];

/** The repository an entry means: its name in the project, or its GitHub `owner/name`, compared without regard to case. */
export function resolveRepository(repositories: readonly Repository[], entry: string): Repository | undefined {
  const wanted = entry.toLowerCase();
  return repositories.find((repository) => repository.name.toLowerCase() === wanted || fullNameOf(repository).toLowerCase() === wanted);
}

async function identityOf(deps: Pick<ProjectSettingsDependencies, "repositoryIdentity">, orgId: OrgId, fullName: string): Promise<RepositoryIdentity | undefined> {
  if (deps.repositoryIdentity === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "adding a repository is not set up in this deployment; ask Rovara support");
  try {
    return await deps.repositoryIdentity(`https://github.com/${fullName}.git`, orgId);
  } catch (error) {
    if (error instanceof TypeError) {
      // GitHub answers a renamed or transferred repository with a redirect the lookup refuses; a failed connection rejects the same way.
      const cause = error.cause instanceof Error ? error.cause.message : undefined;
      if (cause === "unexpected redirect") throw invalid(`GitHub moved or renamed ${fullName}; use its current owner/name`);
      if (error.message === "fetch failed") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub could not be reached just now; try again in a moment");
    }
    throw error;
  }
}

/** The repositories after the change: the project's own, the removed ones gone and the added ones appended. */
async function changedRepositories(
  deps: Pick<ProjectSettingsDependencies, "documentClient" | "tableName" | "repositoryIdentity" | "githubCredentialRef" | "requireRepositoryConnected">,
  caller: ProjectSettingsCaller,
  current: readonly Repository[],
  body: ProjectSettingsBody,
): Promise<{ repositories: Repository[]; removed: Repository[] }> {
  const added: Array<{ index: number; owner: string; name: string }> = [];
  for (const [index, entry] of (body.addRepositories ?? []).entries()) {
    const [owner, rawName] = entry.split("/") as [string, string];
    const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
    const duplicate = resolveRepository(current, `${owner}/${name}`) !== undefined
      || added.some((other) => other.owner.toLowerCase() === owner.toLowerCase() && other.name.toLowerCase() === name.toLowerCase());
    if (duplicate) throw invalid(`addRepositories.${String(index)}: is already a repository of this project`);
    added.push({ index, owner, name });
  }
  const removed: Repository[] = [];
  for (const [index, entry] of (body.removeRepositories ?? []).entries()) {
    const repository = resolveRepository(current, entry);
    if (repository === undefined) throw invalid(`removeRepositories.${String(index)}: is not a repository of this project`);
    if (!removed.includes(repository)) removed.push(repository);
  }
  // Every added repository must be reached through the org's own GitHub connection before GitHub is asked anything about it.
  const connected: NonNullable<ProjectSettingsDependencies["requireRepositoryConnected"]> = deps.requireRepositoryConnected ?? ((orgId, owner, repository) => requireRepositoryConnectedByRecords(deps, orgId, owner, repository));
  const connections = new Map<number, { installationId: number; githubRepositoryId: number }>();
  for (const { index, owner, name } of added) {
    const answer = await connected(caller.orgId, owner, name);
    // What the connection answered is pinned on the entry (Task 16), as for a created project; the by-records default answers no repository id, so pins nothing.
    if (answer.githubRepositoryId !== undefined) connections.set(index, { installationId: answer.installationId, githubRepositoryId: answer.githubRepositoryId });
  }
  const entries: Repository[] = [];
  for (const { index, owner, name } of added) {
    const identity = await identityOf(deps, caller.orgId, `${owner}/${name}`);
    if (identity === undefined) throw invalid(`addRepositories.${String(index)}: the GitHub App cannot see ${owner}/${name}; check the name`);
    if (identity.defaultBranch === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub did not describe that repository; try again");
    const githubCredentialRef = deps.githubCredentialRef;
    if (githubCredentialRef === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "adding a repository is not set up in this deployment; ask Rovara support");
    const connection = connections.get(index);
    entries.push(cloudRepositoryEntry({ repositoryName: name, repository: { fullName: identity.fullName, defaultBranch: identity.defaultBranch }, githubCredentialRef, ...(connection === undefined ? {} : { connection }) }));
  }
  return { repositories: [...current.filter((repository) => !removed.includes(repository)), ...entries], removed };
}

/**
 * Who a save is made on behalf of. A person's own save (the default, and the only one the settings route makes) marks what it changes as the person's; the setup agent's
 * proposal, applied by a maintainer, marks what it changes `agent`, so a later import or draft can tell Rovara's value from one a person typed. It is an option of the
 * function, never of the request body: no caller can claim it over HTTP.
 */
export interface UpdateProjectSettingsOptions {
  origin?: "person" | "agent";
  /** Conditions that commit with the revision (a ConditionCheck on a record the write depends on): when one fails nothing is written. Set by the settings proof for a held change, never by a request. */
  guardItems?: TransactItem[];
}

/** A save that touched settings the meta repo's config file manages. A typed refusal, so callers need not read the words; it answers 403 FORBIDDEN as it always did. */
export class ManagedByFileError extends AgentXError {
  constructor(readonly fields: readonly ProjectOriginField[]) {
    super("FORBIDDEN", `${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} managed by the meta repo's config file; change ${fields.length === 1 ? "it" : "them"} there`, errorStatus("FORBIDDEN"));
  }
}

/**
 * Registers the settings as the project's next revision (`expectedRevision + 1`), applying only the fields given, and answers the project as
 * the app shows it, with a warning for each allowed domain every project already has. A body that changes nothing in the revision (or only
 * the description) writes no revision; a description is the project's META record only.
 *
 * Order: no access is a 404, a role that may not edit settings a 403, then a non-cloud install a 403; then the body, the revision the person
 * saw, and every refusal that needs no write; the writes come last, so a refusal leaves the project as it was.
 */
export async function updateProjectSettings<Caller extends ProjectSettingsCaller>(
  deps: ProjectSettingsDependencies<Caller>,
  caller: Caller,
  name: string,
  rawBody: unknown,
  options: UpdateProjectSettingsOptions = {},
): Promise<{ project: AppProjectDetail; warnings: string[] }> {
  const role = await deps.effectiveRole(caller, name);
  if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can change its settings");
  if (!deps.cloud) throw agentXError("FORBIDDEN", PROJECT_SETTINGS_INSTALL_MANAGED);
  // An archived project's settings are as they were when it was archived; restoring it is how they change again (Task 20).
  if ((await readProjectMeta(deps, caller.orgId, name))?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(name));
  const body = parseProjectSettingsBody(rawBody);
  const domainAuthority = body.allowedDomains === undefined ? undefined : await deps.allowedDomainAuthorityConditions?.(caller, name);
  const recoverOwnedDomainReceipt = async (): Promise<boolean> => {
    if (body.allowedDomains === undefined) return false;
    const key = directDomainReceiptKey(caller.orgId, name, body.requestId);
    const stored = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    if (stored === undefined) return false;
    // Recovery is status-only and still requires fresh live access. A matching
    // immutable revision alone never proves that this request's effects landed.
    if (await deps.allowedDomainAuthorityConditions?.(caller, name) === undefined) throw agentXError("FORBIDDEN", "Live website change authority is required.");
    if (stored.entityType !== "EGRESS_PROPOSAL" || stored.orgId !== caller.orgId || stored.project !== name || stored.by !== caller.developerId || stored.bodyHash !== domainRequestHash(caller.orgId, name, caller.developerId, body)
      || stored.state !== "applied" || stored.mode !== "direct_narrowing" || stored.baseRevision !== body.expectedRevision || stored.resultRevision !== body.expectedRevision + 1) throw agentXError("IDEMPOTENCY_CONFLICT", "Use a fresh request id for a different website change.");
    return true;
  };
  if (await recoverOwnedDomainReceipt()) return { project: await deps.readProject(caller, name), warnings: [] };

  const latest = await latestRevision(deps, caller.orgId, name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const current = latest.definition;
  if (current.revision !== body.expectedRevision) throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
  if (deps.cloud && body.allowedDomains !== undefined && isAllowedDomainWidening(current.network?.allowedDomains ?? [], body.allowedDomains)) refuseAllowedDomainWidening();
  if (current.e2e !== undefined || latest.setupApproval !== undefined) {
    throw agentXError("FORBIDDEN", PROJECT_SETTINGS_ADMIN_MANAGED);
  }

  // Meta repo lane A: a setting the meta repo's config file manages is changed by changing the file, so a save that touches one is refused before anything is read from GitHub.
  const touched: ProjectOriginField[] = [];
  if (body.setupCommands !== undefined) touched.push("setup");
  if (body.testCommands !== undefined) touched.push("readiness");
  if (body.devcontainer !== undefined) touched.push("devcontainer");
  if (body.allowedDomains !== undefined) touched.push("network");
  if (body.addRepositories !== undefined || body.removeRepositories !== undefined) touched.push("repositories");
  const managed = touched.filter((field) => settingOriginOf(current, field) === "file");
  if (managed.length > 0) throw new ManagedByFileError(managed);

  const { repositories, removed } = await changedRepositories(deps, caller, current.repositories, body);
  if (repositories.length === 0) throw invalid("removeRepositories: a project keeps at least one repository");

  const next: Record<string, unknown> = { ...current, revision: current.revision + 1, repositories };
  if (body.devcontainer !== undefined) {
    if (body.devcontainer === null) delete next.devcontainer;
    else {
      const repository = resolveRepository(repositories, body.devcontainer.repository);
      if (repository === undefined) throw invalid("devcontainer.repository: is not a repository of this project");
      next.devcontainer = { repository: repository.name, ...(body.devcontainer.configPath === undefined ? {} : { configPath: body.devcontainer.configPath }) };
    }
  }
  const devcontainer = next.devcontainer as { repository: string } | undefined;
  for (const [index, entry] of (body.removeRepositories ?? []).entries()) {
    const repository = resolveRepository(current.repositories, entry)!;
    if (devcontainer?.repository === repository.name && removed.includes(repository)) {
      throw invalid(`removeRepositories.${String(index)}: is the devcontainer's repository; change the devcontainer first`);
    }
  }
  // Commands run in the project's first repository, the way the one repository of a created project is.
  const cwd = repositories[0]!.path;
  // A line that is one of the stored commands keeps its own timeout, env and directory; any other line takes the list's defaults. With repositories changing in the same save the commands may be re-anchored, so none is kept.
  const keptCommands = body.addRepositories !== undefined || body.removeRepositories !== undefined ? { setup: [], readiness: [] } : { setup: current.setup, readiness: current.readiness };
  if (body.setupCommands !== undefined) next.setup = settingsCommands("setupCommands", body.setupCommands, cwd, SETUP_TIMEOUT, keptCommands.setup);
  if (body.testCommands !== undefined) next.readiness = settingsCommands("testCommands", body.testCommands, cwd, TEST_TIMEOUT, keptCommands.readiness);
  // A command the save keeps still runs where it did; one whose repository is removed would run in a directory that is gone.
  for (const [index, entry] of (body.removeRepositories ?? []).entries()) {
    const path = resolveRepository(current.repositories, entry)!.path;
    const kept = [...(next.setup as Array<{ cwd: string }>), ...(next.readiness as Array<{ cwd: string }>)];
    if (kept.some((command) => command.cwd === path || command.cwd.startsWith(`${path}/`))) {
      throw invalid(`removeRepositories.${String(index)}: commands run in it; replace setupCommands and testCommands in the same save`);
    }
  }
  const domains = body.allowedDomains === undefined ? undefined : [...new Set(body.allowedDomains)];
  if (domains !== undefined) {
    if (domains.length === 0) delete next.network;
    else next.network = { allowedDomains: domains };
  }

  // What a person changes is theirs again: a setting an agent or the config file had set loses that mark (a field with no mark was set by a person). What the setup agent's
  // proposal changes (applied by a maintainer, with `origin: "agent"`) is marked `agent`.
  const personChanged = touched.filter((field) => canonicalJson((current as Record<string, unknown>)[field] ?? null) !== canonicalJson(next[field] ?? null));
  if (personChanged.length > 0) {
    const origins = withSettingOrigins(current.origins, personChanged, options.origin ?? "person");
    if (origins === undefined) delete next.origins; else next.origins = origins;
  }

  const parsed = ProjectDefinitionSchema.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const warnings = (domains ?? []).filter((domain) => DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain)).map((domain) => `${domain} is already allowed for every project`);

  // A revision identical to the current one but for its number says nothing new; the project stays at the revision the person saw.
  const previous = ProjectDefinitionSchema.safeParse(current);
  const withoutRevision = (definition: unknown) => canonicalJson({ ...(definition as Record<string, unknown>), revision: 0 });
  const changed = !previous.success || withoutRevision(previous.data) !== withoutRevision(parsed.data);
  const beforeDomains = [...new Set(current.network?.allowedDomains ?? [])].sort();
  const afterDomains = [...new Set(parsed.data.network?.allowedDomains ?? [])].sort();
  const domainChanged = canonicalJson(beforeDomains) !== canonicalJson(afterDomains);
  if (domainChanged && domainAuthority === undefined) throw agentXError("FORBIDDEN", "Live website change authority is required.");
  const domainPlan = domainChanged && domainAuthority !== undefined ? await planLegacyDomainNarrowing({ ...deps.egress }, {
    orgId: caller.orgId, project: name, by: caller.developerId, body, before: beforeDomains, after: afterDomains, authority: domainAuthority,
  }) : undefined;
  // Actual website changes commit with revision/audit. Existing no-change repair
  // remains in its legacy path and cannot authorize new desired domains.
  const egressWarnings = domainPlan === undefined ? await recordEgress(deps.egress, caller, name, afterDomains) : [];
  if (changed) {
    try {
      const extraItems = [...(domainPlan?.items ?? []), ...(options.guardItems ?? [])];
      await deps.registerRevision({ orgId: caller.orgId, ownerKey: caller.developerId }, { definition: parsed.data, runtimeBinding: latest.runtimeBinding }, extraItems.length === 0 ? undefined : extraItems);
    } catch (error) {
      // Another save took this revision number first (its content differs), or the catalog moved under this one.
      if (domainPlan === undefined || !await recoverOwnedDomainReceipt()) {
        if (error instanceof AgentXError && error.code === "PROJECT_REVISION_MISMATCH") throw agentXError("PROJECT_REVISION_MISMATCH", SETTINGS_STALE_MESSAGE);
        throw error;
      }
    }
  }
  if (domainPlan !== undefined) await flushAuditEvents(deps.egress, [domainPlan.event]);
  if (body.description !== undefined && domainPlan === undefined) await writeDescription(deps, caller.orgId, name, body.description);
  warnings.push(...egressWarnings);
  if (changed && removed.length > 0) await deps.repositoriesRemoved?.(caller, name).catch(() => undefined);
  console.log(JSON.stringify({
    component: "broker", event: "developer.project_settings_changed", orgId: caller.orgId, project: name, revision: changed ? parsed.data.revision : current.revision,
    changed: SETTING_FIELDS.filter((field) => body[field] !== undefined),
  }));
  return { project: await deps.readProject(caller, name), warnings };
}

/**
 * Makes the project's egress item match the domains the project now has, and answers what the person is told: each domain still waiting for
 * Rovara, each one Rovara refused, and that the firewall will follow within 5 minutes when it could not be told at once. It runs on every
 * save, whatever the save changed, and BEFORE the revision is written (ruling C29): a project whose domains were stored before approvals existed asks
 * for them on its next save, and the scheduled reconcile puts the item right after a save whose revision then failed to land. With no item
 * and no domains it reads once and writes nothing. Domains every project already has are not asked about.
 */
async function recordEgress(egress: EgressDomainsDependencies, caller: ProjectSettingsCaller, project: string, domains: readonly string[]): Promise<string[]> {
  const owner = { kind: "project", project } as const;
  const asked = domains.filter((domain) => !DEFAULT_AGENT_ALLOW_DOMAINS.includes(domain));
  const { warning } = await putEgressDomains(egress, caller.orgId, owner, asked, { developerId: caller.developerId });
  if (asked.length === 0) return warning === undefined ? [] : [warning];
  return [...egressStatusWarnings(await readEgressDomains(egress, caller.orgId, owner), asked), ...(warning === undefined ? [] : [warning])];
}

/**
 * Sets (or, when empty, removes) the description on the project's META item. A project that predates META gets one, as active and created by
 * "unknown", which is how it already reads.
 */
async function writeDescription(deps: Pick<ProjectSettingsDependencies, "documentClient" | "tableName">, orgId: OrgId, project: string, description: string): Promise<void> {
  const empty = description.trim() === "";
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName,
    Key: projectMetaKey(orgId, project),
    UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), #name = if_not_exists(#name, :name), #status = if_not_exists(#status, :active), createdAt = if_not_exists(createdAt, :now), createdBy = if_not_exists(createdBy, :unknown)"
      + (empty ? " REMOVE description" : ", description = :description"),
    ExpressionAttributeNames: { "#name": "name", "#status": "status" },
    ExpressionAttributeValues: { ":entity": "PROJECT_META", ":name": project, ":active": "active", ":now": new Date().toISOString(), ":unknown": "unknown", ...(empty ? {} : { ":description": description.trim() }) },
  }));
}

// Lane B: internal read-only working-branch review; no route/save integration yet.
export { readProjectWorkingBranchPreview, type WorkingBranchReviewDependencies } from "./project-working-branch.js";
export { createWorkingBranchProvider, createWorkingBranchLister } from "./project-working-branch-provider.js";
export { readProjectWorkingBranchPage, type WorkingBranchListDependencies } from "./project-working-branch-list.js";

// Unexposed audited working-branch revision primitive. No HTTP/UI or consumer wiring.
export { commitReviewedProjectWorkingBranch, type WorkingBranchSaveDependencies } from "./project-working-branch-save.js";
// Lane B: unexposed cleanup prerequisite; company-close integration remains with lane A.
export { clearWorkingBranchSaveReceipts } from "./project-working-branch-receipt-cleanup.js";
