// ERASE-NAME-2: the member lists (the company's members, the removal preview and status) read the sign-in record's name, and the chosen name laid over it. A person erased before the name item had a tombstone
// (the audit ledger's tombstone only) or after (the name item's) must not show by name there, and a person removed from the company must not show by the name they chose.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { orgEmailKey, type OrgRole } from "@agentx/contracts";
import { FORMER_MEMBER_NAME, chosenNameKey } from "../../packages/broker/src/developer/chosen-name.js";
import { forgetResolvedNames } from "../../packages/broker/src/developer/name-resolver.js";
import { OMAR, createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
const REAL = "Bea Realname";
const CHOSEN = "Bea Chosen";

async function org() {
  const harness = await createSingleAnswerPlanBroker();
  seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return harness;
}
function person(harness: Harness, name: string, role: OrgRole): Developer {
  const developerId = createHash("sha256").update(name).digest("hex");
  const who: Developer = { developerId, name, provider: "oidc", sessionId: `s-${name}` };
  harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  harness.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", displayName: name, email: `${name.toLowerCase().replace(/\s+/gu, ".")}@example.com`, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(harness.db, developerId, { orgId: TEST_ORG, role });
  harness.db.set({ ...orgEmailKey(`${name.toLowerCase().replace(/\s+/gu, ".")}@example.com`), entityType: "ORG_EMAIL", developerId, orgId: TEST_ORG, createdAt: "x" });
  return who;
}
const nameIn = (body: Record<string, unknown>, who: Developer) => (body.members as Array<{ developerId: string; name: string }>).find((member) => member.developerId === who.developerId)?.name;

afterEach(() => { delete process.env["AUDIT_KEYS_TABLE_NAME"]; forgetResolvedNames(); });

describe("the company's member list", () => {
  it("shows the real name, then 'A former member' once the name item says erased", async () => {
    const h = await org();
    const bea = person(h, REAL, "member");
    expect(nameIn((await h.dev(OMAR, "GET", "/v1/app/org/members")).body, bea)).toBe(REAL);
    h.db.set({ ...chosenNameKey(bea.developerId), entityType: "DEVELOPER_NAME", developerId: bea.developerId, erased: true, erasedAt: "2026-11-01T00:00:00.000Z" });
    const after = await h.dev(OMAR, "GET", "/v1/app/org/members");
    expect(nameIn(after.body, bea)).toBe(FORMER_MEMBER_NAME);
    expect(JSON.stringify(after.body)).not.toContain(REAL);
    // A member who is not an owner or admin reads the same.
    const cal = person(h, "Cal Member", "member");
    expect(nameIn((await h.dev(cal, "GET", "/v1/app/org/members")).body, bea)).toBe(FORMER_MEMBER_NAME);
  });

  it("covers a person erased before the name item had a tombstone (the ledger's), whatever name they chose", async () => {
    const h = await org();
    const bea = person(h, REAL, "member");
    h.db.set({ ...chosenNameKey(bea.developerId), entityType: "DEVELOPER_NAME", developerId: bea.developerId, name: CHOSEN, chosenAt: "2026-10-01T00:00:00.000Z" });
    expect(nameIn((await h.dev(OMAR, "GET", "/v1/app/org/members")).body, bea)).toBe(CHOSEN);
    process.env["AUDIT_KEYS_TABLE_NAME"] = "keys";
    h.db.set({ pk: `ORG#${TEST_ORG}`, sk: `SUBJECT#${bea.developerId}`, erasedAt: "2026-09-01T00:00:00.000Z" });
    const after = await h.dev(OMAR, "GET", "/v1/app/org/members");
    expect(nameIn(after.body, bea)).toBe(FORMER_MEMBER_NAME);
    expect(JSON.stringify(after.body)).not.toContain(CHOSEN);
    expect(JSON.stringify(after.body)).not.toContain(REAL);
    // The name item is not written by a read (the chosen name stays for the erase's own hashing).
    expect(h.db.get(chosenNameKey(bea.developerId))).toMatchObject({ name: CHOSEN });
  });
});

describe("a member who was erased and came back (ERASED-REJOIN-NAME)", () => {
  it("shows the new name in the member list, and 'A former member' until they have chosen one", async () => {
    const h = await org();
    const bea = person(h, REAL, "member");
    h.db.set({ ...chosenNameKey(bea.developerId), entityType: "DEVELOPER_NAME", developerId: bea.developerId, erased: true, erasedAt: "2026-11-01T00:00:00.000Z" });
    expect(nameIn((await h.dev(OMAR, "GET", "/v1/app/org/members")).body, bea)).toBe(FORMER_MEMBER_NAME);
    h.db.set({ ...chosenNameKey(bea.developerId), entityType: "DEVELOPER_NAME", developerId: bea.developerId, erased: true, erasedAt: "2026-11-01T00:00:00.000Z", name: CHOSEN, chosenAt: "2026-11-02T00:00:00.000Z" });
    const after = await h.dev(OMAR, "GET", "/v1/app/org/members");
    expect(nameIn(after.body, bea)).toBe(CHOSEN);
    expect(JSON.stringify(after.body)).not.toContain(REAL);
  });
});

describe("the removal preview and status", () => {
  it("name an erased member and an erased successor 'A former member'", async () => {
    const h = await org();
    const bea = person(h, REAL, "member");
    const cal = person(h, "Cal Realname", "admin");
    process.env["AUDIT_KEYS_TABLE_NAME"] = "keys";
    h.db.set({ pk: `ORG#${TEST_ORG}`, sk: `SUBJECT#${bea.developerId}`, erasedAt: "2026-09-01T00:00:00.000Z" });
    h.db.set({ pk: `ORG#${TEST_ORG}`, sk: `SUBJECT#${cal.developerId}`, erasedAt: "2026-09-01T00:00:00.000Z" });
    const preview = await h.dev(OMAR, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview?successorId=${cal.developerId}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ member: { developerId: bea.developerId, name: FORMER_MEMBER_NAME }, successor: { developerId: cal.developerId, name: FORMER_MEMBER_NAME } });
    expect(JSON.stringify(preview.body)).not.toMatch(/Realname/u);
  });
});
