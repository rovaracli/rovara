import { logDeveloperEvent } from "../../developer/log.js";
import type { z } from "zod";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  CHANNEL_MEMBERS_MAX_CHANNELS,
  StoredProjectDefinitionSchema,
  MEMBER_GRANT_SK_PREFIX,
  PROJECT_REVISION_SK_PREFIX,
  SLACK_BINDING_SK_PREFIX,
  developerTaskPolicy,
  metaRepositoryOf,
  memberGrantsPk,
  orgProjectCatalogPk,
  projectPk,
  slackBindingPk,
  type AppProjectSummary,
  setupCheckErrorRef,
  type AppProjectsResponse,
  type ProjectRole,
  type ChannelInfoResponse,
  type ChannelMembersRequest,
  type ChannelMembersResponse,
  type DeveloperProjectsResponse,
  type DeveloperTaskPolicy,
  type OrgId,
  type SlackChannelBinding,
  SESSION_PROJECT_BINDINGS_MAX,
} from "@agentx/contracts";
import { resolveDeveloperAccess } from "../../developer/access.js";
import { effectiveProjectRole, grantRoleOf, grantedByOf, readProjectMeta, type ProjectMetaItem } from "../../developer/project-roles.js";
import { createProjectMembers, survivorOf, type ProjectMembers, type ProjectMembersDependencies } from "../../org/project-members.js";
import { setupStateOf, type SetupCheckDependencies } from "../../org/project-setup-check.js";
import type { DeveloperCaller, DeveloperRouteDependencies, ProjectAccessCaller } from "./types.js";
import { signInStoreOf } from "./common.js";
import { SLACK_UNAVAILABLE, errorName } from "./identity-lambda.js";

/** Every item under `pk` with the sort key prefix, following LastEvaluatedKey through each page. */
export async function queryAll<T>(deps: DeveloperRouteDependencies, pk: string, prefix: string, bound?: { max: number; onCut: () => void }): Promise<T[]> {
  const items: T[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      ConsistentRead: true,
    })) as { Items?: T[]; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = response.LastEvaluatedKey;
    // A bounded read stops at its cap, with what it has: the rest is not read, and the caller is told it was cut.
    if (bound !== undefined && items.length >= bound.max && (start !== undefined || items.length > bound.max)) {
      bound.onCut();
      return items.slice(0, bound.max);
    }
  } while (start !== undefined);
  return items;
}

/** Channel names are for display only: they never hold the projects list near a timeout. */
const CHANNEL_NAMES_DEADLINE_MS = 5_000;
export const REVISION_READS_AT_ONCE = 8;

/** `fn` over every item, at most `limit` at a time, results in the items' order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The latest revision's number and task policy: the only fields read, so only they are fetched. */
export async function latestDefinition(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<{ revision: number; developerTasks?: unknown } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ProjectionExpression: "#definition.#revision, #definition.#developerTasks",
    ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition: { revision: number; developerTasks?: unknown } }> };
  return response.Items?.[0]?.definition;
}

/** Each named project's latest revision and task policy; projects with no revision are left out. */
export async function projectsWithPolicy(deps: DeveloperRouteDependencies, orgId: OrgId, names: readonly string[]): Promise<Map<string, { revision: number; policy: DeveloperTaskPolicy }>> {
  const unique = [...new Set(names)].sort();
  const definitions = await mapLimit(unique, REVISION_READS_AT_ONCE, (name) => latestDefinition(deps, orgId, name));
  const found = new Map<string, { revision: number; policy: DeveloperTaskPolicy }>();
  unique.forEach((name, index) => {
    const definition = definitions[index];
    // developerTaskPolicy fails closed: a policy that no longer parses turns tasks and channel access off.
    if (definition !== undefined) found.set(name, { revision: definition.revision, policy: developerTaskPolicy(definition) });
  });
  return found;
}

/** The channel-members check, failing closed (and logged by error name) when it throws. */
export function safeChannelMembers(deps: DeveloperRouteDependencies): (request: ChannelMembersRequest) => Promise<ChannelMembersResponse> {
  return async (request) => {
    try {
      return await deps.developer.channelMembers(request);
    } catch (error) {
      logDeveloperEvent({ event: "developer.channel_members_failed", reason: "threw", error: errorName(error) });
      return SLACK_UNAVAILABLE;
    }
  };
}

/**
 * Channel names and privacy, best effort: without them the channels are listed by ID (R10).
 * Privacy comes from DeveloperIdentity's 10-minute cache. The whole lookup has one deadline.
 */
export async function channelNames(deps: DeveloperRouteDependencies, channelIds: readonly string[]): Promise<Map<string, { name: string; isPrivate: boolean }>> {
  const names = new Map<string, { name: string; isPrivate: boolean }>();
  const channelInfo = deps.developer.channelInfo;
  if (channelInfo === undefined || channelIds.length === 0) return names;
  const unique = [...new Set(channelIds)].sort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deps.developer.channelInfoDeadlineMs ?? CHANNEL_NAMES_DEADLINE_MS);
  });
  try {
    for (let start = 0; start < unique.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      let answer: ChannelInfoResponse | "deadline";
      try {
        answer = await Promise.race([channelInfo({ kind: "channel-info", channelIds: unique.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS) }), expired]);
      } catch (error) {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "threw", error: errorName(error) });
        return names;
      }
      if (answer === "deadline") {
        logDeveloperEvent({ event: "developer.channel_info_failed", reason: "deadline" });
        return names;
      }
      if (!answer.ok) return names;
      for (const channel of answer.channels) names.set(channel.channelId, { name: channel.name, isPrivate: channel.isPrivate });
    }
    return names;
  } finally {
    clearTimeout(timer);
  }
}

/** A private channel is flagged by ID only: its name never leaves the control plane (R10). */
const describeChannel = (channelId: string, names: Map<string, { name: string; isPrivate: boolean }>) => {
  const known = names.get(channelId);
  if (known === undefined) return { channelId };
  return known.isPrivate ? { channelId, isPrivate: true } : { channelId, name: known.name, isPrivate: false };
};

/**
 * FR-013: a grant is a row that gives a project role: `developer` (a maintainer or contributor) or, since Plan 2, Task 21, `viewer`. An
 * admin's `administrator` rows are the operator's and give none (a developer ID is built like an admin owner key, so they can sit under the
 * same key when both sign in through one IdP). Each row is returned whole: its role and who made it are read from it.
 */
export async function grantRowsOf(deps: DeveloperRouteDependencies, caller: ProjectAccessCaller): Promise<Array<{ projectName: string; grant: GrantRow }>> {
  const rows = await queryAll<GrantRow & { projectName?: string }>(deps, memberGrantsPk(caller.orgId, caller.developerId), MEMBER_GRANT_SK_PREFIX);
  return rows.flatMap((row) => (typeof row.projectName === "string" && grantRoleOf(row) !== undefined ? [{ projectName: row.projectName, grant: row }] : []));
}
type GrantRow = { role?: unknown; projectRole?: unknown; grantedBy?: unknown };

/**
 * The install's Slack team's channel bindings inside one org. Every one of them is read, because a person's access to a project is computed from them: a cut here would silently take a
 * channel's access away. Only the project page (which shows a few channels) passes `boundEvent`, and then reads at most `SESSION_PROJECT_BINDINGS_MAX`, logging the cut with the org's id.
 */
export async function bindingsOf(deps: DeveloperRouteDependencies, orgId: OrgId, boundEvent?: string): Promise<SlackChannelBinding[]> {
  if (deps.developer.slackTeamId === undefined) return [];
  const bound = boundEvent === undefined ? undefined : { max: SESSION_PROJECT_BINDINGS_MAX, onCut: () => logDeveloperEvent({ event: boundEvent, orgId }) };
  return queryAll<SlackChannelBinding>(deps, slackBindingPk(orgId, deps.developer.slackTeamId), SLACK_BINDING_SK_PREFIX, bound);
}

/** A developer's name for display: their sign-in record's, else "Unknown". */
async function nameOf(deps: DeveloperRouteDependencies, developerId: string): Promise<string> {
  return (await signInStoreOf(deps).getDeveloper(developerId))?.displayName ?? "Unknown";
}

export async function listProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperProjectsResponse> {
  const grantRows = await grantRowsOf(deps, caller);
  const grantOf = new Map(grantRows.map((row) => [row.projectName, row.grant]));
  // An org owner or admin reaches every project of their org (Task 11, I4), so each one in the org's catalog is theirs to list.
  const orgMaintainer = caller.orgRole === "owner" || caller.orgRole === "admin";
  const catalogNames = orgMaintainer ? (await queryAll<{ name?: unknown }>(deps, orgProjectCatalogPk(caller.orgId), "PROJECT#")).flatMap((entry) => (typeof entry.name === "string" ? [entry.name] : [])) : [];
  const grants = [...new Set([...grantRows.map((row) => row.projectName), ...catalogNames])];
  const bindings = await bindingsOf(deps, caller.orgId);
  const policies = await projectsWithPolicy(deps, caller.orgId, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants,
    bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    // FR-013 with FR-014: a project's own switch decides whether channel members may use it.
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  const listed = [...access.projects].filter(([name]) => policies.has(name));
  // Like checkProjectAccess: a caller with no Slack link is never shown channel names.
  const names = caller.slackUserId === undefined ? new Map<string, { name: string; isPrivate: boolean }>() : await channelNames(deps, listed.flatMap(([, entry]) => entry.channels));
  // Who added the caller, for the projects a grant of a person gave them (Task 21): one name lookup per person.
  // A person who has since been merged into another is named as the one they became (the grant keeps the id it was made under).
  const merge = projectMembersDepsOf(deps);
  const adders = new Map<string, { id: string; name: string }>();
  for (const [name] of listed) {
    const by = orgMaintainer ? undefined : grantedByOf(grantOf.get(name));
    if (by !== undefined && "developerId" in by) adders.set(by.developerId, { id: by.developerId, name: "Unknown" });
  }
  await mapLimit([...adders.keys()], REVISION_READS_AT_ONCE, async (id) => {
    const survivor = await survivorOf(merge, id);
    adders.set(id, { id: survivor, name: await nameOf(deps, survivor) });
  });
  const projects: DeveloperProjectsResponse["projects"] = [];
  for (const [name, entry] of listed) {
    const known = policies.get(name)!;
    const grant = grantOf.get(name);
    const role = effectiveProjectRole(caller, grant, entry.access === "channel");
    const source = orgMaintainer ? "org_role" as const : grant !== undefined ? "grant" as const : "channel" as const;
    const by = source === "grant" ? grantedByOf(grant) : undefined;
    projects.push({
      name, latestRevision: known.revision, access: entry.access, channels: entry.channels.map((channelId) => describeChannel(channelId, names)), tasks: known.policy,
      ...(role === undefined ? {} : { role, roleSource: source }),
      ...(by === undefined || !("developerId" in by) ? {} : { addedBy: { developerId: adders.get(by.developerId)?.id ?? by.developerId, name: adders.get(by.developerId)?.name ?? "Unknown" } }),
    });
  }
  return {
    developer: {
      id: caller.developerId, name: caller.name, provider: caller.amr, orgRole: caller.orgRole,
      ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
      ...(caller.email === undefined ? {} : { email: caller.email }),
    },
    projects,
    notices: access.slackUnavailable ? ["slack_unavailable"] : [],
  };
}

type StoredProject = z.infer<typeof StoredProjectDefinitionSchema>;

/** A project's latest revision as stored, with who registered it and when; undefined when it has none or the revision no longer parses. */
export async function latestProjectRecord(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<{ definition: StoredProject; registeredBy: string; registeredAt: string; workingBranchSelections?: unknown } | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": projectPk(orgId, project), ":prefix": PROJECT_REVISION_SK_PREFIX },
    ScanIndexForward: false,
    Limit: 1,
    ConsistentRead: true,
  })) as { Items?: Array<{ definition?: unknown; registeredBy?: unknown; registeredAt?: unknown; workingBranchSelections?: unknown }> };
  const item = response.Items?.[0];
  if (item === undefined) return undefined;
  const definition = StoredProjectDefinitionSchema.safeParse(item.definition);
  if (!definition.success) {
    logDeveloperEvent({ event: "developer.project_unreadable", project, reason: definition.error.issues[0]?.message ?? "invalid" });
    return undefined;
  }
  return { workingBranchSelections:item.workingBranchSelections, definition: definition.data, registeredBy: typeof item.registeredBy === "string" ? item.registeredBy : "unknown", registeredAt: typeof item.registeredAt === "string" ? item.registeredAt : "" };
}

/** GitHub's spelling of a repository, `owner/name`, from its URL; the repository's own name when the URL is no GitHub path. */
export function repositoryFullName(repository: { name: string; url: string }): string {
  try {
    const parts = new URL(repository.url).pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length === 2) return parts.join("/");
  } catch { /* fall through to the name */ }
  return repository.name;
}

export async function appProjectSummary(
  deps: DeveloperRouteDependencies,
  name: string,
  role: ProjectRole,
  record: NonNullable<Awaited<ReturnType<typeof latestProjectRecord>>>,
  meta: ProjectMetaItem | undefined,
): Promise<AppProjectSummary> {
  const { definition } = record;
  const metaRepository = metaRepositoryOf(definition);
  const setup = await setupStateOf(setupCheckDepsOf(deps), meta, definition);
  // Live interaction F1: what "Fix with agent" is about when the setup check failed or is outdated (fixed codes and the project's name only; the failed step's text is not copied).
  const setupRef = setupCheckErrorRef({ project: name, status: setup.status, at: setup.checkedAt ?? new Date(deps.now()).toISOString() });
  return {
    name,
    ...(meta?.description === undefined ? {} : { description: meta.description }),
    status: meta?.status ?? "active",
    latestRevision: definition.revision,
    repositories: definition.repositories.map((repository) => ({ name: repository.name, fullName: repositoryFullName(repository), defaultBranch: repository.defaultBranch })),
    ...(metaRepository === undefined ? {} : { metaRepository: { name: metaRepository.name, fullName: repositoryFullName(metaRepository), defaultBranch: metaRepository.defaultBranch, ...(metaRepository.alsoCode === true ? { alsoCode: true } : {}) } }),
    myRole: role,
    setup: setupRef === undefined ? setup : { ...setup, errorRef: setupRef },
  };
}

/**
 * The projects the caller may see in the app and their role in each. Org owners and admins see every project in the org's own
 * catalog, as maintainers. Anyone else sees what a grant or channel access gives, as listProjects resolves it: contributors. Every
 * read is keyed by `caller.orgId`, so another org's project of the same name is never reached. With `only`, just that name.
 */
export async function visibleProjectRoles(deps: DeveloperRouteDependencies, caller: DeveloperCaller, only?: string): Promise<Map<string, ProjectRole>> {
  const roles = new Map<string, ProjectRole>();
  if (caller.orgRole === "owner" || caller.orgRole === "admin") {
    const names = only !== undefined ? [only]
      : (await queryAll<{ name?: unknown }>(deps, orgProjectCatalogPk(caller.orgId), "PROJECT#")).flatMap((entry) => (typeof entry.name === "string" ? [entry.name] : []));
    for (const name of names) roles.set(name, effectiveProjectRole(caller, undefined, false)!);
    return roles;
  }
  const grantRows = (await grantRowsOf(deps, caller)).filter((row) => only === undefined || row.projectName === only);
  const grantOf = new Map(grantRows.map((row) => [row.projectName, row.grant]));
  const grants = grantRows.map((row) => row.projectName);
  const bindings = (await bindingsOf(deps, caller.orgId)).filter((binding) => only === undefined || binding.projectName === only);
  const policies = await projectsWithPolicy(deps, caller.orgId, [...grants, ...bindings.map((binding) => binding.projectName)]);
  const access = await resolveDeveloperAccess({
    grants, bindings,
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
    channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true,
    channelMembers: safeChannelMembers(deps),
  });
  for (const [name, entry] of access.projects) {
    const role = effectiveProjectRole(caller, grantOf.get(name), entry.access === "channel");
    if (role !== undefined && policies.has(name)) roles.set(name, role);
  }
  return roles;
}

/** `GET /v1/app/projects`: the caller's projects, sorted by name. Archived ones only with `?include=archived`. */
export async function listAppProjects(deps: DeveloperRouteDependencies, caller: DeveloperCaller, includeArchived: boolean): Promise<AppProjectsResponse> {
  const roles = await visibleProjectRoles(deps, caller);
  const names = [...roles.keys()].sort();
  const built = await mapLimit(names, REVISION_READS_AT_ONCE, async (name) => {
    const [record, meta] = await Promise.all([latestProjectRecord(deps, caller.orgId, name), readProjectMeta(deps, caller.orgId, name)]);
    // A catalog entry with no readable revision is not a project the app can show.
    if (record === undefined || (meta?.status === "archived" && !includeArchived)) return undefined;
    return appProjectSummary(deps, name, roles.get(name)!, record, meta);
  });
  return { projects: built.filter((project): project is AppProjectSummary => project !== undefined) };
}

/** What the setup status and the setup check read and write: the table and the clock. */
export function setupCheckDepsOf(deps: DeveloperRouteDependencies): SetupCheckDependencies {
  return { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
}

/**
 * What reads and writes a project's people: the table, a developer's sign-in record (for `mergedInto`), and the two ways a Slack channel
 * gives access (a project the person reaches, and whether one project's channel gives it to them). Slack failing closes the channel route
 * only; the person's grants and org role still answer.
 */
export function projectMembersDepsOf(deps: DeveloperRouteDependencies): ProjectMembersDependencies {
  const store = signInStoreOf(deps);
  const slackUserOf = async (developerId: string) => (await store.getDeveloper(developerId))?.slackUserId;
  return {
    documentClient: deps.documentClient,
    tableName: deps.tableName,
    developerRecord: (developerId) => store.getDeveloper(developerId),
    channelAccess: async (orgId, project, developerId) => {
      const slackUserId = await slackUserOf(developerId);
      if (slackUserId === undefined) return false;
      const known = (await projectsWithPolicy(deps, orgId, [project])).get(project);
      if (known === undefined || !known.policy.channelMembersMayUse) return false;
      const bindings = (await bindingsOf(deps, orgId)).filter((binding) => binding.projectName === project);
      if (bindings.length === 0) return false;
      const access = await resolveDeveloperAccess({ grants: [], bindings, slackUserId, channelMembersMayUse: () => true, channelMembers: safeChannelMembers(deps) });
      return access.projects.get(project)?.access === "channel";
    },
    channelProjects: async (orgId, developerId) => {
      const slackUserId = await slackUserOf(developerId);
      if (slackUserId === undefined) return [];
      const bindings = await bindingsOf(deps, orgId);
      const policies = await projectsWithPolicy(deps, orgId, bindings.map((binding) => binding.projectName));
      const access = await resolveDeveloperAccess({
        grants: [], bindings, slackUserId, channelMembersMayUse: (project) => policies.get(project)?.policy.channelMembersMayUse === true, channelMembers: safeChannelMembers(deps),
      });
      return [...access.projects].filter(([name, entry]) => entry.access === "channel" && policies.has(name)).map(([name]) => name);
    },
  };
}

/** Who has which role in a project (Plan 2, Task 21): the injected `projectMembers` when there is one, else built from these dependencies. */
export function projectMembersOf(deps: DeveloperRouteDependencies): ProjectMembers {
  return deps.projectMembers ?? createProjectMembers(projectMembersDepsOf(deps));
}
