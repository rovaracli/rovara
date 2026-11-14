// Rovara Cloud's server for its web app: sign-in through Rovara Code, the session cookie, and the app's API
// (/v1/web/*, the browser's name for /v1/app/*) answered by the route table, and the plan approval page (/v1/app/approve/*, approve.ts).
// Framework-neutral: a local HTTP server
// and a Lambda both pass a CloudRequest and send back the CloudResponse.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import { APPROVAL_PATH, approvalRoute, signInPage } from "./approve.js";
import { LocalPresenceBoard, type PresenceBoard } from "./presence.js";
import { ROUTES, type OrgView, type Route } from "./routes.js";
import type { SessionStore } from "./sessions.js";
import type { WorkSessionStore } from "./work-sessions.js";

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
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

const COOKIE = "rovara_cloud_session";
const SIGN_IN_TTL_MS = 10 * 60_000;

/** Only an app path may be returned to after sign-in, as the app's own returnPath allows. */
export function returnPath(value: string | null): string {
  return value !== null && /^\/app(?:\/[A-Za-z0-9._~%/-]*)?(?:\?[A-Za-z0-9._~%=&-]*)?$/u.test(value) && !value.includes("..") && !value.includes("//") ? value : "/app";
}

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function json(status: number, body: unknown, headers: Record<string, string> = {}): CloudResponse {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers }, body: JSON.stringify(body) };
}
function text(status: number, body: string, headers: Record<string, string> = {}): CloudResponse {
  return { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }, body };
}
const signInAgain = () => json(401, { error: { code: "AUTH_REQUIRED", message: "Your Rovara sign-in ended. Sign in again." } });

/** The handler; it answers undefined for a path that is not Cloud's (the app's pages and assets). */
export function createCloudHandler(options: CloudHandlerOptions): (request: CloudRequest) => Promise<CloudResponse | undefined> {
  const routes = options.routes ?? ROUTES;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((event) => { console.log(JSON.stringify(event)); });
  const presence = options.presence ?? new LocalPresenceBoard();
  const cookie = (value: string, maxAge?: number) =>
    `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/${options.secureCookies ? "; Secure" : ""}${maxAge === undefined ? "" : `; Max-Age=${String(maxAge)}`}`;
  const sessionId = (request: CloudRequest) =>
    (request.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).find(([name]) => name === COOKIE)?.[1];

  return async (request) => {
    const { method, path } = request;
    if (path === "/v1/auth/browser/authorize" && method === "GET") {
      const { url, state, pending } = options.client.startSignIn(returnPath(request.query.get("return_to")), now().getTime());
      await options.store.putPending(state, pending);
      return text(302, "", { location: url });
    }
    if (path === options.callbackPath && method === "GET") {
      const pending = await options.store.takePending(request.query.get("state") ?? "");
      if (pending === undefined || now().getTime() - pending.at > SIGN_IN_TTL_MS) return text(400, "This sign-in expired. Go back to the app and sign in again.");
      const refused = request.query.get("error");
      if (refused !== null) return text(400, `Rovara Code refused the sign-in: ${refused}`);
      try {
        const signedIn = await options.client.finishSignIn(request.query.get("code") ?? "", pending);
        const id = randomBytes(32).toString("base64url");
        await options.store.put(id, {
          accessToken: signedIn.accessToken, ...(signedIn.refreshToken === undefined ? {} : { refreshToken: signedIn.refreshToken }),
          access: signedIn.access, csrf: randomBytes(32).toString("base64url"), signedInAt: now().toISOString(),
        });
        log({ event: "cloud.signed_in", developerId: signedIn.access.developerId, projects: signedIn.access.projects.length });
        return text(302, "", { location: pending.returnTo, "set-cookie": cookie(id) });
      } catch (error) {
        if (error instanceof CodeError) return text(502, "Rovara Code didn't complete the sign-in. Go back to the app and try again.");
        throw error;
      }
    }
    if (path === "/v1/auth/browser/sign-out" && method === "POST") {
      const id = sessionId(request);
      const session = id === undefined ? undefined : await options.store.get(id);
      if (id !== undefined && session !== undefined && sameText(request.headers["x-rovara-csrf"] ?? "", session.csrf)) await options.store.delete(id);
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
        const answer = await approvalRoute({ client: options.client, session, work: options.work, origin: options.origin }, approval[1]!, method, request.headers, form);
        if (session.changed === true) {
          delete session.changed;
          await options.store.put(id, session);
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
    if (!path.startsWith("/v1/web/")) return undefined;

    const id = sessionId(request);
    const session = id === undefined ? undefined : await options.store.get(id);
    if (id === undefined || session === undefined) return json(401, { error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } });
    if (method !== "GET" && method !== "HEAD" && !sameText(request.headers["x-rovara-csrf"] ?? "", session.csrf)) {
      return json(403, { error: { code: "CSRF_INVALID", message: "Refresh the page and try again." } });
    }
    const apiPath = path.slice("/v1/web".length);
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
        const answer = await route.answer({
          client: options.client, session, params: match.slice(1).map((part) => decodeURIComponent(part)), query: request.query, body, org: options.org, now,
          work: options.work, origin: options.origin, presence,
        });
        if (session.changed === true) {
          delete session.changed;
          await options.store.put(id, session);
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
