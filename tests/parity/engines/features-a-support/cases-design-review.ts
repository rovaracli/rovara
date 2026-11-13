// Design review (area 9): the cases both copies answer. Inputs follow Cloud's own suites (design-review-mode, -estimate, -own-findings, -wait, -playbook): the
// ON/OFF table, the cost estimate and the cap gate, the reviewers per round, the requirements a design misses, the wait clock (remind at 24 h and 72 h, park
// at 7 days, close 30 days after), the lock, and the card's coverage and blocker words. A setting is marked effective by each engine's own `markEffective`
// (the `resolveDesignMode` entry of its implementations does it), as each side's resolver reads it.
import { DESIGN_REVIEW_DEFAULT_SETTING, type ModelIdentifier } from "@rovara-code/contracts";
import type { DecisionCase } from "./decision.js";

const setting = (patch: Record<string, unknown> = {}) => ({ ...DESIGN_REVIEW_DEFAULT_SETTING, ...patch });
const ready = (design?: { needed: boolean; reasons: string[]; note?: string }) => ({
  kind: "ready", path: "QUICK", restatement: "Do the thing.", assumptions: [],
  ...(design === undefined ? {} : { design: { needed: design.needed, reasons: design.reasons, note: design.note ?? "Rovara's reading." } }),
});
const needed = ready({ needed: true, reasons: ["new_api"], note: "Adds a new endpoint." });
const notNeeded = ready({ needed: false, reasons: ["bug_fix"], note: "A bug fix in one module." });
const mode = (label: string, input: Record<string, unknown>): DecisionCase => ({ fn: "resolveDesignMode", label, args: [input] });

const STRONG: ModelIdentifier = { provider: "anthropic", modelId: "strong-model" };
const FAST: ModelIdentifier = { provider: "anthropic", modelId: "fast-model" };
const PLANNER: ModelIdentifier = { provider: "openai", modelId: "planner-model" };
const PRICES: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> = {
  "strong-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }, "fast-model": { inputUsdPerMTok: 1, outputUsdPerMTok: 5 }, "planner-model": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
};
const price = (model: ModelIdentifier) => PRICES[model.modelId];
const models = { reviewer: STRONG, merge: FAST, planner: PLANNER };
const estimate = (label: string, patch: Record<string, unknown>): DecisionCase => ({ fn: "estimateDesignReviewUsd", label, args: [{ tier: "standard", models, price, packetTokens: 9_021, ...patch }] });

const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const wait = (patch: Record<string, unknown> = {}) => ({ kind: "answers", since: new Date(T0).toISOString(), ...patch });
const design = (three: string) => `## §1 Context\nR1 is mentioned here only.\n\n## §2 Goals\n\n## §3 Design\n${three}\n\n## §4 Risks\n`;

export const DESIGN_REVIEW_CASES: readonly DecisionCase[] = [
  mode("design-first", { setting: setting(), assessment: notNeeded, designFirst: true }),
  mode("design-first-beats-never", { setting: setting({ mode: "never" }), assessment: notNeeded, designFirst: true }),
  mode("skip-allowed", { setting: setting(), assessment: needed, skip: true }),
  mode("skip-refused", { setting: setting({ allowSkip: false }), assessment: needed, skip: true }),
  mode("never", { setting: setting({ mode: "never" }), assessment: needed }),
  mode("always-not-needed", { setting: setting({ mode: "always" }), assessment: notNeeded }),
  mode("auto-needed", { setting: setting(), assessment: needed }),
  mode("auto-not-needed", { setting: setting(), assessment: notNeeded }),
  mode("auto-older-worker", { setting: setting(), assessment: ready() }),
  mode("quick-under-always", { setting: setting({ mode: "always" }), assessment: needed, quick: true }),
  mode("quick-under-auto", { setting: setting(), assessment: needed, quick: true }),
  mode("not-returned", { setting: setting(), assessment: undefined }),
  mode("questions", { setting: setting(), assessment: { kind: "questions", restatement: "x", questions: [{ id: "q1", text: "Which one?" }] } }),
  estimate("light", { tier: "light" }),
  estimate("standard", {}),
  estimate("thorough", { tier: "thorough" }),
  estimate("one-round", { rounds: 1 }),
  estimate("big-packet", { packetTokens: 200_000 }),
  estimate("no-packet-size", { packetTokens: Number.NaN }),
  estimate("reviewer-unpriced", { models: { ...models, reviewer: { provider: "anthropic", modelId: "unknown-model" } } }),
  { fn: "gateDesignReviewCost", label: "go", args: [{ spentUsd: 0, tier: "standard", capUsd: 10, estimate: { kind: "priced", usd: 1.2 }, canSkip: true }] },
  { fn: "gateDesignReviewCost", label: "ask-lower-tier", args: [{ spentUsd: 0, tier: "standard", capUsd: 1, estimate: { kind: "priced", usd: 1.2 }, lowerTier: { tier: "light", estimate: { kind: "priced", usd: 0.4 } }, canSkip: true }] },
  { fn: "gateDesignReviewCost", label: "ask-tight", args: [{ spentUsd: 0, tier: "standard", capUsd: 0.2, estimate: { kind: "priced", usd: 1.2 }, lowerTier: { tier: "light", estimate: { kind: "priced", usd: 0.4 } }, canSkip: true, capCeilingUsd: 5 }] },
  { fn: "gateDesignReviewCost", label: "spent-most", args: [{ spentUsd: 9.5, tier: "standard", capUsd: 10, estimate: { kind: "priced", usd: 1.2 }, canSkip: false }] },
  { fn: "gateDesignReviewCost", label: "unpriced", args: [{ spentUsd: 0, tier: "standard", capUsd: 10, estimate: { kind: "unpriced", reason: "no_price" }, canSkip: true }] },
  ...(["light", "standard", "thorough"] as const).flatMap((tier) => ([1, 2] as const).map((round): DecisionCase => ({ fn: "reviewersForRound", label: `${tier}-${String(round)}`, args: [tier, round] }))),
  { fn: "requirementsMissingFromDesign", label: "r10-not-r1", args: [design("R10 is covered."), ["R1", "R10"]] },
  { fn: "requirementsMissingFromDesign", label: "nested", args: [design("### 3.2 Deep\n#### 3.2.1 Deeper\nR1 here."), ["R1"]] },
  { fn: "requirementsMissingFromDesign", label: "no-section-three", args: ["## §1 x\nR1", ["R1"]] },
  { fn: "requirementsMissingFromDesign", label: "odd-id", args: [design("some text"), ["not an id!"]] },
  ...[0, 23 * HOUR, 24 * HOUR, 72 * HOUR, 7 * DAY, 8 * DAY].map((at): DecisionCase => ({ fn: "nextDesignWaitDueAt", label: `waiting+${String(at / HOUR)}h`, args: [wait(), T0 + at] })),
  { fn: "nextDesignWaitDueAt", label: "parked", args: [wait({ parkedAt: new Date(T0 + 7 * DAY).toISOString() }), T0 + 8 * DAY] },
  { fn: "nextDesignWaitDueAt", label: "closed", args: [wait({ parkedAt: new Date(T0 + 7 * DAY).toISOString(), closedAt: new Date(T0 + 37 * DAY).toISOString() }), T0 + 38 * DAY] },
  { fn: "lockViolations", label: "holds", args: [setting({ tier: "thorough", allowSkip: false, capUsdPerTask: 3 }), { tierAtLeast: "thorough", allowSkip: false, capCeilingUsd: 3 }] },
  { fn: "lockViolations", label: "looser", args: [setting({ tier: "light", allowSkip: true, capUsdPerTask: 9 }), { tierAtLeast: "thorough", allowSkip: false, capCeilingUsd: 3 }] },
  { fn: "reviewCoverage", label: "all", args: [{ planned: 3, verified: 3 }] },
  { fn: "reviewCoverage", label: "partial", args: [{ planned: 3, verified: 1 }] },
  { fn: "reviewCoverage", label: "none", args: [{ planned: 3, verified: 0 }] },
  { fn: "blockerReasonLine", label: "plain", args: ["The cache is not invalidated."] },
  { fn: "blockerReasonLine", label: "control-char", args: ["bad\u0007line"] },
  { fn: "blockerReasonLine", label: "too-long", args: ["x".repeat(201)] },
];
