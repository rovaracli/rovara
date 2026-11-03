// Design review stage (DR9 fix round, H1): the handler that approves a design. The decisions route calls it through the performer for an `approve_design` card; EVERY permission and friction check is in here, so
// the route (which only checks the digest and that a medium card's evidence was opened) is not the only thing standing between a person and an approval:
//   - the tier is worked out here again, from the broker's own item, by `riskTierOf` (a card or a client cannot lower it);
//   - who may approve, in what capacity, a fresh sign-in on high, and the sole-owner exception are `decideDesignApproval` (approval.ts), fed the broker's own record: the requester from the TASK, the fresh
//     sign-in from the SESSION, the directory read fresh (never the request body);
//   - medium: the evidence of exactly the digest the person was shown must have been opened (re-checked here), and the digest must still be what the server shows;
//   - an open blocker needs a one-line `reason` (Q8); a reason anywhere else is refused, so it cannot be smuggled onto a clean approval;
//   - the commit is fenced with the membership evidence (`secondPersonMembershipCondition`), carries the reason for the PR's Proof line, and says when it was the sole-owner exception so the caller can audit
//     `sole_owner_exception`.
// It writes nothing itself: `commit` is the broker's design-phase decision (`decide.ts`), a port. Wiring pending (hot file): `handlers.approve_design = designApproveHandler(...)` in the performer's handler list, and
// the route passing `reason` and `shown` (see report.md "Wiring pending").
import { agentXError, type EditionPolicy } from "@agentx/contracts";
import { DECISION_CHANGED_MESSAGE, DECISION_OPEN_FIRST_MESSAGE, type DecisionCaller, type PerformInput, type PerformOutcome } from "../decisions/routes.js";
import { perform, type KindHandler } from "../decisions/performer.js";
import { projectDecisionCards, type DecisionItem } from "../decisions/project.js";
import { riskTierOf, type DecisionLocks } from "../decisions/risk-tier.js";
import type { DecisionStore } from "../decisions/store.js";
import { secondPersonMembershipCondition } from "../org/second-person-approval.js";
import { openBlockerWords } from "./proof-line.js";
import { decideDesignApproval, type DesignApprovalRefusal, type DesignApprovalTier, type DesignApproverDirectory } from "./approval.js";
import type { EffectiveDesignReviewSetting } from "./effective-setting.js";

type DesignItem = Extract<DecisionItem, { kind: "approve_design" }>;

/** What the decisions route passes beyond the usual: the approve body's `reason`, and the card and digest the person was SHOWN (the evidence-opened record is keyed by them). */
export type DesignApproveInput = PerformInput;

/** The broker's own record of the design, read fresh for this request. Nothing in it comes from the request body. */
export interface DesignApprovalContext {
  /** The person who asked for the task (the task record), never a body field. */
  requesterId: string;
  setting: EffectiveDesignReviewSetting;
  edition: EditionPolicy | undefined;
  directory: DesignApproverDirectory;
  /** The person signed in freshly for this decision (the session's authentication time, not a body field). */
  freshSignIn: boolean;
}

/** What is committed. `fence` goes into the committing transaction (the membership generation the eligibility was read at). */
export interface DesignApprovalWrite {
  subjectId: string;
  taskId: string | undefined;
  requestId: string;
  tab: PerformInput["tab"];
  approverId: string;
  requesterId: string;
  tier: DesignApprovalTier;
  mode: "requester" | "maintainer" | "high_risk_approver" | "sole_owner_exception";
  openBlockers: number;
  /** The cleaned one-line reason, when blockers were open. */
  proofReason: string | undefined;
  /** The words for the PR's Proof line, when blockers were open. */
  proofLine: string | undefined;
  /** True for the sole-owner exception: the committer audits `sole_owner_exception`. */
  auditSoleOwnerException: boolean;
  fence: ReturnType<typeof secondPersonMembershipCondition>;
  /** The version of what the person was shown. */
  contentVersion: string;
}

export interface DesignApprovePorts<C extends DecisionCaller> {
  /** The broker's record of this design now; undefined when the task or design is gone (the card is stale). */
  context(caller: C, item: DesignItem): Promise<DesignApprovalContext | undefined>;
  locks(caller: C): Promise<DecisionLocks>;
  store: Pick<DecisionStore, "evidenceOpenedAt">;
  nowMs(): number;
  /** The https confirmation page for a fresh sign-in, or undefined when there is none. */
  confirmUrl(caller: C, item: DesignItem): string | undefined;
  /** Commits the design-phase decision, fenced and in one transaction with its audit and request record. `stale` when the design or the fence moved. */
  commit(caller: C, write: DesignApprovalWrite): Promise<"done" | "stale">;
}

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;

/**
 * The words on the PR's Proof line when a design was approved with open blockers. Empty (undefined) when there were none. The approver's reason is a person's words on a line the repository's readers see, so it is
 * made inert here (`inertLine`: no @ mention, link, issue reference or markup survives) by the same function the Proof section uses (money N11).
 */
export function designApprovalProofLine(openBlockers: number, reason: string | undefined): string | undefined {
  if (openBlockers <= 0 || reason === undefined) return undefined;
  return openBlockerWords(openBlockers, reason);
}

const REFUSAL_OUTCOME: Record<Exclude<DesignApprovalRefusal, "reason_required" | "fresh_sign_in_required">, PerformOutcome> = {
  not_eligible: { kind: "refused", reason: "forbidden" },
  requester_cannot_approve_high: { kind: "refused", reason: "second_person_required" },
  group_not_available: { kind: "refused", reason: "not_ready" },
  no_high_risk_approver: { kind: "refused", reason: "not_ready" },
  eligibility_unavailable: { kind: "refused", reason: "not_ready" },
};

export const DESIGN_REASON_REQUIRED_MESSAGE = "reason: say in one line why you approve with an open blocker";
export const DESIGN_REASON_NOT_ALLOWED_MESSAGE = "reason: a reason is taken only when a blocker is open";

export function designApproveHandler<C extends DecisionCaller>(ports: DesignApprovePorts<C>): KindHandler<C> {
  return {
    approve: (caller, rawInput) => perform(async (): Promise<PerformOutcome> => {
      const input = rawInput;
      const item = input.item;
      if (item.kind !== "approve_design") return { kind: "refused", reason: "unsupported" };
      const context = await ports.context(caller, item);
      if (context === undefined) return { kind: "refused", reason: "stale" };
      // The tier: the higher of what the card says and what the broker's own rules say now. It can be raised here, never lowered.
      const locks = await ports.locks(caller);
      const worked = riskTierOf("approve_design", { design: { files: item.files, ...(item.review === undefined ? {} : { review: item.review }) } }, locks).risk;
      const tier: DesignApprovalTier = RISK_ORDER[worked] >= RISK_ORDER[input.card.risk] ? worked : input.card.risk;
      const openBlockers = item.review?.blockers.length ?? 0;
      if (input.reason !== undefined && openBlockers === 0) throw agentXError("CONFIG_INVALID", DESIGN_REASON_NOT_ALLOWED_MESSAGE);
      // Medium: the evidence of exactly the version shown must have been opened. The digest must also still be what the server shows (a card with tabs is checked by the route, which holds its pair).
      if (tier === "medium") {
        if (input.shown === undefined) throw agentXError("CHANGE_STALE", DECISION_OPEN_FIRST_MESSAGE);
        if (input.tab === undefined) {
          const now = projectDecisionCards([item], { locks, pairFullCards: false }).digests[input.card.id];
          if (now === undefined || now !== input.shown.digest) throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
        }
        const opened = await ports.store.evidenceOpenedAt({ orgId: caller.orgId, developerId: caller.developerId, cardId: input.shown.cardId, tab: input.tab }, input.shown.digest);
        if (opened === undefined) throw agentXError("CHANGE_STALE", DECISION_OPEN_FIRST_MESSAGE);
      }
      const decision = decideDesignApproval({
        tier, requesterId: context.requesterId, approverId: caller.developerId, nowMs: ports.nowMs(), setting: context.setting, edition: context.edition, directory: context.directory,
        freshSignIn: context.freshSignIn, openBlockers, blockerReason: input.reason,
      });
      if (!decision.ok) {
        if (decision.code === "reason_required") throw agentXError("CONFIG_INVALID", DESIGN_REASON_REQUIRED_MESSAGE);
        if (decision.code === "fresh_sign_in_required") {
          const confirmUrl = ports.confirmUrl(caller, item);
          return confirmUrl === undefined ? { kind: "refused", reason: "forbidden" } : { kind: "needs_confirmation", confirmUrl };
        }
        return REFUSAL_OUTCOME[decision.code];
      }
      const written = await ports.commit(caller, {
        subjectId: item.subjectId, taskId: item.taskId, requestId: input.requestId, tab: input.tab, approverId: caller.developerId, requesterId: context.requesterId, tier,
        mode: decision.mode, openBlockers, proofReason: decision.proofReason, proofLine: designApprovalProofLine(openBlockers, decision.proofReason),
        auditSoleOwnerException: decision.mode === "sole_owner_exception", fence: secondPersonMembershipCondition(context.directory.people.membershipVersion), contentVersion: item.contentVersion,
      });
      return written === "done" ? { kind: "done" } : { kind: "refused", reason: "stale" };
    }),
  };
}
