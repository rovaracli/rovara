import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import type { TaskModelPolicyPin } from "../model-selection/task-pin.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AuditEventInputSchema, auditEventId, modelSourcesKey, orgSettingsKey, canonicalModelName, type OrgId, type ModelIdentifier, type AuditActor } from "@agentx/contracts";
import { effectiveSources, type RoutingDependencies } from "../model-sources/routing.js";
import { readStageModelEvidence, type StageEvidenceDependencies } from "../model-selection/evidence.js";
import { stageCandidateVerified } from "../model-selection/resolver.js";
import { auditPendingItem } from "../audit/outbox.js";
import type { TransactItem } from "../agents/table-writes.js";
const Evidence = z.object({ sourceId: z.string().regex(/^(src_[a-z0-9]{20}|personal-chatgpt)$/), kind: z.enum(["stored_key", "tested_bedrock_role", "chatgpt_connection"]), payerDeveloperId: z.string().optional(), connectionRevision: z.string().optional() }).strict();
export const TaskFundingProofSchema = z.object({ version: z.literal(1), orgId: z.string(), project: z.string(), sourcesRevision: z.number().int().nonnegative(), sources: z.array(Evidence).min(1).max(64) }).strict();
export type TaskFundingProof = z.infer<typeof TaskFundingProofSchema>;
export type FundingDependencies = StageEvidenceDependencies & { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string };
/** Controller-approved strict shortcut: no catalog source anywhere in the
 * effective order. This proves every frozen stage without forecasting references.
 * Real model evidence is still required; empty/unverified sources never exempt. */
export async function captureTaskFundingProof(deps: FundingDependencies, input: { orgId: OrgId; project: string; models: readonly ModelIdentifier[]; purpose?: "cutover_review"; payerDeveloperId?: string; admittedProof?: TaskFundingProof }): Promise<TaskFundingProof | undefined> {
 if (deps.routing.sources === undefined) return undefined;
 const policy = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgSettingsKey(input.orgId, "TASK_STOP_POLICY"), ConsistentRead: true })) as { Item?: { entityType?: string; revision?: number; enrollment?: { version?: number; state?: string } } };
 if (input.purpose !== "cutover_review" && input.admittedProof === undefined && (policy.Item?.entityType !== "ORG_TASK_STOP_POLICY" || !Number.isSafeInteger(policy.Item.revision) || Number(policy.Item.revision) < 1 || policy.Item.enrollment?.version !== 1 || policy.Item.enrollment.state !== "enabled")) return undefined;
 if (input.admittedProof !== undefined && (TaskFundingProofSchema.parse(input.admittedProof).orgId !== input.orgId || input.admittedProof.project !== input.project)) return undefined;
 const sources = await effectiveSources(deps.routing, input.orgId, input.project);
 if (sources === undefined || sources.order.length === 0 || sources.order.includes("rovara")) return undefined;
 const pool = new Map(input.models.map(model => [`${model.provider}\0${model.modelId}`, model]));
 if (sources.order.includes("personal-chatgpt") && input.payerDeveloperId !== undefined && deps.chatgpt !== undefined) {
  const view = await deps.chatgpt.view(input.payerDeveloperId);
  for (const modelId of view.models ?? []) pool.set(`openai\0${modelId}`, { provider: "openai", modelId });
 }
 if (pool.size > 23) return undefined;
 const rows = await Promise.all([false, true].map(excludePersonalPlan => readStageModelEvidence(deps, { ...input, models: [...pool.values()], excludePersonalPlan })));
 if (rows.some(row => row.sourcesRevision !== sources.stored.revision)) return undefined;
 const evidence = new Map<string, z.infer<typeof Evidence>>();
 for (const row of rows) for (const candidate of row.candidates) {
  if (!stageCandidateVerified({ orgId: input.orgId, stage: "build", sourcesRevision: row.sourcesRevision, candidates: row.candidates, forbidden: [], payerDeveloperId: input.payerDeveloperId, connectionRevision: row.connectionRevision }, candidate)) continue;
  const proof = candidate.evidence;
  // N8: a company's own model endpoint can serve a task, but it never exempts the task from Rovara's spending stop: no proof is captured, so the usual stop rules apply.
  if (proof === undefined || proof.kind === "rovara_catalog" || proof.kind === "qualified_endpoint") return undefined;
  evidence.set(candidate.sourceId, Evidence.parse({ sourceId: candidate.sourceId, kind: proof.kind, ...(proof.payerDeveloperId === undefined ? {} : { payerDeveloperId: proof.payerDeveloperId }), ...(proof.connectionRevision === undefined ? {} : { connectionRevision: proof.connectionRevision }) }));
 }
 if (evidence.size === 0) return undefined;
 return TaskFundingProofSchema.parse({ version: 1, orgId: input.orgId, project: input.project, sourcesRevision: sources.stored.revision, sources: [...evidence.values()] });
}
export function fundingRevisionCheck(tableName: string, proof: TaskFundingProof): TransactItem {
 return { ConditionCheck: { TableName: tableName, Key: modelSourcesKey(proof.orgId), ...(proof.sourcesRevision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#fundingRevision = :fundingRevision", ExpressionAttributeNames: { "#fundingRevision": "revision" }, ExpressionAttributeValues: { ":fundingRevision": proof.sourcesRevision } }) } };
}
export function fundingAuditItems(tableName: string, proof: TaskFundingProof, input: { taskId: string; occurrence: string; actor: AuditActor; at: number }): TransactItem[] {
 return proof.sources.map(source => {
  const event = AuditEventInputSchema.parse({ eventId: auditEventId("spending.stop_exempted", `${input.occurrence}:${source.sourceId}`), orgId: proof.orgId, action: "spending.stop_exempted", actor: input.actor, target: { kind: "task", id: input.taskId }, occurredAt: new Date(input.at).toISOString(), facts: { sourceId: source.sourceId, sourceKind: source.kind, sourcesRevision: proof.sourcesRevision, ...(source.payerDeveloperId === undefined ? {} : { payerDeveloperId: source.payerDeveloperId }), ...(source.connectionRevision === undefined ? {} : { connectionRevision: source.connectionRevision }) } });
  return { Put: { TableName: tableName, Item: auditPendingItem(event, input.at), ConditionExpression: "attribute_not_exists(pk)" } };
 });
}
/** Current actual source evidence is authoritative, including after a revision
 * change. Never treat an admission flag or a missing route as a mint exemption. */
export async function actualCompanyFunding(deps: FundingDependencies, proof: TaskFundingProof, input: { sourceId: string; model: ModelIdentifier; payerDeveloperId?: string }): Promise<TaskFundingProof | undefined> {
 if (!/^src_[a-z0-9]{20}$/.test(input.sourceId)) return undefined;
 const sources = await effectiveSources(deps.routing, proof.orgId, proof.project);
 if (sources === undefined || !sources.order.includes(input.sourceId)) return undefined;
 // The operation already chose its actual route. Verify that source from the
 // server-read snapshot, rather than selecting today's first-priority source.
 // The returned revision is fenced in the native key-record transaction.
 const routing: RoutingDependencies = { ...deps.routing, sources: { read: async () => sources.stored }, projectSourceOrder: async () => [input.sourceId] };
 const live = await readStageModelEvidence({ ...deps, routing }, { orgId: proof.orgId, project: proof.project, models: [input.model], payerDeveloperId: input.payerDeveloperId, excludePersonalPlan: true });
 const found = live.candidates.find(candidate => candidate.sourceId === input.sourceId && canonicalModelName(candidate.model) === canonicalModelName(input.model));
 if (found?.evidence === undefined || !stageCandidateVerified({ orgId: proof.orgId, stage: "build", ...live, forbidden: [] }, found) || !["stored_key", "tested_bedrock_role"].includes(found.evidence.kind)) return undefined;
 return TaskFundingProofSchema.parse({ ...proof, sourcesRevision: live.sourcesRevision, sources: [{ sourceId: found.sourceId, kind: found.evidence.kind }] });
}

export function taskFundingModelPool(pin: TaskModelPolicyPin, geography: RoutingDependencies["rovaraGeography"] = "us"): ModelIdentifier[] {
 const models = new Map<string, ModelIdentifier>();
 const add = (model: ModelIdentifier | undefined) => { if (model !== undefined) models.set(`${model.provider}\0${model.modelId}`, model); };
 const frozen = pin.frozenInputs;if (frozen === undefined) return [];
 if (frozen.projectModels === undefined) bedrockClaudeModelIds(geography).forEach(modelId => add({ provider: "amazon-bedrock", modelId }));else frozen.projectModels.approved.forEach(add);
 add(frozen.projectModels?.default);add(frozen.projectSelection);
 for (const rows of [frozen.projectChoices, frozen.recipeDefaults, pin.policy.stepOverrides]) for (const choice of Object.values(rows)) {add(choice?.model);add(choice?.fallbackModel);}
 return [...models.values()];
}
