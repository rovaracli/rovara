// Unexposed save primitive. No HTTP/UI, registration-input or task-consumer integration.
// Selection metadata belongs to the immutable revision record; every other revision writer
// must preserve/refuse it before this primitive is exposed. Consumers are separately gated.
import { createHash } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, AgentXNameSchema, OrgIdSchema, StoredProjectDefinitionSchema, WorkingBranchNameSchema, agentXError, canonicalJson, orgScoped, projectRevisionKey } from "@rovara-code/contracts";
import { githubInstallationKey } from "@agentx/cloud-contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { auditOccurrence, auditProjectWorkingBranchChanged } from "../audit/events.js";
import { auditPending, type TransactItem } from "../audit/outbox.js";
import { flushAuditEvents } from "../audit/flush.js";
import { takeRateAt } from "../developer/page-comments.js";
import { githubPinsOf, tryGithubPinsOf } from "./project-working-branch-host.js";
import { readProjectWorkingBranchPreview, type WorkingBranchReviewDependencies } from "./project-working-branch.js";
import { readProjectLifecycleRecord as read, readProjectLifecycleAuthority as authority, readProjectLifecycleState as projectState, validateProjectLifecycleIdentifiers as identifiers } from "./reviewed-project-archive.js";
type Session = Required<Pick<WorkingBranchReviewDependencies, "checkRepository" | "resolveBranch">> & { finish(): Promise<void> };
export type WorkingBranchSaveDependencies = Pick<DeveloperRouteDependencies, "documentClient" | "tableName" | "now" | "audit"> & { workingBranchSession?: () => Session };
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), config = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1), sha = z.string().regex(/^[a-f0-9]{40}$/), id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bodySchema = z.object({requestId:z.string().uuid(),expectedOrgId:OrgIdSchema,expectedRevision:revision,expectedProjectRevision:config,repository:AgentXNameSchema,branch:WorkingBranchNameSchema,expectedCommit:sha}).strict();
const selectionSchema = z.object({branch:WorkingBranchNameSchema,commit:sha,installationId:id,repositoryId:id}).strict();
const selectionsSchema = z.record(AgentXNameSchema,selectionSchema).refine(value=>Object.keys(value).length<=32);
const receiptSchema = z.object({orgId:OrgIdSchema,project:AgentXNameSchema,repository:AgentXNameSchema,branch:WorkingBranchNameSchema,commit:sha,fromProjectRevision:config,projectRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),lifecycleRevision:revision,savedAt:z.string().datetime()}).strict();
const invalid=()=>agentXError("CONFIG_INVALID","Review a valid registered working branch before saving.");
const stale=()=>agentXError("CHANGE_STALE","The project or branch changed. Refresh and review the working branch again.");
const forbidden=()=>agentXError("FORBIDDEN","Only a current project maintainer can save a working branch.");
const unavailable=()=>agentXError("RUNTIME_UNAVAILABLE","The working branch could not be checked. Try again.");
const auditUnavailable=()=>agentXError("AUDIT_UNAVAILABLE","The working branch save outcome could not be confirmed. Check its receipt before trying again.");
const disconnected=()=>agentXError("GITHUB_NOT_CONNECTED","Reconnect this project's repository before saving its working branch.");
function safe(error:unknown){
 if(error instanceof AgentXError){
  if(error.code==="CONFIG_INVALID")return invalid();if(error.code==="CHANGE_STALE")return stale();if(error.code==="FORBIDDEN")return forbidden();if(error.code==="GITHUB_NOT_CONNECTED")return disconnected();
  if(error.code==="NOT_FOUND")return agentXError("NOT_FOUND","That project, repository or branch is unavailable in this company.");
  if(error.code==="TOO_MANY_REQUESTS")return agentXError("TOO_MANY_REQUESTS","Too many working branch checks. Try again later.");
  if(error.code==="RUNTIME_UNAVAILABLE")return unavailable();
 }
 return auditUnavailable();
}
/** Snapshot equality for the fields the transaction relies on, including absent critical fields. */
function snapshot(tableName:string,key:{pk:string;sk:string},row:Record<string,unknown>|undefined,critical:string[]=[]):NonNullable<TransactItem["ConditionCheck"]>{
 if(row===undefined)return{TableName:tableName,Key:key,ConditionExpression:"attribute_not_exists(pk)"};
 const names:Record<string,string>={},values:Record<string,unknown>={},conditions=["attribute_exists(pk)"];
 const fields=[...new Set([...Object.keys(row),...critical])].filter(field=>field!=="pk"&&field!=="sk").sort();
 for(const [index,field] of fields.entries()){
  const name=`#s${index}`,value=`:s${index}`;names[name]=field;
  if(row[field]===undefined)conditions.push(`attribute_not_exists(${name})`);else{values[value]=row[field];conditions.push(`${name} = ${value}`);}
 }
 return{TableName:tableName,Key:key,ConditionExpression:conditions.join(" AND "),...(fields.length===0?{}:{ExpressionAttributeNames:names}),...(Object.keys(values).length===0?{}:{ExpressionAttributeValues:values})};
}
async function admit(deps:WorkingBranchSaveDependencies,scope:DeveloperCaller){
 const buckets=[{key:"WORKING_BRANCH_PAGES",sk:scope.developerId,limit:10,window:60_000,units:1},{key:"WORKING_BRANCH_ORG_PAGES",sk:"ALL",limit:30,window:60_000,units:1},{key:"WORKING_BRANCH_ORG_HOURLY_PAGES",sk:"ALL",limit:1_200,window:3_600_000,units:3}];
 for(const bucket of buckets){let accepted:boolean;try{accepted=await takeRateAt(deps,{pk:orgScoped(scope.orgId,bucket.key),sk:bucket.sk},bucket.limit,bucket.window,undefined,bucket.units);}catch{throw unavailable();}if(!accepted)throw agentXError("TOO_MANY_REQUESTS","Working branch check budget exhausted.");}
}
export async function commitReviewedProjectWorkingBranch(deps:WorkingBranchSaveDependencies,caller:DeveloperCaller,name:string,body:unknown){
 try{
  const scope=Object.freeze({...caller}),parsed=bodySchema.safeParse(body);if(!parsed.success)throw invalid();const input=parsed.data;identifiers(scope,name);if(input.expectedOrgId!==scope.orgId)throw stale();
  const auth=await authority(deps,scope,name);
  if(deps.audit===undefined||deps.audit.tableName!==deps.tableName||deps.audit.documentClient!==deps.documentClient)throw auditUnavailable();
  const receiptKey={pk:orgScoped(scope.orgId,"REVIEWED_WORKING_BRANCH"),sk:input.requestId},action="project.working_branch_changed";
  const bodyHash=createHash("sha256").update(canonicalJson({orgId:scope.orgId,by:scope.developerId,action,project:name,...input})).digest("hex");
  async function replay(){
   const row=await read(deps,receiptKey);if(row===undefined)return undefined;
   if(row.entityType!=="REVIEWED_WORKING_BRANCH_REQUEST"||row.orgId!==scope.orgId||row.by!==scope.developerId||row.action!==action||row.bodyHash!==bodyHash)throw invalid();
   const result=receiptSchema.safeParse(row.receipt);if(!result.success)throw auditUnavailable();const value=result.data;
   if(value.orgId!==scope.orgId||value.project!==name||value.repository!==input.repository||value.branch!==input.branch||value.commit!==input.expectedCommit||value.fromProjectRevision!==input.expectedProjectRevision||value.projectRevision!==input.expectedProjectRevision+1||value.lifecycleRevision!==input.expectedRevision)throw auditUnavailable();return value;
  }
  const previous=await replay();if(previous!==undefined)return{receipt:previous,replayed:true};
  const state=await projectState(deps,scope,name);if(state.status!=="active"||state.epoch!==input.expectedRevision||state.projectRevision!==input.expectedProjectRevision)throw stale();
  const repository=state.definition.repositories.find(repo=>repo.name===input.repository);if(repository===undefined)throw agentXError("NOT_FOUND","Repository unavailable.");
  const pins=githubPinsOf(repository);if(!id.safeParse(pins.installationId).success||!id.safeParse(pins.githubRepositoryId).success)throw invalid();
  const [registered,catalog,pointer,org,grant,binding]=await Promise.all([read(deps,state.registeredKey),read(deps,state.catalogKey),read(deps,auth.pointerKey),read(deps,auth.orgKey),auth.actor.role==="member"?read(deps,auth.grantKey):undefined,read(deps,githubInstallationKey(pins.installationId!))]);
  if(registered===undefined||catalog?.latestRevision!==input.expectedProjectRevision||canonicalJson(StoredProjectDefinitionSchema.parse(registered.definition))!==canonicalJson(state.definition))throw stale();
  if(registered.runtimeBinding===undefined||registered.runtimeBinding===null||typeof registered.runtimeBinding!=="object")throw unavailable();
  if(binding?.orgId!==scope.orgId||binding.status!=="active")throw disconnected();
  const selections=selectionsSchema.safeParse(registered.workingBranchSelections===undefined?{}:registered.workingBranchSelections);if(!selections.success)throw unavailable();
  for(const [registeredName,selection] of Object.entries(selections.data)){const repo=state.definition.repositories.find(value=>value.name===registeredName);if(repo===undefined)throw unavailable();const own=tryGithubPinsOf(repo);if(own===undefined||own.installationId!==selection.installationId||own.githubRepositoryId!==selection.repositoryId)throw unavailable();}
  await admit(deps,scope);
  const factory=deps.workingBranchSession;if(factory===undefined)throw unavailable();let session:Session;
  try{session=factory();}catch{throw unavailable();}
  if(session===undefined||typeof session.checkRepository!=="function"||typeof session.resolveBranch!=="function"||typeof session.finish!=="function")throw unavailable();
  let checked:Awaited<ReturnType<typeof readProjectWorkingBranchPreview>>;
  try{checked=await readProjectWorkingBranchPreview({...deps,...session},scope,name,{expectedOrgId:input.expectedOrgId,expectedRevision:input.expectedRevision,expectedProjectRevision:input.expectedProjectRevision,repository:input.repository,branch:input.branch});if(checked.commit!==input.expectedCommit)throw stale();}
  catch(error){try{await session.finish();}catch{/* Primary refusal remains authoritative. */}throw error;}
  try{await session.finish();}catch(error){if(error instanceof AgentXError&&error.code==="GITHUB_NOT_CONNECTED")throw disconnected();throw unavailable();}
  // GitHub reads and database writes are not atomic. These final live reads plus the
  // transaction fence this save; task start still needs its own exact-ref admission.
  await authority(deps,scope,name);const current=await projectState(deps,scope,name);
  if(current.status!=="active"||current.epoch!==state.epoch||current.projectRevision!==state.projectRevision||canonicalJson(current.definition)!==canonicalJson(state.definition))throw stale();
  const next=state.projectRevision+1,savedAt=new Date(deps.now()).toISOString(),selection=selectionSchema.parse({branch:checked.branch,commit:checked.commit,installationId:checked.installationId,repositoryId:checked.repositoryId});
  const receipt=receiptSchema.parse({orgId:scope.orgId,project:name,repository:input.repository,branch:selection.branch,commit:selection.commit,fromProjectRevision:state.projectRevision,projectRevision:next,lifecycleRevision:state.epoch,savedAt});
  const nextRecord:Record<string,unknown> & {definition:Record<string,unknown>}={...registered,...projectRevisionKey(scope.orgId,name,next),definition:{...(registered.definition as Record<string,unknown>),revision:next},workingBranchSavedAt:savedAt,workingBranchSavedBy:scope.developerId,workingBranchSelections:{...selections.data,[input.repository]:selection}};
  // Branch selection metadata changes no setup, source policy, runtime or registration owner pin.
  // Keep those registration fields verbatim; the branch saver is recorded separately.
  StoredProjectDefinitionSchema.parse(nextRecord.definition);
  const labels:string[]=[],items:TransactItem[]=[],add=(label:string,item:TransactItem)=>{labels.push(label);items.push(item);};
  add("meta",{ConditionCheck:snapshot(deps.tableName,state.metaKey,state.meta,["orgId","status","archiveRevision"])});
  const catalogFence=snapshot(deps.tableName,state.catalogKey,catalog,["orgId"]);
  add("catalog",{Update:{...catalogFence,UpdateExpression:"SET latestRevision = :next",ExpressionAttributeValues:{...catalogFence.ExpressionAttributeValues,":next":next}}});
  add("registered",{ConditionCheck:snapshot(deps.tableName,state.registeredKey,registered,["workingBranchSelections","runtimeBinding","setupApproval","registeredBy","registeredAt","workingBranchSavedBy","workingBranchSavedAt"])});
  add("actor",{ConditionCheck:snapshot(deps.tableName,auth.actorKey,auth.actor,["orgId","developerId","role"])});
  add("pointer",{ConditionCheck:snapshot(deps.tableName,auth.pointerKey,pointer,["orgId","role"])});
  add("org",{ConditionCheck:snapshot(deps.tableName,auth.orgKey,org,["orgId","closingAt","closedAt"])});
  if(auth.actor.role==="member")add("grant",{ConditionCheck:snapshot(deps.tableName,auth.grantKey,grant,["role","projectRole","projectName"])});
  add("binding",{ConditionCheck:snapshot(deps.tableName,githubInstallationKey(selection.installationId),binding,["orgId","status"])});
  add("next",{Put:{TableName:deps.tableName,Item:nextRecord,ConditionExpression:"attribute_not_exists(pk)"}});
  add("receipt",{Put:{TableName:deps.tableName,Item:{...receiptKey,entityType:"REVIEWED_WORKING_BRANCH_REQUEST",orgId:scope.orgId,by:scope.developerId,action,bodyHash,receipt},ConditionExpression:"attribute_not_exists(pk)"}});
  const old=selections.data[input.repository],event=auditProjectWorkingBranchChanged({orgId:scope.orgId,actor:{kind:"member",id:scope.developerId},projectName:name,fromRevision:state.projectRevision,toRevision:next,lifecycleRevision:state.epoch,installationId:selection.installationId,repositoryId:selection.repositoryId,requestId:input.requestId,previousConfigured:old!==undefined,occurredAt:savedAt,occurrence:auditOccurrence("reviewed-working-branch",scope.orgId,input.requestId,name),details:[{subject:scope.developerId,fields:{repository:input.repository,repositoryFullName:checked.repositoryFullName,installationId:String(selection.installationId),repositoryId:String(selection.repositoryId),fromBranch:old?.branch??"",fromCommit:old?.commit??"",toBranch:selection.branch,reviewedCommit:selection.commit}}]});
  const pending=auditPending(deps,event);if(pending.length!==1)throw auditUnavailable();for(const item of pending){if(item.Put===undefined)throw auditUnavailable();add("audit",{Put:{...item.Put,ConditionExpression:"attribute_not_exists(pk)"}});}
  try{await deps.documentClient.send(new TransactWriteCommand({TransactItems:items}));}
  catch(error){const already=await replay();if(already!==undefined)return{receipt:already,replayed:true};const reasons=(error as {CancellationReasons?:Array<{Code?:string}>}).CancellationReasons,failed=labels.filter((_,index)=>reasons?.[index]?.Code==="ConditionalCheckFailed");if(failed.some(label=>["actor","pointer","org","grant"].includes(label)))throw forbidden();if(failed.includes("binding"))throw disconnected();if(failed.some(label=>["meta","catalog","registered","next"].includes(label)))throw stale();throw auditUnavailable();}
  await flushAuditEvents(deps,[event]);return{receipt,replayed:false};
 }catch(error){throw safe(error);}
}
