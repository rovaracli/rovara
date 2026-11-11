// Read one existing ceiling. This does not migrate guardrails or authorize a paid start.
import { createHash } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, OrgIdSchema, AgentGuardrailsSchema, agentGuardrailsKey } from "@rovara-code/contracts";
import { TaskStopCeilingReadSchema, DEFAULT_MAX_PER_RUN_CEILING_USD, orgMemberKey, developerOrgKey, orgMetaKey, type TaskStopCeilingRead } from "@agentx/cloud-contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { usdToWholeMicrodollars } from "./budget-amount.js";

type Dependencies = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now">;
type Key = { pk: string; sk: string };
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The company task-stop ceiling could not be checked. An installation administrator may need to check the settings.");
const forbidden = () => agentXError("FORBIDDEN", "Only a current company owner or admin can read this ceiling.");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const bound = (row: Record<string, unknown> | undefined, key: Key) => row?.pk === key.pk && row.sk === key.sk;
async function read(deps: Dependencies, Key: Key): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
    if (response.Item === undefined) return undefined;
    if (!isRecord(response.Item)) throw unavailable();
    return response.Item;
  } catch { throw unavailable(); }
}
async function authority(deps: Dependencies, caller: DeveloperCaller) {
  if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId)) throw forbidden();
  const memberKey = orgMemberKey(caller.orgId, caller.developerId), pointerKey = developerOrgKey(caller.developerId), metaKey = orgMetaKey(caller.orgId);
  const [member, pointer, org] = await Promise.all([read(deps, memberKey), read(deps, pointerKey), read(deps, metaKey)]);
  if (!bound(member, memberKey) || !bound(pointer, pointerKey) || !bound(org, metaKey)
    || member?.orgId !== caller.orgId || member.developerId !== caller.developerId
    || (member.role !== "owner" && member.role !== "admin")
    || pointer?.orgId !== caller.orgId || pointer.role !== member.role
    || org?.orgId !== caller.orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
}
export async function getTaskStopCeiling(deps: Dependencies, caller: DeveloperCaller): Promise<TaskStopCeilingRead> {
  try {
    await authority(deps, caller);
    const key = agentGuardrailsKey(caller.orgId), raw = await read(deps, key);
    let ceilingUsd: unknown = DEFAULT_MAX_PER_RUN_CEILING_USD;
    let revision = 0, source: "configured" | "rovara_default" = "rovara_default";
    if (raw !== undefined) {
      if (!bound(raw, key) || raw.entityType !== "AGENT_GUARDRAILS"
        || (Object.hasOwn(raw, "orgId") && raw.orgId !== caller.orgId)
        || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(raw, field))
        || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw unavailable();
      const guardrails = AgentGuardrailsSchema.safeParse(raw.guardrails);
      if (!guardrails.success) throw unavailable();
      ceilingUsd = guardrails.data.maxPerRunCeilingUsd;
      revision = raw.revision;source = "configured";
    }
    const ceilingMicrousd = usdToWholeMicrodollars(ceilingUsd);
    if (ceilingMicrousd === undefined) throw unavailable();
    // Public version fingerprint, not a token or permission. Read time is not policy version.
    const ceilingDigest = createHash("sha256").update(JSON.stringify([caller.orgId, source, revision, ceilingMicrousd])).digest("hex");
    const result = TaskStopCeilingReadSchema.parse({
      orgId: caller.orgId, checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
      ceilingMicrousd, revision, ceilingDigest, source, backing: "legacy_guardrails_alias",
      coverage: "company_ceiling_only", companyDefault: "not_loaded", projectOverride: "not_loaded",
      agentOverride: "not_loaded", locks: "not_loaded", calculation: "unavailable", enforcement: "not_connected",
    });
    await authority(deps, caller);
    return result;
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw unavailable();
  }
}
