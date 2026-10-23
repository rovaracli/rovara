// A task session is created with the run it wraps (Plan 5 Task 2): `createTaskSessionItems` returns the items that join the run's own start
// transaction, so the task and its session exist together or not at all.
import { createHash } from "node:crypto";
import {
  AgentSessionRecordSchema,
  SESSION_TITLE_MAX,
  agentSessionKey,
  cleanDisplayName,
  liveSessionKey,
  mySessionsKey,
  openAgentSessionKey,
  projectSessionsKey,
  redactText,
  sessionEventId,
  sessionLegSk,
  type AgentSessionRecord,
  type OrgId,
  type Payer,
  type SessionEvent,
  type SessionLeg,
  type WorkOrigin,
} from "@agentx/contracts";
import { putNew, type TableInput, type TransactItem } from "../agents/table-writes.js";
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

export interface TaskSessionInput {
  orgId: OrgId;
  sessionId: string;
  taskId: string;
  project: string;
  agent: { agentId: string; name: string; version: number | "draft" };
  title: string;
  owner: { developerId: string; name: string };
  startedBy: AgentSessionRecord["startedBy"];
  origin: WorkOrigin;
  payer: Payer;
  /** The start's time (an instant): the session, its leg, its event and its index entries are all stamped with it. */
  now: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** What the started event says: who or what began the work. */
function startedText(input: TaskSessionInput, owner: string, agent: string, title: string): string {
  const by = input.startedBy.kind === "event" ? "An event" : input.startedBy.kind === "schedule" ? "A schedule" : owner;
  return `${by} started ${agent}: ${title}`;
}

/**
 * The items of a new task session: the `META` header (status "starting", revision 1), its first leg, the `started` event, the entries that
 * list it for its owner (and for a different member who started it), its project, the live wall and the sweep. Each is written only if absent.
 * The task's own record carries the `sessionId` (the caller writes that).
 */
export function createTaskSessionItems(table: TableInput, input: TaskSessionInput): TransactItem[] {
  const owner = cleanDisplayName(input.owner.name) ?? "Someone";
  const agentName = cleanDisplayName(input.agent.name) ?? input.agent.agentId;
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
  const { orgId, sessionId } = record;
  const startedByOwner = input.startedBy.kind === "member" && input.startedBy.developerId === input.owner.developerId;
  const event: SessionEvent = {
    eventId: sessionEventId("started", sessionId), at: input.now, type: "started",
    actor: startedByOwner ? { kind: "member", developerId: input.owner.developerId, name: owner } : { kind: "system" },
    text: startedText(input, owner, agentName, title),
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

