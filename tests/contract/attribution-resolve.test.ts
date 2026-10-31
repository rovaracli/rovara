// Enterprise foundations, task I3: the attribution is built from the broker's own records, read now. A person who has been erased or has left is never named.
import { describe, expect, it } from "vitest";
import { AuditEventInputSchema } from "@agentx/contracts";
import { auditPullRequestOpened } from "../../packages/broker/src/audit/events.js";
import { erasedPersonKey, orgMemberKey, type OrgId } from "@agentx/contracts";
import { attributionBodyLines, attributionTrailers } from "../../packages/contracts/src/index.js";
import { attributionNameOf, dynamoAttributionReader, resolveActingAttribution, type AttributionReader } from "../../packages/broker/src/attribution/resolve.js";
import { chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const maya = "a".repeat(64), priya = "b".repeat(64), gone = "c".repeat(64), erased = "d".repeat(64);

function reader(names: Record<string, string>, options: { erased?: string[]; fail?: "name" | "erased" } = {}): AttributionReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    memberName: (_org, id) => { reads.push(`name:${id}`); if (options.fail === "name") return Promise.reject(new Error("down")); return Promise.resolve(names[id]); },
    isErased: (_org, id) => { reads.push(`erased:${id}`); if (options.fail === "erased") return Promise.reject(new Error("down")); return Promise.resolve(options.erased?.includes(id) === true); },
  };
}

describe("resolving who asked and who approved", () => {
  it("names a current member by display name and a short reference, and links the full ids for the audit event", async () => {
    const result = await resolveActingAttribution(reader({ [maya]: "Maya Chen", [priya]: "Priya Raman" }), { orgId: org, requesterId: maya, approverId: priya, auditUrl: "https://rovara.example/v1/app/audit/view" });
    expect(attributionTrailers(result.attribution)).toEqual([`Requested-by: Maya Chen (rovara-person ${maya.slice(0, 16)})`, `Approved-by: Priya Raman (rovara-person ${priya.slice(0, 16)})`]);
    expect(attributionBodyLines(result.attribution)).toEqual(["Requested by: Maya Chen", "Plan approved by: Priya Raman", "Audit record: https://rovara.example/v1/app/audit/view"]);
    expect(result.relatedIds).toEqual([maya, priya]);
    // The text written to a host holds the short reference, never the whole id.
    expect(JSON.stringify(result.attribution)).not.toContain(maya);
  });

  it("never names an erased person, reads the marker first, and does not even read their name", async () => {
    const r = reader({ [erased]: "Erin Erased", [priya]: "Priya Raman" }, { erased: [erased] });
    const result = await resolveActingAttribution(r, { orgId: org, requesterId: erased, approverId: priya });
    expect(result.attribution.requester).toEqual({ state: "former" });
    expect(attributionTrailers(result.attribution)[0]).toBe("Requested-by: a former member");
    expect(JSON.stringify(result.attribution)).not.toContain("Erin");
    expect(JSON.stringify(result.attribution)).not.toContain(erased.slice(0, 16));
    expect(r.reads).not.toContain(`name:${erased}`);
    expect(result.attribution.approver).toMatchObject({ state: "named", name: "Priya Raman" });
  });

  it("does not name someone who is no longer a member", async () => {
    const result = await resolveActingAttribution(reader({ [priya]: "Priya Raman" }), { orgId: org, requesterId: gone, approverId: priya });
    expect(result.attribution.requester).toEqual({ state: "former" });
  });

  it("does not name anyone when a record cannot be read: unreadable is not named", async () => {
    for (const fail of ["name", "erased"] as const) {
      const result = await resolveActingAttribution(reader({ [maya]: "Maya Chen" }, { fail }), { orgId: org, requesterId: maya, approverId: maya });
      expect(result.attribution).toEqual({ requester: { state: "former" }, approver: { state: "former" } });
    }
  });

  it("leaves a line out when there is no person for it, or the id is not a person id", async () => {
    expect((await resolveActingAttribution(reader({}), { orgId: org })).attribution).toEqual({});
    expect((await resolveActingAttribution(reader({ [maya]: "Maya" }), { orgId: org, requesterId: "not-an-id", approverId: "../x" })).attribution).toEqual({});
    expect((await resolveActingAttribution(reader({ [maya]: "Maya" }), { orgId: org, requesterId: "not-an-id" })).relatedIds).toEqual([]);
  });

  it("keeps the names when the audit link is bad", async () => {
    const result = await resolveActingAttribution(reader({ [maya]: "Maya Chen" }), { orgId: org, requesterId: maya, auditUrl: "http://insecure.example/x" });
    expect(result.attribution).toEqual({ requester: { state: "named", name: "Maya Chen", ref: maya.slice(0, 16) } });
  });
});

describe("the audit link", () => {
  it("links the change request to the people named, in the pull_request.opened event's related ids, and the event is a valid one", async () => {
    const { attribution, relatedIds } = await resolveActingAttribution(reader({ [maya]: "Maya Chen", [priya]: "Priya Raman" }), { orgId: org, requesterId: maya, approverId: priya });
    const event = auditPullRequestOpened({
      orgId: org, actor: { kind: "member", id: maya }, occurredAt: "2026-10-31T12:00:00.000Z", occurrence: "operation-1",
      pullRequestId: "pr_abc", number: 7, related: relatedIds,
    });
    expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
    expect(event.related).toEqual([maya, priya]);
    // The names in the commit and the description are the short forms of exactly the ids the audit event holds.
    expect(attribution.requester).toMatchObject({ ref: maya.slice(0, 16) });
    expect(attribution.approver).toMatchObject({ ref: priya.slice(0, 16) });
  });

  it("still links an erased person's id (so the audit erasure can find it), though they are not named", async () => {
    const { attribution, relatedIds } = await resolveActingAttribution(reader({}, { erased: [erased] }), { orgId: org, requesterId: erased });
    expect(attribution.requester).toEqual({ state: "former" });
    expect(relatedIds).toEqual([erased]);
  });
});

describe("the name that is written", () => {
  it("is the safe display name cut to plain characters: no email, markup, mention, link or newline", () => {
    expect(attributionNameOf("Maya Chen", maya)).toBe("Maya Chen");
    expect(attributionNameOf("maya@example.com", maya)).toMatch(/^Member [0-9a-f]{8}$/);
    for (const hostile of ["@octocat", "Maya\nApproved-by: Mallory", "[x](http://evil.example)", "<b>Maya</b>", "Maya `x` #1 | * _ \\ / : &", "‮aym", "   ", ""]) {
      const name = attributionNameOf(hostile, maya);
      expect(name, JSON.stringify(hostile)).toMatch(/^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N} .,'’-]{0,78}[\p{L}\p{M}\p{N}.])?$/u);
      expect(name).not.toContain("\n");
    }
    expect(attributionNameOf("Maya\nApproved-by: Mallory", maya)).toBe("Maya Approved-by Mallory");
    expect(Array.from(attributionNameOf("x".repeat(500), maya)).length).toBe(80);
  });

  it("always yields something the attribution accepts", async () => {
    const result = await resolveActingAttribution(reader({ [maya]: "‮@@@\n" }), { orgId: org, requesterId: maya });
    expect(result.attribution.requester).toMatchObject({ state: "named" });
    expect(attributionTrailers(result.attribution)).toHaveLength(1);
  });
});

describe("the reader over the install's tables", () => {
  function tables() {
    const db = new FakeDynamoDb();
    db.set({ ...orgMemberKey(org, maya), orgId: org, developerId: maya, role: "member", joinedAt: "2026-10-01T00:00:00Z" });
    db.set({ pk: `DEVELOPER#${maya}`, sk: "META", developerId: maya, displayName: "Maya Chen" });
    db.set({ ...orgMemberKey(org, erased), orgId: org, developerId: erased, role: "member", joinedAt: "2026-10-01T00:00:00Z" });
    db.set({ pk: `DEVELOPER#${erased}`, sk: "META", developerId: erased, displayName: "Erin Erased" });
    db.set({ ...erasedPersonKey(org, { developerId: erased }), entityType: "TEAM_RECORD_ERASED", at: "2026-10-30T00:00:00Z" });
    return { db, reader: dynamoAttributionReader({ documentClient: db, stateTable: "state", signInTable: "state", teamRecordTable: "state" }) };
  }

  it("reads a member's name, and the permanent erased marker, from the records", async () => {
    const t = tables();
    const result = await resolveActingAttribution(t.reader, { orgId: org, requesterId: maya, approverId: erased });
    expect(result.attribution.requester).toMatchObject({ state: "named", name: "Maya Chen" });
    expect(result.attribution.approver).toEqual({ state: "former" });
  });

  it("does not name a person who is not in this org, whatever other org they are in", async () => {
    const t = tables();
    t.db.set({ ...orgMemberKey("org_bbbbbbbbbbbbbbbbbbbb", priya), orgId: "org_bbbbbbbbbbbbbbbbbbbb", developerId: priya, role: "member" });
    t.db.set({ pk: `DEVELOPER#${priya}`, sk: "META", developerId: priya, displayName: "Priya Raman" });
    expect((await resolveActingAttribution(t.reader, { orgId: org, requesterId: priya })).attribution.requester).toEqual({ state: "former" });
  });

  it("prefers the name the person chose", async () => {
    const t = tables();
    t.db.set({ ...chosenNameKey(maya), entityType: "DEVELOPER_NAME", developerId: maya, name: "May Chen", chosenAt: "2026-10-02T00:00:00Z" });
    const named = (await resolveActingAttribution(t.reader, { orgId: org, requesterId: maya })).attribution.requester;
    expect(named).toMatchObject({ state: "named", name: "May Chen" });
  });
});
