// Owner decision 123: the company's internal address list. Adding needs a DIFFERENT owner or admin (no sole-owner exception); removing applies at once; every change is audited with safe facts only (counts, the
// revision, a digest), the hosts in the sealed details; one company's list and proposals are never another's.
import { describe, expect, it, vi } from "vitest";
import { AuditEventInputSchema, privateAddressListDigest, type AuditEventInput } from "@agentx/cloud-contracts";
import {
  approvePrivateAddresses, openPrivateAddressChange, proposePrivateAddresses, readPrivateAddresses, withdrawPrivateAddresses, type PrivateAddressDeps,
} from "../../packages/broker/src/org/private-addresses.js";
import { launchPrivateAddresses } from "../../packages/broker/src/aws/private-address-launch.js";
import { onAllowedWebsites } from "../../packages/broker/src/aws/developer-routes/private-addresses.js";
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

describe("closing access at once (owner decision 128)", () => {
  const mark = (t: ReturnType<typeof bench>, org: string) => [...t.db.items.values()].find((item) => (item as { pk?: string; sk?: string }).pk === "PRIVATEADDR#RECYCLE" && (item as { sk?: string }).sk === org);
  it("leaves a recycle mark for the company with a removal, in the same transaction, and none for an addition", async () => {
    const t = bench();
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443", "10.20.0.16:443"] });
    await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.15:443", "10.20.0.16:443"]) });
    expect(mark(t, ORG_A)).toBeUndefined();
    t.clock.now += 60_000;
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 1, entries: ["10.20.0.16:443"] });
    expect(mark(t, ORG_A)).toMatchObject({ orgId: ORG_A, removedAt: t.clock.now, entityType: "PRIVATE_ADDRESS_RECYCLE" });
    expect((mark(t, ORG_A) as { indexExpiresAt?: number }).indexExpiresAt).toBe(Math.floor(t.clock.now / 1000) + 15 * 86_400);
    expect(mark(t, ORG_B)).toBeUndefined();
    // A failed removal (stale revision) leaves no newer mark.
    const before = (mark(t, ORG_A) as { removedAt: number }).removedAt;
    t.clock.now += 60_000;
    expect(await code(proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 1, entries: [] }))).toBe("CHANGE_STALE");
    expect((mark(t, ORG_A) as { removedAt: number }).removedAt).toBe(before);
  });

  it("an approved list that also removes something recycles too", async () => {
    const t = bench();
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443"] });
    await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.15:443"]) });
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 1, entries: ["10.20.0.16:443"] });
    expect(mark(t, ORG_A)).toBeUndefined();
    await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-2", expectedDigest: privateAddressListDigest(["10.20.0.16:443"]) });
    expect(mark(t, ORG_A)).toMatchObject({ orgId: ORG_A });
  });

  it("gives every proposal row a TTL 30 days after it expires", async () => {
    const t = bench();
    await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.15:443"] });
    const row = [...t.db.items.values()].find((item) => (item as { entityType?: string }).entityType === "PRIVATE_ADDRESS_CHANGE") as { expiresAt: number; indexExpiresAt: number };
    expect(row.indexExpiresAt).toBe(Math.floor(row.expiresAt / 1000) + 30 * 86_400);
  });
});

describe("a stored list that does not parse (review L5)", () => {
  it("fails that company's launch with clear words, logged loudly, while another company's launch goes on; any save replaces it and recycles", async () => {
    const t = bench({ eligible: [A, B, C, D] });
    t.db.set({ pk: `ORG#${ORG_A}`, sk: "PRIVATEADDR#LIST", entityType: "PRIVATE_ADDRESS_LIST", entries: "10.20.0.15:443", revision: 3 });
    const wsA = "11111111-1111-4111-8111-111111111111", wsB = "22222222-2222-4222-8222-222222222222";
    t.db.set({ pk: `WORKSPACE#${wsA}`, sk: "META", id: wsA, orgId: ORG_A });
    t.db.set({ pk: `WORKSPACE#${wsB}`, sk: "META", id: wsB, orgId: ORG_B });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { logged.push(String(line)); });
    try {
      await expect(launchPrivateAddresses(t.deps, wsA, INSTALL)).rejects.toThrow("stored in a form Rovara can't read");
      expect(logged.some((line) => line.includes("private_addresses.list_unreadable") && line.includes(ORG_A))).toBe(true);
    } finally { spy.mockRestore(); }
    expect(await launchPrivateAddresses(t.deps, wsB, INSTALL)).toEqual([]);
    // Saving the empty list replaces it at once (one admin), and recycles the company's workers.
    expect(await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 3, entries: [] })).toMatchObject({ status: "applied", list: { revision: 4, entries: [] } });
    expect(await launchPrivateAddresses(t.deps, wsA, INSTALL)).toEqual([]);
    expect([...t.db.items.values()].some((item) => (item as { pk?: string; sk?: string }).pk === "PRIVATEADDR#RECYCLE" && (item as { sk?: string }).sk === ORG_A)).toBe(true);
  });

  it("a corrupt row with no readable revision is replaced by a proposal a second admin approves", async () => {
    const t = bench();
    t.db.set({ pk: `ORG#${ORG_A}`, sk: "PRIVATEADDR#LIST", entityType: "PRIVATE_ADDRESS_LIST", entries: ["10.20.0.15:443"], revision: "x" });
    expect(await proposePrivateAddresses(t.deps, { orgId: ORG_A, actorId: A, expectedRevision: 0, entries: ["10.20.0.16:443"] })).toEqual({ status: "needs_approval", changeId: "change-1" });
    expect(await approvePrivateAddresses(t.deps, { orgId: ORG_A, approverId: B, changeId: "change-1", expectedDigest: privateAddressListDigest(["10.20.0.16:443"]) })).toMatchObject({ revision: 1, entries: ["10.20.0.16:443"] });
  });
});

describe("the allowed-websites warning's match", () => {
  it("matches an exact entry or a wildcard it falls under, and nothing else", () => {
    expect(onAllowedWebsites("nexus.corp.example", ["nexus.corp.example"])).toBe(true);
    expect(onAllowedWebsites("nexus.corp.example", ["*.corp.example"])).toBe(true);
    expect(onAllowedWebsites("corp.example", ["*.corp.example"])).toBe(false);
    expect(onAllowedWebsites("evilcorp.example", ["*.corp.example"])).toBe(false);
    expect(onAllowedWebsites("nexus.corp.example", ["corp.example"])).toBe(false);
  });
});
