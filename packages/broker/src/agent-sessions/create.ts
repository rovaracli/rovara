// A task session is created with the run it wraps (Plan 5 Task 2): `createTaskSessionItems` returns the items that join the run's own start
// transaction, so the task and its session exist together or not at all.
import { resolveStoredName } from "../developer/name-resolver.js";
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentSessionRecordSchema,
  SESSION_TITLE_MAX,
  agentSessionKey,
  cleanSessionName,
  liveSessionKey,
  mySessionsKey,
  openAgentSessionKey,
  principalKey,
  projectSessionsKey,
  redactText,
  sessionEventId,
  sessionLegSk,
  sharedSessionsKey,
  type AgentPrincipal,
  type AgentSessionRecord,
  type LocalTool,
  type OrgId,
  type Payer,
  type SessionTrigger,
  type SessionEvent,
  type SessionLeg,
  type SessionLevel,
  type WorkOrigin,
} from "@agentx/contracts";
import { putNew, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { threadBindingItems } from "./bindings.js";
import { sessionEventItem } from "./store.js";

const UNTITLED = "Untitled task";

/**
 * The title a session shows: redacted first (so the cut can't leave half a token), invisible and control characters turned into spaces, and
 * cut to `SESSION_TITLE_MAX` characters. The caller passes a title that already went through `inertTaskTitle` (that function lives in the task
 * code, which imports this module).
 */
export function sessionTitle(title: string): string {
  const clean = redactText(title).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...clean].slice(0, SESSION_TITLE_MAX).join("").trimEnd();
  return cut === "" ? UNTITLED : cut;
}

/**
 * Who a task session names as its starter: the trigger that started a run no person started, else the person who did. Nothing for a chain step's task
 * (its chain run is the session) and for a run with neither, so the start, and a later lazy creation for a task from before sessions, skip those
 * instead of guessing or throwing.
 */
export function sessionStarterFor(input: {
  trigger: SessionTrigger | undefined;
  startedBy: { developerId: string } | undefined;
  chain: { chainRunId: string; stepId: string } | undefined;
}): AgentSessionRecord["startedBy"] | undefined {
  if (input.chain !== undefined) return undefined;
  if (input.trigger !== undefined) return { kind: input.trigger.kind, triggerId: input.trigger.triggerId };
  return input.startedBy === undefined ? undefined : { kind: "member", developerId: input.startedBy.developerId };
}

export interface TaskSessionInput {
  orgId: OrgId;
  sessionId: string;
  taskId: string;
  project: string;
  agent: { agentId: string; name: string; version: number | "draft" };
  title: string;
  owner: { developerId: string; name: string };
  startedBy: AgentSessionRecord["startedBy"];
  /** The name of the member who started the run, when it isn't the owner (the start reads it); without it the event says "Someone". */
  startedByName?: string | undefined;
  origin: WorkOrigin;
  payer: Payer;
  /** The start's time (an instant): the session, its leg, its event and its index entries are all stamped with it. */
  now: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** What the started event says: who or what began the work, and for whom when another member started it on the owner's behalf. */
function startedText(input: TaskSessionInput, owner: string, starter: string | undefined, agent: string, title: string): string {
  if (input.startedBy.kind === "event") return `An event started ${agent}: ${title}`;
  if (input.startedBy.kind === "schedule") return `A schedule started ${agent}: ${title}`;
  if (input.startedBy.kind === "member" && input.startedBy.developerId !== input.owner.developerId) return `${starter ?? "Someone"} started ${agent} for ${owner}: ${title}`;
  return `${owner} started ${agent}: ${title}`;
}

/**
 * The items of a new task session: the `META` header (status "starting", revision 1), its first leg, the `started` event, the entries that
 * list it for its owner (and for a different member who started it), its project, the live wall and the sweep. Each is written only if absent.
 * The task's own record carries the `sessionId` (the caller writes that).
 */
/** The header record a new task session starts with, its first leg alongside. */
function taskSessionHeader(input: TaskSessionInput): { record: AgentSessionRecord; leg: SessionLeg } {
  const owner = cleanSessionName(input.owner.name) ?? "Someone";
  const agentName = cleanSessionName(input.agent.name) ?? input.agent.agentId;
  const title = sessionTitle(input.title);
  const subject = { kind: "task" as const, taskId: input.taskId };
  const where = { kind: "cloud" as const };
  const leg: SessionLeg = { seq: 1, subject, where, startedAt: input.now };
  const summary = { status: "starting" as const, costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: sha256("starting"), computedAt: input.now };
  const record = AgentSessionRecordSchema.parse({
    orgId: input.orgId, sessionId: input.sessionId, kind: "task", mode: "delegate", subject, legs: [leg], where, project: input.project,
    agent: { agentId: input.agent.agentId, name: agentName, version: input.agent.version }, title, owner: { developerId: input.owner.developerId, name: owner },
    startedBy: input.startedBy, origin: input.origin, payer: input.payer, followerCount: 0, summary, summaryRevision: 1, revision: 1,
    createdAt: input.now, updatedAt: input.now,
  } satisfies Record<string, unknown>);
  return { record, leg };
}

export function createTaskSessionItems(table: TableInput, input: TaskSessionInput): TransactItem[] {
  const owner = cleanSessionName(input.owner.name) ?? "Someone";
  const agentName = cleanSessionName(input.agent.name) ?? input.agent.agentId;
  const starterName = input.startedByName === undefined ? undefined : cleanSessionName(input.startedByName);
  const { record, leg } = taskSessionHeader(input);
  const title = record.title;
  const { orgId, sessionId } = record;
  const startedByOwner = input.startedBy.kind === "member" && input.startedBy.developerId === input.owner.developerId;
  const event: SessionEvent = {
    eventId: sessionEventId("started", sessionId), at: input.now, type: "started",
    actor: startedByOwner ? { kind: "member", developerId: input.owner.developerId, name: owner }
      : input.startedBy.kind === "member" && starterName !== undefined ? { kind: "member", developerId: input.startedBy.developerId, name: starterName } : { kind: "system" },
    text: startedText(input, owner, starterName, agentName, title),
  };
  const listed = (developerId: string) => putNew(table, mySessionsKey(orgId, developerId, input.now, sessionId), "MY_SESSION", { orgId, sessionId, developerId, createdAt: input.now });
  return [
    putNew(table, agentSessionKey(orgId, sessionId, "META"), "AGENT_SESSION", { ...record }),
    putNew(table, agentSessionKey(orgId, sessionId, sessionLegSk(leg.seq)), "AGENT_SESSION_LEG", { orgId, sessionId, ...leg }),
    sessionEventItem(table, { orgId, sessionId }, event),
    listed(input.owner.developerId),
    ...(input.startedBy.kind === "member" && !startedByOwner ? [listed(input.startedBy.developerId)] : []),
    putNew(table, projectSessionsKey(orgId, input.project, input.now, sessionId), "PROJECT_SESSION", { orgId, sessionId, project: input.project, createdAt: input.now }),
    putNew(table, liveSessionKey(orgId, sessionId), "LIVE_SESSION", {
      orgId, sessionId, kind: "task", project: input.project, ownerId: input.owner.developerId, status: "starting", createdAt: input.now, updatedAt: input.now,
    }),
    putNew(table, openAgentSessionKey(orgId, sessionId), "OPEN_AGENT_SESSION", { orgId, sessionId }),
  ];
}


// ---- a chain run (Plan 5 Task 3)

export interface ChainSessionInput {
  orgId: OrgId;
  /** The run's own id: a chain run is one session and its id is the session's. */
  runId: string;
  chainName: string;
  project: string;
  owner: { developerId: string; name: string };
  startedBy: AgentSessionRecord["startedBy"];
  /** The name of the member who started the run, when it isn't the owner. */
  startedByName?: string | undefined;
  /** The first line of what the person said to start the run, else the title of the event that started it. */
  about?: string | undefined;
  origin: WorkOrigin;
  payer: Payer;
  now: string;
}

/** Slack's markup reduced to plain words, and a mention made inert (the same reduction a task's title gets for GitHub): the title is shown in lists and posted to channels. */
function inertSessionText(text: string): string {
  return text
    .replace(/<(?:https?|mailto):[^|>]*\|([^>]*)>/giu, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/gu, "#$1")
    .replace(/<[@#!][^>]*>/gu, "")
    .replace(/@(?=\w)/gu, "@\u200D")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The title of a chain session: `<chain>: <first line of the start input or the trigger title>`, redacted and made inert, and cut like any session title. */
export function chainSessionTitle(chainName: string, about: string | undefined): string {
  const first = about === undefined ? "" : inertSessionText(redactText(about.split(/\r?\n/u).find((line) => line.trim() !== "") ?? ""));
  return sessionTitle(first === "" ? chainName : `${chainName}: ${first}`);
}

/**
 * The items of a chain run's session, joining the run's own start transaction (Plan 4's `startChainRun`): the `META` header (status "starting", revision 1), its first leg, the
 * `started` event, the entries that list it for its owner (and for a different member who started it), its project, the live wall and the sweep. `sessionId` is the run's id. The
 * run's step tasks get no session of their own. Each is written only if absent.
 */
export function createChainSessionItems(table: TableInput, input: ChainSessionInput): TransactItem[] {
  const owner = cleanSessionName(input.owner.name) ?? "Someone";
  const chainName = cleanSessionName(input.chainName) ?? "A chain";
  const starterName = input.startedByName === undefined ? undefined : cleanSessionName(input.startedByName);
  const title = chainSessionTitle(chainName, input.about);
  const subject = { kind: "chain" as const, chainRunId: input.runId };
  const where = { kind: "cloud" as const };
  const leg: SessionLeg = { seq: 1, subject, where, startedAt: input.now };
  const summary = { status: "starting" as const, costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: sha256("starting"), computedAt: input.now };
  const record = AgentSessionRecordSchema.parse({
    orgId: input.orgId, sessionId: input.runId, kind: "chain", mode: "delegate", subject, legs: [leg], where, project: input.project, title,
    owner: { developerId: input.owner.developerId, name: owner }, startedBy: input.startedBy, origin: input.origin, payer: input.payer,
    followerCount: 0, summary, summaryRevision: 1, revision: 1, createdAt: input.now, updatedAt: input.now,
  } satisfies Record<string, unknown>);
  const { orgId, sessionId } = record;
  const startedByOwner = input.startedBy.kind === "member" && input.startedBy.developerId === input.owner.developerId;
  const event: SessionEvent = {
    eventId: sessionEventId("started", sessionId), at: input.now, type: "started",
    actor: startedByOwner ? { kind: "member", developerId: input.owner.developerId, name: owner }
      : input.startedBy.kind === "member" && starterName !== undefined ? { kind: "member", developerId: input.startedBy.developerId, name: starterName } : { kind: "system" },
    text: input.startedBy.kind === "event" ? `An event started ${chainName}: ${title}`
      : input.startedBy.kind === "schedule" ? `A schedule started ${chainName}: ${title}`
        : input.startedBy.kind === "member" && !startedByOwner ? `${starterName ?? "Someone"} started ${chainName} for ${owner}: ${title}` : `${owner} started ${chainName}: ${title}`,
  };
  const listed = (developerId: string) => putNew(table, mySessionsKey(orgId, developerId, input.now, sessionId), "MY_SESSION", { orgId, sessionId, developerId, createdAt: input.now });
  return [
    putNew(table, agentSessionKey(orgId, sessionId, "META"), "AGENT_SESSION", { ...record }),
    putNew(table, agentSessionKey(orgId, sessionId, sessionLegSk(leg.seq)), "AGENT_SESSION_LEG", { orgId, sessionId, ...leg }),
    sessionEventItem(table, { orgId, sessionId }, event),
    listed(input.owner.developerId),
    ...(input.startedBy.kind === "member" && !startedByOwner ? [listed(input.startedBy.developerId)] : []),
    putNew(table, projectSessionsKey(orgId, input.project, input.now, sessionId), "PROJECT_SESSION", { orgId, sessionId, project: input.project, createdAt: input.now }),
    putNew(table, liveSessionKey(orgId, sessionId), "LIVE_SESSION", {
      orgId, sessionId, kind: "chain", project: input.project, ownerId: input.owner.developerId, status: "starting", createdAt: input.now, updatedAt: input.now,
    }),
    putNew(table, openAgentSessionKey(orgId, sessionId), "OPEN_AGENT_SESSION", { orgId, sessionId }),
  ];
}


// ---- a session on a Mac (Plan 5 Task 18)

/** How a tool is named in a session's words. */
export const LOCAL_TOOL_WORDS: Record<LocalTool, string> = { rovara: "Rovara", "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", "cursor-cli": "Cursor" };

export interface LocalSessionInput {
  orgId: OrgId;
  sessionId: string;
  deviceId: string;
  /** The device's label as the device record holds it now. */
  deviceLabel: string;
  tool: LocalTool;
  project?: string | undefined;
  /** Already through `inertTaskTitle`. */
  title: string;
  owner: { developerId: string; name: string };
  /** When the work began on the Mac (the leg's start; the caller keeps it from the future). */
  startedAt: string;
  /** The people, projects or company the owner shares it with: checked by the caller. */
  shares: ReadonlyArray<{ principal: AgentPrincipal; level: SessionLevel }>;
  /** The registration's time (an instant): the session, its event, its index entries and its shares are stamped with it. */
  now: string;
}

/**
 * The items of a new local session: the `META` header (kind "local", status "running", revision 1, no payer: the Mac pays for itself), its first leg on the device, the `started` event,
 * the entry that lists it for its owner, its project (when it names one, for rules and budgets only), the live wall and the sweep, and each share with its "shared with me" entry.
 * Each is written only if absent. The session's `LOCAL` state and the device's entry for it are the caller's (`registerLocalSession`).
 */
export function createLocalSessionItems(table: TableInput, input: LocalSessionInput): TransactItem[] {
  const owner = cleanSessionName(input.owner.name) ?? "Someone";
  const label = cleanSessionName(input.deviceLabel) ?? "a Mac";
  const title = sessionTitle(input.title);
  const subject = { kind: "local" as const, deviceId: input.deviceId, tool: input.tool };
  const where = { kind: "mac" as const, deviceId: input.deviceId, label: input.deviceLabel };
  const leg: SessionLeg = { seq: 1, subject, where, startedAt: input.startedAt };
  const summary = { status: "running" as const, costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: sha256("running"), computedAt: input.now };
  const record = AgentSessionRecordSchema.parse({
    orgId: input.orgId, sessionId: input.sessionId, kind: "local", mode: "delegate", subject, legs: [leg], where, ...(input.project === undefined ? {} : { project: input.project }), title,
    owner: { developerId: input.owner.developerId, name: owner }, startedBy: { kind: "local" }, origin: "local", followerCount: 0, summary, summaryRevision: 1, revision: 1,
    createdAt: input.now, updatedAt: input.now,
  } satisfies Record<string, unknown>);
  const { orgId, sessionId } = record;
  const event: SessionEvent = {
    eventId: sessionEventId("started", sessionId), at: input.now, type: "started", actor: { kind: "member", developerId: input.owner.developerId, name: owner },
    text: `${owner} started ${LOCAL_TOOL_WORDS[input.tool]} on ${label}: ${title}`,
  };
  const sharedBy = { developerId: input.owner.developerId, name: owner };
  return [
    putNew(table, agentSessionKey(orgId, sessionId, "META"), "AGENT_SESSION", { ...record }),
    putNew(table, agentSessionKey(orgId, sessionId, sessionLegSk(leg.seq)), "AGENT_SESSION_LEG", { orgId, sessionId, ...leg }),
    sessionEventItem(table, { orgId, sessionId }, event),
    putNew(table, mySessionsKey(orgId, input.owner.developerId, input.now, sessionId), "MY_SESSION", { orgId, sessionId, developerId: input.owner.developerId, createdAt: input.now }),
    ...(input.project === undefined ? [] : [putNew(table, projectSessionsKey(orgId, input.project, input.now, sessionId), "PROJECT_SESSION", { orgId, sessionId, project: input.project, createdAt: input.now })]),
    putNew(table, liveSessionKey(orgId, sessionId), "LIVE_SESSION", {
      orgId, sessionId, kind: "local", ...(input.project === undefined ? {} : { project: input.project }), ownerId: input.owner.developerId, status: "running", createdAt: input.now, updatedAt: input.now,
    }),
    putNew(table, openAgentSessionKey(orgId, sessionId), "OPEN_AGENT_SESSION", { orgId, sessionId }),
    ...input.shares.flatMap(({ principal, level }) => [
      putNew(table, agentSessionKey(orgId, sessionId, `SHARE#${principalKey(principal)}`), "AGENT_SESSION_SHARE", { orgId, sessionId, principal, level, sharedBy, sharedAt: input.now }),
      putNew(table, sharedSessionsKey(orgId, principal, sessionId), "SHARED_SESSION", { orgId, sessionId, principal, level, sharedAt: input.now }),
    ]),
  ];
}


// ---- a task from before sessions

/** What a lazy creation reads of a task record. */
export interface LazySessionTask {
  taskId: string;
  orgId?: OrgId | undefined;
  sessionId?: string | undefined;
  project: string;
  developerId: string;
  createdAt: string;
  agent?: { agentId: string; name: string; version: number | "draft" } | undefined;
  origin?: WorkOrigin | undefined;
  payer?: Payer | undefined;
  startedBy?: { developerId: string } | undefined;
  chain?: { chainRunId: string; stepId: string } | undefined;
  /** The Slack thread the task is shared to, if it has one: the session is bound to it as it is made (Task 20). */
  share?: { teamId: string; channelId: string; threadTs?: string | undefined } | undefined;
}

/**
 * The one session id a task gets when it is made after the fact: derived from the task id, so two first reads that race write the same item and
 * the loser's transaction is refused instead of making a second session.
 */
export function lazySessionId(taskId: string): string {
  return `ses_${sha256(`task-session\n${taskId}`).slice(0, 20)}`;
}

/** What a lazy creation would write for a task, or undefined when the task lacks what a session needs (the same facts `ensureTaskSession` rests on). */
function lazyTaskSessionInput(task: LazySessionTask, input: { ownerName: string; title: string }): TaskSessionInput | undefined {
  const startedBy = sessionStarterFor({ trigger: undefined, startedBy: task.startedBy, chain: task.chain });
  if (startedBy === undefined || task.orgId === undefined || task.agent === undefined || task.origin === undefined) return undefined;
  return {
    orgId: task.orgId, sessionId: lazySessionId(task.taskId), taskId: task.taskId, project: task.project, agent: { agentId: task.agent.agentId, name: task.agent.name, version: task.agent.version },
    title: input.title, owner: { developerId: task.developerId, name: input.ownerName }, startedBy, origin: task.origin,
    payer: task.payer ?? { kind: "member", developerId: task.developerId }, now: task.createdAt,
  };
}

/**
 * The session `ensureTaskSession` would make for a task, without writing anything: for judging what a person may do with it before it exists (a take-over asked of a task that
 * has no session yet). Undefined when the task could not get one.
 */
export function lazyTaskSessionRecord(task: LazySessionTask, input: { ownerName: string; title: string }): AgentSessionRecord | undefined {
  const sessionInput = lazyTaskSessionInput(task, input);
  return sessionInput === undefined ? undefined : taskSessionHeader(sessionInput).record;
}

/**
 * Gives a task started before sessions its session, the first time it is read (a ruling of 2026-10-22: no sweep). One transaction writes the session
 * items and names the session on the task, conditioned on the task having none and belonging to this org, so a repeat or a racing read finds the
 * first one. The starter comes from `sessionStarterFor` (a trigger is not kept on a task, so a scheduled or event run from before skips); a chain
 * step's task, a task with no starter, agent or origin, and a task of another org are skipped. Never throws: a failure is a task with no session
 * yet, which the next read tries again. `input.title` has already been through `inertTaskTitle`. The session is stamped with the task's own
 * creation time, so it sorts where the task started; the sweep (Task 7a) corrects its summary.
 */
export async function ensureTaskSession(
  table: TableInput,
  task: LazySessionTask,
  input: { ownerName: string; title: string },
): Promise<string | undefined> {
  try {
    if (task.sessionId !== undefined) return task.sessionId;
    // ERASE-NAME-2: a session made after the person was erased (or removed) does not store a fresh copy of the name they had (developer/name-resolver.ts).
    const ownerName = await resolveStoredName({ documentClient: table.documentClient, tableName: table.tableName, orgId: task.orgId }, task.developerId, input.ownerName, task.createdAt);
    const sessionInput = lazyTaskSessionInput(task, { ...input, ownerName });
    if (sessionInput === undefined || task.orgId === undefined) return undefined;
    const sessionId = sessionInput.sessionId;
    const key = { pk: `DEVTASK#${task.taskId}`, sk: "META" };
    const items: TransactItem[] = [
      ...createTaskSessionItems(table, sessionInput),
      // A thread maps to one shared task, so this binding cannot meet another session's; if it ever were refused, the whole creation would fail on every read until fixed.
      ...threadBindingItems(table, task.orgId, sessionId, task.share, task.createdAt),
      {
        Update: {
          TableName: table.tableName, Key: key, UpdateExpression: "SET sessionId = :sessionId",
          ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(sessionId) AND orgId = :orgId",
          ExpressionAttributeValues: { ":sessionId": sessionId, ":orgId": task.orgId },
        },
      },
    ];
    try {
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return sessionId;
    } catch {
      // Someone made it first (or the task changed): what the task says now is the answer.
      const stored = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: { sessionId?: unknown; orgId?: unknown } };
      return stored.Item?.orgId === task.orgId && typeof stored.Item.sessionId === "string" ? stored.Item.sessionId : undefined;
    }
  } catch {
    return undefined;
  }
}
