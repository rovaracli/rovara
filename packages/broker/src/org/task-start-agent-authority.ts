// A frozen numeric stop does not freeze visibility, archive state or roster
// membership. Hold those live sources in the accepted task transaction.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { isWriterOrgRole, type OrgRole } from "@agentx/cloud-contracts";
import { AgentGuardrailsSchema, AgentOwnerSchema, AgentPrincipalSchema, agentGuardrailsKey, builtinSettingsKey, agentKey, projectAgentKey, projectMemberKey, isBuiltinAgentId, type AgentId, type OrgId } from "@rovara-code/contracts";
import { Aliases, type TableInput, type TransactItem } from "../agents/table-writes.js";
import { budgetActorRefused } from "../agents/budget-authority.js";
export async function taskStartAgentAuthorityChecks(deps: Pick<TableInput, "documentClient" | "tableName">,
  input: { orgId: OrgId; project: string; agentId: AgentId; draft: boolean; process: boolean; developerId: string; role: OrgRole; expectedDraftRevision?: number; frozenRecipe?: boolean }, authorize: () => Promise<void>, readShares: () => Promise<readonly { principal: unknown }[]>): Promise<TransactItem[]> {
  // I2: same rule as the project fence: an Auditor starts no agent work.
  if (!isWriterOrgRole(input.role)) throw budgetActorRefused();
  if (isBuiltinAgentId(input.agentId)) {
    const settingsKey = builtinSettingsKey(input.orgId, input.agentId), guardrailsKey = agentGuardrailsKey(input.orgId);
    const rows = await Promise.all([settingsKey, guardrailsKey].map(async Key => {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const row = response.Item;
      if (row === undefined || row.pk !== Key.pk || row.sk !== Key.sk || row.orgId !== input.orgId) throw budgetActorRefused();
      return row;
    }));
    const settings = rows[0], guardrails = rows[1];
    if (settings === undefined || settings.entityType !== "BUILTIN_AGENT_SETTINGS" || settings.agentId !== input.agentId
      || typeof settings.pinnedVersion !== "number" || !Number.isSafeInteger(settings.pinnedVersion) || settings.pinnedVersion < 1
      || guardrails?.entityType !== "AGENT_GUARDRAILS") throw budgetActorRefused();
    const parsed = AgentGuardrailsSchema.safeParse(guardrails.guardrails);
    if (!parsed.success || parsed.data.disabledBuiltins.includes(input.agentId)) throw budgetActorRefused();
    await authorize();
    const a = new Aliases();
    const settingsCondition = ["entityType", "orgId", "agentId", "pinnedVersion"].map(field => `${a.name(field)} = ${a.value(settings[field])}`).join(" AND ");
    const b = new Aliases();
    const guardrailsCondition = `${b.name("entityType")} = ${b.value("AGENT_GUARDRAILS")} AND ${b.name("orgId")} = ${b.value(input.orgId)} AND ${b.name("guardrails")}.${b.name("disabledBuiltins")} = ${b.value(parsed.data.disabledBuiltins)}`;
    // Do not fence guardrails.revision or its ceiling: numeric policy edits
    // after capture apply to the next admission, not this accepted task.
    return [
      { ConditionCheck: { TableName: deps.tableName, Key: settingsKey, ConditionExpression: settingsCondition, ExpressionAttributeNames: a.names, ExpressionAttributeValues: a.values } },
      { ConditionCheck: { TableName: deps.tableName, Key: guardrailsKey, ConditionExpression: guardrailsCondition, ExpressionAttributeNames: b.names, ExpressionAttributeValues: b.values } },
    ];
  }
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
    if (index === 0 && input.draft && input.frozenRecipe !== true && (input.expectedDraftRevision === undefined || !Number.isSafeInteger(input.expectedDraftRevision)
      || input.expectedDraftRevision < 1 || row.draftRevision !== input.expectedDraftRevision)) throw budgetActorRefused();
    return row;
  }));
  const additional: TransactItem[] = [];
  const owner = AgentOwnerSchema.parse(rows[0]?.owner);
  const projects = new Set<string>();
  if (input.role === "member") {
    if (owner.kind === "project") projects.add(owner.project);
    if (owner.kind !== "member" || owner.developerId !== input.developerId) {
      // Read shares AFTER META, whose sharesRevision is held below. A change
      // between enumeration and use recheck cannot introduce an unfenced grant.
      const shares = await readShares();
      if (shares.length > 50) throw budgetActorRefused();
      for (const share of shares) {
        const principal = AgentPrincipalSchema.safeParse(share.principal);
        if (principal.success && principal.data.kind === "project") projects.add(principal.data.project);
      }
    }
  }
  projects.delete(input.project); // already fenced once by the task's project helper
  for (const project of projects) {
    const Key = projectMemberKey(input.orgId, input.developerId, project);
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
    const row = response.Item;
    if (row !== undefined && (row.pk !== Key.pk || row.sk !== Key.sk || (row.orgId !== undefined && row.orgId !== input.orgId)
      || row.entityType !== "MEMBERSHIP" || row.ownerKey !== input.developerId || row.projectName !== project)) throw budgetActorRefused();
    const a = new Aliases(), parts = [row === undefined ? `attribute_not_exists(${a.name("pk")})` : `attribute_exists(${a.name("pk")})`];
    if (row !== undefined) ["entityType", "ownerKey", "projectName", "role", "projectRole", "grantId"].forEach(field => parts.push(row[field] === undefined ? `attribute_not_exists(${a.name(field)})` : `${a.name(field)} = ${a.value(row[field])}`));
    additional.push({ ConditionCheck: { TableName: deps.tableName, Key, ConditionExpression: parts.join(" AND "), ExpressionAttributeNames: a.names,
      ...(Object.keys(a.values).length === 0 ? {} : { ExpressionAttributeValues: a.values }),
    } });
  }
  // Invoke the existing use/edit policy, rather than duplicating its ownership
  // or sharing rules. These conditions only fence its observed source state.
  await authorize();
  return [...sources.map(({ key, fields }, index): TransactItem => {
    const row = rows[index]; if (row === undefined) throw budgetActorRefused();
    const a = new Aliases(), parts = [`attribute_exists(${a.name("pk")})`];
    fields.forEach(field => parts.push(row[field] === undefined ? `attribute_not_exists(${a.name(field)})` : `${a.name(field)} = ${a.value(row[field])}`));
    return { ConditionCheck: { TableName: deps.tableName, Key: key, ConditionExpression: parts.join(" AND "), ExpressionAttributeNames: a.names, ExpressionAttributeValues: a.values } };
  }), ...additional];
}
