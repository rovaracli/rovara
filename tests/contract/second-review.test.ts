// SH34: the second review by a different AI company. The setting (off, shadow, on; a company lock is a floor), which model may be the second reviewer (another known company than the build and the
// first review, allowed, not forbidden, past the driving test; Amazon Nova Premier or Pro first), when `on` is allowed (a passing verdict, else shadow), and what a finished second review means
// (shadow never blocks; on blocks; no answer blocks nothing). Also the replay check's fields and bar, which the quality suite fills.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HowWeWorkStageSchema, SECOND_REVIEW_BAR, SECOND_REVIEW_MODES, SecondOpinionSchema, SecondReviewReplayRunSchema, canonicalModelName, configuredSecondReviewMode, modelCompany, secondReviewShadowPassed, stricterSecondReviewMode,
  summarizeSecondReviewReplay, workflowFindingFingerprint, type ModelIdentifier, type SecondReviewReplayCase, type SecondReviewVerdict, type WorkflowReviewReport,
} from "@agentx/contracts";
import {
  drivingTestGate, planSecondReview, secondOpinionOf, secondOpinionShownOn, secondReviewModelUnusable, type DrivingTestRecord, type SecondReviewPlan, type SecondReviewPlanInput,
} from "../../packages/broker/src/rovara-code/second-review.js";

const SONNET: ModelIdentifier = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const OPUS: ModelIdentifier = { provider: "anthropic", modelId: "claude-opus-4-6" };
const GPT: ModelIdentifier = { provider: "openai", modelId: "gpt-5.5" };
const NOVA_PRO: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" };
const NOVA_PREMIER: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-premier-v1:0" };
const NOVA_LITE: ModelIdentifier = { provider: "amazon-bedrock", modelId: "us.amazon.nova-lite-v1:0" };
const BEDROCK_GPT_OSS: ModelIdentifier = { provider: "amazon-bedrock", modelId: "openai.gpt-oss-120b-1:0" };
const BEDROCK_GEMMA: ModelIdentifier = { provider: "amazon-bedrock", modelId: "google.gemma-3-27b-it" };
const GEMINI: ModelIdentifier = { provider: "openrouter", modelId: "google/gemini-3-pro" };
const UNKNOWN_MAKER: ModelIdentifier = { provider: "openrouter", modelId: "x-ai/grok-9" };

const passed = (...models: ModelIdentifier[]): ((model: ModelIdentifier) => boolean) =>
  drivingTestGate(models.map((model) => ({ provider: model.provider, modelId: model.modelId, outcome: "passed" as const, testedAt: "2026-11-01T00:00:00.000Z" })));

const plan = (overrides: Partial<SecondReviewPlanInput> = {}): SecondReviewPlan => planSecondReview({
  switchOn: true, mode: "shadow", against: [SONNET], project: {}, forbidden: [], sources: [SONNET, OPUS, GPT, NOVA_PRO, NOVA_PREMIER], drivingTestPassed: passed(GPT, NOVA_PRO, NOVA_PREMIER), verdicts: [], ...overrides,
});
const ran = (result: SecondReviewPlan) => (result.run ? { mode: result.mode, model: `${result.model.provider}/${result.model.modelId}`, company: result.company, downgraded: result.downgraded } : { skipped: result.reason });

const VERDICT = (model: ModelIdentifier, overrides: Partial<SecondReviewVerdict> = {}): SecondReviewVerdict => ({ model: canonicalModelName(model), replayPassed: true, shadowPassed: true, decidedAt: "2026-11-20T00:00:00.000Z", ...overrides });

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
});

describe("planSecondReview: which model", () => {
  it("puts Amazon Nova Premier first, then Nova Pro, ahead of a stronger-ranked model of another company", () => {
    expect(ran(plan())).toEqual({ mode: "shadow", model: "amazon-bedrock/us.amazon.nova-premier-v1:0", company: "amazon", downgraded: undefined });
    expect(ran(plan({ sources: [SONNET, GPT, NOVA_PRO], drivingTestPassed: passed(GPT, NOVA_PRO) }))).toMatchObject({ model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
    // Without a Nova model that passed, another company's model is next.
    expect(ran(plan({ drivingTestPassed: passed(GPT) }))).toMatchObject({ model: "openai/gpt-5.5", company: "openai" });
  });

  it("refuses a model that has not passed the driving test, or whose last driving test failed", () => {
    expect(ran(plan({ sources: [SONNET, NOVA_PRO], drivingTestPassed: passed() }))).toEqual({ skipped: "untested" });
    const records: DrivingTestRecord[] = [
      { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", outcome: "passed", testedAt: "2026-11-01T00:00:00.000Z" },
      { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0", outcome: "failed", testedAt: "2026-11-02T00:00:00.000Z" },
    ];
    expect(ran(plan({ sources: [SONNET, NOVA_PRO], drivingTestPassed: drivingTestGate(records) }))).toEqual({ skipped: "untested" });
  });

  it("the driving test gate reads the latest test per provider and canonical model name", () => {
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
    expect(ran(plan({ sources: [SONNET, OPUS], drivingTestPassed: passed(SONNET, OPUS) }))).toEqual({ skipped: "no-candidate" });
    expect(ran(plan({ sources: [SONNET, UNKNOWN_MAKER], drivingTestPassed: passed(UNKNOWN_MAKER) }))).toEqual({ skipped: "no-candidate" });
    expect(modelCompany(UNKNOWN_MAKER)).toBe("other");
  });

  it("a model must differ from the first review's company too", () => {
    // Build on Claude, first review on OpenAI: Nova is a third company, GPT is not.
    expect(ran(plan({ against: [SONNET, GPT] }))).toMatchObject({ model: "amazon-bedrock/us.amazon.nova-premier-v1:0" });
    expect(ran(plan({ against: [SONNET, GPT], sources: [SONNET, GPT], drivingTestPassed: passed(GPT) }))).toEqual({ skipped: "no-candidate" });
  });

  it("Bedrock's OpenAI and Google models are the same company as OpenAI and Google, not a different one", () => {
    expect(modelCompany(BEDROCK_GPT_OSS)).toBe("openai");
    // Built by OpenAI directly: the Bedrock OpenAI model is not another company.
    expect(ran(plan({ against: [GPT], sources: [GPT, BEDROCK_GPT_OSS], drivingTestPassed: passed(BEDROCK_GPT_OSS) }))).toEqual({ skipped: "no-candidate" });
    // Built on Bedrock's OpenAI model: OpenAI itself is not another company either.
    expect(ran(plan({ against: [BEDROCK_GPT_OSS], sources: [GPT, BEDROCK_GPT_OSS], drivingTestPassed: passed(GPT) }))).toEqual({ skipped: "no-candidate" });
    // Google: Bedrock's Gemma is never read as different from Gemini (it is not placed at all, and a model that is not placed never counts as different).
    expect(ran(plan({ against: [GEMINI], sources: [GEMINI, BEDROCK_GEMMA], drivingTestPassed: passed(BEDROCK_GEMMA) }))).toEqual({ skipped: "no-candidate" });
    expect(ran(plan({ against: [BEDROCK_GEMMA], sources: [BEDROCK_GEMMA, GEMINI], drivingTestPassed: passed(GEMINI) }))).toEqual({ skipped: "no-candidate" });
    // Another company's model on the same route still counts as different.
    expect(ran(plan({ against: [BEDROCK_GPT_OSS], sources: [SONNET, BEDROCK_GPT_OSS], drivingTestPassed: passed(SONNET) }))).toMatchObject({ company: "anthropic" });
  });

  it("never takes a forbidden model, by canonical name, whichever geography or route reaches it", () => {
    const forbidden: ModelIdentifier[] = [{ provider: "amazon-bedrock", modelId: "amazon.nova-premier-v1:0" }];
    expect(ran(plan({ forbidden, sources: [SONNET, NOVA_PREMIER, NOVA_PRO], drivingTestPassed: passed(NOVA_PREMIER, NOVA_PRO) }))).toMatchObject({ model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
    const jp: ModelIdentifier = { provider: "amazon-bedrock", modelId: "jp.amazon.nova-premier-v1:0" };
    const viaRouter: ModelIdentifier = { provider: "openrouter", modelId: "amazon/nova-premier-v1" };
    expect(ran(plan({ forbidden, sources: [SONNET, jp, viaRouter], drivingTestPassed: passed(jp, viaRouter) }))).toEqual({ skipped: "no-candidate" });
  });

  it("refuses an unrecognised Bedrock id whenever anything is forbidden", () => {
    const odd: ModelIdentifier = { provider: "amazon-bedrock", modelId: "zz.amazon.nova-pro-v1:0" };
    expect(ran(plan({ forbidden: [OPUS], sources: [SONNET, odd], drivingTestPassed: passed(odd) }))).toEqual({ skipped: "no-candidate" });
  });

  it("only takes a model the project approves, and leaves out one the account could not use", () => {
    expect(ran(plan({ project: { approved: [SONNET, GPT] } }))).toMatchObject({ model: "openai/gpt-5.5" });
    expect(ran(plan({ unusable: [NOVA_PREMIER, NOVA_PRO] }))).toMatchObject({ model: "openai/gpt-5.5" });
    expect(ran(plan({ project: { approved: [SONNET] } }))).toEqual({ skipped: "no-candidate" });
  });
});

describe("planSecondReview: when on is allowed", () => {
  it("configured on without a passing verdict runs in shadow and says why", () => {
    expect(ran(plan({ mode: "on" }))).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
    expect(ran(plan({ mode: "on", verdicts: [VERDICT(NOVA_PREMIER, { shadowPassed: false })] }))).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
    expect(ran(plan({ mode: "on", verdicts: [VERDICT(NOVA_PREMIER, { replayPassed: false })] }))).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed" });
  });

  it("a verdict for another model proves nothing for this one", () => {
    expect(ran(plan({ mode: "on", verdicts: [VERDICT(GPT)] }))).toMatchObject({ mode: "on", model: "openai/gpt-5.5" });
    expect(ran(plan({ mode: "on", drivingTestPassed: passed(NOVA_PRO), verdicts: [VERDICT(GPT)] }))).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed", model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
  });

  it("runs in on on the verified model, found by canonical name across geographies", () => {
    const verdicts = [VERDICT({ provider: "amazon-bedrock", modelId: "eu.amazon.nova-premier-v1:0" })];
    expect(ran(plan({ mode: "on", verdicts }))).toEqual({ mode: "on", model: "amazon-bedrock/us.amazon.nova-premier-v1:0", company: "amazon", downgraded: undefined });
  });

  it("a verified model that is untested is still refused", () => {
    expect(ran(plan({ mode: "on", sources: [SONNET, NOVA_PREMIER], drivingTestPassed: passed(), verdicts: [VERDICT(NOVA_PREMIER)] }))).toEqual({ skipped: "untested" });
  });

  it("shadow stays shadow even for a verified model", () => {
    expect(ran(plan({ mode: "shadow", verdicts: [VERDICT(NOVA_PREMIER)] }))).toMatchObject({ mode: "shadow", downgraded: undefined });
  });
});

const digest = "a".repeat(64);
const report = (status: WorkflowReviewReport["status"], findings: WorkflowReviewReport["findings"] = [], extra: Partial<WorkflowReviewReport> = {}): WorkflowReviewReport => ({
  operationId: randomUUID(), candidateDigest: digest, role: "CRITIC", provider: "amazon-bedrock", version: "us.amazon.nova-premier-v1:0", status, findings, readOnly: true, recordedAt: "2026-11-02T12:00:00.000Z", ...extra,
});
const BLOCKING = { text: "off by one in the loop bound", origin: "INTRODUCED" as const };
const runPlan = (mode: "shadow" | "on", downgraded?: "replay-not-passed") => {
  const planned = plan({ mode: mode === "on" ? "on" : "shadow", verdicts: mode === "on" && downgraded === undefined ? [VERDICT(NOVA_PREMIER)] : [] });
  if (!planned.run) throw new Error("expected a plan");
  return planned;
};

describe("secondOpinionOf: what a finished second review means", () => {
  it("shadow never blocks, and records what on would have done", () => {
    const opinion = secondOpinionOf({ plan: runPlan("shadow"), report: report("FINDINGS", [BLOCKING]) });
    expect(opinion).toMatchObject({ mode: "shadow", blocked: false, wouldHaveBlocked: true, blockingCount: 1, unavailable: false, company: "amazon" });
  });

  it("on blocks on a finding the change introduced", () => {
    expect(secondOpinionOf({ plan: runPlan("on"), report: report("FINDINGS", [BLOCKING]) })).toMatchObject({ mode: "on", blocked: true, wouldHaveBlocked: true, blockingCount: 1 });
  });

  it("on does not block on a pass, an advisory or pre-existing finding, or one the owner accepted", () => {
    expect(secondOpinionOf({ plan: runPlan("on"), report: report("PASS") })).toMatchObject({ blocked: false, wouldHaveBlocked: false, blockingCount: 0 });
    const quiet = report("PASS", [{ text: "style nit", origin: "INTRODUCED", advisory: true }, { text: "old problem", origin: "PRE_EXISTING" }]);
    expect(secondOpinionOf({ plan: runPlan("on"), report: quiet })).toMatchObject({ blocked: false });
    const found = report("FINDINGS", [BLOCKING]);
    const accepted = [{ candidateDigest: digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: BLOCKING.text }) }];
    expect(secondOpinionOf({ plan: runPlan("on"), report: found, accepted })).toMatchObject({ blocked: false, wouldHaveBlocked: false });
    // An accepted finding is matched by its fingerprint: a made-up one does not match, so the finding still blocks.
    expect(secondOpinionOf({ plan: runPlan("on"), report: found, accepted: [{ ...accepted[0]!, fingerprint: "b".repeat(64) }] })).toMatchObject({ blocked: true });
  });

  it("a second review that gave no answer blocks nothing, in either mode, and says it did not run", () => {
    for (const status of ["FAILED", "INTERRUPTED", "UNKNOWN"] as const) {
      expect(secondOpinionOf({ plan: runPlan("on"), report: report(status) }), status).toMatchObject({ blocked: false, wouldHaveBlocked: false, unavailable: true });
      expect(secondOpinionOf({ plan: runPlan("shadow"), report: report(status) }), status).toMatchObject({ blocked: false, unavailable: true });
    }
  });

  it("keeps the downgrade on the record", () => {
    const downgraded = plan({ mode: "on" });
    if (!downgraded.run) throw new Error("expected a plan");
    expect(secondOpinionOf({ plan: downgraded, report: report("FINDINGS", [BLOCKING]) })).toMatchObject({ mode: "shadow", downgraded: "replay-not-passed", blocked: false });
  });

  it("the record cannot say a shadow opinion blocked", () => {
    const good = secondOpinionOf({ plan: runPlan("shadow"), report: report("FINDINGS", [BLOCKING]) });
    expect(SecondOpinionSchema.safeParse({ ...good, blocked: true }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, company: "other" }).success).toBe(false);
    expect(SecondOpinionSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });

  it("shows a shadow opinion on the task page and never on the pull request; an on opinion that blocked on both", () => {
    expect(secondOpinionShownOn({ mode: "shadow", blocked: false })).toEqual({ taskPage: true, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "on", blocked: false })).toEqual({ taskPage: true, pullRequest: false });
    expect(secondOpinionShownOn({ mode: "on", blocked: true })).toEqual({ taskPage: true, pullRequest: true });
  });

  it("reads a model the account cannot use from the report, so the next try leaves it out", () => {
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: model-not-found" }))).toBe(true);
    expect(secondReviewModelUnusable(report("FAILED", [], { modelFailure: "the model call failed: rate-limited" }))).toBe(false);
    expect(secondReviewModelUnusable(report("PASS"))).toBe(false);
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

  it("the shadow phase needs two weeks and more than 30% of findings accepted", () => {
    expect(secondReviewShadowPassed({ days: 14, findings: 10, accepted: 4 })).toBe(true);
    expect(secondReviewShadowPassed({ days: 14, findings: 10, accepted: 3 })).toBe(false); // exactly 30% is not above 30%
    expect(secondReviewShadowPassed({ days: 13, findings: 10, accepted: 10 })).toBe(false);
    expect(secondReviewShadowPassed({ days: 30, findings: 0, accepted: 0 })).toBe(false);
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
