// Numeric capture is not a project authorization lease. These native source
// conditions accompany the accepted work transaction without pinning money.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { isWriterOrgRole, type OrgRole } from "@agentx/cloud-contracts";
import { projectMetaKey, projectMemberKey, type OrgId } from "@rovara-code/contracts";
import { Aliases, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { budgetActorRefused } from "../agents/budget-authority.js";
export async function taskStartProjectAuthorityChecks(deps: Pick<TableInput, "documentClient" | "tableName">,
  input: { orgId: OrgId; developerId: string; role: OrgRole; project: string }, authorize: () => Promise<void>): Promise<TransactItem[]> {
  // I2: this fence guards the start or continuation of work. An Auditor never starts work, so it holds no authority to fence.
  if (!isWriterOrgRole(input.role)) throw budgetActorRefused();
  const admin = input.role === "owner" || input.role === "admin";
  const sources = [
    { key: projectMetaKey(input.orgId, input.project), fields: ["entityType", "name", "status", "archivedAt", "archiveRevision", "createdAt", "createdBy"] },
    ...(admin ? [] : [{ key: projectMemberKey(input.orgId, input.developerId, input.project), fields: ["entityType", "ownerKey", "projectName", "role", "projectRole", "grantId"] }]),
  ];
  const rows = await Promise.all(sources.map(async ({ key }, index) => {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response.Item;
    if (row !== undefined && (row.pk !== key.pk || row.sk !== key.sk || (row.orgId !== undefined && row.orgId !== input.orgId))) throw budgetActorRefused();
    if (row !== undefined && (index === 0
      ? row.entityType !== "PROJECT_META" || row.name !== input.project || (row.status !== "active" && row.status !== "archived")
      : row.entityType !== "MEMBERSHIP" || row.ownerKey !== input.developerId || row.projectName !== input.project)) throw budgetActorRefused();
    return row;
  }));
  // A read racing the source checks can only cause a conservative refusal. A
  // fresh live project check must still authorize the caller after these reads.
  await authorize();
  return sources.map(({ key, fields }, index) => {
    const row = rows[index], a = new Aliases();
    const parts = [row === undefined ? `attribute_not_exists(${a.name("pk")})` : `attribute_exists(${a.name("pk")})`];
    if (row !== undefined) fields.forEach(field => parts.push(row[field] === undefined ? `attribute_not_exists(${a.name(field)})` : `${a.name(field)} = ${a.value(row[field])}`));
    return { ConditionCheck: { TableName: deps.tableName, Key: key, ConditionExpression: parts.join(" AND "), ExpressionAttributeNames: a.names,
      ...(Object.keys(a.values).length === 0 ? {} : { ExpressionAttributeValues: a.values }),
    } };
  });
}
