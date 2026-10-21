// Plan 2, Task 11: a person's effective role in a project, and the checks that belong where new work starts. An org owner or admin is a
// maintainer of every project in their org, with no grant. An archived project, or a role that may not start tasks, refuses only the
// places that start new work (a task start, Slack-started work, the setup check): work that exists keeps going.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectAllows, projectMetaKey, type OrgId, type OrgRole, type ProjectRole } from "@agentx/contracts";

/** What a project's grant row says about its holder's role. Plan 3's member roles extend what is read here. */
export interface GrantItem { role?: unknown }

/** A project's META item (Plan 2, Task 11); a project registered before Plan 2 has none. */
export interface ProjectMetaItem {
  entityType: "PROJECT_META";
  name: string;
  status: "active" | "archived";
  description?: string;
  createdAt: string;
  createdBy: string;
  archivedAt?: string;
  archivedBy?: string;
  setupCheck?: { workspaceId: string; revision: number; startedAt: string; startedBy: string };
}

/**
 * Org owners and admins maintain every project in their org; otherwise the grant's role (until members have project roles, a
 * `developer` grant reads as contributor); otherwise a contributor with channel access; otherwise none.
 */
export function effectiveProjectRole(caller: { orgRole: OrgRole; developerId: string }, grant: GrantItem | undefined, channelAccess: boolean): ProjectRole | undefined {
  if (caller.orgRole === "owner" || caller.orgRole === "admin") return "maintainer";
  if (grant?.role === "developer") return "contributor";
  return channelAccess ? "contributor" : undefined;
}

export interface ProjectMetaReader { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The project's META item in this org (a consistent read), or undefined when it has none. */
export async function readProjectMeta(deps: ProjectMetaReader, orgId: OrgId, project: string): Promise<ProjectMetaItem | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: projectMetaKey(orgId, project), ConsistentRead: true })) as { Item?: ProjectMetaItem };
  return response.Item?.entityType === "PROJECT_META" ? response.Item : undefined;
}

/** What a viewer is told when they try to start a task. */
export const viewerCannotStartTasksMessage = (project: string) => `You can view \`${project}\` but not start tasks in it. Ask a maintainer to make you a contributor.`;
export const projectArchivedMessage = (project: string) => `\`${project}\` is archived; ask a maintainer to restore it before starting new work.`;

/**
 * Called only where new work starts. An archived project refuses every kind (PROJECT_ARCHIVED); a task start also needs the role to
 * allow starting tasks. `continue`, workflow decisions, `cancel`, PR follow-up and E2E rounds never call it.
 */
export async function requireNewWorkAllowed(deps: ProjectMetaReader, orgId: OrgId, project: string, role: ProjectRole, kind: "task" | "setup_check"): Promise<void> {
  const meta = await readProjectMeta(deps, orgId, project);
  if (meta?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  if (kind === "task" && !projectAllows(role, "start_tasks")) throw agentXError("PROJECT_ACCESS_DENIED", viewerCannotStartTasksMessage(project));
}
