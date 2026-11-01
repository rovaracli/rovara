// A lesson approval is fenced on the approver's standing (SY-7's pattern, as for the tier-0 setting): the commit carries the conditions that held when eligibility was read, so a person removed
// between the check and the write cannot activate, or add their approval to, a lesson. Run against both stores: the in-memory one (with a stand-in for the table's condition check) and the
// DynamoDB one on a fake table, where the conditions are real ConditionChecks in the same transaction as the write.
import { describe, expect, it } from "vitest";
import { approveLesson, rollbackLessonSet, type ApproveDeps } from "../../packages/broker/src/lessons/approve.js";
import { DynamoLessonStore } from "../../packages/broker/src/lessons/dynamo-store.js";
import { InMemoryLessonStore, type LessonStore } from "../../packages/broker/src/lessons/store.js";
import type { ApproverDirectory } from "../../packages/broker/src/lessons/ports.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { Audit, Clock, KEY, WS, directory, lessonRecord, seed, settings, allowAllAccess } from "./lessons/lesson-helpers.js";

const ID = "les_pend0001";
const base = (over: Parameters<typeof lessonRecord>[0] = {}) => lessonRecord({ id: ID, status: "pending", tier: 2, tierReasons: ["reviewer_stage"], type: "review_check", stages: ["REVIEW"], approvals: [], pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, authors: ["carl"] }, ...over });
const input = (approverId: string, extra: Record<string, unknown> = {}) => ({ ...KEY, lessonId: ID, approverId, ...extra });
const memberKey = (id: string) => ({ pk: `ORG#${WS}`, sk: `MEMBER#${id}` });
const checkOf = (id: string) => ({ ConditionCheck: { TableName: "TeamRecord", Key: memberKey(id), ConditionExpression: "attribute_exists(pk)" } });

interface World { store: LessonStore; present: Set<string>; remove(id: string): void; db?: FakeDynamoDb }
const worlds: Array<[string, () => World]> = [
  ["in-memory", () => {
    const present = new Set(["owner", "ann", "bob"]);
    // The stand-in reads each condition's key the way the table would.
    const store = new InMemoryLessonStore({ fenceCheck: (conditions) => conditions.every((c) => present.has(String((c as { ConditionCheck: { Key: { sk: string } } }).ConditionCheck.Key.sk.slice("MEMBER#".length)))) });
    return { store, present, remove: (id) => { present.delete(id); } };
  }],
  ["dynamodb", () => {
    const db = new FakeDynamoDb();
    const present = new Set(["owner", "ann", "bob"]);
    for (const id of present) db.set({ ...memberKey(id), entityType: "MEMBER" });
    return { store: new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" }), present, remove: (id) => { present.delete(id); db.delete(memberKey(id)); }, db };
  }],
];

describe.each(worlds)("lesson approval is fenced on the approver's standing (%s)", (_name, make) => {
  /** A directory that answers from `present` and pins each answer to the approver's own member record. */
  function fenced(world: World): ApproverDirectory {
    const base = directory();
    return {
      identity: (...args) => base.identity(...args),
      eligibility: async (_ws, _project, who) => ({ ...base.value, eligibleIds: base.value.eligibleIds.filter((id) => world.present.has(id)), fence: who === undefined ? [] : [checkOf(who.approverId)] }),
    };
  }
  function setup() {
    const world = make();
    const audit = new Audit();
    const clock = new Clock();
    let n = 0;
    const deps: ApproveDeps = { access: allowAllAccess, store: world.store, directory: fenced(world), settings: settings(), audit, now: clock.now, newId: () => `ap-${++n}` };
    const during = (action: string, fn: () => void): void => {
      let fired = false;
      const real = audit.emit.bind(audit);
      audit.emit = async (e) => { await real(e); if (!fired && e.action === action) { fired = true; fn(); } };
    };
    return { world, deps, during };
  }
  const get = async (store: LessonStore) => (await store.get(KEY, ID))!;

  it("a person removed between the check and the write cannot add the second approval: nothing activates, and the retry refuses them", async () => {
    const { world, deps, during } = setup();
    await seed(world.store as InMemoryLessonStore, base());
    expect(await approveLesson(deps, input("ann"))).toMatchObject({ ok: true, status: "pending" });
    during("lesson.approved", () => world.remove("bob"));
    const result = await approveLesson(deps, input("bob"));
    expect(result).toEqual({ ok: false, code: "not_eligible" });
    const l = await get(world.store);
    expect(l.status).toBe("pending");
    expect(l.approvals.map((a) => a.by)).toEqual(["ann"]);
  });

  it("the first approval is fenced the same way", async () => {
    const { world, deps, during } = setup();
    await seed(world.store as InMemoryLessonStore, base());
    during("lesson.approved", () => world.remove("ann"));
    expect(await approveLesson(deps, input("ann"))).toEqual({ ok: false, code: "not_eligible" });
    expect((await get(world.store)).approvals).toEqual([]);
  });

  it("a person who is still there is not slowed down: the fenced write goes through", async () => {
    const { world, deps } = setup();
    await seed(world.store as InMemoryLessonStore, base());
    await approveLesson(deps, input("ann"));
    expect(await approveLesson(deps, input("bob"))).toMatchObject({ ok: true, status: "active" });
    expect((await get(world.store)).approvals.map((a) => a.by).sort()).toEqual(["ann", "bob"]);
  });

  it("an edit-and-approve that is already fenced out writes nothing, not even the edited text", async () => {
    const { world, deps, during } = setup();
    await seed(world.store as InMemoryLessonStore, base({ tier: 1, tierReasons: ["not_a_fact"], type: "convention", stages: ["IMPLEMENT"] }));
    during("lesson.approved", () => world.remove("bob"));
    const before = await get(world.store);
    expect(await approveLesson(deps, input("bob", { edit: { title: "Bob's rule", description: "d", body: "Always do what bob wrote here." } }))).toEqual({ ok: false, code: "not_eligible" });
    expect(await get(world.store)).toEqual(before);
  });

  it("a rollback's re-check is fenced on the person who rolled back", async () => {
    const { world, deps, during } = setup();
    await seed(world.store as InMemoryLessonStore, base({ status: "active", approvals: [{ approvalId: "a1", by: "ann", at: 1, mode: "one" }, { approvalId: "a2", by: "owner", at: 1, mode: "second_person" }], expiresAt: 9e15 }));
    const v1 = await get(world.store);
    await world.store.commit(KEY, await world.store.setVersion(KEY), [{ ...v1, version: 2, status: "stale" }], 2);
    during("lesson.rolled_back", () => world.remove("owner"));
    await rollbackLessonSet(deps, { ...KEY, targetSetVersion: 1, expectedSetVersion: 2, actorId: "owner" });
    // The rolled-back lesson came back pending; with the actor gone the go-live is not written.
    expect((await get(world.store)).status).not.toBe("active");
  });
});

describe("the stores honour a fence or refuse; they never ignore one", () => {
  it("the in-memory store refuses a fenced write when it has no way to check the conditions", async () => {
    const store = new InMemoryLessonStore();
    const l = base();
    expect(await store.commit(KEY, 0, [l], 1, [checkOf("ann")])).toEqual({ ok: false, reason: "fenced" });
    expect(await store.get(KEY, ID)).toBeUndefined();
    expect(await store.commit(KEY, 0, [l], 1)).toMatchObject({ ok: true });
  });

  it("the DynamoDB store puts the conditions in the same transaction as the write, and a missing item cancels the whole write", async () => {
    const db = new FakeDynamoDb();
    db.set({ ...memberKey("ann"), entityType: "MEMBER" });
    const store = new DynamoLessonStore({ documentClient: db, tableName: "TeamRecord" });
    expect(await store.commit(KEY, 0, [base()], 1, [checkOf("ann")])).toMatchObject({ ok: true });
    expect(db.transactions().at(-1)!.some((entry) => "ConditionCheck" in entry && JSON.stringify(entry).includes("MEMBER#ann"))).toBe(true);
    db.delete(memberKey("ann"));
    const l = (await store.get(KEY, ID))!;
    expect(await store.commit(KEY, 1, [{ ...l, version: 2, title: "Changed" }], 2, [checkOf("ann")])).toMatchObject({ ok: false });
    expect((await store.get(KEY, ID))!.title).toBe(l.title);
    expect(await store.setVersion(KEY)).toBe(1);
  });
});
