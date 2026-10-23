// A session's summary (Plan 5 Task 7a): what Live, Home and the header show, recomputed from the source records and never from a stream record's own
// contents, so a stale or out-of-order batch is only a reason to look again. A refresh writes the summary, the live tile and one event in one transaction,
// and tells the notice sink afterwards.
//
// A session ENDS only when its work is over (`isEnded`): a closed task, a creator-removed outcome, a merged or closed workflow, an agent-step run that
// ended, a chain run in a terminal status, a local session whose device reported its end. A stopped task is `stopped` and a task between turns is
// `waiting`; both stay open. An ended session never reopens.
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentSessionRecordSchema,
  ENDED_SESSION_STATUSES,
  INDEX_EXPIRY_ATTRIBUTE,
  LIVE_ENDED_KEEP_HOURS,
  LOCAL_OFFLINE_MINUTES,
  SESSION_NEEDS_PEOPLE_MAX,
  SESSION_PEEK_MAX_CHARS,
  SESSION_RETENTION_DAYS,
  SESSION_TITLE_MAX,
  STATUS_WORDS,
  agentSessionKey,
  canonicalJson,
  endedSessionWorkKey,
  liveSessionKey,
  openAgentSessionKey,
  redactText,
  sessionEventId,
  spendRequestKey,
  spendRequestSlotKey,
  taskSpendKey,
  type AgentSessionRecord,
  type OrgId,
  type OrgKey,
  type SessionEvent,
  type SessionId,
  type SessionStatus,
  type SessionSummary,
} from "@agentx/contracts";
import { getAnyApproval } from "../agents/approvals-store.js";
import { agentRunView } from "../agents/run-engine.js";
import { failedIndexes, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { taskPageStep } from "../aws/developer-tasks.js";
import { deriveTaskStatus, recentTaskEvents, taskKey, taskPointerKey, type DeveloperTaskRecord, type OperationFacts, type StoredEvent } from "../developer/task-records.js";
import { effectiveOwnerId } from "./access.js";
import { notifySessionChange } from "./notice-sink.js";
import { AgentSessionStore, sessionEventItem } from "./store.js";

type Item = Record<string, unknown>;
type Log = (entry: Record<string, unknown>) => void;

/** Where the drain remembers the first day it has not finished. A global item holding no org; the first session to end writes its day. */
export const ENDED_DRAIN_CURSOR_KEY: OrgKey = { pk: "ENDED_DRAIN_CURSOR", sk: "META" };

// ---- the sources Plan 4 and Task 18 fill in (until then a chain or local session keeps the summary it has)

/** What the summary needs of a chain run (Plan 4's record, read by its own code). */
export interface ChainFacts {
  status: "running" | "gate" | "paused" | "succeeded" | "failed" | "timed_out" | "cancelled";
  /** The current section's name. */
  stepName?: string;
  /** What the run's finished steps cost. */
  spentUsd: number;
  /** The running step's task, whose own counter is added. */
  stepTaskId?: string;
  /** Who a gate waits for. */
  needsPeople?: string[];
  endedAt?: string;
}
export interface ChainSessionSource {
  read(orgId: OrgId, chainRunId: string): Promise<ChainFacts | undefined>;
  /** Which chain session a stream record of Plan 4's is about (the projector asks); undefined for any other record. */
  targetOf?(record: Item): { orgId: OrgId; sessionId: SessionId } | undefined;
}

/** What a local session's device last said (Task 18). */
export interface LocalFacts {
  status: SessionStatus;
  step?: string;
  peek?: string;
  costUsd: number;
  lastRunFailed?: true;
  /** The device's last update. */
  updatedAt: string;
  /** Set when the device reported the end. */
  endedAt?: string;
}
export interface LocalSessionSource {
  read(session: AgentSessionRecord): Promise<LocalFacts | undefined>;
}

export interface SummaryDependencies extends TableInput {
  log?: Log | undefined;
  chains?: ChainSessionSource | undefined;
  local?: LocalSessionSource | undefined;
}

// ---- digest and small helpers

/** SHA-256 of the summary's canonical JSON without `computedAt` (and without the digest itself). */
export function sessionSummaryDigest(summary: Omit<SessionSummary, "digest" | "computedAt">): string {
  return createHash("sha256").update(canonicalJson(summary), "utf8").digest("hex");
}

const SECONDS_PER_DAY = 86_400;
const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (at: string) => Math.floor(Date.parse(at) / 1000);
const cleanUsd = (value: number) => Math.round(value * 1e6) / 1e6;
const log = (deps: Pick<SummaryDependencies, "log">, entry: Record<string, unknown>) =>
  (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

/** One line, no control or format characters, cut to the summary's step limit. */
const stepText = (text: string): string | undefined => {
  const clean = redactText(text).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...clean].slice(0, SESSION_TITLE_MAX).join("").trimEnd();
  return cut === "" ? undefined : cut;
};

const getItem = async (deps: Pick<TableInput, "documentClient" | "tableName">, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

async function queryPrefix(deps: Pick<TableInput, "documentClient" | "tableName">, pk: string, prefix: string, options: { limit?: number; newestFirst?: boolean } = {}): Promise<Item[]> {
  const found: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true,
      ...(options.newestFirst === true ? { ScanIndexForward: false } : {}), ...(options.limit === undefined ? {} : { Limit: options.limit }), ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    found.push(...(page.Items ?? []));
    start = options.limit === undefined ? page.LastEvaluatedKey : undefined;
  } while (start !== undefined);
  return found;
}

// ---- what is computed

type Ended = { status: "succeeded" | "failed" | "cancelled"; at: string };
interface Computed {
  summary: SessionSummary;
  /** Set when the source says the work is over. */
  ended?: Ended;
}

interface Parts {
  status: SessionStatus;
  step?: string | undefined;
  peek?: string | undefined;
  lastRunFailed?: true | undefined;
  costUsd: number;
  runLimitUsd?: number | undefined;
  stopAtUsd?: number | undefined;
  needsPeople?: readonly string[];
  pendingApprovals?: number;
  offline?: true | undefined;
}

function assemble(parts: Parts, now: number): SessionSummary {
  const needsPeople = [...new Set(parts.needsPeople ?? [])].slice(0, SESSION_NEEDS_PEOPLE_MAX);
  const base = {
    status: parts.status,
    ...(parts.step === undefined ? {} : { step: parts.step }),
    ...(parts.peek === undefined ? {} : { peek: parts.peek }),
    ...(parts.lastRunFailed === undefined ? {} : { lastRunFailed: parts.lastRunFailed }),
    costUsd: cleanUsd(parts.costUsd),
    ...(parts.runLimitUsd === undefined ? {} : { runLimitUsd: parts.runLimitUsd }),
    ...(parts.stopAtUsd === undefined ? {} : { stopAtUsd: parts.stopAtUsd }),
    needsPeople,
    pendingApprovals: parts.pendingApprovals ?? 0,
    ...(parts.offline === undefined ? {} : { offline: parts.offline }),
  };
  return { ...base, digest: sessionSummaryDigest(base), computedAt: iso(now) };
}

const taskSpend = async (deps: SummaryDependencies, orgId: OrgId, taskId: string): Promise<number> => {
  const value = (await getItem(deps, taskSpendKey(orgId, taskId)))?.["settledUsd"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
};

/** The newest readable line of an operation's events, redacted and cut. */
async function peekOf(deps: SummaryDependencies, operationId: string): Promise<string | undefined> {
  const rows = await queryPrefix(deps, `OPERATION#${operationId}`, "EVENT#", { limit: 50, newestFirst: true });
  const events: StoredEvent[] = rows.flatMap((row) => typeof row["sequence"] === "number" && typeof row["type"] === "string" && typeof row["timestamp"] === "string"
    ? [{ sequence: row["sequence"], type: row["type"], timestamp: row["timestamp"], payload: row["payload"] }] : []);
  const line = recentTaskEvents(events, 1)[0]?.text;
  if (line === undefined) return undefined;
  const cut = [...redactText(line).replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim()].slice(0, SESSION_PEEK_MAX_CHARS).join("");
  return cut === "" ? undefined : cut;
}

/** The candidates of the approvals a run waits on and of the spend requests a paused task waits on, with how many decisions wait. */
async function decisionsWaiting(deps: SummaryDependencies, task: DeveloperTaskRecord, approvalIds: readonly string[]): Promise<{ people: string[]; count: number }> {
  const orgId = task.orgId as OrgId;
  const people: string[] = [];
  let count = 0;
  for (const id of approvalIds) {
    const record = await getAnyApproval(deps, orgId, id as never).catch(() => undefined);
    if (record === undefined || record.status !== "PENDING") continue;
    count += 1;
    const approvers = (record as { approvers?: { kind: string; ids?: readonly string[]; candidates?: readonly string[] } }).approvers;
    people.push(...(approvers?.kind === "ids" ? approvers.ids ?? [] : approvers?.candidates ?? []));
  }
  if (task.budgetPause !== undefined) {
    for (const kind of ["run_limit", "max_per_run", "planning"]) {
      const slot = await getItem(deps, spendRequestSlotKey(orgId, task.taskId, kind));
      const requestId = slot?.["spendRequestId"];
      if (typeof requestId !== "string" || slot?.["orgId"] !== orgId) continue;
      const request = await getItem(deps, spendRequestKey(orgId, requestId));
      if (request === undefined || request["orgId"] !== orgId || request["status"] !== "PENDING") continue;
      const expiresAt = request["expiresAt"];
      if (typeof expiresAt === "string" && Date.parse(expiresAt) <= deps.now()) continue;
      count += 1;
      if (Array.isArray(request["approverIds"])) people.push(...(request["approverIds"] as unknown[]).filter((id): id is string => typeof id === "string"));
    }
  }
  return { people, count };
}

async function taskState(deps: SummaryDependencies, session: AgentSessionRecord, taskId: string): Promise<Computed | undefined> {
  const now = deps.now();
  const task = await getItem(deps, taskKey(taskId)) as DeveloperTaskRecord | undefined;
  // A task of another org is not this session's task.
  if (task === undefined || task.orgId !== session.orgId) return undefined;
  const [workspace, pointer, operationItems, spent] = await Promise.all([
    getItem(deps, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" }),
    getItem(deps, taskPointerKey(task.workspaceId)),
    queryPrefix(deps, `WORKSPACE#${task.workspaceId}`, "OPERATION#"),
    taskSpend(deps, session.orgId, task.taskId),
  ]);
  const operations: OperationFacts[] = operationItems.filter((item) => item["entityType"] === "OPERATION").map((item) => ({
    id: String(item["id"]), kind: String(item["kind"]), status: String(item["status"]), error: typeof item["error"] === "string" ? item["error"] : undefined,
    createdAt: String(item["createdAt"]), updatedAt: typeof item["updatedAt"] === "string" ? item["updatedAt"] : undefined, fence: typeof item["fence"] === "number" ? item["fence"] : undefined,
  }));
  const derived = deriveTaskStatus({
    closedAt: task.closedAt, outcome: task.outcome, workspaceStatus: typeof workspace?.["status"] === "string" ? workspace["status"] : "READY",
    pointer: pointer === undefined ? undefined : { pendingPrompt: typeof pointer["pendingPrompt"] === "string" ? pointer["pendingPrompt"] : undefined, cancelledAt: typeof pointer["cancelledAt"] === "string" ? pointer["cancelledAt"] : undefined },
    operations,
  });
  const workflow = task.workflow;
  const run = task.agent !== undefined && workflow === undefined
    ? await agentRunView({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, log: (event, fields) => log(deps, { event, ...fields }) }, task).catch(() => undefined)
    : undefined;

  const runLimitUsd = typeof task.budgetUsd === "number" ? task.budgetUsd : undefined;
  const stopAtUsd = runLimitUsd === undefined ? task.maxPerRunUsd : Math.min(runLimitUsd, task.maxPerRunUsd ?? runLimitUsd);
  const costs = { costUsd: spent, runLimitUsd, stopAtUsd };

  // Is the work over?
  const lastRun = derived.current?.status;
  const closedStatus: Ended["status"] = lastRun === "SUCCEEDED" ? "succeeded" : lastRun === "FAILED" || lastRun === "INTERRUPTED" ? "failed" : "cancelled";
  const at = task.closedAt ?? task.agentRunEnd?.at ?? task.outcomeAt ?? task.updatedAt;
  let ended: Ended | undefined;
  const runEnd = run !== undefined && (run.state === "COMPLETE" || run.state === "FAILED" || run.state === "CANCELLED") ? run.state : task.agentRunEnd?.state;
  if (task.outcome === "creator_removed") ended = { status: "failed", at: task.outcomeAt ?? at };
  else if (runEnd !== undefined) ended = { status: runEnd === "COMPLETE" ? "succeeded" : runEnd === "FAILED" ? "failed" : "cancelled", at };
  else if (workflow?.stage === "MERGED") ended = { status: "succeeded", at };
  else if (workflow?.stage === "CLOSED") ended = { status: "cancelled", at };
  else if (task.closedAt !== undefined) ended = { status: closedStatus, at };
  if (ended !== undefined) {
    const step = workflow === undefined ? undefined : stepText(taskPageStep(workflow, task.closedAt !== undefined));
    return { ended, summary: assemble({ status: ended.status, step, ...costs }, now) };
  }

  // Open: the workflow stage decides first, then a run, then the last operation.
  const waitingOn = await decisionsWaiting(deps, task, run?.pendingApprovals.map((entry) => entry.approvalId) ?? []);
  let status: SessionStatus;
  let step: string | undefined;
  let lastRunFailed: true | undefined;
  const starting = derived.status === "STARTING";
  if (task.budgetPause !== undefined) {
    status = "paused";
    step = workflow === undefined ? run?.currentStep?.name : taskPageStep(workflow, false);
  } else if (workflow !== undefined) {
    step = taskPageStep(workflow, false);
    if ((workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") || workflow.state === "BLOCKED") status = "needs_person";
    else if (workflow.state === "WAITING") status = "waiting";
    else status = starting ? "starting" : "running";
  } else if (run !== undefined) {
    step = run.currentStep?.name;
    if (run.state === "WAITING_FOR_APPROVAL" || waitingOn.count > 0) status = "needs_person";
    else if (run.state === "PAUSED_BUDGET") status = "paused";
    else status = starting ? "starting" : "running";
  } else {
    switch (derived.status) {
      case "STARTING": status = "starting"; break;
      case "RUNNING": status = "running"; break;
      case "CANCELLED": status = "stopped"; break;
      case "FAILED":
      case "INTERRUPTED":
        status = "waiting";
        lastRunFailed = true;
        step = `Failed: ${derived.failure?.category ?? "task_failed"}`;
        break;
      default: status = "waiting";
    }
  }
  const needsPeople = [...waitingOn.people];
  if (status === "needs_person" && needsPeople.length === 0) needsPeople.push(effectiveOwnerId(session, task as unknown as Item));
  if (workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING" && !needsPeople.includes(effectiveOwnerId(session, task as unknown as Item))) needsPeople.push(effectiveOwnerId(session, task as unknown as Item));
  const peek = derived.current === undefined ? undefined : await peekOf(deps, derived.current.id).catch(() => undefined);
  return { summary: assemble({ status, step: step === undefined ? undefined : stepText(step), peek, lastRunFailed, needsPeople, pendingApprovals: waitingOn.count, ...costs }, now) };
}

async function chainState(deps: SummaryDependencies, session: AgentSessionRecord, chainRunId: string): Promise<Computed | undefined> {
  if (deps.chains === undefined) return undefined;
  const facts = await deps.chains.read(session.orgId, chainRunId);
  if (facts === undefined) return undefined;
  const now = deps.now();
  const stepCost = facts.stepTaskId === undefined ? 0 : await taskSpend(deps, session.orgId, facts.stepTaskId);
  const costUsd = facts.spentUsd + stepCost;
  const step = facts.stepName === undefined ? undefined : stepText(facts.stepName);
  const terminal = { succeeded: "succeeded", failed: "failed", timed_out: "failed", cancelled: "cancelled" } as const;
  if (facts.status in terminal) {
    const status = terminal[facts.status as keyof typeof terminal];
    return { ended: { status, at: facts.endedAt ?? iso(now) }, summary: assemble({ status, step, costUsd }, now) };
  }
  const status: SessionStatus = facts.status === "gate" ? "needs_person" : facts.status === "paused" ? "paused" : "running";
  const needsPeople = facts.needsPeople ?? (status === "needs_person" ? [session.owner.developerId] : []);
  return { summary: assemble({ status, step, costUsd, needsPeople }, now) };
}

async function localState(deps: SummaryDependencies, session: AgentSessionRecord): Promise<Computed | undefined> {
  if (deps.local === undefined) return undefined;
  const facts = await deps.local.read(session);
  if (facts === undefined) return undefined;
  const now = deps.now();
  const over = (ENDED_SESSION_STATUSES as readonly string[]).includes(facts.status);
  const step = facts.step === undefined ? undefined : stepText(facts.step);
  const peek = facts.peek === undefined ? undefined : [...redactText(facts.peek).replace(/[\p{Cc}\p{Cf}]+/gu, " ")].slice(0, SESSION_PEEK_MAX_CHARS).join("");
  const offline = !over && now - Date.parse(facts.updatedAt) > LOCAL_OFFLINE_MINUTES * 60_000 ? true as const : undefined;
  const summary = assemble({ status: facts.status, step, peek, lastRunFailed: facts.lastRunFailed, costUsd: facts.costUsd, offline }, now);
  return over ? { summary, ended: { status: facts.status as Ended["status"], at: facts.endedAt ?? iso(now) } } : { summary };
}

async function computeState(deps: SummaryDependencies, session: AgentSessionRecord): Promise<Computed | undefined> {
  switch (session.subject.kind) {
    case "task": return taskState(deps, session, session.subject.taskId);
    case "chain": return chainState(deps, session, session.subject.chainRunId);
    default: return localState(deps, session);
  }
}

/**
 * The summary of a session from its source records only (each task read re-checks `task.orgId`). A session whose source can't be read (a task of
 * another org, a chain or a local session with no source wired) keeps the summary it has.
 */
export async function computeSessionSummary(deps: SummaryDependencies, session: AgentSessionRecord): Promise<SessionSummary> {
  return (await computeState(deps, session))?.summary ?? session.summary;
}

// ---- the refresh

const STATUS_TEXT: Record<SessionStatus, string> = {
  starting: "Starting", running: "Running", needs_person: STATUS_WORDS.needs_person, paused: STATUS_WORDS.paused, waiting: STATUS_WORDS.waiting, stopped: STATUS_WORDS.stopped,
  succeeded: "Finished: succeeded", failed: "Finished: failed", cancelled: "Finished: cancelled",
};

function changeEvent(session: AgentSessionRecord, next: SessionSummary, revision: number, statusChanged: boolean, stepChanged: boolean, ending: boolean): SessionEvent | undefined {
  if (!statusChanged && !stepChanged) return undefined;
  const type = stepChanged && !ending && next.step !== undefined ? "step" as const : "status" as const;
  const text = type === "step" ? `${statusChanged ? `${STATUS_TEXT[next.status]}. ` : ""}Step: ${next.step ?? ""}` : STATUS_TEXT[next.status];
  return { eventId: sessionEventId(type, `${session.sessionId}:${String(revision)}`), at: next.computedAt, type, actor: { kind: "system" }, text };
}

function tileOf(session: AgentSessionRecord, summary: SessionSummary, revision: number, endedAt: string | undefined): Item {
  return {
    ...liveSessionKey(session.orgId, session.sessionId), entityType: "LIVE_SESSION", orgId: session.orgId, sessionId: session.sessionId, kind: session.kind,
    ...(session.project === undefined ? {} : { project: session.project }), ownerId: session.owner.developerId, owner: session.owner, title: session.title,
    ...(session.agent === undefined ? {} : { agent: session.agent }), where: session.where, status: summary.status, summary, summaryRevision: revision, revision: session.revision,
    createdAt: session.createdAt, updatedAt: summary.computedAt,
    ...(endedAt === undefined ? {} : { endedAt, [INDEX_EXPIRY_ATTRIBUTE]: seconds(endedAt) + LIVE_ENDED_KEEP_HOURS * 3600 }),
  };
}

/**
 * Recomputes one session's summary and, when its digest differs, writes it: META `summary` and `summaryRevision + 1` (conditional on the revision read; one
 * re-read on a lost race), the live tile, and a `status` or `step` event when either changed (its id comes from the new revision, so it is told once).
 * The first ended summary also sets `endedAt`, takes the session out of the sweep's list, lists it for the drain and sets its retention. An ended session
 * never reopens, and keeps the status it ended with while its cost catches up.
 */
export async function refreshSessionSummary(deps: SummaryDependencies, orgId: OrgId, sessionId: SessionId): Promise<"unchanged" | "updated"> {
  const store = new AgentSessionStore(deps);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const session = await store.get(orgId, sessionId);
    if (session === undefined) return "unchanged";
    const state = await computeState(deps, session);
    if (state === undefined) return "unchanged";
    const wasEnded = session.endedAt !== undefined;
    if (wasEnded && state.ended === undefined) {
      log(deps, { event: "agent_session.reopen_refused", orgId, sessionId });
      return "unchanged";
    }
    // An ended session keeps the status it ended with.
    const summary = wasEnded && state.summary.status !== session.summary.status
      ? assemble({ ...state.summary, status: session.summary.status }, Date.parse(state.summary.computedAt))
      : state.summary;
    if (summary.digest === session.summary.digest) return "unchanged";

    const revision = session.summaryRevision + 1;
    const ending = !wasEnded && state.ended !== undefined;
    const endedAt = wasEnded ? session.endedAt : state.ended?.at;
    const statusChanged = summary.status !== session.summary.status;
    const stepChanged = (summary.step ?? "") !== (session.summary.step ?? "");
    const event = changeEvent(session, summary, revision, statusChanged, stepChanged, ending);
    const legs = ending ? session.legs.map((leg, index) => index === session.legs.length - 1 && leg.endedAt === undefined ? { ...leg, endedAt: endedAt!, endedBy: "end" as const } : leg) : session.legs;
    const metaKey = agentSessionKey(orgId, sessionId, "META");
    const items: TransactItem[] = [
      { Update: {
        TableName: deps.tableName, Key: metaKey,
        UpdateExpression: `SET summary = :summary, summaryRevision = :next, updatedAt = :at${ending ? ", endedAt = :ended, legs = :legs, #expires = :expires" : ""}`,
        ConditionExpression: "attribute_exists(pk) AND orgId = :org AND summaryRevision = :read",
        ...(ending ? { ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE } } : {}),
        ExpressionAttributeValues: {
          ":summary": summary, ":next": revision, ":at": summary.computedAt, ":org": orgId, ":read": session.summaryRevision,
          ...(ending ? { ":ended": endedAt, ":legs": legs, ":expires": seconds(endedAt!) + SESSION_RETENTION_DAYS * SECONDS_PER_DAY } : {}),
        },
      } },
      { Put: { TableName: deps.tableName, Item: tileOf(session, summary, revision, endedAt) } },
      ...(event === undefined ? [] : [sessionEventItem(deps, { orgId, sessionId }, event)]),
      ...(ending ? [
        { Delete: { TableName: deps.tableName, Key: openAgentSessionKey(orgId, sessionId) } },
        { Put: { TableName: deps.tableName, Item: { ...endedSessionWorkKey(endedAt!.slice(0, 10), orgId, sessionId), entityType: "ENDED_AGENT_SESSION", orgId, sessionId, endedAt } } },
        { Update: {
          TableName: deps.tableName, Key: ENDED_DRAIN_CURSOR_KEY,
          UpdateExpression: "SET entityType = if_not_exists(entityType, :type), #day = if_not_exists(#day, :day)",
          ExpressionAttributeNames: { "#day": "day" }, ExpressionAttributeValues: { ":type": "ENDED_DRAIN_CURSOR", ":day": endedAt!.slice(0, 10) },
        } },
      ] : []),
    ];
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") {
        // Another refresh got there first (or the event is already told): look again, once.
        if (failedIndexes(error) === undefined) throw error;
        continue;
      }
      throw error;
    }
    await notifySessionChange(deps, {
      orgId, sessionId, session: AgentSessionRecordSchema.parse({ ...session, summary, summaryRevision: revision, updatedAt: summary.computedAt, legs, ...(endedAt === undefined ? {} : { endedAt }) }),
      previous: session.summary, summary, summaryRevision: revision, statusChanged, stepChanged, ended: ending, at: summary.computedAt,
    });
    return "updated";
  }
  return "unchanged";
}
