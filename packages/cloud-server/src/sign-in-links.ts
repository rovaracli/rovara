// DEC 254w: "Connected sign-ins", Cloud's half. A signed-in person connects a second sign-in method (Slack or GitHub) to their own person record, and
// removes a connected one. Rovara Code owns every rule (the person, the company, the step-up, the single-use link, what the provider proved); Cloud carries
// the browser through the provider and shows Code's answers in its own fixed words.
//
//   GET    /v1/app/me/sign-ins                   Code's list as the person: { signIns: [{ method, primary, linkedAt? }], linkable }
//   POST   /v1/app/me/sign-ins/link   { method } Cloud's server makes the PKCE verifier and the state, asks Code to start, keeps the pending link in THIS
//                                                browser's sign-in, and answers { authorizeUrl } (the provider's page; the browser never sees verifier or state)
//   GET    <the registered sign-in callback>     the provider's return, through Code, carrying `state` and `link_id`+`link_code` or `link_error`: a LINK
//                                                return, never a sign-in (handler.ts asks `isReturn` first). Goes on only for the browser that started it
//   DELETE /v1/app/me/sign-ins/{method}          Code's unlink (fresh step-up); Code then ends every sign-in of the person
//
// Rules: the pending link is keyed by a hash of THIS sign-in's cookie, so only the browser that started a link can finish it (the account-takeover guard);
// it is taken (deleted) before anything else is checked, so it works once whatever happens next; the state in the return must equal the stored one
// (constant-time) and the link id must equal Code's; `link_error` never reaches Code's finish; Code's words never pass through (a Code sentence is shown
// only when it is exactly one of Code's own fixed ones). Admin routes (GET/DELETE /v1/dev/company/members/{personId}/sign-ins[/{method}]) are Code's and
// not used here yet.
import { createHash, randomBytes } from "node:crypto";
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import { codeRefusal, isObject, oneValue, sameDigest, sha256, type ConnectAnswer, connectRefusal } from "./connect-flow.js";
import { sessionKey, type CodeSession, type SessionStore } from "./sessions.js";

/** The methods Cloud offers to connect (Code's LINKABLE_SIGN_IN_METHODS). */
export const LINK_METHODS = ["slack", "github"] as const;
export type LinkMethod = (typeof LINK_METHODS)[number];
/** How long a started link may take (Code keeps it for 300 seconds as well). */
export const LINK_TTL_MS = 5 * 60_000;
/** Where a link return lands: the account page, with one fixed word. */
export const LINK_LANDING = "/app/account";
export const LINK_FAILURES = ["cancelled", "refused", "failed"] as const;
export type LinkFailure = (typeof LINK_FAILURES)[number];

const CODE_SIGN_INS = "/v1/dev/me/sign-ins";

/** Code's fixed refusal sentences (packages/contracts/src/sign-in-links.ts SIGN_IN_LINK_TEXT), and Cloud's own. */
export const SIGN_IN_LINK_WORDS = Object.freeze({
  refused: "That sign-in can't be connected to your account.",
  forbidden: "Only the person or a company owner or admin can change this person's sign-ins.",
  lastMethod: "This is the first way this person signs in, so it can't be removed.",
  notConnected: "That sign-in is not connected.",
  reauth: "Confirm it's you first: connecting or removing a sign-in needs a confirmation from the last few minutes.",
  notOnCode: "Connected sign-ins aren't connected to Rovara Code yet.",
  unavailable: "Connected sign-ins could not be reached just now. Try again in a moment.",
  invalid: "That sign-in can't be connected here.",
  signedOut: "Sign in to continue.",
});

/** A pending link kept in the browser's sign-in (inside PendingSignIn): hashes and ids only, plus the verifier (sealed where the store seals). */
export interface LinkPending {
  method: LinkMethod;
  developerId: string;
  /** sha256 of the state the browser's return must carry. */
  stateHash: string;
  /** Code's id of the started link: the return's `link_id` must equal it. */
  linkId: string;
}

const STATE = /^[A-Za-z0-9_-]{16,128}$/u;
const LINK_ID = /^lnk_[A-Za-z0-9_-]{43}$/u;
const LINK_CODE = /^lnc_[A-Za-z0-9_-]{43}$/u;
const METHOD_WORD = /^[a-z][a-z0-9_-]{0,31}$/u;
const SIGN_INS_MAX = 20;
/** Where each method's provider page is served: Code's start answers one of these, or Cloud sends the browser nowhere. */
const PROVIDER_HOST: Record<LinkMethod, string> = { slack: "slack.com", github: "github.com" };

/** The pending link's key: derived from this sign-in's cookie, so only the same browser sign-in finds it. */
export const linkPendingKey = (sessionCookie: string) => `link.${sha256(`rovara-sign-in-link:${sessionKey(sessionCookie)}`)}`;

const isLinkMethod = (value: unknown): value is LinkMethod => typeof value === "string" && (LINK_METHODS as readonly string[]).includes(value);

/** Code's provider address, checked: https, the method's own host, no credentials, port or fragment. Undefined otherwise. */
function providerUrl(method: LinkMethod, value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== PROVIDER_HOST[method] || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Code's list, rebuilt field by field. Undefined when anything does not read. */
function listOf(body: unknown): Array<{ method: string; primary: boolean; linkedAt?: string }> | undefined {
  if (!isObject(body) || !Array.isArray(body.signIns) || body.signIns.length > SIGN_INS_MAX) return undefined;
  const rows: Array<{ method: string; primary: boolean; linkedAt?: string }> = [];
  for (const row of body.signIns as unknown[]) {
    if (!isObject(row) || typeof row.method !== "string" || !METHOD_WORD.test(row.method) || typeof row.primary !== "boolean") return undefined;
    const at = row.linkedAt;
    if (at !== undefined && (typeof at !== "string" || at.length > 40 || !Number.isFinite(Date.parse(at)))) return undefined;
    rows.push({ method: row.method, primary: row.primary, ...(typeof at === "string" ? { linkedAt: at } : {}) });
  }
  return rows;
}

export interface SignInLinksDeps {
  client: CodeClient;
  store: SessionStore;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
}

type Operation = "list" | "start" | "unlink";

/** Code's refusal in Cloud's fixed words, by status and code (a Code sentence only when it is exactly one of Code's own). */
function refusalOf(error: CodeError, operation: Operation): ConnectAnswer {
  const { code, message } = codeRefusal(error.body);
  if (error.status === 401) return connectRefusal(401, "AUTH_REQUIRED", SIGN_IN_LINK_WORDS.signedOut);
  if (error.status === 403) {
    if (code === "REAUTH_REQUIRED") return connectRefusal(403, "REAUTH_REQUIRED", SIGN_IN_LINK_WORDS.reauth);
    const known = [SIGN_IN_LINK_WORDS.refused, SIGN_IN_LINK_WORDS.forbidden, SIGN_IN_LINK_WORDS.lastMethod].find((words) => words === message);
    return connectRefusal(403, "FORBIDDEN", known ?? (operation === "start" ? SIGN_IN_LINK_WORDS.refused : SIGN_IN_LINK_WORDS.forbidden));
  }
  if (error.status === 404 || error.status === 405 || error.status === 501) {
    // "Not connected" is Code's own sentence for a method the person doesn't have; any other 404 (no such route, not set up here) means Code doesn't serve this.
    if (operation === "unlink" && code === "NOT_FOUND" && message === SIGN_IN_LINK_WORDS.notConnected) return connectRefusal(404, "SIGN_IN_NOT_CONNECTED", SIGN_IN_LINK_WORDS.notConnected);
    return connectRefusal(501, "NOT_ON_CODE_YET", SIGN_IN_LINK_WORDS.notOnCode);
  }
  return connectRefusal(503, "RUNTIME_UNAVAILABLE", SIGN_IN_LINK_WORDS.unavailable);
}

export function createSignInLinks(deps: SignInLinksDeps) {
  const nowMs = () => deps.now().getTime();
  const unreadable = (session: CodeSession, what: string) => {
    deps.log({ event: "cloud.sign_in_links_unreadable", what, developerId: session.access.developerId });
    return connectRefusal(503, "RUNTIME_UNAVAILABLE", SIGN_IN_LINK_WORDS.unavailable);
  };
  const landing = (query: string) => `${LINK_LANDING}?${query}`;

  /** Code's call as the signed-in person; its refusal becomes Cloud's fixed words. */
  async function ask(session: CodeSession, operation: Operation, path: string, init: { method: string; body?: unknown }): Promise<{ ok: true; answer: unknown } | { ok: false; refusal: ConnectAnswer }> {
    try {
      return { ok: true, answer: await deps.client.json<unknown>(session, path, init) };
    } catch (error) {
      if (!(error instanceof CodeError)) throw error;
      return { ok: false, refusal: refusalOf(error, operation) };
    }
  }

  const routes = {
    /** GET /v1/app/me/sign-ins */
    async list(session: CodeSession): Promise<ConnectAnswer> {
      const asked = await ask(session, "list", CODE_SIGN_INS, { method: "GET" });
      if (!asked.ok) return asked.refusal;
      const signIns = listOf(asked.answer);
      if (signIns === undefined) return unreadable(session, "list");
      return { status: 200, body: { signIns, linkable: [...LINK_METHODS] } };
    },

    /** POST /v1/app/me/sign-ins/link { method }: the PKCE pair and the state are made here, kept for this browser's sign-in, and never sent to the browser. */
    async start(session: CodeSession, sessionCookie: string, body: unknown): Promise<ConnectAnswer> {
      if (!isObject(body) || Object.keys(body).length !== 1 || !isLinkMethod(body.method)) return connectRefusal(400, "CONFIG_INVALID", SIGN_IN_LINK_WORDS.invalid);
      const method = body.method;
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      const asked = await ask(session, "start", `${CODE_SIGN_INS}/link`, {
        method: "POST",
        body: { method, challenge: createHash("sha256").update(verifier).digest("base64url"), returnTo: deps.client.redirectUri, state },
      });
      if (!asked.ok) return asked.refusal;
      const answer = asked.answer;
      const authorizeUrl = isObject(answer) ? providerUrl(method, answer.authorizeUrl) : undefined;
      const linkId = isObject(answer) && typeof answer.linkId === "string" && LINK_ID.test(answer.linkId) ? answer.linkId : undefined;
      if (authorizeUrl === undefined || linkId === undefined) return unreadable(session, "start");
      await deps.store.putPending(linkPendingKey(sessionCookie), {
        verifier, returnTo: LINK_LANDING, at: nowMs(), link: { method, developerId: session.access.developerId, stateHash: sha256(state), linkId },
      });
      deps.log({ event: "cloud.sign_in_link_started", developerId: session.access.developerId, method });
      return { status: 200, body: { authorizeUrl } };
    },

    /** DELETE /v1/app/me/sign-ins/{method}: Code checks the step-up and the first-method rule, then ends every sign-in of the person. */
    async unlink(session: CodeSession, method: string): Promise<ConnectAnswer> {
      if (!isLinkMethod(method)) return connectRefusal(404, "SIGN_IN_NOT_CONNECTED", SIGN_IN_LINK_WORDS.notConnected);
      const asked = await ask(session, "unlink", `${CODE_SIGN_INS}/${method}`, { method: "DELETE" });
      if (!asked.ok) return asked.refusal;
      if (!isObject(asked.answer) || asked.answer.removed !== true) return unreadable(session, "unlink");
      deps.log({ event: "cloud.sign_in_unlinked", developerId: session.access.developerId, method });
      return { status: 200, body: { removed: true } };
    },
  };

  return {
    /** True when a callback request is a link return (it carries any `link_*` word), so it is never read as a sign-in. */
    isReturn(query: URLSearchParams): boolean {
      return query.has("link_id") || query.has("link_code") || query.has("link_error");
    },

    /**
     * The provider's return through Code. Where it lands is always the account page with one fixed word. Code's finish is asked only when: this browser's sign-in
     * has a pending link (taken now, so it is used once whatever happens next), it is fresh and the same person's, the return's `state` and `link_id` are the
     * stored ones, and the return carries `link_id` + `link_code` and no `link_error`.
     */
    async callback(query: URLSearchParams, sessionCookie: string | undefined): Promise<{ location: string }> {
      const refuse = (reason: string, word: LinkFailure = "failed") => {
        deps.log({ event: "cloud.sign_in_link_refused", reason });
        return { location: landing(`link=${word}`) };
      };
      if (sessionCookie === undefined) return refuse("no_session");
      const kept = await deps.store.takePending(linkPendingKey(sessionCookie));
      const link = kept?.link;
      if (kept === undefined || link === undefined || !isLinkMethod(link.method) || nowMs() - kept.at > LINK_TTL_MS || nowMs() < kept.at) return refuse("no_pending");
      const session = await deps.store.get(sessionCookie);
      if (session === undefined || session.access.developerId !== link.developerId) return refuse("session");
      const states = query.getAll("state");
      const state = states.length === 1 ? states[0]! : undefined;
      if (state === undefined || !STATE.test(state) || !sameDigest(link.stateHash, sha256(state))) return refuse("state");
      const error = oneValue(query, "link_error"), id = oneValue(query, "link_id"), code = oneValue(query, "link_code");
      if (error === null || id === null || code === null) return refuse("query");
      if (error !== undefined) {
        // A cancelled, refused or failed link: one fixed word, and Code's finish is never asked.
        if (id !== undefined || code !== undefined) return refuse("query");
        return refuse("link_error", (LINK_FAILURES as readonly string[]).includes(error) ? error as LinkFailure : "failed");
      }
      if (id === undefined || code === undefined || !LINK_ID.test(id) || !LINK_CODE.test(code) || id !== link.linkId) return refuse("link_id");
      const finish = (who: CodeSession) => deps.client.json<unknown>(who, `${CODE_SIGN_INS}/link/finish`, { method: "POST", body: { linkId: id, linkCode: code, verifier: kept.verifier } });
      try {
        let answer: unknown;
        try {
          answer = await finish(session);
        } catch (failure) {
          // Another server refreshed this sign-in first (its refresh token worked once): Code answered 401 before reading anything, so one more try on what the store holds is safe.
          if (!(failure instanceof SignInEnded)) throw failure;
          const stored = await deps.store.get(sessionCookie);
          if (stored === undefined || stored.refreshToken === session.refreshToken || stored.access.developerId !== link.developerId) throw failure;
          answer = await finish(stored);
        }
        if (!isObject(answer) || answer.method !== link.method) return refuse("finish_unreadable");
        deps.log({ event: "cloud.sign_in_linked", developerId: link.developerId, method: link.method });
        return { location: landing(`linked=${link.method}`) };
      } catch (failure) {
        if (failure instanceof SignInEnded) {
          await deps.store.delete(sessionCookie);
          return refuse("signed_out");
        }
        if (failure instanceof CodeError) return refuse(`code_${String(failure.status)}`, failure.status === 403 ? "refused" : "failed");
        throw failure;
      }
    },

    /** The app routes this module answers (paths after /v1/web), or undefined. */
    route(method: string, apiPath: string): ((session: CodeSession, sessionCookie: string, body: unknown) => Promise<ConnectAnswer>) | undefined {
      if (method === "GET" && apiPath === "/me/sign-ins") return (session) => routes.list(session);
      if (method === "POST" && apiPath === "/me/sign-ins/link") return (session, id, body) => routes.start(session, id, body);
      const match = /^\/me\/sign-ins\/([A-Za-z0-9_-]{1,32})$/u.exec(apiPath);
      if (method === "DELETE" && match !== null) return (session) => routes.unlink(session, match[1]!);
      return undefined;
    },
  };
}

export type SignInLinks = ReturnType<typeof createSignInLinks>;
