// Guided onboarding PR 11: the browser binding of an "Add to Slack" or "Connect Linear" round trip, the same way as Connect GitHub (github-connect.ts, PR 2).
// Rovara Code owns the state, the code exchange and the binding; Cloud only carries the person through it, bound to their browser and their Cloud sign-in.
//
//   - Start sets `rovara_cloud_<provider>` (HttpOnly, Secure, SameSite=Lax, Path=/api/connect/<provider>, ten minutes) to 32 random bytes of its own (the
//     "binder"). Cloud keeps only HASHES in its sealed, single-use pending store (sessions.ts; PENDING# rows): the row is keyed by sha256 of the binder and
//     holds sha256 of Code's state, sha256 of this sign-in's cookie key, the person's id and the app page to come back to.
//   - The callback takes that row (once, whatever happens next) and goes on only when the state's hash and the sign-in's hash match (constant-time) and the
//     person is the same; it always clears the cookie.
//   - The outcome stays server-side, sealed, under a key derived from this sign-in's cookie; never in a URL or a log. The landing URL carries one fixed word.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignInEnded, type CodeClient } from "./code-client.js";
import { companyOf, type CompanyMembership } from "./company-caller.js";
import { sessionKey, type CodeSession, type SessionStore } from "./sessions.js";
import { STEP_UP_WINDOW_SECONDS, freshStepUp } from "./step-up.js";

export type ConnectProvider = "slack" | "linear";
export const CONNECT_TTL_MS = 10 * 60_000;
/** Where a connect comes back to when its start named no page. */
export const CONNECT_DEFAULT_BACK = "/app/onboard";

/** A pending-store row of a Slack or Linear connect: the cookie binding ("state") or the callback's outcome ("result"). Hashes, ids and fixed words only. */
export interface ConnectPending {
  provider: ConnectProvider;
  kind: "state" | "result";
  /** sha256 of this sign-in's cookie key. */
  session: string;
  developerId: string;
  /** kind state: sha256 of Code's state. */
  stateHash?: string;
  /** The app page the callback lands on (checked by connectBack at start). */
  back: string;
  /** kind result: the checked outcome (names and flags only, never a token or a state). */
  result?: Record<string, unknown>;
}

/** Cookie values, Code's states: 32 random bytes, base64url. */
export const CONNECT_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const BACK_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,99}$/u;

/**
 * The app page a connect may come back to: `/app` and up to four plain segments, no query, no escapes, no dot segments. Anything else is undefined (the start
 * refuses it). The page is never a company; the browser can only pick where in its own app it lands.
 */
export function connectBack(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300 || !value.startsWith("/app")) return undefined;
  const segments = value.split("/").slice(1);
  if (segments[0] !== "app" || segments.length > 5) return undefined;
  return segments.slice(1).every((segment) => BACK_SEGMENT.test(segment) && segment !== "." && segment !== "..") ? value : undefined;
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Equal-length hex digests compared in constant time. */
export function sameDigest(a: string | undefined, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
export const connectCookieName = (provider: ConnectProvider) => `rovara_cloud_${provider}`;
export const connectCookiePath = (provider: ConnectProvider) => `/api/connect/${provider}`;
export const connectCallbackPath = (provider: ConnectProvider) => `${connectCookiePath(provider)}/callback`;
/** The pending-store key of a cookie binder: a hash, so the stored key can't be turned back into the cookie. */
export const connectStateKey = (provider: ConnectProvider, binder: string) => `connect.${provider}.state.${sha256(`rovara-${provider}-connect-binder:${binder}`)}`;
/** The pending-store key of this sign-in's outcome: derived from the sign-in's cookie, so only that browser's sign-in reads it. */
export const connectResultKey = (provider: ConnectProvider, sessionCookie: string) => `connect.${provider}.result.${sha256(`rovara-${provider}-connect-result:${sessionKey(sessionCookie)}`)}`;
const sessionBinding = (provider: ConnectProvider, sessionCookie: string) => sha256(`rovara-${provider}-connect-session:${sessionKey(sessionCookie)}`);

export interface ConnectFlowDeps {
  provider: ConnectProvider;
  store: SessionStore;
  now: () => Date;
  secureCookies: boolean;
}

/** What the callback found: the person's sign-in and the binding's page, or why it refused (a reason word for the log only). */
export type Bound = { ok: true; session: CodeSession; sessionCookie: string; back: string; state: string } | { ok: false; reason: "no_binding" | "session" | "state" };

export function createConnectFlow(deps: ConnectFlowDeps) {
  const { provider } = deps;
  const nowMs = () => deps.now().getTime();
  const cookie = (value: string, maxAge: number) =>
    `${connectCookieName(provider)}=${value}; HttpOnly; SameSite=Lax; Path=${connectCookiePath(provider)}${deps.secureCookies ? "; Secure" : ""}; Max-Age=${String(maxAge)}`;
  return {
    clearCookie: cookie("", 0),
    landing: (back: string, word: string) => `${back}?${provider}=${word}`,

    /** Binds Code's state to this browser and this sign-in; answers the cookie to set. */
    async bind(session: CodeSession, sessionCookie: string, state: string, back: string): Promise<string> {
      const binder = randomBytes(32).toString("base64url");
      await deps.store.putPending(connectStateKey(provider, binder), {
        verifier: "", returnTo: back, at: nowMs(),
        connect: { provider, kind: "state", session: sessionBinding(provider, sessionCookie), developerId: session.access.developerId, stateHash: sha256(state), back },
      });
      return cookie(binder, CONNECT_TTL_MS / 1000);
    },

    /**
     * The callback's check: the cookie's binding is taken (once, whatever happens next) and must be fresh, this provider's, this sign-in's and this person's,
     * and name exactly the state in the query (one value).
     */
    async take(query: URLSearchParams, cookieBinder: string | undefined, sessionCookie: string | undefined): Promise<Bound> {
      if (cookieBinder === undefined || !CONNECT_SECRET.test(cookieBinder)) return { ok: false, reason: "no_binding" };
      const kept = await deps.store.takePending(connectStateKey(provider, cookieBinder));
      const binding = kept?.connect;
      if (kept === undefined || binding === undefined || binding.provider !== provider || binding.kind !== "state" || nowMs() - kept.at > CONNECT_TTL_MS
        || connectBack(binding.back) === undefined) return { ok: false, reason: "no_binding" };
      const session = sessionCookie === undefined ? undefined : await deps.store.get(sessionCookie);
      if (session === undefined || sessionCookie === undefined || !sameDigest(binding.session, sessionBinding(provider, sessionCookie)) || session.access.developerId !== binding.developerId) {
        return { ok: false, reason: "session" };
      }
      const states = query.getAll("state");
      const state = states.length === 1 ? states[0]! : undefined;
      if (state === undefined || !CONNECT_SECRET.test(state) || binding.stateHash === undefined || !sameDigest(binding.stateHash, sha256(state))) return { ok: false, reason: "state" };
      return { ok: true, session, sessionCookie, back: binding.back, state };
    },

    /** Keeps an outcome for this sign-in (sealed, single use, ten minutes from `at`). */
    async keep(sessionCookie: string, developerId: string, back: string, result: Record<string, unknown>, at = nowMs()): Promise<void> {
      await deps.store.putPending(connectResultKey(provider, sessionCookie), {
        verifier: "", returnTo: back, at, connect: { provider, kind: "result", session: sessionBinding(provider, sessionCookie), developerId, back, result },
      });
    },

    /** Takes this sign-in's kept outcome, when it is this provider's, this sign-in's, this person's and fresh. */
    async takeResult(session: CodeSession, sessionCookie: string): Promise<{ result: Record<string, unknown>; at: number; back: string } | undefined> {
      const kept = await deps.store.takePending(connectResultKey(provider, sessionCookie));
      const found = kept?.connect;
      if (kept === undefined || found === undefined || found.provider !== provider || found.kind !== "result" || found.result === undefined
        || !sameDigest(found.session, sessionBinding(provider, sessionCookie)) || found.developerId !== session.access.developerId || nowMs() - kept.at > CONNECT_TTL_MS) return undefined;
      return { result: found.result, at: kept.at, back: found.back };
    },
  };
}

export type ConnectFlow = ReturnType<typeof createConnectFlow>;

/** One query value: undefined when absent, null when repeated. */
export function oneValue(query: URLSearchParams, name: string): string | undefined | null {
  const all = query.getAll(name);
  return all.length === 0 ? undefined : all.length === 1 ? all[0]! : null;
}

/** A Code refusal's `error.code` and `error.message`, when they are strings (for matching against fixed words only; never passed on). */
export function codeRefusal(body: unknown): { code?: string; message?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return {};
  const { code, message } = error as { code?: unknown; message?: unknown };
  return { ...(typeof code === "string" ? { code } : {}), ...(typeof message === "string" ? { message } : {}) };
}

/** A display name Code sent (a workspace, channel or team name): 1-200 characters, no control or format characters; undefined otherwise. */
export function displayName(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.length > 0 && Array.from(value).length <= max && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : undefined;
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// ---- Shared by the Slack and Linear routes ------------------------------------------------------------------------------------------------------------------

export interface ConnectAnswer { status: number; body: unknown; setCookie?: string }
export const connectRefusal = (status: number, code: string, message: string): ConnectAnswer => ({ status, body: { error: { code, message } } });
export const NOT_IN_COMPANY_WORDS = "You're not in a company yet.";
export const STEP_UP_WORDS = "Confirm it's you again, then try once more.";

/** The live company and role of the person (Code's access check, asked now), or undefined. */
export async function liveMembership(client: CodeClient, session: CodeSession): Promise<CompanyMembership | undefined> {
  return companyOf(await client.access(session));
}

/**
 * A disconnect's own check before Code is asked (Code checks both again): the person is an OWNER of their company now, and their sign-in carries a fresh step-up
 * (a passkey or an emailed code within the window; a Slack, Google or GitHub round trip never sets one).
 */
export async function ownerWithFreshStepUp(client: CodeClient, session: CodeSession, nowMs: number, ownerOnly: string): Promise<ConnectAnswer | undefined> {
  const membership = await liveMembership(client, session);
  if (membership === undefined) return connectRefusal(403, "NO_COMPANY", NOT_IN_COMPANY_WORDS);
  if (membership.companyRole !== "owner") return connectRefusal(403, "FORBIDDEN", ownerOnly);
  if (freshStepUp(session.accessToken, nowMs, STEP_UP_WINDOW_SECONDS) === undefined) return connectRefusal(403, "REAUTH_REQUIRED", STEP_UP_WORDS);
  return undefined;
}

/**
 * Code's call as the bound person at a callback. When another server refreshed this sign-in first, Code answered 401 before reading anything, so asking once more
 * as the stored sign-in (still the same person) is safe.
 */
export async function askAsBound(client: CodeClient, store: SessionStore, bound: { session: CodeSession; sessionCookie: string }, path: string, body: unknown): Promise<{ answer: unknown; session: CodeSession }> {
  try {
    return { answer: await client.json<unknown>(bound.session, path, { method: "POST", body }), session: bound.session };
  } catch (error) {
    if (!(error instanceof SignInEnded)) throw error;
    const stored = await store.get(bound.sessionCookie);
    if (stored === undefined || stored.refreshToken === bound.session.refreshToken || stored.access.developerId !== bound.session.access.developerId) throw error;
    return { answer: await client.json<unknown>(stored, path, { method: "POST", body }), session: stored };
  }
}

/** Code's project names (AGENTX_NAME_PATTERN). */
export const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
/** A start's body: `{}` or `{ back }` naming an app page (connectBack); undefined when it is anything else. */
export function startBody(body: unknown): { back: string } | undefined {
  if (body === undefined) return { back: CONNECT_DEFAULT_BACK };
  if (!isObject(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length === 0) return { back: CONNECT_DEFAULT_BACK };
  if (keys.length !== 1 || keys[0] !== "back") return undefined;
  const back = connectBack(body.back);
  return back === undefined ? undefined : { back };
}
