// Read-only project money source; no initialization, lifecycle claims or paid-start permission.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, agentXError, AGENTX_NAME_PATTERN, orgProjectCatalogKey, projectAiKey, TaskStopProjectReadSchema, type TaskStopProjectRead } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { parseProjectAiWithRevision } from "../spend/settings.js";
import { getTaskStopCompany } from "./task-stop-company.js";
type Dependencies = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The project task-stop setting could not be checked. An installation administrator may need to check the settings.");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const positiveRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
export async function getTaskStopProject(deps: Dependencies, caller: DeveloperCaller, project: string): Promise<TaskStopProjectRead> {
  if (!z.string().regex(AGENTX_NAME_PATTERN).safeParse(project).success) throw agentXError("CONFIG_INVALID", "project: must be a valid project name");
  try {
    const before = await getTaskStopCompany(deps, caller);
    async function read(Key: { pk: string; sk: string }): Promise<unknown> {
      try {
        const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
        return response.Item;
      } catch { throw unavailable(); }
    }
    const catalogKey = orgProjectCatalogKey(caller.orgId, project);
    async function catalogRevision(): Promise<number> {
      const item = await read(catalogKey);
      if (!isRecord(item) || item.pk !== catalogKey.pk || item.sk !== catalogKey.sk || item.entityType !== "PROJECT_CATALOG"
        || item.name !== project || (Object.hasOwn(item, "orgId") && item.orgId !== caller.orgId) || !positiveRevision(item.latestRevision)) throw unavailable();
      return item.latestRevision;
    }
    const revision = await catalogRevision();
    const key = projectAiKey(caller.orgId, project), raw = await read(key);
    if (raw !== undefined && (!isRecord(raw) || raw.pk !== key.pk || raw.sk !== key.sk || raw.entityType !== "PROJECT_AI"
      || (Object.hasOwn(raw, "orgId") && raw.orgId !== caller.orgId) || (Object.hasOwn(raw, "project") && raw.project !== project)
      || !positiveRevision(raw.revision))) throw unavailable();
    // Metadata is bound above; use the exact same snapshot and parser as the legacy view/writer.
    const stored = parseProjectAiWithRevision(raw, project);
    const policy = stored.settings.taskStopPolicy;
    const projectOverride: TaskStopProjectRead["projectOverride"] = policy === undefined || policy.schemaVersion === 2 ? { kind: "inherit" } : { kind: "limited", stopMicrousd: policy.stopMicrousd };
    if (await catalogRevision() !== revision) throw unavailable();
    const after = await getTaskStopCompany(deps, caller);
    if (after.policyDigest !== before.policyDigest) throw unavailable();
    const sourceDigest = createHash("sha256").update(JSON.stringify([caller.orgId, project, revision, stored.revision, projectOverride])).digest("hex");
    return TaskStopProjectReadSchema.parse({
      orgId: caller.orgId, project, checkedAt: after.checkedAt, companyPolicyDigest: after.policyDigest,
      catalogRevision: revision, settingsRevision: stored.revision,
      sourceKind: raw === undefined ? "project_settings_absent" : "project_ai", sourceDigest, projectOverride,
      coverage: "project_override_only", agentOverride: "not_loaded", locks: "not_loaded", projectLifecycle: "not_loaded",
      calculation: "unavailable", enforcement: "not_connected",
    });
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw unavailable();
  }
}
