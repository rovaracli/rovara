// Conditions for the existing project selection Put; no write, approval or audit emitter here.
import {projectPlaybookKey,agentKey,builtinSettingsKey,builtinDefaultPin,isBuiltinAgentId,AgentIdSchema,agentXError,type ResolvedRecipe,type OrgId} from "@agentx/contracts";
import type {StageModelSnapshot} from "./read.js";
import type {TransactItem} from "../agents/table-writes.js";
export function projectSelectionWriteCondition(snapshot:NonNullable<StageModelSnapshot["selectionSnapshot"]>){
 return snapshot.exists?{ConditionExpression:"#model = :model",ExpressionAttributeNames:{"#model":"model"},ExpressionAttributeValues:{":model":snapshot.model}}:{ConditionExpression:"attribute_not_exists(pk)"};
}
export function projectSelectionPlaybookCheck(tableName:string,orgId:OrgId,project:string,snapshot:NonNullable<StageModelSnapshot["playbookSnapshot"]>):TransactItem{
 return {ConditionCheck:{TableName:tableName,Key:projectPlaybookKey(orgId,project),...(snapshot.exists?{ConditionExpression:"#revision = :revision AND #process = :process",ExpressionAttributeNames:{"#revision":"revision","#process":"defaultProcess"},ExpressionAttributeValues:{":revision":snapshot.revision,":process":snapshot.defaultProcess}}:{ConditionExpression:"attribute_not_exists(pk)"})}};
}

/** The current process version is immutable, but choosing another version or archiving it is not. */
export function projectSelectionProcessCheck(tableName:string,orgId:OrgId,project:string,process:StageModelSnapshot["process"]):TransactItem{
 const id=AgentIdSchema.parse(process.agentId),version=process.version;
 if(process.draftRevision!==undefined||version===undefined||!Number.isSafeInteger(version)||version<1)throw agentXError("RUNTIME_UNAVAILABLE","The current process could not be verified.");
 if(isBuiltinAgentId(id))return {ConditionCheck:{TableName:tableName,Key:builtinSettingsKey(orgId,id),ConditionExpression:version===builtinDefaultPin(id)?"attribute_not_exists(#pin) OR #pin = :pin":"#pin = :pin",ExpressionAttributeNames:{"#pin":"pinnedVersion"},ExpressionAttributeValues:{":pin":version}}};
 return {ConditionCheck:{TableName:tableName,Key:agentKey(orgId,id,"META"),ConditionExpression:"#org = :org AND #purpose = :purpose AND #status = :status AND #owner = :owner AND #version = :version",ExpressionAttributeNames:{"#org":"orgId","#purpose":"purpose","#status":"status","#owner":"owner","#version":"currentVersion"},ExpressionAttributeValues:{":org":orgId,":purpose":"process",":status":"active",":owner":{kind:"project",project},":version":version}}};
}

/** A published parent stays on its pinned version; only its live availability can invalidate it. */
export function projectSelectionAncestorChecks(tableName:string,orgId:OrgId,root:string,chain:ResolvedRecipe["chain"]):TransactItem[]{
 const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The current process could not be verified.");
 if(chain.length<1||chain.length>4||chain.at(-1)?.agentId!==root||new Set(chain.map(layer=>layer.agentId)).size!==chain.length)throw unavailable();
 const checks:TransactItem[]=[];
 for(const layer of chain){
  const id=AgentIdSchema.parse(layer.agentId);
  if(layer.builtin!==isBuiltinAgentId(id)||typeof layer.version!=="number"||!Number.isSafeInteger(layer.version)||layer.version<1)throw unavailable();
  if(layer.builtin||id===root)continue;
  checks.push({ConditionCheck:{TableName:tableName,Key:agentKey(orgId,id,"META"),ConditionExpression:"#org = :org AND #status = :status",ExpressionAttributeNames:{"#org":"orgId","#status":"status"},ExpressionAttributeValues:{":org":orgId,":status":"active"}}});
 }
 return checks;
}
