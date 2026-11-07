// Plan 2, Task 13: an org connects its own GitHub App installation. The callback proves who is in the browser (the GitHub account linked
// to the developer who started the connect) and that they manage the installation's account; only a confirmation from the same browser
// binds. Everything here runs against fakes: a fake table, a fake GitHub (github.com and api.github.com) and a fake GitHub App.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GITHUB_INSTALLATION_TAKEN_MESSAGE, agentXError, errorStatus, githubConnectStateKey, githubInstallationEverBoundKey, githubInstallationKey, orgGithubInstallationKey,
  orgMemberKey, orgMetaKey, trialGithubKey, type OrgId,
} from "@agentx/contracts";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { executeCli } from "../../packages/cli/src/main.js";
import { InMemoryTokenStore } from "../../packages/cli/src/token-store.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { GitHubInstallation } from "../../packages/broker/src/github-app.js";
import {
  clearedConnectCookie, completeGithubConnect, confirmGithubConnect, connectCookie, startGithubConnect, type GithubConnectionDependencies,
} from "../../packages/broker/src/org/github-connection.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { unlockTrial } from "../../packages/broker/src/org/trial.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { routeFetch } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const CELL = "https://abc123.execute-api.us-east-1.amazonaws.com";
const CLIENT_ID = "Iv1.rovaraclient";
const CLIENT_SECRET = "client-secret-value-9f3a";
const OWNER = "owner-dev";
const ADMIN = "admin-dev";
const OTHER = "other-dev";
// UX1: neutral words; the web app detects the missing link first and offers "Link your GitHub account" in place.
const STARTED_MESSAGE = "link your GitHub account to your Rovara account first, then connect GitHub again";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

interface GhUser { id: number; installations: number[]; memberships?: Record<string, { state: string; role: string }> }

/** github.com's token exchange and api.github.com's user endpoints, by user token. A code maps to the token it exchanges for. */
function fakeGithub(users: Record<string, GhUser>, codes: Record<string, string>) {
  const revoked: string[] = [];
  const handler = async (url: URL, init: RequestInit | undefined): Promise<Response | undefined> => {
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return Response.json({ error: "incorrect_client_credentials" });
      const token = codes[form.get("code") ?? ""];
      return token === undefined ? Response.json({ error: "bad_verification_code" }) : Response.json({ access_token: token, token_type: "bearer" });
    }
    if (url.origin !== "https://api.github.com") return undefined;
    const method = init?.method ?? "GET";
    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    if (method === "DELETE" && url.pathname === `/applications/${CLIENT_ID}/token`) {
      expect(authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
      revoked.push((JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { access_token: string }).access_token);
      return new Response(null, { status: 204 });
    }
    const user = users[authorization.replace("Bearer ", "")];
    if (user === undefined) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.pathname === "/user") return Response.json({ id: user.id, login: `user${user.id}` });
    if (url.pathname === "/user/installations") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const all = user.installations.map((id) => ({ id }));
      return Response.json({ total_count: all.length, installations: all.slice((page - 1) * 100, page * 100) });
    }
    const membership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname);
    if (membership !== null) {
      const found = user.memberships?.[decodeURIComponent(membership[1]!)];
      return found === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json(found);
    }
    return undefined;
  };
  return { handler, revoked };
}

const install = (id: number, account: GitHubInstallation["account"], extra: Partial<GitHubInstallation> = {}): GitHubInstallation =>
  ({ id, account, repositorySelection: "selected", suspendedAt: null, ...extra });

/** A fake table with an org, its owner and admin (their GitHub accounts linked), and a fake GitHub App and GitHub. */
function world(options: { cloud?: boolean; installs?: Record<number, GitHubInstallation>; users?: Record<string, GhUser>; codes?: Record<string, string>; orgPlan?: "trial" | "team" } = {}) {
  const db = new FakeDynamoDb();
  db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme <Corp>", createdAt: "2026-10-01T00:00:00.000Z", createdBy: OWNER, plan: options.orgPlan ?? "team" });
  db.set({ ...orgMetaKey(ORG_B), entityType: "ORG", orgId: ORG_B, name: "Beta", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "someone", plan: "trial" });
  for (const [developerId, role] of [[OWNER, "owner"], [ADMIN, "admin"], [OTHER, "member"]] as const) db.set({ ...orgMemberKey(TEST_ORG, developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId, role, joinedAt: "x" });
  const link = (developerId: string, githubUserId: number) => {
    const identityKey = ownerKeyForSubject("https://github.com", String(githubUserId));
    const fields = { developerId, provider: "github", issuer: "https://github.com", subject: String(githubUserId), linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" };
    db.set({ pk: `SIGNIN_IDENTITY#${identityKey}`, sk: "META", entityType: "IDENTITY_LINK", ...fields });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: `IDENTITY#${identityKey}`, entityType: "DEVELOPER_IDENTITY", ...fields });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "github", displayName: developerId, firstSignInAt: "x", lastSignInAt: "x", revoked: false, issuer: "https://github.com", subject: String(githubUserId) });
  };
  link(OWNER, 4242);
  link(ADMIN, 4343);
  const installs = options.installs ?? {};
  const github = fakeGithub(options.users ?? {}, options.codes ?? {});
  const fetch = routeFetch(github.handler);
  const logs: Array<Record<string, unknown>> = [];
  let clock = NOW;
  const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
  const unlock = vi.fn((input: { orgId: OrgId; githubUserId: string }) => unlockTrial({ documentClient: db, tableName: "state", now: () => clock }, input));
  const deps: GithubConnectionDependencies = {
    documentClient: db, tableName: "state", now: () => clock, cloud: options.cloud ?? true, origin: CELL,
    app: {
      appSlug: async () => "rovara-cloud",
      oauthClient: async () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
      installation: async (id) => { const found = installs[id]; if (found === undefined) throw agentXError("NOT_FOUND", "GitHub has no such installation of this App"); return found; },
    },
    identities: signIn, orgs: new OrgStore({ documentClient: db, tableName: "state", now: () => clock }), unlockTrial: unlock,
    fetch, log: (entry) => logs.push(entry),
  };
  return { db, deps, fetch, github, logs, unlock, advance: (ms: number) => { clock += ms; } };
}

type World = ReturnType<typeof world>;
const OWNER_CALLER: { developerId: string; orgId: OrgId; orgRole: "owner" | "admin" | "member" } = { developerId: OWNER, orgId: TEST_ORG, orgRole: "owner" };

/** Starts a connect as the org's owner and returns the state the install link carries. */
async function start(w: World, caller = OWNER_CALLER) {
  const started = await startGithubConnect(w.deps, caller);
  const state = new URL(started.installUrl).searchParams.get("state")!;
  return { ...started, state, stateHash: sha(state) };
}
const githubCalls = (w: World, pattern: RegExp) => w.fetch.calls.filter((call) => pattern.test(call));
const revokes = (w: World) => githubCalls(w, /^DELETE https:\/\/api\.github\.com\/applications\//).length;
const installationItems = (db: FakeDynamoDb) => db.find((item) => typeof item.pk === "string" && item.pk.startsWith("GITHUB_INSTALLATION#") || (typeof item.sk === "string" && item.sk.startsWith("GITHUB_INSTALLATION#")));
const bound = (db: FakeDynamoDb, id: number) => db.get(githubInstallationKey(id)) !== undefined || db.get(orgGithubInstallationKey(TEST_ORG, id)) !== undefined;

const ALICE = { id: 4242, installations: [501], memberships: { acme: { state: "active", role: "admin" } } } satisfies GhUser;
const ACME_ORG = install(501, { login: "acme", id: 900, type: "Organization" });

/** The cases most tests share: the owner (GitHub 4242) completing the callback for installation 501 on the GitHub organization acme. */
const standard = (over: Partial<Parameters<typeof world>[0]> = {}) => world({
  installs: { 501: ACME_ORG }, users: { ghu_alice: ALICE }, codes: { code1: "ghu_alice" }, ...over,
});
const callbackQuery = (state: string, extra: Record<string, string> = {}) => ({ code: "code1", installation_id: "501", setup_action: "install", state, ...extra });

describe("the error code and keys", () => {
  it("GITHUB_INSTALLATION_TAKEN answers 409 with the exact message", () => {
    expect(errorStatus("GITHUB_INSTALLATION_TAKEN")).toBe(409);
    expect(agentXError("GITHUB_INSTALLATION_TAKEN", GITHUB_INSTALLATION_TAKEN_MESSAGE).statusCode).toBe(409);
    expect(GITHUB_INSTALLATION_TAKEN_MESSAGE).toBe("This GitHub account is already connected to another Rovara organization.");
  });

  it("keys: the global binding, the org's copy, the permanent tombstone and the state", () => {
    expect(githubInstallationKey(501)).toEqual({ pk: "GITHUB_INSTALLATION#501", sk: "ORG" });
    expect(orgGithubInstallationKey(TEST_ORG, 501)).toEqual({ pk: `ORG#${TEST_ORG}`, sk: "GITHUB_INSTALLATION#501" });
    expect(githubInstallationEverBoundKey(501)).toEqual({ pk: "GITHUB_INSTALLATION#501", sk: "EVER_BOUND" });
    expect(githubConnectStateKey("abc")).toEqual({ pk: "GITHUB_CONNECT#abc", sk: "META" });
  });
});

describe("startGithubConnect", () => {
  it("gives an owner or admin an install link whose state is stored only as its hash, for 15 minutes", async () => {
    const w = standard();
    const started = await start(w);
    expect(started.installUrl).toMatch(/^https:\/\/github\.com\/apps\/rovara-cloud\/installations\/new\?state=[A-Za-z0-9_-]{43}$/);
    expect(started.expiresAt).toBe(new Date(NOW + 900_000).toISOString());
    expect(w.db.get(githubConnectStateKey(started.stateHash))).toMatchObject({ orgId: TEST_ORG, developerId: OWNER, expiresAt: NOW + 900_000 });
    expect(JSON.stringify(w.db.find(() => true))).not.toContain(started.state);
    expect((await start(w, { developerId: ADMIN, orgId: TEST_ORG, orgRole: "admin" })).state).not.toBe(started.state);
  });

  it("refuses a member, and an install that is not Rovara Cloud, with the exact words", async () => {
    const w = standard();
    await expect(startGithubConnect(w.deps, { developerId: OTHER, orgId: TEST_ORG, orgRole: "member" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("only an owner or admin can connect GitHub") as string });
    const privateInstall = standard({ cloud: false });
    await expect(startGithubConnect(privateInstall.deps, OWNER_CALLER)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("on this install, GitHub is connected by the administrator during agentx init") as string });
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_CONNECT#"))).toEqual([]);
  });

  it("refuses an owner with no linked GitHub identity, and says what to do", async () => {
    const w = standard();
    w.db.set({ ...orgMemberKey(TEST_ORG, "email-owner"), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: "email-owner", role: "owner", joinedAt: "x" });
    w.db.set({ pk: "DEVELOPER#email-owner", sk: "META", developerId: "email-owner", provider: "cloud", issuer: "https://cognito.example", subject: "s", displayName: "E", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await expect(startGithubConnect(w.deps, { developerId: "email-owner", orgId: TEST_ORG, orgRole: "owner" })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(STARTED_MESSAGE) as string });
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_CONNECT#"))).toEqual([]);
  });

  it("refuses to start when the App has no OAuth client, before anyone installs anything", async () => {
    const w = standard();
    const deps = { ...w.deps, app: { ...w.deps.app, oauthClient: async () => undefined } };
    await expect(startGithubConnect(deps, OWNER_CALLER)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the callback and the confirmation", () => {
  it("happy path: the callback writes no installation item and asks; the confirmation binds both keys and the tombstone, and unlocks the trial with GitHub's user id", async () => {
    const w = standard({ orgPlan: "trial" });
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    expect(result).toMatchObject({ outcome: "confirm", orgName: "Acme <Corp>", accountLogin: "acme", connectId: started.stateHash });
    expect(result.confirmToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Asking is not binding: nothing about the installation is written yet, and the token is stored only as its hash.
    expect(installationItems(w.db)).toEqual([]);
    const item = w.db.get(githubConnectStateKey(started.stateHash))!;
    expect(item).toMatchObject({ confirmHash: sha(result.confirmToken!), pending: { installationId: 501, accountLogin: "acme", accountType: "Organization", githubUserId: "4242" } });
    expect(item.consumedAt).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain(result.confirmToken!);
    expect(w.unlock).not.toHaveBeenCalled();
    expect(revokes(w)).toBe(1);

    const confirmed = await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL);
    expect(confirmed).toEqual({ outcome: "connected", orgName: "Acme <Corp>", accountLogin: "acme" });
    const record = { installationId: 501, orgId: TEST_ORG, accountLogin: "acme", accountId: 900, accountType: "Organization", repositorySelection: "selected", installedByGithubUserId: "4242", boundByDeveloperId: OWNER, status: "active", boundAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
    expect(w.db.get(githubInstallationKey(501))).toMatchObject(record);
    expect(w.db.get(orgGithubInstallationKey(TEST_ORG, 501))).toMatchObject(record);
    expect(w.db.get(githubInstallationEverBoundKey(501))).toMatchObject({ firstBoundAt: new Date(NOW).toISOString(), firstOrgId: TEST_ORG });
    expect(w.unlock).toHaveBeenCalledExactlyOnceWith({ orgId: TEST_ORG, githubUserId: "4242" });
    expect(w.db.get(trialGithubKey("4242"))).toMatchObject({ orgId: TEST_ORG });
    expect(w.db.get(orgMetaKey(TEST_ORG))).toMatchObject({ trialUnlockedAt: NOW, trialGithubUserId: "4242" });
    expect(w.db.refusals).toEqual([]);
    // The user token is revoked once, on this path, and never again.
    expect(revokes(w)).toBe(1);
  });

  it("an installation already in the tombstone may be bound by its admin, and the tombstone keeps its first org", async () => {
    const w = standard();
    w.db.set({ ...githubInstallationEverBoundKey(501), firstBoundAt: "2026-01-01T00:00:00.000Z", firstOrgId: ORG_B });
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("connected");
    expect(w.db.get(githubInstallationEverBoundKey(501))).toMatchObject({ firstBoundAt: "2026-01-01T00:00:00.000Z", firstOrgId: ORG_B });
    expect(w.db.get(githubInstallationKey(501))).toMatchObject({ orgId: TEST_ORG });
  });

  it("a crafted installation id the user cannot reach is not_yours, nothing is written, and the token is revoked once (Review Focus 3)", async () => {
    const w = standard({ installs: { 501: ACME_ORG, 999: install(999, { login: "victim", id: 1, type: "Organization" }) } });
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state, { installation_id: "999" }));
    expect(result.outcome).toBe("not_yours");
    expect(result.confirmToken).toBeUndefined();
    expect(installationItems(w.db)).toEqual([]);
    expect(w.db.get(githubConnectStateKey(started.stateHash))).toHaveProperty("consumedAt");
    expect(revokes(w)).toBe(1);
  });

  it("a read-only collaborator (a member of the GitHub organization) is not_yours, and nothing is written (Review Focus 3, C1)", async () => {
    const w = standard({ users: { ghu_alice: { ...ALICE, installations: [501, 999], memberships: { victim: { state: "active", role: "member" } } } }, installs: { 999: install(999, { login: "victim", id: 1, type: "Organization" }) } });
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state, { installation_id: "999" }));
    expect(result).toMatchObject({ outcome: "not_yours", accountLogin: "victim" });
    expect(installationItems(w.db)).toEqual([]);
    expect(githubCalls(w, /memberships\/orgs\/victim/)).toHaveLength(1);
    expect(revokes(w)).toBe(1);
  });

  it("a pending or missing membership is not an admin either", async () => {
    for (const membership of [{ state: "pending", role: "admin" }, undefined]) {
      const w = standard({ users: { ghu_alice: { ...ALICE, memberships: membership === undefined ? {} : { acme: membership } } } });
      const started = await start(w);
      expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("not_yours");
      expect(installationItems(w.db)).toEqual([]);
    }
  });

  it("an installation disconnected by DELETE (tombstone only) and then claimed by a non-admin member is not_yours (C1)", async () => {
    const w = standard({ users: { ghu_alice: { ...ALICE, memberships: { acme: { state: "active", role: "member" } } } } });
    w.db.set({ ...githubInstallationEverBoundKey(501), firstBoundAt: "2026-01-01T00:00:00.000Z", firstOrgId: ORG_B });
    const started = await start(w);
    expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("not_yours");
    expect(bound(w.db, 501)).toBe(false);
  });

  it("a User account passes for that same user and fails for another; an Enterprise account is not_yours", async () => {
    const personal = install(502, { login: "alice", id: 4242, type: "User" });
    const bobs = install(503, { login: "bob", id: 777, type: "User" });
    const enterprise = install(504, { login: "bigco", id: 5, type: "Enterprise" });
    const users = { ghu_alice: { id: 4242, installations: [502, 503, 504], memberships: { bigco: { state: "active", role: "admin" } } } };
    const w = world({ installs: { 502: personal, 503: bobs, 504: enterprise }, users, codes: { c1: "ghu_alice", c2: "ghu_alice", c3: "ghu_alice" } });
    const first = await start(w);
    const own = await completeGithubConnect(w.deps, { code: "c1", installation_id: "502", setup_action: "install", state: first.state });
    expect(own).toMatchObject({ outcome: "confirm", accountLogin: "alice" });
    expect((await confirmGithubConnect(w.deps, { connect: first.stateHash, decision: "connect" }, own.confirmToken, CELL)).outcome).toBe("connected");
    expect(w.db.get(githubInstallationKey(502))).toMatchObject({ accountType: "User", accountId: 4242 });
    const second = await start(w);
    expect((await completeGithubConnect(w.deps, { code: "c2", installation_id: "503", setup_action: "install", state: second.state })).outcome).toBe("not_yours");
    const third = await start(w);
    expect((await completeGithubConnect(w.deps, { code: "c3", installation_id: "504", setup_action: "install", state: third.state })).outcome).toBe("not_yours");
    expect(bound(w.db, 503) || bound(w.db, 504)).toBe(false);
  });

  it("someone else's link binds nothing: a GitHub account linked to another developer, or to no one (Review Focus 4, C2)", async () => {
    // A link started by the owner (developer OWNER), completed by the admin's GitHub account 4343, who is an admin of acme on GitHub.
    const users = { ghu_acme_admin: { id: 4343, installations: [501], memberships: { acme: { state: "active", role: "admin" } } }, ghu_stranger: { id: 9999, installations: [501], memberships: { acme: { state: "active", role: "admin" } } } };
    const w = world({ installs: { 501: ACME_ORG }, users, codes: { adminCode: "ghu_acme_admin", strangerCode: "ghu_stranger" } });
    const byAdmin = await start(w);
    const refusedAdmin = await completeGithubConnect(w.deps, { code: "adminCode", installation_id: "501", setup_action: "install", state: byAdmin.state });
    expect(refusedAdmin.outcome).toBe("not_linked");
    expect(refusedAdmin.confirmToken).toBeUndefined();
    const byStranger = await start(w);
    expect((await completeGithubConnect(w.deps, { code: "strangerCode", installation_id: "501", setup_action: "install", state: byStranger.state })).outcome).toBe("not_linked");
    expect(installationItems(w.db)).toEqual([]);
    // Both states are used up: the owner's own attempt with either now says the link expired.
    expect((await completeGithubConnect(w.deps, callbackQuery(byAdmin.state))).outcome).toBe("expired");
    expect(revokes(w)).toBe(2);
  });

  it("an unlinked GitHub identity is not the developer, even when it is the account the developer once used", async () => {
    const w = standard();
    w.db.set({ pk: `SIGNIN_IDENTITY#${ownerKeyForSubject("https://github.com", "4242")}`, sk: "META", developerId: OWNER, provider: "github", issuer: "https://github.com", subject: "4242", linkedAt: "x", lastSignInAt: "x", unlinkedFrom: OWNER, unlinkedAt: "y" });
    const started = await start(w);
    expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("not_linked");
  });

  it("an installation bound to another org is taken at the callback, and the other org's binding stays as it was", async () => {
    const w = standard();
    const other = { ...githubInstallationKey(501), entityType: "GITHUB_INSTALLATION", installationId: 501, orgId: ORG_B, accountLogin: "acme", status: "active", boundAt: "2026-09-01T00:00:00.000Z" };
    w.db.set(other);
    const started = await start(w);
    expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("taken");
    expect(w.db.get(githubInstallationKey(501))).toEqual(other);
    expect(w.db.get(orgGithubInstallationKey(TEST_ORG, 501))).toBeUndefined();
    expect(revokes(w)).toBe(1);
  });

  it("an installation bound to another org between the callback and the confirmation is taken at the confirmation, and writes nothing else", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    const other = { ...githubInstallationKey(501), entityType: "GITHUB_INSTALLATION", installationId: 501, orgId: ORG_B, status: "active" };
    w.db.set(other);
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("taken");
    expect(w.db.get(githubInstallationKey(501))).toEqual(other);
    expect(w.db.get(orgGithubInstallationKey(TEST_ORG, 501))).toBeUndefined();
    expect(w.db.get(githubInstallationEverBoundKey(501))).toBeUndefined();
    expect(w.unlock).not.toHaveBeenCalled();
  });

  it("the confirmation binds nothing without the cookie, with another state's cookie, or with a foreign Origin; the right cookie still works after", async () => {
    const w = standard();
    const first = await start(w);
    const mine = await completeGithubConnect(w.deps, callbackQuery(first.state));
    const attempt = (cookie: string | undefined, origin: string | null = CELL) => confirmGithubConnect(w.deps, { connect: first.stateHash, decision: "connect" }, cookie, origin ?? undefined);
    expect((await attempt(undefined)).outcome).toBe("expired");
    expect((await attempt("A".repeat(43))).outcome).toBe("expired");
    expect((await attempt(mine.confirmToken!.replace(/.$/, mine.confirmToken!.endsWith("A") ? "B" : "A"))).outcome).toBe("expired");
    await expect(attempt(mine.confirmToken, "https://evil.example")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(attempt(mine.confirmToken, null)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(installationItems(w.db)).toEqual([]);
    expect(w.db.get(githubConnectStateKey(first.stateHash))).not.toHaveProperty("consumedAt");
    expect((await attempt(mine.confirmToken)).outcome).toBe("connected");
  });

  it("another state's cookie does not confirm this state", async () => {
    const w = world({ installs: { 501: ACME_ORG, 502: install(502, { login: "acme2", id: 901, type: "Organization" }) }, users: { ghu_alice: { ...ALICE, installations: [501, 502], memberships: { acme: { state: "active", role: "admin" }, acme2: { state: "active", role: "admin" } } } }, codes: { code1: "ghu_alice", code2: "ghu_alice" } });
    const first = await start(w);
    const second = await start(w);
    const a = await completeGithubConnect(w.deps, callbackQuery(first.state));
    const b = await completeGithubConnect(w.deps, { code: "code2", installation_id: "502", setup_action: "install", state: second.state });
    expect((await confirmGithubConnect(w.deps, { connect: first.stateHash, decision: "connect" }, b.confirmToken, CELL)).outcome).toBe("expired");
    expect(installationItems(w.db)).toEqual([]);
    expect((await confirmGithubConnect(w.deps, { connect: first.stateHash, decision: "connect" }, a.confirmToken, CELL)).outcome).toBe("connected");
    expect(bound(w.db, 502)).toBe(false);
  });

  it("cancel binds nothing and uses the state up", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "cancel" }, result.confirmToken, CELL)).outcome).toBe("cancelled");
    expect(installationItems(w.db)).toEqual([]);
    expect(w.unlock).not.toHaveBeenCalled();
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("expired");
  });

  it("a reused state is expired, at the callback and at the confirmation", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    // A second callback with the same state (a refreshed page, a replay) is refused, and so is its code exchange.
    const exchangesBefore = githubCalls(w, /access_token/).length;
    expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("expired");
    expect(githubCalls(w, /access_token/)).toHaveLength(exchangesBefore);
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("connected");
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("expired");
    expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("expired");
    // The second confirmation changed nothing.
    expect(w.unlock).toHaveBeenCalledTimes(1);
  });

  it("an unknown, malformed or expired state is expired, and GitHub is never called", async () => {
    const w = standard();
    expect((await completeGithubConnect(w.deps, callbackQuery("x".repeat(43)))).outcome).toBe("expired");
    expect((await completeGithubConnect(w.deps, callbackQuery("short"))).outcome).toBe("expired");
    expect((await completeGithubConnect(w.deps, {})).outcome).toBe("expired");
    const started = await start(w);
    w.advance(900_001);
    expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("expired");
    expect(w.fetch.calls).toEqual([]);
  });

  it("a confirmation after the state ran out is expired and binds nothing", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    w.advance(900_001);
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("expired");
    expect(installationItems(w.db)).toEqual([]);
  });

  it("a person demoted, removed or whose org closed between the callback and the confirmation binds nothing", async () => {
    for (const change of ["demote", "remove", "close"] as const) {
      const w = standard();
      const started = await start(w);
      const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
      if (change === "demote") w.db.set({ ...w.db.get(orgMemberKey(TEST_ORG, OWNER))!, role: "member" });
      if (change === "remove") w.db.delete(orgMemberKey(TEST_ORG, OWNER));
      if (change === "close") w.db.set({ ...w.db.get(orgMetaKey(TEST_ORG))!, closedAt: "2026-10-21T00:00:00.000Z" });
      expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("not_allowed");
      expect(installationItems(w.db)).toEqual([]);
    }
  });

  it("an Origin of \"null\" is refused like any other foreign Origin, and nothing is consumed", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    await expect(confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, "null")).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("connected");
  });

  it("a confirmation that fails for a reason other than a condition is the expired page, not a thrown error", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    const send = w.deps.documentClient.send.bind(w.deps.documentClient);
    w.deps.documentClient.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      return send(command);
    });
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("expired");
    expect(installationItems(w.db)).toEqual([]);
  });

  it("the trial already claimed by this GitHub account is connected_trial_used, and the binding is written", async () => {
    const w = standard({ orgPlan: "trial" });
    w.db.set({ ...trialGithubKey("4242"), entityType: "TRIAL_GITHUB", orgId: ORG_B, claimedAt: 1 });
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    expect((await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("connected_trial_used");
    expect(w.db.get(githubInstallationKey(501))).toMatchObject({ orgId: TEST_ORG });
    expect(w.db.get(orgMetaKey(TEST_ORG))).not.toHaveProperty("trialUnlockedAt");
    expect(w.db.get(orgMetaKey(TEST_ORG))).toMatchObject({ trialGithubUsedAt: NOW });
  });

  it("another unlock failure is logged by name and the outcome is connected", async () => {
    const w = standard();
    const failing = { ...w.deps, unlockTrial: async () => { throw Object.assign(new Error("boom"), { name: "ThrottlingException" }); } };
    const started = await start(w);
    const result = await completeGithubConnect(failing, callbackQuery(started.state));
    expect((await confirmGithubConnect(failing, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL)).outcome).toBe("connected");
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "github.connect_trial_unlock_failed", error: "ThrottlingException" }));
  });

  it("setup_action=request records the request (Task 14): requested, the user token revoked once, no installation written, the state used", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, { setup_action: "request", state: started.state, installation_id: "501", code: "code1" });
    expect(result.outcome).toBe("requested");
    expect(installationItems(w.db)).toEqual([]);
    expect(w.db.get(githubConnectStateKey(started.stateHash))).toHaveProperty("consumedAt");
    expect(w.db.get({ pk: "GITHUB_INSTALL_REQUEST#4242", sk: "META" })).toMatchObject({ orgId: TEST_ORG, developerId: OWNER, githubUserId: "4242", status: "waiting" });
    expect(revokes(w)).toBe(1);
  });

  it("setup_action=request with no code attributes nothing: its own outcome (not expired), no token exchange, nothing recorded or written but the used state", async () => {
    const w = standard();
    const started = await start(w);
    const result = await completeGithubConnect(w.deps, { setup_action: "request", state: started.state, installation_id: "501" });
    expect(result.outcome).toBe("unattributed");
    expect(w.fetch.calls).toEqual([]);
    expect(installationItems(w.db)).toEqual([]);
    expect(w.db.find((item) => String(item.pk).startsWith("GITHUB_INSTALL_REQUEST"))).toEqual([]);
    expect(w.db.get(githubConnectStateKey(started.stateHash))).toHaveProperty("consumedAt");
    expect(w.logs).toContainEqual(expect.objectContaining({ event: "github.install_request_unattributed", reason: "no_code" }));
  });

  it("a code GitHub refuses, a missing code or a bad installation id is expired and binds nothing", async () => {
    const w = standard();
    const refused = await start(w);
    expect((await completeGithubConnect(w.deps, callbackQuery(refused.state, { code: "nope" }))).outcome).toBe("expired");
    const noCode = await start(w);
    expect((await completeGithubConnect(w.deps, { installation_id: "501", state: noCode.state })).outcome).toBe("expired");
    const badId = await start(w);
    expect((await completeGithubConnect(w.deps, callbackQuery(badId.state, { installation_id: "5x1" }))).outcome).toBe("expired");
    expect(installationItems(w.db)).toEqual([]);
  });

  it("a GitHub outage mid-callback is expired, never a binding, and the token is still revoked", async () => {
    const w = standard();
    const failing = { ...w.deps, app: { ...w.deps.app, installation: async () => { throw agentXError("RUNTIME_UNAVAILABLE", "down"); } } };
    const started = await start(w);
    expect((await completeGithubConnect(failing, callbackQuery(started.state))).outcome).toBe("expired");
    expect(installationItems(w.db)).toEqual([]);
    expect(revokes(w)).toBe(1);
  });

  it("finds an installation on the second page of the user's installations", async () => {
    const many = Array.from({ length: 100 }, (_, index) => 10_000 + index);
    const w = standard({ users: { ghu_alice: { ...ALICE, installations: [...many, 501] } } });
    const started = await start(w);
    expect((await completeGithubConnect(w.deps, callbackQuery(started.state))).outcome).toBe("confirm");
    expect(githubCalls(w, /user\/installations/)).toHaveLength(2);
  });

  it("logs no code, state, confirmation token, user token or client secret, on any path", async () => {
    const w = standard({ orgPlan: "trial" });
    const secrets: string[] = [CLIENT_SECRET, "ghu_alice", "code1"];
    const started = await start(w);
    secrets.push(started.state);
    const result = await completeGithubConnect(w.deps, callbackQuery(started.state));
    secrets.push(result.confirmToken!);
    await confirmGithubConnect(w.deps, { connect: started.stateHash, decision: "connect" }, result.confirmToken, CELL);
    const other = await start(w);
    secrets.push(other.state);
    await completeGithubConnect(w.deps, callbackQuery(other.state, { installation_id: "999" }));
    const logged = JSON.stringify(w.logs);
    expect(logged).not.toMatch(/gh[ou]_/);
    for (const secret of secrets) expect(logged).not.toContain(secret);
    expect(w.logs.length).toBeGreaterThan(3);
  });

  it("revokes the user token once on every path that exchanged a code, and never on one that did not", async () => {
    const paths: Array<[string, (w: World, state: string) => Promise<unknown>, number]> = [
      ["confirm", (w, state) => completeGithubConnect(w.deps, callbackQuery(state)), 1],
      ["not_yours", (w, state) => completeGithubConnect(w.deps, callbackQuery(state, { installation_id: "999" })), 1],
      ["request without a code", (w, state) => completeGithubConnect(w.deps, { setup_action: "request", state }), 0],
      ["request with a code", (w, state) => completeGithubConnect(w.deps, { setup_action: "request", state, code: "code1" }), 1],
      ["refused code", (w, state) => completeGithubConnect(w.deps, callbackQuery(state, { code: "nope" })), 0],
    ];
    for (const [, run, expected] of paths) {
      const w = standard();
      const started = await start(w);
      await run(w, started.state);
      expect(revokes(w)).toBe(expected);
    }
  });
});

describe("the callback route", () => {
  it("answers a failure the flow did not map with the expired page, not raw JSON", async () => {
    const { routeGithubInstall } = await import("../../packages/broker/src/aws/github-install-web.js");
    const w = standard();
    const started = await start(w);
    const deps = { ...w.deps, orgs: { getOrg: async () => { throw Object.assign(new Error("boom"), { name: "ThrottlingException" }); } } };
    const request = { method: "GET", path: "/v1/github/install/callback", headers: {}, requestId: "r" };
    const page = await routeGithubInstall(deps, request, new URL(`https://cell.example/v1/github/install/callback?code=code1&installation_id=501&setup_action=install&state=${started.state}`));
    expect(page.statusCode).toBe(410);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("This connect link has expired");
    expect(w.logs).toContainEqual({ event: "github.connect_callback_failed", error: "ThrottlingException" });
  });
});

describe("the cookie", () => {
  it("is a __Host- cookie that is Secure, HttpOnly, SameSite=Strict, for the whole host, for ten minutes; clearing it expires it", () => {
    expect(connectCookie("tok")).toBe("__Host-rovara_gh_connect=tok; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600");
    expect(clearedConnectCookie()).toContain("Max-Age=0");
  });
});

describe("through the broker", () => {
  const ACME = { id: 4242, installations: [501], memberships: { acme: { state: "active", role: "admin" } } };

  async function broker(options: { cloud?: boolean } = {}) {
    const users = { ghu_alice: ACME };
    const github = fakeGithub(users, { code1: "ghu_alice", code2: "ghu_alice" });
    const fetch = routeFetch(github.handler);
    const harness = await createDeveloperTaskBroker({
      brokerExtra: {
        ...(options.cloud === false ? {} : { cloud: true }),
        githubFetch: fetch,
        githubPullRequests: {
          reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), verifyWebhookRepository: vi.fn(),
          appSlug: async () => "rovara-cloud", oauthClient: async () => ({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
          installation: async (id: number) => { if (id !== 501) throw agentXError("NOT_FOUND", "GitHub has no such installation of this App"); return ACME_ORG; },
        },
      },
    });
    seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    harness.db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme <img src=x onerror=alert(1)>", createdAt: "x", createdBy: "system", plan: "team" });
    const identityKey = ownerKeyForSubject("https://github.com", "4242");
    const link = { developerId: OMAR.developerId, provider: "github", issuer: "https://github.com", subject: "4242", linkedAt: "2026-10-01T00:00:00.000Z", lastSignInAt: "2026-10-01T00:00:00.000Z" };
    const linkGithub = () => {
      harness.db.set({ pk: `SIGNIN_IDENTITY#${identityKey}`, sk: "META", entityType: "IDENTITY_LINK", ...link });
      harness.db.set({ pk: `DEVELOPER#${OMAR.developerId}`, sk: `IDENTITY#${identityKey}`, entityType: "DEVELOPER_IDENTITY", ...link });
    };
    const publicCall = async (method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
      const reply = await harness.handler({
        version: "2.0", routeKey: `${method} ${path.split("?")[0]}`, rawPath: path.split("?")[0]!, rawQueryString: path.split("?")[1] ?? "", headers,
        ...(body === undefined ? {} : { body }), requestContext: { requestId: "r-1", http: { method } },
      });
      return { statusCode: reply.statusCode, headers: "headers" in reply ? reply.headers as Record<string, string> : {}, body: reply.body };
    };
    return { ...harness, github, fetch, linkGithub, publicCall };
  }
  const cookieOf = (setCookie: string | undefined) => /^(__Host-rovara_gh_connect)=([^;]*)/.exec(setCookie ?? "");

  it("POST /v1/app/github/connect: a member is 403, an owner with no linked GitHub identity is 403 with the exact words, a linked owner gets the link", async () => {
    const b = await broker();
    const member = await b.dev(MAYA, "POST", "/v1/app/github/connect");
    expect(member.status).toBe(403);
    expect(member.body.error).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("only an owner or admin can connect GitHub") as string });
    const unlinked = await b.dev(OMAR, "POST", "/v1/app/github/connect");
    expect(unlinked.status).toBe(403);
    expect(JSON.stringify(unlinked.body.error)).toContain(STARTED_MESSAGE);
    expect(b.db.find((item) => String(item.pk).startsWith("GITHUB_CONNECT#"))).toEqual([]);
    b.linkGithub();
    const linked = await b.dev(OMAR, "POST", "/v1/app/github/connect");
    expect(linked.status).toBe(200);
    expect(linked.body.installUrl).toMatch(/^https:\/\/github\.com\/apps\/rovara-cloud\/installations\/new\?state=/);
    expect(typeof linked.body.expiresAt).toBe("string");
  });

  it("POST /v1/app/github/connect on an install that is not Rovara Cloud is 403 with the administrator words, and the public routes are 404", async () => {
    const b = await broker({ cloud: false });
    b.linkGithub();
    const refused = await b.dev(OMAR, "POST", "/v1/app/github/connect");
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body.error)).toContain("on this install, GitHub is connected by the administrator during agentx init");
    expect((await b.publicCall("GET", "/v1/github/install/callback?state=x")).statusCode).toBe(404);
    expect((await b.publicCall("POST", "/v1/github/install/confirm", {}, "connect=x&decision=connect")).statusCode).toBe(404);
  });

  it("UX3: a connect started from the Connections page ends there; one started the old way, or with an unknown place, ends in onboarding, and no place is ever taken from a request", async () => {
    const b = await broker();
    b.linkGithub();
    const confirmFor = async (state: string) => {
      const callback = await b.publicCall("GET", `/v1/github/install/callback?code=code1&installation_id=501&setup_action=install&state=${state}`);
      const token = cookieOf(callback.headers["set-cookie"])![2]!;
      return b.publicCall("POST", "/v1/github/install/confirm", { origin: CELL, cookie: `__Host-rovara_gh_connect=${token}`, "content-type": "application/x-www-form-urlencoded" }, `connect=${sha(state)}&decision=connect`);
    };
    // A place that is not one of the two fixed ones is refused when the connect starts.
    for (const returnTo of ["https://evil.example/", "/app/admin/people", "//evil.example", 7]) expect((await b.dev(OMAR, "POST", "/v1/app/github/connect", { returnTo })).status).toBe(400);
    const fromConnections = (await b.dev(OMAR, "POST", "/v1/app/github/connect", { returnTo: "/app/admin/connections" })).body as { installUrl: string };
    const state = new URL(fromConnections.installUrl).searchParams.get("state")!;
    expect(b.db.get(githubConnectStateKey(sha(state)))).toMatchObject({ returnTo: "/app/admin/connections" });
    // A callback page that ends without a confirm (the request path) also goes back to Connections.
    const requested = await b.publicCall("GET", `/v1/github/install/callback?code=code1&installation_id=501&setup_action=request&state=${state}`);
    expect(requested.body).toContain('href="/app/admin/connections?open=github"');expect(requested.body).not.toContain("/app/onboard");
    const second = new URL(((await b.dev(OMAR, "POST", "/v1/app/github/connect", { returnTo: "/app/admin/connections" })).body as { installUrl: string }).installUrl).searchParams.get("state")!;
    const confirmed = await confirmFor(second);
    expect(confirmed.body).toContain("<h1>GitHub connected</h1>");expect(confirmed.body).toContain('<a class="rv-next" href="/app/admin/connections?open=github">Continue in Rovara</a>');expect(confirmed.body).not.toContain("/app/onboard");
    // The old way (an empty body, as the command line sends it) and an explicit onboarding both end in onboarding.
    const plain = (await b.dev(OMAR, "POST", "/v1/app/github/connect")).body as { installUrl: string };
    expect(b.db.get(githubConnectStateKey(sha(new URL(plain.installUrl).searchParams.get("state")!)))?.returnTo).toBeUndefined();
    const onboard = (await b.dev(OMAR, "POST", "/v1/app/github/connect", { returnTo: "/app/onboard" })).body as { installUrl: string };
    const cancelled = await b.publicCall("GET", `/v1/github/install/callback?code=code1&installation_id=501&setup_action=install&state=${new URL(onboard.installUrl).searchParams.get("state")!}`);
    expect(cancelled.body).toContain("Connect acme");
    // A state nobody knows ends in onboarding.
    expect((await b.publicCall("GET", "/v1/github/install/callback?state=" + "A".repeat(43))).body).toContain('href="/app/onboard">Back to Rovara</a>');
  });

  it("the whole flow: link, callback page with the cookie, confirmation page, both keys, cookie cleared", async () => {
    const b = await broker();
    b.linkGithub();
    const { installUrl } = (await b.dev(OMAR, "POST", "/v1/app/github/connect")).body as { installUrl: string };
    const state = new URL(installUrl).searchParams.get("state")!;
    const callback = await b.publicCall("GET", `/v1/github/install/callback?code=code1&installation_id=501&setup_action=install&state=${state}`);
    expect(callback.statusCode).toBe(200);
    expect(callback.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(callback.headers["content-security-policy"]).toMatch(/default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
    expect(callback.headers["cache-control"]).toContain("no-store");
    expect(callback.body).toContain("<h1>Connect acme to Acme &lt;img src=x onerror=alert(1)&gt;?</h1>");
    expect(callback.body).not.toContain("<img");
    expect(callback.body).toContain("Rovara will be able to read and write the repositories you gave it access to in acme, for everyone in Acme &lt;img src=x onerror=alert(1)&gt;.");
    expect(callback.body).toContain(`name="connect" value="${sha(state)}"`);
    expect(callback.body).toMatch(/>Connect<\/button>.*>Cancel<\/button>/);
    expect(callback.body).not.toContain(state);
    // The page's own form post must carry its real Origin, so the page may not say no-referrer (a browser would send "Origin: null").
    expect(callback.headers["referrer-policy"]).toBe("same-origin");
    const set = callback.headers["set-cookie"]!;
    expect(set).toMatch(/^__Host-rovara_gh_connect=[A-Za-z0-9_-]{43}; Secure; HttpOnly; SameSite=Strict; Path=\/; Max-Age=600$/);
    expect(b.db.get(githubInstallationKey(501))).toBeUndefined();

    const token = cookieOf(set)![2]!;
    const form = `connect=${sha(state)}&decision=connect`;
    const headers = { origin: CELL, cookie: `__Host-rovara_gh_connect=${token}`, "content-type": "application/x-www-form-urlencoded" };
    const confirmed = await b.publicCall("POST", "/v1/github/install/confirm", headers, form);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body).toContain("<h1>GitHub connected</h1>");
    expect(confirmed.body).toContain("acme is now connected to Acme &lt;img src=x onerror=alert(1)&gt;.");
    // UX1: a button to the next step in the app, never a terminal command.
    expect(confirmed.body).toContain('<a class="rv-next" href="/app/onboard?github=connected">Continue in Rovara</a>');expect(confirmed.body).not.toContain("agentx");
    expect(confirmed.headers["set-cookie"]).toContain("Max-Age=0");
    expect(b.db.get(githubInstallationKey(501))).toMatchObject({ orgId: TEST_ORG, accountLogin: "acme", boundByDeveloperId: OMAR.developerId });
    expect(b.db.get(orgGithubInstallationKey(TEST_ORG, 501))).toMatchObject({ orgId: TEST_ORG });
    expect(b.github.revoked).toEqual(["ghu_alice"]);
    // The same post again is a used state.
    const again = await b.publicCall("POST", "/v1/github/install/confirm", headers, form);
    expect(again.statusCode).toBe(410);
    expect(again.body).toContain("<h1>This connect link has expired</h1>");
  });

  it("the confirmation refuses a foreign Origin with 400 and a missing cookie as expired, and binds nothing", async () => {
    const b = await broker();
    b.linkGithub();
    const { installUrl } = (await b.dev(OMAR, "POST", "/v1/app/github/connect")).body as { installUrl: string };
    const state = new URL(installUrl).searchParams.get("state")!;
    const callback = await b.publicCall("GET", `/v1/github/install/callback?code=code1&installation_id=501&setup_action=install&state=${state}`);
    const token = cookieOf(callback.headers["set-cookie"])![2]!;
    const form = `connect=${sha(state)}&decision=connect`;
    expect((await b.publicCall("POST", "/v1/github/install/confirm", { origin: "https://evil.example", cookie: `__Host-rovara_gh_connect=${token}` }, form)).statusCode).toBe(400);
    expect((await b.publicCall("POST", "/v1/github/install/confirm", { cookie: `__Host-rovara_gh_connect=${token}` }, form)).statusCode).toBe(400);
    // A browser whose page said no-referrer posts "Origin: null": still refused, never accepted as the cell.
    expect((await b.publicCall("POST", "/v1/github/install/confirm", { origin: "null", cookie: `__Host-rovara_gh_connect=${token}` }, form)).statusCode).toBe(400);
    expect((await b.publicCall("POST", "/v1/github/install/confirm", { origin: CELL }, form)).statusCode).toBe(410);
    expect((await b.publicCall("POST", "/v1/github/install/confirm", { origin: CELL, cookie: `__Host-rovara_gh_connect=${token}` }, "connect=zz&decision=maybe")).statusCode).toBe(400);
    expect(b.db.get(githubInstallationKey(501))).toBeUndefined();
  });

  it("someone else's link, completed by the GitHub admin of the account, shows the sign-in page and binds nothing (Review Focus 4)", async () => {
    const b = await broker();
    b.linkGithub();
    // Omar's link, completed in the browser of the GitHub user 4242 ... who is not linked to Omar in this table: only the link is removed.
    const { installUrl } = (await b.dev(OMAR, "POST", "/v1/app/github/connect")).body as { installUrl: string };
    b.db.delete({ pk: `SIGNIN_IDENTITY#${ownerKeyForSubject("https://github.com", "4242")}`, sk: "META" });
    const state = new URL(installUrl).searchParams.get("state")!;
    const callback = await b.publicCall("GET", `/v1/github/install/callback?code=code1&installation_id=501&setup_action=install&state=${state}`);
    expect(callback.statusCode).toBe(403);
    expect(callback.body).toContain("Link this GitHub account to your Rovara account first");expect(callback.body).toContain('href="/app/onboard?github=not_linked"');
    expect(callback.headers["set-cookie"]).toBeUndefined();
    expect(b.db.get(githubInstallationKey(501))).toBeUndefined();
  });

  it("serves the other outcomes' pages with their exact words", async () => {
    const b = await broker();
    const expired = await b.publicCall("GET", `/v1/github/install/callback?state=${"z".repeat(43)}`);
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain("<h1>This connect link has expired</h1>");expect(expired.body).toContain('href="/app/onboard">Back to Rovara</a>');
    b.linkGithub();
    const { installUrl } = (await b.dev(OMAR, "POST", "/v1/app/github/connect")).body as { installUrl: string };
    const state = new URL(installUrl).searchParams.get("state")!;
    const requested = await b.publicCall("GET", `/v1/github/install/callback?setup_action=request&code=code1&state=${state}`);
    expect(requested.body).toContain("<h1>Waiting for your GitHub admin</h1>");
    expect(requested.body).toContain("You asked an admin of your GitHub organization to approve Rovara.");
    expect(requested.body).toContain("The request stays open for 7 days.");
    expect(requested.body).toContain("Tell them: for Rovara org Acme &lt;img src=x onerror=alert(1)&gt; (owner ");
    expect(requested.body).not.toContain("<img");
    expect(b.db.get({ pk: "GITHUB_INSTALL_REQUEST#4242", sk: "META" })).toMatchObject({ orgId: TEST_ORG, developerId: OMAR.developerId, status: "waiting" });
  });
});

describe("the pages", () => {
  it("say the exact words of every outcome", async () => {
    const { githubConnectPage } = await import("../../packages/broker/src/org/github-connect-page.js");
    const text = (kind: Parameters<typeof githubConnectPage>[0], data = { accountLogin: "acme", orgName: "Acme" }) => githubConnectPage(kind, data).body.replace(/<style[^>]*>.*?<\/style>/, "");
    expect(text("connected_trial_used")).toContain("Your free trial stays locked: this GitHub account already started a trial for another organization.");
    expect(text("cancelled")).toContain("<h1>Nothing was connected</h1>");
    expect(text("cancelled")).toContain("You can connect GitHub again from Rovara whenever you&#39;re ready.");
    expect(text("taken")).toContain(`<h1>${GITHUB_INSTALLATION_TAKEN_MESSAGE}</h1>`);
    expect(githubConnectPage("taken").statusCode).toBe(409);
    expect(text("not_yours")).toContain("<h1>Only the account&#39;s owner or an admin of the GitHub organization can connect it</h1>");
    expect(text("not_yours")).toContain("Choose a GitHub account you own, or ask an admin of acme on GitHub to approve Rovara&#39;s request.");
    expect(githubConnectPage("confirm", { accountLogin: "acme", orgName: "Acme", connectId: "a".repeat(64) }).headers["referrer-policy"]).toBe("same-origin");
    expect(githubConnectPage("not_allowed", { orgName: "Acme" }).statusCode).toBe(403);
    expect(text("not_allowed")).toContain("<h1>Nothing was connected</h1>");
    expect(text("not_allowed")).toContain("The Rovara organization Acme was closed, or you are no longer its owner or admin. Ask an owner or admin of Acme to connect GitHub from Rovara.");
    expect(text("not_linked")).toContain("This connect link was started by someone else in Rovara, or your GitHub account isn&#39;t linked to your Rovara account yet. In Rovara, choose Link your GitHub account, then connect GitHub again.");
    // UX1: no browser page of the connect flow speaks CLI, and every one but the confirm form has a button to the next step.
    for (const kind of ["connected", "connected_trial_used", "cancelled", "requested", "not_linked", "not_yours", "not_allowed", "unattributed", "taken", "expired"] as const) { expect(text(kind)).not.toContain("agentx");expect(text(kind)).toMatch(/<a class="rv-next" href="\/app[^"]*">/); }
  });
});

describe("infrastructure", () => {
  let template: { Resources: Record<string, { Type: string; Properties: Record<string, unknown>; DependsOn?: string | string[] }> };
  beforeAll(() => {
    const app = buildAgentXApp({ agentxEnv: "staging" });
    template = Template.fromStack(app.node.children.find((child): child is Stack => Stack.isStack(child) && child.stackName === "agentx-staging-control-plane")!).toJSON() as typeof template;
  }, 300_000);

  it("routes the callback and the confirmation without an authorizer, and throttles both on the stage like the other public routes", () => {
    const routes = Object.entries(template.Resources).filter(([, resource]) => resource.Type === "AWS::ApiGatewayV2::Route");
    for (const key of ["GET /v1/github/install/callback", "POST /v1/github/install/confirm"]) {
      const found = routes.filter(([, route]) => route.Properties.RouteKey === key);
      expect(found).toHaveLength(1);
      expect(found[0]![1].Properties.AuthorizationType).toBe("NONE");
    }
    const [stage] = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::ApiGatewayV2::Stage");
    const settings = stage!.Properties.RouteSettings as Record<string, unknown>;
    expect(settings["GET /v1/github/install/callback"]).toEqual({ ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 });
    expect(settings["POST /v1/github/install/confirm"]).toEqual({ ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 });
    const depends = [stage!.DependsOn].flat();
    for (const key of ["GET /v1/github/install/callback", "POST /v1/github/install/confirm"]) {
      expect(depends).toContain(routes.find(([, route]) => route.Properties.RouteKey === key)![0]);
    }
  });
});

describe("agentx github connect", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
  const ISSUER = `${CELL}/v1/auth`;
  const entry = { url: CELL, issuer: ISSUER, tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke` };

  async function cli(answer: (method: string, path: string, count: number, requests: number) => Response | undefined, github: { pollMs?: number; waitMs?: number } = {}) {
    const home = await mkdtemp(join(tmpdir(), "rovara-github-cli-"));
    dirs.push(home);
    await saveDeveloperEnvironment(home, "staging", entry);
    const tokenStore = new InMemoryTokenStore();
    await tokenStore.set(developerTokenKey(ISSUER), { accessToken: "access", refreshToken: `agxr_${"a".repeat(43)}`, expiresAt: Date.now() + 3_600_000 });
    const out: string[] = [];
    const err: string[] = [];
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    let lists = 0;
    let polls = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
      if (path === "/v1/app/github/installations") lists += 1;
      if (path === "/v1/app/github/requests") polls += 1;
      return answer(method, path, lists, polls) ?? new Response("unexpected", { status: 500 });
    });
    const opened: string[] = [];
    const printedBeforeOpen: string[] = [];
    const run = (argv: string[]) => executeCli(argv, {
      fetchImplementation, tokenStore, environments: { home },
      stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) },
      login: { openBrowser: async (url: string) => { opened.push(url); printedBeforeOpen.push(err.join("")); } },
      githubConnect: { pollMs: 1, waitMs: 2_000, ...github },
    });
    return { run, out, err, calls, opened, printedBeforeOpen };
  }
  const INSTALL_URL = "https://github.com/apps/rovara-cloud/installations/new?state=s";
  const started = Response.json({ installUrl: INSTALL_URL, expiresAt: "2026-10-21T12:15:00.000Z", requestId: "r" });
  const listed = (installations: Array<{ installationId: number; accountLogin: string }>) => Response.json({ installations: installations.map((entry) => ({ ...entry, accountType: "Organization", repositorySelection: "selected", status: "active" })), requestId: "r" });

  it("posts, opens the browser, polls until a new installation appears, and says which account is connected", async () => {
    const h = await cli((method, path, lists) => {
      if (method === "POST" && path === "/v1/app/github/connect") return started.clone();
      // The baseline already has installation 7; the second poll adds 501.
      if (path === "/v1/app/github/installations") return listed(lists < 3 ? [{ installationId: 7, accountLogin: "old" }] : [{ installationId: 7, accountLogin: "old" }, { installationId: 501, accountLogin: "acme" }]);
      return undefined;
    });
    expect(await h.run(["github", "connect"])).toBe(0);
    expect(h.opened).toEqual([INSTALL_URL]);
    expect(h.out.join("")).toBe("Connected acme.\n");
    expect(h.err.join("")).toContain(INSTALL_URL);
    expect(h.calls.filter((call) => call.path === "/v1/app/github/installations").length).toBeGreaterThanOrEqual(3);
  });

  // Plan 2, Task 14: "Ask my GitHub admin". The CLI prints what to write if GitHub asks for a message, then reports the request's state changes once.
  const ME = Response.json({ developer: { id: "dev-me", name: "Me", orgRole: "admin" }, org: { orgId: TEST_ORG, name: "Acme", plan: "team" }, identities: [], requestId: "r" });
  const startedNamed = () => Response.json({ installUrl: INSTALL_URL, expiresAt: "2026-10-21T12:15:00.000Z", orgName: "Acme", ownerName: "Olive", requestId: "r" });
  const request = (status: string, over: Record<string, unknown> = {}) => Response.json({ requests: [{ githubLogin: "rhea", status, requestedAt: "2026-10-21T12:00:00.000Z", expiresAt: "2026-10-28T12:00:00.000Z", requestedBy: { developerId: "dev-me", name: "Me" }, ...over }], requestId: "r" });
  const noInstallations = () => listed([]);

  it("prints the message to give the GitHub admin before it opens the browser", async () => {
    const h = await cli((method, path, _installations, count) => {
      if (method === "POST") return startedNamed();
      if (path === "/v1/app/me") return ME.clone();
      if (path === "/v1/app/github/requests") return count < 2 ? Response.json({ requests: [], requestId: "r" }) : request("connected", { accountLogin: "acme" });
      return noInstallations();
    });
    expect(await h.run(["github", "connect"])).toBe(0);
    const err = h.err.join("");
    expect(err).toContain("If GitHub asks for a message to your admin, write: for Rovara org Acme (owner Olive)");
    // Printed before the browser opens, so the person has it when GitHub's page asks.
    expect(h.opened).toEqual([INSTALL_URL]);
    expect(h.printedBeforeOpen[0]).toContain("If GitHub asks for a message to your admin, write: for Rovara org Acme (owner Olive)");
  });

  it("reports a waiting request once while it polls, then the approval, and ends connected", async () => {
    const h = await cli((method, path, installations, count) => {
      if (method === "POST") return startedNamed();
      if (path === "/v1/app/me") return ME.clone();
      if (path === "/v1/app/github/requests") return count < 4 ? (count < 2 ? Response.json({ requests: [], requestId: "r" }) : request("waiting")) : request("connected", { accountLogin: "acme" });
      return noInstallations();
    });
    expect(await h.run(["github", "connect"])).toBe(0);
    const err = h.err.join("");
    expect(err.match(/Waiting for your GitHub admin/g)).toHaveLength(1);
    expect(err).toContain("Tell them: for Rovara org Acme (owner Olive).");
    expect(err).toContain("Your GitHub admin approved Rovara. acme is now connected to Acme.");
    expect(h.out.join("")).toBe("Connected acme.\n");
  });

  it("says it is still waiting when the wait ends with the request open, and that is not a failure", async () => {
    const h = await cli((method, path, _installations, count) => {
      if (method === "POST") return startedNamed();
      if (path === "/v1/app/me") return ME.clone();
      if (path === "/v1/app/github/requests") return count < 2 ? Response.json({ requests: [], requestId: "r" }) : request("waiting");
      return noInstallations();
    }, { waitMs: 20 });
    expect(await h.run(["github", "connect"])).toBe(0);
    expect(h.err.join("")).toContain("Still waiting for your GitHub admin; check later with agentx github list.");
    expect(h.out.join("")).toBe("");
  });

  it("ends with the copy for a request that expired, was declined or needs a reinstall", async () => {
    for (const [status, words] of [
      ["expired", "Your request wasn't approved within 7 days, or your GitHub admin declined it. Run agentx github connect to ask again."],
      ["reinstall_needed", "acme was connected to Rovara before, so an approval can't reconnect it on its own."],
    ] as const) {
      const h = await cli((method, path, installations, count) => {
        if (method === "POST") return startedNamed();
        if (path === "/v1/app/me") return ME.clone();
        if (path === "/v1/app/github/requests") return count < 2 ? Response.json({ requests: [], requestId: "r" }) : request(status, { accountLogin: "acme" });
        return noInstallations();
      });
      expect(await h.run(["github", "connect"])).not.toBe(0);
      expect(h.err.join("")).toContain(words);
    }
  });

  it("does not report another member's request as its own", async () => {
    const h = await cli((method, path, installations) => {
      if (method === "POST") return startedNamed();
      if (path === "/v1/app/me") return ME.clone();
      if (path === "/v1/app/github/requests") return request("connected", { accountLogin: "other", requestedBy: { developerId: "someone-else", name: "Else" } });
      return installations < 4 ? noInstallations() : listed([{ installationId: 501, accountLogin: "acme" }]);
    });
    expect(await h.run(["github", "connect"])).toBe(0);
    expect(h.out.join("")).toBe("Connected acme.\n");
    expect(h.err.join("")).not.toContain("approved Rovara");
  });

  it("polls no requests when /v1/app/me fails, so another member's request never ends this person's wait", async () => {
    const h = await cli((method, path, installations) => {
      if (method === "POST") return startedNamed();
      if (path === "/v1/app/me") return Response.json({ error: { code: "RUNTIME_UNAVAILABLE", message: "down" } }, { status: 503 });
      if (path === "/v1/app/github/requests") return request("connected", { accountLogin: "other", requestedBy: { developerId: "someone-else", name: "Else" } });
      return installations < 4 ? noInstallations() : listed([{ installationId: 501, accountLogin: "acme" }]);
    });
    expect(await h.run(["github", "connect"])).toBe(0);
    expect(h.out.join("")).toBe("Connected acme.\n");
    expect(h.err.join("")).not.toContain("approved Rovara");
    expect(h.calls.filter((call) => call.path === "/v1/app/github/requests")).toEqual([]);
  });

  it("prints the link and opens nothing with --no-browser", async () => {
    const h = await cli((method, path, lists) => {
      if (method === "POST") return started.clone();
      return listed(lists < 2 ? [] : [{ installationId: 501, accountLogin: "acme" }]);
    });
    expect(await h.run(["github", "connect", "--no-browser"])).toBe(0);
    expect(h.opened).toEqual([]);
    expect(h.err.join("")).toContain(INSTALL_URL);
  });

  it("shows the server's refusal and polls nothing", async () => {
    const h = await cli((method) => (method === "POST"
      ? Response.json({ error: { code: "FORBIDDEN", message: "FORBIDDEN: only an owner or admin can connect GitHub" } }, { status: 403 }) : undefined));
    expect(await h.run(["github", "connect"])).not.toBe(0);
    expect(h.err.join("")).toContain("only an owner or admin can connect GitHub");
    expect(h.calls.filter((call) => call.method === "GET" && call.path === "/v1/app/github/installations")).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  it("never opens a link that is not GitHub's own install page", async () => {
    const h = await cli((method) => (method === "POST" ? Response.json({ installUrl: "https://evil.example/apps/x/installations/new?state=s", expiresAt: "x", requestId: "r" }) : undefined));
    expect(await h.run(["github", "connect"])).not.toBe(0);
    expect(h.opened).toEqual([]);
  });
});
