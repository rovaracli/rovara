// TE-A5: the existing MACHINE_TIME_ONCE receipt is also the workspace's machine meter record. The stop recorder adds
// launch/generation metadata in the SAME transaction as the org counter. No second writer, migration or new once-key.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, workspaceSessionKey } from "@rovara-code/contracts";
import { MACHINE_PRICES, machineHourlyUsd, machineTimePk, openComputeKey } from "@agentx/cloud-contracts";
import { z } from "zod";
import { resolveTaskAccess } from "../developer/task-access.js";

type Dependencies = Parameters<typeof resolveTaskAccess>[0];
type Caller = Parameters<typeof resolveTaskAccess>[1];
type Item = Record<string, unknown>;
export interface MachineTypeMeter { seconds: number; minutes: number; usd: number | null }
export interface TaskMachineMeter {
  minutes: number;
  /** Reference-rate compute dollars for RECORDED time; null if any type or the supplied region is unpriced. */
  usd: number | null;
  byInstanceType: Record<string, MachineTypeMeter>;
  complete: boolean;
  scope: "workspace";
  label: "Per workspace" | "Per workspace, so far";
  pricing: { asOf: string; region: string; source: string; sourceNote: string };
}

const receiptSchema = z.object({
  entityType: z.literal("MACHINE_TIME_ONCE"),
  instanceType: z.string().min(1).max(128),
  seconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  stoppedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Machine time could not be read.");
const notFound = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");
async function get(deps: Dependencies, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/**
 * Owner-only broker reader; no public route. Call with the worker deployment's known region (unknown means unpriced).
 * A task stores workspaceId; SESSION belongs to that workspace, can restart, and is not the task's AGENT_SESSION.
 * Several tasks may share a workspace. These are its whole recorded runs, never apportioned or summed across tasks.
 * Open time is not estimated. Completeness requires one annotated receipt for EVERY generation and a stable stopped
 * session with the same last launch. Old receipts still contribute seconds, but missing coverage (including failed or
 * zero-length starts without receipts) says "so far". At most 1,000 receipts are read; truncated totals say so far too.
 */
export async function readTaskMachineMeter(deps: Dependencies, caller: Caller, taskId: string, region: string): Promise<TaskMachineMeter> {
  try {
    const access = await resolveTaskAccess(deps, caller, taskId, "read");
    if (access.role !== "owner") throw notFound();
    const workspaceId = access.task.workspaceId;
    if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw notFound();
    const workspace = await get(deps, { pk: `WORKSPACE#${workspaceId}`, sk: "META" });
    if (workspace?.orgId !== caller.orgId) throw notFound();
    const before = await get(deps, workspaceSessionKey(workspaceId));
    const pk = machineTimePk(caller.orgId), prefix = `ONCE#${workspaceId}#`;
    const byInstanceType: Record<string, MachineTypeMeter> = Object.create(null) as Record<string, MachineTypeMeter>;
    const generations = new Set<number>();
    let count = 0, lastGeneration = 0, lastStart: number | undefined;
    let seconds = 0, pricedSeconds = 0, priced = true;
    let next: Record<string, unknown> | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await deps.documentClient.send(new QueryCommand({
        TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, Limit: 100,
        ...(next === undefined ? {} : { ExclusiveStartKey: next }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        const receipt = receiptSchema.parse(item);
        if (item.pk !== pk || typeof item.sk !== "string" || !item.sk.startsWith(prefix) || !/^\d+$/.test(item.sk.slice(prefix.length))) throw unavailable();
        const stoppedAt = Number(item.sk.slice(prefix.length));
        if (!Number.isSafeInteger(stoppedAt)) throw unavailable();
        if (receipt.startedAt !== undefined && (receipt.stoppedAt !== stoppedAt || receipt.startedAt > stoppedAt
          || Math.round((stoppedAt - receipt.startedAt) / 1000) !== receipt.seconds)) throw unavailable();
        seconds += receipt.seconds;
        if (!Number.isSafeInteger(seconds)) throw unavailable();
        const rate = machineHourlyUsd(receipt.instanceType, region);
        const entry = byInstanceType[receipt.instanceType] ?? { seconds: 0, minutes: 0, usd: rate === undefined ? null : 0 };
        entry.seconds += receipt.seconds;
        entry.minutes = entry.seconds / 60;
        entry.usd = rate === undefined ? null : Number((entry.seconds * rate / 3600).toFixed(12));
        byInstanceType[receipt.instanceType] = entry;
        if (rate === undefined) priced = false;
        else pricedSeconds += receipt.seconds * rate;
        count += 1;
        if (receipt.generation !== undefined && receipt.startedAt !== undefined) {
          generations.add(receipt.generation);
          if (receipt.generation > lastGeneration) { lastGeneration = receipt.generation; lastStart = receipt.startedAt; }
        }
      }
      next = page.LastEvaluatedKey;
      if (next === undefined) break;
    }
    const open = await get(deps, openComputeKey(caller.orgId, workspaceId));
    const after = await get(deps, workspaceSessionKey(workspaceId));
    const stable = ["state", "generation", "launchedAt", "instanceId"].every(field => before?.[field] === after?.[field]);
    const complete = stable && next === undefined && open === undefined && after?.instanceId === undefined
      && ["STOPPED", "FAILED", "DELETED"].includes(String(after?.state))
      && generations.size === count && count === after?.generation && lastGeneration === count
      && typeof after.launchedAt === "string" && Date.parse(after.launchedAt) === lastStart;
    return {
      minutes: seconds / 60, usd: priced ? Number((pricedSeconds / 3600).toFixed(12)) : null, byInstanceType, complete,
      scope: "workspace", label: complete ? "Per workspace" : "Per workspace, so far",
      pricing: { asOf: MACHINE_PRICES.asOf, region, source: MACHINE_PRICES.source, sourceNote: MACHINE_PRICES.sourceNote },
    };
  } catch (error) {
    if (error instanceof AgentXError && error.code === "TASK_NOT_FOUND") throw error;
    throw unavailable();
  }
}
