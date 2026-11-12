// Design review stage: which event started a task, as far as the broker recorded it. A task keeps no trigger of its own, so the event's source is read where it was written: the chain run's `startedBy` for a chain
// step's task, else the task's session (`startedBy.triggerId`) and that trigger's own spec. Anything that cannot be read is no source (the origin rule then fails closed).
import { ChainRunStartedBySchema, SessionStartedBySchema, agentSessionKey, chainRunKey, type OrgId } from "@rovara-code/contracts";
import { getItem } from "../aws/cancellation.js";
import type { AwsBrokerDependencies } from "../aws/broker/definitions.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { TriggerStore } from "../triggers/store.js";

/** The source (`github`, `sentry`, ...) of the event that started the task, or undefined for a task no event started and for any read or parse that fails. Never throws. */
export async function eventSourceOfTask(dependencies: AwsBrokerDependencies, task: Pick<DeveloperTaskRecord, "origin" | "chain" | "sessionId">, orgId: OrgId): Promise<string | undefined> {
  if (task.origin !== "event") return undefined;
  try {
    if (task.chain !== undefined) {
      const run = await getItem<{ orgId?: unknown; startedBy?: unknown }>(dependencies, chainRunKey(orgId, task.chain.chainRunId, "META"));
      const started = run?.orgId === orgId ? ChainRunStartedBySchema.safeParse(run.startedBy) : undefined;
      return started?.success === true && started.data.kind === "event" ? started.data.source : undefined;
    }
    if (task.sessionId === undefined) return undefined;
    const session = await getItem<{ orgId?: unknown; startedBy?: unknown }>(dependencies, agentSessionKey(orgId, task.sessionId, "META"));
    const started = session?.orgId === orgId ? SessionStartedBySchema.safeParse(session.startedBy) : undefined;
    if (started?.success !== true || started.data.kind !== "event") return undefined;
    const triggers = dependencies.agents?.triggers ?? new TriggerStore({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now });
    const trigger = await triggers.get(orgId, started.data.triggerId);
    return trigger?.spec.kind === "event" ? trigger.spec.source : undefined;
  } catch {
    return undefined;
  }
}
