// The source write route (Team record source-row lane, task 2): add, change, approve and reject a source row. Real second-person eligibility is read from seeded company records (the same
// evidence every other less-safe approval uses); the audit outbox is the capture fake. One FakeDynamoDb holds the State table and the TeamRecord table (it ignores table names).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SourcesAdminViewSchema, developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, teamRecordPk, type OrgId } from "@agentx/contracts";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import { placeWidened, type SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { erasePerson, eraseProject } from "../../../packages/broker/src/team-record/erase.js";
import type { CompanyLocks } from "../../../packages/broker/src/team-record/edition.js";
import { capturingAuditDeps } from "../../support/audit-capture.js";
import type { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { ORG_A, ORG_B, addSource, caller, world, type World } from "../../support/team-record-core.js";

// ---- people. Every id is a 64-character hex string, as the company's records keep them.
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MAINT = "c".repeat(64), CONTRIB = "d".repeat(64), VIEWER = "e".repeat(64), AUDITOR = "f".repeat(64), OTHER_ORG_MAINT = "1".repeat(64), OTHER_ORG_OWNER = "2".repeat(64);
type OrgRole = "owner" | "admin" | "member" | "auditor";
interface Who { id: string; orgRole: OrgRole; projectRole: "maintainer" | "contributor" | "viewer" | undefined; browser?: boolean }
const WHO = {
  owner: { id: OWNER, orgRole: "owner", projectRole: "maintainer" },
  admin: { id: ADMIN, orgRole: "admin", projectRole: "maintainer" },
  maint: { id: MAINT, orgRole: "member", projectRole: "maintainer" },
  contrib: { id: CONTRIB, orgRole: "member", projectRole: "contributor" },
  viewer: { id: VIEWER, orgRole: "member", projectRole: "viewer" },
  auditor: { id: AUDITOR, orgRole: "auditor", projectRole: "viewer" },
  stranger: { id: "9".repeat(64), orgRole: "member", projectRole: undefined },
} as const satisfies Record<string, Who>;

const AT = "2026-10-01T00:00:00.000Z";
function seedCompany(db: FakeDynamoDb, orgId: OrgId, people: Record<string, OrgRole>, maintainers: Array<{ id: string; project: string }>, projects: string[], meta: Record<string, unknown> = {}): void {
  db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG", createdAt: AT, approvalMembershipVersion: 3, approvalTrackingSince: AT, ...meta });
  for (const project of projects) db.set({ ...projectMetaKey(orgId, project), entityType: "PROJECT_META", name: project, status: "active", createdAt: AT, archiveRevision: 0 });
  for (const [id, role] of Object.entries(people)) {
    db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role, joinedAt: AT });
    db.set({ ...developerOrgKey(id), orgId, role });
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
  }
  for (const { id, project } of maintainers) db.set({ ...projectMemberKey(orgId, id, project), ownerKey: id, projectName: project, role: "developer", projectRole: "maintainer", grantId: `grant-${id.slice(0, 4)}` });
}

interface Harness { w: World; audit: ReturnType<typeof capturingAuditDeps>; repos: Map<string, number[]>; locks: { value: CompanyLocks | undefined }; paused: string[]; ids: { next: number }; skipped: Record<string, number> | undefined; repoNames?: Map<string, Array<{ id: number; name: string }>> }
function harness(options: { edition?: "enterprise" | "public"; people?: Record<string, OrgRole>; maintainers?: Array<{ id: string; project: string }>; meta?: Record<string, unknown> } = {}): Harness {
  const w = world({ edition: options.edition ?? "enterprise" });
  const audit = capturingAuditDeps({ db: w.db, now: () => w.clock.ms });
  seedCompany(w.db, ORG_A, options.people ?? { [OWNER]: "owner", [ADMIN]: "admin", [MAINT]: "member", [CONTRIB]: "member", [VIEWER]: "member", [AUDITOR]: "auditor" }, options.maintainers ?? [{ id: MAINT, project: "web" }], ["web", "api"], options.meta);
  seedCompany(w.db, ORG_B, { [OTHER_ORG_OWNER]: "owner", [OTHER_ORG_MAINT]: "member" }, [{ id: OTHER_ORG_MAINT, project: "web" }], ["web"]);
  const repos = new Map<string, number[]>([[`${ORG_A}/web`, [9]], [`${ORG_A}/api`, [9, 10]], [`${ORG_B}/web`, [9]]]);
  return { w, audit, repos, locks: { value: undefined }, paused: [], ids: { next: 1 }, skipped: undefined };
}

const dependencies = (h: Harness) => ({
  table: h.w.table, modes: h.w.deps.modes, now: () => h.w.clock.ms,
  ...(h.skipped === undefined ? {} : { skipped: { read: async () => h.skipped! } }),
  sources: {
    edition: h.w.deps.edition,
    projectRepositories: async (orgId: OrgId, project: string) => h.repos.get(`${orgId}/${project}`),
    ...(h.repoNames === undefined ? {} : { repositoryNames: async (orgId: OrgId, project: string) => h.repoNames!.get(`${orgId}/${project}`) }),
    locks: async () => h.locks.value,
    pausedSources: async () => h.paused,
    newId: () => `change-${String(h.ids.next++)}`,
  },
});

function contextOf(h: Harness, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}): SourceWriteContext {
  return { orgRole: who.orgRole, browserSession: who.browser !== false, body: () => body, audit: h.audit.deps, ...over };
}

const PATH = (project: string) => `/v1/app/projects/${project}/record/sources`;
async function post(h: Harness, who: Who, body: unknown, options: { org?: OrgId; project?: string; context?: Partial<SourceWriteContext> } = {}) {
  const reply = await handleRecordRoute(dependencies(h), {
    method: "POST", path: PATH(options.project ?? "web"), query: {}, caller: caller({ orgId: options.org ?? ORG_A, developerId: who.id, projectRole: who.projectRole }),
    write: contextOf(h, who, body, options.context),
  });
  return reply as { status: number; body: Record<string, unknown> };
}
async function get(h: Harness, who: Who, options: { withContext?: boolean; org?: OrgId } = {}) {
  return await handleRecordRoute(dependencies(h), {
    method: "GET", path: PATH("web"), query: {}, caller: caller({ orgId: options.org ?? ORG_A, developerId: who.id, projectRole: who.projectRole }),
    ...(options.withContext === false ? {} : { write: contextOf(h, who, undefined) }),
  }) as { status: number; body: Record<string, unknown> };
}

const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const add = (over: Record<string, unknown> = {}) => ({ action: "add", requestId: randomUUID(), source: "github", scope: "github:repo/9", retention: "C", audienceDefault: "maintainers", enabled: true, ...over });
const change = (expectedRevision: number, over: Record<string, unknown> = {}) => ({ action: "change", requestId: randomUUID(), source: "github", scope: "github:repo/9", expectedRevision, ...over });

const sourceRows = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE");
const proposals = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_CHANGE"); // no such row is ever written any more (T9)
const claims = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_SCOPE");
const requests = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REQUEST");
const nothingWritten = (h: Harness) => { expect(sourceRows(h)).toHaveLength(0); expect(proposals(h)).toHaveLength(0); expect(claims(h)).toHaveLength(0); expect(requests(h)).toHaveLength(0); };
const codeOf = (reply: { body: Record<string, unknown> }) => reply.body.code;
const flushed = async (h: Harness) => { await new Promise((resolve) => setTimeout(resolve, 0)); return h.audit.recorded(); };

describe("who may write", () => {
  it("a company owner, an admin and a maintainer of this project can add a source; the row is the stored one with revision 1", async () => {
    for (const who of [WHO.owner, WHO.admin, WHO.maint]) {
      const h = harness();
      const reply = await post(h, who, add());
      expect(reply, who.id).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
      const [row] = sourceRows(h);
      expect(row).toMatchObject({ workspaceId: ORG_A, project: "web", source: "github", scope: "github:repo/9", retention: "C", enabled: true, audienceDefault: "maintainers", exclude: [], health: "unknown", addedBy: who.id, revision: 1 });
      expect(claims(h)).toHaveLength(1);
      expect(claims(h)[0]).toMatchObject({ project: "web" });
    }
  });

  it("a contributor, a viewer and the Auditor are refused with FORBIDDEN and nothing is written; no project role answers as a missing project", async () => {
    for (const who of [WHO.contrib, WHO.viewer, WHO.auditor]) {
      const h = harness();
      const reply = await post(h, who, add());
      expect(codeOf(reply), who.id).toBe("FORBIDDEN");
      expect(reply.status).toBe(403);
      nothingWritten(h);
    }
    const h = harness();
    const missing = await post(h, WHO.stranger, add());
    expect(missing).toMatchObject({ status: 404, body: { code: "PROJECT_NOT_FOUND" } });
    nothingWritten(h);
  });

  it("every write needs a live browser session", async () => {
    const h = harness();
    const reply = await post(h, { ...WHO.owner, browser: false }, add());
    expect(reply).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(JSON.stringify(reply.body)).not.toContain("github");
    nothingWritten(h);
  });

  it("a company's records never answer another company: its maintainer adds to ITS project, and cannot change or remove a row of the first company", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    const other = { id: OTHER_ORG_MAINT, orgRole: "member", projectRole: "maintainer" } as const;
    expect(codeOf(await post(h, other, change(1, { retention: "D" }), { org: ORG_B }))).toBe("NOT_FOUND");
    expect(codeOf(await post(h, other, { action: "remove", requestId: randomUUID(), source: "github", scope: "github:repo/9", expectedRevision: 1 }, { org: ORG_B }))).toBe("NOT_FOUND");
    expect(sourceRows(h)[0]).toMatchObject({ workspaceId: ORG_A, retention: "C", revision: 1 });
    // The same place in company B is its own row and its own claim.
    expect(await post(h, other, add(), { org: ORG_B })).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(h).filter((row) => row.workspaceId === ORG_B)).toHaveLength(1);
    expect(sourceRows(h).filter((row) => row.workspaceId === ORG_A)).toHaveLength(1);
    expect(claims(h)).toHaveLength(2);
  });
});

describe("the place is resolved on the server", () => {
  it("a GitHub repository must be one of THIS project's repositories, read live; a name or id from another project's list is refused", async () => {
    const h = harness();
    for (const scope of ["github:repo/10", "github:repo/abc", "github:repo/0", "github:repo/9/extra", "github:acme/api"]) {
      const reply = await post(h, WHO.maint, add({ scope }));
      expect(reply, scope).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
      expect(JSON.stringify(reply.body), scope).not.toContain("acme");
    }
    nothingWritten(h);
    // The same id is fine for the project that holds it (api holds 10), and is read again each time.
    expect((await post(h, WHO.owner, add({ scope: "github:repo/10" }), { project: "api" })).status).toBe(200);
    h.repos.set(`${ORG_A}/web`, [9, 11]);
    expect((await post(h, WHO.owner, add({ scope: "github:repo/11" }))).status).toBe(200);
    // A repository list that cannot be read fails closed.
    h.repos.delete(`${ORG_A}/web`);
    expect(await post(h, WHO.owner, add({ scope: "github:repo/9" }))).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
  });

  it("a Rovara source is only this project's own place", async () => {
    const h = harness();
    expect((await post(h, WHO.maint, add({ source: "rovara", scope: "rovara:project/web" }))).status).toBe(200);
    expect(await post(h, WHO.maint, add({ source: "rovara", scope: "rovara:project/api" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)).toHaveLength(1);
  });

  it("MCP and plug-in code hosts are not available yet: a fixed code, nothing written (Slack, Linear and Jira are covered in source-routes-slack-tickets.test.ts)", async () => {
    const h = harness();
    for (const [source, scope] of [["mcp", "mcp:srv/x"], ["codehost:examplehost", "codehost:examplehost:repo/1"]] as const) {
      const reply = await post(h, WHO.owner, add({ source, scope }));
      expect(reply, source).toEqual({ status: 422, body: { code: "SOURCE_KIND_NOT_YET", message: "That kind of source can't be added yet." } });
    }
    nothingWritten(h);
  });

  it("a note opt-in belongs to Slack only", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ notesOptIn: true }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    nothingWritten(h);
  });

  it("the request body is checked against its strict schema and never echoed", async () => {
    const h = harness();
    for (const body of [{}, { action: "add" }, add({ orgId: ORG_B }), add({ retention: "Z" }), add({ requestId: "not-a-uuid" }), "text", null, change(0)]) {
      const reply = await post(h, WHO.owner, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(codeOf(reply)).toBe("CONFIG_INVALID");
      expect(JSON.stringify(reply.body)).not.toContain(ORG_B);
    }
    expect(await post(h, WHO.owner, undefined, { context: { body: () => { throw new Error("secret body text"); } } })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    nothingWritten(h);
  });
});

describe("the revision fence", () => {
  it("a change names the revision it read: the right one writes revision + 1, a stale one is CHANGE_STALE", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    expect(await post(h, WHO.maint, change(1, { enabled: false }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)[0]).toMatchObject({ enabled: false, revision: 2, retention: "C" });
    expect(await post(h, WHO.owner, change(1, { enabled: true }))).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ enabled: false, revision: 2 });
  });

  it("a row written before the route (no revision) reads as 0, and a change of it writes revision 1", async () => {
    const h = harness();
    await addSource(h.w, { source: "github", scope: "github:repo/9", retention: "C" });
    expect(sourceRows(h)[0]).not.toHaveProperty("revision");
    expect(await post(h, WHO.owner, change(5, { enabled: false }))).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(await post(h, WHO.owner, change(0, { enabled: false }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
  });

  it("an add of a place that already has a row is stale, and a change of a missing row is NOT_FOUND", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    expect(await post(h, WHO.owner, add())).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(await post(h, WHO.owner, change(0, { source: "rovara", scope: "rovara:project/web", enabled: false }))).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  });

  it("a change keeps what ingest wrote meanwhile (health, cursor) and drops a notes opt-in only when told", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    const row = sourceRows(h)[0]!;
    h.w.db.set({ ...row, health: "ok", lastCursor: "cursor-7" });
    expect(await post(h, WHO.owner, change(1, { exclude: ["u1", "u2"], audienceDefault: "project" }))).toMatchObject({ status: 200 });
    expect(sourceRows(h)[0]).toMatchObject({ health: "ok", lastCursor: "cursor-7", exclude: ["u1", "u2"], audienceDefault: "project", revision: 2, addedBy: OWNER });
  });

  it("two projects adding one place at the same moment: exactly one wins, the other is refused, and one claim names the winner", async () => {
    const h = harness();
    const [first, second] = await Promise.all([post(h, WHO.owner, add(), { project: "web" }), post(h, WHO.owner, add(), { project: "api" })]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const loser = first.status === 400 ? first : second;
    expect(loser.body.code).toBe("CONFIG_INVALID");
    expect(sourceRows(h)).toHaveLength(1);
    expect(claims(h)).toHaveLength(1);
    expect(claims(h)[0]).toMatchObject({ project: sourceRows(h)[0]!.project });
    // The loser left nothing behind (no request item either, so it can try another place with the same request id).
    expect(requests(h)).toHaveLength(1);
  });

  it("a place held by another project stays refused later, and the same project may keep the claim it holds", async () => {
    const h = harness();
    await post(h, WHO.owner, add(), { project: "web" });
    expect(await post(h, WHO.owner, add(), { project: "api" })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(JSON.stringify(sourceRows(h).map((row) => row.project))).toBe('["web"]');
  });

  it("saving a source row for a closed place opens it again, in the same transaction", async () => {
    const h = harness();
    const { recordScopeMarkerKey } = await import("@agentx/contracts");
    h.w.db.set({ ...recordScopeMarkerKey(ORG_A, "github:repo/9"), entityType: "TEAM_RECORD_SCOPE_CLOSED" });
    await post(h, WHO.owner, add());
    expect(h.w.db.get(recordScopeMarkerKey(ORG_A, "github:repo/9"))).toBeUndefined();
  });
});

describe("a repeated request", () => {
  it("the same request id and body answers the stored outcome and writes nothing", async () => {
    const h = harness();
    const body = add({ requestId: REQUEST_A });
    const first = await post(h, WHO.owner, body);
    const before = h.w.db.transactions().length;
    const again = await post(h, WHO.owner, body);
    expect(again).toEqual(first);
    expect(h.w.db.transactions().length).toBe(before);
    expect(sourceRows(h)).toHaveLength(1);
    expect(requests(h)).toHaveLength(1);
    // Even after the row moved on, the stored outcome is what a repeat gets.
    await post(h, WHO.owner, change(1, { enabled: false }));
    expect(await post(h, WHO.owner, body)).toEqual(first);
  });

  it("the same request id with another body is CONFIG_INVALID and writes nothing", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ requestId: REQUEST_A }));
    const before = JSON.stringify(sourceRows(h));
    expect(await post(h, WHO.owner, add({ requestId: REQUEST_A, retention: "B" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(JSON.stringify(sourceRows(h))).toBe(before);
  });

  it("another person's request id is its own: it does not read or block theirs", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ requestId: REQUEST_A }));
    const other = await post(h, WHO.admin, add({ requestId: REQUEST_A }));
    expect(other).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
  });

  it("an expired request item is not an answer", async () => {
    const h = harness();
    const body = add({ requestId: REQUEST_A });
    await post(h, WHO.owner, body);
    h.w.clock.ms += 2 * 86_400_000;
    // The place has its row, so the repeat is now a stale add, not the old answer.
    expect(await post(h, WHO.owner, body)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
  });
});

describe("retention rules (no second person: T9)", () => {
  it("the company's retention ceiling refuses a retention above it, whoever asks, and does not trouble an unrelated change", async () => {
    const h = harness();
    h.locks.value = { retentionCeiling: { default: "B" } };
    expect(await post(h, WHO.owner, add({ retention: "C" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, add({ retention: "D" }))).toMatchObject({ status: 400 });
    expect((await post(h, WHO.owner, add({ retention: "B" }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { retention: "D" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    h.locks.value = { retentionCeiling: { default: "A" } };
    expect((await post(h, WHO.owner, change(1, { enabled: false }))).status).toBe(200);
  });

  it("a retention the edition does not offer is refused", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ retention: "Z" }))).toMatchObject({ status: 400 });
  });

  it("final M8: a change to a GitHub row that turns it on or keeps more re-checks the repository is still the project's, and refuses as a missing place when it is not", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    expect((await post(h, WHO.owner, change(1, { enabled: false }))).status).toBe(200); // keeping less never asks
    h.repos.set(`${ORG_A}/web`, [11]); // the repository left the project
    expect(await post(h, WHO.owner, change(2, { enabled: true }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, change(2, { retention: "D" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)[0]).toMatchObject({ enabled: false, revision: 2 });
    expect(proposals(h)).toHaveLength(0);
    // Turning it off stays possible.
    expect((await post(h, WHO.owner, change(2, { exclude: ["U1"] }))).status).toBe(200);
    // A list that cannot be read fails closed for a turn-on.
    h.repos.delete(`${ORG_A}/web`);
    expect((await post(h, WHO.owner, change(3, { enabled: true }))).status).toBe(503);
  });

});

describe("what a place widens", () => {
  it("a private channel, a DM and a group DM widen what is kept, in both editions; a public channel and Slack Connect never do", () => {
    expect(placeWidened("enterprise", "private_channel")).toEqual(["private_channel"]);
    expect(placeWidened("enterprise", "dm")).toEqual(["dm"]);
    expect(placeWidened("enterprise", "mpim")).toEqual(["mpim"]);
    expect(placeWidened("enterprise", "public_channel")).toEqual([]);
    expect(placeWidened("enterprise", "slack_connect")).toEqual([]);
    expect(placeWidened("public", "private_channel")).toEqual(["private_channel"]);
    expect(placeWidened("public", "dm")).toEqual(["dm"]); // refused by the route in Public; the word is still the same
    expect(placeWidened("public", "public_channel")).toEqual([]);
    expect(placeWidened("enterprise", undefined)).toEqual([]);
  });
});

describe("the sources view", () => {
  it("a person who may edit gets the admin view: revisions, who added each, the approval of an older row and what is offered", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    await post(h, WHO.maint, change(1, { retention: "D" }));
    h.paused = ["github:9", "github:other"];
    const reply = await get(h, WHO.maint);
    expect(reply.status).toBe(200);
    const view = SourcesAdminViewSchema.parse(reply.body);
    expect(view.canEdit).toBe(true);
    expect(view.sources).toEqual([expect.objectContaining({ kind: "github", scope: "github:repo/9", revision: 2, addedBy: OWNER, retention: "D", exclude: [], excluded: 0, paused: true })]);
    expect(view.otherPaused).toBe(1);
    expect(view.offered.github).toEqual(["A", "B", "C", "D"]);
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG_OWNER);
  });

  it("T5: the admin view lists the project's repositories with their places, from the same live read, so the screen can offer them; an unreadable list leaves them out", async () => {
    const h = harness();
    h.repoNames = new Map([[`${ORG_A}/web`, [{ id: 9, name: "payments-api" }, { id: 12, name: "web-app" }]]]);
    const view = SourcesAdminViewSchema.parse((await get(h, WHO.maint)).body);
    expect(view.repositories).toEqual([{ name: "payments-api", scope: "github:repo/9" }, { name: "web-app", scope: "github:repo/12" }]);
    h.repoNames = new Map();
    expect(SourcesAdminViewSchema.parse((await get(h, WHO.maint)).body)).not.toHaveProperty("repositories");
    // Another company's project of the same name never lends its list.
    h.repoNames = new Map([[`${ORG_B}/web`, [{ id: 9, name: "other-company-repo" }]]]);
    expect(JSON.stringify((await get(h, WHO.maint)).body)).not.toContain("other-company-repo");
  });

  it("the offered retention follows the edition and the company's ceiling", async () => {
    const h = harness({ edition: "public", people: { [OWNER]: "owner" }, maintainers: [] });
    h.locks.value = { retentionCeiling: { github: "C" } };
    const view = SourcesAdminViewSchema.parse((await get(h, WHO.owner)).body);
    expect(view.offered.slack).toEqual(["A", "B"]);
    expect(view.offered.github).toEqual(["A", "B", "C"]);
  });

  it("everyone else gets exactly the reply the route always gave, with or without the write context", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    await post(h, WHO.maint, change(1, { retention: "D" }));
    for (const who of [WHO.contrib, WHO.viewer, WHO.auditor]) {
      const withContext = await get(h, who);
      const without = await get(h, who, { withContext: false });
      expect(JSON.stringify(withContext), who.id).toBe(JSON.stringify(without));
      expect(withContext.body).not.toHaveProperty("canEdit");
      expect(withContext.body).not.toHaveProperty("pending");
      expect((withContext.body.sources as Array<Record<string, unknown>>)[0]).not.toHaveProperty("addedBy");
      expect((withContext.body.sources as Array<Record<string, unknown>>)[0]).not.toHaveProperty("approval");
    }
    // A maintainer asking WITHOUT the write context (a caller that does not pass it) gets that same older reply.
    expect(Object.keys((await get(h, WHO.maint, { withContext: false })).body).sort()).toEqual(["sources"]);
  });

  it("another company reads nothing of this one", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    const other = await get(h, { id: OTHER_ORG_MAINT, orgRole: "member", projectRole: "maintainer" }, { org: ORG_B });
    expect(SourcesAdminViewSchema.parse(other.body).sources).toEqual([]);
  });
});

describe("erasure and archive reach the new items", () => {
  it("archiving a project leaves no claim and no request item of it, and another project's claim stays", async () => {
    const h = harness();
    await post(h, WHO.owner, add(), { project: "web" });
    await post(h, WHO.owner, add({ scope: "github:repo/10" }), { project: "api" });
    await post(h, WHO.owner, change(1, { retention: "D" }), { project: "web" });
    expect(claims(h)).toHaveLength(2);
    const d = deleteDeps(h.w);
    const done = await eraseProject(d.deps, ORG_A, "web", "project_archived", "archive-1");
    expect(done.complete).toBe(true);
    expect(sourceRows(h).map((row) => row.project)).toEqual(["api"]);
    expect(claims(h).map((item) => item.project)).toEqual(["api"]);
    expect(requests(h).filter((item) => String(item.pk).endsWith("#P#web"))).toHaveLength(0);
    // The place is free for another project to take again.
    expect(h.w.db.find((item) => item.project === "web" && String(item.sk).startsWith("SRC"))).toEqual([]);
  });

  it("closing the company removes every claim", async () => {
    const h = harness();
    await post(h, WHO.owner, add(), { project: "web" });
    const { eraseWorkspace } = await import("../../../packages/broker/src/team-record/erase.js");
    const d = deleteDeps(h.w);
    const done = await eraseWorkspace(d.deps, ORG_A, ["web", "api"], "close-1");
    expect(done.complete).toBe(true);
    expect(claims(h)).toHaveLength(0);
    // The lake's own delete queue stays until the lake job has run; nothing else of the company is left.
    expect(h.w.db.find((item) => String(item.pk) === teamRecordPk(ORG_A) && !String(item.sk).startsWith("LAKEDEL#"))).toEqual([]);
  });
});

describe("fix round 1", () => {
  it("1. an editor still gets the skipped-for-unlinked-author counts, in the admin view; members' reply is unchanged", async () => {
    const h = harness();
    h.skipped = { jira: 3 };
    await post(h, WHO.owner, add());
    const view = SourcesAdminViewSchema.parse((await get(h, WHO.maint)).body);
    expect(view.skippedUnlinked).toEqual({ jira: 3 });
    // The old reply gave the counts to maintainers only, and not to a contributor.
    expect((await get(h, WHO.contrib)).body).not.toHaveProperty("skippedUnlinked");
    expect(JSON.stringify(await get(h, WHO.contrib))).toBe(JSON.stringify(await get(h, WHO.contrib, { withContext: false })));
    // Where nothing is read, the view has none.
    const bare = harness();
    expect(SourcesAdminViewSchema.parse((await get(bare, WHO.maint)).body)).not.toHaveProperty("skippedUnlinked");
  });

  it("2. the audit event of an add or a change does not depend on the client's request id: the same id in two projects, or after the request item expired, still audits", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ requestId: REQUEST_A }), { project: "web" });
    await post(h, WHO.owner, add({ requestId: REQUEST_A, scope: "github:repo/10" }), { project: "api" });
    const added = (await flushed(h)).filter((event) => event.action === "record.source_added");
    expect(added).toHaveLength(2);
    expect(new Set(added.map((event) => event.eventId)).size).toBe(2);
    const R2 = "22222222-2222-4222-8222-222222222222";
    expect((await post(h, WHO.owner, change(1, { requestId: R2, enabled: false }))).status).toBe(200);
    h.w.clock.ms += 2 * 86_400_000; // the request item is gone
    expect((await post(h, WHO.owner, change(2, { requestId: R2, enabled: true }))).status).toBe(200);
    const changed = (await flushed(h)).filter((event) => event.action === "record.source_changed");
    expect(changed).toHaveLength(2);
    expect(new Set(changed.map((event) => event.eventId)).size).toBe(2);
    // Another person using the same id is audited too.
    expect((await post(h, WHO.admin, change(3, { requestId: R2, enabled: false }))).status).toBe(200);
    expect((await flushed(h)).filter((event) => event.action === "record.source_changed")).toHaveLength(3);
  });

  it("3. a person erase moves the row's revision: a change made from a page loaded before it is CHANGE_STALE and the erased id stays gone", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    expect((await post(h, WHO.owner, change(1, { exclude: ["U123", "U999"] }))).status).toBe(200); // revision 2
    const d = deleteDeps(h.w);
    const erased = await erasePerson(d.deps, ORG_A, { developerId: "5".repeat(64), projects: ["web"], identities: [{ system: "slack", sourceId: "U123" }] }, "erase-fence-1");
    expect(erased.steps?.config).toBe(true);
    expect(sourceRows(h)[0]).toMatchObject({ exclude: ["U999"], revision: 3 });
    expect(await post(h, WHO.owner, change(2, { exclude: ["U123", "U999"] }))).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ exclude: ["U999"], revision: 3 });
    // The adder's id is scrubbed under the same fence.
    const erasedAdder = await erasePerson(d.deps, ORG_A, { developerId: OWNER, projects: ["web"] }, "erase-fence-2");
    expect(erasedAdder.steps?.config).toBe(true);
    expect(sourceRows(h)[0]).toMatchObject({ addedBy: "0".repeat(64), revision: 4 });
    expect(await post(h, WHO.admin, change(3, { enabled: false }))).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
  });

  it("3. the scrub gives way to an editor who changed the same list meanwhile, and tries again within a bound", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    await post(h, WHO.owner, change(1, { exclude: ["U123"] }));
    const send = h.w.db.send.bind(h.w.db);
    let raced = false;
    h.w.db.send = async (command: Parameters<FakeDynamoDb["send"]>[0]) => {
      // An editor adds a second id just before the scrub's first write lands.
      if (!raced && (command as { constructor: { name: string } }).constructor.name === "UpdateCommand") {
        raced = true;
        h.w.db.set({ ...sourceRows(h)[0]!, exclude: ["U123", "U777"], revision: 3 });
      }
      return send(command);
    };
    const d = deleteDeps(h.w);
    await erasePerson(d.deps, ORG_A, { developerId: "5".repeat(64), projects: ["web"], identities: [{ system: "slack", sourceId: "U123" }] }, "erase-fence-3");
    expect(raced).toBe(true);
    expect(sourceRows(h)[0]).toMatchObject({ exclude: ["U777"], revision: 4 });
  });

  it("5. the admin view, which carries person ids, is served only to a live browser session", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    const token = await get(h, { ...WHO.maint, browser: false });
    expect(JSON.stringify(token)).toBe(JSON.stringify(await get(h, WHO.maint, { withContext: false })));
    expect(token.body).not.toHaveProperty("canEdit");
    expect(JSON.stringify(token.body)).not.toContain(OWNER);
    expect(SourcesAdminViewSchema.parse((await get(h, WHO.maint)).body).canEdit).toBe(true);
  });

});

// ---- Task 9 (owner decision 2026-11-04): no second person for any source change, in either edition. Every editor's change applies at once and is audited.
describe("T9: every editor's change applies at once, with a `widened` audit fact", () => {
  const sourceEvents = async (h: Harness) => (await flushed(h)).filter((event) => event.action === "record.source_added" || event.action === "record.source_changed");
  const nothingWaits = async (h: Harness) => {
    expect(proposals(h)).toHaveLength(0);
    const actions = (await flushed(h)).map((event) => event.action as string);
    expect(actions).not.toContain("record.source_change_proposed");
    expect(actions).not.toContain("record.source_change_decided");
  };

  it("an Enterprise retention raise is saved at once, by an owner, an admin and a maintainer; the row moves, the audit says widened: retention_raise, and nothing waits", async () => {
    for (const who of [WHO.owner, WHO.admin, WHO.maint]) {
      const h = harness();
      expect((await post(h, WHO.owner, add({ retention: "C" }))).status).toBe(200);
      expect(await post(h, who, change(1, { retention: "D" })), who.id).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
      expect(sourceRows(h)[0], who.id).toMatchObject({ retention: "D", revision: 2 });
      const [changed] = (await sourceEvents(h)).filter((event) => event.action === "record.source_changed");
      expect(changed, who.id).toMatchObject({ actor: { kind: "member", id: who.id }, facts: { source: "github", fromRetention: "C", toRetention: "D", enabled: true, widened: "retention_raise" } });
      expect(JSON.stringify(changed)).not.toContain("repo/9");
      await nothingWaits(h);
    }
  });

  it("adding above the Enterprise default is saved at once, with its row and claim, and says widened: retention_raise", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ retention: "D" }))).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(h)).toHaveLength(1);
    expect(claims(h)).toHaveLength(1);
    expect((await sourceEvents(h))[0]).toMatchObject({ action: "record.source_added", facts: { source: "github", retention: "D", restricted: false, widened: "retention_raise" } });
    await nothingWaits(h);
  });

  it("a change that widens nothing carries no widened fact: a lowering, an on/off switch, and an add at or below the default", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ retention: "C" }))).status).toBe(200);
    expect((await post(h, WHO.owner, change(1, { retention: "B" }))).status).toBe(200);
    expect((await post(h, WHO.owner, change(2, { enabled: false }))).status).toBe(200);
    for (const event of await sourceEvents(h)) expect(event.facts, JSON.stringify(event.facts)).not.toHaveProperty("widened");
    const pub = harness({ edition: "public" });
    expect((await post(pub, WHO.owner, add({ retention: "B" }))).status).toBe(200); // below Public's default (D)
    for (const event of await sourceEvents(pub)) expect(event.facts).not.toHaveProperty("widened");
  });

  it("the Public edition says widened too (fix round 1): a raise from the stored retention is audited with retention_raise, and without a ledger it is refused like Enterprise", async () => {
    const h = harness({ edition: "public" });
    expect((await post(h, WHO.owner, add({ retention: "B" }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { retention: "D" }), { context: { audit: {} } })).toMatchObject({ status: 503, body: { code: "AUDIT_UNAVAILABLE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "B", revision: 1 });
    expect((await post(h, WHO.owner, change(1, { retention: "D" }))).status).toBe(200);
    const changed = (await sourceEvents(h)).filter((event) => event.action === "record.source_changed");
    expect(changed[0]).toMatchObject({ facts: { fromRetention: "B", toRetention: "D", widened: "retention_raise" } });
    // An ordinary Public write still goes on without a ledger.
    expect((await post(h, WHO.owner, change(2, { enabled: false }), { context: { audit: {} } })).status).toBe(200);
  });

  it("the write context has no second-person check, roster or fresh sign-in (T9): a context of role, session, body and audit saves the same raise, for a maintainer", async () => {
    const h = harness();
    const bare: Partial<SourceWriteContext> = {};
    expect((await post(h, WHO.maint, add({ retention: "D" }), { context: bare })).status).toBe(200);
    expect((await post(h, WHO.maint, change(1, { retention: "B" }), { context: bare })).status).toBe(200);
    expect((await post(h, WHO.maint, change(2, { retention: "D" }), { context: bare })).status).toBe(200);
    expect(sourceRows(h)[0]).toMatchObject({ retention: "D", revision: 3 });
  });

  it("the approve and reject actions are gone: an old body is CONFIG_INVALID and writes nothing", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    const before = h.w.db.find(() => true).length;
    for (const body of [{ action: "approve", changeId: "change-1" }, { action: "reject", changeId: "change-1" }]) {
      expect(await post(h, WHO.owner, body), body.action).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    }
    expect(h.w.db.find(() => true)).toHaveLength(before);
  });

  it("a widened write is refused when its audit item cannot be written, and an ordinary write goes on without a ledger", async () => {
    const h = harness();
    expect((await post(h, WHO.owner, add({ retention: "C" }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { retention: "D" }), { context: { audit: {} } })).toMatchObject({ status: 503, body: { code: "AUDIT_UNAVAILABLE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
    expect((await post(h, WHO.owner, change(1, { enabled: false }), { context: { audit: {} } })).status).toBe(200);
  });

  it("a repeat of a widened request answers the stored outcome, writes no second row and audits once", async () => {
    const h = harness();
    const body = add({ retention: "D", requestId: REQUEST_A });
    const first = await post(h, WHO.owner, body);
    expect(await post(h, WHO.owner, body)).toEqual(first);
    expect(sourceRows(h)).toHaveLength(1);
    expect((await sourceEvents(h)).filter((event) => event.action === "record.source_added")).toHaveLength(1);
  });

  it("the admin view has no pending list and no soleApprover; the other company's editor changes only its own rows", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ retention: "D" }));
    const view = await get(h, WHO.owner);
    expect(view.body).not.toHaveProperty("pending");
    expect(view.body).not.toHaveProperty("soleApprover");
    expect(SourcesAdminViewSchema.safeParse(view.body).success).toBe(true);
    const other = { id: OTHER_ORG_MAINT, orgRole: "member", projectRole: "maintainer" } as const;
    expect(await post(h, other, change(1, { retention: "B" }), { org: ORG_B })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(sourceRows(h)[0]).toMatchObject({ workspaceId: ORG_A, retention: "D", revision: 1 });
  });

});
