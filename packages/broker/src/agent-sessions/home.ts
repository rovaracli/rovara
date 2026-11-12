// Home (Plan 5 Task 15): one person's attention cards. `homeCards` asks every registered source for the caller's cards, checks and bounds what they answer, takes out what the caller
// dismissed, ranks the rest and answers the first `HOME_CARDS_MAX` with the total. A card is built for the caller alone and from what is read now: an approval only for a person who may
// decide it (its confirm link too), a session only for a person who may view it, plan, pull request and failure cards only for sessions the caller owns now. A link is present only for
// an action the caller may take, and never carries a ticket. Every read is bounded; a source that throws or is slow is skipped and logged with fixed words, never with what it said.
import { createHash } from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { HOME_CARDS_MAX, HOME_FAILURE_DAYS, INDEX_EXPIRY_ATTRIBUTE, SessionIdSchema, TASK_STATUS_WORDS, TaskStatusSchema, agentSessionKey, budgetPauseNext, budgetScopeName, sessionTaskStatus, taskStatusText, agentXError, homeDismissedKey, mySessionsKey, projectAllows, sessionLink, type AgentSessionRecord } from "@rovara-code/contracts";
import { HOME_DISMISSIBLE_KINDS, HOME_DISMISS_DAYS, HOME_NOT_DISMISSIBLE, HOME_REASON_MAX, HomeCardIdSchema, HomeCardSchema, OrgRoleSchema, openSpendRequestsKey, orgMemberKey, type HomeCard, type HomeCardKind, type HomeDismissResponse, type HomeResponse, type OrgRole } from "@agentx/cloud-contracts";
import { changeTitleOf } from "../agents/approval-decide-kind.js";
import type { ApprovalCaller, ApprovalDependencies } from "../agents/approvals.js";
import { listApprovalsFor, mayDecideApproval, shownText } from "../agents/approvals.js";
import type { AnyApprovalRecord } from "../agents/approvals.js";
import type { AgentRouteDependencies } from "../agents/routes.js";
import { getSpendRequest, mayDecideSpendRequest } from "../spend/requests.js";
import { taskKey } from "../developer/task-records.js";
import { githubUserOfMember } from "../rovara-code/github-members.js";
import { reviewWaitsOf, trackingItemFor } from "../rovara-code/nudges.js";
import { endedRetryStartsRun, newSessionRoleMemo, sessionAccessFor, sessionActionsFor, sessionHasEnded, type SessionAccess, type SessionRoleMemo } from "./access.js";
import { HOME_DISMISSED_READ_MAX, OCCURRENCE_PATTERN, failureCardIdOf, failureOccurrenceOf, homeDismissalsOf } from "./failure-dismissals.js";
import { batchGetItems, keyText } from "./live.js";
import { approveLink, type SessionReadCaller, type SessionReadDependencies } from "./read.js";
import { sessionFromItem } from "./store.js";

type Item = Record<string, unknown>;

/** What Home needs: the session reads, and Plan 3's approvals core (without it there are no approval or spend cards). */
export interface HomeDependencies extends SessionReadDependencies {
  approvals?: (ApprovalDependencies & Partial<AgentRouteDependencies>) | undefined;
  /**
   * The kinds of Home card that decision cards now carry (`decisions/`), set by the wiring ONLY when the decision card sources are mounted. Home then drops its own cards of these kinds, so a
   * decision cannot be made from Home's older card and skip the card's friction (a medium card's evidence-first rule, a high card's confirmation page). Absent: nothing is dropped.
   */
  retiredKinds?: readonly HomeCardKind[] | undefined;
  /** How long one source may take before it is skipped (default `HOME_SOURCE_TIMEOUT_MS`). */
  homeSourceTimeoutMs?: number | undefined;
  /**
   * UX2 slice 2 item 2: the caller's pending decision cards (only what THEY may decide now, from the card sources), for the one "needs you" count. Absent (cards off) or failing: the count is Home's own
   * cards. A Home card whose decision a pending card holds is left out, so nothing is counted or shown twice.
   */
  pendingDecisions?: ((caller: HomeCaller) => Promise<readonly PendingDecisionRef[]>) | undefined;
}
/** A pending decision card as Home counts it: its id, its kind and the task it is about (when it is about one). */
export interface PendingDecisionRef { cardId: string; kind: string; taskId?: string | undefined; /** The project the card is about (the per-project count reads it). */ project?: string | undefined }
export type HomeCaller = SessionReadCaller;

/**
 * A card a source answers. `blocksRunningSession` ranks an approval or a budget request above the rest; `occurrence` says which happening of the card this is (a failure's end or summary revision;
 * default: `at`), so a dismissal hides that happening and not a new one. Home takes both off before answering.
 */
export type HomeSourceCard = HomeCard & { blocksRunningSession?: true; occurrence?: string; /** The project the card is about, when the source knows it: only for the per-project "needs you" count in the sidebar's navigation, never part of the answer. */ project?: string; /** The task a card about one of the caller's own sessions is about (UX2 slice 2: a decision card for it replaces a plan or merge card). */ taskId?: string };

/** What one request already learned, shared by the sources so the caller's sessions are read once. */
export interface HomeContext {
  readonly orgRole: OrgRole;
  /** The caller's own sessions that may have a card (a plan to review, a pull request to review, a failure), judged for the caller: they own each now and may view it. */
  ownSessions(): Promise<readonly OwnSession[]>;
  /** The sessions among `ids`, read once (a missing one or another org's is absent). */
  sessionsById(ids: readonly string[]): Promise<Map<string, AgentSessionRecord>>;
  /** The tasks among `ids`, read once (a missing one or another org's is absent). */
  tasksById(ids: readonly string[]): Promise<Map<string, Item>>;
  /** What the caller may do with a session now, or undefined when they may not view it. */
  accessOf(session: AgentSessionRecord): Promise<SessionAccess | undefined>;
}
export interface OwnSession { session: AgentSessionRecord; access: SessionAccess; task: Item | undefined }

/** One place cards come from. Plan 5 registers `approval`, `spend_request`, `plan`, `pull_request` and `failure`; later plans add `question` and `offer`. */
export interface HomeCardSource {
  kind: HomeCardKind;
  list(deps: HomeDependencies, caller: HomeCaller, context: HomeContext): Promise<HomeSourceCard[]>;
}

export const HOME_SOURCE_TIMEOUT_MS = 2000;
/** The most cards read from one source; more are cut (and logged), so `total` counts at most this many per source. */
export const HOME_SOURCE_CARDS_MAX = 100;
/** The most of the caller's own session-list rows read, and the most sessions among them judged. */
export const HOME_OWN_SCAN_MAX = 200;
export const HOME_OWN_JUDGED_MAX = 50;
/** The most approvals checked for the caller, and the most open budget requests. */
export const HOME_APPROVALS_MAX = 100;
export const HOME_SPEND_SCAN_MAX = 100;
export { HOME_DISMISSED_READ_MAX };
const PAGE = 100;
const DAY_MS = 86_400_000;
const FAILURE_WORDS_MAX = 120;
const SESSION_WORDS_MAX = 80;
const PROBE_AT = "2000-01-01T00:00:00.000Z";
const PROBE_ID = "ses_00000000000000000000";

const occurrenceOf = (card: HomeSourceCard): string => card.occurrence ?? card.at;

const isAgentXError = (error: unknown): boolean => error instanceof Error && error.name === "AgentXError";
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const logOf = (deps: Pick<HomeDependencies, "log">) => (entry: Record<string, unknown>) => (deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
export const fit = (prefix: string, rest: string): string => [...`${prefix}${rest}`].slice(0, HOME_REASON_MAX).join("").trimEnd();
const cut = (value: string, max: number): string => [...value].slice(0, max).join("").trimEnd();

// ---- the registry

const sources: HomeCardSource[] = [];

/** Adds a source of cards. Answers the function that takes it away again (for a test). */
export function registerHomeCardSource(source: HomeCardSource): () => void {
  sources.push(source);
  return () => {
    const at = sources.indexOf(source);
    if (at >= 0) sources.splice(at, 1);
  };
}

// ---- what a request knows

function contextFor(deps: HomeDependencies, caller: HomeCaller, orgRole: OrgRole): HomeContext {
  const log = logOf(deps);
  const memo: SessionRoleMemo = newSessionRoleMemo();
  const sessions = new Map<string, Promise<AgentSessionRecord | undefined>>();
  const tasks = new Map<string, Promise<Item | undefined>>();
  const access = new Map<string, Promise<SessionAccess | undefined>>();
  let own: Promise<readonly OwnSession[]> | undefined;

  const readInto = async <T>(cache: Map<string, Promise<T | undefined>>, ids: readonly string[], keyOf: (id: string) => { pk: string; sk: string }, build: (item: Item, id: string) => T | undefined) => {
    const wanted = [...new Set(ids)].filter((id) => !cache.has(id));
    if (wanted.length > 0) {
      const read = batchGetItems(deps, wanted.map(keyOf));
      for (const id of wanted) cache.set(id, read.then((found) => { const item = found.get(keyText(keyOf(id))); return item === undefined ? undefined : build(item, id); }));
    }
    const found = new Map<string, T>();
    for (const id of ids) {
      const value = await cache.get(id);
      if (value !== undefined) found.set(id, value);
    }
    return found;
  };

  const context: HomeContext = {
    orgRole,
    sessionsById: (ids) => readInto(sessions, ids.filter((id) => SessionIdSchema.safeParse(id).success), (id) => agentSessionKey(caller.orgId, id as never, "META"), (item, id) => {
      const session = sessionFromItem(item);
      return session !== undefined && session.orgId === caller.orgId && session.sessionId === id ? session : undefined;
    }),
    tasksById: (ids) => readInto(tasks, ids, (id) => taskKey(id), (item) => (item["orgId"] === caller.orgId ? item : undefined)),
    accessOf: (session) => {
      const known = access.get(session.sessionId);
      if (known !== undefined) return known;
      const judged = (async () => {
        try {
          return (await sessionAccessFor(deps, caller, orgRole, session, { memo })).access;
        } catch (error) {
          // A role that cannot be read is no access, never a reason to show the session.
          if (isAgentXError(error)) return undefined;
          throw error;
        }
      })();
      access.set(session.sessionId, judged);
      return judged;
    },
    ownSessions: () => (own ??= ownSessionsOf(deps, caller, context, log)),
  };
  return context;
}

const withinDays = (instant: string | undefined, nowMs: number, days: number): boolean => instant !== undefined && nowMs - Date.parse(instant) < days * DAY_MS && Date.parse(instant) <= nowMs + DAY_MS;

/** Whether a session can be one of the caller's cards by what its summary says: a plan or pull request waits, or it failed lately. */
function candidateOf(session: AgentSessionRecord, nowMs: number): boolean {
  const { summary } = session;
  const ended = session.endedAt !== undefined;
  const failure = ended ? summary.status === "failed" && withinDays(session.endedAt, nowMs, HOME_FAILURE_DAYS) : summary.lastRunFailed === true && withinDays(session.updatedAt, nowMs, HOME_FAILURE_DAYS);
  // UX2 slice 2: a task stopped or paused for budget needs its owner too (Home's blocked and paused cards).
  const waits = !ended && session.kind === "task" && (summary.status === "needs_person" || summary.status === "waiting" || summary.status === "stopped" || summary.status === "paused");
  return failure || waits;
}

/** The caller's newest sessions (their list, a fixed number of rows), those that may have a card, judged for the caller: owner now and able to view. */
async function ownSessionsOf(deps: HomeDependencies, caller: HomeCaller, context: HomeContext, log: (entry: Record<string, unknown>) => void): Promise<readonly OwnSession[]> {
  const pk = mySessionsKey(caller.orgId, caller.developerId, PROBE_AT, PROBE_ID).pk;
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  let more = false;
  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, ScanIndexForward: false, Limit: PAGE,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const row of page.Items ?? []) {
      if (ids.length >= HOME_OWN_SCAN_MAX) { more = true; break; }
      const id = SessionIdSchema.safeParse(row["sessionId"]);
      if (id.success && row["orgId"] === caller.orgId) ids.push(id.data);
    }
    start = page.LastEvaluatedKey;
    if (more || start === undefined) break;
  }
  const nowMs = deps.now();
  const found = await context.sessionsById(ids);
  const candidates = ids.flatMap((id) => {
    const session = found.get(id);
    return session !== undefined && candidateOf(session, nowMs) ? [session] : [];
  });
  if (more || candidates.length > HOME_OWN_JUDGED_MAX) log({ event: "home.sessions_truncated", orgId: caller.orgId });
  const judged = candidates.slice(0, HOME_OWN_JUDGED_MAX);
  const tasks = await context.tasksById(judged.flatMap((session) => (session.subject.kind === "task" ? [session.subject.taskId] : [])));
  const owned: OwnSession[] = [];
  for (const session of judged) {
    const access = await context.accessOf(session);
    if (access === undefined || !access.owner) continue;
    owned.push({ session, access, task: session.subject.kind === "task" ? tasks.get(session.subject.taskId) : undefined });
  }
  return owned;
}

// ---- small builders

const sessionHref = (deps: HomeDependencies, sessionId: string) => sessionLink(deps.origin.replace(/\/+$/u, ""), sessionId);
export const openSession = (deps: HomeDependencies, sessionId: string, label = "Open session") => ({ label, action: "open" as const, href: sessionHref(deps, sessionId), method: "GET" as const });
const confirmButton = (deps: HomeDependencies, id: string, label: string) => ({ label, action: "confirm" as const, href: approveLink(deps, id), method: "GET" as const });
export const quoted = (title: string) => `"${cut(shownText(title, 300), SESSION_WORDS_MAX)}"`;

/** A pull request's address when it is a plain `https://github.com/…` one; nothing else is ever a destination. */
function githubUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.port === "" ? `${url.origin}${url.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

// ---- the sources: approvals and budget requests

const WRITE_AGENT_FALLBACK = "An agent";

/** The words that say what an approval is about, who asks, and the session it belongs to (if any). */
function approvalWords(record: AnyApprovalRecord, task: Item | undefined): { title: string; reason: string; taskId?: string; sessionId?: string } {
  if (record.kind === "change") {
    const title = changeTitleOf(record.subject.kind);
    return { title, reason: fit("A change is waiting for you to approve: ", title) };
  }
  if (record.subject.kind === "chain_gate") {
    const prompt = shownText(record.kind === "step" ? record.prompt : record.summary, 300) || "A decision is waiting";
    return { title: prompt, reason: fit("A chain run is waiting for you to approve: ", prompt), sessionId: record.subject.chainRunId };
  }
  const taskId = record.subject.taskId;
  const prompt = shownText(record.kind === "write" ? record.summary : record.prompt, 300) || "A decision is waiting";
  const taskAgent = (task?.["agent"] as { name?: unknown } | undefined)?.name;
  const named = record.kind === "write" ? record.agent?.name : typeof taskAgent === "string" ? taskAgent : undefined;
  const agent = (named === undefined ? "" : cut(shownText(named, 80), 60)) || WRITE_AGENT_FALLBACK;
  const sessionId = text(task?.["sessionId"]);
  return { title: prompt, reason: fit(`${agent} is waiting for you to approve: `, prompt), taskId, ...(sessionId === undefined ? {} : { sessionId }) };
}

/** The project of a session the source read, as a card field (absent for a session with none). */
const projectOf = (session: { project?: string | undefined } | undefined): { project?: string } => (session?.project === undefined ? {} : { project: session.project });

const approvalSource: HomeCardSource = {
  kind: "approval",
  async list(deps, caller, context) {
    const approvals = deps.approvals;
    if (approvals === undefined) return [];
    const asker: ApprovalCaller = { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole };
    const now = deps.now();
    // Oldest first, the longest-waiting ones when there are more than are checked.
    const open = (await listApprovalsFor(approvals, asker, "PENDING")).filter((record) => Date.parse(record.expiresAt) > now).reverse().slice(0, HOME_APPROVALS_MAX);
    const deciders: AnyApprovalRecord[] = [];
    for (const record of open) {
      try {
        if (await mayDecideApproval(approvals, asker, record)) deciders.push(record);
      } catch (error) {
        if (!isAgentXError(error)) throw error;
      }
    }
    const taskIds = deciders.flatMap((record) => (record.kind !== "change" && record.subject.kind === "agent_run" ? [record.subject.taskId] : []));
    const tasks = await context.tasksById(taskIds);
    const words = deciders.map((record) => approvalWords(record, record.kind !== "change" && record.subject.kind === "agent_run" ? tasks.get(record.subject.taskId) : undefined));
    const sessions = await context.sessionsById(words.flatMap((entry) => (entry.sessionId === undefined ? [] : [entry.sessionId])));
    const cards: HomeSourceCard[] = [];
    for (const [index, record] of deciders.entries()) {
      const entry = words[index]!;
      const session = entry.sessionId === undefined ? undefined : sessions.get(entry.sessionId);
      const viewable = session !== undefined && await context.accessOf(session) !== undefined;
      cards.push({
        cardId: `approval:${record.approvalId}`, kind: "approval", title: entry.title, reason: entry.reason, ...(viewable ? { sessionId: session.sessionId } : {}), at: record.createdAt,
        buttons: [confirmButton(deps, record.approvalId, "Open"), ...(viewable ? [openSession(deps, session.sessionId)] : [])],
        ...(session !== undefined && session.endedAt === undefined ? { blocksRunningSession: true as const } : {}),
        ...projectOf(session),
      });
    }
    return cards;
  },
};

/** What a budget request is about when it is not about a session the caller may see. */
const SPEND_SCOPE_WORDS: Record<string, string> = { run_limit: "A run", max_per_run: "A run", planning: "A run", month: "The monthly budget", owner_cap: "An agent owner's budget" };

const spendSource: HomeCardSource = {
  kind: "spend_request",
  async list(deps, caller, context) {
    const approvals = deps.approvals;
    if (approvals === undefined) return [];
    const now = deps.now();
    const open = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": openSpendRequestsKey(caller.orgId, PROBE_AT, "spr_0").pk }, ConsistentRead: true, Limit: HOME_SPEND_SCAN_MAX,
    })) as { Items?: Item[] };
    const decided: Array<NonNullable<Awaited<ReturnType<typeof getSpendRequest>>>> = [];
    for (const row of (open.Items ?? []).slice(0, HOME_SPEND_SCAN_MAX)) {
      const id = text(row["spendRequestId"]);
      if (id === undefined || row["orgId"] !== caller.orgId) continue;
      const record = await getSpendRequest(approvals, caller.orgId, id);
      if (record === undefined || record.status !== "PENDING" || Date.parse(record.expiresAt) <= now) continue;
      if (await mayDecideSpendRequest(approvals, { orgId: caller.orgId, developerId: caller.developerId }, id)) decided.push(record);
    }
    const tasks = await context.tasksById(decided.flatMap((record) => (record.taskId === undefined ? [] : [record.taskId])));
    const sessionIds = decided.flatMap((record) => { const id = record.taskId === undefined ? undefined : text(tasks.get(record.taskId)?.["sessionId"]); return id === undefined ? [] : [id]; });
    const sessions = await context.sessionsById(sessionIds);
    const cards: HomeSourceCard[] = [];
    for (const record of decided) {
      const sessionId = record.taskId === undefined ? undefined : text(tasks.get(record.taskId)?.["sessionId"]);
      const session = sessionId === undefined ? undefined : sessions.get(sessionId);
      const viewable = session !== undefined && await context.accessOf(session) !== undefined;
      const label = viewable ? quoted(session.title) : SPEND_SCOPE_WORDS[record.kind] ?? "A budget";
      cards.push({
        cardId: `spend_request:${record.spendRequestId}`, kind: "spend_request", title: "Budget request", reason: fit(`${label} needs $${String(Number(record.amountUsd.toFixed(2)))} more`, ""), ...(viewable ? { sessionId: session.sessionId } : {}),
        at: record.createdAt, buttons: [confirmButton(deps, record.spendRequestId, "Decide"), ...(viewable ? [openSession(deps, session.sessionId)] : [])],
        ...(session !== undefined && session.endedAt === undefined ? { blocksRunningSession: true as const } : {}),
        ...projectOf(session),
      });
    }
    return cards;
  },
};

// ---- the sources: the caller's own sessions

const workflowOf = (own: OwnSession): { stage?: unknown; state?: unknown; pullRequests?: unknown } | undefined => own.task?.["workflow"] as { stage?: unknown; state?: unknown; pullRequests?: unknown } | undefined;

const planSource: HomeCardSource = {
  kind: "plan",
  async list(deps, _caller, context) {
    return (await context.ownSessions()).flatMap((own): HomeSourceCard[] => {
      const workflow = workflowOf(own);
      if (own.session.endedAt !== undefined || own.session.summary.status !== "needs_person" || workflow?.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return [];
      const { session } = own;
      return [{
        cardId: `plan:${session.sessionId}`, kind: "plan", title: session.title, reason: fit(`Your plan for ${quoted(session.title)} is ready to review`, ""), sessionId: session.sessionId, at: session.updatedAt,
        ...(session.subject.kind === "task" ? { taskId: session.subject.taskId } : {}),
        ...projectOf(session),
        buttons: [openSession(deps, session.sessionId, "Review plan")],
      }];
    });
  },
};

/** The pull requests of a task that are still open as the workflow records them (an unknown state counts as open). */
const openPullRequests = (workflow: { pullRequests?: unknown } | undefined): Array<{ repositoryId: string; number: number; url?: unknown }> =>
  (Array.isArray(workflow?.pullRequests) ? workflow.pullRequests as Array<{ repositoryId?: unknown; number?: unknown; url?: unknown; state?: unknown }> : [])
    .flatMap((request) => (typeof request.repositoryId === "string" && typeof request.number === "number" && (request.state === "OPEN" || request.state === "UNKNOWN")
      ? [{ repositoryId: request.repositoryId, number: request.number, url: request.url }] : []));

/**
 * Whether a Rovara Code task's pull request is waiting for someone to review it, from what tracking last read (Plan 6 Task 18, N7): open, out of draft, asked of someone, not yet decided.
 * A task without tracking items (version 1, or none read yet) is not.
 */
async function waitsForReview(deps: HomeDependencies, own: OwnSession, workflow: { pullRequests?: unknown } | undefined): Promise<boolean> {
  const { session, task } = own;
  if (session.subject.kind !== "task" || (task?.["workflow"] as { definitionVersion?: unknown } | undefined)?.definitionVersion !== "1.1.0") return false;
  const { taskId } = session.subject;
  const found = await Promise.all(openPullRequests(workflow).map((request) => trackingItemFor(deps, session.orgId, taskId, request.repositoryId, request.number)));
  return found.some((item) => item !== undefined && item.state === "open" && !item.draft && item.review === "requested");
}

const pullRequestSource: HomeCardSource = {
  kind: "pull_request",
  async list(deps, _caller, context) {
    const cards = await Promise.all((await context.ownSessions()).map(async (own): Promise<HomeSourceCard[]> => {
      const workflow = workflowOf(own);
      if (own.session.endedAt !== undefined || own.session.summary.status !== "waiting" || workflow?.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING") return [];
      const { session } = own;
      const requests = Array.isArray(workflow.pullRequests) ? workflow.pullRequests as Array<{ url?: unknown; state?: unknown }> : [];
      const url = requests.filter((request) => request.state === "OPEN" || request.state === "UNKNOWN").map((request) => githubUrl(request.url)).find((address) => address !== undefined);
      const waiting = await waitsForReview(deps, own, workflow);
      return [{
        ...(session.subject.kind === "task" ? { taskId: session.subject.taskId } : {}),
        ...projectOf(session),
        cardId: `pull_request:${session.sessionId}`, kind: "pull_request", title: session.title, reason: fit(`Your pull request for ${quoted(session.title)} ${waiting ? "is waiting for review" : "is ready for review"}`, ""), sessionId: session.sessionId, at: session.updatedAt,
        buttons: [url === undefined ? openSession(deps, session.sessionId) : { label: "Open pull request", action: "open" as const, href: url, method: "GET" as const }],
      }];
    }));
    return cards.flat();
  },
};

/**
 * The pull requests that wait for the caller's review (Plan 6 Task 18): the ones Rovara reminded them of, each judged now. It is shown only while the caller's linked GitHub account is the one
 * that was asked, the task has not ended, the pull request is open and out of draft and its review is still undecided; the session's title and a link to it only when the caller may view the
 * session, else the repository and the number.
 */
const reviewerSource: HomeCardSource = {
  kind: "pull_request",
  async list(deps, caller, context) {
    const waits = await reviewWaitsOf(deps, caller.orgId, caller.developerId);
    if (waits.length === 0) return [];
    const linked = await githubUserOfMember({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, caller.orgId, caller.developerId);
    const mine = waits.filter((wait) => linked !== undefined && wait.githubUserId === linked);
    const tasks = await context.tasksById(mine.map((wait) => wait.taskId));
    const live = (await Promise.all(mine.map(async (wait) => {
      const task = tasks.get(wait.taskId);
      if (task === undefined || task["closedAt"] !== undefined || task["releasedAt"] !== undefined) return [];
      const workflow = task["workflow"] as { pullRequests?: unknown } | undefined;
      const request = openPullRequests(workflow).find((entry) => entry.repositoryId === wait.repositoryId && entry.number === wait.number);
      if (request === undefined) return [];
      const tracked = await trackingItemFor(deps, caller.orgId, wait.taskId, wait.repositoryId, wait.number);
      if (tracked === undefined || tracked.state !== "open" || tracked.draft || tracked.review !== "requested") return [];
      return [{ wait, task, request }];
    }))).flat();
    const sessions = await context.sessionsById(live.flatMap(({ task }) => { const id = text(task["sessionId"]); return id === undefined ? [] : [id]; }));
    const nowMs = deps.now();
    const cards: HomeSourceCard[] = [];
    for (const { wait, task, request } of live) {
      const sessionId = text(task["sessionId"]);
      const session = sessionId === undefined ? undefined : sessions.get(sessionId);
      const viewable = session !== undefined && await context.accessOf(session) !== undefined;
      const label = viewable ? session.title : `${wait.repositoryId} #${String(wait.number)}`;
      const days = Math.max(1, Math.floor((nowMs - Date.parse(wait.since)) / DAY_MS));
      const address = githubUrl(request.url);
      const digest = createHash("sha256").update(`${wait.taskId}\n${wait.repositoryId}\n${String(wait.number)}`, "utf8").digest("hex").slice(0, 24);
      cards.push({
        cardId: `pull_request:rv_${digest}`, kind: "pull_request", title: cut(shownText(label, 300), 300) || "Pull request", reason: fit(`${quoted(label)} has been waiting for your review for ${String(days)} ${days === 1 ? "day" : "days"}`, ""),
        ...(viewable ? { sessionId: session.sessionId } : {}), at: wait.at, ...projectOf(session),
        buttons: [...(address === undefined ? [] : [{ label: "Open pull request", action: "open" as const, href: address, method: "GET" as const }]), ...(viewable ? [openSession(deps, session.sessionId)] : [])],
      });
    }
    return cards;
  },
};

/**
 * Whether a retry of this session would do something: a failed agent run, a chain run, or a blocked workflow, by someone who may start work in its project. An ENDED session is retried only where a retry starts a
 * run (`endedRetryStartsRun`): a task that ended failed with no run to start again (a setup draft, a workflow whose setup failed) offers no Retry that could only say "nothing to retry".
 */
function mayRetry(own: OwnSession): boolean {
  const { session, access, task } = own;
  const ended = sessionHasEnded(session);
  const actions = sessionActionsFor(access, { ...session.summary, ...(ended ? { ended: true as const, retryStartsRun: endedRetryStartsRun(session, task) } : {}) });
  if (!actions.includes("retry")) return false;
  if (session.kind === "local" || session.where.kind !== "cloud") return false;
  const retryable = session.subject.kind === "chain" || task?.["agent"] !== undefined || (session.endedAt === undefined && (task?.["workflow"] as { state?: unknown } | undefined)?.state === "BLOCKED");
  if (!retryable) return false;
  return session.project === undefined || (access.projectRole !== undefined && projectAllows(access.projectRole, "start_tasks"));
}

const failureSource: HomeCardSource = {
  kind: "failure",
  async list(deps, _caller, context) {
    const origin = deps.origin.replace(/\/+$/u, "");
    return (await context.ownSessions()).flatMap((own): HomeSourceCard[] => {
      const { session } = own;
      const failed = session.endedAt !== undefined ? session.summary.status === "failed" : session.summary.lastRunFailed === true;
      // UX2 slice 2 item 6: a task its owner closed is Closed, not Failed: no failure card (and no Retry) for it, whatever its last run did.
      // Only a summary that carries the status model's words says what failed in them; an older one keeps the step's words.
      const stored = TaskStatusSchema.safeParse((session.summary as { display?: unknown }).display);
      const display = stored.success ? stored.data : undefined;
      if (!failed || display?.state === "closed" || display?.state === "merged" || own.task?.["closedAt"] !== undefined) return [];
      const said = display?.state === "failed" && display.reason !== undefined ? cut(display.reason, FAILURE_WORDS_MAX) : cut(shownText((session.summary.step ?? "").replace(/^Failed:\s*/u, ""), 300), FAILURE_WORDS_MAX) || "it did not finish";
      const cardId = failureCardIdOf(session.sessionId);
      const occurrence = failureOccurrenceOf(session);
      return [{
        ...projectOf(session), cardId, kind: "failure", occurrence, title: session.title, reason: fit(`${quoted(session.title)} failed: `, said), sessionId: session.sessionId, at: session.endedAt ?? session.updatedAt,
        buttons: [
          openSession(deps, session.sessionId),
          ...(mayRetry(own) ? [{ label: "Retry", action: "retry" as const, href: `${origin}/v1/app/sessions/${session.sessionId}/retry`, method: "POST" as const }] : []),
          { label: "Dismiss", action: "dismiss" as const, href: `${origin}/v1/app/home/cards/${encodeURIComponent(cardId)}/dismiss?occurrence=${encodeURIComponent(occurrence)}`, method: "POST" as const },
        ],
      }];
    });
  },
};

/** The stages whose wait has a card of its own (a plan to review, Understand's questions, a pull request to merge): a blocked card would say it twice. */
const OWN_CARD_WAITS = new Set(["PLAN_REVIEW/WAITING", "UNDERSTAND/WAITING", "WAIT_FOR_MERGE/WAITING"]);

/** "Needs you: <reason>. Next: <next step>", within a card's reason; the next step is left out when both don't fit. */
function needsYouReason(text: string, next: string | undefined): string {
  const full = next === undefined ? text : `${text}. Next: ${next}`;
  return [...full].length <= HOME_REASON_MAX ? full : fit(text, "");
}

/**
 * UX2 slice 2 item 2: the caller's own blocked tasks (checks failed, reviews found problems, CI failing, a branch conflict, a run limit waiting, coding stopped, a stop before it finished): why it stopped and
 * the next step, from the one status model, with the task's page. Header, Live and the sidebar already said it needs them; now Home does too.
 */
const blockedSource: HomeCardSource = {
  kind: "blocked",
  async list(deps, _caller, context) {
    return (await context.ownSessions()).flatMap((own): HomeSourceCard[] => {
      const { session } = own;
      // Review I4: never a plain "waiting" (a run that finished and waits for its owner's next request, a pull request, a failure: each has its own card or none).
      if (session.endedAt !== undefined || session.summary.status === "paused" || session.summary.status === "waiting" || session.summary.lastRunFailed === true) return [];
      // The summary's own status-model words when it has them; an older summary counts only when it reads as needing a person or stopped (never a plain "waiting", which a pull request or a failure card covers).
      const stored = TaskStatusSchema.safeParse((session.summary as { display?: unknown }).display);
      if (stored.success ? stored.data.state !== "needs_you" : session.summary.status !== "needs_person" && session.summary.status !== "stopped") return [];
      const display = stored.success ? stored.data : sessionTaskStatus(session.summary);
      const workflow = workflowOf(own);
      if (typeof workflow?.stage === "string" && typeof workflow.state === "string" && OWN_CARD_WAITS.has(`${workflow.stage}/${workflow.state}`)) return [];
      return [{
        cardId: `blocked:${session.sessionId}`, kind: "blocked", title: session.title, reason: needsYouReason(taskStatusText(display), display.next), sessionId: session.sessionId, at: session.updatedAt,
        ...(session.subject.kind === "task" ? { taskId: session.subject.taskId } : {}), ...projectOf(session),
        buttons: [openSession(deps, session.sessionId, "Open task")],
      }];
    });
  },
};

/**
 * UX2 slice 2 item 2: the caller's own tasks paused for budget: what limit it reached and who can raise it (the people who may decide the budget request get its own card). Fixed words, never the request's text.
 */
const pausedSource: HomeCardSource = {
  kind: "paused",
  async list(deps, _caller, context) {
    return (await context.ownSessions()).flatMap((own): HomeSourceCard[] => {
      const { session, task } = own;
      if (session.endedAt !== undefined || session.summary.status !== "paused") return [];
      const pause = task?.["budgetPause"] as { scope?: { kind?: unknown } } | undefined;
      const scopeKind = typeof pause?.scope?.kind === "string" ? pause.scope.kind : undefined;
      const text = `${TASK_STATUS_WORDS.paused_budget}. It reached ${budgetScopeName(scopeKind)}`;
      // Review M3: an org owner or admin may raise any limit (`budgetRaisers`), so the owner who is one is told they can raise it themselves.
      const mayRaise = context.orgRole === "owner" || context.orgRole === "admin";
      return [{
        cardId: `paused:${session.sessionId}`, kind: "paused", title: session.title, reason: needsYouReason(text, budgetPauseNext(scopeKind, mayRaise, session.summary.pendingApprovals > 0)), sessionId: session.sessionId, at: session.updatedAt,
        ...(session.subject.kind === "task" ? { taskId: session.subject.taskId } : {}), ...projectOf(session),
        buttons: [openSession(deps, session.sessionId, "Open task")],
      }];
    });
  },
};

for (const source of [approvalSource, spendSource, planSource, pullRequestSource, reviewerSource, failureSource, blockedSource, pausedSource]) registerHomeCardSource(source);

// ---- reading the cards

class SourceTimeout extends Error {}

async function runSource(source: HomeCardSource, deps: HomeDependencies, caller: HomeCaller, context: HomeContext, log: (entry: Record<string, unknown>) => void): Promise<HomeSourceCard[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listing = Promise.resolve().then(() => source.list(deps, caller, context));
    listing.catch(() => undefined); // a source that answers after its time must not be an unhandled rejection
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new SourceTimeout()), deps.homeSourceTimeoutMs ?? HOME_SOURCE_TIMEOUT_MS); });
    return await Promise.race([listing, timeout]);
  } catch (error) {
    log(error instanceof SourceTimeout ? { event: "home.source_failed", source: source.kind, reason: "timeout" } : { event: "home.source_failed", source: source.kind, reason: "error", error: error instanceof Error ? error.name : "unknown" });
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Collected { cards: HomeSourceCard[]; dismissed: ReadonlyMap<string, string> }

async function collect(deps: HomeDependencies, caller: HomeCaller): Promise<Collected> {
  const log = logOf(deps);
  const member = (await batchGetItems(deps, [orgMemberKey(caller.orgId, caller.developerId)])).values().next().value as Item | undefined;
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success) return { cards: [], dismissed: new Map() };
  const asker: HomeCaller = { ...caller, orgRole: role.data };
  const context = contextFor(deps, asker, role.data);
  const answers = await Promise.all([...sources].map(async (source) => ({ source, cards: await runSource(source, deps, asker, context, log) })));
  const seen = new Set<string>();
  const cards: HomeSourceCard[] = [];
  const retired = new Set<HomeCardKind>(deps.retiredKinds ?? []);
  for (const { source, cards: answered } of answers) {
    if (retired.has(source.kind)) continue;
    if (answered.length > HOME_SOURCE_CARDS_MAX) log({ event: "home.source_truncated", source: source.kind });
    for (const card of answered.slice(0, HOME_SOURCE_CARDS_MAX)) {
      const { blocksRunningSession, occurrence, taskId, project, ...shown } = card;
      const checked = HomeCardSchema.safeParse(shown);
      if (!checked.success || checked.data.kind !== source.kind || !checked.data.cardId.startsWith(`${source.kind}:`)) {
        log({ event: "home.card_invalid", source: source.kind, problem: checked.success ? "kind" : checked.error.issues[0]?.path.join(".") ?? "card" });
        continue;
      }
      if (seen.has(checked.data.cardId)) continue;
      seen.add(checked.data.cardId);
      const kept = occurrence !== undefined && OCCURRENCE_PATTERN.test(occurrence) ? occurrence : undefined;
      cards.push({ ...checked.data, ...(blocksRunningSession === true ? { blocksRunningSession } : {}), ...(kept === undefined ? {} : { occurrence: kept }), ...(typeof taskId === "string" ? { taskId } : {}), ...(typeof project === "string" ? { project } : {}) });
    }
  }
  return { cards, dismissed: await homeDismissalsOf(deps, caller) };
}

const isDismissible = (kind: string): boolean => (HOME_DISMISSIBLE_KINDS as readonly string[]).includes(kind);

/** The order cards are shown in: what blocks a running session, a question, a plan, a pull request, other approvals and budget requests, a failure, an offer. */
function tierOf(card: HomeSourceCard): number {
  const blocking = card.blocksRunningSession === true && (card.kind === "approval" || card.kind === "spend_request");
  if (blocking) return 0;
  switch (card.kind) {
    case "question": return 1;
    case "blocked": case "paused": return 1;
    case "plan": return 2;
    case "pull_request": return 3;
    case "approval":
    case "spend_request": return 4;
    case "failure": return 5;
    default: return 6;
  }
}
const ranked = (cards: readonly HomeSourceCard[]): HomeSourceCard[] => [...cards].sort((a, b) => tierOf(a) - tierOf(b) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));

/**
 * `GET /v1/app/home`: the caller's cards, ranked, the first `HOME_CARDS_MAX` of them, and `total`: how many they have (each source read up to `HOME_SOURCE_CARDS_MAX`). A person who is not
 * in the org has none.
 */
export async function homeCards(deps: HomeDependencies, caller: HomeCaller): Promise<HomeResponse> {
  const { shown, decisions } = await shownCards(deps, caller);
  const answer = shown.slice(0, HOME_CARDS_MAX).map(({ blocksRunningSession: _blocks, occurrence: _occurrence, taskId: _taskId, project: _project, ...card }) => card); // eslint-disable-line @typescript-eslint/no-unused-vars -- the ranking hint, the occurrence, the task and the project are not part of the answer
  // Without the decision cards wired (cards off, or an older wiring) the one count is Home's own: `needsYou` is left out and readers use `total`.
  return { cards: answer, total: shown.length, ...(deps.pendingDecisions === undefined ? {} : { needsYou: shown.length + (decisions?.length ?? 0) }) };
}

/** The caller's cards as Home shows them (every one, ranked), and their pending decision cards: the one set both the Home answer and the navigation's counts are made from. */
async function shownCards(deps: HomeDependencies, caller: HomeCaller): Promise<{ shown: HomeSourceCard[]; decisions: readonly PendingDecisionRef[] | undefined }> {
  const [{ cards, dismissed }, decisions] = await Promise.all([collect(deps, caller), pendingDecisionsOf(deps, caller)]);
  const shown = ranked(withoutRestating(withoutDecided(cards.filter((card) => !(isDismissible(card.kind) && dismissed.get(card.cardId) === occurrenceOf(card))), decisions ?? []), decisions ?? []));
  return { shown, decisions };
}

/**
 * The navigation's counts: Home's `total` and `needsYou` exactly as `homeCards` gives them, and `byProject`: how many of those same cards (and pending decision cards) are about each project, for the caller only.
 * A card whose source names no project (an organization-wide budget request, say) is in `needsYou` but in no project's count, so the projects' counts may add up to less than `needsYou`.
 */
export async function homeNeedsYou(deps: HomeDependencies, caller: HomeCaller): Promise<{ total: number; needsYou?: number; byProject: Record<string, number> }> {
  const { shown, decisions } = await shownCards(deps, caller);
  const byProject: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const entry of [...shown, ...(decisions ?? [])]) if (entry.project !== undefined) byProject[entry.project] = (byProject[entry.project] ?? 0) + 1;
  return { total: shown.length, ...(deps.pendingDecisions === undefined ? {} : { needsYou: shown.length + (decisions?.length ?? 0) }), byProject };
}

/** The caller's pending decision cards, or undefined when there are none to read (cards off) or they could not be read (logged; Home's own cards still count). */
async function pendingDecisionsOf(deps: HomeDependencies, caller: HomeCaller): Promise<readonly PendingDecisionRef[] | undefined> {
  if (deps.pendingDecisions === undefined) return undefined;
  try {
    return await deps.pendingDecisions(caller);
  } catch (error) {
    logOf(deps)({ event: "home.decisions_unreadable", error: error instanceof Error ? error.name : "unknown" });
    return undefined;
  }
}

/**
 * Review M2: a blocked or paused card only says what another card already asks when the same task has a pending decision card (a run-limit approval, a merge, a spec choice, a budget request on
 * its own card) or another Home card the caller decides (an approval, a budget request, a plan, a pull request, a question). Then it is left out, of the list and of the count, so one task never
 * reads as two things that need you.
 */
export function withoutRestating(cards: readonly HomeSourceCard[], decisions: readonly PendingDecisionRef[]): HomeSourceCard[] {
  const decidedTasks = new Set(decisions.flatMap((decision) => (decision.taskId === undefined ? [] : [decision.taskId])));
  const askedSessions = new Set(cards.filter((card) => card.kind !== "blocked" && card.kind !== "paused" && card.kind !== "failure").flatMap((card) => (card.sessionId === undefined ? [] : [card.sessionId])));
  return cards.filter((card) => {
    if (card.kind !== "blocked" && card.kind !== "paused") return true;
    if (card.taskId !== undefined && decidedTasks.has(card.taskId)) return false;
    return card.sessionId === undefined || !askedSessions.has(card.sessionId);
  });
}

/** The decision card kinds that hold the decision each older Home card kind asks for (the web app's `one-card.ts` rule, on the server). */
const REPLACED_BY: Readonly<Record<string, readonly string[]>> = { plan: ["approve_plan", "approve_requirements", "approve_design"], pull_request: ["merge"] };

/** Home's cards less those whose decision a pending decision card holds: a plan or the owner's own pull request for the same task, an approval or a budget request that has its own card. */
export function withoutDecided(cards: readonly HomeSourceCard[], decisions: readonly PendingDecisionRef[]): HomeSourceCard[] {
  if (decisions.length === 0) return [...cards];
  const byTask = new Map<string, Set<string>>();
  for (const decision of decisions) if (decision.taskId !== undefined) byTask.set(decision.taskId, (byTask.get(decision.taskId) ?? new Set()).add(decision.kind));
  const outside = new Set(decisions.filter((decision) => decision.kind === "approve_request").map((decision) => decision.cardId.slice(decision.cardId.indexOf(":") + 1)));
  return cards.filter((card) => {
    if ((card.kind === "approval" || card.kind === "spend_request") && outside.has(card.cardId.slice(card.cardId.indexOf(":") + 1))) return false;
    const replacing = REPLACED_BY[card.kind];
    if (replacing === undefined || card.taskId === undefined) return true;
    if (card.kind === "pull_request" && card.cardId !== `pull_request:${card.sessionId ?? ""}`) return true;
    const pending = byTask.get(card.taskId);
    return pending === undefined || !replacing.some((kind) => pending.has(kind));
  });
}

/**
 * `POST /v1/app/home/cards/{cardId}/dismiss`: hides one of the caller's failure or offer cards for them, for `HOME_DISMISS_DAYS`. Another kind is `CONFIG_INVALID`. It is idempotent: a
 * card that is already dismissed, or is not the caller's (or not there any more), answers the same and writes nothing; only a card on the caller's own Home is ever written, in their own partition.
 */
export async function dismissHomeCard(deps: HomeDependencies, caller: HomeCaller, rawCardId: string, seen?: string): Promise<HomeDismissResponse> {
  const parsed = HomeCardIdSchema.safeParse(rawCardId);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "cardId: is not a card on Home");
  const cardId = parsed.data;
  if (!isDismissible(cardId.slice(0, cardId.indexOf(":")))) throw agentXError("CONFIG_INVALID", HOME_NOT_DISMISSIBLE);
  const answer: HomeDismissResponse = { cardId, dismissed: true };
  const { cards, dismissed } = await collect(deps, caller);
  const card = cards.find((candidate) => candidate.cardId === cardId);
  if (card === undefined) return answer;
  // The occurrence the person saw (the dismiss link carries it) is the one hidden; a failure that came after they looked stays on Home.
  if (seen !== undefined && !OCCURRENCE_PATTERN.test(seen)) throw agentXError("CONFIG_INVALID", "occurrence: is not one");
  const occurrence = seen ?? occurrenceOf(card);
  if (dismissed.get(cardId) === occurrence) return answer;
  const nowMs = deps.now();
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        ...homeDismissedKey(caller.orgId, caller.developerId, cardId), entityType: "HOME_DISMISSED", orgId: caller.orgId, developerId: caller.developerId, cardId, occurrence, dismissedAt: new Date(nowMs).toISOString(),
        [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + HOME_DISMISS_DAYS * 86_400,
      },
      ConditionExpression: `attribute_not_exists(pk) OR ${INDEX_EXPIRY_ATTRIBUTE} <= :now OR attribute_not_exists(occurrence) OR occurrence <> :occurrence`,
      ExpressionAttributeValues: { ":now": Math.floor(nowMs / 1000), ":occurrence": occurrence },
    }));
  } catch (error) {
    // A dismissal that landed first is this one's answer too.
    if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
  }
  return answer;
}
