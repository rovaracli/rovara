// Guided onboarding PR 2 (designs-2026-10-30/guided-onboarding-design.md sections 3 and 3a; DEC 254j, 254l item 3): the "Connect GitHub" button's
// server side. Rovara Code (PR #830) owns the state, the GitHub user check and the binding; Cloud only carries the person through it, bound to
// their browser and their Cloud sign-in.
//
//   POST /v1/app/github/connect          (browser: /v1/web/github/connect)  Code's connect as the person; the GitHub address to go to
//   GET  /api/connect/github/callback                                       where GitHub sends the person back (the GitHub App's callback URL)
//   POST /v1/app/github/connect/result   (browser: /v1/web/…)               the callback's outcome, kept server-side for this sign-in
//   POST /v1/app/github/choose           (browser: /v1/web/…)               bind one installation from the outcome's list (Code's choose)
//   GET  /v1/app/github/connections      (browser: /v1/web/…)               the company's connected GitHub accounts (Code's read, any member), with
//                                                                            #832's health (`status` active/suspended/uninstalled, `accountType`)
//   DELETE /v1/app/github/connections/{installationId}                     guided onboarding PR 12b: disconnect (Code #832 DELETE /v1/dev/company/github/{id}).
//                                                                            A company OWNER, checked here first and by Code again;
//                                                                            refused while projects use its repos (Code names them; Cloud rebuilds the sentence)
//
// Rules:
//   - The browser never names a company: Cloud sends Code `{}` at connect and only GitHub's own values at the claim, always with the person's own
//     token. Code reads the company and role live at every call.
//   - The cookie binding: connect sets `rovara_cloud_github` (HttpOnly, Secure, SameSite=Lax, Path=/api/connect/github, ten minutes) to 32 random
//     bytes of its own (the "binder"). Cloud stores only HASHES, in its sealed, single-use pending store (sessions.ts; PENDING# rows): the row is
//     keyed by sha256 of the binder and holds sha256 of Code's state and sha256 of this sign-in's cookie key, and the person's id. No HMAC key.
//     The callback takes that row (once, whatever happens next), and goes on only when the state's hash and the sign-in's hash match
//     (constant-time) and the person is the same; it always clears the cookie.
//   - The outcome and a choose ticket stay server-side, sealed, under a key derived from this sign-in's cookie; never in a URL or a log. The
//     landing URL carries only one fixed word (GITHUB_OUTCOMES). No query value is echoed into a page, a URL or a log.
//   - Refusals are Code's fixed sentences (GITHUB_WORDS), matched by status, never Code's or GitHub's text passed through.
//   - The one-trial-per-GitHub-account rule (`github=trial_used`) is applied on every connected answer with Code's checked githubUser.id
//     (company-store.ts unlockTrial, L2-8): the company's trial is unlocked and the GitHub account claimed in one write, so two companies
//     racing for one GitHub account cannot both get a trial. The company that loses is still connected (Code bound the installation as the
//     person before Cloud is told), is told only the fixed flag `trialUsed`, and gets no trial.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import { companyOf } from "./company-caller.js";
import { PROJECT_NAME, codeRefusal, companyOwnerOnly } from "./connect-flow.js";
import { validGithubUserId, type CompanyStore } from "./company-store.js";
import { sessionKey, type CodeSession, type SessionStore } from "./sessions.js";

export const GITHUB_CALLBACK_PATH = "/api/connect/github/callback";
export const GITHUB_CONNECT_COOKIE = "rovara_cloud_github";
const COOKIE_PATH = "/api/connect/github";
/** The Set-Cookie value of the connect cookie (shared with the person's own GitHub link, github-link.ts: one cookie, one callback). */
export const githubConnectCookie = (value: string, maxAge: number, secure: boolean) => `${GITHUB_CONNECT_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}${secure ? "; Secure" : ""}; Max-Age=${String(maxAge)}`;
export const GITHUB_CONNECT_TTL_MS = 10 * 60_000;
const CODE_GITHUB = "/v1/dev/company/github";
const LANDING = "/app/onboard";
/** L4-GH: where a return of the person's own GitHub link lands (github-link.ts): the profile page. */
export const GITHUB_LINK_LANDING = "/app/account";

/** Code's fixed sentences (Code PR #830 github-connect-routes.ts), and Cloud's own for a Code without the routes. */
export const GITHUB_WORDS = Object.freeze({
  adminOnly: "Only a company owner or admin can connect GitHub.",
  notSetUp: "Connecting GitHub isn't set up on this Rovara yet. Ask the Rovara team.",
  notAvailable: "Connecting GitHub isn't available yet.",
  startAgain: "Start again from Rovara.",
  taken: "This GitHub account is already connected to a different Rovara company.",
  unavailable: "GitHub could not be connected just now. Start again from Rovara.",
  connectionsUnavailable: "The company's GitHub connections could not be read just now; try again.",
  noDetails: "Connecting GitHub takes no details.",
  chooseListed: "Choose one of the GitHub accounts listed.",
  // Guided onboarding PR 12b (Code #832's disconnect).
  ownerOnly: "Only a company owner can disconnect GitHub.",
  notConnected: "That GitHub account isn't connected to your company.",
  disconnectUnavailable: "GitHub could not be disconnected just now; try again.",
  inUseUnreadable: "Projects still use this GitHub connection. Remove its repositories from them first.",
});
/** Code's in-use refusal names the company's own projects; Cloud rebuilds it from the names it can read, else says it without them. */
export const githubInUseWords = (projects: readonly string[]) => `Projects still use this GitHub connection: ${projects.join(", ")}. Remove its repositories from them first.`;
const IN_USE = /^Projects still use this GitHub connection: ([a-z0-9, -]{1,4000})\. Remove its repositories from them first\.$/u;
/** GitHub's own uninstall page for an installation (Code's githubUninstallUrl): an https github.com settings address and nothing else. */
const UNINSTALL_URL = /^https:\/\/github\.com\/(?:settings\/installations\/[1-9][0-9]{0,15}|organizations\/[A-Za-z0-9-]{1,39}\/settings\/installations\/[1-9][0-9]{0,15})$/u;
const INSTALLATION_IN_PATH = /^[1-9][0-9]{0,15}$/u;

/** The one word the callback's landing URL carries: the outcome is kept server-side ("result"), or one of Code's refusals. */
export const GITHUB_OUTCOMES = ["result", "start_again", "taken", "unavailable", "not_available"] as const;
type Outcome = (typeof GITHUB_OUTCOMES)[number];

type AccountType = "User" | "Organization";
type Connection = "this_company" | "another_company" | "unbound";
interface Choice { installationId: number; accountLogin: string; accountType: AccountType; suspended: boolean; connection: Connection }

/** The callback's outcome as Cloud keeps it (sealed, server-side). Only `choose` holds a secret (Code's ticket), never sent to the browser. */
export type GithubResult =
  | { status: "connected"; alreadyConnected: boolean; accountLogin: string; accountType: AccountType; trialUsed?: true }
  | { status: "choose"; ticket: string; githubLogin: string; installations: Choice[] }
  | { status: "requested"; adminUrl?: string };

/** A pending-store row of a GitHub connect: the cookie binding ("state") or the callback's outcome ("result"). Hashes and ids only. */
export interface GithubPending {
  kind: "state" | "result";
  /** L4-GH: kind state only. `link`: the person's own GitHub account link (github-link.ts), whose return the callback hands to that module; absent: the company connect. */
  flow?: "link";
  /** sha256 of this sign-in's cookie key (sessionBinding). */
  session: string;
  developerId: string;
  /** kind state: sha256 of Code's state. */
  stateHash?: string;
  /** kind state: the App's install page with no state, for the "ask your GitHub admin" link. */
  adminUrl?: string;
  /** kind result. */
  result?: GithubResult;
}

const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SLUG = /^[a-z0-9-]{1,100}$/u;
const CLIENT_ID = /^[A-Za-z0-9.]{1,64}$/u;
const GITHUB_CODE = /^[A-Za-z0-9_-]{1,128}$/u;
const INSTALLATION_ID = /^[1-9][0-9]{0,15}$/u;
const SETUP_ACTIONS = ["install", "update", "request"] as const;
const CHOICES_MAX = 100;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Equal-length hex digests compared in constant time. */
function sameDigest(a: string | undefined, b: string): boolean {
  if (typeof a !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
/** The pending-store key of a cookie binder: a hash, so the stored key can't be turned back into the cookie. */
export const githubStateKey = (binder: string) => `github.state.${sha256(`rovara-github-connect-binder:${binder}`)}`;
/** The pending-store key of this sign-in's outcome: derived from the sign-in's cookie, so only that browser's sign-in reads it. */
export const githubResultKey = (sessionCookie: string) => `github.result.${sha256(`rovara-github-connect-result:${sessionKey(sessionCookie)}`)}`;
export const sessionBinding = (sessionCookie: string) => sha256(`rovara-github-connect-session:${sessionKey(sessionCookie)}`);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const installationId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const accountType = (value: unknown): value is AccountType => value === "User" || value === "Organization";
const login = (value: unknown): value is string => typeof value === "string" && LOGIN.test(value);

export interface GithubConnectDeps {
  client: CodeClient;
  store: SessionStore;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
  /** Cloud's company data, for the trial rule. Absent: no trial is recorded (this Cloud has no company data). */
  companies?: CompanyStore;
  secureCookies: boolean;
  /** L4-GH: the person's own GitHub link (github-link.ts). Absent: a link return is refused (the install flow is unchanged). */
  link?: { finish(session: CodeSession, sessionCookie: string, query: { state: string; code: string | undefined; extra: boolean }): Promise<{ location: string }> };
}

export interface GithubAnswer { status: number; body: unknown; setCookie?: string }
const refusal = (status: number, code: string, message: string): GithubAnswer => ({ status, body: { error: { code, message } } });

/** Code's answer to connect, checked: both GitHub addresses carry exactly Code's state, nothing else. Undefined when anything doesn't read. */
function connectAnswer(body: unknown): { state: string; installUrl: string; authorizeUrl: string; adminUrl: string; expiresAt: string } | undefined {
  if (!isObject(body)) return undefined;
  const { state, installUrl, authorizeUrl, expiresAt } = body;
  if (typeof state !== "string" || !SECRET.test(state) || typeof installUrl !== "string" || typeof authorizeUrl !== "string" || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  try {
    const install = new URL(installUrl), authorize = new URL(authorizeUrl);
    for (const url of [install, authorize]) {
      if (url.origin !== "https://github.com" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    }
    const slug = /^\/apps\/([^/]+)\/installations\/new$/u.exec(install.pathname)?.[1];
    const installQuery = [...install.searchParams], authorizeQuery = [...authorize.searchParams];
    if (slug === undefined || !SLUG.test(slug) || installQuery.length !== 1 || installQuery[0]![0] !== "state" || installQuery[0]![1] !== state) return undefined;
    if (authorize.pathname !== "/login/oauth/authorize" || authorizeQuery.length !== 2 || authorize.searchParams.get("state") !== state || !CLIENT_ID.test(authorize.searchParams.get("client_id") ?? "")) return undefined;
    const clean = (url: URL) => `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
    return { state, installUrl: clean(install), authorizeUrl: clean(authorize), adminUrl: `https://github.com/apps/${slug}/installations/new`, expiresAt };
  } catch {
    return undefined;
  }
}

/** Code's claim or choose answer, checked field by field. Undefined when anything doesn't read. */
function claimAnswer(body: unknown, allow: "claim" | "choose"): { result: GithubResult; githubUserId?: number; installationId?: number } | undefined {
  if (!isObject(body)) return undefined;
  if (body.status === "requested" && allow === "claim") return { result: { status: "requested" } };
  const user = body.githubUser;
  if (!isObject(user) || !validGithubUserId(user.id) || !login(user.login)) return undefined;
  if (body.status === "connected") {
    const installation = body.installation;
    if (typeof body.alreadyConnected !== "boolean" || !isObject(installation) || !installationId(installation.installationId) || !login(installation.accountLogin) || !accountType(installation.accountType)) return undefined;
    return {
      result: { status: "connected", alreadyConnected: body.alreadyConnected, accountLogin: installation.accountLogin, accountType: installation.accountType },
      githubUserId: user.id, installationId: installation.installationId,
    };
  }
  if (body.status === "choose" && allow === "claim") {
    if (typeof body.ticket !== "string" || !SECRET.test(body.ticket) || !Array.isArray(body.installations) || body.installations.length > CHOICES_MAX) return undefined;
    const installations: Choice[] = [];
    for (const row of body.installations as unknown[]) {
      if (!isObject(row) || !installationId(row.installationId) || !login(row.accountLogin) || !accountType(row.accountType) || typeof row.suspended !== "boolean") return undefined;
      if (row.connection !== "this_company" && row.connection !== "another_company" && row.connection !== "unbound") return undefined;
      installations.push({ installationId: row.installationId, accountLogin: row.accountLogin, accountType: row.accountType, suspended: row.suspended, connection: row.connection });
    }
    return { result: { status: "choose", ticket: body.ticket, githubLogin: user.login, installations } };
  }
  return undefined;
}

/** A refusal of Code's claim or choose, as the one fixed word. Code's 401 never gets here (the client refreshes or ends the sign-in). */
function claimOutcome(status: number): Exclude<Outcome, "result"> {
  if (status === 403) return "start_again";
  if (status === 409) return "taken";
  if (status === 404 || status === 405 || status === 501) return "not_available";
  return "unavailable";
}
const OUTCOME_WORDS: Record<Exclude<Outcome, "result">, { status: number; code: string; message: string }> = {
  start_again: { status: 403, code: "FORBIDDEN", message: GITHUB_WORDS.startAgain },
  taken: { status: 409, code: "GITHUB_INSTALLATION_TAKEN", message: GITHUB_WORDS.taken },
  unavailable: { status: 503, code: "RUNTIME_UNAVAILABLE", message: GITHUB_WORDS.unavailable },
  not_available: { status: 404, code: "NOT_FOUND", message: GITHUB_WORDS.notAvailable },
};
const outcomeRefusal = (outcome: Exclude<Outcome, "result">) => refusal(OUTCOME_WORDS[outcome].status, OUTCOME_WORDS[outcome].code, OUTCOME_WORDS[outcome].message);

/** What the browser sees of an outcome: never the ticket. */
function view(result: GithubResult): unknown {
  if (result.status !== "choose") return result;
  return { status: "choose", githubLogin: result.githubLogin, installations: result.installations };
}

export function createGithubConnect(deps: GithubConnectDeps) {
  const nowMs = () => deps.now().getTime();
  const cookie = (value: string, maxAge: number) =>
    `${GITHUB_CONNECT_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}${deps.secureCookies ? "; Secure" : ""}; Max-Age=${String(maxAge)}`;
  const clearCookie = cookie("", 0);
  const landing = (outcome: Outcome) => `${LANDING}?github=${outcome}`;

  /** The live company of the person (Code's access check), or undefined. */
  async function liveCompany(session: CodeSession): Promise<string | undefined> {
    return companyOf(await deps.client.access(session))?.companyId;
  }

  /** The trial rule on a connected answer: the first company to connect a GitHub account unlocks its trial; no other company does. Never fails the connection. */
  async function applyTrial(session: CodeSession, result: GithubResult, githubUserId: number | undefined): Promise<GithubResult> {
    if (result.status !== "connected" || githubUserId === undefined || deps.companies === undefined) return result;
    try {
      const companyId = await liveCompany(session);
      if (companyId === undefined) return result;
      const unlock = await deps.companies.unlockTrial(githubUserId, companyId, deps.now().toISOString());
      if (unlock === "unlocked") deps.log({ event: "cloud.github_trial_unlocked", companyId, developerId: session.access.developerId });
      if (unlock !== "used") return result;
      deps.log({ event: "cloud.github_trial_used", companyId, developerId: session.access.developerId });
      return { ...result, trialUsed: true };
    } catch (error) {
      if (error instanceof SignInEnded) throw error;
      deps.log({ event: "cloud.github_trial_check_failed", developerId: session.access.developerId });
      return result;
    }
  }

  /** Keeps an outcome for this sign-in (sealed, single use, ten minutes). */
  async function keepResult(sessionCookie: string, developerId: string, result: GithubResult, at = nowMs()): Promise<void> {
    await deps.store.putPending(githubResultKey(sessionCookie), { verifier: "", returnTo: LANDING, at, github: { kind: "result", session: sessionBinding(sessionCookie), developerId, result } });
  }

  /** Takes this sign-in's kept outcome, when it is this sign-in's, this person's and fresh. */
  async function takeResult(session: CodeSession, sessionCookie: string): Promise<{ result: GithubResult; at: number } | undefined> {
    const kept = await deps.store.takePending(githubResultKey(sessionCookie));
    const github = kept?.github;
    if (kept === undefined || github?.kind !== "result" || github.result === undefined || !sameDigest(github.session, sessionBinding(sessionCookie))
      || github.developerId !== session.access.developerId || nowMs() - kept.at > GITHUB_CONNECT_TTL_MS) return undefined;
    return { result: github.result, at: kept.at };
  }

  return {
    /** POST /v1/app/github/connect: Code's connect as the person, the cookie binding, and the GitHub addresses. */
    async start(session: CodeSession, sessionCookie: string, body: unknown): Promise<GithubAnswer> {
      // The browser sends nothing: no company, no installation, no return address.
      if (body !== undefined && !(isObject(body) && Object.keys(body).length === 0)) return refusal(400, "CONFIG_INVALID", GITHUB_WORDS.noDetails);
      if (await liveCompany(session) === undefined) return refusal(403, "NO_COMPANY", "You're not in a company yet.");
      let answer: unknown;
      try {
        answer = await deps.client.json<unknown>(session, `${CODE_GITHUB}/connect`, { method: "POST", body: {} });
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        if (error.status === 403) return refusal(403, "FORBIDDEN", GITHUB_WORDS.adminOnly);
        if (error.status === 404 || error.status === 405 || error.status === 501) return refusal(404, "NOT_FOUND", GITHUB_WORDS.notAvailable);
        const said = isObject(error.body) && isObject(error.body.error) ? error.body.error.message : undefined;
        return refusal(503, "RUNTIME_UNAVAILABLE", error.status === 503 && said === GITHUB_WORDS.notSetUp ? GITHUB_WORDS.notSetUp : GITHUB_WORDS.unavailable);
      }
      const checked = connectAnswer(answer);
      if (checked === undefined) {
        deps.log({ event: "cloud.github_connect_unreadable", developerId: session.access.developerId });
        return refusal(503, "RUNTIME_UNAVAILABLE", GITHUB_WORDS.unavailable);
      }
      const binder = randomBytes(32).toString("base64url");
      await deps.store.putPending(githubStateKey(binder), {
        verifier: "", returnTo: LANDING, at: nowMs(),
        github: { kind: "state", session: sessionBinding(sessionCookie), developerId: session.access.developerId, stateHash: sha256(checked.state), adminUrl: checked.adminUrl },
      });
      deps.log({ event: "cloud.github_connect_started", developerId: session.access.developerId });
      return { status: 200, body: { installUrl: checked.installUrl, authorizeUrl: checked.authorizeUrl, expiresAt: checked.expiresAt }, setCookie: cookie(binder, GITHUB_CONNECT_TTL_MS / 1000) };
    },

    /**
     * GET /api/connect/github/callback: GitHub's return. The cookie's binding is taken (once) and must name this state, this sign-in and this
     * person; the cookie is cleared; Code's claim is asked as the person; the outcome is kept server-side and the person lands on onboarding.
     */
    async callback(query: URLSearchParams, cookieBinder: string | undefined, sessionCookie: string | undefined): Promise<{ location: string; setCookie: string }> {
      // L4-GH: once the cookie's binding is known to be a link flow, a refusal lands on the profile page, not on onboarding.
      let linkFlow = false;
      const refuse = (reason: string, outcome: Exclude<Outcome, "result"> = "start_again") => {
        deps.log({ event: "cloud.github_callback_refused", reason });
        return { location: linkFlow ? `${GITHUB_LINK_LANDING}?github_link=${outcome === "start_again" ? "start_again" : "unavailable"}` : landing(outcome), setCookie: clearCookie };
      };
      if (cookieBinder === undefined || !SECRET.test(cookieBinder)) return refuse("no_binding");
      const kept = await deps.store.takePending(githubStateKey(cookieBinder));
      const binding = kept?.github;
      linkFlow = binding?.kind === "state" && binding.flow === "link";
      if (kept === undefined || binding?.kind !== "state" || nowMs() - kept.at > GITHUB_CONNECT_TTL_MS) return refuse("no_binding");
      let session = sessionCookie === undefined ? undefined : await deps.store.get(sessionCookie);
      if (session === undefined || sessionCookie === undefined || !sameDigest(binding.session, sessionBinding(sessionCookie)) || session.access.developerId !== binding.developerId) return refuse("session");
      const one = (name: string): string | undefined | null => {
        const all = query.getAll(name);
        return all.length === 0 ? undefined : all.length === 1 ? all[0]! : null;
      };
      const state = one("state");
      if (typeof state !== "string" || !SECRET.test(state) || binding.stateHash === undefined || !sameDigest(binding.stateHash, sha256(state))) return refuse("state");
      const code = one("code"), installation = one("installation_id"), setupAction = one("setup_action");
      if (code === null || installation === null || setupAction === null) return refuse("query");
      // L4-GH: the cookie's binding says this return is the person's own GitHub link, not the company connect: it never reaches the install claim below.
      if (binding.flow === "link") {
        if (deps.link === undefined) return refuse("no_link");
        // A code that is present but not a code is a bad return, not a cancel.
        if (code !== undefined && !GITHUB_CODE.test(code)) return refuse("query");
        const extra = installation !== undefined || setupAction !== undefined;
        const done = await deps.link.finish(session, sessionCookie, { state, code, extra });
        return { location: done.location, setCookie: clearCookie };
      }
      if ((code !== undefined && !GITHUB_CODE.test(code)) || (installation !== undefined && !INSTALLATION_ID.test(installation))
        || (setupAction !== undefined && !(SETUP_ACTIONS as readonly string[]).includes(setupAction))) return refuse("query");
      const id = installation === undefined ? undefined : Number(installation);
      if (id !== undefined && !Number.isSafeInteger(id)) return refuse("query");

      let outcome: GithubResult;
      try {
        let answer: unknown;
        try {
          const claim = { state, ...(code === undefined ? {} : { code }), ...(id === undefined ? {} : { installationId: id }), ...(setupAction === undefined ? {} : { setupAction }) };
          try {
            answer = await deps.client.json<unknown>(session, `${CODE_GITHUB}/claim`, { method: "POST", body: claim });
          } catch (error) {
            // Another server refreshed this sign-in first: Code answered 401 before reading the state, so asking once more as the stored sign-in is safe.
            if (!(error instanceof SignInEnded)) throw error;
            const stored = await deps.store.get(sessionCookie);
            if (stored === undefined || stored.refreshToken === session.refreshToken || stored.access.developerId !== binding.developerId) throw error;
            session = stored;
            answer = await deps.client.json<unknown>(session, `${CODE_GITHUB}/claim`, { method: "POST", body: claim });
          }
        } catch (error) {
          if (!(error instanceof CodeError)) throw error;
          const refused = claimOutcome(error.status);
          deps.log({ event: "cloud.github_claim_refused", developerId: session.access.developerId, status: error.status });
          return { location: landing(refused), setCookie: clearCookie };
        }
        const checked = claimAnswer(answer, "claim");
        if (checked === undefined) {
          deps.log({ event: "cloud.github_claim_unreadable", developerId: session.access.developerId });
          return { location: landing("unavailable"), setCookie: clearCookie };
        }
        outcome = checked.result.status === "requested" ? { status: "requested", ...(binding.adminUrl === undefined ? {} : { adminUrl: binding.adminUrl }) } : await applyTrial(session, checked.result, checked.githubUserId);
        deps.log({ event: "cloud.github_claimed", developerId: session.access.developerId, outcome: outcome.status, ...(checked.installationId === undefined ? {} : { installationId: checked.installationId }) });
      } catch (error) {
        if (!(error instanceof SignInEnded)) throw error;
        await deps.store.delete(sessionCookie);
        return refuse("signed_out");
      }
      if (session.changed === true) {
        delete session.changed;
        await deps.store.save(sessionCookie, session);
      }
      await keepResult(sessionCookie, session.access.developerId, outcome);
      return { location: landing("result"), setCookie: clearCookie };
    },

    /** POST /v1/app/github/connect/result: this sign-in's kept outcome (a choose list stays kept, for the choice). */
    async result(session: CodeSession, sessionCookie: string): Promise<GithubAnswer> {
      const taken = await takeResult(session, sessionCookie);
      if (taken === undefined) return { status: 200, body: { status: "none" } };
      // The list stays until a choice (or ten minutes from the callback), so a reload shows it again.
      if (taken.result.status === "choose") await keepResult(sessionCookie, session.access.developerId, taken.result, taken.at);
      return { status: 200, body: view(taken.result) };
    },

    /** POST /v1/app/github/choose { installationId }: one installation from this sign-in's kept list, bound by Code's choose with the kept ticket. */
    async choose(session: CodeSession, sessionCookie: string, body: unknown): Promise<GithubAnswer> {
      if (!isObject(body) || Object.keys(body).length !== 1 || !installationId(body.installationId)) return refusal(400, "CONFIG_INVALID", GITHUB_WORDS.chooseListed);
      const wanted = body.installationId;
      const taken = await takeResult(session, sessionCookie);
      if (taken === undefined || taken.result.status !== "choose") {
        if (taken !== undefined) await keepResult(sessionCookie, session.access.developerId, taken.result, taken.at);
        return outcomeRefusal("start_again");
      }
      const listed = taken.result;
      const row = listed.installations.find((entry) => entry.installationId === wanted);
      if (row === undefined || row.connection === "another_company" || row.suspended) {
        await keepResult(sessionCookie, session.access.developerId, listed, taken.at);
        return refusal(400, "CONFIG_INVALID", GITHUB_WORDS.chooseListed);
      }
      let answer: unknown;
      try {
        answer = await deps.client.json<unknown>(session, `${CODE_GITHUB}/choose`, { method: "POST", body: { ticket: listed.ticket, installationId: wanted } });
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        deps.log({ event: "cloud.github_choose_refused", developerId: session.access.developerId, status: error.status });
        return outcomeRefusal(claimOutcome(error.status));
      }
      const checked = claimAnswer(answer, "choose");
      if (checked === undefined) return outcomeRefusal("unavailable");
      const outcome = await applyTrial(session, checked.result, checked.githubUserId);
      deps.log({ event: "cloud.github_claimed", developerId: session.access.developerId, outcome: outcome.status, installationId: wanted });
      return { status: 200, body: view(outcome) };
    },

    /** GET /v1/app/github/connections: the company's connected GitHub accounts, as Code reads them for any member. */
    async connections(session: CodeSession): Promise<GithubAnswer> {
      if (companyOf(session.access) === undefined) return refusal(403, "NO_COMPANY", "You're not in a company yet.");
      let answer: unknown;
      try {
        answer = await deps.client.json<unknown>(session, CODE_GITHUB);
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        if (error.status === 404 || error.status === 405 || error.status === 501) return refusal(404, "NOT_FOUND", GITHUB_WORDS.notAvailable);
        return refusal(503, "RUNTIME_UNAVAILABLE", GITHUB_WORDS.connectionsUnavailable);
      }
      const rows = isObject(answer) && Array.isArray(answer.installations) && answer.installations.length <= CHOICES_MAX ? answer.installations as unknown[] : undefined;
      const installations: unknown[] = [];
      for (const row of rows ?? []) {
        if (!isObject(row) || !installationId(row.installationId) || !login(row.accountLogin) || typeof row.connectedAt !== "string" || !Number.isFinite(Date.parse(row.connectedAt)) || !isObject(row.connectedBy)) {
          return refusal(503, "RUNTIME_UNAVAILABLE", GITHUB_WORDS.connectionsUnavailable);
        }
        const by = row.connectedBy;
        const name = typeof by.name === "string" && by.name.length > 0 && by.name.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(by.name) ? by.name : undefined;
        // #832's health and account type, only when they read as one of Code's words (an older Code sends neither).
        const health = row.status === "active" || row.status === "suspended" || row.status === "uninstalled" ? { status: row.status } : {};
        installations.push({ installationId: row.installationId, accountLogin: row.accountLogin, ...health, ...(accountType(row.accountType) ? { accountType: row.accountType } : {}), connectedAt: row.connectedAt, connectedBy: by.kind === "person" ? { kind: "person", ...(name === undefined ? {} : { name }) } : { kind: "operator" } });
      }
      if (rows === undefined) return refusal(503, "RUNTIME_UNAVAILABLE", GITHUB_WORDS.connectionsUnavailable);
      return { status: 200, body: { installations } };
    },

    /**
     * DELETE /v1/app/github/connections/{installationId} (guided onboarding PR 12b): a company owner (checked here first; Code checks it
     * again, and that the installation is the company's own and not in use). The browser names only the installation; the company is Code's, read live.
     */
    async disconnect(session: CodeSession, rawId: string, body: unknown): Promise<GithubAnswer> {
      if (body !== undefined && !(isObject(body) && Object.keys(body).length === 0)) return refusal(400, "CONFIG_INVALID", "Disconnecting GitHub takes no details.");
      // Not an installation id: answered as Code answers an installation that isn't the company's, without asking Code.
      if (!INSTALLATION_IN_PATH.test(rawId) || !Number.isSafeInteger(Number(rawId))) return refusal(404, "NOT_FOUND", GITHUB_WORDS.notConnected);
      const wanted = Number(rawId);
      const refused = await companyOwnerOnly(deps.client, session, GITHUB_WORDS.ownerOnly);
      if (refused !== undefined) return { status: refused.status, body: refused.body };
      let answer: unknown;
      try {
        answer = await deps.client.json<unknown>(session, `${CODE_GITHUB}/${String(wanted)}`, { method: "DELETE" });
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        const { code, message } = codeRefusal(error.body);
        if (error.status === 403) return refusal(403, "FORBIDDEN", GITHUB_WORDS.ownerOnly);
        if (error.status === 409 && code === "GITHUB_IN_USE") {
          const named = typeof message === "string" ? IN_USE.exec(message)?.[1]?.split(", ") : undefined;
          const projects = named !== undefined && named.length <= 100 && named.every((name) => PROJECT_NAME.test(name)) ? named : undefined;
          return { status: 409, body: { error: { code: "GITHUB_IN_USE", message: projects === undefined ? GITHUB_WORDS.inUseUnreadable : githubInUseWords(projects) }, ...(projects === undefined ? {} : { projects }) } };
        }
        if (error.status === 404 && code === "NOT_FOUND" && message !== "route not found") return refusal(404, "NOT_FOUND", GITHUB_WORDS.notConnected);
        if (error.status === 404 || error.status === 405 || error.status === 501) return refusal(501, "NOT_ON_CODE_YET", GITHUB_WORDS.notAvailable);
        return refusal(503, "RUNTIME_UNAVAILABLE", GITHUB_WORDS.disconnectUnavailable);
      }
      if (!isObject(answer) || answer.status !== "disconnected" || answer.installationId !== wanted || !login(answer.accountLogin)
        || (answer.uninstallUrl !== undefined && (typeof answer.uninstallUrl !== "string" || !UNINSTALL_URL.test(answer.uninstallUrl) || !answer.uninstallUrl.endsWith(`/${String(wanted)}`)))) {
        return refusal(503, "RUNTIME_UNAVAILABLE", GITHUB_WORDS.disconnectUnavailable);
      }
      deps.log({ event: "cloud.github_disconnected", developerId: session.access.developerId, installationId: wanted });
      return { status: 200, body: { status: "disconnected", installationId: wanted, accountLogin: answer.accountLogin, ...(typeof answer.uninstallUrl === "string" ? { uninstallUrl: answer.uninstallUrl } : {}) } };
    },
  };
}

export type GithubConnect = ReturnType<typeof createGithubConnect>;
/** The app's GitHub connect routes that need the sign-in's cookie (paths after /v1/web). */
export const GITHUB_APP_PATHS = { start: "/github/connect", result: "/github/connect/result", choose: "/github/choose", connections: "/github/connections" } as const;
/** DELETE /v1/web/github/connections/{installationId} (guided onboarding PR 12b). */
export const GITHUB_DISCONNECT_PATH = /^\/github\/connections\/([^/]+)$/u;
