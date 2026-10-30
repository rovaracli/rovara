import {stageChoiceOf} from "./stage-inputs.js";
// Current server-owned process/source snapshot for G3. Read-only; no agent/list or provider fanout.
import { GetCommand,QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ModelSelectionPolicyResponseSchema,type ModelSelectionPolicyResponse,STAGE_IDS,STAGE_EDIT_RULES,STAGE_EDIT_GROUPS,ROVARA_CODE_AGENT_ID,builtinRecipe,builtinDefaultPin,recipeDigest,StoredProjectDefinitionSchema,ModelIdentifierSchema,agentXError,orgScoped,projectPk,PROJECT_REVISION_SK_PREFIX,projectSelectionKey,type AgentId,type OrgId,type RecipeOverlay,type ResolvedRecipe,type ModelIdentifier } from "@agentx/contracts";
import { bedrockClaudeModelIds } from "@agentx/model-runtime/catalog";
import { resolveAgent,type AgentStore,type AgentRecord } from "../agents/store.js";
import { readGuardrailsWithRevision } from "../agents/guardrails.js";
import { defaultWorkerModel } from "../agents/dispatch.js";
import { readProjectPlaybookState } from "../playbook/project-playbook-store.js";
import { readModelSelectionPolicy,type ModelPolicyReader } from "./policy-store.js";
import { readStageModelEvidence,type StageEvidenceDependencies } from "./evidence.js";
import type { StageModelSnapshot,StageModelCaller } from "./read.js";
export interface StageSnapshotDependencies extends ModelPolicyReader,StageEvidenceDependencies {store:AgentStore|undefined}
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The model settings could not be read. Reload and try again.");
async function draftLayer(deps:StageSnapshotDependencies,orgId:OrgId,project:string):Promise<AgentRecord> {
 if(deps.store===undefined) throw unavailable();
 const matches:AgentRecord[]=[];let cursor:Record<string,unknown>|undefined;
 for(let page=0;page<2;page++) {
  const found=await deps.documentClient.send(new QueryCommand({TableName:deps.tableName,KeyConditionExpression:"pk = :pk",ExpressionAttributeValues:{":pk":orgScoped(orgId,"AGENT_DIRECTORY")},Limit:16,ConsistentRead:true,...(cursor===undefined?{}:{ExclusiveStartKey:cursor})})) as {Items?:Record<string,unknown>[];LastEvaluatedKey?:Record<string,unknown>};
  if((found.Items?.length??0)>16) throw unavailable();
  for(const row of found.Items??[]) {
   if(typeof row.sk!=="string" || !/^agt_[a-z0-9]{20}$/u.test(row.sk)) throw unavailable();
   const record=await deps.store.get(orgId,row.sk);
   if(record?.purpose==="process" && record.owner.kind==="project" && record.owner.project===project && record.status==="active") matches.push(record);
  }
  cursor=found.LastEvaluatedKey;if(cursor===undefined) break;
 }
 // A capped discovery is unavailable even when a match was found: another match could be beyond the cap.
 if(cursor!==undefined || matches.length!==1) throw unavailable();
 return matches[0]!;
}
/** Trusted publish/rollback input, resolved by the server from its immutable draft/version. Never an HTTP body. */
export interface StagePublicationRecipe {record:AgentRecord;recipe:ResolvedRecipe;overlay:RecipeOverlay;version?:number}
export async function loadStageModelSnapshot(deps:StageSnapshotDependencies,caller:StageModelCaller,project:string,draftRevision?:number,publication?:StagePublicationRecipe,policyPreview?:ModelSelectionPolicyResponse):Promise<StageModelSnapshot> {
 const orgId=caller.orgId;
 const raw=await deps.documentClient.send(new QueryCommand({TableName:deps.tableName,KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":projectPk(orgId,project),":prefix":PROJECT_REVISION_SK_PREFIX},ScanIndexForward:false,Limit:1,ConsistentRead:true})) as {Items?:Record<string,unknown>[]};
 const record=raw.Items?.[0];const definition=StoredProjectDefinitionSchema.safeParse(record?.definition);
 if(!definition.success || definition.data.name!==project || typeof record?.registeredAt!=="string") throw unavailable();
 const playbookState=await readProjectPlaybookState(deps,orgId,project);
 if(playbookState.unreadable)throw unavailable();
 const playbook=playbookState.playbook;
 const pin=deps.store===undefined?builtinDefaultPin(ROVARA_CODE_AGENT_ID):await deps.store.pinnedBuiltinVersion(orgId,ROVARA_CODE_AGENT_ID);
 let recipe:ResolvedRecipe=deps.store===undefined?builtinRecipe(ROVARA_CODE_AGENT_ID,pin):deps.store.builtinRecipe(ROVARA_CODE_AGENT_ID,pin);
 let agentId:AgentId=ROVARA_CODE_AGENT_ID,version:number|undefined=pin,overlay:RecipeOverlay|undefined;
 if(publication!==undefined) {
  const layer=publication.record;
  if(layer.orgId!==orgId || layer.status!=="active" || layer.purpose!=="process" || layer.owner.kind!=="project" || layer.owner.project!==project) throw unavailable();
  recipe=publication.recipe;overlay=publication.overlay;agentId=layer.agentId;version=publication.version;
 } else if(playbook.defaultProcess.kind==="project_process" || draftRevision!==undefined) {
  if(deps.store===undefined) throw unavailable();
  const layer=playbook.defaultProcess.kind==="project_process"?await deps.store.get(orgId,playbook.defaultProcess.agentId):await draftLayer(deps,orgId,project);
  if(layer===undefined || layer.status!=="active" || layer.purpose!=="process" || layer.owner.kind!=="project" || layer.owner.project!==project) throw unavailable();
  agentId=layer.agentId;
  if(draftRevision!==undefined) {
   const draft=await deps.store.getDraft(orgId,agentId);if(draft===undefined || draft.revision!==draftRevision) throw agentXError("DRAFT_STALE","This process draft changed. Reload and try again.");
   recipe=await resolveAgent(deps.store,orgId,agentId,"draft",{draft});overlay=draft.overlay;version=undefined;
  } else {
   if(layer.currentVersion===undefined) throw unavailable();version=layer.currentVersion;
   recipe=await resolveAgent(deps.store,orgId,agentId,version);overlay=(await deps.store.getVersion(orgId,agentId,version))?.overlay;
  }
 }
 const currentPolicy=await readModelSelectionPolicy(deps,orgId),storedGuardrails=await readGuardrailsWithRevision(deps,orgId);
 // Trusted read-only preview overlay; all source/recipe evidence is still loaded normally.
 const policy=policyPreview===undefined?currentPolicy:ModelSelectionPolicyResponseSchema.parse(policyPreview);
 if(policy.revision!==currentPolicy.revision)throw unavailable();
 const guardrails=storedGuardrails.guardrails;
 const selectionRow=await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:projectSelectionKey(orgId,project),ConsistentRead:true})) as {Item?:Record<string,unknown>};
 const selected=selectionRow.Item===undefined?undefined:ModelIdentifierSchema.safeParse(selectionRow.Item.model);
 if(selected!==undefined && !selected.success) throw unavailable();
 const pool=new Map<string,ModelIdentifier>();const add=(model:ModelIdentifier|undefined)=>{if(model!==undefined) pool.set(`${model.provider}\0${model.modelId}`,{provider:model.provider,modelId:model.modelId});};
 if(definition.data.models!==undefined) definition.data.models.approved.forEach(add);
 else bedrockClaudeModelIds(deps.routing.rovaraGeography??"us").forEach(modelId=>add({provider:"amazon-bedrock",modelId}));
 const rows=STAGE_IDS.map(stage=>{
  const step=recipe.steps.find(step=>step.kind===STAGE_EDIT_RULES[stage].stepKind);
  const rawOwn=step===undefined?undefined:overlay?.steps?.[step.id];
  const own=stageChoiceOf(rawOwn,stage,recipe);
  const inherited=step===undefined?undefined:stageChoiceOf(step.settings,stage,recipe);
  const group=STAGE_EDIT_GROUPS.find(group=>group.some(member=>member===stage))!;
  const configured=group.map(member=>policy.stepOverrides[member]).filter(row=>row!==undefined);
  const company=configured[0];
  if(configured.some(row=>JSON.stringify(row)!==JSON.stringify(company))) throw unavailable();
  for(const choice of [own,inherited,company]){add(choice?.model);add(choice?.fallbackModel);}
  const projectSelection=selected?.success?selected.data:undefined;add(projectSelection);add(definition.data.models?.default);
  const defaults=inherited===undefined&&company===undefined?undefined:{...inherited,...company};
  // Recipe null clears inherited fallback; a lock is kept separately and cannot be cleared here.
  if(defaults!==undefined && rawOwn?.fallbackModel===null) delete defaults.fallbackModel;
  return {stage,own,defaults,company,projectSelection};
 });
 if(pool.size>23) throw unavailable();
 const evidence=await readStageModelEvidence(deps,{orgId,project,models:[...pool.values()],payerDeveloperId:caller.developerId});
 return {orgId,project,processChain:recipe.chain,playbookSnapshot:{exists:playbookState.exists,revision:playbook.revision,defaultProcess:playbook.defaultProcess},selectionSnapshot:selected?.success?{exists:true,model:selected.data}:{exists:false},guardrailsRevision:storedGuardrails.revision,registeredAt:record.registeredAt,companyRevision:policy.revision,projectRevision:definition.data.revision,canEdit:false,process:{agentId,...(version===undefined?{}:{version}),...(draftRevision===undefined?{}:{draftRevision}),digest:recipeDigest(recipe)},stages:rows.map(({stage,own,defaults,company,projectSelection})=>({orgId,stage,...evidence,forbidden:guardrails.forbiddenModels,approved:definition.data.models?.approved,projectChoice:own,companyLock:company?.locked===true?company:undefined,companyDefault:company?.locked===true?undefined:defaults,projectSelection,projectDefault:definition.data.models?.default,builtinDefault:defaultWorkerModel(deps.routing.rovaraGeography),requireDifferentVendor:guardrails.requireCrossCompanyReview&&(stage==="code_review"||stage==="security_review"),allowLegacyDefaultFallback:true}))};
}
