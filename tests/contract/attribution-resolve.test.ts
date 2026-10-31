// Enterprise foundations, task I3: the attribution is built from the broker's own records, read now. A person who has been erased or has left is never named.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuditEventInputSchema } from "@agentx/contracts";
import { auditPullRequestOpened } from "../../packages/broker/src/audit/events.js";
import { erasedPersonKey, orgMemberKey, orgRemovedKey, type OrgId } from "@agentx/contracts";
import { attributionBodyLines, attributionTrailers } from "../../packages/contracts/src/index.js";
import { attributionNameOf, dynamoAttributionReader, resolveActingAttribution, type AttributionReader } from "../../packages/broker/src/attribution/resolve.js";
import { dynamoAttributionLinkStore, type AttributionLink, type AttributionLinkStore } from "../../packages/broker/src/attribution/links.js";
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

/** Links in memory, with the order of the calls recorded. */
function memoryLinks(options: { failPut?: boolean } = {}): AttributionLinkStore & { rows: AttributionLink[] } {
  const rows: AttributionLink[] = [];
  return {
    rows,
    put: (_org, link) => { if (options.failPut === true) return Promise.reject(new Error("down")); rows.push(link); return Promise.resolve(); },
    resolve: (_org, ref) => Promise.resolve(rows.find((row) => row.ref === ref)),
    linksOf: (_org, id) => Promise.resolve(rows.filter((row) => row.developerId === id)),
    cutReferences: () => Promise.resolve(),
    deletePersonRows: (_org, links) => { for (const link of links) rows.splice(rows.indexOf(link), 1); return Promise.resolve(); },
  };
}
const TASK = "11111111-1111-4111-8111-111111111111";

describe("resolving who asked and who approved", () => {
  it("names a current member by display name and a short reference, and links the full ids for the audit event", async () => {
    const result = await resolveActingAttribution(reader({ [maya]: "Maya Chen", [priya]: "Priya Raman" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya, approverId: priya, auditUrl: "https://rovara.example/v1/app/audit/view" });
    expect(attributionTrailers(result.attribution)).toEqual([expect.stringMatching(/^Requested-by: rovara-ref [a-f0-9]{16}$/), expect.stringMatching(/^Approved-by: rovara-ref [a-f0-9]{16}$/)]);
    expect(attributionBodyLines(result.attribution)).toEqual(["Requested by: Maya Chen", "Plan approved by: Priya Raman", "Audit record: https://rovara.example/v1/app/audit/view"]);
    expect(result.relatedIds).toEqual([maya, priya]);
    // The text written to a host holds a random reference: not the id, not a cut of it, and not a hash of it.
    const text = JSON.stringify(result.attribution) + attributionTrailers(result.attribution).join("\n");
    for (const id of [maya, priya]) {
      expect(text).not.toContain(id);
      expect(text).not.toContain(id.slice(0, 16));
      expect(text).not.toContain(createHash("sha256").update(id).digest("hex").slice(0, 16));
    }
  });

  it("never names an erased person, reads the marker first, and does not even read their name", async () => {
    const r = reader({ [erased]: "Erin Erased", [priya]: "Priya Raman" }, { erased: [erased] });
    const result = await resolveActingAttribution(r, memoryLinks(), { orgId: org, taskId: TASK, requesterId: erased, approverId: priya });
    expect(result.attribution.requester).toEqual({ state: "former" });
    expect(attributionTrailers(result.attribution)[0]).toBe("Requested-by: a former member");
    expect(JSON.stringify(result.attribution)).not.toContain("Erin");
    expect(JSON.stringify(result.attribution)).not.toContain(erased.slice(0, 16));
    expect(r.reads).not.toContain(`name:${erased}`);
    expect(result.attribution.approver).toMatchObject({ state: "named", name: "Priya Raman" });
  });

  it("does not name someone who was never one of this org's people", async () => {
    const result = await resolveActingAttribution(reader({ [priya]: "Priya Raman" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: gone, approverId: priya });
    expect(result.attribution.requester).toEqual({ state: "former" });
  });

  it("does not name anyone when a record cannot be read: unreadable is not named", async () => {
    for (const fail of ["name", "erased"] as const) {
      const result = await resolveActingAttribution(reader({ [maya]: "Maya Chen" }, { fail }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya, approverId: maya });
      expect(result.attribution).toEqual({ requester: { state: "former" }, approver: { state: "former" } });
    }
  });

  it("leaves a line out when there is no person for it, or the id is not a person id", async () => {
    expect((await resolveActingAttribution(reader({}), memoryLinks(), { orgId: org, taskId: TASK })).attribution).toEqual({});
    expect((await resolveActingAttribution(reader({ [maya]: "Maya" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: "not-an-id", approverId: "../x" })).attribution).toEqual({});
    expect((await resolveActingAttribution(reader({ [maya]: "Maya" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: "not-an-id" })).relatedIds).toEqual([]);
  });

  it("keeps the names when the audit link is bad", async () => {
    const result = await resolveActingAttribution(reader({ [maya]: "Maya Chen" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya, auditUrl: "http://insecure.example/x" });
    expect(result.attribution).toMatchObject({ requester: { state: "named", name: "Maya Chen" } });
    expect(JSON.stringify(result.attribution)).not.toContain("auditUrl");
  });
});

describe("the reference on a commit leads to a person only through a row that erasure deletes", () => {
  it("is random: two attributions of the same people get different references, and nothing about the person decides it", async () => {
    const refs = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const r = await resolveActingAttribution(reader({ [maya]: "Maya Chen" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya });
      refs.add(r.attribution.requester?.state === "named" ? r.attribution.requester.ref : "");
    }
    expect(refs.size).toBe(20);
  });

  it("stores a row for each named person before it answers, and none for a former member", async () => {
    const links = memoryLinks();
    const result = await resolveActingAttribution(reader({ [maya]: "Maya Chen" }, { erased: [erased] }), links, { orgId: org, taskId: TASK, requesterId: maya, approverId: erased });
    expect(links.rows).toEqual([expect.objectContaining({ developerId: maya, role: "requester", taskId: TASK, ref: result.attribution.requester?.state === "named" ? result.attribution.requester.ref : "" })]);
    expect(links.rows).toHaveLength(1);
  });

  it("fails closed when the row cannot be stored: no reference is handed out that leads to nothing erasable", async () => {
    await expect(resolveActingAttribution(reader({ [maya]: "Maya Chen" }), memoryLinks({ failPut: true }), { orgId: org, taskId: TASK, requesterId: maya })).rejects.toThrow("down");
  });

  it("is unlinkable once erased: the references of a person resolve before, and to nothing after, and the tasks to rewrite are returned", async () => {
    const db = new FakeDynamoDb();
    const links = dynamoAttributionLinkStore({ documentClient: db, tableName: "state" });
    const refs: string[] = [];
    for (const taskId of [TASK, "22222222-2222-4222-8222-222222222222"]) {
      const r = await resolveActingAttribution(reader({ [maya]: "Maya Chen", [priya]: "Priya Raman" }), links, { orgId: org, taskId, requesterId: maya, approverId: priya });
      if (r.attribution.requester?.state === "named") refs.push(r.attribution.requester.ref);
    }
    expect(await Promise.all(refs.map((ref) => links.resolve(org, ref)))).toEqual([expect.objectContaining({ developerId: maya }), expect.objectContaining({ developerId: maya })]);
    const gone = await links.linksOf(org, maya);
    await links.cutReferences(org, gone);
    // After the cut the references lead nowhere, though the person's own rows (the list of descriptions to rewrite) are still there.
    expect(await Promise.all(refs.map((ref) => links.resolve(org, ref)))).toEqual([undefined, undefined]);
    expect(await links.linksOf(org, maya)).toHaveLength(2);
    await links.deletePersonRows(org, gone);
    expect(gone.map((link) => [link.role, link.taskId]).sort()).toEqual([["requester", TASK], ["requester", "22222222-2222-4222-8222-222222222222"]]);
    expect(await Promise.all(refs.map((ref) => links.resolve(org, ref)))).toEqual([undefined, undefined]);
    // Nothing of the person is left in the table, and the other person's rows are untouched.
    expect(JSON.stringify(db.find(() => true))).not.toContain(maya);
    expect(db.find(() => true).filter((item) => item.developerId === priya)).toHaveLength(4);
    // A second pass finds nothing.
    expect(await links.linksOf(org, maya)).toEqual([]);
  });

  it("writes the reference row and the person row in one transaction: a failure or a repeated reference leaves neither (re-check New-3)", async () => {
    const db = new FakeDynamoDb();
    const links = dynamoAttributionLinkStore({ documentClient: db, tableName: "state" });
    const link = { ref: "0123456789abcdef", developerId: maya, role: "requester" as const, taskId: TASK, createdAt: "2026-10-31T00:00:00.000Z" };
    db.injectFault({ command: "TransactWriteCommand", error: { name: "ServiceUnavailable" } });
    await expect(links.put(org, link)).rejects.toBeDefined();
    expect(db.find(() => true)).toEqual([]);
    const before = db.commandNames().length;
    await links.put(org, link);
    // One write command carries both rows: no state exists in which only one of them does.
    expect(db.commandNames().slice(before)).toEqual(["TransactWriteCommand"]);
    expect(db.find(() => true)).toHaveLength(2);
    // The same reference again is refused and adds nothing (not an orphan person row).
    await expect(links.put(org, { ...link, developerId: priya })).rejects.toBeDefined();
    expect(db.find(() => true)).toHaveLength(2);
    expect(await links.linksOf(org, priya)).toEqual([]);
  });

  it("refuses an invalid reference or person id", async () => {
    const links = dynamoAttributionLinkStore({ documentClient: new FakeDynamoDb(), tableName: "state" });
    await expect(links.put(org, { ref: "xyz", developerId: maya, role: "requester", taskId: TASK, createdAt: "t" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(links.linksOf(org, "not-an-id")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await links.resolve(org, "../x")).toBeUndefined();
  });
});

describe("the audit link", () => {
  it("links the change request to the people named, in the pull_request.opened event's related ids, and the event is a valid one", async () => {
    const { attribution, relatedIds } = await resolveActingAttribution(reader({ [maya]: "Maya Chen", [priya]: "Priya Raman" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya, approverId: priya });
    const event = auditPullRequestOpened({
      orgId: org, actor: { kind: "member", id: maya }, occurredAt: "2026-10-31T12:00:00.000Z", occurrence: "operation-1",
      pullRequestId: "pr_abc", number: 7, related: relatedIds,
    });
    expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
    expect(event.related).toEqual([maya, priya]);
    expect(attribution.requester).toMatchObject({ state: "named" });
    expect(attribution.approver).toMatchObject({ state: "named" });
  });

  it("still links an erased person's id (so the audit erasure can find it), though they are not named", async () => {
    const { attribution, relatedIds } = await resolveActingAttribution(reader({}, { erased: [erased] }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: erased });
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
    const result = await resolveActingAttribution(reader({ [maya]: "‮@@@\n" }), memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya });
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
    const result = await resolveActingAttribution(t.reader, memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya, approverId: erased });
    expect(result.attribution.requester).toMatchObject({ state: "named", name: "Maya Chen" });
    expect(result.attribution.approver).toEqual({ state: "former" });
  });

  it("a member who LEFT but was not erased keeps their real name; once erased they are 'a former member' (owner ruling 2026-10-31)", async () => {
    const t = tables();
    const departed = "f".repeat(64);
    // They left: the member record is gone and the removal's tombstone stands; their sign-in record (and so their name) is still there.
    t.db.set({ ...orgRemovedKey(org, departed), entityType: "ORG_REMOVED", orgId: org, developerId: departed, removedAt: "2026-10-20T00:00:00Z" });
    t.db.set({ pk: `DEVELOPER#${departed}`, sk: "META", developerId: departed, displayName: "Dana Departed" });
    const links = memoryLinks();
    const before = await resolveActingAttribution(t.reader, links, { orgId: org, taskId: TASK, requesterId: departed, approverId: maya });
    expect(before.attribution.requester).toMatchObject({ state: "named", name: "Dana Departed" });
    expect(attributionBodyLines(before.attribution)[0]).toBe("Requested by: Dana Departed");
    // The same person after an erasure: the permanent marker comes first.
    t.db.set({ ...erasedPersonKey(org, { developerId: departed }), entityType: "TEAM_RECORD_ERASED", at: "2026-10-30T00:00:00Z" });
    const after = await resolveActingAttribution(t.reader, memoryLinks(), { orgId: org, taskId: TASK, requesterId: departed, approverId: maya });
    expect(after.attribution.requester).toEqual({ state: "former" });
    expect(attributionBodyLines(after.attribution)[0]).toBe("Requested by: a former member");
    expect(JSON.stringify(after.attribution)).not.toContain("Dana");
  });

  it("does not name a person who is not in this org, whatever other org they are in", async () => {
    const t = tables();
    t.db.set({ ...orgMemberKey("org_bbbbbbbbbbbbbbbbbbbb", priya), orgId: "org_bbbbbbbbbbbbbbbbbbbb", developerId: priya, role: "member" });
    t.db.set({ pk: `DEVELOPER#${priya}`, sk: "META", developerId: priya, displayName: "Priya Raman" });
    expect((await resolveActingAttribution(t.reader, memoryLinks(), { orgId: org, taskId: TASK, requesterId: priya })).attribution.requester).toEqual({ state: "former" });
  });

  it("prefers the name the person chose", async () => {
    const t = tables();
    t.db.set({ ...chosenNameKey(maya), entityType: "DEVELOPER_NAME", developerId: maya, name: "May Chen", chosenAt: "2026-10-02T00:00:00Z" });
    const named = (await resolveActingAttribution(t.reader, memoryLinks(), { orgId: org, taskId: TASK, requesterId: maya })).attribution.requester;
    expect(named).toMatchObject({ state: "named", name: "May Chen" });
  });
});
