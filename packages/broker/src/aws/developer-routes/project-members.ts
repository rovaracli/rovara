import { logDeveloperEvent } from "../../developer/log.js";
import { nameResolverOf, replacementNamesFrom } from "../../developer/name-resolver.js";
import { AgentXNameSchema, agentXError, projectAllows, type ProjectMember, type ProjectMemberChangeResponse, type ProjectMemberRemoveResponse, type ProjectSlackChannelRemoveResponse, type ProjectSlackChannelResponse, type ProjectMembersResponse, type ProjectRole, type OrgId, PutProjectMemberBodySchema, RemoveProjectSlackChannelBodySchema, RemoveProjectMemberBodySchema } from "@rovara-code/contracts";
import { unbindProjectChannel, type ProjectSlackChannelDependencies } from "../../org/slack-binding.js";
import { listProjectMembers, removeProjectMember, setProjectMember, survivorOf } from "../../org/project-members.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";
import { PROJECT_NOT_FOUND_IN_APP, bodyError, signInStoreOf } from "./common.js";
import { REVISION_READS_AT_ONCE, latestDefinition, mapLimit, projectMembersDepsOf, visibleProjectRoles } from "./project-list.js";

/** The caller's role in a project named in a route's path, or the same 404 PROJECT_NOT_FOUND as no access and no such project (never 403). */
export async function projectRoleForRoute(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<{ name: string; role: ProjectRole }> {
  const notFound = () => agentXError("PROJECT_NOT_FOUND", PROJECT_NOT_FOUND_IN_APP);
  let name: string;
  try { name = decodeURIComponent(rawName); } catch { throw notFound(); }
  if (!AgentXNameSchema.safeParse(name).success) throw notFound();
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined || await latestDefinition(deps, caller.orgId, name) === undefined) throw notFound();
  return { name, role };
}

const ROLE_ORDER: Record<ProjectRole, number> = { maintainer: 0, contributor: 1, viewer: 2 };

/**
 * `GET /v1/app/projects/{name}/members`: everyone with a role in the project and where it comes from, for anyone who can see the project.
 * Org owners and admins are listed as maintainers by their org role (`org_role`), once, whatever grants they also hold.
 */
export async function getProjectMembers(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<ProjectMembersResponse> {
  const { name } = await projectRoleForRoute(deps, caller, rawName);
  const merge = projectMembersDepsOf(deps);
  // Who added a person is shown as the developer they have since been merged into, if any.
  const rows = (await listProjectMembers(merge, caller.orgId, name)).map(async (row) => (row.grantedBy !== undefined && "developerId" in row.grantedBy
    ? { ...row, grantedBy: { developerId: await survivorOf(merge, row.grantedBy.developerId) } } : row));
  return buildProjectMembersResponse(deps, caller.orgId, await Promise.all(rows), isOrgAdmin(caller));
}

/** Whether the caller is an owner or admin of the org: the people who may see other people's emails, join dates and sign-in methods (release 0.4.16, owner decision "option A"). */
const isOrgAdmin = (caller: Pick<DeveloperCaller, "orgRole">): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

/** The project's people. Names are email-safe for everyone; an email is shown to an owner or admin only (`showEmails`). */
async function buildProjectMembersResponse(deps: DeveloperRouteDependencies, orgId: OrgId, rows: Awaited<ReturnType<typeof listProjectMembers>>, showEmails: boolean): Promise<ProjectMembersResponse> {
  const store = signInStoreOf(deps);
  const cards = new Map<string, { name: string; email?: string }>();
  const ids = [...new Set(rows.flatMap((row) => [row.developerId, ...(row.grantedBy !== undefined && "developerId" in row.grantedBy ? [row.grantedBy.developerId] : [])]))];
  const { records, nameItems } = await store.getDevelopersWithNameItems(ids);
  // ERASE-NAME-2: a person erased (also before the name item had a tombstone) is not shown by the name stored for them.
  const replaced = (await replacementNamesFrom(nameResolverOf(deps, orgId), ids, nameItems)).currentOnly();
  await mapLimit(ids, REVISION_READS_AT_ONCE, async (id) => {
    const record = records.get(id);
    const identities = await store.identitiesOf(id);
    const email = showEmails ? record?.email ?? identities.find((identity) => identity.email !== undefined)?.email : undefined;
    cards.set(id, { name: replaced.get(id) ?? record?.displayName ?? "Unknown", ...(email === undefined ? {} : { email }) });
  });
  const members: ProjectMember[] = rows.map((row) => {
    const card = cards.get(row.developerId)!;
    const by = row.grantedBy;
    return {
      developerId: row.developerId, name: card.name, ...(card.email === undefined ? {} : { email: card.email }), role: row.role, source: row.source,
      // The operator console's grants have no person to name.
      ...(row.source !== "grant" || by === undefined || !("developerId" in by) ? {} : { grantedBy: { developerId: by.developerId, name: cards.get(by.developerId)?.name ?? "Unknown" } }),
    };
  });
  members.sort((left, right) => ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || left.name.localeCompare(right.name) || left.developerId.localeCompare(right.developerId));
  return { members };
}

/** Tells the agents platform a person's project role changed; what it fails with is logged, never raised (the change stands). */
async function notifyProjectMemberChanged(deps: DeveloperRouteDependencies, orgId: OrgId, project: string, developerId: string): Promise<void> {
  if (deps.projectMemberChanged === undefined) return;
  try {
    await deps.projectMemberChanged(orgId, project, developerId);
  } catch (error) {
    logDeveloperEvent({ event: "developer.project_member_hook_failed", orgId, project, error: error instanceof Error ? error.name : "unknown" });
  }
}

const MANAGE_MEMBERS_MESSAGE = "only a project maintainer can change who is in a project";

/**
 * `PUT /v1/app/projects/{name}/members/{developerId}`: a maintainer of the project (or an org owner or admin) gives a member of the org a role
 * in it. A contributor or viewer is refused (403), so nobody can grant themselves or another a higher role. The person must be in the caller's
 * org; an owner or admin takes no role. A replay of the request id answers the stored outcome.
 */
export async function putProjectMember(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, developerId: string, body: unknown): Promise<ProjectMemberChangeResponse> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "manage_members")) throw agentXError("FORBIDDEN", MANAGE_MEMBERS_MESSAGE);
  const parsed = PutProjectMemberBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const member = await setProjectMember({ ...projectMembersDepsOf(deps), now: () => new Date(deps.now()), ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, caller.orgId, name, {
    requestId: parsed.data.requestId, developerId, role: parsed.data.role, actor: { developerId: caller.developerId },
  });
  logDeveloperEvent({ event: "developer.project_member_set", orgId: caller.orgId, project: name, role: member.role });
  await notifyProjectMemberChanged(deps, caller.orgId, name, member.developerId);
  return { member };
}

/** `DELETE /v1/app/projects/{name}/members/{developerId}`: the same people may take a person's grant away. `removed` is false when they had none. */
export async function deleteProjectMember(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, developerId: string, body: unknown): Promise<ProjectMemberRemoveResponse> {
  const { name, role } = await projectRoleForRoute(deps, caller, rawName);
  if (!projectAllows(role, "manage_members")) throw agentXError("FORBIDDEN", MANAGE_MEMBERS_MESSAGE);
  const parsed = RemoveProjectMemberBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const removed = await removeProjectMember({ ...projectMembersDepsOf(deps), now: () => new Date(deps.now()), ...(deps.audit === undefined ? {} : { audit: deps.audit }) }, caller.orgId, name, {
    requestId: parsed.data.requestId, developerId, actor: { developerId: caller.developerId },
  });
  logDeveloperEvent({ event: "developer.project_member_removed", orgId: caller.orgId, project: name, removed: String(removed.removed) });
  await notifyProjectMemberChanged(deps, caller.orgId, name, removed.developerId);
  return removed;
}

const SLACK_BIND_ROLE_MESSAGE = "only an organization owner or admin can bind a Slack channel to a project";

/**
 * `PUT /v1/app/projects/{name}/slack-channel` (release 0.4.17): an org owner or admin binds a Slack channel of the org's Slack workspace to a
 * project of the org, with the developer sign-in. Owner or admin only, read live from the membership on every call: the operator's bind needs the
 * project's `administrator` membership, which a project's own maintainer does not hold, so a project maintainer who is only an org member is 403.
 * No access to the project is the usual 404. The team and channel checks, the replay and the audit are `bindProjectChannel`'s.
 */
export async function putProjectSlackChannel(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string): Promise<ProjectSlackChannelResponse> {
  await projectRoleForRoute(deps, caller, rawName);
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", SLACK_BIND_ROLE_MESSAGE);
  throw agentXError("FORBIDDEN", "Use the browser Slack approval flow to link a channel.");
}

/** `DELETE /v1/app/projects/{name}/slack-channel`: the same people unbind one of the project's channels. `removed` is false when it was not bound. */
export async function deleteProjectSlackChannel(deps: DeveloperRouteDependencies, caller: DeveloperCaller, rawName: string, body: unknown): Promise<ProjectSlackChannelRemoveResponse> {
  const { name } = await projectRoleForRoute(deps, caller, rawName);
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", SLACK_BIND_ROLE_MESSAGE);
  const parsed = RemoveProjectSlackChannelBodySchema.safeParse(body);
  if (!parsed.success) throw bodyError(parsed.error);
  const result = await unbindProjectChannel(slackChannelDepsOf(deps), caller.orgId, name, { ...parsed.data, actor: { developerId: caller.developerId } });
  if (result.removed) logDeveloperEvent({ event: "developer.slack_channel_unbound", orgId: caller.orgId, project: name });
  return result;
}

/** What a bind writes and reads. A Rovara Cloud install gives an org no claim on the installation's own Slack team: its orgs connect their own. */
function slackChannelDepsOf(deps: DeveloperRouteDependencies): ProjectSlackChannelDependencies {
  if (deps.orgs === undefined) throw agentXError("NOT_FOUND", "organizations are not set up in this deployment");
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: () => new Date(deps.now()), orgs: deps.orgs,
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    ...(deps.cloud === true || deps.developer.slackTeamId === undefined ? {} : { installSlackTeamId: deps.developer.slackTeamId }),
  };
}
