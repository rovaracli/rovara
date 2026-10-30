import { GetCommand, QueryCommand, TransactGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { z } from "zod";
import { usdToWholeMicrodollars } from "./budget-amount.js";
import { nativeSnapshotConditions } from "./native-snapshot-conditions.js";
// These items join the native organization creation transaction. No post-create
// ensure, runtime numeric default, independent ceiling, or enrollment side effect.
import { AuditEventInputSchema, BUILTIN_AGENT_IDS, AgentGuardrailsSchema, AgentIdSchema, agentKey, builtinSettingsKey, builtinRecipe, projectAiKey, orgProjectCatalogKey, isBuiltinAgentId, OrgIdSchema, agentXError, orgMetaKey, DEFAULT_AGENT_GUARDRAILS, agentGuardrailsKey, orgScoped, orgSettingsKey, type OrgId } from "@agentx/contracts";
import { auditTaskStopPolicySeeded } from "../audit/events.js";
import { auditPendingItem, type TransactItem } from "../audit/outbox.js";

export function taskStopBootstrapItems(tableName: string, orgId: OrgId, nowMs: number, options: { codePin?: { version: number; by: string } } = {}): TransactItem[] {
  const at = new Date(nowMs).toISOString();
  const occurrence = `task-stop-bootstrap-v1#${orgId}`;
  const event = AuditEventInputSchema.parse(auditTaskStopPolicySeeded({
    orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence,
    source: "bootstrap", mode: "rovara_estimate", revision: 1, ceilingMicrousd: DEFAULT_AGENT_GUARDRAILS.maxPerRunCeilingUsd * 1_000_000,
  }));
  const put = (Item: Record<string, unknown>): TransactItem => ({ Put: { TableName: tableName, Item, ConditionExpression: "attribute_not_exists(pk)" } });
  return [
    put({ ...orgSettingsKey(orgId, "TASK_STOP_POLICY"), entityType: "ORG_TASK_STOP_POLICY", orgId, revision: 1,
      policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } },
      enrollment: { version: 1, state: "disabled" },
      seedProvenance: { occurrence, source: "bootstrap", reviewRequired: true, seededAt: at },
      updatedBy: "system", updatedAt: at }),
    put({ ...agentGuardrailsKey(orgId), entityType: "AGENT_GUARDRAILS", orgId, revision: 1,
      guardrails: structuredClone(DEFAULT_AGENT_GUARDRAILS), seedProvenance: { occurrence, source: "bootstrap", reviewRequired: true, seededAt: at }, updatedBy: "system", updatedAt: at }),
    put({ pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#bootstrap", entityType: "TASK_STOP_SEED", orgId,
      version: 1, occurrenceId: occurrence, source: "bootstrap", outcome: "created", completedAt: at, policyRevision: 1, auditOccurrence: event.eventId }),
    ...BUILTIN_AGENT_IDS.map(agentId => put({ ...builtinSettingsKey(orgId, agentId), entityType: "BUILTIN_AGENT_SETTINGS", orgId, agentId, revision: 1, stopKind: "inherit",
      seedProvenance: { occurrence, source: "bootstrap", reviewRequired: true, seededAt: at }, updatedAt: at,
      updatedBy: agentId === "rovara-code" && options.codePin !== undefined ? options.codePin.by : "system",
      ...(agentId === "rovara-code" && options.codePin !== undefined ? { pinnedVersion: options.codePin.version } : {}) })),
    // Persist even when delivery runtime isn't wired yet: no audit-free money seed.
    put({ ...auditPendingItem(event, nowMs) }),
  ];
}

/** Explicit offline upgrade prerequisite; never invoked by a paid start and never
 * enables enforcement. Resource inheritance inventory is a separate prerequisite. */
export async function bootstrapTaskStopPolicy(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }, orgId: OrgId): Promise<{ outcome: "created" | "preserved" }> {
  OrgIdSchema.parse(orgId);
  const keys = [orgMetaKey(orgId), orgSettingsKey(orgId, "TASK_STOP_POLICY"), agentGuardrailsKey(orgId), { pk: orgScoped(orgId, "TASK_STOP_SEED"), sk: "V1#upgrade" }];
  const result = z.object({ Responses: z.array(z.object({ Item: z.record(z.string(), z.unknown()).optional() })).length(4) }).parse(await deps.documentClient.send(new TransactGetCommand({ TransactItems: keys.map(Key => ({ Get: { TableName: deps.tableName, Key } })) })));
  const rows = result.Responses.map(response => response.Item);
  const guards = nativeSnapshotConditions(deps.tableName, keys, rows, ["closingAt", "closedAt", "revision", "policy", "guardrails", "enrollment"]);
  const [org, policy, ceiling, receipt] = rows;
  if (org?.orgId !== orgId || org.entityType !== "ORG" || org.closingAt !== undefined || org.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "The company must be open before spending upgrade.");
  if (receipt !== undefined) {
    const saved = z.object({ orgId: z.literal(orgId), entityType: z.literal("TASK_STOP_SEED"), source: z.literal("upgrade"), version: z.literal(1), occurrenceId: z.literal(`task-stop-upgrade-v1#${orgId}`), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), completedAt: z.string().datetime(), policyRevision: z.number().int().positive(), auditOccurrence: z.string().min(1), outcome: z.enum(["created", "preserved"]) }).parse(receipt);
    return { outcome: saved.outcome };
  }
  if (policy !== undefined) {
    const numeric = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
    z.object({ orgId: z.literal(orgId), entityType: z.literal("ORG_TASK_STOP_POLICY"), revision: z.number().int().positive(), enrollment: z.object({ version: z.literal(1), state: z.enum(["disabled", "ready", "enabled"]) }).passthrough(),
      policy: z.union([z.object({ schemaVersion: z.literal(1), defaultStopMicrousd: numeric }).strict(), z.object({ schemaVersion: z.literal(2), defaultPolicy: z.union([z.object({ kind: z.literal("rovara_estimate") }).strict(), z.object({ kind: z.literal("limited"), stopMicrousd: numeric }).strict()]) }).strict()]) }).parse(policy);
  }
  const guardrails = ceiling === undefined ? DEFAULT_AGENT_GUARDRAILS : AgentGuardrailsSchema.parse(ceiling.guardrails);
  if (ceiling !== undefined && (ceiling.orgId !== orgId || ceiling.entityType !== "AGENT_GUARDRAILS" || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(ceiling, field)) || !Number.isSafeInteger(ceiling.revision) || Number(ceiling.revision) < 1)) throw agentXError("CONFIG_INVALID", "The spending ceiling needs repair.");
  const ceilingMicrousd = guardrails.maxPerRunCeilingUsd * 1_000_000;
  if (!Number.isSafeInteger(ceilingMicrousd)) throw agentXError("CONFIG_INVALID", "The spending ceiling needs repair.");
  const at = new Date(deps.now()).toISOString(), occurrence = `task-stop-upgrade-v1#${orgId}`, outcome = policy === undefined ? "created" : "preserved", revision = policy === undefined ? 1 : Number(policy.revision);
  const baseEvent = auditTaskStopPolicySeeded({ orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence, source: "upgrade", mode: "rovara_estimate", revision, ceilingMicrousd });
  const event = AuditEventInputSchema.parse({ ...baseEvent, facts: { ...baseEvent.facts, mode: outcome === "created" ? "rovara_estimate" : "preserved", outcome } });
  const put = (Item: Record<string, unknown>): TransactItem => ({ Put: { TableName: deps.tableName, Item, ConditionExpression: "attribute_not_exists(pk)" } });
  const items: TransactItem[] = [guards[0]!];
  if (policy === undefined) items.push(put({ ...keys[1], orgId, entityType: "ORG_TASK_STOP_POLICY", revision: 1, policy: { schemaVersion: 2, defaultPolicy: { kind: "rovara_estimate" } }, enrollment: { version: 1, state: "disabled" }, seedProvenance: { occurrence, source: "upgrade", reviewRequired: true, seededAt: at }, updatedBy: "system", updatedAt: at }));
  else items.push(guards[1]!);
  if (ceiling === undefined) items.push(put({ ...keys[2], orgId, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: structuredClone(guardrails), seedProvenance: { occurrence, source: "upgrade", reviewRequired: true, seededAt: at }, updatedBy: "system", updatedAt: at }));
  else items.push(guards[2]!);
  items.push(put({ ...keys[3], orgId, entityType: "TASK_STOP_SEED", version: 1, occurrenceId: occurrence, source: "upgrade", outcome, sourceDigest: createHash("sha256").update(JSON.stringify(rows.slice(0, 3))).digest("hex"), completedAt: at, policyRevision: revision, auditOccurrence: event.eventId }), put({ ...auditPendingItem(event, deps.now()) }));
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  return { outcome };
}

/** One bounded legacy resource; callers must checkpoint the whole inventory
 * separately. Missing custom resources refuse; registered built-ins may acquire
 * their optional settings metadata. This operation never enables enforcement. */
export async function upgradeTaskStopInheritance(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }, input: { orgId: OrgId; kind: "agent"; agentId: string }): Promise<{ outcome: "updated" | "preserved" }> {
  const { orgId, agentId } = z.object({ orgId: OrgIdSchema, kind: z.literal("agent"), agentId: AgentIdSchema }).strict().parse(input);
  const builtin = isBuiltinAgentId(agentId);
  const keys = [orgMetaKey(orgId), builtin ? builtinSettingsKey(orgId, agentId) : agentKey(orgId, agentId, "META")];
  const response = z.object({ Responses: z.array(z.object({ Item: z.record(z.string(), z.unknown()).optional() })).length(2) }).parse(await deps.documentClient.send(new TransactGetCommand({ TransactItems: keys.map(Key => ({ Get: { TableName: deps.tableName, Key } })) })));
  const rows = response.Responses.map(entry => entry.Item), [org, stored] = rows;
  // The immutable server registry establishes a built-in's existence. Absence
  // of its optional legacy settings is recognized inheritance, never money.
  const resource = stored ?? (builtin ? { ...keys[1], orgId, agentId, entityType: "BUILTIN_AGENT_SETTINGS", revision: 1 } : undefined);
  const guards = nativeSnapshotConditions(deps.tableName, keys, rows, ["orgId", "agentId", "closingAt", "closedAt", "status", "revision", "stopKind", "maxPerRunUsd", "seedProvenance"]);
  if (org?.orgId !== orgId || org.entityType !== "ORG" || org.closingAt !== undefined || org.closedAt !== undefined || resource === undefined
    || resource.entityType !== (builtin ? "BUILTIN_AGENT_SETTINGS" : "AGENT")
    || (resource.orgId !== orgId && (!builtin || resource.orgId !== undefined))
    || (resource.agentId !== agentId && (!builtin || resource.agentId !== undefined))
    || (builtin ? resource.status !== undefined && resource.status !== "active" : resource.status !== "active")) throw agentXError("CONFIG_INVALID", "The legacy spending resource needs repair.");
  const revision = builtin && resource.revision === undefined ? 1 : resource.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw agentXError("CONFIG_INVALID", "The legacy spending revision needs repair.");
  if (builtin && resource.pinnedVersion !== undefined) builtinRecipe(agentId, z.number().int().positive().parse(resource.pinnedVersion));
  const explicit = Object.hasOwn(resource, "maxPerRunUsd"), kind = explicit ? "limited" : "inherit";
  if (explicit && usdToWholeMicrodollars(resource.maxPerRunUsd) === undefined) throw agentXError("CONFIG_INVALID", "The legacy agent limit needs repair.");
  if (resource.stopKind !== undefined) {
    if (resource.stopKind !== kind) throw agentXError("CONFIG_INVALID", "The legacy agent limit is contradictory.");
    if (resource.orgId === orgId && resource.agentId === agentId && resource.revision === revision) return { outcome: "preserved" };
  }
  const at = new Date(deps.now()).toISOString(), occurrence = `task-stop-inheritance-v1#${orgId}#agent#${agentId}`;
  const base = auditTaskStopPolicySeeded({ orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence, source: "upgrade", mode: "rovara_estimate", revision: Number(revision), ceilingMicrousd: 0 });
  const event = AuditEventInputSchema.parse({ ...base, target: { kind: "agent", id: agentId }, facts: { mode: kind, source: "upgrade", revision, outcome: "updated" } });
  const source = guards[1]!.ConditionCheck!;
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [guards[0]!, { Update: { TableName: deps.tableName, Key: keys[1]!, UpdateExpression: "SET #seedType = :seedType, #seedKind = :seedKind, #seedProof = :seedProof, #seedOrg = :seedOrg, #seedAgent = :seedAgent, #seedRevision = :seedRevision", ConditionExpression: source.ConditionExpression, ExpressionAttributeNames: { ...source.ExpressionAttributeNames, "#seedType": "entityType", "#seedOrg": "orgId", "#seedAgent": "agentId", "#seedRevision": "revision", "#seedKind": "stopKind", "#seedProof": "seedProvenance" }, ExpressionAttributeValues: { ...source.ExpressionAttributeValues, ":seedType": builtin ? "BUILTIN_AGENT_SETTINGS" : "AGENT", ":seedOrg": orgId, ":seedAgent": agentId, ":seedRevision": revision, ":seedKind": kind, ":seedProof": { source: "upgrade", occurrence, reviewRequired: true, seededAt: at } } } }, { Put: { TableName: deps.tableName, Item: auditPendingItem(event, deps.now()), ConditionExpression: "attribute_not_exists(pk)" } }] }));
  return { outcome: "updated" };
}

/** Explicit single-project inventory item; no missing project/settings creation. */
export async function upgradeTaskStopProjectInheritance(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }, input: { orgId: OrgId; project: string }): Promise<{ outcome: "updated" | "preserved" }> {
  const { orgId, project } = z.object({ orgId: OrgIdSchema, project: z.string().min(1).max(256) }).strict().parse(input);
  const keys = [orgMetaKey(orgId), projectAiKey(orgId, project), orgProjectCatalogKey(orgId, project)];
  const response = z.object({ Responses: z.array(z.object({ Item: z.record(z.string(), z.unknown()).optional() })).length(3) }).parse(await deps.documentClient.send(new TransactGetCommand({ TransactItems: keys.map(Key => ({ Get: { TableName: deps.tableName, Key } })) })));
  const rows = response.Responses.map(entry => entry.Item), [org, resource, catalog] = rows;
  const guards = nativeSnapshotConditions(deps.tableName, keys, rows, ["orgId", "project", "closingAt", "closedAt", "revision", "latestRevision", "taskStopPolicy", "seedProvenance"]);
  if (org?.orgId !== orgId || org.entityType !== "ORG" || org.closingAt !== undefined || org.closedAt !== undefined || resource === undefined || (resource.orgId !== undefined && resource.orgId !== orgId) || resource.entityType !== "PROJECT_AI" || resource.project !== project || !Number.isSafeInteger(resource.revision) || Number(resource.revision) < 1 || catalog === undefined || (catalog.orgId !== undefined && catalog.orgId !== orgId) || catalog.entityType !== "PROJECT_CATALOG" || catalog.name !== project || !Number.isSafeInteger(catalog.latestRevision) || Number(catalog.latestRevision) < 1) throw agentXError("CONFIG_INVALID", "The legacy project spending setting needs repair.");
  const existingPolicy = Object.hasOwn(resource, "taskStopPolicy");
  const policy = existingPolicy ? z.union([z.object({ schemaVersion: z.literal(1), stopMicrousd: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(), z.object({ schemaVersion: z.literal(2), kind: z.literal("inherit") }).strict()]).parse(resource.taskStopPolicy) : { schemaVersion: 2 as const, kind: "inherit" as const };
  if (existingPolicy && resource.orgId === orgId && catalog.orgId === orgId) return { outcome: "preserved" };
  const at = new Date(deps.now()).toISOString(), occurrence = `task-stop-inheritance-v1#${orgId}#project#${project}`;
  const base = auditTaskStopPolicySeeded({ orgId, actor: { kind: "system", id: "rovara" }, occurredAt: at, occurrence, source: "upgrade", mode: "rovara_estimate", revision: Number(resource.revision), ceilingMicrousd: 0 });
  const event = AuditEventInputSchema.parse({ ...base, target: { kind: "project", name: project }, facts: { mode: policy.schemaVersion === 1 ? "limited" : "inherit", source: "upgrade", revision: resource.revision, outcome: "updated" } });
  const source = guards[1]!.ConditionCheck!, catalogSource = guards[2]!.ConditionCheck!;
  const catalogWrite: TransactItem = catalog.orgId === orgId ? guards[2]! : { Update: { ...catalogSource, TableName: deps.tableName, Key: keys[2]!, UpdateExpression: "SET #seedOrg = :seedOrg", ExpressionAttributeNames: { ...catalogSource.ExpressionAttributeNames, "#seedOrg": "orgId" }, ExpressionAttributeValues: { ...catalogSource.ExpressionAttributeValues, ":seedOrg": orgId } } };
  await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [guards[0]!, catalogWrite, { Update: { TableName: deps.tableName, Key: keys[1]!, UpdateExpression: "SET #seedOrg = :seedOrg, #seedPolicy = :seedPolicy, #seedProof = :seedProof", ConditionExpression: source.ConditionExpression, ExpressionAttributeNames: { ...source.ExpressionAttributeNames, "#seedOrg": "orgId", "#seedPolicy": "taskStopPolicy", "#seedProof": "seedProvenance" }, ExpressionAttributeValues: { ...source.ExpressionAttributeValues, ":seedOrg": orgId, ":seedPolicy": policy, ":seedProof": resource.seedProvenance ?? { source: "upgrade", occurrence, reviewRequired: true, seededAt: at } } } }, { Put: { TableName: deps.tableName, Item: auditPendingItem(event, deps.now()), ConditionExpression: "attribute_not_exists(pk)" } }] }));
  return { outcome: "updated" };
}

/** One directory page only. Exhaustion is not a rollout or enrollment receipt.
 * A failed resource throws before returning any advanced cursor; replay safely
 * preserves earlier metadata commits. The controller persists page checkpoints. */
export async function upgradeTaskStopAgentInventoryPage(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }, input: { orgId: OrgId; limit: number; cursor?: { pk: string; sk: string } }): Promise<{ examined: number; updated: number; preserved: number; complete: boolean; cursor?: { pk: string; sk: string } }> {
  const parsed = z.object({ orgId: OrgIdSchema, limit: z.number().int().min(1).max(25), cursor: z.object({ pk: z.string(), sk: AgentIdSchema }).strict().optional() }).strict().parse(input);
  const partition = orgScoped(parsed.orgId, "AGENT_DIRECTORY");
  if (parsed.cursor !== undefined && (parsed.cursor.pk !== partition || isBuiltinAgentId(parsed.cursor.sk))) throw agentXError("CONFIG_INVALID", "Invalid spending inventory cursor.");
  const org = z.object({ Item: z.record(z.string(), z.unknown()).optional() }).parse(await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMetaKey(parsed.orgId), ConsistentRead: true }))).Item;
  if (org?.orgId !== parsed.orgId || org.entityType !== "ORG" || org.closingAt !== undefined || org.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "The inventory company must be open.");
  const keySchema = z.object({ pk: z.literal(partition), sk: AgentIdSchema.refine(id => !isBuiltinAgentId(id)) }).strict();
  const page = z.object({ Items: z.array(z.record(z.string(), z.unknown())).max(parsed.limit).optional(), LastEvaluatedKey: keySchema.optional() }).parse(await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": partition }, ConsistentRead: true, Limit: parsed.limit, ...(parsed.cursor === undefined ? {} : { ExclusiveStartKey: parsed.cursor }) })));
  const entries = (page.Items ?? []).map(row => {
    const entry = z.object({ pk: z.literal(partition), sk: AgentIdSchema, entityType: z.literal("AGENT_DIRECTORY"), agentId: AgentIdSchema }).parse(row);
    if (entry.sk !== entry.agentId || isBuiltinAgentId(entry.agentId)) throw agentXError("CONFIG_INVALID", "The agent inventory needs repair.");
    return entry;
  });
  let updated = 0, preserved = 0;
  for (const entry of entries) {
    const result = await upgradeTaskStopInheritance(deps, { orgId: parsed.orgId, kind: "agent", agentId: entry.agentId });
    if (result.outcome === "updated") updated += 1; else preserved += 1;
  }
  return { examined: entries.length, updated, preserved, complete: page.LastEvaluatedKey === undefined, ...(page.LastEvaluatedKey === undefined ? {} : { cursor: page.LastEvaluatedKey }) };
}

/** One bounded native project catalog page; exhaustion is never readiness. */
export async function upgradeTaskStopProjectInventoryPage(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }, input: { orgId: OrgId; limit: number; cursor?: { pk: string; sk: string } }): Promise<{ examined: number; updated: number; preserved: number; complete: boolean; cursor?: { pk: string; sk: string } }> {
  const parsed = z.object({ orgId: OrgIdSchema, limit: z.number().int().min(1).max(25), cursor: z.object({ pk: z.string(), sk: z.string().regex(/^PROJECT#.+$/).max(264) }).strict().optional() }).strict().parse(input);
  const partition = orgScoped(parsed.orgId, "PROJECT_CATALOG");
  if (parsed.cursor !== undefined && (parsed.cursor.pk !== partition)) throw agentXError("CONFIG_INVALID", "Invalid spending inventory cursor.");
  const org = z.object({ Item: z.record(z.string(), z.unknown()).optional() }).parse(await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMetaKey(parsed.orgId), ConsistentRead: true }))).Item;
  if (org?.orgId !== parsed.orgId || org.entityType !== "ORG" || org.closingAt !== undefined || org.closedAt !== undefined) throw agentXError("CONFIG_INVALID", "The inventory company must be open.");
  const keySchema = z.object({ pk: z.literal(partition), sk: z.string().regex(/^PROJECT#.+$/).max(264) }).strict();
  const page = z.object({ Items: z.array(z.record(z.string(), z.unknown())).max(parsed.limit).optional(), LastEvaluatedKey: keySchema.optional() }).parse(await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": partition }, ConsistentRead: true, Limit: parsed.limit, ...(parsed.cursor === undefined ? {} : { ExclusiveStartKey: parsed.cursor }) })));
  const entries = (page.Items ?? []).map(row => {
    const entry = z.object({ pk: z.literal(partition), sk: z.string(), entityType: z.literal("PROJECT_CATALOG"), name: z.string().min(1).max(256), latestRevision: z.number().int().positive() }).parse(row);
    if (entry.sk !== `PROJECT#${entry.name}` || (row.orgId !== undefined && row.orgId !== parsed.orgId)) throw agentXError("CONFIG_INVALID", "The project inventory needs repair.");
    return entry;
  });
  let updated = 0, preserved = 0;
  for (const entry of entries) {
    const result = await upgradeTaskStopProjectInheritance(deps, { orgId: parsed.orgId, project: entry.name });
    if (result.outcome === "updated") updated += 1; else preserved += 1;
  }
  return { examined: entries.length, updated, preserved, complete: page.LastEvaluatedKey === undefined, ...(page.LastEvaluatedKey === undefined ? {} : { cursor: page.LastEvaluatedKey }) };
}

/** A bounded registry page, not a controller rollout/readiness assertion. */
export async function upgradeTaskStopBuiltinInventoryPage(deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number }, input: { orgId: OrgId; limit: number; cursor?: { agentId: string; registryDigest: string } }): Promise<{ examined: number; updated: number; preserved: number; complete: boolean; cursor?: { agentId: string; registryDigest: string } }> {
  const parsed = z.object({ orgId: OrgIdSchema, limit: z.number().int().min(1).max(6), cursor: z.object({ agentId: AgentIdSchema, registryDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict().parse(input);
  const registryDigest = createHash("sha256").update(JSON.stringify({ orgId: parsed.orgId, agentIds: BUILTIN_AGENT_IDS })).digest("hex");
  const start = parsed.cursor === undefined ? 0 : BUILTIN_AGENT_IDS.findIndex(id => id === parsed.cursor?.agentId);
  if (start < 0 || (parsed.cursor !== undefined && parsed.cursor.registryDigest !== registryDigest)) throw agentXError("CONFIG_INVALID", "The built-in spending inventory cursor changed.");
  const page = BUILTIN_AGENT_IDS.slice(start, start + parsed.limit);
  let updated = 0, preserved = 0;
  for (const agentId of page) {
    const result = await upgradeTaskStopInheritance(deps, { orgId: parsed.orgId, kind: "agent", agentId });
    if (result.outcome === "updated") updated += 1; else preserved += 1;
  }
  const next = BUILTIN_AGENT_IDS[start + page.length];
  return { examined: page.length, updated, preserved, complete: next === undefined, ...(next === undefined ? {} : { cursor: { agentId: next, registryDigest } }) };
}
