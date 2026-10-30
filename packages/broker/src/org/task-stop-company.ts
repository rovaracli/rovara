// Read-only company default foundation; other scopes and enforcement remain unconnected.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, orgSettingsKey, TaskStopCompanyPolicySchema, TaskStopCompanyReadSchema, type TaskStopCompanyRead } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { getTaskStopCeiling } from "./task-stop-ceiling.js";
type Dependencies = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Company task-stop settings could not be checked. An installation administrator may need to check the settings.");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export async function getTaskStopCompany(deps: Dependencies, caller: DeveloperCaller): Promise<TaskStopCompanyRead> {
  try {
    const before = await getTaskStopCeiling(deps, caller);
    const Key = orgSettingsKey(caller.orgId, "TASK_STOP_POLICY");
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
    const raw = response.Item;
    // No configured company default exists until an explicitly reviewed writer creates it.
    if (!isRecord(raw) || raw.pk !== Key.pk || raw.sk !== Key.sk || raw.orgId !== caller.orgId
      || raw.entityType !== "ORG_TASK_STOP_POLICY" || typeof raw.revision !== "number"
      || !Number.isSafeInteger(raw.revision) || raw.revision < 1
      || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(raw, field))) throw unavailable();
    const policy = TaskStopCompanyPolicySchema.safeParse(raw.policy);
    if (!policy.success) throw unavailable();
    // Recheck live authority and the same single ceiling after the default read. This is
    // bounded drift detection, not an atomic policy lease; start must revalidate its inputs.
    const after = await getTaskStopCeiling(deps, caller);
    if (after.ceilingDigest !== before.ceilingDigest) throw unavailable();
    const policyDigest = createHash("sha256").update(JSON.stringify([caller.orgId, raw.revision, policy.data.defaultStopMicrousd, after.ceilingDigest])).digest("hex");
    return TaskStopCompanyReadSchema.parse({
      orgId: caller.orgId, checkedAt: after.checkedAt,
      defaultStopMicrousd: policy.data.defaultStopMicrousd, revision: raw.revision, defaultSource: "configured",
      ceilingMicrousd: after.ceilingMicrousd, ceilingRevision: after.revision, ceilingSource: after.source,
      policyDigest, coverage: "company_default_and_ceiling", projectOverride: "not_loaded", agentOverride: "not_loaded",
      locks: "not_loaded", calculation: "unavailable", enforcement: "not_connected",
    });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw unavailable();
  }
}

export { captureTaskStopAdmission, previewTaskStopCutover, type TaskStopCaptureDependencies, type TaskStopCaptureRequest, type CapturedTaskStop } from "./task-stop-admission.js";
