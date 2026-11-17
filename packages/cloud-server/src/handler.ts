// Rovara Cloud's server for its web app: sign-in through Rovara Code, the session cookie, and the app's API
// (/v1/web/*, the browser's name for /v1/app/*) answered by the route table, and the plan approval page (/v1/app/approve/*, approve.ts).
// Framework-neutral: a local HTTP server
// and a Lambda both pass a CloudRequest and send back the CloudResponse.
import { renameInSessions } from "./rename.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CloudAuditStore } from "./audit-log.js";
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import { APPROVAL_PATH, approvalRoute, signInPage } from "./approve.js";
import { LocalPresenceBoard, type PresenceBoard } from "./presence.js";
import { POLICY_HOOK_PATH } from "./policy-hook.js";
import { COMPANY_ROUTES, type CompanyBackend } from "./company-routes.js";
import { PRODUCT_AI_ROUTES, type ProductAiBackend } from "./product-ai-routes.js";
import { LEARNING_AI_ROUTES } from "./learning-ai-routes.js";
import { AGENT_AI_ROUTES } from "./agent-ai-routes.js";
import { BEDROCK_BYO_ROUTES } from "./bedrock-byo-routes.js";
import { ROUTES, type OrgView, type Route, type RouteAnswer } from "./routes.js";
import type { SessionStore } from "./sessions.js";
import { StoreConflict, companyScopedWork, type WorkSessionStore } from "./work-sessions.js";
import { companyOf } from "./company-caller.js";
import { JOIN_UNUSABLE, inviteTokenHash, linkToken, openSecret, sealSecret, ticketKey, usableInvite } from "./onboarding-routes.js";
import { GITHUB_APP_PATHS, GITHUB_CALLBACK_PATH, GITHUB_CONNECT_COOKIE, createGithubConnect, type GithubAnswer } from "./github-connect.js";
import { connectCookieName } from "./connect-flow.js";
import { SLACK_CALLBACK_PATH, createSlackConnect } from "./slack-connect.js";
import { LINEAR_CALLBACK_PATH, createLinearConnect } from "./linear-connect.js";
import { createSignInLinks } from "./sign-in-links.js";

export interface CloudRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Header names in lower case. */
  headers: Record<string, string | undefined>;
  body?: string;
}

export interface CloudResponse { status: number; headers: Record<string, string>; body: string }

export interface CloudHandlerOptions {
  client: CodeClient;
  store: SessionStore;
  org: OrgView;
  /** The path Code sends the browser back to after sign-in: the path of the client's redirect URI. */
  callbackPath: string;
  /** Adds `Secure` to the cookie; off only on a loopback address. */
  secureCookies: boolean;
  /** Cloud's sessions (phase 2). */
  work: WorkSessionStore;
  /** The address the app is served at, for session links (such as http://127.0.0.1:8787). */
  origin: string;
  /** Who is looking at each session now; this server's memory by default. */
  presence?: PresenceBoard;
  routes?: Route[];
  /** Cloud's company data: adds the company routes (company-routes.ts). Absent: those routes answer 501, as before. */
  company?: CompanyBackend;
  /** Cloud's own audit records (plan v3.2 7.5): read by `GET /v1/app/company/audit`, written by routes that change something at company level and by the policy hook. */
  audit?: CloudAuditStore;
  /** The project's product AI settings over the gateway's write-only key store: adds those routes (product-ai-routes.ts). Absent: 501, as before. */
  productAi?: ProductAiBackend;
  /** Lane H: the policy hook's answering route (`createPolicyHookRoute`), served at `POLICY_HOOK_PATH`. Absent: that path is not Cloud's, as before. */
  policyHook?: (request: CloudRequest) => Promise<CloudResponse>;
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const COOKIE = "rovara_cloud_session";
/**
 * The join ticket's cookie (onboarding-routes.ts): opaque, single use, ten minutes, only for Cloud's sign-in paths. `<ticket>.<key>`: the
 * ticket names the kept join; the key opens the invite secret sealed in it (DEC 254h), so the store alone can't.
 */
const JOIN_COOKIE = "rovara_cloud_join";
const JOIN_TICKET = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u;
/** Where a join that can't go on lands: the join page's one sentence. */
const JOIN_UNUSABLE_PAGE = "/app/join?unusable=1";
/** The join page's lookup: the invite link's token in, the company's name and a join ticket out. */
export const JOIN_PATH = "/v1/auth/browser/join";
const SIGN_IN_TTL_MS = 10 * 60_000;

/** Only an app path may be returned to after sign-in, as the app's own returnPath allows. */
export function returnPath(value: string | null): string {
  return value !== null && /^\/app(?:\/[A-Za-z0-9._~%/-]*)?(?:\?[A-Za-z0-9._~%=&-]*)?$/u.test(value) && !value.includes("..") && !value.includes("//") ? value : "/app";
}

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function json(status: number, body: unknown, headers: Record<string, string> = {}): CloudResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body: JSON.stringify(body) };
}
/** How many times a request runs when another server changed what it read meanwhile (StoreConflict, a refresh done elsewhere). */
const REQUEST_ATTEMPTS = 3;

/** Code's task page path, as the app's links name it (packages/ui/src/screens/project/learning-text.ts taskPageHref). */
export const CODE_TASK_PAGE = /^\/review\/[A-Za-z0-9_-]{1,100}\/task$/u;

function text(status: number, body: string, headers: Record<string, string> = {}): CloudResponse {
  return { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }, body };
}
/** A request body as JSON; `null` (never a valid GitHub connect body) when it doesn't parse. */
const parsedBody = (body: string | undefined): unknown => {
  if (body === undefined || body === "") return undefined;
  try { return JSON.parse(body) as unknown; } catch { return null; }
};
const signInAgain = () => json(401, { error: { code: "AUTH_REQUIRED", message: "Your Rovara sign-in ended. Sign in again." } });

/** The handler; it answers undefined for a path that is not Cloud's (the app's pages and assets). */
export function createCloudHandler(options: CloudHandlerOptions): (request: CloudRequest) => Promise<CloudResponse | undefined> {
  const routes = options.routes ?? [...ROUTES, ...(options.company === undefined ? [] : [...COMPANY_ROUTES, ...AGENT_AI_ROUTES]), ...(options.productAi === undefined ? [] : [...PRODUCT_AI_ROUTES, ...LEARNING_AI_ROUTES, ...BEDROCK_BYO_ROUTES])];
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((event) => { console.log(JSON.stringify(event)); });
  const presence = options.presence ?? new LocalPresenceBoard();
  // Every refresh goes through the store: one server at a time, and the new tokens saved before the retried call.
  options.client.useRefreshGuard(options.store);
  const cookie = (value: string, maxAge?: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/${options.secureCookies ? "; Secure" : ""}${maxAge === undefined ? "" : `; Max-Age=${String(maxAge)}`}`;
  const sessionId = (request: CloudRequest) =>
    (request.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).find(([name]) => name === COOKIE)?.[1];

  const joinCookie = (value: string, maxAge: number) =>
    `${JOIN_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/v1/auth/browser${options.secureCookies ? "; Secure" : ""}; Max-Age=${String(maxAge)}`;
  const cookieNamed = (request: CloudRequest, name: string) =>
    (request.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).find(([key]) => key === name)?.[1];
  const unusable = (status = 404) => json(status, { error: { code: "INVITE_UNUSABLE", message: JOIN_UNUSABLE } });
  const appOrigin = new URL(options.origin).origin;
  // Guided onboarding PR 2: Connect GitHub (github-connect.ts).
  const github = createGithubConnect({ client: options.client, store: options.store, now, log, secureCookies: options.secureCookies, ...(options.company === undefined ? {} : { companies: options.company.store }) });
  // Guided onboarding PR 11: Add to Slack, the channel picker, Connect Linear and the team pick (slack-connect.ts, linear-connect.ts).
  const slack = createSlackConnect({ client: options.client, store: options.store, now, log, secureCookies: options.secureCookies, origin: options.origin });
  const linear = createLinearConnect({ client: options.client, store: options.store, now, log, secureCookies: options.secureCookies, origin: options.origin });
  // DEC 254w: Connected sign-ins (sign-in-links.ts). Its return arrives at the registered sign-in callback, so the callback below asks `isReturn` first.
  const signInLinks = createSignInLinks({ client: options.client, store: options.store, now, log });

  /**
   * The join page's lookup (onboarding-routes.ts): same origin only (a page elsewhere can't start a join for someone), JSON, small. A usable
   * invite answers the company's name and keeps a single-use join ticket, in an HttpOnly cookie, for "Sign in to join".
   */
  async function joinLookup(request: CloudRequest): Promise<CloudResponse> {
    if (request.headers.origin !== appOrigin || !(request.headers["content-type"] ?? "").startsWith("application/json") || (request.body ?? "").length > 256) return unusable(403);
    let body: unknown;
    try { body = JSON.parse(request.body ?? ""); } catch { return unusable(); }
    const token = body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 ? linkToken((body as { invite?: unknown }).invite) : undefined;
    const invite = token === undefined ? undefined : await usableInvite(options.company?.store, inviteTokenHash(token), now().getTime());
    if (invite === undefined) return unusable();
    const ticket = randomBytes(32).toString("base64url"), key = ticketKey();
    // Code's secret rides in the ticket sealed under the cookie's key: the store never holds it readable, and it is never logged.
    await options.store.putPending(`join.${ticket}`, {
      verifier: "", returnTo: "/app", at: now().getTime(), invite: invite.tokenHash, joinTicket: true, ...(invite.codeSecret === true ? { sealedSecret: sealSecret(token!, key, ticket) } : {}),
    });
    return json(200, { companyName: invite.companyName ?? "your company" }, { "set-cookie": joinCookie(`${ticket}.${key}`, SIGN_IN_TTL_MS / 1000) });
  }

  /** "Sign in to join": the ticket from the cookie, the invite checked again, and Code's sign-in with the invite's company. */
  async function joinSignIn(request: CloudRequest): Promise<CloudResponse> {
    const [, ticket, key] = JOIN_TICKET.exec(cookieNamed(request, JOIN_COOKIE) ?? "") ?? [];
    const clear = joinCookie("", 0);
    const kept = ticket !== undefined ? await options.store.takePending(`join.${ticket}`) : undefined;
    const fresh = kept !== undefined && kept.joinTicket === true && kept.invite !== undefined && now().getTime() - kept.at <= SIGN_IN_TTL_MS;
    const invite = fresh ? await usableInvite(options.company?.store, kept.invite!, now().getTime()) : undefined;
    // An invite whose link is Code's secret joins only with that secret, opened from the ticket and matching the invite's hash.
    const secret = invite?.codeSecret === true ? openSecret(kept!.sealedSecret, key!, ticket!) : undefined;
    if (invite === undefined || (invite.codeSecret === true && (secret === undefined || inviteTokenHash(secret) !== invite.tokenHash))) {
      return text(302, "", { location: JOIN_UNUSABLE_PAGE, "set-cookie": clear });
    }
    const { url, state, pending } = options.client.startSignIn("/app", now().getTime(), { company: invite.companyId, invite: invite.tokenHash, ...(secret === undefined ? {} : { inviteSecret: secret }) });
    await options.store.putPending(state, pending);
    return text(302, "", { location: url, "set-cookie": clear });
  }

  /**
   * After a join's sign-in: the invite is marked taken only when Code put the person in the invite's company AND says this sign-in joined by
   * an invite (`joinedByInvite`, DEC 254h). Where the person lands.
   */
  async function finishJoin(inviteHash: string, access: NonNullable<Parameters<typeof companyOf>[0]>, developerId: string): Promise<string> {
    const invite = await usableInvite(options.company?.store, inviteHash, now().getTime());
    if (invite === undefined || companyOf(access)?.companyId !== invite.companyId || access.joinedByInvite !== true) {
      log({ event: "cloud.invite_join_refused", developerId });
      return JOIN_UNUSABLE_PAGE;
    }
    try {
      await options.company!.store.updateInvite({ ...invite, state: "accepted", revision: invite.revision + 1, acceptedAt: now().toISOString(), acceptedBy: developerId }, { revision: invite.revision, state: "pending" });
      log({ event: "cloud.invite_accepted", inviteId: invite.inviteId, companyId: invite.companyId, developerId });
    } catch {
      // Code already admitted the person; the invite stays pending until it expires. Fixed words only.
      log({ event: "cloud.invite_accept_failed", inviteId: invite.inviteId });
    }
    return "/app?joined=1";
  }

  return async (request) => {
    const { method, path } = request;
    if (path === POLICY_HOOK_PATH && options.policyHook !== undefined) return options.policyHook(request);
    if (path === GITHUB_CALLBACK_PATH && method === "GET") {
      const back = await github.callback(request.query, cookieNamed(request, GITHUB_CONNECT_COOKIE), sessionId(request));
      return text(302, "", { location: back.location, "set-cookie": back.setCookie });
    }
    if (path === SLACK_CALLBACK_PATH && method === "GET") {
      const back = await slack.callback(request.query, cookieNamed(request, connectCookieName("slack")), sessionId(request));
      return text(302, "", { location: back.location, "set-cookie": back.setCookie });
    }
    if (path === LINEAR_CALLBACK_PATH && method === "GET") {
      const back = await linear.callback(request.query, cookieNamed(request, connectCookieName("linear")), sessionId(request));
      return text(302, "", { location: back.location, "set-cookie": back.setCookie });
    }
    if (path === JOIN_PATH && method === "POST") return joinLookup(request);
    if (path === "/v1/auth/browser/authorize" && method === "GET" && request.query.get("join") === "1") return joinSignIn(request);
    if (path === "/v1/auth/browser/authorize" && method === "GET") {
      // `step_up=1`: the app asks for a fresh step-up before a sensitive change (company settings, inviting an admin).
      const { url, state, pending } = options.client.startSignIn(returnPath(request.query.get("return_to")), now().getTime(), { stepUp: request.query.get("step_up") === "1" });
      await options.store.putPending(state, pending);
      return text(302, "", { location: url });
    }
    if (path === options.callbackPath && method === "GET" && signInLinks.isReturn(request.query)) {
      // A connected sign-in's return, never a sign-in: it goes on only for the browser whose sign-in started it.
      const back = await signInLinks.callback(request.query, sessionId(request));
      return text(302, "", { location: back.location });
    }
    if (path === options.callbackPath && method === "GET") {
      const state = request.query.get("state") ?? "";
      // A join ticket is never a sign-in under way.
      const pending = state.startsWith("join.") || state.startsWith("github.") || state.startsWith("connect.") || state.startsWith("link.") ? undefined : await options.store.takePending(state);
      if (pending === undefined || pending.joinTicket === true || pending.github !== undefined || pending.connect !== undefined || pending.link !== undefined || now().getTime() - pending.at > SIGN_IN_TTL_MS) return text(400, "This sign-in expired. Go back to the app and sign in again.");
      const refused = request.query.get("error");
      // A join Code refused (the email isn't the invited one, the invite was used or withdrawn): the one sentence, never Code's words.
      if (refused !== null && pending.invite !== undefined) return text(302, "", { location: JOIN_UNUSABLE_PAGE });
      if (refused !== null) return text(400, `Rovara Code refused the sign-in: ${refused}`);
      try {
        const signedIn = await options.client.finishSignIn(request.query.get("code") ?? "", pending);
        const id = randomBytes(32).toString("base64url");
        await options.store.create(id, {
          accessToken: signedIn.accessToken, ...(signedIn.refreshToken === undefined ? {} : { refreshToken: signedIn.refreshToken }),
          access: signedIn.access, csrf: randomBytes(32).toString("base64url"), signedInAt: now().toISOString(),
        });
        log({ event: "cloud.signed_in", developerId: signedIn.access.developerId, projects: signedIn.access.projects.length });
        // Rovara-cloud#39: a name changed since this person's sessions were written (chosen in Code, or a provider's) reaches them now. Best effort.
        try {
          const renamedSessions = await renameInSessions(options.work, signedIn.access.developerId, signedIn.access.displayName);
          if (renamedSessions > 0) log({ event: "cloud.sessions_renamed", developerId: signedIn.access.developerId, sessions: renamedSessions });
        } catch (error) {
          log({ event: "cloud.sessions_rename_failed", developerId: signedIn.access.developerId, error: error instanceof Error ? error.name : "unknown" });
        }
        const landing = pending.invite === undefined ? pending.returnTo : await finishJoin(pending.invite, signedIn.access, signedIn.access.developerId);
        return text(302, "", { location: landing, "set-cookie": cookie(id) });
      } catch (error) {
        if (error instanceof CodeError) return text(502, "Rovara Code didn't complete the sign-in. Go back to the app and try again.");
        throw error;
      }
    }
    if (path === "/v1/auth/browser/sign-out" && method === "POST") {
      const id = sessionId(request);
      const session = id === undefined ? undefined : await options.store.get(id);
      if (id !== undefined && session !== undefined && sameText(request.headers["x-rovara-csrf"] ?? "", session.csrf)) {
        await options.store.delete(id);
        // The sign-in ends at Code too, so the tokens are no use to anyone who copied them.
        const revoked = await options.client.revoke(session);
        log({ event: revoked ? "cloud.signed_out" : "cloud.revoke_failed", developerId: session.access.developerId });
      }
      return text(204, "", { "set-cookie": cookie("", 0) });
    }
    const approval = APPROVAL_PATH.exec(path);
    if (approval !== null && (method === "GET" || method === "POST")) {
      // A page the browser opens directly, so a missing sign-in answers a page, not JSON.
      const id = sessionId(request);
      const session = id === undefined ? undefined : await options.store.get(id);
      if (id === undefined || session === undefined) return signInPage();
      const form = method === "POST" && (request.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded") ? new URLSearchParams(request.body ?? "") : undefined;
      try {
        const answer = await approvalRoute({ client: options.client, session, work: companyScopedWork(options.work, () => companyOf(session.access)?.companyId), origin: options.origin }, approval[1]!, method, request.headers, form);
        if (session.changed === true) {
          delete session.changed;
          await options.store.save(id, session);
        }
        if (method === "POST" && answer.status === 303) log({ event: "cloud.plan_decided", sessionId: approval[1], decision: form?.get("decision") });
        return answer;
      } catch (error) {
        if (error instanceof SignInEnded) {
          await options.store.delete(id);
          return signInPage();
        }
        throw error;
      }
    }
    // Code's own task page (`/review/<task>/task`), which the app links to where Cloud has no page of its own, such as a lesson's
    // source task. It lives on Code, so the browser goes there; Code asks the person to sign in to it if they haven't.
    if (CODE_TASK_PAGE.test(path) && (method === "GET" || method === "HEAD")) return text(302, "", { location: `${options.client.baseUrl}${path}` });
    if (!path.startsWith("/v1/web/")) return undefined;

    const id = sessionId(request);
    let session = id === undefined ? undefined : await options.store.get(id);
    if (id === undefined || session === undefined) return json(401, { error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } });
    if (method !== "GET" && method !== "HEAD" && !sameText(request.headers["x-rovara-csrf"] ?? "", session.csrf)) {
      return json(403, { error: { code: "CSRF_INVALID", message: "Refresh the page and try again." } });
    }
    const apiPath = path.slice("/v1/web".length);
    // Guided onboarding PR 2: the GitHub connect routes need this sign-in's cookie (the binding and the kept outcome are keyed by it).
    const githubCall: (() => Promise<GithubAnswer>) | undefined =
      method === "POST" && apiPath === GITHUB_APP_PATHS.start ? () => github.start(session!, id, parsedBody(request.body))
        : method === "POST" && apiPath === GITHUB_APP_PATHS.result ? () => github.result(session!, id)
          : method === "POST" && apiPath === GITHUB_APP_PATHS.choose ? () => github.choose(session!, id, parsedBody(request.body))
            : method === "GET" && apiPath === GITHUB_APP_PATHS.connections ? () => github.connections(session!) : undefined;
    // Guided onboarding PR 11: Slack and Linear (the start and result routes need this sign-in's cookie, as GitHub's).
    const connectRoute = githubCall === undefined ? slack.route(method, apiPath, request.query) ?? linear.route(method, apiPath) ?? signInLinks.route(method, apiPath) : undefined;
    const connectCall = githubCall ?? (connectRoute === undefined ? undefined : () => connectRoute(session!, id, parsedBody(request.body)));
    if (connectCall !== undefined) {
      try {
        let answer: GithubAnswer;
        try {
          answer = await connectCall();
        } catch (error) {
          // Another server refreshed this sign-in first (its refresh token was used once): run once more on what the store holds, as the route loop does.
          if (!(error instanceof SignInEnded)) throw error;
          const stored = await options.store.get(id);
          if (stored === undefined || stored.refreshToken === session.refreshToken) throw error;
          session = stored;
          answer = await connectCall();
        }
        if (session.changed === true) {
          delete session.changed;
          await options.store.save(id, session);
        }
        return json(answer.status, answer.body, answer.setCookie === undefined ? {} : { "set-cookie": answer.setCookie });
      } catch (error) {
        if (error instanceof SignInEnded) {
          await options.store.delete(id);
          return signInAgain();
        }
        throw error;
      }
    }
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.path.exec(apiPath);
      if (match === null) continue;
      let body: unknown;
      try {
        body = request.body === undefined || request.body === "" ? undefined : JSON.parse(request.body);
      } catch {
        return json(400, { error: { code: "CONFIG_INVALID", message: "The request body isn't valid JSON." } });
      }
      try {
        let answer: RouteAnswer | undefined;
        // Another server may change a session between a route's read and its write (StoreConflict), or refresh this sign-in's
        // tokens first: Code's refresh tokens work once, so this server's refresh then fails. Either way the request runs
        // again on what the store holds now, a few times at most.
        for (let attempt = 1; answer === undefined; attempt += 1) {
          const using = session;
          try {
            answer = await route.answer({
              client: options.client, session: using, params: match.slice(1).map((part) => decodeURIComponent(part)), query: request.query, body, org: options.org, now,
              // Cloud's sessions as the person's company sees them, by the company Code named in its latest access check for this sign-in (kept
              // with the stored sign-in). Not asked afresh on every session route: a person is in one company, a change of company is a new
              // sign-in, and every route that shows or changes a session's data asks Code for its task first (Code checks the company live).
              work: companyScopedWork(options.work, () => companyOf(using.access)?.companyId), origin: options.origin, presence, ...(options.audit === undefined ? {} : { audit: options.audit }), ...(options.company === undefined ? {} : { company: options.company }),
              ...(options.productAi === undefined ? {} : { productAi: options.productAi }),
            });
          } catch (error) {
            if (attempt >= REQUEST_ATTEMPTS) throw error;
            if (error instanceof StoreConflict) continue;
            if (!(error instanceof SignInEnded)) throw error;
            const stored = await options.store.get(id);
            if (stored === undefined || stored.refreshToken === using.refreshToken) throw error;
            session = stored;
          }
        }
        const retried = /^\/sessions\/(ses_[0-9a-z]{20})\/retry$/u.exec(apiPath);
        if (method === "POST" && retried !== null && answer.status === 200) log({ event: "cloud.reviews_retried", sessionId: retried[1] });
        if (session.changed === true) {
          delete session.changed;
          await options.store.save(id, session);
        }
        return json(answer.status, answer.body);
      } catch (error) {
        if (error instanceof SignInEnded) {
          await options.store.delete(id);
          return signInAgain();
        }
        // Code's own refusal (403, 404, 409 …) reaches the app as Code worded it.
        if (error instanceof CodeError) return json(error.status, error.body ?? { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code didn't answer." } });
        throw error;
      }
    }
    log({ event: "cloud.route_not_on_code", method, path: `/v1/app${apiPath}` });
    return json(501, { error: { code: "NOT_ON_CODE_YET", message: `/v1/app${apiPath} isn't connected to Rovara Code yet.` } });
  };
}
