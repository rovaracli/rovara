// Design review stage (DR8, design-review-stage.md 3.4 and 3.6): what a design review will cost, worked out BEFORE anything runs, and the decision when it is over the cap or cannot be priced.
// Pure: it reads no store and calls no model. The caller gives it the models the resolver chose (reviewers and the merge step resolve through the existing `plan_check` stage; there is no `design_review`
// stage) and a price lookup over the catalog.
//
//   estimate = tier reviewers x (packet tokens in + 4k out) x the reviewer model's catalog price
//            + the merge step (a model, except in Light where the merge is code only)
//            + one planner revision per round (about 40k in / 8k out)
//   for 2 rounds (Q7).
//
// A reviewer review is priced by `estimateSecondReviewUsd`, the same function the second-review picker uses, so the two never disagree.
// NO PRICE MEANS "COST UNAVAILABLE": a model the catalog has no price for is never guessed at (How we work 5.3). The review then needs one tap from the requester (an `approve_spend` card, low risk).
// Customer pays (owner 2026-11-03): this file only describes a cost; nothing here spends or mints a key.
import { DESIGN_REVIEW_CAP_MAX_USD, DESIGN_REVIEW_ROUNDS_MAX, DESIGN_REVIEW_TIERS, type DesignReviewTier, type ModelIdentifier, type ReviewerRole } from "@agentx/contracts";
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
/** A planner revision (3.4): about 40k in and 8k out per round. */
export const PLANNER_REVISION_TOKENS = { input: 40_000, output: 8_000 } as const;
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

const validTokens = (value: number): boolean => Number.isFinite(value) && value >= 0;

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
  const plannerUsd = micro(estimateSecondReviewUsd(plannerPrice, { input: PLANNER_REVISION_TOKENS.input, maxOutput: PLANNER_REVISION_TOKENS.output }) * rounds);
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
  /** Run design review for this task anyway, with the price unknown: only offered for "cost unavailable", and only the requester may choose it. MEASURED spend still stops the run at the cap (`designReviewSpendStop`). */
  | { choice: "run_unpriced" }
  | { choice: "skip" };

export interface CapGateInput {
  tier: DesignReviewTier;
  capUsd: number;
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
 *   - over the cap: three choices, each only if it is allowed: run at the next lower tier (only if that tier is priced AND fits), raise the cap for this task (to the estimate, rounded up to a cent, only if
 *     that is at most the highest cap allowed and the company's ceiling), or skip (only if the skip rules allow);
 *   - no price: "Cost unavailable", one tap: run it unpriced, or skip (if allowed). Nothing runs on its own.
 * An estimate above every limit with Skip not allowed leaves no choice at all: the card then says so and the task waits for someone who can skip or change the setting. Never a silent run.
 */
export function gateDesignReviewCost(input: CapGateInput): DesignReviewCapGate {
  const { estimate } = input;
  if (estimate.kind === "priced" && estimate.usd <= input.capUsd) return { kind: "go", estimateUsd: estimate.usd };
  const choices: DesignSpendChoice[] = [];
  if (estimate.kind === "unavailable") {
    choices.push({ choice: "run_unpriced" });
    if (input.canSkip) choices.push({ choice: "skip" });
    return { kind: "ask", why: "cost_unavailable", estimateUsd: undefined, choices };
  }
  const lower = input.lowerTier;
  if (lower !== undefined && lower.estimate.kind === "priced" && lower.estimate.usd <= input.capUsd) choices.push({ choice: "lower_tier", tier: lower.tier, estimateUsd: lower.estimate.usd });
  const raised = roundUpCents(estimate.usd);
  const ceiling = Math.min(DESIGN_REVIEW_CAP_MAX_USD, input.capCeilingUsd ?? DESIGN_REVIEW_CAP_MAX_USD);
  if (raised > input.capUsd && raised <= ceiling) choices.push({ choice: "raise_cap", newCapUsd: raised });
  if (input.canSkip) choices.push({ choice: "skip" });
  return { kind: "ask", why: "over_cap", estimateUsd: estimate.usd, choices };
}

/**
 * Whether a running design review must stop NOW, from the spend the proxy has MEASURED for the task's design review keys (M5). It does not depend on an estimate or a catalog price:
 *   - measured spend at or above the cap stops it, in any run, priced or not, mid-round (3.6 "Running out"): nothing pauses to ask for money;
 *   - an unpriced run with NO measurement (the meter gave nothing) stops too: with no price and no reading nothing bounds the spend, so it never starts another reviewer on a guess.
 * A bad number (NaN, negative) is no reading. The caller (the DR7 dispatch) asks before it starts each reviewer and each merge or revision call.
 */
export function designReviewSpendStop(input: { capUsd: number; measuredUsd: number | undefined; unpriced: boolean }): { stop: false } | { stop: true; why: "cap_reached" | "spend_unmeasured" } {
  const reading = input.measuredUsd !== undefined && Number.isFinite(input.measuredUsd) && input.measuredUsd >= 0 ? input.measuredUsd : undefined;
  if (!Number.isFinite(input.capUsd) || input.capUsd < 0) return { stop: true, why: "cap_reached" };
  if (reading !== undefined && reading >= input.capUsd) return { stop: true, why: "cap_reached" };
  if (reading === undefined && input.unpriced) return { stop: true, why: "spend_unmeasured" };
  return { stop: false };
}
