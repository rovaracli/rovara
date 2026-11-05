// Shared fakes for the developer sign-in (spec 025 phase 25a). Nothing here reaches AWS, Slack or
// any identity provider.
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { AdminCreateUserCommand, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { SignJWT, UnsecuredJWT, createLocalJWKSet, type JWTHeaderParameters, type JWTVerifyGetKey } from "jose";
import type { EditionPolicy, OrgId } from "@agentx/contracts";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";
import { githubSignInProvider, oidcSignInProvider, samlSignInProvider, slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { samlServiceProviderAddresses } from "../../packages/broker/src/developer/saml.js";
import { DecideStore } from "../../packages/broker/src/developer/decide-session.js";
import type { DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import type { DeveloperIdentityDependencies, HttpResult } from "../../packages/broker/src/developer/server.js";
import { createDeveloperIdentityHandler } from "../../packages/broker/src/developer/server.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { duplicateMerger } from "../../packages/broker/src/org/merge-members.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { unlockTrial } from "../../packages/broker/src/org/trial.js";
import { ssoStoresFor } from "../../packages/broker/src/developer/sso-sign-in.js";
import type { AuditCapture } from "./audit-capture.js";
import type { PublicSigningJwk, TokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { kmsTokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ORG } from "./orgs.js";

export const T0 = Date.parse("2026-09-27T12:00:00.000Z");
export const API = "https://abc123.execute-api.us-east-1.amazonaws.com";
export const ISSUER = `${API}/v1/auth`;

export function rsaKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** A KMS client that signs with a local RSA key, and records every command it received. */
export function fakeKms(keys = rsaKeyPair()) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    publicKey: keys.publicKey,
    async send(command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      if (command instanceof GetPublicKeyCommand) {
        return { KeySpec: "RSA_2048", KeyUsage: "SIGN_VERIFY", PublicKey: new Uint8Array(keys.publicKey.export({ format: "der", type: "spki" })) };
      }
      if (command instanceof SignCommand) {
        if (input.MessageType !== "RAW" || input.SigningAlgorithm !== "RSASSA_PKCS1_V1_5_SHA_256") throw new Error("unexpected signing request");
        return { Signature: new Uint8Array(cryptoSign("sha256", Buffer.from(input.Message as Uint8Array), keys.privateKey)) };
      }
      throw new Error(`fakeKms does not support ${name}`);
    },
  };
}

/** The signer every server test uses: the real KMS signer over the fake KMS. */
export function localSigner(): TokenSigner & { jwks(): Promise<{ keys: PublicSigningJwk[] }> } {
  const signer = kmsTokenSigner({ kms: fakeKms(), keyId: "arn:aws:kms:us-east-1:123456789012:key/test" });
  return { ...signer, jwks: async () => ({ keys: [await signer.publicJwk()] }) };
}

export const TEAM = "T0TEAM1";
export const SLACK_CLIENT_ID = "1111111111.2222222222222";
export const SLACK_CLIENT_SECRET = "0123456789abcdef0123456789abcdef";
export const BOT_TOKEN = "xoxb-1111-2222-plantedbottoken";
export const OIDC_ISSUER = "https://idp.example.test";
export const OIDC_CLIENT_ID = "agentx-developers";
export const OIDC_CLIENT_SECRET = "planted-oidc-client-secret-value";
export const GITHUB_CLIENT_ID = "Iv1.0123456789abcdef";
export const GITHUB_CLIENT_SECRET = "planted-github-client-secret-value";

type Handler = (url: URL, init: RequestInit | undefined) => Promise<Response | undefined>;

/** One fetch for several fakes: the first handler that answers wins; anything else throws. */
export function routeFetch(...handlers: Handler[]): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    for (const handler of handlers) {
      const response = await handler(url, init);
      if (response !== undefined) return response;
    }
    throw new Error(`test setup: unexpected fetch ${url.href}`);
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

function signingKey() {
  const keys = rsaKeyPair();
  const kid = `k${Math.random().toString(36).slice(2, 8)}`;
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return { keys, kid, jwks: createLocalJWKSet({ keys: [jwk] }), jwk };
}

/**
 * Mints any ID token for the negative tests. `claims` replace the defaults; `header` extends the
 * protected header (alg "none" makes an unsecured token); `key` defaults to the fake's own key.
 */
function mint(signer: ReturnType<typeof signingKey>, defaults: Record<string, unknown>) {
  return async (claims: Record<string, unknown> = {}, header: Partial<JWTHeaderParameters> = {}, key?: KeyObject | Uint8Array): Promise<string> => {
    const seconds = Math.floor(Date.now() / 1000);
    const payload = Object.fromEntries(Object.entries({ iat: seconds, exp: seconds + 300, ...defaults, ...claims }).filter(([, value]) => value !== undefined));
    if (header.alg === "none") return new UnsecuredJWT(payload).encode();
    return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: signer.kid, ...header }).sign(key ?? signer.keys.privateKey);
  };
}

/** RFC 6749 section 2.3.1 form encoding, written out independently of the code under test. */
export function formEncodeForBasic(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9*\-._]/.test(char)) return char;
    if (char === " ") return "+";
    return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

const form = (init: RequestInit | undefined) => new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");

export interface FakeSlackUser { userId: string; teamId?: string; name: string; email?: string; emailVerified?: boolean; deleted?: boolean; isBot?: boolean; enterpriseTeams?: string[] }

/** Slack's OpenID Connect and Web API, as far as the sign-in uses them. */
/** `channelInfo`: what conversations.info answers per channel ID (no `isPrivate` leaves is_private out); any other ID is channel_not_found.
 * conversations.list lists the same channels in one page, each with is_private (false when `isPrivate` is left out). */
export function fakeSlack(options: { users: FakeSlackUser[]; channels?: Record<string, string[]>; channelInfo?: Record<string, { name: string; isPrivate?: boolean; /** Extra fields of Slack's channel object (is_im, is_ext_shared, ...); `name` may be dropped for a DM. */ raw?: Record<string, unknown> }>; scopes?: string[]; /** `users.conversations`: the private channels each Slack user is in (and the bot too), by user id; any other user is user_not_found. */ userChannels?: Record<string, Array<Record<string, unknown>>>; now?: () => number }) {
  const issuedAt = () => Math.floor((options.now ?? Date.now)() / 1000);
  const signer = signingKey();
  const codes = new Map<string, { user: FakeSlackUser; nonce: string; redirectUri: string; teamId: string; idToken?: string }>();
  const state = { down: false, rateLimited: false, secretSeen: [] as string[], botError: undefined as string | undefined };
  const user = (id: string) => options.users.find((candidate) => candidate.userId === id);
  const userJson = (u: FakeSlackUser) => ({
    id: u.userId, team_id: u.teamId ?? TEAM, deleted: u.deleted === true, is_bot: u.isBot === true, real_name: u.name,
    ...(u.enterpriseTeams ? { enterprise_user: { teams: u.enterpriseTeams } } : {}),
  });
  const handler: Handler = async (url, init) => {
    if (url.hostname !== "slack.com") return undefined;
    if (state.down) throw new TypeError("fetch failed");
    if (state.rateLimited) return Response.json({ ok: false, error: "ratelimited" }, { status: 429 });
    const bearer = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/api/openid.connect.token") {
      const body = form(init);
      state.secretSeen.push(body.get("client_secret") ?? "");
      if (body.get("client_id") !== SLACK_CLIENT_ID || body.get("client_secret") !== SLACK_CLIENT_SECRET) return Response.json({ ok: false, error: "invalid_client" });
      const grant = codes.get(body.get("code") ?? "");
      if (grant === undefined || grant.redirectUri !== body.get("redirect_uri")) return Response.json({ ok: false, error: "invalid_code" });
      codes.delete(body.get("code") ?? "");
      if (grant.idToken !== undefined) return Response.json({ ok: true, access_token: "xoxp-user-token-unused", id_token: grant.idToken });
      const idToken = await new SignJWT({
        nonce: grant.nonce, name: grant.user.name,
        ...(grant.user.email === undefined ? {} : { email: grant.user.email, email_verified: grant.user.emailVerified ?? true }),
        "https://slack.com/user_id": grant.user.userId, "https://slack.com/team_id": grant.teamId,
      }).setProtectedHeader({ alg: "RS256", kid: signer.kid }).setIssuer("https://slack.com").setAudience(SLACK_CLIENT_ID)
        .setSubject(grant.user.userId).setIssuedAt(issuedAt()).setExpirationTime(issuedAt() + 300).sign(signer.keys.privateKey);
      return Response.json({ ok: true, access_token: "xoxp-user-token-unused", id_token: idToken });
    }
    if (bearer !== `Bearer ${BOT_TOKEN}`) return Response.json({ ok: false, error: "invalid_auth" });
    if (state.botError !== undefined) return Response.json({ ok: false, error: state.botError });
    if (url.pathname === "/api/auth.test") {
      return Response.json({ ok: true, team_id: TEAM, team: "Acme", user_id: "U0BOT0001", bot_id: "B0BOT0001" }, { headers: { "x-oauth-scopes": (options.scopes ?? []).join(",") } });
    }
    if (url.pathname === "/api/users.info") {
      const found = user(url.searchParams.get("user") ?? "");
      return Response.json(found ? { ok: true, user: userJson(found) } : { ok: false, error: "user_not_found" });
    }
    if (url.pathname === "/api/users.lookupByEmail") {
      const found = options.users.find((candidate) => candidate.email === url.searchParams.get("email"));
      return Response.json(found ? { ok: true, user: userJson(found) } : { ok: false, error: "users_not_found" });
    }
    if (url.pathname === "/api/conversations.members") {
      const members = options.channels?.[url.searchParams.get("channel") ?? ""];
      if (members === undefined) return Response.json({ ok: false, error: "channel_not_found" });
      const start = Number(url.searchParams.get("cursor") || "0");
      const page = members.slice(start, start + 2);
      const next = start + 2 < members.length ? String(start + 2) : "";
      return Response.json({ ok: true, members: page, response_metadata: { next_cursor: next } });
    }
    if (url.pathname === "/api/conversations.list") {
      const channels = Object.entries(options.channelInfo ?? {}).map(([id, info]) => ({ id, name: info.name, is_private: info.isPrivate === true, ...(info.raw ?? {}) }));
      return Response.json({ ok: true, channels, response_metadata: { next_cursor: "" } });
    }
    if (url.pathname === "/api/users.conversations") {
      const channels = options.userChannels?.[url.searchParams.get("user") ?? ""];
      if (channels === undefined) return Response.json({ ok: false, error: "user_not_found" });
      return Response.json({ ok: true, channels, response_metadata: { next_cursor: "" } });
    }
    if (url.pathname === "/api/conversations.info") {
      const id = url.searchParams.get("channel") ?? "";
      const info = options.channelInfo?.[id];
      if (info === undefined) return Response.json({ ok: false, error: "channel_not_found" });
      return Response.json({ ok: true, channel: { id, name: info.name, ...(info.isPrivate === undefined ? {} : { is_private: info.isPrivate }), ...(info.raw ?? {}) } });
    }
    return undefined;
  };
  return {
    state,
    handler,
    jwks: signer.jwks as JWTVerifyGetKey,
    publicKey: signer.keys.publicKey,
    issue: mint(signer, { iss: "https://slack.com", aud: SLACK_CLIENT_ID, "https://slack.com/team_id": TEAM }),
    /**
     * What the browser does at Slack: `userId` approves the authorize URL; returns the callback URL.
     * `idToken` makes the token endpoint answer with that token instead of a good one.
     */
    approve(authorizeUrl: string, userId: string, overrides: { teamId?: string; idToken?: string } = {}): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== "https://slack.com/openid/connect/authorize") throw new Error(`test setup: not a Slack authorize URL: ${authorizeUrl}`);
      if (url.searchParams.get("client_id") !== SLACK_CLIENT_ID) throw new Error("test setup: wrong client_id");
      const found = user(userId);
      if (found === undefined) throw new Error(`test setup: no Slack user ${userId}`);
      const code = `slack-code-${Math.random().toString(36).slice(2)}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, {
        user: found, nonce: url.searchParams.get("nonce") ?? "", redirectUri, teamId: overrides.teamId ?? found.teamId ?? TEAM,
        ...(overrides.idToken === undefined ? {} : { idToken: overrides.idToken }),
      });
      return `${redirectUri}?code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}

export interface FakeOidcUser { sub: string; name?: string; email?: string; email_verified?: boolean; groups?: string[]; /** The ID token's `auth_time` claim (epoch seconds): when the provider last authenticated the person. Absent: the token carries none. */ auth_time?: number;
  /** The ID token's `amr` claim (how the person authenticated). Absent: the token carries none. */ amr?: string[] }

/** A company OIDC provider with discovery, a token endpoint (client_secret_basic) and keys. */
export function fakeOidc(options: { users: FakeOidcUser[]; clientSecret?: string; now?: () => number }) {
  const issuedAt = () => Math.floor((options.now ?? Date.now)() / 1000);
  const signer = signingKey();
  const codes = new Map<string, { user: FakeOidcUser; nonce: string; redirectUri: string; idToken?: string }>();
  const state = { down: false, authorizations: [] as string[] };
  const handler: Handler = async (url, init) => {
    if (url.origin !== OIDC_ISSUER) return undefined;
    if (state.down) throw new TypeError("fetch failed");
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer: OIDC_ISSUER, authorization_endpoint: `${OIDC_ISSUER}/authorize`, token_endpoint: `${OIDC_ISSUER}/token`, jwks_uri: `${OIDC_ISSUER}/jwks` });
    }
    if (url.pathname === "/token") {
      const expected = `Basic ${Buffer.from(`${formEncodeForBasic(OIDC_CLIENT_ID)}:${formEncodeForBasic(options.clientSecret ?? OIDC_CLIENT_SECRET)}`).toString("base64")}`;
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      state.authorizations.push(authorization);
      if (authorization !== expected) return Response.json({ error: "invalid_client" }, { status: 401 });
      const body = form(init);
      const grant = codes.get(body.get("code") ?? "");
      if (grant === undefined || grant.redirectUri !== body.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      codes.delete(body.get("code") ?? "");
      if (grant.idToken !== undefined) return Response.json({ access_token: "unused", token_type: "Bearer", id_token: grant.idToken });
      const { sub, ...claims } = grant.user;
      const idToken = await new SignJWT({ ...claims, nonce: grant.nonce }).setProtectedHeader({ alg: "RS256", kid: signer.kid })
        .setIssuer(OIDC_ISSUER).setAudience(OIDC_CLIENT_ID).setSubject(sub).setIssuedAt(issuedAt()).setExpirationTime(issuedAt() + 300).sign(signer.keys.privateKey);
      return Response.json({ access_token: "unused", token_type: "Bearer", id_token: idToken });
    }
    return undefined;
  };
  return {
    state,
    handler,
    jwks: signer.jwks as JWTVerifyGetKey,
    publicKey: signer.keys.publicKey,
    issue: mint(signer, { iss: OIDC_ISSUER, aud: OIDC_CLIENT_ID }),
    /** `claims` replace the user's own claims in this one ID token (for example a later `auth_time`); `nonce` replaces the token's nonce. */
    approve(authorizeUrl: string, sub: string, overrides: { idToken?: string; nonce?: string; claims?: Partial<FakeOidcUser> } = {}): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== `${OIDC_ISSUER}/authorize`) throw new Error(`test setup: not the OIDC authorize URL: ${authorizeUrl}`);
      const found = options.users.find((candidate) => candidate.sub === sub);
      if (found === undefined) throw new Error(`test setup: no OIDC user ${sub}`);
      const code = `oidc-code-${Math.random().toString(36).slice(2)}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, { user: { ...found, ...(overrides.claims ?? {}) }, nonce: overrides.nonce ?? url.searchParams.get("nonce") ?? "", redirectUri, ...(overrides.idToken === undefined ? {} : { idToken: overrides.idToken }) });
      return `${redirectUri}?code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}

/**
 * Amazon Cognito's admin API as far as the decide flow uses it. `users` are the pool's existing users (the same people `fakeOidc` signs
 * in, by `sub`); every command is recorded with its input. A created user is added with the sub `sub-of-<email>`.
 */
/** `federated`: a user made by a social sign-in (Google): Cognito reports it as EXTERNAL_PROVIDER, with an `identities` attribute. */
export interface FakeCognitoUser { email: string; sub: string; emailVerified?: boolean; federated?: boolean }
export function fakeCognito(options: { users?: FakeCognitoUser[]; createError?: string } = {}) {
  const users = new Map<string, FakeCognitoUser>((options.users ?? []).map((user) => [user.email, user]));
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const attributes = (user: FakeCognitoUser) => [
    { Name: "sub", Value: user.sub }, { Name: "email", Value: user.email }, { Name: "email_verified", Value: String(user.emailVerified ?? true) },
    ...(user.federated === true ? [{ Name: "identities", Value: JSON.stringify([{ providerName: "Google", providerType: "Google" }]) }] : []),
  ];
  return {
    calls, users,
    /** The next AdminCreateUser fails with an error of this name (once). */
    failNextCreate: undefined as string | undefined,
    async send(this: { failNextCreate: string | undefined }, command: unknown): Promise<unknown> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      const input = (command as { input: Record<string, unknown> }).input;
      calls.push({ name, input });
      if (command instanceof AdminCreateUserCommand) {
        if (this.failNextCreate !== undefined) {
          const failure = this.failNextCreate;
          this.failNextCreate = undefined;
          throw Object.assign(new Error(failure), { name: failure });
        }
        if (options.createError !== undefined) throw Object.assign(new Error(options.createError), { name: options.createError });
        const email = String(input.Username);
        if (users.has(email)) throw Object.assign(new Error("exists"), { name: "UsernameExistsException" });
        const created = { email, sub: `sub-of-${email}` };
        users.set(email, created);
        return { User: { Username: created.sub, Attributes: attributes(created) } };
      }
      if (command instanceof AdminGetUserCommand) {
        const found = users.get(String(input.Username));
        if (found === undefined) throw Object.assign(new Error("none"), { name: "UserNotFoundException" });
        return { Username: found.sub, UserStatus: found.federated === true ? "EXTERNAL_PROVIDER" : "CONFIRMED", UserAttributes: attributes(found) };
      }
      throw new Error(`fakeCognito does not support ${name}`);
    },
  };
}

export interface FakeGithubEmail { email: string; primary: boolean; verified: boolean }
export interface FakeGithubUser { id: number; login: string; name?: string | null; emails?: FakeGithubEmail[] }

/** GitHub's OAuth web flow and the two REST reads the sign-in makes (user, user/emails). */
export function fakeGithub(options: { users: FakeGithubUser[] }) {
  const codes = new Map<string, { user: FakeGithubUser; redirectUri: string }>();
  const tokens = new Map<string, FakeGithubUser>();
  const state = { down: false, tokenStatus: undefined as number | undefined, tokenError: undefined as string | undefined, secretSeen: [] as string[], issuedTokens: [] as string[], apiHeaders: [] as Headers[], emailsStatus: undefined as number | undefined };
  const handler: Handler = async (url, init) => {
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      if (state.down) throw new TypeError("fetch failed");
      if (state.tokenStatus !== undefined) return new Response("bad gateway", { status: state.tokenStatus });
      const body = form(init);
      state.secretSeen.push(body.get("client_secret") ?? "");
      if (new Headers(init?.headers).get("accept") !== "application/json") return new Response("access_token=not-json", { status: 200 });
      // GitHub answers HTTP 200 with an error body for a bad client or code.
      if (state.tokenError !== undefined) return Response.json({ error: state.tokenError });
      if (body.get("client_id") !== GITHUB_CLIENT_ID || body.get("client_secret") !== GITHUB_CLIENT_SECRET) return Response.json({ error: "incorrect_client_credentials" });
      const grant = codes.get(body.get("code") ?? "");
      if (grant === undefined || grant.redirectUri !== body.get("redirect_uri")) return Response.json({ error: "bad_verification_code" });
      codes.delete(body.get("code") ?? "");
      const token = `gho_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      tokens.set(token, grant.user);
      state.issuedTokens.push(token);
      return Response.json({ access_token: token, token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url.origin === "https://api.github.com") {
      state.apiHeaders.push(new Headers(init?.headers));
      const user = tokens.get((new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, ""));
      if (user === undefined) return Response.json({ message: "Bad credentials" }, { status: 401 });
      if (url.pathname === "/user") return Response.json({ id: user.id, login: user.login, name: user.name ?? null });
      if (url.pathname === "/user/emails") {
        if (state.emailsStatus !== undefined) return Response.json({ message: "nope" }, { status: state.emailsStatus });
        return Response.json(user.emails ?? []);
      }
    }
    return undefined;
  };
  return {
    state,
    handler,
    /** What the browser does at GitHub: `id` approves the authorize URL; returns the callback URL. */
    approve(authorizeUrl: string, id: number | string): string {
      const url = new URL(authorizeUrl);
      if (url.origin + url.pathname !== "https://github.com/login/oauth/authorize") throw new Error(`test setup: not the GitHub authorize URL: ${authorizeUrl}`);
      if (url.searchParams.get("client_id") !== GITHUB_CLIENT_ID) throw new Error("test setup: wrong client_id");
      const found = options.users.find((candidate) => String(candidate.id) === String(id));
      if (found === undefined) throw new Error(`test setup: no GitHub user ${id}`);
      const code = `github-code-${Math.random().toString(36).slice(2)}`;
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      codes.set(code, { user: found, redirectUri });
      return `${redirectUri}?code=${code}&state=${url.searchParams.get("state") ?? ""}`;
    },
  };
}

export function httpEvent(method: "GET" | "POST", pathAndQuery: string, body?: Record<string, string>): HttpApiV2Event {
  const url = new URL(pathAndQuery, API);
  return {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" },
    ...(body === undefined ? {} : { body: Buffer.from(new URLSearchParams(body).toString()).toString("base64"), isBase64Encoded: true }),
    requestContext: { requestId: "req-1", http: { method } },
  };
}

export const CLI_REDIRECT = "http://127.0.0.1:49152/callback";
export const VERIFIER = "v".repeat(64);
export const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

export function authorizeQuery(overrides: Record<string, string> = {}): string {
  return `/v1/auth/authorize?${new URLSearchParams({
    response_type: "code", client_id: "agentx-cli", redirect_uri: CLI_REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "cli-state", ...overrides,
  }).toString()}`;
}

/** The sign-in server with fake Slack, fake OIDC, fake DynamoDB and the fake KMS signer. */
export function identityHarness(options: {
  slack?: boolean; teamId?: string | undefined; oidc?: { requiredClaim?: string; requiredValues?: string[] };
  /** The hosted Rovara sign-in, served by the same fake provider as `oidc` (its users are `oidcUsers`). */
  cloud?: { displayName?: string };
  /** GitHub sign-in (cloud installs only): the fake GitHub's users; unlocking the trial is wired as the Lambda wires it. */
  github?: { users: FakeGithubUser[] };
  slackUsers?: FakeSlackUser[]; oidcUsers?: FakeOidcUser[]; channels?: Record<string, string[]>;
  channelInfo?: Record<string, { name: string; isPrivate?: boolean; raw?: Record<string, unknown> }>;
  /** What `users.conversations` answers per Slack user id (see `fakeSlack`). */
  userChannels?: Record<string, Array<Record<string, unknown>>>;
  slackCredentials?: { clientId?: string; clientSecret?: string };
  /** The State table, where orgs and membership live; a fresh one when absent. */
  state?: FakeDynamoDb;
  /** false: the install has no single org for a Slack or company sign-in to join. */
  singleOrg?: boolean;
  /**
   * true: the sign-in table and the State table are one fake (their keys never collide), and a sign-in heals a duplicate member
   * (mergeDuplicateMember writes both tables in one transaction, which two separate fakes cannot show whole).
   */
  sharedTable?: boolean;
  /** Plan 2, Task 8: the notice of a newly linked sign-in method. Absent: the sign-in has no notice dependencies, as an install with no SES sender. */
  notice?: DeveloperIdentityDependencies["notice"];
  /** Plan 3, Task 21a-presence: the decide flow's dependencies (tickets, the approval kinds, Cognito's admin API). Absent: the decide routes do not exist. */
  decide?: { kinds?: DecideKinds; cognito?: ReturnType<typeof fakeCognito> };
  /** Enterprise foundations E3: the edition's feature table. Absent: an install deployed before editions. */
  editionPolicy?: EditionPolicy;
  /** Enterprise foundations I1: the group mapping and the break-glass list, over the State table fake (built as the Lambda builds them, from the edition). */
  sso?: boolean;
  /** Enterprise foundations I4: the SAML sign-in, over the State table's SAML stores (needs `sso` and an edition with company sign-in). */
  saml?: boolean;
  /** Enterprise foundations I1: the Audit Ledger's outbox, attached to the State table fake. */
  audit?: AuditCapture;
} = {}) {
  let clock = T0;
  const now = () => clock;
  const state = options.state ?? new FakeDynamoDb();
  const db = options.sharedTable === true ? state : new FakeDynamoDb();
  const orgs = new OrgStore({ documentClient: state, tableName: "state", now });
  const slack = fakeSlack({ users: options.slackUsers ?? [], now, ...(options.channels ? { channels: options.channels } : {}), ...(options.channelInfo ? { channelInfo: options.channelInfo } : {}), ...(options.userChannels ? { userChannels: options.userChannels } : {}) });
  const oidc = fakeOidc({ users: options.oidcUsers ?? [], now });
  const github = fakeGithub({ users: options.github?.users ?? [] });
  const fetch = routeFetch(slack.handler, oidc.handler, github.handler);
  const signer = localSigner();
  const logs: Array<Record<string, unknown>> = [];
  const teamId = "teamId" in options ? options.teamId : TEAM;
  const cloudProvider = options.cloud === undefined ? undefined : oidcSignInProvider({
    method: "cloud", issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: [], fetch, jwksFor: () => oidc.jwks, now,
  });
  const githubProvider = options.github === undefined ? undefined : githubSignInProvider({ clientId: GITHUB_CLIENT_ID, clientSecret: async () => GITHUB_CLIENT_SECRET, fetch, now });
  const providers: DeveloperIdentityDependencies["providers"] = {
    slack: slackSignInProvider({ teamId, credentials: async () => options.slackCredentials ?? { clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }, fetch, jwks: slack.jwks, now }),
    ...(options.oidc === undefined ? {} : {
      oidc: oidcSignInProvider({
        issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET,
        ...(options.oidc.requiredClaim === undefined ? {} : { requiredClaim: options.oidc.requiredClaim }),
        requiredValues: options.oidc.requiredValues ?? [], fetch, jwksFor: () => oidc.jwks, now,
      }),
    }),
    ...(cloudProvider === undefined ? {} : { cloud: cloudProvider }),
    ...(githubProvider === undefined ? {} : { github: githubProvider }),
  };
  const store = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now });
  const ssoStores = options.sso !== true ? undefined : ssoStoresFor({ documentClient: state, tableName: "state", policy: options.editionPolicy });
  const samlProvider = options.saml !== true || ssoStores === undefined || options.singleOrg === false ? undefined : samlSignInProvider({
    sp: samlServiceProviderAddresses(ISSUER), orgId: TEST_ORG, load: (orgId) => ssoStores.saml.config.get(orgId), replay: ssoStores.saml.replay, stash: ssoStores.saml.stash, now,
  });
  if (samlProvider !== undefined) providers.saml = samlProvider;
  const deps: DeveloperIdentityDependencies = {
    config: {
      env: "staging", issuer: ISSUER,
      slack: { enabled: options.slack ?? true, ...(teamId === undefined ? {} : { teamId }) },
      ...(options.oidc === undefined ? {} : { oidc: { displayName: "Okta" } }),
      ...(options.cloud === undefined ? {} : { cloud: { displayName: options.cloud.displayName ?? "Rovara" } }),
      ...(options.github === undefined ? {} : { github: { displayName: "GitHub" } }),
    },
    store,
    ...(options.sharedTable === true ? duplicateMerger({ documentClient: state, tableName: "state", signInStore: store, now }) : {}),
    orgs,
    ...(options.notice === undefined ? {} : { notice: options.notice }),
    ...(options.singleOrg === false ? {} : { singleOrgId: TEST_ORG }),
    ...(options.editionPolicy === undefined ? {} : { editionPolicy: options.editionPolicy }),
    ...(ssoStores === undefined ? {} : { sso: ssoStores }),
    ...(samlProvider === undefined ? {} : { saml: samlProvider }),
    ...(options.audit === undefined ? {} : { audit: options.audit.audit }),
    ...(options.github === undefined ? {} : { onGithubSignIn: (input: { orgId: OrgId; githubUserId: string }) => unlockTrial({ documentClient: state, tableName: "state", now }, input) }),
    signer,
    providers,
    directory: slackDirectory({ teamId, botToken: async () => BOT_TOKEN, fetch, now }),
    now,
    log: (entry) => logs.push(entry),
  };
  const decideStore = new DecideStore({ documentClient: db, tableName: "signin", now });
  const cognito = options.decide?.cognito ?? fakeCognito();
  if (options.decide !== undefined) {
    deps.decide = { store: decideStore, kinds: options.decide.kinds ?? {}, cloudIssuer: OIDC_ISSUER, cognito: { client: cognito, userPoolId: "us-east-1_TESTPOOL" } };
  }
  options.audit?.attach(state);
  const handler = createDeveloperIdentityHandler(deps);
  const http = async (event: HttpApiV2Event) => handler(event) as Promise<HttpResult>;
  return {
    db, state, orgs, slack, oidc, github, fetch, signer, logs, deps, handler, http, decide: decideStore, cognito,
    tick: (ms: number) => { clock += ms; },
    now,
    /** GET authorize, follow to the provider, approve as `who`, follow the callback: the CLI's loopback URL. */
    async signIn(method: "slack" | "oidc" | "cloud" | "github", who: string, extra: { teamId?: string; query?: Record<string, string> } = {}): Promise<URL> {
      let response = await http(httpEvent("GET", authorizeQuery(extra.query)));
      if (response.statusCode === 200) {
        const link = new RegExp(`href="([^"]*method=${method})"`).exec(response.body)?.[1];
        if (link === undefined) throw new Error(`test setup: no ${method} link on the method page`);
        response = await http(httpEvent("GET", link.replaceAll("&amp;", "&")));
      }
      if (response.statusCode !== 302) return new URL(`${API}/unexpected-${response.statusCode}`);
      const providerUrl = response.headers.location!;
      if (providerUrl.startsWith(CLI_REDIRECT)) return new URL(providerUrl);
      const callback = method === "slack" ? slack.approve(providerUrl, who, extra.teamId === undefined ? {} : { teamId: extra.teamId })
        : method === "github" ? github.approve(providerUrl, who) : oidc.approve(providerUrl, who);
      const back = await http(httpEvent("GET", callback));
      return new URL(back.headers.location ?? `${API}/no-redirect-${back.statusCode}`);
    },
    async exchange(code: string, overrides: Record<string, string> = {}) {
      const response = await http(httpEvent("POST", "/v1/auth/token", { grant_type: "authorization_code", client_id: "agentx-cli", code, code_verifier: VERIFIER, redirect_uri: CLI_REDIRECT, ...overrides }));
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    },
    async refresh(refreshToken: string) {
      const response = await http(httpEvent("POST", "/v1/auth/token", { grant_type: "refresh_token", client_id: "agentx-cli", refresh_token: refreshToken }));
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    },
  };
}
