// Spec 025 FR-002 to FR-004: the Slack and company OIDC providers, and the GitHub OAuth provider of cloud installs (Task 22). The code exchange runs here,
// server side, with the client secret; the laptop never sees it.
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { GroupClaimNameSchema, SLACK_OIDC_ISSUER, SlackTeamIdSchema, SlackUserIdSchema, cleanDisplayName, containsEmailAddress, SAML_RESPONSE_MAX_BYTES, SAML_SIGN_IN_REFUSED_MESSAGE, type DeveloperSignInMethod, type OrgId, type SamlIdpConfig } from "@agentx/contracts";
import { SAML_HANDLE, SAML_STASH_TTL_SECONDS, claimAssertion, samlAuthorizeUrl, samlServiceProviderMetadata, verifySamlResponse, type SamlReplayStore, type SamlResponseStash, type SamlServiceProvider } from "./saml.js";
import { randomBytes } from "node:crypto";

export interface ProviderIdentity {
  method: DeveloperSignInMethod; issuer: string; subject: string; displayName: string; email?: string; slackUserId?: string;
  /** The provider vouched for `email` (OIDC `email_verified`); the org a first sign-in lands in may depend on it. */
  emailVerified?: boolean;
  /** GitHub's numeric account id (the `github` method only); the one free trial per GitHub account is keyed on it. */
  githubUserId?: string;
  /** The GitHub account's login (the `github` method only), shown beside the linked identity; it can change, so it never keys anything. */
  login?: string;
  /**
   * When the provider says the person last authenticated, in epoch seconds: the ID token's `auth_time` claim (Cognito and company OpenID
   * Connect providers; Google when the claim is requested). Absent when the token carries none: GitHub and Slack's tokens never do.
   * Plan 2, Task 8b: the sign-in's recorded time is never newer than this.
   */
  authTime?: number;
  /**
   * Plan 3, Task 21a-presence: the ID token's `amr` claim (RFC 8176 values: how the person authenticated), when the token carries one as a
   * list of strings. The decide flow reads it to see that the email code was used; GitHub and Slack's tokens never carry one.
   */
  amr?: string[];
  /** The ID token names federated identities (`identities`): a social sign-in through the pool, which is never the email code. */
  federated?: true;
  /**
   * Enterprise foundations I1: the verified ID token's group claims, for the company sign-in's group mapping, and nothing else of the token. Only claims whose name is one
   * that carries groups (GroupClaimNameSchema) are kept, so a claim a person can edit about themselves (email, name) never reaches the mapping. Company sign-in only.
   */
  claims?: Record<string, unknown>;
}
/** `wrongAccount`: the person signed in fine but is not one AgentX accepts (another Slack workspace,
 * or without the required claim), so signing in as someone else may help. */
export type ProviderResult = { ok: true; identity: ProviderIdentity } | {
  ok: false; reason: string; wrongAccount?: true;
  /** A fixed word for the log and the audit record when `reason` is one sentence for every cause (the SAML sign-in); absent otherwise. */
  code?: string;
};
/** The provider could not be reached; try again. */
export class ProviderUnavailableError extends Error { override name = "ProviderUnavailableError"; }
/** An admin must finish setting the provider up. */
export class ProviderNotConfiguredError extends Error { override name = "ProviderNotConfiguredError"; }

export interface SignInProvider {
  readonly method: DeveloperSignInMethod;
  /**
   * Plan 2, Task 8b. `freshSignIn` asks the provider to have the person sign in again instead of reusing its browser session, and
   * `chooseAccount` asks it to show its account picker, each only in the way its documentation lists (see the providers below); a
   * provider with no such option ignores it. Neither is proof: a fresh sign-in is judged by the ID token's `auth_time`, not by the request.
   */
  authorizeUrl(input: {
    state: string; nonce: string; redirectUri: string; freshSignIn?: boolean; chooseAccount?: boolean;
    /**
     * Plan 3, Task 21a-presence (R67): confirming a decision. Cognito managed login with its own email-code method only
     * (`identity_provider=COGNITO`, so no social provider is offered), a sign-in that cannot reuse a browser session (`prompt=login`,
     * `max_age=0`), and the member's verified email as `login_hint`. Only the hosted Rovara ("cloud") provider honours it.
     */
    decide?: { loginHint: string };
  }): Promise<string>;
  complete(input: { code: string; nonce: string; redirectUri: string }): Promise<ProviderResult>;
}

const SCOPES = "openid email profile";
const TIMEOUT_MS = 8_000;

async function call(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderUnavailableError(`${what} could not be reached; try again in a minute`);
  }
  if (response.status === 429 || response.status >= 500) throw new ProviderUnavailableError(`${what} answered HTTP ${response.status}; try again in a minute`);
  try {
    return await response.json();
  } catch {
    throw new ProviderUnavailableError(`${what} answered with something other than JSON; try again in a minute`);
  }
}

/** Only the provider's short error code, never anything else it echoed back. */
const errorCode = (error: unknown): string => (typeof error === "string" ? error.replace(/[^a-z_]/g, "").slice(0, 64) : "") || "no reason given";

/**
 * RFC 6749 section 2.3.1: the client ID and secret are form-encoded before they go in the Basic
 * header. This is the WHATWG application/x-www-form-urlencoded serializer (space becomes "+", and
 * everything but letters, digits and `*-._` is percent-encoded).
 */
const formEncode = (value: string): string => new URLSearchParams([["v", value]]).toString().slice(2);

const NOT_VERIFIED = "the identity token could not be verified; run agentx login again";

async function verifyIdToken(idToken: string, jwks: JWTVerifyGetKey, options: { issuer: string; audience: string; nonce: string; now: number }): Promise<{ ok: true; payload: JWTPayload } | { ok: false; reason: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, {
      issuer: options.issuer, audience: options.audience, currentDate: new Date(options.now), algorithms: ["RS256", "ES256"],
      requiredClaims: ["exp", "iat"], clockTolerance: 60, maxTokenAge: "10m",
    }));
  } catch {
    return { ok: false, reason: NOT_VERIFIED };
  }
  // OIDC Core 3.1.3.7: with several audiences azp is required, and when present it must be us.
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp === undefined) return { ok: false, reason: NOT_VERIFIED };
  if (payload.azp !== undefined && payload.azp !== options.audience) return { ok: false, reason: NOT_VERIFIED };
  if (payload.nonce !== options.nonce) return { ok: false, reason: "the identity token's nonce does not match this sign-in; run agentx login again" };
  return { ok: true, payload };
}

/** OIDC Core 5.1: `email_verified` is a boolean, but some providers send the string "true". */
const emailVerifiedClaim = (payload: JWTPayload): boolean => payload.email_verified === true || payload.email_verified === "true";

/** OIDC Core 2: `auth_time` is a JSON number of seconds; anything else is not a time the sign-in can use. */
const authTimeOf = (payload: JWTPayload): { authTime: number } | Record<string, never> =>
  typeof payload.auth_time === "number" && Number.isFinite(payload.auth_time) && payload.auth_time >= 0 ? { authTime: payload.auth_time } : {};

/** RFC 8176: `amr` is a list of strings; anything else is not a list the decide flow can use. */
const amrOf = (payload: JWTPayload): { amr: string[] } | Record<string, never> =>
  Array.isArray(payload.amr) && payload.amr.every((value) => typeof value === "string") ? { amr: payload.amr } : {};

const federatedOf = (payload: JWTPayload): { federated: true } | Record<string, never> => (payload.identities === undefined ? {} : { federated: true });

/** The group claims of a verified ID token (see `ProviderIdentity.claims`). Own properties only, copied into a plain object. */
const groupClaimsOf = (payload: JWTPayload): { claims: Record<string, unknown> } | Record<string, never> => {
  const claims: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) if (GroupClaimNameSchema.safeParse(key).success) claims[key] = payload[key];
  return { claims };
};

const verifiedEmail = (payload: JWTPayload): string | undefined =>
  typeof payload.email === "string" && emailVerifiedClaim(payload) ? payload.email : undefined;

export function slackSignInProvider(input: {
  teamId: string | undefined; credentials: () => Promise<{ clientId?: string; clientSecret?: string }>; fetch: typeof fetch; jwks: JWTVerifyGetKey; now: () => number;
}): SignInProvider {
  const configured = async () => {
    if (input.teamId === undefined) throw new ProviderNotConfiguredError("this AgentX environment has no Slack team ID yet; ask an admin to run agentx signin enable slack");
    const { clientId, clientSecret } = await input.credentials();
    if (clientId === undefined || clientSecret === undefined) throw new ProviderNotConfiguredError("the Slack app's client ID and client secret are not stored yet; ask an admin to run agentx signin enable slack");
    return { teamId: input.teamId, clientId, clientSecret };
  };
  return {
    method: "slack",
    async authorizeUrl({ state, nonce, redirectUri }) {
      const { teamId, clientId } = await configured();
      const url = new URL("https://slack.com/openid/connect/authorize");
      for (const [key, value] of Object.entries({ response_type: "code", scope: SCOPES, client_id: clientId, state, nonce, redirect_uri: redirectUri, team: teamId })) url.searchParams.set(key, value);
      return url.toString();
    },
    async complete({ code, nonce, redirectUri }) {
      const { teamId, clientId, clientSecret } = await configured();
      const body = await call(input.fetch, "https://slack.com/api/openid.connect.token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }).toString(),
      }, "Slack") as { ok?: boolean; error?: unknown; id_token?: unknown };
      if (body.error === "ratelimited") throw new ProviderUnavailableError("Slack is rate limiting sign-ins; try again in a minute");
      if (body.ok !== true || typeof body.id_token !== "string") {
        return { ok: false, reason: `Slack refused the sign-in (${errorCode(body.error)}); run agentx login again` };
      }
      const verified = await verifyIdToken(body.id_token, input.jwks, { issuer: SLACK_OIDC_ISSUER, audience: clientId, nonce, now: input.now() });
      if (!verified.ok) return verified;
      const team = verified.payload["https://slack.com/team_id"];
      if (team !== teamId) return { ok: false, wrongAccount: true, reason: `you signed in to Slack workspace ${SlackTeamIdSchema.safeParse(team).data ?? "unknown"}, but this AgentX serves ${teamId}` };
      const userId = SlackUserIdSchema.safeParse(verified.payload["https://slack.com/user_id"]);
      if (!userId.success) return { ok: false, reason: "Slack's identity token names no Slack user; run agentx login again" };
      const email = verifiedEmail(verified.payload);
      return {
        ok: true,
        identity: {
          method: "slack", issuer: SLACK_OIDC_ISSUER, subject: userId.data,
          displayName: (typeof verified.payload.name === "string" ? cleanDisplayName(verified.payload.name) : undefined) ?? userId.data,
          ...(email === undefined ? {} : { email, emailVerified: true }),
          slackUserId: userId.data,
        },
      };
    },
  };
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

export function oidcSignInProvider(input: {
  /** "oidc" is the company's own sign-in; "cloud" is the hosted Rovara one. Default "oidc". */
  method?: "oidc" | "cloud";
  issuer: string; clientId: string; clientSecret: () => Promise<string>; requiredClaim?: string; requiredValues: readonly string[];
  fetch: typeof fetch; jwksFor: (jwksUri: string) => JWTVerifyGetKey; now: () => number;
}): SignInProvider {
  const method = input.method ?? "oidc";
  const issuer = input.issuer.replace(/\/+$/, "");
  let discovery: Promise<Discovery> | undefined;
  const discover = () => {
    if (input.requiredClaim === undefined && input.requiredValues.length > 0) {
      return Promise.reject(new ProviderNotConfiguredError("company sign-in lists required values but no claim to check them against; ask an admin to set DeveloperOidcRequiredClaim"));
    }
    discovery ??= call(input.fetch, `${issuer}/.well-known/openid-configuration`, {}, "the company sign-in provider").then((value) => {
      const doc = value as Partial<Discovery>;
      if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== issuer) {
        throw new ProviderNotConfiguredError(`the company sign-in provider's discovery document names a different issuer than ${issuer}; ask an admin to check DeveloperOidcIssuer`);
      }
      for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        const endpoint = doc[key];
        if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) throw new ProviderNotConfiguredError(`the company sign-in provider's discovery document has no HTTPS ${key}; ask an admin to check the provider`);
      }
      return doc as Discovery;
    }).catch((error: unknown) => {
      discovery = undefined;
      throw error;
    });
    return discovery;
  };
  return {
    method,
    async authorizeUrl({ state, nonce, redirectUri, freshSignIn, chooseAccount, decide }) {
      const doc = await discover();
      const url = new URL(doc.authorization_endpoint);
      // Only parameters the documentation lists, and never `prompt=login`: Cognito forwards every prompt value but `none` to the social
      // provider it signs in with, and Google documents only none, consent and select_account.
      //  - `max_age=0`: Cognito managed login /oauth2/authorize (https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html,
      //    "Step-up authentication request"); OIDC Core 3.1.2.1 for a company provider. A server ignores a parameter it does not know (RFC 6749 3.1).
      //  - `prompt=select_account`: the same Cognito page (forwarded to the social provider, no effect on the email code), Google
      //    (https://developers.google.com/identity/openid-connect/openid-connect) and OIDC Core 3.1.2.1.
      for (const [key, value] of Object.entries({
        response_type: "code", scope: SCOPES, client_id: input.clientId, state, nonce, redirect_uri: redirectUri,
        ...(freshSignIn === true ? { max_age: "0" } : {}),
        ...(freshSignIn === true || chooseAccount === true ? { prompt: "select_account" } : {}),
        // A decision is confirmed with the pool's own email code, never a social provider, and never from a browser session (R67). `prompt=login`
        // is safe here because `identity_provider=COGNITO` keeps Cognito from forwarding it to a social provider.
        ...(decide === undefined || method !== "cloud" ? {} : { identity_provider: "COGNITO", prompt: "login", max_age: "0", login_hint: decide.loginHint }),
      })) url.searchParams.set(key, value);
      return url.toString();
    },
    async complete({ code, nonce, redirectUri }) {
      const doc = await discover();
      const secret = await input.clientSecret();
      const basic = Buffer.from(`${formEncode(input.clientId)}:${formEncode(secret)}`).toString("base64");
      const body = await call(input.fetch, doc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }).toString(),
      }, "the company sign-in provider") as { id_token?: unknown; error?: unknown };
      if (typeof body.id_token !== "string") {
        return { ok: false, reason: `the company sign-in provider refused the sign-in (${errorCode(body.error)}); run agentx login again` };
      }
      const verified = await verifyIdToken(body.id_token, input.jwksFor(doc.jwks_uri), { issuer: doc.issuer, audience: input.clientId, nonce, now: input.now() });
      if (!verified.ok) return verified;
      const payload = verified.payload;
      if (input.requiredClaim !== undefined && input.requiredValues.length > 0) {
        const raw = payload[input.requiredClaim];
        const values = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
        if (!input.requiredValues.some((value) => values.includes(value))) {
          return { ok: false, wrongAccount: true, reason: `this AgentX requires the ${input.requiredClaim} claim to include ${input.requiredValues.join(" or ")}` };
        }
      }
      if (typeof payload.sub !== "string" || payload.sub === "") return { ok: false, reason: "the identity token has no subject; ask an admin to check the company sign-in app" };
      const email = verifiedEmail(payload);
      // Release 0.4.16: the person's email is not their name. The email-code sign-in has no name for a person; the name then stays empty and the sign-in
      // table stores a placeholder ("Member 3fa9"), so no screen shows the address to a teammate. A name that holds an address is not used either.
      const name = [payload.name, payload.preferred_username].find((value): value is string => typeof value === "string" && value !== "" && !containsEmailAddress(value));
      return {
        ok: true,
        identity: {
          method, issuer, subject: payload.sub,
          displayName: (name === undefined ? undefined : cleanDisplayName(name)) ?? "",
          ...(email === undefined ? {} : { email, emailVerified: emailVerifiedClaim(payload) }),
          ...authTimeOf(payload),
          ...amrOf(payload),
          ...federatedOf(payload),
          ...(method === "oidc" ? groupClaimsOf(payload) : {}),
        },
      };
    },
  };
}

const GITHUB_ISSUER = "https://github.com";
const GITHUB_SCOPES = "read:user user:email";
const GITHUB_API_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "rovara-sign-in" } as const;

/**
 * Sign up and sign in with GitHub (Task 22). GitHub is OAuth 2.0 but not OIDC (no ID token, no nonce, no discovery), and Cognito cannot
 * federate it, so the broker runs the web flow itself: the state is the sign-in server's own auth-request id (single use, consumed at the
 * callback), and the identity comes from GitHub's REST API. The access token lives only inside `complete()`: it is never stored, logged
 * or returned. The subject is the numeric account id, which survives a changed login; a verified email is the primary one GitHub vouches for.
 */
export function githubSignInProvider(input: {
  clientId: string; clientSecret: () => Promise<string>; fetch: typeof fetch; now: () => number;
}): SignInProvider {
  return {
    method: "github",
    async authorizeUrl({ state, redirectUri, freshSignIn, chooseAccount }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      // GitHub documents one `prompt` value, `select_account` (the account picker); it has no login or max_age
      // (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps). So a fresh GitHub sign-in is best effort:
      // an app the person already authorized can complete without a password, and GitHub has no ID token to carry an auth_time.
      for (const [key, value] of Object.entries({
        client_id: input.clientId, redirect_uri: redirectUri, scope: GITHUB_SCOPES, state,
        ...(freshSignIn === true || chooseAccount === true ? { prompt: "select_account" } : {}),
      })) url.searchParams.set(key, value);
      return url.toString();
    },
    async complete({ code, redirectUri }) {
      const secret = await input.clientSecret();
      // GitHub answers a bad client or code with HTTP 200 and an error body, so only an outage (network, 429, 5xx) is "unavailable".
      const exchanged = await call(input.fetch, "https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ client_id: input.clientId, client_secret: secret, code, redirect_uri: redirectUri }).toString(),
      }, "GitHub") as { access_token?: unknown; error?: unknown } | null;
      const accessToken = exchanged?.access_token;
      if (typeof accessToken !== "string" || accessToken === "") {
        return { ok: false, reason: `GitHub refused the sign-in (${errorCode(exchanged?.error)}); run agentx login again` };
      }
      const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${accessToken}` };
      const user = await call(input.fetch, "https://api.github.com/user", { headers }, "GitHub") as { id?: unknown; login?: unknown; name?: unknown } | null;
      if (typeof user?.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) {
        return { ok: false, reason: "GitHub's answer names no account; run agentx login again" };
      }
      const githubUserId = String(user.id);
      const emails = await call(input.fetch, "https://api.github.com/user/emails?per_page=100", { headers }, "GitHub");
      const primary = Array.isArray(emails)
        ? emails.find((entry): entry is { email: string } => typeof entry === "object" && entry !== null
          && (entry as { primary?: unknown }).primary === true && (entry as { verified?: unknown }).verified === true
          && typeof (entry as { email?: unknown }).email === "string" && (entry as { email: string }).email !== "")
        : undefined;
      const name = [user.name, user.login].find((value): value is string => typeof value === "string" && cleanDisplayName(value) !== undefined);
      return {
        ok: true,
        identity: {
          method: "github", issuer: GITHUB_ISSUER, subject: githubUserId,
          displayName: (name === undefined ? undefined : cleanDisplayName(name)) ?? githubUserId,
          ...(primary === undefined ? {} : { email: primary.email, emailVerified: true }),
          githubUserId,
          ...(typeof user.login === "string" && cleanDisplayName(user.login) !== undefined ? { login: user.login } : {}),
        },
      };
    },
  };
}

// ---- SAML 2.0 (Enterprise foundations I4)

/** The SAML sign-in: a provider like the others, plus what only SAML needs (the identity provider POSTs to us, and we publish our metadata). */
export interface SamlSignInProvider extends SignInProvider {
  /** Whether an administrator has saved and enabled the identity provider's settings. */
  configured(): Promise<boolean>;
  /** Keeps a posted `SAMLResponse` for one redirect (see developer/saml.ts) and returns the single-use handle that `complete` takes as its `code`. Undefined when SAML is not set up. */
  accept(samlResponse: string): Promise<string | undefined>;
  /** Our service provider metadata, to give the identity provider. */
  metadata(): string;
}

const SAML_EMAIL_ATTRIBUTES = ["email", "mail", "emailAddress", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3"] as const;
const SAML_NAME_ATTRIBUTES = ["displayName", "name", "cn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "urn:oid:2.16.840.1.113730.3.1.241"] as const;
const NAME_ID_EMAIL_FORMAT = /^urn:oasis:names:tc:SAML:(?:1\.1|2\.0):nameid-format:emailAddress$/;

export function samlSignInProvider(input: {
  sp: SamlServiceProvider;
  /** The install's single org: SAML settings, the replay record and the stash live in its partition. Absent (a wiring mistake): not configured. */
  orgId: OrgId | undefined;
  load: (orgId: OrgId) => Promise<SamlIdpConfig | undefined>;
  replay: SamlReplayStore;
  stash: SamlResponseStash;
  now: () => number;
}): SamlSignInProvider {
  const settings = async (): Promise<{ orgId: OrgId; config: SamlIdpConfig }> => {
    if (input.orgId === undefined) throw new ProviderNotConfiguredError("SAML sign-in is not set up in this environment");
    const config = await input.load(input.orgId);
    if (config === undefined || !config.enabled) throw new ProviderNotConfiguredError("SAML sign-in is not set up; ask an administrator");
    return { orgId: input.orgId, config };
  };
  const idpOf = (config: SamlIdpConfig) => ({ entityId: config.idpEntityId, ssoUrl: config.ssoUrl, certificate: config.certificate });
  return {
    method: "saml",
    async configured() {
      try {
        await settings();
        return true;
      } catch (error) {
        if (error instanceof ProviderNotConfiguredError) return false;
        throw error;
      }
    },
    async authorizeUrl({ state, nonce, freshSignIn }) {
      const { config } = await settings();
      return samlAuthorizeUrl({ sp: input.sp, idp: idpOf(config), state, nonce, ...(freshSignIn === true ? { freshSignIn } : {}) });
    },
    async accept(samlResponse) {
      const { orgId } = await settings();
      // The size bound, before anything is stored (verifySamlResponse bounds it again before it is read).
      if (samlResponse.length > Math.ceil((SAML_RESPONSE_MAX_BYTES * 4) / 3) + 64) return undefined;
      const handle = randomBytes(32).toString("base64url");
      await input.stash.put(orgId, handle, samlResponse, Math.floor(input.now() / 1000) + SAML_STASH_TTL_SECONDS);
      return handle;
    },
    metadata: () => samlServiceProviderMetadata(input.sp),
    async complete({ code, nonce }) {
      const { orgId, config } = await settings();
      if (!SAML_HANDLE.test(code)) return { ok: false, reason: SAML_SIGN_IN_REFUSED_MESSAGE, code: "response_unreadable" };
      const response = await input.stash.take(orgId, code, input.now());
      if (response === undefined) return { ok: false, reason: SAML_SIGN_IN_REFUSED_MESSAGE, code: "response_unreadable" };
      const verified = await verifySamlResponse({ samlResponse: response, sp: input.sp, idp: idpOf(config), nonce, nowMs: input.now() });
      if (!verified.ok) return { ok: false, reason: SAML_SIGN_IN_REFUSED_MESSAGE, code: verified.reason };
      // The assertion is accepted once: a copy of it, at any time, is a replay.
      const claimed = await claimAssertion(input.replay, orgId, verified.assertion);
      if (!claimed.ok) return { ok: false, reason: SAML_SIGN_IN_REFUSED_MESSAGE, code: claimed.reason };
      const { assertion } = claimed;
      const attributeOf = (names: readonly string[]) => names.flatMap((name) => assertion.attributes[name] ?? []).find((value) => value !== "" && !value.includes("\u0000"));
      const emailOf = (candidate: string | undefined) => (candidate !== undefined && candidate.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : undefined);
      // The email the identity provider vouches for: its email attribute, else a NameID in email format. The provider is the company's own and signs the assertion, so the address counts as verified.
      const email = emailOf(attributeOf(SAML_EMAIL_ATTRIBUTES)) ?? (NAME_ID_EMAIL_FORMAT.test(assertion.nameIdFormat ?? "") ? emailOf(assertion.subject) : undefined);
      const name = [attributeOf(SAML_NAME_ATTRIBUTES)].find((value): value is string => value !== undefined && !containsEmailAddress(value));
      // Only the attributes that carry groups reach the group mapping; a person-editable one (email, name) never does. The value is the list as the assertion gave it.
      const claims: Record<string, unknown> = {};
      for (const [attribute, values] of Object.entries(assertion.attributes)) if (GroupClaimNameSchema.safeParse(attribute).success) claims[attribute] = [...values];
      return {
        ok: true,
        identity: {
          method: "saml", issuer: assertion.issuer, subject: assertion.subject,
          displayName: (name === undefined ? undefined : cleanDisplayName(name)) ?? "",
          ...(email === undefined ? {} : { email, emailVerified: true }),
          ...(assertion.authTime === undefined ? {} : { authTime: assertion.authTime }),
          claims,
        },
      };
    },
  };
}
