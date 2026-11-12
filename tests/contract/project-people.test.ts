// srv/project-people: A-31 (invites that carry a project and a project role), A-32 (the web's People tab: add, change, remove under the roster revision, never the last
// maintainer) and A-33 (which code settings the viewer may change; the writes are the existing code-settings route). Everything goes through the real route dispatcher
// (`routeDeveloperRequest`) as a browser session, or as a token where the browser-only rule is the point; invites are accepted through the real `OrgStore`.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentXError, errorStatus, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import { PROJECT_LAST_MAINTAINER_MESSAGE, PROJECT_PEOPLE_STALE_MESSAGE, type ProjectPeopleRole, ProjectPeopleViewReaderSchema, ProjectPeopleViewSchema, ProjectPersonChangeResponseReaderSchema, developerOrgKey, orgBanKey, orgMemberKey, orgMetaKey, type OrgRole } from "@agentx/cloud-contracts";
import { routeDeveloperRequest, type DeveloperCaller, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { StatusReply } from "../../packages/broker/src/aws/status-reply.js";
import { routeProjectPeople } from "../../packages/broker/src/aws/developer-routes/project-people.js";
import { joinedQuery } from "../../packages/broker/src/developer/server.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
import { projectPeopleRevisionKey, removeProjectMember } from "../../packages/broker/src/org/project-members.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const hex = (c: string) => c.repeat(64);
const OWNER = hex("1"), ADMIN = hex("2"), MAINT = hex("3"), OTHER_MAINT = hex("4"), CONTRIB = hex("5"), VIEWER = hex("6"), MEMBER = hex("7"), AUDITOR = hex("8"), NEWBIE = hex("9"), FOREIGN = hex("a"), MAINT2 = hex("b");
const NOW = Date.parse("2026-11-11T12:00:00Z");

/** The eight people of the brief, by what they are to project `payments` in company A. */
const PEOPLE = {
  owner: { id: OWNER, orgRole: "owner" }, admin: { id: ADMIN, orgRole: "admin" }, maintainer: { id: MAINT, orgRole: "member" }, otherMaintainer: { id: OTHER_MAINT, orgRole: "member" },
  contributor: { id: CONTRIB, orgRole: "member" }, viewer: { id: VIEWER, orgRole: "member" }, member: { id: MEMBER, orgRole: "member" }, auditor: { id: AUDITOR, orgRole: "auditor" },
} as const satisfies Record<string, { id: string; orgRole: OrgRole }>;
type Who = keyof typeof PEOPLE;

const DEFINITION = (name: string) => ({
  name, revision: 1, repositories: [{ name: "web", url: `https://github.com/acme/${name}.git`, path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
});
const BINDING = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };

function fixture(options: { audit?: boolean } = {}) {
  const db = new FakeDynamoDb();
  let nowMs = NOW;
  const now = () => nowMs;
  const capture = capturingAuditDeps({ db, now });
  const store = new OrgStore({ documentClient: db, tableName: "state", now, audit: capture.audit });
  const member = (orgId: OrgId, developerId: string, role: string) => {
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt: "2026-10-01T00:00:00Z" });
    db.set({ ...developerOrgKey(developerId), entityType: "DEVELOPER_ORG", orgId, role, joinedAt: "2026-10-01T00:00:00Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, displayName: `Person ${developerId.slice(0, 1)}`, provider: "oidc", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  };
  const project = (orgId: OrgId, name: string) => {
    db.set({ ...projectRevisionKey(orgId, name, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING, definition: DEFINITION(name) });
    db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  };
  const grant = (orgId: OrgId, developerId: string, name: string, role: ProjectRole) => db.set({
    ...projectMemberKey(orgId, developerId, name), entityType: "MEMBERSHIP", ownerKey: developerId, grantId: randomUUID(), projectName: name,
    role: role === "viewer" ? "viewer" : "developer", projectRole: role, grantedBy: { developerId: OWNER }, grantedAt: "2026-10-05T00:00:00.000Z",
  });
  for (const orgId of [A, B]) db.set({ ...orgMetaKey(orgId), entityType: "ORG", orgId, name: orgId === A ? "Acme" : "Other", plan: "team", createdAt: "x", createdBy: "x" });
  for (const person of Object.values(PEOPLE)) member(A, person.id, person.orgRole);
  member(B, FOREIGN, "owner");
  project(A, "payments"); project(A, "ledger"); project(B, "payments");
  grant(A, MAINT, "payments", "maintainer"); grant(A, OTHER_MAINT, "ledger", "maintainer"); grant(A, CONTRIB, "payments", "contributor"); grant(A, VIEWER, "payments", "viewer");
  // The other company has a project of the same name, maintained by its owner's grant-free role; a cross-company call must never reach it.
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "state", now, orgs: store, cloud: true,
    ...(options.audit === false ? {} : { audit: capture.audit }),
    developer: { issuer: "https://cell.example/v1/auth", env: "test", signInTableName: "state", methods: { cloud: true, slack: false, oidc: true }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true, memberOf: [] }) },
  };
  const callerOf = (who: Who | { id: string; orgRole: OrgRole; orgId?: OrgId }): DeveloperCaller => {
    const person = typeof who === "string" ? PEOPLE[who] : who;
    return { orgId: (typeof who === "string" ? A : who.orgId ?? A), developerId: person.id, orgRole: person.orgRole, name: "Person", amr: "oidc", sessionId: "fixture", browserSession: true };
  };
  /** A browser-session call (or, with `token`, a call with no authenticated caller, as a bearer token's is before authentication). */
  async function call(who: Who | { id: string; orgRole: OrgRole; orgId?: OrgId }, method: string, path: string, body?: unknown, token = false): Promise<{ status: number; body: Record<string, unknown>; code?: string; message?: string }> {
    const request = { method, path, headers: token ? { authorization: "Bearer never-authenticated" } : {}, body: body === undefined ? "" : JSON.stringify(body), requestId: "test" };
    try {
      const result = await routeDeveloperRequest(deps, request, new URL(path, "https://cell.example"), token ? undefined : { caller: callerOf(who), csrf: "csrf" });
      if (result instanceof StatusReply) return { status: result.statusCode, body: result.body as Record<string, unknown> };
      return { status: 200, body: result as Record<string, unknown> };
    } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: errorStatus(error.code), body: {}, code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") };
    }
  }
  const roleIn = (developerId: string, name = "payments", orgId: OrgId = A) => db.get(projectMemberKey(orgId, developerId, name))?.projectRole as string | undefined;
  const revision = (name = "payments", orgId: OrgId = A) => (db.get(projectPeopleRevisionKey(orgId, name))?.revision as number | undefined) ?? 0;
  return { db, capture, store, deps, call, grant, member, project, roleIn, revision, advance: (ms: number) => { nowMs += ms; } };
}
type Fixture = ReturnType<typeof fixture>;

const PEOPLE_PATH = "/v1/app/projects/payments/people";
const put = (f: Fixture, who: Who, target: string, role: ProjectPeopleRole, expectedRevision: number, requestId = randomUUID()) => f.call(who, "PUT", `${PEOPLE_PATH}/${target}`, { requestId, role, expectedRevision });
const del = (f: Fixture, who: Who, target: string, expectedRevision: number, requestId = randomUUID()) => f.call(who, "DELETE", `${PEOPLE_PATH}/${target}`, { requestId, expectedRevision });

// ---- A-32: the People tab ------------------------------------------------------------------------------------------------------------------------------------------------

describe("the People routes are browser-only", () => {
  it("refuses a token call to the read and both writes before any table read", async () => {
    const f = fixture();
    for (const [method, path] of [["GET", PEOPLE_PATH], ["PUT", `${PEOPLE_PATH}/${NEWBIE}`], ["DELETE", `${PEOPLE_PATH}/${NEWBIE}`]] as const) {
      const before = f.db.commandNames().length;
      const answer = await f.call("owner", method, path, { requestId: randomUUID(), role: "viewer", expectedRevision: 0 }, true);
      expect(answer, `${method} ${path}`).toMatchObject({ status: 403, code: "FORBIDDEN", message: expect.stringContaining("live browser session") as unknown });
      expect(f.db.commandNames().length, `${method} ${path}`).toBe(before);
    }
    expect(f.roleIn(NEWBIE)).toBeUndefined();
  });
});

describe("the People routes check the browser session themselves too", () => {
  it("refuses an authenticated caller that is not a browser session, before any read", async () => {
    const f = fixture();
    const caller: DeveloperCaller = { orgId: A, developerId: OWNER, orgRole: "owner", name: "Person", amr: "oidc", sessionId: "token" };
    for (const method of ["GET", "PUT", "DELETE"]) {
      const before = f.db.commandNames().length;
      const path = method === "GET" ? PEOPLE_PATH : `${PEOPLE_PATH}/${MEMBER}`;
      await expect(routeProjectPeople(f.deps, caller, method, path, () => ({ requestId: randomUUID(), role: "viewer", expectedRevision: 0 }))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.db.commandNames().length, method).toBe(before);
    }
    expect(await routeProjectPeople(f.deps, caller, "GET", "/v1/app/projects/payments/members", () => undefined)).toBeUndefined();
  });
});

describe("who sees the People tab, and with which powers", () => {
  const expected: Record<Who, { status: number; viewer?: Record<string, unknown> }> = {
    owner: { status: 200, viewer: { role: "maintainer", projectRole: "maintainer", canManageMembers: true, assignableRoles: ["maintainer", "contributor", "collaborator", "viewer"], canInvite: true, invitableRoles: ["maintainer", "contributor", "viewer"], canEditCodeSettings: true, canConfirmSelfApproval: true } },
    admin: { status: 200, viewer: { role: "maintainer", canManageMembers: true, canInvite: true, invitableRoles: ["maintainer", "contributor", "viewer"], canEditCodeSettings: true, canConfirmSelfApproval: true } },
    maintainer: { status: 200, viewer: { role: "maintainer", projectRole: "maintainer", canManageMembers: true, assignableRoles: ["maintainer", "contributor", "collaborator", "viewer"], canInvite: true, invitableRoles: ["contributor", "viewer"], canEditCodeSettings: true, canConfirmSelfApproval: false } },
    contributor: { status: 200, viewer: { role: "contributor", canManageMembers: false, assignableRoles: [], canInvite: false, invitableRoles: [], canEditCodeSettings: false, canConfirmSelfApproval: false } },
    viewer: { status: 200, viewer: { role: "viewer", canManageMembers: false, assignableRoles: [], canInvite: false, invitableRoles: [], canEditCodeSettings: false, canConfirmSelfApproval: false } },
    otherMaintainer: { status: 404 }, member: { status: 404 }, auditor: { status: 403 },
  };
  for (const who of Object.keys(PEOPLE) as Who[]) {
    it(`${who}: ${String(expected[who].status)}`, async () => {
      const f = fixture();
      const answer = await f.call(who, "GET", PEOPLE_PATH);
      expect(answer.status).toBe(expected[who].status);
      if (expected[who].status !== 200) { expect(answer.code).toBe(who === "auditor" ? "FORBIDDEN" : "PROJECT_NOT_FOUND"); return; }
      const view = ProjectPeopleViewSchema.parse(answer.body);
      expect(view.viewer).toMatchObject(expected[who].viewer!);
      expect(view.revision).toBe(0);
      expect(view.members.map((m) => [m.developerId, m.role, m.source]).sort()).toEqual([[ADMIN, "maintainer", "org_role"], [CONTRIB, "contributor", "grant"], [MAINT, "maintainer", "grant"], [OWNER, "maintainer", "org_role"], [VIEWER, "viewer", "grant"]].sort());
    });
  }

  it("offers no invite on an archived project", async () => {
    const f = fixture();
    f.db.set({ ...projectMetaKey(A, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived" });
    const view = ProjectPeopleViewSchema.parse((await f.call("owner", "GET", PEOPLE_PATH)).body);
    expect(view.viewer).toMatchObject({ canInvite: false, invitableRoles: [], canManageMembers: true });
  });
});

describe("adding, changing and removing a person: the CLI's rules", () => {
  // The Auditor is refused by the company's Auditor gate (403, "reads the audit log and nothing else") before the route runs.
  const putExpected: Record<Who, number> = { owner: 200, admin: 200, maintainer: 200, contributor: 403, viewer: 403, otherMaintainer: 404, member: 404, auditor: 403 };
  for (const who of Object.keys(PEOPLE) as Who[]) {
    it(`${who} adding a member as a viewer: ${String(putExpected[who])}`, async () => {
      const f = fixture();
      const answer = await put(f, who, MEMBER, "viewer", 0);
      expect(answer.status, JSON.stringify(answer)).toBe(putExpected[who]);
      if (putExpected[who] === 200) {
        expect(answer.body).toEqual({ member: { developerId: MEMBER, role: "viewer", projectRole: "viewer" }, revision: 1 });
        expect(f.roleIn(MEMBER)).toBe("viewer");
        expect(f.capture.recordedBy("project_member.changed")).toEqual([expect.objectContaining({ actor: { kind: "member", id: PEOPLE[who].id }, target: { kind: "project", name: "payments" }, facts: { toRole: "viewer" } })]);
      } else {
        expect(f.roleIn(MEMBER)).toBeUndefined();
        expect(f.revision()).toBe(0);
        expect(f.capture.recordedBy("project_member.changed")).toEqual([]);
      }
    });
    it(`${who} removing the contributor: ${String(putExpected[who])}`, async () => {
      const f = fixture();
      const answer = await del(f, who, CONTRIB, 0);
      expect(answer.status, JSON.stringify(answer)).toBe(putExpected[who]);
      expect(f.roleIn(CONTRIB)).toBe(putExpected[who] === 200 ? undefined : "contributor");
      expect(f.capture.recordedBy("project_member.removed").length).toBe(putExpected[who] === 200 ? 1 : 0);
    });
  }

  it("changes a role, and answers removed:false for a person with nothing to take away (an owner by company role)", async () => {
    const f = fixture();
    expect((await put(f, "maintainer", CONTRIB, "viewer", 0)).body).toEqual({ member: { developerId: CONTRIB, role: "viewer", projectRole: "viewer" }, revision: 1 });
    expect(f.capture.recordedBy("project_member.changed")).toEqual([expect.objectContaining({ facts: { fromRole: "contributor", toRole: "viewer" } })]);
    expect((await del(f, "maintainer", MEMBER, 1)).body).toEqual({ developerId: MEMBER, removed: false, revision: 1 });
    expect((await del(f, "maintainer", OWNER, 1))).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
  });

  it("names only a member of the caller's company: another company's person, an unknown id, an owner, an admin and the Auditor are refused", async () => {
    const f = fixture();
    expect(await put(f, "maintainer", FOREIGN, "viewer", 0)).toMatchObject({ status: 404, code: "NOT_FOUND", message: "that person isn't in your organization" });
    expect(await put(f, "maintainer", hex("c"), "viewer", 0)).toMatchObject({ status: 404, code: "NOT_FOUND" });
    for (const target of [OWNER, ADMIN, AUDITOR]) expect(await put(f, "maintainer", target, "viewer", 0), target).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    expect(f.db.get(projectMemberKey(A, FOREIGN, "payments"))).toBeUndefined();
    expect(f.db.get(projectMemberKey(B, FOREIGN, "payments"))).toBeUndefined();
    expect(f.revision()).toBe(0);
  });

  it("keeps companies apart: another company's owner gets the same 404 on a project of the same name, and nothing of either company changes", async () => {
    const f = fixture();
    const foreign = { id: FOREIGN, orgRole: "owner" as const, orgId: B };
    // B's own payments project is visible to B's owner, and shows B's people only.
    const own = ProjectPeopleViewSchema.parse((await f.call(foreign, "GET", PEOPLE_PATH)).body);
    expect(own.members.map((m) => m.developerId)).toEqual([FOREIGN]);
    // A's people can't be reached from B: the target is not in B.
    expect(await f.call(foreign, "PUT", `${PEOPLE_PATH}/${MEMBER}`, { requestId: randomUUID(), role: "viewer", expectedRevision: 0 })).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await f.call(foreign, "DELETE", `${PEOPLE_PATH}/${CONTRIB}`, { requestId: randomUUID(), expectedRevision: 0 })).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(f.roleIn(CONTRIB)).toBe("contributor");
    expect(await f.call(foreign, "GET", "/v1/app/projects/ledger/people")).toMatchObject({ status: 404, code: "PROJECT_NOT_FOUND" });
  });

  it("refuses a malformed body (no revision, unknown role, extra field) with nothing written", async () => {
    const f = fixture();
    for (const body of [{ requestId: randomUUID(), role: "viewer" }, { requestId: randomUUID(), role: "owner", expectedRevision: 0 }, { requestId: randomUUID(), role: "viewer", expectedRevision: 0, extra: 1 }, { requestId: "x", role: "viewer", expectedRevision: 0 }]) {
      expect(await f.call("maintainer", "PUT", `${PEOPLE_PATH}/${MEMBER}`, body), JSON.stringify(body)).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    }
    expect(f.db.transactions().length).toBe(0);
  });

  it("fails closed with no audit ledger: the web's change is always recorded", async () => {
    const f = fixture({ audit: false });
    expect(await put(f, "maintainer", MEMBER, "viewer", 0)).toMatchObject({ status: 503, code: "RUNTIME_UNAVAILABLE" });
    expect(f.roleIn(MEMBER)).toBeUndefined();
  });
});

describe("the last maintainer", () => {
  it("can't be removed or given a lower role, by the web or the CLI, and can once another person maintains the project", async () => {
    const f = fixture();
    for (const who of ["owner", "admin", "maintainer"] as const) {
      expect(await del(f, who, MAINT, 0), who).toMatchObject({ status: 400, code: "CONFIG_INVALID", message: PROJECT_LAST_MAINTAINER_MESSAGE });
      expect(await put(f, who, MAINT, "contributor", 0), who).toMatchObject({ status: 400, message: PROJECT_LAST_MAINTAINER_MESSAGE });
    }
    // The CLI's route is the same store function.
    const cli = await f.call("owner", "DELETE", `/v1/app/projects/payments/members/${MAINT}`, { requestId: randomUUID() });
    expect(cli).toMatchObject({ status: 400, message: PROJECT_LAST_MAINTAINER_MESSAGE });
    expect(f.roleIn(MAINT)).toBe("maintainer");
    expect(f.revision()).toBe(0);
    expect(f.capture.recordedBy("project_member.removed")).toEqual([]);
    expect((await put(f, "maintainer", CONTRIB, "maintainer", 0)).status).toBe(200);
    expect((await del(f, "maintainer", MAINT, 1)).body).toEqual({ developerId: MAINT, removed: true, revision: 2 });
    expect(f.roleIn(MAINT)).toBeUndefined();
  });

  it("holds under a race: two maintainers removing each other at once end with one maintainer, never none", async () => {
    const f = fixture();
    f.member(A, MAINT2, "member");
    f.grant(A, MAINT2, "payments", "maintainer");
    const send = f.db.send.bind(f.db);
    let raced = false;
    f.db.send = (async (command: unknown) => {
      if (!raced && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        raced = true;
        // Between MAINT's read of the roster and its commit, MAINT2 removes MAINT (through the store, as the CLI's route would).
        await removeProjectMember({ documentClient: f.db, tableName: "state", now: () => new Date(NOW) }, A, "payments", { requestId: randomUUID(), developerId: MAINT, actor: { developerId: MAINT2 } });
      }
      return send(command as never);
    });
    const answer = await f.call("maintainer", "DELETE", `/v1/app/projects/payments/members/${MAINT2}`, { requestId: randomUUID() });
    expect(answer).toMatchObject({ status: 400, message: PROJECT_LAST_MAINTAINER_MESSAGE });
    expect([f.roleIn(MAINT), f.roleIn(MAINT2)]).toEqual([undefined, "maintainer"]);
  });
});

describe("the roster revision", () => {
  it("refuses a change under a revision someone else moved, whether by the web or the CLI", async () => {
    const f = fixture();
    expect((await f.call("maintainer", "GET", PEOPLE_PATH)).body.revision).toBe(0);
    expect((await put(f, "maintainer", MEMBER, "viewer", 0)).body).toMatchObject({ revision: 1 });
    expect(await put(f, "owner", MEMBER, "contributor", 0)).toMatchObject({ status: 409, code: "CHANGE_STALE", message: PROJECT_PEOPLE_STALE_MESSAGE });
    expect(f.roleIn(MEMBER)).toBe("viewer");
    // A CLI change moves it too.
    expect((await f.call("owner", "PUT", `/v1/app/projects/payments/members/${MEMBER}`, { requestId: randomUUID(), role: "contributor" })).body).toEqual({ member: { developerId: MEMBER, role: "contributor", projectRole: "contributor" } });
    expect(f.revision()).toBe(2);
    expect(await del(f, "maintainer", MEMBER, 1)).toMatchObject({ status: 409, code: "CHANGE_STALE" });
    expect((await f.call("maintainer", "GET", PEOPLE_PATH)).body.revision).toBe(2);
    expect((await del(f, "maintainer", MEMBER, 2)).body).toEqual({ developerId: MEMBER, removed: true, revision: 3 });
  });

  it("a change to the role a person already has moves nothing and records nothing", async () => {
    const f = fixture();
    expect((await put(f, "maintainer", CONTRIB, "contributor", 0)).body).toEqual({ member: { developerId: CONTRIB, role: "contributor", projectRole: "contributor" }, revision: 0 });
    expect(f.revision()).toBe(0);
    expect(f.capture.recordedBy("project_member.changed")).toEqual([]);
  });
});

describe("request ids", () => {
  it("a replay answers the first outcome and writes nothing; the same id for another change is refused", async () => {
    const f = fixture();
    const requestId = randomUUID();
    const first = await put(f, "maintainer", MEMBER, "viewer", 0, requestId);
    expect(first.body).toEqual({ member: { developerId: MEMBER, role: "viewer", projectRole: "viewer" }, revision: 1 });
    const writes = f.db.transactions().length;
    // The replay carries the revision it was first sent with, now stale: still the stored answer, not a refusal.
    expect((await put(f, "maintainer", MEMBER, "viewer", 0, requestId)).body).toEqual(first.body);
    expect(f.db.transactions().length).toBe(writes);
    expect(await put(f, "maintainer", MEMBER, "contributor", 1, requestId)).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(await put(f, "owner", MEMBER, "viewer", 1, requestId)).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(f.capture.recordedBy("project_member.changed")).toHaveLength(1);
  });
});

// ---- Collaborator role (W11) on the People tab ------------------------------------------------------------------------------------------------------------------------------

describe("the collaborator role on the People tab", () => {
  const expected: Record<Who, number> = { owner: 200, admin: 200, maintainer: 200, contributor: 403, viewer: 403, otherMaintainer: 404, member: 404, auditor: 403 };
  for (const who of Object.keys(PEOPLE) as Who[]) {
    it(`${who} making a member a collaborator: ${String(expected[who])}`, async () => {
      const f = fixture();
      const answer = await put(f, who, MEMBER, "collaborator", 0);
      expect(answer.status, JSON.stringify(answer)).toBe(expected[who]);
      if (expected[who] !== 200) { expect(f.db.get(projectMemberKey(A, MEMBER, "payments"))).toBeUndefined(); expect(f.revision()).toBe(0); return; }
      // The floor for older clients, the exact role beside it; the reader keeps both.
      expect(answer.body).toEqual({ member: { developerId: MEMBER, role: "viewer", projectRole: "collaborator" }, revision: 1 });
      expect(ProjectPersonChangeResponseReaderSchema.parse(answer.body).member).toMatchObject({ role: "viewer", projectRole: "collaborator" });
      expect(f.db.get(projectMemberKey(A, MEMBER, "payments"))).toMatchObject({ role: "viewer", projectRole: "collaborator" });
      const view = ProjectPeopleViewReaderSchema.parse((await f.call(who, "GET", PEOPLE_PATH)).body);
      expect(view.members.find((m) => m.developerId === MEMBER)).toMatchObject({ role: "viewer", projectRole: "collaborator", source: "grant" });
      expect(view.revision).toBe(1);
      // The reader knows the exact role (it is not just passed through): collaborator is one of its four, a role it doesn't know reads as "unknown", and the floor stays three-valued.
      const raw = (await f.call(who, "GET", PEOPLE_PATH)).body as { members: Array<Record<string, unknown>> };
      const read = (projectRole: unknown, role: unknown = "viewer") => ProjectPeopleViewReaderSchema.parse({ ...raw, members: raw.members.map((m) => (m.developerId === MEMBER ? { ...m, role, projectRole } : m)) }).members.find((m) => m.developerId === MEMBER);
      expect(read("collaborator")).toMatchObject({ role: "viewer", projectRole: "collaborator" });
      expect(read("owner")).toMatchObject({ projectRole: "unknown" });
      expect(read("collaborator", "collaborator")).toMatchObject({ role: "unknown" });
    });
  }

  it("a collaborator sees the tab as a viewer, with its exact role beside the floor, and may give no role", async () => {
    const f = fixture();
    // A collaborator's grant row, as the store writes one: the coarse role is viewer, the exact role collaborator.
    f.db.set({ ...projectMemberKey(A, MEMBER, "payments"), entityType: "MEMBERSHIP", ownerKey: MEMBER, grantId: randomUUID(), projectName: "payments", role: "viewer", projectRole: "collaborator", grantedBy: { developerId: OWNER }, grantedAt: "2026-10-05T00:00:00.000Z" });
    const view = ProjectPeopleViewReaderSchema.parse((await f.call("member", "GET", PEOPLE_PATH)).body);
    expect(view.viewer).toMatchObject({ role: "viewer", projectRole: "collaborator", canManageMembers: false, assignableRoles: [], canInvite: false, canEditCodeSettings: false });
    expect(await put(f, "member", NEWBIE, "collaborator", 0)).toMatchObject({ status: 403 });
    // Contributors and viewers carry their exact role too.
    expect(ProjectPeopleViewReaderSchema.parse((await f.call("viewer", "GET", PEOPLE_PATH)).body).viewer).toMatchObject({ role: "viewer", projectRole: "viewer" });
  });

  it("a collaborator change is fenced by the roster revision", async () => {
    const f = fixture();
    expect((await put(f, "maintainer", CONTRIB, "viewer", 0)).status).toBe(200);
    expect(await put(f, "owner", MEMBER, "collaborator", 0)).toMatchObject({ status: 409, code: "CHANGE_STALE", message: PROJECT_PEOPLE_STALE_MESSAGE });
    expect(f.db.get(projectMemberKey(A, MEMBER, "payments"))).toBeUndefined();
    expect((await put(f, "owner", MEMBER, "collaborator", 1)).body).toMatchObject({ revision: 2 });
  });

  it("a collaborator is not a maintainer: with one present, the last maintainer still can't be removed or made a collaborator", async () => {
    const f = fixture();
    expect((await put(f, "maintainer", MEMBER, "collaborator", 0)).status).toBe(200);
    expect(await del(f, "owner", MAINT, 1)).toMatchObject({ status: 400, message: PROJECT_LAST_MAINTAINER_MESSAGE });
    expect(await put(f, "owner", MAINT, "collaborator", 1)).toMatchObject({ status: 400, message: PROJECT_LAST_MAINTAINER_MESSAGE });
    expect(f.roleIn(MAINT)).toBe("maintainer");
    // Once someone else maintains it, the maintainer may become a collaborator.
    expect((await put(f, "owner", MEMBER, "maintainer", 1)).status).toBe(200);
    expect((await put(f, "owner", MAINT, "collaborator", 2)).body).toEqual({ member: { developerId: MAINT, role: "viewer", projectRole: "collaborator" }, revision: 3 });
  });

  it("refuses a role outside Cloud's four, writing nothing", async () => {
    const f = fixture();
    for (const role of ["owner", "admin", "developer", "Collaborator"]) expect(await f.call("maintainer", "PUT", `${PEOPLE_PATH}/${MEMBER}`, { requestId: randomUUID(), role, expectedRevision: 0 }), role).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    expect(f.db.transactions().length).toBe(0);
  });
});

// ---- A-33: code settings from the web --------------------------------------------------------------------------------------------------------------------------------------

describe("code settings from the web (the existing route)", () => {
  const expected: Record<Who, number> = { owner: 200, admin: 200, maintainer: 200, contributor: 403, viewer: 403, otherMaintainer: 404, member: 404, auditor: 403 };
  for (const who of Object.keys(PEOPLE) as Who[]) {
    it(`${who} changing the merge method and reviewers: ${String(expected[who])}, matching what the People read says`, async () => {
      const f = fixture();
      const answer = await f.call(who, "PUT", "/v1/app/projects/payments/code-settings", { requestId: randomUUID(), expectedRevision: 0, mergeMethod: "merge", codeReviewers: ["acme/payments-team"] });
      expect(answer.status, JSON.stringify(answer)).toBe(expected[who]);
      if (expected[who] === 200) {
        expect(answer.body).toMatchObject({ settings: { mergeMethod: "merge", codeReviewers: ["acme/payments-team"], allowSelfApproval: false, revision: 1 } });
        // The route's audit rides on the approvals runtime (rovara-code-settings.test.ts covers it); this bench has none.
      }
      const view = await f.call(who, "GET", PEOPLE_PATH);
      if (view.status === 200) expect((view.body.viewer as { canEditCodeSettings: boolean }).canEditCodeSettings).toBe(expected[who] === 200);
    });
  }

  it("a stale revision is refused, and turning self-approval on is never applied by a maintainer alone", async () => {
    const f = fixture();
    expect((await f.call("maintainer", "PUT", "/v1/app/projects/payments/code-settings", { requestId: randomUUID(), expectedRevision: 0, mergeMethod: "merge" })).status).toBe(200);
    expect(await f.call("maintainer", "PUT", "/v1/app/projects/payments/code-settings", { requestId: randomUUID(), expectedRevision: 0, mergeMethod: "squash" })).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    // This bench has no approvals runtime: self-approval ON can't even be asked for, and nothing is applied.
    expect(await f.call("maintainer", "PUT", "/v1/app/projects/payments/code-settings", { requestId: randomUUID(), expectedRevision: 1, allowSelfApproval: true })).toMatchObject({ status: 503, code: "RUNTIME_UNAVAILABLE" });
    expect((await f.call("maintainer", "GET", "/v1/app/projects/payments/code-settings")).body).toMatchObject({ settings: { allowSelfApproval: false, revision: 1 } });
  });
});

// ---- A-31: invites that carry a project ------------------------------------------------------------------------------------------------------------------------------------

const INVITE_PATH = "/v1/app/org/invites/reviewed";
/** A project invite goes to a colleague's email (a maintainer's must: review M1); a company-only one is a link. */
const inviteBody = (project?: { name: string; role: ProjectRole }, requestId = randomUUID(), email: string | null = "new.person@example.test") => ({ requestId, role: "member", ...(project === undefined ? {} : { project, ...(email === null ? {} : { email }) }) });
const tokenOf = (answer: { body: Record<string, unknown> }) => new URL(String(answer.body.inviteUrl)).hash.slice("#invite=".length);
async function invite(f: Fixture, who: Who, project: { name: string; role: ProjectRole } = { name: "payments", role: "contributor" }) {
  const answer = await f.call(who, "POST", INVITE_PATH, inviteBody(project));
  expect(answer.status, JSON.stringify(answer)).toBe(200);
  return tokenOf(answer);
}
const accept = (f: Fixture, token: string, developerId = NEWBIE) => f.store.acceptInvite({ tokenHash: inviteTokenHash(token), developerId });
const refusal = async (promise: Promise<unknown>) => promise.then(() => "accepted", (error: { code?: string }) => String(error.code));

describe("who may invite someone straight into a project", () => {
  const expected: Record<Who, number> = { owner: 200, admin: 200, maintainer: 200, otherMaintainer: 403, contributor: 403, viewer: 403, member: 403, auditor: 403 };
  for (const who of Object.keys(PEOPLE) as Who[]) {
    it(`${who} inviting a contributor to payments: ${String(expected[who])}`, async () => {
      const f = fixture();
      const answer = await f.call(who, "POST", INVITE_PATH, inviteBody({ name: "payments", role: "contributor" }));
      expect(answer.status, JSON.stringify(answer)).toBe(expected[who]);
      const invites = f.db.find((row) => row.entityType === "ORG_INVITE");
      if (expected[who] !== 200) { expect(invites).toEqual([]); return; }
      expect(invites).toEqual([expect.objectContaining({ role: "member", project: { name: "payments", role: "contributor" }, projectInviter: who === "maintainer" ? "maintainer" : "admin", createdBy: PEOPLE[who].id })]);
      expect(answer.body.receipt).toMatchObject({ role: "member", project: { name: "payments", role: "contributor" } });
      expect(f.capture.recordedBy("project_member.invited")).toEqual([expect.objectContaining({ actor: { kind: "member", id: PEOPLE[who].id }, target: { kind: "project", name: "payments" }, facts: { role: "contributor", inviter: who === "maintainer" ? "maintainer" : "admin" } })]);
      expect(f.capture.recordedBy("org.invite_created")).toHaveLength(1);
    });
  }

  it("a maintainer invites only as contributor or viewer, only to an active project; an owner may invite a maintainer; an admin invite names no project", async () => {
    const f = fixture();
    expect(await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "maintainer" }))).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect((await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }))).status).toBe(200);
    expect((await f.call("owner", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "maintainer" }))).status).toBe(200);
    expect(await f.call("owner", "POST", INVITE_PATH, { requestId: randomUUID(), role: "admin", project: { name: "payments", role: "viewer" } })).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    expect(await f.call("maintainer", "POST", INVITE_PATH, inviteBody())).toMatchObject({ status: 403 });
    f.db.set({ ...projectMetaKey(A, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived" });
    expect(await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }))).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    expect(await f.call("owner", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }))).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    expect(await f.call("owner", "POST", INVITE_PATH, inviteBody({ name: "nowhere", role: "viewer" }))).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    expect(f.db.find((row) => row.entityType === "ORG_INVITE")).toHaveLength(2);
  });

  it("a maintainer's invite must name a colleague's email: no shareable link; an owner's or admin's project link is fine (review M1)", async () => {
    const f = fixture();
    const link = await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }, randomUUID(), null));
    expect(link).toMatchObject({ status: 400, code: "CONFIG_INVALID", message: expect.stringContaining("email address") as unknown });
    expect(await refusal(f.store.createInvite({ orgId: A, createdBy: MAINT, role: "member", requestId: randomUUID(), reviewed: true, project: { name: "payments", role: "viewer" } }))).toBe("CONFIG_INVALID");
    expect(f.db.find((row) => row.entityType === "ORG_INVITE")).toEqual([]);
    for (const who of ["owner", "admin"] as const) expect((await f.call(who, "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }, randomUUID(), null))).status, who).toBe(200);
    const made = f.db.find((row) => row.entityType === "ORG_INVITE");
    expect(made.map((row) => [row.projectInviter, row.email ?? null])).toEqual([["admin", null], ["admin", null]]);
  });

  it("keeps companies apart: another company's project of the same name gives a maintainer of it nothing here, and B's owner can't name A's project", async () => {
    const f = fixture();
    f.member(B, MAINT2, "member");
    f.grant(B, MAINT2, "ledger", "maintainer");
    const foreignMaintainer = { id: MAINT2, orgRole: "member" as const, orgId: B };
    // B has no ledger project; the grant alone makes no project.
    expect(await f.call(foreignMaintainer, "POST", INVITE_PATH, inviteBody({ name: "ledger", role: "viewer" }))).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    const foreignOwner = { id: FOREIGN, orgRole: "owner" as const, orgId: B };
    const answer = await f.call(foreignOwner, "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }));
    expect(answer.status).toBe(200);
    // The invite is B's, for B's payments: accepting it joins B and B's project, never A's.
    const joined = await accept(f, tokenOf(answer));
    expect(joined).toMatchObject({ orgId: B, project: { name: "payments", role: "viewer" } });
    expect(f.roleIn(NEWBIE, "payments", B)).toBe("viewer");
    expect(f.roleIn(NEWBIE, "payments", A)).toBeUndefined();
  });

  it("the route refuses before the store is asked, and the store refuses a non-maintainer on its own", async () => {
    const f = fixture();
    let asked = 0;
    const create = f.store.createInvite.bind(f.store);
    f.store.createInvite = (async (input: Parameters<OrgStore["createInvite"]>[0]) => { asked += 1; return create(input); });
    expect((await f.call("contributor", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }))).status).toBe(403);
    expect((await f.call("otherMaintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }))).status).toBe(403);
    expect(asked).toBe(0);
    expect(await refusal(f.store.createInvite({ orgId: A, createdBy: CONTRIB, role: "member", requestId: randomUUID(), reviewed: true, project: { name: "payments", role: "viewer" } }))).toBe("FORBIDDEN");
    expect(await refusal(f.store.createInvite({ orgId: A, createdBy: MAINT, role: "member", requestId: randomUUID(), reviewed: true, email: "x@example.test", project: { name: "payments", role: "maintainer" } }))).toBe("FORBIDDEN");
    expect(await refusal(f.store.createInvite({ orgId: A, createdBy: OWNER, role: "admin", requestId: randomUUID(), reviewed: true, project: { name: "payments", role: "viewer" } }))).toBe("CONFIG_INVALID");
    expect(await refusal(f.store.createInvite({ orgId: A, createdBy: AUDITOR, role: "member", requestId: randomUUID(), reviewed: true, project: { name: "payments", role: "viewer" } }))).toBe("FORBIDDEN");
    // Refused on the live read, before the rate counter or any write: no attempt was even counted.
    expect(f.db.find((row) => String(row.pk).includes("INVITE_CREATE_RATE"))).toEqual([]);
    // An Auditor left holding an old maintainer grant is still no maintainer (only a plain member may use the grant).
    f.grant(A, AUDITOR, "payments", "maintainer");
    expect(await refusal(f.store.createInvite({ orgId: A, createdBy: AUDITOR, role: "member", requestId: randomUUID(), reviewed: true, project: { name: "payments", role: "viewer" } }))).toBe("FORBIDDEN");
    expect(f.db.find((row) => row.entityType === "ORG_INVITE")).toEqual([]);
  });

  it("refuses a maintainer who lost the role while the invite was being written, with no partial invite", async () => {
    const f = fixture();
    const send = f.db.send.bind(f.db);
    let once = true;
    f.db.send = (async (command: unknown) => {
      if (once && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { once = false; f.grant(A, MAINT, "payments", "contributor"); }
      return send(command as never);
    });
    expect(await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }))).toMatchObject({ status: 403 });
    expect(f.db.find((row) => row.entityType === "ORG_INVITE")).toEqual([]);
    expect(f.capture.recordedBy("project_member.invited")).toEqual([]);
  });

  it("refuses a project archived while the invite was being written", async () => {
    const f = fixture();
    const send = f.db.send.bind(f.db);
    let once = true;
    f.db.send = (async (command: unknown) => {
      if (once && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { once = false; f.db.set({ ...projectMetaKey(A, "payments"), entityType: "PROJECT_META", status: "archived" }); }
      return send(command as never);
    });
    expect(await f.call("owner", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }))).toMatchObject({ status: 400, code: "CONFIG_INVALID" });
    expect(f.db.find((row) => row.entityType === "ORG_INVITE")).toEqual([]);
  });

  it("a replay answers the receipt with its project; the same request id for another project or role is refused", async () => {
    const f = fixture();
    const requestId = randomUUID();
    const first = await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }, requestId));
    expect(first.status).toBe(200);
    const replay = await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }, requestId));
    expect(replay.body).toEqual({ receipt: first.body.receipt });
    expect(await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "contributor" }, requestId))).toMatchObject({ status: 400 });
    expect(await f.call("owner", "POST", INVITE_PATH, inviteBody({ name: "ledger", role: "viewer" }, randomUUID()))).toMatchObject({ status: 200 });
    expect(await f.call("maintainer", "POST", INVITE_PATH, inviteBody(undefined, requestId))).toMatchObject({ status: 403 });
    expect(f.db.find((row) => row.entityType === "ORG_INVITE")).toHaveLength(2);
  });

  it("the company's invite list shows the project an invite carries", async () => {
    const f = fixture();
    await invite(f, "maintainer", { name: "payments", role: "viewer" });
    expect((await f.call("owner", "POST", INVITE_PATH, inviteBody())).status).toBe(200);
    const listed = (await f.call("owner", "GET", "/v1/app/org/invites")).body.invites as Array<{ createdBy: string; project?: unknown }>;
    expect(listed.map((row) => [row.createdBy, row.project ?? null]).sort()).toEqual([[MAINT, { name: "payments", role: "viewer" }], [OWNER, null]].sort());
  });

  it("a maintainer reads back the receipt of their own project invite only while they maintain the project", async () => {
    const f = fixture();
    const requestId = randomUUID();
    expect((await f.call("maintainer", "POST", INVITE_PATH, inviteBody({ name: "payments", role: "viewer" }, requestId))).status).toBe(200);
    expect((await f.call("maintainer", "GET", `/v1/app/org/invites/requests/${requestId}`)).body.receipt).toMatchObject({ project: { name: "payments", role: "viewer" } });
    expect(await f.call("contributor", "GET", `/v1/app/org/invites/requests/${requestId}`)).toMatchObject({ status: 404 });
    f.grant(A, MAINT, "payments", "contributor");
    expect(await f.call("maintainer", "GET", `/v1/app/org/invites/requests/${requestId}`)).toMatchObject({ status: 403 });
  });
});

describe("accepting an invite that carries a project", () => {
  it("joins the company and the project in one transaction, moves the roster revision, records both, and lands on the project", async () => {
    const f = fixture();
    const token = await invite(f, "maintainer", { name: "payments", role: "contributor" });
    const before = f.db.transactions().length;
    expect(await accept(f, token)).toEqual({ orgId: A, role: "member", project: { name: "payments", role: "contributor" } });
    expect(f.db.transactions().length).toBe(before + 1);
    expect(f.db.get(orgMemberKey(A, NEWBIE))).toMatchObject({ role: "member" });
    expect(f.db.get(projectMemberKey(A, NEWBIE, "payments"))).toMatchObject({ role: "developer", projectRole: "contributor", grantedBy: { developerId: MAINT } });
    expect(f.revision()).toBe(1);
    expect(f.capture.recordedBy("member.joined")).toHaveLength(1);
    expect(f.capture.recordedBy("project_member.joined_by_invite")).toEqual([expect.objectContaining({ actor: { kind: "member", id: NEWBIE }, target: { kind: "project", name: "payments" }, facts: { role: "contributor" }, related: [NEWBIE, MAINT] })]);
    // The roster the web shows has them.
    const view = ProjectPeopleViewSchema.parse((await f.call("maintainer", "GET", PEOPLE_PATH)).body);
    expect(view.members.find((m) => m.developerId === NEWBIE)).toMatchObject({ role: "contributor", source: "grant" });
    expect(joinedQuery({ projectName: "payments" })).toBe("joined=1&project=payments");
    expect(joinedQuery({ projectNote: "project_archived" })).toBe("joined=1&projectNote=project_archived");
    expect(joinedQuery({})).toBe("joined=1");
  });

  it("an owner's maintainer invite gives the maintainer role; a company-only invite gives no project", async () => {
    const f = fixture();
    expect(await accept(f, await invite(f, "owner", { name: "ledger", role: "maintainer" }))).toMatchObject({ project: { name: "ledger", role: "maintainer" } });
    expect(f.roleIn(NEWBIE, "ledger")).toBe("maintainer");
    const plain = await f.call("owner", "POST", INVITE_PATH, inviteBody());
    expect(await accept(f, tokenOf(plain), hex("d"))).toEqual({ orgId: A, role: "member" });
    expect(f.db.find((row) => row.entityType === "MEMBERSHIP" && row.ownerKey === hex("d"))).toEqual([]);
  });

  it("an expired or revoked invite adds no membership of either kind", async () => {
    const f = fixture();
    const expired = await invite(f, "maintainer");
    f.advance(8 * 86_400_000);
    expect(await refusal(accept(f, expired))).toBe("INVITE_INVALID");
    const revoked = await invite(f, "owner");
    const row = f.db.find((item) => item.entityType === "ORG_INVITE" && item.tokenHash !== undefined && String(item.expiresAt) > new Date(NOW + 8 * 86_400_000).toISOString())[0]!;
    f.db.set({ ...row, revokedAt: new Date(NOW).toISOString(), revokedBy: OWNER });
    expect(await refusal(accept(f, revoked))).toBe("INVITE_INVALID");
    expect(f.db.get(orgMemberKey(A, NEWBIE))).toBeUndefined();
    expect(f.roleIn(NEWBIE)).toBeUndefined();
    expect(f.capture.recordedBy("project_member.joined_by_invite")).toEqual([]);
  });

  it("a project archived since the invite: the company only, with a note and its record", async () => {
    const f = fixture();
    const token = await invite(f, "maintainer", { name: "payments", role: "viewer" });
    f.db.set({ ...projectMetaKey(A, "payments"), entityType: "PROJECT_META", name: "payments", status: "archived" });
    expect(await accept(f, token)).toEqual({ orgId: A, role: "member", projectNote: "project_archived" });
    expect(f.db.get(orgMemberKey(A, NEWBIE))).toMatchObject({ role: "member" });
    expect(f.roleIn(NEWBIE)).toBeUndefined();
    expect(f.revision()).toBe(0);
    expect(f.capture.recordedBy("project_member.invite_skipped")).toEqual([expect.objectContaining({ facts: { role: "viewer", cause: "project_archived" } })]);
  });

  it("a project removed since the invite: the company only, noted as gone", async () => {
    const f = fixture();
    const token = await invite(f, "owner", { name: "ledger", role: "viewer" });
    f.db.delete(projectRevisionKey(A, "ledger", 1));
    expect(await accept(f, token)).toEqual({ orgId: A, role: "member", projectNote: "project_gone" });
    expect(f.roleIn(NEWBIE, "ledger")).toBeUndefined();
  });

  it("a project archived during the join: read again, and the company only", async () => {
    const f = fixture();
    const token = await invite(f, "owner", { name: "payments", role: "viewer" });
    const send = f.db.send.bind(f.db);
    let once = true;
    f.db.send = (async (command: unknown) => {
      if (once && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { once = false; f.db.set({ ...projectMetaKey(A, "payments"), entityType: "PROJECT_META", status: "archived" }); }
      return send(command as never);
    });
    expect(await accept(f, token)).toEqual({ orgId: A, role: "member", projectNote: "project_archived" });
    expect(f.roleIn(NEWBIE)).toBeUndefined();
    expect(f.db.get(orgMemberKey(A, NEWBIE))).toMatchObject({ role: "member" });
  });

  it("a maintainer's invite counts only while they maintain the project: lost before or during the join, nobody joins; promoted to admin, it still counts", async () => {
    const before = fixture();
    const token = await invite(before, "maintainer");
    before.grant(A, MAINT, "payments", "viewer");
    expect(await refusal(accept(before, token))).toBe("INVITE_INVALID");
    expect(before.db.get(orgMemberKey(A, NEWBIE))).toBeUndefined();

    const during = fixture();
    const raced = await invite(during, "maintainer");
    const send = during.db.send.bind(during.db);
    let once = true;
    during.db.send = (async (command: unknown) => {
      if (once && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { once = false; during.db.delete(projectMemberKey(A, MAINT, "payments")); }
      return send(command as never);
    });
    expect(await refusal(accept(during, raced))).toBe("INVITE_INVALID");
    expect(during.db.get(orgMemberKey(A, NEWBIE))).toBeUndefined();
    expect(during.roleIn(NEWBIE)).toBeUndefined();
    expect(during.db.get(during.db.find((row) => row.entityType === "ORG_INVITE")[0] as { pk: string; sk: string })?.acceptedAt).toBeUndefined();

    const removed = fixture();
    const gone = await invite(removed, "maintainer");
    const sendRemoved = removed.db.send.bind(removed.db);
    let first = true;
    removed.db.send = (async (command: unknown) => {
      // The inviter leaves the company during the join; their grant row is left behind.
      if (first && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") { first = false; removed.db.delete(orgMemberKey(A, MAINT)); }
      return sendRemoved(command as never);
    });
    expect(await refusal(accept(removed, gone))).toBe("INVITE_INVALID");
    expect(removed.db.get(orgMemberKey(A, NEWBIE))).toBeUndefined();

    const promoted = fixture();
    const kept = await invite(promoted, "maintainer");
    promoted.member(A, MAINT, "admin");
    expect(await accept(promoted, kept)).toMatchObject({ project: { name: "payments", role: "contributor" } });

    const left = fixture();
    const orphan = await invite(left, "maintainer");
    left.db.delete(orgMemberKey(A, MAINT));
    expect(await refusal(accept(left, orphan))).toBe("INVITE_INVALID");
  });

  it("a project maintainer's invite never lifts a ban; an owner's or admin's invite still does (review H1)", async () => {
    const f = fixture();
    const banKey = orgBanKey(A, NEWBIE);
    f.db.set({ ...banKey, entityType: "ORG_BAN", orgId: A, developerId: NEWBIE });
    const token = await invite(f, "maintainer", { name: "payments", role: "viewer" });
    expect(await refusal(accept(f, token))).toBe("INVITE_INVALID");
    expect(f.db.get(banKey)).toBeDefined();
    expect(f.db.get(orgMemberKey(A, NEWBIE))).toBeUndefined();
    expect(f.roleIn(NEWBIE)).toBeUndefined();
    // An owner's invite is still the way back, as before: it clears the ban in the join.
    const owners = await invite(f, "owner", { name: "payments", role: "viewer" });
    expect(await accept(f, owners)).toMatchObject({ orgId: A, project: { name: "payments", role: "viewer" } });
    expect(f.db.get(banKey)).toBeUndefined();
    // A company-only admin invite too.
    const other = hex("e");
    f.db.set({ ...orgBanKey(A, other), entityType: "ORG_BAN", orgId: A, developerId: other });
    expect(await accept(f, tokenOf(await f.call("admin", "POST", INVITE_PATH, inviteBody())), other)).toEqual({ orgId: A, role: "member" });
    expect(f.db.get(orgBanKey(A, other))).toBeUndefined();
  });

  it("an operator's row on the person and project makes the invite invalid, not a config error (review L2)", async () => {
    const f = fixture();
    const token = await invite(f, "owner", { name: "payments", role: "viewer" });
    f.db.set({ ...projectMemberKey(A, NEWBIE, "payments"), entityType: "MEMBERSHIP", projectName: "payments", role: "administrator" });
    expect(await refusal(accept(f, token))).toBe("INVITE_INVALID");
    expect(f.db.get(orgMemberKey(A, NEWBIE))).toBeUndefined();
  });

  it("refuses an invite whose stored project part this release can't read, rather than joining without it", async () => {
    const f = fixture();
    const token = await invite(f, "owner");
    const row = f.db.find((item) => item.entityType === "ORG_INVITE")[0]!;
    f.db.set({ ...row, project: { name: "payments", role: "owner" } });
    expect(await refusal(accept(f, token))).toBe("INVITE_INVALID");
    f.db.set({ ...row, projectInviter: "someone" });
    expect(await refusal(accept(f, token))).toBe("INVITE_INVALID");
    expect(f.db.get(orgMemberKey(A, NEWBIE))).toBeUndefined();
  });

  it("an invite written before this release (no project) still joins exactly as before", async () => {
    const f = fixture();
    const plain = await f.call("owner", "POST", INVITE_PATH, inviteBody());
    const row = f.db.find((item) => item.entityType === "ORG_INVITE")[0]!;
    expect(row.project).toBeUndefined();
    expect(row.projectInviter).toBeUndefined();
    expect(await accept(f, tokenOf(plain))).toEqual({ orgId: A, role: "member" });
  });
});
