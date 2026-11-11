// PF6: an in-memory stand-in for Plan 2 Task 21's `createProjectMembers` (packages/broker/src/org/project-members.ts), kept in step with it
// (tests/contract/project-members-parity.test.ts runs both over the same people). Org owners and admins are `maintainer` of every project
// (listed once, as `org_role` rows, whatever grants they also hold); everyone else has the role a grant gives them, else `contributor` when the
// project's Slack channel gives them access (`channel`), else none. A person who reaches a project only through its channel is not in `list`.
// A project that is archived is left out of `projectsOf`. The real one is wired into the broker; this one is for unit tests that want no table.
import type { ProjectMembers } from "../../packages/broker/src/agents/access.js";
import type { OrgId } from "@rovara-code/contracts";
import type { OrgRole } from "../../packages/cloud-contracts/src/org-node.js";
import type { ProjectRole } from "@rovara-code/contracts";

type Caller = { developerId: string; orgRole: OrgRole };
const isOrgAdmin = (orgRole: OrgRole) => orgRole === "owner" || orgRole === "admin";

export class FakeProjectMembers implements ProjectMembers {
  private readonly grants = new Map<string, ProjectRole>();
  private readonly projects = new Map<OrgId, Set<string>>();
  private readonly archived = new Set<string>();
  private readonly orgRoles = new Map<string, OrgRole>();
  private readonly channels = new Set<string>();
  /** Every `roleOf`, `list` and `projectsOf` call, so a test can check what was asked. */
  readonly calls: string[] = [];

  addProject(orgId: OrgId, project: string): void {
    const names = this.projects.get(orgId) ?? new Set<string>();
    names.add(project);
    this.projects.set(orgId, names);
  }

  /** Records a developer's org role, so `list` can name the org's owners and admins (the real one reads the org's members). */
  setOrgRole(orgId: OrgId, developerId: string, orgRole: OrgRole): void {
    this.orgRoles.set(`${orgId}|${developerId}`, orgRole);
  }

  /** Archives a project: `projectsOf` no longer returns it (its roles still answer `roleOf` and `list`, as in the real one). */
  archive(orgId: OrgId, project: string): void {
    this.archived.add(`${orgId}|${project}`);
  }

  /** The project's Slack channel gives this developer access: a contributor, unless they hold a grant (an explicit grant is the role). The project need not exist. */
  channel(orgId: OrgId, project: string, developerId: string): void {
    this.channels.add(`${orgId}|${project}|${developerId}`);
  }

  /** Gives a developer a role on a project (the project joins the org's catalog too). */
  grant(orgId: OrgId, project: string, developerId: string, role: ProjectRole): void {
    this.addProject(orgId, project);
    this.grants.set(`${orgId}|${project}|${developerId}`, role);
  }

  /** Takes a developer's grant on a project away. */
  revoke(orgId: OrgId, project: string, developerId: string): void {
    this.grants.delete(`${orgId}|${project}|${developerId}`);
  }

  roleOf = (orgId: OrgId, project: string, caller: Caller): Promise<ProjectRole | undefined> => {
    this.calls.push(`roleOf ${project}`);
    if (!this.projects.get(orgId)?.has(project)) return Promise.resolve(undefined);
    if (isOrgAdmin(caller.orgRole)) return Promise.resolve("maintainer");
    return Promise.resolve(this.grants.get(`${orgId}|${project}|${caller.developerId}`) ?? (this.channels.has(`${orgId}|${project}|${caller.developerId}`) ? "contributor" : undefined));
  };

  list = (orgId: OrgId, project: string): Promise<Array<{ developerId: string; role: ProjectRole; source: "grant" | "org_role" }>> => {
    this.calls.push(`list ${project}`);
    // A project that does not exist has no one; each owner or admin is listed once, as a maintainer by their org role; the others by their grant.
    if (!this.projects.get(orgId)?.has(project)) return Promise.resolve([]);
    const found: Array<{ developerId: string; role: ProjectRole; source: "grant" | "org_role" }> = [];
    const admins = new Set<string>();
    for (const [key, orgRole] of this.orgRoles) {
      if (!key.startsWith(`${orgId}|`) || !isOrgAdmin(orgRole)) continue;
      const developerId = key.slice(orgId.length + 1);
      admins.add(developerId);
      found.push({ developerId, role: "maintainer", source: "org_role" });
    }
    const prefix = `${orgId}|${project}|`;
    for (const [key, role] of this.grants) {
      const developerId = key.slice(prefix.length);
      if (key.startsWith(prefix) && !admins.has(developerId)) found.push({ developerId, role, source: "grant" });
    }
    return Promise.resolve(found);
  };

  projectsOf = (orgId: OrgId, caller: Caller): Promise<Array<{ project: string; role: ProjectRole }>> => {
    this.calls.push("projectsOf");
    const names = [...(this.projects.get(orgId) ?? [])].sort();
    const found: Array<{ project: string; role: ProjectRole }> = [];
    for (const project of names) {
      if (this.archived.has(`${orgId}|${project}`)) continue;
      const role = isOrgAdmin(caller.orgRole) ? "maintainer" : this.grants.get(`${orgId}|${project}|${caller.developerId}`) ?? (this.channels.has(`${orgId}|${project}|${caller.developerId}`) ? "contributor" : undefined);
      if (role !== undefined) found.push({ project, role });
    }
    return Promise.resolve(found);
  };
}
