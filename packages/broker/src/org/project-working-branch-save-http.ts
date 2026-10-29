// Browser-only setting exposure. CLI and task consumers are not released.
import { z } from "zod";
import { AgentXNameSchema, ProjectWorkingBranchReceiptSchema, ProjectWorkingBranchSaveResultSchema, agentXError, orgScoped } from "@agentx/contracts";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
import { readProjectLifecycleAuthority as authority, readProjectLifecycleRecord as read } from "./reviewed-project-archive.js";
import { commitReviewedProjectWorkingBranch } from "./project-working-branch-save.js";
const missing=()=>agentXError("NOT_FOUND","That working branch request is unavailable.");
export async function projectWorkingBranchSaveHttp(deps:DeveloperRouteDependencies,caller:DeveloperCaller,encodedName:string,body:unknown,requestId?:string){
 if(caller.browserSession!==true)throw agentXError("FORBIDDEN","Use a live browser session for working branch settings.");
 let name:string;try{name=decodeURIComponent(encodedName);}catch{throw missing();}
 if(!AgentXNameSchema.safeParse(name).success)throw missing();
 if(requestId===undefined)return ProjectWorkingBranchSaveResultSchema.parse(await commitReviewedProjectWorkingBranch({...deps,...(deps.projectWorkingBranchPreview===undefined?{}:{workingBranchSession:deps.projectWorkingBranchPreview})},caller,name,body));
 await authority(deps,caller,name);
 if(!z.string().uuid().safeParse(requestId).success)throw missing();
 let admitted:boolean;try{admitted=await takeRateAt(deps,{pk:orgScoped(caller.orgId,"WORKING_BRANCH_RECEIPT_READS"),sk:caller.developerId},30,60_000);}catch{throw agentXError("RUNTIME_UNAVAILABLE","The save status could not be checked.");}
 if(!admitted)throw agentXError("TOO_MANY_REQUESTS","Too many save status checks. Try again later.");
 const row=await read(deps,{pk:orgScoped(caller.orgId,"REVIEWED_WORKING_BRANCH"),sk:requestId});
 // Foreign actor and absence are deliberately indistinguishable.
 if(row===undefined||row.by!==caller.developerId||row.orgId!==caller.orgId||row.action!=="project.working_branch_changed"||row.entityType!=="REVIEWED_WORKING_BRANCH_REQUEST")throw missing();
 const receipt=ProjectWorkingBranchReceiptSchema.safeParse(row.receipt);
 if(!receipt.success||receipt.data.orgId!==caller.orgId||receipt.data.project!==name)throw missing();
 await authority(deps,caller,name);
 return {receipt:receipt.data,replayed:true};
}
