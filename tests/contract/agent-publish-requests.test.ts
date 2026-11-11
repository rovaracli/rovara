// Agent publish requests (experience decision 24, owner decisions 91 and 92) and the Home row's favourite and suggested agents (experience decision 23). Each guard has a
// test that fails without it: who may ask; who may decide a project request (that project's maintainer or an org owner or admin, never the person who asked) and a company
// request (an org owner or admin only, an admin's own only on the page with a fresh sign-in); the binding to the version and digest; the guardrails at approve time; company
// scoping; the browser-only decide; withdraw by the requester only; one waiting request per agent and target; the repeat rules; favourites kept while hidden.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { decideApproval, type ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { approvalKey, orgProjectCatalogKey, projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org.js";
import type { AgentId } from "../../packages/contracts/src/agent-node.js";
import type { RecipeOverlay } from "../../packages/contracts/src/agent-recipe-node.js";
import { AgentPublishRequestSchema, MyAgentsSchema } from "../../packages/contracts/src/app-agent-publish.js";
import { MAYA, createDeveloperTaskBroker, seedMembership, DEV_ISSUER, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web, a plain org member
const QUINN = person("3", "Quinn"); // maintainer of api only
const PAT = person("4", "Pat"); // a plain member with no role on web
const OWEN = person("7", "Owen"); // org owner
const CELL = new URL(DEV_ISSUER).origin;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OVERLAY: RecipeOverlay = { instructions: "Summarise the open tickets.", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }], autonomy: "prepare" };
const WEB = { kind: "project", project: "web" } as const;
const COMPANY = { kind: "company" } as const;

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
    members.setOrgRole(TEST_ORG, who.developerId, role);
  };
  await enroll(DANA, "admin");
  await enroll(OWEN, "owner");
  await enroll(MAX, "member");
  await enroll(QUINN, "member");
  await enroll(PAT, "member");
  members.setOrgRole(TEST_ORG, MAYA.developerId, "member");
  const maintain = (who: Developer, project: string) => {
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, project), entityType: "PROJECT_CATALOG", name: project });
    members.grant(TEST_ORG, project, who.developerId, "maintainer");
    const key = projectMemberKey(TEST_ORG, who.developerId, project);
    h.db.set({ pk: key.pk, sk: key.sk, entityType: "MEMBERSHIP", role: "developer", projectRole: "maintainer" });
  };
  maintain(MAX, "web");
  maintain(QUINN, "api");
  members.grant(TEST_ORG, "web", MAYA.developerId, "contributor");
  const call = async (who: Developer, method: string, path: string, body?: Record<string, unknown>) => {
    const reply = await h.dev(who, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
    const { requestId: _requestId, ...rest } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: reply.status, body: rest as Record<string, unknown> };
  };
  /** A new agent of `who`, with version 1 published. */
  const publishedAgent = async (who: Developer, overlay: RecipeOverlay = OVERLAY): Promise<AgentId> => {
    const created = await call(who, "POST", "/v1/app/agents", { name: `Agent ${randomUUID().slice(0, 8)}`, overlay });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const agent = created.body.agent as { agentId: AgentId; draftRevision: number };
    const published = await call(who, "POST", `/v1/app/agents/${agent.agentId}/publish`, { expectedRevision: agent.draftRevision });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    return agent.agentId;
  };
  const ask = (who: Developer, agentId: string, target: unknown, extra: Record<string, unknown> = {}) => call(who, "POST", `/v1/app/agents/${agentId}/publish-requests`, { target, version: 1, ...extra });
  const decideStore = new DecideStore({ documentClient: h.db, tableName: "signin", now: Date.now });
  const session = async (who: Developer, approvalId: string, agoSeconds: number) => {
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - agoSeconds;
    await decideStore.putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return cookie;
  };
  const raw = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => await h.handler({
    version: "2.0", rawPath: path, rawQueryString: "", headers, ...(body === undefined ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } },
  }) as { statusCode: number; headers: Record<string, string>; body: string };
  /** The confirmation page, as `who`, pressing `decision`. */
  const onPage = async (who: Developer, approvalId: string, decision: "approve" | "decline" = "approve", agoSeconds = 30) => {
    const cookie = await session(who, approvalId, agoSeconds);
    return raw("POST", `/v1/app/approve/${approvalId}`, { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ decision, csrf: csrfTokenFor(cookie) }).toString());
  };
  const record = (approvalId: string) => h.db.get(approvalKey(TEST_ORG, approvalId).pk, approvalKey(TEST_ORG, approvalId).sk) as { status: string; failure?: string; declineReason?: string; withdrawnBy?: string };
  const requestOf = (reply: { body: Record<string, unknown> }) => AgentPublishRequestSchema.parse(reply.body.request);
  return { ...h, store, members, call, publishedAgent, ask, onPage, record, requestOf };
}

describe("asking to publish an agent", () => {
  it("only a person who manages the agent may ask: a person who can't see it gets 404, one who can only use it 403, and a built-in is refused", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    expect((await w.ask(PAT, agentId, WEB)).status).toBe(404);
    await w.store.replaceShares({ orgId: TEST_ORG, agentId, upsert: [{ principal: { kind: "member", developerId: PAT.developerId }, level: "use" }], remove: [], expectedSharesRevision: 0, by: "seed" });
    const used = await w.ask(PAT, agentId, WEB);
    expect(used.status, JSON.stringify(used.body)).toBe(403);
    expect((await w.ask(DANA, "root-cause-analyst", COMPANY)).status).toBe(400);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);
  });

  it("refuses a version that is not the current one, an agent with none, and a project the caller can't see", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    expect((await w.ask(MAYA, agentId, WEB, { version: 2 })).body.error).toMatchObject({ code: "CHANGE_STALE" });
    const draftOnly = await w.call(MAYA, "POST", "/v1/app/agents", { name: "Draft only", overlay: OVERLAY });
    const draftId = (draftOnly.body.agent as { agentId: string }).agentId;
    expect((await w.ask(MAYA, draftId, WEB)).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await w.ask(MAYA, agentId, { kind: "project", project: "api" })).body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
  });

  it("a maintainer asking for their own project gets it at once, by the owner move; an admin moving a member's agent leaves the author edit access", async () => {
    const w = await world();
    const mine = await w.publishedAgent(MAX);
    const applied = await w.ask(MAX, mine, WEB);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ status: "published", request: null, agent: { agentId: mine, publication: { level: "project", projects: ["web"], pending: null } } });
    expect(await w.store.get(TEST_ORG, mine)).toMatchObject({ owner: WEB, accountable: { developerId: MAX.developerId } });
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(0);

    const mayas = await w.publishedAgent(MAYA);
    expect((await w.ask(DANA, mayas, WEB)).status).toBe(200);
    expect(await w.store.get(TEST_ORG, mayas)).toMatchObject({ owner: WEB, accountable: { developerId: DANA.developerId } });
    expect(await w.store.listShares(TEST_ORG, mayas)).toEqual([expect.objectContaining({ principal: { kind: "member", developerId: MAYA.developerId }, level: "edit" })]);
  });

  it("a repeat with the same request id and body answers the same request; another body is 409; a second request for the same target waits for nothing", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const requestId = randomUUID();
    const first = await w.ask(MAYA, agentId, WEB, { requestId, note: "Used it on 6 releases." });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const again = await w.ask(MAYA, agentId, WEB, { requestId, note: "Used it on 6 releases." });
    expect(again.status).toBe(202);
    expect(w.requestOf(again).approvalId).toBe(w.requestOf(first).approvalId);
    expect((await w.ask(MAYA, agentId, WEB, { requestId, note: "Something else." })).body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await w.ask(MAYA, agentId, WEB)).body.error).toMatchObject({ code: "CHANGE_STALE" });
    // Another target is its own request.
    expect((await w.ask(MAYA, agentId, COMPANY)).status).toBe(202);
    expect(w.db.find((item) => item.entityType === "APPROVAL")).toHaveLength(2);
  });
});

describe("deciding a project request (decision 91: approval moves the agent to the project)", () => {
  it("only that project's maintainer or an org owner or admin decides, never the person who asked; approving moves ownership with the approver accountable", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const asked = await w.ask(MAYA, agentId, WEB, { note: "Used it on 6 releases." });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const request = w.requestOf(asked);
    expect(request).toMatchObject({ state: "pending", target: WEB, version: 1, note: "Used it on 6 releases.", requestedBy: { id: MAYA.developerId, name: "Maya Chen" }, approval: { canDecide: false, reason: "you_requested", confirmUrl: null } });
    expect(request.effect).toContain("to the web project");
    for (const who of [MAYA, QUINN, PAT]) {
      const refused = await w.onPage(who, request.approvalId);
      expect(refused.statusCode, `${who.name}: ${refused.body}`).toBe(403);
    }
    expect(w.record(request.approvalId).status).toBe("PENDING");
    expect(await w.store.get(TEST_ORG, agentId)).toMatchObject({ owner: { kind: "member", developerId: MAYA.developerId } });
    const done = await w.onPage(MAX, request.approvalId);
    expect(done.statusCode, done.body).toBe(200);
    expect(w.record(request.approvalId).status).toBe("APPROVED_DONE");
    expect(await w.store.get(TEST_ORG, agentId)).toMatchObject({ owner: WEB, accountable: { developerId: MAX.developerId } });
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([expect.objectContaining({ principal: { kind: "member", developerId: MAYA.developerId }, level: "edit" })]);
    const mine = await w.call(MAYA, "GET", `/v1/app/agent-publish-requests?state=all&mine=1`);
    expect(mine.body.requests).toEqual([expect.objectContaining({ approvalId: request.approvalId, state: "approved", decidedBy: { id: MAX.developerId, name: "Max" } })]);
  });

  it("the person who asked never decides their own project request, even after they become the project's maintainer", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const request = w.requestOf(await w.ask(MAYA, agentId, WEB));
    w.members.grant(TEST_ORG, "web", MAYA.developerId, "maintainer");
    expect((await w.onPage(MAYA, request.approvalId)).statusCode).toBe(403);
    expect(w.record(request.approvalId).status).toBe("PENDING");
  });

  it("an org owner may decide a project request too", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const request = w.requestOf(await w.ask(MAYA, agentId, WEB));
    expect((await w.onPage(OWEN, request.approvalId)).statusCode).toBe(200);
    expect(await w.store.get(TEST_ORG, agentId)).toMatchObject({ owner: WEB, accountable: { developerId: OWEN.developerId } });
  });

  it("a request is bound to the version asked about: one published since makes it fail, and nothing moves", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const request = w.requestOf(await w.ask(MAYA, agentId, WEB));
    const draft = await w.call(MAYA, "GET", `/v1/app/agents/${agentId}/draft`);
    const saved = await w.call(MAYA, "PUT", `/v1/app/agents/${agentId}/draft`, { expectedRevision: (draft.body.draft as { revision: number }).revision, overlay: { ...OVERLAY, instructions: "Summarise the closed tickets." } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await w.call(MAYA, "POST", `/v1/app/agents/${agentId}/publish`, { expectedRevision: (saved.body.draft as { revision: number }).revision })).status).toBe(200);
    const listed = await w.call(MAX, "GET", "/v1/app/agent-publish-requests");
    expect(listed.body.requests).toEqual([expect.objectContaining({ approvalId: request.approvalId, state: "stale", approval: expect.objectContaining({ canDecide: false, reason: "stale" }) as unknown })]);
    await w.onPage(MAX, request.approvalId);
    expect(w.record(request.approvalId)).toMatchObject({ status: "APPROVED_FAILED" });
    expect(await w.store.get(TEST_ORG, agentId)).toMatchObject({ owner: { kind: "member", developerId: MAYA.developerId } });
  });

  it("the guardrails are checked again when it is approved: tightened since, nothing is applied", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const request = w.requestOf(await w.ask(MAYA, agentId, COMPANY));
    const current = await w.call(DANA, "GET", "/v1/app/org/agent-guardrails");
    const tightened = await w.call(DANA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: current.body.revision, guardrails: { ...(current.body.guardrails as Record<string, unknown>), maxAutonomy: "suggest" } });
    expect(tightened.status, JSON.stringify(tightened.body)).toBe(200);
    await w.onPage(DANA, request.approvalId);
    expect(w.record(request.approvalId)).toMatchObject({ status: "APPROVED_FAILED" });
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([]);
  });
});

describe("deciding a company request (decision 91: owners and admins only)", () => {
  it("a maintainer can't decide it; an admin can; the share is written at use", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const request = w.requestOf(await w.ask(MAYA, agentId, COMPANY));
    expect(request.approval).toMatchObject({ canDecide: false, reason: "not_an_admin" });
    for (const who of [MAYA, MAX]) expect((await w.onPage(who, request.approvalId)).statusCode, who.name).toBe(403);
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([]);
    expect((await w.onPage(DANA, request.approvalId)).statusCode).toBe(200);
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([expect.objectContaining({ principal: { kind: "org" }, level: "use", grantedBy: DANA.developerId })]);
  });

  it("an admin's own company request is not applied at once: a token is sent to the page, a stale sign-in is refused, a fresh one approves", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(DANA);
    const asked = await w.ask(DANA, agentId, COMPANY);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const request = w.requestOf(asked);
    expect(request.approval).toMatchObject({ canDecide: true, reason: null, freshSignInNeeded: true, confirmUrl: expect.stringContaining(request.approvalId) as string });
    const token = await w.call(DANA, "POST", `/v1/app/approvals/${request.approvalId}/decide`, { decision: "APPROVE" });
    expect(token.status).toBe(401);
    expect(token.body.error).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect((await w.onPage(DANA, request.approvalId, "approve", 11 * 60)).statusCode).toBe(401);
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([]);
    expect((await w.onPage(DANA, request.approvalId)).statusCode).toBe(200);
    expect(await w.store.listShares(TEST_ORG, agentId)).toEqual([expect.objectContaining({ principal: { kind: "org" }, level: "use" })]);
  });

  it("a decline may carry a reason, shown to the person who asked, and is audited; a reason with an approval is refused", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const request = w.requestOf(await w.ask(MAYA, agentId, COMPANY));
    // The decide route's own decision function (the route adds only the browser session guard in front of it, tested above).
    const capture = capturingAuditDeps({ db: w.db });
    const deps: ApprovalDependencies = { store: w.store, projectMembers: w.members, documentClient: w.db, tableName: "state", now: Date.now, confirmOrigin: CELL, audit: capture.audit, signInStore: new DeveloperSignInStore({ documentClient: w.db, tableName: "signin", now: Date.now }) };
    const dana = { orgId: TEST_ORG, developerId: DANA.developerId, orgRole: "admin" as const };
    await expect(decideApproval(deps, dana, request.approvalId, { requestId: randomUUID(), decision: "APPROVE", reason: "no" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(decideApproval(deps, dana, request.approvalId, { requestId: randomUUID(), decision: "DECLINE", reason: "bad\u0007text" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await decideApproval(deps, dana, request.approvalId, { requestId: randomUUID(), decision: "DECLINE", reason: "  Please add a test step first.  " })).toMatchObject({ status: "DECLINED" });
    expect(w.record(request.approvalId)).toMatchObject({ status: "DECLINED", declineReason: "Please add a test step first." });
    expect(capture.recordedBy("agent_publication.declined")).toMatchObject([{ target: { kind: "agent", id: agentId }, facts: { approvalId: request.approvalId, targetKind: "company", version: 1, explained: true } }]);
    const mine = await w.call(MAYA, "GET", `/v1/app/agents/${agentId}/publish-requests`);
    expect(mine.body.requests).toEqual([expect.objectContaining({ state: "declined", declineReason: "Please add a test step first." })]);
  });
});

describe("withdrawing and listing", () => {
  it("only the person who asked withdraws, by their own request id; a repeat answers it again; it can't be approved after", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const requestId = randomUUID();
    const request = w.requestOf(await w.ask(MAYA, agentId, WEB, { requestId }));
    expect((await w.call(MAX, "POST", `/v1/app/agent-publish-requests/${requestId}/withdraw`, {})).status).toBe(404);
    expect((await w.call(DANA, "POST", `/v1/app/agent-publish-requests/${requestId}/withdraw`, {})).status).toBe(404);
    expect(w.record(request.approvalId).status).toBe("PENDING");
    const withdrawn = await w.call(MAYA, "POST", `/v1/app/agent-publish-requests/${requestId}/withdraw`, {});
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.request).toMatchObject({ state: "withdrawn" });
    expect(w.record(request.approvalId)).toMatchObject({ status: "EXPIRED", withdrawnBy: MAYA.developerId });
    expect((await w.call(MAYA, "POST", `/v1/app/agent-publish-requests/${requestId}/withdraw`, {})).status).toBe(200);
    expect((await w.onPage(MAX, request.approvalId)).statusCode).not.toBe(200);
    expect(await w.store.get(TEST_ORG, agentId)).toMatchObject({ owner: { kind: "member", developerId: MAYA.developerId } });
    // The target is free again.
    expect((await w.ask(MAYA, agentId, WEB)).status).toBe(202);
  });

  it("lists only what the caller may see: the asker, the target's maintainers and admins; never another project's maintainer", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAYA);
    const request = w.requestOf(await w.ask(MAYA, agentId, WEB));
    const seen = async (who: Developer) => ((await w.call(who, "GET", "/v1/app/agent-publish-requests")).body.requests as Array<{ approvalId: string; approval: { canDecide: boolean } }>);
    expect((await seen(MAX)).map((entry) => [entry.approvalId, entry.approval.canDecide])).toEqual([[request.approvalId, true]]);
    expect((await seen(DANA)).map((entry) => entry.approvalId)).toEqual([request.approvalId]);
    expect((await seen(MAYA)).map((entry) => entry.approvalId)).toEqual([request.approvalId]);
    expect(await seen(QUINN)).toEqual([]);
    expect(await seen(PAT)).toEqual([]);
    expect((await w.call(PAT, "GET", `/v1/app/agents/${agentId}/publish-requests`)).status).toBe(404);
    // The agent view says it waits, to its author.
    const profile = await w.call(MAYA, "GET", `/v1/app/agents/${agentId}`);
    expect((profile.body.agent as { publication: unknown }).publication).toMatchObject({ level: "personal", pending: { requestId: request.requestId, target: WEB } });
  });

  it("is company scoped: another company's agent reads as missing", async () => {
    const w = await world();
    const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
    const theirs = await w.store.create({ orgId: ORG_B, name: "Theirs", owner: { kind: "member", developerId: PAT.developerId }, overlay: OVERLAY, createdBy: PAT.developerId });
    expect((await w.ask(DANA, theirs.agentId, COMPANY)).status).toBe(404);
    expect((await w.call(DANA, "GET", `/v1/app/agents/${theirs.agentId}/publish-requests`)).status).toBe(404);
  });
});

describe("favourite and suggested agents", () => {
  it("starts with the starter built-ins, keeps the list in order, and fences it by revision and request id", async () => {
    const w = await world();
    const empty = MyAgentsSchema.parse((await w.call(PAT, "GET", "/v1/app/me/agents")).body);
    expect(empty.favourites).toEqual([]);
    expect(empty.revision).toBe(0);
    expect(empty.suggested.length).toBeGreaterThan(0);
    expect(empty.suggested.every((card) => card.reason === "starter" && card.builtin)).toBe(true);
    const mine = await w.publishedAgent(PAT);
    const requestId = randomUUID();
    const saved = await w.call(PAT, "PUT", "/v1/app/me/agents/favourites", { requestId, expectedRevision: 0, agentIds: [mine, "root-cause-analyst"] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ revision: 1, favourites: [{ agentId: mine, reason: "favourite" }, { agentId: "root-cause-analyst", reason: "favourite" }] });
    expect((await w.call(PAT, "PUT", "/v1/app/me/agents/favourites", { requestId, expectedRevision: 0, agentIds: [mine, "root-cause-analyst"] })).body).toMatchObject({ revision: 1 });
    expect((await w.call(PAT, "PUT", "/v1/app/me/agents/favourites", { requestId, expectedRevision: 0, agentIds: [mine] })).body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await w.call(PAT, "PUT", "/v1/app/me/agents/favourites", { expectedRevision: 0, agentIds: [mine] })).body.error).toMatchObject({ code: "CHANGE_STALE" });
    const home = MyAgentsSchema.parse((await w.call(PAT, "GET", "/v1/app/me/agents")).body);
    expect(home.favourites.map((card) => card.agentId)).toEqual([mine, "root-cause-analyst"]);
    expect(home.suggested.map((card) => card.agentId)).not.toContain("root-cause-analyst");
  });

  it("refuses an agent the person can't see with one sentence, and keeps a favourite that became hidden until access returns", async () => {
    const w = await world();
    const mayas = await w.publishedAgent(MAYA);
    expect((await w.call(PAT, "PUT", "/v1/app/me/agents/favourites", { expectedRevision: 0, agentIds: [mayas] })).body.error).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("isn't an agent you can pick") as string });
    await w.store.replaceShares({ orgId: TEST_ORG, agentId: mayas, upsert: [{ principal: { kind: "member", developerId: PAT.developerId }, level: "use" }], remove: [], expectedSharesRevision: 0, by: "seed" });
    expect((await w.call(PAT, "PUT", "/v1/app/me/agents/favourites", { expectedRevision: 0, agentIds: [mayas] })).status).toBe(200);
    await w.store.replaceShares({ orgId: TEST_ORG, agentId: mayas, upsert: [], remove: [{ kind: "member", developerId: PAT.developerId }], expectedSharesRevision: 1, by: "seed" });
    expect(MyAgentsSchema.parse((await w.call(PAT, "GET", "/v1/app/me/agents")).body).favourites).toEqual([]);
    // A new list that leaves it out does not drop it.
    expect((await w.call(PAT, "PUT", "/v1/app/me/agents/favourites", { expectedRevision: 1, agentIds: ["root-cause-analyst"] })).status).toBe(200);
    await w.store.replaceShares({ orgId: TEST_ORG, agentId: mayas, upsert: [{ principal: { kind: "member", developerId: PAT.developerId }, level: "use" }], remove: [], expectedSharesRevision: 2, by: "seed" });
    expect(MyAgentsSchema.parse((await w.call(PAT, "GET", "/v1/app/me/agents")).body).favourites.map((card) => card.agentId)).toEqual(["root-cause-analyst", mayas]);
  });

  it("suggests the asked project's roster, and only to a person with a role on it", async () => {
    const w = await world();
    const agentId = await w.publishedAgent(MAX);
    expect((await w.ask(MAX, agentId, WEB)).status).toBe(200);
    const added = await w.call(MAX, "PUT", `/v1/app/projects/web/agents/${agentId}`, {});
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const home = MyAgentsSchema.parse((await w.call(MAYA, "GET", "/v1/app/me/agents?project=web")).body);
    expect(home.suggested[0]).toMatchObject({ agentId, reason: "project_roster" });
    expect((await w.call(PAT, "GET", "/v1/app/me/agents?project=web")).status).toBe(404);
  });
});
