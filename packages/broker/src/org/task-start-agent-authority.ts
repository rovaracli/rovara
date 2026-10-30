// A frozen numeric stop does not freeze visibility, archive state or roster
// membership. Hold those live sources in the accepted task transaction.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentOwnerSchema, agentKey, projectAgentKey, isBuiltinAgentId, type AgentId, type OrgId } from "@agentx/contracts";
import { Aliases, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { budgetActorRefused } from "../agents/budget-authority.js";
export async function taskStartAgentAuthorityChecks(deps: Pick<TableInput, "documentClient" | "tableName">,
  input: { orgId: OrgId; project: string; agentId: AgentId; draft: boolean; process: boolean }, authorize: () => Promise<void>): Promise<TransactItem[]> {
  if (isBuiltinAgentId(input.agentId)) return [];
  const sources = [
    { key: agentKey(input.orgId, input.agentId, "META"), fields: ["entityType", "orgId", "agentId", "status", "owner", "accountable", "purpose", "sharesRevision", "createdAt", "createdBy", ...(input.draft ? ["draftRevision"] : [])] },
    ...(input.draft || input.process ? [] : [{ key: projectAgentKey(input.orgId, input.project, input.agentId), fields: ["entityType", "orgId", "project", "agentId", "addedAt", "addedBy"] }]),
  ];
  const rows = await Promise.all(sources.map(async ({ key }, index) => {
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response.Item;
    if (row === undefined || row.pk !== key.pk || row.sk !== key.sk || row.orgId !== input.orgId || row.agentId !== input.agentId) throw budgetActorRefused();
    if (index === 0 ? row.entityType !== "AGENT" || row.status !== "active" || !AgentOwnerSchema.safeParse(row.owner).success
      : row.entityType !== "PROJECT_AGENT" || row.project !== input.project) throw budgetActorRefused();
    return row;
  }));
  // Invoke the existing use/edit policy, rather than duplicating its ownership
  // or sharing rules. These conditions only fence its observed source state.
  await authorize();
  return sources.map(({ key, fields }, index) => {
    const row = rows[index]; if (row === undefined) throw budgetActorRefused();
    const a = new Aliases(), parts = [`attribute_exists(${a.name("pk")})`];
    fields.forEach(field => parts.push(row[field] === undefined ? `attribute_not_exists(${a.name(field)})` : `${a.name(field)} = ${a.value(row[field])}`));
    return { ConditionCheck: { TableName: deps.tableName, Key: key, ConditionExpression: parts.join(" AND "), ExpressionAttributeNames: a.names, ExpressionAttributeValues: a.values } };
  });
}
