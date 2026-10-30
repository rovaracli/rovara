import {readRequest} from "../agents/table-writes.js";
import {requireCompanyModelPolicyAuthority} from "./company-read.js";
// The existing guardrail confirmation flow, with B33's shared live evidence policy.
import {agentXError,ModelSelectionPolicyPutSchema,NEEDS_CONFIRMATION_CHANGES_MAX} from "@agentx/contracts";
import {createPendingChange,confirmUrlFor,registerApprovalDecisionGuard,registerApprovalSubjectHandler,type ApprovalDependencies} from "../agents/approvals.js";
import {orgAdminApprovers} from "../agents/changes.js";
import type {AgentCaller} from "../agents/access.js";
import {readSecondPersonApprovalEvidence} from "../org/second-person-evidence.js";
import {decideSecondPersonApproval} from "../org/second-person-approval.js";
import {prepareCompanyModelPolicy} from "./company-prepare.js";
import {writeSaferCompanyModelPolicy,applyApprovedCompanyModelPolicy} from "./company-write.js";
export async function updateCompanyModelPolicy(deps:ApprovalDependencies,caller:AgentCaller,value:unknown){
 const adapted={...deps,routing:deps.modelRouting??{}};
 await requireCompanyModelPolicyAuthority(adapted,caller);
 const parsed=ModelSelectionPolicyPutSchema.safeParse(value);
 if(parsed.success&&await readRequest(deps,caller.orgId,caller.developerId,parsed.data.requestId)!==undefined)return writeSaferCompanyModelPolicy(adapted,{...caller,signedInId:caller.developerId},parsed.data);
 const prepared=await prepareCompanyModelPolicy(adapted,caller,value);
 if(prepared.changes.length===0)return writeSaferCompanyModelPolicy(adapted,{...caller,signedInId:caller.developerId},prepared.body);
 if(deps.audit===undefined||deps.modelSignInTableName===undefined)throw agentXError("RUNTIME_UNAVAILABLE","Company model approvals are unavailable.");
 const record=await createPendingChange(deps,{orgId:caller.orgId,requestId:prepared.body.requestId,requestedBy:caller.developerId,subject:{kind:"model_selection_policy",body:prepared.body,sourcesRevision:prepared.sourcesRevision,guardrailsRevision:prepared.guardrailsRevision},changes:prepared.changes,approvers:await orgAdminApprovers(deps,caller.orgId)});
 if(record.status!=="PENDING")throw agentXError("APPROVAL_CLOSED","This request was already decided.");
 return {status:"NEEDS_CONFIRMATION" as const,code:"REAUTH_REQUIRED" as const,confirmationId:record.approvalId,confirmUrl:confirmUrlFor(deps,record),changes:record.changes.slice(0,NEEDS_CONFIRMATION_CHANGES_MAX),requestId:prepared.body.requestId};
}
export function registerCompanyModelPolicyApprovals(){
 registerApprovalDecisionGuard("company_model_policy",async(deps,caller,record,decision)=>{
  if(record.kind!=="change"||record.subject.kind!=="model_selection_policy"||decision!=="APPROVE")return;
  if(record.requestedBy===undefined||deps.modelSignInTableName===undefined)throw agentXError("FORBIDDEN","Complete company approval authority is required.");
  const evidence=await readSecondPersonApprovalEvidence({...deps,signInTableName:deps.modelSignInTableName},{orgId:record.orgId,proposerId:record.requestedBy,approverId:caller.developerId});
  decideSecondPersonApproval(evidence.decisionInput);
 });
 registerApprovalSubjectHandler("model_selection_policy",async(deps,record)=>{if(record.kind!=="change"||record.subject.kind!=="model_selection_policy")throw agentXError("CONFIG_INVALID","This is not a company model approval.");await applyApprovedCompanyModelPolicy({...deps,routing:deps.modelRouting??{}},record);});
}
