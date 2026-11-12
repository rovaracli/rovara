// Collaborator role (W11, A-23/A-26, experience decisions 14 and 36, owner answer Q8): the new project role, its row of the permission table, how its grant is stored and read (an older reader sees a
// viewer), the people routes and the project read, and the project's switch `collaboratorApprovals` (on by default, a maintainer changes it under the revision they read, audited, browser-only,
// company-scoped).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROJECT_PERMISSIONS as CODE_PROJECT_PERMISSIONS, projectAllows as codeProjectAllows, projectMemberKey, type ProjectPermission as CodePermission } from "@rovara-code/contracts";
import { GroupMappingRuleSchema, PROJECT_PERMISSIONS, PROJECT_ROLE_PRECEDENCE, ProjectRoleSchema, PutProjectMemberBodySchema, projectAllows, projectRoleFloor, type ProjectPermission, type ProjectRole } from "@agentx/cloud-contracts";
import { effectiveMemberRole, effectiveProjectRole, grantMemberRoleOf, grantRoleOf } from "../../packages/broker/src/developer/project-roles.js";
import { setProjectMember } from "../../packages/broker/src/org/project-members.js";
import { COLLABORATOR_APPROVALS_SK } from "../../packages/broker/src/collaborators/approvals-setting.js";
import { CARA, KIT, LENA, NEO, OTHER_ORG, OTTO, PRIYA, PROJECT, SAM, collaboratorBench, errorOf } from "../support/collaborator-bench.js";
import { TEST_ORG } from "../support/orgs.js";
import { projectPk } from "@rovara-code/contracts";

const CODE_PERMISSIONS: CodePermission[] = ["view", "start_tasks", "edit_settings", "manage_members", "archive", "setup_check", "manage_agents", "approve_spend", "approve_writes", "view_spend"];
const ALL: ProjectPermission[] = [...CODE_PERMISSIONS, "answer_questions", "approve_product_decisions", "comment", "ask"];
const SWITCH = `/v1/app/projects/${PROJECT}/collaborator-approvals`;

describe("the permission table", () => {
  it("has the four roles, and exactly these permissions per role", () => {
    expect(ProjectRoleSchema.options).toEqual(["maintainer", "contributor", "collaborator", "viewer"]);
    const table = Object.fromEntries(ProjectRoleSchema.options.map((role) => [role, ALL.filter((action) => projectAllows(role, action))]));
    expect(table).toEqual({
      maintainer: [...CODE_PERMISSIONS, "answer_questions", "approve_product_decisions", "comment", "ask"],
      // Decision 104: a contributor also uses the live Ask.
      contributor: ["view", "start_tasks", "answer_questions", "comment", "ask"],
      // Decision 103: a collaborator comments and uses the live Ask; a viewer does neither.
      collaborator: ["view", "answer_questions", "approve_product_decisions", "comment", "ask"],
      viewer: ["view"],
    });
    for (const role of ProjectRoleSchema.options) for (const action of ALL) expect(projectAllows(role, action), `${role} ${action}`).toBe(PROJECT_PERMISSIONS[role].includes(action));
  });

  it("gives a collaborator exactly a viewer's answer on every one of Code's permissions (so its viewer floor can never let it do more anywhere else)", () => {
    for (const action of CODE_PERMISSIONS) {
      expect(projectAllows("collaborator", action), action).toBe(codeProjectAllows("viewer", action));
      expect(codeProjectAllows(projectRoleFloor("collaborator"), action), action).toBe(projectAllows("collaborator", action));
    }
    // Cloud's table keeps Code's rows for the three roles Code has.
    for (const role of ["maintainer", "contributor", "viewer"] as const) for (const action of CODE_PERMISSIONS) expect(projectAllows(role, action), `${role} ${action}`).toBe(CODE_PROJECT_PERMISSIONS[role].includes(action));
  });

  it("never lets a collaborator start work, approve code or writes, merge, change settings, manage people or see spend", () => {
    for (const action of ["start_tasks", "approve_writes", "approve_spend", "edit_settings", "manage_members", "manage_agents", "archive", "setup_check", "view_spend"] as const) expect(projectAllows("collaborator", action), action).toBe(false);
  });

  it("floors only the collaborator, and keeps company sign-in mappings on Code's three roles (a saved collaborator mapping would lock an older broker out after a rollback)", () => {
    expect(ProjectRoleSchema.options.map(projectRoleFloor)).toEqual(["maintainer", "contributor", "viewer", "viewer"]);
    expect(PROJECT_ROLE_PRECEDENCE).toEqual(["maintainer", "contributor", "viewer"]);
    const rule = (role: string) => ({ id: "pm", group: "product", orgRole: "member", projectRoles: [{ project: PROJECT, role }] });
    expect(GroupMappingRuleSchema.safeParse(rule("viewer")).success).toBe(true);
    expect(GroupMappingRuleSchema.safeParse(rule("collaborator")).success).toBe(false);
    expect(PutProjectMemberBodySchema.safeParse({ requestId: randomUUID(), role: "collaborator" }).success).toBe(true);
    expect(PutProjectMemberBodySchema.safeParse({ requestId: randomUUID(), role: "owner" }).success).toBe(false);
  });
});

describe("a collaborator's grant row", () => {
  it("is stored as a viewer with projectRole collaborator: the exact read is a collaborator, every older read a viewer", () => {
    const row = { role: "viewer", projectRole: "collaborator" };
    expect(grantMemberRoleOf(row)).toBe("collaborator");
    expect(grantRoleOf(row)).toBe("viewer");
    const member = { orgRole: "member" as const, developerId: "x" };
    expect(effectiveMemberRole(member, row, false)).toBe("collaborator");
    expect(effectiveProjectRole(member, row, false)).toBe("viewer");
    // Exactly how the code before this change read a grant (`role: viewer` is a viewer): an older broker never takes a collaborator for more.
    const before = (grant: { role?: unknown; projectRole?: unknown }) => (grant.role === "viewer" ? "viewer" : grant.role === "developer" ? "contributor-or-more" : undefined);
    expect(before(row)).toBe("viewer");
  });

  it("reads a row that contradicts itself (developer with projectRole collaborator) as the least privileged role, and keeps every older shape as before", () => {
    expect(grantMemberRoleOf({ role: "developer", projectRole: "collaborator" })).toBe("viewer");
    expect(grantMemberRoleOf({ role: "developer" })).toBe("contributor");
    expect(grantMemberRoleOf({ role: "developer", projectRole: "maintainer" })).toBe("maintainer");
    expect(grantMemberRoleOf({ role: "viewer", projectRole: "maintainer" })).toBe("viewer");
    expect(grantMemberRoleOf({ role: "administrator" })).toBeUndefined();
    // An org owner or admin is a maintainer whatever grant they hold; an Auditor has no project role.
    expect(effectiveMemberRole({ orgRole: "admin", developerId: "x" }, { role: "viewer", projectRole: "collaborator" }, false)).toBe("maintainer");
    expect(effectiveMemberRole({ orgRole: "auditor", developerId: "x" }, { role: "viewer", projectRole: "collaborator" }, true)).toBeUndefined();
  });
});

describe("people routes and the project read", () => {
  it("lets a maintainer make someone a collaborator through the existing people route, stored and audited, and lists them with the exact role beside the floor", async () => {
    const b = await collaboratorBench();
    const put = await b.dev(PRIYA, "PUT", `/v1/app/projects/${PROJECT}/members/${NEO.developerId}`, { requestId: randomUUID(), role: "collaborator" });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject({ member: { developerId: NEO.developerId, role: "viewer", projectRole: "collaborator" } });
    expect(b.db.get(projectMemberKey(TEST_ORG, NEO.developerId, PROJECT))).toMatchObject({ role: "viewer", projectRole: "collaborator" });
    expect(b.audit.recordedBy("project_member.changed").map((event) => event.facts)).toEqual([{ fromRole: "contributor", toRole: "collaborator" }]);
    const listed = (await b.dev(LENA, "GET", `/v1/app/projects/${PROJECT}/members`)).body.members as Array<{ developerId: string; role: string; projectRole: string }>;
    expect(listed.find((m) => m.developerId === CARA.developerId)).toMatchObject({ role: "viewer", projectRole: "collaborator" });
    expect(listed.find((m) => m.developerId === NEO.developerId)).toMatchObject({ role: "viewer", projectRole: "collaborator" });
    // Ordered maintainers, contributors, collaborators, viewers.
    expect(listed.map((m) => m.projectRole)).toEqual(["maintainer", "maintainer", "contributor", "collaborator", "collaborator", "viewer"]);
  });

  it("refuses a role that is not one of the four at the route and at the store, writing nothing", async () => {
    const b = await collaboratorBench();
    const before = b.db.get(projectMemberKey(TEST_ORG, NEO.developerId, PROJECT));
    const refused = await b.dev(PRIYA, "PUT", `/v1/app/projects/${PROJECT}/members/${NEO.developerId}`, { requestId: randomUUID(), role: "approver" });
    expect(refused.status).toBe(400);
    await expect(setProjectMember({ documentClient: b.db, tableName: "state", now: () => new Date() }, TEST_ORG, PROJECT, { requestId: randomUUID(), developerId: NEO.developerId, role: "approver" as ProjectRole, actor: { developerId: PRIYA.developerId } }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(b.db.get(projectMemberKey(TEST_ORG, NEO.developerId, PROJECT))).toEqual(before);
  });

  it("shows a collaborator its project as a viewer in myRole and as a collaborator in myProjectRole, and refuses it starting work, changing people and the switch", async () => {
    const b = await collaboratorBench();
    const projects = (await b.dev(CARA, "GET", "/v1/app/projects")).body.projects as Array<{ name: string; myRole: string; myProjectRole: string }>;
    expect(projects.map((p) => [p.name, p.myRole, p.myProjectRole])).toEqual([[PROJECT, "viewer", "collaborator"]]);
    const detail = (await b.dev(CARA, "GET", `/v1/app/projects/${PROJECT}`)).body;
    expect(detail).toMatchObject({ myRole: "viewer", myProjectRole: "collaborator", collaboratorApprovals: { enabled: true, revision: 0, isDefault: true, canChange: false } });
    const start = await b.dev(CARA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: PROJECT, instructions: "Change the banner", client: "claude-code" });
    expect(errorOf(start)?.code).toBe("PROJECT_ACCESS_DENIED");
    expect((await b.dev(CARA, "PUT", `/v1/app/projects/${PROJECT}/members/${SAM.developerId}`, { requestId: randomUUID(), role: "collaborator" })).status).toBe(403);
    expect((await b.web(CARA, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 })).status).toBe(403);
    expect(b.db.get({ pk: projectPk(TEST_ORG, PROJECT), sk: COLLABORATOR_APPROVALS_SK })).toBeUndefined();
  });
});

describe("the project's collaborator switch", () => {
  it("is on by default; a maintainer turns it off and on under the revision they read, each change audited once", async () => {
    const b = await collaboratorBench();
    expect((await b.web(SAM, "GET", SWITCH)).body).toMatchObject({ collaboratorApprovals: { enabled: true, revision: 0, isDefault: true, canChange: false } });
    const off = await b.web(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ collaboratorApprovals: { enabled: false, revision: 1, isDefault: false, canChange: true } });
    const on = await b.web(LENA, "PUT", SWITCH, { requestId: randomUUID(), enabled: true, expectedRevision: 1 });
    expect(on.body).toMatchObject({ collaboratorApprovals: { enabled: true, revision: 2, isDefault: false, canChange: true } });
    expect(b.audit.recordedBy("project.collaborator_approvals_changed").map((event) => [event.actor.id, event.facts])).toEqual([
      [PRIYA.developerId, { enabled: false, revision: 1 }], [LENA.developerId, { enabled: true, revision: 2 }],
    ]);
    expect((await b.web(SAM, "GET", `/v1/app/projects/${PROJECT}`)).body).toMatchObject({ collaboratorApprovals: { enabled: true, revision: 2 } });
  });

  it("lets any maintainer turn it back on after another maintainer turned it off, with no second admin, and audits both (decision 103)", async () => {
    const b = await collaboratorBench();
    b.grant(NEO, "maintainer");
    expect((await b.web(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 })).status).toBe(200);
    const back = await b.web(NEO, "PUT", SWITCH, { requestId: randomUUID(), enabled: true, expectedRevision: 1 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ collaboratorApprovals: { enabled: true, revision: 2 } });
    expect(b.audit.recordedBy("project.collaborator_approvals_changed").map((event) => [event.actor.id, event.facts])).toEqual([
      [PRIYA.developerId, { enabled: false, revision: 1 }], [NEO.developerId, { enabled: true, revision: 2 }],
    ]);
  });

  it("refuses a stale revision (CHANGE_STALE) and writes nothing", async () => {
    const b = await collaboratorBench();
    await b.web(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 });
    const stale = await b.web(LENA, "PUT", SWITCH, { requestId: randomUUID(), enabled: true, expectedRevision: 0 });
    expect(errorOf(stale)?.code).toBe("CHANGE_STALE");
    expect(b.db.get({ pk: projectPk(TEST_ORG, PROJECT), sk: COLLABORATOR_APPROVALS_SK })).toMatchObject({ enabled: false, revision: 1 });
    expect(b.audit.recordedBy("project.collaborator_approvals_changed")).toHaveLength(1);
  });

  it("answers a replay of the same request id with what it answered and writes nothing; the same id with another body is CONFIG_INVALID", async () => {
    const b = await collaboratorBench();
    const requestId = randomUUID();
    const first = await b.web(PRIYA, "PUT", SWITCH, { requestId, enabled: false, expectedRevision: 0 });
    const again = await b.web(PRIYA, "PUT", SWITCH, { requestId, enabled: false, expectedRevision: 0 });
    expect(again.body).toEqual(first.body);
    expect(b.audit.recordedBy("project.collaborator_approvals_changed")).toHaveLength(1);
    expect(errorOf(await b.web(PRIYA, "PUT", SWITCH, { requestId, enabled: true, expectedRevision: 1 }))?.code).toBe("CONFIG_INVALID");
  });

  it("refuses every role but a maintainer (and a company owner or admin), and every caller without a live browser session, writing nothing", async () => {
    const b = await collaboratorBench();
    for (const who of [SAM, KIT, CARA, NEO]) expect((await b.web(who, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 })).status, who.name).toBe(403);
    const token = await b.dev(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 });
    expect(token.status).toBe(403);
    expect(errorOf(token)?.message).toContain("live browser session");
    expect(b.db.get({ pk: projectPk(TEST_ORG, PROJECT), sk: COLLABORATOR_APPROVALS_SK })).toBeUndefined();
    expect(b.audit.recordedBy("project.collaborator_approvals_changed")).toEqual([]);
  });

  it("is per company: another company's maintainer of a project with the same name reads and changes only its own", async () => {
    const b = await collaboratorBench();
    await b.web(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 });
    expect((await b.web(OTTO, "GET", SWITCH)).body).toMatchObject({ collaboratorApprovals: { enabled: true, revision: 0, isDefault: true, canChange: true } });
    expect((await b.web(OTTO, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 1 })).status).toBe(409);
    expect(b.db.get({ pk: projectPk(OTHER_ORG, PROJECT), sk: COLLABORATOR_APPROVALS_SK })).toBeUndefined();
    expect(b.db.get({ pk: projectPk(TEST_ORG, PROJECT), sk: COLLABORATOR_APPROVALS_SK })).toMatchObject({ enabled: false, revision: 1 });
    // A project the caller cannot see is the same 404 as a missing one.
    expect((await b.web(OTTO, "GET", "/v1/app/projects/nothing-here/collaborator-approvals")).status).toBe(404);
  });

  it("reads a stored setting that cannot be read as OFF (fail closed), and a maintainer can save over it at the revision it shows", async () => {
    const b = await collaboratorBench();
    b.db.set({ pk: projectPk(TEST_ORG, PROJECT), sk: COLLABORATOR_APPROVALS_SK, enabled: "yes" });
    expect((await b.web(PRIYA, "GET", SWITCH)).body).toMatchObject({ collaboratorApprovals: { enabled: false, revision: 0, isDefault: false, canChange: true } });
    expect((await b.web(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: true, expectedRevision: 0 })).body).toMatchObject({ collaboratorApprovals: { enabled: true, revision: 1, isDefault: false, canChange: true } });
  });
});
