// The projector (Plan 5 Task 7a): maps the State table's stream records to the sessions they touch and refreshes each one's summary. It reads only an
// allowlist of source keys (a task, its run, an operation, an approval or spend request, the per-task counter, Plan 4's chain run), so it never reacts to
// Plan 5's own writes (`AGENT_SESSION#`, `LIVE_SESSIONS`, `CHANGES#`, `OPEN_AGENT_SESSIONS`, `ENDED_AGENT_SESSIONS#`, `DEVICE#`, ...). It de-duplicates the
// sessions of a batch, refreshes at most `PROJECTOR_SESSIONS_PER_BATCH_MAX` of them, `PROJECTOR_CONCURRENCY` at a time, and starts none after the deadline;
// the rest are counted as skipped and left to the sweep. It writes nothing but what a refresh writes.
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { PROJECTOR_CONCURRENCY, PROJECTOR_SESSIONS_PER_BATCH_MAX, type OrgId, type SessionId } from "@rovara-code/contracts";
import type { StreamRecord } from "../developer/notifications.js";
import { settleSteerDeliveriesFor } from "./steer.js";
import { refreshSessionSummary, type SummaryDependencies } from "./summary.js";

type Item = Record<string, unknown>;

export interface ProjectorDependencies extends SummaryDependencies {
  /** What refreshes one session; `refreshSessionSummary` unless a test stands in. */
  refresh?: ((deps: SummaryDependencies, orgId: OrgId, sessionId: SessionId) => Promise<"unchanged" | "updated">) | undefined;
}

export interface ProjectResult {
  refreshed: number;
  unchanged: number;
  /** Sessions this batch named and did not refresh (over the cap, or past the deadline): the sweep brings them up to date. */
  skipped: number;
  failed: number;
}

const ORG_KEY = /^ORG#(org_[0-9a-z]{20})#(.+)$/;
const TASK_PK = /^DEVTASK#([0-9a-f-]{36})$/;
const WORKSPACE_PK = /^WORKSPACE#(.+)$/;

/** What a record points at before it is resolved to a session. */
type Target =
  | { kind: "session"; orgId: string; sessionId: string }
  | { kind: "task"; taskId: string; keyOrg?: string }
  | { kind: "workspace"; workspaceId: string };

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

function targetOf(deps: ProjectorDependencies, record: Item): { target?: Target; mismatch?: boolean } {
  const pk = text(record["pk"]);
  const sk = text(record["sk"]);
  if (pk === undefined || sk === undefined) return {};
  const scoped = ORG_KEY.exec(pk);
  if (scoped !== null) {
    const org = scoped[1]!;
    const rest = scoped[2]!;
    const named = (): { target?: Target; mismatch?: boolean } | undefined => (record["orgId"] === org ? undefined : { mismatch: true });
    if (rest.startsWith("TASK_SPENT#") && sk === "META") {
      return named() ?? { target: { kind: "task", taskId: rest.slice("TASK_SPENT#".length), keyOrg: org } };
    }
    if (rest.startsWith("APPROVAL#") && sk === "META") {
      const bad = named();
      if (bad !== undefined) return bad;
      const subject = record["subject"] as { kind?: unknown; taskId?: unknown; chainRunId?: unknown } | undefined;
      if (typeof subject?.taskId === "string") return { target: { kind: "task", taskId: subject.taskId, keyOrg: org } };
      if (typeof subject?.chainRunId === "string") return { target: { kind: "session", orgId: org, sessionId: subject.chainRunId } };
      return {};
    }
    if (rest.startsWith("SPEND_REQUEST#") && sk === "META") {
      const bad = named();
      if (bad !== undefined) return bad;
      const taskId = text(record["taskId"]);
      return taskId === undefined ? {} : { target: { kind: "task", taskId, keyOrg: org } };
    }
  }
  const task = TASK_PK.exec(pk);
  if (task !== null) {
    if (sk === "AGENT_RUN") return { target: { kind: "task", taskId: task[1]! } };
    if (sk === "META") {
      const chain = record["chain"] as { chainRunId?: unknown } | undefined;
      const sessionId = text(record["sessionId"]) ?? (typeof chain?.chainRunId === "string" ? chain.chainRunId : undefined);
      const orgId = text(record["orgId"]);
      return sessionId === undefined || orgId === undefined ? {} : { target: { kind: "session", orgId, sessionId } };
    }
    return {};
  }
  const workspace = WORKSPACE_PK.exec(pk);
  if (workspace !== null && sk.startsWith("OPERATION#")) return { target: { kind: "workspace", workspaceId: workspace[1]! } };
  const chain = deps.chains?.targetOf?.(record);
  return chain === undefined ? {} : { target: { kind: "session", orgId: chain.orgId, sessionId: chain.sessionId } };
}

async function get(deps: ProjectorDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** Refreshes the sessions the batch touched, within the deadline (epoch milliseconds). Never throws for one session's failure. */
export async function projectSessions(records: readonly StreamRecord[], deps: ProjectorDependencies, options: { deadline: number }): Promise<ProjectResult> {
  const result: ProjectResult = { refreshed: 0, unchanged: 0, skipped: 0, failed: 0 };
  const warn = (entry: Record<string, unknown>) => (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
  const sessions = new Map<string, { orgId: string; sessionId: string }>();
  const tasks = new Map<string, Item | undefined>();
  const pointers = new Map<string, string | undefined>();
  const add = (orgId: string, sessionId: string) => { sessions.set(`${orgId}#${sessionId}`, { orgId, sessionId }); };
  // The tasks of a chain's steps that changed in this batch, by the chain's session: a message to the chain's step is told as taken from the step's own task, which a refresh of the chain doesn't read.
  const stepTasks = new Map<string, Set<string>>();

  const resolveTask = async (taskId: string, keyOrg: string | undefined) => {
    if (!tasks.has(taskId)) tasks.set(taskId, await get(deps, { pk: `DEVTASK#${taskId}`, sk: "META" }));
    const task = tasks.get(taskId);
    const orgId = text(task?.["orgId"]);
    if (orgId === undefined) return;
    if (keyOrg !== undefined && keyOrg !== orgId) { warn({ event: "agent_session.projector_org_mismatch", taskId }); return; }
    const chain = task?.["chain"] as { chainRunId?: unknown } | undefined;
    const sessionId = text(task?.["sessionId"]) ?? (typeof chain?.chainRunId === "string" ? chain.chainRunId : undefined);
    if (sessionId !== undefined) add(orgId, sessionId);
  };

  for (const entry of records) {
    if (entry.eventName !== "INSERT" && entry.eventName !== "MODIFY") continue;
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    let record: Item;
    try { record = unmarshall(image) as Item; } catch { continue; }
    const { target, mismatch } = targetOf(deps, record);
    if (mismatch === true) { warn({ event: "agent_session.projector_org_mismatch", key: text(record["pk"])?.slice(0, 80) }); continue; }
    if (target === undefined) continue;
    try {
      if (target.kind === "session") {
        add(target.orgId, target.sessionId);
        // A chain step's own task record (it names the chain run, and has no session of its own).
        const stepTask = TASK_PK.exec(text(record["pk"]) ?? "")?.[1];
        if (stepTask !== undefined && text(record["sessionId"]) === undefined) stepTasks.set(`${target.orgId}#${target.sessionId}`, (stepTasks.get(`${target.orgId}#${target.sessionId}`) ?? new Set()).add(stepTask));
      }
      else if (target.kind === "task") await resolveTask(target.taskId, target.keyOrg);
      else {
        if (!pointers.has(target.workspaceId)) pointers.set(target.workspaceId, text((await get(deps, { pk: `WORKSPACE#${target.workspaceId}`, sk: "DEVELOPER_TASK" }))?.["taskId"]));
        const taskId = pointers.get(target.workspaceId);
        if (taskId !== undefined) await resolveTask(taskId, undefined);
      }
    } catch (error) {
      warn({ event: "agent_session.projector_resolve_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const all = [...sessions.values()];
  const batch = all.slice(0, PROJECTOR_SESSIONS_PER_BATCH_MAX);
  result.skipped += all.length - batch.length;
  const refresh = deps.refresh ?? refreshSessionSummary;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      if (index >= batch.length) return;
      // The deadline is checked before each refresh starts; one that has started is allowed to finish.
      if (deps.now() >= options.deadline) return;
      next += 1;
      const { orgId, sessionId } = batch[index]!;
      try {
        const outcome = await refresh({ ...deps, deadline: options.deadline }, orgId, sessionId);
        if (outcome === "updated") result.refreshed += 1;
        else result.unchanged += 1;
      } catch (error) {
        result.failed += 1;
        warn({ event: "agent_session.projector_refresh_failed", sessionId, error: error instanceof Error ? error.name : "unknown" });
      }
      // Never throws; a mark it can't make is made by the next change to the task.
      for (const taskId of stepTasks.get(`${orgId}#${sessionId}`) ?? []) await settleSteerDeliveriesFor(deps, orgId, sessionId, taskId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROJECTOR_CONCURRENCY, batch.length) }, worker));
  result.skipped += batch.length - next;
  return result;
}
