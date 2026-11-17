// Guided onboarding PR 11 (designs-2026-10-30/guided-onboarding-design.md sections 3b and 3c; DEC 254k, 254l items 2, 4 and 8): "Add to Slack" and a project's
// Slack channel, Cloud's side. Rovara Code (PR #836 install, PR #840 channels) owns the state, the exchange, the binding and every role check; Cloud carries the
// person through Slack bound to their browser and their Cloud sign-in (connect-flow.ts), and shows Code's answers in its own fixed words.
//
//   POST   /v1/app/slack/install                    {} | {back}   Code's install as the person; Slack's address to go to; the cookie binding
//   GET    /api/connect/slack/callback                            where Slack sends the person back (the Slack app's redirect URL)
//   POST   /v1/app/slack/install/result                           the callback's outcome, kept server-side for this sign-in
//   GET    /v1/app/slack                                          the company's workspace (any member)
//   POST   /v1/app/slack/disconnect                 {}            owner + fresh step-up (the Connections page, PR 12b)
//   GET    /v1/app/slack/channels?project=&cursor=                the channel picker (one Slack page)
//   GET    /v1/app/projects/{p}/slack/channel                     the project's channel
//   PUT    /v1/app/projects/{p}/slack/channel       {channelId}   link (or "invite_needed")
//   POST   /v1/app/projects/{p}/slack/channel/check {channelId}   the "Check" press after /invite
//   DELETE /v1/app/projects/{p}/slack/channel                     unlink
//
// Rules: the browser never names a company (Code reads it live from the person's token); every query value is checked before it reaches Code and none is echoed
// into a page, a URL or a log; Code's and Slack's own words never pass through (answers are rebuilt field by field, refusals are SLACK_WORDS by status and code).
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import {
  CONNECT_SECRET, NOT_IN_COMPANY_WORDS, PROJECT_NAME, askAsBound, codeRefusal, connectCallbackPath, connectRefusal, createConnectFlow, displayName, isObject, liveMembership,
  oneValue, ownerWithFreshStepUp, startBody, type ConnectAnswer,
} from "./connect-flow.js";
import type { CodeSession, SessionStore } from "./sessions.js";

export const SLACK_CALLBACK_PATH = connectCallbackPath("slack");
const CODE_SLACK = "/v1/dev/company/slack";

/** Code's fixed sentences (PR #836 slack-company-install.ts, PR #840 slack-channel-link.ts), and Cloud's own. */
export const SLACK_WORDS = Object.freeze({
  adminOnly: "Only a company owner or admin can add Rovara to Slack.",
  ownerOnly: "Only a company owner can disconnect Slack.",
  notSetUp: "Adding Rovara to Slack isn't set up on this Rovara yet. Ask the Rovara team.",
  notAvailable: "Adding Rovara to Slack isn't available yet.",
  startAgain: "Start again from Rovara.",
  cancelled: "Rovara wasn't added to Slack. You can add it any time.",
  unavailable: "Slack could not be connected just now. Start again from Rovara.",
  readUnavailable: "The company's Slack connection could not be read just now; try again.",
  disconnectUnavailable: "Slack could not be disconnected just now; try again.",
  taken: "This Slack workspace is already connected to another company.",
  otherWorkspace: "This company is already connected to a different Slack workspace. A company owner can disconnect it first.",
  enterprise: "Rovara can be added to one Slack workspace, not to a whole Enterprise Grid organization. Add it to a single workspace.",
  notConnected: "This company has no Slack workspace connected.",
  noDetails: "Adding Rovara to Slack takes no details.",
  // Channels (PR #840).
  linkNotAllowed: "Only a company owner or admin, or this project's admin, can link or unlink its Slack channel.",
  channelNotConnected: "Add Rovara to Slack first: this company has no Slack workspace connected.",
  channelNoToken: "Rovara can't reach your Slack workspace just now. A company owner or admin can add Rovara to Slack again.",
  channelTaken: "This channel is already linked to another project. Unlink it there first.",
  channelShared: "This channel is shared with another organization, so it can't be linked. Pick a channel only your workspace uses.",
  channelArchived: "This channel is archived. Pick another channel.",
  channelRefused: "This channel can't be linked. Pick another channel.",
  invite: "Type `/invite @Rovara` in the channel, then press Check.",
  channelUnavailable: "Slack could not be checked just now; try again.",
  notLinked: "This project has no Slack channel linked.",
  tooMany: "This project has too many linked channels to change here. Unlink some with the CLI first.",
  pickChannel: "Pick a channel from the list.",
  projectNotFound: "That project doesn't exist, or you can't use it.",
});

/** The one word the callback's landing URL carries: the outcome is kept server-side ("result"), or a fixed refusal. */
export const SLACK_OUTCOMES = ["result", "cancelled", "start_again", "taken", "other_workspace", "enterprise", "unavailable", "not_set_up", "not_available"] as const;
type Outcome = (typeof SLACK_OUTCOMES)[number];

const SLACK_TEAM = /^[TE][A-Z0-9]{2,31}$/u;
const SLACK_CHANNEL = /^[CG][A-Z0-9]{2,31}$/u;
const SLACK_CLIENT_ID = /^[0-9]{1,24}\.[0-9]{1,24}$/u;
const SLACK_SCOPES = /^[a-z:._]{1,64}(?:,[a-z:._]{1,64}){0,39}$/u;
const SLACK_CODE = /^[A-Za-z0-9._-]{1,256}$/u;
const SLACK_ERROR = /^[a-z_]{1,64}$/u;
const CHANNEL_NAME = /^[\p{L}\p{N}_.-]{1,80}$/u;
const CURSOR = /^[A-Za-z0-9=+/_-]{1,512}$/u;
const CHANNELS_MAX = 1000;
const PROJECTS_MAX = 500;
const REPLACED_MAX = 10;

const notAvailable = (status: number) => status === 404 || status === 405 || status === 501;

/** Code's install answer, checked: Slack's OAuth v2 page with exactly Code's state, this Cloud's callback, a client id and bot scopes. Undefined otherwise. */
function installAnswer(body: unknown, redirectUri: string): { state: string; authorizeUrl: string; expiresAt: string } | undefined {
  if (!isObject(body)) return undefined;
  const { state, authorizeUrl, expiresAt } = body;
  if (typeof state !== "string" || !CONNECT_SECRET.test(state) || typeof authorizeUrl !== "string" || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) return undefined;
  try {
    const url = new URL(authorizeUrl);
    if (url.origin !== "https://slack.com" || url.pathname !== "/oauth/v2/authorize" || url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    const keys = [...url.searchParams.keys()].sort();
    if (keys.join(",") !== "client_id,redirect_uri,scope,state") return undefined;
    const q = url.searchParams;
    if (!SLACK_CLIENT_ID.test(q.get("client_id")!) || !SLACK_SCOPES.test(q.get("scope")!) || q.get("redirect_uri") !== redirectUri || q.get("state") !== state) return undefined;
    const clean = new URL("https://slack.com/oauth/v2/authorize");
    for (const key of ["client_id", "scope", "redirect_uri", "state"]) clean.searchParams.set(key, q.get(key)!);
    return { state, authorizeUrl: clean.toString(), expiresAt };
  } catch {
    return undefined;
  }
}

/** A Slack workspace as Code names it: a team id, and a name when it reads. */
function workspaceOf(value: unknown): { teamId: string; teamName?: string } | undefined {
  if (!isObject(value) || typeof value.teamId !== "string" || !SLACK_TEAM.test(value.teamId)) return undefined;
  const name = displayName(value.teamName);
  return { teamId: value.teamId, ...(name === undefined ? {} : { teamName: name }) };
}

/** Code's complete answer as Cloud keeps it: names and flags only. Undefined when anything doesn't read. */
function completeAnswer(body: unknown): Record<string, unknown> | "cancelled" | undefined {
  if (!isObject(body)) return undefined;
  if (body.status === "cancelled") return "cancelled";
  if (body.status !== "connected" || typeof body.alreadyConnected !== "boolean") return undefined;
  const workspace = workspaceOf(body.workspace);
  if (workspace === undefined) return undefined;
  const result: Record<string, unknown> = { status: "connected", alreadyConnected: body.alreadyConnected, ...(workspace.teamName === undefined ? {} : { workspaceName: workspace.teamName }) };
  if (body.signedInWorkspace !== undefined) {
    const signedIn = workspaceOf(body.signedInWorkspace);
    if (signedIn === undefined || typeof body.matchesSignIn !== "boolean" || body.matchesSignIn !== (signedIn.teamId === workspace.teamId)) return undefined;
    if (!body.matchesSignIn) result.mismatch = { ...(signedIn.teamName === undefined ? {} : { signedInName: signedIn.teamName }) };
  }
  return result;
}

/** A refusal of Code's complete, as the one fixed word. Code's 401 never gets here (the client refreshes or ends the sign-in). */
function completeOutcome(error: CodeError): Exclude<Outcome, "result" | "cancelled"> {
  const { code, message } = codeRefusal(error.body);
  if (error.status === 403) return message === SLACK_WORDS.enterprise ? "enterprise" : "start_again";
  if (error.status === 409) return code === "SLACK_COMPANY_HAS_WORKSPACE" ? "other_workspace" : "taken";
  if (notAvailable(error.status)) return "not_available";
  if (error.status === 503 && message === SLACK_WORDS.notSetUp) return "not_set_up";
  return "unavailable";
}

/** Code's channel-route refusals in Cloud's words, by status and code (and, between Code's own fixed sentences, by which one it is). */
function channelRefusal(error: CodeError): ConnectAnswer {
  const { code, message } = codeRefusal(error.body);
  if (error.status === 403) return connectRefusal(403, "FORBIDDEN", SLACK_WORDS.linkNotAllowed);
  if (error.status === 404) {
    if (message === SLACK_WORDS.notLinked) return connectRefusal(404, "NOT_FOUND", SLACK_WORDS.notLinked);
    return connectRefusal(404, "NOT_FOUND", code === "NOT_FOUND" && message === "project not found" ? SLACK_WORDS.projectNotFound : SLACK_WORDS.notAvailable);
  }
  if (notAvailable(error.status)) return connectRefusal(404, "NOT_FOUND", SLACK_WORDS.notAvailable);
  if (error.status === 409 && code === "SLACK_NOT_CONNECTED") return connectRefusal(409, "SLACK_NOT_CONNECTED", message === SLACK_WORDS.channelNoToken ? SLACK_WORDS.channelNoToken : SLACK_WORDS.channelNotConnected);
  if (error.status === 409 && code === "SLACK_CHANNEL_TAKEN") return connectRefusal(409, "SLACK_CHANNEL_TAKEN", SLACK_WORDS.channelTaken);
  if (error.status === 409 && code === "SLACK_CHANNEL_REFUSED") {
    return connectRefusal(409, "SLACK_CHANNEL_REFUSED", message === SLACK_WORDS.channelShared ? SLACK_WORDS.channelShared : message === SLACK_WORDS.channelArchived ? SLACK_WORDS.channelArchived : SLACK_WORDS.channelRefused);
  }
  if (error.status === 400) return connectRefusal(400, "CONFIG_INVALID", message === SLACK_WORDS.tooMany ? SLACK_WORDS.tooMany : SLACK_WORDS.pickChannel);
  return connectRefusal(503, "RUNTIME_UNAVAILABLE", SLACK_WORDS.channelUnavailable);
}

function channelView(value: unknown): { id: string; name: string; isPrivate: boolean } | undefined {
  if (!isObject(value) || typeof value.id !== "string" || !SLACK_CHANNEL.test(value.id) || typeof value.name !== "string" || !CHANNEL_NAME.test(value.name) || typeof value.isPrivate !== "boolean") return undefined;
  return { id: value.id, name: value.name, isPrivate: value.isPrivate };
}

const unreadable = () => connectRefusal(503, "RUNTIME_UNAVAILABLE", SLACK_WORDS.channelUnavailable);

/** Code's link answer, rebuilt: linked (the channel, whether it was already, the ids it replaced) or invite_needed with Cloud's fixed sentence. */
function linkAnswer(body: unknown): ConnectAnswer {
  if (!isObject(body)) return unreadable();
  if (body.status === "invite_needed") {
    const channel = isObject(body.channel) && typeof body.channel.id === "string" && SLACK_CHANNEL.test(body.channel.id) ? body.channel.id : undefined;
    return channel === undefined ? unreadable() : { status: 200, body: { status: "invite_needed", channel: { id: channel }, message: SLACK_WORDS.invite } };
  }
  const channel = channelView(body.channel);
  if (body.status !== "linked" || channel === undefined || typeof body.alreadyLinked !== "boolean" || !Array.isArray(body.replaced) || body.replaced.length > REPLACED_MAX
    || !body.replaced.every((id) => typeof id === "string" && SLACK_CHANNEL.test(id))) return unreadable();
  return { status: 200, body: { status: "linked", channel, alreadyLinked: body.alreadyLinked, replaced: body.replaced } };
}

export interface SlackConnectDeps {
  client: CodeClient;
  store: SessionStore;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
  secureCookies: boolean;
  /** The app's own origin (https://…): the Slack app's redirect URL is `<origin>/api/connect/slack/callback`. */
  origin: string;
}

export function createSlackConnect(deps: SlackConnectDeps) {
  const flow = createConnectFlow({ provider: "slack", store: deps.store, now: deps.now, secureCookies: deps.secureCookies });
  const redirectUri = `${new URL(deps.origin).origin}${SLACK_CALLBACK_PATH}`;

  /** Code's call as the person; its refusal goes to `refuse`, which never passes Code's words on. */
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

  const projectPath = (project: string) => `${CODE_SLACK}/projects/${encodeURIComponent(project)}/channel`;
  const badProject = () => connectRefusal(404, "NOT_FOUND", SLACK_WORDS.projectNotFound);
  const linkBody = (body: unknown): string | undefined =>
    isObject(body) && Object.keys(body).length === 1 && typeof body.channelId === "string" && SLACK_CHANNEL.test(body.channelId) ? body.channelId : undefined;

  const routes = {
    /** POST /v1/app/slack/install: Code's install as the person, the cookie binding, and Slack's address. */
    async start(session: CodeSession, sessionCookie: string, body: unknown): Promise<ConnectAnswer> {
      const start = startBody(body);
      if (start === undefined) return connectRefusal(400, "CONFIG_INVALID", SLACK_WORDS.noDetails);
      if (await liveMembership(deps.client, session) === undefined) return connectRefusal(403, "NO_COMPANY", NOT_IN_COMPANY_WORDS);
      let answer: unknown;
      try {
        answer = await deps.client.json<unknown>(session, `${CODE_SLACK}/install`, { method: "POST", body: { redirectUri } });
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        if (error.status === 403) return connectRefusal(403, "FORBIDDEN", SLACK_WORDS.adminOnly);
        if (notAvailable(error.status)) return connectRefusal(404, "NOT_FOUND", SLACK_WORDS.notAvailable);
        return connectRefusal(503, "RUNTIME_UNAVAILABLE", error.status === 503 && codeRefusal(error.body).message === SLACK_WORDS.notSetUp ? SLACK_WORDS.notSetUp : SLACK_WORDS.unavailable);
      }
      const checked = installAnswer(answer, redirectUri);
      if (checked === undefined) {
        deps.log({ event: "cloud.slack_install_unreadable", developerId: session.access.developerId });
        return connectRefusal(503, "RUNTIME_UNAVAILABLE", SLACK_WORDS.unavailable);
      }
      const setCookie = await flow.bind(session, sessionCookie, checked.state, start.back);
      deps.log({ event: "cloud.slack_install_started", developerId: session.access.developerId });
      return { status: 200, body: { authorizeUrl: checked.authorizeUrl, expiresAt: checked.expiresAt }, setCookie };
    },

    /** POST /v1/app/slack/install/result: this sign-in's kept outcome. A workspace other than the sign-in's stays kept (the "Keep it?" question) until it expires. */
    async result(session: CodeSession, sessionCookie: string): Promise<ConnectAnswer> {
      const taken = await flow.takeResult(session, sessionCookie);
      if (taken === undefined) return { status: 200, body: { status: "none" } };
      if (taken.result.mismatch !== undefined) await flow.keep(sessionCookie, session.access.developerId, taken.back, taken.result, taken.at);
      return { status: 200, body: taken.result };
    },

    /** GET /v1/app/slack: the company's workspace as Code reads it for any member. Never a token or a person id. */
    async status(session: CodeSession): Promise<ConnectAnswer> {
      return ask(session, CODE_SLACK, {}, (error) => notAvailable(error.status) ? connectRefusal(404, "NOT_FOUND", SLACK_WORDS.notAvailable) : connectRefusal(503, "RUNTIME_UNAVAILABLE", SLACK_WORDS.readUnavailable), (answer) => {
        const failed = connectRefusal(503, "RUNTIME_UNAVAILABLE", SLACK_WORDS.readUnavailable);
        if (!isObject(answer) || !("workspace" in answer)) return failed;
        if (answer.workspace === null) return { status: 200, body: { workspace: null } };
        const row = answer.workspace;
        const workspace = workspaceOf(row);
        if (workspace === undefined || !isObject(row) || (row.state !== "connected" && row.state !== "disconnected") || typeof row.connectedAt !== "string" || !Number.isFinite(Date.parse(row.connectedAt)) || !isObject(row.connectedBy)) return failed;
        const name = displayName(row.connectedBy.name);
        return { status: 200, body: { workspace: {
          ...(workspace.teamName === undefined ? {} : { teamName: workspace.teamName }), state: row.state, connectedAt: row.connectedAt,
          connectedBy: row.connectedBy.kind === "person" ? { kind: "person", ...(name === undefined ? {} : { name }) } : { kind: "operator" },
        } } };
      });
    },

    /** POST /v1/app/slack/disconnect {}: owner + fresh step-up here first, then Code's disconnect (which checks both again). */
    async disconnect(session: CodeSession, sessionCookie: string, body: unknown): Promise<ConnectAnswer> {
      if (body !== undefined && !(isObject(body) && Object.keys(body).length === 0)) return connectRefusal(400, "CONFIG_INVALID", "Disconnecting Slack takes no details.");
      const refused = await ownerWithFreshStepUp(deps.client, session, deps.now().getTime(), SLACK_WORDS.ownerOnly);
      if (refused !== undefined) return refused;
      return ask(session, `${CODE_SLACK}/disconnect`, { method: "POST", body: {} }, (error) => {
        const { code } = codeRefusal(error.body);
        if (error.status === 403) return code === "REAUTH_REQUIRED" ? connectRefusal(403, "REAUTH_REQUIRED", "Confirm it's you again, then try once more.") : connectRefusal(403, "FORBIDDEN", SLACK_WORDS.ownerOnly);
        if (error.status === 404 && code === "NOT_FOUND") return connectRefusal(404, "NOT_FOUND", SLACK_WORDS.notConnected);
        if (notAvailable(error.status)) return connectRefusal(404, "NOT_FOUND", SLACK_WORDS.notAvailable);
        return connectRefusal(503, "RUNTIME_UNAVAILABLE", SLACK_WORDS.disconnectUnavailable);
      }, (answer) => {
        const workspace = isObject(answer) ? workspaceOf(answer.workspace) : undefined;
        const projects = isObject(answer) && Array.isArray(answer.projectsLosingChannel) && answer.projectsLosingChannel.length <= PROJECTS_MAX
          && answer.projectsLosingChannel.every((name) => typeof name === "string" && PROJECT_NAME.test(name)) ? answer.projectsLosingChannel as string[] : undefined;
        if (!isObject(answer) || answer.status !== "disconnected" || workspace === undefined || projects === undefined) return connectRefusal(503, "RUNTIME_UNAVAILABLE", SLACK_WORDS.disconnectUnavailable);
        return { status: 200, body: { status: "disconnected", ...(workspace.teamName === undefined ? {} : { workspaceName: workspace.teamName }), projectsLosingChannel: projects } };
      }).then(async (answer) => {
        // A kept "Keep it?" question about the workspace just disconnected is answered.
        if (answer.status === 200) {
          await flow.takeResult(session, sessionCookie);
          deps.log({ event: "cloud.slack_disconnected", developerId: session.access.developerId });
        }
        return answer;
      });
    },

    /** GET /v1/app/slack/channels?project=&cursor=: one page of the picker. */
    async channels(session: CodeSession, query: URLSearchParams): Promise<ConnectAnswer> {
      const project = oneValue(query, "project"), cursor = oneValue(query, "cursor");
      if (typeof project !== "string" || !PROJECT_NAME.test(project)) return badProject();
      if (cursor === null || (cursor !== undefined && !CURSOR.test(cursor))) return connectRefusal(400, "CONFIG_INVALID", SLACK_WORDS.pickChannel);
      const search = new URLSearchParams({ project, ...(cursor === undefined ? {} : { cursor }) });
      return ask(session, `${CODE_SLACK}/channels?${search.toString()}`, {}, channelRefusal, (answer) => {
        if (!isObject(answer) || !Array.isArray(answer.channels) || answer.channels.length > CHANNELS_MAX) return unreadable();
        const channels: unknown[] = [];
        for (const row of answer.channels as unknown[]) {
          const channel = channelView(row);
          if (channel === undefined || !isObject(row)) return unreadable();
          const linkedProject = typeof row.linkedProject === "string" && PROJECT_NAME.test(row.linkedProject) ? row.linkedProject : undefined;
          channels.push({ ...channel, ...(row.linked === true ? { linked: true, ...(linkedProject === undefined ? {} : { linkedProject }) } : {}) });
        }
        const next = typeof answer.nextCursor === "string" && CURSOR.test(answer.nextCursor) ? answer.nextCursor : undefined;
        return { status: 200, body: { channels, ...(next === undefined ? {} : { nextCursor: next }) } };
      });
    },

    /** GET /v1/app/projects/{p}/slack/channel: the project's channel ids, and whether the company has a workspace connected. */
    async projectChannel(session: CodeSession, project: string): Promise<ConnectAnswer> {
      if (!PROJECT_NAME.test(project)) return badProject();
      return ask(session, projectPath(project), {}, channelRefusal, (answer) => {
        if (!isObject(answer) || !Array.isArray(answer.channels) || answer.channels.length > REPLACED_MAX + 1) return unreadable();
        const ids: string[] = [];
        for (const row of answer.channels as unknown[]) {
          if (!isObject(row) || typeof row.channelId !== "string" || !SLACK_CHANNEL.test(row.channelId)) return unreadable();
          ids.push(row.channelId);
        }
        const connected = answer.workspace !== null && workspaceOf(answer.workspace) !== undefined;
        return { status: 200, body: { connected, channels: ids.map((id) => ({ id })) } };
      });
    },

    /** PUT /v1/app/projects/{p}/slack/channel {channelId} and POST …/check: link, or "invite_needed". */
    async link(session: CodeSession, project: string, body: unknown, check: boolean): Promise<ConnectAnswer> {
      if (!PROJECT_NAME.test(project)) return badProject();
      const channelId = linkBody(body);
      if (channelId === undefined) return connectRefusal(400, "CONFIG_INVALID", SLACK_WORDS.pickChannel);
      const answer = await ask(session, check ? `${projectPath(project)}/check` : projectPath(project), { method: check ? "POST" : "PUT", body: { channelId } }, channelRefusal, linkAnswer);
      if (answer.status === 200) deps.log({ event: "cloud.slack_channel_linked", developerId: session.access.developerId, outcome: (answer.body as { status: string }).status });
      return answer;
    },

    /** DELETE /v1/app/projects/{p}/slack/channel: unlink (threads already started keep working). */
    async unlink(session: CodeSession, project: string): Promise<ConnectAnswer> {
      if (!PROJECT_NAME.test(project)) return badProject();
      return ask(session, projectPath(project), { method: "DELETE" }, channelRefusal, (answer) => {
        if (!isObject(answer) || answer.status !== "unlinked" || !Array.isArray(answer.channels) || answer.channels.length > REPLACED_MAX
          || !answer.channels.every((id) => typeof id === "string" && SLACK_CHANNEL.test(id))) return unreadable();
        return { status: 200, body: { status: "unlinked", channels: answer.channels } };
      });
    },
  };

  return {
    ...routes,

    /**
     * GET /api/connect/slack/callback: Slack's return. The cookie's binding is taken (once) and must name this state, this sign-in and this person; the cookie
     * is cleared; Code's complete is asked as the person with Slack's `code` (or `error`) only; the outcome is kept server-side.
     */
    async callback(query: URLSearchParams, cookieBinder: string | undefined, sessionCookie: string | undefined): Promise<{ location: string; setCookie: string }> {
      const bound = await flow.take(query, cookieBinder, sessionCookie);
      const refuse = (reason: string, back = "/app/onboard", word: Exclude<Outcome, "result"> = "start_again") => {
        deps.log({ event: "cloud.slack_callback_refused", reason });
        return { location: flow.landing(back, word), setCookie: flow.clearCookie };
      };
      if (!bound.ok) return refuse(bound.reason);
      const code = oneValue(query, "code"), error = oneValue(query, "error");
      if (code === null || error === null || (code === undefined) === (error === undefined)) return refuse("query", bound.back);
      if ((code !== undefined && !SLACK_CODE.test(code)) || (error !== undefined && !SLACK_ERROR.test(error))) return refuse("query", bound.back);
      let session = bound.session;
      try {
        let answer: unknown;
        try {
          ({ answer, session } = await askAsBound(deps.client, deps.store, bound, `${CODE_SLACK}/install/complete`, { state: bound.state, ...(code === undefined ? { error } : { code }) }));
        } catch (failure) {
          if (!(failure instanceof CodeError)) throw failure;
          deps.log({ event: "cloud.slack_install_refused", developerId: session.access.developerId, status: failure.status });
          return { location: flow.landing(bound.back, completeOutcome(failure)), setCookie: flow.clearCookie };
        }
        const checked = completeAnswer(answer);
        if (checked === undefined) {
          deps.log({ event: "cloud.slack_install_unreadable", developerId: session.access.developerId });
          return { location: flow.landing(bound.back, "unavailable"), setCookie: flow.clearCookie };
        }
        if (checked === "cancelled") return { location: flow.landing(bound.back, "cancelled"), setCookie: flow.clearCookie };
        deps.log({ event: "cloud.slack_installed", developerId: session.access.developerId, alreadyConnected: checked.alreadyConnected, matchesSignIn: checked.mismatch === undefined });
        if (session.changed === true) {
          delete session.changed;
          await deps.store.save(bound.sessionCookie, session);
        }
        await flow.keep(bound.sessionCookie, session.access.developerId, bound.back, checked);
        return { location: flow.landing(bound.back, "result"), setCookie: flow.clearCookie };
      } catch (failure) {
        if (!(failure instanceof SignInEnded)) throw failure;
        await deps.store.delete(bound.sessionCookie);
        return refuse("signed_out", bound.back);
      }
    },

    /** The app routes this module answers (paths after /v1/web), or undefined. */
    route(method: string, apiPath: string, query: URLSearchParams): ((session: CodeSession, sessionCookie: string, body: unknown) => Promise<ConnectAnswer>) | undefined {
      if (method === "POST" && apiPath === "/slack/install") return (session, id, body) => routes.start(session, id, body);
      if (method === "POST" && apiPath === "/slack/install/result") return (session, id) => routes.result(session, id);
      if (method === "GET" && apiPath === "/slack") return (session) => routes.status(session);
      if (method === "POST" && apiPath === "/slack/disconnect") return (session, id, body) => routes.disconnect(session, id, body);
      if (method === "GET" && apiPath === "/slack/channels") return (session) => routes.channels(session, query);
      const match = /^\/projects\/([^/]{1,200})\/slack\/channel(\/check)?$/u.exec(apiPath);
      if (match === null) return undefined;
      let project: string;
      try { project = decodeURIComponent(match[1]!); } catch { return () => Promise.resolve(badProject()); }
      if (match[2] !== undefined) return method === "POST" ? (session, _id, body) => routes.link(session, project, body, true) : undefined;
      if (method === "GET") return (session) => routes.projectChannel(session, project);
      if (method === "PUT") return (session, _id, body) => routes.link(session, project, body, false);
      if (method === "DELETE") return (session) => routes.unlink(session, project);
      return undefined;
    },
  };
}

export type SlackConnect = ReturnType<typeof createSlackConnect>;
