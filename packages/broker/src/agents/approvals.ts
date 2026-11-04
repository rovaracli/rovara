// Plan 3 Task 7 (PF18, PF19) and Task 21: the approvals core. A change that needs a person's confirmation (a less-safe publish, rollback or adoption, a company-wide
// share; guardrail relaxations, connector widenings, opt-outs), a write an agent wants to make, and a step of a run that waits are each stored as one APPROVAL#
// record, listed through the global OPEN_APPROVALS index and one APPROVER# item per person who may be asked. Nothing is applied when the record is made.
//
// The code lives in three files that this one re-exports, so every import of `agents/approvals.js` stays as it was:
//   - approvals-store.ts:   the records and their schemas, the registries of rules and handlers, creating and listing, who may decide;
//   - approvals-decide.ts:  deciding (the state machine), the sweep that expires, retries and tells handlers;
//   - approvals-movers.ts:  the member movers (a merge or a removal changes who may decide a pending approval).
export { MAX_APPROVAL_ATTEMPTS, approvalIdFor, approvalIdFromSeed, approvalTaskEventKey, confirmUrlFor, createPendingChange, createStepApproval, createWriteApprovalRecord, getAnyApproval, getApproval, getApprovalSubjectHandler, getApproverRule, listApprovalsFor, mayDecideApproval, pendingChangeFor, pendingWriteApprovals, registerApprovalDecisionGuard, registerApprovalGaveUpHandler, registerApprovalSubjectHandler, registerApproverRefusal, registerApproverRule, requireRegisteredApprovers, runOfApproval, shownPersonName, shownText } from "./approvals-store.js";
export type { ApprovalDecisionGuard, ApproverRefusal, ApproverRefusalFor, AgentChangeSubject, ChainChangeSubject, AnyApprovalRecord, ApprovalCaller, ApprovalDependencies, ApprovalRecord, ApprovalRun, ApprovalRunView, ApprovalStatus, ApprovalStoreDependencies, ApprovalSubject, ApprovalSubjectHandler, ApproverRuleCheck, ApproverSpec, ChangeApprovalRecord, ChangeSubject, ConnectorWidenSubject, DecideBody, OptOutChangeSubject, OtherChangeSubject, SessionOwnerSubject, SessionShareOrgSubject, StepApprovalRecord, WriteApprovalRecord } from "./approvals-store.js";
export { MAX_HANDLER_TRIES, decideApproval, expireApprovalNow, expireApprovals, registerWriteApprovalDriver, runApprovalDecision, runApprovalSweep } from "./approvals-decide.js";
export type { ApprovalSweepReport, Execution, WriteApprovalDriver } from "./approvals-decide.js";
// Loading this module registers the approvals' member mover (Task 11's hand-off): the settlement run and OrgStore use the one global registry.
import "./approvals-movers.js";
