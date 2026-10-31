// Task 22: the `github` sign-in method on cloud installs. GitHub is not OIDC, so the broker's own sign-in server
// runs the OAuth web flow (providers.ts githubSignInProvider); everything downstream is the `cloud` method's rules.
import { describe, expect, it } from "vitest";
import { developerOrgKey, orgEmailKey, orgMetaKey, trialGithubKey } from "@agentx/contracts";
import { developerClaims } from "../../packages/broker/src/aws/developer-routes.js";
import { createDeveloperApiConfiguration } from "../../packages/broker/src/aws/workflow-dependencies-configuration.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { developerIdentityConfigFromEnvironment } from "../../packages/broker/src/aws/developer-identity.js";
import { ProviderUnavailableError, githubSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { enabledMethods } from "../../packages/broker/src/developer/server.js";
import { admitTrial } from "../../packages/broker/src/org/trial.js";
import {
  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ISSUER, httpEvent, identityHarness, routeFetch, type FakeGithubUser, type FakeOidcUser,
} from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const GITHUB_ISSUER = "https://github.com";
const ada: FakeGithubUser = { id: 4242, login: "ada", name: "Ada Lovelace", emails: [{ email: "ada@example.com", primary: true, verified: true }, { email: "ada@old.example", primary: false, verified: true }] };
const adaId = ownerKeyForSubject(GITHUB_ISSUER, "4242");
const claimsOf = (accessToken: unknown) => JSON.parse(Buffer.from(String(accessToken).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
const orgMetas = (state: FakeDynamoDb) => state.find((item) => item.entityType === "ORG" && item.sk === "META" && String(item.pk).startsWith("ORG#org_"));

async function signedIn(h: ReturnType<typeof identityHarness>, method: "github" | "cloud", who: string) {
  const code = (await h.signIn(method, who)).searchParams.get("code")!;
  const exchanged = await h.exchange(code);
  expect(exchanged.status).toBe(200);
  return claimsOf(exchanged.body.access_token);
}

const configurationOf = async (h: ReturnType<typeof identityHarness>) =>
  (JSON.parse((await h.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body) as { methods: Record<string, unknown> }).methods;

describe("a GitHub sign-in creates an org and unlocks its trial", () => {
  it("makes the caller the owner of a new org, names the developer for the numeric id, and unlocks the trial", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    const claims = await signedIn(h, "github", "4242");
    expect(claims).toMatchObject({ sub: adaId, amr: "github", org_role: "owner" });
    expect(orgMetas(h.state)).toHaveLength(1);
    expect(h.state.get(orgMetaKey(claims.org as never))).toMatchObject({ name: "Ada Lovelace's team", plan: "trial", createdBy: adaId, trialGithubUserId: "4242" });
    expect(h.state.get(orgMetaKey(claims.org as never))!.trialUnlockedAt).toBeTypeOf("number");
    expect(h.state.get(trialGithubKey("4242"))).toMatchObject({ orgId: claims.org });
    expect(h.state.get(developerOrgKey(adaId))).toMatchObject({ orgId: claims.org, role: "owner" });
    expect(h.state.get(orgEmailKey("ada@example.com"))).toMatchObject({ developerId: adaId });
    await expect(admitTrial({ documentClient: h.state, tableName: "state" }, claims.org as never)).resolves.toBeUndefined();
    expect(h.db.get(`DEVELOPER#${adaId}`, "META")).toMatchObject({ provider: "github", issuer: GITHUB_ISSUER, subject: "4242", displayName: "Ada Lovelace", email: "ada@example.com" });
  });

  it("keeps the same developer and org when the login or name changes", async () => {
    const mutable: FakeGithubUser = { ...ada };
    const h = identityHarness({ cloud: {}, github: { users: [mutable] } });
    const first = await signedIn(h, "github", "4242");
    mutable.login = "countess"; mutable.name = null;
    const second = await signedIn(h, "github", "4242");
    expect(second).toMatchObject({ sub: first.sub, org: first.org });
    expect(orgMetas(h.state)).toHaveLength(1);
  });

  it("falls back to the login when the account has no name", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [{ id: 7, login: "octocat", name: null }] } });
    const claims = await signedIn(h, "github", "7");
    expect(h.state.get(orgMetaKey(claims.org as never))).toMatchObject({ name: "octocat's team" });
  });

  it("leaves a second org locked when its GitHub account already unlocked another, and the sign-in still succeeds", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    // Another org already holds this GitHub account's one trial.
    h.state.set({ ...trialGithubKey("4242"), entityType: "TRIAL_GITHUB", orgId: "org_aaaaaaaaaaaaaaaaaaaa", claimedAt: 1 });
    const claims = await signedIn(h, "github", "4242");
    expect(claims).toMatchObject({ amr: "github", org_role: "owner" });
    const org = h.state.get(orgMetaKey(claims.org as never))!;
    expect(org.trialUnlockedAt).toBeUndefined();
    expect(h.state.get(trialGithubKey("4242"))).toMatchObject({ orgId: "org_aaaaaaaaaaaaaaaaaaaa" });
    await expect(admitTrial({ documentClient: h.state, tableName: "state" }, claims.org as never)).rejects.toMatchObject({ code: "TRIAL_LOCKED" });
    expect(h.logs.some((entry) => entry.event === "signin.trial_unlock_skipped" && entry.reason === "TRIAL_GITHUB_USED")).toBe(true);
  });

  it("still signs in when unlocking the trial fails for another reason", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    h.deps.onGithubSignIn = () => Promise.reject(new Error("dynamo down"));
    const claims = await signedIn(h, "github", "4242");
    expect(claims).toMatchObject({ amr: "github" });
    expect(h.logs.some((entry) => entry.event === "signin.trial_unlock_failed")).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain("dynamo down");
  });
});

describe("a GitHub sign-in links by a verified email, exactly like the cloud method", () => {
  const maya: FakeOidcUser = { sub: "maya-cloud-1", name: "Maya Chen", email: "maya@example.com", email_verified: true };
  const mayaGithub = (verified: boolean, primary = true): FakeGithubUser => ({ id: 99, login: "maya", name: "Maya C.", emails: [{ email: "maya@example.com", primary, verified }] });

  it("puts the same verified email, via cloud then via GitHub, in one org as one developer, and unlocks that org's trial", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya], github: { users: [mayaGithub(true)] } });
    const first = await signedIn(h, "cloud", maya.sub);
    expect(h.state.get(orgMetaKey(first.org as never))!.trialUnlockedAt).toBeUndefined();
    const second = await signedIn(h, "github", "99");
    expect(second).toMatchObject({ org: first.org, org_role: "owner", amr: "github", sub: first.sub });
    expect(orgMetas(h.state)).toHaveLength(1);
    expect(h.state.get(orgMetaKey(first.org as never))).toMatchObject({ trialGithubUserId: "99" });
  });

  it("gives an unverified primary email no linking and no email pointer", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya], github: { users: [mayaGithub(false)] } });
    const first = await signedIn(h, "cloud", maya.sub);
    const second = await signedIn(h, "github", "99");
    expect(second.org).not.toBe(first.org);
    expect(orgMetas(h.state)).toHaveLength(2);
    expect(h.state.get(orgEmailKey("maya@example.com"))).toMatchObject({ developerId: first.sub });
    expect(h.db.get(`DEVELOPER#${second.sub as string}`, "META")!.email).toBeUndefined();
  });

  it("ignores a verified email that is not the primary one", async () => {
    const h = identityHarness({ cloud: {}, oidcUsers: [maya], github: { users: [mayaGithub(true, false)] } });
    const first = await signedIn(h, "cloud", maya.sub);
    const second = await signedIn(h, "github", "99");
    expect(second.org).not.toBe(first.org);
  });

  it("accepts an invite written for the verified email, and refuses it for a different one (R7)", async () => {
    const eve: FakeGithubUser = { id: 100, login: "eve", name: "Eve", emails: [{ email: "eve@example.com", primary: true, verified: true }] };
    const mallory: FakeGithubUser = { id: 101, login: "mallory", name: "Mallory", emails: [{ email: "mallory@example.com", primary: true, verified: true }] };
    const h = identityHarness({ cloud: {}, oidcUsers: [maya], github: { users: [eve, mallory] } });
    const owner = await signedIn(h, "cloud", maya.sub);
    const { token } = await h.orgs.createInvite({ orgId: owner.org as never, createdBy: owner.sub as string, role: "member", email: "eve@example.com" });
    const refused = await h.signIn("github", "101", { query: { invite: token } });
    expect(refused.searchParams.get("inviteError")).toBe("INVITE_WRONG_EMAIL");
    const own = claimsOf((await h.exchange(refused.searchParams.get("code")!)).body.access_token);
    expect(own).toMatchObject({ org_role: "owner" });
    expect(own.org).not.toBe(owner.org);
    const joined = await h.signIn("github", "100", { query: { invite: token } });
    expect(joined.searchParams.get("inviteError")).toBeNull();
    const claims = claimsOf((await h.exchange(joined.searchParams.get("code")!)).body.access_token);
    expect(claims).toMatchObject({ org: owner.org, org_role: "member", amr: "github" });
  });
});

describe("the github method is only offered when it is configured", () => {
  it("is listed in the configuration document only with a provider and cloud configured", async () => {
    expect(await configurationOf(identityHarness({ cloud: {}, github: { users: [ada] } }))).toEqual({ slack: true, oidc: null, cloud: { displayName: "Rovara" }, github: { displayName: "GitHub" } });
    expect(await configurationOf(identityHarness({ cloud: {} }))).toMatchObject({ github: null });
    expect(await configurationOf(identityHarness({}))).toMatchObject({ github: null });
  });

  it("needs cloud as well: GitHub alone on a non-cloud install is not offered", () => {
    const h = identityHarness({ github: { users: [ada] } });
    expect(enabledMethods(h.deps)).not.toContain("github");
  });

  it("refuses to choose github when it is not configured", async () => {
    const h = identityHarness({ cloud: {} });
    const refused = await h.http(httpEvent("GET", "/v1/auth/authorize?request=anything&method=github"));
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("Sign-in method not available");
  });

  it("reads DEVELOPER_GITHUB_CLIENT_ID and DEVELOPER_GITHUB_SECRET_ID, and only on a cloud install", () => {
    const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: ISSUER };
    const cloud = { ...base, DEVELOPER_CLOUD_ISSUER: "https://cloud.example.test", DEVELOPER_CLOUD_CLIENT_ID: "client" };
    expect(developerIdentityConfigFromEnvironment(cloud)).not.toHaveProperty("github");
    expect(developerIdentityConfigFromEnvironment({ ...cloud, DEVELOPER_GITHUB_CLIENT_ID: "" })).not.toHaveProperty("github");
    expect(developerIdentityConfigFromEnvironment({ ...cloud, DEVELOPER_GITHUB_CLIENT_ID: "gh-client" })).not.toHaveProperty("github");
    expect(developerIdentityConfigFromEnvironment({ ...cloud, DEVELOPER_GITHUB_CLIENT_ID: "gh-client", DEVELOPER_GITHUB_SECRET_ID: "arn:secret" })).toMatchObject({ github: { displayName: "GitHub" } });
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_GITHUB_CLIENT_ID: "gh-client", DEVELOPER_GITHUB_SECRET_ID: "arn:secret" })).not.toHaveProperty("github");
  });
});

describe("the broker accepts GitHub tokens only while the method is on", () => {
  const env = { DEVELOPER_TOKEN_ISSUER: ISSUER, DEVELOPER_IDENTITY_FUNCTION_NAME: "identity", DEVELOPER_SIGNIN_TABLE_NAME: "signin", AGENTX_ENV: "staging" };
  const configurationFor = (extra: Record<string, string>) => createDeveloperApiConfiguration({ ...env, ...extra }, () => ({}) as never)!;
  const cloud = { DEVELOPER_CLOUD_ISSUER: "https://cloud.example.test" };

  it("turns the method on from the cloud issuer plus the GitHub client id, and not otherwise", () => {
    expect(configurationFor({ ...cloud, DEVELOPER_GITHUB_CLIENT_ID: "gh" }).methods.github).toBe(true);
    expect(configurationFor(cloud).methods.github).toBe(false);
    expect(configurationFor({ DEVELOPER_GITHUB_CLIENT_ID: "gh" }).methods.github).toBe(false);
  });

  it("accepts a github token when the method is on, and refuses it, naming GitHub, when it is off", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    const token = claimsOf((await h.exchange((await h.signIn("github", "4242")).searchParams.get("code")!)).body.access_token);
    expect(developerClaims(token, configurationFor({ ...cloud, DEVELOPER_GITHUB_CLIENT_ID: "gh" }))).toMatchObject({ developerId: adaId, amr: "github", orgRole: "owner" });
    expect(() => developerClaims(token, configurationFor(cloud))).toThrowError(/GitHub sign-in is turned off/);
    expect(() => developerClaims(token, configurationFor(cloud))).toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }) as Error);
  });
});

describe("the GitHub provider", () => {
  it("sends the browser to GitHub with the client id, scope, state and our callback", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    const methodPage = await h.http(httpEvent("GET", "/v1/auth/authorize?" + new URLSearchParams({
      response_type: "code", client_id: "agentx-cli", redirect_uri: "http://127.0.0.1:49152/callback", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "cli-state",
    }).toString()));
    expect(methodPage.statusCode).toBe(200);
    const link = /href="([^"]*method=github)"/.exec(methodPage.body)![1]!.replaceAll("&amp;", "&");
    const go = await h.http(httpEvent("GET", link));
    const url = new URL(go.headers.location!);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: GITHUB_CLIENT_ID, scope: "read:user user:email", redirect_uri: `${ISSUER}/callback/github` });
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("exchanges the code with the client secret, then reads the user and emails with the token", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    await signedIn(h, "github", "4242");
    expect(h.fetch.calls).toEqual(expect.arrayContaining([
      "POST https://github.com/login/oauth/access_token", "GET https://api.github.com/user", "GET https://api.github.com/user/emails",
    ]));
    expect(h.github.state.secretSeen).toEqual([GITHUB_CLIENT_SECRET]);
    const token = h.github.state.issuedTokens[0]!;
    for (const headers of h.github.state.apiHeaders) {
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(headers.get("user-agent")).toBeTruthy();
    }
  });

  it("never stores or logs the GitHub access token or the client secret", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    await signedIn(h, "github", "4242");
    const token = h.github.state.issuedTokens[0]!;
    const everything = JSON.stringify([h.db.find(() => true), h.state.find(() => true), h.logs]);
    expect(everything).toContain("4242");
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(GITHUB_CLIENT_SECRET);
  });

  it("maps a GitHub outage at the token exchange to the provider-unavailable error", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    h.github.state.tokenStatus = 502;
    const back = await h.signIn("github", "4242");
    expect(back.searchParams.get("error")).toBe("temporarily_unavailable");
    expect(h.logs.some((entry) => entry.event === "signin.provider_unavailable" && entry.method === "github")).toBe(true);
    h.github.state.tokenStatus = undefined;
    h.github.state.down = true;
    expect((await h.signIn("github", "4242")).searchParams.get("error")).toBe("temporarily_unavailable");
  });

  it("refuses, naming only GitHub's short error code, when GitHub rejects the code", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    h.github.state.tokenError = "bad_verification_code";
    const back = await h.signIn("github", "4242");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("error_description")).toContain("bad_verification_code");
    expect(orgMetas(h.state)).toHaveLength(0);
  });

  it("treats a failed email read as no email, and the sign-in still works", async () => {
    const h = identityHarness({ cloud: {}, github: { users: [ada] } });
    h.github.state.emailsStatus = 403;
    const claims = await signedIn(h, "github", "4242");
    expect(claims).toMatchObject({ amr: "github", org_role: "owner" });
    expect(h.state.get(orgEmailKey("ada@example.com"))).toBeUndefined();
  });
});

describe("githubSignInProvider (unit)", () => {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const provider = (fetchFn: typeof fetch) => githubSignInProvider({ clientId: "cid", clientSecret: async () => "secret", fetch: fetchFn, now: () => 0 });
  const route = (user: unknown, emails: unknown, token: unknown = { access_token: "gho_x" }) => routeFetch(
    async (url) => (url.pathname === "/login/oauth/access_token" ? json(token) : undefined),
    async (url) => (url.pathname === "/user" ? json(user) : url.pathname === "/user/emails" ? json(emails) : undefined),
  );
  const complete = (fetchFn: typeof fetch) => provider(fetchFn).complete({ code: "c", nonce: "n", redirectUri: "https://x/callback/github" });

  it("returns issuer https://github.com, the numeric id as subject and githubUserId, and the primary verified email", async () => {
    const result = await complete(route({ id: 12345, login: "ada", name: "Ada" }, [{ email: "other@example.com", primary: false, verified: true }, { email: "Ada@Example.com", primary: true, verified: true }]));
    expect(result).toEqual({ ok: true, identity: { method: "github", issuer: GITHUB_ISSUER, subject: "12345", displayName: "Ada", email: "Ada@Example.com", emailVerified: true, githubUserId: "12345", login: "ada" } });
  });

  it("has no email, and emailVerified unset, when the primary email is unverified", async () => {
    const result = await complete(route({ id: 1, login: "ada", name: null }, [{ email: "a@example.com", primary: true, verified: false }, { email: "b@example.com", primary: false, verified: true }]));
    expect(result).toEqual({ ok: true, identity: { method: "github", issuer: GITHUB_ISSUER, subject: "1", displayName: "ada", githubUserId: "1", login: "ada" } });
  });

  it("refuses a user answer with no numeric id", async () => {
    expect(await complete(route({ login: "ada" }, []))).toMatchObject({ ok: false });
    expect(await complete(route({ id: "1", login: "ada" }, []))).toMatchObject({ ok: false });
  });

  it("refuses an answer with no access token, and throws unavailable for a non-JSON answer", async () => {
    expect(await complete(route({ id: 1, login: "a" }, [], { token_type: "bearer" }))).toMatchObject({ ok: false });
    const html = routeFetch(async () => new Response("<html>", { status: 200 }));
    await expect(complete(html)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("throws unavailable when GitHub's API answers 5xx after the token exchange", async () => {
    const fetchFn = routeFetch(
      async (url) => (url.pathname === "/login/oauth/access_token" ? json({ access_token: "gho_x" }) : undefined),
      async (url) => (url.pathname === "/user" ? new Response("", { status: 503 }) : undefined),
    );
    await expect(complete(fetchFn)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
