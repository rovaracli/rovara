import { logDeveloperEvent } from "../../developer/log.js";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXNameSchema,
  CHANNEL_MEMBERS_MAX_CHANNELS,
  DEVELOPER_WORKSPACES_PER_PROJECT,
  WORKSPACE_PROJECT_INDEX,
  WorkspaceInstanceSchema,
  agentXError,
  isSystemOwnerId,
  systemOwnerIdOf,
  workspaceProjectIndexValue,
  workspaceRecordFields,
  type ProjectRole,
  type DeveloperTaskPolicy,
  type DeveloperWorkspace,
  type DeveloperWorkspacesResponse,
  type OrgId,
} from "@agentx/contracts";
import { accessDeniedMessage } from "../../developer/access.js";
import { isSystemOwnerCaller } from "../../developer/system-owner.js";
import { effectiveProjectRole } from "../../developer/project-roles.js";
import { evaluateProjectAuthority } from "../../developer/task-project-access.js";
import type { DeveloperCaller, DeveloperRouteDependencies, ProjectAccessCaller } from "./types.js";
import { bindingsOf, channelNames, grantRowsOf, listProjects, projectsWithPolicy, safeChannelMembers } from "./project-list.js";

/**
 * FR-018's first three checks, in order, for one project; the start route calls it (Task 8), and
 * every route must call it before a DeveloperTaskActions member that trusts its caller.
 * PROJECT_NOT_FOUND, then PROJECT_ACCESS_DENIED (naming only public bound channels, R10), or
 * SLACK_UNAVAILABLE when only a channel could have given access and Slack is down, then
 * PROJECT_TASKS_DISABLED.
 */
export async function checkProjectAccess(
  deps: DeveloperRouteDependencies,
  caller: ProjectAccessCaller & { sessionId?: string },
  project: string,
  membership?: { freshMemberOf: readonly string[] },
  options: { ignoreTasksOff?: boolean } = {},
): Promise<{ revision: number; policy: DeveloperTaskPolicy; access: "granted" | "channel"; channelIds: string[]; role: ProjectRole }> {
  // A name that is not a project name is never echoed back: it could be long or carry markup.
  if (!AgentXNameSchema.safeParse(project).success) throw agentXError("PROJECT_NOT_FOUND", "that is not a valid AgentX project name");
  const known = (await projectsWithPolicy(deps, caller.orgId, [project])).get(project);
  if (known === undefined) throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  // A project's system owner (automatic runs) is no member: it holds no grant and is bound to no channel. Its access to ITS OWN project is the project's existence, as the project's own revision says, with the
  // role that starts work; the tasks-off switch is for people's tasks from AI tools and does not stop an automatic run. Any other id with the system owner's session is refused (it is built for one project only).
  if (isSystemOwnerId(caller.developerId)) {
    // Its id AND its own session id (`isSystemOwnerCaller`), for its own project only: the id alone is not enough, so nothing that merely carries the id passes for it.
    if (!isSystemOwnerCaller(caller) || caller.developerId !== systemOwnerIdOf(caller.orgId, project)) throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, []));
    return { revision: known.revision, policy: known.policy, access: "granted", channelIds: [], role: "contributor" };
  }
  const grant = (await grantRowsOf(deps, caller)).find((row) => row.projectName === project)?.grant;
  const bindings = (await bindingsOf(deps, caller.orgId)).filter((binding) => binding.projectName === project);
  // An org owner or admin counts as granted on every project in their org, with no grant (Plan 2, Task 11, I4). A project of another org
  // is never reached: `known` and every row read above are this org's.
  const orgMaintainer = caller.orgRole === "owner" || caller.orgRole === "admin";
  // Any grant counts as granted here, a viewer's too: what the role may do is decided by the effective role, below and at the places new work starts.
  const projectMemberships = grant !== undefined || orgMaintainer ? [{ projectName: project, role: "developer" }] : [];
  const evaluate = (freshMemberOf?: readonly string[]) => evaluateProjectAuthority({
    project,
    // `ignoreTasksOff` asks for the same access rule with the project's tasks-off switch set aside: sending an existing task back to coding (owner, 0.4.27).
    revision: { revision: known.revision, definition: { developerTasks: options.ignoreTasksOff === true ? { ...known.policy, enabled: true } : known.policy } },
    memberships: projectMemberships,
    bindings,
    ...(freshMemberOf === undefined ? {} : { freshMemberOf }),
    ...(caller.slackUserId === undefined ? {} : { slackUserId: caller.slackUserId }),
  });
  let result = evaluate(membership?.freshMemberOf);
  if (result.kind === "needs-membership") {
    const memberOf = new Set<string>();
    for (let start = 0; start < result.channelIds.length; start += CHANNEL_MEMBERS_MAX_CHANNELS) {
      const response = await safeChannelMembers(deps)({
        kind: "channel-members", slackUserId: caller.slackUserId!, channelIds: result.channelIds.slice(start, start + CHANNEL_MEMBERS_MAX_CHANNELS),
      });
      if (!response.ok) throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
      for (const channelId of response.memberOf) memberOf.add(channelId);
    }
    result = evaluate([...memberOf]);
  }
  if (result.kind === "unavailable") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "not-found") throw agentXError("PROJECT_NOT_FOUND", `project \`${project}\` doesn't exist in this AgentX`);
  if (result.kind === "needs-membership") throw agentXError("SLACK_UNAVAILABLE", "Slack could not be reached to check your channel membership; try again, or ask an admin for access");
  if (result.kind === "denied") {
    if (result.reason === "tasks-disabled") throw agentXError("PROJECT_TASKS_DISABLED", `tasks from AI tools are turned off for \`${project}\`; use the project's Slack channel, or ask an admin`);
    // Only a channel that would give access is worth naming, and only a public one (R10).
    const visible = caller.slackUserId === undefined || !known.policy.channelMembersMayUse
      ? []
      : [...(await channelNames(deps, result.visibleChannelIds)).values()].filter((channel) => !channel.isPrivate).map((channel) => channel.name).sort();
    throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, visible));
  }
  // This function never refuses an archived project or a viewer: those refusals are requireNewWorkAllowed's, at the places new work
  // starts, because the E2E rechecks of a running task's creator also come through here.
  const role = effectiveProjectRole(caller, grant, result.access === "channel");
  if (role === undefined) throw agentXError("PROJECT_ACCESS_DENIED", accessDeniedMessage(project, []));
  return { revision: result.revision, policy: options.ignoreTasksOff === true ? known.policy : result.policy, access: result.access, channelIds: result.channelIds, role };
}

/**
 * Spec 041 FR-002: a project's workspaces, newest first, from the sparse byWorkspaceProject index.
 * Only a workspace's own fields are read; the index carries the whole item, so no second get is
 * needed per workspace.
 */
async function projectWorkspaces(deps: DeveloperRouteDependencies, orgId: OrgId, project: string): Promise<DeveloperWorkspace[]> {
  const items: Array<Record<string, unknown>> = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      IndexName: WORKSPACE_PROJECT_INDEX.name,
      KeyConditionExpression: "#project = :project",
      ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": workspaceProjectIndexValue(orgId, project) },
      // Newest first, and never more than one page past the cap: a project with thousands of
      // thread workspaces must not turn one page load into an unbounded scan.
      ScanIndexForward: false,
      Limit: DEVELOPER_WORKSPACES_PER_PROJECT,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    items.push(...(response.Items ?? []));
    start = items.length >= DEVELOPER_WORKSPACES_PER_PROJECT ? undefined : response.LastEvaluatedKey;
  } while (start !== undefined);

  const workspaces: DeveloperWorkspace[] = [];
  for (const item of items.slice(0, DEVELOPER_WORKSPACES_PER_PROJECT)) {
    const parsed = WorkspaceInstanceSchema.safeParse(workspaceRecordFields(item));
    // A record this release cannot read is left out rather than failing the whole listing.
    if (!parsed.success) {
      logDeveloperEvent({ event: "developer.workspace_unreadable", project, reason: parsed.error.issues[0]?.message ?? "invalid" });
      continue;
    }
    const workspace = parsed.data;
    workspaces.push({
      id: workspace.id,
      projectName: workspace.projectName,
      projectRevision: workspace.projectRevision,
      status: workspace.status,
      busy: workspace.activeOperationId !== null,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  }
  return workspaces;
}

/**
 * FR-001: the projects the caller may use, with the workspaces in each of them. The projects come
 * from listProjects itself, so this route applies exactly the same access rules (grants, and channel
 * membership only where the project's developerTasks policy allows it, failing closed).
 */
export async function listWorkspaces(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DeveloperWorkspacesResponse> {
  const listing = await listProjects(deps, caller);
  const workspaces: DeveloperWorkspace[] = [];
  for (const project of listing.projects) workspaces.push(...await projectWorkspaces(deps, caller.orgId, project.name));
  // Across projects, still newest first, so the page's list reads as one timeline.
  workspaces.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { ...listing, workspaces };
}
