// Member removal (v1.1), task 1: S0, the one transaction that cuts a person off and records the removal. Through the real OrgStore and
// FakeDynamoDb: a refused removal changes nothing (the grants are no longer deleted first), a person with no GitHub link can be removed,
// the request id is a receipt, the recorded grants are the exact delete list, and the tombstone has no expiry.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  developerOrgKey, memberGrantsPk, memberRemovalQueueKey, orgBanKey, orgEmailKey, orgMemberKey, orgRemovedKey, orgSettingsKey, type OrgId,
} from "@agentx/contracts";
import { githubMemberKey, memberGithubKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { memberRemovalRecordKey, MEMBER_REMOVAL_EMAIL_CAP } from "../../packages/contracts/src/member-removal.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const T0 = Date.parse("2026-10-30T10:00:00.000Z");
const REQUEST = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST = "22222222-2222-4222-8222-222222222222";

async function world(options: { hook?: boolean } = {}) {
  let clock = T0;
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db, now: () => clock });
  const hookCalls: unknown[] = [];
  const store = new OrgStore({
    documentClient: db, tableName: "state", now: () => clock, audit: audit.audit,
    ...(options.hook === false ? {} : { // The hook stops short (as a request that ran out of time does), so the marker stays for the sweep.
    memberRemoval: { onRemoved: async (event) => { hookCalls.push(event); throw new Error("left to the sweep"); } } }),
  });
  const orgId = await store.createOrgWithOwner({ name: "Acme", developerId: "owner", email: "owner@example.com" });
  await store.addMember({ orgId, developerId: "sam", role: "member", email: "sam@example.com" });
  return { db, store, orgId, audit, hookCalls, tick: (ms: number) => { clock += ms; } };
}

const grant = (orgId: OrgId, who: string, project: string, extra: Record<string, unknown> = {}) =>
  ({ ...projectMemberKey(orgId, who, project), entityType: "MEMBERSHIP", ownerKey: who, projectName: project, role: "developer", projectRole: "contributor", grantId: `grant-${who}-${project}`, ...extra });

describe("removeMember: S0", () => {
  it("deletes the member, the pointer and the email pointer, and puts the tombstone, the record and the marker in one transaction", async () => {
    const w = await world();
    const before = w.db.commandNames().length;
    const result = await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: ["sam@example.com"], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", requestId: REQUEST });
    expect(result).toMatchObject({ removalId: REQUEST, state: "STARTED", successorId: "owner", replay: false });
    expect(w.db.get(orgMemberKey(w.orgId, "sam"))).toBeUndefined();
    expect(w.db.get(developerOrgKey("sam"))).toBeUndefined();
    expect(w.db.get(orgEmailKey("sam@example.com"))).toBeUndefined();
    expect(w.db.get(orgRemovedKey(w.orgId, "sam"))).toMatchObject({ removedAt: "2026-10-30T10:00:00.000Z" });
    expect(w.db.get(memberRemovalRecordKey(w.orgId, REQUEST))).toMatchObject({ leaverId: "sam", role: "member", successorId: "owner", by: "owner", state: "STARTED", removedAt: "2026-10-30T10:00:00.000Z" });
    expect(w.db.find((item) => item.pk === memberRemovalQueueKey("2026-10-30T10:00:00.000Z", w.orgId, "sam").pk)).toEqual([
      expect.objectContaining({ orgId: w.orgId, developerId: "sam", by: "owner", removalId: REQUEST, successorId: "owner", removedAt: "2026-10-30T10:00:00.000Z" }),
    ]);
    // (The audit flush deletes its own pending item afterwards; nothing else is written outside the transaction.)
    const writes = w.db.commandNames().slice(before).filter((name) => ["PutCommand", "UpdateCommand", "TransactWriteCommand"].includes(name));
    expect(writes).toEqual(["TransactWriteCommand"]);
  });

  it("changes nothing when the removal is refused: the grants and the monthly limit stay (G2)", async () => {
    const w = await world();
    w.db.set(grant(w.orgId, "owner", "payments"));
    w.db.set({ ...orgSettingsKey(w.orgId, "BUDGET"), entityType: "ORG_SETTINGS", revision: 1, memberOverrides: { owner: 40 } });
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "owner", emails: [], ban: false })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(w.db.get(projectMemberKey(w.orgId, "owner", "payments"))).toBeDefined();
    expect(w.db.get(orgSettingsKey(w.orgId, "BUDGET"))).toMatchObject({ memberOverrides: { owner: 40 } });
    expect(w.db.get(orgMemberKey(w.orgId, "owner"))).toBeDefined();
    expect(w.db.get(orgRemovedKey(w.orgId, "owner"))).toBeUndefined();
  });

  it("deletes no grant in S0: it records the exact grants and the limit it saw, for the access step", async () => {
    const w = await world();
    w.db.set(grant(w.orgId, "sam", "payments"));
    w.db.set(grant(w.orgId, "sam", "web", { projectRole: "maintainer" }));
    w.db.set({ ...orgSettingsKey(w.orgId, "BUDGET"), entityType: "ORG_SETTINGS", revision: 1, memberOverrides: { sam: 25 } });
    await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", requestId: REQUEST });
    expect(w.db.find((item) => item.pk === memberGrantsPk(w.orgId, "sam"))).toHaveLength(2);
    const record = w.db.get(memberRemovalRecordKey(w.orgId, REQUEST))!;
    expect(record.grants).toEqual([
      { project: "payments", grantId: "grant-sam-payments", role: "developer", projectRole: "contributor" },
      { project: "web", grantId: "grant-sam-web", role: "developer", projectRole: "maintainer" },
    ]);
    expect(record.memberLimitUsd).toBe(25);
  });

  it("refuses more than 2000 grants with RUNTIME_UNAVAILABLE and changes nothing", async () => {
    const w = await world();
    for (let index = 0; index < 2001; index += 1) w.db.set(grant(w.orgId, "sam", `p${String(index).padStart(4, "0")}`));
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.get(orgMemberKey(w.orgId, "sam"))).toBeDefined();
  });

  it("removes a person who has no GitHub link", async () => {
    const w = await world();
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" })).resolves.toMatchObject({ state: "STARTED" });
  });

  it("deletes the GitHub link in both directions when there is one", async () => {
    const w = await world();
    w.db.set({ ...memberGithubKey(w.orgId, "sam"), entityType: "MEMBER_GITHUB", orgId: w.orgId, githubUserId: "4711", developerId: "sam", linkedAt: "x" });
    w.db.set({ ...githubMemberKey(w.orgId, "4711"), entityType: "GITHUB_MEMBER", orgId: w.orgId, githubUserId: "4711", developerId: "sam", linkedAt: "x" });
    await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" });
    expect(w.db.get(memberGithubKey(w.orgId, "sam"))).toBeUndefined();
    expect(w.db.get(githubMemberKey(w.orgId, "4711"))).toBeUndefined();
  });

  it("removes a person whose GitHub link item names no account, or whose account item is missing, or belongs to someone else", async () => {
    const nameless = await world();
    nameless.db.set({ ...memberGithubKey(nameless.orgId, "sam"), entityType: "MEMBER_GITHUB", orgId: nameless.orgId, developerId: "sam", linkedAt: "x" });
    await nameless.store.removeMember({ orgId: nameless.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" });
    expect(nameless.db.get(memberGithubKey(nameless.orgId, "sam"))).toBeUndefined();

    const noReverse = await world();
    noReverse.db.set({ ...memberGithubKey(noReverse.orgId, "sam"), entityType: "MEMBER_GITHUB", orgId: noReverse.orgId, githubUserId: "4711", developerId: "sam", linkedAt: "x" });
    await noReverse.store.removeMember({ orgId: noReverse.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" });
    expect(noReverse.db.get(memberGithubKey(noReverse.orgId, "sam"))).toBeUndefined();

    const theirs = await world();
    theirs.db.set({ ...memberGithubKey(theirs.orgId, "sam"), entityType: "MEMBER_GITHUB", orgId: theirs.orgId, githubUserId: "4711", developerId: "sam", linkedAt: "x" });
    theirs.db.set({ ...githubMemberKey(theirs.orgId, "4711"), entityType: "GITHUB_MEMBER", orgId: theirs.orgId, githubUserId: "4711", developerId: "someone-else", linkedAt: "x" });
    await theirs.store.removeMember({ orgId: theirs.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" });
    expect(theirs.db.get(memberGithubKey(theirs.orgId, "sam"))).toBeUndefined();
    expect(theirs.db.get(githubMemberKey(theirs.orgId, "4711"))).toMatchObject({ developerId: "someone-else" });
  });

  it("is CHANGE_STALE, and removes nothing, when a GitHub link appears between the read and the transaction", async () => {
    const w = await world();
    const realSend = w.db.send;
    w.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") {
        w.db.set({ ...memberGithubKey(w.orgId, "sam"), entityType: "MEMBER_GITHUB", orgId: w.orgId, githubUserId: "4711", developerId: "sam", linkedAt: "x" });
      }
      return realSend(command);
    };
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(w.db.get(orgMemberKey(w.orgId, "sam"))).toBeDefined();
  });

  it("puts the ban only on a private install", async () => {
    const a = await world();
    await a.store.removeMember({ orgId: a.orgId, developerId: "sam", emails: [], ban: true, by: { kind: "member", id: "owner" }, callerRole: "owner" });
    expect(a.db.get(orgBanKey(a.orgId, "sam"))).toBeDefined();
    const b = await world();
    await b.store.removeMember({ orgId: b.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner" });
    expect(b.db.get(orgBanKey(b.orgId, "sam"))).toBeUndefined();
  });

  it("deletes at most 10 email pointers in S0 and leaves the rest on the record for the access step", async () => {
    const w = await world();
    const emails = Array.from({ length: MEMBER_REMOVAL_EMAIL_CAP + 2 }, (_, index) => `sam${String(index)}@example.com`);
    for (const email of emails) w.db.set({ ...orgEmailKey(email), entityType: "ORG_EMAIL", developerId: "sam", orgId: w.orgId, createdAt: "2026-10-01T00:00:00.000Z" });
    await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails, ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", requestId: REQUEST });
    const left = emails.filter((email) => w.db.get(orgEmailKey(email)) !== undefined);
    expect(left).toHaveLength(2);
    expect(w.db.get(memberRemovalRecordKey(w.orgId, REQUEST))!.leftoverEmailPointers).toEqual(left.map((email) => orgEmailKey(email).pk));
  });

  it("makes the request id a receipt: the same request answers the same removal, a different body is CONFIG_INVALID", async () => {
    const w = await world();
    const input = { orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member" as const, id: "owner" }, callerRole: "owner" as const, requestId: REQUEST };
    const first = await w.store.removeMember(input);
    const again = await w.store.removeMember(input);
    expect(again).toMatchObject({ removalId: first.removalId, replay: true });
    expect(w.audit.recordedBy("member.removed")).toHaveLength(1);
    expect(w.db.find((item) => item.pk === memberRemovalQueueKey(first.removedAt, w.orgId, "sam").pk)).toHaveLength(1);
    await expect(w.store.removeMember({ ...input, successorId: "sam" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("answers NOT_FOUND for a person who is not a member", async () => {
    const w = await world();
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "nobody", emails: [], ban: false, requestId: OTHER_REQUEST })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("defaults the successor to the person who removes, and to the first other owner on a leave or a system removal", async () => {
    const w = await world();
    await w.store.addMember({ orgId: w.orgId, developerId: "ana", role: "admin" });
    const byAna = await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "ana" }, callerRole: "admin", requestId: REQUEST });
    expect(byAna.successorId).toBe("ana");
    const left = await w.store.removeMember({ orgId: w.orgId, developerId: "ana", emails: [], ban: false, by: { kind: "member", id: "ana" } });
    expect(left.successorId).toBe("owner");
  });

  it("takes the chosen successor, and refuses one who is not a member (SUCCESSOR_INVALID) without changing anything", async () => {
    const w = await world();
    await w.store.addMember({ orgId: w.orgId, developerId: "ana", role: "admin" });
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", successorId: "ghost" })).rejects.toMatchObject({ code: "SUCCESSOR_INVALID" });
    expect(w.db.get(orgMemberKey(w.orgId, "sam"))).toBeDefined();
    const chosen = await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", successorId: "ana" });
    expect(chosen.successorId).toBe("ana");
  });

  it("refuses with SUCCESSOR_INVALID when the successor is removed between the read and the transaction", async () => {
    const w = await world();
    await w.store.addMember({ orgId: w.orgId, developerId: "ana", role: "admin" });
    const realSend = w.db.send;
    w.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") w.db.delete(orgMemberKey(w.orgId, "ana"));
      return realSend(command);
    };
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", successorId: "ana" })).rejects.toMatchObject({ code: "SUCCESSOR_INVALID" });
    expect(w.db.get(orgMemberKey(w.orgId, "sam"))).toBeDefined();
  });

  it("refuses the last owner, and refuses when the only other owner is demoted in between (LAST_OWNER after one fresh try)", async () => {
    const w = await world();
    await w.store.addMember({ orgId: w.orgId, developerId: "co", role: "owner" });
    const realSend = w.db.send;
    w.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") w.db.set({ ...w.db.get(orgMemberKey(w.orgId, "co"))!, role: "member" });
      return realSend(command);
    };
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "owner", emails: [], ban: false })).rejects.toMatchObject({ code: "LAST_OWNER" });
    expect(w.db.get(orgMemberKey(w.orgId, "owner"))).toBeDefined();
  });

  it("lets only one of two owners who remove each other win; the other is refused FORBIDDEN and nothing of theirs is cut", async () => {
    const w = await world();
    await w.store.addMember({ orgId: w.orgId, developerId: "co", role: "owner" });
    const realSend = w.db.send;
    let raced = false;
    w.db.send = async (command) => {
      // co's removal of owner is read; before its transaction, owner's removal of co commits.
      if (!raced && command.constructor.name === "TransactWriteCommand") {
        raced = true;
        w.db.send = realSend;
        await w.store.removeMember({ orgId: w.orgId, developerId: "co", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", requestId: REQUEST });
        w.db.send = async (next) => (next.constructor.name === "TransactWriteCommand" ? realSend(next) : realSend(next));
      }
      return realSend(command);
    };
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "owner", emails: [], ban: false, by: { kind: "member", id: "co" }, callerRole: "owner", requestId: OTHER_REQUEST })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.db.get(orgMemberKey(w.orgId, "owner"))).toBeDefined();
    expect(w.db.get(orgMemberKey(w.orgId, "co"))).toBeUndefined();
  });

  it("is FORBIDDEN when the caller's role changed between the read and the transaction", async () => {
    const w = await world();
    await w.store.addMember({ orgId: w.orgId, developerId: "ana", role: "admin" });
    const realSend = w.db.send;
    w.db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand") w.db.set({ ...w.db.get(orgMemberKey(w.orgId, "ana"))!, role: "member" });
      return realSend(command);
    };
    await expect(w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "ana" }, callerRole: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.db.get(orgMemberKey(w.orgId, "sam"))).toBeDefined();
  });

  it("writes member.removed with the removal id and who took over, naming the successor", async () => {
    const w = await world();
    await w.store.addMember({ orgId: w.orgId, developerId: "ana", role: "admin" });
    await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", successorId: "ana", requestId: REQUEST });
    const [event] = w.audit.recordedBy("member.removed");
    expect(event).toMatchObject({ facts: { role: "member", removalId: REQUEST, successorKind: "chosen" }, related: ["ana"], actor: { kind: "member", id: "owner" } });
  });

  it("keeps the tombstone for ever and only moves its time forward on a second removal", async () => {
    const w = await world();
    await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", requestId: REQUEST });
    for (const name of Object.keys(w.db.get(orgRemovedKey(w.orgId, "sam"))!)) expect(name).not.toMatch(/expir|ttl/i);
    w.tick(86_400_000);
    await w.store.addMember({ orgId: w.orgId, developerId: "sam", role: "member" });
    w.tick(3_600_000);
    await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", requestId: OTHER_REQUEST });
    expect(w.db.get(orgRemovedKey(w.orgId, "sam"))).toMatchObject({ removedAt: "2026-10-31T11:00:00.000Z" });
  });

  it("with no movers wired, there is no marker, and the grants and limit still go (the access step runs in place)", async () => {
    const w = await world({ hook: false });
    w.db.set(grant(w.orgId, "sam", "payments"));
    const result = await w.store.removeMember({ orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member", id: "owner" }, callerRole: "owner", requestId: REQUEST });
    expect(w.db.find((item) => item.pk === memberRemovalQueueKey(result.removedAt, w.orgId, "sam").pk)).toEqual([]);
    expect(w.db.get(projectMemberKey(w.orgId, "sam", "payments"))).toBeUndefined();
    expect(w.db.get(memberRemovalRecordKey(w.orgId, REQUEST))).toMatchObject({ state: "DONE" });
  });
});

describe("an install with no movers", () => {
  it("fails the request when the cleanup stops, leaves the person cut off, and finishes the cleanup when the same request is repeated", async () => {
    const w = await world({ hook: false });
    w.db.set(grant(w.orgId, "sam", "payments"));
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("#grantId"), error: { name: "InternalServerError" } });
    const input = { orgId: w.orgId, developerId: "sam", emails: [], ban: false, by: { kind: "member" as const, id: "owner" }, callerRole: "owner" as const, requestId: REQUEST };
    await expect(w.store.removeMember(input)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.get(orgMemberKey(w.orgId, "sam"))).toBeUndefined();
    expect(w.db.get(projectMemberKey(w.orgId, "sam", "payments"))).toBeDefined();
    expect(w.db.get(memberRemovalRecordKey(w.orgId, REQUEST))).toMatchObject({ state: "STARTED" });
    await expect(w.store.removeMember(input)).resolves.toMatchObject({ removalId: REQUEST, state: "DONE", replay: true });
    expect(w.db.get(projectMemberKey(w.orgId, "sam", "payments"))).toBeUndefined();
    expect(w.db.get(memberRemovalRecordKey(w.orgId, REQUEST))).toMatchObject({ state: "DONE" });
  });
});

describe("FakeDynamoDb transaction limits", () => {
  // The fake checks the limits only on transactions that touch a partition built to stay inside them (learning-store.test.ts keeps the "elsewhere" case); the removal
  // transaction always carries its removal record.
  it("refuses a removal transaction of more than 100 actions", async () => {
    const db = new FakeDynamoDb();
    const record = { Put: { TableName: "state", Item: { ...memberRemovalRecordKey("org-1", "req-1"), entityType: "MEMBER_REMOVAL_RECORD" } } };
    const items = [record, ...Array.from({ length: 100 }, (_, index) => ({ Put: { TableName: "state", Item: { pk: `K#${String(index)}`, sk: "x" } } }))];
    await expect(db.send(new TransactWriteCommand({ TransactItems: items }))).rejects.toMatchObject({ name: "ValidationException" });
    expect(db.get(memberRemovalRecordKey("org-1", "req-1"))).toBeUndefined();
  });
});
