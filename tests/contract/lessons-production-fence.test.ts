// The PRODUCTION fence of a lesson approval: the approver directory (`lessons/directory.ts`) pins its answer to the approver's live standing, and the real approval transaction carries those
// ConditionChecks (company membership generation, the approver's membership, sign-in identity and project grant, the project). Without them a person removed between the read and the write
// could still complete an approval. Runs the real directory over a fake table, with the real DynamoDB lesson store.
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, projectMetaKey, type OrgId } from "../../packages/contracts/src/index.js";
import { approveLesson, type ApproveDeps } from "../../packages/broker/src/lessons/approve.js";
import { createApproverDirectory } from "../../packages/broker/src/lessons/directory.js";
import { DynamoLessonStore } from "../../packages/broker/src/lessons/dynamo-store.js";
import type { InMemoryLessonStore, LessonStore } from "../../packages/broker/src/lessons/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { Audit, Clock, KEY, WS, allowAllAccess, lessonRecord, seed, settings } from "../unit/lessons/lesson-helpers.js";

const ORG = WS as OrgId;
const PROJECT = KEY.project;
const owner = "a".repeat(64), admin = "b".repeat(64), maintainer = "c".repeat(64), plain = "d".repeat(64);
const ID = "les_pend0001";
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

function world(options: { counter?: number | undefined } = { counter: 3 }) {
  const db = new FakeDynamoDb();
  db.set({ ...orgMetaKey(ORG), orgId: ORG, entityType: "ORG", createdAt: "2026-10-01T00:00:00.000Z", ...(options.counter === undefined ? {} : { approvalMembershipVersion: options.counter }), approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
  db.set({ ...projectMetaKey(ORG, PROJECT), entityType: "PROJECT_META", name: PROJECT, status: "active", createdAt: "2026-10-01T00:00:00.000Z", archiveRevision: 0 });
  const person = (id: string, role: "owner" | "admin" | "member") => {
    db.set({ ...orgMemberKey(ORG, id), orgId: ORG, developerId: id, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ ...developerOrgKey(id), orgId: ORG, role });
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
  };
  person(owner, "owner"); person(admin, "admin"); person(maintainer, "member"); person(plain, "member");
  db.set({ ...projectMemberKey(ORG, maintainer, PROJECT), ownerKey: maintainer, projectName: PROJECT, role: "developer", projectRole: "maintainer", grantId: "g1" });
  const evidence = { documentClient: db, tableName: "state", signInTableName: "signin", now: () => NOW };
  const directory = createApproverDirectory({ evidence, linkedAccounts: async () => [] });
  const store: LessonStore = new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" });
  const audit = new Audit();
  const clock = new Clock(NOW);
  let n = 0;
  const deps: ApproveDeps = { access: allowAllAccess, store, directory, settings: settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
  return { db, deps, store, audit, directory };
}
const pending = () => lessonRecord({ id: ID, status: "pending", tier: 2, tierReasons: ["reviewer_stage"], type: "review_check", stages: ["REVIEW"], approvals: [], pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] } });
const input = (approverId: string) => ({ ...KEY, lessonId: ID, approverId });
const checks = (db: FakeDynamoDb) => db.transactions().flat().filter((entry) => "ConditionCheck" in entry).map((entry) => (entry as { ConditionCheck: { TableName: string; Key: { pk: string; sk: string }; ConditionExpression: string } }).ConditionCheck);

describe("the production directory pins a lesson approval to the approver's standing", () => {
  it("asking for a named approver returns the fence; asking for the roster alone does not", async () => {
    const w = world();
    const fenced = await w.directory.eligibility(WS, PROJECT, { approverId: admin });
    expect(fenced.complete).toBe(true);
    expect(fenced.eligibleIds.sort()).toEqual([owner, admin, maintainer].sort());
    const fence = (fenced.fence ?? []) as Array<{ ConditionCheck: { TableName: string; Key: { pk: string; sk: string } } }>;
    expect(fence.length).toBeGreaterThanOrEqual(5);
    const keys = fence.map((c) => `${c.ConditionCheck.TableName}:${c.ConditionCheck.Key.sk}`);
    expect(keys).toContain(`state:${orgMetaKey(ORG).sk}`);
    expect(keys).toContain(`state:${orgMemberKey(ORG, admin).sk}`);
    expect(keys).toContain(`signin:META`);
    expect(keys).toContain(`state:${projectMetaKey(ORG, PROJECT).sk}`);
    expect((await w.directory.eligibility(WS, PROJECT)).fence).toBeUndefined();
  });

  it("a failed fenced read is NOBODY, never an unfenced roster (an approver who is not live; a closed company)", async () => {
    const w = world();
    w.db.set({ pk: `DEVELOPER#${admin}`, sk: "META", developerId: admin, revoked: true, revokedAt: "2026-10-30T00:00:00.000Z" });
    const gone = await w.directory.eligibility(WS, PROJECT, { approverId: admin });
    expect(gone).toMatchObject({ complete: false, eligibleIds: [], ownerIds: [] });
    expect(gone.fence).toBeUndefined();
    // The same roster read without a named approver still answers (the control: only the fenced read refuses).
    expect((await w.directory.eligibility(WS, PROJECT)).complete).toBe(true);
    // A plain member who is not a project maintainer is not an approver.
    expect((await world().directory.eligibility(WS, PROJECT, { approverId: plain })).complete).toBe(false);
    // A non-person id is refused.
    expect((await world().directory.eligibility(WS, PROJECT, { approverId: "ann" })).complete).toBe(false);
  });

  it("a company with no membership counter still has a fence (it does not throw like the proposer = approver evidence)", async () => {
    const w = world({ counter: undefined });
    const fenced = await w.directory.eligibility(WS, PROJECT, { approverId: owner });
    expect(fenced.complete).toBe(true);
    expect(fenced.membershipVersion).toBe(0);
    const meta = (fenced.fence as Array<{ ConditionCheck: { TableName: string; Key: { sk: string }; ConditionExpression: string } }>).find((c) => c.ConditionCheck.Key.sk === orgMetaKey(ORG).sk)!;
    expect(meta.ConditionCheck.ConditionExpression).toContain("attribute_not_exists(approvalMembershipVersion)");
  });
});

describe("the real lesson approval transaction carries the fence", () => {
  it("the go-live transaction holds the org membership, member, identity and project ConditionChecks", async () => {
    const w = world();
    await seed(w.store as InMemoryLessonStore, pending());
    expect(await approveLesson(w.deps, input(owner))).toMatchObject({ ok: true, status: "pending" });
    expect(await approveLesson(w.deps, input(admin))).toMatchObject({ ok: true, status: "active" });
    const written = checks(w.db);
    for (const [table, sk] of [["state", orgMetaKey(ORG).sk], ["state", orgMemberKey(ORG, admin).sk], ["state", developerOrgKey(admin).sk], ["signin", "META"], ["state", projectMetaKey(ORG, PROJECT).sk]] as const) {
      expect(written.some((c) => c.TableName === table && c.Key.sk === sk), `${table} ${sk}`).toBe(true);
    }
    // Each ConditionCheck sits in the same transaction as the write of the lesson itself.
    const last = w.db.transactions().at(-1)!;
    expect(last.some((entry) => "Put" in entry)).toBe(true);
    expect(last.filter((entry) => "ConditionCheck" in entry && (entry as { ConditionCheck: { TableName: string } }).ConditionCheck.TableName === "signin").length).toBeGreaterThanOrEqual(1);
  });

  it("an approver removed between the read and the write (the membership counter moves) cannot complete the approval", async () => {
    const w = world();
    await seed(w.store as InMemoryLessonStore, pending());
    expect(await approveLesson(w.deps, input(owner))).toMatchObject({ ok: true, status: "pending" });
    const real = w.audit.emit.bind(w.audit);
    let fired = false;
    w.audit.emit = async (e) => { await real(e); if (!fired && e.action === "lesson.approved") { fired = true; w.db.set({ ...orgMetaKey(ORG), orgId: ORG, entityType: "ORG", createdAt: "2026-10-01T00:00:00.000Z", approvalMembershipVersion: 4, approvalTrackingSince: "2026-10-01T00:00:00.000Z" }); } };
    const result = await approveLesson(w.deps, input(admin));
    expect(fired).toBe(true);
    const lesson = (await w.store.get(KEY, ID))!;
    // Whether the retry then sees the new generation and succeeds or refuses, the first write (made at the old generation) did not land.
    if (result.ok) expect(w.db.transactions().at(-1)!.some((entry) => "ConditionCheck" in entry && JSON.stringify(entry).includes("approvalMembershipVersion"))).toBe(true);
    expect(lesson.approvals.filter((a) => a.by === admin).length).toBeLessThanOrEqual(1);
  });

  it("an approver whose sign-in identity is revoked between the read and the write does not activate the lesson", async () => {
    const w = world();
    await seed(w.store as InMemoryLessonStore, pending());
    await approveLesson(w.deps, input(owner));
    const real = w.audit.emit.bind(w.audit);
    let fired = false;
    w.audit.emit = async (e) => { await real(e); if (!fired && e.action === "lesson.approved") { fired = true; w.db.set({ pk: `DEVELOPER#${admin}`, sk: "META", developerId: admin, revoked: true }); } };
    const result = await approveLesson(w.deps, input(admin));
    expect(result.ok).toBe(false);
    const lesson = (await w.store.get(KEY, ID))!;
    expect(lesson.status).toBe("pending");
    expect(lesson.approvals.map((a) => a.by)).toEqual([owner]);
  });
});
