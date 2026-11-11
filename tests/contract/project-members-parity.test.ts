// PF6: the stand-in the agents unit tests use (tests/support/fake-project-members.ts) answers like Plan 2 Task 21's real
// `createProjectMembers` over the same people: the same role for a caller, the same list (org owners and admins as `org_role` rows, once),
// and the same projects (an archived project is left out of `projectsOf`, a project with no revision is not one), and the same roles
// for a person the project's Slack channel gives access (a contributor, unless an explicit grant says otherwise, Plan 3 Task 11).
import { describe, expect, it } from "vitest";
import { orgMemberKey, type OrgRole } from "@agentx/cloud-contracts";
import { orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import { createProjectMembers } from "../../packages/broker/src/org/project-members.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";

const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const id = (letter: string) => letter.repeat(64);
const OWNER = id("1");
const ADMIN = id("2");
const MAINTAINER = id("3");
const CONTRIBUTOR = id("4");
const VIEWER = id("5");
const NONE = id("6");
const ADMIN_WITH_GRANT = id("7");
const CHANNEL_ONLY = id("9"); // reaches web, old and a project that does not exist through their channels, and nothing else

function world() {
  const db = new FakeDynamoDb();
  const fake = new FakeProjectMembers();
  const person = (orgId: OrgId, developerId: string, role: OrgRole) => {
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    fake.setOrgRole(orgId, developerId, role);
  };
  const project = (orgId: OrgId, name: string, status?: "archived") => {
    db.set({ ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", definition: { name, revision: 1 } });
    db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1 });
    fake.addProject(orgId, name);
    if (status === "archived") {
      db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status, createdAt: "x", createdBy: "y", archivedAt: "z", archivedBy: "y" });
      fake.archive(orgId, name);
    }
  };
  const channels = new Set<string>();
  /** The project's Slack channel gives this person access, in the real and in the fake. */
  const channel = (orgId: OrgId, name: string, developerId: string) => {
    channels.add(`${orgId}|${name}|${developerId}`);
    fake.channel(orgId, name, developerId);
  };
  const grant = (orgId: OrgId, name: string, developerId: string, role: ProjectRole) => {
    db.set({
      ...projectMemberKey(orgId, developerId, name), entityType: "MEMBERSHIP", ownerKey: developerId, grantId: `g-${developerId.slice(0, 4)}`, projectName: name,
      role: role === "viewer" ? "viewer" : "developer", projectRole: role, grantedBy: { developerId: OWNER }, grantedAt: "2026-10-05T00:00:00.000Z",
    });
    fake.grant(orgId, name, developerId, role);
  };
  person(TEST_ORG, OWNER, "owner");
  person(TEST_ORG, ADMIN, "admin");
  for (const who of [MAINTAINER, CONTRIBUTOR, VIEWER, NONE]) person(TEST_ORG, who, "member");
  person(TEST_ORG, ADMIN_WITH_GRANT, "admin");
  person(TEST_ORG, CHANNEL_ONLY, "member");
  person(OTHER_ORG, id("8"), "owner");
  project(TEST_ORG, "web");
  project(TEST_ORG, "api");
  project(TEST_ORG, "old", "archived");
  project(OTHER_ORG, "web");
  grant(TEST_ORG, "web", MAINTAINER, "maintainer");
  grant(TEST_ORG, "web", CONTRIBUTOR, "contributor");
  grant(TEST_ORG, "web", VIEWER, "viewer");
  grant(TEST_ORG, "web", ADMIN_WITH_GRANT, "viewer");
  grant(TEST_ORG, "api", CONTRIBUTOR, "viewer");
  grant(TEST_ORG, "old", MAINTAINER, "maintainer");
  grant(TEST_ORG, "old", VIEWER, "viewer");
  // Channel access: on its own it is a contributor; beside an explicit grant the grant is the role (a viewer in the channel stays a viewer, a
  // maintainer stays one); an owner or admin is a maintainer either way; a project with no revision gives nothing; another org's channel is no one's here.
  channel(TEST_ORG, "web", CHANNEL_ONLY);
  channel(TEST_ORG, "old", CHANNEL_ONLY);
  channel(TEST_ORG, "nope", CHANNEL_ONLY);
  channel(TEST_ORG, "web", NONE);
  channel(TEST_ORG, "web", VIEWER);
  channel(TEST_ORG, "web", MAINTAINER);
  channel(TEST_ORG, "api", CONTRIBUTOR);
  channel(TEST_ORG, "web", ADMIN);
  channel(OTHER_ORG, "web", CHANNEL_ONLY);
  const real = createProjectMembers({
    documentClient: db, tableName: "state",
    channelAccess: async (orgId, project, developerId) => channels.has(`${orgId}|${project}|${developerId}`),
    channelProjects: async (orgId, developerId) => [...channels].flatMap((entry) => { const [org, project, who] = entry.split("|"); return org === orgId && who === developerId ? [project!] : []; }),
  });
  return { fake, real };
}

const sorted = <T extends { developerId?: string; project?: string }>(rows: T[]) => [...rows].sort((a, b) => (a.developerId ?? a.project ?? "").localeCompare(b.developerId ?? b.project ?? ""));
const CALLERS: Array<{ developerId: string; orgRole: OrgRole }> = [
  { developerId: OWNER, orgRole: "owner" }, { developerId: ADMIN, orgRole: "admin" }, { developerId: ADMIN_WITH_GRANT, orgRole: "admin" },
  { developerId: MAINTAINER, orgRole: "member" }, { developerId: CONTRIBUTOR, orgRole: "member" }, { developerId: VIEWER, orgRole: "member" }, { developerId: NONE, orgRole: "member" },
  { developerId: CHANNEL_ONLY, orgRole: "member" },
];

describe("the stand-in project members and the real ones", () => {
  it("name the same role for every caller on every project, including a missing one and another org's", async () => {
    const { fake, real } = world();
    for (const caller of CALLERS) for (const project of ["web", "api", "old", "nope"]) {
      expect(await fake.roleOf(TEST_ORG, project, caller), `${caller.developerId.slice(0, 1)} on ${project}`).toBe(await real.roleOf(TEST_ORG, project, caller));
    }
    expect(await fake.roleOf(OTHER_ORG, "api", CALLERS[0]!)).toBeUndefined();
    expect(await real.roleOf(OTHER_ORG, "api", CALLERS[0]!)).toBeUndefined();
  });

  it("name the same role for a person the project's channel gives access: a contributor, unless a grant says otherwise", async () => {
    const { fake, real } = world();
    const roles = async (who: string, project: string) => {
      const caller = { developerId: who, orgRole: "member" as const };
      const [fromFake, fromReal] = [await fake.roleOf(TEST_ORG, project, caller), await real.roleOf(TEST_ORG, project, caller)];
      expect(fromFake, `${who.slice(0, 1)} on ${project}`).toBe(fromReal);
      return fromReal;
    };
    expect(await roles(CHANNEL_ONLY, "web")).toBe("contributor");
    expect(await roles(NONE, "web")).toBe("contributor");
    // An explicit grant is the role, even beside the channel.
    expect(await roles(VIEWER, "web")).toBe("viewer");
    expect(await roles(MAINTAINER, "web")).toBe("maintainer");
    expect(await roles(CONTRIBUTOR, "api")).toBe("viewer");
    // The channel of an archived project still answers; a project with no revision does not exist, whoever is in its channel.
    expect(await roles(CHANNEL_ONLY, "old")).toBe("contributor");
    expect(await roles(CHANNEL_ONLY, "nope")).toBeUndefined();
    // No channel, no grant, no role; another org's channel gives nothing here.
    expect(await roles(CHANNEL_ONLY, "api")).toBeUndefined();
    expect(await real.roleOf(OTHER_ORG, "web", { developerId: NONE, orgRole: "member" })).toBeUndefined();
    expect(await fake.roleOf(OTHER_ORG, "web", { developerId: NONE, orgRole: "member" })).toBeUndefined();
    expect(await real.roleOf(OTHER_ORG, "web", { developerId: CHANNEL_ONLY, orgRole: "member" })).toBe("contributor");
    expect(await fake.roleOf(OTHER_ORG, "web", { developerId: CHANNEL_ONLY, orgRole: "member" })).toBe("contributor");
    // An org admin in the channel is a maintainer, as without it.
    expect(await real.roleOf(TEST_ORG, "web", { developerId: ADMIN, orgRole: "admin" })).toBe("maintainer");
    expect(await fake.roleOf(TEST_ORG, "web", { developerId: ADMIN, orgRole: "admin" })).toBe("maintainer");
  });

  it("do not list a person who reaches a project only through its channel", async () => {
    const { fake, real } = world();
    for (const project of ["web", "old"]) {
      expect((await real.list(TEST_ORG, project)).map((row) => row.developerId)).not.toContain(CHANNEL_ONLY);
      expect((await fake.list(TEST_ORG, project)).map((row) => row.developerId)).not.toContain(CHANNEL_ONLY);
    }
  });

  it("list owners and admins as org_role maintainers, once, then the grants of everyone else", async () => {
    const { fake, real } = world();
    for (const project of ["web", "api", "old", "nope"]) {
      expect(sorted(await fake.list(TEST_ORG, project)), project).toEqual(sorted(await real.list(TEST_ORG, project)));
    }
    const web = await real.list(TEST_ORG, "web");
    expect(web.filter((row) => row.source === "org_role").map((row) => row.developerId).sort()).toEqual([OWNER, ADMIN, ADMIN_WITH_GRANT].sort());
    expect(web.filter((row) => row.developerId === ADMIN_WITH_GRANT)).toHaveLength(1);
    expect(await fake.list(OTHER_ORG, "api")).toEqual([]);
  });

  it("list the projects a caller reaches, leaving out an archived one", async () => {
    const { fake, real } = world();
    for (const caller of CALLERS) {
      expect(sorted(await fake.projectsOf(TEST_ORG, caller)), caller.developerId.slice(0, 1)).toEqual(sorted(await real.projectsOf(TEST_ORG, caller)));
    }
    expect((await real.projectsOf(TEST_ORG, CALLERS[0]!)).map((entry) => entry.project)).toEqual(["api", "web"]);
    expect((await fake.projectsOf(TEST_ORG, { developerId: MAINTAINER, orgRole: "member" })).map((entry) => entry.project)).toEqual(["web"]);
    // A channel gives its project as a contributor; an archived project and one with no revision are left out; a grant beside it keeps its role.
    expect(await real.projectsOf(TEST_ORG, { developerId: CHANNEL_ONLY, orgRole: "member" })).toEqual([{ project: "web", role: "contributor" }]);
    expect(await fake.projectsOf(TEST_ORG, { developerId: CHANNEL_ONLY, orgRole: "member" })).toEqual([{ project: "web", role: "contributor" }]);
    expect(await real.projectsOf(TEST_ORG, { developerId: VIEWER, orgRole: "member" })).toEqual([{ project: "web", role: "viewer" }]);
    expect(await real.projectsOf(TEST_ORG, { developerId: CONTRIBUTOR, orgRole: "member" })).toEqual([{ project: "api", role: "viewer" }, { project: "web", role: "contributor" }]);
  });
});
