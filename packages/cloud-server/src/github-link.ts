// L4-GH: "Connect your GitHub" on a person's own profile, Cloud's half (briefs/lead4/L4-GH-SCOPE.md). A signed-in person links the GitHub account that is theirs to themselves, so hosted Rovara
// can place the author of a commit or a review as a member of the company. Rovara Code owns every rule (the person, the company, the single-use state, what GitHub proved,
// first link wins, one account per person); Cloud carries the browser through GitHub and shows Code's answers in its own fixed words. Cloud stores nothing about the link.
//
//   GET    /v1/app/me/github          Code's read as the person: { linked: false } or { linked: true, login, linkedAt }
//   POST   /v1/app/me/github/link     Code's start as the person, the cookie binding (the SAME cookie and callback as Connect GitHub: the pending row says
//                                     `flow: "link"`), and GitHub's authorize address: { authorizeUrl }
//   GET    /api/connect/github/callback   where GitHub sends the person back (the GitHub App's callback URL); github-connect.ts checks the binding and hands a LINK return to `finish`
//   DELETE /v1/app/me/github          Code's unlink as the person
//
// Rules: the browser names nothing (no person, no company, no account): Code reads them from the sign-in and the live membership, and the account is GitHub's own answer for the code. The state
// is bound to this browser (cookie) and this sign-in (hash) and is taken once whatever happens next. Code's words never pass through: a Code sentence is shown only as one of Cloud's own fixed
// ones, chosen by status and code. The landing URL carries one fixed word (`?github_link=<word>`); no query value is echoed into a page, a URL or a log.
import { randomBytes } from "node:crypto";
import { isCodeOutcomeUnknown, CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import { codeRefusal, isObject, sha256, type ConnectAnswer, connectRefusal } from "./connect-flow.js";
import { GITHUB_CONNECT_TTL_MS, GITHUB_LINK_LANDING, githubConnectCookie, githubStateKey, sessionBinding } from "./github-connect.js";
import type { CodeSession, SessionStore } from "./sessions.js";

export { GITHUB_LINK_LANDING };
/** The one word the landing carries. */
export const GITHUB_LINK_OUTCOMES = ["linked", "cancelled", "start_again", "taken", "exists", "not_available", "unavailable"] as const;
export type GithubLinkOutcome = (typeof GITHUB_LINK_OUTCOMES)[number];
const CODE_LINK = "/v1/dev/me/github";

/** Code's fixed sentences (Code's github-account-link-routes.ts), and Cloud's own. Cloud shows only these. */
export const GITHUB_LINK_WORDS = Object.freeze({
  startAgain: "Start again from Rovara.",
  taken: "This GitHub account is already connected to another member of your company.",
  exists: "You already have a GitHub account connected. Disconnect it first.",
  notSetUp: "Connecting your GitHub account isn't set up on this Rovara yet. Ask the Rovara team.",
  notAvailable: "Connecting your GitHub account isn't available yet.",
  unavailable: "Your GitHub account could not be connected just now. Start again from Rovara.",
  readUnavailable: "Your GitHub connection could not be read just now; try again.",
  unlinkUnavailable: "Your GitHub account could not be disconnected just now; try again.",
  noDetails: "Connecting your GitHub account takes no details.",
  signedOut: "Sign in to continue.",
});

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const CLIENT_ID = /^[A-Za-z0-9.]{1,64}$/u;
const GITHUB_ID_MAX = Number.MAX_SAFE_INTEGER;
const NO_CODE_YET = (status: number) => status === 404 || status === 405 || status === 501;

export interface GithubLinkDeps {
  client: CodeClient;
  store: SessionStore;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
  secureCookies: boolean;
}

/** GitHub's authorize address from Code, checked: https github.com, exactly `client_id` and Code's own `state`, nothing else. Undefined when anything does not read. */
function authorizeUrlOf(body: unknown): { state: string; authorizeUrl: string } | undefined {
  if (!isObject(body) || typeof body.state !== "string" || !SECRET.test(body.state) || typeof body.authorizeUrl !== "string" || body.authorizeUrl.length > 2048) return undefined;
  try {
    const url = new URL(body.authorizeUrl);
    const query = [...url.searchParams];
    if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    if (query.length !== 2 || url.searchParams.get("state") !== body.state || !CLIENT_ID.test(url.searchParams.get("client_id") ?? "")) return undefined;
    return { state: body.state, authorizeUrl: `${url.origin}${url.pathname}?${url.searchParams.toString()}` };
  } catch {
    return undefined;
  }
}

export function createGithubLink(deps: GithubLinkDeps) {
  const nowMs = () => deps.now().getTime();
  const landing = (word: GithubLinkOutcome) => `${GITHUB_LINK_LANDING}?github_link=${word}`;
  const unreadable = (session: CodeSession, what: string, words: string = GITHUB_LINK_WORDS.unavailable) => {
    deps.log({ event: "cloud.github_link_unreadable", what, developerId: session.access.developerId });
    return connectRefusal(503, "RUNTIME_UNAVAILABLE", words);
  };

  /** Code's refusal in Cloud's fixed words, by status and code. */
  function refusalOf(error: CodeError, operation: "read" | "start" | "unlink"): ConnectAnswer {
    if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
    const { message } = codeRefusal(error.body);
    if (error.status === 401) return connectRefusal(401, "AUTH_REQUIRED", GITHUB_LINK_WORDS.signedOut);
    if (error.status === 403) return connectRefusal(403, "FORBIDDEN", GITHUB_LINK_WORDS.startAgain);
    if (NO_CODE_YET(error.status)) return connectRefusal(501, "NOT_ON_CODE_YET", GITHUB_LINK_WORDS.notAvailable);
    if (error.status === 503 && operation === "start" && message === GITHUB_LINK_WORDS.notSetUp) return connectRefusal(503, "RUNTIME_UNAVAILABLE", GITHUB_LINK_WORDS.notSetUp);
    return connectRefusal(503, "RUNTIME_UNAVAILABLE", operation === "read" ? GITHUB_LINK_WORDS.readUnavailable : operation === "unlink" ? GITHUB_LINK_WORDS.unlinkUnavailable : GITHUB_LINK_WORDS.unavailable);
  }

  async function ask(session: CodeSession, operation: "read" | "start" | "unlink", init: { method: string; body?: unknown }, path = CODE_LINK): Promise<{ ok: true; answer: unknown } | { ok: false; refusal: ConnectAnswer }> {
    try {
      return { ok: true, answer: await deps.client.json<unknown>(session, path, init) };
    } catch (error) {
      if (!(error instanceof CodeError)) throw error;
      return { ok: false, refusal: refusalOf(error, operation) };
    }
  }

  const routes = {
    /** GET /v1/app/me/github */
    async read(session: CodeSession): Promise<ConnectAnswer> {
      const asked = await ask(session, "read", { method: "GET" });
      if (!asked.ok) return asked.refusal;
      const answer = asked.answer;
      if (isObject(answer) && answer.linked === false) return { status: 200, body: { linked: false } };
      if (isObject(answer) && answer.linked === true && typeof answer.login === "string" && LOGIN.test(answer.login)) {
        const at = answer.linkedAt;
        return { status: 200, body: { linked: true, login: answer.login, ...(typeof at === "string" && at.length <= 40 && Number.isFinite(Date.parse(at)) ? { linkedAt: at } : {}) } };
      }
      return unreadable(session, "read", GITHUB_LINK_WORDS.readUnavailable);
    },

    /** POST /v1/app/me/github/link: Code's start as the person, the cookie binding for the link flow, and GitHub's authorize address. */
    async start(session: CodeSession, sessionCookie: string, body: unknown): Promise<ConnectAnswer> {
      // The browser sends nothing: no company, no person, no account, no return address.
      if (body !== undefined && !(isObject(body) && Object.keys(body).length === 0)) return connectRefusal(400, "CONFIG_INVALID", GITHUB_LINK_WORDS.noDetails);
      const asked = await ask(session, "start", { method: "POST", body: {} }, `${CODE_LINK}/link`);
      if (!asked.ok) return asked.refusal;
      const checked = authorizeUrlOf(asked.answer);
      if (checked === undefined) return unreadable(session, "start");
      const binder = randomBytes(32).toString("base64url");
      await deps.store.putPending(githubStateKey(binder), {
        verifier: "", returnTo: GITHUB_LINK_LANDING, at: nowMs(),
        github: { kind: "state", flow: "link", session: sessionBinding(sessionCookie), developerId: session.access.developerId, stateHash: sha256(checked.state) },
      });
      deps.log({ event: "cloud.github_link_started", developerId: session.access.developerId });
      return { status: 200, body: { authorizeUrl: checked.authorizeUrl }, setCookie: githubConnectCookie(binder, GITHUB_CONNECT_TTL_MS / 1000, deps.secureCookies) };
    },

    /** DELETE /v1/app/me/github */
    async unlink(session: CodeSession, body: unknown): Promise<ConnectAnswer> {
      if (body !== undefined && !(isObject(body) && Object.keys(body).length === 0)) return connectRefusal(400, "CONFIG_INVALID", GITHUB_LINK_WORDS.noDetails);
      const asked = await ask(session, "unlink", { method: "DELETE" });
      if (!asked.ok) return asked.refusal;
      if (!isObject(asked.answer) || typeof asked.answer.unlinked !== "boolean") return unreadable(session, "unlink", GITHUB_LINK_WORDS.unlinkUnavailable);
      deps.log({ event: "cloud.github_unlinked", developerId: session.access.developerId });
      return { status: 200, body: { unlinked: asked.answer.unlinked } };
    },
  };

  return {
    /**
     * GitHub's return of a LINK flow (github-connect.ts has already taken the cookie binding once, checked it is fresh, this sign-in's and this person's, and that the state's hash matches).
     * Code's claim is asked as the person, with the state and the code only; where the person lands is always the profile page with one fixed word.
     */
    async finish(session: CodeSession, sessionCookie: string, query: { state: string; code: string | undefined; extra: boolean }): Promise<{ location: string }> {
      const refuse = (reason: string, word: GithubLinkOutcome = "start_again") => {
        deps.log({ event: "cloud.github_link_refused", reason, developerId: session.access.developerId });
        return { location: landing(word) };
      };
      // GitHub sends no code when the person cancels; a return that also carries install fields is not a link return.
      if (query.extra) return refuse("query");
      if (query.code === undefined) return refuse("no_code", "cancelled");
      const claim = { state: query.state, code: query.code };
      let current = session;
      try {
        let answer: unknown;
        try {
          answer = await deps.client.json<unknown>(current, `${CODE_LINK}/link/claim`, { method: "POST", body: claim });
        } catch (error) {
          // Another server refreshed this sign-in first: Code answered 401 before reading the state, so asking once more as the stored sign-in is safe.
          if (!(error instanceof SignInEnded)) throw error;
          const stored = await deps.store.get(sessionCookie);
          if (stored === undefined || stored.refreshToken === current.refreshToken || stored.access.developerId !== session.access.developerId) throw error;
          current = stored;
          answer = await deps.client.json<unknown>(current, `${CODE_LINK}/link/claim`, { method: "POST", body: claim });
        }
        const user = isObject(answer) && isObject(answer.githubUser) ? answer.githubUser : undefined;
        if (!isObject(answer) || answer.status !== "linked" || user === undefined || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0 || user.id > GITHUB_ID_MAX
          || typeof user.login !== "string" || !LOGIN.test(user.login)) return refuse("claim_unreadable", "unavailable");
        if (current.changed === true) {
          delete current.changed;
          await deps.store.save(sessionCookie, current);
        }
        deps.log({ event: "cloud.github_linked", developerId: session.access.developerId, alreadyLinked: answer.alreadyLinked === true });
        return { location: landing("linked") };
      } catch (error) {
        if (error instanceof SignInEnded) {
          await deps.store.delete(sessionCookie);
          return refuse("signed_out");
        }
        if (isCodeOutcomeUnknown(error)) throw error;
        if (!(error instanceof CodeError)) throw error;
        const { code } = codeRefusal(error.body);
        deps.log({ event: "cloud.github_link_claim_refused", developerId: session.access.developerId, status: error.status });
        if (error.status === 403) return { location: landing("start_again") };
        if (error.status === 409) return { location: landing(code === "GITHUB_ACCOUNT_LINK_EXISTS" ? "exists" : code === "GITHUB_ACCOUNT_TAKEN" ? "taken" : "unavailable") };
        if (NO_CODE_YET(error.status)) return { location: landing("not_available") };
        return { location: landing("unavailable") };
      }
    },

    /** The app routes this module answers (paths after /v1/web), or undefined. */
    route(method: string, apiPath: string): ((session: CodeSession, sessionCookie: string, body: unknown) => Promise<ConnectAnswer>) | undefined {
      if (apiPath === "/me/github" && method === "GET") return (session) => routes.read(session);
      if (apiPath === "/me/github" && method === "DELETE") return (session, _id, body) => routes.unlink(session, body);
      if (apiPath === "/me/github/link" && method === "POST") return (session, id, body) => routes.start(session, id, body);
      return undefined;
    },
  };
}

export type GithubLink = ReturnType<typeof createGithubLink>;
