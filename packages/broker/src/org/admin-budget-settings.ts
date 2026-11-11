import { usdToWholeMicrodollars } from "./budget-amount.js";
// Strict read projection. Do not call legacy ensureSynced/readBudgets here: a GET must
// neither mutate the proxy nor turn corrupt persisted values into plausible defaults.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, agentXError, OrgIdSchema } from "@rovara-code/contracts";
import { AdminBudgetSettingsSchema, DEFAULT_ORG_MONTHLY_BUDGET_USD, DEFAULT_MEMBER_MONTHLY_BUDGET_USD, orgSettingsKey, orgMemberKey, developerOrgKey, orgMetaKey, type AdminBudgetSettings } from "@agentx/cloud-contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
type Dependencies = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "cloud" | "now">;
type Key = { pk: string; sk: string };
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Monthly base budget settings could not be checked. Try again.");
const forbidden = () => agentXError("FORBIDDEN", "Only a current company owner or admin can view these budget settings.");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const bound = (row: Record<string, unknown> | undefined, key: Key) => row?.pk === key.pk && row.sk === key.sk;
async function read(deps: Dependencies, Key: Key): Promise<Record<string, unknown> | undefined> {
 try {
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: unknown };
  if (result.Item === undefined) return undefined;
  if (!isRecord(result.Item)) throw unavailable();
  return result.Item;
 } catch { throw unavailable(); }
}
async function authority(deps: Dependencies, caller: DeveloperCaller) {
 if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId)) throw forbidden();
 const memberKey = orgMemberKey(caller.orgId, caller.developerId), pointerKey = developerOrgKey(caller.developerId), metaKey = orgMetaKey(caller.orgId);
 const [member, pointer, org] = await Promise.all([read(deps, memberKey), read(deps, pointerKey), read(deps, metaKey)]);
 if (!bound(member, memberKey) || !bound(pointer, pointerKey) || !bound(org, metaKey) || member?.orgId !== caller.orgId || member.developerId !== caller.developerId || (member.role !== "owner" && member.role !== "admin") || pointer?.orgId !== caller.orgId || pointer.role !== member.role || org?.orgId !== caller.orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
}
/** Exact decimal USD boundary, not binary multiplication/rounding or clamping. */
function microdollars(value: unknown): number {
 const result = usdToWholeMicrodollars(value);if (result === undefined) throw unavailable();return result;
}
function monthly(raw: Record<string, unknown> | undefined, field: string, cloud: boolean | undefined, defaultUsd: number): AdminBudgetSettings["orgMonthly"] {
 // Presence matters: null/undefined in an existing field is corrupt, not absence.
 if (raw !== undefined && Object.hasOwn(raw, field)) return { kind: "limited", microdollars: microdollars(raw[field]), source: "configured" };
 return cloud === true ? { kind: "limited", microdollars: microdollars(defaultUsd), source: "cloud_default" } : { kind: "unlimited", source: "unset" };
}
export async function getAdminBudgetSettings(deps: Dependencies, caller: DeveloperCaller): Promise<AdminBudgetSettings> {
 try {
  await authority(deps, caller);
  const key = orgSettingsKey(caller.orgId, "BUDGET"), raw = await read(deps, key);
  let count = 0;
  if (raw !== undefined) {
   if (!bound(raw, key) || raw.entityType !== "ORG_BUDGET" || (Object.hasOwn(raw, "orgId") && raw.orgId !== caller.orgId) || !isRecord(raw.memberOverrides)) throw unavailable();
   const overrides = Object.entries(raw.memberOverrides);if (overrides.length > 500) throw unavailable();
   for (const [developerId, amount] of overrides) { if (!/^[a-f0-9]{64}$/.test(developerId)) throw unavailable();microdollars(amount); }
   count = overrides.length;
  }
  const result = AdminBudgetSettingsSchema.parse({ orgId: caller.orgId, checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString(), coverage: "monthly_base_settings_only", orgMonthly: monthly(raw, "orgMonthlyUsd", deps.cloud, DEFAULT_ORG_MONTHLY_BUDGET_USD), memberDefaultMonthly: monthly(raw, "memberDefaultMonthlyUsd", deps.cloud, DEFAULT_MEMBER_MONTHLY_BUDGET_USD), memberOverrideCount: count, memberOverrideCoverage: "configured_only_membership_not_checked", topUps: "not_checked", usage: "not_checked", enforcement: "not_checked" });
  // Refuse a role/pointer/open-org change observed after the setting read as well.
  await authority(deps, caller);
  return result;
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
