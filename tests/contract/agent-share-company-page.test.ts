// Owner decision 91 (and experience decision 24): only an org owner or admin confirms a company-wide agent share, and only on the confirmation
// page with a fresh sign-in. The agent's own author (a plain member) and a project's maintainer ask, they never decide; an admin who is the author
// still goes through the page: a token or a stale sign-in can't confirm it. Sharing with a project or a person is unchanged (applies at once).
import "../support/automations-on.js";
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { orgProjectCatalogKey, projectMemberKey, approvalKey } from "@rovara-code/contracts";
import type { OrgRole } from "@agentx/cloud-contracts";
import type { AgentId } from "@rovara-code/contracts";
import type { RecipeOverlay } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker, seedMembership, DEV_ISSUER, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web, a plain org member
const OWEN = person("7", "Owen"); // org owner
const CELL = new URL(DEV_ISSUER).origin;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const SAFE: RecipeOverlay = { instructions: "Summarise the open tickets.", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };
const COMPANY = { principal: { kind: "org" }, level: "use" } as const;

beforeAll(async () => { await loadSlackBroker(); });

async function world() {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { projectMembers: members }, decide: {} } });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const enroll = async (who: Developer, role: OrgRole) => {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: "oidc", displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  };
  await enroll(DANA, "admin");
  await enroll(OWEN, "owner");
  await enroll(MAX, "member");
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
  h.db.set({ pk: projectMemberKey(TEST_ORG, MAX.developerId, "web").pk, sk: projectMemberKey(TEST_ORG, MAX.developerId, "web").sk, entityType: "MEMBERSHIP", role: "developer", projectRole: "maintainer" });
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>) => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest };
  };
  const agentOf = async (who: Developer, extra: Record<string, unknown> = {}): Promise<AgentId> => {
    const created = await call(who, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay: SAFE, ...extra });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.agent as { agentId: AgentId }).agentId;
  };
  const approvals = () => h.db.find((item) => item.entityType === "APPROVAL") as unknown as Array<{ approvalId: string; status: string }>;
  const decideStore = new DecideStore({ documentClient: h.db, tableName: "signin", now: Date.now });
  /** A confirmation-page session for `who`, signed in `agoSeconds` ago. */
  const session = async (who: Developer, approvalId: string, agoSeconds: number) => {
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - agoSeconds;
    await decideStore.putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return cookie;
  };
  const raw = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => await h.handler({
    version: "2.0", rawPath: path, rawQueryString: "", headers, ...(body === undefined ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } },
  }) as { statusCode: number; headers: Record<string, string>; body: string };
  /** Opens the confirmation page as `who` and presses Approve there. */
  const approveOnPage = async (who: Developer, approvalId: string, agoSeconds = 30) => {
    const cookie = await session(who, approvalId, agoSeconds);
    return raw("POST", `/v1/app/approve/${approvalId}`, { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString());
  };
  const status = (approvalId: string) => (h.db.get(approvalKey(TEST_ORG, approvalId).pk, approvalKey(TEST_ORG, approvalId).sk) as { status: string }).status;
  return { ...h, store, call, agentOf, approvals, approveOnPage, status };
}

describe("confirming a company-wide agent share (decision 91)", () => {
  it("a non-admin author is refused on the page, and the share is not written", async () => {
    const w = await world();
    const agentId = await w.agentOf(MAYA);
    expect((await w.call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [approval] = w.approvals();
    const refused = await w.approveOnPage(MAYA, approval!.approvalId);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(w.status(approval!.approvalId)).toBe("PENDING");
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([]);
  });

  it("a project maintainer, even one who owns the project's agent, is refused on the page", async () => {
    const w = await world();
    const agentId = await w.agentOf(MAX, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect((await w.call(MAX, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [approval] = w.approvals();
    const refused = await w.approveOnPage(MAX, approval!.approvalId);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(w.status(approval!.approvalId)).toBe("PENDING");
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([]);
  });

  it("an admin who is the author confirms their own request only on the page with a fresh sign-in", async () => {
    const w = await world();
    const agentId = await w.agentOf(DANA);
    // Not at once: even an admin's own company-wide share waits for the page.
    const asked = await w.call(DANA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [COMPANY] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", confirmUrl: expect.stringContaining("approve") as string });
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([]);
    const [approval] = w.approvals();
    const id = approval!.approvalId;
    // Her own bearer token is sent to the page, not let through.
    const token = await w.call(DANA, "POST", `/v1/app/approvals/${id}/decide`, { decision: "APPROVE" });
    expect(token.status).toBe(401);
    expect(token.body.error).toMatchObject({ code: "REAUTH_REQUIRED" });
    // A sign-in from eleven minutes ago is too old.
    expect((await w.approveOnPage(DANA, id, 11 * 60)).statusCode).toBe(401);
    expect(w.status(id)).toBe("PENDING");
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([]);
    // A fresh sign-in on the page confirms it.
    const done = await w.approveOnPage(DANA, id);
    expect(done.statusCode, done.body).toBe(200);
    expect(w.status(id)).toBe("APPROVED_DONE");
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([expect.objectContaining({ principal: { kind: "org" }, level: "use", grantedBy: DANA.developerId })]);
  });

  it("an org owner confirms a member's request on the page", async () => {
    const w = await world();
    const agentId = await w.agentOf(MAYA);
    expect((await w.call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const done = await w.approveOnPage(OWEN, w.approvals()[0]!.approvalId);
    expect(done.statusCode, done.body).toBe(200);
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([expect.objectContaining({ principal: { kind: "org" }, grantedBy: OWEN.developerId })]);
  });

  it("sharing with a project or a person is unchanged: applied at once, nobody asked", async () => {
    const w = await world();
    const agentId = await w.agentOf(MAYA);
    const saved = await w.call(MAYA, "PUT", `/v1/app/agents/${agentId}/shares`, { shares: [{ principal: { kind: "project", project: "web" }, level: "use" }, { principal: { kind: "member", developerId: MAX.developerId }, level: "view" }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await w.store.listShares(TEST_ORG, agentId)).toHaveLength(2);
    expect(w.approvals()).toHaveLength(0);
  });
});

describe("decision 92: a company-shared agent's change and a company-wide chain share", () => {
  const WRITE: RecipeOverlay = { ...SAFE, tools: [{ connector: { type: "linear" }, access: "read_write" }] };
  const putDraft = async (w: Awaited<ReturnType<typeof world>>, who: Developer, agentId: AgentId, overlay: RecipeOverlay) => {
    const draft = await w.call(who, "GET", `/v1/app/agents/${agentId}/draft`);
    return w.call(who, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: (draft.body.draft as { revision: number }).revision, overlay });
  };
  const publish = async (w: Awaited<ReturnType<typeof world>>, who: Developer, agentId: AgentId) => {
    const draft = await w.call(who, "GET", `/v1/app/agents/${agentId}/draft`);
    return w.call(who, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: (draft.body.draft as { revision: number }).revision });
  };
  /** An agent of `who`'s with version 1 published and the company share an admin confirmed earlier stored. */
  const sharedAgentOf = async (w: Awaited<ReturnType<typeof world>>, who: Developer) => {
    const agentId = await w.agentOf(who);
    expect((await publish(w, who, agentId)).status).toBe(200);
    await w.store.replaceShares({ orgId: TEST_ORG, agentId, upsert: [{ principal: { kind: "org" }, level: "use" }], remove: [], expectedSharesRevision: 0, by: DANA.developerId });
    return agentId;
  };

  it("a non-admin author and a maintainer are refused on the page for a shared agent's less-safe publish", async () => {
    const w = await world();
    const agentId = await sharedAgentOf(w, MAYA);
    expect((await putDraft(w, MAYA, agentId, WRITE)).status).toBe(200);
    expect((await publish(w, MAYA, agentId)).status).toBe(202);
    const [approval] = w.approvals();
    const refused = await w.approveOnPage(MAYA, approval!.approvalId);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(w.status(approval!.approvalId)).toBe("PENDING");
    expect((await w.store.get(TEST_ORG, agentId))?.currentVersion).toBe(1);
    // A maintainer of web who owns a project's shared agent is refused the same way.
    const web = await w.agentOf(MAX, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect((await publish(w, MAX, web)).status).toBe(200);
    await w.store.replaceShares({ orgId: TEST_ORG, agentId: web, upsert: [{ principal: { kind: "org" }, level: "use" }], remove: [], expectedSharesRevision: 0, by: DANA.developerId });
    expect((await putDraft(w, MAX, web, WRITE)).status).toBe(200);
    expect((await publish(w, MAX, web)).status).toBe(202);
    const webApproval = w.approvals().find((record) => record.approvalId !== approval!.approvalId)!;
    expect((await w.approveOnPage(MAX, webApproval.approvalId)).statusCode).toBe(403);
    expect((await w.store.get(TEST_ORG, web))?.currentVersion).toBe(1);
  });

  it("an admin author applies their own less-safe change to a shared agent only on the page with a fresh sign-in", async () => {
    const w = await world();
    const agentId = await sharedAgentOf(w, DANA);
    expect((await putDraft(w, DANA, agentId, WRITE)).status).toBe(200);
    const asked = await publish(w, DANA, agentId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const id = w.approvals()[0]!.approvalId;
    const token = await w.call(DANA, "POST", `/v1/app/approvals/${id}/decide`, { decision: "APPROVE" });
    expect(token.status).toBe(401);
    expect(token.body.error).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect((await w.approveOnPage(DANA, id, 11 * 60)).statusCode).toBe(401);
    expect((await w.store.get(TEST_ORG, agentId))?.currentVersion).toBe(1);
    const done = await w.approveOnPage(DANA, id);
    expect(done.statusCode, done.body).toBe(200);
    expect(w.status(id)).toBe("APPROVED_DONE");
    expect((await w.store.get(TEST_ORG, agentId))?.currentVersion).toBe(2);
  });

  it("an unshared agent's author still confirms their own less-safe publish on the page, as before", async () => {
    const w = await world();
    const agentId = await w.agentOf(MAYA);
    expect((await publish(w, MAYA, agentId)).status).toBe(200);
    expect((await putDraft(w, MAYA, agentId, WRITE)).status).toBe(200);
    expect((await publish(w, MAYA, agentId)).status).toBe(202);
    expect((await w.approveOnPage(MAYA, w.approvals()[0]!.approvalId)).statusCode).toBe(200);
    expect((await w.store.get(TEST_ORG, agentId))?.currentVersion).toBe(2);
  });

  const chainOf = async (w: Awaited<ReturnType<typeof world>>, who: Developer, extra: Record<string, unknown> = {}) => {
    const created = await w.call(who, "POST", "/v1/app/chains", { name: `Chain ${randomUUID().slice(0, 8)}`, ...extra });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return (created.body.chain as { chainId: string }).chainId;
  };

  it("a non-admin chain author and a maintainer are refused on the page for a company-wide chain share", async () => {
    const w = await world();
    const mine = await chainOf(w, MAYA);
    expect((await w.call(MAYA, "PUT", `/v1/app/chains/${mine}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const web = await chainOf(w, MAX, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX.developerId } });
    expect((await w.call(MAX, "PUT", `/v1/app/chains/${web}/shares`, { shares: [COMPANY] })).status).toBe(202);
    const [mineApproval, webApproval] = w.approvals();
    expect((await w.approveOnPage(MAYA, mineApproval!.approvalId)).statusCode).toBe(403);
    expect((await w.approveOnPage(MAX, webApproval!.approvalId)).statusCode).toBe(403);
    expect(w.approvals().map((record) => record.status)).toEqual(["PENDING", "PENDING"]);
  });

  it("an admin chain author confirms their own company-wide share only on the page with a fresh sign-in", async () => {
    const w = await world();
    const chainId = await chainOf(w, DANA);
    const asked = await w.call(DANA, "PUT", `/v1/app/chains/${chainId}/shares`, { shares: [COMPANY] });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const id = w.approvals()[0]!.approvalId;
    const token = await w.call(DANA, "POST", `/v1/app/approvals/${id}/decide`, { decision: "APPROVE" });
    expect(token.status).toBe(401);
    expect(token.body.error).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect((await w.approveOnPage(DANA, id, 11 * 60)).statusCode).toBe(401);
    expect(w.status(id)).toBe("PENDING");
    const done = await w.approveOnPage(DANA, id);
    expect(done.statusCode, done.body).toBe(200);
    expect(w.status(id)).toBe("APPROVED_DONE");
  });
});
