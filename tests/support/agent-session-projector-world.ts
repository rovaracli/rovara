// Plan 5 Task 7a: a small company with open task sessions whose source records (task, workspace, operations, counter) the tests move around.
import { randomUUID } from "node:crypto";
import { marshall } from "@aws-sdk/util-dynamodb";
import { agentSessionKey, liveSessionKey, openAgentSessionKey, taskSpendKey, type AgentSessionRecord } from "@rovara-code/contracts";
import { projectSessions } from "../../packages/broker/src/agent-sessions/projector.js";
import { refreshSessionSummary } from "../../packages/broker/src/agent-sessions/summary.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { ORG_A, PRIYA, T0, sessionWorld, type SessionWorld } from "./agent-session-world.js";

type Item = Record<string, unknown>;
/** Named so the world's inferred type can be written in a declaration (its caller and sign-in store come from the broker package). */
export type WorldTypes = { caller: DeveloperCaller; signInStore: DeveloperSignInStore };
export const DAY_MS = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const workflow = (stage: string, state: string, extra: Record<string, unknown> = {}) => ({ stage, state, revision: 3, path: "QUICK", artifacts: [], decisions: [], ...extra });



export function projectorWorld() {
  const w: SessionWorld = sessionWorld();
  const logs: Array<Record<string, unknown>> = [];
  const deps = { documentClient: w.db, tableName: "state", now: () => w.clock.now, log: (entry: Record<string, unknown>) => logs.push(entry) };
  const sessionOf = (sessionId: string) => w.db.get(agentSessionKey(ORG_A, sessionId, "META")) as unknown as AgentSessionRecord & Item;

  /** An open task session as the start writes it, with its workspace, pointer, live tile and sweep entry. */
  const open = (options: { owner?: string; task?: Item; orgId?: typeof ORG_A } = {}) => {
    const seeded = w.seedSession({ owner: options.owner ?? PRIYA, ...(options.orgId === undefined ? {} : { orgId: options.orgId }) });
    const workspaceId = randomUUID();
    const orgId = options.orgId ?? ORG_A;
    const meta = w.db.get(agentSessionKey(orgId, seeded.sessionId, "META"))!;
    w.db.set({ ...meta, legs: [{ seq: 1, subject: meta.subject, where: meta.where, startedAt: "2026-10-22T08:00:00.000Z" }] });
    w.db.set({ ...w.db.get(taskKey(seeded.taskId))!, workspaceId, ...(options.task ?? {}) });
    w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "READY" });
    w.db.set({ ...taskPointerKey(workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId: seeded.taskId, developerId: options.owner ?? PRIYA });
    w.db.set({ ...liveSessionKey(orgId, seeded.sessionId), entityType: "LIVE_SESSION", orgId, sessionId: seeded.sessionId, kind: "task", status: "starting", createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z" });
    w.db.set({ ...openAgentSessionKey(orgId, seeded.sessionId), entityType: "OPEN_AGENT_SESSION", orgId, sessionId: seeded.sessionId });
    return { ...seeded, workspaceId, orgId };
  };
  const patchTask = (taskId: string, fields: Item) => { const next = { ...w.db.get(taskKey(taskId))!, ...fields }; w.db.set(next); return next; };
  let opCounter = 0;
  const operation = (workspaceId: string, kind: string, status: string, offsetMs = 0, error?: string) => {
    opCounter += 1;
    const id = `op-${String(opCounter).padStart(4, "0")}`;
    const createdAt = iso(Date.parse("2026-10-22T08:00:00.000Z") + offsetMs);
    const item = { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${id}`, entityType: "OPERATION", id, workspaceId, kind, status, fence: opCounter, createdAt, updatedAt: createdAt, requestId: id, payloadHash: "h", ...(error === undefined ? {} : { error }) };
    w.db.set(item);
    return item;
  };
  const setOperation = (item: Item, status: string) => { const next = { ...w.db.get({ pk: item.pk as string, sk: item.sk as string })!, status }; w.db.set(next); return next; };
  const eventOf = (operationId: string, sequence: number, message: string) =>
    w.db.set({ pk: `OPERATION#${operationId}`, sk: `EVENT#${String(sequence).padStart(12, "0")}`, entityType: "EVENT", sequence, type: "progress", timestamp: iso(T0), payload: { message } });
  const spent = (taskId: string, usd: number, orgId = ORG_A) => w.db.set({ ...taskSpendKey(orgId, taskId), entityType: "TASK_SPENT", orgId, settledUsd: usd });
  const stream = (item: Item, previous?: Item, eventName = "MODIFY") => ({
    eventName, eventID: randomUUID(), dynamodb: { NewImage: marshall(item, { removeUndefinedValues: true }), ...(previous === undefined ? {} : { OldImage: marshall(previous, { removeUndefinedValues: true }) }) },
  });
  const project = (items: Item[], deadline = Date.now() + 60_000, extra: Record<string, unknown> = {}) => projectSessions(items.map((item) => stream(item)), { ...deps, ...extra }, { deadline });
  const refresh = (sessionId: string, orgId = ORG_A, extra: Record<string, unknown> = {}) => refreshSessionSummary({ ...deps, ...extra }, orgId, sessionId);
  const tile = (sessionId: string, orgId = ORG_A) => w.db.get(liveSessionKey(orgId, sessionId)) as Item | undefined;
  const events = (sessionId: string) => w.db.find((item) => item.pk === agentSessionKey(ORG_A, sessionId, "META").pk && String(item.sk).startsWith("EVENT#"));
  return { w, deps, logs, sessionOf, open, patchTask, operation, setOperation, eventOf, spent, stream, project, refresh, tile, events };
}

export type PW = ReturnType<typeof projectorWorld>;
