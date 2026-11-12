// Owner decision 123: the company's internal address list. Adding needs a DIFFERENT owner or admin (no sole-owner exception); removing applies at once; every change is audited with safe facts only (counts, the
// revision, a digest), the hosts in the sealed details; one company's list and proposals are never another's.
import { describe, expect, it } from "vitest";
import { AuditEventInputSchema, privateAddressListDigest, type AuditEventInput } from "@agentx/cloud-contracts";
import {
  approvePrivateAddresses, openPrivateAddressChange, proposePrivateAddresses, readPrivateAddresses, withdrawPrivateAddresses, type PrivateAddressDeps,
} from "../../packages/broker/src/org/private-addresses.js";
import { launchPrivateAddresses } from "../../packages/broker/src/aws/private-address-launch.js";
import type { Tier0Authority } from "../../packages/broker/src/lessons/sole-owner-switch.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG_A = `org_${"a".repeat(20)}`, ORG_B = `org_${"b".repeat(20)}`;
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64);
const INSTALL = { vpcCidrs: ["10.42.0.0/16"], serviceHosts: [] };

function bench(options: { eligible?: string[]; ledger?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const clock = { now: Date.UTC(2026, 10, 12, 10, 0, 0) };
  const eligible = options.eligible ?? [A, B];
  const group = { value: { complete: true, membershipVersion: 3, ownerIds: eligible.slice(0, 1), eligibleIds: eligible, lastEligibleLossAtMs: null as number | null } };
  const asked: Array<{ scope: unknown; who: unknown }> = [];
  const authority: Tier0Authority = { eligibility: async (scope, who) => { asked.push({ scope, who }); return group.value; } };
  let counter = 0;
  const deps: PrivateAddressDeps = {
    documentClient: db, tableName: "state", evidence: {} as never, install: INSTALL, now: () => clock.now, authority,
    adminConditions: async (_org, actor) => { if (!eligible.includes(actor)) throw Object.assign(new Error("no"), { code: "FORBIDDEN" }); return []; },
    newId: () => `change-${String(++counter)}`,
    ...(options.ledger === false ? {} : { audit: { sqs: {} as never, queueUrl: "", documentClient: db as never, tableName: "state", now: () => clock.now, log: () => undefined, pendingOnly: true as const } }),
  };
  // In the order they were written (the table keeps insertion order).
  const events = (): AuditEventInput[] => [...db.items.values()].flatMap((item) => (item as { event?: AuditEventInput }).event === undefined ? [] : [(item as { event: AuditEventInput }).event]);
  return { db, deps, clock, group, asked, events };
}

const code = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return "ok"; } catch (error) { return (error as { code?: string }).code ?? "thrown"; } };

describe("adding internal addresses", () => {
  it("opens a proposal that changes nothing until a DIFFERENT admin approves the digest they were shown", async () => {
    const t = bench();
    const asked = await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["nexus.corp.example:8081", "10.20.0.15:443"] });
    expect(asked).toEqual({ status: "needs_approval", changeId: "change-1" });
    expect((await readPrivateAddresses(t.deps, ORG_A)).entries).toEqual([]);
    const digest = privateAddressListDigest(["10.20.0.15:443", "nexus.corp.example:8081"]);
    // The proposer can never approve their own.
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: A, changeId: "change-1", expectedDigest: digest }))).toBe("FORBIDDEN");
    // Nor can someone who is not an owner or admin.
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: C, changeId: "change-1", expectedDigest: digest }))).toBe("FORBIDDEN");
    // Nor anyone approving a list other than the one they were shown.
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.15:443"]) }))).toBe("CHANGE_STALE");
    expect((await readPrivateAddresses(t.deps, ORG_A)).entries).toEqual([]);
    const list = await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: digest });
    expect(list).toMatchObject({ revision: 1, entries: ["10.20.0.15:443", "nexus.corp.example:8081"], digest });
    // The shared rule was asked about the proposer AND the approver, for the company.
    expect(t.asked.at(-1)).toEqual({ scope: { kind: "company", workspaceId: ORG_A }, who: { proposerId: A, approverId: B } });
    // A proposal is used once.
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: digest }))).toBe("CHANGE_STALE");
  });

  it("gives a company of one admin no way to add alone: no sole-owner exception", async () => {
    const t = bench({ eligible: [A] });
    t.group.value.lastEligibleLossAtMs = t.clock.now - 30 * 86_400_000;
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443"] });
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: A, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.15:443"]) }))).toBe("FORBIDDEN");
    expect((await readPrivateAddresses(t.deps, ORG_A)).entries).toEqual([]);
  });

  it("is refused by a proposer who is not an owner or admin, for a refused entry, and against a stale revision", async () => {
    const t = bench();
    expect(await code(proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: C, expectedRevision: 0, entries: ["10.20.0.15:443"] }))).toBe("FORBIDDEN");
    for (const bad of ["169.254.169.254:80", "10.42.0.2:53", "*.corp.example:443", "10.0.0.0/8", "nexus.corp.example"]) {
      expect(await code(proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443", bad] })), bad).toBe("CONFIG_INVALID");
    }
    expect(await code(proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 3, entries: ["10.20.0.15:443"] }))).toBe("CHANGE_STALE");
    expect(t.events()).toEqual([]);
  });

  it("allows one waiting proposal at a time, which its proposer withdraws or another admin turns down", async () => {
    const t = bench({ eligible: [A, B, D] });
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443"] });
    expect(await code(proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: B, expectedRevision: 0, entries: ["10.20.0.16:443"] }))).toBe("CHANGE_STALE");
    await withdrawPrivateAddresses(t.deps, { orgId: ORG_A, actorId: D, changeId: "change-1" });
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.15:443"]) }))).toBe("CHANGE_STALE");
    expect(await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: B, expectedRevision: 0, entries: ["10.20.0.16:443"] })).toEqual({ status: "needs_approval", changeId: "change-2" });
    expect(t.events().at(-2)).toMatchObject({ action: "company.private_addresses_withdrawn", facts: { by: "admin", entryCount: 1 } });
  });

  it("expires after 7 days, and a proposal made against an older list can no longer be approved", async () => {
    const t = bench();
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443"] });
    t.clock.now += 7 * 86_400_000;
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.15:443"]) }))).toBe("CHANGE_STALE");
    // A second proposal, then the list moves under it (an approved first list is replaced by a removal).
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443", "10.20.0.16:443"] });
    await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-2", expectedDigest: privateAddressListDigest(["10.20.0.15:443", "10.20.0.16:443"]) });
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 1, entries: ["10.20.0.15:443", "10.20.0.16:443", "10.20.0.17:443"] });
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: B, expectedRevision: 1, entries: ["10.20.0.15:443"] });
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-3", expectedDigest: privateAddressListDigest(["10.20.0.15:443", "10.20.0.16:443", "10.20.0.17:443"]) }))).toBe("CHANGE_STALE");
    expect(await openPrivateAddressChange(t.deps, ORG_A, t.clock.now, await readPrivateAddresses(t.deps, ORG_A))).toBeUndefined();
  });

  it("is refused without the audit ledger: nothing is proposed", async () => {
    const t = bench({ ledger: false });
    expect(await code(proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443"] }))).toBe("AUDIT_UNAVAILABLE");
    expect(await openPrivateAddressChange(t.deps, ORG_A, t.clock.now, await readPrivateAddresses(t.deps, ORG_A))).toBeUndefined();
  });
});

describe("removing internal addresses", () => {
  it("applies at once by one admin, and works without a ledger (closing a wall is never blocked)", async () => {
    const t = bench();
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443", "10.20.0.16:443"] });
    await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.15:443", "10.20.0.16:443"]) });
    expect(await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 1, entries: ["10.20.0.16:443"] })).toMatchObject({ status: "applied", list: { revision: 2, entries: ["10.20.0.16:443"] } });
    expect(t.events().at(-1)).toMatchObject({ action: "company.private_addresses_changed", actor: { id: A }, facts: { mode: "direct", added: 0, removed: 1, entryCount: 1, revision: 2 } });
    const quiet = bench({ ledger: false });
    quiet.db.set({ pk: `ORG#${ORG_A}`, sk: "PRIVATEADDR#LIST", entityType: "PRIVATE_ADDRESS_LIST", orgId: ORG_A, entries: ["10.20.0.15:443"], revision: 4 });
    expect(await proposePrivateAddresses(quiet.deps, { orgId: ORG_A, actorId: A, expectedRevision: 4, entries: [] })).toMatchObject({ status: "applied", list: { revision: 5, entries: [] } });
  });

  it("fails closed on a stored list that does not parse", async () => {
    const t = bench();
    t.db.set({ pk: `ORG#${ORG_A}`, sk: "PRIVATEADDR#LIST", entityType: "PRIVATE_ADDRESS_LIST", entries: "10.20.0.15:443", revision: 1 });
    await expect(readPrivateAddresses(t.deps, ORG_A)).rejects.toThrow();
  });
});

describe("the audit record", () => {
  it("holds counts, the revision, a digest and fixed words only: the hosts are in the sealed company details", async () => {
    const t = bench();
    const entries = ["nexus.corp.example:8081", "10.20.0.15:443"];
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries });
    await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(entries) });
    const [proposed, changed] = t.events();
    expect(proposed).toMatchObject({ action: "company.private_addresses_proposed", actor: { kind: "member", id: A }, target: { kind: "org", id: ORG_A }, facts: { revision: 0, entryCount: 2, added: 2, removed: 0, listDigest: privateAddressListDigest(entries) } });
    expect(changed).toMatchObject({ action: "company.private_addresses_changed", actor: { kind: "member", id: B }, facts: { revision: 1, entryCount: 2, added: 2, removed: 0, mode: "second_person" } });
    for (const event of [proposed!, changed!]) {
      expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
      // Positive control: the hosts were really in the event (its details), and nowhere outside them.
      expect(JSON.stringify(event.details)).toContain("nexus.corp.example");
      const outside = JSON.stringify({ ...event, details: undefined });
      for (const leak of ["nexus", "corp.example", "10.20.0.15", "8081"]) expect(outside, leak).not.toContain(leak);
      expect(event.details).toEqual([{ subject: "org", fields: { entries1: "10.20.0.15:443,nexus.corp.example:8081" } }]);
    }
  });

  it("splits a long list over detail fields that fit", async () => {
    const t = bench();
    const entries = Array.from({ length: 16 }, (_, index) => `${String(index).padStart(2, "0")}${"n".repeat(40)}.${"m".repeat(43)}.example:65535`);
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries });
    const [event] = t.events();
    expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
    expect(Object.values(event!.details![0]!.fields).join(",").split(",")).toEqual([...entries].sort());
  });
});

describe("company isolation", () => {
  it("never shows, approves or withdraws one company's proposal from another", async () => {
    const t = bench({ eligible: [A, B, C, D] });
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443"] });
    const digest = privateAddressListDigest(["10.20.0.15:443"]);
    expect(await code(approvePrivateAddresses(t.deps, { orgId: ORG_B, approverId: C, changeId: "change-1", expectedDigest: digest }))).toBe("NOT_FOUND");
    expect(await code(withdrawPrivateAddresses(t.deps, { orgId: ORG_B, actorId: C, changeId: "change-1" }))).toBe("NOT_FOUND");
    expect(await openPrivateAddressChange(t.deps, ORG_B, t.clock.now, await readPrivateAddresses(t.deps, ORG_B))).toBeUndefined();
    await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: digest });
    expect((await readPrivateAddresses(t.deps, ORG_B)).entries).toEqual([]);
    // B's own list is its own.
    await proposePrivateAddresses(t.deps, { orgId: ORG_B, actorId: C, expectedRevision: 0, entries: ["10.30.0.9:8081"] });
    await approvePrivateAddresses(t.deps, { orgId: ORG_B, approverId: D, changeId: "change-2", expectedDigest: privateAddressListDigest(["10.30.0.9:8081"]) });
    expect((await readPrivateAddresses(t.deps, ORG_A)).entries).toEqual(["10.20.0.15:443"]);
    expect((await readPrivateAddresses(t.deps, ORG_B)).entries).toEqual(["10.30.0.9:8081"]);
  });

  it("launches each workspace's worker with its own company's list only, and none for a workspace naming no company", async () => {
    const t = bench({ eligible: [A, B, C, D] });
    for (const [org, entry, proposer, approver, id] of [[ORG_A, "10.20.0.15:443", A, B, "change-1"], [ORG_B, "10.30.0.9:8081", C, D, "change-2"]] as const) {
      await proposePrivateAddresses(t.deps, { orgId: org, actorId: proposer, expectedRevision: 0, entries: [entry] });
      await approvePrivateAddresses(t.deps, { orgId: org, approverId: approver, changeId: id, expectedDigest: privateAddressListDigest([entry]) });
    }
    const wsA = "11111111-1111-4111-8111-111111111111", wsB = "22222222-2222-4222-8222-222222222222", wsNone = "33333333-3333-4333-8333-333333333333";
    t.db.set({ pk: `WORKSPACE#${wsA}`, sk: "META", id: wsA, orgId: ORG_A });
    t.db.set({ pk: `WORKSPACE#${wsB}`, sk: "META", id: wsB, orgId: ORG_B });
    t.db.set({ pk: `WORKSPACE#${wsNone}`, sk: "META", id: wsNone });
    expect(await launchPrivateAddresses(t.deps, wsA, INSTALL)).toEqual(["10.20.0.15:443"]);
    expect(await launchPrivateAddresses(t.deps, wsB, INSTALL)).toEqual(["10.30.0.9:8081"]);
    expect(await launchPrivateAddresses(t.deps, wsNone, INSTALL)).toEqual([]);
    expect(await launchPrivateAddresses(t.deps, "44444444-4444-4444-8444-444444444444", INSTALL)).toEqual([]);
    // A record whose own id is not the workspace asked for (a misfiled or copied item) gives no list.
    const wsCopy = "55555555-5555-4555-8555-555555555555";
    t.db.set({ pk: `WORKSPACE#${wsCopy}`, sk: "META", id: wsA, orgId: ORG_A });
    expect(await launchPrivateAddresses(t.deps, wsCopy, INSTALL)).toEqual([]);
    // An entry that a tightened install now refuses is left out at launch.
    expect(await launchPrivateAddresses(t.deps, wsA, { vpcCidrs: ["10.20.0.0/16"], serviceHosts: [] })).toEqual([]);
  });
});
