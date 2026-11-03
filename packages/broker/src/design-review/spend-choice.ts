// Design review stage (DR8 fix round, M7): the handler for a choice made on a design review's spend card (raise the cap, run a lower tier, run it unpriced, skip design review). The card's `choose` actions POST to
// `/v1/app/tasks/{taskId}/design-review/spend/{choice}` (`spend-card.ts`); that route is one line that calls this. EVERYTHING that decides lives here, so the card's own wording or a viewer's button changes nothing:
//   - the gate is worked out AGAIN from the broker's record of the task and the effective setting (the lock applied), for THIS caller: the amount, the tier and the cap come from the record, never the request;
//   - a choice the gate does not offer this caller is refused (a Skip the skip rules refuse them; a raise above the highest cap or the company's ceiling; a lower tier that does not fit);
//   - authority: `run_unpriced` is the REQUESTER's alone (3.6); `raise_cap` is the requester's only up to the low spend amount ($10) and a project maintainer's above it, never above the ceiling; `lower_tier` is the
//     requester's or a maintainer's; `skip` goes through the skip rules (`maySkipDesignReview`) for the caller;
//   - friction by the card's tier: the digest must be what the server shows now (a changed estimate, cap or design makes an old look worthless); medium: the evidence of that digest must have been opened; high: a
//     fresh sign-in;
//   - the commit is conditional on the task record's revision, and the decision is recorded under the request id (a replay returns the earlier outcome; the same id for another choice is refused).
// An unpriced run is bounded by MEASURED spend (M5): the applied choice carries `stopAtMeasuredUsd`, the cap, which the dispatch checks with `designReviewSpendStop` before every reviewer and call.
import { createHash } from "node:crypto";
import { agentXError, canonicalJson, lowerDesignReviewTier, raiseDesignReviewCap, skipDesignReview, startDesignReview, type WorkflowSnapshot, type DesignReason, type DesignReviewTier, type EditionPolicy } from "@agentx/contracts";
import { DECISION_CHANGED_MESSAGE, DECISION_OPEN_FIRST_MESSAGE, DECISION_FULL_PAGE_MESSAGE, type DecisionCaller } from "../decisions/routes.js";
import { projectDecisionCards, type DecisionItem } from "../decisions/project.js";
import { DECISION_SPEND_LOW_MAX_USD, riskTierOf, type DecisionLocks } from "../decisions/risk-tier.js";
import type { DecisionStore } from "../decisions/store.js";
import { secondPersonMembershipCondition } from "../org/second-person-approval.js";
import { maySkipDesignReview, type DesignApproverDirectory, type SkipRefusal } from "./approval.js";
import type { EffectiveDesignReviewSetting } from "./effective-setting.js";
import { gateDesignReviewCost, type DesignReviewCapGate, type DesignReviewEstimate, type DesignSpendChoice } from "./estimate.js";
import { designSpendCardItem } from "./spend-card.js";

export type DesignSpendChoiceName = DesignSpendChoice["choice"];

/** The broker's record of the task and its gate, read fresh for this request. Nothing in it comes from the request body. */
export interface DesignSpendContext {
  taskId: string;
  requesterId: string;
  /** The tier the review is about to run at. */
  tier: DesignReviewTier;
  setting: EffectiveDesignReviewSetting;
  /** The cap this task has now (the setting's, or a raise already made for this task). */
  taskCapUsd: number;
  /** What this review has already spent (the review record's `spentUsd`). The gate compares the estimate with the cap minus this, as the workflow does when it starts (money N1). */
  spentUsd: number;
  /** The company lock's cap ceiling, if any. */
  capCeilingUsd?: number | undefined;
  estimate: DesignReviewEstimate;
  /** What the next lower tier would cost with the same models (undefined: no lower tier, or it has no price). */
  lowerTier?: { tier: DesignReviewTier; estimate: DesignReviewEstimate } | undefined;
  reasons: readonly DesignReason[];
  touches: readonly DesignReason[];
  directory: DesignApproverDirectory;
  edition: EditionPolicy | undefined;
  /** The person signed in freshly for this decision (the session), needed only when the card is high. */
  freshSignIn: boolean;
  /** The version of the task record this gate was worked out from. The commit is conditional on it. */
  revision: string;
  card: { subjectId: string; project: string; title: string; createdAt: string; openPath: string; contentVersion: string };
}

export type DesignSpendApplied =
  | { choice: "lower_tier"; tier: DesignReviewTier }
  | { choice: "raise_cap"; newCapUsd: number }
  /** `stopAtMeasuredUsd`: the run stops when the proxy's MEASURED spend reaches this, whatever the price (M5). */
  | { choice: "run_unpriced"; stopAtMeasuredUsd: number }
  | { choice: "skip" };

export interface DesignSpendWrite {
  taskId: string;
  requestId: string;
  actorId: string;
  applied: DesignSpendApplied;
  /** Conditional on this: the task record is still the one the gate was worked out from. */
  revision: string;
  fence: ReturnType<typeof secondPersonMembershipCondition>;
}

export interface DesignSpendPorts<C extends DecisionCaller> {
  context(caller: C, taskId: string): Promise<DesignSpendContext | undefined>;
  locks(caller: C): Promise<DecisionLocks>;
  store: Pick<DecisionStore, "evidenceOpenedAt" | "findDecision" | "recordDecision">;
  now(): number;
  commit(caller: C, write: DesignSpendWrite): Promise<"done" | "stale">;
}

export interface DesignSpendRequest { taskId: string; choice: DesignSpendChoiceName; requestId: string; shownDigest: string }
export type DesignSpendResult = { kind: "done"; choice: DesignSpendChoiceName; replay: boolean; applied?: DesignSpendApplied };

const same = (left: string, right: string): boolean => left.normalize("NFC").trim().toLowerCase() === right.normalize("NFC").trim().toLowerCase();
const has = (list: readonly string[], id: string): boolean => list.some((entry) => same(entry, id));

/** The gate for this caller, and the card item that shows it. `go` when nothing needs asking (the choice is then stale). Used by the card's source and by the handler, so both see the same card. */
export function designSpendGateFor(context: DesignSpendContext, callerId: string): { gate: DesignReviewCapGate; skip: { ok: true } | { ok: false; code: SkipRefusal } } {
  const skip = maySkipDesignReview({ setting: context.setting, reasons: context.reasons, touches: context.touches, skipperId: callerId, directory: context.directory, edition: context.edition });
  const gate = gateDesignReviewCost({ tier: context.tier, capUsd: context.taskCapUsd, spentUsd: context.spentUsd, capCeilingUsd: context.capCeilingUsd, estimate: context.estimate, lowerTier: context.lowerTier, canSkip: skip.ok });
  return { gate, skip };
}

/** The pending `approve_spend` item for a gate that asks. Its version covers the gate's inputs, so a changed estimate, cap, tier or choice list is a different card. */
export function designSpendItemFor(context: DesignSpendContext, gate: Extract<DesignReviewCapGate, { kind: "ask" }>): DecisionItem {
  const inputs = createHash("sha256").update(canonicalJson({ tier: context.tier, cap: context.taskCapUsd, spent: context.spentUsd, ceiling: context.capCeilingUsd ?? null, gate, revision: context.revision })).digest("hex").slice(0, 16);
  const head = context.card.contentVersion.length > 70 ? createHash("sha256").update(context.card.contentVersion).digest("hex").slice(0, 32) : context.card.contentVersion;
  return designSpendCardItem({ taskId: context.taskId, ...context.card, contentVersion: `${head}:${inputs}`, gate, capUsd: context.taskCapUsd });
}

export type SpendAuthority = { ok: true } | { ok: false; code: "requester_only" | "maintainer_only" | "not_a_member" | "above_ceiling" };

/**
 * Who may make this choice. Members only (a maintainer or a project member who is not an Auditor or viewer); then by choice: unpriced is the requester's alone; a raise is the requester's up to the low amount and a
 * maintainer's above it; a lower tier is the requester's or a maintainer's. Skip is judged by the skip rules, not here.
 */
export function mayChooseDesignSpend(input: { choice: Exclude<DesignSpendChoiceName, "skip">; callerId: string; requesterId: string; newCapUsd?: number | undefined; ceilingUsd?: number | undefined; directory: DesignApproverDirectory }): SpendAuthority {
  const { directory } = input;
  const maintainer = has(directory.people.eligibleIds, input.callerId);
  const member = maintainer || has(directory.projectMemberIds, input.callerId);
  if (!member || has(directory.notApproverIds, input.callerId)) return { ok: false, code: "not_a_member" };
  const requester = same(input.callerId, input.requesterId);
  switch (input.choice) {
    case "run_unpriced": return requester ? { ok: true } : { ok: false, code: "requester_only" };
    case "lower_tier": return requester || maintainer ? { ok: true } : { ok: false, code: "requester_only" };
    case "raise_cap":
      if (input.newCapUsd === undefined || (input.ceilingUsd !== undefined && input.newCapUsd > input.ceilingUsd)) return { ok: false, code: "above_ceiling" };
      return maintainer || (requester && input.newCapUsd <= DECISION_SPEND_LOW_MAX_USD) ? { ok: true } : { ok: false, code: "maintainer_only" };
  }
}

const CHOICE_REFUSALS: Record<Exclude<SpendAuthority, { ok: true }>["code"], string> = {
  requester_only: "Only the person who asked for this task can choose this.",
  maintainer_only: "A project maintainer has to raise the limit this far.",
  not_a_member: "You can't decide this.",
  above_ceiling: "Your company doesn't allow a limit this high.",
};
const SKIP_REFUSALS: Record<SkipRefusal, string> = {
  skip_not_allowed: "This project doesn't allow skipping design review.",
  not_a_member: "You can't decide this.",
  high_risk_approver_only: "Only the design approver can skip a high-risk design review.",
  eligibility_unavailable: "Who may skip can't be worked out right now.",
  group_not_available: "Who may skip can't be worked out right now.",
  no_high_risk_approver: "Who may skip can't be worked out right now.",
};

export function designSpendChoiceHandler<C extends DecisionCaller>(ports: DesignSpendPorts<C>): (caller: C, request: DesignSpendRequest) => Promise<DesignSpendResult> {
  return async (caller, request) => {
    const who = { orgId: caller.orgId, developerId: caller.developerId };
    const context = await ports.context(caller, request.taskId);
    if (context === undefined) throw agentXError("NOT_FOUND", "This decision is no longer waiting for you.");
    const cardId = `approve_spend:${context.card.subjectId}`;
    // A replay returns the earlier outcome and writes nothing (before anything else: once a choice is made the gate no longer asks); the same id for another card or choice is refused.
    const earlier = await ports.store.findDecision(who, request.requestId);
    if (earlier !== undefined) {
      if (earlier.cardId !== cardId || earlier.reason !== request.choice) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
      return { kind: "done", choice: request.choice, replay: true };
    }
    const { gate, skip } = designSpendGateFor(context, caller.developerId);
    if (gate.kind === "go") throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
    const item = designSpendItemFor(context, gate);
    const offered = gate.choices.find((choice) => choice.choice === request.choice);
    if (offered === undefined) {
      if (request.choice === "skip" && !skip.ok) throw agentXError("FORBIDDEN", SKIP_REFUSALS[skip.code]);
      throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
    }
    // The card as this person was shown it: its digest, risk and friction come from the record, and what they were shown must be what the server shows now.
    const locks = await ports.locks(caller);
    const projection = projectDecisionCards([item], { locks, pairFullCards: false });
    const card = projection.cards[0];
    const digest = projection.digests[cardId];
    if (card === undefined || digest === undefined) throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
    if (request.shownDigest !== digest) throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
    const risk = riskTierOf("approve_spend", { spend: { amountUsd: gate.estimateUsd ?? 0 } }, locks).risk;
    if (risk === "high" && !context.freshSignIn) throw agentXError("FORBIDDEN", "Sign in again to decide this.");
    if (risk === "medium" || card.friction.expandEvidenceFirst) {
      const opened = await ports.store.evidenceOpenedAt({ ...who, cardId }, digest);
      if (opened === undefined) throw agentXError("CHANGE_STALE", DECISION_OPEN_FIRST_MESSAGE);
    }
    // Authority, by choice.
    let applied: DesignSpendApplied;
    switch (offered.choice) {
      case "skip":
        if (!skip.ok) throw agentXError("FORBIDDEN", SKIP_REFUSALS[skip.code]);
        applied = { choice: "skip" };
        break;
      case "lower_tier":
      case "raise_cap":
      case "run_unpriced": {
        const authority = mayChooseDesignSpend({
          choice: offered.choice, callerId: caller.developerId, requesterId: context.requesterId, newCapUsd: offered.choice === "raise_cap" ? offered.newCapUsd : undefined, ceilingUsd: context.capCeilingUsd, directory: context.directory,
        });
        if (!authority.ok) throw agentXError("FORBIDDEN", CHOICE_REFUSALS[authority.code]);
        applied = offered.choice === "lower_tier" ? { choice: "lower_tier", tier: offered.tier } : offered.choice === "raise_cap" ? { choice: "raise_cap", newCapUsd: offered.newCapUsd } : { choice: "run_unpriced", stopAtMeasuredUsd: context.taskCapUsd };
        break;
      }
    }
    const written = await ports.commit(caller, { taskId: context.taskId, requestId: request.requestId, actorId: caller.developerId, applied, revision: context.revision, fence: secondPersonMembershipCondition(context.directory.people.membershipVersion) });
    if (written !== "done") throw agentXError("CHANGE_STALE", DECISION_CHANGED_MESSAGE);
    const decidedAt = new Date(ports.now()).toISOString();
    // The decision row is history, written after the commit: a failure to write it never turns a made choice into an error. For a spend choice, `reason` holds the choice word.
    try { await ports.store.recordDecision({ ...who, cardId, kind: "approve_spend", risk, outcome: "approved", reason: request.choice, requestId: request.requestId, createdAt: card.createdAt, decidedAt }); } catch { /* history is best effort */ }
    return { kind: "done", choice: request.choice, replay: false, applied };
  };
}


/**
 * What the commit port does with an applied choice: the contract move for each one, at the revision the gate was worked out from. DR7's commit port calls this inside its conditional write, so the choice
 * on the card and the move on the workflow can never differ:
 *   raise_cap -> raiseDesignReviewCap (records who), lower_tier -> lowerDesignReviewTier (records who), run_unpriced -> startDesignReview with the spend approved by this person,
 *   skip -> skipDesignReview (`person_skip`, with who; the review is not retried or re-armed). `estimateUsd` is the estimate the gate used (the lower tier's, for lower_tier).
 * Each move throws a WorkflowTransitionError when the workflow is no longer where the card was drawn, which the commit port turns into "stale".
 */
export function applyDesignSpendChoice(snapshot: unknown, write: Pick<DesignSpendWrite, "actorId" | "applied">, input: { expectedRevision: number; now: string; estimateUsd?: number | undefined }): WorkflowSnapshot {
  const by = { actorId: write.actorId };
  const estimate = input.estimateUsd === undefined ? {} : { estimateUsd: input.estimateUsd };
  switch (write.applied.choice) {
    case "raise_cap": return raiseDesignReviewCap(snapshot, { expectedRevision: input.expectedRevision, capUsd: write.applied.newCapUsd, by, ...estimate, now: input.now });
    case "lower_tier": return lowerDesignReviewTier(snapshot, { expectedRevision: input.expectedRevision, tier: write.applied.tier, by, ...estimate, now: input.now });
    case "run_unpriced": return startDesignReview(snapshot, { expectedRevision: input.expectedRevision, costApproved: { by }, now: input.now });
    case "skip": return skipDesignReview(snapshot, { expectedRevision: input.expectedRevision, by, now: input.now });
  }
}
