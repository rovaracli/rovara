// Existing agent money settings only; no recipe reads, initialization, writes or paid starts.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, agentXError, AgentIdSchema, agentKey, builtinSettingsKey, isBuiltinAgentId } from "@rovara-code/contracts";
import { TaskStopAgentReadSchema, type TaskStopAgentRead } from "@agentx/cloud-contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { getTaskStopCompany } from "./task-stop-company.js";
import { usdToWholeMicrodollars } from "./budget-amount.js";
type Dependencies = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The agent task-stop setting could not be checked. An installation administrator may need to check the settings.");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export async function getTaskStopAgent(deps: Dependencies, caller: DeveloperCaller, id: string): Promise<TaskStopAgentRead> {
  const parsed = AgentIdSchema.safeParse(id);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "agentId: must name a known agent kind or a valid custom agent ID");
  try {
    const agentId = parsed.data, builtin = isBuiltinAgentId(agentId);
    const before = await getTaskStopCompany(deps, caller);
    const Key = builtin ? builtinSettingsKey(caller.orgId, agentId) : agentKey(caller.orgId, agentId, "META");
    let item: unknown;
    try {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
      item = response.Item;
    } catch { throw unavailable(); }
    let sourceKind: TaskStopAgentRead["sourceKind"];
    let agentOverride: TaskStopAgentRead["agentOverride"] = { kind: "inherit" };
    if (item === undefined) {
      if (!builtin) throw unavailable();
      sourceKind = "builtin_absent";
    } else {
      if (!isRecord(item) || item.pk !== Key.pk || item.sk !== Key.sk
        || !z.string().datetime().safeParse(item.updatedAt).success) throw unavailable();
      if (builtin) {
        if (item.entityType !== "BUILTIN_AGENT_SETTINGS" || !Number.isSafeInteger(item.pinnedVersion) || Number(item.pinnedVersion) < 1
          || (Object.hasOwn(item, "orgId") && item.orgId !== caller.orgId)
          || (Object.hasOwn(item, "agentId") && item.agentId !== agentId)) throw unavailable();
        sourceKind = "builtin_settings";
      } else {
        if (item.entityType !== "AGENT" || item.orgId !== caller.orgId || item.agentId !== agentId
          || (item.status !== "active" && item.status !== "archived")) throw unavailable();
        sourceKind = "custom_agent";
      }
      if (Object.hasOwn(item, "maxPerRunUsd")) {
        const stopMicrousd = usdToWholeMicrodollars(item.maxPerRunUsd);
        if (stopMicrousd === undefined) throw unavailable();
        agentOverride = { kind: "limited", stopMicrousd };
      }
    }
    const after = await getTaskStopCompany(deps, caller);
    if (after.policyDigest !== before.policyDigest) throw unavailable();
    const raw = isRecord(item) ? item : undefined;
    // No invented revision: these legacy rows have timestamps/field fences, not a money revision.
    const sourceDigest = createHash("sha256").update(JSON.stringify([caller.orgId, agentId, sourceKind, agentOverride, raw?.updatedAt ?? null, raw?.pinnedVersion ?? null, raw?.status ?? null])).digest("hex");
    return TaskStopAgentReadSchema.parse({
      orgId: caller.orgId, agentId, checkedAt: after.checkedAt, companyPolicyDigest: after.policyDigest,
      sourceKind, sourceDigest, agentOverride, coverage: "agent_override_only", projectOverride: "not_loaded",
      locks: "not_loaded", calculation: "unavailable", enforcement: "not_connected",
    });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw unavailable();
  }
}
