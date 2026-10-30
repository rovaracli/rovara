// Member removal (v1.1), task 1: the pure shape of the one transaction (S0). The plan never names one key twice, merges the
// membership checks of one person into one action, deletes the GitHub link only when it was read (and checks it is still absent when not),
// caps the email pointers, keeps the tombstone free of any expiry attribute and maps a refused action back to the reason it stands for.
import { describe, expect, it } from "vitest";
import { orgMemberKey, orgRemovedKey, type OrgId } from "@agentx/contracts";
import { MEMBER_REMOVAL_EMAIL_CAP } from "../../packages/contracts/src/member-removal.js";
import { planMemberRemoval, removalRefusal, type RemovalPlanInput } from "../../packages/broker/src/org/member-removal/plan.js";

const ORG = `org_${"a".repeat(20)}` as OrgId;
const NOW = "2026-10-30T10:00:00.000Z";
const pointer = (index: number) => `ORG_EMAIL#person${String(index)}@example.com`;

const base = (overrides: Partial<RemovalPlanInput> = {}): RemovalPlanInput => ({
  tableName: "state",
  orgId: ORG,
  removalId: "11111111-1111-4111-8111-111111111111",
  removedAt: NOW,
  leaver: { developerId: "leaver", role: "member" },
  caller: { developerId: "owner", role: "owner" },
  successor: { developerId: "owner" },
  emailPointers: [],
  ban: false,
  record: { state: "STARTED" },
  marker: { entityType: "MEMBER_REMOVAL", orgId: ORG, developerId: "leaver" },
  company: [{ Update: { TableName: "state", Key: { pk: "ORG#meta", sk: "META" }, UpdateExpression: "SET approvalMembershipVersion = :one", ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":one": 1 } } }],
  audit: [{ Put: { TableName: "state", Item: { pk: "AUDIT_PENDING#1", sk: "x", event: {} } } }],
  ...overrides,
});

const keyOf = (item: NonNullable<ReturnType<typeof planMemberRemoval>["items"][number]>): string => {
  const action = (item.Put ?? item.Delete ?? item.Update ?? item.ConditionCheck) as { Key?: { pk: string; sk: string }; Item?: { pk: string; sk: string } };
  const key = action.Key ?? action.Item!;
  return `${key.pk}|${key.sk}`;
};

describe("planMemberRemoval", () => {
  it("never names one key twice, whoever is the caller, the successor and the other owner", () => {
    const people = ["owner", "other", "leaver"];
    for (const caller of [...people, undefined]) for (const successor of [...people.filter((p) => p !== "leaver"), undefined]) for (const otherOwner of [...people.filter((p) => p !== "leaver"), undefined]) {
      const plan = planMemberRemoval(base({
        leaver: { developerId: "leaver", role: otherOwner === undefined ? "member" : "owner" },
        ...(caller === undefined ? { caller: undefined } : { caller: { developerId: caller, role: "owner" as const } }),
        ...(successor === undefined ? { successor: undefined } : { successor: { developerId: successor } }),
        ...(otherOwner === undefined ? {} : { otherOwner: { developerId: otherOwner } }),
        emailPointers: [pointer(1), pointer(2)],
      }));
      const keys = plan.items.map(keyOf);
      expect(new Set(keys).size, `caller ${String(caller)} successor ${String(successor)} other ${String(otherOwner)}`).toBe(keys.length);
    }
  });

  it("checks the caller, the successor and the other owner in one action when they are one person", () => {
    const plan = planMemberRemoval(base({ leaver: { developerId: "leaver", role: "owner" }, otherOwner: { developerId: "owner" } }));
    const checks = plan.items.filter((item) => item.ConditionCheck !== undefined);
    expect(checks).toHaveLength(1);
    const condition = checks[0]!.ConditionCheck!;
    expect(condition.Key).toEqual(orgMemberKey(ORG, "owner"));
    // All three questions are asked of the one item.
    expect(condition.ConditionExpression).toMatch(/#role = :callerRole/);
    expect(condition.ConditionExpression).toMatch(/#role = :otherOwnerRole/);
    expect(condition.ConditionExpression).toMatch(/developerId = :successorId/);
  });

  it("does not check the caller on a leave, where the caller is the leaver (the member delete already checks the role)", () => {
    const plan = planMemberRemoval(base({ caller: { developerId: "leaver", role: "member" }, successor: { developerId: "owner" } }));
    const keys = plan.items.map(keyOf);
    expect(keys.filter((key) => key === `${orgMemberKey(ORG, "leaver").pk}|${orgMemberKey(ORG, "leaver").sk}`)).toHaveLength(1);
    expect(plan.layout.callerCheck).toBeUndefined();
  });

  it("deletes the member and the pointer, only while the member still has the role that was seen", () => {
    const plan = planMemberRemoval(base({ leaver: { developerId: "leaver", role: "admin" } }));
    const member = plan.items[plan.layout.member]!.Delete!;
    expect(member.Key).toEqual(orgMemberKey(ORG, "leaver"));
    expect(member.ConditionExpression).toBe("attribute_exists(pk) AND #role = :seenRole");
    expect(member.ExpressionAttributeValues).toEqual({ ":seenRole": "admin" });
  });

  it("puts the tombstone with no expiry attribute, and only while it is not newer than this removal", () => {
    const plan = planMemberRemoval(base());
    const put = plan.items[plan.layout.tombstone]!.Put!;
    expect(put.Item).toMatchObject({ ...orgRemovedKey(ORG, "leaver"), entityType: "ORG_REMOVED", removedAt: NOW });
    // Nothing on the tombstone can make DynamoDB's time-to-live delete it: the old tasks of a person who rejoined outlive any bound we could prove.
    for (const name of Object.keys(put.Item!)) expect(name).not.toMatch(/expir|ttl/i);
    expect(put.ConditionExpression).toBe("attribute_not_exists(pk) OR removedAt < :removedAt");
    expect(put.ExpressionAttributeValues).toEqual({ ":removedAt": NOW });
  });

  it("puts the ban only when it is asked for", () => {
    expect(planMemberRemoval(base({ ban: false })).layout.ban).toBeUndefined();
    const plan = planMemberRemoval(base({ ban: true }));
    expect(plan.items[plan.layout.ban!]!.Put!.Item).toMatchObject({ entityType: "ORG_BAN", developerId: "leaver" });
  });

  it("writes the removal record once (it is the receipt) and the marker only when there is one", () => {
    const withMarker = planMemberRemoval(base());
    expect(withMarker.items[withMarker.layout.record]!.Put!.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(withMarker.layout.marker).toBeDefined();
    const without = planMemberRemoval(base({ marker: undefined }));
    expect(without.layout.marker).toBeUndefined();
  });

  it("deletes the GitHub link, both ways, only when the read found it", () => {
    const linked = planMemberRemoval(base({ github: { githubUserId: "4711" } }));
    expect(linked.layout.github).toHaveLength(2);
    const deletes = linked.layout.github.map((index) => linked.items[index]!.Delete!);
    expect(deletes.map((d) => d.Key.pk)).toEqual([expect.stringContaining("MEMBER_GITHUB#leaver"), expect.stringContaining("GITHUB_MEMBER#4711")]);
    for (const del of deletes) expect(del.ConditionExpression).toContain("developerId = :leaver");
  });

  it("with no GitHub link it still plans, and checks that none appeared since the read", () => {
    const plan = planMemberRemoval(base());
    expect(plan.layout.github).toEqual([]);
    expect(plan.layout.githubAbsent).toBeDefined();
    const check = plan.items[plan.layout.githubAbsent!]!.ConditionCheck!;
    expect(check.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(removalRefusal(plan, new Set([plan.layout.githubAbsent!]))).toBe("CHANGE_STALE");
  });

  it("caps the email pointers in the transaction and hands the rest back for the access step", () => {
    const pointers = Array.from({ length: MEMBER_REMOVAL_EMAIL_CAP + 3 }, (_, index) => pointer(index));
    const plan = planMemberRemoval(base({ emailPointers: pointers }));
    expect(plan.layout.emails).toHaveLength(MEMBER_REMOVAL_EMAIL_CAP);
    expect(plan.leftoverEmailPointers).toEqual(pointers.slice(MEMBER_REMOVAL_EMAIL_CAP));
    for (const index of plan.layout.emails) expect(plan.items[index]!.Delete!.ConditionExpression).toBe("developerId = :leaver");
  });

  it("stays far under DynamoDB's 100 actions even with every optional part present", () => {
    const pointers = Array.from({ length: 50 }, (_, index) => pointer(index));
    const plan = planMemberRemoval(base({ leaver: { developerId: "leaver", role: "owner" }, otherOwner: { developerId: "other" }, successor: { developerId: "third" }, ban: true, github: { githubUserId: "4711" }, emailPointers: pointers }));
    expect(plan.items.length).toBeLessThanOrEqual(30);
  });

  it("maps a refused action back to its reason, the caller's own check first", () => {
    const plan = planMemberRemoval(base({ leaver: { developerId: "leaver", role: "owner" }, otherOwner: { developerId: "other" }, successor: { developerId: "third" } }));
    expect(removalRefusal(plan, new Set([plan.layout.member]))).toBe("CHANGE_STALE");
    expect(removalRefusal(plan, new Set([plan.layout.pointer]))).toBe("CHANGE_STALE");
    expect(removalRefusal(plan, new Set([plan.layout.tombstone]))).toBe("MEMBER_ALREADY_REMOVED");
    expect(removalRefusal(plan, new Set([plan.layout.record]))).toBe("REPLAY");
    expect(removalRefusal(plan, new Set([plan.layout.successorCheck!]))).toBe("SUCCESSOR_INVALID");
    expect(removalRefusal(plan, new Set([plan.layout.callerCheck!]))).toBe("FORBIDDEN");
    expect(removalRefusal(plan, new Set([plan.layout.ownerCheck!]))).toBe("LAST_OWNER");
    expect(removalRefusal(plan, new Set([plan.layout.company[0]!]))).toBe("CHANGE_STALE");
    expect(removalRefusal(plan, new Set())).toBeUndefined();
  });

  it("answers FORBIDDEN, not SUCCESSOR_INVALID, when one merged check fails for the caller who is also the successor", () => {
    const plan = planMemberRemoval(base());
    expect(plan.layout.callerCheck).toBe(plan.layout.successorCheck);
    expect(removalRefusal(plan, new Set([plan.layout.callerCheck!]))).toBe("FORBIDDEN");
  });
});
