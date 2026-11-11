// Member removal (v1.1), task 5: the routes. A preview of what moves and what ends, the removal itself (a receipt per request id), the removal's status, and the legacy
// DELETE that keeps its answer and hands over to the person who removes.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { memberRemovalRecordKey, orgEmailKey, orgMemberKey, type OrgRole } from "@agentx/cloud-contracts";
import { memberGithubKey, projectMemberKey } from "@rovara-code/contracts";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { MAYA, OMAR, createSingleAnswerPlanBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;

async function org() {
  const endDeveloperSessions = vi.fn(async () => ({ ok: true as const }));
  const harness = await createSingleAnswerPlanBroker({ developerExtra: { endDeveloperSessions } });
  seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return { ...harness, endDeveloperSessions };
}

function person(harness: Harness, name: string, role: OrgRole): Developer {
  const developerId = createHash("sha256").update(name).digest("hex");
  const who: Developer = { developerId, name, provider: "oidc", sessionId: `s-${name}` };
  const email = `${name.toLowerCase()}@example.com`;
  harness.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
  harness.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", displayName: name, email, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  seedMembership(harness.db, developerId, { orgId: TEST_ORG, role });
  harness.db.set({ ...orgEmailKey(email), entityType: "ORG_EMAIL", developerId, orgId: TEST_ORG, createdAt: "x" });
  return who;
}
const isMember = (harness: Harness, who: Developer) => harness.db.get(orgMemberKey(TEST_ORG, who.developerId)) !== undefined;
const errorOf = (answer: { body: Record<string, unknown> }) => answer.body.error as { code: string; message: string } | undefined;

describe("GET /v1/app/org/members/{id}/removal-preview", () => {
  it("shows an owner who goes where, defaulting to the person asking, and what ends", async () => {
    const h = await org();
    const bea = person(h, "Bea", "member");
    h.db.set({ ...projectMemberKey(TEST_ORG, bea.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: bea.developerId, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: "g1" });
    const preview = await h.dev(OMAR, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      member: { developerId: bea.developerId, name: "Bea", role: "member" },
      successor: { developerId: OMAR.developerId, name: "Omar Diaz" },
      moves: { agents: 0, skills: 0, chains: 0, triggers: 0, approvals: 0, spendRequests: 0 },
      duties: { wasRole: "member", maintainerProjects: 1, projectGrants: 1 },
    });
    expect((preview.body.ends as string[]).join(" ")).toMatch(/running tasks stop after their current step/i);
  });

  it("names the person chosen to take over, and refuses one who is not in the company", async () => {
    const h = await org();
    const bea = person(h, "Bea", "member");
    const cal = person(h, "Cal", "admin");
    const chosen = await h.dev(OMAR, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview?successorId=${cal.developerId}`);
    expect(chosen.body).toMatchObject({ successor: { developerId: cal.developerId, name: "Cal" } });
    const stranger = await h.dev(OMAR, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview?successorId=${"f".repeat(64)}`);
    expect(stranger.status).toBe(409);
    expect(errorOf(stranger)?.code).toBe("SUCCESSOR_INVALID");
    const self = await h.dev(OMAR, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview?successorId=${bea.developerId}`);
    expect(errorOf(self)?.code).toBe("SUCCESSOR_INVALID");
  });

  it("follows the removal rules: an admin previews members only, a member nothing, nobody previews themselves, and nobody who is not a member", async () => {
    const h = await org();
    const adm = person(h, "Ana", "admin");
    const bea = person(h, "Bea", "member");
    expect((await h.dev(adm, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview`)).status).toBe(200);
    expect((await h.dev(adm, "GET", `/v1/app/org/members/${OMAR.developerId}/removal-preview`)).status).toBe(403);
    expect((await h.dev(MAYA, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview`)).status).toBe(403);
    expect((await h.dev(OMAR, "GET", `/v1/app/org/members/${OMAR.developerId}/removal-preview`)).status).toBe(403);
    expect((await h.dev(OMAR, "GET", `/v1/app/org/members/${"e".repeat(63)}9/removal-preview`)).status).toBe(404);
  });
});

describe("what the preview and the status say", () => {
  it("lists the GitHub unlink only when the person has a link, and counts the open invites they created", async () => {
    const h = await org();
    const bea = person(h, "Bea", "admin");
    const plain = await h.dev(OMAR, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview`);
    expect((plain.body.ends as string[]).join(" ")).not.toMatch(/GitHub/);
    h.db.set({ ...memberGithubKey(TEST_ORG, bea.developerId), entityType: "MEMBER_GITHUB", orgId: TEST_ORG, githubUserId: "4711", developerId: bea.developerId, linkedAt: "x" });
    await new OrgStore({ documentClient: h.db, tableName: "state", now: () => Date.now() }).createInvite({ orgId: TEST_ORG, createdBy: bea.developerId, role: "member", requestId: randomUUID() });
    const linked = await h.dev(OMAR, "GET", `/v1/app/org/members/${bea.developerId}/removal-preview`);
    expect((linked.body.ends as string[]).join(" ")).toMatch(/GitHub link is removed/);
    expect(linked.body).toMatchObject({ duties: { invitesCreated: 1 } });
    const body = { requestId: randomUUID(), expectedRole: "admin" };
    expect((await h.dev(OMAR, "POST", `/v1/app/org/members/${bea.developerId}/removal`, body)).status).toBe(200);
    const status = await h.dev(OMAR, "GET", `/v1/app/org/removals/${body.requestId}`);
    expect(status.body).toMatchObject({ duties: { wasRole: "admin", invitesCreated: 1 } });
  });

  it("treats a role it cannot read as owner for the admin rule, and asks an owner to review again", async () => {
    const h = await org();
    const adm = person(h, "Ana", "admin");
    const odd = person(h, "Odd", "member");
    h.db.set({ ...h.db.get(orgMemberKey(TEST_ORG, odd.developerId))!, role: "mystery" });
    expect((await h.dev(adm, "GET", `/v1/app/org/members/${odd.developerId}/removal-preview`)).status).toBe(403);
    expect((await h.dev(adm, "POST", `/v1/app/org/members/${odd.developerId}/removal`, { requestId: randomUUID(), expectedRole: "member" })).status).toBe(403);
    expect(errorOf(await h.dev(OMAR, "GET", `/v1/app/org/members/${odd.developerId}/removal-preview`))?.code).toBe("CHANGE_STALE");
  });
});

describe("POST /v1/app/org/members/{id}/removal and GET /v1/app/org/removals/{id}", () => {
  it("removes the person with the chosen successor, answers the same for the same request, and shows the removal's state and duties", async () => {
    const h = await org();
    const bea = person(h, "Bea", "member");
    const cal = person(h, "Cal", "admin");
    h.db.set({ ...projectMemberKey(TEST_ORG, bea.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: bea.developerId, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: "g1" });
    const body = { requestId: randomUUID(), expectedRole: "member", successorId: cal.developerId };
    const removed = await h.dev(OMAR, "POST", `/v1/app/org/members/${bea.developerId}/removal`, body);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removalId: body.requestId, state: expect.stringMatching(/^(STARTED|DONE)$/) as string });
    expect(String(removed.body.message)).toMatch(/running tasks will stop after their current step/i);
    expect(isMember(h, bea)).toBe(false);
    expect(h.db.get(memberRemovalRecordKey(TEST_ORG, body.requestId))).toMatchObject({ successorId: cal.developerId, by: OMAR.developerId });

    const again = await h.dev(OMAR, "POST", `/v1/app/org/members/${bea.developerId}/removal`, body);
    expect(again.status).toBe(200);
    expect(again.body.removalId).toBe(body.requestId);
    const reused = await h.dev(OMAR, "POST", `/v1/app/org/members/${bea.developerId}/removal`, { ...body, successorId: OMAR.developerId });
    expect(reused.status).toBe(400);
    expect(errorOf(reused)?.code).toBe("CONFIG_INVALID");

    const status = await h.dev(OMAR, "GET", `/v1/app/org/removals/${body.requestId}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ removalId: body.requestId, member: { developerId: bea.developerId, name: "Bea" }, successor: { developerId: cal.developerId, name: "Cal" }, duties: { wasRole: "member", maintainerProjects: 1 } });
    expect((await h.dev(MAYA, "GET", `/v1/app/org/removals/${body.requestId}`)).status).toBe(403);
    expect((await h.dev(OMAR, "GET", `/v1/app/org/removals/${randomUUID()}`)).status).toBe(404);
  });

  it("refuses a stale role, a successor who is not in the company, the last owner, an admin removing an owner, and a malformed body, changing nothing", async () => {
    const h = await org();
    const bea = person(h, "Bea", "member");
    const ana = person(h, "Ana", "admin");
    const post = (by: Developer, who: Developer, body: unknown) => h.dev(by, "POST", `/v1/app/org/members/${who.developerId}/removal`, body);
    expect(errorOf(await post(OMAR, bea, { requestId: randomUUID(), expectedRole: "admin" }))?.code).toBe("CHANGE_STALE");
    expect(errorOf(await post(OMAR, bea, { requestId: randomUUID(), expectedRole: "member", successorId: "f".repeat(64) }))?.code).toBe("SUCCESSOR_INVALID");
    expect((await post(ana, OMAR, { requestId: randomUUID(), expectedRole: "owner" })).status).toBe(403);
    expect((await post(MAYA, bea, { requestId: randomUUID(), expectedRole: "member" })).status).toBe(403);
    expect((await post(OMAR, bea, { expectedRole: "member" })).status).toBe(400);
    expect((await post(OMAR, bea, { requestId: "not-a-uuid", expectedRole: "member" })).status).toBe(400);
    expect(isMember(h, bea)).toBe(true);
    // The last owner cannot be removed, even by an owner.
    expect((await post(OMAR, OMAR, { requestId: randomUUID(), expectedRole: "owner" })).status).toBe(403);
  });
});

describe("DELETE /v1/app/org/members/{id} (the CLI's route)", () => {
  it("keeps its answer, and the person who removes takes over", async () => {
    const h = await org();
    const bea = person(h, "Bea", "member");
    const removed = await h.dev(OMAR, "DELETE", `/v1/app/org/members/${bea.developerId}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removed: { developerId: bea.developerId, name: "Bea" }, message: expect.stringContaining("running tasks will stop after their current step") as string });
    const [record] = h.db.find((item) => String(item.pk).endsWith("#MEMBER_REMOVAL"));
    expect(record).toMatchObject({ leaverId: bea.developerId, successorId: OMAR.developerId });
  });
});
