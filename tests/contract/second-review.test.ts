// SH34: the second review by a different AI company. The setting (off, shadow, on; a company lock is a floor; lowering needs a second person), which model may be the second reviewer (Amazon Bedrock only; another
// known company than every recorded model; allowed, not forbidden, past the driving test for its exact revision; Amazon Nova Premier or Pro first), when `on` is allowed (evidence recomputed from the stored replay
// run, else shadow), and what a finished second review means (accepted only for the planned model, the code review and the current candidate; shadow never blocks; on blocks; no answer blocks nothing).
// Also the replay check's fields and bar, which the quality suite fills.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HowWeWorkStageSchema, SECOND_REVIEW_BAR, SECOND_REVIEW_MODES, SECOND_REVIEW_OPERATION_TAG, SecondOpinionSchema, SecondReviewReplayRunSchema, SecondReviewVerdictSchema, canonicalModelName, configuredSecondReviewMode,
  forbiddenModelMatcher, isSecondReviewOperation, lockSecondReviewLoweringNeedsSecondPerson, modelCompany, projectSecondReviewLoweringNeedsSecondPerson, secondReviewModelKey, secondReviewShadowPassed,
  secondReviewVerdictHolds, stricterSecondReviewMode, summarizeSecondReviewReplay, workflowFindingFingerprint,
  type ModelIdentifier, type SecondReviewReplayCase, type SecondReviewReplayRun, type SecondReviewVerdict, type WorkflowReviewReport,
} from "@agentx/contracts";
import {
  SECOND_REVIEW_OPERATION, acceptSecondReport, admitSecondReview, againstModels, drivingTestGate, estimateSecondReviewUsd, planSecondReview, secondOpinionOf, secondOpinionPrLines, secondOpinionShownOn,
  SECOND_REVIEW_TRIES_MAX, mergeWaitsForSecondReview, nextSecondReviewTry, secondOpinionUnavailable, secondReviewAcknowledgement, secondReviewAlreadyRan, secondReviewBlocksWhenUnavailable, secondReviewModelUnusable,
  secondReviewUnavailableDecision, type SecondReviewAttempt, type DrivingTestRecord, type SecondReviewPlan, type SecondReviewPlanInput,
} from "../../packages/broker/src/rovara-code/second-review.js";
import { reviewFailures } from "../../packages/broker/src/model-selection/task-failures.js";

const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const GPT: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
const NOVA_PRO: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
const NOVA_PRO_V2: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v2:0" };
const NOVA_PREMIER: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-premier-v1:0" };
const NOVA_LITE: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-lite-v1:0" };
const BEDROCK_GPT_OSS: ModelIdentifier = { provider: "amazon-bedrock", modelId: "openai.gpt-oss-120b-1:0" };
const BEDROCK_GEMMA: ModelIdentifier = { provider: "amazon-bedrock", modelId: "google.gemma-3-27b-it" };
const BEDROCK_CLAUDE: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
const GEMINI: ModelIdentifier = { provider: "openrouter", modelId: "google/gemini-3-pro" };
const UNKNOWN_MAKER: ModelIdentifier = { provider: "openrouter", modelId: "x-ai/grok-9" };

const passed = (...models: ModelIdentifier[]): ((model: ModelIdentifier) => boolean) =>
  drivingTestGate(models.map((model) => ({ provider: model.provider, modelId: model.modelId, outcome: "passed" as const, testedAt: "2026-11-01T00:00:00.000Z" })));

const plan = (overrides: Partial<SecondReviewPlanInput> = {}): SecondReviewPlan => planSecondReview({
  switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [SONNET, OPUS, GPT, NOVA_PRO, NOVA_PREMIER, BEDROCK_GPT_OSS], drivingTestPassed: passed(GPT, NOVA_PRO, NOVA_PREMIER, BEDROCK_GPT_OSS),
  verdicts: [], replayRuns: [], ...overrides,
});
const ran = (result: SecondReviewPlan) => (result.run ? { mode: result.mode, model: `${result.model.provider}/${result.model.modelId}`, company: result.company, downgraded: result.downgraded } : { skipped: result.reason });

// ---- replay runs and verdicts (built from the real bar)
const replayCases = (spec: { known: number; planted: number; both: number; baselineOnly: number; extra: number; neither?: number }): SecondReviewReplayCase[] => {
  const shapes: Array<[boolean, boolean, number]> = [[true, true, spec.both], [true, false, spec.baselineOnly], [false, true, spec.extra], [false, false, spec.neither ?? 0]];
  const out: SecondReviewReplayCase[] = [];
  for (const [baselineCaught, candidateCaught, count] of shapes) {
    for (let i = 0; i < count; i += 1) out.push({ caseId: `c${String(out.length + 1)}`, kind: "known_defect", baselineCaught, candidateCaught, candidateBlockingFindings: 0, candidateDismissedBlocking: 0 });
  }
  return out.map((entry, index) => ({ ...entry, kind: index < spec.known ? "known_defect" as const : "planted_bug" as const }));
};
const PASSING_CASES = replayCases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 5 });
const runFor = (model: ModelIdentifier, over: Partial<SecondReviewReplayRun> = {}): SecondReviewReplayRun => ({ runId: "run-1", ranAt: "2026-11-01T00:00:00.000Z", candidate: model, baseline: OPUS, cases: PASSING_CASES, ...over });
const verdictFor = (model: ModelIdentifier, over: Partial<SecondReviewVerdict> = {}): SecondReviewVerdict => ({
  model: secondReviewModelKey(model), replayRunId: "run-1", baseline: OPUS, shadow: { startedAt: "2026-11-02T00:00:00.000Z", endedAt: "2026-11-16T00:00:00.000Z", findings: 10, agreed: 4 },
  createdAt: "2026-11-20T00:00:00.000Z", createdBy: "staff:alice", ...over,
});
/** Evidence that holds for a model: a passing replay run and a verdict on it. */
const proof = (model: ModelIdentifier) => ({ verdicts: [verdictFor(model)], replayRuns: [runFor(model)] });

describe("the setting review.otherCompany", () => {
  it("is off unless somebody chose; the project's choice beats the company's default", () => {
    expect(configuredSecondReviewMode({})).toBe("off");
    expect(configuredSecondReviewMode({ companyDefault: "shadow" })).toBe("shadow");
    expect(configuredSecondReviewMode({ companyDefault: "shadow", project: "off" })).toBe("off");
    expect(configuredSecondReviewMode({ companyDefault: "off", project: "on" })).toBe("on");
  });

  it("a company lock is a floor: it raises a project and never lowers one", () => {
    expect(configuredSecondReviewMode({ project: "off", companyLock: "shadow" })).toBe("shadow");
    expect(configuredSecondReviewMode({ companyDefault: "off", companyLock: "on" })).toBe("on");
    expect(configuredSecondReviewMode({ project: "on", companyLock: "shadow" })).toBe("on");
    expect(configuredSecondReviewMode({ project: "on", companyLock: "off" })).toBe("on");
    expect(stricterSecondReviewMode("shadow", "off")).toBe("shadow");
    expect(stricterSecondReviewMode("off", "on")).toBe("on");
  });

  it("lowering needs a second person (W8): on to shadow or off for a project, any lower lock; raising and observing do not", () => {
    expect(projectSecondReviewLoweringNeedsSecondPerson("on", "shadow")).toBe(true);
    expect(projectSecondReviewLoweringNeedsSecondPerson("on", "off")).toBe(true);
    expect(projectSecondReviewLoweringNeedsSecondPerson("shadow", "off")).toBe(false);
    expect(projectSecondReviewLoweringNeedsSecondPerson("off", "on")).toBe(false);
    expect(projectSecondReviewLoweringNeedsSecondPerson("on", "on")).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson("on", "shadow")).toBe(true);
    expect(lockSecondReviewLoweringNeedsSecondPerson("shadow", undefined)).toBe(true);
    expect(lockSecondReviewLoweringNeedsSecondPerson("on", "off")).toBe(true);
    expect(lockSecondReviewLoweringNeedsSecondPerson(undefined, "shadow")).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson("shadow", "on")).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson(undefined, undefined)).toBe(false);
    expect(lockSecondReviewLoweringNeedsSecondPerson("shadow", "shadow")).toBe(false);
  });
});

describe("planSecondReview: whether it runs", () => {
  it("runs nothing with the install switch off, whatever a project or company set", () => {
    expect(ran(plan({ switchOn: false, mode: "on" }))).toEqual({ skipped: "switch-off" });
  });

  it("runs nothing in mode off", () => {
    expect(ran(plan({ mode: "off" }))).toEqual({ skipped: "mode-off" });
  });

  it("runs nothing when no recorded model says what to differ from", () => {
    expect(ran(plan({ against: [] }))).toEqual({ skipped: "no-reference-model" });
  });

  it("starts its operation tagged, with the proxy's model fallback off", () => {
    const planned = plan();
    if (!planned.run) throw new Error("expected a plan");
    expect(planned.operation).toEqual({ tag: SECOND_REVIEW_OPERATION_TAG, modelFallback: "off" });
    expect(planned.operation).toBe(SECOND_REVIEW_OPERATION);
    expect(planned.against).toEqual([SONNET]);
  });
});

describe("planSecondReview: Amazon Bedrock only (W5)", () => {
  it("refuses a direct OpenAI model, or any non-Bedrock route, even for another company", () => {
    expect(ran(plan({ sources: [SONNET, GPT], drivingTestPassed: passed(GPT) }))).toEqual({ skipped: "no-candidate" });
    expect(ran(plan({ sources: [SONNET, GEMINI], drivingTestPassed: passed(GEMINI) }))).toEqual({ skipped: "no-candidate" });
    expect(ran(plan({ sources: [SONNET, { provider: "Amazon-Bedrock", modelId: "us.amazon.nova-pro-v1:0" }], drivingTestPassed: passed({ provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" }) }))).toMatchObject({ company: "amazon" });
  });

  it("an install with only direct keys gets no second review, not a quiet fallback to them", () => {
    expect(ran(plan({ sources: [SONNET, OPUS, GPT], drivingTestPassed: passed(GPT), mode: "on", ...proof(GPT) }))).toEqual({ skipped: "no-candidate" });
  });
});

describe("planSecondReview: which model", () => {
  it("puts Amazon Nova Premier first, then Nova Pro, ahead of another Bedrock company's model", () => {
    expect(ran(plan())).toEqual({ mode: "shadow", model: "amazon-bedrock/us.amazon.nova-premier-v1:0", company: "amazon", downgraded: undefined });
    expect(ran(plan({ sources: [SONNET, BEDROCK_GPT_OSS, NOVA_PRO], drivingTestPassed: passed(BEDROCK_GPT_OSS, NOVA_PRO) }))).toMatchObject({ model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
    // Without a Nova model that passed, another Bedrock company's model is next.
    expect(ran(plan({ drivingTestPassed: passed(BEDROCK_GPT_OSS) }))).toMatchObject({ model: "amazon-bedrock/openai.gpt-oss-120b-1:0", company: "openai" });
  });

  it("refuses a model that has not passed the driving test, or whose last driving test failed", () => {
    expect(ran(plan({ sources: [SONNET, NOVA_PRO], drivingTestPassed: passed() }))).toEqual({ skipped: "untested" });
    const records: DrivingTestRecord[] = [
      { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", outcome: "passed", testedAt: "2026-11-01T00:00:00.000Z" },
      { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", outcome: "failed", testedAt: "2026-11-02T00:00:00.000Z" },
    ];
    expect(ran(plan({ sources: [SONNET, NOVA_PRO], drivingTestPassed: drivingTestGate(records) }))).toEqual({ skipped: "untested" });
  });

  it("the driving test gate reads the latest test per provider and exact revision", () => {
    const gate = drivingTestGate([
      { provider: "amazon-bedrock", modelId: "eu.amazon.nova-pro-v1:0", outcome: "passed", testedAt: "2026-11-01T00:00:00.000Z" },
      { provider: "openrouter", modelId: "amazon/nova-lite-v1", outcome: "failed", testedAt: "2026-11-01T00:00:00.000Z" },
      { provider: "amazon-bedrock", modelId: "amazon.nova-lite-v1:0", outcome: "failed", testedAt: "2026-11-01T00:00:00.000Z" },
      { provider: "amazon-bedrock", modelId: "amazon.nova-lite-v1:0", outcome: "passed", testedAt: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(gate(NOVA_PRO)).toBe(true); // a geography is not another model
    expect(gate({ provider: "openrouter", modelId: "amazon/nova-pro-v1" })).toBe(false); // another provider's route is not tested by it
    expect(gate(NOVA_LITE)).toBe(false); // the later failure wins over the earlier pass
    expect(gate(GPT)).toBe(false); // never tested
  });

  it("another company only: the build's own company, and models of no known company, are never chosen", () => {
    expect(ran(plan({ against: [BEDROCK_CLAUDE], sources: [SONNET, BEDROCK_CLAUDE], drivingTestPassed: passed(BEDROCK_CLAUDE) }))).toEqual({ skipped: "no-candidate" });
    const unknown: ModelIdentifier = { provider: "amazon-bedrock", modelId: "xai.grok-4-v1:0" };
    expect(modelCompany(unknown)).toBe("other");
    expect(ran(plan({ sources: [SONNET, unknown], drivingTestPassed: passed(unknown) }))).toEqual({ skipped: "no-candidate" });
    expect(modelCompany(UNKNOWN_MAKER)).toBe("other");
  });

  it("a model must differ from the first review's company too", () => {
    // Build on Claude, first review on OpenAI (on Bedrock): Nova is a third company, Bedrock's OpenAI model is not.
    expect(ran(plan({ against: [SONNET, BEDROCK_GPT_OSS] }))).toMatchObject({ model: "amazon-bedrock/us.amazon.nova-premier-v1:0" });
    expect(ran(plan({ against: [SONNET, BEDROCK_GPT_OSS], sources: [SONNET, BEDROCK_GPT_OSS], drivingTestPassed: passed(BEDROCK_GPT_OSS) }))).toEqual({ skipped: "no-candidate" });
  });

  it("Bedrock's OpenAI and Google models are the same company as OpenAI and Google, not a different one", () => {
    expect(modelCompany(BEDROCK_GPT_OSS)).toBe("openai");
    expect(ran(plan({ against: [GPT], sources: [GPT, BEDROCK_GPT_OSS], drivingTestPassed: passed(BEDROCK_GPT_OSS) }))).toEqual({ skipped: "no-candidate" });
    expect(ran(plan({ against: [BEDROCK_GPT_OSS], sources: [GPT, BEDROCK_GPT_OSS], drivingTestPassed: passed(BEDROCK_GPT_OSS) }))).toEqual({ skipped: "no-candidate" });
    // Google: Bedrock's Gemma is never read as different from Gemini (it is not placed at all, and a model that is not placed never counts as different).
    expect(ran(plan({ against: [GEMINI], sources: [GEMINI, BEDROCK_GEMMA], drivingTestPassed: passed(BEDROCK_GEMMA) }))).toEqual({ skipped: "no-candidate" });
    expect(ran(plan({ against: [BEDROCK_GEMMA], sources: [BEDROCK_GEMMA, NOVA_PRO], drivingTestPassed: passed(BEDROCK_GEMMA) }))).toEqual({ skipped: "no-candidate" });
    // Another company's model on the same route still counts as different.
    expect(ran(plan({ against: [BEDROCK_GPT_OSS], sources: [BEDROCK_CLAUDE, BEDROCK_GPT_OSS], drivingTestPassed: passed(BEDROCK_CLAUDE) }))).toMatchObject({ company: "anthropic" });
  });

  it("never takes a forbidden model, by canonical name, whichever geography or route reaches it", () => {
    const forbidden: ModelIdentifier[] = [{ provider: "amazon-bedrock", modelId: "amazon.nova-premier-v1:0" }];
    expect(ran(plan({ forbidden, sources: [SONNET, NOVA_PREMIER, NOVA_PRO], drivingTestPassed: passed(NOVA_PREMIER, NOVA_PRO) }))).toMatchObject({ model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
    const jp: ModelIdentifier = { provider: "amazon-bedrock", modelId: "jp.amazon.nova-premier-v1:0" };
    expect(ran(plan({ forbidden, sources: [SONNET, jp], drivingTestPassed: passed(jp) }))).toEqual({ skipped: "no-candidate" });
  });

  it("refuses an unrecognised Bedrock id whenever anything is forbidden", () => {
    const odd: ModelIdentifier = { provider: "amazon-bedrock", modelId: "zz.amazon.nova-pro-v1:0" };
    expect(ran(plan({ forbidden: [OPUS], sources: [SONNET, odd], drivingTestPassed: passed(odd) }))).toEqual({ skipped: "no-candidate" });
  });

  it("only takes a model the project approves, and leaves out one the account could not use", () => {
    expect(ran(plan({ project: { approved: [SONNET, NOVA_PRO] } }))).toMatchObject({ model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
    expect(ran(plan({ unusable: [NOVA_PREMIER, NOVA_PRO] }))).toMatchObject({ model: "amazon-bedrock/openai.gpt-oss-120b-1:0" });
    expect(ran(plan({ project: { approved: [SONNET] } }))).toEqual({ skipped: "no-candidate" });
  });
});

describe("a test or a verdict is about one revision (F1)", () => {
  it("the key drops a geography and nothing else", () => {
    expect(secondReviewModelKey({ provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" })).toBe(secondReviewModelKey({ provider: "Amazon-Bedrock", modelId: "EU.amazon.nova-pro-v1:0" }));
    expect(secondReviewModelKey(NOVA_PRO)).not.toBe(secondReviewModelKey(NOVA_PRO_V2));
    expect(canonicalModelName(NOVA_PRO)).toBe(canonicalModelName(NOVA_PRO_V2)); // the family reads the same: that is why the key is not the canonical name
  });

  it("a driving test of v1 does not pass v2", () => {
    const gate = drivingTestGate([{ provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", outcome: "passed", testedAt: "2026-11-01T00:00:00.000Z" }]);
    expect(gate(NOVA_PRO)).toBe(true);
    expect(gate(NOVA_PRO_V2)).toBe(false);
    expect(ran(plan({ sources: [SONNET, NOVA_PRO_V2], drivingTestPassed: gate }))).toEqual({ skipped: "untested" });
  });

  it("a verdict on v1 does not give v2 on", () => {
    const base = { mode: "on" as const, sources: [SONNET, NOVA_PRO_V2], drivingTestPassed: passed(NOVA_PRO_V2) };
    expect(ran(plan({ ...base, verdicts: [verdictFor(NOVA_PRO)], replayRuns: [runFor(NOVA_PRO)] }))).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed", model: "amazon-bedrock/us.amazon.nova-pro-v2:0" });
    expect(ran(plan({ ...base, ...proof(NOVA_PRO_V2) }))).toMatchObject({ mode: "on" });
  });
});

describe("the latest driving test (F3)", () => {
  const at = (testedAt: string, outcome: "passed" | "failed"): DrivingTestRecord => ({ provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", outcome, testedAt });
  it("compares the times as times: an offset time is not ordered by its text", () => {
    // 2026-11-01T00:00+05:00 is 2026-10-31T19:00Z, EARLIER than 2026-10-31T20:00Z although its text sorts later.
    expect(drivingTestGate([at("2026-10-31T20:00:00.000Z", "failed"), at("2026-11-01T00:00:00.000+05:00", "passed")])(NOVA_PRO)).toBe(false);
    expect(drivingTestGate([at("2026-11-01T00:00:00.000+05:00", "passed"), at("2026-10-31T20:00:00.000Z", "failed")])(NOVA_PRO)).toBe(false);
    expect(drivingTestGate([at("2026-10-31T20:00:00.000Z", "passed"), at("2026-11-01T00:00:00.000+05:00", "failed")])(NOVA_PRO)).toBe(true);
  });

  it("a failed result wins a tie, in either order; an unreadable time is the oldest", () => {
    expect(drivingTestGate([at("2026-11-01T00:00:00.000Z", "passed"), at("2026-11-01T00:00:00.000Z", "failed")])(NOVA_PRO)).toBe(false);
    expect(drivingTestGate([at("2026-11-01T00:00:00.000Z", "failed"), at("2026-11-01T00:00:00.000Z", "passed")])(NOVA_PRO)).toBe(false);
    expect(drivingTestGate([at("not a time", "passed"), at("2026-11-01T00:00:00.000Z", "failed")])(NOVA_PRO)).toBe(false);
    expect(drivingTestGate([at("not a time", "failed"), at("2026-11-01T00:00:00.000Z", "passed")])(NOVA_PRO)).toBe(true);
  });
});

describe("a forbidden model is forbidden whatever the case of its provider (F2)", () => {
  const forbiddenGpt: ModelIdentifier[] = [{ provider: "openrouter", modelId: "openai/gpt-5" }];
  it("matches by canonical name across provider spellings", () => {
    expect(canonicalModelName({ provider: "OpenRouter", modelId: "openai/gpt-5" })).toBe(canonicalModelName(forbiddenGpt[0]!));
    expect(forbiddenModelMatcher(forbiddenGpt)({ provider: "OpenRouter", modelId: "openai/gpt-5" })).toBe(true);
    expect(forbiddenModelMatcher(forbiddenGpt)({ provider: "OPENROUTER", modelId: "OpenAI/GPT-5" })).toBe(true);
    expect(forbiddenModelMatcher([{ provider: "OpenRouter", modelId: "openai/gpt-5" }])({ provider: "openrouter", modelId: "openai/gpt-5" })).toBe(true);
  });
});

describe("planSecondReview: when on is allowed (W3: evidence is recomputed, never read as a pass)", () => {
  const onPlan = (over: Partial<SecondReviewPlanInput>) => ran(plan({ mode: "on", ...over }));

  it("configured on without evidence runs in shadow and says why", () => {
    expect(onPlan({})).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
  });

  it("runs in on on the model whose evidence holds, found by exact revision across geographies", () => {
    const geography: ModelIdentifier = { provider: "amazon-bedrock", modelId: "eu.amazon.nova-premier-v1:0" };
    expect(onPlan(proof(geography))).toEqual({ mode: "on", model: "amazon-bedrock/us.amazon.nova-premier-v1:0", company: "amazon", downgraded: undefined });
  });

  it("a verdict for another model proves nothing for this one", () => {
    expect(onPlan(proof(BEDROCK_GPT_OSS))).toMatchObject({ mode: "on", model: "amazon-bedrock/openai.gpt-oss-120b-1:0" });
    expect(onPlan({ drivingTestPassed: passed(NOVA_PRO), ...proof(BEDROCK_GPT_OSS) })).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed", model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
  });

  it("a verdict whose replay run fails the bar when scored again does not hold", () => {
    const weak = runFor(NOVA_PREMIER, { cases: replayCases({ known: 30, planted: 20, both: 31, baselineOnly: 9, extra: 5, neither: 5 }) });
    expect(onPlan({ verdicts: [verdictFor(NOVA_PREMIER)], replayRuns: [weak] })).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
  });

  it("a verdict with no stored run, or another run's id, or another model's run, does not hold", () => {
    expect(onPlan({ verdicts: [verdictFor(NOVA_PREMIER)], replayRuns: [] })).toMatchObject({ mode: "shadow" });
    expect(onPlan({ verdicts: [verdictFor(NOVA_PREMIER, { replayRunId: "run-2" })], replayRuns: [runFor(NOVA_PREMIER)] })).toMatchObject({ mode: "shadow" });
    expect(onPlan({ verdicts: [verdictFor(NOVA_PREMIER)], replayRuns: [runFor(NOVA_PRO)] })).toMatchObject({ mode: "shadow" });
    expect(onPlan({ verdicts: [verdictFor(NOVA_PREMIER, { baseline: SONNET })], replayRuns: [runFor(NOVA_PREMIER)] })).toMatchObject({ mode: "shadow" });
  });

  it("the shadow window is judged from its timestamps and counts, after the replay", () => {
    const hold = (shadow: Partial<SecondReviewVerdict["shadow"]>, run: Partial<SecondReviewReplayRun> = {}) =>
      secondReviewVerdictHolds(verdictFor(NOVA_PREMIER, { shadow: { ...verdictFor(NOVA_PREMIER).shadow, ...shadow } }), runFor(NOVA_PREMIER, run));
    expect(hold({})).toBe(true);
    expect(hold({ endedAt: "2026-11-15T23:59:59.000Z" })).toBe(false); // one second short of 14 days
    expect(hold({ startedAt: "2026-10-31T00:00:00.000Z", endedAt: "2026-11-20T00:00:00.000Z" })).toBe(false); // started before the replay ran
    expect(hold({ startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-20T00:00:00.000Z" })).toBe(false); // started AT the replay: not after it
    expect(hold({ agreed: 3 })).toBe(false); // exactly 30% is not above 30%
    expect(hold({ findings: 0, agreed: 0 })).toBe(false);
    expect(hold({ endedAt: "2026-11-01T00:00:00.000Z" })).toBe(false); // ends before it starts
    expect(hold({ startedAt: "garbage" })).toBe(false);
  });

  it("an admin withdraws a verdict; it then holds for nothing", () => {
    const withdrawn = verdictFor(NOVA_PREMIER, { withdrawnAt: "2026-11-25T00:00:00.000Z", withdrawnBy: "admin:bob" });
    expect(secondReviewVerdictHolds(withdrawn, runFor(NOVA_PREMIER))).toBe(false);
    expect(onPlan({ verdicts: [withdrawn], replayRuns: [runFor(NOVA_PREMIER)] })).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
  });

  it("the record has no pass flag to set: a stored pass is not a field", () => {
    const good = verdictFor(NOVA_PREMIER);
    expect(SecondReviewVerdictSchema.safeParse(good).success).toBe(true);
    expect(SecondReviewVerdictSchema.safeParse({ ...good, replayPassed: true }).success).toBe(false);
    expect(SecondReviewVerdictSchema.safeParse({ ...good, shadowPassed: true }).success).toBe(false);
    expect(SecondReviewVerdictSchema.safeParse({ ...good, withdrawnAt: "2026-11-25T00:00:00.000Z" }).success).toBe(false); // withdrawn without saying by whom
  });

  it("a verified model that is untested is still refused", () => {
    expect(onPlan({ sources: [SONNET, NOVA_PREMIER], drivingTestPassed: passed(), ...proof(NOVA_PREMIER) })).toEqual({ skipped: "untested" });
  });

  it("shadow stays shadow even for a verified model", () => {
    expect(ran(plan({ mode: "shadow", ...proof(NOVA_PREMIER) }))).toMatchObject({ mode: "shadow", downgraded: undefined });
  });
});

describe("againstModels (W6)", () => {
  it("is every build operation's ran model, in every round, and the first reviewer's", () => {
    expect(againstModels({ buildRanModels: [SONNET, OPUS, SONNET], firstReviewerRan: BEDROCK_GPT_OSS })).toEqual([SONNET, OPUS, BEDROCK_GPT_OSS]);
  });

  it("is undefined when any model is unknown, because an unknown model cannot be shown to differ", () => {
    expect(againstModels({ buildRanModels: [SONNET, undefined], firstReviewerRan: OPUS })).toBeUndefined();
    expect(againstModels({ buildRanModels: [SONNET], firstReviewerRan: undefined })).toBeUndefined();
    expect(againstModels({ buildRanModels: [], firstReviewerRan: OPUS })).toBeUndefined();
  });

  it("a second round's build model counts: a reviewer that matches round 2's company is refused", () => {
    const against = againstModels({ buildRanModels: [SONNET, BEDROCK_GPT_OSS], firstReviewerRan: OPUS })!;
    expect(ran(plan({ against, sources: [BEDROCK_GPT_OSS, NOVA_PRO], drivingTestPassed: passed(BEDROCK_GPT_OSS, NOVA_PRO) }))).toMatchObject({ company: "amazon" });
    expect(ran(plan({ against, sources: [BEDROCK_GPT_OSS], drivingTestPassed: passed(BEDROCK_GPT_OSS) }))).toEqual({ skipped: "no-candidate" });
  });
});

const digest = "a".repeat(64);
const report = (status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = [], extra: Partial<WorkflowReviewReport> = {}): WorkflowReviewReport => ({
  operationId: randomUUID(), candidateDigest: digest, role: "CRITIC", provider: "amazon-bedrock", version: "us.amazon.nova-premier-v1:0", status, findings, readOnly: true, recordedAt: "2026-11-02T12:00:00.000Z", ...extra,
});
const BLOCKING = { text: "off by one in the loop bound", origin: "INTRODUCED" as const };
const runPlan = (mode: "shadow" | "on") => {
  const planned = plan({ mode, ...(mode === "on" ? proof(NOVA_PREMIER) : {}) });
  if (!planned.run) throw new Error("expected a plan");
  return planned;
};
const opinion = (mode: "shadow" | "on", r: WorkflowReviewReport, over: Partial<Parameters<typeof secondOpinionOf>[0]> = {}) =>
  secondOpinionOf({ plan: runPlan(mode), report: r, currentCandidateDigest: digest, ranModel: NOVA_PREMIER, ...over });

describe("secondOpinionOf: what a finished second review means", () => {
  it("shadow never blocks, and records what on would have done", () => {
    expect(opinion("shadow", report("FINDINGS", [BLOCKING]))).toMatchObject({ mode: "shadow", blocked: false, wouldHaveBlocked: true, blockingCount: 1, unavailable: false, company: "amazon" });
  });

  it("on blocks on a finding the change introduced", () => {
    expect(opinion("on", report("FINDINGS", [BLOCKING]))).toMatchObject({ mode: "on", blocked: true, wouldHaveBlocked: true, blockingCount: 1 });
  });

  it("on does not block on a pass, an advisory or pre-existing finding, or one the owner accepted as a risk", () => {
    expect(opinion("on", report("PASS"))).toMatchObject({ blocked: false, wouldHaveBlocked: false, blockingCount: 0 });
    expect(opinion("on", report("PASS", [{ text: "style nit", origin: "INTRODUCED", advisory: true }, { text: "old problem", origin: "PRE_EXISTING" }]))).toMatchObject({ blocked: false });
    const found = report("FINDINGS", [BLOCKING]);
    const accepted = [{ candidateDigest: digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: BLOCKING.text }) }];
    expect(opinion("on", found, { accepted })).toMatchObject({ blocked: false, wouldHaveBlocked: false });
    expect(opinion("on", found, { accepted: [{ ...accepted[0]!, fingerprint: "b".repeat(64) }] })).toMatchObject({ blocked: true });
  });

  it("a second review that gave no answer blocks nothing, in either mode, and says it did not run", () => {
    for (const status of ["FAILED", "INTERRUPTED", "UNKNOWN"] as const) {
      expect(opinion("on", report(status)), status).toMatchObject({ blocked: false, wouldHaveBlocked: false, unavailable: true, unavailableReason: "no-answer" });
      expect(opinion("shadow", report(status)), status).toMatchObject({ blocked: false, unavailable: true });
    }
  });

  it("keeps the downgrade on the record", () => {
    const downgraded = plan({ mode: "on" });
    if (!downgraded.run) throw new Error("expected a plan");
    expect(secondOpinionOf({ plan: downgraded, report: report("FINDINGS", [BLOCKING]), currentCandidateDigest: digest, ranModel: NOVA_PREMIER })).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed", blocked: false });
  });

  it("the record cannot say a shadow opinion blocked, an unknown company, or an unavailable one with findings", () => {
    const good = opinion("shadow", report("FINDINGS", [BLOCKING]));
    expect(SecondOpinionSchema.safeParse({ ...good, blocked: true }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, company: "other" }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, unavailable: true }).success).toBe(false);
    const gone = secondOpinionUnavailable(runPlan("on"), "not-run");
    expect(SecondOpinionSchema.safeParse({ ...gone, wouldHaveBlocked: true }).success).toBe(false);
  });

  it("shows a shadow opinion on the task page and never on the pull request; an on opinion that blocked on both", () => {
    expect(secondOpinionShownOn({ mode: "shadow", blocked: false })).toEqual({ taskPage: true, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "on", blocked: false })).toEqual({ taskPage: true, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "on", blocked: true })).toEqual({ taskPage: true, pullRequest: true });
  });
});

describe("acceptSecondReport (W2)", () => {
  const check = (over: Partial<Parameters<typeof acceptSecondReport>[0]> = {}) => acceptSecondReport({ plan: runPlan("on"), report: report("FINDINGS", [BLOCKING]), currentCandidateDigest: digest, ranModel: NOVA_PREMIER, ...over });

  it("accepts the code review of the current candidate from the planned model", () => {
    expect(check()).toEqual({ accepted: true });
    // The planned model reached through another geography is the same revision.
    expect(check({ ranModel: { provider: "amazon-bedrock", modelId: "eu.amazon.nova-premier-v1:0" } })).toEqual({ accepted: true });
  });

  it("refuses when the report's own provider and version name another model than the plan, whatever the operation record says (ran model)", () => {
    expect(check({ report: report("PASS", [], { provider: "amazon-bedrock", version: "us.amazon.nova-pro-v1:0" }) })).toEqual({ accepted: false, reason: "wrong-model" });
    expect(check({ report: report("PASS", [], { provider: "openai", version: "gpt-5.5" }) })).toEqual({ accepted: false, reason: "wrong-model" });
    expect(check({ report: report("PASS", [], { version: "us.amazon.nova-premier-v2:0" }) })).toEqual({ accepted: false, reason: "wrong-model" });
    expect(check({ report: report("PASS", [], { provider: "Amazon-Bedrock", version: "eu.amazon.nova-premier-v1:0" }) })).toEqual({ accepted: true });
  });

  it("refuses a security review, another candidate, and a missing current candidate", () => {
    expect(check({ report: report("PASS", [], { role: "SECURITY" }) })).toEqual({ accepted: false, reason: "wrong-role" });
    expect(check({ report: report("PASS", [], { candidateDigest: "c".repeat(64) }) })).toEqual({ accepted: false, reason: "wrong-candidate" });
    expect(check({ currentCandidateDigest: undefined })).toEqual({ accepted: false, reason: "wrong-candidate" });
  });

  it("refuses when the model that actually ran is not the planned one, or is unknown, or a revision away", () => {
    expect(check({ ranModel: NOVA_PRO })).toEqual({ accepted: false, reason: "wrong-model" });
    expect(check({ ranModel: undefined })).toEqual({ accepted: false, reason: "wrong-model" });
    expect(check({ ranModel: { provider: "amazon-bedrock", modelId: "us.amazon.nova-premier-v2:0" } })).toEqual({ accepted: false, reason: "wrong-model" });
  });

  it("refuses when the ran model is, after all, the same company as something in against", () => {
    const planned = runPlan("shadow");
    // The recorded history turned out to include an Amazon model (a build round recorded later): the planned model is no longer a different company.
    const tainted = { ...planned, against: [...planned.against, NOVA_LITE] };
    expect(acceptSecondReport({ plan: tainted, report: report("PASS"), currentCandidateDigest: digest, ranModel: NOVA_PREMIER })).toEqual({ accepted: false, reason: "same-company" });
  });

  it("a report that is not accepted leaves an unavailable opinion with no findings, in on too", () => {
    for (const bad of [{ ranModel: NOVA_PRO }, { currentCandidateDigest: "d".repeat(64) }, { report: report("FINDINGS", [BLOCKING], { role: "SECURITY" }) }]) {
      const result = opinion("on", report("FINDINGS", [BLOCKING]), bad);
      expect(result).toMatchObject({ unavailable: true, blocked: false, wouldHaveBlocked: false, blockingCount: 0 });
      expect(result.report).toBeUndefined();
    }
  });
});

describe("a second review that cannot run (owner decision 2026-11-02: retry, then flag)", () => {
  const REASONS = ["no-answer", "wrong-model", "budget", "not-run", "no-candidate", "wrong-role", "wrong-candidate", "same-company"] as const;

  it("never blocks, whatever the reason or mode", () => {
    for (const reason of REASONS) for (const mode of ["on", "shadow"] as const) expect(secondReviewBlocksWhenUnavailable({ mode, reason }), `${mode} ${reason}`).toBe(false);
  });

  it("on: flags it on the task page and the pull request and asks the owner to acknowledge; shadow stays silent", () => {
    for (const reason of REASONS) {
      expect(secondReviewUnavailableDecision({ mode: "on", reason })).toMatchObject({ blocks: false, showOnTaskPage: true, showOnPullRequest: true, askOwnerToAcknowledge: true, line: expect.stringMatching(/^Second review did not run: .+/u) as string });
      expect(secondReviewUnavailableDecision({ mode: "shadow", reason }), reason).toEqual({ blocks: false, showOnTaskPage: false, showOnPullRequest: false, askOwnerToAcknowledge: false, line: undefined });
    }
  });

  it("the page rules follow: an unavailable on opinion is on the PR, an unavailable shadow one is nowhere, an answered shadow one is on the task page only", () => {
    expect(secondOpinionShownOn({ mode: "on", blocked: false, unavailable: true })).toEqual({ taskPage: true, pullRequest: true });
    expect(secondOpinionShownOn({ mode: "shadow", blocked: false, unavailable: true })).toEqual({ taskPage: false, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "shadow", blocked: false, unavailable: false })).toEqual({ taskPage: true, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "on", blocked: false, unavailable: false })).toEqual({ taskPage: true, pullRequest: false });
  });

  it("the pull request says one fixed line for an on opinion that did not run, with no model text", () => {
    for (const reason of REASONS) {
      const lines = secondOpinionPrLines(secondOpinionUnavailable({ mode: "on", company: "amazon" }, reason));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^Second review did not run: [A-Za-z ,.'-]+$/u);
    }
    expect(secondOpinionPrLines(secondOpinionUnavailable({ mode: "shadow", company: "amazon" }, "no-answer"))).toEqual([]);
  });

  it("no candidate at all is an opinion with no company, flagged the same way", () => {
    const none = secondOpinionUnavailable({ mode: "on" }, "no-candidate");
    expect(none.company).toBeUndefined();
    expect(secondOpinionShownOn(none)).toEqual({ taskPage: true, pullRequest: true });
    expect(secondReviewAcknowledgement(none, digest)).toMatchObject({ required: true });
  });

  it("asks the task owner to acknowledge before merge, once per candidate, and the merge waits until they have", () => {
    const flagged = secondOpinionUnavailable({ mode: "on", company: "amazon" }, "no-answer");
    const ack = secondReviewAcknowledgement(flagged, digest);
    if (!ack.required) throw new Error("expected an ask");
    expect(ack.text).toMatch(/^Second review did not run: .+Acknowledge before merging\.$/u);
    expect(secondReviewAcknowledgement(flagged, digest)).toEqual(ack); // the same ask is the same key
    const otherCandidate = secondReviewAcknowledgement(flagged, "f".repeat(64));
    expect(otherCandidate.required && otherCandidate.key).not.toBe(ack.key);
    expect(mergeWaitsForSecondReview(flagged, digest, [])).toBe(true);
    expect(mergeWaitsForSecondReview(flagged, digest, [ack.key])).toBe(false);
    expect(mergeWaitsForSecondReview(flagged, "f".repeat(64), [ack.key])).toBe(true); // an acknowledgement is for that candidate only
    expect(mergeWaitsForSecondReview(secondOpinionUnavailable({ mode: "shadow", company: "amazon" }, "no-answer"), digest, [])).toBe(false);
    expect(mergeWaitsForSecondReview(opinion("on", report("PASS")), digest, [])).toBe(false);
    expect(mergeWaitsForSecondReview(undefined, digest, [])).toBe(false);
  });

  describe("the tries: the same model once more, then the next allowed candidate, at most three", () => {
    const onInput = (over: Partial<SecondReviewPlanInput> = {}): SecondReviewPlanInput => ({
      switchOn: true, mode: "on", against: [SONNET], project: {}, forbidden: [], sources: [SONNET, NOVA_PREMIER, NOVA_PRO, BEDROCK_GPT_OSS], drivingTestPassed: passed(NOVA_PREMIER, NOVA_PRO, BEDROCK_GPT_OSS),
      verdicts: [verdictFor(NOVA_PREMIER, { replayRunId: "run-1" }), verdictFor(NOVA_PRO, { replayRunId: "run-2" }), verdictFor(BEDROCK_GPT_OSS, { replayRunId: "run-3" })],
      replayRuns: [runFor(NOVA_PREMIER, { runId: "run-1" }), runFor(NOVA_PRO, { runId: "run-2" }), runFor(BEDROCK_GPT_OSS, { runId: "run-3" })], ...over,
    });
    const nextModel = (result: ReturnType<typeof nextSecondReviewTry>) => ("try" in result ? `${result.try.model.modelId}|${result.try.mode}` : `giveUp:${result.giveUp}`);
    const attempt = (model: ModelIdentifier, outcome: SecondReviewAttempt["outcome"], mode: "shadow" | "on" = "on"): SecondReviewAttempt => ({ model, outcome, mode });

    it("the first try is the best candidate", () => {
      expect(nextModel(nextSecondReviewTry(onInput(), []))).toBe("us.amazon.nova-premier-v1:0|on");
    });

    it("a first answer-less try is retried on the same model", () => {
      expect(nextModel(nextSecondReviewTry(onInput(), [attempt(NOVA_PREMIER, "no-answer")]))).toBe("us.amazon.nova-premier-v1:0|on");
    });

    it("an unusable model goes straight to the next allowed candidate", () => {
      expect(nextModel(nextSecondReviewTry(onInput(), [attempt(NOVA_PREMIER, "unusable")]))).toBe("us.amazon.nova-pro-v1:0|on");
    });

    it("a model with no answer twice is left out; the third try is the next candidate", () => {
      expect(nextModel(nextSecondReviewTry(onInput(), [attempt(NOVA_PREMIER, "no-answer"), attempt(NOVA_PREMIER, "no-answer")]))).toBe("us.amazon.nova-pro-v1:0|on");
    });

    it("stops after three tries, whatever is left", () => {
      expect(SECOND_REVIEW_TRIES_MAX).toBe(3);
      expect(nextModel(nextSecondReviewTry(onInput(), [attempt(NOVA_PREMIER, "no-answer"), attempt(NOVA_PREMIER, "no-answer"), attempt(NOVA_PRO, "no-answer")]))).toBe("giveUp:no-answer");
      expect(nextModel(nextSecondReviewTry(onInput(), [attempt(NOVA_PREMIER, "unusable"), attempt(NOVA_PRO, "unusable"), attempt(BEDROCK_GPT_OSS, "unusable")]))).toBe("giveUp:no-answer");
    });

    it("gives up when no candidate is left, flagged as such", () => {
      expect(nextModel(nextSecondReviewTry(onInput({ project: { approved: [SONNET] } }), []))).toBe("giveUp:no-candidate");
      expect(nextModel(nextSecondReviewTry(onInput({ sources: [SONNET, NOVA_PREMIER], verdicts: [verdictFor(NOVA_PREMIER, { replayRunId: "run-1" })], replayRuns: [runFor(NOVA_PREMIER, { runId: "run-1" })] }), [attempt(NOVA_PREMIER, "unusable")]))).toBe("giveUp:no-answer");
    });

    it("never swaps a blocking review for a silent one: if the next candidate could only run in shadow, it gives up", () => {
      // Only Nova Premier has evidence for on. After it fails, the next candidate (Nova Pro) would run in shadow: not taken.
      const input = onInput({ verdicts: [verdictFor(NOVA_PREMIER, { replayRunId: "run-1" })], replayRuns: [runFor(NOVA_PREMIER, { runId: "run-1" })] });
      expect(nextModel(nextSecondReviewTry(input, [attempt(NOVA_PREMIER, "unusable")]))).toBe("giveUp:no-answer");
      expect(nextModel(nextSecondReviewTry(input, [attempt(NOVA_PREMIER, "no-answer"), attempt(NOVA_PREMIER, "no-answer")]))).toBe("giveUp:no-answer");
    });

    it("a context-length rejection counts as no answer, so it never retires the model for the other tries", () => {
      const rejected = report("FAILED", [], { modelFailure: "the model call failed: request-rejected ValidationException HTTP 400" });
      expect(secondReviewModelUnusable(rejected)).toBe(false);
      expect(nextModel(nextSecondReviewTry(onInput(), [attempt(NOVA_PREMIER, secondReviewModelUnusable(rejected) ? "unusable" : "no-answer")]))).toBe("us.amazon.nova-premier-v1:0|on");
    });

    it("shadow tries follow the same count, and its result stays silent", () => {
      const shadowInput = onInput({ mode: "shadow", verdicts: [], replayRuns: [] });
      expect(nextModel(nextSecondReviewTry(shadowInput, [attempt(NOVA_PREMIER, "no-answer", "shadow"), attempt(NOVA_PREMIER, "no-answer", "shadow")]))).toBe("us.amazon.nova-pro-v1:0|shadow");
      expect(secondReviewUnavailableDecision({ mode: "shadow", reason: "no-answer" }).showOnPullRequest).toBe(false);
    });

    it("THE ATTACKER CASE: a diff that makes every candidate time out or come back unusable ends flagged and needing acknowledgement, never passing silently", () => {
      // Drive the whole sequence the way the engine will: try, record the outcome, ask for the next try, until it gives up.
      const attempts: SecondReviewAttempt[] = [];
      let guard = 0;
      let verdict: ReturnType<typeof nextSecondReviewTry>;
      for (;;) {
        verdict = nextSecondReviewTry(onInput(), attempts);
        if (!("try" in verdict) || (guard += 1) > 10) break;
        // The injected diff: Nova Premier times out, Nova Pro is "unusable", the OpenAI model times out.
        const outcome = verdict.try.model.modelId.includes("nova-pro") ? "unusable" : "no-answer";
        attempts.push({ model: verdict.try.model, mode: verdict.try.mode, outcome });
      }
      expect(attempts.length).toBeLessThanOrEqual(SECOND_REVIEW_TRIES_MAX);
      expect(guard).toBeLessThanOrEqual(SECOND_REVIEW_TRIES_MAX);
      if (!("giveUp" in verdict)) throw new Error("the sequence must end");
      const flagged = secondOpinionUnavailable({ mode: "on", company: "amazon" }, verdict.giveUp);
      // Not blocked, but shown on both pages, with the fixed line, and the merge waits for the owner.
      expect(flagged).toMatchObject({ unavailable: true, blocked: false, wouldHaveBlocked: false });
      expect(secondOpinionShownOn(flagged)).toEqual({ taskPage: true, pullRequest: true });
      expect(secondOpinionPrLines(flagged)[0]).toMatch(/^Second review did not run:/u);
      expect(mergeWaitsForSecondReview(flagged, digest, [])).toBe(true);
    });

    it("the same attack with every candidate unusable and with no candidate at all is flagged too", () => {
      const allUnusable = [attempt(NOVA_PREMIER, "unusable"), attempt(NOVA_PRO, "unusable"), attempt(BEDROCK_GPT_OSS, "unusable")];
      const stopped = nextSecondReviewTry(onInput(), allUnusable);
      expect(stopped).toEqual({ giveUp: "no-answer" });
      const none = nextSecondReviewTry(onInput({ sources: [SONNET] }), []);
      expect(none).toEqual({ giveUp: "no-candidate" });
      for (const result of [stopped, none]) {
        if (!("giveUp" in result)) throw new Error("expected give up");
        expect(mergeWaitsForSecondReview(secondOpinionUnavailable({ mode: "on" }, result.giveUp), digest, [])).toBe(true);
      }
    });
  });
});

describe("the pull request lines (W7)", () => {
  const hostile = "See [the fix](https://evil.example/x) @octocat #123 ![img](https://evil.example/i.png) <!-- hide --> GH-45 Fixes ENG-9 https://evil.example/path www.evil.example";

  it("are empty for a shadow opinion and a non-blocking one, and one fixed line for an on one that did not run", () => {
    expect(secondOpinionPrLines(opinion("shadow", report("FINDINGS", [{ text: hostile, origin: "INTRODUCED" }])))).toEqual([]);
    expect(secondOpinionPrLines(opinion("on", report("PASS")))).toEqual([]);
    // An `on` one that did not run is the one fixed line, no model text (owner decision 2026-11-02).
    expect(secondOpinionPrLines(secondOpinionUnavailable(runPlan("on"), "no-answer"))).toEqual(["Second review did not run: the reviewer gave no usable answer after retrying"]);
    expect(secondOpinionPrLines(secondOpinionUnavailable(runPlan("shadow"), "no-answer"))).toEqual([]);
  });

  it("make model text inert: no link, mention, image, comment, issue reference or closing word survives", () => {
    const lines = secondOpinionPrLines(opinion("on", report("FINDINGS", [{ text: hostile, origin: "INTRODUCED", file: "src/@evil/[x](y).ts", line: 9 }], { version: "@octocat <b>model</b>" })));
    const text = lines.join("\n");
    expect(lines[0]).toContain("Second review");
    expect(text).not.toMatch(/\]\(/u);
    expect(text).not.toMatch(/<!--|<b>|<\/b>/u);
    expect(text).not.toMatch(/(?<!‍)@octocat|(?<!‍)@evil/u);
    expect(text).not.toMatch(/!\[/u);
    expect(text).not.toMatch(/https?:\/\/(?!‍)/u);
    expect(text).not.toMatch(/#(?=\d)/u);
    expect(text).not.toMatch(/Fixes ENG-9/u);
  });

  it("list the same blocking findings the opinion blocked on: one the owner accepted as a risk is not listed (and with all accepted there are no lines)", () => {
    const two = opinion("on", report("FINDINGS", [BLOCKING, { text: "second problem", origin: "INTRODUCED" }]));
    const accepted = [{ candidateDigest: digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: BLOCKING.text }) }];
    const text = secondOpinionPrLines(two, accepted).join("\n");
    expect(text).toContain("1 blocking finding");
    expect(text).toContain("second problem");
    expect(text).not.toContain(BLOCKING.text);
    const both = [...accepted, { candidateDigest: digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: "second problem" }) }];
    expect(secondOpinionPrLines(two, both)).toEqual([]);
  });

  it("are bounded: at most five findings, each cut", () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ text: `finding ${String(n)} ${"x".repeat(1000)}`.slice(0, 600), origin: "INTRODUCED" as const }));
    const lines = secondOpinionPrLines(opinion("on", report("FINDINGS", many)));
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("12 blocking findings");
    for (const line of lines.slice(1)) expect(Array.from(line).length).toBeLessThanOrEqual(480);
  });
});

describe("the context-length rule (unusable models)", () => {
  it("reads a model the account cannot use from the report, so the next try leaves it out", () => {
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: model-not-found" }))).toBe(true);
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: key-rejected ValidationException HTTP 403" }))).toBe(true);
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: provider-quota HTTP 402" }))).toBe(true);
  });

  it("a rejected request (which is how a prompt over the context length arrives) and an unknown failure do not retire the model", () => {
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: request-rejected ValidationException HTTP 400" }))).toBe(false);
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: unknown" }))).toBe(false);
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: rate-limited" }))).toBe(false);
    expect(secondReviewModelUnusable(report("PASS"))).toBe(false);
  });
});

describe("cost and admission", () => {
  it("estimates from the catalog price with no caching", () => {
    expect(estimateSecondReviewUsd({ inputUsdPerMTok: 0.8, outputUsdPerMTok: 3.2 }, { input: 100_000, maxOutput: 4_000 })).toBeCloseTo(0.0928, 6);
  });

  it("admits when the estimate fits the payer's room, once per candidate per round", () => {
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.09, roomUsd: 0.1, alreadyRan: false })).toEqual({ admit: true });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.09, roomUsd: 0.09, alreadyRan: false })).toEqual({ admit: true });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.1, roomUsd: 0.09, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
    expect(admitSecondReview({ mode: "on", estimateUsd: 0.1, roomUsd: 0.09, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.01, roomUsd: 5, alreadyRan: true })).toEqual({ admit: false, reason: "not-run" });
  });

  it("fails closed on a number it cannot read", () => {
    expect(admitSecondReview({ mode: "shadow", estimateUsd: Number.NaN, roomUsd: 5, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
    expect(admitSecondReview({ mode: "shadow", estimateUsd: 0.01, roomUsd: Number.NaN, alreadyRan: false })).toEqual({ admit: false, reason: "budget" });
  });

  it("knows a second review already ran for a candidate in a round, by its tag", () => {
    const ops = [{ secondReview: true, candidateDigest: digest, round: 1 }, { candidateDigest: digest, round: 2 }];
    expect(secondReviewAlreadyRan(ops, digest, 1)).toBe(true);
    expect(secondReviewAlreadyRan(ops, digest, 2)).toBe(false); // an untagged operation is the first review's
    expect(secondReviewAlreadyRan(ops, "e".repeat(64), 1)).toBe(false);
  });
});

describe("a second review is its own operation (W1)", () => {
  it("is recognised by its tag", () => {
    expect(isSecondReviewOperation({ secondReview: true })).toBe(true);
    expect(isSecondReviewOperation({})).toBe(false);
    expect(isSecondReviewOperation({ secondReview: "true" })).toBe(false);
  });

  it("a second review's failure never retires a model for the first review's retries", () => {
    const failed = { workflowMode: "REVIEW", status: "FAILED", error: "MODEL_NOT_ALLOWED: nope", createdAt: "2026-11-02T12:00:00.000Z", model: { provider: "amazon-bedrock", modelId: "us.amazon.nova-premier-v1:0" } };
    expect(reviewFailures([failed], undefined).models).toHaveLength(1);
    expect(reviewFailures([{ ...failed, secondReview: true }], undefined)).toEqual({ models: [], sinceLatestBuild: 0 });
  });
});

const cases = (spec: { known: number; planted: number; both: number; baselineOnly: number; extra: number; neither?: number }): SecondReviewReplayCase[] => {
  const shapes: Array<[boolean, boolean, number]> = [[true, true, spec.both], [true, false, spec.baselineOnly], [false, true, spec.extra], [false, false, spec.neither ?? 0]];
  const out: SecondReviewReplayCase[] = [];
  for (const [baselineCaught, candidateCaught, count] of shapes) {
    for (let i = 0; i < count; i += 1) out.push({ caseId: `c${String(out.length + 1)}`, kind: "known_defect", baselineCaught, candidateCaught, candidateBlockingFindings: 0, candidateDismissedBlocking: 0 });
  }
  // The first `known` cases are past tasks with a known defect, the rest are planted-bug diffs.
  return out.map((entry, index) => ({ ...entry, kind: index < spec.known ? "known_defect" as const : "planted_bug" as const }));
};
const withDismissed = (list: SecondReviewReplayCase[], dismissed: number): SecondReviewReplayCase[] =>
  list.map((entry, index) => (index === 0 ? { ...entry, candidateBlockingFindings: dismissed, candidateDismissedBlocking: dismissed } : entry));

describe("the replay check (section 9.2)", () => {
  it("passes a run that meets every part of the bar, at the exact edges", () => {
    // 50 tasks: 30 known + 20 planted. Baseline catches 40; the candidate catches 32 of them (80%) and adds 5 (1 in 10).
    const list = cases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 5 });
    expect(list).toHaveLength(50);
    expect(summarizeSecondReviewReplay(list)).toMatchObject({ tasks: 50, knownDefects: 30, plantedBugs: 20, baselineCaught: 40, bothCaught: 32, extraCatches: 5, dismissedBlocking: 0, passed: true, failures: [] });
  });

  it("fails just under each edge, naming the part", () => {
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 20, both: 31, baselineOnly: 9, extra: 5, neither: 5 })).failures).toEqual(["catch-share-low"]);
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 4, neither: 6 })).failures).toEqual(["few-extra-catches"]);
    // Dismissed blocking findings must stay UNDER one per 5 tasks: 10 over 50 tasks is one per 5, which fails; 9 passes.
    const base = cases({ known: 30, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 5 });
    expect(summarizeSecondReviewReplay(withDismissed(base, 10)).failures).toEqual(["too-many-dismissed"]);
    expect(summarizeSecondReviewReplay(withDismissed(base, 9)).passed).toBe(true);
  });

  it("a set that is too small does not pass, however well it did", () => {
    expect(summarizeSecondReviewReplay(cases({ known: 29, planted: 20, both: 32, baselineOnly: 8, extra: 5, neither: 4 })).failures).toEqual(["too-few-known-defects"]);
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 19, both: 32, baselineOnly: 8, extra: 5, neither: 4 })).failures).toEqual(["too-few-planted-bugs"]);
    const empty = summarizeSecondReviewReplay([]);
    expect(empty.passed).toBe(false);
    expect(empty.failures).toEqual(["too-few-known-defects", "too-few-planted-bugs", "baseline-caught-nothing", "few-extra-catches"]);
  });

  it("a baseline that caught nothing gives no share to compare with, so it fails", () => {
    expect(summarizeSecondReviewReplay(cases({ known: 30, planted: 20, both: 0, baselineOnly: 0, extra: 50 })).failures).toContain("baseline-caught-nothing");
  });

  it("reads a run's fields strictly: counts and flags only, no repeated case, dismissed within blocking", () => {
    const entry: SecondReviewReplayCase = { caseId: "t-1", kind: "known_defect", baselineCaught: true, candidateCaught: true, candidateBlockingFindings: 2, candidateDismissedBlocking: 1 };
    const run = { runId: "r-1", ranAt: "2026-11-20T00:00:00.000Z", candidate: { provider: "amazon-bedrock", modelId: "amazon.nova-premier-v1:0" }, baseline: { provider: "anthropic", modelId: "claude-opus-4-6" }, cases: [entry] };
    expect(SecondReviewReplayRunSchema.safeParse(run).success).toBe(true);
    expect(SecondReviewReplayRunSchema.safeParse({ ...run, cases: [entry, entry] }).success).toBe(false);
    expect(SecondReviewReplayRunSchema.safeParse({ ...run, cases: [{ ...entry, candidateDismissedBlocking: 3 }] }).success).toBe(false);
    expect(SecondReviewReplayRunSchema.safeParse({ ...run, cases: [{ ...entry, text: "model output" }] }).success).toBe(false);
  });

  it("the shadow phase needs two weeks and more than 30% of findings agreed with or fixed", () => {
    expect(secondReviewShadowPassed({ days: 14, findings: 10, agreed: 4 })).toBe(true);
    expect(secondReviewShadowPassed({ days: 14, findings: 10, agreed: 3 })).toBe(false); // exactly 30% is not above 30%
    expect(secondReviewShadowPassed({ days: 13, findings: 10, agreed: 10 })).toBe(false);
    expect(secondReviewShadowPassed({ days: 30, findings: 0, agreed: 0 })).toBe(false);
    expect(SECOND_REVIEW_BAR.shadowDays).toBe(14);
  });
});

describe("How we work: the second opinion row", () => {
  const mark = <T,>(value: T, locked = false) => ({ value, source: "company" as const, locked, ...(locked ? { lockedBy: "company" as const } : {}) });
  const stage = (who: Record<string, unknown>) => ({
    id: "review", name: "Review", kind: "review", who: { model: mark(null), thinking: mark(null), differentCompanyFrom: mark([]), ...who },
    knows: { instructions: [] }, may: { tools: mark(null), readOnly: true }, checked: { items: [] }, evidence: { items: [] }, approves: { items: [] },
  });

  it("is optional, so a view without it (switch off, or an older broker) still reads", () => {
    expect(HowWeWorkStageSchema.safeParse(stage({})).success).toBe(true);
  });

  it("takes exactly the three modes, with a company lock marked as locked", () => {
    for (const mode of SECOND_REVIEW_MODES) expect(HowWeWorkStageSchema.safeParse(stage({ secondOpinion: mark(mode, true) })).success, mode).toBe(true);
    expect(HowWeWorkStageSchema.safeParse(stage({ secondOpinion: mark("maybe") })).success).toBe(false);
    expect(HowWeWorkStageSchema.safeParse(stage({ secondOpinion: { value: "on", source: "company", locked: true } })).success).toBe(false);
  });
});
