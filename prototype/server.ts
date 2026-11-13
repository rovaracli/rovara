// Prototype (PrepLabsAI/Rovara-cloud#1): the Rovara Cloud web app on its own, signing people in through a Rovara Code
// install as a registered sign-in client (spec 063) and answering the app's /v1/web API from it. One feature at a time;
// everything not built yet answers 501 so the screen says so.
//
//   ROVARA_CODE_URL=https://<api> ROVARA_CLIENT_ID=rovara-cloud ROVARA_CLIENT_SECRET_FILE=<file> npx tsx prototype/server.ts
//
// Sessions live in memory: restarting the server signs everyone out.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { createAppHandler } from "../packages/web/src/server/handler.js";

const PORT = Number(process.env.PORT ?? 8787);
const CODE = required("ROVARA_CODE_URL").replace(/\/+$/, "");
const CLIENT_ID = process.env.ROVARA_CLIENT_ID ?? "rovara-cloud";
const CLIENT_SECRET = readFileSync(required("ROVARA_CLIENT_SECRET_FILE"), "utf8").trim();
// Rovara Code takes a loopback redirect only at exactly this path (isLoopbackRedirectUri).
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SESSION_COOKIE = "rovara_prototype_session";

interface Access { developerId: string; displayName: string; administrator: boolean; projects: Array<{ name: string; access: string }>; notices: string[] }
interface Session { accessToken: string; refreshToken?: string; access: Access; csrf: string; signedInAt: string }
const pendingSignIns = new Map<string, { verifier: string; returnTo: string; at: number }>();
const sessions = new Map<string, Session>();

const app = createAppHandler({ appDirectory: join(resolve(process.cwd(), "packages/web/dist"), "app"), assetOrigin: "", realtimeHttpHost: "", realtimeWsHost: "" });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "cache-control": "no-store", ...(typeof body === "string" ? {} : { "content-type": "application/json" }), ...headers });
  res.end(text);
}
const redirect = (res: ServerResponse, location: string, headers: Record<string, string> = {}) => send(res, 302, "", { location, ...headers });
const notBuilt = (res: ServerResponse, path: string) => send(res, 501, { error: { code: "NOT_IN_PROTOTYPE", message: `${path} isn't in the Rovara Cloud prototype yet.` } });

function sessionOf(req: IncomingMessage): Session | undefined {
  const id = (req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=")).find(([name]) => name === SESSION_COOKIE)?.[1];
  return id === undefined ? undefined : sessions.get(id);
}
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Only an app path may be returned to, as the app's own returnPath allows. */
function returnPath(value: string | null): string {
  return value !== null && /^\/app(?:\/[A-Za-z0-9._~%/-]*)?(?:\?[A-Za-z0-9._~%=&-]*)?$/.test(value) && !value.includes("..") && !value.includes("//") ? value : "/app";
}

/** Step 1: sign in through Rovara Code, as the registered client, with PKCE. */
function startSignIn(res: ServerResponse, url: URL): void {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  pendingSignIns.set(state, { verifier, returnTo: returnPath(url.searchParams.get("return_to")), at: Date.now() });
  const authorize = new URL(`${CODE}/v1/auth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  }).toString();
  redirect(res, authorize.toString());
}

async function finishSignIn(res: ServerResponse, url: URL): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const pending = pendingSignIns.get(state);
  pendingSignIns.delete(state);
  if (pending === undefined || Date.now() - pending.at > 10 * 60_000) return send(res, 400, "This sign-in expired. Go back to the app and sign in again.");
  const error = url.searchParams.get("error");
  if (error !== null) return send(res, 400, `Rovara Code refused the sign-in: ${error} ${url.searchParams.get("error_description") ?? ""}`);
  const token = await fetch(`${CODE}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", code_verifier: pending.verifier, redirect_uri: REDIRECT_URI }),
  });
  const tokens = await token.json() as { access_token?: string; refresh_token?: string; error?: string };
  if (!token.ok || tokens.access_token === undefined) return send(res, 502, `Rovara Code didn't issue a token: ${tokens.error ?? token.status}`);
  const access = await accessCheck(tokens.access_token);
  if (access === undefined) return send(res, 502, "Rovara Code's access check refused the new sign-in.");
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, { accessToken: tokens.access_token, ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }), access, csrf: randomBytes(32).toString("base64url"), signedInAt: new Date().toISOString() });
  console.log(JSON.stringify({ event: "signed_in", developerId: access.developerId, projects: access.projects.length }));
  redirect(res, pending.returnTo, { "set-cookie": `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/` });
}

/** Spec 063 FR-004: who the person is and what they can use, with their own token for this client. */
async function accessCheck(accessToken: string): Promise<Access | undefined> {
  const response = await fetch(`${CODE}/v1/dev/access`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}" });
  return response.ok ? await response.json() as Access : undefined;
}

/** GET /v1/app/me, as the app reads it (AppMeResponseSchema). One fixed org until orgs are built. */
function me(session: Session) {
  return {
    csrf: session.csrf,
    developer: { id: session.access.developerId, name: session.access.displayName, orgRole: session.access.administrator ? "owner" : "member", nameChosen: true },
    org: { orgId: "rovara-production", name: "Rovara (production)", plan: "prototype" },
    identities: [{ provider: "oidc", linkedAt: session.signedInAt, lastSignInAt: session.signedInAt }],
  };
}

/** GET /v1/app/nav, the app's frame (AppNavSchema): the person, the one org, and their projects from the access check. */
function nav(session: Session) {
  return {
    me: { developerId: session.access.developerId, name: session.access.displayName, orgRole: session.access.administrator ? "owner" : "member", nameChosen: true },
    org: { name: "Rovara (production)" },
    homeCount: 0,
    projects: session.access.projects.slice(0, 50).map((project) => ({ name: project.name, agents: [] })),
    shared: { agents: [], sessions: [] },
    // Off until each is built in the prototype.
    features: { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const method = req.method ?? "GET";
  if (url.pathname === "/") return redirect(res, "/app");
  if (url.pathname === "/v1/auth/browser/authorize" && method === "GET") return startSignIn(res, url);
  if (url.pathname === "/callback" && method === "GET") return finishSignIn(res, url);
  if (url.pathname === "/v1/auth/browser/sign-out" && method === "POST") {
    const session = sessionOf(req);
    if (session !== undefined && sameText(String(req.headers["x-rovara-csrf"] ?? ""), session.csrf)) {
      for (const [id, value] of sessions) if (value === session) sessions.delete(id);
    }
    return send(res, 204, "", { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
  }
  if (url.pathname.startsWith("/v1/web/")) {
    const session = sessionOf(req);
    if (session === undefined) return send(res, 401, { error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } });
    if (method !== "GET" && method !== "HEAD" && !sameText(String(req.headers["x-rovara-csrf"] ?? ""), session.csrf)) return send(res, 403, { error: { code: "CSRF_INVALID", message: "Refresh the page and try again." } });
    if (url.pathname === "/v1/web/me" && method === "GET") return send(res, 200, me(session));
    if (url.pathname === "/v1/web/nav" && method === "GET") {
      // Step 2: projects come from Rovara Code each time, so a grant or revoke shows on the next load.
      const fresh = await accessCheck(session.accessToken);
      if (fresh === undefined) return send(res, 401, { error: { code: "AUTH_REQUIRED", message: "Your Rovara sign-in ended. Sign in again." } });
      session.access = fresh;
      return send(res, 200, nav(session));
    }
    if (url.pathname === "/v1/web/home" && method === "GET") return send(res, 200, { cards: [], total: 0 });
    console.log(JSON.stringify({ event: "not_in_prototype", method, path: url.pathname }));
    return notBuilt(res, url.pathname.replace("/v1/web/", "/v1/app/"));
  }
  if (url.pathname === "/app" || url.pathname.startsWith("/app/") || url.pathname.startsWith("/s/")) {
    const answer = await app({ rawPath: url.pathname, headers: req.headers as Record<string, string | undefined>, requestContext: { http: { method } } });
    const headers = Object.fromEntries(Object.entries(answer.headers ?? {}).filter(([name]) => name.toLowerCase() !== "strict-transport-security")) as Record<string, string>;
    res.writeHead(answer.statusCode, headers);
    res.end(answer.isBase64Encoded === true ? Buffer.from(answer.body, "base64") : answer.body);
    return;
  }
  send(res, 404, "Not found");
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) send(res, 500, "The prototype failed; see its terminal.");
  });
}).listen(PORT, "127.0.0.1", () => console.log(`Rovara Cloud prototype on http://127.0.0.1:${PORT}/app, signing in through ${CODE} as ${CLIENT_ID}`));
