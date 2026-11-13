// Owner decision 143(c), the other half of the off-sweep: the TASKS a trigger started on its own (an agent trigger's run, not a chain's step; a chain's runs are stopped by
// `lifecycle.ts` `lookAt`). With automations off the engine starts nothing (`AUTOMATIONS_OFF_MESSAGE`); this stops what already started, at a safe point
// (`automationStopSafe`): the open sessions whose starter is an event or a schedule are read, and each one's task is asked to stop through the same cancel path a chain step's
// task is (`ChainRunPorts.cancelTask`, as the session's owner). A task at a moment that would leave work half done (a pull request being opened) is left to the next sweep.
// Nothing is merged by a stop: a merge is a person's act. While automations are on it reads nothing at all.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, SessionIdSchema, agentSessionKey } from "@rovara-code/contracts";
import { sessionFromItem } from "../agent-sessions/store.js";
import { createHash } from "node:crypto";
import { taskKey } from "../developer/task-records.js";
import { automationStopSafe } from "./automations-gate.js";
import { getItem, type Deps } from "./runner.js";

export interface TriggerStopReport {
  /** Open sessions looked at. */
  examined: number;
  /** Tasks asked to stop. */
  stopped: number;
  /** Tasks left for the next sweep because they are not at a safe point. */
  deferred: number;
  failed: number;
}

/** At most this many open sessions are looked at in one sweep (the rest, the next one). */
export const TRIGGER_STOP_SESSIONS_MAX = 200;

/** A stable request id for the stop of one task: a repeat of the sweep asks the same cancel, which the task layer answers as the first. */
export const stopRequestIdOf = (taskId: string): string => {
  const hex = createHash("sha256").update(`automations-off\0${taskId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export async function stopTriggerTasksWhenOff(deps: Deps): Promise<TriggerStopReport> {
  const report: TriggerStopReport = { examined: 0, stopped: 0, deferred: 0, failed: 0 };
  if (deps.automations?.enabled() !== false) return report;
  const page = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": "OPEN_AGENT_SESSIONS" }, ConsistentRead: true, Limit: TRIGGER_STOP_SESSIONS_MAX,
  })) as { Items?: Array<Record<string, unknown>> };
  for (const item of page.Items ?? []) {
    const [org, session] = String(item["sk"]).split("#");
    const orgId = OrgIdSchema.safeParse(org);
    const sessionId = SessionIdSchema.safeParse(session);
    if (!orgId.success || !sessionId.success) continue;
    report.examined += 1;
    try {
      const raw = await getItem(deps, agentSessionKey(orgId.data, sessionId.data, "META"));
      const record = raw === undefined ? undefined : sessionFromItem(raw);
      if (record === undefined || record.endedAt !== undefined) continue;
      const { startedBy, subject } = record;
      if ((startedBy.kind !== "event" && startedBy.kind !== "schedule") || subject.kind !== "task") continue;
      const task = await getItem(deps, taskKey(subject.taskId));
      if (!automationStopSafe(task?.workflow as { stage?: unknown; state?: unknown } | undefined)) { report.deferred += 1; continue; }
      await deps.chainRuns.cancelTask({ orgId: orgId.data, taskId: subject.taskId, owner: { developerId: record.owner.developerId }, requestId: stopRequestIdOf(subject.taskId) });
      report.stopped += 1;
    } catch {
      report.failed += 1;
    }
  }
  return report;
}
