// Live steer test world: a task session (owner Priya, "can use" for Arjun) whose workspace is BUSY on a RUNNING Implement operation of an ec2 worker, with the broker's signing key.
import { randomUUID } from "node:crypto";
import { agentSessionKey, type AgentSessionRecord } from "../../packages/contracts/src/index.js";
import { sendSessionMessage, type SessionMessageDependencies } from "../../packages/broker/src/agent-sessions/messages.js";
import { taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { ARJUN, ORG_A, sessionWorld } from "./agent-session-world.js";

export type Item = Record<string, unknown>;
export const KEY = "k".repeat(48);
export const TEXT = "also add a retry to the v2 endpoint, token LIVE-TEXT-4471";

export function liveSteerWorld(options: { key?: string | undefined; workspace?: Partial<Item> | null; operation?: Partial<Item> | null; pointer?: string | null } = {}) {
  const w = sessionWorld();
  const logs: Array<Record<string, unknown>> = [];
  const made = w.seedSession({ kind: "task" });
  const metaKey = agentSessionKey(ORG_A, made.sessionId, "META");
  w.db.set({ ...w.db.get(taskKey(made.taskId))!, workflow: { revision: 3, stage: "IMPLEMENT", state: "RUNNING" } });
  w.seedShare(ORG_A, made.sessionId, { kind: "member", developerId: ARJUN }, "use");
  const workspaceId = String(w.db.get(taskKey(made.taskId))!["workspaceId"]);
  const operationId = randomUUID();
  if (options.workspace !== null) w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", id: workspaceId, orgId: ORG_A, deploymentMode: "ec2-ebs", status: "BUSY", activeOperationId: operationId, fence: 4, projectRevision: 2, ...options.workspace });
  if (options.pointer !== null) w.db.set({ ...taskPointerKey(workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId: options.pointer ?? made.taskId });
  if (options.operation !== null) w.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId, kind: "task", status: "RUNNING", fence: 4, workflowMode: "IMPLEMENT", ...options.operation });
  const deps: SessionMessageDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, log: (entry) => logs.push(entry),
    ...(options.key === undefined && "key" in options ? {} : { liveSteer: { callbackSigningKey: options.key ?? KEY } }),
  };
  const send = (who: string, text = TEXT, requestId: string = randomUUID()) => sendSessionMessage(deps, w.caller(who), made.sessionId, { requestId, kind: "steer", text });
  const outbox = () => w.db.find((item) => String(item.pk).startsWith("OUTBOX#")) as Item[];
  const notes = () => w.db.find((item) => item.pk === `DEVTASK#${made.taskId}` && String(item.sk).startsWith("NOTE#"));
  const everything = () => w.db.find(() => true) as Item[];
  const session = () => w.db.get(metaKey) as unknown as AgentSessionRecord;
  return { w, deps, logs, made, workspaceId, operationId, send, outbox, notes, everything, session, metaKey };
}

