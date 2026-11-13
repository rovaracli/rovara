// Prototype (PrepLabsAI/Rovara-cloud#1): the Rovara Cloud web app on its own, signing people in through a Rovara Code
// install as a registered sign-in client (spec 063) and answering the app's /v1/web API from it. One feature at a time;
// everything not built yet answers 501 so the screen says so.
//
//   ROVARA_CODE_URL=https://<api> ROVARA_CLIENT_ID=rovara-cloud ROVARA_CLIENT_SECRET_FILE=<file> npx tsx prototype/server.ts
//
// Sessions live in memory: restarting the server signs everyone out.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
// Spec 065: what Cloud asks to do as the signed-in person; Rovara Code keeps only what its registration allows.
const SCOPES = process.env.ROVARA_SCOPES ?? "projects:members projects:create";

interface Access { developerId: string; displayName: string; administrator: boolean; projects: Array<{ name: string; access: string }>; notices: string[] }
interface Session { accessToken: string; refreshToken?: string; access: Access; csrf: string; signedInAt: string; /** Onboarding creations by requestId, so a retried request answers the same project. */ created?: Record<string, { name: string; at: string }> }
const pendingSignIns = new Map<string, { verifier: string; returnTo: string; at: number }>();
// Kept in a private file when PROTOTYPE_SESSIONS_FILE is set, so restarting the prototype keeps people signed in.
const SESSIONS_FILE = process.env.PROTOTYPE_SESSIONS_FILE;
const sessions = new Map<string, Session>(SESSIONS_FILE === undefined ? [] : loadSessions(SESSIONS_FILE));
function loadSessions(file: string): Array<[string, Session]> {
  try { return Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, Session>); } catch { return []; }
}
function saveSessions(): void {
  if (SESSIONS_FILE !== undefined) writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
}

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
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, state, scope: SCOPES,
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
  saveSessions();
  console.log(JSON.stringify({ event: "signed_in", developerId: access.developerId, projects: access.projects.length }));
  redirect(res, pending.returnTo, { "set-cookie": `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/` });
}

/** Spec 063 FR-004: who the person is and what they can use, with their own token for this client. */
async function accessCheck(accessToken: string): Promise<Access | undefined> {
  const response = await fetch(`${CODE}/v1/dev/access`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: "{}" });
  return response.ok ? await response.json() as Access : undefined;
}

/** A new access token from the session's refresh token (tokens last an hour); false when the sign-in has ended. */
async function refresh(session: Session): Promise<boolean> {
  if (session.refreshToken === undefined) return false;
  const response = await fetch(`${CODE}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: session.refreshToken }),
  });
  const tokens = await response.json() as { access_token?: string; refresh_token?: string };
  if (!response.ok || tokens.access_token === undefined) return false;
  session.accessToken = tokens.access_token;
  if (tokens.refresh_token !== undefined) session.refreshToken = tokens.refresh_token;
  saveSessions();
  return true;
}

/** A call to Rovara Code as the person, refreshing their token once when it has expired. */
async function codeFetch(session: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const call = () => fetch(`${CODE}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${session.accessToken}` } });
  const first = await call();
  return first.status === 401 && await refresh(session) ? call() : first;
}

/** The access check as the person, refreshing first when needed; undefined when their sign-in has ended. */
async function freshAccess(session: Session): Promise<Access | undefined> {
  const response = await codeFetch(session, "/v1/dev/access", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!response.ok) return undefined;
  session.access = await response.json() as Access;
  return session.access;
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

/** A project's role for the person, from Rovara Code's access: an administrator maintains it, anyone else contributes. */
function roleOf(access: string): "maintainer" | "contributor" {
  return access === "administrator" ? "maintainer" : "contributor";
}

/**
 * GET /v1/app/projects/{name}/overview (ProjectOverviewSchema), from what the access check says. Repositories, setup
 * and channels need Rovara Code's project read (next step); until then they are empty.
 */
interface CodeProject { latestRevision: number; repositories: Array<{ name: string; defaultBranch: string; fullName?: string }> }

/** Spec 065: the project as Rovara Code answers it for this person; undefined while that route isn't there. */
async function codeProject(session: Session, name: string): Promise<CodeProject | undefined> {
  const response = await codeFetch(session, `/v1/dev/client/projects/${encodeURIComponent(name)}`);
  return response.ok ? await response.json() as CodeProject : undefined;
}

/** Spec 065b: the GitHub accounts Rovara Code's GitHub App is installed on, and the repositories each lets it reach. */
interface CodeRepositories {
  installations: Array<{ installationId: number; accountLogin: string; accountType: string; repositorySelection: string; status: string; repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string }> }>;
}

/** The repositories the person's projects already use (owner/name, lowercase), to mark them in the picker. */
async function usedRepositories(session: Session): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  for (const project of session.access.projects) {
    for (const repository of (await codeProject(session, project.name))?.repositories ?? []) {
      if (repository.fullName !== undefined) used.set(repository.fullName.toLowerCase(), project.name);
    }
  }
  return used;
}

/** A project as the app's admin screens list it (AppProjectSummarySchema). */
async function summary(session: Session, name: string, access: string) {
  const code = await codeProject(session, name);
  return {
    name, status: "active", latestRevision: code?.latestRevision ?? 1, myRole: roleOf(access), setup: { status: "unchecked" },
    repositories: (code?.repositories ?? []).map((repository) => ({ name: repository.name, fullName: repository.fullName ?? repository.name, defaultBranch: repository.defaultBranch })),
  };
}

const ROLE_OF_MEMBER: Record<string, string> = { administrator: "maintainer", developer: "contributor" };

function overview(session: Session, name: string, code: CodeProject | undefined) {
  const project = session.access.projects.find((entry) => entry.name === name);
  if (project === undefined) return undefined;
  const role = roleOf(project.access);
  const repositories = (code?.repositories ?? []).slice(0, 20).map((repository) => ({ fullName: repository.fullName ?? repository.name, defaultBranch: repository.defaultBranch }));
  return {
    project: { name, status: "active", ...(code === undefined ? {} : { latestRevision: code.latestRevision }), repositories, setup: { status: "unchecked" }, channels: [] },
    you: { role, canStartWork: true, canEditSettings: role === "maintainer", canViewSpend: false },
    agents: [],
    running: [],
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
    features: { localAgents: false, usage: false, admin: session.access.administrator, chains: false, notices: false, describe: false },
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
      saveSessions();
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
      if (await freshAccess(session) === undefined) return send(res, 401, { error: { code: "AUTH_REQUIRED", message: "Your Rovara sign-in ended. Sign in again." } });
      return send(res, 200, nav(session));
    }
    if (url.pathname === "/v1/web/home" && method === "GET") return send(res, 200, { cards: [], total: 0 });
    const overviewPath = /^\/v1\/web\/projects\/([^/]+)\/overview$/.exec(url.pathname);
    if (overviewPath !== null && method === "GET") {
      if (await freshAccess(session) === undefined) return send(res, 401, { error: { code: "AUTH_REQUIRED", message: "Your Rovara sign-in ended. Sign in again." } });
      const name = decodeURIComponent(overviewPath[1]!);
      const answer = overview(session, name, await codeProject(session, name));
      return answer === undefined ? send(res, 404, { error: { code: "PROJECT_NOT_FOUND", message: "That project doesn't exist, or you can't use it." } }) : send(res, 200, answer);
    }
    const ended = () => send(res, 401, { error: { code: "AUTH_REQUIRED", message: "Your Rovara sign-in ended. Sign in again." } });
    // Step 4 (spec 065b): onboarding creates a project in Rovara Code from a repository its GitHub App can reach.
    if ((url.pathname === "/v1/web/github/installations" || url.pathname === "/v1/web/github/repositories") && method === "GET") {
      const response = await codeFetch(session, "/v1/dev/client/repositories");
      const body = await response.json() as CodeRepositories & { error?: unknown };
      if (!response.ok) return send(res, response.status, body);
      if (url.pathname === "/v1/web/github/installations") {
        return send(res, 200, { installations: body.installations.map(({ repositories: _, ...installation }) => installation) });
      }
      const installation = body.installations.find((entry) => String(entry.installationId) === url.searchParams.get("installation"));
      if (installation === undefined) return send(res, 404, { error: { code: "NOT_FOUND", message: "That GitHub account isn't connected." } });
      const used = await usedRepositories(session);
      return send(res, 200, { repositories: installation.repositories.map((repository) => ({ ...repository, ...(used.has(repository.fullName.toLowerCase()) ? { project: used.get(repository.fullName.toLowerCase()) } : {}) })) });
    }
    if (url.pathname === "/v1/web/projects" && method === "POST") {
      const body = JSON.parse(await readBody(req) || "{}") as { requestId?: string; repository?: string; name?: string; setupCommand?: string; testCommand?: string; setupCommands?: string[]; testCommands?: string[] };
      const earlier = body.requestId === undefined ? undefined : session.created?.[body.requestId];
      if (earlier !== undefined) return send(res, 200, { duplicate: true, project: { definition: { name: earlier.name }, registeredAt: earlier.at } });
      const list = (single?: string, many?: string[]) => many ?? (single?.trim() ? [single.trim()] : undefined);
      const setupCommands = list(body.setupCommand, body.setupCommands), testCommands = list(body.testCommand, body.testCommands);
      const response = await codeFetch(session, "/v1/dev/client/projects", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repository: body.repository, ...(body.name ? { name: body.name } : {}), ...(setupCommands ? { setupCommands } : {}), ...(testCommands ? { testCommands } : {}) }),
      });
      const created = await response.json() as { name?: string; error?: unknown };
      if (!response.ok || created.name === undefined) return send(res, response.ok ? 502 : response.status, created);
      const at = new Date().toISOString();
      if (body.requestId !== undefined) { session.created = { ...session.created, [body.requestId]: { name: created.name, at } }; saveSessions(); }
      return send(res, 201, { duplicate: false, project: { definition: { name: created.name }, registeredAt: at } });
    }
    if (url.pathname === "/v1/web/projects" && method === "GET") {
      const access = await freshAccess(session);
      if (access === undefined) return ended();
      return send(res, 200, { projects: await Promise.all(access.projects.map((project) => summary(session, project.name, project.access))) });
    }
    const projectPath = /^\/v1\/web\/projects\/([^/]+)(\/members(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (projectPath !== null) {
      const access = await freshAccess(session);
      if (access === undefined) return ended();
      const name = decodeURIComponent(projectPath[1]!);
      const mine = access.projects.find((project) => project.name === name);
      if (mine === undefined) return send(res, 404, { error: { code: "PROJECT_NOT_FOUND", message: "That project doesn't exist, or you can't use it." } });
      if (projectPath[2] === undefined && method === "GET") {
        return send(res, 200, { ...await summary(session, name, mine.access), settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "", createdBy: { developerId: "", name: "" } });
      }
      const members = `/v1/dev/client/projects/${encodeURIComponent(name)}/members`;
      if (projectPath[3] === undefined && method === "GET") {
        const response = await codeFetch(session, members);
        const body = await response.json() as { members?: Array<{ developerId: string; name: string; role: string }>; error?: { code: string; message: string } };
        if (!response.ok) return send(res, response.status, body);
        return send(res, 200, { members: (body.members ?? []).map((member) => ({ developerId: member.developerId, name: member.name, role: ROLE_OF_MEMBER[member.role] ?? "contributor", source: "grant" })) });
      }
      if (projectPath[3] !== undefined && (method === "PUT" || method === "DELETE")) {
        const who = decodeURIComponent(projectPath[3]);
        if (method === "PUT") {
          const body = JSON.parse(await readBody(req) || "{}") as { role?: string };
          // Rovara Code grants contributors; maintainers are a project's administrators, made there.
          if (body.role !== undefined && body.role !== "contributor") return send(res, 400, { error: { code: "CONFIG_INVALID", message: "Only contributors can be added here for now." } });
        }
        const response = await codeFetch(session, `${members}/${encodeURIComponent(who)}`, { method });
        const answer = await response.json() as { developerId?: string; outcome?: string; error?: unknown };
        if (!response.ok) return send(res, response.status, answer);
        return method === "PUT"
          ? send(res, 200, { member: { developerId: answer.developerId, role: "contributor" } })
          : send(res, 200, { developerId: answer.developerId, removed: answer.outcome === "revoked" });
      }
    }
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
