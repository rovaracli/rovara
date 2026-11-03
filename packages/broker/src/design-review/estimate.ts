// Design review stage (DR8, design-review-stage.md 3.4 and 3.6): what a design review will cost, worked out BEFORE anything runs, and the decision when it is over the cap or cannot be priced.
// Pure: it reads no store and calls no model. The caller gives it the models the resolver chose (reviewers and the merge step resolve through the existing `plan_check` stage; there is no `design_review`
// stage) and a price lookup over the catalog.
//
//   estimate = tier reviewers x (packet tokens in + 4k out) x the reviewer model's catalog price
//            + the merge step (a model, except in Light where the merge is code only)
//            + the planner's runs (about 40k in / 8k out each): per round, one run that may ask and one that resolves after the answers, except in the last round, which does not ask (B2-M1)
//   for 2 rounds (Q7).
//
// A reviewer review is priced by `estimateSecondReviewUsd`, the same function the second-review picker uses, so the two never disagree.
// NO PRICE MEANS "COST UNAVAILABLE": a model the catalog has no price for is never guessed at (How we work 5.3). The review then needs one tap from the requester (an `approve_spend` card, low risk).
// Customer pays (owner 2026-11-03): this file only describes a cost; nothing here spends or mints a key.
import { DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_ROUNDS_MAX, DESIGN_REVIEW_TIERS, addDesignUsd, designReviewCapRoom, type DesignReviewTier, type ModelIdentifier, type ReviewerRole } from "@agentx/contracts";
import { SECOND_REVIEW_TYPICAL_REVIEW_TOKENS, estimateSecondReviewUsd, type SecondReviewPrice } from "../rovara-code/second-review-picker.js";

/** The reviewers each tier runs per round (3.4). Zoom-out and Critic B are priced in every round of Thorough: the estimate may be high, never low. */
export const TIER_REVIEWERS: Readonly<Record<DesignReviewTier, readonly ReviewerRole[]>> = {
  light: ["critic"],
  standard: ["comprehension", "critic", "codebase"],
  thorough: ["comprehension", "critic", "codebase", "zoom_out", "critic_b"],
};
/**
 * Reviewers that read code or search with tools re-send the whole context on every tool turn, so what they read is a multiple of the packet (M4). Comprehension reads the packet alone (one call). The factors are
 * deliberately round and high: the estimate may be high, never low. DR-FU2/FU3 replace them with measured turns from staging spend logs; until then they are named and tested, not guessed again in place.
 */
export const ROLE_INPUT_TURN_FACTOR: Readonly<Record<ReviewerRole, number>> = { comprehension: 1, critic: 2, codebase: 3, zoom_out: 2, critic_b: 2 };

/** The reviewers one round of a tier runs. Zoom-out runs only AFTER round 1, on what changed (3.4), so round 1 of Thorough is four reviewers and round 2 is five. */
export function reviewersForRound(tier: DesignReviewTier, round: 1 | 2): readonly ReviewerRole[] {
  return round === 1 ? TIER_REVIEWERS[tier].filter((role) => role !== "zoom_out") : TIER_REVIEWERS[tier];
}

/** Light merges in code only: no model runs and nothing is priced. */
export const TIER_HAS_MERGE_MODEL: Readonly<Record<DesignReviewTier, boolean>> = { light: false, standard: true, thorough: true };

/** What a reviewer writes (tokens out): the same 4k as a second review. */
export const REVIEWER_OUTPUT_TOKENS = SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.output;
/** A planner revision (3.4): about 40k in and 8k out per run. */
export const PLANNER_REVISION_TOKENS = { input: 40_000, output: 8_000 } as const;
/**
 * B2-M1: how many planner runs the rounds still to run can hold. A round that may still ask runs the planner twice (the run that asks, then the run that resolves with the answers); the LAST round does not ask, so it runs
 * the planner once. So 2 rounds are 3 runs and a last round alone is 1. The estimate prices all of them and the round start holds their price back from the reviewers' room.
 */
export const plannerRunsFor = (roundsToRun: number): number => (Number.isInteger(roundsToRun) && roundsToRun >= 1 ? 2 * roundsToRun - 1 : 0);
/** The merge step reads the raw findings (at most 15 per reviewer) and writes the merged list. A generous bound: the estimate may be high, never low. */
export const MERGE_TOKENS = { perReviewerInput: 6_000, designInput: 8_000, output: 6_000 } as const;

export type PriceLookup = (model: ModelIdentifier) => SecondReviewPrice | undefined;

/** Which model price was missing. */
export type PricedPart = "reviewer" | "merge" | "planner" | "packet";

export interface DesignReviewEstimateInput {
  tier: DesignReviewTier;
  /** The models the resolver chose. The merge model defaults to the reviewer's (a model the customer connected is always at least as dear as a fast one: the estimate cannot come out low). */
  models: { reviewer: ModelIdentifier | undefined; merge?: ModelIdentifier | undefined; planner: ModelIdentifier | undefined };
  price: PriceLookup;
  /**
   * Tokens in a reviewer's packet (the broker builds it, so it knows its bytes: design, requirements and every source). REQUIRED (M4): a guess of 60k could come out low for a big packet and pass the gate.
   * A number that is not a usable size makes the estimate "Cost unavailable", never a default.
   */
  packetTokens: number;
  /** Rounds to price. Absent: the maximum, 2. */
  rounds?: 1 | 2 | undefined;
}

export interface DesignReviewCostBreakdown { reviewersUsd: number; mergeUsd: number; plannerUsd: number }

export type DesignReviewEstimate =
  | { kind: "priced"; usd: number; breakdown: DesignReviewCostBreakdown; tier: DesignReviewTier; reviewers: number; rounds: number }
  /** "Cost unavailable": the parts the catalog had no price for. Never a number. */
  | { kind: "unavailable"; tier: DesignReviewTier; missing: PricedPart[] };

/** Money to a millionth of a dollar, so a sum of the same parts is the same number whatever the order. */
const micro = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

// A packet always holds at least the design and the requirements: 0 (or less) prices a review with no input and is "cost unavailable", never a free review (money N8).
const validTokens = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * The estimate for one tier. `unavailable` when any model it must price has no catalog price (or was not resolved at all): nothing is guessed, and a zero price is not read as "free" unless the
 * catalog says so.
 */
export function estimateDesignReviewUsd(input: DesignReviewEstimateInput): DesignReviewEstimate {
  const rounds = input.rounds ?? DESIGN_REVIEW_ROUNDS_MAX;
  const packet = input.packetTokens;
  const reviewers = TIER_REVIEWERS[input.tier].length;
  const priceOf = (model: ModelIdentifier | undefined): SecondReviewPrice | undefined => {
    if (model === undefined) return undefined;
    const price = input.price(model);
    return price !== undefined && Number.isFinite(price.inputUsdPerMTok) && Number.isFinite(price.outputUsdPerMTok) && price.inputUsdPerMTok >= 0 && price.outputUsdPerMTok >= 0 ? price : undefined;
  };
  const reviewerPrice = priceOf(input.models.reviewer);
  const mergePrice = TIER_HAS_MERGE_MODEL[input.tier] ? priceOf(input.models.merge ?? input.models.reviewer) : undefined;
  const plannerPrice = priceOf(input.models.planner);
  const missing: PricedPart[] = [];
  if (!validTokens(packet)) missing.push("packet");
  if (reviewerPrice === undefined) missing.push("reviewer");
  if (TIER_HAS_MERGE_MODEL[input.tier] && mergePrice === undefined) missing.push("merge");
  if (plannerPrice === undefined) missing.push("planner");
  if (missing.length > 0 || reviewerPrice === undefined || plannerPrice === undefined || (TIER_HAS_MERGE_MODEL[input.tier] && mergePrice === undefined)) return { kind: "unavailable", tier: input.tier, missing };
  // Every reviewer of the tier is priced in every round (Zoom-out too: high, never low), each at its role's turn factor.
  const perRound = TIER_REVIEWERS[input.tier].reduce((sum, role) => sum + estimateSecondReviewUsd(reviewerPrice, { input: packet * ROLE_INPUT_TURN_FACTOR[role], maxOutput: REVIEWER_OUTPUT_TOKENS }), 0);
  const reviewersUsd = micro(perRound * rounds);
  const mergeUsd = mergePrice === undefined ? 0 : micro(estimateSecondReviewUsd(mergePrice, { input: MERGE_TOKENS.designInput + MERGE_TOKENS.perReviewerInput * reviewers, maxOutput: MERGE_TOKENS.output }) * rounds);
  const plannerUsd = micro(estimateSecondReviewUsd(plannerPrice, { input: PLANNER_REVISION_TOKENS.input, maxOutput: PLANNER_REVISION_TOKENS.output }) * plannerRunsFor(rounds));
  return { kind: "priced", usd: micro(reviewersUsd + mergeUsd + plannerUsd), breakdown: { reviewersUsd, mergeUsd, plannerUsd }, tier: input.tier, reviewers, rounds };
}

/** The tier below this one, or undefined for the lowest. */
export function nextLowerTier(tier: DesignReviewTier): DesignReviewTier | undefined {
  const index = DESIGN_REVIEW_TIERS.indexOf(tier);
  return index > 0 ? DESIGN_REVIEW_TIERS[index - 1] : undefined;
}

/** What the gate decided. `go`: run now. `ask`: nothing runs until a person picks one of the choices on an `approve_spend` card. */
export type DesignReviewCapGate =
  | { kind: "go"; estimateUsd: number }
  | { kind: "ask"; why: "over_cap" | "cost_unavailable"; estimateUsd: number | undefined; choices: DesignSpendChoice[] };

/** One of the (at most three) actions on the spend card. */
export type DesignSpendChoice =
  | { choice: "lower_tier"; tier: DesignReviewTier; estimateUsd: number }
  | { choice: "raise_cap"; newCapUsd: number }
  /** Run design review for this task anyway, with the price unknown: only offered for "cost unavailable", and only the requester may choose it. MEASURED spend still bounds the run: every reviewer's and the merge step's key has a fixed ceiling inside what is left under the cap (`allocateSlotBudgets`), and the planner's key is held to what is left too (`plannerRunRoomUsd`). */
  | { choice: "run_unpriced" }
  | { choice: "skip" };

export interface CapGateInput {
  tier: DesignReviewTier;
  capUsd: number;
  /**
   * What the review has already spent (the review record's `spentUsd`, re-arms and retries included). REQUIRED: the gate compares the estimate with what is LEFT under the cap, exactly as the workflow's
   * `designReviewCapRoom` does when the review starts, so a card can never say "go" for a start the workflow then refuses, or offer a raise that still leaves the start refused (money N1).
   */
  spentUsd: number;
  /** The company lock's cap ceiling: a raise never goes above it. */
  capCeilingUsd?: number | undefined;
  estimate: DesignReviewEstimate;
  /** What the next lower tier would cost, worked out by the caller with the same models (undefined: no lower tier, or it has no price). */
  lowerTier?: { tier: DesignReviewTier; estimate: DesignReviewEstimate } | undefined;
  /** The skip rules (3.1, Q10), already applied for the person the card is for: false takes the option away. */
  canSkip: boolean;
}

const roundUpCents = (usd: number): number => Math.ceil(micro(usd) * 100) / 100;

/**
 * Whether a design review may start, or a person must choose first (3.6):
 *   - priced and within the cap: go;
 *   - over the cap: three choices, each only if it is allowed: run at the next lower tier (only if that tier is priced AND fits in what is left), raise the cap for this task (to what is spent plus the estimate,
 *     rounded up to a cent, only if that is at most the highest cap allowed and the company's ceiling), or skip (only if the skip rules allow);
 *   - "fits" means what `designReviewCapRoom` means: the estimate is at most the cap minus the spend so far.
 *   - no price: "Cost unavailable", one tap: run it unpriced, or skip (if allowed). Nothing runs on its own.
 * An estimate above every limit with Skip not allowed leaves no choice at all: the card then says so and the task waits for someone who can skip or change the setting. Never a silent run.
 */
export function gateDesignReviewCost(input: CapGateInput): DesignReviewCapGate {
  const { estimate } = input;
  const fits = (usd: number): boolean => designReviewCapRoom({ capUsd: input.capUsd, spentUsd: input.spentUsd, estimateUsd: usd }).kind === "fits";
  if (estimate.kind === "priced" && fits(estimate.usd)) return { kind: "go", estimateUsd: estimate.usd };
  const choices: DesignSpendChoice[] = [];
  if (estimate.kind === "unavailable") {
    choices.push({ choice: "run_unpriced" });
    if (input.canSkip) choices.push({ choice: "skip" });
    return { kind: "ask", why: "cost_unavailable", estimateUsd: undefined, choices };
  }
  const lower = input.lowerTier;
  if (lower !== undefined && lower.estimate.kind === "priced" && fits(lower.estimate.usd)) choices.push({ choice: "lower_tier", tier: lower.tier, estimateUsd: lower.estimate.usd });
  // A raise must leave room for the estimate AFTER what is already spent: to spent + estimate, not to the estimate alone.
  const raised = roundUpCents(addDesignUsd(input.spentUsd, estimate.usd));
  const ceiling = Math.min(DESIGN_REVIEW_CAP_MAX_USD, input.capCeilingUsd ?? DESIGN_REVIEW_CAP_MAX_USD);
  if (raised > input.capUsd && raised <= ceiling) choices.push({ choice: "raise_cap", newCapUsd: raised });
  if (input.canSkip) choices.push({ choice: "skip" });
  return { kind: "ask", why: "over_cap", estimateUsd: estimate.usd, choices };
}

// ---- what each reviewer's key may spend, and what a run records as its cost (money N3). Pure: DR7 puts the budget on the key and the measured cost on the run.

/**
 * The most each model key of a round may spend: what is left under the cap, split equally between the reviewers and the merge step (when it is a model), rounded DOWN to a micro-dollar so the shares never add up
 * to more than what is left. The proxy refuses calls past it (`budget_exhausted`), so the reviewers, which start together, cannot run past the cap between two checks. Nothing left gives 0: no key is minted.
 * `reservedUsd` is held back for work that is not on a reviewer key (the planner's revision), and is never given to a reviewer.
 */
export function designReviewKeyBudgets(input: { capUsd: number; spentUsd: number; reviewers: number; hasMergeModel: boolean; reservedUsd?: number }): { reviewerUsd: number; mergeUsd: number; roomUsd: number } {
  const parts = input.reviewers + (input.hasMergeModel ? 1 : 0);
  const reserved = input.reservedUsd !== undefined && Number.isFinite(input.reservedUsd) && input.reservedUsd > 0 ? input.reservedUsd : 0;
  const room = Number.isFinite(input.capUsd) && Number.isFinite(input.spentUsd) ? Math.max(0, addDesignUsd(addDesignUsd(input.capUsd, -input.spentUsd), -reserved)) : 0;
  if (!Number.isInteger(input.reviewers) || input.reviewers < 1 || parts < 1) return { reviewerUsd: 0, mergeUsd: 0, roomUsd: room };
  const share = Math.floor((room / parts) * 1_000_000) / 1_000_000;
  return { reviewerUsd: share, mergeUsd: input.hasMergeModel ? share : 0, roomUsd: room };
}

export type RecordedCostSource = "measured" | "session_estimate" | "budget_ceiling";

/**
 * The cost a reviewer's run records. The proxy's MEASURED spend for the reviewer's key wins whenever it is a usable number. The session's own figure (the catalog price times its tokens) is used only when it is above 0:
 * an unpriced model reports 0, and 0 is never recorded as the cost of a run that used tokens. With no measurement and no usable session figure the run is charged its key's whole budget, the most it could have spent,
 * so spend toward the cap is never under-counted. (`budgetUsd` is the value from `designReviewKeyBudgets`.)
 */
export function recordedReviewerCost(input: { measuredUsd: number | undefined; sessionUsd: number; budgetUsd: number; usedTokens: boolean }): { costUsd: number; source: RecordedCostSource } {
  const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
  if (usable(input.measuredUsd)) return { costUsd: input.measuredUsd, source: "measured" };
  if (usable(input.sessionUsd) && input.sessionUsd > 0) return { costUsd: input.sessionUsd, source: "session_estimate" };
  return input.usedTokens ? { costUsd: Math.max(0, input.budgetUsd), source: "budget_ceiling" } : { costUsd: 0, source: "session_estimate" };
}
