// Plan 3, Task 21a-presence (R66, R67, R6-2, R6-3, R6-4, R7-1, R7-2): the sign-in function's half of "a person present decides". Three steps:
//
//   identify  GET /v1/auth/decide/identify?return=...   a link with no ticket (Slack, a task event, someone else's message): the person's
//                                                        NORMAL sign-in, any method, which only NAMES the member. It never counts as fresh.
//             callback (purpose "decide_identify")       resolves the member, checks they may decide the approval now, mints a ticket for
//                                                        that member (mintedBy "identified_session") and goes to start.
//   start     GET /v1/auth/decide/start?ticket=...       redeems the ticket (the only source of who and what), makes sure the member has an
//                                                        email-code user in the pool, and sends the browser to Cognito managed login with the
//                                                        email code only, from a clean sign-in (prompt=login, max_age=0).
//   callback  GET /v1/auth/callback/cloud (decide state)  accepts the sign-in only when it was interactive and recent
//                                                        (isFreshInteractiveSignIn), resolves to the ticket's member, and writes the session.
//
// GitHub is never offered for a decision and never counts as fresh. Nothing here logs or stores a ticket, state, verifier or cookie value.
import { withDecideIsolation } from "./confirm-page.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AdminCreateUserCommand, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { normalizeEmail } from "@rovara-code/contracts";
import { type DeveloperSignInMethod } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";
import type { OrgStore } from "../org/store.js";
import { mayDecide, type DecideInspection, type DecideKinds } from "./decide-kinds.js";
import {
  APPROVE_RETURN_PATTERN, DECIDE_COOKIE, DECIDE_PKCE_COOKIE, DECIDE_SECONDS, RATE_LIMIT_MESSAGE, TICKET_EXPIRED_MESSAGE, cookieOf, csrfTokenFor, endedWords,
  type DecideState, type DecideStore,
} from "./decide-session.js";
import type { ResolvedSignInDeveloper } from "./identities.js";
import { ProviderNotConfiguredError, ProviderUnavailableError, type ProviderIdentity, type SignInProvider } from "./providers.js";
import type { HttpResult } from "./server.js";
import type { AuthRequestRecord, DeveloperSignInStore } from "./store.js";
import { pkceChallengeMatches, sha256Hex } from "./tokens.js";

export const NO_VERIFIED_EMAIL_REFUSAL = "Rovara needs a verified email to confirm decisions. Sign in once with your email code, or ask an admin.";
export const COGNITO_SETUP_REFUSAL = "Rovara couldn't set up email confirmation for your account. Ask an admin for help.";
export const NOT_EMAIL_CODE_REFUSAL = "Confirm with the email code sent to your address. Open the approval again.";
export const DIFFERENT_ACCOUNT_REFUSAL = "You confirmed as a different account. Open the approval again.";
const OPEN_AGAIN = "Open the approval again from Rovara.";

/** What the sign-in function needs to run the decide flow: its tickets and states, the approval kinds, and Cognito's admin API on the cloud pool. */
export interface DecideSignInDependencies {
  store: DecideStore;
  kinds: DecideKinds;
  /** The cloud pool's OIDC issuer as the provider reports it (`ProviderIdentity.issuer`), which keys a pool user's sign-in identity. */
  cloudIssuer: string;
  cognito: { client: { send(command: unknown): Promise<unknown> }; userPoolId: string };
}

/** What `server.ts` lends the flow, so it renders and logs exactly as every other page of the sign-in server does. */
export interface DecideSignInContext {
  deps: DecideSignInDependencies;
  signIn: DeveloperSignInStore;
  orgs: Pick<OrgStore, "orgForDeveloper" | "developerForVerifiedEmail">;
  endpoint(path: string): string;
  methods(): DeveloperSignInMethod[];
  methodLabel(method: DeveloperSignInMethod): string;
  provider(method: DeveloperSignInMethod): SignInProvider;
  resolveDeveloper(method: DeveloperSignInMethod, identity: ProviderIdentity): Promise<ResolvedSignInDeveloper>;
  /** Tells the account's address, best effort (never fails the flow), that an email-code sign-in was added for confirming decisions. */
  noticeDecideSignIn(to: string): Promise<void>;
  /** `refreshTo` adds a `<meta http-equiv="refresh">` to the same-origin path, for a page that sends the browser on after it is shown. */
  page(statusCode: number, title: string, paragraphs: string[], links?: Array<{ href: string; label: string }>, refreshTo?: string): HttpResult;
  redirect(location: string): HttpResult;
  now(): number;
  log(entry: Record<string, unknown>): void;
}

/** How Cognito reports that a person signed in with the email code (OIDC `amr`); the exact value is confirmed live in Task 37. */
const EMAIL_CODE_AMR = new Set(["otp", "email_otp", "email-otp", "emailotp", "email"]);
const FUTURE_SKEW_SECONDS = 60;

/**
 * R67, R6-4: whether this ID token proves the person was present for THIS flow. It needs an `auth_time` that is not before the flow began
 * (a session that existed before it proves nothing), is at most 10 minutes old, and is not from the future. When the token carries `amr`, it
 * must show the email code. When it carries none, a native Cognito sign-in completed in this flow is accepted, which is what the state
 * record says (`identity_provider=COGNITO`, `prompt=login`, written by the start route): a password sign-in also needs the person, and
 * GitHub cannot appear because it is not a Cognito provider.
 */
export function isFreshInteractiveSignIn(token: { authTime?: number | undefined; amr?: readonly string[] | undefined }, state: Pick<DecideState, "startedAt" | "identityProvider" | "prompt">, nowMs: number): boolean {
  const authTime = token.authTime;
  if (authTime === undefined || !Number.isFinite(authTime)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (authTime < Math.floor(state.startedAt / 1000)) return false;
  if (nowSeconds - authTime > DECIDE_SECONDS || authTime - nowSeconds > FUTURE_SKEW_SECONDS) return false;
  if (token.amr !== undefined) return token.amr.some((value) => EMAIL_CODE_AMR.has(value.toLowerCase()));
  return state.identityProvider === "COGNITO" && state.prompt === "login";
}

// The PKCE cookie must reach the callback, a top-level navigation back from the pool, so it is Lax; the session cookie is Strict (R67).
const pkceCookie = (verifier: string) => `${DECIDE_PKCE_COOKIE}=${verifier}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DECIDE_SECONDS}`;
const clearedPkceCookie = () => `${DECIDE_PKCE_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
const sessionCookie = (value: string) => `${DECIDE_COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DECIDE_SECONDS}`;
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;

function hashMatches(value: string, hash: string): boolean {
  const given = Buffer.from(sha256Hex(value));
  const stored = Buffer.from(hash);
  return given.length === stored.length && timingSafeEqual(given, stored);
}

export function createDecideSignIn(context: DecideSignInContext) {
  const ctx: DecideSignInContext = { ...context,
    page: (...args) => withDecideIsolation(context.page(...args)),
    redirect: (...args) => withDecideIsolation(context.redirect(...args)),
  };
  const { deps } = ctx;
  const attribute = (attributes: Array<{ Name?: string; Value?: string }> | undefined, name: string) => attributes?.find((entry) => entry.Name === name)?.Value;

  const expiredPage = (statusCode = 400) => ctx.page(statusCode, "This confirmation link has expired", [TICKET_EXPIRED_MESSAGE]);
  const rateLimited = () => ctx.page(429, "Too many attempts", [RATE_LIMIT_MESSAGE]);
  const unavailable = () => ctx.page(503, "Confirmation is unavailable", ["Try opening the approval again in a moment."]);
  const refuse = (statusCode: number, title: string, paragraphs: string[], cookies: string[] = []): HttpResult => ({ ...ctx.page(statusCode, title, paragraphs), ...(cookies.length === 0 ? {} : { cookies }) });

  /**
   * Whether `developerId` may decide `approvalId` now, asked of the kinds (the broker, over an invoke). A question that can't be answered is not a
   * yes (hand-off 1): undefined, and the caller answers a 503 page and does nothing else (no ticket, no Cognito call).
   */
  async function inspectNow(target: Parameters<typeof mayDecide>[1]): Promise<DecideInspection | undefined> {
    try {
      return await mayDecide(deps.kinds, target);
    } catch (error) {
      ctx.log({ event: "signin.decide_inspect_failed", approvalId: target.approvalId, error: codeOf(error) ?? (error instanceof Error ? error.name : "unknown") });
      return undefined;
    }
  }

  /** What a person hears when the approval cannot be decided by them now. */
  function inspectionPage(inspection: Exclude<DecideInspection, { status: "open" }>, cookies: string[] = []): HttpResult {
    if (inspection.status === "forbidden") return refuse(403, "You can't decide this", [`Only ${inspection.who} can decide this.`], cookies);
    if (inspection.status === "decided" || inspection.status === "expired") return refuse(409, inspection.status === "expired" ? "This request expired" : "Already decided", [endedWords(inspection)], cookies);
    return refuse(404, "Approval not found", ["This approval was not found. Open it again from Rovara."], cookies);
  }

  // ---- identify ----------------------------------------------------------------------------------------------------------------------

  /** `GET /v1/auth/decide/identify?return=`: the person's normal sign-in, bound to this browser, to learn who they are. */
  async function identify(query: URLSearchParams): Promise<HttpResult> {
    // Decoded once by URLSearchParams, then matched whole: `//evil`, `%2F%2Fevil`, backslashes, `..` and anything else do not fit.
    const approvalId = APPROVE_RETURN_PATTERN.exec(query.get("return") ?? "")?.[1];
    if (approvalId === undefined) return ctx.page(400, "This link isn't valid", [OPEN_AGAIN]);
    const methods = ctx.methods();
    if (methods.length === 0) return ctx.page(503, "Sign-in is unavailable", ["Ask a Rovara administrator to enable a sign-in method."]);
    const verifier = randomBytes(32).toString("base64url");
    const auth = await ctx.signIn.createAuthRequest({
      clientRedirectUri: ctx.endpoint("/decide/identified"), clientState: randomBytes(24).toString("base64url"),
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"), nonce: randomBytes(32).toString("base64url"),
      purpose: "decide_identify", decideApprovalId: approvalId,
    });
    const cookies = [pkceCookie(verifier)];
    if (methods.length === 1) {
      if (await ctx.signIn.chooseMethod(auth.id, methods[0]!) === undefined) return refuse(503, "Sign-in is unavailable", ["Try opening the approval again in a moment."], cookies);
      return { ...await identifyToProvider(auth.id, auth.nonce, methods[0]!), cookies };
    }
    return { ...ctx.page(200, "Sign in to confirm", ["Sign in so Rovara knows who you are. You will be asked for an email code next."], methods.map((method) => ({
      href: `${ctx.endpoint("/authorize")}?request=${encodeURIComponent(auth.id)}&method=${method}`, label: `Sign in with ${ctx.methodLabel(method)}`,
    }))), cookies };
  }

  /** Off to the provider for an identify sign-in; a provider that cannot be reached is a page here. */
  async function identifyToProvider(requestId: string, nonce: string, method: DeveloperSignInMethod): Promise<HttpResult> {
    try {
      return ctx.redirect(await ctx.provider(method).authorizeUrl({ state: requestId, nonce, redirectUri: ctx.endpoint(`/callback/${method}`) }));
    } catch (error) {
      ctx.log({ event: "signin.decide_identify_authorize_failed", method, error: errorName(error) });
      return unavailable();
    }
  }

  /** The member this identify sign-in is, resolving the usual way but never starting an account for a stranger. */
  async function memberOf(method: DeveloperSignInMethod, identity: ProviderIdentity): Promise<string | undefined> {
    const known = await ctx.signIn.getIdentityLink(ownerKeyForSubject(identity.issuer, identity.subject)) !== undefined;
    const named = !known && identity.emailVerified === true && identity.email !== undefined && normalizeEmail(identity.email).ascii
      && await ctx.orgs.developerForVerifiedEmail(identity.email) !== undefined;
    if (!known && !named) return undefined;
    return (await ctx.resolveDeveloper(method, identity)).developerId;
  }

  /** The callback of an identify sign-in: names the member, checks they may decide now, mints a ticket for them, and goes to start. Never a session. */
  async function identifyCallback(method: DeveloperSignInMethod, request: AuthRequestRecord, code: string | null, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const verifier = cookieOf(headers, DECIDE_PKCE_COOKIE);
    if (verifier === undefined || !pkceChallengeMatches(verifier, request.codeChallenge)) return ctx.page(400, "This sign-in expired", [OPEN_AGAIN]);
    const cleared = [clearedPkceCookie()];
    const approvalId = request.decideApprovalId;
    if (approvalId === undefined || !APPROVE_RETURN_PATTERN.test(`/v1/app/approve/${approvalId}`)) return refuse(400, "This link isn't valid", [OPEN_AGAIN], cleared);
    if (code === null) return refuse(400, "Sign-in was cancelled", [OPEN_AGAIN], cleared);
    try {
      const result = await ctx.provider(method).complete({ code, nonce: request.nonce, redirectUri: ctx.endpoint(`/callback/${method}`) });
      if (!result.ok) {
        ctx.log({ event: "signin.refused", method, reason: result.reason });
        return refuse(403, "Sign-in was refused", [result.reason, OPEN_AGAIN], cleared);
      }
      const developerId = await memberOf(method, result.identity);
      const record = developerId === undefined ? undefined : await ctx.signIn.getDeveloper(developerId);
      const membership = developerId === undefined ? undefined : await ctx.orgs.orgForDeveloper(developerId);
      if (developerId === undefined || record?.revoked === true || membership === undefined) {
        return refuse(403, "You can't decide this", ["Only the people this was asked of can decide it."], cleared);
      }
      const inspection = await inspectNow({ orgId: membership.orgId, developerId, approvalId });
      if (inspection === undefined) return { ...unavailable(), cookies: cleared };
      if (inspection.status !== "open") return inspectionPage(inspection, cleared);
      const ticket = await deps.store.mintTicket({ orgId: membership.orgId, developerId, approvalId, mintedBy: "identified_session" });
      ctx.log({ event: "signin.decide_ticket_minted", mintedBy: "identified_session", developerId, approvalId });
      return { ...ctx.redirect(`/v1/auth/decide/start?ticket=${ticket}`), cookies: cleared };
    } catch (error) {
      if (codeOf(error) === "TOO_MANY_REQUESTS") return { ...rateLimited(), cookies: cleared };
      if (error instanceof ProviderUnavailableError || error instanceof ProviderNotConfiguredError) return { ...unavailable(), cookies: cleared };
      throw error;
    }
  }

  // ---- start -------------------------------------------------------------------------------------------------------------------------

  /**
   * The member's own native email-code pool user for `email` (R6-2, R7-2), made and linked if need be, or a refusal page. Whether one exists
   * is Cognito's answer (`AdminGetUser`), never a link's provider: a Google sign-in through the pool is a `cloud` link too, and its pool
   * user (status EXTERNAL_PROVIDER, with `identities`) cannot receive the email code. An existing native user is used only when it is
   * verified, has this email, and is linked to this member or to no one at all. A missing one is created (at most one a day, and only a
   * successful create uses the slot). Its `sub` is what the callback will require.
   */
  async function ensureEmailCodeUser(developerId: string, email: string): Promise<{ sub: string } | HttpResult> {
    const { cognito } = deps;
    const refusalPage = (reason: string) => {
      ctx.log({ event: "signin.decide_cognito_refused", developerId, reason });
      return refuse(403, "Email confirmation isn't set up", [COGNITO_SETUP_REFUSAL]);
    };
    type PoolUser = { UserStatus?: string; UserAttributes?: Array<{ Name?: string; Value?: string }> };
    const lookup = async (): Promise<PoolUser | undefined> => {
      try {
        return await cognito.client.send(new AdminGetUserCommand({ UserPoolId: cognito.userPoolId, Username: email })) as PoolUser;
      } catch (error) {
        if (errorName(error) === "UserNotFoundException") return undefined;
        throw error;
      }
    };
    let existing = await lookup();
    let sub: string | undefined;
    if (existing === undefined) {
      await deps.store.takeCreateUserSlot(developerId);
      try {
        const created = await cognito.client.send(new AdminCreateUserCommand({
          UserPoolId: cognito.userPoolId, Username: email,
          UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }], MessageAction: "SUPPRESS",
        })) as { User?: { Attributes?: Array<{ Name?: string; Value?: string }> } };
        sub = attribute(created.User?.Attributes, "sub");
        if (sub === undefined) return refusalPage("no_sub");
      } catch (error) {
        // Only a successful AdminCreateUser keeps the slot.
        await deps.store.releaseCreateUserSlot(developerId);
        if (errorName(error) !== "UsernameExistsException" && errorName(error) !== "AliasExistsException") throw error;
        existing = await lookup();
        if (existing === undefined) return refusalPage("create_raced");
      }
    }
    if (existing !== undefined) {
      const existingSub = attribute(existing.UserAttributes, "sub");
      const existingEmail = attribute(existing.UserAttributes, "email");
      if (existing.UserStatus === "EXTERNAL_PROVIDER" || attribute(existing.UserAttributes, "identities") !== undefined) return refusalPage("federated_user");
      if (existingSub === undefined || attribute(existing.UserAttributes, "email_verified") !== "true"
        || existingEmail === undefined || normalizeEmail(existingEmail).email !== email) return refusalPage("user_not_usable");
      const identityKey = ownerKeyForSubject(deps.cloudIssuer, existingSub);
      const linkedTo = await ctx.signIn.developerForIdentity(identityKey);
      const hasLinkItem = await ctx.signIn.getIdentityLink(identityKey) !== undefined;
      if (linkedTo !== undefined ? linkedTo !== developerId : hasLinkItem || await ctx.signIn.getDeveloper(identityKey) !== undefined) return refusalPage("sub_belongs_to_another");
      sub = existingSub;
    }
    const identityKey = ownerKeyForSubject(deps.cloudIssuer, sub!);
    const linked = await ctx.signIn.linkIdentity({ identityKey, developerId, provider: "cloud", issuer: deps.cloudIssuer, subject: sub!, email });
    // Linking never moves an identity, and a link that lost a race to someone else is a refusal, not a re-link.
    if (await ctx.signIn.developerForIdentity(identityKey) !== developerId) return refusalPage("link_not_ours");
    if (linked.created) {
      ctx.log({ event: "signin.decide_cognito_linked", developerId });
      await ctx.noticeDecideSignIn(email);
    }
    return { sub: sub! };
  }

  /** `GET /v1/auth/decide/start?ticket=`: the only start route. It takes no `return` and no member; both come from the ticket. */
  async function start(query: URLSearchParams): Promise<HttpResult> {
    const ticket = await deps.store.redeemTicket(query.get("ticket") ?? "");
    if (ticket === undefined) return expiredPage();
    const returnPath = `/v1/app/approve/${ticket.approvalId}`;
    if (!APPROVE_RETURN_PATTERN.test(returnPath)) return expiredPage();
    const record = await ctx.signIn.getDeveloper(ticket.developerId);
    if (record?.revoked === true) return refuse(403, "You can't decide this", ["Contact a Rovara administrator."]);
    const inspection = await inspectNow({ orgId: ticket.orgId, developerId: ticket.developerId, approvalId: ticket.approvalId });
    if (inspection === undefined) return unavailable();
    if (inspection.status !== "open") return inspectionPage(inspection);
    const { emails } = await ctx.signIn.decideEmailsOf(ticket.developerId);
    const email = emails[0];
    if (email === undefined) return refuse(403, "A verified email is needed", [NO_VERIFIED_EMAIL_REFUSAL]);
    let cloud: SignInProvider;
    try {
      cloud = ctx.provider("cloud");
    } catch {
      return unavailable();
    }
    try {
      const poolUser = await ensureEmailCodeUser(ticket.developerId, email);
      if (!("sub" in poolUser)) return poolUser;
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      await deps.store.putState(state, {
        purpose: "decide", stateHash: sha256Hex(state), nonce, codeVerifierHash: sha256Hex(verifier), startedAt: ctx.now(),
        return: returnPath, approvalId: ticket.approvalId, orgId: ticket.orgId, developerId: ticket.developerId, expectedSub: poolUser.sub,
        identityProvider: "COGNITO", prompt: "login", expiresAt: Math.floor(ctx.now() / 1000) + DECIDE_SECONDS,
      });
      const location = await cloud.authorizeUrl({ state, nonce, redirectUri: ctx.endpoint("/callback/cloud"), decide: { loginHint: email } });
      ctx.log({ event: "signin.decide_started", developerId: ticket.developerId, approvalId: ticket.approvalId });
      return { ...ctx.redirect(location), cookies: [pkceCookie(verifier)] };
    } catch (error) {
      if (codeOf(error) === "TOO_MANY_REQUESTS") return rateLimited();
      if (error instanceof ProviderUnavailableError || error instanceof ProviderNotConfiguredError) return unavailable();
      throw error;
    }
  }

  // ---- the session -------------------------------------------------------------------------------------------------------------------

  /**
   * The callback of the fresh sign-in, for a state `start` wrote. `return`, `approvalId` and `developerId` come only from that record. The
   * sign-in is accepted only when its ID token's nonce is the stored one, it is fresh and interactive, and the pool user resolves to the
   * ticket's member; then a new session (a new cookie value, whatever the browser already holds) is written, bound to the one approval.
   */
  async function callback(state: DecideState, code: string | null, headers: Record<string, string | undefined>): Promise<HttpResult> {
    const verifier = cookieOf(headers, DECIDE_PKCE_COOKIE);
    if (verifier === undefined || !hashMatches(verifier, state.codeVerifierHash)) return ctx.page(400, "This confirmation sign-in expired", [OPEN_AGAIN]);
    const cleared = [clearedPkceCookie()];
    if (code === null) return refuse(400, "Sign-in was cancelled", [OPEN_AGAIN], cleared);
    let identity: ProviderIdentity;
    try {
      const result = await ctx.provider("cloud").complete({ code, nonce: state.nonce, redirectUri: ctx.endpoint("/callback/cloud") });
      if (!result.ok) {
        ctx.log({ event: "signin.decide_refused", reason: "not_verified" });
        return refuse(403, "Sign-in was refused", [result.reason, OPEN_AGAIN], cleared);
      }
      identity = result.identity;
    } catch (error) {
      if (error instanceof ProviderUnavailableError || error instanceof ProviderNotConfiguredError) return { ...unavailable(), cookies: cleared };
      throw error;
    }
    if (!isFreshInteractiveSignIn({ authTime: identity.authTime, amr: identity.amr }, state, ctx.now())) {
      ctx.log({ event: "signin.decide_refused", reason: "not_fresh", developerId: state.developerId });
      return refuse(403, "That sign-in wasn't recent enough", ["Confirm with a new email code.", OPEN_AGAIN], cleared);
    }
    // Only the member's own email-code pool user counts (R67). Anything else, a Google-federated user above all, is refused before anything
    // is linked, merged or written: a federated user of the same member resolves to them but is not the email code.
    const identityKey = ownerKeyForSubject(identity.issuer, identity.subject);
    const signedInAs = await ctx.signIn.developerForIdentity(identityKey);
    if (identity.federated === true || identity.subject !== state.expectedSub || signedInAs !== state.developerId) {
      const sameMember = signedInAs === state.developerId;
      ctx.log({ event: "signin.decide_refused", reason: sameMember ? "not_email_code_user" : "different_account" });
      return refuse(403, sameMember ? "Use the email code" : "Different account", [sameMember ? NOT_EMAIL_CODE_REFUSAL : DIFFERENT_ACCOUNT_REFUSAL], cleared);
    }
    if ((await ctx.signIn.getDeveloper(state.developerId))?.revoked === true) return refuse(403, "Your sign-in was turned off", ["Contact a Rovara administrator."], cleared);
    if (!APPROVE_RETURN_PATTERN.test(state.return) || state.return !== `/v1/app/approve/${state.approvalId}`) return refuse(400, "This link isn't valid", [OPEN_AGAIN], cleared);
    // A new cookie value every time: any decide cookie the browser already holds is ignored here and replaced by this one.
    const cookie = randomBytes(32).toString("base64url");
    const signedInAt = Math.min(Math.floor(ctx.now() / 1000), Math.floor(identity.authTime!));
    await deps.store.putSession(cookie, {
      orgId: state.orgId, developerId: state.developerId, approvalId: state.approvalId, signedInAt, method: "email_code",
      csrfHash: sha256Hex(csrfTokenFor(cookie)), expiresAt: signedInAt + DECIDE_SECONDS,
    });
    // A new sign-in ends the session this browser held before (the cookie it presented), so the old value stops working at once.
    const earlier = cookieOf(headers, DECIDE_COOKIE);
    if (earlier !== undefined && earlier !== cookie && earlier.length >= 32 && earlier.length <= 128) {
      try {
        await deps.store.deleteSession(earlier);
      } catch (error) {
        ctx.log({ event: "signin.decide_earlier_session_not_ended", error: errorName(error) });
      }
    }
    ctx.log({ event: "signin.decide_session_started", developerId: state.developerId, approvalId: state.approvalId });
    // A same-origin page that sends the browser on itself, not a redirect: a SameSite=Strict cookie is not sent on a redirect that continues
    // a navigation begun on the pool's (cross-site) page, but it is on the navigation this page starts.
    return {
      ...ctx.page(200, "Confirmed", ["You're signed in for this decision."], [{ href: state.return, label: "Continue to the approval" }], state.return),
      cookies: [sessionCookie(cookie), ...cleared],
    };
  }

  return { identify, identifyToProvider, identifyCallback, start, callback };
}
