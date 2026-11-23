import { ProjectOverviewReaderSchema, TaskCloseActionSchema, TaskClosePreviewResponseSchema, SessionBoundCloseBodySchema } from "@agentx/contracts/web";
import { WorkflowFeedbackFindingsDecisionRequestSchema, WorkflowFeedbackReviewRetryRequestSchema } from "@agentx/contracts";
import { parseTaskMoneyV1 } from "./task-money.js";
// The web app's API routes (/v1/app/*, which the browser calls as /v1/web/*) that Cloud answers from Rovara Code, as
// the signed-in person. Each entry shapes Code's answer into the reader schema the app expects. The migration tracker
// lists every route and where it is answered from (PrepLabsAI/Rovara-cloud#1).
import type { CodeAccess, CodeClient } from "./code-client.js";
import type { CodeSession } from "./sessions.js";
import { newSessionId, type WorkSession, type WorkSessionStore, newMessageId } from "./work-sessions.js";
import { renameInSessions } from "./rename.js";
import { COMMENTS_PER_SESSION_MAX, commentText, commentView, commentsPage, timelineOf, timelinePage, type CodeTaskEvent } from "./conversation.js";
import { approvalUrl, blockedReview, blockedStepRetry, feedbackChoice, followState, reviewChoices, liveTile, sessionRunning, sessionStatus, sessionView, waitingPlan, type CodeTask, type SessionExtras } from "./session-view.js";
import { CLOSE_PREVIEW_NOT_SERVED, CORE_ACTION_WORDS, acceptOnPage, actOnCoreSession, codeSessionOf, isCodeRouteMissing, isCoreNotYet, noSession, pendingPlanCards, securityAcceptRefusal, type FindingsAccept } from "./core-task-actions.js";
import type { PresenceBoard } from "./presence.js";
import { CodeError, SignInEnded, slackWorkspaceHint } from "./code-client.js";
import type { CloudAuditStore } from "./audit-log.js";
import { CompanyAuditQueryRefused, codeEngineAuditSource, listCompanyAudit, parseCompanyAuditQuery } from "./company-audit.js";
import { LIST_PAGE, WORK_READS, detailedTasks } from "./work-reads.js";
import { ONBOARDING_ROUTES } from "./onboarding-routes.js";
import { MEMBER_ROUTES } from "./member-routes.js";
import { PROJECT_LIFECYCLE_ROUTES } from "./project-lifecycle-routes.js";
import { PROJECT_CREATE_ROUTES, createProjects, isCreateProjectsBody } from "./project-create-routes.js";
import { AI_SPEND_ROUTES } from "./ai-spend-routes.js";
import { LEARNING_MODEL_ROUTES } from "./learning-model-routes.js";
import { AGENT_MODELS_ROUTES } from "./agent-models-routes.js";
import { EGRESS_ADDRESSES_ROUTES } from "./egress-addresses-routes.js";
import { SETUP_CHECKLIST_ROUTES, projectSetupStatusOf } from "./setup-checklist-routes.js";
import { codeOwnerOf, openTaskByCodeId } from "./open-task.js";
import { WIKI_ROUTES } from "./wiki-routes.js";
import { KNOWN_FAILING_ROUTES, knownFailingOverview } from "./known-failing-routes.js";
import { SAVED_ENV_ROUTES } from "./saved-env-routes.js";
import { WIKI_CORRECTION_ROUTES } from "./wiki-corrections-routes.js";
import { WIKI_SETUP_ROUTES } from "./wiki-setup-routes.js";
import { EVAL_CHECK_ROUTES } from "./eval-check-routes.js";
import { ANSWERS_ROUTES } from "./answers-routes.js";
import { AGENT_DIRECTORY_ROUTES } from "./agent-directory-routes.js";
import { SYSTEM_RUNS_ROUTES } from "./system-runs-routes.js";
import { TASK_START_REQUEST_ROUTES } from "./task-start-request-routes.js";
import { GITHUB_DISCONNECT_PREVIEW_ROUTES } from "./github-disconnect-preview-routes.js";
import { MERGE_ROUTES } from "./merge-routes.js";
import { SETUP_REPAIR_ROUTES } from "./setup-repair-routes.js";
import { SETUP_LIMITS_ROUTES } from "./setup-limits-routes.js";
import { LESSONS_ROUTES } from "./lessons-routes.js";
import { KNOWLEDGE_SWITCH_ROUTES } from "./knowledge-switch-routes.js";
import { GRADUATION_ROUTES } from "./lessons-graduation-routes.js";
import { SKILLS_ROUTES } from "./skills-routes.js";
import { LESSONS_EXTRAS_ROUTES } from "./lessons-extras-routes.js";
import { HOW_WE_WORK_ROUTES } from "./how-we-work-routes.js";
import { INBOX_ROUTES } from "./inbox-routes.js";
import { PEOPLE_ROUTES, coOwnerOf } from "./people-routes.js";
import { SCRIPT_TOKEN_ROUTES } from "./script-token-routes.js";
import { REPORT_ROUTES } from "./report-routes.js";
import { PLAN_FEATURE_ROUTES } from "./plan-feature-routes.js";
import { PEOPLE_LIMITS_ROUTES } from "./people-limits-routes.js";
import { REPORT_ACTION_ROUTES } from "./report-action-routes.js";
import { INTAKE_UPDATES_ROUTES } from "./intake-updates-routes.js";
import { TASK_LOG_ROUTES } from "./task-log-routes.js";
import type { CompanyBackend } from "./company-routes.js";
import { withdrawForMember, type ProductAiBackend } from "./product-ai-routes.js";
import { NOT_IN_COMPANY, companyCaller, companyNameOf, companyOf, isCompanyAdmin, refused, type CompanyRole } from "./company-caller.js";
import { parseAnswersBody } from "./answers.js";

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
  /** Selected bounded readers retain one deadline across session-recovery attempts. */
  serverReadDeadline?: number;
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
  /** Fixed-shape server events; never log request bodies or answer content. */
  log?: (event: Record<string, unknown>) => void;
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
  const [code, setup] = await Promise.all([codeProject(context, name), projectSetupStatusOf(context, name)]);
  return {
    name, status: "active", latestRevision: code?.latestRevision ?? 1, myRole: roleOf(access), setup,
    repositories: (code?.repositories ?? []).map((repository) => ({ name: repository.name, fullName: repository.fullName ?? repository.name, defaultBranch: repository.defaultBranch })),
  };
}

interface CodeRepositories {
  installations: Array<{ installationId: number; accountLogin: string; accountType: string; repositorySelection: string; status: string; repositories: Array<{ fullName: string; githubRepositoryId: number; private: boolean; defaultBranch: string }> }>;
}

/** Code's task view, version 2, as the app's session page reads it. */
const TASK_VIEW = { "x-agentx-task-view": "2" };

/** A feedback answer from Code that does not read as the contract (a different task, a missing field): nothing is assumed from it. */
const feedbackUnreadable: RouteAnswer = { status: 502, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara answered in an unexpected way. Check this task again." } } };
const sessionNotFound: RouteAnswer = { status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } } };
const badRequest = (message: string): RouteAnswer => ({ status: 400, body: { error: { code: "CONFIG_INVALID", message } } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** A project name in a path, as the lessons routes take it (lessons-routes.ts PROJECT). */
const PROJECT_IN_PATH = "([A-Za-z0-9][A-Za-z0-9._-]{0,99})";
/** DEC 253q (d): the only members of an eval confirm Cloud passes on to Code (Code validates them strictly). */
const evalConfirmNotOnCode = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Confirming an eval isn't connected to Rovara Code yet." } } };
const evalConfirmRefused: RouteAnswer = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner, admin or project maintainer confirms the eval." } } };
/** A company owner or admin (Code's company role), or the project's maintainer (its "administrator" access, roleOf). Code re-checks the role live. */
function confirmsEval(access: CodeAccess, companyRole: CompanyRole, project: string): boolean {
  if (isCompanyAdmin(companyRole)) return true;
  const entry = mine(access, project);
  return entry !== undefined && roleOf(entry.access) === "maintainer";
}

// L4-EVC (DEC 254zzz20 D5, D6, D8): the setup flow's ONE eval card. Code serves four hosted routes under /v1/app/projects/{p}/setup-agent/ (the card's read, ONE approval, a decision on a waiting spend
// item, and the opt-in health check); Cloud forwards each as the signed-in person. Each POST names only its own keys (Code validates them strictly): nothing that names a company, a role or a payer is
// ever forwarded, at the top or inside `seen`.
export const EVAL_APPROVE_KEYS = ["taskId", "reportDigest", "selection", "paths", "approve", "seen"] as const;
export const EVAL_DECIDE_KEYS = ["requestId", "outcome", "seen"] as const;
export const EVAL_HEALTH_KEYS = ["requestId", "seenCostMicros"] as const;
/** The members of `seen` that are passed on: the dollars the person was shown (approve), or the offer's revision and digest (decide). */
const EVAL_SEEN_KEYS = { approve: ["perCheckHighMicros", "monthlyCapMicros"], decide: ["revision", "artifactDigest"] } as const;
const evalCardNotOnCode: RouteAnswer = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "The eval card isn't connected to Rovara Code yet." } } };
const evalCardRefused: RouteAnswer = { status: 403, body: { error: { code: "FORBIDDEN", message: "Only a company owner, admin or project maintainer can answer for the eval's spend." } } };
const EVAL_UNAVAILABLE_ON_INSTALL = "Approving an eval's spend isn't available on this install yet.";
/** L4-EVW4 (DEC 254zzz43): a person's act on the wrapper card names its request id, the act and (to open a pull request) the eval; nothing else. Code's own refusal that no code host is wired for it reads as "not connected yet". */
export const EVAL_WRAPPER_KEYS = ["requestId", "action", "selection"] as const;
const EVAL_WRAPPER_UNAVAILABLE_ON_INSTALL = "Setting up the file Rovara needs to read your eval isn't available on this install yet.";

/** Code's fixed refusal the eval card turns into Cloud's own: not served yet (its unknown-route 404, or the install has no eval approval). Any other refusal is Code's own. */
function evalCardRefusal(error: unknown): RouteAnswer | undefined {
  if (!(error instanceof CodeError)) return undefined;
  const answered = (error.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  if (error.status === 404 && answered?.code === "NOT_FOUND" && (answered.message === "route not found" || answered.message === EVAL_UNAVAILABLE_ON_INSTALL || answered.message === EVAL_WRAPPER_UNAVAILABLE_ON_INSTALL)) return evalCardNotOnCode;
  return undefined;
}

/** One member of the browser's `seen` handed on: only the named keys of a plain object; anything else goes as sent (Code refuses it). */
function evalSeen(value: unknown, keys: readonly string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const given = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(given, key)) kept[key] = given[key];
  return kept;
}

/** The eval card's read or one of its acts, forwarded to Code's own path as the person. A POST is for a company owner or admin, or the project's maintainer (Code re-checks live), except the wrapper card's "Check now" (a read); the read is for anyone in the company. */
function evalCardRoute(method: "GET" | "POST", tail: "eval" | "eval-approve" | "eval-decide" | "eval-health" | "eval-wrapper", keys: readonly string[], seenKeys?: readonly string[]): Route {
  return {
    method, path: new RegExp(`^/projects/${PROJECT_IN_PATH}/setup-agent/${tail}$`, "u"),
    answer: async ({ client, session, params, body }) => {
      const project = params[0]!;
      const membership = companyOf(session.access);
      if (membership === undefined) return NOT_IN_COMPANY;
      const path = `/v1/app/projects/${encodeURIComponent(project)}/setup-agent/${tail}`;
      try {
        if (method === "GET") return ok(await client.json<unknown>(session, path));
        if (body === null || typeof body !== "object" || Array.isArray(body)) return confirmsEval(session.access, membership.companyRole, project) ? badRequest("Send the eval answer as a JSON object.") : evalCardRefused;
        const given = body as Record<string, unknown>;
        // "Check now" on the wrapper card only reads the default branch: any member of the project may ask it (Code decides who may see the project). Every other act is for a company owner, admin or the project's maintainer.
        const readOnly = tail === "eval-wrapper" && given["action"] === "check";
        if (!readOnly && !confirmsEval(session.access, membership.companyRole, project)) return evalCardRefused;
        const forwarded: Record<string, unknown> = {};
        for (const key of keys) if (Object.hasOwn(given, key)) forwarded[key] = key === "seen" ? evalSeen(given[key], seenKeys ?? []) : given[key];
        return ok(await client.json<unknown>(session, path, { method: "POST", body: forwarded }));
      } catch (error) {
        const refusal = evalCardRefusal(error);
        if (refusal !== undefined) return refusal;
        throw error;
      }
    },
  };
}
const EVAL_CARD_ROUTES: Route[] = [
  evalCardRoute("GET", "eval", []),
  evalCardRoute("POST", "eval-approve", EVAL_APPROVE_KEYS, EVAL_SEEN_KEYS.approve),
  evalCardRoute("POST", "eval-decide", EVAL_DECIDE_KEYS, EVAL_SEEN_KEYS.decide),
  evalCardRoute("POST", "eval-health", EVAL_HEALTH_KEYS),
  evalCardRoute("POST", "eval-wrapper", EVAL_WRAPPER_KEYS),
];

async function readTask(context: RouteContext, taskId: string): Promise<CodeTask> {
  const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(taskId)}`, { headers: TASK_VIEW });
  const { money: rawMoney, ...legacy } = task;
  const money = parseTaskMoneyV1(rawMoney);
  return { ...legacy, ...(money?.taskId === task.taskId ? { money } : {}) };
}

/** The session and its task, or undefined for a session Cloud doesn't have. Code decides whether the person may see the task. */
async function sessionAndTask(context: RouteContext): Promise<{ record: WorkSession; task: CodeTask } | undefined> {
  const record = await context.work.get(context.params[0]!);
  if (record === undefined) return undefined;
  const task = await readTask(context, record.taskId);
  return { record: await ownerFromCode(context, record, task), task };
}

/**
 * Code names the task's owner (`task.owner`, open-task.ts codeOwnerOf). When that is the person reading and the session still names someone else (a take-over the
 * person confirmed on Code's page after Code answered PENDING), the session now names them. Only ever the reader, only on Code's own word; best effort (a race keeps the record).
 */
async function ownerFromCode(context: RouteContext, record: WorkSession, task: CodeTask): Promise<WorkSession> {
  const owner = codeOwnerOf(task);
  const me = context.session.access.developerId;
  if (owner === undefined || owner.developerId !== me || record.owner.developerId === me) return record;
  const updated: WorkSession = { ...record, owner: { developerId: me, name: context.session.access.displayName }, revision: record.revision + 1 };
  delete updated.ownerUnresolved;
  // Best effort: a store that cannot be written now (a race, throttling) keeps the record and never costs the read.
  try { await context.work.put(updated); } catch (error) { if (error instanceof SignInEnded) throw error; return record; }
  return updated;
}

/** The reader, with the name they signed in with now: their own name on a session is always current (Rovara-cloud#39). */
const viewer = (context: RouteContext) => ({ developerId: context.session.access.developerId, name: context.session.access.displayName, ...(context.session.access.companyRole === undefined ? {} : { companyRole: context.session.access.companyRole }) });
const me = (context: RouteContext) => ({ developerId: context.session.access.developerId, name: context.session.access.displayName });

/** The session's followers and viewers for this person. */
const peopleOf = async (context: RouteContext, record: WorkSession) => ({ ...followState(record, context.session.access.developerId), viewingNow: await context.presence.viewing(record.sessionId, context.now().getTime()) });

/** Code's pending plan cards for this request's person, read once per request and only when needed (core-task-actions.ts). */
const planCardsRead = new WeakMap<RouteContext, Promise<ReadonlySet<string>>>();
/**
 * Audit 2026-11-18 item 6: what the session view needs beside the task. Only for the owner with a plan waiting: whether Code decides that plan on a card (a core task), so the
 * view links to the card on the session page and never to Cloud's approval page, which the core does not take.
 */
async function extrasOf(context: RouteContext, record: WorkSession, task: CodeTask): Promise<SessionExtras> {
  if (record.owner.developerId !== context.session.access.developerId) {
    // A live People co-owner may answer review findings or retry a blocked step (Code checks again in the move).
    return (reviewChoices(task) !== undefined || blockedStepRetry(task) !== undefined || feedbackChoice(task)) && await coOwnerOf(context, record) ? { coOwner: true } : {};
  }
  if (waitingPlan(task) === undefined) return {};
  let cards = planCardsRead.get(context);
  if (cards === undefined) planCardsRead.set(context, cards = pendingPlanCards(context.client, context.session));
  return (await cards).has(record.taskId.toLowerCase()) ? { planOnCard: true } : {};
}

/** Whether this person may make an owner's move on the session's task from Cloud: its owner, or a co-owner on Code's People list (Code checks again either way). */
const ownerOrCoOwner = async (context: RouteContext, record: WorkSession): Promise<boolean> =>
  record.owner.developerId === context.session.access.developerId || await coOwnerOf(context, record);

/** The session as the app reads it, for this person now. */
async function viewOf(context: RouteContext, record: WorkSession, task: CodeTask, people?: Awaited<ReturnType<typeof peopleOf>>) {
  return sessionView(record, task, viewer(context), context.origin, people, await extrasOf(context, record, task));
}

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
  const bodyIsEmpty = context.body === undefined || context.body === null
    || (typeof context.body === "object" && !Array.isArray(context.body) && Object.keys(context.body).length === 0);
  const queryRev = bodyIsEmpty ? context.query.get("rev") : null;
  const revision = input.rev ?? (queryRev !== null && /^[1-9]\d*$/u.test(queryRev) ? Number(queryRev) : undefined);
  if (revision !== comment.rev) return { status: 409, body: { error: { code: "CONFLICT", message: "This comment changed since you opened it. Refresh and try again." } } };
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
  return (await Promise.all(running.map(async ({ record, task }) => liveTile(record, task, viewer(context), context.origin, await peopleOf(context, record), await extrasOf(context, record, task)))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The person's own tasks from Code's detailed list (one read, Code #1045), by task id, as the task view would say the parts Home reads; undefined when Code refuses the list or
 * does not serve the detail (Home then reads each session's task as before). An ended sign-in is not swallowed.
 */
async function listedTasks(context: RouteContext): Promise<Map<string, CodeTask> | undefined> {
  let found: Awaited<ReturnType<typeof detailedTasks>>;
  try {
    found = await detailedTasks(context.client, context.session, 1, LIST_PAGE);
  } catch (error) {
    if (error instanceof CodeError) return undefined;
    throw error;
  }
  if (!found.served) return undefined;
  const byId = new Map<string, CodeTask>();
  for (const row of found.rows) {
    const task = row as Partial<CodeTask>;
    if (typeof task.taskId === "string" && typeof task.title === "string" && typeof task.project === "string" && typeof task.status === "string" && typeof task.updatedAt === "string") byId.set(task.taskId.toLowerCase(), task as CodeTask);
  }
  return byId;
}

/** Whether Home needs the task's whole view for this person's card: a plan waiting for its owner's review, or a review stop its owner moves on (the list row has neither's details). */
const needsWholeTask = (task: CodeTask, owner: boolean): boolean => owner && sessionStatus(task) === "needs_person"
  && ((task.workflow?.stage === "PLAN_REVIEW" && task.workflow.state === "WAITING") || (task.workflow?.stage === "REVIEW" && task.workflow.state === "BLOCKED"));

async function homeCards(context: RouteContext): Promise<{ cards: HomeCard[]; total: number }> {
  const me = context.session.access.developerId;
  const sessions = (await context.work.startedBy(me)).slice(0, HOME_SESSIONS_READ);
  const origin = context.origin.replace(/\/+$/u, "");
  // One list read for the person's tasks; a task is read on its own only where the card needs its whole view, or where the list did not have it.
  const listed = sessions.length === 0 ? undefined : await listedTasks(context);
  const read = await Promise.all(sessions.map(async (record) => {
    const row = listed?.get(record.taskId.toLowerCase());
    if (row !== undefined && !needsWholeTask(row, record.owner.developerId === me)) return { record, task: row };
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
      // A core task's plan is decided on its decision card, which the session page shows (audit 2026-11-18 item 6); any other plan on Cloud's approval page.
      const onCard = (await extrasOf(context, record, task)).planOnCard === true;
      card("plan", `The plan for ${task.project} is waiting for your review.`, [onCard ? { label: "Review plan", action: "open", href: open.href, method: "GET" } : { label: "Review plan", action: "confirm", href: approvalUrl(origin, record.sessionId), method: "GET" }, open]);
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
    // Project machine size: member reads; SET is a stored choice; Code decides who may make it.
    method: "GET", path: /^\/projects\/([^/]+)\/machine-size$/u,
    answer: async (context) => {
      const project = context.params[0]!;
      if (mine(await context.client.access(context.session), project) === undefined) return projectNotFound;
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
      if (mine(await context.client.access(context.session), project) === undefined) return projectNotFound;
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
    // GET /v1/app/me/sign-in-workspace (L4-SIGNIN): the Slack workspace id of THIS sign-in, when it was a Slack sign-in, so the browser can remember it as
    // "the last workspace" (a localStorage hint for the next Sign in with Slack). From the sign-in's own access check (Code's record, kept on the session);
    // no call to Code, no company needed. Only a workspace id leaves, and only for the signed-in browser's own sign-in.
    method: "GET", path: /^\/me\/sign-in-workspace$/u,
    answer: async ({ session }) => {
      const slackTeamId = slackWorkspaceHint((session.access as { slackTeamId?: unknown } | undefined)?.slackTeamId);
      return ok(slackTeamId === undefined ? {} : { slackTeamId });
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
    // GET /v1/app/decisions (DecisionCardsViewReaderSchema): Code's decision cards, passed through as Code built them: each card carries the digest Code
    // checks when the person acts. Code serves them on its own `/v1/app/decisions` (core host, the same strict card shapes as contracts decision-card-tabs.ts);
    // Cloud used to ask `/v1/dev/client/decisions`, which Code never served (L4-MF1 side finding, 2026-11-17). A Code that does not serve the route
    // (an older one, or the core off), its 404 or 501 becomes the 404 the app reads as "cards are switched off": it shows none, and Home's plan, failure and
    // pull-request cards still show, where any other answer would show as an error.
    method: "GET", path: /^\/decisions$/u,
    answer: async ({ client, session }) => {
      try {
        return ok(await client.json<unknown>(session, "/v1/app/decisions"));
      } catch (error) {
        if (error instanceof CodeError && (error.status === 404 || error.status === 501)) return decisionsOff;
        throw error;
      }
    },
  },
  {
    // POST /v1/app/decisions/{kind}/{subject}/{approve|request-changes|reject|evidence-opened}: one card, one request (contract v0 `decisions.act`; Code's own
    // path is `/v1/app/decisions/...`, not the contract row's historical `/v1/dev/client/decisions/...`). Code checks
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
      return ok(await client.json<unknown>(session, `/v1/app/decisions/${encodeURIComponent(kind)}/${encodeURIComponent(subject)}/${action}${suffix}`, { method: "POST", body }));
    },
  },
  {
    // GET /v1/app/projects/{p}/overview (ProjectOverviewSchema).
    method: "GET", path: /^\/projects\/([^/]+)\/overview$/u,
    answer: async (context) => {
      const name = context.params[0]!;
      const access = await context.client.access(context.session);
      const project = mine(access, name);
      if (project === undefined) return projectNotFound;
      const [code, setup] = await Promise.all([codeProject(context, name), projectSetupStatusOf(context, name)]);
      const role = roleOf(project.access);
      const membership = companyOf(access);
      const canEditSettings = role === "maintainer" || isCompanyAdmin(membership?.companyRole);
      const knownFailing = membership !== undefined && canEditSettings ? await knownFailingOverview(context, name) : undefined;
      const overview = {
        project: {
          name, status: "active", ...(code === undefined ? {} : { latestRevision: code.latestRevision }),
          repositories: (code?.repositories ?? []).slice(0, 20).map((repository) => ({ fullName: repository.fullName ?? repository.name, defaultBranch: repository.defaultBranch })),
          setup, channels: [],
        },
        you: { role, canStartWork: true, canEditSettings, canViewSpend: false },
        ...(knownFailing === undefined ? {} : { knownFailing }),
        agents: [],
        running: await runningInProject(context, name),
      };
      const parsed = ProjectOverviewReaderSchema.safeParse(overview);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map(issue => issue.path[0]).filter((field): field is string => typeof field === "string" && ["project", "you", "agents", "running", "budget", "learning", "orgId", "knownFailing"].includes(field)))];
        context.log?.({ event: "cloud.response_shape_failure", fields });
      }
      return ok(overview);
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
    // POST /v1/web/projects/{p}/setup-agent/eval-confirm: remains unavailable on Cloud. Keep the company and project role checks
    // so unauthorized callers receive the same fixed refusal as other company actions.
    method: "POST", path: new RegExp(`^/projects/${PROJECT_IN_PATH}/setup-agent/eval-confirm$`, "u"),
    answer: async ({ session, params, body }) => {
      const project = params[0]!;
      // The sign-in's latest access answer: Code re-checks the role live on its own route, so this only spares Code a call it would refuse.
      const membership = companyOf(session.access);
      if (membership === undefined) return NOT_IN_COMPANY;
      if (!confirmsEval(session.access, membership.companyRole, project)) return evalConfirmRefused;
      if (body === null || typeof body !== "object" || Array.isArray(body)) return badRequest("Send the eval confirmation as a JSON object.");
      return evalConfirmNotOnCode;
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
    // POST /v1/app/tasks/{taskId}/answers: Understand's questions answered from the Work list or Home (Code #1057 puts the round on the list row), for a task with or without a
    // Cloud session. The body is the session page's answer form's, checked the same way (answers.ts: request id, round, the revision the row read, one to three answers); only the
    // request id, round and answers go to Code's POST /v1/dev/tasks/{taskId}/answers, as the signed-in person. Cloud adds no reach: it keeps no record of the task and
    // decides nothing; Code decides who may answer (another company's task and one the person may not act on read as no such task) and its refusals pass through unchanged.
    // The answer says only that Code took them: the page reads its list again.
    method: "POST", path: /^\/tasks\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\/answers$/u,
    answer: async (context) => {
      const input = parseAnswersBody(context.body);
      if (!input.ok) return badRequest(input.message);
      const taskId = context.params[0]!.toLowerCase();
      await context.client.json(context.session, `/v1/dev/tasks/${encodeURIComponent(taskId)}/answers`, { method: "POST", headers: TASK_VIEW, body: input.value });
      return ok({ taskId, answered: true });
    },
  },
  {
    // GET /v1/app/sessions/{id}: Cloud's session around Code's task.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      return found === undefined ? sessionNotFound : ok({ session: await viewOf(context, found.record, found.task, await peopleOf(context, found.record)) });
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
      return ok({ session: await viewOf(context, found.record, await readTask(context, found.record.taskId), await peopleOf(context, found.record)) });
    },
  },
  // PR feedback (CLOUD-HALF "Private app implementation"). Cloud passes the person's token and Code decides everything: who may read or decide (the live
  // owner or an explicitly authorized co-owner), the revision and digests the press is bound to, the selection, admission and the task's money. Cloud only
  // checks the body against Code's own request schemas (a malformed one never reaches Code) and answers with the session Code's returned task makes
  // (the authoritative read-back). Code's refusals reach the app as Code's own status and body.
  {
    // Code GET .../workflow/feedback -> { review }. Collecting (no report yet) is Code's 404; the page reads that state from the task itself.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})\/feedback$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const read = await context.client.json<{ review?: unknown }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/workflow/feedback`, { headers: TASK_VIEW });
      const review = (read as { review?: unknown } | null)?.review;
      if (review === null || typeof review !== "object" || Array.isArray(review) || (review as { taskId?: unknown }).taskId !== record.taskId) return feedbackUnreadable;
      return ok({ review });
    },
  },
  {
    // Code POST .../workflow/feedback-decision, the body exactly WorkflowFeedbackFindingsDecisionRequestSchema -> { task }.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/feedback-decision$/u,
    answer: async (context) => {
      // The company's own sessions first (another company's session is absent before anything else), then the body against Code's own schema.
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const input = WorkflowFeedbackFindingsDecisionRequestSchema.safeParse(context.body);
      if (!input.success) return badRequest("Send the choice exactly as the feedback card made it.");
      const answer = await context.client.json<{ task?: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/workflow/feedback-decision`, { method: "POST", headers: TASK_VIEW, body: input.data });
      if (answer?.task?.taskId !== record.taskId) return feedbackUnreadable;
      return ok({ session: await viewOf(context, record, answer.task, await peopleOf(context, record)) });
    },
  },
  {
    // Code POST .../workflow/feedback-retry, exactly { reviewDigest } -> { task, started }.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/feedback-retry$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const input = WorkflowFeedbackReviewRetryRequestSchema.safeParse(context.body);
      if (!input.success) return badRequest("Send only the review to retry.");
      const answer = await context.client.json<{ task?: CodeTask; started?: unknown }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/workflow/feedback-retry`, { method: "POST", headers: TASK_VIEW, body: input.data });
      if (answer?.task?.taskId !== record.taskId || typeof answer.started !== "boolean") return feedbackUnreadable;
      return ok({ session: await viewOf(context, record, answer.task, await peopleOf(context, record)), started: answer.started });
    },
  },
  {
    // One Retry: blocked non-review steps use Code's served workflow/retry, as owner/co-owner.
    // Review Retry retains its candidate-bound workflow/review implementation. No session fallback.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/retry$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      if (found === undefined) return sessionNotFound;
      const requestId = (context.body as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId !== "string" || !UUID.test(requestId)) return badRequest("requestId must be a UUID.");
      const stepRetry = blockedStepRetry(found.task);
      if (!(stepRetry === undefined ? found.record.owner.developerId === context.session.access.developerId : await ownerOrCoOwner(context, found.record))) return { status: 403, body: { error: { code: "FORBIDDEN", message: `Only ${found.record.owner.name}${stepRetry === undefined ? "" : " or a co-owner"} can retry this session.` } } };
      const retry = stepRetry ?? blockedReview(found.task)?.retry;
      if (retry === undefined) return { status: 409, body: { error: { code: "CONFLICT", message: "There's nothing to retry on this session right now." } } };
      const shown = context.body as { expectedRevision?: unknown; candidateDigest?: unknown };
      if (stepRetry !== undefined) {
        if (shown.expectedRevision !== stepRetry.expectedRevision) return { status: 409, body: { error: { code: "CONFLICT", message: "This step changed since you read it. Read the task again." } } };
        // Proven pre-dispatch refusals only. Code next 271a60202 developer-tasks.ts:
        // 1984-1993, 2168-2173, 2464-2472; errors.ts maps CONFIG_INVALID to 400.
        // Generic 403/404 can come from the post-apply authorization read (2206).
        const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/workflow/retry`, {
          method: "POST", headers: TASK_VIEW,
          body: { requestId, expectedRevision: shown.expectedRevision, instructions: "Retry the blocked workflow step." },
        }).catch((failure: unknown) => {
          const final: ReadonlyArray<readonly [number, string, string?]> = [
            ...["BUDGET_EXCEEDED", "ORG_BUDGET_EXCEEDED", "PROJECT_BUDGET_EXCEEDED", "AGENT_BUDGET_EXCEEDED", "MACHINE_TIME_EXCEEDED"].map(code => [402, code] as const),
            [400, "CONFIG_INVALID", "refresh the task and include its current revision before retrying verification"],
            [400, "CONFIG_INVALID", "choose checks that are approved for this project"],
            [400, "CONFIG_INVALID", "this action can retry blocked planning or coding, or run selected checks for blocked verification or a change ready to publish"],
            [400, "CONFIG_INVALID", "the approved ordered work plan is retained, but this broker is not enabled to retry it"],
            // NOT final (no 409 IDEMPOTENCY_CONFLICT sentence at all): "this retry is out of date; refresh the task and try again" is thrown pre-write (parity-task-actions.ts:76, 84) but ALSO via started(...) AFTER admitRound + startImplementation/startPublication (:78, :95), i.e. after a PAID round is admitted; "the verification retry is stale; ..." is also thrown AFTER commit (:88). Both stay unknown (DEC 254zzz285 lock + Check).
          ];
          if (failure instanceof CodeError) {
            const error = (failure.body as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
            if (final.some(([status, code, words]) => failure.status === status && error?.code === code && typeof error.message === "string" && error.message.trim() !== "" && (words === undefined || error.message === words))) throw failure;
          }
          throw new CodeError(502, { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara didn't confirm this retry. Check the task before retrying again." } });
        });
        return ok({ session: await viewOf(context, found.record, task, await peopleOf(context, found.record)) });
      }
      if (!Number.isSafeInteger(shown.expectedRevision) || (shown.expectedRevision as number) < 0 || typeof shown.candidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(shown.candidateDigest)) return badRequest("The displayed revision and candidate digest are required.");
      // The caller's displayed pins belong to this intent. Never replace them
      // with retry from this authorization read, or downgrade to core Retry.
      const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/workflow/review`, {
        method: "POST", headers: TASK_VIEW,
        body: { requestId, expectedRevision: shown.expectedRevision, candidateDigest: shown.candidateDigest, instructions: "Retry the independent read-only code and security reviews on the same verified candidate. Do not edit files." },
      });
      return ok({ session: await viewOf(context, found.record, task, await peopleOf(context, found.record)) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/send-back (Rovara-cloud#25): a task stopped by review findings goes back to coding with the owner's note. Code adds
    // the findings to the coding agent's prompt itself (workflow/send-back); the note is the owner's own instruction. Only the owner.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/send-back$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      if (found === undefined) return sessionNotFound;
      const input = (context.body ?? {}) as { requestId?: unknown; note?: unknown; expectedRevision?: unknown; candidateDigest?: unknown };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      if (input.note !== undefined && (typeof input.note !== "string" || input.note.trim().length > 1000)) return badRequest("The note is at most 1,000 characters.");
      const choices = reviewChoices(found.task);
      if (choices === undefined) return { status: 409, body: { error: { code: "CONFLICT", message: "There are no review findings to send back right now." } } };
      if (!await ownerOrCoOwner(context, found.record)) return { status: 403, body: { error: { code: "FORBIDDEN", message: `Only ${found.record.owner.name} or a co-owner can send this back to coding.` } } };
      if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || typeof input.candidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(input.candidateDigest)) return badRequest("This page is out of date. Reload to continue.");
      const note = typeof input.note === "string" && input.note.trim() !== "" ? input.note.trim() : "Fix the review findings.";
      const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/workflow/send-back`, {
        method: "POST", headers: TASK_VIEW, body: { requestId: input.requestId, expectedRevision: input.expectedRevision, instructions: note },
      });
      return ok({ session: await viewOf(context, found.record, task, await peopleOf(context, found.record)) });
    },
  },
  {
    // POST /v1/app/sessions/{id}/accept-findings (Rovara-cloud#25): the owner accepts every blocking finding of the current code with their reason, so
    // the reviews clear and Code opens the pull request (workflow/review-findings). The IDs are computed here from Code's task, never taken from the request.
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/accept-findings$/u,
    answer: async (context) => {
      const found = await sessionAndTask(context);
      if (found === undefined) return sessionNotFound;
      const input = (context.body ?? {}) as { requestId?: unknown; reason?: unknown; expectedRevision?: unknown; candidateDigest?: unknown };
      if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) return badRequest("requestId must be a UUID.");
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (reason === "" || reason.length > 500) return badRequest("Give a reason of up to 500 characters for accepting the findings.");
      const choices = reviewChoices(found.task);
      if (choices === undefined) return { status: 409, body: { error: { code: "CONFLICT", message: "There are no review findings to accept right now." } } };
      if (!await ownerOrCoOwner(context, found.record)) return { status: 403, body: { error: { code: "FORBIDDEN", message: `Only ${found.record.owner.name} or a co-owner can accept these findings.` } } };
      if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || typeof input.candidateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(input.candidateDigest)) return badRequest("This page is out of date. Reload to continue.");
      const accept: FindingsAccept = { requestId: input.requestId, expectedRevision: input.expectedRevision as number, candidateDigest: input.candidateDigest, resolutions: choices.findings.map((finding) => ({ findingId: finding.findingId, action: "ACCEPT", note: reason })) };
      let task: CodeTask;
      try {
        ({ task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(found.record.taskId)}/workflow/review-findings`, { method: "POST", headers: TASK_VIEW, body: accept }));
      } catch (error) {
        // The core takes a security finding's accept only on the web page's own route (Code #1045), which Cloud asks next, with the same body. Said in fixed words,
        // never Code's bare 403. The owner/co-owner rule above and Code's own check both stay (owner DEC 254zzz73 removed only the step-up).
        const refused = securityAcceptRefusal(error);
        if (refused !== "page") throw error;
        const done = await acceptOnPage(context.client, context.session, found.record.taskId, accept);
        if ("answer" in done) return done.answer;
        task = done.task;
      }
      return ok({ session: await viewOf(context, found.record, task, await peopleOf(context, found.record)) });
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
      return ok({ session: await viewOf(context, record, task) });
    },
  },
  {
    // DEC 254zzz367: the exact D-CORE preview, as this caller; Code also checks its preview authority.
    method: "GET", path: /^\/sessions\/(ses_[0-9a-z]{20})\/close$/u,
    answer: async (context) => {
      const record = await readableSession(context);
      if (record === undefined) return sessionNotFound;
      const action = TaskCloseActionSchema.safeParse(context.query.get("action"));
      if (context.query.size !== 1 || !action.success) return badRequest("Choose close or discard to preview this task.");
      let raw: unknown;
      try { raw = await context.client.json<unknown>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/close?action=${action.data}`); }
      // An older Code has no preview route: said once, as 501 NOT_ON_CODE_YET, so the app's legacy close is used only on this served answer.
      catch (error) { if (isCodeRouteMissing(error)) return { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: CLOSE_PREVIEW_NOT_SERVED } } }; throw error; }
      const preview = TaskClosePreviewResponseSchema.safeParse(raw);
      if (!preview.success) return { status: 502, body: { error: { code: "INVALID_RESPONSE", message: "Rovara Code's Close preview couldn't be read. Refresh to review it again." } } };
      return ok(preview.data);
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
      let closed: { task: CodeTask; closed: boolean; discardedUnpublished?: boolean; unpublished?: unknown; message?: string };
      // A supplied binding (even malformed) must never become a legacy close or use its fallback.
      if (Object.hasOwn(input, "expectedPreviewDigest") || Object.hasOwn(input, "discard_unpublished")) {
        const bound = SessionBoundCloseBodySchema.safeParse(input);
        if (!bound.success) return badRequest("Close needs the preview digest, a requestId UUID and an optional discard_unpublished boolean.");
        const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/close`, { method: "POST", headers: TASK_VIEW, body: bound.data });
        closed = { task, closed: task.status === "CLOSED" };
      } else try {
        closed = await context.client.json<{ task: CodeTask; closed: boolean; discardedUnpublished?: boolean; unpublished?: unknown; message?: string }>(
          context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/close`,
          { method: "POST", headers: TASK_VIEW, body: { requestId: input.requestId, ...(input.discardUnpublished === true ? { discard_unpublished: true } : {}) } },
        );
      } catch (error) {
        // A core task (audit 2026-11-18 item 6): the core closes it through the task's session (its owner, at the `edit` level). Code's 404 said the person may read the task.
        if (!isCoreNotYet(error)) throw error;
        const current = await readTask(context, record.taskId);
        // A core task started before Code kept a session for every task (Code #1045, no backfill) can't be closed from here: said at once, before any question about unpublished work.
        if (codeSessionOf(current) === undefined) return noSession("close");
        // The core's close has no unpublished-work check yet (Code core/task-flow/close.ts), so the first ask never closes: it says so, as the old close lists what it found, and only the
        // person's second, explicit press (`discardUnpublished`) closes the task.
        if (input.discardUnpublished !== true) {
          return ok({ session: await viewOf(context, record, current), closed: false, unpublished: [{ repository: "This task's workspace", reasons: [CORE_ACTION_WORDS.closeFirstAsk] }] });
        }
        const done = await actOnCoreSession(context.client, context.session, current, "close", input.requestId);
        if ("answer" in done) return done.answer;
        closed = { task: done.task, closed: true };
      }
      return ok({
        session: await viewOf(context, record, closed.task), closed: closed.closed,
        ...(closed.discardedUnpublished === undefined ? {} : { discardedUnpublished: closed.discardedUnpublished }),
        ...(closed.unpublished === undefined ? {} : { unpublished: closed.unpublished }),
        ...(closed.message === undefined ? {} : { message: closed.message }),
      });
    },
  },
  {
    // POST /v1/app/sessions/{id}/take-over: the person becomes the task's owner in Code (against the People revision the caller was shown).
    method: "POST", path: /^\/sessions\/(ses_[0-9a-z]{20})\/take-over$/u,
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      const { requestId, expectedPeopleRevision } = (context.body ?? {}) as { requestId?: unknown; expectedPeopleRevision?: unknown };
      if (typeof requestId !== "string" || !UUID.test(requestId)) return badRequest("requestId must be a UUID.");
      if (typeof expectedPeopleRevision !== "number" || !Number.isSafeInteger(expectedPeopleRevision) || expectedPeopleRevision < 1) return badRequest("expectedPeopleRevision must be a positive safe integer.");
      const path = `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/people`;
      // Never rebase the person's consent onto a fresh read. Code checks this exact shown revision before changing ownership.
      const answer = await context.client.json<unknown>(context.session, `${path}/take-ownership`, { method: "POST", body: { requestId, expectedPeopleRevision } });
      // Code's answer (TaskPeopleChangeResultSchema): COMMITTED made the person the owner now; PENDING waits for them to confirm on Code's page, and until then the
      // old owner stays the owner, in Code and here. Anything else is not a take-over Cloud records.
      const change = typeof answer === "object" && answer !== null && typeof (answer as { change?: unknown }).change === "object" ? (answer as { change: Record<string, unknown> }).change : undefined;
      if (change?.["status"] === "PENDING") {
        const pending = change["requestId"];
        if (typeof pending !== "string" || !UUID.test(pending) || pending.toLowerCase() !== requestId.toLowerCase() || !UUID.test(record.taskId)) return { status: 502, body: { error: { code: "INVALID_RESPONSE", message: "Rovara Code's answer couldn't be read. Refresh to check who owns this task." } } };
        // Where to confirm is Cloud's own build of Code's confirm page (as the People panel's), never Code's text passed on.
        const confirmUrl = `${context.client.baseUrl}/review/${record.taskId.toLowerCase()}/task/people/confirm/${pending.toLowerCase()}`;
        return { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl, changes: ["Make you the owner of this task"] } };
      }
      if (change?.["status"] !== "COMMITTED") return { status: 502, body: { error: { code: "INVALID_RESPONSE", message: "Rovara Code's answer couldn't be read. Refresh to check who owns this task." } } };
      const updated: WorkSession = { ...record, owner: { developerId: context.session.access.developerId, name: context.session.access.displayName }, revision: record.revision + 1 };
      delete updated.ownerUnresolved;
      await context.work.put(updated);
      return ok({ session: await viewOf(context, updated, await readTask(context, record.taskId)) });
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
  // Graduation and tidy first: `…/lessons/tidy/retire` must be tried before `…/lessons/{id}/retire`.
  ...GRADUATION_ROUTES,
  ...LESSONS_EXTRAS_ROUTES,
  ...LESSONS_ROUTES,
  // L4-JA7: "Knowledge stays in Rovara" and a project's local tools setting, as the person (knowledge-switch-routes.ts).
  ...KNOWLEDGE_SWITCH_ROUTES,
  // Rovara skills (L4-JA): list, one skill with its text, edit, approve (two different people) and retire, as the person; Code decides.
  ...SKILLS_ROUTES,
  ...HOW_WE_WORK_ROUTES,
  // Creating a company (DEC 254a), for a person with no company yet.
  ...ONBOARDING_ROUTES,
  ...MEMBER_ROUTES,
  // A project's archive and restore, preview first (DEC 254n item 3): Code decides who may; Cloud passes the person's token and fixed words.
  ...PROJECT_LIFECYCLE_ROUTES,
  ...PROJECT_CREATE_ROUTES,
  // The "AI and spending" step (guided onboarding PR 15): the company's AI model and a project's per-task limit, answered by Code as the person.
  ...AI_SPEND_ROUTES,
  // The model the company's lessons learn with (DEC 254zzz63): its own choice or the install default, answered by Code as the person.
  ...LEARNING_MODEL_ROUTES,
  // DEC 254zzz84 (1): the company's per-step AI models, answered by Code as the person.
  ...AGENT_MODELS_ROUTES,
  // Rovara's outbound addresses (L4-EGR): a read for company owners and admins, answered by Code as the person.
  ...EGRESS_ADDRESSES_ROUTES,
  // The in-app inbox (web task channel K5): Code's C7 routes, as the person.
  ...INBOX_ROUTES,
  // The project setup checklist and the hosted setup run (guided onboarding PR 9): Code decides who may; Cloud passes the person's token and fixed words.
  ...SETUP_CHECKLIST_ROUTES,
  ...EVAL_CARD_ROUTES,
  ...PEOPLE_ROUTES,
  // The admin's People and limits read (cost report slice A6): each member's spend this month against their limit, by name, company owners and admins only.
  ...PEOPLE_LIMITS_ROUTES,
  ...TASK_LOG_ROUTES,
  ...SCRIPT_TOKEN_ROUTES,
  // The project Wiki tab's reads (lead 4 W5): Code decides who may read; Cloud passes the person's token, rebuilds each answer for that project only, and answers in fixed words.
  ...WIKI_ROUTES,
  // L4-MF1: the saved environment image read (forwarded to Code) and the start preview (answered here: unknown).
  ...SAVED_ENV_ROUTES,
  ...KNOWN_FAILING_ROUTES,
  // The wiki's corrections (lead 4 C1): Code decides who may add notes, mark wrong, approve and resolve; Cloud passes the person's token and rebuilds each answer.
  ...WIKI_CORRECTION_ROUTES,
  // The wiki panel on the setup page (lead 4 W6): the file map, the build controls and the nightly upkeep switch; Code decides who may, Cloud rebuilds bodies and answers (no dollar figure crosses).
  ...WIKI_SETUP_ROUTES,
  // L4-EVCI2: the setup checklist's "Eval check from your CI" (Code decides who may; Cloud rebuilds every body and answer).
  ...EVAL_CHECK_ROUTES,
  // L4-P3: the company's one control over nightly upkeep (read, allow, withdraw): company owners and admins only; Code decides again.
  ...SYSTEM_RUNS_ROUTES,
  ...MERGE_ROUTES,
  ...TASK_START_REQUEST_ROUTES,
  ...GITHUB_DISCONNECT_PREVIEW_ROUTES,
  // L4-U5: the "Setup needs repair" card on a project's setup page and its "Re-check setup" button, passed to Code as the person; Code decides who may.
  ...SETUP_REPAIR_ROUTES,
  // SETUP-LIMITS: a project's setup-run limits (read, change), passed to Code as the person; Code decides who may and what a number may be.
  ...SETUP_LIMITS_ROUTES,
  // The admin portal's Cost and time report (Feature A, slice A3): Code's one-row-per-task read, grouped here for a company owner or admin.
  ...REPORT_ROUTES,
  // The plan card's available feature choices (lead 4 PCF); filing and creation use the Cost and time report actions below.
  ...PLAN_FEATURE_ROUTES,
  // The smart Just answer and the start box's path suggestion (lead 4 J3): Code decides who may; Cloud passes the person's token, rebuilds each answer, and answers in fixed words. Off unless the deployment says so.
  ...ANSWERS_ROUTES,
  // Its actions (lane L4-CR4): new feature, rename, merge, mark done or reopen, move a task. Code decides; Cloud checks the body and words the refusals.
  ...REPORT_ACTION_ROUTES,
  ...INTAKE_UPDATES_ROUTES,
  // The company-wide agent directory (lead 4 L4-MF3): only a company owner or administrator; Code decides again on its live membership.
  ...AGENT_DIRECTORY_ROUTES,
];
