import {createHash} from "node:crypto";
import {z} from "zod";
import {commit,readRequest} from "../agents/table-writes.js";
// Shared server-only project selection writer. HTTP adapters supply authenticated identities, never permission flags.
import {GetCommand,TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import {agentRequestKey,INDEX_EXPIRY_ATTRIBUTE,ModelIdentifierSchema,orgMemberKey,OrgRoleSchema,projectAllows,projectSelectionKey,projectRevisionKey,canonicalJson,agentXError,type OrgId} from "@agentx/contracts";
import type {ApprovalDependencies} from "../agents/approvals.js";
import {requireSafeProjectModelSelection} from "./read.js";
import {loadStageModelSnapshot} from "./snapshot.js";
import {modelSelectionRevisionChecks} from "./policy-store.js";
import {projectSelectionWriteCondition,projectSelectionPlaybookCheck,projectSelectionProcessCheck,projectSelectionAncestorChecks} from "./selection-inputs.js";
import {projectModelSelectionAuthorityChecks} from "./authority.js";
import {modelSelectionAuditEvent} from "../playbook/project-settings-audit.js";
import {auditActorOf} from "../audit/plan3-hooks.js";
import {tryAuditEvents,auditPending} from "../audit/outbox.js";
import {flushAuditEvents} from "../audit/flush.js";
const Receipt=z.object({model:ModelIdentifierSchema}).strict();
export interface ProjectSelectionWriteInput {orgId:OrgId;project:string;signedInId:string;developerId:string;model:unknown;surface:"slack"|"cli";requestId:string}
export async function writeProjectModelSelection(deps:ApprovalDependencies,input:ProjectSelectionWriteInput){
 const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The model settings could not be verified. Reload and try again.");
 const caller={orgId:input.orgId,developerId:input.developerId};
 const result=await requireSafeProjectModelSelection({now:deps.now,projectFor:async()=>{
  const row=(await deps.documentClient.send(new GetCommand({TableName:deps.tableName,Key:orgMemberKey(input.orgId,input.developerId),ConsistentRead:true})) as {Item?:Record<string,unknown>}).Item;
  const role=OrgRoleSchema.safeParse(row?.role);
  if(!role.success||row?.orgId!==input.orgId||row.developerId!==input.developerId)throw agentXError("FORBIDDEN","Your company access changed.");
  const projectRole=await deps.projectMembers.roleOf(input.orgId,input.project,{developerId:input.developerId,orgRole:role.data});
  return {name:input.project,canEdit:projectRole!==undefined&&projectAllows(projectRole,"edit_settings")};
 },snapshot:()=>loadStageModelSnapshot({documentClient:deps.documentClient,tableName:deps.tableName,store:deps.store,now:deps.now,routing:deps.modelRouting??{},chatgpt:deps.stageChatgpt},caller,input.project)},caller,input.project,input.model);
 const context=result.writeContext;
 if(context.registeredAt===undefined||context.guardrailsRevision===undefined||context.playbook===undefined||context.selection===undefined||context.chain===undefined||deps.audit===undefined)throw unavailable();
 const authority=await projectModelSelectionAuthorityChecks(deps,{...input,registeredAt:context.registeredAt});
 const projectKey=projectRevisionKey(input.orgId,input.project,context.projectRevision);
 if(!authority.some(item=>item.ConditionCheck!==undefined&&canonicalJson(item.ConditionCheck.Key)===canonicalJson(projectKey)))throw unavailable();
 const reply={model:result.model};
 const fingerprint=createHash("sha256").update(canonicalJson({action:"project.model_selection",version:1,orgId:input.orgId,project:input.project,surface:input.surface,model:result.model})).digest("hex");
 const earlier=await readRequest(deps,input.orgId,input.developerId,input.requestId);
 if(earlier!==undefined&&earlier.fingerprint!==fingerprint)throw agentXError("IDEMPOTENCY_CONFLICT","This request ID is already being used for another change.");
 const checks=[...authority,...modelSelectionRevisionChecks(deps.tableName,input.orgId,{companyRevision:context.companyRevision,sourcesRevision:context.sourcesRevision,guardrailsRevision:context.guardrailsRevision}),projectSelectionPlaybookCheck(deps.tableName,input.orgId,input.project,context.playbook),projectSelectionProcessCheck(deps.tableName,input.orgId,input.project,context.process),...projectSelectionAncestorChecks(deps.tableName,input.orgId,context.process.agentId,context.chain)];
 if(earlier!==undefined){
  const remembered=Receipt.safeParse(earlier.result);
  if(!remembered.success||canonicalJson(remembered.data)!==canonicalJson(reply))throw unavailable();
  await deps.documentClient.send(new TransactWriteCommand({TransactItems:[...checks,{ConditionCheck:{TableName:deps.tableName,Key:projectSelectionKey(input.orgId,input.project),...projectSelectionWriteCondition(context.selection)}},{ConditionCheck:{TableName:deps.tableName,Key:agentRequestKey(input.orgId,input.developerId,input.requestId),ConditionExpression:"#fingerprint = :fingerprint AND #result = :result AND #expires > :now",ExpressionAttributeNames:{"#fingerprint":"fingerprint","#result":"result","#expires":INDEX_EXPIRY_ATTRIBUTE},ExpressionAttributeValues:{":fingerprint":fingerprint,":result":remembered.data,":now":Math.floor(deps.now()/1000)}}}]}));
  return remembered.data;
 }
 const at=new Date(deps.now()).toISOString(),changed=!context.selection.exists||canonicalJson(context.selection.model)!==canonicalJson(result.model);
 const events=changed?await tryAuditEvents(deps,()=>[modelSelectionAuditEvent({orgId:input.orgId,actor:auditActorOf(input.developerId),occurredAt:at,project:input.project,surface:input.surface,cleared:false,requestId:input.requestId})]):[];
 if(changed&&events.length!==1)throw unavailable();
 const items=[...checks,{Put:{TableName:deps.tableName,Item:{...projectSelectionKey(input.orgId,input.project),entityType:"PROJECT_MODEL_SELECTION",model:result.model,updatedAt:at,updatedBy:input.developerId},...projectSelectionWriteCondition(context.selection)}},...events.flatMap(event=>auditPending(deps,event))];
 if(items.length+1>90)throw unavailable();
 await commit(deps,items,()=>agentXError("PLAYBOOK_STALE","The model settings or your access changed. Reload and try again."),{orgId:input.orgId,developerId:input.developerId,requestId:input.requestId,fingerprint},reply);
 await flushAuditEvents(deps,events);
 return reply;
}
