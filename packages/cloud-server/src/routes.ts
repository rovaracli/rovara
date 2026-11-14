// The web app's API routes (/v1/app/*, which the browser calls as /v1/web/*) that Cloud answers from Rovara Code, as
// the signed-in person. Each entry shapes Code's answer into the reader schema the app expects. The migration tracker
// lists every route and where it is answered from (PrepLabsAI/Rovara-cloud#1).
import type { CodeAccess, CodeClient } from "./code-client.js";
import type { CodeSession } from "./sessions.js";
import { newSessionId, type WorkSession, type WorkSessionStore } from "./work-sessions.js";
import { approvalUrl, followState, sessionStatus, sessionView, waitingPlan, type CodeTask } from "./session-view.js";
import type { PresenceBoard } from "./presence.js";
import { CodeError } from "./code-client.js";

/** The company this Cloud shows, until companies are Cloud's own (phase 4). */
export interface OrgView { orgId: string; name: string; plan: string }

export interface RouteContext {
  client: CodeClient;
  session: CodeSession;
  /** The path's captured parts, decoded. */
  params: string[];
  query: URLSearchParams;
  body: unknown;
  org: OrgView;
  now: () => Date;
  /** Cloud's sessions (phase 2). */
  work: WorkSessionStore;
  /** The address the app is served at, for session links. */
  origin: string;
  /** Who is looking at each session now (phase 2c). */
  presence: PresenceBoard;
}

export interface RouteAnswer { status: number; body: unknown }

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Matched against the path after /v1/web; capture groups become `params`. */
  path: RegExp;
  answer(context: RouteContext): Promise<RouteAnswer>;
}

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const projectNotFound: RouteAnswer = { status: 404, body: { error: { code: "PROJECT_NOT_FOUND", message: "That project doesn't exist, or you can't use it." } } };

/** A project's role for the person: an administrator maintains it, anyone else contributes. */
export function roleOf(access: string): "maintainer" | "contributor" {
  return access === "administrator" ? "maintainer" : "contributor";
}

const ROLE_OF_MEMBER: Record<string, "maintainer" | "contributor"> = { administrator: "maintainer", developer: "contributor" };

/** Code's project read (spec 065), or undefined for a project the person may not use. */
interface CodeProject { name: string; latestRevision: number; access: string; repositories: Array<{ name: string; url: string; defaultBranch: string; fullName?: string }> }

async function codeProject(context: RouteContext, name: string): Promise<CodeProject | undefined> {
  try {
    return await context.client.json<CodeProject>(context.session, `/v1/dev/client/projects/${encodeURIComponent(name)}`);
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return undefined;
    throw error;
  }
}

function mine(access: CodeAccess, name: string): { name: string; access: string } | undefined {
  return access.projects.find((project) => project.name === name);
}

/** A project as the app's lists show it (AppProjectSummarySchema). */
async function summary(context: RouteContext, name: string, access: string) {
  const code = await codeProject(context, name);
  return {
    name, status: "active", latestRevision: code?.latestRevision ?? 1, myRole: roleOf(access), setup: { status: "unchecked" },
    repositories: (code?.repositories ?? []).map((repository) => ({ name: repository.name, fullName: repository.fullName ?? repository.name, defaultBranch: repository.defaultBranch })),
  };
}

interface CodeRepositories {
  installations: Array<{ installationId: number; accountLogin: string; accountType: string; repositorySelection: string; status: string; repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string }> }>;
}

/** Code's task view, version 2, as the app's session page reads it. */
const TASK_VIEW = { "x-agentx-task-view": "2" };

const sessionNotFound: RouteAnswer = { status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } } };
const badRequest = (message: string): RouteAnswer => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message } } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function readTask(context: RouteContext, taskId: string): Promise<CodeTask> {
  return (await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(taskId)}`, { headers: TASK_VIEW })).task;
}

/** The session and its task, or undefined for a session Cloud doesn't have. Code decides whether the person may see the task. */
async function sessionAndTask(context: RouteContext): Promise<{ record: WorkSession; task: CodeTask } | undefined> {
  const record = await context.work.get(context.params[0]!);
  if (record === undefined) return undefined;
  return { record, task: await readTask(context, record.taskId) };
}

const viewer = (context: RouteContext) => ({ developerId: context.session.access.developerId });
const me = (context: RouteContext) => ({ developerId: context.session.access.developerId, name: context.session.access.displayName });

/** The session's followers and viewers for this person. */
const peopleOf = (context: RouteContext, record: WorkSession) => ({ ...followState(record, context.session.access.developerId), viewingNow: context.presence.viewing(record.sessionId, context.now().getTime()) });

/**
 * The session, once Code has let the person read its task: its owner, or someone it is shared with who is still a member of the
 * project (spec 067). Code's own refusal (not found) reaches the app as the route's answer. The read asks for no events.
 */
async function readableSession(context: RouteContext): Promise<WorkSession | undefined> {
  const record = await context.work.get(context.params[0]!);
  if (record === undefined) return undefined;
  await context.client.json(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}?events=0`, { headers: TASK_VIEW });
  return record;
}

const FOLLOWERS_MAX = 200;
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
const MEMBER_KEY = /^MEMBER#([a-f0-9]{64})$/u;

interface CodeReader { developerId: string; name: string; role: string; projectMember: boolean; grantedAt: string }

/** A Code reader as one of the session's shares (SessionShareSchema): a person, at view, shared by the session's owner. */
const shareOf = (record: WorkSession, reader: CodeReader) => ({
  principal: { kind: "member", developerId: reader.developerId }, level: "view", sharedBy: record.owner, sharedAt: reader.grantedAt,
});

/** How many of the person's newest sessions Home reads from Code, and how many cards it answers (HOME_CARDS_MAX). */
const HOME_SESSIONS_READ = 20;
const HOME_CARDS_MAX = 10;
const HOME_RANK = { plan: 0, failure: 1, pull_request: 2 } as const;

interface HomeCard {
  cardId: string; kind: keyof typeof HOME_RANK; title: string; reason: string; sessionId: string; at: string;
  buttons: Array<{ label: string; action: "open" | "confirm"; href: string; method: "GET" }>;
}

/**
 * Home's cards, from the sessions the person started (their newest few), each read from Code now: a plan waiting for them to review, a
 * failed run, an open pull request. A card goes away when its task moves on; none is dismissible yet. A task Code no longer lets the
 * person see is left out.
 */
async function homeCards(context: RouteContext): Promise<{ cards: HomeCard[]; total: number }> {
  const me = context.session.access.developerId;
  const sessions = (await context.work.startedBy(me)).slice(0, HOME_SESSIONS_READ);
  const origin = context.origin.replace(/\/+$/u, "");
  const read = await Promise.all(sessions.map(async (record) => {
    try {
      return { record, task: await readTask(context, record.taskId) };
    } catch (error) {
      if (error instanceof CodeError && (error.status === 403 || error.status === 404)) return undefined;
      throw error;
    }
  }));
  const cards: HomeCard[] = [];
  for (const entry of read) {
    if (entry === undefined) continue;
    const { record, task } = entry;
    const title = (task.title.trim() === "" ? "Task" : task.title).slice(0, 300);
    const open = { label: "Open session", action: "open" as const, href: `${origin}/s/${record.sessionId}`, method: "GET" as const };
    const card = (kind: HomeCard["kind"], reason: string, buttons: HomeCard["buttons"]) =>
      cards.push({ cardId: `${kind}:${record.sessionId}`, kind, title, reason, sessionId: record.sessionId, at: task.updatedAt, buttons });
    const status = sessionStatus(task);
    if (record.owner.developerId === me && waitingPlan(task) !== undefined) {
      card("plan", `The plan for ${task.project} is waiting for your review.`, [{ label: "Review plan", action: "confirm", href: approvalUrl(origin, record.sessionId), method: "GET" }, open]);
    } else if (status === "failed") {
      card("failure", `The work in ${task.project} stopped before it finished.`, [open]);
    } else {
      const pullRequest = (task.pullRequests ?? []).find((entry) => entry.state === "open" && typeof entry.url === "string" && /^https:\/\//u.test(entry.url));
      if (pullRequest !== undefined && status !== "stopped") {
        card("pull_request", `A pull request in ${task.project} is ready for review.`, [{ label: "Open pull request", action: "open", href: pullRequest.url!, method: "GET" }, open]);
      }
    }
  }
  cards.sort((a, b) => HOME_RANK[a.kind] - HOME_RANK[b.kind] || b.at.localeCompare(a.at));
  return { cards: cards.slice(0, HOME_CARDS_MAX), total: cards.length };
}

export const ROUTES: Route[] = [
  {
    // GET /v1/app/me (AppMeResponseSchema): the person from Code's access check, in the one company this Cloud shows.
    method: "GET", path: /^\/me$/u,
    answer: async ({ session, org }) => ok({
      csrf: session.csrf,
      developer: { id: session.access.developerId, name: session.access.displayName, orgRole: session.access.administrator ? "owner" : "member", nameChosen: true },
      org,
      identities: [{ provider: "oidc", linkedAt: session.signedInAt, lastSignInAt: session.signedInAt }],
    }),
  },
  {
    // GET /v1/app/nav (AppNavSchema): projects come from Code on every load, so a grant or revoke shows at once.
    method: "GET", path: /^\/nav$/u,
    answer: async (context) => {
      const { client, session, org } = context;
      const [access, home] = await Promise.all([client.access(session), homeCards(context)]);
      return ok({
        me: { developerId: access.developerId, name: access.displayName, orgRole: access.administrator ? "owner" : "member", nameChosen: true },
        org: { name: org.name },
        homeCount: home.total,
        projects: access.projects.slice(0, 50).map((project) => ({ name: project.name, agents: [] })),
        shared: { agents: [], sessions: [] },
        // Each turns on as its routes move to Code (phase 2 onwards).
        features: { localAgents: false, usage: false, admin: access.administrator, chains: false, notices: false, describe: false },
      });
    },
  },
  {
    // GET /v1/app/home: what needs the person, from their sessions' tasks in Code.
    method: "GET", path: /^\/home$/u,
    answer: async (context) => ok(await homeCards(context)),
  },
  {
    method: "GET", path: /^\/projects$/u,
    answer: async (context) => {
      const access = await context.client.access(context.session);
      return ok({ projects: await Promise.all(access.projects.map((project) => summary(context, project.name, project.access))) });
    },
  },
  {
    // POST /v1/app/projects (CreateProjectBodySchema): Code's client project create (spec 065b). A retried requestId answers the same project.
    method: "POST", path: /^\/projects$/u,
    answer: async ({ client, session, body, now }) => {
      const input = (body ?? {}) as { requestId?: string; repository?: string; name?: string; setupCommand?: string; testCommand?: string; setupCommands?: string[]; testCommands?: string[] };
      const earlier = input.requestId === undefined ? undefined : session.created?.[input.requestId];
      if (earlier !== undefined) return ok({ duplicate: true, project: { definition: { name: earlier.name }, registeredAt: earlier.at } });
      const list = (single?: string, many?: string[]) => many ?? (single?.trim() ? [single.trim()] : undefined);
      const setupCommands = list(input.setupCommand, input.setupCommands), testCommands = list(input.testCommand, input.testCommands);
      const created = await client.json<{ name: string }>(session, "/v1/dev/client/projects", {
        method: "POST",
        body: { repository: input.repository, ...(input.name ? { name: input.name } : {}), ...(setupCommands ? { setupCommands } : {}), ...(testCommands ? { testCommands } : {}) },
      });
      const at = now().toISOString();
      if (input.requestId !== undefined) {
        session.created = { ...session.created, [input.requestId]: { name: created.name, at } };
        session.changed = true;
      }
      return { status: 201, body: { duplicate: false, project: { definition: { name: created.name }, registeredAt: at } } };
    },
  },
  {
    // GET /v1/app/projects/{p}/overview (ProjectOverviewSchema).
    method: "GET", path: /^\/projects\/([^/]+)\/overview$/u,
    answer: async (context) => {
      const name = context.params[0]!;
      const project = mine(await context.client.access(context.session), name);
      if (project === undefined) return projectNotFound;
      const code = await codeProject(context, name);
      const role = roleOf(project.access);
      return ok({
        project: {
          name, status: "active", ...(code === undefined ? {} : { latestRevision: code.latestRevision }),
          repositories: (code?.repositories ?? []).slice(0, 20).map((repository) => ({ fullName: repository.fullName ?? repository.name, defaultBranch: repository.defaultBranch })),
          setup: { status: "unchecked" }, channels: [],
        },
        you: { role, canStartWork: true, canEditSettings: role === "maintainer", canViewSpend: false },
        agents: [],
        running: [],
      });
    },
  },
  {
    // GET /v1/app/projects/{p} (AppProjectDetailSchema). Settings stay empty until project setup is on Code (PrepLabsAI/Rovara#604).
    method: "GET", path: /^\/projects\/([^/]+)$/u,
    answer: async (context) => {
      const name = context.params[0]!;
      const project = mine(await context.client.access(context.session), name);
      if (project === undefined) return projectNotFound;
      return ok({ ...await summary(context, name, project.access), settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "", createdBy: { developerId: "", name: "" } });
    },
  },
  {
    // GET /v1/app/projects/{p}/members: Code's client members (spec 065a).
    method: "GET", path: /^\/projects\/([^/]+)\/members$/u,
    answer: async ({ client, session, params }) => {
      const body = await client.json<{ members?: Array<{ developerId: string; name: string; role: string }> }>(session, `/v1/dev/client/projects/${encodeURIComponent(params[0]!)}/members`);
      return ok({ members: (body.members ?? []).map((member) => ({ developerId: member.developerId, name: member.name, role: ROLE_OF_MEMBER[member.role] ?? "contributor", source: "grant" })) });
    },
  },
  {
    // PUT /v1/app/projects/{p}/members/{who}: Code grants contributors; maintainers are a project's administrators, made in Code.
    method: "PUT", path: /^\/projects\/([^/]+)\/members\/([^/]+)$/u,
    answer: async ({ client, session, params, body }) => {
      const role = (body as { role?: unknown } | undefined)?.role;
      if (role !== undefined && role !== "contributor") return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Only contributors can be added here for now." } } };
      const answer = await client.json<{ developerId: string }>(session, `/v1/dev/client/projects/${encodeURIComponent(params[0]!)}/members/${encodeURIComponent(params[1]!)}`, { method: "PUT" });
      return ok({ member: { developerId: answer.developerId, role: "contributor" } });
    },
  },
  {
    method: "DELETE", path: /^\/projects\/([^/]+)\/members\/([^/]+)$/u,
    answer: async ({ client, session, params }) => {
      const answer = await client.json<{ developerId: string; outcome: string }>(session, `/v1/dev/client/projects/${encodeURIComponent(params[0]!)}/members/${encodeURIComponent(params[1]!)}`, { method: "DELETE" });
      return ok({ developerId: answer.developerId, removed: answer.outcome === "revoked" });
    },
  },
  {
    // GET /v1/app/github/installations: the GitHub accounts Code's GitHub App is installed on (spec 065b).
    method: "GET", path: /^\/github\/installations$/u,
    answer: async ({ client, session }) => {
      const body = await client.json<CodeRepositories>(session, "/v1/dev/client/repositories");
      return ok({ installations: body.installations.map((entry) => ({ installationId: entry.installationId, accountLogin: entry.accountLogin, accountType: entry.accountType, repositorySelection: entry.repositorySelection, status: entry.status })) });
    },
  },
  {
    // GET /v1/app/github/repositories?installation=N: that account's repositories, marked when a project already uses one.
    method: "GET", path: /^\/github\/repositories$/u,
    answer: async (context) => {
      const body = await context.client.json<CodeRepositories>(context.session, "/v1/dev/client/repositories");
      const installation = body.installations.find((entry) => String(entry.installationId) === context.query.get("installation"));
      if (installation === undefined) return { status: 404, body: { error: { code: "NOT_FOUND", message: "That GitHub account isn't connected." } } };
      const used = new Map<string, string>();
      for (const project of context.session.access.projects) {
        for (const repository of (await codeProject(context, project.name))?.repositories ?? []) {
          if (repository.fullName !== undefined) used.set(repository.fullName.toLowerCase(), project.name);
        }
      }
      return ok({ repositories: installation.repositories.map((repository) => ({ ...repository, ...(used.has(repository.fullName.toLowerCase()) ? { project: used.get(repository.fullName.toLowerCase()) } : {}) })) });
    },
  },
  {
    // POST /v1/app/projects/{p}/code: start work. Code starts a Quick task (plan, code, checks, draft pull request); Cloud keeps a
    // session for it. A retried requestId answers the same session without asking Code again.
    method: "POST", path: /^\/projects\/([^/]+)\/code$/u,
    answer: async (context) => {
      const input = (context.body ?? {}) as { requestId?: unknown; input?: { text?: unknown } };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      const text = typeof input.input?.text === "string" ? input.input.text.trim() : "";
      if (text === "") return badRequest("Say what the work is.");
      const earlier = await context.work.byRequest(input.requestId);
      const project = context.params[0]!;
      if (earlier !== undefined) {
        const task = await readTask(context, earlier.taskId);
        return { status: 201, body: { task, sessionId: earlier.sessionId, sessionUrl: `${context.origin.replace(/\/+$/u, "")}/s/${earlier.sessionId}` } };
      }
      const started = await context.client.json<{ task: CodeTask }>(context.session, "/v1/dev/tasks", {
        method: "POST", headers: TASK_VIEW,
        body: { requestId: input.requestId, project, instructions: text, workflow: true, workflowPath: "QUICK", client: "Rovara Cloud" },
      });
      const person = { developerId: context.session.access.developerId, name: context.session.access.displayName };
      const record: WorkSession = { sessionId: newSessionId(), taskId: started.task.taskId, project, startedBy: person, owner: person, createdAt: context.now().toISOString(), revision: 1 };
      await context.work.put(record, input.requestId);
      return { status: 201, body: { task: started.task, sessionId: record.sessionId, sessionUrl: `${context.origin.replace(/\/+$/u, "")}/s/${record.sessionId}` } };
    },
  },
  {
    // GET /v1/app/sessions/{id}: Cloud's session around Code's task.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      return found === undefined ? sessionNotFound : ok({ session: sessionView(found.record, found.task, viewer(context), context.origin, peopleOf(context, found.record)) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/stop: Code cancels the task's running step.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/stop$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const requestId = (context.body as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId !== "string" || !UUID.test(requestId)) return badRequest("requestId must be a UUID.");
      const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/cancel`, { method: "POST", headers: TASK_VIEW, body: { requestId } });
      return ok({ session: sessionView(record, task, viewer(context), context.origin) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/close: Code closes the task; the first ask never discards unpublished work.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/close$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const input = (context.body ?? {}) as { requestId?: unknown; discardUnpublished?: unknown };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      const closed = await context.client.json<{ task: CodeTask; closed: boolean; discardedUnpublished?: boolean; unpublished?: unknown; message?: string }>(
        context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/close`,
        { method: "POST", headers: TASK_VIEW, body: { requestId: input.requestId, ...(input.discardUnpublished === true ? { discard_unpublished: true } : {}) } },
      );
      return ok({
        session: sessionView(record, closed.task, viewer(context), context.origin), closed: closed.closed,
        ...(closed.discardedUnpublished === undefined ? {} : { discardedUnpublished: closed.discardedUnpublished }),
        ...(closed.unpublished === undefined ? {} : { unpublished: closed.unpublished }),
        ...(closed.message === undefined ? {} : { message: closed.message }),
      });
    },
  },
  {
    // POST /v1/app/sessions/{id}/take-over: the person becomes the task's owner in Code (asked against the people revision Code shows now).
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/take-over$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const requestId = (context.body as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId !== "string" || !UUID.test(requestId)) return badRequest("requestId must be a UUID.");
      const path = `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/people`;
      const { view } = await context.client.json<{ view: { revision: number } }>(context.session, path);
      await context.client.json(context.session, `${path}/take-ownership`, { method: "POST", body: { requestId, expectedPeopleRevision: view.revision } });
      const updated: WorkSession = { ...record, owner: { developerId: context.session.access.developerId, name: context.session.access.displayName }, revision: record.revision + 1 };
      await context.work.put(updated);
      return ok({ session: sessionView(updated, await readTask(context, record.taskId), viewer(context), context.origin) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/follow: anyone who may read the task follows it; the owner always does, with no entry.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/follow$/u,
    answer: async (context) => {
      const record = await readableSession(context);
      if (record === undefined) return sessionNotFound;
      const person = me(context);
      if (followState(record, person.developerId).following) return ok({ following: true });
      const followers = record.followers ?? [];
      if (followers.length >= FOLLOWERS_MAX) return badRequest("This session has as many followers as it can have.");
      await context.work.put({ ...record, followers: [...followers, person] });
      return ok({ following: true });
    },
  },
  {
    // DELETE /v1/app/sessions/{id}/follow: the follow goes; the owner always follows.
    method: "DELETE", path: /^\/sessions\/(ses_[0-9a-z]{20})\/follow$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const developerId = context.session.access.developerId;
      if (developerId === record.owner.developerId) return ok({ following: true });
      const followers = record.followers ?? [];
      if (followers.some((person) => person.developerId === developerId)) await context.work.put({ ...record, followers: followers.filter((person) => person.developerId !== developerId) });
      return ok({ following: false });
    },
  },
  {
    // POST /v1/app/sessions/{id}/presence: the page's heartbeat; answers who is looking at the session now.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/presence$/u,
    answer: async (context) => {
      const record = await readableSession(context);
      if (record === undefined) return sessionNotFound;
      return ok({ viewingNow: context.presence.heartbeat(record.sessionId, me(context), context.now().getTime()) });
    },
  },
  {
    // GET /v1/app/sessions/{id}/shares: the people Code lets read the task (its readers, spec 067). Code answers only the owner.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})\/shares$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const { readers } = await context.client.json<{ readers: CodeReader[] }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/readers`);
      return ok({ shares: readers.map((reader) => shareOf(record, reader)) });
    },
  },
  {
    // PUT /v1/app/sessions/{id}/shares: share with a person, at view. Code makes them a reader (a member of the project only).
    method: "PUT", path: /^\/sessions\/(ses_[0-9a-z]{20})\/shares$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const input = (context.body ?? {}) as { requestId?: unknown; principal?: { kind?: unknown; developerId?: unknown }; level?: unknown };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      if (input.principal?.kind !== "member" || typeof input.principal.developerId !== "string" || !DEVELOPER_ID.test(input.principal.developerId)) {
        return badRequest("A session can be shared with a person for now, not a project or the whole company.");
      }
      if (input.level !== "view") return badRequest("A session can be shared to view only, for now.");
      const answer = await context.client.json<{ reader: CodeReader }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/readers/${input.principal.developerId}`, {
        method: "PUT", body: { requestId: input.requestId, role: "viewer" },
      });
      return ok({ share: shareOf(record, answer.reader) });
    },
  },
  {
    // DELETE /v1/app/sessions/{id}/shares/{principalKey}: stop sharing with a person (`MEMBER#<developerId>`); they stop following too.
    method: "DELETE", path: /^\/sessions\/(ses_[0-9a-z]{20})\/shares\/([^/]+)$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const key = MEMBER_KEY.exec(context.params[1]!);
      if (key === null) return badRequest("Only a share with a person can be removed here.");
      const answer = await context.client.json<{ removed: boolean }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/readers/${key[1]!}`, { method: "DELETE" });
      const followers = record.followers ?? [];
      if (followers.some((person) => person.developerId === key[1])) await context.work.put({ ...record, followers: followers.filter((person) => person.developerId !== key[1]) });
      return ok({ removed: answer.removed });
    },
  },
];
