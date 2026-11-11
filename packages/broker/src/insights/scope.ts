// Insights: who may see what (decisions 12, 32, 33). The scope is read live on every request from the caller's own member record (one consistent GetItem under the caller's checked company),
// never from the token and never from the request:
//   owner or admin           the whole company, per-person spend included;
//   Insights viewer          the whole company, no per-person spend; a GRANT on a member (never a fifth role): `insightsViewer`, `insightsGrantedAt`, `insightsGrantedBy` on the member record;
//   project maintainer       the projects they maintain (`projectAllows(role, "view_spend")`), no per-person spend;
//   any other member         nothing (FORBIDDEN);
//   the Auditor, or a role this release does not know      nothing: the dispatcher's allow-list is positive and does not list Insights, and this check refuses them again (FORBIDDEN).
// A person can hold several of these; the scope is the union. The grant counts only while the record is still a plain member's and was not touched by a later role change (`grantHolds`): a member who
// was made an admin, an Auditor or a member again since the grant is not an Insights viewer until an admin gives it again. This module does not change the live-role read that Slack and the
// confirmation page share (`org/live-role.ts`); the grant is read here, with its own GetItem, so nothing that reads a role changes.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, agentXError, orgMemberKey, projectAllows, type OrgId } from "@agentx/contracts";
import type { InsightsOverview } from "@agentx/contracts";
import type { ProjectMembers } from "../org/project-members.js";

export const INSIGHTS_REFUSED = "Insights is for company owners and admins, people an admin gave access, and project maintainers.";
export const INSIGHTS_ADMIN_ONLY = "Only a company owner or admin can see or change who has Insights access.";
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;

/** What the Insights routes need to know who is asking: `DeveloperCaller` fits. */
export interface InsightsCaller { developerId: string; orgId: OrgId; orgRole: string; browserSession?: true | undefined }

export interface InsightsScopeDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Without it nobody is a maintainer here. */
  projectMembers?: Pick<ProjectMembers, "projectsOf"> | undefined;
}

export type InsightsVia = InsightsOverview["viewer"]["via"][number];
export interface InsightsViewer {
  developerId: string;
  /** The role on the member record NOW. */
  role: "owner" | "admin" | "member";
  via: InsightsVia[];
  scope: { kind: "company" } | { kind: "projects"; projects: string[] };
  contentLevel: "full_where_readable" | "metadata_only_elsewhere";
  canSeePerPerson: boolean;
}

type Item = Record<string, unknown>;

/** The caller's member record, read now. */
export async function readMemberRecord(deps: Pick<InsightsScopeDependencies, "documentClient" | "tableName">, orgId: OrgId, developerId: string): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true }))) as { Item?: Item }).Item;
}

/**
 * Whether a member record holds a valid Insights grant: a plain `member` role, the grant fields complete and well formed, and no role change since the grant (`roleUpdatedAt` is set by every role
 * change; one later than the grant, or one that cannot be read, voids it). Anything unreadable is no grant.
 */
export function grantHolds(item: Item | undefined): boolean {
  if (item === undefined || item["insightsViewer"] !== true || item["role"] !== "member") return false;
  const grantedBy = item["insightsGrantedBy"];
  if (typeof grantedBy !== "string" || !DEVELOPER_ID.test(grantedBy)) return false;
  const grantedAt = typeof item["insightsGrantedAt"] === "string" ? Date.parse(item["insightsGrantedAt"]) : Number.NaN;
  if (!Number.isFinite(grantedAt)) return false;
  if (item["roleUpdatedAt"] !== undefined) {
    const changedAt = typeof item["roleUpdatedAt"] === "string" ? Date.parse(item["roleUpdatedAt"]) : Number.NaN;
    if (!Number.isFinite(changedAt) || changedAt > grantedAt) return false;
  }
  return true;
}

/** The projects the person maintains, with a role that may view spend. */
async function maintainedProjects(deps: InsightsScopeDependencies, caller: InsightsCaller): Promise<string[]> {
  if (deps.projectMembers === undefined) return [];
  const projects = await deps.projectMembers.projectsOf(caller.orgId, { developerId: caller.developerId, orgRole: "member" });
  return [...new Set(projects.filter((entry) => projectAllows(entry.role, "view_spend")).map((entry) => entry.project))].sort();
}

/**
 * The caller's Insights scope, or FORBIDDEN when they have none. The role is the member record's now (a person with no record, an Auditor and a role this release does not know get nothing, whatever
 * the session says). A fault while reading who maintains what is a retryable 503 and never lets a person through.
 */
export async function resolveInsightsViewer(deps: InsightsScopeDependencies, caller: InsightsCaller): Promise<InsightsViewer> {
  const refused = () => agentXError("FORBIDDEN", INSIGHTS_REFUSED);
  // The session's own role is a second check: a session that says Auditor (or anything but a writer's role) never reaches the scope below.
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin" && caller.orgRole !== "member") throw refused();
  const record = await readMemberRecord(deps, caller.orgId, caller.developerId);
  const parsed = OrgRoleSchema.safeParse(record?.["role"]);
  if (record === undefined || !parsed.success || (parsed.data !== "owner" && parsed.data !== "admin" && parsed.data !== "member")) throw refused();
  const role = parsed.data;
  if (role === "owner" || role === "admin") return { developerId: caller.developerId, role, via: [role], scope: { kind: "company" }, contentLevel: "full_where_readable", canSeePerPerson: true };
  const granted = grantHolds(record);
  let projects: string[] = [];
  try {
    projects = await maintainedProjects(deps, caller);
  } catch {
    if (!granted) throw agentXError("RUNTIME_UNAVAILABLE", "Insights can't check your projects right now. Try again in a moment.");
  }
  if (!granted && projects.length === 0) throw refused();
  const via: InsightsVia[] = [...(granted ? ["viewer_grant" as const] : []), ...(projects.length > 0 ? ["maintainer" as const] : [])];
  return {
    developerId: caller.developerId, role, via,
    scope: granted ? { kind: "company" } : { kind: "projects", projects },
    contentLevel: granted ? "metadata_only_elsewhere" : "full_where_readable",
    canSeePerPerson: false,
  };
}

/** A project the viewer may ask about: inside their scope, else FORBIDDEN (a maintainer) or PROJECT_NOT_FOUND (an unknown name, company scope only; a maintainer is told nothing about names outside theirs). */
export function inScope(viewer: InsightsViewer, project: string): boolean {
  return viewer.scope.kind === "company" || viewer.scope.projects.includes(project);
}
