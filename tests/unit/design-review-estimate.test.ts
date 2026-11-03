// Design review stage DR8: the estimate, the cost gate and the spend card source (design-review-stage.md 3.4 and 3.6). Money, so every edge is pinned: the estimate equals the second-review picker's
// own function for one reviewer, "Cost unavailable" is never a number, a gate never runs on its own, and the card's choices are the ones the rules allow.
import { describe, expect, it } from "vitest";
import { DecisionCardSchema, type ModelIdentifier } from "@agentx/contracts";
import { PLANNER_REVISION_TOKENS, MERGE_TOKENS, ROLE_INPUT_TURN_FACTOR, designReviewSpendStop, estimateDesignReviewUsd as estimateWithPacket, designReviewKeyBudgets, gateDesignReviewCost, nextLowerTier, recordedReviewerCost, reviewersForRound, TIER_REVIEWERS, type DesignReviewEstimate, type DesignReviewEstimateInput, type PriceLookup } from "../../packages/broker/src/design-review/estimate.js";
import { designSpendCardItem, designSpendChoicePath } from "../../packages/broker/src/design-review/spend-card.js";
import { cardOfItem } from "../../packages/broker/src/decisions/project.js";
import { SECOND_REVIEW_TYPICAL_REVIEW_TOKENS, estimateSecondReviewUsd } from "../../packages/broker/src/rovara-code/second-review-picker.js";

const STRONG: ModelIdentifier = { provider: "anthropic", modelId: "strong-model" };
const FAST: ModelIdentifier = { provider: "anthropic", modelId: "fast-model" };
const PLANNER: ModelIdentifier = { provider: "openai", modelId: "planner-model" };
const PRICES: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> = {
  "strong-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  "fast-model": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
  "planner-model": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
};
const price: PriceLookup = (model) => PRICES[model.modelId];
const models = { reviewer: STRONG, merge: FAST, planner: PLANNER };
/** The packet size is required (M4); most tests use the typical 60k. */
const estimateDesignReviewUsd = (input: Omit<DesignReviewEstimateInput, "packetTokens"> & { packetTokens?: number }): DesignReviewEstimate => estimateWithPacket({ packetTokens: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.input, ...input });
const priced = (estimate: DesignReviewEstimate) => { if (estimate.kind !== "priced") throw new Error("expected a price"); return estimate; };

describe("the estimate", () => {
  it("matches estimateSecondReviewUsd for one reviewer: Light is one reviewer, no merge model, two rounds", () => {
    const estimate = priced(estimateDesignReviewUsd({ tier: "light", models, price }));
    // The one reviewer (Critic) searches with tools, so its input is the packet times its turn factor (M4).
    const one = estimateSecondReviewUsd(PRICES["strong-model"]!, { input: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.input * ROLE_INPUT_TURN_FACTOR.critic, maxOutput: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS.output });
    expect(estimateSecondReviewUsd(PRICES["strong-model"]!, { input: 60_000, maxOutput: 4_000 })).toBeCloseTo(0.24, 6);
    expect(estimate.reviewers).toBe(1);
    expect(estimate.breakdown.reviewersUsd).toBeCloseTo(one * 2, 6);
    // Light merges in code: nothing is priced for the merge.
    expect(estimate.breakdown.mergeUsd).toBe(0);
    expect(estimate.breakdown.plannerUsd).toBeCloseTo(estimateSecondReviewUsd(PRICES["planner-model"]!, { input: PLANNER_REVISION_TOKENS.input, maxOutput: PLANNER_REVISION_TOKENS.output }) * 2, 6);
    expect(estimate.usd).toBeCloseTo(estimate.breakdown.reviewersUsd + estimate.breakdown.plannerUsd, 6);
  });

  it("prices every reviewer of the tier in every round, plus the merge model and a planner revision per round", () => {
    const standard = priced(estimateDesignReviewUsd({ tier: "standard", models, price }));
    expect(standard.reviewers).toBe(3);
    expect(TIER_REVIEWERS.standard).toEqual(["comprehension", "critic", "codebase"]);
    const reviewerUsd = (role: keyof typeof ROLE_INPUT_TURN_FACTOR) => estimateSecondReviewUsd(PRICES["strong-model"]!, { input: 60_000 * ROLE_INPUT_TURN_FACTOR[role], maxOutput: 4_000 });
    expect(standard.breakdown.reviewersUsd).toBeCloseTo((reviewerUsd("comprehension") + reviewerUsd("critic") + reviewerUsd("codebase")) * 2, 6);
    const merge = estimateSecondReviewUsd(PRICES["fast-model"]!, { input: MERGE_TOKENS.designInput + MERGE_TOKENS.perReviewerInput * 3, maxOutput: MERGE_TOKENS.output }) * 2;
    expect(standard.breakdown.mergeUsd).toBeCloseTo(merge, 6);
    const thorough = priced(estimateDesignReviewUsd({ tier: "thorough", models, price }));
    expect(thorough.reviewers).toBe(5);
    // Dearer tiers cost more; the estimate is monotone in the tier.
    const light = priced(estimateDesignReviewUsd({ tier: "light", models, price }));
    expect(light.usd).toBeLessThan(standard.usd);
    expect(standard.usd).toBeLessThan(thorough.usd);
    // One round costs less than two.
    expect(priced(estimateDesignReviewUsd({ tier: "standard", models, price, rounds: 1 })).usd).toBeLessThan(standard.usd);
  });

  it("uses the packet size the broker built, and a size that is not a usable number is Cost unavailable, never a default (M4)", () => {
    const small = priced(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: 10_000 }));
    const typical = priced(estimateDesignReviewUsd({ tier: "light", models, price }));
    const big = priced(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: 200_000 }));
    expect(small.breakdown.reviewersUsd).toBeLessThan(typical.breakdown.reviewersUsd);
    expect(big.breakdown.reviewersUsd).toBeGreaterThan(typical.breakdown.reviewersUsd);
    // N8: a packet with no tokens prices a review with no input; it is "cost unavailable", never a cheap price.
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, 0]) {
      expect(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: bad })).toEqual({ kind: "unavailable", tier: "light", missing: ["packet"] });
    }
    expect(priced(estimateDesignReviewUsd({ tier: "light", models, price, packetTokens: 1 })).breakdown.reviewersUsd).toBeGreaterThan(0);
  });

  it("M4: tool-using reviewers re-send the context every turn, so the estimate is a multiple of the packet for them (named factors, Comprehension reads once)", () => {
    expect(ROLE_INPUT_TURN_FACTOR).toEqual({ comprehension: 1, critic: 2, codebase: 3, zoom_out: 2, critic_b: 2 });
    const free: PriceLookup = () => ({ inputUsdPerMTok: 1, outputUsdPerMTok: 0 });
    const cost = (tier: "standard" | "thorough") => priced(estimateDesignReviewUsd({ tier, models: { reviewer: STRONG, planner: PLANNER }, price: free, packetTokens: 1_000_000, rounds: 1 })).breakdown.reviewersUsd;
    // 1 + 2 + 3 packets of 1M tokens at $1 per million, one round.
    expect(cost("standard")).toBeCloseTo(6, 6);
    // Thorough adds Zoom-out (2) and Critic B (2).
    expect(cost("thorough")).toBeCloseTo(10, 6);
  });

  it("L3: Zoom-out runs only after round 1, so round 1 of Thorough plans four reviewers and round 2 five", () => {
    expect(reviewersForRound("thorough", 1)).toEqual(["comprehension", "critic", "codebase", "critic_b"]);
    expect(reviewersForRound("thorough", 2)).toEqual(TIER_REVIEWERS.thorough);
    expect(reviewersForRound("standard", 1)).toEqual(TIER_REVIEWERS.standard);
    expect(reviewersForRound("light", 2)).toEqual(["critic"]);
  });

  it("is Cost unavailable, never a number, when the catalog has no price for a model it must price", () => {
    const noReviewerPrice: PriceLookup = (model) => (model.modelId === "strong-model" ? undefined : PRICES[model.modelId]);
    expect(estimateDesignReviewUsd({ tier: "standard", models, price: noReviewerPrice })).toEqual({ kind: "unavailable", tier: "standard", missing: ["reviewer"] });
    const nothing: PriceLookup = () => undefined;
    expect(estimateDesignReviewUsd({ tier: "standard", models, price: nothing })).toEqual({ kind: "unavailable", tier: "standard", missing: ["reviewer", "merge", "planner"] });
    // Light has no merge model to price, so the merge is not reported missing.
    expect(estimateDesignReviewUsd({ tier: "light", models, price: nothing })).toEqual({ kind: "unavailable", tier: "light", missing: ["reviewer", "planner"] });
    // A model the resolver did not resolve at all is also unavailable, not free.
    expect(estimateDesignReviewUsd({ tier: "light", models: { reviewer: undefined, planner: PLANNER }, price })).toMatchObject({ kind: "unavailable", missing: ["reviewer"] });
    // A catalog row that is not a usable number is no price.
    const broken: PriceLookup = () => ({ inputUsdPerMTok: Number.NaN, outputUsdPerMTok: 5 });
    expect(estimateDesignReviewUsd({ tier: "light", models, price: broken }).kind).toBe("unavailable");
    expect(estimateDesignReviewUsd({ tier: "light", models, price: () => ({ inputUsdPerMTok: -1, outputUsdPerMTok: 5 }) }).kind).toBe("unavailable");
  });

  it("falls back to the reviewer's price for the merge step when no separate model was resolved (it can only come out high)", () => {
    const same = priced(estimateDesignReviewUsd({ tier: "standard", models: { reviewer: STRONG, planner: PLANNER }, price }));
    const cheaper = priced(estimateDesignReviewUsd({ tier: "standard", models, price }));
    expect(same.breakdown.mergeUsd).toBeGreaterThan(cheaper.breakdown.mergeUsd);
  });

  it("knows the next lower tier", () => {
    expect(nextLowerTier("thorough")).toBe("standard");
    expect(nextLowerTier("standard")).toBe("light");
    expect(nextLowerTier("light")).toBeUndefined();
  });
});

describe("the cap gate", () => {
  const est = (tier: "light" | "standard" | "thorough", capModels = models) => estimateDesignReviewUsd({ tier, models: capModels, price });
  const standard = priced(est("standard"));

  it("goes when the estimate is within the cap (at the cap too)", () => {
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: standard, canSkip: true })).toEqual({ kind: "go", estimateUsd: standard.usd });
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: standard.usd, estimate: standard, canSkip: true }).kind).toBe("go");
  });

  it("asks when over the cap, with the lower tier only if it fits, a raise only if allowed, and skip only if the rules allow", () => {
    const light = priced(est("light"));
    const capBetween = (light.usd + standard.usd) / 2;
    const gate = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: capBetween, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: true });
    expect(gate.kind).toBe("ask");
    if (gate.kind !== "ask") return;
    expect(gate.why).toBe("over_cap");
    expect(gate.choices.map((c) => c.choice)).toEqual(["lower_tier", "raise_cap", "skip"]);
    expect(gate.choices[0]).toEqual({ choice: "lower_tier", tier: "light", estimateUsd: light.usd });
    // The raise is to the estimate rounded UP to a cent: it always covers the estimate.
    const raise = gate.choices[1] as { choice: "raise_cap"; newCapUsd: number };
    expect(raise.newCapUsd).toBeGreaterThanOrEqual(standard.usd);
    expect(raise.newCapUsd - standard.usd).toBeLessThan(0.0101);
    // The lower tier does not fit either: not offered.
    const tight = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: light.usd / 2, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: true });
    expect(tight.kind === "ask" && tight.choices.map((c) => c.choice)).toEqual(["raise_cap", "skip"]);
    // The lower tier has no price: not offered, and never guessed.
    const unpricedLower = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: capBetween, estimate: standard, lowerTier: { tier: "light", estimate: { kind: "unavailable", tier: "light", missing: ["reviewer"] } }, canSkip: true });
    expect(unpricedLower.kind === "ask" && unpricedLower.choices.map((c) => c.choice)).toEqual(["raise_cap", "skip"]);
    // The skip rules take Skip away.
    const noSkip = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: capBetween, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: false });
    expect(noSkip.kind === "ask" && noSkip.choices.map((c) => c.choice)).toEqual(["lower_tier", "raise_cap"]);
  });

  it("never offers a raise above the highest cap or the company's ceiling", () => {
    const huge: DesignReviewEstimate = { kind: "priced", usd: 250, breakdown: { reviewersUsd: 250, mergeUsd: 0, plannerUsd: 0 }, tier: "thorough", reviewers: 5, rounds: 2 };
    const overMax = gateDesignReviewCost({ spentUsd: 0, tier: "thorough", capUsd: 10, estimate: huge, canSkip: true });
    expect(overMax.kind === "ask" && overMax.choices.map((c) => c.choice)).toEqual(["skip"]);
    const ceiling = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 1, capCeilingUsd: 1.5, estimate: standard, canSkip: true });
    expect(standard.usd).toBeGreaterThan(1.5);
    expect(ceiling.kind === "ask" && ceiling.choices.map((c) => c.choice)).toEqual(["skip"]);
  });

  it("with no skip and nothing that fits, asks with NO choices: it never runs by itself", () => {
    const huge: DesignReviewEstimate = { kind: "priced", usd: 250, breakdown: { reviewersUsd: 250, mergeUsd: 0, plannerUsd: 0 }, tier: "thorough", reviewers: 5, rounds: 2 };
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "thorough", capUsd: 10, estimate: huge, canSkip: false })).toEqual({ kind: "ask", why: "over_cap", estimateUsd: 250, choices: [] });
  });

  it("Cost unavailable: asks, with run-anyway (one tap) and skip if allowed, and no number", () => {
    const unavailable = estimateDesignReviewUsd({ tier: "standard", models, price: () => undefined });
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: unavailable, canSkip: true })).toEqual({ kind: "ask", why: "cost_unavailable", estimateUsd: undefined, choices: [{ choice: "run_unpriced" }, { choice: "skip" }] });
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: unavailable, canSkip: false })).toEqual({ kind: "ask", why: "cost_unavailable", estimateUsd: undefined, choices: [{ choice: "run_unpriced" }] });
    // Even a huge cap does not let an unpriced review start: there is no "within the cap" without a price.
    expect(gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 100, estimate: unavailable, canSkip: true }).kind).toBe("ask");
  });
});

describe("M5: an unpriced run is still bounded by measured spend", () => {
  it("stops at the cap on measured spend, priced or not, and an unpriced run with no reading never goes on", () => {
    expect(designReviewSpendStop({ capUsd: 10, measuredUsd: 9.99, unpriced: true })).toEqual({ stop: false });
    expect(designReviewSpendStop({ capUsd: 10, measuredUsd: 10, unpriced: true })).toEqual({ stop: true, why: "cap_reached" });
    expect(designReviewSpendStop({ capUsd: 10, measuredUsd: 250, unpriced: false })).toEqual({ stop: true, why: "cap_reached" });
    // No meter reading: a priced run is bounded by its estimate, an unpriced one by nothing, so it stops.
    expect(designReviewSpendStop({ capUsd: 10, measuredUsd: undefined, unpriced: false })).toEqual({ stop: false });
    expect(designReviewSpendStop({ capUsd: 10, measuredUsd: undefined, unpriced: true })).toEqual({ stop: true, why: "spend_unmeasured" });
    // A reading that is not a usable number is no reading; a bad cap stops everything.
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) expect(designReviewSpendStop({ capUsd: 10, measuredUsd: bad, unpriced: true }), String(bad)).toMatchObject({ stop: true });
    expect(designReviewSpendStop({ capUsd: Number.NaN, measuredUsd: 0, unpriced: false })).toMatchObject({ stop: true });
  });
});

describe("the approve_spend card source", () => {
  const TASK = "11111111-1111-4111-8111-111111111111";
  const base = { taskId: TASK, subjectId: "dr-spend-1", project: "payments", title: "Partner ranking by region", createdAt: "2026-11-03T10:00:00.000Z", openPath: `/app/sessions/ses_${"a".repeat(20)}`, contentVersion: "v1", capUsd: 1 };
  const standard = priced(estimateDesignReviewUsd({ tier: "standard", models, price }));
  const light = priced(estimateDesignReviewUsd({ tier: "light", models, price }));

  it("makes a card whose actions are the allowed choices, as POSTs of this server, and which the card contract accepts", () => {
    const gate = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: (light.usd + standard.usd) / 2, estimate: standard, lowerTier: { tier: "light", estimate: light }, canSkip: true });
    if (gate.kind !== "ask") throw new Error("expected an ask");
    const item = designSpendCardItem({ ...base, capUsd: (light.usd + standard.usd) / 2, gate });
    const made = cardOfItem(item);
    expect(made).toBeDefined();
    const card = made!.card;
    expect(DecisionCardSchema.safeParse(card).success).toBe(true);
    expect(card.kind).toBe("approve_spend");
    expect(card.actions.filter((a) => a.kind === "choose").map((a) => a.href)).toEqual([
      designSpendChoicePath(TASK, "lower_tier"), designSpendChoicePath(TASK, "raise_cap"), designSpendChoicePath(TASK, "skip"),
    ]);
    expect(card.actions.every((a) => a.kind === "open" ? a.method === "GET" : a.method === "POST")).toBe(true);
    // Never an approve action: a choice names what happens, none is a blanket yes.
    expect(card.actions.some((a) => a.kind === "approve")).toBe(false);
    expect(card.recommended.action).toBe("choose");
    expect(card.evidence.map((c) => c.label)).toEqual(["Estimate", "Limit for this task"]);
    expect(card.next.costUsd).toBe(standard.usd);
  });

  it("says Cost unavailable and is low risk when there is no price", () => {
    const unavailable = estimateDesignReviewUsd({ tier: "standard", models, price: () => undefined });
    const gate = gateDesignReviewCost({ spentUsd: 0, tier: "standard", capUsd: 10, estimate: unavailable, canSkip: true });
    if (gate.kind !== "ask") throw new Error("expected an ask");
    const card = cardOfItem(designSpendCardItem({ ...base, capUsd: 10, gate }))!.card;
    expect(card.risk).toBe("low");
    expect(card.evidence[0]).toMatchObject({ label: "Estimate", value: "Cost unavailable", state: "unknown" });
    expect(card.next.costUsd).toBeUndefined();
    expect(card.actions.filter((a) => a.kind === "choose").map((a) => a.label)).toEqual(["Run it anyway", "Skip design review"]);
    expect(card.question).not.toMatch(/\$/u);
  });

  it("a gate with no choice left gives a card that only opens the page", () => {
    const card = cardOfItem(designSpendCardItem({ ...base, capUsd: 10, gate: { kind: "ask", why: "over_cap", estimateUsd: 250, choices: [] } }))!.card;
    expect(card.actions.map((a) => a.kind)).toEqual(["open"]);
    expect(card.recommended.action).toBe("open");
    // $250 is above the admin amount: high risk, and a high card has only "Open to decide".
    expect(card.risk).toBe("high");
  });

  it("an ordinary spend request is unchanged", () => {
    const card = cardOfItem({ kind: "approve_spend", subjectId: "spr1", taskId: TASK, project: "payments", title: "t", createdAt: base.createdAt, openPath: base.openPath, contentVersion: "v1", amountUsd: 5, scopeLabel: "this task" })!.card;
    expect(card.actions.map((a) => a.kind)).toEqual(["approve", "reject", "open"]);
  });
});


describe("money N3 (pure parts): what each reviewer's key may spend, and what a run records", () => {
  it("splits what is left under the cap between the reviewers and the merge model, rounding down so the shares never exceed it", () => {
    const standard = designReviewKeyBudgets({ capUsd: 10, spentUsd: 4, reviewers: 3, hasMergeModel: true });
    expect(standard).toEqual({ reviewerUsd: 1.5, mergeUsd: 1.5, roomUsd: 6 });
    const light = designReviewKeyBudgets({ capUsd: 10, spentUsd: 4, reviewers: 1, hasMergeModel: false });
    expect(light).toEqual({ reviewerUsd: 6, mergeUsd: 0, roomUsd: 6 });
    const odd = designReviewKeyBudgets({ capUsd: 1, spentUsd: 0, reviewers: 3, hasMergeModel: true });
    expect(odd.reviewerUsd).toBe(0.25);
    for (const [cap, spent, reviewers] of [[10, 3.3333333, 3], [7, 0.1, 5], [0.5, 0, 4]] as const) {
      const budgets = designReviewKeyBudgets({ capUsd: cap, spentUsd: spent, reviewers, hasMergeModel: true });
      expect(budgets.reviewerUsd * reviewers + budgets.mergeUsd).toBeLessThanOrEqual(budgets.roomUsd + 1e-9);
    }
  });

  it("holds back a reservation for the planner, and gives nothing when nothing is left or the input is not a number", () => {
    expect(designReviewKeyBudgets({ capUsd: 10, spentUsd: 0, reviewers: 3, hasMergeModel: false, reservedUsd: 1 })).toEqual({ reviewerUsd: 3, mergeUsd: 0, roomUsd: 9 });
    for (const bad of [{ capUsd: 10, spentUsd: 10 }, { capUsd: 10, spentUsd: 12 }, { capUsd: Number.NaN, spentUsd: 0 }, { capUsd: 10, spentUsd: Number.NaN }]) {
      expect(designReviewKeyBudgets({ ...bad, reviewers: 3, hasMergeModel: true }), JSON.stringify(bad)).toMatchObject({ reviewerUsd: 0, mergeUsd: 0, roomUsd: 0 });
    }
    expect(designReviewKeyBudgets({ capUsd: 10, spentUsd: 0, reviewers: 0, hasMergeModel: true })).toMatchObject({ reviewerUsd: 0 });
  });

  it("a run's cost is the proxy's measured spend when there is one, never 0 for an unpriced run that used tokens", () => {
    expect(recordedReviewerCost({ measuredUsd: 0.42, sessionUsd: 0.1, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 0.42, source: "measured" });
    // a measured 0 is a reading, not a gap
    expect(recordedReviewerCost({ measuredUsd: 0, sessionUsd: 0.1, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 0, source: "measured" });
    // the session's own figure is only a stand-in when it is above 0
    expect(recordedReviewerCost({ measuredUsd: undefined, sessionUsd: 0.1, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 0.1, source: "session_estimate" });
    // unpriced model: the session reports 0 and nothing was measured, so the run is charged its key's whole budget
    expect(recordedReviewerCost({ measuredUsd: undefined, sessionUsd: 0, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 1.5, source: "budget_ceiling" });
    expect(recordedReviewerCost({ measuredUsd: Number.NaN, sessionUsd: Number.NaN, budgetUsd: 1.5, usedTokens: true })).toEqual({ costUsd: 1.5, source: "budget_ceiling" });
    expect(recordedReviewerCost({ measuredUsd: -1, sessionUsd: 0, budgetUsd: 1.5, usedTokens: true }).costUsd).toBe(1.5);
    // a run that never reached the model costs nothing
    expect(recordedReviewerCost({ measuredUsd: undefined, sessionUsd: 0, budgetUsd: 1.5, usedTokens: false })).toEqual({ costUsd: 0, source: "session_estimate" });
  });
});
