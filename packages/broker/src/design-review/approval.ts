// Design review stage (DR9, design-review-stage.md 3.8, owner Q8 and Q10): who may approve a design, who may skip its review, and who is asked a question. PURE: the caller reads who is eligible (fresh, complete,
// fenced in its own committing transaction, as every second-person approval is) and passes it in; nothing here reads a store, a clock or a role. The rules, all fail closed:
//   - low and medium: the requester, or a project maintainer;
//   - high: the configured HIGH-RISK APPROVER (maintainers, named people, or a group, Enterprise only) and a fresh sign-in. The REQUESTER is refused, even if they are a high-risk approver, unless they
//     are the only eligible approver and the only owner (the sole-owner exception, with its 24-hour cool-off, from `org/approval-by-risk.ts`; the caller audits it as `sole_owner_exception`);
//   - an open blocker allows approval only with a one-line reason (Q8), which goes on the PR's Proof line;
//   - only a high-risk approver may skip a high-risk design review (Q10), and nobody may when the setting says no skipping.
// Any comparison here is of people's ids and the setting's kind, never of a company role: eligibility comes from the caller's directory, so an Auditor (who holds no project role) is never in it.
import { featureEnabled, type DesignReason, type DesignReviewSetting, type EditionPolicy } from "@agentx/contracts";
import { secondPersonOutcome, type ApprovalEligibility } from "../org/approval-by-risk.js";
import { isHighRiskCodes } from "./risk.js";

export type DesignApprovalTier = "low" | "medium" | "high";

export interface DesignApproverDirectory {
  /** The project's maintainers as eligible ids, its owners, the membership generation: the shared second-person evidence. Required complete. */
  people: ApprovalEligibility;
  /** Everyone who is a member of the project now (the named people must still be members). */
  projectMemberIds: readonly string[];
  /** Enterprise groups: group id to member ids. Ignored in the Public edition. */
  groups?: Readonly<Record<string, readonly string[]>> | undefined;
}

/** The ids who count as the high-risk approver now, or why nobody does. */
export type HighRiskApprovers = { ok: true; ids: string[] } | { ok: false; code: "group_not_available" | "no_high_risk_approver" | "eligibility_unavailable" };

const same = (left: string, right: string): boolean => left.normalize("NFC").trim().toLowerCase() === right.normalize("NFC").trim().toLowerCase();
const has = (list: readonly string[], id: string): boolean => list.some((entry) => same(entry, id));
const unique = (ids: readonly string[]): string[] => ids.filter((id, index) => ids.findIndex((other) => same(other, id)) === index);

/**
 * Who the configured high-risk approver is, now. `maintainers`: the project's maintainers. `people`: the named people who are still members. `group`: the group's members, and only where the edition has groups
 * (a group in Public is refused whatever the data says). An empty set is `no_high_risk_approver`: the design waits and the maintainers are asked to name one (3.7), it is never decided by someone else.
 */
export function highRiskApprovers(setting: Pick<DesignReviewSetting, "highRiskApprover">, directory: DesignApproverDirectory, edition: EditionPolicy | undefined): HighRiskApprovers {
  if (!directory.people.complete) return { ok: false, code: "eligibility_unavailable" };
  const approver = setting.highRiskApprover;
  let ids: string[];
  switch (approver.kind) {
    case "maintainers": ids = unique(directory.people.eligibleIds); break;
    case "people": ids = unique(approver.memberIds.filter((id) => has(directory.projectMemberIds, id))); break;
    case "group":
      if (edition === undefined || !featureEnabled(edition, "groups")) return { ok: false, code: "group_not_available" };
      ids = unique(directory.groups?.[approver.groupId] ?? []);
      break;
  }
  return ids.length === 0 ? { ok: false, code: "no_high_risk_approver" } : { ok: true, ids };
}

/** A blocker's one-line reason: one plain line of 1 to 200 characters, or undefined. Used as the Proof line's words, so it is cut and cleaned here, not later. */
export const BLOCKER_REASON_MAX = 200;
export function blockerReasonLine(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.normalize("NFC").trim();
  if (text.length === 0 || text.length > BLOCKER_REASON_MAX || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return undefined;
  return text;
}

export interface DesignApprovalInput {
  tier: DesignApprovalTier;
  requesterId: string;
  approverId: string;
  nowMs: number;
  setting: Pick<DesignReviewSetting, "highRiskApprover">;
  edition: EditionPolicy | undefined;
  directory: DesignApproverDirectory;
  /** The decision is made on the confirmation page after a fresh sign-in. A high design needs it. */
  freshSignIn: boolean;
  /** Blockers still open on the design as the approver sees it, and the approver's one-line reason for approving anyway. */
  openBlockers: number;
  blockerReason?: string | undefined;
}

export type DesignApprovalRefusal =
  | "not_eligible" | "requester_cannot_approve_high" | "fresh_sign_in_required" | "reason_required"
  | "group_not_available" | "no_high_risk_approver" | "eligibility_unavailable" | "sole_owner_cool_off";
export type DesignApprovalDecision =
  | { ok: true; mode: "requester" | "maintainer" | "high_risk_approver" | "sole_owner_exception"; /** The reason to put on the Proof line, when blockers were open. */ proofReason?: string }
  | { ok: false; code: DesignApprovalRefusal; availableAt?: string };

/** Whether this person may approve this design now, and in what capacity. The caller audits `sole_owner_exception` and records `proofReason`. */
export function decideDesignApproval(input: DesignApprovalInput): DesignApprovalDecision {
  const { directory } = input;
  if (!directory.people.complete) return { ok: false, code: "eligibility_unavailable" };
  const reasonOf = (): DesignApprovalDecision | { proofReason: string | undefined } => {
    if (input.openBlockers <= 0) return { proofReason: undefined };
    const line = blockerReasonLine(input.blockerReason);
    return line === undefined ? { ok: false, code: "reason_required" } : { proofReason: line };
  };
  const isRequester = same(input.approverId, input.requesterId);
  if (input.tier !== "high") {
    const maintainer = has(directory.people.eligibleIds, input.approverId);
    const member = has(directory.projectMemberIds, input.approverId) || maintainer;
    if (!(maintainer || (isRequester && member))) return { ok: false, code: "not_eligible" };
    const reason = reasonOf();
    if ("ok" in reason) return reason;
    return { ok: true, mode: isRequester ? "requester" : "maintainer", ...(reason.proofReason === undefined ? {} : { proofReason: reason.proofReason }) };
  }
  const approvers = highRiskApprovers(input.setting, directory, input.edition);
  if (!approvers.ok) return { ok: false, code: approvers.code };
  if (!has(approvers.ids, input.approverId)) return { ok: false, code: "not_eligible" };
  if (!input.freshSignIn) return { ok: false, code: "fresh_sign_in_required" };
  let mode: "high_risk_approver" | "sole_owner_exception" = "high_risk_approver";
  if (isRequester) {
    // The person who asked is not the second person. Only the sole-owner exception lets them decide: they are the only eligible approver AND the only owner, with the shared 24-hour cool-off.
    const spelled = approvers.ids.find((id) => same(id, input.approverId)) ?? input.approverId;
    const outcome = secondPersonOutcome({ ...directory.people, eligibleIds: approvers.ids }, spelled, spelled, input.nowMs);
    if (!outcome.ok) {
      if (outcome.code === "sole_owner_cool_off") return { ok: false, code: "sole_owner_cool_off", ...(outcome.availableAt === undefined ? {} : { availableAt: outcome.availableAt }) };
      return { ok: false, code: outcome.code === "second_person_required" ? "requester_cannot_approve_high" : "eligibility_unavailable" };
    }
    mode = "sole_owner_exception";
  }
  const reason = reasonOf();
  if ("ok" in reason) return reason;
  return { ok: true, mode, ...(reason.proofReason === undefined ? {} : { proofReason: reason.proofReason }) };
}

export type SkipRefusal = "skip_not_allowed" | "high_risk_approver_only" | "eligibility_unavailable" | "group_not_available" | "no_high_risk_approver";

/**
 * Whether this person may skip design review (3.1, Q10). `allowSkip: false` takes the Skip away from everyone. A design with a high-risk area (Understand's reasons or the design's touches) may be skipped only
 * by a high-risk approver; the requester sees "Ask <approver> to skip". Reasons are model words that can only add: a missing high reason cannot be fixed here, so it is the setting's `never`/`always` that
 * protects such a project, and the code-computed tier still applies to whatever design is written.
 */
export function maySkipDesignReview(input: {
  setting: Pick<DesignReviewSetting, "allowSkip" | "highRiskApprover">; reasons: readonly DesignReason[]; touches?: readonly DesignReason[] | undefined;
  skipperId: string; directory: DesignApproverDirectory; edition: EditionPolicy | undefined;
}): { ok: true } | { ok: false; code: SkipRefusal } {
  if (!input.setting.allowSkip) return { ok: false, code: "skip_not_allowed" };
  if (!isHighRiskCodes([...input.reasons, ...(input.touches ?? [])])) return { ok: true };
  const approvers = highRiskApprovers(input.setting, input.directory, input.edition);
  if (!approvers.ok) return { ok: false, code: approvers.code };
  return has(approvers.ids, input.skipperId) ? { ok: true } : { ok: false, code: "high_risk_approver_only" };
}

/**
 * Who is asked a design question (3.7): the requester always; and when the question is about a high-risk area, the high-risk approver too. The first answer counts and both are named on the record. A group or
 * set that cannot be worked out asks the requester only and the question stays open: nothing is auto-answered.
 */
export function designQuestionAudience(input: {
  requesterId: string; aboutHighRisk: boolean; setting: Pick<DesignReviewSetting, "highRiskApprover">; directory: DesignApproverDirectory; edition: EditionPolicy | undefined;
}): string[] {
  if (!input.aboutHighRisk) return [input.requesterId];
  const approvers = highRiskApprovers(input.setting, input.directory, input.edition);
  return unique([input.requesterId, ...(approvers.ok ? approvers.ids : [])]);
}
