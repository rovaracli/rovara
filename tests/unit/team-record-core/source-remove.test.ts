// Removing a source row (Team record source-row lane, task 3): the row, its claim, the waiting changes and a durable delete-queue item go in ONE transaction, the place is closed right after
// (best effort), the delete worker removes the place's data, and TR-E5 (item heads). Uses the same harness as `source-routes.test.ts` (copied: it is not exported).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, recordFactKey, recordItemHeadKey, recordScopeHash, recordScopeMarkerKey, type OrgId } from "@agentx/contracts";
import { handleRecordRoute } from "../../../packages/broker/src/team-record/routes.js";
import type { SourceWriteContext } from "../../../packages/broker/src/team-record/source-write.js";
import { readApproverRoster } from "../../../packages/broker/src/org/second-person-evidence.js";
import { secondPersonFromRecords } from "../../../packages/broker/src/org/test-environment.js";
import { eraseProject } from "../../../packages/broker/src/team-record/erase.js";
import { DEFAULT_DELETE_BUDGET, runDeleteWorker } from "../../../packages/broker/src/team-record/delete-worker.js";
import { hiddenByPending } from "../../../packages/broker/src/team-record/acl.js";
import { advanceItemHead, isScopeClosed } from "../../../packages/broker/src/team-record/item-head.js";
import { listScopeWork, pendingHidesOf, putScopeWork, sourceRowItem } from "../../../packages/broker/src/team-record/store.js";
import type { CompanyLocks } from "../../../packages/broker/src/team-record/edition.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "../../support/audit-capture.js";
import type { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { FACT_A, FACT_B, addFact, deleteDeps, idsOf } from "../../support/team-record-delete.js";
import { GITHUB_SCOPE, ORG_A, ORG_B, caller, githubDraft, rows, world, type World } from "../../support/team-record-core.js";

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

const add = (over: Record<string, unknown> = {}) => ({ action: "add", requestId: randomUUID(), source: "github", scope: "github:repo/9", retention: "C", audienceDefault: "maintainers", enabled: true, ...over });
const change = (expectedRevision: number, over: Record<string, unknown> = {}) => ({ action: "change", requestId: randomUUID(), source: "github", scope: "github:repo/9", expectedRevision, ...over });

const sourceRows = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE");
const proposals = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_CHANGE");
const claims = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_SCOPE");
const requests = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REQUEST");
const flushed = async (h: Harness) => { await new Promise((resolve) => setTimeout(resolve, 0)); return h.audit.recorded(); };


// ---- helpers
const remove = (expectedRevision: number, over: Record<string, unknown> = {}) => ({ action: "remove", requestId: randomUUID(), source: "github", scope: GITHUB_SCOPE, expectedRevision, ...over });

const queue = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_SCOPE_WORK");
const heads = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_ITEM_HEAD");
const events = (h: Harness) => h.w.db.find((item) => item.entityType === "TEAM_RECORD_EVENT");
const marker = (h: Harness, scope = GITHUB_SCOPE) => h.w.db.get(recordScopeMarkerKey(ORG_A, scope));
type Command = Parameters<FakeDynamoDb["send"]>[0];
/** An update that sets the tombstone of a row (the hide). */
const isTombstoneWrite = (command: unknown): boolean => (command as { constructor: { name: string } }).constructor.name === "UpdateCommand"
  && Object.values((command as { input: { ExpressionAttributeNames?: Record<string, string> } }).input.ExpressionAttributeNames ?? {}).includes("tombstone");
const worker = (h: Harness, budget = DEFAULT_DELETE_BUDGET, extra: Parameters<typeof deleteDeps>[1] = {}) => { const d = deleteDeps(h.w, extra); return runDeleteWorker(d.deps, ORG_A, budget).then((summary) => ({ summary, d })); };

/** A project with a github source row (through the route) and three stored comments, each with a vector. */
async function seeded(h: Harness, ids = ["c-1", "c-2", "c-3"]) {
  expect(await post(h, WHO.owner, add())).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
  for (const id of ids) {
    const outcome = await h.w.sink.put(githubDraft({ sourceRef: { system: "github.com", id, version: "1" }, links: [], retention: "C", text: `Comment ${id} about retries.` }));
    expect(outcome, id).toEqual({ status: "stored" });
  }
}

describe("who may remove", () => {
  it("a company owner, an admin and a maintainer of this project can remove a source; the reply is removed", async () => {
    for (const who of [WHO.owner, WHO.admin, WHO.maint]) {
      const h = harness();
      await seeded(h);
      expect(await post(h, who, remove(1)), who.id).toEqual({ status: 200, body: { status: "removed" } });
      expect(sourceRows(h), who.id).toHaveLength(0);
    }
  });

  it("a contributor, a viewer and the Auditor are refused, a stranger gets the missing-project answer, a token is refused; nothing changes", async () => {
    for (const who of [WHO.contrib, WHO.viewer, WHO.auditor, { ...WHO.owner, browser: false }]) {
      const h = harness();
      await seeded(h);
      expect(await post(h, who, remove(1)), who.id).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
      expect(sourceRows(h)).toHaveLength(1);
      expect(queue(h)).toHaveLength(0);
      expect(marker(h)).toBeUndefined();
    }
    const h = harness();
    await seeded(h);
    expect(await post(h, WHO.stranger, remove(1))).toMatchObject({ status: 404, body: { code: "PROJECT_NOT_FOUND" } });
    expect(sourceRows(h)).toHaveLength(1);
  });

  it("another company's maintainer cannot remove it: the same place is not found there, and the first company's row, claim and data stay", async () => {
    const h = harness();
    await seeded(h);
    const other = { id: OTHER_ORG_MAINT, orgRole: "member", projectRole: "maintainer" } as const;
    expect(await post(h, other, remove(1), { org: ORG_B })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(sourceRows(h)).toHaveLength(1);
    expect(claims(h)).toHaveLength(1);
    expect(queue(h)).toHaveLength(0);
    expect(marker(h)).toBeUndefined();
    expect(events(h)).toHaveLength(3);
    // Company B has its own row for the same place; removing it leaves company A's alone.
    expect(await post(h, other, add({ retention: "C" }), { org: ORG_B })).toMatchObject({ status: 200 });
    expect(await post(h, other, remove(1), { org: ORG_B })).toEqual({ status: 200, body: { status: "removed" } });
    expect(sourceRows(h).map((row) => row.workspaceId)).toEqual([ORG_A]);
    expect(events(h)).toHaveLength(3);
    expect(h.w.db.get(recordScopeMarkerKey(ORG_B, GITHUB_SCOPE))).toBeDefined();
    expect(marker(h)).toBeUndefined();
  });

  it("a source that is not there is NOT_FOUND, and the project must be the caller's", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, remove(0))).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    await seeded(h);
    // The same place in another project of the company is not this project's row.
    expect(await post(h, WHO.owner, remove(1), { project: "api" })).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(sourceRows(h)).toHaveLength(1);
  });
});

describe("the revision fence and replay", () => {
  it("a stale revision is CHANGE_STALE and writes nothing; the right one removes", async () => {
    const h = harness();
    await seeded(h);
    expect(await post(h, WHO.owner, change(1, { retention: "B" }))).toMatchObject({ status: 200 }); // revision 2
    const before = h.w.db.find(() => true).length;
    expect(await post(h, WHO.owner, remove(1))).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(h.w.db.find(() => true)).toHaveLength(before);
    expect(queue(h)).toHaveLength(0);
    expect(marker(h)).toBeUndefined();
    expect(await post(h, WHO.owner, remove(2))).toEqual({ status: 200, body: { status: "removed" } });
  });

  it("a row written before revisions existed reads as revision 0 and can be removed with 0", async () => {
    const h = harness();
    await seeded(h);
    const [row] = sourceRows(h);
    const { revision: _revision, ...legacy } = row!; // eslint-disable-line @typescript-eslint/no-unused-vars -- a row as the older code stored it
    h.w.db.set(legacy);
    expect(await post(h, WHO.owner, remove(1))).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(await post(h, WHO.owner, remove(0))).toEqual({ status: 200, body: { status: "removed" } });
  });

  it("a repeat of the same request answers the stored outcome and writes nothing more; the same id with another body is CONFIG_INVALID", async () => {
    const h = harness();
    await seeded(h);
    const body = remove(1);
    expect(await post(h, WHO.owner, body)).toEqual({ status: 200, body: { status: "removed" } });
    const written = h.w.db.find(() => true).length;
    expect(await post(h, WHO.owner, body)).toEqual({ status: 200, body: { status: "removed" } });
    expect(await post(h, WHO.owner, body)).toEqual({ status: 200, body: { status: "removed" } });
    expect(h.w.db.find(() => true)).toHaveLength(written);
    expect(queue(h)).toHaveLength(1);
    expect((await flushed(h)).filter((event) => event.action === "record.source_removed")).toHaveLength(1);
    expect(await post(h, WHO.owner, { ...body, expectedRevision: 5 })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
  });

  it("a replay does not delete the data of a place that was added again meanwhile", async () => {
    const h = harness();
    await seeded(h);
    const body = remove(1);
    await post(h, WHO.owner, body);
    await worker(h);
    expect(await post(h, WHO.owner, add())).toMatchObject({ status: 200 });
    expect(await post(h, WHO.owner, body)).toEqual({ status: 200, body: { status: "removed" } });
    expect(sourceRows(h)).toHaveLength(1);
    expect(queue(h)).toHaveLength(0);
    expect(marker(h)).toBeUndefined();
  });
});

describe("one transaction", () => {
  it("the row, its claim, the waiting changes of that place, the request, the audit and the queue item are written together", async () => {
    const h = harness();
    await seeded(h);
    // Two waiting changes for this place (Enterprise: a raise waits) and one for another place that must stay.
    h.repos.set(`${ORG_A}/web`, [9, 11]);
    expect((await post(h, WHO.owner, change(1, { retention: "D" }))).status).toBe(202);
    expect((await post(h, WHO.owner, change(1, { retention: "D", enabled: false }))).status).toBe(202);
    expect((await post(h, WHO.owner, add({ scope: "github:repo/11", retention: "D" }))).status).toBe(202);
    expect(proposals(h)).toHaveLength(3);
    const requestsBefore = requests(h).length;
    const sent: number[] = [];
    const send = h.w.db.send.bind(h.w.db);
    h.w.db.send = async (command: Command) => { const seen: unknown = command; if (seen instanceof TransactWriteCommand) sent.push((seen.input.TransactItems ?? []).length); return send(command); };

    expect(await post(h, WHO.owner, remove(1))).toEqual({ status: 200, body: { status: "removed" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeLessThanOrEqual(100);
    expect(sourceRows(h)).toHaveLength(0);
    expect(claims(h)).toHaveLength(0);
    expect(proposals(h).map((item) => (item.scope as string))).toEqual(["github:repo/11"]);
    expect(requests(h)).toHaveLength(requestsBefore + 1);
    const [work] = queue(h);
    expect(work).toMatchObject({ type: "tombstone", system: "github", scope: GITHUB_SCOPE, cause: "excluded", hidePending: true, childPending: true });
    expect(work!.textOnly).toBeUndefined();
    const recorded = (await flushed(h)).filter((event) => event.action === "record.source_removed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ orgId: ORG_A, actor: { kind: "member", id: OWNER }, facts: { source: "github" } });
    expect(JSON.stringify(recorded[0])).not.toContain("repo/9");
  });

  it("if any part loses a race nothing is written: a change decided at the same moment cancels the removal whole", async () => {
    const h = harness();
    await seeded(h);
    expect((await post(h, WHO.owner, change(1, { retention: "D" }))).status).toBe(202);
    const requestsBefore = requests(h).length;
    const send = h.w.db.send.bind(h.w.db);
    h.w.db.send = async (command: Command) => {
      const seen: unknown = command;
      if (seen instanceof TransactWriteCommand) for (const item of proposals(h)) h.w.db.delete({ pk: item.pk as string, sk: item.sk as string }); // someone rejects it first
      return send(command);
    };
    expect(await post(h, WHO.owner, remove(1))).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)).toHaveLength(1);
    expect(claims(h)).toHaveLength(1);
    expect(queue(h)).toHaveLength(0);
    expect(requests(h)).toHaveLength(requestsBefore);
    expect(marker(h)).toBeUndefined();
    expect((await flushed(h)).filter((event) => event.action === "record.source_removed")).toHaveLength(0);
    // Asked again with the world as it is, it goes through.
    h.w.db.send = send;
    expect(await post(h, WHO.owner, remove(1))).toEqual({ status: 200, body: { status: "removed" } });
  });

  it("a row with no claim (written by the older save path) is removed too; another project's claim is left alone", async () => {
    const h = harness();
    await seeded(h);
    for (const claim of claims(h)) h.w.db.delete({ pk: claim.pk as string, sk: claim.sk as string });
    expect(await post(h, WHO.owner, remove(1))).toEqual({ status: 200, body: { status: "removed" } });
    expect(sourceRows(h)).toHaveLength(0);
    expect(claims(h)).toHaveLength(0);
  });

  it("freeing the claim lets another project of the company take the place once the data is gone", async () => {
    const h = harness();
    await seeded(h);
    h.repos.set(`${ORG_A}/api`, [9, 10]);
    expect(await post(h, WHO.owner, add(), { project: "api" })).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } }); // held by web
    await post(h, WHO.owner, remove(1));
    await worker(h);
    expect(await post(h, WHO.owner, add(), { project: "api" })).toEqual({ status: 200, body: { status: "saved", revision: 1 } });
    expect(claims(h)[0]).toMatchObject({ project: "api" });
  });

  it("more than 80 waiting changes for one place refuse the removal (the transaction holds at most 100 items); fewer go through", async () => {
    const h = harness();
    await seeded(h);
    for (let i = 0; i < 85; i += 1) expect((await post(h, WHO.owner, change(1, { retention: "D" }))).status).toBe(202);
    expect(proposals(h)).toHaveLength(85);
    const sent: number[] = [];
    const send = h.w.db.send.bind(h.w.db);
    h.w.db.send = async (command: Command) => { const seen: unknown = command; if (seen instanceof TransactWriteCommand) sent.push((seen.input.TransactItems ?? []).length); return send(command); };
    expect(await post(h, WHO.owner, remove(1))).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID" } });
    expect(sent).toEqual([]);
    expect(sourceRows(h)).toHaveLength(1);
    expect(queue(h)).toHaveLength(0);
    // Decided changes make room: with 60 left the removal is one transaction of at most 100 items and takes them all.
    for (const item of proposals(h).slice(0, 25)) h.w.db.delete({ pk: item.pk as string, sk: item.sk as string });
    expect(await post(h, WHO.owner, remove(1))).toEqual({ status: 200, body: { status: "removed" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeLessThanOrEqual(100);
    expect(proposals(h)).toHaveLength(0);
  });
});

describe("hiding and closing", () => {
  it("from the commit on every read hides the place's rows, before the worker has run", async () => {
    const h = harness();
    await seeded(h);
    const pendingBefore = await pendingHidesOf(h.w.table, ORG_A);
    expect(pendingBefore.scopes.has(GITHUB_SCOPE)).toBe(false);
    await post(h, WHO.owner, remove(1));
    const pending = await pendingHidesOf(h.w.table, ORG_A);
    expect(pending.scopes.has(GITHUB_SCOPE)).toBe(true);
    const row = events(h)[0]!;
    expect(events(h)).toHaveLength(3); // not deleted yet
    expect(hiddenByPending({ scope: row.scope as string, audience: row.audience as never, sourceRef: row.sourceRef as never }, pending)).toBe(true);
  });

  it("the place is closed at once when the marker write works", async () => {
    const h = harness();
    await seeded(h);
    await post(h, WHO.owner, remove(1));
    expect(marker(h)).toMatchObject({ entityType: "TEAM_RECORD_SCOPE_CLOSED", cause: "excluded", scope: GITHUB_SCOPE });
    expect(await isScopeClosed(h.w.table, ORG_A, GITHUB_SCOPE)).toBe(true);
    expect(await isScopeClosed(h.w.table, ORG_A, "github:repo/10")).toBe(false);
  });

  it("when the marker write fails the removal still succeeds and the worker closes the place on its next run", async () => {
    const h = harness();
    await seeded(h);
    const send = h.w.db.send.bind(h.w.db);
    h.w.db.send = async (command: Command) => {
      const seen: unknown = command;
      if (seen instanceof PutCommand && (seen.input.Item as { entityType?: string } | undefined)?.entityType === "TEAM_RECORD_SCOPE_CLOSED") throw new Error("dynamodb unavailable");
      return send(command);
    };
    expect(await post(h, WHO.owner, remove(1))).toEqual({ status: 200, body: { status: "removed" } });
    expect(marker(h)).toBeUndefined();
    expect(queue(h)).toHaveLength(1);
    expect((await pendingHidesOf(h.w.table, ORG_A)).scopes.has(GITHUB_SCOPE)).toBe(true); // hidden meanwhile
    h.w.db.send = send;
    await worker(h);
    expect(marker(h)).toMatchObject({ cause: "excluded" });
  });
});

describe("the delete worker finishes the job", () => {
  it("deletes the rows and their vectors inside the hour, queues the lake delete of the place, and leaves nothing queued", async () => {
    const h = harness();
    await seeded(h);
    expect(h.w.vectorItems.length).toBeGreaterThan(0); // positive control: there were vectors to delete
    await post(h, WHO.owner, remove(1));
    h.w.clock.ms += 59 * 60_000;
    const { summary, d } = await worker(h);
    expect(summary).toMatchObject({ rows: 3, finished: 1, blocked: 0, backlog: false });
    expect(idsOf(h.w)).toEqual([]);
    expect(h.w.vectorDeletes.flat().length).toBeGreaterThanOrEqual(3);
    expect(d.lake.enqueued).toEqual(expect.arrayContaining([{ kind: "scope", hash: recordScopeHash(GITHUB_SCOPE) }]));
    expect(queue(h)).toHaveLength(0);
    expect(await listScopeWork(h.w.table, ORG_A, 10)).toEqual([]);
    expect(marker(h)).toBeDefined();
  });

  it("a fact distilled only from the removed place is deleted; one that also rests on another place is re-distilled from what is left", async () => {
    const h = harness();
    await seeded(h);
    await addFact(h.w, FACT_A, [{ system: "github.com", sourceId: "c-1", scope: GITHUB_SCOPE }, { system: "github.com", sourceId: "c-2", scope: GITHUB_SCOPE }]);
    await addFact(h.w, FACT_B, [{ system: "github.com", sourceId: "c-3", scope: GITHUB_SCOPE }, { system: "notes", sourceId: "n-1", scope: "github:repo/10" }]);
    await post(h, WHO.owner, remove(1));
    const calls: unknown[] = [];
    const { summary } = await worker(h, DEFAULT_DELETE_BUDGET, { redistil: { async redistil(input) { calls.push(input); return { text: "What is left says use withRetry." }; } } });
    expect(summary).toMatchObject({ facts: 2, redistilled: 1 });
    expect(h.w.db.get(recordFactKey(ORG_A, "web", FACT_A))).toBeUndefined();
    expect(h.w.db.get(recordFactKey(ORG_A, "web", FACT_B))).toBeUndefined();
    expect(calls).toEqual([expect.objectContaining({ remaining: [{ system: "notes", sourceId: "n-1" }] })]);
    const facts = rows(h.w, "TEAM_RECORD_FACT");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ derivedFrom: ["notes:n-1"] });
  });

  it("a lesson that rested only on the removed place is withdrawn; one with a valid code citation or other sources is kept without the record citations", async () => {
    const h = harness();
    await seeded(h, ["c-1", "c-2"]);
    const ids = Object.fromEntries(events(h).map((row) => [(row.sourceRef as { id: string }).id, row.id as string]));
    const lesson = (id: string, sourceEvents: string[], extra: Record<string, unknown> = {}) => ({ id, version: 1, status: "active", citations: [], provenance: { sourceEvents }, counters: { citationStale: 0 }, ...extra });
    const code = { kind: "code" as const, repo: "acme/api", path: "src/a.ts", startLine: 1, endLine: 2, anchor: "x", commit: "abc1234" };
    await post(h, WHO.owner, remove(1));
    const d = deleteDeps(h.w);
    d.lessons.list.push(lesson("les_only", [ids["c-1"]!]), lesson("les_coded", [ids["c-1"]!], { citations: [code], lastValidatedAt: "2026-10-30T10:00:00.000Z" }), lesson("les_mixed", [ids["c-1"]!, "other-event"]), lesson("les_other", ["other-event"]));
    await runDeleteWorker(d.deps, ORG_A);
    expect(d.lessons.withdrawn).toEqual(["les_only"]);
    expect(d.lessons.trimmed.sort()).toEqual(["les_coded", "les_mixed"]);
  });

  it("another place of the project and another project's rows are not touched", async () => {
    const h = harness();
    await seeded(h);
    h.repos.set(`${ORG_A}/web`, [9, 11]);
    await post(h, WHO.owner, add({ scope: "github:repo/11" }));
    expect(await h.w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "keep", version: "1" }, links: [], retention: "C", audience: { kind: "project" }, scope: "github:repo/11" } as never))).toEqual({ status: "stored" });
    await post(h, WHO.owner, remove(1));
    await worker(h);
    expect(idsOf(h.w)).toEqual(["keep"]);
    expect(marker(h, "github:repo/11")).toBeUndefined();
  });
});

describe("ingest after a removal", () => {
  it("a new item and a queued put replayed after the removal are refused (no source row)", async () => {
    const h = harness();
    await seeded(h);
    const queued = githubDraft({ sourceRef: { system: "github.com", id: "late", version: "1" }, links: [], retention: "C" });
    await post(h, WHO.owner, remove(1));
    expect(await h.w.sink.put(queued)).toEqual({ status: "refused", reason: "no_source_row" });
    expect(await h.w.sink.put(queued)).toEqual({ status: "refused", reason: "no_source_row" }); // the replay
    await worker(h);
    expect(await h.w.sink.put(queued)).toEqual({ status: "refused", reason: "no_source_row" });
    expect(idsOf(h.w)).toEqual([]);
  });

  it("the closed place is a second wall: even a source row that appears without clearing the marker records nothing", async () => {
    const h = harness();
    await seeded(h);
    await post(h, WHO.owner, remove(1));
    h.w.db.set(sourceRowItem({ workspaceId: ORG_A, project: "web", source: "github", scope: GITHUB_SCOPE, enabled: true, retention: "C", exclude: [], audienceDefault: "maintainers", health: "unknown", addedBy: OWNER, updatedAt: "2026-10-30T10:00:00.000Z" }));
    expect(await h.w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "late", version: "1" }, links: [], retention: "C" }))).toEqual({ status: "refused", reason: "scope_closed" });
  });

  it("adding the place again opens it: the old rows stay deleted and new ones record", async () => {
    const h = harness();
    await seeded(h);
    await post(h, WHO.owner, remove(1));
    await worker(h);
    expect(idsOf(h.w)).toEqual([]);
    expect(marker(h)).toBeDefined();
    // The revision counts on from the removed row's (1), so nothing made against that row can fit this one.
    expect(await post(h, WHO.owner, add())).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(marker(h)).toBeUndefined();
    expect(await h.w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-new", version: "1" }, links: [], retention: "C" }))).toEqual({ status: "stored" });
    // An old item is not brought back by the removal; it is recorded afresh only if the source sends it again.
    expect(idsOf(h.w)).toEqual(["c-new"]);
    await worker(h); // nothing queued: the new row is not touched
    expect(idsOf(h.w)).toEqual(["c-new"]);
  });

  it("adding the place again before the worker has run is refused (the worker would close it and take the new rows); after the worker it works", async () => {
    const h = harness();
    await seeded(h);
    await post(h, WHO.owner, remove(1));
    const again = await post(h, WHO.owner, add());
    expect(again).toEqual({ status: 409, body: { code: "SOURCE_REMOVAL_RUNNING", message: "This source was just removed and its stored data is still being deleted. You can add it again in about an hour." } });
    expect(JSON.stringify(again.body)).not.toContain("repo/9");
    expect(sourceRows(h)).toHaveLength(0);
    expect(marker(h)).toBeDefined();
    await worker(h);
    expect(await post(h, WHO.owner, add())).toMatchObject({ status: 200 });
  });
});

describe("a waiting change never outlives its row", () => {
  const approve = (h: Harness, changeId: string) => post(h, WHO.admin, { action: "approve", changeId });

  it("a change waiting when the row is removed goes with it; after the worker and a new add, approving it is CHANGE_STALE and the new row is untouched", async () => {
    const h = harness();
    await seeded(h);
    const waiting = await post(h, WHO.owner, change(1, { retention: "D" }));
    expect(waiting.status).toBe(202);
    await post(h, WHO.owner, remove(1));
    expect(proposals(h)).toHaveLength(0);
    await worker(h);
    expect(await post(h, WHO.owner, add())).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(await approve(h, waiting.body.changeId as string)).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 2 });
  });

  it("a change that slipped in between remove's read and its commit is stale for the new row (revisions count on across a removal)", async () => {
    const h = harness();
    await seeded(h);
    const send = h.w.db.send.bind(h.w.db);
    let late: string | undefined;
    let inside = false;
    h.w.db.send = async (command: Command) => {
      const seen: unknown = command;
      if (seen instanceof TransactWriteCommand && !inside) {
        inside = true;
        const proposed = await post(h, WHO.owner, change(1, { retention: "D" })); // lands first, after remove has listed the waiting changes
        late = proposed.body.changeId as string;
      }
      return send(command);
    };
    expect(await post(h, WHO.owner, remove(1))).toEqual({ status: 200, body: { status: "removed" } });
    h.w.db.send = send;
    expect(late).toBeDefined();
    expect(proposals(h)).toHaveLength(1); // the orphan
    await worker(h);
    expect(await post(h, WHO.owner, add())).toEqual({ status: 200, body: { status: "saved", revision: 2 } });
    expect(await approve(h, late!)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 2 });
  });

  it("a change made before the current row was written is refused even when its revision fits", async () => {
    const h = harness();
    await seeded(h);
    const waiting = await post(h, WHO.owner, change(1, { retention: "D" }));
    const [stored] = proposals(h);
    const earlier = (iso: unknown) => new Date(Date.parse(iso as string) - 3_600_000).toISOString(); // a change lives exactly seven days
    h.w.db.set({ ...stored!, createdAt: earlier(stored!.createdAt), expiresAt: earlier(stored!.expiresAt) });
    h.w.clock.ms += 1_000; // the row is rewritten later than the change was made, with the same revision number
    h.w.db.set({ ...sourceRows(h)[0]!, updatedAt: new Date(h.w.clock.ms).toISOString() });
    expect(await approve(h, waiting.body.changeId as string)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)[0]).toMatchObject({ retention: "C", revision: 1 });
  });

  it("an add that waited before the place was removed is refused afterwards", async () => {
    const h = harness();
    h.repos.set(`${ORG_A}/web`, [9, 11]);
    expect((await post(h, WHO.owner, add({ scope: "github:repo/11", retention: "D" }))).status).toBe(202);
    const [stored] = proposals(h);
    // The same place gets a row, then loses it (a marker is left); the old add must not come back.
    h.w.clock.ms += 1_000;
    expect(await post(h, WHO.owner, add({ scope: "github:repo/11" }))).toMatchObject({ status: 200 });
    expect(await post(h, WHO.owner, remove(1, { scope: "github:repo/11" }))).toMatchObject({ status: 200 });
    await worker(h);
    h.w.db.set(stored!); // it was still waiting
    expect(await approve(h, stored!.id as string)).toMatchObject({ status: 409, body: { code: "CHANGE_STALE" } });
    expect(sourceRows(h)).toHaveLength(0);
  });

  it("the revision marker is removed with the project", async () => {
    const h = harness();
    await seeded(h);
    await post(h, WHO.owner, remove(1));
    expect(h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REVISION")).toHaveLength(1);
    await worker(h);
    await eraseProject(deleteDeps(h.w).deps, ORG_A, "web", "project_archived", "archive-1");
    expect(h.w.db.find((item) => item.entityType === "TEAM_RECORD_SOURCE_REVISION")).toHaveLength(0);
  });
});

describe("TR-E5: item heads go with a deleted place", () => {
  it("the heads of the place's items are deleted with its rows, those of another place stay", async () => {
    const h = harness();
    await seeded(h);
    h.repos.set(`${ORG_A}/web`, [9, 11]);
    await post(h, WHO.owner, add({ scope: "github:repo/11" }));
    await h.w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "other", version: "1" }, links: [], retention: "C", audience: { kind: "project" }, scope: "github:repo/11" } as never));
    expect(heads(h)).toHaveLength(4);
    await post(h, WHO.owner, remove(1));
    await worker(h);
    expect(heads(h)).toHaveLength(1);
    expect(h.w.db.get(recordItemHeadKey(ORG_A, "github.com", "other"))).toBeDefined();
    for (const id of ["c-1", "c-2", "c-3"]) expect(h.w.db.get(recordItemHeadKey(ORG_A, "github.com", id)), id).toBeUndefined();
  });

  it("a head with no row (retention B) and a head written before heads carried a place are both deleted", async () => {
    const h = harness();
    await seeded(h, ["c-1"]);
    // A retention-B item: a head that names no row, written with its place.
    await advanceItemHead(h.w.table, ORG_A, { system: "github.com", sourceId: "b-1", version: "1", versionAt: "2026-10-30T10:00:00.000Z", trust: "member", indexExpiresAt: 2_000_000_000, scope: GITHUB_SCOPE });
    // A head as the older code wrote it: no place on it (found through its row).
    const old = h.w.db.get(recordItemHeadKey(ORG_A, "github.com", "c-1"))!;
    const { scope: _scope, gsi3pk: _pk, gsi3sk: _sk, ...legacy } = old as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the head without its place
    h.w.db.set(legacy);
    expect(heads(h)).toHaveLength(2);
    await post(h, WHO.owner, remove(1));
    await worker(h);
    expect(heads(h)).toHaveLength(0);
  });

  it("is bounded and resumes: with a small budget it takes several runs, and no head is left", async () => {
    const h = harness();
    await seeded(h, ["c-1", "c-2", "c-3", "c-4"]);
    for (const id of ["b-1", "b-2"]) await advanceItemHead(h.w.table, ORG_A, { system: "github.com", sourceId: id, version: "1", versionAt: "2026-10-30T10:00:00.000Z", trust: "member", indexExpiresAt: 2_000_000_000, scope: GITHUB_SCOPE });
    expect(heads(h)).toHaveLength(6);
    await post(h, WHO.owner, remove(1));
    const budget = { ...DEFAULT_DELETE_BUDGET, maxItems: 3 };
    let runs = 0;
    const left: number[] = [];
    while (queue(h).length > 0 && runs < 10) { await worker(h, budget); runs += 1; left.push(heads(h).length); }
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(left[0]).toBeGreaterThan(0); // not all in the first run
    expect(left.at(-1)).toBe(0);
    expect(idsOf(h.w)).toEqual([]);
    expect(queue(h)).toHaveLength(0);
  });

  it("a place deleted at its source (cause source_deleted) clears its heads the same way", async () => {
    const h = harness();
    await seeded(h);
    expect(heads(h)).toHaveLength(3);
    await h.w.sink.tombstone({ workspaceId: ORG_A, system: "github", scope: GITHUB_SCOPE, cause: "source_deleted" });
    await worker(h);
    expect(heads(h)).toHaveLength(0);
    expect(idsOf(h.w)).toEqual([]);
  });

  it("an item whose newer version lives in another place keeps its head when the old place is deleted", async () => {
    const h = harness();
    await seeded(h, ["c-1", "mover"]);
    h.repos.set(`${ORG_A}/web`, [9, 11]);
    await post(h, WHO.owner, add({ scope: "github:repo/11" }));
    // The item moved (a transferred issue): its newer version is a row of the other place; the old row still sits in the first.
    const moved = githubDraft({ sourceRef: { system: "github.com", id: "mover", version: "2", versionAt: "2026-10-31T10:00:00.000Z" }, links: [], retention: "C", audience: { kind: "project" }, scope: "github:repo/11" } as never);
    expect(await h.w.sink.put(moved)).toEqual({ status: "stored" });
    expect(h.w.db.get(recordItemHeadKey(ORG_A, "github.com", "mover"))).toMatchObject({ scope: "github:repo/11", version: "2" });
    // The cleanup of the replaced version has not run yet, so the old row is still in the first place when it is deleted.
    for (const work of queue(h).filter((item) => item.type === "replaced")) h.w.db.delete({ pk: work.pk as string, sk: work.sk as string });
    expect(events(h).filter((row) => (row.sourceRef as { id: string }).id === "mover" && row.scope === GITHUB_SCOPE)).toHaveLength(1);
    await post(h, WHO.owner, remove(1));
    await worker(h);
    expect(h.w.db.get(recordItemHeadKey(ORG_A, "github.com", "c-1"))).toBeUndefined();
    expect(h.w.db.get(recordItemHeadKey(ORG_A, "github.com", "mover"))).toMatchObject({ scope: "github:repo/11", version: "2" });
  });

  it("a head of an item whose row is replaced by a newer version stays (only a deleted place clears heads)", async () => {
    const h = harness();
    await seeded(h, ["c-1"]);
    await h.w.sink.put(githubDraft({ sourceRef: { system: "github.com", id: "c-1", version: "2", versionAt: "2026-10-31T10:00:00.000Z" }, links: [], retention: "C", text: "Edited." }));
    await worker(h);
    expect(heads(h)).toHaveLength(1);
  });
});

describe("the Rovara row", () => {
  const PROJECT = { kind: "project" } as const;
  const structured = (id: string) => githubDraft({ source: "rovara", kind: "rovara.merged", repo: undefined, sourceRef: { system: "rovara", id, version: "1" }, audience: PROJECT, trust: "rovara", actor: undefined, text: undefined, retention: "C", links: [], structured: { taskId: id, stage: "REVIEW", round: 2 } });
  const note = (id: string) => githubDraft({ source: "rovara", kind: "rovara.ask", repo: undefined, sourceRef: { system: "rovara", id, version: "1" }, audience: PROJECT, scope: "rovara:project/web", trust: "member", text: "what did the team say about retries", retention: "C", links: [], origin: "slack", structured: { taskId: id } } as never);
  const RS = "rovara:project/web";

  it("removal returns the project to the default: structured rows stay and keep recording, free-text rows are hidden then deleted, the place stays open", async () => {
    const h = harness({ edition: "enterprise" });
    expect(await post(h, WHO.owner, add({ source: "rovara", scope: RS, retention: "C" }))).toMatchObject({ status: 200 });
    expect(await h.w.sink.put(structured("m-1"))).toEqual({ status: "stored" });
    expect(await h.w.sink.put(note("a-1"))).toEqual({ status: "stored" });
    expect(events(h)).toHaveLength(2);
    expect(events(h).filter((row) => row.text !== undefined)).toHaveLength(1);
    const reply = await post(h, WHO.owner, remove(1, { source: "rovara", scope: RS }));
    expect(reply).toEqual({ status: 200, body: { status: "removed" } });
    expect(sourceRows(h)).toHaveLength(0);
    expect(claims(h)).toHaveLength(0);
    expect(marker(h, RS)).toBeUndefined(); // the place is not closed
    const [work] = queue(h);
    expect(work).toMatchObject({ type: "tombstone", scope: RS, cause: "excluded", textOnly: true });
    expect(work!.childPending).toBeUndefined();
    // The text row is hidden at once (tombstoned, no text); the structured row is not touched.
    const byId = (id: string) => events(h).find((row) => (row.sourceRef as { id: string }).id === id)!;
    expect(byId("a-1").tombstone).toMatchObject({ cause: "excluded" });
    expect(byId("a-1").text).toBeUndefined();
    expect(byId("m-1").tombstone).toBeUndefined();
    expect((await pendingHidesOf(h.w.table, ORG_A)).scopes.has(RS)).toBe(false); // the structured rows are readable
    const { summary } = await worker(h);
    expect(summary).toMatchObject({ rows: 1, finished: 1, blocked: 0 });
    expect(events(h).map((row) => (row.sourceRef as { id: string }).id)).toEqual(["m-1"]);
    expect(queue(h)).toHaveLength(0);
    // With no row the project's own default applies: Rovara rows still record.
    expect(await h.w.sink.put(structured("m-2"))).toEqual({ status: "stored" });
    expect(await h.w.sink.put(note("a-2"))).toEqual({ status: "stored" });
  });

  it("a private task's free-text row (its access scope is the task's) is hidden and deleted with the project's Rovara row, and its structured rows stay", async () => {
    const h = harness({ edition: "enterprise" });
    expect(await post(h, WHO.owner, add({ source: "rovara", scope: RS, retention: "C" }))).toMatchObject({ status: 200 });
    const privateTo = { kind: "restricted", acl: { source: "rovara", scope: "rovara:task/t-priv", principals: ["a".repeat(64)], capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } } as never;
    expect(await h.w.sink.put({ ...note("a-priv"), audience: privateTo, project: "web" })).toEqual({ status: "stored" });
    expect(await h.w.sink.put({ ...structured("m-priv"), audience: privateTo, scope: RS, project: "web" })).toEqual({ status: "stored" });
    expect(await post(h, WHO.owner, remove(1, { source: "rovara", scope: RS }))).toEqual({ status: 200, body: { status: "removed" } });
    const byId = (id: string) => events(h).find((row) => (row.sourceRef as { id: string }).id === id)!;
    expect(byId("a-priv").tombstone).toMatchObject({ cause: "excluded" });
    expect(byId("a-priv").text).toBeUndefined();
    expect(byId("m-priv").tombstone).toBeUndefined();
    await worker(h);
    expect(events(h).map((row) => (row.sourceRef as { id: string }).id)).toEqual(["m-priv"]);
  });

  it("when the inline hide fails the worker does it, and the whole place stays hidden meanwhile", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ source: "rovara", scope: RS, retention: "C" }));
    await h.w.sink.put(structured("m-1"));
    await h.w.sink.put(note("a-1"));
    const send = h.w.db.send.bind(h.w.db);
    let failing = true;
    h.w.db.send = async (command: Command) => {
      if (failing && isTombstoneWrite(command)) throw new Error("dynamodb unavailable");
      return send(command);
    };
    expect(await post(h, WHO.owner, remove(1, { source: "rovara", scope: RS }))).toEqual({ status: 200, body: { status: "removed" } });
    expect(queue(h)[0]).toMatchObject({ hidePending: true });
    expect((await pendingHidesOf(h.w.table, ORG_A)).scopes.has(RS)).toBe(true);
    failing = false;
    await worker(h);
    expect(events(h).map((row) => (row.sourceRef as { id: string }).id)).toEqual(["m-1"]);
    expect((await pendingHidesOf(h.w.table, ORG_A)).scopes.size).toBe(0);
  });

  it("with the inline hide done, a purge that takes several runs never hides the structured rows", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ source: "rovara", scope: RS, retention: "C" }));
    for (const id of ["m-1", "m-2", "m-3", "m-4"]) await h.w.sink.put(structured(id));
    for (const id of ["a-1", "a-2", "a-3"]) await h.w.sink.put(note(id));
    await post(h, WHO.owner, remove(1, { source: "rovara", scope: RS }));
    expect(queue(h)[0]).toMatchObject({ hidePending: false, hideDone: true });
    let runs = 0;
    while (queue(h).length > 0 && runs < 40) {
      expect((await pendingHidesOf(h.w.table, ORG_A)).scopes.has(RS), `before run ${runs}`).toBe(false);
      await worker(h, { ...DEFAULT_DELETE_BUDGET, maxItems: 2 });
      runs += 1;
      if (queue(h).length > 0) expect(queue(h)[0]).toMatchObject({ hidePending: false });
    }
    expect(runs).toBeGreaterThanOrEqual(2); // the purge really spanned runs
    expect(events(h).map((row) => (row.sourceRef as { id: string }).id).sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
  });

  it("when the worker had to do the hiding, the structured rows are readable again as soon as it has hidden the text rows", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ source: "rovara", scope: RS, retention: "C" }));
    for (const id of ["m-1", "m-2"]) await h.w.sink.put(structured(id));
    for (const id of ["a-1", "a-2", "a-3"]) await h.w.sink.put(note(id));
    const send = h.w.db.send.bind(h.w.db);
    h.w.db.send = async (command: Command) => { if (isTombstoneWrite(command)) throw new Error("down"); return send(command); };
    await post(h, WHO.owner, remove(1, { source: "rovara", scope: RS }));
    h.w.db.send = send;
    expect(queue(h)[0]).toMatchObject({ hidePending: true });
    let runs = 0;
    while (queue(h).length > 0 && runs < 40 && !queue(h)[0]!.hideDone) { await worker(h, { ...DEFAULT_DELETE_BUDGET, maxItems: 2 }); runs += 1; }
    expect(queue(h)[0]).toMatchObject({ hideDone: true, hidePending: false });
    expect((await pendingHidesOf(h.w.table, ORG_A)).scopes.has(RS)).toBe(false);
  });

  it("a fact made from a text row goes; a fact made only from structured rows stays; the place's access record is not purged", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ source: "rovara", scope: RS, retention: "C" }));
    await h.w.sink.put(structured("m-1"));
    await h.w.sink.put(note("a-1"));
    await addFact(h.w, FACT_A, [{ system: "rovara", sourceId: "a-1", scope: RS }]);
    await addFact(h.w, FACT_B, [{ system: "rovara", sourceId: "m-1", scope: RS }]);
    await post(h, WHO.owner, remove(1, { source: "rovara", scope: RS }));
    await worker(h);
    expect(h.w.db.get(recordFactKey(ORG_A, "web", FACT_A))).toBeUndefined();
    expect(h.w.db.get(recordFactKey(ORG_A, "web", FACT_B))).toBeDefined();
    expect(h.w.db.get(recordFactKey(ORG_A, "web", FACT_B))!.tombstone).toBeUndefined();
  });

  it("a walk over more rows than one run's budget resumes and still keeps the structured rows", async () => {
    const h = harness();
    await post(h, WHO.owner, add({ source: "rovara", scope: RS, retention: "C" }));
    for (const id of ["m-1", "m-2", "m-3", "m-4"]) await h.w.sink.put(structured(id));
    for (const id of ["a-1", "a-2", "a-3"]) await h.w.sink.put(note(id));
    // The inline hide is kept from finishing so the worker has all of it to do.
    const send = h.w.db.send.bind(h.w.db);
    h.w.db.send = async (command: Command) => {
      if (isTombstoneWrite(command)) throw new Error("down");
      return send(command);
    };
    await post(h, WHO.owner, remove(1, { source: "rovara", scope: RS }));
    h.w.db.send = send;
    let runs = 0;
    while (queue(h).length > 0 && runs < 40) { await worker(h, { ...DEFAULT_DELETE_BUDGET, maxItems: 2 }); runs += 1; }
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(queue(h)).toHaveLength(0);
    expect(events(h).map((row) => (row.sourceRef as { id: string }).id).sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
  });
});

// ---- task 8: what an editor sees while a removed source is still being cleared
async function view(h: Harness, who: Who, options: { org?: OrgId; project?: string; withContext?: boolean } = {}) {
  return await handleRecordRoute(dependencies(h), {
    method: "GET", path: PATH(options.project ?? "web"), query: {}, caller: caller({ orgId: options.org ?? ORG_A, developerId: who.id, projectRole: who.projectRole }),
    ...(options.withContext === false ? {} : { write: contextOf(h, who, undefined) }),
  }) as { status: number; body: Record<string, unknown> };
}

describe("T8: the editors' view lists a removed source while its data is still being deleted", () => {
  it("clearing is absent before a removal, present after it (source, place, since), and gone once the worker has finished", async () => {
    const h = harness();
    await seeded(h);
    const before = await view(h, WHO.owner);
    expect(before.status).toBe(200);
    expect(before.body).not.toHaveProperty("clearing");
    expect(before.body.sources).toHaveLength(1);
    const removedAt = new Date(h.w.clock.ms).toISOString();
    await post(h, WHO.owner, remove(1));
    const during = await view(h, WHO.owner);
    expect(during.body.sources).toEqual([]);
    expect(during.body.clearing).toEqual([{ source: "github", scope: GITHUB_SCOPE, since: removedAt }]);
    // A maintainer of the project sees it too.
    expect((await view(h, WHO.maint)).body.clearing).toEqual([{ source: "github", scope: GITHUB_SCOPE, since: removedAt }]);
    h.w.clock.ms += 59 * 60_000;
    await worker(h);
    expect(queue(h)).toHaveLength(0);
    const after = await view(h, WHO.owner);
    expect(after.status).toBe(200);
    expect(after.body).not.toHaveProperty("clearing");
  });

  it("members and callers without a live browser session get the old reply, with no clearing field", async () => {
    const h = harness();
    await seeded(h);
    const memberBefore = await view(h, WHO.contrib);
    expect(memberBefore.status).toBe(200);
    await post(h, WHO.owner, remove(1));
    for (const reply of [await view(h, WHO.contrib), await view(h, WHO.viewer), await view(h, { ...WHO.owner, browser: false }), await view(h, WHO.maint, { withContext: false })]) {
      expect(reply.status).toBe(200);
      expect(reply.body).not.toHaveProperty("clearing");
      expect(reply.body).not.toHaveProperty("canEdit");
      expect(JSON.stringify(reply.body)).not.toContain("repo/9");
    }
    // Byte-for-byte the reply a member had before there was a clearing list (the row is gone either way).
    expect(JSON.stringify((await view(h, WHO.contrib)).body)).toBe(JSON.stringify({ sources: [] }));
    expect(memberBefore.body.sources).toHaveLength(1);
  });

  it("another company, and another project of the same company, never see it", async () => {
    const h = harness();
    await seeded(h);
    const other = { id: OTHER_ORG_MAINT, orgRole: "member", projectRole: "maintainer" } as const;
    await post(h, WHO.owner, remove(1));
    expect((await view(h, WHO.owner)).body.clearing).toHaveLength(1); // positive control: the view does list it for the project
    const ownerOfB = { id: OTHER_ORG_OWNER, orgRole: "owner", projectRole: "maintainer" } as const;
    for (const reply of [await view(h, other, { org: ORG_B }), await view(h, ownerOfB, { org: ORG_B }), await view(h, WHO.owner, { project: "api" })]) {
      expect(reply.status).toBe(200);
      expect(reply.body).not.toHaveProperty("clearing");
    }
    // Company B's own removal shows only B's place, and A's view is unchanged by it.
    expect(await post(h, other, add({ retention: "C" }), { org: ORG_B })).toMatchObject({ status: 200 });
    expect(await post(h, other, remove(1), { org: ORG_B })).toEqual({ status: 200, body: { status: "removed" } });
    expect((await view(h, other, { org: ORG_B })).body.clearing).toHaveLength(1);
    expect((await view(h, WHO.owner)).body.clearing).toHaveLength(1);
  });

  it("a Rovara row's removal is not a clearing place (the place stays open and can be added at once)", async () => {
    const h = harness();
    expect(await post(h, WHO.owner, add({ source: "rovara", scope: "rovara:project/web", retention: "C" }))).toMatchObject({ status: 200 });
    expect(await post(h, WHO.owner, remove(1, { source: "rovara", scope: "rovara:project/web" }))).toEqual({ status: 200, body: { status: "removed" } });
    expect(queue(h)).toHaveLength(1); // positive control: work is queued
    expect((await view(h, WHO.owner)).body).not.toHaveProperty("clearing");
  });

  it("queue work that carries no project (a tap or an erasure) is not listed, and the list is bounded at 100", async () => {
    const h = harness();
    const base = { type: "tombstone", system: "github", cause: "excluded", hidePending: true, hidden: 0, childPending: true } as const;
    await putScopeWork(h.w.table, ORG_A, { ...base, requestId: randomUUID(), scope: "github:repo/700", at: AT, queuedAtSeconds: 1 });
    for (let index = 0; index < 120; index += 1) await putScopeWork(h.w.table, ORG_A, { ...base, requestId: randomUUID(), scope: `github:repo/${String(1000 + index)}`, project: "web", at: new Date(Date.parse(AT) + index * 1000).toISOString(), queuedAtSeconds: 1 + index });
    const reply = await view(h, WHO.owner);
    const clearing = reply.body.clearing as Array<{ scope: string }>;
    expect(clearing).toHaveLength(100);
    expect(clearing.some((entry) => entry.scope === "github:repo/700")).toBe(false);
  });

  it("the queue item carries the project that removed the place, nothing else new", async () => {
    const h = harness();
    await seeded(h);
    await post(h, WHO.owner, remove(1));
    expect(queue(h)[0]).toMatchObject({ project: "web", scope: GITHUB_SCOPE, cause: "excluded" });
  });
});
