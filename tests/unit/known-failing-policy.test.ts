// Setup and test health SH17 (owner decision F4): the company setting "always two people" for marking tests as already failing. OFF by default. Turning it ON applies at once; turning it OFF needs a DIFFERENT eligible
// admin (the one-admin rule: no sole-owner exception for loosening); an unreadable value counts as ON; every change is audited under this setting's own ledger names.
import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "@agentx/cloud-contracts";
import { KnownFailingPolicyStore, alwaysTwoPeople, approveAlwaysTwoPeopleOff, knownFailingPolicyAuditSink, setAlwaysTwoPeople, type KnownFailingPolicyDeps } from "../../packages/broker/src/org/known-failing-policy.js";
import type { Tier0Authority } from "../../packages/broker/src/lessons/sole-owner-switch.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = `org_${"d".repeat(20)}`;
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);

function bench(eligible: string[] = [A, B]) {
  const db = new FakeDynamoDb();
  const events: AuditEventInput[] = [];
  const clock = { now: Date.UTC(2026, 10, 2, 10, 0, 0) };
  const group = { value: { complete: true, membershipVersion: 4, ownerIds: eligible.slice(0, 1), eligibleIds: eligible, lastEligibleLossAtMs: null as number | null } };
  const authority: Tier0Authority = { eligibility: async () => group.value };
  const table = { documentClient: db, tableName: "state" };
  const deps: KnownFailingPolicyDeps = {
    table, evidence: {} as never, authority, now: () => clock.now,
    audit: knownFailingPolicyAuditSink(async (event) => { events.push(event); }, () => clock.now),
  };
  let counter = 0;
  deps.newId = () => `change-${String(++counter)}`;
  return { db, deps, events, group, table, clock };
}

describe("always two people", () => {
  it("is off when never set, and on when the stored value cannot be read (the stricter side)", async () => {
    const t = bench();
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(false);
    t.db.set({ pk: `ORG#${ORG}`, sk: "KNOWNFAILING#POLICY", enabled: "garbage" });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(true);
    expect(await alwaysTwoPeople({ read: async () => { throw new Error("down"); } }, ORG)).toBe(true);
  });

  it("turning it ON applies at once for an eligible admin and is audited as a direct change", async () => {
    const t = bench();
    expect(await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: true, requestedBy: A })).toEqual({ ok: true, status: "applied", alwaysTwoPeople: true });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(true);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ action: "company.known_failing_policy_changed", target: { kind: "org" }, facts: { fromAlwaysTwo: false, toAlwaysTwo: true, mode: "direct" } });
  });

  it("is refused for a person who is not an eligible admin, and writes nothing", async () => {
    const t = bench();
    expect(await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: true, requestedBy: C })).toEqual({ ok: false, code: "not_eligible" });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(false);
    expect(t.events).toEqual([]);
  });

  it("turning it OFF opens a proposal and changes nothing; a DIFFERENT admin approves it", async () => {
    const t = bench();
    await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: true, requestedBy: A });
    t.events.length = 0;
    const asked = await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: false, requestedBy: A });
    expect(asked).toEqual({ ok: true, status: "needs_approval", changeId: "change-1" });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(true);
    expect(t.events[0]).toMatchObject({ action: "company.known_failing_policy_proposed", facts: { fromAlwaysTwo: true, toAlwaysTwo: false } });
    // The proposer cannot approve their own.
    expect(await approveAlwaysTwoPeopleOff(t.deps, { orgId: ORG, changeId: "change-1", approverId: A })).toEqual({ ok: false, code: "second_person_required" });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(true);
    // A person who is not eligible cannot either.
    expect(await approveAlwaysTwoPeopleOff(t.deps, { orgId: ORG, changeId: "change-1", approverId: C })).toEqual({ ok: false, code: "not_eligible" });
    expect(await approveAlwaysTwoPeopleOff(t.deps, { orgId: ORG, changeId: "change-1", approverId: B })).toEqual({ ok: true, alwaysTwoPeople: false });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(false);
    expect(t.events.at(-1)).toMatchObject({ action: "company.known_failing_policy_changed", actor: { id: B }, facts: { fromAlwaysTwo: true, toAlwaysTwo: false, mode: "second_person" } });
    // The same proposal cannot be used twice.
    expect(await approveAlwaysTwoPeopleOff(t.deps, { orgId: ORG, changeId: "change-1", approverId: B })).toEqual({ ok: false, code: "not_pending" });
  });

  it("gives a company of one no way to loosen it alone: the sole-owner exception does not apply to turning it off", async () => {
    const t = bench([A]);
    await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: true, requestedBy: A });
    await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: false, requestedBy: A });
    expect(await approveAlwaysTwoPeopleOff(t.deps, { orgId: ORG, changeId: "change-1", approverId: A })).toEqual({ ok: false, code: "second_person_required" });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(true);
  });

  it("does not loosen after the proposal expired or when the setting moved since it was proposed", async () => {
    const t = bench();
    await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: true, requestedBy: A });
    await setAlwaysTwoPeople(t.deps, { orgId: ORG, alwaysTwo: false, requestedBy: A });
    t.clock.now += 8 * 86_400_000;
    expect(await approveAlwaysTwoPeopleOff(t.deps, { orgId: ORG, changeId: "change-1", approverId: B })).toEqual({ ok: false, code: "expired" });
    expect(await alwaysTwoPeople(t.table, ORG)).toBe(true);
  });

  it("the store reads what it wrote and treats a missing company as off", async () => {
    const t = bench();
    const store = new KnownFailingPolicyStore(t.table);
    expect(await store.read(ORG)).toBe(true);
    expect(await store.write(ORG, false, { by: A, at: 1 }, true)).toBe(true);
    expect(await store.read(ORG)).toBe(false);
    expect(await store.write(ORG, true, { by: A, at: 2 }, true)).toBe(false);
  });
});

describe("the audit sink", () => {
  it("refuses an event it has no ledger name for, so a grant never passes unrecorded", async () => {
    const sink = knownFailingPolicyAuditSink(async () => undefined, () => 0);
    await expect(sink.emit({ action: "lesson.approved", workspaceId: ORG, project: "p", actor: A, facts: {} } as never)).rejects.toThrow("no name");
  });
});
