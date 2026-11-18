// The web app's API routes (/v1/app/*, which the browser calls as /v1/web/*) that Cloud answers from Rovara Code, as
// the signed-in person. Each entry shapes Code's answer into the reader schema the app expects. The migration tracker
// lists every route and where it is answered from (PrepLabsAI/Rovara-cloud#1).
import type { CodeAccess, CodeClient } from "./code-client.js";
import type { CodeSession } from "./sessions.js";
import { newSessionId, type WorkSession, type WorkSessionStore, newMessageId } from "./work-sessions.js";
import { renameInSessions } from "./rename.js";
import { COMMENTS_PER_SESSION_MAX, commentText, commentView, commentsPage, timelineOf, timelinePage, type CodeTaskEvent } from "./conversation.js";
import { approvalUrl, blockedReview, followState, reviewChoices, liveTile, sessionRunning, sessionStatus, sessionView, waitingPlan, type CodeTask } from "./session-view.js";
import type { PresenceBoard } from "./presence.js";
import { CodeError, SignInEnded } from "./code-client.js";
import type { CloudAuditStore } from "./audit-log.js";
import { CompanyAuditQueryRefused, codeEngineAuditSource, listCompanyAudit, parseCompanyAuditQuery } from "./company-audit.js";
import { WORK_READS } from "./work-reads.js";
import { ONBOARDING_ROUTES } from "./onboarding-routes.js";
import { MEMBER_ROUTES } from "./member-routes.js";
import { PROJECT_LIFECYCLE_ROUTES } from "./project-lifecycle-routes.js";
import { PROJECT_CREATE_ROUTES, createProjects, isCreateProjectsBody } from "./project-create-routes.js";
import { AI_SPEND_ROUTES } from "./ai-spend-routes.js";
import { SETUP_CHECKLIST_ROUTES } from "./setup-checklist-routes.js";
import { openTaskByCodeId } from "./open-task.js";
import { WIKI_ROUTES } from "./wiki-routes.js";
import { WIKI_CORRECTION_ROUTES } from "./wiki-corrections-routes.js";
import { WIKI_SETUP_ROUTES } from "./wiki-setup-routes.js";
import { ANSWERS_ROUTES } from "./answers-routes.js";
import { LESSONS_ROUTES } from "./lessons-routes.js";
import { HOW_WE_WORK_ROUTES } from "./how-we-work-routes.js";
import { INBOX_ROUTES } from "./inbox-routes.js";
import { PEOPLE_ROUTES } from "./people-routes.js";
import { REPORT_ROUTES } from "./report-routes.js";
import type { CompanyBackend } from "./company-routes.js";
import { withdrawForMember, type ProductAiBackend } from "./product-ai-routes.js";
import { NOT_IN_COMPANY, companyCaller, companyNameOf, companyOf, isCompanyAdmin, refused, type CompanyRole } from "./company-caller.js";
import { parseAnswersBody } from "./answers.js";
import { freshStepUp, STEP_UP_WINDOW_SECONDS } from "./step-up.js";

/** The deployment's plan words. The company itself (its id and name) is never the deployment's: it comes from Code's access check (company-caller.ts). */
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
  /** Cloud's company data (company-routes.ts); absent when this Cloud has none. */
  company?: CompanyBackend;
  /** Cloud's own audit records. Absent: the company audit answers 503, and a route that records a Cloud action has nowhere to record it. */
  audit?: CloudAuditStore;
  /** The project's product AI settings (product-ai-routes.ts); absent when this Cloud has none. */
  productAi?: ProductAiBackend;
  /** Lead 4 J3: the deployment setting for the smart Just answer (handler.ts `answersEnabled`). Absent: off. */
  answersEnabled?: boolean;
}

export interface RouteAnswer { status: number; body: unknown }

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Matched against the path after /v1/web; capture groups become `params`. */
  path: RegExp;
  answer(context: RouteContext): Promise<RouteAnswer>;
}

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const auditUnavailable: RouteAnswer = { status: 503, body: { error: { code: "AUDIT_UNAVAILABLE", message: "The company audit isn't available right now." } } };
const decisionsOff: RouteAnswer = { status: 404, body: { error: { code: "NOT_FOUND", message: "Decision cards aren't on Rovara Code yet." } } };
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

/** A project name in a path, as the lessons routes take it (lessons-routes.ts PROJECT). */
const PROJECT_IN_PATH = "([A-Za-z0-9][A-Za-z0-9._-]{0,99})";
/** DEC 253q (d): the only members of an eval confirm Cloud passes on to Code (Code validates them strictly). */
export const EVAL_CONFIRM_KEYS = ["taskId", "reportDigest", "selection", "paths"] as const;
const evalConfirmNotOnCode = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Confirming an eval isn't connected to Rovara Code yet." } } };
const evalConfirmRefused: RouteAnswer = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner, admin or project maintainer confirms the eval." } } };
/** A company owner or admin (Code's company role), or the project's maintainer (its "administrator" access, roleOf). Code re-checks the role live. */
function confirmsEval(access: CodeAccess, companyRole: CompanyRole, project: string): boolean {
  if (isCompanyAdmin(companyRole)) return true;
  const entry = mine(access, project);
  return entry !== undefined && roleOf(entry.access) === "maintainer";
}

async function readTask(context: RouteContext, taskId: string): Promise<CodeTask> {
  return (await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(taskId)}`, { headers: TASK_VIEW })).task;
}

/** The session and its task, or undefined for a session Cloud doesn't have. Code decides whether the person may see the task. */
async function sessionAndTask(context: RouteContext): Promise<{ record: WorkSession; task: CodeTask } | undefined> {
  const record = await context.work.get(context.params[0]!);
  if (record === undefined) return undefined;
  return { record, task: await readTask(context, record.taskId) };
}

/** The reader, with the name they signed in with now: their own name on a session is always current (Rovara-cloud#39). */
const viewer = (context: RouteContext) => ({ developerId: context.session.access.developerId, name: context.session.access.displayName });
const me = (context: RouteContext) => ({ developerId: context.session.access.developerId, name: context.session.access.displayName });

/** The session's followers and viewers for this person. */
const peopleOf = async (context: RouteContext, record: WorkSession) => ({ ...followState(record, context.session.access.developerId), viewingNow: await context.presence.viewing(record.sessionId, context.now().getTime()) });

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

/** A comment's edit or deletion, by its author, on the revision they saw. */
async function changeComment(context: RouteContext, change: "edit" | "delete"): Promise<RouteAnswer> {
  const record = await readableSession(context);
  if (record === undefined) return sessionNotFound;
  const messages = record.messages ?? [];
  const comment = messages.find((message) => message.messageId === context.params[1]);
  if (comment === undefined || comment.deletedAt !== undefined) return { status: 404, body: { error: { code: "NOT_FOUND", message: "That comment isn't here any more." } } };
  if (comment.author.developerId !== context.session.access.developerId) return { status: 403, body: { error: { code: "FORBIDDEN", message: "You can change only your own comments." } } };
  const input = (context.body ?? {}) as { rev?: unknown; text?: unknown };
  if (input.rev !== comment.rev) return { status: 409, body: { error: { code: "CONFLICT", message: "This comment changed since you opened it. Refresh and try again." } } };
  const at = context.now().toISOString();
  let next = { ...comment, rev: comment.rev + 1 };
  if (change === "edit") {
    const text = commentText(input.text);
    if ("problem" in text) return badRequest(text.problem);
    next = { ...next, text: text.text, editedAt: at };
  } else {
    next = { ...next, deletedAt: at };
  }
  await context.work.put({ ...record, messages: messages.map((message) => (message.messageId === comment.messageId ? next : message)) });
  return ok(commentView(record.sessionId, next));
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
  buttons: Array<{ label: string; action: "open" | "confirm"; href: string; method: "GET" } | { label: string; action: "retry"; href: string; method: "POST" }>;
}

/**
 * Home's cards, from the sessions the person started (their newest few), each read from Code now: a plan waiting for them to review, a
 * failed run, an open pull request. A card goes away when its task moves on; none is dismissible yet. A task Code no longer lets the
 * person see is left out.
 */
/**
 * The project page's running sessions: the person's own sessions in `project` (their newest few) that are still going, read from Code
 * now, newest first. Sessions shared with them are not listed yet: Cloud indexes sessions by who started them.
 */
async function runningInProject(context: RouteContext, project: string) {
  const me = context.session.access.developerId;
  const records = (await context.work.startedBy(me)).filter((record) => record.project === project).slice(0, HOME_SESSIONS_READ);
  const read = await Promise.all(records.map(async (record) => {
    try {
      return { record, task: await readTask(context, record.taskId) };
    } catch (error) {
      if (error instanceof CodeError && (error.status === 403 || error.status === 404)) return undefined;
      throw error;
    }
  }));
  const running = read.filter((entry): entry is { record: WorkSession; task: CodeTask } => entry !== undefined && sessionRunning(entry.task));
  return (await Promise.all(running.map(async ({ record, task }) => liveTile(record, task, viewer(context), context.origin, await peopleOf(context, record)))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

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
    } else if (record.owner.developerId === me && blockedReview(task) !== undefined) {
      // Rovara-cloud#15: stopped at review, which only its owner can move on. Shown as a stop, with Code's reason and, when Code would take it, Retry reviews.
      const blocked = blockedReview(task)!;
      card("failure", blocked.reason, [...(blocked.retry === undefined ? [] : [{ label: "Retry reviews", action: "retry" as const, href: `${origin}/v1/app/sessions/${record.sessionId}/retry`, method: "POST" as const }]), open]);
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
    // Project machine size: member reads; SET is a stored choice and requires a fresh web-page step-up in Cloud and Code.
    method: "GET", path: /^\/projects\/([^/]+)\/machine-size$/u,
    answer: async (context) => {
      const project = context.params[0]!;
      if (mine(context.session.access, project) === undefined) return projectNotFound;
      try { return ok(await context.client.json<Record<string, unknown>>(context.session, `/v1/dev/projects/${encodeURIComponent(project)}/machine-size`)); }
      catch (error) {
        if (error instanceof CodeError) {
          const answered = (error.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
          if (error.status === 501 || answered?.code === "NOT_AVAILABLE_HERE" || error.status === 404 && answered?.code === "NOT_FOUND" && answered.message === "route not found") return { status: 501, body: { status: "not_set_up", message: "Machine size suggestions are not set up on Rovara Code yet." } };
          if (error.status === 404 && answered?.code === "NOT_FOUND" && answered.message === "project not found") return projectNotFound;
        }
        throw error;
      }
    },
  },
  {
    method: "POST", path: /^\/projects\/([^/]+)\/machine-size$/u,
    answer: async (context) => {
      const project = context.params[0]!;
      if (mine(context.session.access, project) === undefined) return projectNotFound;
      if (freshStepUp(context.session.accessToken, context.now().getTime(), STEP_UP_WINDOW_SECONDS) === undefined) return { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Confirm it's you again, then try once more." } } };
      const rowId = (context.body as { rowId?: unknown } | undefined)?.rowId;
      if (typeof rowId !== "string") return badRequest("Choose one of the listed machine sizes.");
      try { return ok(await context.client.json<Record<string, unknown>>(context.session, `/v1/dev/projects/${encodeURIComponent(project)}/machine-size`, { method: "POST", body: { rowId } })); }
      catch (error) {
        if (error instanceof CodeError) {
          const answered = (error.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
          if (error.status === 501 || answered?.code === "NOT_AVAILABLE_HERE" || error.status === 404 && answered?.code === "NOT_FOUND" && answered.message === "route not found") return { status: 501, body: { status: "not_set_up", message: "Machine size suggestions are not set up on Rovara Code yet." } };
          if (error.status === 404 && answered?.code === "NOT_FOUND" && answered.message === "project not found") return projectNotFound;
        }
        throw error;
      }
    },
  },
  {
    // GET /v1/app/me (AppMeResponseSchema): the person and their company from Code's access check made now. No company: NOT_IN_COMPANY.
    method: "GET", path: /^\/me$/u,
    answer: async (context) => {
      const who = await companyCaller(context);
      // No company yet: still the sign-in's CSRF value, so the onboarding pages (creating a company) can send their one change.
      if (refused(who)) return who === NOT_IN_COMPANY ? { status: who.status, body: { ...(who.body as object), csrf: context.session.csrf } } : who;
      const { session, org } = context;
      return ok({
        csrf: session.csrf,
        // Not chosen only when Code says so; the app then asks once what teammates should call the person.
        developer: { id: who.developerId, name: who.name, orgRole: who.companyRole, nameChosen: who.access.nameChosen !== false },
        org: { orgId: who.companyId, name: companyNameOf(who), plan: org.plan },
        identities: [{ provider: "oidc", linkedAt: session.signedInAt, lastSignInAt: session.signedInAt }],
      });
    },
  },
  {
    // PUT /v1/app/me/name (SetMyNameBodySchema): the person's own name, stored in Code (PrepLabsAI/Rovara#634), which checks it. Only the name is passed on.
    method: "PUT", path: /^\/me\/name$/u,
    answer: async ({ client, session, body, work }) => {
      const name = (body as { name?: unknown } | undefined)?.name;
      if (typeof name !== "string") return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "name: give a name of 1 to 80 characters." } } };
      const answer = await client.json<{ name: string; nameChosen: true }>(session, "/v1/dev/me/name", { method: "PUT", body: { name } });
      // The session keeps Code's access answer from sign-in; /me reads it, so it takes the new name now.
      session.access = { ...session.access, displayName: answer.name, nameChosen: true };
      session.changed = true;
      // Rovara-cloud#39: the sessions this person started take the new name too, for everyone who reads them. Best effort: the name is already saved.
      await renameInSessions(work, session.access.developerId, answer.name).catch(() => 0);
      return ok({ name: answer.name, nameChosen: true });
    },
  },
  {
    // GET /v1/app/nav (AppNavSchema): projects come from Code on every load, so a grant or revoke shows at once.
    method: "GET", path: /^\/nav$/u,
    answer: async (context) => {
      const who = await companyCaller(context);
      if (refused(who)) return who;
      const { access } = who;
      const home = await homeCards(context);
      return ok({
        me: { developerId: who.developerId, name: who.name, orgRole: who.companyRole, nameChosen: access.nameChosen !== false },
        org: { name: companyNameOf(who) },
        homeCount: home.total,
        projects: access.projects.slice(0, 50).map((project) => ({ name: project.name, agents: [] })),
        shared: { agents: [], sessions: [] },
        // Each turns on as its routes move to Code (phase 2 onwards). Admin: a company owner or admin, never the install administrator.
        features: { localAgents: false, usage: false, admin: isCompanyAdmin(who.companyRole), chains: false, notices: false, describe: false, answers: context.answersEnabled === true },
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
    answer: async (context) => {
      // Guided onboarding PR 10: several repositories (one project, or one each) are project-create-routes.ts; the one-repository body below is unchanged.
      if (isCreateProjectsBody(context.body)) return createProjects(context);
      const { client, session, body, now } = context;
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
    // GET /v1/app/tasks/{task}/loaded-knowledge[/…] and /lessons: what the agent loaded and the lessons it used are not on Code yet. The app reads a
    // 404 as "nothing recorded" (and hides the lessons), where any other answer shows "could not be loaded".
    method: "GET", path: /^\/tasks\/[^/]+\/(?:loaded-knowledge(?:\/.*)?|lessons)$/u,
    answer: () => Promise.resolve({ status: 404, body: { error: { code: "NOT_FOUND", message: "This isn't recorded on Rovara Code yet." } } }),
  },
  {
    // POST /v1/app/realtime/token: live updates are not on Code yet. The app reads a 404 here as "live updates are off" and reads its screens again
    // every 30 seconds, where any other answer would keep it reconnecting.
    method: "POST", path: /^\/realtime\/token$/u,
    answer: () => Promise.resolve({ status: 404, body: { error: { code: "NOT_FOUND", message: "Live updates aren't on Rovara Code yet." } } }),
  },
  {
    // GET /v1/app/decisions (DecisionCardsViewReaderSchema): Code's decision cards (contract v0 `decisions.list`, `/v1/dev/client/decisions`), passed through
    // as Code built them: each card carries the digest Code checks when the person acts. Code does not serve the route yet (the decision cards arrive with
    // the core on AWS, lane E2), so its 404 or 501 becomes the 404 the app reads as "cards are switched off": it shows none, and Home's plan, failure and
    // pull-request cards still show, where any other answer would show as an error.
    method: "GET", path: /^\/decisions$/u,
    answer: async ({ client, session }) => {
      try {
        return ok(await client.json<unknown>(session, "/v1/dev/client/decisions"));
      } catch (error) {
        if (error instanceof CodeError && (error.status === 404 || error.status === 501)) return decisionsOff;
        throw error;
      }
    },
  },
  {
    // POST /v1/app/decisions/{kind}/{subject}/{approve|request-changes|reject|evidence-opened}: one card, one request (contract v0 `decisions.act`). Code checks
    // the digest the person was shown (409 CHANGE_STALE when the card changed), the card's risk and who may decide; its answer, refusals included, reaches the
    // app unchanged. Only `?merging=1` and `?tab=` of the query go on.
    method: "POST", path: /^\/decisions\/([A-Za-z0-9_]+)\/([A-Za-z0-9_-]{1,150})\/(approve|request-changes|reject|evidence-opened)$/u,
    answer: async ({ client, session, params, query, body }) => {
      const [kind, subject, action] = params as [string, string, string];
      const requestId = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { requestId?: unknown }).requestId : undefined;
      if (typeof requestId !== "string" || !UUID.test(requestId)) return badRequest("requestId must be a UUID.");
      const forwarded = new URLSearchParams();
      if (query.get("merging") === "1") forwarded.set("merging", "1");
      const tab = query.get("tab");
      if (tab === "requirements" || tab === "design") forwarded.set("tab", tab);
      const suffix = forwarded.size === 0 ? "" : `?${forwarded.toString()}`;
      return ok(await client.json<unknown>(session, `/v1/dev/client/decisions/${encodeURIComponent(kind)}/${encodeURIComponent(subject)}/${action}${suffix}`, { method: "POST", body }));
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
        running: await runningInProject(context, name),
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
    // POST /v1/web/projects/{p}/setup-agent/eval-confirm (the app's /v1/app/..., DEC 253q d): forwarded to Code's own route as the signed-in person. Only a
    // company administrator or the project's maintainer is forwarded (Code re-checks the role live); only an object body, and only
    // its EVAL_CONFIRM_KEYS. Until Code serves the route (E2) its unknown-route 404 reaches the app as 501 NOT_ON_CODE_YET.
    method: "POST", path: new RegExp(`^/projects/${PROJECT_IN_PATH}/setup-agent/eval-confirm$`, "u"),
    answer: async ({ client, session, params, body }) => {
      const project = params[0]!;
      // The sign-in's latest access answer: Code re-checks the role live on its own route, so this only spares Code a call it would refuse.
      const membership = companyOf(session.access);
      if (membership === undefined) return NOT_IN_COMPANY;
      if (!confirmsEval(session.access, membership.companyRole, project)) return evalConfirmRefused;
      if (body === null || typeof body !== "object" || Array.isArray(body)) return badRequest("Send the eval confirmation as a JSON object.");
      const given = body as Record<string, unknown>;
      const forwarded: Record<string, unknown> = {};
      for (const key of EVAL_CONFIRM_KEYS) if (Object.hasOwn(given, key)) forwarded[key] = given[key];
      try {
        return ok(await client.json<unknown>(session, `/v1/app/projects/${encodeURIComponent(project)}/setup-agent/eval-confirm`, { method: "POST", body: forwarded }));
      } catch (error) {
        // A Code that does not serve the route yet answers its fixed unknown-route 404 (handler.ts "route not found"): the app reads that as not on Code yet. Any other 404 (no report, no project) is Code's own.
        const answered = error instanceof CodeError ? (error.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error : undefined;
        if (error instanceof CodeError && error.status === 404 && answered?.code === "NOT_FOUND" && answered.message === "route not found") return evalConfirmNotOnCode;
        throw error;
      }
    },
  },
  {
    // PUT /v1/app/projects/{p}/members/{who}: Code grants contributors; maintainers are a project's administrators, made in Code.
    method: "PUT", path: /^\/projects\/([^/]+)\/members\/([^/]+)$/u,
    answer: async (context) => {
      const { client, session, params, body } = context;
      const role = (body as { role?: unknown } | undefined)?.role;
      if (role !== undefined && role !== "contributor") return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "Only contributors can be added here for now." } } };
      // PRODUCT-EVAL-APPROVER-REREAD: the person's role in the project changes, so their eval approvals stop counting first.
      const withdrawal = await withdrawForMember(context, params[1]!, { project: params[0]! });
      if ("status" in withdrawal) return withdrawal;
      const answer = await client.json<{ developerId: string }>(session, `/v1/dev/client/projects/${encodeURIComponent(params[0]!)}/members/${encodeURIComponent(params[1]!)}`, { method: "PUT" });
      await withdrawal.after();
      return ok({ member: { developerId: answer.developerId, role: "contributor" } });
    },
  },
  {
    method: "DELETE", path: /^\/projects\/([^/]+)\/members\/([^/]+)$/u,
    answer: async (context) => {
      const { client, session, params } = context;
      // PRODUCT-EVAL-APPROVER-REREAD: a person leaving a project keeps no eval approval (withdrawn before Code removes them).
      const withdrawal = await withdrawForMember(context, params[1]!, { project: params[0]! });
      if ("status" in withdrawal) return withdrawal;
      const answer = await client.json<{ developerId: string; outcome: string }>(session, `/v1/dev/client/projects/${encodeURIComponent(params[0]!)}/members/${encodeURIComponent(params[1]!)}`, { method: "DELETE" });
      await withdrawal.after();
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
    // POST /v1/app/projects/{p}/code: start work. Code starts a Quick task (or a Full one when the body names `path: "full"`; plan, code, checks, draft pull request); Cloud keeps a
    // session for it. A retried requestId answers the same session without asking Code again.
    method: "POST", path: /^\/projects\/([^/]+)\/code$/u,
    answer: async (context) => {
      const input = (context.body ?? {}) as { requestId?: unknown; input?: { text?: unknown } };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      const text = typeof input.input?.text === "string" ? input.input.text.trim() : "";
      if (text === "") return badRequest("Say what the work is.");
      // Lead 4 J3 (DEC 173): the start box may name the path it suggested ("quick" or "full"); absent is Quick, as it always was. Anything else is refused.
      const path = (context.body as { path?: unknown } | undefined)?.path;
      if (path !== undefined && path !== "quick" && path !== "full") return badRequest("The path is quick or full.");
      // The person's company now (DEC 253z): no company, no work; the answer also refreshes the company the new session is stamped with.
      const who = await companyCaller(context);
      if (refused(who)) return who;
      const earlier = await context.work.byRequest(input.requestId);
      const project = context.params[0]!;
      if (earlier !== undefined) {
        const task = await readTask(context, earlier.taskId);
        return { status: 201, body: { task, sessionId: earlier.sessionId, sessionUrl: `${context.origin.replace(/\/+$/u, "")}/s/${earlier.sessionId}` } };
      }
      const started = await context.client.json<{ task: CodeTask }>(context.session, "/v1/dev/tasks", {
        method: "POST", headers: TASK_VIEW,
        body: { requestId: input.requestId, project, instructions: text, workflow: true, workflowPath: path === "full" ? "FULL" : "QUICK", client: "Rovara Cloud" },
      });
      const person = { developerId: context.session.access.developerId, name: context.session.access.displayName };
      const record: WorkSession = { sessionId: newSessionId(), taskId: started.task.taskId, project, startedBy: person, owner: person, createdAt: context.now().toISOString(), revision: 1 };
      await context.work.put(record, input.requestId);
      return { status: 201, body: { task: started.task, sessionId: record.sessionId, sessionUrl: `${context.origin.replace(/\/+$/u, "")}/s/${record.sessionId}` } };
    },
  },
  {
    // POST /v1/app/tasks/{taskId}/open (K2): the Cloud session of a Code task, made on the first open by anyone Code lets read the task (open-task.ts).
    // The answer is { sessionId, sessionUrl }; a refusal from Code, and a task Cloud cannot open, answer the same SESSION_NOT_FOUND 404.
    method: "POST", path: /^\/tasks\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\/open$/u,
    answer: openTaskByCodeId,
  },
  {
    // GET /v1/app/sessions/{id}: Cloud's session around Code's task.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      return found === undefined ? sessionNotFound : ok({ session: sessionView(found.record, found.task, viewer(context), context.origin, await peopleOf(context, found.record)) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/answers: the owner's answers to the questions Understand asked. Cloud reads the task from Code for its own session record
    // (Code decides whether the person may see it), checks the body, and sends the checked answers to Code's POST /v1/dev/tasks/{taskId}/answers with the
    // task id from that record (never one from the request). Code serves every task: a core task's owner answers it, a workflow task says nothing waits.
    // Code decides who may answer (only the task's owners); its refusals pass through unchanged. The answer is the session as GET shows it, re-read.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/answers$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      if (found === undefined) return sessionNotFound;
      const input = parseAnswersBody(context.body);
      if (!input.ok) return badRequest(input.message);
      await context.client.json(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/answers`, { method: "POST", headers: TASK_VIEW, body: input.value });
      return ok({ session: sessionView(found.record, await readTask(context, found.record.taskId), viewer(context), context.origin, await peopleOf(context, found.record)) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/retry (Rovara-cloud#15): for a task stopped at review, Code reviews the same checked code again (its
    // workflow/review route, as Slack's Retry reviews). Only the owner; Code checks the owner, the revision and the candidate again.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/retry$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      if (found === undefined) return sessionNotFound;
      const requestId = (context.body as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId !== "string" || !UUID.test(requestId)) return badRequest("requestId must be a UUID.");
      if (found.record.owner.developerId !== context.session.access.developerId) return { status: 403, body: { error: { code: "FORBIDDEN", message: `Only ${found.record.owner.name} can retry this session.` } } };
      const retry = blockedReview(found.task)?.retry;
      if (retry === undefined) return { status: 409, body: { error: { code: "CONFLICT", message: "There's nothing to retry on this session right now." } } };
      const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/workflow/review`, {
        method: "POST", headers: TASK_VIEW,
        body: { requestId, ...retry, instructions: "Retry the independent read-only code and security reviews on the same verified candidate. Do not edit files." },
      });
      return ok({ session: sessionView(found.record, task, viewer(context), context.origin, await peopleOf(context, found.record)) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/send-back (Rovara-cloud#25): a task stopped by review findings goes back to coding with the owner's note. Code adds
    // the findings to the coding agent's prompt itself (workflow/send-back); the note is the owner's own instruction. Only the owner.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/send-back$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      if (found === undefined) return sessionNotFound;
      const input = (context.body ?? {}) as { requestId?: unknown; note?: unknown };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim().length > 1000)) return badRequest("The note is at most 1,000 characters.");
      if (found.record.owner.developerId !== context.session.access.developerId) return { status: 403, body: { error: { code: "FORBIDDEN", message: `Only ${found.record.owner.name} can send this back to coding.` } } };
      const choices = reviewChoices(found.task);
      if (choices === undefined) return { status: 409, body: { error: { code: "CONFLICT", message: "There are no review findings to send back right now." } } };
      const note = typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : "Fix the review findings.";
      const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/workflow/send-back`, {
        method: "POST", headers: TASK_VIEW, body: { requestId: input.requestId, expectedRevision: choices.expectedRevision, instructions: note },
      });
      return ok({ session: sessionView(found.record, task, viewer(context), context.origin, await peopleOf(context, found.record)) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/accept-findings (Rovara-cloud#25): the owner accepts every blocking finding of the current code with their reason, so
    // the reviews clear and Code opens the pull request (workflow/review-findings). The IDs are computed here from Code's task, never taken from the request.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/accept-findings$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      if (found === undefined) return sessionNotFound;
      const input = (context.body ?? {}) as { requestId?: unknown; reason?: unknown };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (reason === "" || reason.length > 500) return badRequest("Give a reason of up to 500 characters for accepting the findings.");
      if (found.record.owner.developerId !== context.session.access.developerId) return { status: 403, body: { error: { code: "FORBIDDEN", message: `Only ${found.record.owner.name} can accept these findings.` } } };
      const choices = reviewChoices(found.task);
      if (choices === undefined) return { status: 409, body: { error: { code: "CONFLICT", message: "There are no review findings to accept right now." } } };
      const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/workflow/review-findings`, {
        method: "POST", headers: TASK_VIEW,
        body: { requestId: input.requestId, expectedRevision: choices.expectedRevision, candidateDigest: choices.candidateDigest, resolutions: choices.findings.map((finding) => ({ findingId: finding.findingId, action: "ACCEPT", note: reason })) },
      });
      return ok({ session: sessionView(found.record, task, viewer(context), context.origin, await peopleOf(context, found.record)) });
    },
  },
  {
    // GET /v1/app/sessions/{id}/events (Rovara-cloud#24): the Conversation's timeline, from the Code task's own events (the newest Code keeps), for
    // anyone Code lets read the task. Paged after `<at>#<eventId>`.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})\/events$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const { events } = await context.client.json<{ events: CodeTaskEvent[] }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/events?limit=50`);
      return ok(timelinePage(timelineOf(events ?? []), context.query.get("after")));
    },
  },
  {
    // GET /v1/app/sessions/{id}/messages (Rovara-cloud#24): the session's comments, Cloud's own, for anyone Code lets read the task. Pinned
    // comments are not offered (Cloud's session view lists no parts to pin), so a read for one part has none.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})\/messages$/u,
    answer: async (context) => {
      const record = await readableSession(context);
      if (record === undefined) return sessionNotFound;
      if (context.query.get("anchor") !== null) return ok({ messages: [] });
      return ok(commentsPage(record.sessionId, record.messages ?? [], context.query.get("after"), viewer(context)));
    },
  },
  {
    // POST /v1/app/sessions/{id}/messages {requestId, kind, text, threadId?}: a comment from anyone who can read the session. A message to the
    // agent ("steer") and a pinned comment are refused: neither is available in Cloud yet.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/messages$/u,
    answer: async (context) => {
      const record = await readableSession(context);
      if (record === undefined) return sessionNotFound;
      const input = (context.body ?? {}) as { requestId?: unknown; kind?: unknown; text?: unknown; threadId?: unknown; anchor?: unknown };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      const repeated = record.messageRequests?.[input.requestId];
      const earlier = repeated === undefined ? undefined : (record.messages ?? []).find((message) => message.messageId === repeated);
      if (earlier !== undefined) return ok(commentView(record.sessionId, earlier));
      if (input.kind === "steer") return { status: 409, body: { error: { code: "CONFLICT", message: "Messages to the agent aren't available in Rovara Cloud yet. To change the work, use Send back to coding with a note." } } };
      if (input.kind !== "comment") return badRequest("kind must be comment.");
      if (input.anchor !== undefined) return badRequest("Pinning a comment to part of the session isn't available in Rovara Cloud yet.");
      const text = commentText(input.text);
      if ("problem" in text) return badRequest(text.problem);
      const messages = record.messages ?? [];
      if (messages.length >= COMMENTS_PER_SESSION_MAX) return { status: 409, body: { error: { code: "CONFLICT", message: `This session already has ${String(COMMENTS_PER_SESSION_MAX)} comments.` } } };
      let threadId: string | undefined;
      if (input.threadId !== undefined) {
        const parent = typeof input.threadId === "string" ? messages.find((message) => message.messageId === input.threadId) : undefined;
        if (parent === undefined) return badRequest("That comment isn't in this session.");
        threadId = parent.threadId ?? parent.messageId;
      }
      const comment = { messageId: newMessageId(), kind: "comment" as const, source: "app" as const, author: me(context), text: text.text, createdAt: context.now().toISOString(), rev: 1, ...(threadId === undefined ? {} : { threadId }) };
      await context.work.put({ ...record, messages: [...messages, comment], messageRequests: { ...record.messageRequests, [input.requestId]: comment.messageId } });
      return { status: 201, body: commentView(record.sessionId, comment) };
    },
  },
  {
    // PATCH /v1/app/sessions/{id}/messages/{messageId} {rev, text} and DELETE {rev}: only the comment's author, on the revision they saw.
    method: "PATCH", path: /^\/sessions\/(ses_[0-9a-z]{20})\/messages\/(msg_[0-9a-z]{20})$/u,
    answer: (context) => changeComment(context, "edit"),
  },
  {
    method: "DELETE", path: /^\/sessions\/(ses_[0-9a-z]{20})\/messages\/(msg_[0-9a-z]{20})$/u,
    answer: (context) => changeComment(context, "delete"),
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
      delete updated.ownerUnresolved;
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
      return ok({ viewingNow: await context.presence.heartbeat(record.sessionId, me(context), context.now().getTime()) });
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
  {
    // GET /v1/app/company/audit (plan v3.2 7.5): Cloud's own audit records and Code's engine records as one list, newest first, for a company owner or admin.
    // Who and which company: Code's access check now (company-caller.ts), never a parameter; Code checks again on its own route.
    method: "GET", path: /^\/company\/audit$/u,
    answer: async (context) => {
      const who = await companyCaller(context);
      if (refused(who)) return who;
      if (!isCompanyAdmin(who.companyRole)) return { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company administrator can read the audit." } } };
      if (context.audit === undefined) return auditUnavailable;
      try {
        const query = parseCompanyAuditQuery(context.query);
        return ok(await listCompanyAudit({ store: context.audit, engine: codeEngineAuditSource(context.client, context.session), now: context.now }, who.companyId, query));
      } catch (error) {
        if (error instanceof CompanyAuditQueryRefused) return badRequest(error.message);
        // Code's own refusal and an ended sign-in are the handler's; anything else (the store) is "unavailable", with no cause.
        if (error instanceof CodeError || error instanceof SignInEnded) throw error;
        return auditUnavailable;
      }
    },
  },
  // The Work page's reads (the split inbox): the task list and, for one task, its plan, proof index, events and plan comments.
  ...WORK_READS,
  ...LESSONS_ROUTES,
  ...HOW_WE_WORK_ROUTES,
  // Creating a company (DEC 254a), for a person with no company yet.
  ...ONBOARDING_ROUTES,
  ...MEMBER_ROUTES,
  // A project's archive and restore, preview first (DEC 254n item 3): Code decides who may; Cloud passes the person's token and fixed words.
  ...PROJECT_LIFECYCLE_ROUTES,
  ...PROJECT_CREATE_ROUTES,
  // The "AI and spending" step (guided onboarding PR 15): the company's AI model and a project's per-task limit, answered by Code as the person.
  ...AI_SPEND_ROUTES,
  // The in-app inbox (web task channel K5): Code's C7 routes, as the person.
  ...INBOX_ROUTES,
  // The project setup checklist and the hosted setup run (guided onboarding PR 9): Code decides who may; Cloud passes the person's token and fixed words.
  ...SETUP_CHECKLIST_ROUTES,
  ...PEOPLE_ROUTES,
  // The project Wiki tab's reads (lead 4 W5): Code decides who may read; Cloud passes the person's token, rebuilds each answer for that project only, and answers in fixed words.
  ...WIKI_ROUTES,
  // The wiki's corrections (lead 4 C1): Code decides who may add notes, mark wrong, approve and resolve; Cloud passes the person's token and rebuilds each answer.
  ...WIKI_CORRECTION_ROUTES,
  // The wiki panel on the setup page (lead 4 W6): the file map, the build controls and the nightly upkeep switch; Code decides who may, Cloud rebuilds bodies and answers (no dollar figure crosses).
  ...WIKI_SETUP_ROUTES,
  // The admin portal's Cost and time report (Feature A, slice A3): Code's one-row-per-task read, grouped here for a company owner or admin.
  ...REPORT_ROUTES,
  // The smart Just answer and the start box's path suggestion (lead 4 J3): Code decides who may; Cloud passes the person's token, rebuilds each answer, and answers in fixed words. Off unless the deployment says so.
  ...ANSWERS_ROUTES,
];
