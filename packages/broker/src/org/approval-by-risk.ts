// Approval by risk (learning v2, design-review-stage.md 3.8): the pure rules that decide HOW MANY people must approve something and whether a second person's approval counts, shared by lessons
// (`lessons/policy.ts`, `lessons/approve.ts`) and the design review stage (`design-review/approval.ts`). Moved out of the lessons code with NO change in behaviour: the lesson approval tests run unchanged.
//
// The shape of the rule, for any consumer: code decides the tier (a model's words can only raise it), a higher tier needs more or other people, and the person who asked or wrote it is not the second
// person, except through the existing sole-owner exception (`decideSecondPersonApproval`, with its own 24-hour cool-off). This file holds the pure parts only; each consumer keeps its own store, audit
// and eligibility reads, and fences its commit with the evidence it read.
import { decideSecondPersonApproval } from "./second-person-approval.js";

/** How many people a level needs: `auto` goes live by itself (only where a consumer allows it), `one`, `two`. */
export type ApprovalLevel = "auto" | "one" | "two";
/** An approval policy by tier: tier 0 and tier 1 as configured, tier 2 always two people (it has no setting). Structurally the lessons' `ApprovalPolicy` without its group field. */
export interface ApprovalLevels { tier0: ApprovalLevel; tier1: "one" | "two" }

/** How many approvers a tier needs under a policy. Tier 2 can never go below two people. */
export function approversRequired(tier: 0 | 1 | 2, policy: ApprovalLevels): 0 | 1 | 2 {
  if (tier === 2) return 2;
  const level = tier === 0 ? policy.tier0 : policy.tier1;
  return level === "auto" ? 0 : level === "one" ? 1 : 2;
}

/** What a directory knows about who may approve, read fresh and complete. The same shape as the lessons' `ApproverDirectory.eligibility`. */
export interface ApprovalEligibility {
  complete: boolean;
  membershipVersion: number;
  ownerIds: readonly string[];
  eligibleIds: readonly string[];
  lastEligibleLossAtMs: number | null;
}

export type SecondPersonRefusal = "sole_owner_cool_off" | "second_person_required" | "eligibility_unavailable";
export type SecondPersonOutcome =
  | { ok: true; mode: "second_person" | "sole_owner_exception" }
  | { ok: false; code: SecondPersonRefusal; /** The time the cool-off opens (ISO), taken from the shared rule's own refusal so no caller repeats the 24-hour constant. */ availableAt?: string };

/**
 * `decideSecondPersonApproval` as a result instead of a throw. The ids are compared exactly, so the caller hands each person in the spelling of the eligible list. Fails closed: anything the shared
 * rule refuses, for any reason, is a refusal here, and a refusal that carries no reason is `eligibility_unavailable`.
 */
export function secondPersonOutcome(group: ApprovalEligibility, proposerId: string, approverId: string, nowMs: number): SecondPersonOutcome {
  try {
    const decision = decideSecondPersonApproval({
      proposerId, approverId, nowMs, complete: group.complete, membershipVersion: group.membershipVersion, ownerIds: group.ownerIds, eligibleIds: group.eligibleIds, lastEligibleLossAtMs: group.lastEligibleLossAtMs,
    });
    return { ok: true, mode: decision.mode };
  } catch (error) {
    const soleOwner = (error as { soleOwner?: { reasonCode?: string; availableAt?: unknown } }).soleOwner;
    const reason = soleOwner?.reasonCode;
    const code: SecondPersonRefusal = reason === "SOLE_OWNER_COOL_OFF" ? "sole_owner_cool_off" : reason === "SECOND_PERSON_REQUIRED" ? "second_person_required" : "eligibility_unavailable";
    return code === "sole_owner_cool_off" && typeof soleOwner?.availableAt === "string" ? { ok: false, code, availableAt: soleOwner.availableAt } : { ok: false, code };
  }
}
