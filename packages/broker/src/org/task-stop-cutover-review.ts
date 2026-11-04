// Bounded company readiness and advisory task impacts; never paid-work permission.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import {
 AgentGuardrailsSchema, AgentIdSchema, BUILTIN_AGENT_IDS, OrgModelSourcesSchema, ROVARA_CODE_AGENT_ID,
 TaskStopCompanyPolicySchema, TaskStopProjectPolicySchema, WORKSPACE_PROJECT_INDEX, agentGuardrailsKey, agentKey,
 builtinSettingsKey, isBuiltinAgentId, modelSourcesKey, orgProjectCatalogKey, orgScoped, projectAiKey, projectMetaKey,
 taskSpendKey, workspaceProjectIndexValue, type TaskStopImpact,
} from "@agentx/contracts";
import { taskKey, taskPointerKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { TransactItem } from "../agents/table-writes.js";
import { readTaskRecipe } from "../agents/runs.js";
import { captureTaskFundingProof, taskFundingModelPool } from "./task-stop-funding.js";
import { captureTaskStopCutoverReview, type CapturedTaskStop } from "./task-stop-admission.js";
import { savedTaskStopBounds } from "./task-stop-window.js";
import { taskRunLimitMicrousd } from "../spend/task-approval-terms.js";
import { usdToWholeMicrodollars } from "./budget-amount.js";
import { badConfig, checks, companySource, digest, missing, read, tooLarge, type EnrollmentDeps, type Key, type Row } from "./task-stop-enrollment-common.js";

export function taskStopEconomicDigest(snapshot: CapturedTaskStop, outcome: string): string {
 const { company: _company, ...revisions } = snapshot.sourceRevisions;void _company;
 return digest({ orgId: snapshot.orgId, project: snapshot.project, agentId: snapshot.agentId,
  calculationInput: snapshot.calculationInput, effectiveStopMicrousd: snapshot.effectiveStopMicrousd,
  approvalCapMicrousd: snapshot.approvalCapMicrousd, bindingScopes: snapshot.bindingScopes, outcome, revisions });
}
const text = z.string().min(1).max(256).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
async function pages(deps: EnrollmentDeps, pk: string, index = false): Promise<Row[]> {
 const rows: Row[] = [], seen = new Set<string>();let cursor: Row | undefined;
 for (let n = 0; n < 100; n += 1) {
  const response = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName,
   ...(index ? { IndexName: WORKSPACE_PROJECT_INDEX.name, ExpressionAttributeNames: { "#partition": WORKSPACE_PROJECT_INDEX.partitionKey } } : {}),
   KeyConditionExpression: `${index ? "#partition" : "pk"} = :pk`, ExpressionAttributeValues: { ":pk": pk },
   ...(index ? {} : { ConsistentRead: true }), Limit: 50, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
  }));
  const page = z.object({ Items: z.array(z.record(z.string(), z.unknown())).max(50).optional(), LastEvaluatedKey: z.record(z.string(), z.unknown()).optional() }).safeParse(response);
  if (!page.success) throw badConfig();
  for (const row of page.data.Items ?? []) {
   if (index ? row.workspaceProject !== pk : row.pk !== pk) throw badConfig();rows.push(row);
   if (rows.length > (index ? 500 : 100)) throw tooLarge();
  }
  cursor = page.data.LastEvaluatedKey;if (cursor === undefined) return rows;
  if (typeof cursor.pk !== "string" || typeof cursor.sk !== "string" || (!index && cursor.pk !== pk) || (index && cursor.workspaceProject !== undefined && cursor.workspaceProject !== pk)) throw badConfig();
  const id = digest(cursor);if (seen.has(id)) throw badConfig();seen.add(id);
 }
 throw tooLarge();
}
export async function captureCompanyCutover(deps: EnrollmentDeps, caller: DeveloperCaller) {
 const source = await companySource(deps, caller), native: TransactItem[] = checks(deps, source.key, source.row), economic: Array<{ key: Key; digest: string }> = [];
 const identities = new Set<string>();
 function economicRow(key: Key, row: Row | undefined, fields: string[], company = false) {
  if (row !== undefined && (row.pk !== key.pk || row.sk !== key.sk || (row.orgId !== undefined && row.orgId !== caller.orgId))) throw badConfig();
  const selected = row === undefined ? undefined : Object.fromEntries(["pk", "sk", ...fields].filter(field => row[field] !== undefined).map(field => [field, row[field]]));
  native.push(...checks(deps, key, selected, fields));
  economic.push({ key, digest: digest(selected ?? null) });if (!company) identities.add(digest(key));
 }
 economicRow(source.key, source.row, ["orgId", "entityType", "policy"], true);
 const guardKey = agentGuardrailsKey(caller.orgId), guard = await read(deps, guardKey);
 if (guard === undefined) throw missing();
 const parsedGuard = AgentGuardrailsSchema.safeParse(guard.guardrails);
 if (guard.orgId !== caller.orgId || guard.entityType !== "AGENT_GUARDRAILS" || !positive(guard.revision) || !parsedGuard.success || usdToWholeMicrodollars(parsedGuard.data.maxPerRunCeilingUsd) === undefined || ["ceilingMicrousd", "maxPerRunCeilingUsd", "taskStopCeilingMicrousd"].some(field => Object.hasOwn(guard, field))) throw badConfig();
 economicRow(guardKey, guard, ["orgId", "entityType", "revision", "guardrails"]);
 let seeded = false;
 for (const kind of ["bootstrap", "upgrade"]) {
  const key = { pk: orgScoped(caller.orgId, "TASK_STOP_SEED"), sk: `V1#${kind}` }, row = await read(deps, key);
  if (row !== undefined) {
   if (row.orgId !== caller.orgId || row.entityType !== "TASK_STOP_SEED" || row.version !== 1 || row.source !== kind || !["created", "preserved"].includes(String(row.outcome)) || !positive(row.policyRevision) || row.policyRevision > source.revision) throw badConfig();seeded = true;
  }
  economicRow(key, row, ["orgId", "entityType", "version", "source", "outcome", "policyRevision"]);
 }
 if (!seeded) throw missing();
 const modelsKey = modelSourcesKey(caller.orgId), models = await read(deps, modelsKey);
 if (models !== undefined && (!positive(models.revision) || !OrgModelSourcesSchema.safeParse(Object.fromEntries(["sources", "order", "assistantModel", "chatgptPreferredModel"].filter(field => models[field] !== undefined).map(field => [field, models[field]]))).success)) throw badConfig();
 economicRow(modelsKey, models, ["entityType", "revision", "sources", "order", "credentials", "removing"]);
 const catalogs = await pages(deps, orgScoped(caller.orgId, "PROJECT_CATALOG")), directory = await pages(deps, orgScoped(caller.orgId, "AGENT_DIRECTORY"));
 if (2 * catalogs.length + directory.length + BUILTIN_AGENT_IDS.length > 80) throw tooLarge();
 const projects: string[] = [], agents = new Set<string>();
 for (const catalog of catalogs) {
  const project = text.safeParse(catalog.name);if (!project.success) throw badConfig();
  const key = orgProjectCatalogKey(caller.orgId, project.data);
  if (catalog.pk !== key.pk || catalog.sk !== key.sk || catalog.orgId !== caller.orgId || catalog.entityType !== "PROJECT_CATALOG" || !positive(catalog.latestRevision) || projects.includes(project.data)) throw badConfig();
  const aiKey = projectAiKey(caller.orgId, project.data), ai = await read(deps, aiKey), meta = await read(deps, projectMetaKey(caller.orgId, project.data));
  if (ai === undefined || ai.taskStopPolicy === undefined) throw missing();
  if (ai.orgId !== caller.orgId || ai.project !== project.data || ai.entityType !== "PROJECT_AI" || !positive(ai.revision) || !TaskStopProjectPolicySchema.safeParse(ai.taskStopPolicy).success
   || meta === undefined || meta.name !== project.data || (meta.orgId !== undefined && meta.orgId !== caller.orgId)) throw badConfig();
  projects.push(project.data);
  economicRow(key, catalog, ["orgId", "entityType", "name", "latestRevision"]);
  economicRow(aiKey, ai, ["orgId", "entityType", "project", "revision", "taskStopPolicy", "sourceOrder"]);
 }
 const ids: string[] = [...BUILTIN_AGENT_IDS];
 for (const entry of directory) {
  const id = AgentIdSchema.safeParse(entry.agentId);
  if (!id.success || isBuiltinAgentId(id.data) || entry.sk !== id.data || entry.entityType !== "AGENT_DIRECTORY" || (entry.orgId !== undefined && entry.orgId !== caller.orgId) || ids.includes(id.data)) throw badConfig();ids.push(id.data);
 }
 for (const id of ids) {
  const key = isBuiltinAgentId(id) ? builtinSettingsKey(caller.orgId, id) : agentKey(caller.orgId, id, "META"), row = await read(deps, key);
  if (row === undefined || (row.stopKind === undefined && row.maxPerRunUsd === undefined)) throw missing();
  if (row.orgId !== caller.orgId || row.agentId !== id || row.entityType !== (isBuiltinAgentId(id) ? "BUILTIN_AGENT_SETTINGS" : "AGENT") || !positive(row.revision)
   || (!isBuiltinAgentId(id) && row.status !== "active" && row.status !== "archived")
   || (row.maxPerRunUsd === undefined ? row.stopKind !== "inherit" : usdToWholeMicrodollars(row.maxPerRunUsd) === undefined || (row.stopKind !== undefined && row.stopKind !== "limited"))) throw badConfig();
  economicRow(key, row, ["orgId", "entityType", "agentId", "revision", "stopKind", "maxPerRunUsd", "status", "pinnedVersion"]);agents.add(id);
 }
 const tasks: TaskStopImpact[] = [], taskEconomics: Array<{ taskId: string; digest: string }> = [], seen = new Set<string>();let workspaces = 0;
 for (const project of projects.sort()) for (const workspace of await pages(deps, workspaceProjectIndexValue(caller.orgId, project), true)) {
  workspaces += 1;if (workspaces > 500) throw tooLarge();
  if (typeof workspace.id !== "string" || !z.string().uuid().safeParse(workspace.id).success || workspace.orgId !== caller.orgId) throw badConfig();
  const pointer = await read(deps, taskPointerKey(workspace.id));if (pointer === undefined) continue; // Standalone setup workspaces have no task.
  if (!z.string().uuid().safeParse(pointer.taskId).success) throw badConfig();
  const taskId = String(pointer.taskId);if (seen.has(taskId)) continue;seen.add(taskId);
  const raw = await read(deps, taskKey(taskId));
  if (raw === undefined || raw.orgId !== caller.orgId || raw.taskId !== taskId || raw.entityType !== "DEVELOPER_TASK" || raw.project !== project) throw badConfig();
  const task = raw as unknown as DeveloperTaskRecord;
  if (task.closedAt !== undefined || task.releasedAt !== undefined || task.workflow?.state === "COMPLETE") continue;
  if (tasks.length >= 25) throw tooLarge();
  const agentId = task.agent?.agentId ?? ROVARA_CODE_AGENT_ID;if (!agents.has(agentId)) throw missing();
  const preview = await captureTaskStopCutoverReview({ ...deps, requireScopeAccess: async () => {
   const meta = await read(deps, projectMetaKey(caller.orgId, project));if (meta?.status !== "active" || meta.archivedAt !== undefined) throw badConfig();
  } }, { orgId: caller.orgId, developerId: caller.developerId, role: "owner", project, agentId,
   ...savedTaskStopBounds(task.spendingStop), pathLimitMicrousd: taskRunLimitMicrousd(task) ?? null,
   ...(task.maxPerRunUsd === undefined ? {} : { committedMaxPerRunMicrousd: usdToWholeMicrodollars(task.maxPerRunUsd) ?? null }) });
  // Only economic native keys: task/workspace inventory is advisory, and owner evidence is separately fenced.
  native.push(...preview.sourceChecks.filter(item => item.ConditionCheck?.Key !== undefined && (identities.has(digest(item.ConditionCheck.Key)) || item.ConditionCheck.Key.pk === source.key.pk && item.ConditionCheck.Key.sk === source.key.sk)));
  const snapshot = preview.snapshot, phase = raw.activeOperationId !== undefined || workspace.activeOperationId !== undefined || workspace.state === "RUNNING" ? "running" as const : "queued" as const;
  const spend = await read(deps, taskSpendKey(caller.orgId, taskId));
  if (spend === undefined && (task.modelKeyIds?.length ?? 0) > 0) throw badConfig();
  const spent = spend === undefined ? 0 : usdToWholeMicrodollars(spend.settledUsd), baseline = usdToWholeMicrodollars(task.budgetBaselineUsd ?? 0);
  if (spent === undefined || baseline === undefined || spend !== undefined && spend.orgId !== caller.orgId) throw badConfig();
  let exempt = false;
  if (deps.agents?.modelRouting !== undefined) {
   const frozen = await readTaskRecipe(deps, taskId, caller.orgId);
   if (frozen?.modelPolicyPin !== undefined) exempt = (await captureTaskFundingProof({ ...deps, routing: deps.agents.modelRouting, chatgpt: deps.agents.stageChatgpt, now: deps.now }, {
    orgId: caller.orgId, project, models: taskFundingModelPool(frozen.modelPolicyPin, deps.agents.modelRouting.rovaraGeography), purpose: "cutover_review",
    ...(task.payer?.kind === "member" ? { payerDeveloperId: task.payer.developerId } : {}),
   })) !== undefined;
  }
  const outcome = exempt ? "exempt" : phase === "running" ? "retain_current_window" : snapshot.effectiveStopMicrousd === 0 ? "refuse_next_admission"
   : Math.max(0, spent - baseline) >= snapshot.effectiveStopMicrousd ? "stop_at_next_admission" : "retain_current_window";
  const currentCapMicrousd = usdToWholeMicrodollars(task.budgetUsd);if (currentCapMicrousd === undefined) throw badConfig();
  tasks.push({ taskId, project, phase, effectiveStopMicrousd: snapshot.effectiveStopMicrousd, approvalCapMicrousd: snapshot.approvalCapMicrousd, currentCapMicrousd, outcome });
  taskEconomics.push({ taskId, digest: taskStopEconomicDigest(snapshot, outcome) });
 }
 economic.sort((a, b) => digest(a.key).localeCompare(digest(b.key)));tasks.sort((a, b) => a.taskId.localeCompare(b.taskId));taskEconomics.sort((a, b) => a.taskId.localeCompare(b.taskId));
 // Validate company content even with no tasks; no numeric defaults are invented.
 if (!TaskStopCompanyPolicySchema.safeParse(source.row.policy).success) throw badConfig();
 const sourceDigest = digest(economic), projectionDigest = digest({ economic, taskEconomics });
 return { source, tasks, sourceDigest, digest: projectionDigest, checks: native };
}
