// Plan 3, Task 21a-wiring (PF31h, R66, R68): the decide routes, the approval kinds and `mayDecide`, on top of 21a-presence's machinery.
// The `apr` kind is the REAL one (`approvalDecideKind`) over real approval records: write, step and change approvals are decided through the
// confirmation page, a token is sent to the page, eligibility is read live, and a refused decision does not spend the session (M-d).
// The sign-in function asks the broker whether a member may decide (`decide-inspect`); the broker's handler and the invoke bridge are tested
// here too. The presence machinery itself (tickets, the fresh sign-in, the session) is decide-presence.test.ts.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentXError, agentXError, approvalKey, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type ConnectorResult, type GrantedTool, type OrgId, type ToolFacts } from "@rovara-code/contracts";
import { orgMemberKey, type OrgRole } from "@agentx/cloud-contracts";
import type { AgentCaller } from "../../packages/broker/src/agents/access.js";
import { approvalDecideKind, requestIdFor } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { routeApprovalRequest } from "../../packages/broker/src/agents/approval-routes.js";
import {
  createPendingChange, createStepApproval, expireApprovals, getAnyApproval, registerApprovalSubjectHandler,
  type AnyApprovalRecord, type ApprovalDependencies, type StepApprovalRecord, type WriteApprovalRecord,
} from "../../packages/broker/src/agents/approvals.js";
import { registerAgentApprovals } from "../../packages/broker/src/agents/changes.js";
import { memoryRunCache } from "../../packages/broker/src/agents/run-cache.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { decideWrite, type ApprovedCall, type ClassifyContext, type DecideWriteInput, type WriteGateRuntime } from "../../packages/broker/src/agents/write-gate.js";
import type { ClassifyAgentWriteDependencies } from "../../packages/broker/src/agents/write-class.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import type { DecideKind, DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import { brokerDecideKinds, lambdaInspectInvoker, type DecideInspectRequest } from "../../packages/broker/src/developer/decide-inspect.js";
import {
  DECIDE_COOKIE, DecideStore, csrfTokenFor, mintConfirmUrl, requireDecideSession, type DecideRequestContext,
} from "../../packages/broker/src/developer/decide-session.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { decideKindsFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { DEV_ISSUER, MAYA, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

// ---- the world: one org with a project, a run owner, a maintainer, a contributor and an admin

const T0 = Date.parse("2026-10-22T09:00:00.000Z");
const CELL = "https://cell.example.com";
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const hex = (digit: string) => digit.repeat(64);
const ALICE = hex("a"); // the run's owner, a contributor on web
const BOB = hex("c"); // a maintainer of web
const CARA = hex("d"); // a contributor on web
const DANA = hex("e"); // an org admin
const ERIN = hex("f"); // a member with no role on web
const XAVI = hex("9"); // org B's owner
const TASK = "11111111-1111-4111-8111-111111111111";
const OPERATION = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "con_aaaaaaaaaaaaaaaaaaaa";
const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const TEAM_PAY = "d519f057-89bb-4ec9-a34f-089164ee065a";
const SCHEMA = "a".repeat(64);
const FORBIDDEN = "Only Alice or a project maintainer can decide this.";
const STALE = "The draft changed after this was asked. Publish again.";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function grant(upstreamName: string): GrantedTool {
  const facts: ToolFacts = { connector: "linear", upstreamName, access: "write", itemArguments: ["id"] };
  return { connector: "linear", type: "linear", upstreamName, presentedName: `linear__${upstreamName}`, access: "write", facts };
}
const SAVE_ISSUE = grant("save_issue");
const GITHUB_REVIEW: GrantedTool = {
  connector: "github", type: "github", upstreamName: "create_pull_request_review", presentedName: "github__create_pull_request_review", access: "write",
  facts: { connector: "github", upstreamName: "create_pull_request_review", access: "write", itemArguments: ["pull_number"] },
};
const CLASSIFY: ClassifyContext = { rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false };

function world() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const members = new FakeProjectMembers();
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "state", now: () => clock.now });
  const store = new AgentStore({ documentClient: db, tableName: "state", now: () => clock.now });
  const vendor = { calls: [] as ApprovedCall[], runs: 0 };
  const runtime: WriteGateRuntime = {
    classify: { documentClient: db, tableName: "state", now: () => clock.now, labelListers: {}, runCache: () => memoryRunCache() } as unknown as ClassifyAgentWriteDependencies,
    runConnector: async (call): Promise<ConnectorResult> => {
      vendor.runs += 1;
      vendor.calls.push(call);
      return { requestId: call.request.requestId, status: "SUCCEEDED", text: JSON.stringify({ id: "CHA-9" }), truncated: false, replayed: false };
    },
    regrant: async () => ({ tool: SAVE_ISSUE, classify: CLASSIFY }),
    recordedResult: async () => undefined,
    requireRunAuthority: async () => undefined,
  };
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: db, tableName: "state", signInStore, now: () => clock.now, confirmOrigin: CELL, writeGate: runtime, log: () => undefined,
  };
  const handled: Array<{ kind: string; status: string; approvalId: string }> = [];
  registerAgentApprovals();
  registerApprovalSubjectHandler("agent_run", async (_deps, record) => { handled.push({ kind: record.kind, status: record.status, approvalId: record.approvalId }); });
  const changes = { applied: [] as Array<{ approvalId: string; decidedBy: string | undefined; proof: unknown }>, failWith: undefined as string | undefined };
  registerApprovalSubjectHandler("agent_publish", async (_deps, record, decision) => {
    if (changes.failWith !== undefined) throw agentXError("AGENT_REVISION_CONFLICT", changes.failWith);
    changes.applied.push({ approvalId: record.approvalId, decidedBy: record.decidedBy, proof: decision?.proof });
  });

  const member = (orgId: OrgId, developerId: string, role: OrgRole, name: string) => {
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", displayName: name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    members.setOrgRole(orgId, developerId, role);
  };
  for (const [who, role, name] of [[ALICE, "member", "Alice"], [BOB, "member", "Bob"], [CARA, "member", "Cara"], [DANA, "admin", "Dana"], [ERIN, "member", "Erin"]] as const) member(ORG_A, who, role, name);
  member(ORG_B, XAVI, "owner", "Xavi");
  members.addProject(ORG_A, "web");
  members.grant(ORG_A, "web", ALICE, "contributor");
  members.grant(ORG_A, "web", BOB, "maintainer");
  members.grant(ORG_A, "web", CARA, "contributor");
  db.set({ ...orgProjectCatalogKey(ORG_A, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 1 });
  db.set({ ...projectMetaKey(ORG_A, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: DANA });
  const command = { cwd: "repo/web", executable: "npm", args: ["ci"], timeoutSeconds: 900 };
  db.set({
    ...projectRevisionKey(ORG_A, "web", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: { deploymentMode: "ec2-ebs" },
    definition: {
      name: "web", revision: 1,
      repositories: [
        { name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" },
        { name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-app" },
      ],
      setup: [command], readiness: [{ ...command, args: ["test"] }], orchestratorInstructions: "Delegate work.",
      integrations: {
        connectors: [
          { name: "linear", type: "linear", credentialRef: CONNECTION, scopes: [{ alias: "eng", teamId: TEAM }, { alias: "pay", teamId: TEAM_PAY }], tools: [{ name: "save_issue", access: "write" }] },
          { name: "github", type: "github", scopes: ["web", "payments-api"], tools: [{ name: "create_pull_request_review", access: "write" }] },
        ],
      },
    },
  });
  db.set({
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: ORG_A, developerId: ALICE, developerName: "Alice", provider: "oidc", project: "web",
    workspaceId: WORKSPACE, ownerKey: "owner-key-alice", createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z",
  });

  const kind = approvalDecideKind(deps);
  const decideStore = new DecideStore({ documentClient: db, tableName: "signin", now: () => clock.now });
  const bearers = new Map([["Bearer bob", { developerId: BOB, orgId: ORG_A }], ["Bearer cara", { developerId: CARA, orgId: ORG_A }], ["Bearer dana", { developerId: DANA, orgId: ORG_A }]]);
  const context = (kinds: DecideKinds = { apr: kind }): DecideRequestContext => ({
    store: decideStore, now: () => clock.now, cellOrigin: CELL, kinds,
    authenticateBearer: async (authorization) => {
      const found = bearers.get(authorization);
      if (found === undefined) throw agentXError("AUTH_REQUIRED", "a valid sign-in is required");
      return found;
    },
  });
  /** A session as the sign-in function writes it after a fresh email-code sign-in. */
  let counter = 0;
  const session = async (developerId: string, approvalId: string, options: { orgId?: OrgId; agoSeconds?: number } = {}) => {
    counter += 1;
    const cookie = `cookie-${String(counter)}-${"x".repeat(40)}`;
    const signedInAt = Math.floor(clock.now / 1000) - (options.agoSeconds ?? 30);
    await decideStore.putSession(cookie, { orgId: options.orgId ?? ORG_A, developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return cookie;
  };
  const page = (approvalId: string, options: { method?: "GET" | "POST"; cookie?: string; fields?: Record<string, string>; headers?: Record<string, string>; kinds?: DecideKinds } = {}) => {
    const method = options.method ?? "GET";
    return routeDecidePage(context(options.kinds), {
      method, path: `/v1/app/approve/${approvalId}`, requestId: "r",
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: `${DECIDE_COOKIE}=${options.cookie}` }),
        ...(method === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}), ...options.headers,
      },
      ...(options.fields === undefined ? {} : { body: new URLSearchParams(options.fields).toString() }),
    }, new URL(`${CELL}/v1/app/approve/${approvalId}`));
  };
  /** Approves or declines as `cookie`'s member, with the page's own CSRF token. */
  const decide = (approvalId: string, cookie: string, decision: "approve" | "decline" = "approve", kinds?: DecideKinds) =>
    page(approvalId, { method: "POST", cookie, fields: { decision, csrf: csrfTokenFor(cookie) }, ...(kinds === undefined ? {} : { kinds }) });

  const input = (args: Record<string, unknown> = { id: "ENG-12", stateId: "s1" }, scope = "eng"): DecideWriteInput => ({
    orgId: ORG_A, taskId: TASK, operationId: OPERATION, stepId: "work", agentId: "agt_00000000000000000007", agentName: "Triage bot", tool: SAVE_ISSUE,
    call: { scope, schemaHash: SCHEMA, arguments: args }, classify: CLASSIFY, run: { project: "web", owner: { developerId: ALICE, name: "Alice" } },
  });
  /** A GitHub review call: the server binds the repository from the scope, so the arguments never name it. */
  const githubInput = (scope: string): DecideWriteInput => ({
    ...input({ pull_number: 12, event: "APPROVE" }, scope), tool: GITHUB_REVIEW, classification: { class: "consequential", reason: "a review", ignoredRules: [] },
  });
  const waitingWrite = async (args?: Record<string, unknown>, scope?: string): Promise<string> => {
    const decision = await decideWrite(deps, input(args, scope));
    if (decision.outcome !== "wait") throw new Error(`expected wait, got ${JSON.stringify(decision)}`);
    return decision.approvalId;
  };
  const waitingChange = async (): Promise<string> => (await createPendingChange(deps, {
    orgId: ORG_A, requestId: randomUUID(), requestedBy: ALICE,
    subject: { kind: "agent_publish", agentId: "agt_00000000000000000001", draftRevision: 3, digest: "d".repeat(64), expectedCurrentVersion: 1 },
    changes: ["Publishes the draft of Triage as version 2"], approvers: { kind: "rule", rule: "org_admin", candidates: [DANA] },
  })).approvalId;
  const waitingStep = async (): Promise<string> => (await createStepApproval(deps, {
    orgId: ORG_A, subject: { kind: "agent_run", taskId: TASK, stepId: "gate" }, prompt: "Go on with the release?",
    approvers: { kind: "ids", ids: [BOB] }, project: "web", owner: { developerId: ALICE, name: "Alice" },
  })).approvalId;
  const record = async (approvalId: string): Promise<AnyApprovalRecord> => (await getAnyApproval(deps, ORG_A, approvalId))!;
  const sessionOf = async (cookie: string) => decideStore.getSession(cookie);
  const waitingGithub = async (scope: string): Promise<string> => {
    const decision = await decideWrite(deps, githubInput(scope));
    if (decision.outcome !== "wait") throw new Error(`expected wait, got ${JSON.stringify(decision)}`);
    return decision.approvalId;
  };
  return { db, clock, members, deps, vendor, handled, changes, kind, decideStore, context, session, page, decide, waitingWrite, waitingGithub, waitingChange, waitingStep, record, sessionOf, member };
}
type World = ReturnType<typeof world>;
const caller = (developerId: string, orgRole: OrgRole = "member", orgId: OrgId = ORG_A): AgentCaller => ({ orgId, developerId, orgRole });
void caller;

// ---- the apr kind, through the confirmation page

describe("the confirmation page for a write approval", () => {
  it("shows the exact call, every argument escaped as text, to a maintainer", async () => {
    const w = world();
    const id = await w.waitingWrite({ id: "ENG-12", stateId: "<script>alert(1)</script>", note: "x‮y" });
    const cookie = await w.session(BOB, id);
    const shown = await w.page(id, { cookie });
    expect(shown.statusCode).toBe(200);
    expect(shown.body).not.toContain("<script>");
    expect(shown.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(shown.body).toContain("[U+202E]");
    for (const expected of ["linear", "save_issue", "ENG-12", "web", "Alice", `value="${csrfTokenFor(cookie)}"`, "Approve", "Decline"]) expect(shown.body, expected).toContain(expected);
    expect(shown.headers["content-security-policy"]).toContain("form-action 'self'");
    expect(shown.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(shown.headers["x-frame-options"]).toBe("DENY");
  });

  // Final fix wave, access I-1: the scope is part of the call, so two approvals that differ only in it must read differently.
  const plain = (body: string, ...ids: string[]) => ids.reduce((text, id) => text.split(id).join("<id>"), body).replace(/name="csrf" value="[^"]*"/u, "");
  it("shows the connector's scope in the facts and the exact call, so two calls that differ only by scope read differently", async () => {
    const w = world();
    const eng = await w.waitingWrite(undefined, "eng");
    const pay = await w.waitingWrite(undefined, "pay");
    expect(eng).not.toBe(pay);
    const engPage = await w.page(eng, { cookie: await w.session(BOB, eng) });
    const payPage = await w.page(pay, { cookie: await w.session(BOB, pay) });
    expect(engPage.statusCode).toBe(200);
    expect(payPage.statusCode).toBe(200);
    expect(engPage.body).toContain("<dt>Scope</dt><dd>eng</dd>");
    expect(payPage.body).toContain("<dt>Scope</dt><dd>pay</dd>");
    // The exact call block names the scope beside the connector and the tool.
    expect(engPage.body).toMatch(/<h2>The exact call<\/h2><dl>.*<dt>Scope<\/dt><dd>eng<\/dd>.*<\/dl><pre>/u);
    expect(payPage.body).toMatch(/<h2>The exact call<\/h2><dl>.*<dt>Scope<\/dt><dd>pay<\/dd>.*<\/dl><pre>/u);
    expect(plain(engPage.body, eng)).not.toBe(plain(payPage.body, pay));
  });

  it("shows a GitHub call's repository as owner/name, which the stored arguments leave out", async () => {
    const w = world();
    const site = await w.waitingGithub("web");
    const payments = await w.waitingGithub("payments-api");
    const sitePage = await w.page(site, { cookie: await w.session(BOB, site) });
    const paymentsPage = await w.page(payments, { cookie: await w.session(BOB, payments) });
    expect(sitePage.body).toContain("<dt>Repository</dt><dd>acme/web</dd>");
    expect(paymentsPage.body).toContain("<dt>Repository</dt><dd>acme/payments-api</dd>");
    expect(sitePage.body).not.toContain("acme/payments-api");
    expect(plain(sitePage.body, site)).not.toBe(plain(paymentsPage.body, payments));
    expect(await w.record(payments)).toMatchObject({ scope: "payments-api", repository: "acme/payments-api" });
  });

  it("approving applies exactly the stored call once, with the session's proof, and ends the session", async () => {
    const w = world();
    const id = await w.waitingWrite({ id: "ENG-12", stateId: "s1" });
    const stored = await w.record(id) as WriteApprovalRecord;
    const cookie = await w.session(BOB, id);
    const done = await w.decide(id, cookie);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).toContain("Approved");
    expect(w.vendor.runs).toBe(1);
    expect(w.vendor.calls[0]!.request).toMatchObject({ arguments: stored.arguments });
    const ended = await w.record(id) as WriteApprovalRecord;
    expect(ended).toMatchObject({ status: "APPROVED_DONE", decidedBy: BOB });
    expect(ended.decisionProof).toMatchObject({ kind: "fresh_sign_in", method: "email_code" });
    expect(ended.decisionRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await w.sessionOf(cookie)).toBeUndefined();
    // The same cookie can't decide again, here or anything else.
    const again = await w.decide(id, cookie);
    expect(again.statusCode).toBe(401);
    expect(w.vendor.runs).toBe(1);
  });

  it("declining writes nothing and calls nothing", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    const done = await w.decide(id, cookie, "decline");
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).toContain("Declined");
    expect(w.vendor.runs).toBe(0);
    expect(await w.record(id)).toMatchObject({ status: "DECLINED", decidedBy: BOB });
  });

  it("lets the run's owner decide it", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(ALICE, id);
    expect((await w.decide(id, cookie)).statusCode).toBe(200);
    expect(w.vendor.runs).toBe(1);
  });

  it("gives a contributor who is not the owner 403 on the page and on the post, and runs nothing", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(CARA, id);
    const shown = await w.page(id, { cookie });
    expect(shown.statusCode).toBe(403);
    expect(shown.body).toContain(FORBIDDEN);
    expect(shown.body).not.toContain("save_issue");
    const posted = await w.decide(id, cookie);
    expect(posted.statusCode).toBe(403);
    expect(posted.body).toContain(FORBIDDEN);
    expect(w.vendor.runs).toBe(0);
    expect(await w.record(id)).toMatchObject({ status: "PENDING" });
  });

  it("reads the member's role live: a maintainer demoted after signing in can't decide, and one who left the org finds nothing", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    w.members.grant(ORG_A, "web", BOB, "viewer");
    expect((await w.page(id, { cookie })).statusCode).toBe(403);
    w.members.grant(ORG_A, "web", BOB, "maintainer");
    w.db.delete(orgMemberKey(ORG_A, BOB).pk, orgMemberKey(ORG_A, BOB).sk);
    expect((await w.page(id, { cookie })).statusCode).toBe(404);
    expect(w.vendor.runs).toBe(0);
  });

  it("finds nothing for another org's session or an id that does not exist", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const other = await w.session(XAVI, id, { orgId: ORG_B });
    expect((await w.page(id, { cookie: other })).statusCode).toBe(404);
    expect((await w.decide(id, other)).statusCode).toBe(404);
    const missing = "apr_zzzzzzzzzzzzzzzzzzzz";
    expect((await w.page(missing, { cookie: await w.session(BOB, missing) })).statusCode).toBe(404);
    expect(w.vendor.runs).toBe(0);
  });

  it("says who decided and when once it is decided, to anyone who may decide it, and not to a stranger", async () => {
    const w = world();
    const id = await w.waitingWrite();
    expect((await w.decide(id, await w.session(BOB, id))).statusCode).toBe(200);
    const later = await w.page(id, { cookie: await w.session(ALICE, id) });
    expect(later.statusCode).toBe(409);
    expect(later.body).toContain("This was already decided by Bob at ");
    expect((await w.page(id, { cookie: await w.session(CARA, id) })).statusCode).toBe(403);
  });

  it("treats an approval past its time as closed, though the sweep has not ended it yet", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    w.clock.now += 8 * 86_400_000;
    const late = await w.session(BOB, id);
    const shown = await w.page(id, { cookie: late });
    expect(shown.statusCode).toBe(409);
    expect(shown.body).toContain("expired");
    expect((await w.decide(id, late)).statusCode).toBe(409);
    expect(w.vendor.runs).toBe(0);
    expect(cookie).toBeDefined();
  });

  it("decides once when two posts arrive at the same time with one session", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    const results = await Promise.all([w.decide(id, cookie), w.decide(id, cookie), w.decide(id, cookie)]);
    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(w.vendor.runs).toBe(1);
  });
});

describe("the confirmation page for a change and a step", () => {
  it("applies exactly the stored change, shows the words of what it does, and gives a non-admin 403", async () => {
    const w = world();
    const id = await w.waitingChange();
    const shown = await w.page(id, { cookie: await w.session(DANA, id) });
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toContain("Publishes the draft of Triage as version 2");
    const refused = await w.decide(id, await w.session(BOB, id));
    expect(refused.statusCode).toBe(403);
    expect(w.changes.applied).toEqual([]);
    const done = await w.decide(id, await w.session(DANA, id));
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).toContain("Approved");
    expect(w.changes.applied).toHaveLength(1);
    expect(w.changes.applied[0]).toMatchObject({ approvalId: id, decidedBy: DANA, proof: { kind: "fresh_sign_in" } });
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_DONE" });
  });

  it("ends APPROVED_FAILED with the stale-draft words when the draft changed, shows them, and applies nothing", async () => {
    const w = world();
    const id = await w.waitingChange();
    w.changes.failWith = STALE;
    const done = await w.decide(id, await w.session(DANA, id));
    expect(done.body).toContain(STALE);
    expect(done.body).toContain("did not go through");
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_FAILED", failure: STALE });
    expect(w.changes.applied).toEqual([]);
  });

  it("declining a change applies nothing", async () => {
    const w = world();
    const id = await w.waitingChange();
    expect((await w.decide(id, await w.session(DANA, id), "decline")).statusCode).toBe(200);
    expect(await w.record(id)).toMatchObject({ status: "DECLINED" });
    expect(w.changes.applied).toEqual([]);
  });

  it("lets a person named on a step approval continue the run, and no one else", async () => {
    const w = world();
    const id = await w.waitingStep();
    const shown = await w.page(id, { cookie: await w.session(BOB, id) });
    expect(shown.body).toContain("Go on with the release?");
    expect((await w.decide(id, await w.session(ERIN, id))).statusCode).toBe(403);
    expect((await w.decide(id, await w.session(BOB, id))).statusCode).toBe(200);
    expect(await w.record(id)).toMatchObject({ status: "APPROVED", decidedBy: BOB });
    expect((await w.record(id) as StepApprovalRecord).kind).toBe("step");
    expect(w.handled).toContainEqual({ kind: "step", status: "APPROVED", approvalId: id });
  });
});

// ---- M-d: a refused decision does not spend the session

describe("a refused decision does not consume the session (M-d)", () => {
  const refusing = (w: World, error: unknown): DecideKinds => ({ apr: { ...w.kind, decide: async () => { throw error; } } satisfies DecideKind });

  it("keeps it after FORBIDDEN (eligibility lost between the page and the post) and lets the same session decide once eligible again", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    w.members.grant(ORG_A, "web", BOB, "viewer");
    expect((await w.decide(id, cookie)).statusCode).toBe(403);
    expect(await w.sessionOf(cookie)).toMatchObject({ approvalId: expect.stringMatching(/^apr_/) as string });
    expect((await w.sessionOf(cookie))?.usedAt).toBeUndefined();
    w.members.grant(ORG_A, "web", BOB, "maintainer");
    expect((await w.decide(id, cookie)).statusCode).toBe(200);
    expect(w.vendor.runs).toBe(1);
    expect(await w.sessionOf(cookie)).toBeUndefined();
  });

  it("keeps it after APPROVAL_CLOSED, whether the page saw the decision or the decision itself raced", async () => {
    const w = world();
    const id = await w.waitingWrite();
    expect((await w.decide(id, await w.session(ALICE, id))).statusCode).toBe(200);
    const late = await w.session(BOB, id);
    expect((await w.decide(id, late)).statusCode).toBe(409);
    expect(await w.sessionOf(late)).toBeDefined();
    expect((await w.sessionOf(late))?.usedAt).toBeUndefined();
    // The kind itself says closed (the other decision landed between the check and the claim).
    const second = world();
    const other = await second.waitingWrite();
    const raced = await second.session(BOB, other);
    const response = await second.decide(other, raced, "approve", refusing(second, agentXError("APPROVAL_CLOSED", "this request was already decided")));
    expect(response.statusCode).toBe(409);
    expect(await second.sessionOf(raced)).toBeDefined();
    expect((await second.sessionOf(raced))?.usedAt).toBeUndefined();
  });

  it("keeps it after CONFIG_INVALID and after any other refusal below 500, and shows its words", async () => {
    const w = world();
    const id = await w.waitingWrite();
    for (const error of [agentXError("CONFIG_INVALID", "body: has a field this route does not take"), agentXError("FORBIDDEN", FORBIDDEN), agentXError("NOT_FOUND", "approval not found")]) {
      const cookie = await w.session(BOB, id);
      const response = await w.decide(id, cookie, "approve", refusing(w, error));
      expect(response.statusCode, error.code).toBeLessThan(500);
      expect(response.statusCode, error.code).toBeGreaterThanOrEqual(400);
      expect(await w.sessionOf(cookie), error.code).toBeDefined();
      expect((await w.sessionOf(cookie))?.usedAt, error.code).toBeUndefined();
    }
    expect(w.vendor.runs).toBe(0);
  });

  it("keeps it for a bad choice on the form, which decided nothing", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    expect((await w.page(id, { method: "POST", cookie, fields: { decision: "maybe", csrf: csrfTokenFor(cookie) } })).statusCode).toBe(400);
    expect(await w.sessionOf(cookie)).toMatchObject({ approvalId: expect.stringMatching(/^apr_/) as string });
    expect((await w.sessionOf(cookie))?.usedAt).toBeUndefined();
  });

  it("spends it when the decision was made, however it ended: applied, declined, failed to apply, or a server error", async () => {
    const w = world();
    const done = await w.waitingWrite();
    const doneCookie = await w.session(BOB, done);
    expect((await w.decide(done, doneCookie)).statusCode).toBe(200);
    expect(await w.sessionOf(doneCookie)).toBeUndefined();

    const declined = await w.waitingWrite({ id: "ENG-13", stateId: "s2" });
    const declinedCookie = await w.session(BOB, declined);
    expect((await w.decide(declined, declinedCookie, "decline")).statusCode).toBe(200);
    expect(await w.sessionOf(declinedCookie)).toBeUndefined();

    const change = await w.waitingChange();
    w.changes.failWith = STALE;
    const failedCookie = await w.session(DANA, change);
    await w.decide(change, failedCookie);
    expect(await w.sessionOf(failedCookie)).toBeUndefined();

    // A failure on our side may have partly happened: the session is spent (fail closed), and the person signs in again.
    const trouble = await w.waitingWrite({ id: "ENG-14", stateId: "s3" });
    for (const error of [agentXError("RUNTIME_UNAVAILABLE", "not set up"), new Error("socket hang up")]) {
      const cookie = await w.session(BOB, trouble);
      const response = await w.decide(trouble, cookie, "approve", refusing(w, error)).catch(() => ({ statusCode: 500 }));
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      expect(await w.sessionOf(cookie), error.message).toBeUndefined();
    }
  });

  it("derives the decision's request id from the session, so a retried post replays the stored outcome", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    expect((await w.decide(id, cookie)).statusCode).toBe(200);
    const first = (await w.record(id)).decisionRequestId;
    // Another session of the same member for the same (now decided) approval is told it was decided, and the stored request id is untouched.
    const second = await w.session(BOB, id);
    expect((await w.decide(id, second)).statusCode).toBe(409);
    expect((await w.record(id)).decisionRequestId).toBe(first);
    expect(w.vendor.runs).toBe(1);
  });
});

describe("the apr kind's own decision", () => {
  it("replays the stored outcome when the same session repeats the decision (a post that was retried), and runs the call once", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const proof = { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: "2026-10-22T08:59:00.000Z", sessionRef: "b".repeat(64) };
    const target = { orgId: ORG_A, developerId: BOB, approvalId: id };
    expect((await w.kind.decide(target, "approve", proof)).message).toContain("Approved");
    expect((await w.kind.decide(target, "approve", proof)).message).toContain("Approved");
    expect(w.vendor.runs).toBe(1);
    // Another session is another request: it finds the approval closed.
    await expect(w.kind.decide(target, "approve", { ...proof, sessionRef: "c".repeat(64) })).rejects.toMatchObject({ code: "APPROVAL_CLOSED" });
  });

  it("decides only with the page's fresh sign-in proof: any other proof is refused and nothing is decided", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const target = { orgId: ORG_A, developerId: BOB, approvalId: id };
    for (const proof of [{ kind: "none" as const }, { kind: "button" as const, via: "slack" as const }]) {
      await expect(w.kind.decide(target, "approve", proof)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(w.vendor.runs).toBe(0);
    expect(await w.record(id)).toMatchObject({ status: "PENDING" });
  });
});

describe("the decide route and the guard behind it", () => {
  const guardFor = (w: World) => async (request: { method: string; path: string; headers: Record<string, string | undefined>; body?: string }) =>
    requireDecideSession(w.context(), request);

  it("refuses a CLI or MCP token with REAUTH_REQUIRED and a confirmUrl whose ticket was minted for that member, and changes nothing", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const gate = guardFor(w);
    const deps = { ...w.deps, requireDecide: (request: { method: string; path: string; headers: Record<string, string | undefined>; body?: string }) => gate(request) } as unknown as ApprovalDependencies;
    const body = JSON.stringify({ requestId: randomUUID(), decision: "APPROVE" });
    const refused = await routeApprovalRequest(deps, caller(BOB), { method: "POST", path: `/v1/app/approvals/${id}/decide`, requestId: "r", headers: { authorization: "Bearer bob" }, body }, new URL(`${CELL}/v1/app/approvals/${id}/decide`))
      .then(() => undefined, (error: { code: string; statusCode: number; details?: { confirmUrl?: string } }) => error);
    expect(refused).toMatchObject({ code: "REAUTH_REQUIRED", statusCode: 401 });
    expect(refused?.details?.confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/${id}\\?ticket=[A-Za-z0-9_-]{43}$`));
    expect(w.vendor.runs).toBe(0);
    expect(await w.record(id)).toMatchObject({ status: "PENDING" });
    // The ticket names Bob and this approval only.
    const ticket = new URL(refused!.details!.confirmUrl!).searchParams.get("ticket")!;
    expect(await w.decideStore.redeemTicket(ticket)).toMatchObject({ developerId: BOB, approvalId: id, orgId: ORG_A, mintedBy: "token" });
  });

  it("mints no ticket for a token whose member may not decide it (403), or for another org's approval (404)", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const gate = guardFor(w);
    const request = (authorization: string, approvalId = id) => ({ method: "POST", path: `/v1/app/approvals/${approvalId}/decide`, headers: { authorization }, body: "{}" });
    expect(await gate(request("Bearer cara")).then(() => undefined, (error: { code: string }) => error.code)).toBe("FORBIDDEN");
    expect(await gate(request("Bearer bob", "apr_zzzzzzzzzzzzzzzzzzzz")).then(() => undefined, (error: { code: string }) => error.code)).toBe("NOT_FOUND");
    expect(w.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
  });

  it("gives the session back when the route's decision is refused, and spends it when it was made", async () => {
    const w = world();
    const id = await w.waitingChange();
    const cookie = await w.session(DANA, id);
    const request = (body: unknown) => ({ method: "POST", path: `/v1/app/approvals/${id}/decide`, requestId: "r", headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/json" }, body: JSON.stringify({ csrf: csrfTokenFor(cookie), ...(body as object) }) });
    const deps = { ...w.deps, requireDecide: (r: Parameters<ReturnType<typeof guardFor>>[0]) => guardFor(w)(r) } as unknown as ApprovalDependencies;
    const url = new URL(`${CELL}/v1/app/approvals/${id}/decide`);
    // A body the route refuses (an unknown field): nothing was decided.
    await expect(routeApprovalRequest(deps, caller(DANA, "admin"), request({ requestId: randomUUID(), decision: "APPROVE", extra: 1 }), url)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await w.sessionOf(cookie)).toMatchObject({ approvalId: expect.stringMatching(/^apr_/) as string });
    expect((await w.sessionOf(cookie))?.usedAt).toBeUndefined();
    const decided = await routeApprovalRequest(deps, caller(DANA, "admin"), request({ requestId: randomUUID(), decision: "APPROVE" }), url);
    expect(decided).toMatchObject({ status: "APPROVED_DONE" });
    expect(await w.sessionOf(cookie)).toBeUndefined();
  });
});

describe("reads and the confirm-link route (fix round 1: I1, I2)", () => {
  const request = (method: string, path: string, body?: unknown) => ({ method, path, requestId: "r", headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const withMint = (w: World, mint?: ApprovalDependencies["mintConfirmUrl"]): ApprovalDependencies => ({
    ...w.deps, mintConfirmUrl: mint ?? ((who, approvalId) => mintConfirmUrl(w.context(), { developerId: who.developerId, orgId: who.orgId }, approvalId)),
  });
  const route = (w: World, who: AgentCaller, method: string, path: string, deps: ApprovalDependencies = withMint(w), body?: unknown) =>
    routeApprovalRequest(deps, who, request(method, path, body), new URL(`${CELL}${path}`)) as Promise<{ approval?: { confirmUrl: string; status: string }; confirmUrl?: string; ticketed?: boolean }>;
  const tickets = (w: World) => w.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"));

  it("mints nothing on a read, so any number of reads leaves the member able to mint", async () => {
    const w = world();
    const id = await w.waitingWrite();
    for (let index = 0; index < 25; index += 1) expect((await route(w, caller(BOB), "GET", `/v1/app/approvals/${id}`)).approval?.confirmUrl).toBe(`${CELL}/v1/app/approve/${id}`);
    expect(tickets(w)).toEqual([]);
    const asked = await route(w, caller(BOB), "POST", `/v1/app/approvals/${id}/confirm-link`, withMint(w), {});
    expect(asked.ticketed).toBe(true);
    expect(asked.confirmUrl).toMatch(new RegExp(`^${CELL}/v1/app/approve/${id}\\?ticket=[A-Za-z0-9_-]{43}$`));
    expect(tickets(w)).toHaveLength(1);
  });

  it("answers the bare link for an approval past its time that the sweep has not ended, and for a decided one, without minting", async () => {
    const w = world();
    const minted: string[] = [];
    const spy = withMint(w, async (who, approvalId) => { minted.push(approvalId); return mintConfirmUrl(w.context(), { developerId: who.developerId, orgId: who.orgId }, approvalId); });
    const expired = await w.waitingWrite();
    const decided = await w.waitingWrite({ id: "ENG-13", stateId: "s2" });
    expect((await w.decide(decided, await w.session(BOB, decided))).statusCode).toBe(200);
    // Decided, and well inside its time: still no mint.
    expect(await route(w, caller(BOB), "POST", `/v1/app/approvals/${decided}/confirm-link`, spy, {})).toEqual({ confirmUrl: `${CELL}/v1/app/approve/${decided}`, ticketed: false });
    w.clock.now += 8 * 86_400_000;
    for (const id of [expired, decided]) {
      const shown = await route(w, caller(BOB), "GET", `/v1/app/approvals/${id}`);
      expect(shown.approval?.confirmUrl, id).toBe(`${CELL}/v1/app/approve/${id}`);
      const asked = await route(w, caller(BOB), "POST", `/v1/app/approvals/${id}/confirm-link`, spy, {});
      expect(asked, id).toEqual({ confirmUrl: `${CELL}/v1/app/approve/${id}`, ticketed: false });
    }
    // The mint is not even tried for an approval that is no longer open.
    expect(minted).toEqual([]);
    expect(tickets(w)).toEqual([]);
  });

  it("answers the bare link to a run owner who lost the right to decide, and not found to a maintainer who lost every right", async () => {
    const w = world();
    const id = await w.waitingWrite();
    w.members.grant(ORG_A, "web", ALICE, "viewer");
    const minted: string[] = [];
    const spy = withMint(w, async (_who, approvalId) => { minted.push(approvalId); return "never"; });
    expect(await route(w, caller(ALICE), "POST", `/v1/app/approvals/${id}/confirm-link`, spy, {})).toEqual({ confirmUrl: `${CELL}/v1/app/approve/${id}`, ticketed: false });
    expect(minted).toEqual([]);
    w.members.grant(ORG_A, "web", BOB, "viewer");
    await expect(route(w, caller(BOB), "POST", `/v1/app/approvals/${id}/confirm-link`, withMint(w), {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tickets(w)).toEqual([]);
  });

  it("falls back to the bare link on any error of ours from the mint (the limit included), and rethrows what is not ours", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const limited = withMint(w, async () => { throw agentXError("TOO_MANY_REQUESTS", "Too many confirmation attempts. Try again later."); });
    expect(await route(w, caller(BOB), "POST", `/v1/app/approvals/${id}/confirm-link`, limited, {})).toEqual({ confirmUrl: `${CELL}/v1/app/approve/${id}`, ticketed: false });
    const closed = withMint(w, async () => { throw agentXError("APPROVAL_CLOSED", "closed meanwhile"); });
    expect((await route(w, caller(BOB), "POST", `/v1/app/approvals/${id}/confirm-link`, closed, {})).ticketed).toBe(false);
    const broken = withMint(w, async () => { throw new Error("socket hang up"); });
    await expect(route(w, caller(BOB), "POST", `/v1/app/approvals/${id}/confirm-link`, broken, {})).rejects.toThrow("socket hang up");
  });

  it("is a POST on an approval's own path only, and absent without a mint", async () => {
    const w = world();
    const id = await w.waitingWrite();
    await expect(route(w, caller(BOB), "GET", `/v1/app/approvals/${id}/confirm-link`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await route(w, caller(BOB), "POST", `/v1/app/approvals/${id}/confirm-link`, w.deps, {})).toEqual({ confirmUrl: `${CELL}/v1/app/approve/${id}`, ticketed: false });
  });
});

describe("the API decide route settles the session by what came of the decision (fix round 1: m3, m4)", () => {
  /** A guard that records what is done with the session; the documentClient fails the decision's claim with `failure`. */
  async function attempt(failure: Error | undefined, options: { requestId?: string } = {}) {
    const w = world();
    const id = await w.waitingChange();
    const calls: string[] = [];
    const proof = { kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: "2026-10-22T08:59:00.000Z", sessionRef: "d".repeat(64) };
    const documentClient = { send: (command: unknown) => {
      if (failure !== undefined && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") return Promise.reject(failure);
      return w.db.send(command as never);
    } };
    const deps = { ...w.deps, documentClient, requireDecide: async () => ({
      orgId: ORG_A, developerId: DANA, proof, finish: async () => { calls.push("finish"); }, release: async () => { calls.push("release"); },
    }) } as unknown as ApprovalDependencies;
    const body = { decision: "APPROVE", ...(options.requestId === undefined ? {} : { requestId: options.requestId }) };
    const outcome = await routeApprovalRequest(deps, caller(DANA, "admin"), { method: "POST", path: `/v1/app/approvals/${id}/decide`, requestId: "r", headers: {}, body: JSON.stringify(body) }, new URL(`${CELL}/v1/app/approvals/${id}/decide`))
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    return { w, id, calls, outcome, proof };
  }

  it("spends the session on a failure of ours at 500 and above, exactly 500 included, and gives it back below 500", async () => {
    for (const [status, expected] of [[503, "finish"], [500, "finish"], [499, "release"], [409, "release"]] as const) {
      const { calls, outcome } = await attempt(new AgentXError("RUNTIME_UNAVAILABLE", "trouble", status));
      expect("error" in outcome, String(status)).toBe(true);
      expect(calls, String(status)).toEqual([expected]);
    }
    // An error that is not one of ours may have partly happened: spent.
    expect((await attempt(new Error("socket hang up"))).calls).toEqual(["finish"]);
  });

  it("spends the session when the decision was made", async () => {
    const { calls, outcome, w, id } = await attempt(undefined);
    expect(outcome).toMatchObject({ value: { status: "APPROVED_DONE" } });
    expect(calls).toEqual(["finish"]);
    expect(await w.record(id)).toMatchObject({ status: "APPROVED_DONE" });
  });

  it("derives the request id from the session on this route too: the client's is not used", async () => {
    const { w, id, proof } = await attempt(undefined, { requestId: randomUUID() });
    expect((await w.record(id)).decisionRequestId).toBe(requestIdFor(proof, id));
    // Without a requestId in the body the decision still has one.
    const none = await attempt(undefined);
    expect((await none.w.record(none.id)).decisionRequestId).toBe(requestIdFor(none.proof, none.id));
  });
});

describe("what the page says of a write and of an expired approval (fix round 1: concern 3, m6)", () => {
  it("stores the agent's id and name on the write record when it is created, and the page shows the name from the record", async () => {
    const w = world();
    const id = await w.waitingWrite();
    expect((await w.record(id) as WriteApprovalRecord).agent).toEqual({ agentId: "agt_00000000000000000007", name: "Triage bot" });
    const shown = await w.page(id, { cookie: await w.session(BOB, id) });
    expect(shown.body).toContain("Triage bot");
    // The name is the record's, not a lookup: it survives a rename (nothing here reads the agent).
    const stored = w.db.get(approvalKey(ORG_A, id).pk, approvalKey(ORG_A, id).sk)!;
    w.db.set({ ...stored, agent: { agentId: "agt_00000000000000000007", name: "<b>Renamed</b>" } });
    const again = await w.page(id, { cookie: await w.session(BOB, id) });
    expect(again.body).toContain("&lt;b&gt;Renamed&lt;/b&gt;");
    expect(again.body).not.toContain("<b>Renamed");
  });

  it("says an approval expired, with the time, rather than that someone decided it: unswept and swept", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const expiresAt = (await w.record(id)).expiresAt;
    w.clock.now = Date.parse(expiresAt) + 1;
    const unswept = await w.page(id, { cookie: await w.session(BOB, id) });
    expect(unswept.statusCode).toBe(409);
    expect(unswept.body).toContain(`This request expired at ${expiresAt}.`);
    expect(unswept.body).not.toContain("already decided");
    await expireApprovals(w.deps, w.clock.now);
    expect(await w.record(id)).toMatchObject({ status: "EXPIRED" });
    const swept = await w.page(id, { cookie: await w.session(BOB, id) });
    expect(swept.body).toContain(`This request expired at ${expiresAt}.`);
    expect(swept.body).not.toContain("a teammate");
    // The bridge carries the same fact.
    expect(await w.kind.inspect({ orgId: ORG_A, developerId: BOB, approvalId: id })).toEqual({ status: "expired", at: expiresAt });
  });
});

describe("the session store gives a claim back (M-d)", () => {
  it("releases only a claimed, unexpired session, and leaves an unknown one alone", async () => {
    const w = world();
    const id = await w.waitingWrite();
    const cookie = await w.session(BOB, id);
    await w.decideStore.releaseSession(cookie);
    expect(await w.sessionOf(cookie)).toMatchObject({ approvalId: expect.stringMatching(/^apr_/) as string });
    expect((await w.sessionOf(cookie))?.usedAt).toBeUndefined();
    expect(await w.decideStore.claimSession(cookie, id)).toBe(true);
    expect(await w.decideStore.claimSession(cookie, id)).toBe(false);
    await w.decideStore.releaseSession(cookie);
    expect(await w.decideStore.claimSession(cookie, id)).toBe(true);
    await expect(w.decideStore.releaseSession("never-existed-".padEnd(40, "z"))).resolves.toBeUndefined();
    expect(w.db.find((item) => String(item.pk).startsWith("DECIDE_SESSION#"))).toHaveLength(1);
    // An expired session is not revived.
    await w.decideStore.releaseSession(cookie);
    w.clock.now += 11 * 60_000;
    expect(await w.decideStore.claimSession(cookie, id)).toBe(false);
  });
});

// ---- the bridge: the sign-in function asks the broker

describe("the sign-in function's kinds ask the broker (hand-off 1)", () => {
  const target = { orgId: ORG_A, developerId: BOB, approvalId: "apr_aaaaaaaaaaaaaaaaaaaa" };

  it("sends a decide-inspect request with the member and the approval, and maps each answer", async () => {
    const sent: DecideInspectRequest[] = [];
    const answers: unknown[] = [{ status: "open" }, { status: "forbidden", who: "Alice or a project maintainer" }, { status: "decided", by: "Bob", at: "2026-10-22T10:00:00.000Z" }, { status: "not_found" }, { status: "expired", at: "2026-10-22T10:00:00.000Z" }];
    const kinds = brokerDecideKinds({ invoke: async (request) => { sent.push(request); return answers.shift(); } });
    expect(Object.keys(kinds).sort()).toEqual(["apr", "spr"]);
    expect((await kinds.apr!.inspect(target)).status).toBe("open");
    expect(await kinds.apr!.inspect(target)).toEqual({ status: "forbidden", who: "Alice or a project maintainer" });
    expect(await kinds.spr!.inspect({ ...target, approvalId: "spr_aaaaaaaaaaaaaaaaaaaa" })).toEqual({ status: "decided", by: "Bob", at: "2026-10-22T10:00:00.000Z" });
    expect(await kinds.apr!.inspect(target)).toEqual({ status: "not_found" });
    expect(await kinds.apr!.inspect(target)).toEqual({ status: "expired", at: "2026-10-22T10:00:00.000Z" });
    expect(sent[0]).toEqual({ kind: "decide-inspect", orgId: ORG_A, developerId: BOB, approvalId: "apr_aaaaaaaaaaaaaaaaaaaa" });
    expect(sent[2]).toMatchObject({ approvalId: "spr_aaaaaaaaaaaaaaaaaaaa" });
  });

  it("fails closed on a bad answer, an extra field, or a refusal to answer, and never decides on the sign-in side", async () => {
    for (const bad of [undefined, null, "open", {}, { status: "open", view: { title: "x" } }, { status: "forbidden" }, { status: "decided", by: "Bob" }, { status: "maybe" }, { status: "open", call: {} }]) {
      const kinds = brokerDecideKinds({ invoke: async () => bad });
      await expect(kinds.apr!.inspect(target), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(brokerDecideKinds({ invoke: async () => { throw new Error("timed out"); } }).apr!.inspect(target)).rejects.toThrow();
    await expect(brokerDecideKinds({ invoke: async () => ({ status: "open" }) }).apr!.decide(target, "approve", { kind: "none" } as never)).rejects.toThrow();
  });

  it("invokes the named function, waiting for its answer, and reads the broker's {statusCode, body}", async () => {
    const calls: Array<{ command: { constructor: { name: string }; input: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array } }; options: unknown }> = [];
    const respond = (payload: unknown, extra: Record<string, unknown> = {}) => ({ send: async (command: never, options?: unknown) => {
      calls.push({ command: command, options });
      return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(payload)), ...extra };
    } });
    const request: DecideInspectRequest = { kind: "decide-inspect", ...target };
    const answer = await lambdaInspectInvoker(respond({ statusCode: 200, body: JSON.stringify({ status: "open" }) }), "agentx-staging-broker")(request);
    expect(answer).toEqual({ status: "open" });
    expect(calls[0]!.command.constructor.name).toBe("InvokeCommand");
    expect(calls[0]!.command.input).toMatchObject({ FunctionName: "agentx-staging-broker", InvocationType: "RequestResponse" });
    expect(JSON.parse(new TextDecoder().decode(calls[0]!.command.input.Payload))).toEqual(request);
    expect(calls[0]!.options).toMatchObject({ abortSignal: expect.anything() as unknown });
    // A function error, a non-200 answer, a non-JSON body, an empty payload and a failed call all throw.
    // The broker's envelope puts its requestId beside the answer; the answer is the rest.
    expect(await lambdaInspectInvoker(respond({ statusCode: 200, body: JSON.stringify({ status: "not_found", requestId: "decide-inspect" }) }), "f")(request)).toEqual({ status: "not_found" });
    await expect(lambdaInspectInvoker(respond({ errorMessage: "boom" }, { FunctionError: "Unhandled" }), "f")(request)).rejects.toThrow();
    await expect(lambdaInspectInvoker(respond({ statusCode: 400, body: "{}" }), "f")(request)).rejects.toThrow();
    await expect(lambdaInspectInvoker(respond({ statusCode: 200, body: "not json" }), "f")(request)).rejects.toThrow();
    await expect(lambdaInspectInvoker({ send: async () => ({ StatusCode: 200 }) }, "f")(request)).rejects.toThrow();
    await expect(lambdaInspectInvoker({ send: async () => { throw new Error("network"); } }, "f")(request)).rejects.toThrow();
  });
});

describe("the sign-in function's kinds come from its environment", () => {
  const target = { orgId: ORG_A, developerId: BOB, approvalId: "apr_aaaaaaaaaaaaaaaaaaaa" };
  it("has none (every approval is not found) with no broker function named, and asks the named one otherwise", async () => {
    const sent: unknown[] = [];
    const lambda = { send: async (command: unknown) => {
      sent.push((command as { input: { FunctionName?: string } }).input.FunctionName);
      return { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: JSON.stringify({ status: "open" }) })) };
    } };
    expect(decideKindsFromEnvironment({}, lambda)).toEqual({});
    expect(decideKindsFromEnvironment({ DECIDE_INSPECT_FUNCTION_NAME: "" }, lambda)).toEqual({});
    const kinds = decideKindsFromEnvironment({ DECIDE_INSPECT_FUNCTION_NAME: "agentx-staging-broker" }, lambda);
    expect((await kinds.apr!.inspect(target)).status).toBe("open");
    expect(sent).toEqual(["agentx-staging-broker"]);
  });
});

// ---- the broker: wiring, the decide-inspect event, tickets for a token

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const B_DANA = person("1", "Dana"); // org admin
const B_MAX = person("2", "Max"); // maintainer of web
const B_CARL = person("3", "Carl"); // contributor on web
const BROKER_CELL = new URL(DEV_ISSUER).origin;

beforeAll(async () => { await loadSlackBroker(); });

async function brokerWorld(options: { decide?: boolean } = {}) {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: { agents: { projectMembers: members }, ...(options.decide === false ? {} : { decide: {} }) },
  });
  for (const [who, role] of [[B_DANA, "admin"], [B_MAX, "member"], [B_CARL, "member"]] as const) {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  }
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  members.grant(TEST_ORG, "web", B_MAX.developerId, "maintainer");
  members.grant(TEST_ORG, "web", B_CARL.developerId, "contributor");
  registerAgentApprovals();
  const applied: Array<{ approvalId: string; decidedBy: string | undefined; proof: unknown }> = [];
  registerApprovalSubjectHandler("agent_publish", async (_deps, record, decision) => { applied.push({ approvalId: record.approvalId, decidedBy: record.decidedBy, proof: decision?.proof }); });
  const store = new DecideStore({ documentClient: h.db, tableName: "signin", now: Date.now });
  const storeDeps = { documentClient: h.db, tableName: "state", now: Date.now };
  const waiting = async () => (await createPendingChange(storeDeps, {
    orgId: TEST_ORG, requestId: randomUUID(), requestedBy: B_MAX.developerId,
    subject: { kind: "agent_publish", agentId: "agt_00000000000000000001", draftRevision: 3, digest: "d".repeat(64), expectedCurrentVersion: 1 },
    changes: ["Publishes the draft of Triage as version 2"], approvers: { kind: "rule", rule: "org_admin", candidates: [B_DANA.developerId] },
  })).approvalId;
  const status = (approvalId: string) => (h.db.get(approvalKey(TEST_ORG, approvalId).pk, approvalKey(TEST_ORG, approvalId).sk) as { status: string } | undefined)?.status;
  const raw = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) => {
    const response = await h.handler({
      version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers,
      ...(body === undefined ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } },
    }) as { statusCode: number; headers: Record<string, string>; body: string };
    return response;
  };
  const session = async (who: Developer, approvalId: string) => {
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await store.putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return cookie;
  };
  return { ...h, members, store, applied, waiting, status, raw, session };
}

describe("through the broker: a token is sent to the page, and the page decides", () => {
  it("answers a token's POST to the decide route with REAUTH_REQUIRED, 401 and a ticketed confirmUrl, and changes nothing", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const reply = await b.dev(B_DANA, "POST", `/v1/app/approvals/${id}/decide`, { requestId: randomUUID(), decision: "APPROVE" });
    expect(reply.status).toBe(401);
    const error = reply.body.error as { code: string; confirmUrl: string; message: string };
    expect(error.code).toBe("REAUTH_REQUIRED");
    expect(error.confirmUrl).toMatch(new RegExp(`^${BROKER_CELL}/v1/app/approve/${id}\\?ticket=[A-Za-z0-9_-]{43}$`));
    expect(error.message).toBe(`Decisions are made in your browser. Open ${error.confirmUrl}.`);
    expect(b.status(id)).toBe("PENDING");
    expect(b.applied).toEqual([]);
    expect(await b.store.redeemTicket(new URL(error.confirmUrl).searchParams.get("ticket")!)).toMatchObject({ developerId: B_DANA.developerId, approvalId: id, orgId: TEST_ORG });
  });

  it("gives a member who may not decide it 403 and no ticket, and another org's member 404", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const refused = await b.dev(B_CARL, "POST", `/v1/app/approvals/${id}/decide`, { requestId: randomUUID(), decision: "APPROVE" });
    expect(refused.status).toBe(403);
    const stranger = await b.dev(person("4", "Omar"), "POST", `/v1/app/approvals/${id}/decide`, { requestId: randomUUID(), decision: "APPROVE" }).catch(() => ({ status: 401 }));
    expect([401, 403, 404]).toContain(stranger.status);
    expect(b.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
    expect(b.status(id)).toBe("PENDING");
  });

  it("shows the bare link on every read, however many, and mints a ticket only when asked: POST confirm-link", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const bare = `${BROKER_CELL}/v1/app/approve/${id}`;
    for (let index = 0; index < 12; index += 1) {
      const shown = await b.dev(B_DANA, "GET", `/v1/app/approvals/${id}`);
      expect(shown.status).toBe(200);
      expect((shown.body.approval as { confirmUrl: string }).confirmUrl).toBe(bare);
    }
    const listed = await b.dev(B_DANA, "GET", "/v1/app/approvals");
    expect((listed.body.approvals as Array<{ confirmUrl: string }>).map((entry) => entry.confirmUrl)).toEqual([bare]);
    expect(b.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
    // After all those reads the member can still mint, and the ticket is the first.
    const asked = await b.dev(B_DANA, "POST", `/v1/app/approvals/${id}/confirm-link`, {});
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ ticketed: true, confirmUrl: expect.stringMatching(new RegExp(`^${bare}\\?ticket=[A-Za-z0-9_-]{43}$`)) as string });
    const ticket = new URL((asked.body as { confirmUrl: string }).confirmUrl).searchParams.get("ticket")!;
    expect(await b.store.redeemTicket(ticket)).toMatchObject({ developerId: B_DANA.developerId, approvalId: id, mintedBy: "token" });
  });

  it("gives the bare link and no ticket to someone who can see the approval but not decide it, and 404 to someone who can't see it", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const asked = await b.dev(B_MAX, "POST", `/v1/app/approvals/${id}/confirm-link`, {});
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ ticketed: false, confirmUrl: `${BROKER_CELL}/v1/app/approve/${id}` });
    expect((await b.dev(B_CARL, "POST", `/v1/app/approvals/${id}/confirm-link`, {})).status).toBe(404);
    expect(b.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
  });

  it("decides on the page with a fresh session, the cell's Origin and the CSRF field: the change is applied once, with the session's proof", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const cookie = await b.session(B_DANA, id);
    const headers = { cookie: `${DECIDE_COOKIE}=${cookie}` };
    const shown = await b.raw("GET", `/v1/app/approve/${id}`, headers);
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toContain("Publishes the draft of Triage as version 2");
    const form = { ...headers, origin: BROKER_CELL, "content-type": "application/x-www-form-urlencoded" };
    const wrong = await b.raw("POST", `/v1/app/approve/${id}`, { ...form, origin: "https://evil.example" }, new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString());
    expect(wrong.statusCode).toBe(403);
    expect(b.status(id)).toBe("PENDING");
    const done = await b.raw("POST", `/v1/app/approve/${id}`, form, new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString());
    expect(done.statusCode, done.body).toBe(200);
    expect(b.status(id)).toBe("APPROVED_DONE");
    expect(b.applied).toHaveLength(1);
    expect(b.applied[0]).toMatchObject({ approvalId: id, decidedBy: B_DANA.developerId, proof: { kind: "fresh_sign_in", method: "email_code" } });
    const again = await b.raw("POST", `/v1/app/approve/${id}`, form, new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString());
    expect(again.statusCode).toBe(401);
    expect(b.applied).toHaveLength(1);
  });

  it("sends a browser with no session to the identify step, and a ticket to the start of the sign-in", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const bare = await b.raw("GET", `/v1/app/approve/${id}`);
    expect(bare.statusCode).toBe(302);
    expect(bare.headers.location).toBe(`/v1/auth/decide/identify?return=/v1/app/approve/${id}`);
    const ticket = await b.store.mintTicket({ orgId: TEST_ORG, developerId: B_DANA.developerId, approvalId: id, mintedBy: "token" });
    const ticketed = await b.raw("GET", `/v1/app/approve/${id}?ticket=${ticket}`);
    expect(ticketed.headers.location).toBe(`/v1/auth/decide/start?ticket=${ticket}`);
  });

  it("answers the page with NOT_FOUND on an install that has no confirmation page set up", async () => {
    const b = await brokerWorld({ decide: false });
    const id = await b.waiting();
    expect((await b.raw("GET", `/v1/app/approve/${id}`)).statusCode).toBe(404);
  });
});

describe("the broker's decide-inspect event (what the sign-in function asks)", () => {
  const inspect = async (b: Awaited<ReturnType<typeof brokerWorld>>, event: Record<string, unknown>) => {
    const response = await b.handler(event);
    // The broker's envelope adds `requestId` to every JSON answer; the invoker on the sign-in side drops it (tested above).
    const { requestId: _requestId, ...body } = JSON.parse(response.body) as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's
    return { status: response.statusCode, body };
  };

  it("answers open, forbidden, decided and not_found from the same live evaluation as the page, and never returns the approval", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const ask = (developerId: string, approvalId = id, orgId: string = TEST_ORG) => inspect(b, { kind: "decide-inspect", orgId, developerId, approvalId });
    expect(await ask(B_DANA.developerId)).toEqual({ status: 200, body: { status: "open" } });
    expect(await ask(B_CARL.developerId)).toEqual({ status: 200, body: { status: "forbidden", who: expect.stringContaining("admin") as string } });
    expect(await ask(B_DANA.developerId, "apr_zzzzzzzzzzzzzzzzzzzz")).toEqual({ status: 200, body: { status: "not_found" } });
    expect(await ask(B_DANA.developerId, id, "org_bbbbbbbbbbbbbbbbbbbb")).toEqual({ status: 200, body: { status: "not_found" } });
    expect(await ask(B_DANA.developerId, "spr_aaaaaaaaaaaaaaaaaaaa")).toEqual({ status: 200, body: { status: "not_found" } });
    // A member added to the admins after the approval was made (absent from its candidates) may decide it; the stored candidates are never consulted.
    expect(await ask(B_MAX.developerId)).toMatchObject({ body: { status: "forbidden" } });
    seedMembership(b.db, B_MAX.developerId, { orgId: TEST_ORG, role: "admin" });
    expect(await ask(B_MAX.developerId)).toEqual({ status: 200, body: { status: "open" } });
    // Decided: the name and the time, nothing else.
    const cookie = await b.session(B_DANA, id);
    const form = { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: BROKER_CELL, "content-type": "application/x-www-form-urlencoded" };
    expect((await b.raw("POST", `/v1/app/approve/${id}`, form, new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString())).statusCode).toBe(200);
    const decided = await ask(B_DANA.developerId);
    expect(decided.body).toEqual({ status: "decided", by: "Dana", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string });
  });

  it("answers expired, with the time, for an approval past its time that the sweep has not ended", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const key = approvalKey(TEST_ORG, id);
    const stored = b.db.get(key.pk, key.sk)!;
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    b.db.set({ ...stored, expiresAt });
    expect(await inspect(b, { kind: "decide-inspect", orgId: TEST_ORG, developerId: B_DANA.developerId, approvalId: id })).toEqual({ status: 200, body: { status: "expired", at: expiresAt } });
  });

  it("refuses a malformed request without evaluating anything", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const good = { kind: "decide-inspect", orgId: TEST_ORG, developerId: B_DANA.developerId, approvalId: id };
    for (const bad of [{ ...good, extra: 1 }, { ...good, approvalId: "apr_short" }, { ...good, developerId: "nope" }, { ...good, orgId: "org_x" }, { kind: "decide-inspect" }]) {
      expect((await inspect(b, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("is reached only by a direct invoke: an HTTP request carrying the same words is an ordinary request", async () => {
    const b = await brokerWorld();
    const id = await b.waiting();
    const viaHttp = await b.handler({
      version: "2.0", rawPath: "/v1/app/approvals", rawQueryString: "", headers: {}, routeKey: "ANY /v1/app/{proxy+}",
      kind: "decide-inspect", orgId: TEST_ORG, developerId: B_DANA.developerId, approvalId: id,
      requestContext: { requestId: "r", http: { method: "GET" } },
    });
    expect(JSON.parse(viaHttp.body)).not.toHaveProperty("status", "open");
    expect(viaHttp.statusCode).toBeGreaterThanOrEqual(400);
    const viaBody = await b.raw("POST", "/v1/app/approvals", {}, JSON.stringify({ kind: "decide-inspect", orgId: TEST_ORG, developerId: B_DANA.developerId, approvalId: id }));
    expect(viaBody.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("answers not_found for everything on an install without the confirmation page", async () => {
    const b = await brokerWorld({ decide: false });
    const id = await b.waiting();
    expect(await inspect(b, { kind: "decide-inspect", orgId: TEST_ORG, developerId: B_DANA.developerId, approvalId: id })).toEqual({ status: 200, body: { status: "not_found" } });
  });
});

void MAYA;

it("shows a structured stage refusal repair link on the real confirmation result page",async()=>{
 const {ProcessModelRefusal}=await import("../../packages/broker/src/model-selection/process-refusal.js");
 const w=world(),id=await w.waitingChange();registerApprovalSubjectHandler("agent_publish",async()=>{throw new ProcessModelRefusal("STAGE_LOCKED","build","/app/admin/how-we-work");});
 const response=await w.decide(id,await w.session(DANA,id));expect(response.statusCode).toBe(200);expect(response.body).toContain('href="/app/admin/how-we-work"');expect(response.body).toContain("build: STAGE_LOCKED");
 expect(await w.record(id)).toMatchObject({status:"APPROVED_FAILED",modelRefusal:{code:"STAGE_LOCKED",reason:"STAGE_LOCKED",stage:"build",fixHref:"/app/admin/how-we-work"}});
});
