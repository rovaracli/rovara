import {frozenRecipeModelInputs} from "./stage-inputs.js";
// The existing TASK_RECIPE item owns the model policy snapshot. No per-operation repinning.
import {StageModelApprovalProofSchema,parseStageModelApprovalProof,processApprovalRecipeDigest,type StageModelApprovalProof} from "./approval-proof.js";
import {z} from "zod";
import {GetCommand,QueryCommand} from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, AgentIdSchema, ProjectModelsSchema, ModelSelectionSchema, StageIdSchema, StageModelChoiceSchema, projectSelectionKey, ModelSelectionPolicyResponseSchema, StoredProjectDefinitionSchema, PROJECT_REVISION_SK_PREFIX, projectPk, projectRevisionKey, modelSourcesKey, recipeDigest, agentXError, type OrgId, type AgentId, type ResolvedRecipe, type RecipeOverlay } from "@rovara-code/contracts";
import { orgSettingsKey } from "@agentx/cloud-contracts";
import {readModelSelectionPolicy,inactiveModelSourcesRevision,type ModelPolicyReader} from "./policy-store.js";
import {effectiveSources,type RoutingDependencies} from "../model-sources/routing.js";
import type {TransactItem} from "../agents/table-writes.js";
const Policy=ModelSelectionPolicyResponseSchema.omit({candidates:true});
const FrozenInputs=z.object({projectRevision:z.number().int().min(1),projectModels:ProjectModelsSchema.optional(),projectSelection:ModelSelectionSchema.optional(),projectChoices:z.partialRecord(StageIdSchema,StageModelChoiceSchema),recipeDefaults:z.partialRecord(StageIdSchema,StageModelChoiceSchema),clearedFallbacks:z.array(StageIdSchema).max(7),/** Set when the task is pinned: its review steps default to a different company's model (owner decision 2026-11-02). A task pinned before that keeps resolving as it did. */reviewDefault:z.literal("different_company").optional()}).strict();
const Pin=z.object({frozenInputs:FrozenInputs.optional(),approvalProof:StageModelApprovalProofSchema.optional(),version:z.literal(1),orgId:OrgIdSchema,project:z.string().min(1).max(63),registeredAt:z.string().datetime(),processAgentId:AgentIdSchema,recipeDigest:z.string().regex(/^[a-f0-9]{64}$/u),policy:Policy,sourcesRevision:z.number().int().min(0)}).strict();
export type TaskModelPolicyPin=z.infer<typeof Pin>;
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The task's pinned model policy could not be verified.");
export function parseTaskModelPolicyPin(raw:unknown,binding:{orgId:OrgId;project?:string;agentId?:AgentId;recipe:ResolvedRecipe;digest:string}):TaskModelPolicyPin {
 const parsed=Pin.safeParse(raw);
 if(!parsed.success||parsed.data.orgId!==binding.orgId||parsed.data.recipeDigest!==binding.digest||binding.digest!==recipeDigest(binding.recipe)||binding.project!==undefined&&parsed.data.project!==binding.project||binding.agentId!==undefined&&parsed.data.processAgentId!==binding.agentId) throw unavailable();
 if(parsed.data.approvalProof!==undefined) parseStageModelApprovalProof(parsed.data.approvalProof,{orgId:binding.orgId,project:parsed.data.project,registeredAt:parsed.data.registeredAt,agentId:parsed.data.processAgentId,recipeDigest:processApprovalRecipeDigest(binding.recipe,parsed.data.processAgentId)});
 return parsed.data;
}
export async function prepareTaskModelPolicyPin(deps:ModelPolicyReader&{modelRouting?:RoutingDependencies},input:{orgId:OrgId;project:string;agentId:AgentId;recipe:ResolvedRecipe;digest:string;projectRevision?:number;projectOverlay?:RecipeOverlay;approvalProof?:StageModelApprovalProof}):Promise<TaskModelPolicyPin> {
 const [policy,sources,response,selection]=await Promise.all([readModelSelectionPolicy(deps,input.orgId),effectiveSources(deps.modelRouting??{},input.orgId,input.project),input.projectRevision===undefined
  ?deps.documentClient.send(new QueryCommand({TableName:deps.tableName,KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":projectPk(input.orgId,input.project),":prefix":PROJECT_REVISION_SK_PREFIX},ScanIndexForward:false,Limit:1,ConsistentRead:true})) as Promise<{Items?:Record<string,unknown>[];Item?:Record<string,unknown>}>
  :deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:projectRevisionKey(input.orgId,input.project,input.projectRevision),ConsistentRead:true})) as Promise<{Item?:Record<string,unknown>;Items?:Record<string,unknown>[]}>,
  deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:projectSelectionKey(input.orgId,input.project),ConsistentRead:true})) as Promise<{Item?:Record<string,unknown>}>]);
 const row=input.projectRevision===undefined?response.Items?.[0]:response.Item,definition=StoredProjectDefinitionSchema.safeParse(row?.definition);
 if(!definition.success||definition.data.name!==input.project||typeof row?.registeredAt!=="string") throw unavailable();
 const key=projectRevisionKey(input.orgId,input.project,definition.data.revision);
 if(row.pk!==key.pk||row.sk!==key.sk||input.projectRevision!==undefined&&input.projectRevision!==definition.data.revision) throw unavailable();
 const selected=selection.Item===undefined?undefined:ModelSelectionSchema.safeParse(selection.Item.model);
 if(selected!==undefined&&!selected.success)throw unavailable();
 const frozenInputs={projectRevision:definition.data.revision,...(definition.data.models===undefined?{}:{projectModels:definition.data.models}),...(selected?.success?{projectSelection:selected.data}:{}),...frozenRecipeModelInputs(input.recipe,input.projectOverlay),reviewDefault:"different_company" as const};
 return parseTaskModelPolicyPin({frozenInputs,version:1,orgId:input.orgId,project:input.project,registeredAt:row.registeredAt,processAgentId:input.agentId,recipeDigest:input.digest,policy,...(input.approvalProof===undefined?{}:{approvalProof:input.approvalProof}),sourcesRevision:sources?.stored.revision??await inactiveModelSourcesRevision(deps,input.orgId)},{orgId:input.orgId,project:input.project,agentId:input.agentId,recipe:input.recipe,digest:input.digest});
}
export function taskModelPolicyAdmissionChecks(tableName:string,pin:TaskModelPolicyPin):TransactItem[] {
 return ([[orgSettingsKey(pin.orgId,"MODEL_SELECTION_POLICY"),pin.policy.revision],[modelSourcesKey(pin.orgId),pin.sourcesRevision]] as const).map(([Key,revision])=>({ConditionCheck:{TableName:tableName,Key,...(revision===0?{ConditionExpression:"attribute_not_exists(pk)"}:{ConditionExpression:"#revision = :revision",ExpressionAttributeNames:{"#revision":"revision"},ExpressionAttributeValues:{":revision":revision}})}}));
}
