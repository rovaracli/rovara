// Reading a session (Plan 5 Task 5): its view, its lists and the task of one of its chain steps. Every read goes through `requireSessionLevel`, so
// a session the caller can't view is `NOT_FOUND` and its existence never leaks; what the caller may not see inside it (a decision they can't make,
// a step's task without a project role) is left out, never shown as an error.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { AGENT_SESSION_CONTRACT_VERSION, AGENTX_NAME_PATTERN, ChainRunViewSchema, LIVE_INDEX_SCAN_MAX, LIVE_PAGE_MAX, SessionBindingSchema, SessionIdSchema, agentSessionKey, agentXError, cleanSessionName, hideEmailAddresses, mySessionsKey, projectAllows, projectSessionsKey, sessionLink, sessionBindingKey, sharedSessionsKey, taskSpendKey, type AgentSessionRecord, type SessionBinding, type SessionLevel, type SessionStatus, budgetPauseNext, budgetScopeName, sessionTaskStatus, taskStatusNext, type TaskStatus } from "@rovara-code/contracts";
import { type SessionList, type SessionTile } from "@agentx/cloud-contracts";
import { type SessionView } from "@agentx/cloud-contracts";
import { type DeveloperTaskView, type OrgRole } from "@agentx/cloud-contracts";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { safeDisplayName } from "../developer/person-name.js";
import { anchorTargetsOf } from "./anchors.js";
import { SETUP_DRAFT_RETRY_WORDS, closableSession, endedRetryStartsRun, newSessionRoleMemo, requireSessionLevel, sessionActionsFor, sessionHasEnded, type SessionAccess, type SessionCaller } from "./access.js";
import { sessionLiveFlags } from "./live-flags.js";
import { viewingNow } from "./followers.js";
import { ownerNameOverlay, ownerNamedAt } from "./owner-names.js";
import type { AuditRuntime } from "../audit/outbox.js";
import type { ChainControl, SessionControlHost } from "./stop.js";
import type { SessionTakeOverDependencies } from "./take-over.js";
import { finishedAsOf } from "./finished-as.js";
import { linearLinkOfBinding } from "../rovara-code/linear-close.js";

/** Who reads: `DeveloperCaller` fits. */
export interface SessionReadCaller extends SessionCaller { orgRole: OrgRole }

/** What the people who may decide something may be shown, answered live by the approvals and spend code the broker holds. */
export interface SessionDeciding {
  /** The caller's own pending decisions on this session, with the words that name each (never what is being approved: the confirmation page shows that). */
  approvals(caller: SessionReadCaller, session: AgentSessionRecord): Promise<Array<{ approvalId: string; title: string }>>;
  /** Whether the caller may decide this budget request now. */
  spend(caller: SessionReadCaller, spendRequestId: string): Promise<boolean>;
  /**
   * `approvals` for many sessions at once (the Live wall asks for a whole page): the caller's decisions are listed once and matched to each session, so the answer is the same as asking
   * one session at a time, in the reads of one. A session with no decision waiting for the caller is absent from the answer.
   */
  approvalsFor?(caller: SessionReadCaller, sessions: readonly AgentSessionRecord[]): Promise<Map<string, Array<{ approvalId: string; title: string }>>>;
}

export interface SessionReadDependencies extends SessionTakeOverDependencies {
  /** The install switches as the caller's company has them (TE-A1). Absent: the process environment. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Plan 5 Task 13: Plan 3's cancel, workflow retry and run start for the signed-in person. Without it stop and retry of a task session answer `RUNTIME_UNAVAILABLE`. */
  control?: SessionControlHost | undefined;
  /** Plan 5 Task 13: Plan 4's chain cancel and retry with the session actor (`chainControlFor`, built for each request). Without it a chain session is neither stopped nor retried, and nothing is written. */
  chainControl?: ChainControl | undefined;
  /** The Audit Ledger's outbox: a stop or retry adds its pending item to its own transaction. Absent on a legacy install, where nothing is recorded. */
  audit?: AuditRuntime;
  /** The origin links point at: the broker's issuer origin. */
  origin: string;
  /** The task's own view, built for this caller (the broker binds the task dependencies); `actor` is `owner` only for the session's effective owner. */
  taskView(task: DeveloperTaskRecord, options: { events: number; details: boolean; actor: "owner" | "viewer" }): Promise<DeveloperTaskView>;
  /** Without it no approval or budget link is shown to anyone. */
  deciding?: SessionDeciding;
  /** Task 10c: whether the person may create an agent in a project now (Plan 3's own check, read live). Without it no one is offered `make_agent`. */
  mayMakeAgent?: (caller: SessionReadCaller, project: string) => Promise<boolean>;
}

type Item = Record<string, unknown>;
const NOT_FOUND = () => agentXError("NOT_FOUND", "session not found");
const UNAVAILABLE = () => agentXError("RUNTIME_UNAVAILABLE", "This session can't be shown right now.");
/** The level of an access that `requireSessionLevel` let through: never "none" (that is NOT_FOUND there). */
const levelOf = (access: SessionAccess): SessionLevel => {
  if (access.level === "none") throw NOT_FOUND();
  return access.level;
};
const isAgentXError = (error: unknown) => error instanceof Error && error.name === "AgentXError";

const getItem = async (deps: Pick<SessionReadDependencies, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

export const approveLink = (deps: Pick<SessionReadDependencies, "origin">, id: string) => `${deps.origin.replace(/\/+$/u, "")}/v1/app/approve/${id}`;

// ---- the view

/** The task of a task session, when it is the session's own (a task of another org is not). */
async function taskOf(deps: SessionReadDependencies, session: AgentSessionRecord): Promise<DeveloperTaskRecord> {
  if (session.subject.kind !== "task") throw NOT_FOUND();
  const task = (await getItem(deps, taskKey(session.subject.taskId))) as DeveloperTaskRecord | undefined;
  if (task === undefined || task.orgId !== session.orgId) throw NOT_FOUND();
  return task;
}

/** Where a task is, in a session's words: used until the projector has computed the session's own summary (Task 7a). */
function statusOfTask(view: DeveloperTaskView): SessionStatus {
  switch (view.status) {
    case "SUCCEEDED":
      return "succeeded";
    // Closed: finished only when the work was merged or answered; any other closed task was closed before its work finished (QA6-07).
    case "CLOSED":
      // A plain task (no workflow) is finished only when its agent run completed; a closed one whose run did not read as closed, never as finished (as the computed summary reads it).
      return view.workflow === undefined ? (view.run?.state === "COMPLETE" ? "succeeded" : "cancelled")
        : view.workflow.stage !== "MERGED" && view.workflow.outcome !== "ANSWERED" ? "cancelled" : "succeeded";
    case "FAILED":
    case "INTERRUPTED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      break;
  }
  if (view.paused !== undefined) return "paused";
  if (view.status === "STARTING") return "starting";
  if (view.run?.state === "WAITING_FOR_APPROVAL") return "needs_person";
  if (view.workflow?.state === "WAITING") return "waiting";
  return "running";
}

/**
 * S3 (C59): the words of a session that a model or a person wrote (title, step, latest line) read without an email address to everyone but the session's owner, whose own text they are.
 * The stored record keeps the raw words: the summary refresh, a move to the cloud and "make this an agent" work from them.
 */
const wordsFor = (mine: boolean) => (text: string): string => (mine ? text : hideEmailAddresses(text));

async function nameOf(deps: SessionReadDependencies, developerId: string): Promise<string | undefined> {
  try {
    const record = await deps.signInStore.getDeveloper(developerId);
    return record === undefined ? undefined : cleanSessionName(record.displayName);
  } catch {
    return undefined;
  }
}

async function payerOf(deps: SessionReadDependencies, session: AgentSessionRecord, ownerName: string): Promise<{ kind: "member" | "project" | "agent" | "chain"; name: string }> {
  const payer = session.payer ?? { kind: "member" as const, developerId: session.owner.developerId };
  if (payer.kind === "project") return { kind: "project", name: payer.project };
  // Plan 4: a chain that pays for the runs its triggers start. The chain's own name is not on the session header, so the view names the chain by its id.
  if (payer.kind === "chain") return { kind: "chain", name: payer.chainId };
  if (payer.kind === "agent") return { kind: "agent", name: session.agent?.agentId === payer.agentId ? session.agent.name : payer.agentId };
  return { kind: "member", name: payer.developerId === session.owner.developerId ? ownerName : await nameOf(deps, payer.developerId) ?? "A teammate" };
}

function bindingLink(binding: SessionBinding): { kind: SessionBinding["kind"]; url: string } {
  if (binding.kind === "linear_issue") return { kind: "linear_issue", url: linearLinkOfBinding(binding) };
  if (binding.kind === "tracker_item") return { kind: "tracker_item", url: binding.url };
  return { kind: "slack_thread", url: `https://app.slack.com/client/${binding.teamId}/${binding.channelId}/thread/${binding.channelId}-${binding.threadTs}` };
}

async function bindingsOf(deps: SessionReadDependencies, session: AgentSessionRecord): Promise<Array<{ kind: SessionBinding["kind"]; url: string }>> {
  const found: Array<{ kind: SessionBinding["kind"]; url: string }> = [];
  for (const kind of ["slack_thread", "linear_issue", "tracker_item"] as const) {
    const item = await getItem(deps, sessionBindingKey(session.orgId, session.sessionId, kind));
    const parsed = SessionBindingSchema.safeParse(item?.["binding"]);
    if (parsed.success && parsed.data.kind === kind) found.push(bindingLink(parsed.data));
  }
  return found;
}

/** The caller's own decisions on this session; a failure to read them leaves them out. */
async function decisionsOf(deps: SessionReadDependencies, caller: SessionReadCaller, session: AgentSessionRecord): Promise<Array<{ approvalId: string; title: string }>> {
  if (deps.deciding === undefined) return [];
  try {
    return await deps.deciding.approvals(caller, session);
  } catch (error) {
    if (isAgentXError(error)) return [];
    throw error;
  }
}

/** The task's own view with the links of decisions the caller can't make taken out of it (the text of what waits stays). */
function withoutForeignLinks(view: DeveloperTaskView, mine: ReadonlySet<string>): DeveloperTaskView {
  if (view.run === undefined) return view;
  const pendingApprovals = view.run.pendingApprovals.map((entry) => {
    if (entry.confirmUrl === undefined || mine.has(entry.approvalId)) return entry;
    const { confirmUrl: _link, ...rest } = entry; // eslint-disable-line @typescript-eslint/no-unused-vars -- taken out on purpose
    return rest;
  });
  return { ...view, run: { ...view.run, pendingApprovals } };
}

/**
 * One person's reading of one session: the header, its cost, what they may do and the work itself. `NOT_FOUND` for another org and for a caller
 * with no level. Status and step come from the stored summary once the projector has computed one (its revision is above the start's), and
 * from the task until then.
 */
/** How much of a task session's cost is an estimate (DECISIONS 172), from the task's own spend counter the ledger keeps beside its total: never more than the cost shown. */
async function estimatedSpendOf(deps: Pick<SessionReadDependencies, "documentClient" | "tableName">, session: AgentSessionRecord, costUsd: number): Promise<number> {
  if (session.subject.kind !== "task") return 0;
  const value = (await getItem(deps, taskSpendKey(session.orgId, session.subject.taskId)))?.["estimatedUsd"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(Math.min(value, costUsd) * 1e6) / 1e6 : 0;
}

export async function sessionView(deps: SessionReadDependencies, caller: SessionReadCaller, sessionId: string): Promise<SessionView> {
  const access = await requireSessionLevel(deps, caller, sessionId, "view", "view it");
  const { session } = access;
  const computed = session.summaryRevision > 1;
  const mine = await decisionsOf(deps, caller, session);
  const mineIds = new Set(mine.map((entry) => entry.approvalId));

  let body: SessionView["body"];
  let task: DeveloperTaskRecord | undefined;
  let taskShown: DeveloperTaskView | undefined;
  if (session.subject.kind === "task") {
    task = await taskOf(deps, session);
    taskShown = withoutForeignLinks(await deps.taskView(task, { events: 20, details: true, actor: access.owner ? "owner" : "viewer" }), mineIds);
    // The task's own title is the session's: it reads like the session's.
    if (!access.owner && taskShown.title !== undefined) taskShown = { ...taskShown, title: hideEmailAddresses(taskShown.title) };
    body = { kind: "task", task: taskShown };
  } else if (session.subject.kind === "chain") {
    if (deps.chain === undefined) throw UNAVAILABLE();
    const chain = await deps.chain.runView({ kind: "session", developerId: caller.developerId }, session.subject.chainRunId);
    // Plan 4's run view, read against its own contract: a view that does not meet it is not shown (the screen would be handed something it can't read).
    const view = ChainRunViewSchema.safeParse(chain);
    if (!view.success) throw UNAVAILABLE();
    body = { kind: "chain", chain: view.data };
  } else {
    body = { kind: "local", tool: session.subject.tool };
  }

  const summary = session.summary;
  const status = computed || taskShown === undefined ? summary.status : statusOfTask(taskShown);
  // A blocked workflow reads as needing a person but can be retried; read live when the summary is not the computed one, and never for a finished task.
  const workflowBlocked = computed || taskShown === undefined ? summary.workflowBlocked : taskShown.workflow?.state === "BLOCKED" && status !== "succeeded" ? true as const : undefined;
  const step = computed || taskShown === undefined ? summary.step : taskShown.run?.currentStep?.name;
  const runLimitUsd = computed || task === undefined ? summary.runLimitUsd : typeof task.budgetUsd === "number" ? task.budgetUsd : undefined;
  const stopAtUsd = computed || task === undefined ? summary.stopAtUsd
    : runLimitUsd === undefined ? task.maxPerRunUsd : Math.min(runLimitUsd, task.maxPerRunUsd ?? runLimitUsd);
  const estimatedUsd = await estimatedSpendOf(deps, session, summary.costUsd);
  const pausedView = taskShown?.paused;
  let paused: SessionView["cost"]["paused"];
  if (pausedView !== undefined) {
    const spendRequestId = pausedView.spendRequestId;
    const mayDecide = spendRequestId !== undefined && deps.deciding !== undefined && await deps.deciding.spend(caller, spendRequestId).catch((error: unknown) => {
      if (isAgentXError(error)) return false;
      throw error;
    });
    paused = {
      scope: pausedView.scope["kind"] ?? "budget",
      ...(spendRequestId === undefined ? {} : { spendRequestId }),
      ...(mayDecide === true && spendRequestId !== undefined ? { confirmUrl: approveLink(deps, spendRequestId) } : {}),
    };
  }

  // UX2 slice 2: the one status, for this reader: the task view's own (its next step for the owner or for anyone else), and a budget pause says who can raise the limit.
  const baseDisplay = taskShown?.statusView ?? sessionTaskStatus(summary);
  const statusView: TaskStatus = baseDisplay.state === "paused_budget"
    ? { state: "paused_budget", reason: `it reached ${budgetScopeName(pausedView?.scope["kind"])}`, next: budgetPauseNext(pausedView?.scope["kind"], paused?.confirmUrl !== undefined, paused?.spendRequestId !== undefined) }
    : (() => { const next = taskStatusNext(baseDisplay, access.owner); const { nextOthers: _others, ...rest } = baseDisplay; void _others; return { ...rest, ...(next === undefined ? {} : { next }) }; })();
  // A failed setup draft is never retried: its next step is a new draft, asked for from the project's page.
  const display: TaskStatus = task?.purpose === "setup_draft" && statusView.state === "failed" ? { ...statusView, next: SETUP_DRAFT_RETRY_WORDS } : statusView;
  // Release 0.4.18: the owner's chosen name, read by the stored owner's id (a session started before the rename stores the name the person had then).
  const ownerNames = await ownerNameOverlay(deps, [access.effectiveOwner.developerId, session.owner.developerId], session.orgId);
  const followerItem = await getItem(deps, agentSessionKey(session.orgId, session.sessionId, `FOLLOWER#${caller.developerId}`));
  // Make this an agent (Task 10c): offered to a person who may create agents in the session's project, asked of the same check the route makes, with the org role read from their record. A task session only.
  const canMakeAgent = deps.mayMakeAgent !== undefined && session.kind === "task" && session.project !== undefined && await deps.mayMakeAgent({ orgId: caller.orgId, developerId: caller.developerId, orgRole: access.orgRole }, session.project);
  // The parts a comment can be pinned to, from the very view shown (Task 10b).
  const anchors = taskShown === undefined ? [] : anchorTargetsOf(taskShown);
  // Ask about this task / Fix with agent: offered only where the switch is on and the routes' own gate lets this reader use it (`live-flags.ts`).
  // An ended session is offered no Stop, steering or Take over, and Retry only where a retry starts a run.
  const ended = sessionHasEnded({ endedAt: session.endedAt, summary: { ...summary, status } });
  const live = await sessionLiveFlags(deps, caller, access, { errorRef: taskShown?.errorRef, closed: task?.closedAt !== undefined });
  return {
    contractVersion: AGENT_SESSION_CONTRACT_VERSION,
    sessionId: session.sessionId,
    kind: session.kind,
    mode: session.mode,
    title: wordsFor(access.owner)(session.title),
    ...(session.project === undefined ? {} : { project: session.project }),
    ...(session.agent === undefined ? {} : { agent: session.agent }),
    owner: ownerNamedAt(access.effectiveOwner, ownerNames, access.effectiveOwnerWrittenAt),
    startedBy: session.startedBy,
    where: session.where.kind === "cloud" ? { kind: "cloud" } : { kind: "mac", label: session.where.label, offline: summary.offline === true },
    status,
    ...(step === undefined ? {} : { step: wordsFor(access.owner)(step) }),
    ...(summary.peek === undefined ? {} : { peek: wordsFor(access.owner)(summary.peek) }),
    ...(summary.lastRunFailed === undefined ? {} : { lastRunFailed: summary.lastRunFailed }),
    display,
    // Live interaction F1: the task's own reference, read from the very view shown (a session whose task shows no error has none).
    ...(taskShown?.errorRef === undefined ? {} : { errorRef: taskShown.errorRef }),
    cost: {
      spentUsd: summary.costUsd,
      ...(estimatedUsd > 0 ? { estimatedUsd } : {}),
      ...(runLimitUsd === undefined ? {} : { runLimitUsd }),
      ...(stopAtUsd === undefined ? {} : { stopAtUsd }),
      payer: await payerOf(deps, session, ownerNamedAt({ developerId: session.owner.developerId, name: safeDisplayName(session.owner.name, session.owner.developerId) }, ownerNames, session.createdAt).name),
      ...(paused === undefined ? {} : { paused }),
    },
    approvals: mine.map((entry) => ({ approvalId: entry.approvalId, title: entry.title, confirmUrl: approveLink(deps, entry.approvalId) })),
    followers: session.followerCount,
    viewingNow: await viewingNow(deps, session, deps.now()),
    you: { level: levelOf(access), owner: access.owner, following: access.owner || followerItem !== undefined, actions: [...sessionActionsFor(access, { status, workflowBlocked, closable: closableSession(session), display: taskShown?.statusView ?? summary.display, ...(task?.closedAt === undefined ? {} : { closed: true as const }), ...(ended ? { ended: true as const, retryStartsRun: endedRetryStartsRun(session, task) } : {}) }), ...(canMakeAgent ? ["make_agent" as const] : [])],
      // Merge's rule (pressMerge): the effective owner, a maintainer of the project (granted or inherited) or an org admin. A reader at `view` who is one of the last two still presses it (C59).
      ...(session.subject.kind === "task" && levelOf(access) === "view" && (access.projectRole === "maintainer" || access.orgAdmin) ? { mayMerge: true as const } : {}),
      ...(live === undefined ? {} : { live }) },
    link: sessionLink(deps.origin, session.sessionId),
    bindings: await bindingsOf(deps, session),
    legs: session.legs,
    ...(session.retryOf === undefined ? {} : { retryOf: session.retryOf }),
    ...(anchors.length === 0 ? {} : { anchors }),
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
    body,
  };
}

// ---- a chain step's task

/**
 * `GET /v1/app/sessions/{id}/sections/{seq}/task` [view], chain sessions only. A caller with no project role that holds `start_tasks` on the chain's
 * project gets `NOT_FOUND`, whatever their level on the session (answer 7, I9): Plan 4's own check is the same one, kept when its reads are wired.
 */
export async function sessionStepTask(deps: SessionReadDependencies, caller: SessionReadCaller, sessionId: string, seq: number): Promise<{ task: DeveloperTaskView }> {
  const access = await requireSessionLevel(deps, caller, sessionId, "view", "view it");
  const { session } = access;
  if (session.subject.kind !== "chain" || !Number.isInteger(seq) || seq < 1 || seq > 9999) throw NOT_FOUND();
  if (session.project === undefined) throw NOT_FOUND();
  let role: Awaited<ReturnType<SessionReadDependencies["projectMembers"]["roleOf"]>>;
  try {
    role = await deps.projectMembers.roleOf(session.orgId, session.project, { developerId: caller.developerId, orgRole: access.orgRole });
  } catch (error) {
    if (isAgentXError(error)) throw error;
    throw agentXError("RUNTIME_UNAVAILABLE", "Your role in this project could not be checked; try again in a moment.");
  }
  if (role === undefined || !projectAllows(role, "start_tasks")) throw NOT_FOUND();
  if (deps.chain === undefined) throw UNAVAILABLE();
  return { task: await deps.chain.stepTask({ kind: "session", developerId: caller.developerId }, session.subject.chainRunId, seq) };
}

// ---- the lists

export interface SessionListQuery {
  owner?: "me" | undefined;
  project?: string | undefined;
  shared?: "me" | undefined;
  status?: "open" | "ended" | undefined;
  /** `team` or `company`, with `status=ended`: the Finished list over more than the caller's own work (`listFinishedScope`); none of owner, project or shared goes with it. */
  scope?: string | undefined;
  cursor?: string | undefined;
  /** Rows per page: 1 to 100, default 50. */
  limit?: number | undefined;
}

const DEFAULT_PAGE = 50;
const PROBE_ID = "ses_00000000000000000000";
const PROBE_AT = "2000-01-01T00:00:00.000Z";

/** The summary a tile carries: the step and latest line without an email address, unless the tile is its owner's own. A summary with none is returned as it is. */
function summaryFor(summary: AgentSessionRecord["summary"], mine: boolean): AgentSessionRecord["summary"] {
  if (mine) return summary;
  const step = summary.step === undefined ? undefined : hideEmailAddresses(summary.step);
  const peek = summary.peek === undefined ? undefined : hideEmailAddresses(summary.peek);
  return step === summary.step && peek === summary.peek ? summary : { ...summary, ...(step === undefined ? {} : { step }), ...(peek === undefined ? {} : { peek }) };
}

export function tileOf(session: AgentSessionRecord, level: SessionTile["level"], owner: SessionTile["owner"], mine: boolean): SessionTile {
  return {
    contractVersion: AGENT_SESSION_CONTRACT_VERSION,
    sessionId: session.sessionId,
    kind: session.kind,
    title: wordsFor(mine)(session.title),
    ...(session.project === undefined ? {} : { project: session.project }),
    ...(session.agent === undefined ? {} : { agent: session.agent }),
    owner,
    where: session.where,
    level,
    revision: session.revision,
    summary: summaryFor(session.summary, mine),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt, finishedAs: finishedAsOf(session) }),
  };
}

const invalid = (message: string) => agentXError("CONFIG_INVALID", message);

// ---- the cursor
// A cursor is the sort key of the last row a list scanned, which may be a session the caller can't see (when the scan cap stops the loop). So it is
// sealed (AES-256-GCM under the server's cursor key) and bound to the org, the person and the list it was given for: nobody can read the key out of
// it, change it, or carry it to another list or another person. Any failure is one message that echoes nothing (review m-1).

const CURSOR_VERSION = "v1.";
export const cursorKeyOf = (deps: Pick<SessionReadDependencies, "cursorKey">): Buffer => {
  if (deps.cursorKey === undefined || deps.cursorKey === "") throw agentXError("RUNTIME_UNAVAILABLE", "Sessions can't be listed right now.");
  return createHash("sha256").update(deps.cursorKey, "utf8").digest();
};
const cursorContext = (orgId: string, developerId: string, pk: string) => Buffer.from(`${orgId}\n${developerId}\n${pk}`, "utf8");

export function sealCursor(deps: Pick<SessionReadDependencies, "cursorKey">, caller: SessionCaller, pk: string, sk: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cursorKeyOf(deps), iv);
  cipher.setAAD(cursorContext(caller.orgId, caller.developerId, pk));
  const sealed = Buffer.concat([cipher.update(sk, "utf8"), cipher.final()]);
  return `${CURSOR_VERSION}${Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString("base64url")}`;
}

/** The sort key a cursor holds, or `CONFIG_INVALID` for anything this list, this person and this server key didn't give. */
export function openCursor(deps: Pick<SessionReadDependencies, "cursorKey">, caller: SessionCaller, pk: string, cursor: string): string {
  const key = cursorKeyOf(deps);
  const refuse = () => invalid("cursor: is not one this list gave");
  if (!cursor.startsWith(CURSOR_VERSION)) throw refuse();
  const body = cursor.slice(CURSOR_VERSION.length);
  const bytes = Buffer.from(body, "base64url");
  if (bytes.toString("base64url") !== body || bytes.length < 12 + 16 + 1) throw refuse(); // not the one spelling this list writes
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(cursorContext(caller.orgId, caller.developerId, pk));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const sk = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8");
    return sk;
  } catch {
    throw refuse();
  }
}

/**
 * `GET /v1/app/sessions?owner=me|project=<p>|shared=me&status=open|ended&cursor=`: one of the three indexes, newest first, each row read again with the
 * caller's level and dropped when they have none (an index row says only that a session once belonged there). The project index is the caller's
 * org's. `next` is opaque.
 */
export async function listSessions(deps: SessionReadDependencies, caller: SessionReadCaller, query: SessionListQuery): Promise<SessionList> {
  const list = await listSessionTiles(deps, caller, query);
  // Release 0.4.18: the owners' chosen names, one BatchGetItem for the page.
  const overlay = await ownerNameOverlay(deps, list.sessions.map((tile) => tile.owner.developerId), caller.orgId);
  return overlay.chosen.size === 0 && overlay.replaced.size === 0 ? list : { ...list, sessions: list.sessions.map((tile) => ({ ...tile, owner: ownerNamedAt(tile.owner, overlay, tile.createdAt) })) };
}

async function listSessionTiles(deps: SessionReadDependencies, caller: SessionReadCaller, query: SessionListQuery): Promise<SessionList> {
  if (query.scope !== undefined) throw invalid("scope: use the finished list for team and company");
  const chosen = [query.owner !== undefined, query.project !== undefined, query.shared !== undefined].filter(Boolean).length;
  if (chosen !== 1) throw invalid("Choose one of owner, project or shared.");
  if (query.owner !== undefined && query.owner !== "me") throw invalid("owner: must be me");
  if (query.shared !== undefined && query.shared !== "me") throw invalid("shared: must be me");
  if (query.project !== undefined && !AGENTX_NAME_PATTERN.test(query.project)) throw invalid("project: is not a project name");
  if (query.status !== undefined && query.status !== "open" && query.status !== "ended") throw invalid("status: must be open or ended");
  const limit = query.limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIVE_PAGE_MAX) throw invalid(`limit: must be a whole number from 1 to ${String(LIVE_PAGE_MAX)}`);

  const { orgId } = caller;
  const pk = query.project !== undefined ? projectSessionsKey(orgId, query.project, PROBE_AT, PROBE_ID).pk
    : query.shared !== undefined ? sharedSessionsKey(orgId, { kind: "member", developerId: caller.developerId }, PROBE_ID).pk
      : mySessionsKey(orgId, caller.developerId, PROBE_AT, PROBE_ID).pk;
  cursorKeyOf(deps); // a list that can't seal its cursor doesn't start
  const memo = newSessionRoleMemo(); // the caller's role on each project, asked once for the whole request (review m-2)
  let start: Record<string, unknown> | undefined;
  if (query.cursor !== undefined) {
    start = { pk, sk: openCursor(deps, caller, pk, query.cursor) };
  }

  const tiles: SessionTile[] = [];
  let lastSk: string | undefined;
  let scanned = 0;
  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, ScanIndexForward: false, Limit: 100,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    const rows = page.Items ?? [];
    for (const row of rows) {
      if (tiles.length >= limit || scanned >= LIVE_INDEX_SCAN_MAX) {
        return { sessions: tiles, ...(lastSk === undefined ? {} : { next: sealCursor(deps, caller, pk, lastSk) }) };
      }
      scanned += 1;
      if (typeof row["sk"] === "string") lastSk = row["sk"];
      const id = SessionIdSchema.safeParse(row["sessionId"]);
      if (!id.success || row["orgId"] !== orgId) continue;
      let access: SessionAccess;
      try {
        access = await requireSessionLevel(deps, caller, id.data, "view", "view it", { memo });
      } catch (error) {
        if (isAgentXError(error)) continue;
        throw error;
      }
      const ended = access.session.endedAt !== undefined;
      if ((query.status === "open" && ended) || (query.status === "ended" && !ended)) continue;
      tiles.push(tileOf(access.session, levelOf(access), access.effectiveOwner, access.owner));
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) return { sessions: tiles };
  }
}
