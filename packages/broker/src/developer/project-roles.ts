// Plan 2, Task 11: a person's effective role in a project, and the checks that belong where new work starts. An org owner or admin is a
// maintainer of every project in their org, with no grant. An archived project, or a role that may not start tasks, refuses only the
// places that start new work (a task start, Slack-started work, the setup check): work that exists keeps going.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ProjectRoleSchema, agentXError, projectAllows, projectArchivedMessage, projectMetaKey, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import { isWriterOrgRole, type OrgRole } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";

/**
 * What a project's grant row says, as stored (Plan 2, Task 21). A new row has `role` (`developer` for a maintainer or contributor,
 * `viewer` for a viewer), `projectRole` and `grantedBy`; the two older shapes have fewer of these and read as `grantRoleOf` and
 * `grantedByOf` say.
 */
export interface GrantItem { role?: unknown; projectRole?: unknown; grantedBy?: unknown }

/** Who made a grant: a person of the org, or the operator console. */
export type GrantedBy = { developerId: string } | { system: "admin" };

/**
 * The project role a grant row gives, or undefined when it gives none. `role: viewer` is a viewer. `role: developer` is its `projectRole`,
 * and a contributor when the row has none (the shape before project roles). Any other `role`, an `administrator` row among them, gives no
 * project role: those rows are the operator's. A row that contradicts itself (`developer` with `projectRole: viewer`) reads as the less
 * privileged role.
 */
export function grantRoleOf(grant: GrantItem | undefined): ProjectRole | undefined {
  if (grant === undefined) return undefined;
  if (grant.role === "viewer") return "viewer";
  if (grant.role !== "developer") return undefined;
  const stored = ProjectRoleSchema.safeParse(grant.projectRole);
  return stored.success ? stored.data : "contributor";
}

/**
 * Who made a grant. `{ developerId }` as stored; the older `{ issuer, subject }` of the operator console reads as the developer that sign-in
 * identity is (`ownerKeyForSubject`); a row with none, or any other shape, reads as the operator console.
 */
export function grantedByOf(grant: GrantItem | undefined): GrantedBy {
  const by = grant?.grantedBy;
  if (typeof by !== "object" || by === null) return { system: "admin" };
  const fields = by as Record<string, unknown>;
  if (typeof fields.developerId === "string" && fields.developerId !== "") return { developerId: fields.developerId };
  if (typeof fields.issuer === "string" && typeof fields.subject === "string") {
    try { return { developerId: ownerKeyForSubject(fields.issuer, fields.subject) }; } catch { return { system: "admin" }; }
  }
  return { system: "admin" };
}

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
 * Org owners and admins maintain every project in their org; otherwise the grant's role (`grantRoleOf`), which an explicit grant keeps
 * even when the person is also in the project's Slack channel; otherwise a contributor with channel access; otherwise none.
 */
export function effectiveProjectRole(caller: { orgRole: OrgRole; developerId: string }, grant: GrantItem | undefined, channelAccess: boolean): ProjectRole | undefined {
  if (caller.orgRole === "owner" || caller.orgRole === "admin") return "maintainer";
  // The Auditor has no project role, whatever grant or channel it may also hold: it reads the audit log and writes nothing. A positive list (P3-OPEN-ROLES-CLOUD-ADOPTION): any role that is not a writer's has none.
  if (!isWriterOrgRole(caller.orgRole)) return undefined;
  const granted = grantRoleOf(grant);
  if (granted !== undefined) return granted;
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
// The plan's one PROJECT_ARCHIVED text (`projectArchivedMessage`, in the contracts) serves new work and a settings change alike.

/**
 * Called only where new work starts. An archived project refuses every kind (PROJECT_ARCHIVED); a task start also needs the role to
 * allow starting tasks. `continue`, workflow decisions that don't start a new run, `cancel`, PR follow-up and E2E rounds never call it.
 */
export async function requireNewWorkAllowed(deps: ProjectMetaReader, orgId: OrgId, project: string, role: ProjectRole, kind: "task" | "setup_check"): Promise<void> {
  const meta = await readProjectMeta(deps, orgId, project);
  if (meta?.status === "archived") throw agentXError("PROJECT_ARCHIVED", projectArchivedMessage(project));
  if (kind === "task" && !projectAllows(role, "start_tasks")) throw agentXError("PROJECT_ACCESS_DENIED", viewerCannotStartTasksMessage(project));
}
