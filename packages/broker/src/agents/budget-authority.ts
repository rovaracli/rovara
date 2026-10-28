// Transactional current-org actor fence for the existing user budget write paths.
import { OrgIdSchema, OrgRoleSchema, agentXError, orgMemberKey, developerOrgKey, orgMetaKey, type OrgId, type OrgRole } from "@agentx/contracts";
import type { TransactItem } from "./table-writes.js";
export interface BudgetIdentity { developerId: string; role: OrgRole }
export interface BudgetActor extends BudgetIdentity { signedIn?: BudgetIdentity }
export const budgetActorRefused = () => agentXError("FORBIDDEN", "Your company access changed. Reload and check your access before changing this budget.");
export function budgetActorChecks(tableName: string, orgId: OrgId, actor: BudgetActor): TransactItem[] {
  if (!OrgIdSchema.safeParse(orgId).success || !/^[a-f0-9]{64}$/.test(actor.developerId) || !OrgRoleSchema.safeParse(actor.role).success) throw budgetActorRefused();
  const roleNames = { "#role": "role" }, roleValues = { ":org": orgId, ":role": actor.role };
  const checks: TransactItem[] = [
    { ConditionCheck: { TableName: tableName, Key: orgMemberKey(orgId, actor.developerId), ConditionExpression: "orgId = :org AND developerId = :person AND #role = :role", ExpressionAttributeNames: roleNames, ExpressionAttributeValues: { ...roleValues, ":person": actor.developerId } } },
    { ConditionCheck: { TableName: tableName, Key: developerOrgKey(actor.developerId), ConditionExpression: "orgId = :org AND #role = :role", ExpressionAttributeNames: roleNames, ExpressionAttributeValues: roleValues } },
    { ConditionCheck: { TableName: tableName, Key: orgMetaKey(orgId), ConditionExpression: "orgId = :org AND attribute_not_exists(closingAt) AND attribute_not_exists(closedAt)", ExpressionAttributeValues: { ":org": orgId } } },
  ];
  // DynamoDB permits one operation per key: share the org-open condition, retain both identities' member and pointer checks.
  if (actor.signedIn !== undefined && actor.signedIn.developerId !== actor.developerId) {
    checks.push(...budgetActorChecks(tableName, orgId, actor.signedIn).slice(0, 2));
  }
  return checks;
}
