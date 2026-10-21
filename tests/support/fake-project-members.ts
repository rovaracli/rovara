// PF6: an in-memory stand-in for Plan 2 Task 21's `createProjectMembers`, coded against the A3 interface. Org owners and
// admins are `maintainer` of every project (as the real one will be); everyone else has the role a grant gives them, or none.
// When Plan 2 Task 21 lands, the controller swaps in the real one and re-runs the focused tests.
import type { ProjectMembers } from "../../packages/broker/src/agents/access.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import type { ProjectRole } from "../../packages/contracts/src/app-projects.js";

type Caller = { developerId: string; orgRole: OrgRole };
const isOrgAdmin = (orgRole: OrgRole) => orgRole === "owner" || orgRole === "admin";

export class FakeProjectMembers implements ProjectMembers {
  private readonly grants = new Map<string, ProjectRole>();
  private readonly projects = new Map<OrgId, Set<string>>();
  /** Every `roleOf`, `list` and `projectsOf` call, so a test can check what was asked. */
  readonly calls: string[] = [];

  addProject(orgId: OrgId, project: string): void {
    const names = this.projects.get(orgId) ?? new Set<string>();
    names.add(project);
    this.projects.set(orgId, names);
  }

  /** Gives a developer a role on a project (the project joins the org's catalog too). */
  grant(orgId: OrgId, project: string, developerId: string, role: ProjectRole): void {
    this.addProject(orgId, project);
    this.grants.set(`${orgId}|${project}|${developerId}`, role);
  }

  roleOf = (orgId: OrgId, project: string, caller: Caller): Promise<ProjectRole | undefined> => {
    this.calls.push(`roleOf ${project}`);
    if (!this.projects.get(orgId)?.has(project)) return Promise.resolve(undefined);
    if (isOrgAdmin(caller.orgRole)) return Promise.resolve("maintainer");
    return Promise.resolve(this.grants.get(`${orgId}|${project}|${caller.developerId}`));
  };

  list = (orgId: OrgId, project: string): Promise<Array<{ developerId: string; role: ProjectRole; source: "grant" | "org_role" }>> => {
    this.calls.push(`list ${project}`);
    const prefix = `${orgId}|${project}|`;
    return Promise.resolve([...this.grants].filter(([key]) => key.startsWith(prefix)).map(([key, role]) => ({ developerId: key.slice(prefix.length), role, source: "grant" as const })));
  };

  projectsOf = (orgId: OrgId, caller: Caller): Promise<Array<{ project: string; role: ProjectRole }>> => {
    this.calls.push("projectsOf");
    const names = [...(this.projects.get(orgId) ?? [])].sort();
    const found: Array<{ project: string; role: ProjectRole }> = [];
    for (const project of names) {
      const role = isOrgAdmin(caller.orgRole) ? "maintainer" : this.grants.get(`${orgId}|${project}|${caller.developerId}`);
      if (role !== undefined) found.push({ project, role });
    }
    return Promise.resolve(found);
  };
}
