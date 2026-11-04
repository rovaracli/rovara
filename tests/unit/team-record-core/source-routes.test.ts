// The source write route (Team record source-row lane, task 2): add, change, approve and reject a source row. Real second-person eligibility is read from seeded company records (the same
// evidence every other less-safe approval uses); the audit outbox is the capture fake. One FakeDynamoDb holds the State table and the TeamRecord table (it ignores table names).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SourcesAdminViewSchema, agentXError, developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, teamRecordPk, type OrgId } from "@agentx/contracts";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import { scopeReasons, type SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { readApproverRoster } from "../../../packages/broker/src/org/second-person-evidence.js";
import { secondPersonFromRecords } from "../../../packages/broker/src/org/test-environment.js";
import { DynamoSoleOwnerSwitch } from "../../../packages/broker/src/lessons/dynamo-settings.js";
import { erasePerson, eraseProject } from "../../../packages/broker/src/team-record/erase.js";
import type { CompanyLocks } from "../../../packages/broker/src/team-record/edition.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../../support/audit-capture.js";
import type { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { ORG_A, ORG_B, addSource, caller, world, type World } from "../../support/team-record-core.js";

// ---- people. Every id is a 64-character hex string, as the company's records keep them.
const OWNER = "a".repeat(64), ADMIN = "b".repeat(64), MAINT = "c".repeat(64), CONTRIB = "d".repeat(64), VIEWER = "e".repeat(64), AUDITOR = "f".repeat(64), OTHER_ORG_MAINT = "1".repeat(64), OTHER_ORG_OWNER = "2".repeat(64);
type OrgRole = "owner" | "admin" | "member" | "auditor";
interface Who { id: string; orgRole: OrgRole; projectRole: "maintainer" | "contributor" | "viewer" | undefined; browser?: boolean; fresh?: boolean }
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

interface Harness { w: World; audit: ReturnType<typeof capturingAuditDeps>; repos: Map<string, number[]>; locks: { value: CompanyLocks | undefined }; paused: string[]; ids: { next: number }; skipped: Record<string, number> | undefined }
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
    locks: async () => h.locks.value,
    pausedSources: async () => h.paused,
    newId: () => `change-${String(h.ids.next++)}`,
  },
});

function contextOf(h: Harness, who: Who, body: unknown, over: Partial<SourceWriteContext> = {}): SourceWriteContext {
  const evidence = { documentClient: h.w.db, tableName: AUDIT_CAPTURE_TABLE, signInTableName: "signin", now: () => h.w.clock.ms };
  return {
    orgRole: who.orgRole, browserSession: who.browser !== false, body: () => body, audit: h.audit.deps,
    secondPerson: secondPersonFromRecords({ ...evidence, soleOwnerTable: h.w.table }),
    roster: (scope) => readApproverRoster(evidence, scope),
    freshSignIn: async () => { if (who.fresh === false) throw agentXError("REAUTH_REQUIRED", "sign in again"); },
    ...over,
  };
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
const proposals = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_CHANGE");
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

  it("a company's records never answer another company: its maintainer adds to ITS project, and cannot approve or reject a change of the first company", async () => {
    const h = harness();
    const first = await post(h, WHO.owner, change(0, { retention: "D" }));
    expect(codeOf(first)).toBe("NOT_FOUND"); // no row yet in company A
    await post(h, WHO.owner, add());
    const proposed = await post(h, WHO.owner, change(1, { retention: "D" }));
    expect(proposed.status).toBe(202);
    const changeId = proposed.body.changeId as string;
    const other = { id: OTHER_ORG_MAINT, orgRole: "member", projectRole: "maintainer" } as const;
    expect(codeOf(await post(h, other, { action: "approve", changeId }, { org: ORG_B }))).toBe("NOT_FOUND");
    expect(codeOf(await post(h, other, { action: "reject", changeId }, { org: ORG_B }))).toBe("NOT_FOUND");
    expect(proposals(h)).toHaveLength(1);
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

  it("Slack, Linear, Jira, MCP and plug-in code hosts are not available yet: a fixed code, nothing written", async () => {
    const h = harness();
    for (const [source, scope] of [["slack", "slack:T1/C9"], ["linear", "linear:team/ENG"], ["jira", "jira:project/ENG"], ["mcp", "mcp:srv/x"], ["codehost:gitfarm", "codehost:gitfarm:repo/1"]] as const) {
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

describe("a less-safe change waits for a second person (Enterprise)", () => {
  async function withRow(h: Harness, retention = "C") {
    expect((await post(h, WHO.owner, add({ retention }))).status).toBe(200);
  }

  it("a retention raise stores a seven-day proposal and a needs_approval answer, and the row does not move; a lowering applies at once", async () => {
    const h = harness();
    await withRow(h);
    const reply = await post(h, WHO.maint, change(1, { retention: "D" }));
    expect(reply.status).toBe(202);
    expect(reply.body).toEqual({ status: "needs_approval", changeId: "change-1", expiresAt: new Date(h.w.clock.ms + 7 * 86_400_000).toISOString() });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
    const [proposal] = proposals(h);
    expect(proposal).toMatchObject({ id: "change-1", kind: "change", reasons: ["retention_raise"], proposedBy: MAINT, againstRevision: 1, project: "web", source: "github", scope: "github:repo/9" });
    expect(proposal!.row).toMatchObject({ retention: "D", enabled: true });
    expect(proposal!.row).not.toHaveProperty("approval");
    const events = await flushed(h);
    const proposed = events.filter((event) => event.action === "record.source_change_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ actor: { kind: "member", id: MAINT }, facts: { source: "github", reasons: "retention_raise" } });
    expect(JSON.stringify(proposed[0])).not.toContain("repo/9");
    // A lowering is the safe side: it applies at once.
    expect((await post(h, WHO.owner, change(1, { retention: "B" }))).status).toBe(200);
    expect(sourceRows(h)[0]).toMatchObject({ retention: "B", revision: 2 });
  });

  it("adding a source above the Enterprise default retention is a proposal too: nothing is stored as a row until it is approved", async () => {
    const h = harness();
    const reply = await post(h, WHO.owner, add({ retention: "D" }));
    expect(reply).toMatchObject({ status: 202, body: { status: "needs_approval", changeId: "change-1" } });
    expect(sourceRows(h)).toHaveLength(0);
    expect(claims(h)).toHaveLength(0);
    expect(proposals(h)[0]).toMatchObject({ kind: "add", againstRevision: null, reasons: ["retention_raise"] });
    expect(proposals(h)[0]!.row).toMatchObject({ retention: "D", addedBy: OWNER });
    expect(proposals(h)[0]!.row).not.toHaveProperty("revision");
  });

  it("the Public edition never proposes: the same raise applies at once", async () => {
    const h = harness({ edition: "public" });
    await withRow(h, "B");
    expect(await post(h, WHO.owner, change(1, { retention: "D" }))).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(proposals(h)).toHaveLength(0);
  });

  it("the company's retention ceiling refuses a retention above it, whoever asks, and does not trouble an unrelated change", async () => {
    const h = harness();
    h.locks.value = { retentionCeiling: { default: "B" } };
    expect(await post(h, WHO.owner, add({ retention: "C" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(await post(h, WHO.owner, add({ retention: "D" }))).toMatchObject({ status: 400 });
    expect((await post(h, WHO.owner, add({ retention: "B" }))).status).toBe(200);
    expect(await post(h, WHO.owner, change(1, { retention: "D" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(proposals(h)).toHaveLength(0);
    h.locks.value = { retentionCeiling: { default: "A" } };
    expect((await post(h, WHO.owner, change(1, { enabled: false }))).status).toBe(200);
  });

  it("a retention the edition does not offer is refused", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ retention: "Z" }))).toMatchObject({ status: 400 });
  });

  it("with no audit ledger a less-safe write is refused and nothing is stored; an ordinary write goes on without one", async () => {
    const h = harness();
    await withRow(h);
    const reply = await post(h, WHO.owner, change(1, { retention: "D" }), { context: { audit: {} } });
    expect(reply).toMatchObject({ status: 503, body: { code: "AUDIT_UNAVAILABLE" } });
    expect(proposals(h)).toHaveLength(0);
    expect(requests(h).filter((item) => (item.reply as { status?: string } | undefined)?.status === "needs_approval")).toHaveLength(0);
    expect((await post(h, WHO.owner, change(1, { enabled: false }), { context: { audit: {} } })).status).toBe(200);
  });

  it("a repeat of the request that proposed answers the same proposal and writes no second one", async () => {
    const h = harness();
    await withRow(h);
    const body = change(1, { retention: "D", requestId: REQUEST_A });
    const first = await post(h, WHO.owner, body);
    const again = await post(h, WHO.owner, body);
    expect(again).toEqual(first);
    expect(proposals(h)).toHaveLength(1);
    expect((await flushed(h)).filter((event) => event.action === "record.source_change_proposed")).toHaveLength(1);
  });

  it("a proposal needs the company's approvers to be readable: when they are not, nothing is stored", async () => {
    const h = harness();
    await withRow(h);
    const reply = await post(h, WHO.owner, change(1, { retention: "D" }), { context: { roster: async () => { throw new Error("down"); } } });
    expect(reply).toMatchObject({ status: 503, body: { code: "RUNTIME_UNAVAILABLE" } });
    expect(proposals(h)).toHaveLength(0);
  });
});

describe("approving a waiting change", () => {
  async function waiting(h: Harness, proposer: Who = WHO.owner) {
    await post(h, WHO.owner, add());
    const reply = await post(h, proposer, change(1, { retention: "D" }));
    expect(reply.status).toBe(202);
    return reply.body.changeId as string;
  }
  const approve = (h: Harness, who: Who, changeId: string, context: Partial<SourceWriteContext> = {}) => post(h, who, { action: "approve", changeId }, { context });

  it("the proposer cannot approve while another eligible person exists; a different eligible person applies it with the approval recorded, audited, and the proposal gone", async () => {
    const h = harness();
    const changeId = await waiting(h);
    expect(await approve(h, WHO.owner, changeId)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
    expect(proposals(h)).toHaveLength(1);
    const done = await approve(h, WHO.maint, changeId);
    expect(done).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "D", revision: 2, approval: { approvalId: changeId, by: MAINT, at: new Date(h.w.clock.ms).toISOString() } });
    expect(proposals(h)).toHaveLength(0);
    const events = await flushed(h);
    expect(events.filter((event) => event.action === "record.source_change_decided")).toEqual([expect.objectContaining({ actor: { kind: "member", id: MAINT }, facts: { source: "github", decision: "approved", soleOwner: false } })]);
    expect(events.filter((event) => event.action === "record.source_changed")).toEqual([expect.objectContaining({ facts: { source: "github", fromRetention: "C", toRetention: "D", enabled: true } })]);
    // A repeat finds nothing waiting.
    expect(await approve(h, WHO.admin, changeId)).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  });

  it("an approved add creates the row, its claim and the approval; a place taken by another project meanwhile is refused", async () => {
    const h = harness();
    const added = await post(h, WHO.owner, add({ retention: "D" }));
    const changeId = added.body.changeId as string;
    const done = await approve(h, WHO.maint, changeId);
    expect(done).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(sourceRows(h)[0]).toMatchObject({ project: "web", retention: "D", revision: 1, addedBy: OWNER, approval: { approvalId: changeId, by: MAINT } });
    expect(claims(h)).toHaveLength(1);
    expect(proposals(h)).toHaveLength(0);
    const events = await flushed(h);
    expect(events.map((event) => event.action)).toEqual(expect.arrayContaining(["record.source_change_proposed", "record.source_change_decided", "record.source_added"]));
    expect(events.find((event) => event.action === "record.source_added")).toMatchObject({ facts: { source: "github", retention: "D", restricted: false } });

    const h2 = harness();
    const other = await post(h2, WHO.owner, add({ retention: "D" }), { project: "web" });
    await post(h2, WHO.owner, add({ retention: "C" }), { project: "api" }); // api takes the place first
    expect(await approve(h2, WHO.maint, other.body.changeId as string)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h2).map((row) => row.project)).toEqual(["api"]);
  });

  it("the only eligible approver may approve their own change (the sole-owner exception), and it is audited as such", async () => {
    const h = harness({ people: { [OWNER]: "owner" }, maintainers: [] });
    const changeId = await waiting(h);
    const done = await approve(h, WHO.owner, changeId);
    expect(done).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    const decided = (await flushed(h)).filter((event) => event.action === "record.source_change_decided");
    expect(decided).toEqual([expect.objectContaining({ facts: { source: "github", decision: "approved", soleOwner: true } })]);
  });

  it("the sole-owner exception is not available when the company switched it off, or after a recent loss of an eligible person", async () => {
    const off = harness({ people: { [OWNER]: "owner" }, maintainers: [] });
    await new DynamoSoleOwnerSwitch(off.w.table).write(ORG_A, false, { by: OWNER, at: off.w.clock.ms }, true);
    const first = await waiting(off);
    expect(await approve(off, WHO.owner, first)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(sourceRows(off)[0]).toMatchObject({ retention: "C" });

    const recent = harness({ people: { [OWNER]: "owner" }, maintainers: [], meta: { approvalLastCompanyEligibleLossAt: new Date(T_NOW - 3_600_000).toISOString() } });
    const second = await waiting(recent);
    expect(await approve(recent, WHO.owner, second)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
  });

  it("a change made against a row that has moved since is CHANGE_STALE, and the row is not touched", async () => {
    const h = harness();
    const changeId = await waiting(h);
    expect((await post(h, WHO.admin, change(1, { enabled: false }))).status).toBe(200);
    expect(await approve(h, WHO.maint, changeId)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", enabled: false, revision: 2 });
  });

  it("the people who can approve changed since the change was made: refused with CHANGE_STALE", async () => {
    const h = harness();
    const changeId = await waiting(h);
    // A new admin joins: the company's membership moved.
    seedCompany(h.w.db, ORG_A, { [OWNER]: "owner", [ADMIN]: "admin", [MAINT]: "member", [CONTRIB]: "member", [VIEWER]: "member", [AUDITOR]: "auditor", ["7".repeat(64)]: "admin" }, [{ id: MAINT, project: "web" }], ["web", "api"], { approvalMembershipVersion: 4 });
    expect(await approve(h, WHO.maint, changeId)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
  });

  it("membership that changes between the check and the commit stops the commit", async () => {
    const h = harness();
    const changeId = await waiting(h);
    const send = h.w.db.send.bind(h.w.db);
    h.w.db.send = async (command: Parameters<FakeDynamoDb["send"]>[0]) => {
      const seen: unknown = command;
      if (seen instanceof TransactWriteCommand) h.w.db.set({ ...h.w.db.get(orgMetaKey(ORG_A)), approvalMembershipVersion: 9 });
      return send(command);
    };
    expect(await approve(h, WHO.maint, changeId)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
    expect(proposals(h)).toHaveLength(1);
  });

  it("a proposer who left the company: the people who can approve changed, so the change is made again", async () => {
    const h = harness();
    const changeId = await waiting(h, WHO.admin);
    h.w.db.delete(orgMemberKey(ORG_A, ADMIN));
    expect(await approve(h, WHO.maint, changeId)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C" });
  });

  it("the shared check refuses a proposer who is no longer a live person even when the roster looks unchanged", async () => {
    const h = harness();
    const changeId = await waiting(h, WHO.admin);
    // The roster read is held at what it was; the second-person check reads the proposer's own records.
    h.w.db.set({ pk: `DEVELOPER#${ADMIN}`, sk: "META", developerId: ADMIN, revoked: true });
    const reply = await approve(h, WHO.maint, changeId, { roster: async () => ({ complete: true, membershipVersion: 3, ownerIds: [OWNER], eligibleIds: [OWNER, ADMIN, MAINT], lastEligibleLossAtMs: null }) });
    expect(reply).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C" });
  });

  it("an expired change cannot be approved", async () => {
    const h = harness();
    const changeId = await waiting(h);
    h.w.clock.ms += 7 * 86_400_000 + 1;
    expect(await approve(h, WHO.maint, changeId)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
  });

  it("the approver must have signed in within the last ten minutes", async () => {
    const h = harness();
    const changeId = await waiting(h);
    const reply = await approve(h, { ...WHO.maint, fresh: false }, changeId);
    expect(reply).toMatchObject({ body: { code: "REAUTH_REQUIRED" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C" });
    expect(proposals(h)).toHaveLength(1);
  });

  it("an approval needs the audit ledger and a live browser session, and an approver who can edit the project", async () => {
    const h = harness();
    const changeId = await waiting(h);
    expect(await approve(h, WHO.maint, changeId, { audit: {} })).toMatchObject({ status: 503, body: { code: "AUDIT_UNAVAILABLE" } });
    expect(await approve(h, { ...WHO.maint, browser: false }, changeId)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await approve(h, WHO.contrib, changeId)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await approve(h, WHO.auditor, changeId)).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C" });
    expect(proposals(h)).toHaveLength(1);
  });

  it("the retention rules are checked again when the change is approved (a ceiling set meanwhile refuses it)", async () => {
    const h = harness();
    const changeId = await waiting(h);
    h.locks.value = { retentionCeiling: { default: "C" } };
    expect(await approve(h, WHO.maint, changeId)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C" });
  });

  it("a place that left the project since an add was proposed is refused at approval", async () => {
    const h = harness();
    const changeId = (await post(h, WHO.owner, add({ retention: "D" }))).body.changeId as string;
    h.repos.set(`${ORG_A}/web`, [11]);
    expect(await approve(h, WHO.maint, changeId)).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sourceRows(h)).toHaveLength(0);
  });

  it("a change id of another project is not found", async () => {
    const h = harness();
    const changeId = await waiting(h);
    expect(await post(h, WHO.owner, { action: "approve", changeId }, { project: "api" })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(proposals(h)).toHaveLength(1);
  });
});

describe("rejecting a waiting change", () => {
  async function waiting(h: Harness) {
    await post(h, WHO.owner, add());
    return (await post(h, WHO.maint, change(1, { retention: "D" }))).body.changeId as string;
  }

  it("the proposer, or any other person who can edit the project, rejects it: the proposal goes, the row is untouched, and the decision is audited", async () => {
    for (const who of [WHO.maint, WHO.owner, WHO.admin]) {
      const h = harness();
      const changeId = await waiting(h);
      expect(await post(h, who, { action: "reject", changeId })).toEqual({ status: 200, body: { status: "rejected" } });
      expect(proposals(h)).toHaveLength(0);
      expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
      const decided = (await flushed(h)).filter((event) => event.action === "record.source_change_decided");
      expect(decided).toEqual([expect.objectContaining({ actor: { kind: "member", id: who.id }, facts: { source: "github", decision: "rejected", soleOwner: false } })]);
      expect(await post(h, who, { action: "reject", changeId })).toMatchObject({ status: 404 });
    }
  });

  it("a contributor, the Auditor and a session without a browser cannot reject", async () => {
    const h = harness();
    const changeId = await waiting(h);
    for (const who of [WHO.contrib, WHO.auditor, { ...WHO.owner, browser: false }]) expect(await post(h, who, { action: "reject", changeId })).toMatchObject({ status: 403 });
    expect(proposals(h)).toHaveLength(1);
  });
});

const T_NOW = Date.parse("2026-10-30T12:00:00.000Z");

describe("the reasons a place needs a second person", () => {
  it("a private channel, a DM and a group DM need one in Enterprise only; a public channel and Slack Connect never do", () => {
    expect(scopeReasons("enterprise", "private_channel")).toEqual(["private_channel"]);
    expect(scopeReasons("enterprise", "dm")).toEqual(["dm"]);
    expect(scopeReasons("enterprise", "mpim")).toEqual(["mpim"]);
    expect(scopeReasons("enterprise", "public_channel")).toEqual([]);
    expect(scopeReasons("enterprise", "slack_connect")).toEqual([]);
    expect(scopeReasons("public", "private_channel")).toEqual([]);
    expect(scopeReasons("public", "dm")).toEqual([]);
    expect(scopeReasons("enterprise", undefined)).toEqual([]);
  });
});

describe("the sources view", () => {
  it("a person who may edit gets the admin view: revisions, who added each, the approval, waiting changes and what is offered", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    await post(h, WHO.maint, change(1, { retention: "D" }));
    h.paused = ["github:9", "github:other"];
    const reply = await get(h, WHO.maint);
    expect(reply.status).toBe(200);
    const view = SourcesAdminViewSchema.parse(reply.body);
    expect(view.canEdit).toBe(true);
    expect(view.sources).toEqual([expect.objectContaining({ kind: "github", scope: "github:repo/9", revision: 1, addedBy: OWNER, retention: "C", exclude: [], excluded: 0, paused: true })]);
    expect(view.otherPaused).toBe(1);
    expect(view.pending).toEqual([{ changeId: "change-1", source: "github", scope: "github:repo/9", kind: "change", reasons: ["retention_raise"], proposedByYou: true, expiresAt: new Date(h.w.clock.ms + 7 * 86_400_000).toISOString() }]);
    expect(view.soleApprover).toBe(false);
    expect(view.offered.github).toEqual(["A", "B", "C", "D"]);
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG_OWNER);
    // The owner did not make that change.
    expect(SourcesAdminViewSchema.parse((await get(h, WHO.owner)).body).pending[0]!.proposedByYou).toBe(false);
  });

  it("the offered retention follows the edition and the company's ceiling, and a company with one eligible approver says so", async () => {
    const h = harness({ edition: "public", people: { [OWNER]: "owner" }, maintainers: [] });
    h.locks.value = { retentionCeiling: { github: "C" } };
    const view = SourcesAdminViewSchema.parse((await get(h, WHO.owner)).body);
    expect(view.offered.slack).toEqual(["A", "B"]);
    expect(view.offered.github).toEqual(["A", "B", "C"]);
    expect(view.soleApprover).toBe(true);
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
  const DEV = "3".repeat(64);
  it("erasing a person deletes the changes they proposed and scrubs them from other changes (added by, excluded ids), then removes nothing else", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    // Two waiting changes: one proposed by the erased person; one proposed by someone else whose row names the erased person as the adder and excludes their source id.
    const mine = await post(h, { ...WHO.maint, id: DEV }, change(1, { retention: "D" }), { context: { roster: async () => ({ complete: true, membershipVersion: 3, ownerIds: [OWNER], eligibleIds: [OWNER, ADMIN], lastEligibleLossAtMs: null }) } });
    expect(mine.status).toBe(202);
    const other = await post(h, WHO.owner, change(1, { retention: "D", exclude: ["U123"] }));
    const keep = proposals(h).find((item) => item.id === other.body.changeId)!;
    h.w.db.set({ ...keep, row: { ...(keep.row as object), addedBy: DEV, exclude: ["U123", "U999"] } });
    const d = deleteDeps(h.w);
    const result = await erasePerson(d.deps, ORG_A, { developerId: DEV, projects: ["web"] }, "erase-src-1");
    expect(result.steps?.config).toBe(true);
    expect(proposals(h).map((item) => item.id)).toEqual([other.body.changeId]);
    expect(proposals(h)[0]!.row).toMatchObject({ addedBy: "0".repeat(64), exclude: ["U123", "U999"] });
    const withIds = await erasePerson(d.deps, ORG_A, { developerId: DEV, projects: ["web"], identities: [{ system: "slack", sourceId: "U123" }] }, "erase-src-2");
    expect(withIds.steps?.config).toBe(true);
    expect(proposals(h)[0]!.row).toMatchObject({ exclude: ["U999"] });
    expect(sourceRows(h)).toHaveLength(1);
    expect(JSON.stringify([...proposals(h), ...sourceRows(h), ...requests(h), ...claims(h)])).not.toContain(DEV);
  });

  it("archiving a project leaves no claim, no waiting change and no request item of it, and another project's claim stays", async () => {
    const h = harness();
    await post(h, WHO.owner, add(), { project: "web" });
    await post(h, WHO.owner, add({ scope: "github:repo/10" }), { project: "api" });
    await post(h, WHO.owner, change(1, { retention: "D" }), { project: "web" });
    expect(claims(h)).toHaveLength(2);
    expect(proposals(h)).toHaveLength(1);
    const d = deleteDeps(h.w);
    const done = await eraseProject(d.deps, ORG_A, "web", "project_archived", "archive-1");
    expect(done.complete).toBe(true);
    expect(sourceRows(h).map((row) => row.project)).toEqual(["api"]);
    expect(claims(h).map((item) => item.project)).toEqual(["api"]);
    expect(proposals(h)).toHaveLength(0);
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

  it("4. only the proposer, or a person the roster lists as able to approve, can reject", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    const changeId = (await post(h, WHO.owner, change(1, { retention: "D" }))).body.changeId as string;
    const rosterWithout = (id: string) => async () => ({ complete: true, membershipVersion: 3, ownerIds: [OWNER], eligibleIds: [OWNER, ADMIN, MAINT].filter((one) => one !== id), lastEligibleLossAtMs: null });
    expect(await post(h, WHO.maint, { action: "reject", changeId }, { context: { roster: rosterWithout(MAINT) } })).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(await post(h, WHO.maint, { action: "reject", changeId }, { context: { roster: async () => { throw new Error("down"); } } })).toMatchObject({ status: 503 });
    expect(proposals(h)).toHaveLength(1);
    // The proposer needs no roster.
    expect(await post(h, WHO.owner, { action: "reject", changeId }, { context: { roster: rosterWithout(OWNER) } })).toEqual({ status: 200, body: { status: "rejected" } });
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

  it("6. waiting changes that have expired do not count toward the limit of 100", async () => {
    const h = harness();
    await post(h, WHO.owner, add());
    for (let index = 0; index < 100; index += 1) expect((await post(h, WHO.owner, change(1, { retention: "D" }))).status).toBe(202);
    expect(await post(h, WHO.owner, change(1, { retention: "D" }))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    h.w.clock.ms += 7 * 86_400_000 + 1;
    expect((await post(h, WHO.owner, change(1, { retention: "D" }))).status).toBe(202);
  });
});
