import { agentXError } from "@rovara-code/contracts";
/** Shared policy only. Callers must obtain complete server-side evidence and fence
 * its generation and both people's live authority in their committing transaction.
 * This decision is not a transferable approval capability. */
export interface ApprovalDecisionInput {
  proposerId: string;
  approverId: string;
  nowMs: number;
  complete: boolean;
  membershipVersion: number;
  ownerIds: readonly string[];
  eligibleIds: readonly string[];
  /** null means a complete history proves no eligible-access loss. */
  lastEligibleLossAtMs: number | null;
}
export interface ApprovalDecision {
  mode: "second_person" | "sole_owner_exception";
  membershipVersion: number;
}
const COOL_OFF_MS = 86_400_000;
const refuse = (reasonCode="ELIGIBILITY_UNAVAILABLE", availableAtMs?:number): never => {
  const at=availableAtMs===undefined?undefined:new Date(availableAtMs);
  throw Object.assign(agentXError("FORBIDDEN", "a fresh eligible second-person approval is required"),{soleOwner:{available:false,availableAt:at!==undefined&&Number.isFinite(at.getTime())?at.toISOString():null,reasonCode}});
};

export function decideSecondPersonApproval(input: ApprovalDecisionInput): ApprovalDecision {
  const { proposerId, approverId, eligibleIds, ownerIds, membershipVersion, nowMs } = input;
  if (!input.complete || !Number.isSafeInteger(membershipVersion) || membershipVersion < 0
    || !Number.isFinite(nowMs) || nowMs < 0
    || eligibleIds.some(id => id.length === 0) || ownerIds.some(id => id.length === 0)
    || new Set(eligibleIds).size !== eligibleIds.length || new Set(ownerIds).size !== ownerIds.length
    || !eligibleIds.includes(proposerId) || !eligibleIds.includes(approverId)) return refuse();
  if (proposerId !== approverId) return { mode: "second_person", membershipVersion };
  if (ownerIds.length !== 1 || ownerIds[0] !== proposerId || eligibleIds.length !== 1) return refuse("SECOND_PERSON_REQUIRED");
  const loss = input.lastEligibleLossAtMs;
  if (loss !== null && (!Number.isFinite(loss) || loss < 0 || loss > nowMs)) return refuse();
  if (loss !== null && nowMs - loss < COOL_OFF_MS) return refuse("SOLE_OWNER_COOL_OFF",loss+COOL_OFF_MS);
  return { mode: "sole_owner_exception", membershipVersion };
}

/** Merge this condition into the caller's org-META action, or use it in a
 * ConditionCheck on that META if the transaction has no other action on it.
 * Also pin BOTH people's live member/developer/grant records. Never send two
 * actions on the same META key. Generation writers must be fully deployed. */
export function secondPersonMembershipCondition(membershipVersion: number): {
  ConditionExpression: string;
  ExpressionAttributeValues: { ":approvalMembershipVersion": number };
} {
  if (!Number.isSafeInteger(membershipVersion) || membershipVersion < 0) throw agentXError("CHANGE_STALE", "approval membership evidence must be refreshed");
  return {
    ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(closedAt) AND attribute_not_exists(closingAt) AND approvalMembershipVersion = :approvalMembershipVersion",
    ExpressionAttributeValues: { ":approvalMembershipVersion": membershipVersion },
  };
}
