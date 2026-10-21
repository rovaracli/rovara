// Plan 2, Task 14: ask my GitHub admin. A Rovara owner or admin who is not an admin of their GitHub organization asks its admin to approve the
// App; GitHub's `installation.created` webhook then names the requester, and Rovara binds the installation to the requester's org only when
// every check holds. Everything here runs against fakes: a fake table, a fake GitHub (token exchange, /user), a fake GitHub App and a fake SES.
import { createHash, createHmac } from "node:crypto";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  GITHUB_INSTALL_REQUEST_TTL_MS, agentXError, githubAuditKey, githubDeliveryKey, githubInstallRequestKey, githubInstallRequestQueueKey, githubInstallationEverBoundKey,
  githubInstallationKey, githubInstallRequestCopy, orgGithubInstallRequestKey, orgGithubInstallationKey, orgMemberKey, orgMetaKey, trialGithubKey, type OrgId,
} from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { handleGithubWebhook } from "../../packages/broker/src/aws/github-webhooks.js";
import { routeGithubInstall } from "../../packages/broker/src/aws/github-install-web.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { GitHubInstallation } from "../../packages/broker/src/github-app.js";
import { completeGithubConnect, startGithubConnect, type GithubConnectionDependencies } from "../../packages/broker/src/org/github-connection.js";
import type { GithubConnectedNotice, GithubRequestReminder } from "../../packages/broker/src/org/github-connect-support.js";
import {
  bindRequestedInstallation, cancelInstallRequest, listInstallRequests, recordInstallRequest, sendInstallRequestReminders, type InstallationCreatedPayload,
} from "../../packages/broker/src/org/github-install-requests.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { unlockTrial } from "../../packages/broker/src/org/trial.js";
import { githubConnectedNoticeText, githubConnectedNoticeSubject, githubRequestReminderText, GITHUB_REQUEST_REMINDER_SUBJECT } from "../../packages/broker/src/developer/identity-notice.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { routeFetch } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const CELL = "https://abc123.execute-api.us-east-1.amazonaws.com";
const CLIENT_ID = "Iv1.rovaraclient";
const CLIENT_SECRET = "client-secret-value-9f3a";

// Rovara developers of TEST_ORG: two owners (one with no email on record), an admin (the requester R) and a member. Org B: its own admin Q.
const OWNER = "owner-dev";
const OWNER2 = "owner2-dev";
const OWNER_NO_EMAIL = "owner3-dev";
const R = "admin-dev";
const MEMBER = "member-dev";
const Q = "q-dev";
const QB_OWNER = "b-owner-dev";
// Their GitHub accounts.
const R_ID = 4343;
const R_LOGIN = "rhea";
const Q_ID = 5151;
const Q_LOGIN = "quinn";
const STRANGER_ID = 9999;
const APPROVER = { id: 777, login: "gh-admin" };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

interface GhUser { id: number; login: string }

/** github.com's token exchange and api.github.com's `/user` and token revocation. A code maps to the token it exchanges for. */
function fakeGithub(users: Record<string, GhUser>, codes: Record<string, string>) {
  const revoked: string[] = [];
  const handler = async (url: URL, init: RequestInit | undefined): Promise<Response | undefined> => {
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const token = codes[form.get("code") ?? ""];
      return token === undefined ? Response.json({ error: "bad_verification_code" }) : Response.json({ access_token: token, token_type: "bearer" });
    }
    if (url.origin !== "https://api.github.com") return undefined;
    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    if ((init?.method ?? "GET") === "DELETE" && url.pathname === `/applications/${CLIENT_ID}/token`) {
      revoked.push((JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { access_token: string }).access_token);
      return new Response(null, { status: 204 });
    }
    const user = users[authorization.replace("Bearer ", "")];
    if (user === undefined) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/user") return Response.json({ id: user.id, login: user.login });
    return undefined;
  };
  return { handler, revoked };
}

const ACME = { login: "acme", id: 900, type: "Organization" as const };
const install = (id: number, account: GitHubInstallation["account"] = ACME): GitHubInstallation => ({ id, account, repositorySelection: "selected", suspendedAt: null });

type Membership = { state: string; role: string };
const DEFAULT_MEMBERSHIPS: Record<string, Membership> = {
  [`acme/${R_LOGIN}`]: { state: "active", role: "member" },
  [`acme/${Q_LOGIN}`]: { state: "active", role: "member" },
  [`acme/${APPROVER.login}`]: { state: "active", role: "admin" },
};

/** A table with TEST_ORG (owners, an admin R, a member) and ORG_B, their GitHub accounts linked, and fakes for GitHub, its App and SES. */
function world(options: { installs?: Record<number, GitHubInstallation>; memberships?: Record<string, Membership> } = {}) {
  const db = new FakeDynamoDb();
  db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme <Corp>", createdAt: "2026-10-01T00:00:00.000Z", createdBy: OWNER, plan: "trial" });
  db.set({ ...orgMetaKey(ORG_B), entityType: "ORG", orgId: ORG_B, name: "Beta", createdAt: "2026-10-01T00:00:00.000Z", createdBy: QB_OWNER, plan: "trial" });
  const member = (orgId: OrgId, developerId: string, role: "owner" | "admin" | "member", joinedAt: string) =>
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt });
  member(TEST_ORG, OWNER, "owner", "2026-10-01T00:00:00.000Z");
  member(TEST_ORG, OWNER2, "owner", "2026-10-02T00:00:00.000Z");
  member(TEST_ORG, OWNER_NO_EMAIL, "owner", "2026-10-03T00:00:00.000Z");
  member(TEST_ORG, R, "admin", "2026-10-04T00:00:00.000Z");
  member(TEST_ORG, MEMBER, "member", "2026-10-05T00:00:00.000Z");
  member(ORG_B, QB_OWNER, "owner", "2026-10-01T00:00:00.000Z");
  member(ORG_B, Q, "admin", "2026-10-02T00:00:00.000Z");
  const developer = (developerId: string, displayName: string, email: string | undefined, github?: { id: number }) => {
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: github === undefined ? "cloud" : "github", displayName, ...(email === undefined ? {} : { email }), firstSignInAt: "x", lastSignInAt: "x", revoked: false, issuer: github === undefined ? "https://cognito.example" : "https://github.com", subject: github === undefined ? developerId : String(github.id) });
    if (github === undefined) return;
    const identityKey = ownerKeyForSubject("https://github.com", String(github.id));
    const fields = { developerId, provider: "github", issuer: "https://github.com", subject: String(github.id), linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" };
    db.set({ pk: `SIGNIN_IDENTITY#${identityKey}`, sk: "META", entityType: "IDENTITY_LINK", ...fields });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: `IDENTITY#${identityKey}`, entityType: "DEVELOPER_IDENTITY", ...fields });
  };
  developer(OWNER, "Olive Owner", "olive@acme.test", { id: 4242 });
  developer(OWNER2, "Sam Second", "sam@acme.test");
  developer(OWNER_NO_EMAIL, "No Email", undefined);
  developer(R, "Rhea Requester", "rhea@acme.test", { id: R_ID });
  developer(MEMBER, "Mel Member", "mel@acme.test", { id: 4444 });
  developer(Q, "Quinn Q", "quinn@beta.test", { id: Q_ID });
  developer(QB_OWNER, "Bea Owner", "bea@beta.test");

  const installs = options.installs ?? { 601: install(601) };
  const memberships = { ...DEFAULT_MEMBERSHIPS, ...options.memberships };
  const github = fakeGithub(
    { ghu_r: { id: R_ID, login: R_LOGIN }, ghu_q: { id: Q_ID, login: Q_LOGIN }, ghu_member: { id: 4444, login: "mel" }, ghu_stranger: { id: STRANGER_ID, login: "stranger" }, ghu_owner: { id: 4242, login: "olivia" } },
    { codeR: "ghu_r", codeR2: "ghu_r", codeQ: "ghu_q", codeMember: "ghu_member", codeStranger: "ghu_stranger", codeOwner: "ghu_owner" },
  );
  const fetch = routeFetch(github.handler);
  const logs: Array<Record<string, unknown>> = [];
  let clock = NOW;
  const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
  const unlock = vi.fn((input: { orgId: OrgId; githubUserId: string }) => unlockTrial({ documentClient: db, tableName: "state", now: () => clock }, input));
  const notices: GithubConnectedNotice[] = [];
  const reminders: GithubRequestReminder[] = [];
  const membership = vi.fn(async (_installationId: number, org: string, login: string) => memberships[`${org}/${login}`]);
  const deps: GithubConnectionDependencies = {
    documentClient: db, tableName: "state", now: () => clock, cloud: true, origin: CELL,
    app: {
      appSlug: async () => "rovara-cloud",
      oauthClient: async () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      installation: async (id) => { const found = installs[id]; if (found === undefined) throw agentXError("NOT_FOUND", "GitHub has no such installation of this App"); return found; },
      orgMembership: membership,
    },
    identities: signIn, orgs: new OrgStore({ documentClient: db, tableName: "state", now: () => clock }), unlockTrial: unlock,
    notifyGithubConnected: async (notice) => { notices.push(notice); },
    remindGithubRequester: async (reminder) => { reminders.push(reminder); },
    fetch, log: (entry) => logs.push(entry),
  };
  return { db, deps, fetch, github, logs, unlock, notices, reminders, membership, memberships, advance: (ms: number) => { clock += ms; }, now: () => clock };
}
type World = ReturnType<typeof world>;

const callerOf = (developerId: string, orgId: OrgId = TEST_ORG, orgRole: "owner" | "admin" | "member" = "admin") => ({ developerId, orgId, orgRole });
const R_CALLER = callerOf(R);

/** Starts a connect as `caller` and returns the state the install link carries. */
async function start(w: World, caller = R_CALLER) {
  const started = await startGithubConnect(w.deps, caller);
  const state = new URL(started.installUrl).searchParams.get("state")!;
  return { ...started, state, stateHash: sha(state) };
}

/** The request callback of GitHub's "Request": a non-admin member asked, GitHub sends the browser back with the user authorization code. */
async function ask(w: World, code = "codeR", caller = R_CALLER) {
  const started = await start(w, caller);
  const outcome = await completeGithubConnect(w.deps, { setup_action: "request", state: started.state, code });
  return { ...started, outcome };
}

const isoAt = (ms: number) => new Date(ms).toISOString();
/** An `installation.created` payload as GitHub sends it for an approved request. */
const created = (w: World, over: { id?: number; createdAtMs?: number | string; requester?: InstallationCreatedPayload["requester"]; sender?: InstallationCreatedPayload["sender"]; account?: InstallationCreatedPayload["installation"]["account"] } = {}): InstallationCreatedPayload => ({
  installation: { id: over.id ?? 601, created_at: over.createdAtMs ?? isoAt(w.now() + HOUR), account: over.account ?? ACME },
  requester: "requester" in over ? over.requester! : { id: R_ID, login: R_LOGIN },
  sender: over.sender ?? APPROVER,
});
let deliveryCounter = 0;
const nextDelivery = () => `550e8400-e29b-41d4-a716-${String(446655440000 + (deliveryCounter += 1))}`;

const auditItems = (w: World, orgId: OrgId = TEST_ORG) => w.db.find((item) => item.pk === `ORG#${orgId}#GITHUB_AUDIT`);
const boundTo = (w: World, id: number) => (w.db.get(githubInstallationKey(id)) as { orgId?: string } | undefined)?.orgId;
const requestOf = (w: World, githubUserId: number | string = R_ID) => w.db.get(githubInstallRequestKey(String(githubUserId))) as Record<string, unknown> | undefined;
const orgRequestOf = (w: World, githubUserId: number | string = R_ID, orgId: OrgId = TEST_ORG) => w.db.get(orgGithubInstallRequestKey(orgId, String(githubUserId))) as Record<string, unknown> | undefined;

describe("keys and copy", () => {
  it("keys: the global request, the org's copy, the reminder queue, the delivery and the audit item", () => {
    expect(githubInstallRequestKey("4343")).toEqual({ pk: "GITHUB_INSTALL_REQUEST#4343", sk: "META" });
    expect(orgGithubInstallRequestKey(TEST_ORG, "4343")).toEqual({ pk: `ORG#${TEST_ORG}`, sk: "GITHUB_INSTALL_REQUEST#4343" });
    expect(githubInstallRequestQueueKey(1_000, "4343")).toEqual({ pk: "GITHUB_INSTALL_REQUEST_QUEUE", sk: "1000#4343" });
    expect(githubDeliveryKey("d1")).toEqual({ pk: "GITHUB_DELIVERY#d1", sk: "INSTALL_REQUEST" });
    expect(githubAuditKey(TEST_ORG, "2026-10-21T12:00:00.000Z", "u1")).toEqual({ pk: `ORG#${TEST_ORG}#GITHUB_AUDIT`, sk: "2026-10-21T12:00:00.000Z#u1" });
    expect(githubInstallationEverBoundKey(601)).toEqual({ pk: "GITHUB_INSTALLATION#601", sk: "EVER_BOUND" });
    expect(GITHUB_INSTALL_REQUEST_TTL_MS).toBe(7 * DAY);
  });

  it("says the exact words of every state", () => {
    const names = { account: "acme", orgName: "Acme", ownerName: "Olive" };
    expect(githubInstallRequestCopy("waiting", names)).toEqual({
      title: "Waiting for your GitHub admin",
      lines: [
        "You asked an admin of your GitHub organization to approve Rovara. Once they approve it on GitHub, Rovara connects it to Acme and tells your organization's owners. The request stays open for 7 days.",
        "GitHub doesn't show your admin which Rovara organization asked. Tell them: for Rovara org Acme (owner Olive).",
      ],
    });
    expect(githubInstallRequestCopy("connected", names).title).toBe("Your GitHub admin approved Rovara. acme is now connected to Acme.");
    expect(githubInstallRequestCopy("declined").title).toBe("Your GitHub admin declined the request. Ask them about it, or ask them to run agentx github connect.");
    expect(githubInstallRequestCopy("expired").title).toBe("Your request wasn't approved within 7 days, or your GitHub admin declined it. Run agentx github connect to ask again.");
    expect(githubInstallRequestCopy("taken").title).toBe("This GitHub account is already connected to another Rovara organization.");
    expect(githubInstallRequestCopy("reinstall_needed", names).title).toBe("acme was connected to Rovara before, so an approval can't reconnect it on its own. Ask an admin of acme on GitHub to uninstall Rovara and approve a new request, or to run agentx github connect themselves.");
  });
});

describe("the request callback (recordInstallRequest)", () => {
  it("an org admin's request is recorded as waiting, in both places, with a queue item, a 7 day window, and the user token revoked once", async () => {
    const w = world();
    const asked = await ask(w);
    expect(asked.outcome).toMatchObject({ outcome: "requested", orgName: "Acme <Corp>", ownerName: "Olive Owner" });
    const expected = { orgId: TEST_ORG, developerId: R, githubUserId: String(R_ID), githubLogin: R_LOGIN, requestedAt: NOW, expiresAt: NOW + 7 * DAY, status: "waiting" };
    expect(requestOf(w)).toMatchObject(expected);
    expect(orgRequestOf(w)).toMatchObject(expected);
    expect(requestOf(w)).not.toHaveProperty("requestedAccountLogin");
    expect(w.db.get(githubInstallRequestQueueKey(NOW, String(R_ID)))).toBeDefined();
    expect(w.db.get({ pk: `GITHUB_CONNECT#${asked.stateHash}`, sk: "META" })).toHaveProperty("consumedAt");
    expect(w.github.revoked).toEqual(["ghu_r"]);
    // Asking binds nothing and unlocks nothing.
    expect(boundTo(w, 601)).toBeUndefined();
    expect(w.unlock).not.toHaveBeenCalled();
  });

  it("only owners and admins start a request: a member gets FORBIDDEN from the start", async () => {
    const w = world();
    await expect(startGithubConnect(w.deps, callerOf(MEMBER, TEST_ORG, "member"))).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("only an owner or admin can connect GitHub") as string });
  });

  it("a state whose developer was demoted to member meanwhile records nothing, and says so", async () => {
    const w = world();
    const started = await start(w);
    w.db.set({ ...orgMemberKey(TEST_ORG, R), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: R, role: "member", joinedAt: "x" });
    await expect(recordInstallRequest(w.deps, { stateHash: started.stateHash }, { code: "codeR" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("only an owner or admin can connect GitHub") as string });
    expect(requestOf(w)).toBeUndefined();
    expect(orgRequestOf(w)).toBeUndefined();
    expect(w.github.revoked).toEqual(["ghu_r"]);
    // Through the callback the person sees the page that says they are no longer an owner or admin.
    const again = await start(w, R_CALLER);
    expect((await completeGithubConnect(w.deps, { setup_action: "request", state: again.state, code: "codeR" })).outcome).toBe("not_allowed");
    expect(requestOf(w)).toBeUndefined();
  });

  it("a GitHub account that is not linked to the state's developer records nothing", async () => {
    const w = world();
    const started = await start(w);
    expect(await recordInstallRequest(w.deps, { stateHash: started.stateHash }, { code: "codeStranger" })).toBe("not_linked");
    expect(requestOf(w, STRANGER_ID)).toBeUndefined();
    // Another developer's linked account is not this developer's either.
    const other = await start(w);
    expect(await recordInstallRequest(w.deps, { stateHash: other.stateHash }, { code: "codeOwner" })).toBe("not_linked");
    expect(requestOf(w, 4242)).toBeUndefined();
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_INSTALL_REQUEST"))).toEqual([]);
    expect(w.github.revoked).toEqual(["ghu_stranger", "ghu_owner"]);
  });

  it("a callback with no code attributes nothing: expired, nothing recorded, no token exchange, logged github.install_request_unattributed", async () => {
    const w = world();
    const started = await start(w);
    expect(await recordInstallRequest(w.deps, { stateHash: started.stateHash }, {})).toBe("expired");
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_INSTALL_REQUEST"))).toEqual([]);
    expect(w.fetch.calls).toEqual([]);
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "github.install_request_unattributed", orgId: TEST_ORG, reason: "no_code" }));
    // And through the callback: the state is used up, the page is the expired one, and a later delivery has no request to match.
    const second = await start(w);
    expect((await completeGithubConnect(w.deps, { setup_action: "request", state: second.state })).outcome).toBe("expired");
    expect(requestOf(w)).toBeUndefined();
    const delivery = await bindRequestedInstallation(w.deps, nextDelivery(), created(w));
    expect(delivery).toBe("ignored");
    expect(boundTo(w, 601)).toBeUndefined();
  });

  it("a code GitHub refuses, or a state that is used or expired, records nothing", async () => {
    const w = world();
    const refused = await start(w);
    expect(await recordInstallRequest(w.deps, { stateHash: refused.stateHash }, { code: "nope" })).toBe("expired");
    const used = await ask(w);
    expect(used.outcome.outcome).toBe("requested");
    expect(await recordInstallRequest(w.deps, { stateHash: used.stateHash }, { code: "codeR" })).toBe("expired");
    const old = await start(w);
    w.advance(16 * 60_000);
    expect(await recordInstallRequest(w.deps, { stateHash: old.stateHash }, { code: "codeR" })).toBe("expired");
  });

  it("a new request replaces one that is not waiting, and the same developer's waiting one; the old queue item goes", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    await ask(w, "codeR2");
    expect(requestOf(w)).toMatchObject({ requestedAt: NOW + HOUR, status: "waiting" });
    expect(w.db.get(githubInstallRequestQueueKey(NOW, String(R_ID)))).toBeUndefined();
    expect(w.db.get(githubInstallRequestQueueKey(NOW + HOUR, String(R_ID)))).toBeDefined();
    await cancelInstallRequest(w.deps, R_CALLER, String(R_ID));
    w.advance(HOUR);
    await ask(w);
    expect(requestOf(w)).toMatchObject({ requestedAt: NOW + 2 * HOUR, status: "waiting" });
  });

  it("another developer's waiting request is replaced only when the GitHub identity is no longer theirs, and the replacement is audited", async () => {
    const w = world();
    // The GitHub user 4343 asked as developer MEMBER-of-nothing: a waiting record held by another developer whose link still stands.
    w.db.set({ ...githubInstallRequestKey(String(R_ID)), entityType: "GITHUB_INSTALL_REQUEST", orgId: ORG_B, developerId: Q, githubUserId: String(R_ID), githubLogin: R_LOGIN, requestedAt: NOW - HOUR, expiresAt: NOW + 6 * DAY, status: "waiting" });
    w.db.set({ ...orgGithubInstallRequestKey(ORG_B, String(R_ID)), entityType: "GITHUB_INSTALL_REQUEST", orgId: ORG_B, developerId: Q, githubUserId: String(R_ID), githubLogin: R_LOGIN, requestedAt: NOW - HOUR, expiresAt: NOW + 6 * DAY, status: "waiting" });
    // The identity is linked to R, not Q: R's request replaces it (it is no longer Q's), and the replacement is audited in R's org.
    await ask(w);
    expect(requestOf(w)).toMatchObject({ orgId: TEST_ORG, developerId: R, status: "waiting" });
    expect(orgRequestOf(w, R_ID, ORG_B)).toBeUndefined();
    expect(auditItems(w)).toEqual([expect.objectContaining({ action: "install_request_replaced", replacedDeveloperId: Q, replacedOrgId: ORG_B, developerId: R })]);
  });
});

describe("the installation.created delivery (bindRequestedInstallation)", () => {
  it("happy path: binds the installation to the requester's org, writes the tombstone and the audit item, unlocks the trial with the requester's id, and tells each owner once", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    const delivery = nextDelivery();
    expect(await bindRequestedInstallation(w.deps, delivery, created(w))).toBe("bound");
    const at = isoAt(w.now());
    const record = { installationId: 601, orgId: TEST_ORG, accountLogin: "acme", accountId: 900, accountType: "Organization", repositorySelection: "selected", installedByGithubUserId: String(R_ID), boundByDeveloperId: R, status: "active", boundAt: at, updatedAt: at };
    expect(w.db.get(githubInstallationKey(601))).toMatchObject(record);
    expect(w.db.get(orgGithubInstallationKey(TEST_ORG, 601))).toMatchObject(record);
    expect(w.db.get(githubInstallationEverBoundKey(601))).toMatchObject({ firstBoundAt: at, firstOrgId: TEST_ORG });
    for (const item of [requestOf(w), orgRequestOf(w)]) {
      expect(item).toMatchObject({ status: "connected", installationId: 601, accountLogin: "acme", approvedBy: { githubUserId: "777", login: "gh-admin" }, decidedAt: w.now() });
    }
    expect(w.db.get(githubInstallRequestQueueKey(NOW, String(R_ID)))).toBeUndefined();
    expect(w.db.get(githubDeliveryKey(delivery))).toMatchObject({ processedAt: at, expiresAt: w.now() + 30 * DAY });
    expect(auditItems(w)).toEqual([expect.objectContaining({
      action: "install_request_bound", requester: { githubUserId: "4343", login: "rhea", developerId: R }, approver: { githubUserId: "777", login: "gh-admin" },
      installationId: 601, accountLogin: "acme", deliveryId: delivery,
    })]);
    expect(w.unlock).toHaveBeenCalledExactlyOnceWith({ orgId: TEST_ORG, githubUserId: String(R_ID) });
    expect(w.db.get(trialGithubKey(String(R_ID)))).toMatchObject({ orgId: TEST_ORG });
    // The membership of the requester and of the approver was read with the new installation's own token (id 601).
    expect(w.membership.mock.calls).toEqual([[601, "acme", R_LOGIN], [601, "acme", APPROVER.login]]);
    // One notice to each owner who has an address; the owner with none gets none, and the admin requester is not an owner.
    expect(w.notices.map((notice) => notice.to).sort()).toEqual(["olive@acme.test", "sam@acme.test"]);
    expect(w.notices[0]).toMatchObject({ orgName: "Acme <Corp>", accountLogin: "acme", approverLogin: "gh-admin", requester: { name: "Rhea Requester", email: "rhea@acme.test" } });
    expect(w.db.refusals).toEqual([]);
  });

  it("accepts created_at as epoch seconds as well as an ISO string", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w, { createdAtMs: Math.floor((w.now()) / 1000) }))).toBe("bound");
    expect(boundTo(w, 601)).toBe(TEST_ORG);
  });

  it("a Rovara member who is demoted while the request waits binds nothing", async () => {
    const w = world();
    await ask(w);
    w.db.set({ ...orgMemberKey(TEST_ORG, R), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: R, role: "member", joinedAt: "x" });
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w))).toBe("ignored");
    expect(boundTo(w, 601)).toBeUndefined();
    expect(w.db.get(githubInstallationEverBoundKey(601))).toBeUndefined();
    expect(requestOf(w)).toMatchObject({ status: "waiting" });
    expect(w.notices).toEqual([]);
  });

  it("a requester removed from the org after asking binds nothing", async () => {
    const w = world();
    await ask(w);
    w.db.delete(orgMemberKey(TEST_ORG, R));
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w))).toBe("ignored");
    expect(boundTo(w, 601)).toBeUndefined();
  });

  it("a requester who is not an active member of the GitHub organization binds nothing and the request stays waiting", async () => {
    for (const memberships of [{ [`acme/${R_LOGIN}`]: { state: "pending", role: "member" } }, { [`acme/${R_LOGIN}`]: undefined as unknown as Membership }]) {
      const w = world({ memberships });
      await ask(w);
      w.advance(HOUR);
      expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w))).toBe("ignored");
      expect(boundTo(w, 601)).toBeUndefined();
      expect(requestOf(w)).toMatchObject({ status: "waiting" });
      expect(w.db.get(githubDeliveryKey("x"))).toBeUndefined();
    }
  });

  it("an approver who is not an admin of the GitHub organization binds nothing", async () => {
    for (const approver of [{ state: "active", role: "member" }, { state: "pending", role: "admin" }, undefined]) {
      const w = world({ memberships: { [`acme/${APPROVER.login}`]: approver as unknown as Membership } });
      await ask(w);
      w.advance(HOUR);
      expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w))).toBe("ignored");
      expect(boundTo(w, 601)).toBeUndefined();
    }
  });

  it("a personal account (not an Organization) binds nothing", async () => {
    const w = world({ installs: { 601: install(601, { login: "rhea", id: R_ID, type: "User" }) } });
    await ask(w);
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w, { account: { login: "rhea", id: R_ID, type: "User" } }))).toBe("ignored");
    expect(boundTo(w, 601)).toBeUndefined();
  });

  it("stale or expired: a request past 7 days, one cancelled, and an installation created before the request each bind nothing", async () => {
    const expired = world();
    await ask(expired);
    expired.advance(7 * DAY + 1);
    expect(await bindRequestedInstallation(expired.deps, nextDelivery(), created(expired, { createdAtMs: isoAt(expired.now() - 1000) }))).toBe("ignored");
    expect(boundTo(expired, 601)).toBeUndefined();

    const cancelled = world();
    await ask(cancelled);
    await cancelInstallRequest(cancelled.deps, R_CALLER, String(R_ID));
    cancelled.advance(HOUR);
    expect(await bindRequestedInstallation(cancelled.deps, nextDelivery(), created(cancelled))).toBe("ignored");
    expect(boundTo(cancelled, 601)).toBeUndefined();

    const before = world();
    before.advance(DAY);
    await ask(before);
    before.advance(HOUR);
    expect(await bindRequestedInstallation(before.deps, nextDelivery(), created(before, { createdAtMs: isoAt(NOW) }))).toBe("ignored");
    // Created at or after the request but not before the expiry binds; created at the expiry does not.
    expect(await bindRequestedInstallation(before.deps, nextDelivery(), created(before, { createdAtMs: isoAt((requestOf(before)!.expiresAt as number)) }))).toBe("ignored");
    expect(boundTo(before, 601)).toBeUndefined();
    expect(requestOf(before)).toMatchObject({ status: "waiting" });
  });

  it("no cross-binding: a delivery naming R binds to R's org only, Q's open request is unchanged, and an unlinked or differently linked GitHub user binds nothing", async () => {
    const w = world({ memberships: { [`acme/${R_LOGIN}`]: { state: "active", role: "member" } } });
    await ask(w);
    const q = await ask(w, "codeQ", callerOf(Q, ORG_B, "admin"));
    expect(q.outcome.outcome).toBe("requested");
    const qBefore = structuredClone(requestOf(w, Q_ID));
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w))).toBe("bound");
    expect(boundTo(w, 601)).toBe(TEST_ORG);
    expect(w.db.get(orgGithubInstallationKey(ORG_B, 601))).toBeUndefined();
    expect(requestOf(w, Q_ID)).toEqual(qBefore);
    expect(orgRequestOf(w, Q_ID, ORG_B)).toMatchObject({ status: "waiting" });

    // A GitHub user linked to no developer, and one linked to a developer other than the request's, bind nothing.
    const other = world();
    await ask(other);
    other.advance(HOUR);
    expect(await bindRequestedInstallation(other.deps, nextDelivery(), created(other, { requester: { id: STRANGER_ID, login: "stranger" } }))).toBe("ignored");
    expect(await bindRequestedInstallation(other.deps, nextDelivery(), created(other, { requester: { id: 4444, login: "mel" } }))).toBe("ignored");
    // The request is R's, but the identity is now linked to somebody else: unlinked from R and linked to Q.
    other.db.set({ pk: `SIGNIN_IDENTITY#${ownerKeyForSubject("https://github.com", String(R_ID))}`, sk: "META", entityType: "IDENTITY_LINK", developerId: Q, provider: "github", issuer: "https://github.com", subject: String(R_ID), linkedAt: "x", lastSignInAt: "x" });
    expect(await bindRequestedInstallation(other.deps, nextDelivery(), created(other))).toBe("ignored");
    expect(boundTo(other, 601)).toBeUndefined();
  });

  it("replay: the same delivery id twice binds once, writes one audit item and sends one set of notices", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    const delivery = nextDelivery();
    expect(await bindRequestedInstallation(w.deps, delivery, created(w))).toBe("bound");
    expect(await bindRequestedInstallation(w.deps, delivery, created(w))).toBe("ignored");
    expect(auditItems(w)).toHaveLength(1);
    expect(w.notices).toHaveLength(2);
    expect(w.unlock).toHaveBeenCalledTimes(1);
  });

  it("the delivery record is what stops a replay even when everything else has been put back (a lost race on the delivery item changes nothing)", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    const delivery = nextDelivery();
    // Another worker recorded this delivery between the read and the write: the transaction refuses, and nothing else is written.
    w.db.set({ ...githubDeliveryKey(delivery), processedAt: "x", expiresAt: w.now() + DAY });
    expect(await bindRequestedInstallation(w.deps, delivery, created(w))).toBe("ignored");
    expect(boundTo(w, 601)).toBeUndefined();
    expect(requestOf(w)).toMatchObject({ status: "waiting" });
    expect(auditItems(w)).toEqual([]);
  });

  it("replay after a disconnect: the original delivery, redelivered by hand or by the recovery path, binds nothing and leaves a new request waiting; a new delivery id for the same installation ends it as reinstall_needed", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    const original = nextDelivery();
    expect(await bindRequestedInstallation(w.deps, original, created(w))).toBe("bound");
    // Task 15's DELETE: both binding items go; the tombstone and the delivery record stay.
    w.db.delete(githubInstallationKey(601));
    w.db.delete(orgGithubInstallationKey(TEST_ORG, 601));
    w.advance(DAY);
    await ask(w, "codeR2");
    const second = structuredClone(requestOf(w));
    w.advance(HOUR);
    // By hand, then by the recovery path (the sweep reads GITHUB_DELIVERY#<id>/META rows, and an install-request delivery has none: it re-enters the same function).
    expect(await bindRequestedInstallation(w.deps, original, created(w, { createdAtMs: isoAt(NOW + HOUR) }))).toBe("ignored");
    expect(await bindRequestedInstallation(w.deps, original, created(w, { createdAtMs: isoAt(NOW + HOUR) }))).toBe("ignored");
    expect(w.db.get({ pk: `GITHUB_DELIVERY#${original}`, sk: "META" })).toBeUndefined();
    expect(boundTo(w, 601)).toBeUndefined();
    expect(requestOf(w)).toEqual(second);
    // A test-built delivery with a new id and a created_at inside the new request's window: the installation was bound before, so it needs a new approval.
    const fresh = nextDelivery();
    expect(await bindRequestedInstallation(w.deps, fresh, created(w, { createdAtMs: isoAt(w.now()) }))).toBe("ignored");
    expect(boundTo(w, 601)).toBeUndefined();
    for (const item of [requestOf(w), orgRequestOf(w)]) expect(item).toMatchObject({ status: "reinstall_needed", installationId: 601 });
    expect(auditItems(w).map((item) => item.action).sort()).toEqual(["install_request_bound", "install_request_reinstall_needed"]);
    expect(w.db.get(githubInstallRequestQueueKey(second!.requestedAt as number, String(R_ID)))).toBeUndefined();
  });

  it("the same, when the GitHub user's new request comes from a new org after leaving the old one", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    const original = nextDelivery();
    expect(await bindRequestedInstallation(w.deps, original, created(w))).toBe("bound");
    w.db.delete(githubInstallationKey(601));
    w.db.delete(orgGithubInstallationKey(TEST_ORG, 601));
    // R leaves org X and becomes an admin of org Y; the same GitHub account asks from there.
    w.db.delete(orgMemberKey(TEST_ORG, R));
    w.db.set({ ...orgMemberKey(ORG_B, R), entityType: "ORG_MEMBER", orgId: ORG_B, developerId: R, role: "admin", joinedAt: "x" });
    w.advance(DAY);
    const asked = await ask(w, "codeR2", callerOf(R, ORG_B, "admin"));
    expect(asked.outcome.outcome).toBe("requested");
    expect(requestOf(w)).toMatchObject({ orgId: ORG_B, status: "waiting" });
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, original, created(w, { createdAtMs: isoAt(NOW + HOUR) }))).toBe("ignored");
    expect(requestOf(w)).toMatchObject({ orgId: ORG_B, status: "waiting" });
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w, { createdAtMs: isoAt(w.now()) }))).toBe("ignored");
    expect(requestOf(w)).toMatchObject({ orgId: ORG_B, status: "reinstall_needed" });
    expect(boundTo(w, 601)).toBeUndefined();
  });

  it("a Task 13 binding is in the tombstone too: an approval can't reconnect it", async () => {
    const w = world();
    w.db.set({ ...githubInstallationEverBoundKey(601), firstBoundAt: "2026-01-01T00:00:00.000Z", firstOrgId: ORG_B });
    await ask(w);
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w))).toBe("ignored");
    expect(requestOf(w)).toMatchObject({ status: "reinstall_needed" });
    expect(boundTo(w, 601)).toBeUndefined();
    expect(w.notices).toEqual([]);
  });

  it("already bound: an installation bound to org Z ends the request as taken, and Z's binding is unchanged", async () => {
    const w = world();
    await ask(w);
    const other = { ...githubInstallationKey(601), entityType: "GITHUB_INSTALLATION", installationId: 601, orgId: ORG_B, accountLogin: "acme", status: "active", boundAt: "2026-09-01T00:00:00.000Z" };
    w.db.set(other);
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w))).toBe("ignored");
    expect(w.db.get(githubInstallationKey(601))).toEqual(other);
    expect(w.db.get(orgGithubInstallationKey(TEST_ORG, 601))).toBeUndefined();
    for (const item of [requestOf(w), orgRequestOf(w)]) expect(item).toMatchObject({ status: "taken" });
    expect(auditItems(w)).toEqual([expect.objectContaining({ action: "install_request_taken", installationId: 601 })]);
    expect(w.unlock).not.toHaveBeenCalled();
  });

  it("unattributed: no requester binds nothing and is logged as github.install_request_unattributed; so is a requester with no open request", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w, { requester: null }))).toBe("ignored");
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "github.install_request_unattributed", installationId: 601, reason: "no_requester" }));
    expect(await bindRequestedInstallation(w.deps, nextDelivery(), created(w, { requester: { id: Q_ID, login: Q_LOGIN } }))).toBe("ignored");
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "github.install_request_unattributed", reason: "no_open_request" }));
    expect(boundTo(w, 601)).toBeUndefined();
    expect(requestOf(w)).toMatchObject({ status: "waiting" });
  });

  it("a GitHub outage while checking membership is thrown, so the webhook answers retryably, and nothing is recorded", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    const failing = { ...w.deps, app: { ...w.deps.app, orgMembership: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "GitHub's membership lookup failed with HTTP 502"); } } };
    const delivery = nextDelivery();
    await expect(bindRequestedInstallation(failing, delivery, created(w))).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.get(githubDeliveryKey(delivery))).toBeUndefined();
    // The same delivery redelivered later, with GitHub back, binds.
    expect(await bindRequestedInstallation(w.deps, delivery, created(w))).toBe("bound");
  });

  it("does not log a token, a code, an email address or a client secret", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    await bindRequestedInstallation(w.deps, nextDelivery(), created(w));
    const logged = JSON.stringify(w.logs);
    expect(logged).not.toMatch(/ghu_|gho_|ghs_/);
    for (const secret of ["codeR", CLIENT_SECRET, "rhea@acme.test", "olive@acme.test", "sam@acme.test"]) expect(logged).not.toContain(secret);
    expect(w.logs.length).toBeGreaterThan(2);
  });
});

describe("cancel and list", () => {
  it("the requester and an org owner may cancel; another member gets FORBIDDEN; another org's request is NOT_FOUND; a cancelled request is audited and leaves the queue", async () => {
    const w = world();
    await ask(w);
    await expect(cancelInstallRequest(w.deps, callerOf(MEMBER, TEST_ORG, "member"), String(R_ID))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(cancelInstallRequest(w.deps, callerOf(Q, ORG_B, "admin"), String(R_ID))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(requestOf(w)).toMatchObject({ status: "waiting" });
    expect(await cancelInstallRequest(w.deps, callerOf(OWNER, TEST_ORG, "owner"), String(R_ID))).toEqual({ githubUserId: "4343", status: "cancelled" });
    for (const item of [requestOf(w), orgRequestOf(w)]) expect(item).toMatchObject({ status: "cancelled", decidedAt: NOW });
    expect(w.db.get(githubInstallRequestQueueKey(NOW, String(R_ID)))).toBeUndefined();
    expect(auditItems(w)).toEqual([expect.objectContaining({ action: "install_request_cancelled", cancelledBy: OWNER })]);
    // Not waiting any more.
    await expect(cancelInstallRequest(w.deps, callerOf(OWNER, TEST_ORG, "owner"), String(R_ID))).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    const own = world();
    await ask(own);
    // A plain requester (a member who was an admin when they asked) may cancel their own.
    expect((await cancelInstallRequest(own.deps, callerOf(R, TEST_ORG, "member"), String(R_ID))).status).toBe("cancelled");
  });

  it("lists the org's requests, and shows expired for a waiting request past its expiry", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    await ask(w, "codeQ", callerOf(Q, ORG_B, "admin"));
    const listed = await listInstallRequests(w.deps, TEST_ORG);
    expect(listed.requests).toEqual([{
      githubLogin: R_LOGIN, status: "waiting", requestedAt: isoAt(NOW), expiresAt: isoAt(NOW + 7 * DAY), requestedBy: { developerId: R, name: "Rhea Requester" },
    }]);
    w.advance(7 * DAY);
    expect((await listInstallRequests(w.deps, TEST_ORG)).requests[0]).toMatchObject({ githubLogin: R_LOGIN, status: "expired" });
    expect(requestOf(w)).toMatchObject({ status: "waiting" });
    // A cancel after the expiry is refused too: it is no longer waiting.
    await expect(cancelInstallRequest(w.deps, R_CALLER, String(R_ID))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("naming: telling the Rovara side which org asked", () => {
  it("the owners' email names the GitHub organization (login and address), the requester, the approver and the Rovara org, with the exact words", () => {
    const notice: GithubConnectedNotice = { to: "olive@acme.test", orgName: "Acme", accountLogin: "acme-co", approverLogin: "gh-admin", requester: { name: "Rhea Requester", email: "rhea@acme.test" } };
    expect(githubConnectedNoticeSubject("acme-co", "Acme")).toBe("GitHub organization acme-co connected to Acme on Rovara");
    expect(githubConnectedNoticeText(notice)).toBe(
      "Rhea Requester (rhea@acme.test) asked to connect the GitHub organization acme-co (https://github.com/acme-co) to your Rovara organization Acme. "
      + "gh-admin, an admin of acme-co on GitHub, approved it. Rovara can now work in the repositories acme-co gave it access to. "
      + "If this isn't the GitHub organization you expected, remove it with agentx github disconnect acme-co.",
    );
    // No email on record: the parentheses go too, and the rest is unchanged.
    const without = githubConnectedNoticeText({ ...notice, requester: { name: "Rhea Requester" } });
    expect(without).toContain("Rhea Requester asked to connect the GitHub organization acme-co");
    expect(without).not.toContain("()");
    expect(without).not.toContain("(rhea");
  });

  it("the waiting page repeats the suggested message with the org and owner names, escaped", async () => {
    const w = world();
    const started = await start(w);
    const page = await routeGithubInstall(w.deps, { method: "GET", path: "/v1/github/install/callback", headers: {}, requestId: "r" },
      new URL(`https://cell.example/v1/github/install/callback?code=codeR&setup_action=request&state=${started.state}`));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<h1>Waiting for your GitHub admin</h1>");
    expect(page.body).toContain("You asked an admin of your GitHub organization to approve Rovara. Once they approve it on GitHub, Rovara connects it to Acme &lt;Corp&gt; and tells your organization&#39;s owners. The request stays open for 7 days.");
    expect(page.body).toContain("GitHub doesn&#39;t show your admin which Rovara organization asked. Tell them: for Rovara org Acme &lt;Corp&gt; (owner Olive Owner).");
    expect(page.body).not.toContain("<Corp>");
  });

  it("the start answer carries the org and owner names for the CLI's message", async () => {
    const w = world();
    expect(await start(w)).toMatchObject({ orgName: "Acme <Corp>", ownerName: "Olive Owner" });
  });
});

describe("one reminder after 2 days (Step 6)", () => {
  const QUEUE = (w: World) => w.db.find((item) => item.pk === "GITHUB_INSTALL_REQUEST_QUEUE");

  it("emails the requester once at 2 days, marks the request on both items, and not again on a second run", async () => {
    const w = world();
    await ask(w);
    w.advance(2 * DAY - 1);
    expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 0, cleared: 0 });
    expect(w.reminders).toEqual([]);
    w.advance(2);
    expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 1, cleared: 0 });
    expect(w.reminders).toEqual([{ to: "rhea@acme.test", expiresAt: NOW + 7 * DAY }]);
    expect(requestOf(w)).toMatchObject({ remindedAt: w.now(), status: "waiting" });
    expect(orgRequestOf(w)).toMatchObject({ remindedAt: w.now() });
    expect(QUEUE(w)).toEqual([]);
    w.advance(HOUR);
    expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 0, cleared: 0 });
    w.advance(3 * DAY);
    expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 0, cleared: 0 });
    expect(w.reminders).toHaveLength(1);
  });

  it("two sweeps at once remind once", async () => {
    const w = world();
    await ask(w);
    w.advance(3 * DAY);
    const [first, second] = await Promise.all([sendInstallRequestReminders(w.deps), sendInstallRequestReminders(w.deps)]);
    expect(first.reminded + second.reminded).toBe(1);
    expect(w.reminders).toHaveLength(1);
  });

  it("sends none for a request that is connected or cancelled, even if its queue entry was left behind", async () => {
    const connected = world();
    await ask(connected);
    connected.advance(HOUR);
    expect(await bindRequestedInstallation(connected.deps, nextDelivery(), created(connected))).toBe("bound");
    expect(QUEUE(connected)).toEqual([]);
    connected.advance(3 * DAY);
    expect(await sendInstallRequestReminders(connected.deps)).toEqual({ reminded: 0, cleared: 0 });

    for (const status of ["connected", "cancelled"] as const) {
      const w = world();
      await ask(w);
      // A queue entry left behind by a crash between the status change and its removal.
      for (const item of [requestOf(w)!, orgRequestOf(w)!]) item.status = status;
      w.advance(3 * DAY);
      expect(QUEUE(w)).toHaveLength(1);
      expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 0, cleared: 1 });
      expect(QUEUE(w)).toEqual([]);
      expect(w.reminders).toEqual([]);
    }
    const cancelled = world();
    await ask(cancelled);
    await cancelInstallRequest(cancelled.deps, R_CALLER, String(R_ID));
    cancelled.advance(3 * DAY);
    expect(await sendInstallRequestReminders(cancelled.deps)).toEqual({ reminded: 0, cleared: 0 });
    expect(cancelled.reminders).toEqual([]);
  });

  it("sends none past expiry, and clears the entry", async () => {
    const w = world();
    await ask(w);
    w.advance(7 * DAY);
    expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 0, cleared: 1 });
    expect(w.reminders).toEqual([]);
    expect(QUEUE(w)).toEqual([]);
  });

  it("a replaced request is reminded once, for its newest asking only", async () => {
    const w = world();
    await ask(w);
    w.advance(DAY);
    await ask(w, "codeR2");
    w.advance(2 * DAY - 1);
    expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 0, cleared: 0 });
    w.advance(2);
    expect(await sendInstallRequestReminders(w.deps)).toEqual({ reminded: 1, cleared: 0 });
    expect(w.reminders).toEqual([{ to: "rhea@acme.test", expiresAt: NOW + DAY + 7 * DAY }]);
  });

  it("a requester with no address, or a send that fails, is marked reminded and never retried by the next sweep", async () => {
    const noEmail = world();
    await ask(noEmail);
    noEmail.db.set({ pk: `DEVELOPER#${R}`, sk: "META", developerId: R, provider: "github", displayName: "Rhea Requester", firstSignInAt: "x", lastSignInAt: "x", revoked: false, issuer: "https://github.com", subject: String(R_ID) });
    noEmail.advance(3 * DAY);
    expect((await sendInstallRequestReminders(noEmail.deps)).reminded).toBe(1);
    expect(noEmail.reminders).toEqual([]);
    expect(requestOf(noEmail)).toHaveProperty("remindedAt");

    const failing = world();
    await ask(failing);
    failing.advance(3 * DAY);
    const sends = vi.fn(async () => { throw Object.assign(new Error("boom"), { name: "MessageRejected" }); });
    const deps = { ...failing.deps, remindGithubRequester: sends };
    expect((await sendInstallRequestReminders(deps)).reminded).toBe(1);
    expect((await sendInstallRequestReminders(deps)).reminded).toBe(0);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(failing.logs).toContainEqual({ event: "github.install_request_reminder_failed", error: "MessageRejected" });
    expect(JSON.stringify(failing.logs)).not.toContain("rhea@acme.test");
  });

  it("the email says the exact words, naming the GitHub organization when it is known and 'your GitHub organization' when it is not", () => {
    expect(GITHUB_REQUEST_REMINDER_SUBJECT).toBe("Your GitHub admin hasn't approved Rovara yet");
    expect(githubRequestReminderText({ to: "x", expiresAt: Date.parse("2026-10-28T12:00:00.000Z") })).toBe(
      "You asked an admin of your GitHub organization to approve Rovara 2 days ago, and it's still waiting. The request expires on 2026-10-28. Remind them, or ask them to run agentx github connect themselves.",
    );
    expect(githubRequestReminderText({ to: "x", requestedAccountLogin: "acme-co", expiresAt: Date.parse("2026-10-28T12:00:00.000Z") })).toContain("You asked an admin of acme-co to approve Rovara 2 days ago");
  });

  it("through the broker: the scheduled event runs the sweep and sends one SES email to the requester", async () => {
    const sent: Array<{ input: { Destination?: { ToAddresses?: string[] }; Content?: { Simple?: { Subject?: { Data?: string } } } } }> = [];
    const harness = await createDeveloperTaskBroker({
      brokerExtra: {
        cloud: true,
        githubConnectedNotice: { ses: { send: async (command: { input: never }) => { sent.push(command); return {}; } }, from: "Rovara <signin@rovara.dev>", log: () => undefined },
        githubPullRequests: {
          reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(),
          appSlug: async () => "rovara-cloud", oauthClient: async () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
          installation: async () => install(601),
        },
      },
    });
    seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    harness.db.set({ pk: `DEVELOPER#${OMAR.developerId}`, sk: "META", developerId: OMAR.developerId, provider: "oidc", displayName: "Omar", email: "omar@acme.test", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const requestedAt = Date.now() - 3 * DAY;
    const record = { entityType: "GITHUB_INSTALL_REQUEST", orgId: TEST_ORG, developerId: OMAR.developerId, githubUserId: "4343", githubLogin: R_LOGIN, requestedAt, expiresAt: requestedAt + 7 * DAY, status: "waiting" };
    harness.db.set({ ...githubInstallRequestKey("4343"), ...record });
    harness.db.set({ ...orgGithubInstallRequestKey(TEST_ORG, "4343"), ...record });
    harness.db.set({ ...githubInstallRequestQueueKey(requestedAt, "4343"), entityType: "GITHUB_INSTALL_REQUEST_QUEUE", orgId: TEST_ORG });
    const run = () => harness.handler({ kind: "github-install-request-reminders" });
    const first = await run();
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ reminded: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.Destination!.ToAddresses).toEqual(["omar@acme.test"]);
    expect(sent[0]!.input.Content!.Simple!.Subject!.Data).toBe("Your GitHub admin hasn't approved Rovara yet");
    expect(JSON.parse((await run()).body)).toMatchObject({ reminded: 0 });
    expect(sent).toHaveLength(1);
  });
});

describe("the webhook endpoint", () => {
  const SECRET = "whsec-test";
  const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
  const body = (w: World, over: Record<string, unknown> = {}) => JSON.stringify({
    action: "created", installation: { id: 601, created_at: isoAt(w.now() + HOUR), account: ACME, repository_selection: "selected" },
    requester: { id: R_ID, login: R_LOGIN }, sender: APPROVER, ...over,
  });
  const deliver = (w: World, raw: string, headers: Record<string, string> = {}, id = nextDelivery()) => handleGithubWebhook({
    documentClient: w.db, tableName: "state", rawBody: raw, secret: SECRET,
    headers: { "x-hub-signature-256": sign(raw), "x-github-delivery": id, "x-github-event": "installation", ...headers },
    authorizeRepository: async () => { throw new Error("not for installation events"); },
    process: async () => { throw new Error("not for installation events"); },
    installationCreated: (deliveryId, payload) => bindRequestedInstallation(w.deps, deliveryId, payload),
    now: () => isoAt(w.now()),
  });

  it("a signed installation.created delivery names the requester and binds; the same delivery again is accepted and binds nothing more", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    const raw = body(w);
    const id = nextDelivery();
    expect(await deliver(w, raw, {}, id)).toEqual({ status: "ACCEPTED", deliveryId: id });
    expect(boundTo(w, 601)).toBe(TEST_ORG);
    expect(await deliver(w, raw, {}, id)).toEqual({ status: "ACCEPTED", deliveryId: id });
    expect(auditItems(w)).toHaveLength(1);
    expect(w.notices).toHaveLength(2);
  });

  it("a null or missing requester is accepted and attributes nothing", async () => {
    const w = world();
    await ask(w);
    w.advance(HOUR);
    await deliver(w, body(w, { requester: null }));
    const missing = JSON.parse(body(w)) as Record<string, unknown>;
    delete missing.requester;
    await deliver(w, JSON.stringify(missing));
    expect(boundTo(w, 601)).toBeUndefined();
    expect(w.logs.filter((entry) => entry.event === "github.install_request_unattributed")).toHaveLength(2);
  });

  it("refuses a bad signature, a bad delivery id and a payload that is not an installation.created, before reading anything", async () => {
    const w = world();
    await ask(w);
    const raw = body(w);
    await expect(deliver(w, raw, { "x-hub-signature-256": `sha256=${"0".repeat(64)}` })).rejects.toThrow("GitHub webhook signature is invalid");
    await expect(deliver(w, raw, {}, "not-a-uuid")).rejects.toThrow("delivery ID is invalid");
    const deleted = JSON.stringify({ action: "deleted", installation: { id: 601 }, sender: APPROVER });
    await expect(deliver(w, deleted)).rejects.toThrow("unsupported or incomplete");
    expect(boundTo(w, 601)).toBeUndefined();
  });

  it("through the broker: the public webhook route binds, and a member may list the requests while another member may not cancel them", async () => {
    const memberships = DEFAULT_MEMBERSHIPS;
    const harness = await createDeveloperTaskBroker({
      brokerExtra: {
        cloud: true,
        githubWebhookSecret: async () => SECRET,
        githubPullRequests: {
          reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(),
          appSlug: async () => "rovara-cloud", oauthClient: async () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
          installation: async (id: number) => { if (id !== 601) throw agentXError("NOT_FOUND", "no such installation"); return install(601); },
          organizationMembership: async (_id: number, org: string, login: string) => memberships[`${org}/${login}`],
        },
      },
    });
    seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    harness.db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme", createdAt: "x", createdBy: "system", plan: "team" });
    // MAYA is a member; OMAR an owner and the requester, whose GitHub account is linked.
    const identityKey = ownerKeyForSubject("https://github.com", String(R_ID));
    const link = { developerId: OMAR.developerId, provider: "github", issuer: "https://github.com", subject: String(R_ID), linkedAt: "x", lastSignInAt: "x" };
    harness.db.set({ pk: `SIGNIN_IDENTITY#${identityKey}`, sk: "META", entityType: "IDENTITY_LINK", ...link });
    harness.db.set({ pk: `DEVELOPER#${OMAR.developerId}`, sk: `IDENTITY#${identityKey}`, entityType: "DEVELOPER_IDENTITY", ...link });
    const requested = { entityType: "GITHUB_INSTALL_REQUEST", orgId: TEST_ORG, developerId: OMAR.developerId, githubUserId: String(R_ID), githubLogin: R_LOGIN, requestedAt: Date.now() - 1000, expiresAt: Date.now() + 7 * DAY, status: "waiting" };
    harness.db.set({ ...githubInstallRequestKey(String(R_ID)), ...requested });
    harness.db.set({ ...orgGithubInstallRequestKey(TEST_ORG, String(R_ID)), ...requested });

    const listedByMember = await harness.dev(MAYA, "GET", "/v1/app/github/requests");
    expect(listedByMember.status).toBe(200);
    expect(listedByMember.body.requests).toEqual([expect.objectContaining({ githubLogin: R_LOGIN, status: "waiting", requestedBy: expect.objectContaining({ developerId: OMAR.developerId }) as unknown })]);
    expect((await harness.dev(MAYA, "DELETE", `/v1/app/github/requests/${R_ID}`)).status).toBe(403);
    expect((await harness.dev(MAYA, "DELETE", "/v1/app/github/requests/12345")).status).toBe(404);
    expect(harness.db.get(githubInstallRequestKey(String(R_ID)))).toMatchObject({ status: "waiting" });

    const raw = JSON.stringify({ action: "created", installation: { id: 601, created_at: new Date(Date.now() + 60_000).toISOString(), account: ACME }, requester: { id: R_ID, login: R_LOGIN }, sender: APPROVER });
    const reply = await harness.handler({
      version: "2.0", routeKey: "POST /v1/github/webhooks", rawPath: "/v1/github/webhooks", rawQueryString: "",
      headers: { "x-hub-signature-256": sign(raw), "x-github-delivery": "550e8400-e29b-41d4-a716-446655449999", "x-github-event": "installation" },
      body: raw, requestContext: { requestId: "r-1", http: { method: "POST" } },
    });
    expect(reply.statusCode).toBe(200);
    expect(harness.db.get(githubInstallationKey(601))).toMatchObject({ orgId: TEST_ORG, boundByDeveloperId: OMAR.developerId });
    expect(harness.db.get(githubInstallationEverBoundKey(601))).toBeDefined();

    const cancelled = world();
    await ask(cancelled);
    expect(requestOf(cancelled)).toBeDefined();
  });
});

describe("infrastructure", () => {
  let cloud: { Resources: Record<string, { Type: string; Properties: Record<string, unknown>; Condition?: string }> };
  beforeAll(() => {
    const app = buildAgentXApp({ agentxEnv: "staging", agentxCloud: true });
    cloud = Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane")!).toJSON() as typeof cloud;
  }, 300_000);

  it("the broker's ses:SendEmail names only the sender's source ARN parameter, under CloudSignInEmailFromSes, and nothing else about SES", () => {
    const policies = Object.entries(cloud.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy");
    const broker = policies.filter(([, policy]) => (policy.Properties.Roles as Array<{ Ref: string }>).some((role) => role.Ref.startsWith("BrokerServiceRole")));
    const sesStatements = broker.flatMap(([, policy]) => ((policy.Properties.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown; Condition?: unknown; Effect: string }> }).Statement))
      .filter((statement) => [statement.Action].flat().some((action) => action.toLowerCase().startsWith("ses:")));
    expect(sesStatements).toEqual([{ Action: "ses:SendEmail", Effect: "Allow", Resource: { Ref: "CloudSignInEmailSourceArn" } }]);
    const holders = broker.filter(([, policy]) => JSON.stringify(policy.Properties.PolicyDocument).includes("ses:SendEmail"));
    expect(holders).toHaveLength(1);
    expect(holders[0]![1].Condition).toBe("CloudSignInEmailFromSes");
    const env = (Object.values(cloud.Resources).find((resource) => resource.Type === "AWS::Lambda::Function" && "Environment" in resource.Properties && JSON.stringify(resource.Properties.Environment).includes("GITHUB_APP_CREDENTIAL_REF"))!.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(Object.keys(env)).toContain("DEVELOPER_NOTICE_EMAIL_FROM");
  });

  it("an hourly schedule invokes the broker with the reminder event, on the role the webhook recovery schedule uses (Step 6)", () => {
    const schedules = Object.entries(cloud.Resources).filter(([, resource]) => resource.Type === "AWS::Scheduler::Schedule");
    const named = (name: string) => schedules.find(([id]) => id.replace(/[0-9A-F]{8}$/, "") === name)![1].Properties as { ScheduleExpression: string; State: string; Target: { Arn: unknown; Input: string; RoleArn: unknown } };
    const reminder = named("GithubInstallRequestReminderSchedule");
    const recovery = named("GithubWebhookRecoverySchedule");
    expect(reminder.ScheduleExpression).toBe("rate(1 hour)");
    expect(reminder.State).toBe("ENABLED");
    expect(JSON.parse(reminder.Target.Input)).toEqual({ kind: "github-install-request-reminders" });
    expect(reminder.Target.Arn).toEqual(recovery.Target.Arn);
    expect(reminder.Target.RoleArn).toEqual(recovery.Target.RoleArn);
  });
});
