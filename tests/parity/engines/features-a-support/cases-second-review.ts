// Second review (area 8): the cases both copies answer. Inputs follow Cloud's own suite (tests/contract/second-review-start.test.ts): the plan (switch, mode,
// models named or the default, forbidden and unusable models, `on` with and without evidence), what an unavailable second review does, the acknowledgement,
// where an opinion is shown, the money gate, the mode a scope runs in, and when the evidence holds.
import { SECOND_OPINION_UNAVAILABLE_REASONS, secondReviewModelKey, type ModelIdentifier, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict } from "@rovara-code/contracts";
import type { DecisionCase } from "./decision.js";

const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const GPT: ModelIdentifier = { provider: "openrouter", modelId: "openai/gpt-5.5" };
const GEMINI: ModelIdentifier = { provider: "openrouter", modelId: "google/gemini-3-pro" };
const NOVA: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
const MYSTERY: ModelIdentifier = { provider: "openrouter", modelId: "x-ai/grok-9" };

const replayCases = (): SecondReviewReplayCase[] => {
  const out: SecondReviewReplayCase[] = [];
  const shapes: Array<[boolean, boolean, number]> = [[true, true, 32], [true, false, 8], [false, true, 5], [false, false, 5]];
  for (const [baselineCaught, candidateCaught, count] of shapes) for (let i = 0; i < count; i += 1) out.push({ caseId: `c${String(out.length + 1)}`, kind: "known_defect", baselineCaught, candidateCaught, candidateBlockingFindings: 0, candidateDismissedBlocking: 0 });
  return out.map((entry, index) => ({ ...entry, kind: index < 30 ? "known_defect" as const : "planted_bug" as const }));
};
const proof = (model: ModelIdentifier): { verdicts: SecondReviewVerdict[]; replayRuns: SecondReviewReplayRun[] } => ({
  replayRuns: [{ runId: "run-1", ranAt: "2026-11-01T00:00:00.000Z", candidate: model, baseline: OPUS, cases: replayCases() }],
  verdicts: [{ model: secondReviewModelKey(model), replayRunId: "run-1", baseline: OPUS, shadow: { startedAt: "2026-11-02T00:00:00.000Z", endedAt: "2026-11-16T00:00:00.000Z", findings: 10, agreed: 4, reviews: 10 }, createdAt: "2026-11-20T00:00:00.000Z", createdBy: "staff:alice" }],
});

const base = { switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [OPUS, SONNET, GPT, GEMINI, NOVA], verdicts: [], replayRuns: [] };
const plan = (label: string, patch: Record<string, unknown>): DecisionCase => ({ fn: "planSecondReview", label, args: [{ ...base, ...patch }] });

const DIGEST = "c".repeat(64);
const PLAN = { run: true, mode: "shadow", model: GPT, candidates: [GPT, GEMINI], company: "openai", against: [SONNET], choice: "default", skipped: [] };
const ON_PLAN = { ...PLAN, mode: "on" };
const report = (status: string, over: Record<string, unknown> = {}, findings: unknown[] = []) => ({
  operationId: "op-2", candidateDigest: DIGEST, role: "CRITIC", provider: GPT.provider, version: GPT.modelId, status, findings, readOnly: true, recordedAt: "2026-11-12T10:00:00.000Z", ...over,
});
const BLOCKER = { text: "The retry loop never stops.", origin: "INTRODUCED", severity: "HIGH", file: "src/retry.ts", line: 3 };
const opinion = (label: string, input: Record<string, unknown>): DecisionCase => ({ fn: "secondOpinionOf", label, args: [input] });
const accept = (label: string, input: Record<string, unknown>): DecisionCase => ({ fn: "acceptSecondReport", label, args: [input] });

export const SECOND_REVIEW_CASES: readonly DecisionCase[] = [
  plan("switch-off", { switchOn: false }),
  plan("mode-off", { mode: "off" }),
  plan("no-reference-model", { against: [] }),
  plan("default-shadow", {}),
  plan("default-against-gpt", { against: [GPT] }),
  plan("default-changed", { previousDefault: MYSTERY }),
  plan("company-choice", { companyModels: [GEMINI, NOVA] }),
  plan("company-choice-same-company", { companyModels: [OPUS] }),
  plan("company-choice-not-routable", { companyModels: [MYSTERY] }),
  plan("project-narrows", { companyModels: [GPT, GEMINI], projectModels: [GEMINI] }),
  plan("forbidden-gpt", { forbidden: [{ provider: "openrouter", modelId: "openai/gpt-5.5" }] }),
  plan("unusable-gpt", { unusable: [GPT] }),
  plan("on-without-evidence", { mode: "on" }),
  plan("on-with-evidence", { mode: "on", ...proof(GPT), companyModels: [GPT] }),
  plan("legacy-ranking", { legacyRanking: true }),
  ...(["shadow", "on"] as const).flatMap((mode) => SECOND_OPINION_UNAVAILABLE_REASONS.map((reason): DecisionCase => ({ fn: "secondReviewUnavailableDecision", label: `${mode}-${reason}`, args: [{ mode, reason }] }))),
  ...(["shadow", "on"] as const).flatMap((mode) => [
    { fn: "secondReviewAcknowledgement", label: `${mode}-unavailable-budget`, args: [{ mode, unavailable: true, unavailableReason: "budget" }, "d".repeat(64)] },
    { fn: "secondReviewAcknowledgement", label: `${mode}-available`, args: [{ mode }, "d".repeat(64)] },
    { fn: "secondOpinionShownOn", label: `${mode}-blocked`, args: [{ mode, blocked: true }] },
    { fn: "secondOpinionShownOn", label: `${mode}-unavailable`, args: [{ mode, blocked: false, unavailable: true }] },
  ] satisfies DecisionCase[]),
  accept("pass", { plan: PLAN, report: report("PASS"), currentCandidateDigest: DIGEST }),
  accept("wrong-role", { plan: PLAN, report: report("PASS", { role: "SECURITY" }), currentCandidateDigest: DIGEST }),
  accept("wrong-candidate", { plan: PLAN, report: report("PASS"), currentCandidateDigest: "d".repeat(64) }),
  accept("wrong-model", { plan: PLAN, report: report("PASS", { provider: "anthropic", version: "claude-opus-4-6" }), currentCandidateDigest: DIGEST }),
  accept("route-alias", { plan: PLAN, report: report("PASS", { version: "org-route-1" }), currentCandidateDigest: DIGEST, routeAliases: { "org-route-1": "openai/gpt-5.5" } }),
  opinion("shadow-pass", { plan: PLAN, report: report("PASS"), currentCandidateDigest: DIGEST }),
  opinion("shadow-findings", { plan: PLAN, report: report("FINDINGS", {}, [BLOCKER]), currentCandidateDigest: DIGEST }),
  opinion("on-findings", { plan: ON_PLAN, report: report("FINDINGS", {}, [BLOCKER]), currentCandidateDigest: DIGEST }),
  opinion("on-findings-accepted", { plan: ON_PLAN, report: report("FINDINGS", {}, [BLOCKER]), currentCandidateDigest: DIGEST, accepted: [{ index: 0 }] }),
  opinion("on-wrong-model", { plan: ON_PLAN, report: report("FINDINGS", { provider: "anthropic", version: "claude-opus-4-6" }, [BLOCKER]), currentCandidateDigest: DIGEST }),
  { fn: "admitSecondReview", label: "fits", args: [{ mode: "shadow", estimateUsd: 0.4, roomUsd: 2, alreadyRan: false }] },
  { fn: "admitSecondReview", label: "no-room", args: [{ mode: "on", estimateUsd: 3, roomUsd: 2, alreadyRan: false }] },
  { fn: "admitSecondReview", label: "already-ran", args: [{ mode: "shadow", estimateUsd: 0.4, roomUsd: 2, alreadyRan: true }] },
  { fn: "againstModels", label: "all-known", args: [{ buildRanModels: [SONNET, OPUS], firstReviewerRan: SONNET }] },
  { fn: "againstModels", label: "one-unknown", args: [{ buildRanModels: [SONNET, undefined], firstReviewerRan: SONNET }] },
  { fn: "secondReviewAlreadyRan", label: "same-candidate-round", args: [[{ secondReview: { mode: "shadow" }, candidateDigest: "c1", round: 1 }], "c1", 1] },
  { fn: "secondReviewAlreadyRan", label: "other-round", args: [[{ secondReview: { mode: "shadow" }, candidateDigest: "c1", round: 1 }], "c1", 2] },
  { fn: "effectiveMode", label: "company-lock-stricter", args: [{ companyDefault: "shadow", companyLock: "on" }, { kind: "company" }] },
  { fn: "effectiveMode", label: "project-inherits", args: [{ companyDefault: "shadow" }, { kind: "project", project: "payments" }] },
  { fn: "verdictHoldsFor", label: "holds", args: [proof(GPT), { provider: GPT.provider, modelId: GPT.modelId }] },
  { fn: "verdictHoldsFor", label: "other-model", args: [proof(GPT), { provider: GEMINI.provider, modelId: GEMINI.modelId }] },
  { fn: "secondReviewPicker", label: "default-list", args: [{ sources: [OPUS, SONNET, GPT, GEMINI, NOVA], project: {}, forbidden: [], against: [SONNET], verdicts: [], replayRuns: [] }] },
];
