// Guided onboarding PR 11 (designs-2026-10-30/guided-onboarding-design.md section 3d; DEC 254k, 254l items 2 and 5): "Connect Linear" and a project's Linear
// team, Cloud's side. Rovara Code (PR #838) owns the state, the PKCE verifier, the exchange, the binding, the tokens and every role check; Cloud carries the
// person through Linear bound to their browser and their Cloud sign-in (connect-flow.ts), and shows Code's answers in its own fixed words.
//
//   POST   /v1/app/linear/connect           {} | {back}   Code's connect as the person; Linear's consent address; the cookie binding
//   GET    /api/connect/linear/callback                   where Linear sends the person back (the redirect URL in Code's Linear app secret)
//   POST   /v1/app/linear/connect/result                  the callback's outcome, kept server-side for this sign-in
//   GET    /v1/app/linear                                 the company's connection (any member)
//   DELETE /v1/app/linear                                 company owner only (the Connections page, PR 12b)
//   GET    /v1/app/projects/{p}/linear                    the project's team and the teams the company's token sees
//   PUT    /v1/app/projects/{p}/linear      {teamId}      pick the project's team
//   DELETE /v1/app/projects/{p}/linear                    clear it
//
// Rules: as slack-connect.ts. Linear's authorize address must come back to THIS Cloud's callback (the redirect_uri Code put in it), so a misconfigured app
// secret refuses at start instead of sending the person's code elsewhere.
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import {
  CONNECT_SECRET, NOT_IN_COMPANY_WORDS, PROJECT_NAME, askAsBound, codeRefusal, connectCallbackPath, connectRefusal, createConnectFlow, displayName, isObject, liveMembership,
  oneValue, companyOwnerOnly, startBody, type ConnectAnswer,
} from "./connect-flow.js";
import type { CodeSession, SessionStore } from "./sessions.js";

export const LINEAR_CALLBACK_PATH = connectCallbackPath("linear");
const CODE_LINEAR = "/v1/dev/company/linear";

/** Code's fixed sentences (PR #838 linear-connect-routes.ts, linear-connections.ts), and Cloud's own. */
export const LINEAR_WORDS = Object.freeze({
  adminOnly: "Only a company owner or admin can connect Linear.",
  ownerOnly: "Only a company owner can disconnect Linear.",
  notSetUp: "Connecting Linear isn't set up on this Rovara yet. Ask the Rovara team.",
  notAvailable: "Connecting Linear isn't available yet.",
  startAgain: "Start again from Rovara.",
  cancelled: "Linear wasn't connected. You can connect it any time.",
  unavailable: "Linear could not be connected just now. Start again from Rovara.",
  statusUnavailable: "The company's Linear connection could not be read just now; try again.",
  disconnectUnavailable: "Linear could not be disconnected just now; try again.",
  taken: "This Linear workspace is already connected to a different Rovara company.",
  otherWorkspace: "This company is already connected to another Linear workspace. A company owner can disconnect it first, then connect again.",
  notConnected: "Linear isn't connected for this company. A company owner or admin can connect it in Company settings, Connections.",
  needsReconnect: "Linear needs reconnecting. A company owner or admin can reconnect it in Company settings, Connections.",
  teamAdminOnly: "Only a company owner or admin, or the project's admin, can choose its Linear team.",
  teamNotFound: "That Linear team was not found in the company's Linear workspace.",
  teamsUnavailable: "Linear's teams could not be read just now; try again.",
  pickTeam: "Pick a team from the list.",
  noDetails: "Connecting Linear takes no details.",
  projectNotFound: "That project doesn't exist, or you can't use it.",
});

/** The one word the callback's landing URL carries. */
export const LINEAR_OUTCOMES = ["result", "cancelled", "start_again", "taken", "other_workspace", "unavailable", "not_set_up", "not_available"] as const;
type Outcome = (typeof LINEAR_OUTCOMES)[number];

const LINEAR_ID = /^[A-Za-z0-9-]{1,100}$/u;
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}$/u;
const URL_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const LINEAR_CLIENT_ID = /^[A-Za-z0-9]{1,64}$/u;
const LINEAR_SCOPE = /^[a-z:]{1,40}(?:,[a-z:]{1,40}){0,9}$/u;
const LINEAR_CODE = /^[A-Za-z0-9._~-]{1,512}$/u;
const TEAMS_MAX = 250;
const PROJECTS_MAX = 500;
const AUTHORIZE_KEYS = ["actor", "client_id", "code_challenge", "code_challenge_method", "prompt", "redirect_uri", "response_type", "scope", "state"];

const notAvailable = (status: number) => status === 404 || status === 405 || status === 501;

/** Code's connect answer, checked: Linear's consent page acting as the app, with exactly Code's state, PKCE S256 and this Cloud's callback. */
function connectAnswer(body: unknown, redirectUri: string): { state: string; authorizeUrl: string; expiresAt: string } | undefined {
  if (!isObject(body)) return undefined;
  const { state, authorizeUrl, expiresAt } = body;
  if (typeof state !== "string" || !CONNECT_SECRET.test(state) || typeof authorizeUrl !== "string" || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  try {
    const url = new URL(authorizeUrl);
    if (url.origin !== "https://linear.app" || url.pathname !== "/oauth/authorize" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    const q = url.searchParams;
    if ([...q.keys()].sort().join(",") !== AUTHORIZE_KEYS.join(",")) return undefined;
    if (q.get("state") !== state || q.get("redirect_uri") !== redirectUri || q.get("response_type") !== "code" || q.get("actor") !== "app" || q.get("prompt") !== "consent"
      || q.get("code_challenge_method") !== "S256" || !CONNECT_SECRET.test(q.get("code_challenge")!) || !LINEAR_CLIENT_ID.test(q.get("client_id")!) || !LINEAR_SCOPE.test(q.get("scope")!)) return undefined;
    const clean = new URL("https://linear.app/oauth/authorize");
    for (const key of AUTHORIZE_KEYS) clean.searchParams.set(key, q.get(key)!);
    return { state, authorizeUrl: clean.toString(), expiresAt };
  } catch {
    return undefined;
  }
}

function workspaceOf(value: unknown): { name: string; urlKey: string } | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !LINEAR_ID.test(value.id) || typeof value.urlKey !== "string" || !URL_KEY.test(value.urlKey)) return undefined;
  const name = displayName(value.name);
  return name === undefined ? undefined : { name, urlKey: value.urlKey };
}

function teamOf(value: unknown): { id: string; key: string; name: string } | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !LINEAR_ID.test(value.id) || typeof value.key !== "string" || !TEAM_KEY.test(value.key)) return undefined;
  const name = displayName(value.name);
  return name === undefined ? undefined : { id: value.id, key: value.key, name };
}

function completeOutcome(error: CodeError): Exclude<Outcome, "result" | "cancelled"> {
  const { message } = codeRefusal(error.body);
  if (error.status === 403) return "start_again";
  if (error.status === 409) return message === LINEAR_WORDS.otherWorkspace ? "other_workspace" : "taken";
  if (notAvailable(error.status)) return "not_available";
  if (error.status === 503 && message === LINEAR_WORDS.notSetUp) return "not_set_up";
  return "unavailable";
}

/** Code's project-team refusals in Cloud's words. */
function teamRefusal(error: CodeError): ConnectAnswer {
  const { code, message } = codeRefusal(error.body);
  if (error.status === 403) return connectRefusal(403, "FORBIDDEN", LINEAR_WORDS.teamAdminOnly);
  if (error.status === 404) {
    if (message === LINEAR_WORDS.teamNotFound) return connectRefusal(404, "NOT_FOUND", LINEAR_WORDS.teamNotFound);
    return connectRefusal(404, "NOT_FOUND", message === "project not found" ? LINEAR_WORDS.projectNotFound : LINEAR_WORDS.notAvailable);
  }
  if (notAvailable(error.status)) return connectRefusal(404, "NOT_FOUND", LINEAR_WORDS.notAvailable);
  if (error.status === 409 && code === "LINEAR_NOT_CONNECTED") return connectRefusal(409, "LINEAR_NOT_CONNECTED", message === LINEAR_WORDS.needsReconnect ? LINEAR_WORDS.needsReconnect : LINEAR_WORDS.notConnected);
  if (error.status === 400) return connectRefusal(400, "CONFIG_INVALID", LINEAR_WORDS.pickTeam);
  return connectRefusal(503, "RUNTIME_UNAVAILABLE", LINEAR_WORDS.teamsUnavailable);
}

const teamsUnreadable = () => connectRefusal(503, "RUNTIME_UNAVAILABLE", LINEAR_WORDS.teamsUnavailable);

export interface LinearConnectDeps {
  client: CodeClient;
  store: SessionStore;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
  secureCookies: boolean;
  /** The app's own origin: Linear must send the person back to `<origin>/api/connect/linear/callback`. */
  origin: string;
}

export function createLinearConnect(deps: LinearConnectDeps) {
  const flow = createConnectFlow({ provider: "linear", store: deps.store, now: deps.now, secureCookies: deps.secureCookies });
  const redirectUri = `${new URL(deps.origin).origin}${LINEAR_CALLBACK_PATH}`;

  async function ask(session: CodeSession, path: string, init: { method?: string; body?: unknown }, refuse: (error: CodeError) => ConnectAnswer, read: (body: unknown) => ConnectAnswer): Promise<ConnectAnswer> {
    let answer: unknown;
    try {
      answer = await deps.client.json<unknown>(session, path, init);
    } catch (error) {
      if (!(error instanceof CodeError)) throw error;
      return refuse(error);
    }
    return read(answer);
  }
  const projectPath = (project: string) => `${CODE_LINEAR}/projects/${encodeURIComponent(project)}`;
  const badProject = () => connectRefusal(404, "NOT_FOUND", LINEAR_WORDS.projectNotFound);

  const routes = {
    /** POST /v1/app/linear/connect: Code's connect as the person, the cookie binding, and Linear's consent address. */
    async start(session: CodeSession, sessionCookie: string, body: unknown): Promise<ConnectAnswer> {
      const start = startBody(body);
      if (start === undefined) return connectRefusal(400, "CONFIG_INVALID", LINEAR_WORDS.noDetails);
      if (await liveMembership(deps.client, session) === undefined) return connectRefusal(403, "NO_COMPANY", NOT_IN_COMPANY_WORDS);
      let answer: unknown;
      try {
        answer = await deps.client.json<unknown>(session, `${CODE_LINEAR}/connect`, { method: "POST", body: {} });
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        if (error.status === 403) return connectRefusal(403, "FORBIDDEN", LINEAR_WORDS.adminOnly);
        if (notAvailable(error.status)) return connectRefusal(404, "NOT_FOUND", LINEAR_WORDS.notAvailable);
        return connectRefusal(503, "RUNTIME_UNAVAILABLE", error.status === 503 && codeRefusal(error.body).message === LINEAR_WORDS.notSetUp ? LINEAR_WORDS.notSetUp : LINEAR_WORDS.unavailable);
      }
      const checked = connectAnswer(answer, redirectUri);
      if (checked === undefined) {
        deps.log({ event: "cloud.linear_connect_unreadable", developerId: session.access.developerId });
        return connectRefusal(503, "RUNTIME_UNAVAILABLE", LINEAR_WORDS.unavailable);
      }
      const setCookie = await flow.bind(session, sessionCookie, checked.state, start.back);
      deps.log({ event: "cloud.linear_connect_started", developerId: session.access.developerId });
      return { status: 200, body: { authorizeUrl: checked.authorizeUrl, expiresAt: checked.expiresAt }, setCookie };
    },

    /** POST /v1/app/linear/connect/result: this sign-in's kept outcome, once. */
    async result(session: CodeSession, sessionCookie: string): Promise<ConnectAnswer> {
      const taken = await flow.takeResult(session, sessionCookie);
      return { status: 200, body: taken === undefined ? { status: "none" } : taken.result };
    },

    /** GET /v1/app/linear: the company's connection as Code reads it for any member. Never a token or a person id. */
    async status(session: CodeSession): Promise<ConnectAnswer> {
      const failed = connectRefusal(503, "RUNTIME_UNAVAILABLE", LINEAR_WORDS.statusUnavailable);
      return ask(session, CODE_LINEAR, {}, (error) => notAvailable(error.status) ? connectRefusal(404, "NOT_FOUND", LINEAR_WORDS.notAvailable) : failed, (answer) => {
        if (!isObject(answer)) return failed;
        if (answer.status === "disconnected" && answer.workspace === undefined) return { status: 200, body: { status: "disconnected" } };
        if (answer.status !== "connected" && answer.status !== "needs_reconnect" && answer.status !== "disconnected") return failed;
        const workspace = workspaceOf(answer.workspace);
        if (workspace === undefined || typeof answer.connectedAt !== "string" || !Number.isFinite(Date.parse(answer.connectedAt)) || !isObject(answer.connectedBy)) return failed;
        const name = displayName(answer.connectedBy.name);
        return { status: 200, body: { status: answer.status, workspace, connectedAt: answer.connectedAt, connectedBy: name === undefined ? {} : { name } } };
      });
    },

    /** DELETE /v1/app/linear: company owner here first, then Code's disconnect (which checks it again). */
    async disconnect(session: CodeSession): Promise<ConnectAnswer> {
      const refused = await companyOwnerOnly(deps.client, session, LINEAR_WORDS.ownerOnly);
      if (refused !== undefined) return refused;
      const failed = connectRefusal(503, "RUNTIME_UNAVAILABLE", LINEAR_WORDS.disconnectUnavailable);
      const answer = await ask(session, CODE_LINEAR, { method: "DELETE" }, (error) => {
        const { code } = codeRefusal(error.body);
        if (error.status === 403) return connectRefusal(403, "FORBIDDEN", LINEAR_WORDS.ownerOnly);
        if (error.status === 409 && code === "LINEAR_NOT_CONNECTED") return connectRefusal(409, "LINEAR_NOT_CONNECTED", LINEAR_WORDS.notConnected);
        if (notAvailable(error.status)) return connectRefusal(404, "NOT_FOUND", LINEAR_WORDS.notAvailable);
        return failed;
      }, (body) => {
        const workspaceName = isObject(body) ? displayName(body.workspaceName) : undefined;
        if (!isObject(body) || body.status !== "disconnected" || workspaceName === undefined || !Array.isArray(body.projects) || body.projects.length > PROJECTS_MAX
          || !body.projects.every((name) => typeof name === "string" && PROJECT_NAME.test(name))) return failed;
        return { status: 200, body: { status: "disconnected", workspaceName, projects: body.projects } };
      });
      if (answer.status === 200) deps.log({ event: "cloud.linear_disconnected", developerId: session.access.developerId });
      return answer;
    },

    /** GET /v1/app/projects/{p}/linear: the project's team and the teams to pick from. */
    async projectTeam(session: CodeSession, project: string): Promise<ConnectAnswer> {
      if (!PROJECT_NAME.test(project)) return badProject();
      return ask(session, projectPath(project), {}, teamRefusal, (answer) => {
        if (!isObject(answer) || !Array.isArray(answer.teams) || answer.teams.length > TEAMS_MAX) return teamsUnreadable();
        const teams = [];
        for (const row of answer.teams as unknown[]) {
          const team = teamOf(row);
          if (team === undefined) return teamsUnreadable();
          teams.push(team);
        }
        const team = answer.team === null ? null : teamOf(answer.team);
        if (team === undefined) return teamsUnreadable();
        return { status: 200, body: { team, teams } };
      });
    },

    /** PUT /v1/app/projects/{p}/linear {teamId}: one of the teams the company's own token sees (Code checks). */
    async pickTeam(session: CodeSession, project: string, body: unknown): Promise<ConnectAnswer> {
      if (!PROJECT_NAME.test(project)) return badProject();
      if (!isObject(body) || Object.keys(body).length !== 1 || typeof body.teamId !== "string" || !LINEAR_ID.test(body.teamId)) return connectRefusal(400, "CONFIG_INVALID", LINEAR_WORDS.pickTeam);
      const answer = await ask(session, projectPath(project), { method: "PUT", body: { teamId: body.teamId } }, teamRefusal, (value) => {
        const team = isObject(value) ? teamOf(value.team) : undefined;
        return team === undefined ? teamsUnreadable() : { status: 200, body: { team } };
      });
      if (answer.status === 200) deps.log({ event: "cloud.linear_team_picked", developerId: session.access.developerId });
      return answer;
    },

    /** DELETE /v1/app/projects/{p}/linear: clears the project's team. */
    async clearTeam(session: CodeSession, project: string): Promise<ConnectAnswer> {
      if (!PROJECT_NAME.test(project)) return badProject();
      return ask(session, projectPath(project), { method: "DELETE" }, teamRefusal, (value) =>
        isObject(value) && value.team === null && typeof value.cleared === "boolean" ? { status: 200, body: { team: null, cleared: value.cleared } } : teamsUnreadable());
    },
  };

  return {
    ...routes,

    /**
     * GET /api/connect/linear/callback: Linear's return. The cookie's binding is taken (once) and must name this state, this sign-in and this person; the cookie
     * is cleared; Code's complete is asked as the person with Linear's `code` only. Linear's `error` (the person pressed Cancel) asks Code nothing.
     */
    async callback(query: URLSearchParams, cookieBinder: string | undefined, sessionCookie: string | undefined): Promise<{ location: string; setCookie: string }> {
      const bound = await flow.take(query, cookieBinder, sessionCookie);
      const refuse = (reason: string, back = "/app/onboard", word: Exclude<Outcome, "result"> = "start_again") => {
        deps.log({ event: "cloud.linear_callback_refused", reason });
        return { location: flow.landing(back, word), setCookie: flow.clearCookie };
      };
      if (!bound.ok) return refuse(bound.reason);
      const code = oneValue(query, "code"), error = oneValue(query, "error");
      if (code === null || error === null || (code === undefined) === (error === undefined)) return refuse("query", bound.back);
      if (error !== undefined) return error === "access_denied" ? refuse("cancelled", bound.back, "cancelled") : refuse("query", bound.back);
      if (code === undefined || !LINEAR_CODE.test(code)) return refuse("query", bound.back);
      let session = bound.session;
      try {
        let answer: unknown;
        try {
          ({ answer, session } = await askAsBound(deps.client, deps.store, bound, `${CODE_LINEAR}/complete`, { state: bound.state, code }));
        } catch (failure) {
          if (!(failure instanceof CodeError)) throw failure;
          deps.log({ event: "cloud.linear_connect_refused", developerId: session.access.developerId, status: failure.status });
          return { location: flow.landing(bound.back, completeOutcome(failure)), setCookie: flow.clearCookie };
        }
        const workspace = isObject(answer) ? workspaceOf(answer.workspace) : undefined;
        if (!isObject(answer) || answer.status !== "connected" || typeof answer.reconnected !== "boolean" || workspace === undefined) {
          deps.log({ event: "cloud.linear_connect_unreadable", developerId: session.access.developerId });
          return { location: flow.landing(bound.back, "unavailable"), setCookie: flow.clearCookie };
        }
        deps.log({ event: "cloud.linear_connected", developerId: session.access.developerId, reconnected: answer.reconnected });
        if (session.changed === true) {
          delete session.changed;
          await deps.store.save(bound.sessionCookie, session);
        }
        await flow.keep(bound.sessionCookie, session.access.developerId, bound.back, { status: "connected", reconnected: answer.reconnected, workspaceName: workspace.name, urlKey: workspace.urlKey });
        return { location: flow.landing(bound.back, "result"), setCookie: flow.clearCookie };
      } catch (failure) {
        if (!(failure instanceof SignInEnded)) throw failure;
        await deps.store.delete(bound.sessionCookie);
        return refuse("signed_out", bound.back);
      }
    },

    /** The app routes this module answers (paths after /v1/web), or undefined. */
    route(method: string, apiPath: string): ((session: CodeSession, sessionCookie: string, body: unknown) => Promise<ConnectAnswer>) | undefined {
      if (method === "POST" && apiPath === "/linear/connect") return (session, id, body) => routes.start(session, id, body);
      if (method === "POST" && apiPath === "/linear/connect/result") return (session, id) => routes.result(session, id);
      if (method === "GET" && apiPath === "/linear") return (session) => routes.status(session);
      if (method === "DELETE" && apiPath === "/linear") return (session) => routes.disconnect(session);
      const match = /^\/projects\/([^/]{1,200})\/linear$/u.exec(apiPath);
      if (match === null) return undefined;
      let project: string;
      try { project = decodeURIComponent(match[1]!); } catch { return () => Promise.resolve(badProject()); }
      if (method === "GET") return (session) => routes.projectTeam(session, project);
      if (method === "PUT") return (session, _id, body) => routes.pickTeam(session, project, body);
      if (method === "DELETE") return (session) => routes.clearTeam(session, project);
      return undefined;
    },
  };
}

export type LinearConnect = ReturnType<typeof createLinearConnect>;
