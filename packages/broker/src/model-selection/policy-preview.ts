import {takeRateAt} from "../developer/page-comments.js";
import {sealCursor,openCursor,cursorKeyOf} from "../agent-sessions/read.js";
// Bounded read-only company proposal preview. A page is never a count or complete impact inventory.
import {createHash} from "node:crypto";
import {QueryCommand} from "@aws-sdk/lib-dynamodb";
import {z} from "zod";
import {ModelPolicyPreviewRequestSchema,ModelPolicyPreviewResponseSchema,canonicalJson,agentXError,orgProjectCatalogPk,orgScoped,type ModelSelectionPolicyResponse} from "@agentx/contracts";
import {requireCompanyModelPolicyAuthority} from "./company-read.js";
import {readModelSelectionPolicy,type ModelPolicyReader} from "./policy-store.js";
import {validateStageChoices,type StageModelSnapshot,type StageModelCaller} from "./read.js";
export interface ModelPolicyPreviewDependencies extends ModelPolicyReader {
 cursorKey?:string;
 now():number;
 loadSnapshot(caller:StageModelCaller,project:string,policy?:ModelSelectionPolicyResponse):Promise<StageModelSnapshot>;
}
const CursorAfter=z.string().regex(/^PROJECT#[a-z0-9][a-z0-9_-]{0,62}$/u);
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The model policy preview could not be read. Reload and try again.");
const invalid=()=>agentXError("CONFIG_INVALID","The model policy preview request is invalid.");
function identity(snapshot:StageModelSnapshot){return canonicalJson({orgId:snapshot.orgId,project:snapshot.project,registeredAt:snapshot.registeredAt??null,projectRevision:snapshot.projectRevision,companyRevision:snapshot.companyRevision,process:snapshot.process,selection:snapshot.selectionSnapshot??null,playbook:snapshot.playbookSnapshot??null,guardrailsRevision:snapshot.guardrailsRevision??null,sources:snapshot.stages.map(row=>[row.stage,row.sourcesRevision])});}
export async function previewCompanyModelPolicy(deps:ModelPolicyPreviewDependencies,caller:StageModelCaller,raw:unknown){
 const parsed=ModelPolicyPreviewRequestSchema.safeParse(raw);if(!parsed.success)throw invalid();const body=parsed.data;
 await requireCompanyModelPolicyAuthority(deps,caller);
 const policy=await readModelSelectionPolicy(deps,caller.orgId);
 if(policy.revision!==body.expectedRevision)throw agentXError("POLICY_STALE","The company model policy changed. Reload and try again.");
 const proposalDigest=createHash("sha256").update(canonicalJson(body.stepOverrides)).digest("hex");
 const pk=orgProjectCatalogPk(caller.orgId),context=`model-policy-preview:v1:${pk}:${policy.revision}:${proposalDigest}`;
 try{cursorKeyOf(deps);}catch{throw unavailable();}
 let after:string|undefined;
 if(body.cursor!==undefined){try{after=CursorAfter.parse(openCursor(deps,caller,context,body.cursor));}catch{throw invalid();}}
 // Each admitted page can load ten snapshots. Bound that work before catalog or snapshot reads.
 if(!await takeRateAt(deps,{pk:orgScoped(caller.orgId,"MODEL_POLICY_PREVIEW_RATE"),sk:caller.developerId},5,60_000))throw agentXError("TOO_MANY_REQUESTS","Too many model policy previews. Try again in a minute.");
 let page:{Items?:Record<string,unknown>[];LastEvaluatedKey?:Record<string,unknown>};
 try{page=await deps.documentClient.send(new QueryCommand({TableName:deps.tableName,KeyConditionExpression:"pk = :pk AND begins_with(sk, :prefix)",ExpressionAttributeValues:{":pk":pk,":prefix":"PROJECT#"},Limit:5,ConsistentRead:true,...(after===undefined?{}:{ExclusiveStartKey:{pk,sk:after}})})) as typeof page;}catch{throw unavailable();}
 if((page.Items?.length??0)>5)throw unavailable();
 const projects=[];
 for(const row of page.Items??[]){
  if(typeof row.name!=="string"||!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(row.name)||row.pk!==pk||row.sk!==`PROJECT#${row.name}`||row.entityType!=="PROJECT_CATALOG"||row.orgId!==undefined&&row.orgId!==caller.orgId)throw unavailable();
  const project=row.name;
  try{
   const before=await deps.loadSnapshot(caller,project),next=await deps.loadSnapshot(caller,project,{...policy,stepOverrides:body.stepOverrides});
   if(before.orgId!==caller.orgId||before.project!==project||before.companyRevision!==policy.revision||identity(before)!==identity(next))throw unavailable();
   const validate=(snapshot:StageModelSnapshot)=>validateStageChoices({now:()=>deps.now(),projectFor:async()=>({name:project,canEdit:true}),snapshot:async()=>snapshot},caller,project,{});
   const prior=await validate(before),proposed=await validate(next);
   const reasonCodes=[...new Set(proposed.stages.flatMap(stage=>stage.kind==="refusal"?[stage.code]:[]))];
   projects.push({project,impact:!proposed.ok?"blocked" as const:canonicalJson(prior.stages)===canonicalJson(proposed.stages)?"unchanged" as const:"changed" as const,reasonCodes});
  }catch{projects.push({project,impact:"unavailable" as const,reasonCodes:[]});}
 }
 let nextCursor:string|undefined;
 if(page.LastEvaluatedKey!==undefined){const key=page.LastEvaluatedKey;if(key.pk!==pk||typeof key.sk!=="string"||!CursorAfter.safeParse(key.sk).success)throw unavailable();nextCursor=sealCursor(deps,caller,context,key.sk);}
 const current=await readModelSelectionPolicy(deps,caller.orgId);if(current.revision!==policy.revision)throw agentXError("POLICY_STALE","The company model policy changed. Reload and try again.");
 await requireCompanyModelPolicyAuthority(deps,caller);
 return ModelPolicyPreviewResponseSchema.parse({version:1,checkedAt:new Date(deps.now()).toISOString(),policyRevision:policy.revision,mayBeIncomplete:true,projects,...(nextCursor===undefined?{}:{nextCursor})});
}
