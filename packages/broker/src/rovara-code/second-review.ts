// Second review by a different AI company (setup-test-health design section 9; owner decision 9, 2026-11-01): an ADDED second opinion on a task's code from a model of another company than the one
// that wrote it, in `shadow` (recorded and shown on the task page as "second opinion", never blocking, never on the pull request) and then `on` (its blocking findings block like the first review's:
// a code failure, send back). This is the one place the choice and the verdict are made, over values the caller gives it (the recorded models, what the account can serve, the driving tests, the
// verdicts); it reads nothing and calls no model. The install switch is `cr` (second-review-switch.ts): off, nothing is planned.
//
// What this relies on (do not weaken): `modelCompany` reads a Bedrock id's maker with or without a geography (`openai.gpt-oss` over Bedrock is OpenAI, as `gpt-5` is), and a model it cannot place is `other`,
// which never counts as different (`differentCompany`). The forbidden-model check is `forbiddenModelMatcher` through the critic's `candidatesOf`, which refuses an unrecognised Bedrock id whenever
// anything is forbidden and matches by `canonicalModelName`, so another route to a forbidden model is forbidden too.
import {
  SECOND_REVIEW_OPERATION_TAG, SecondOpinionSchema, blockingFindings, canonicalModelName, modelCompany, secondReviewModelKey, secondReviewProviderAllowed, secondReviewVerdictHolds,
  type AcceptedFindingRef, type ModelCompany, type ModelIdentifier, type ModelSelection, type SecondOpinion, type SecondOpinionUnavailableReason, type SecondReviewMode, type SecondReviewReplayRun,
  type SecondReviewSkipReason, type SecondReviewVerdict, type WorkflowReviewReport,
} from "@agentx/contracts";
import { differentCompany } from "../agents/dispatch.js";
import { inertLine } from "./inert-text.js";
import { candidatesOf, type CriticModelLimits } from "./critic.js";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The driving test gate
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One model's last driving test, as the model checks record it (`readModelTests`), tagged with the provider whose route it was run on. */
export interface DrivingTestRecord {
  provider: string;
  modelId: string;
  outcome: "passed" | "failed";
  testedAt: string;
}

/**
 * The gate for "a model that has not passed the driving test is refused": a model passes only when the LATEST test on record for its provider and exact revision (`secondReviewModelKey`) passed. A model never
 * tested, a model whose last test failed, a test of another revision (v1 does not cover v2), and a model of a provider with no record are all refused. A geography (`eu.amazon.nova-pro-v1:0`) is the same
 * model. "Latest" compares the times as times (not as text), an unreadable time is older than any readable one, and on a tie a failed result wins.
 */
export function drivingTestGate(records: readonly DrivingTestRecord[]): (model: ModelIdentifier) => boolean {
  const timeOf = (record: DrivingTestRecord): number => { const at = Date.parse(record.testedAt); return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at; };
  const latest = new Map<string, DrivingTestRecord>();
  for (const record of records) {
    const key = secondReviewModelKey(record);
    const seen = latest.get(key);
    if (seen === undefined || timeOf(record) > timeOf(seen) || (timeOf(record) === timeOf(seen) && record.outcome === "failed")) latest.set(key, record);
  }
  return (model) => latest.get(secondReviewModelKey(model))?.outcome === "passed";
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The plan: whether a second review runs, in which mode, on which model
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Amazon's own models come first (owner decision 9: Nova Pro or Premier first), in this order, by canonical name. Everything else keeps the critic's capability order after them. */
export const SECOND_REVIEW_PREFERRED_MODELS: readonly string[] = ["nova-premier", "nova-pro"];

export interface SecondReviewPlanInput {
  /** The install switch `cr`. */
  switchOn: boolean;
  /** The CONFIGURED mode (`configuredSecondReviewMode`: project, company default, company lock). */
  mode: SecondReviewMode;
  /** The recorded models the second reviewer must differ in company from (`againstModels`: every build operation's and the first reviewer's). Empty: nothing can be shown to differ, so nothing runs. */
  against: readonly ModelIdentifier[];
  project: { approved?: readonly ModelIdentifier[] | undefined };
  forbidden: CriticModelLimits["forbidden"];
  /** The models the project's sources can serve for this org (empty when that is not known: the approved list stands in). */
  sources: readonly ModelIdentifier[];
  /** Models an earlier try of this task's second review found the account could not use (`secondReviewModelUnusable`). */
  unusable?: readonly ModelIdentifier[] | undefined;
  /** `drivingTestGate` over the driving tests on record. */
  drivingTestPassed: (model: ModelIdentifier) => boolean;
  /** The evidence on record and the replay runs it names: `on` is allowed for a model only while `secondReviewVerdictHolds` for one of them (recomputed here, never read as a stored pass). */
  verdicts: readonly SecondReviewVerdict[];
  replayRuns: readonly SecondReviewReplayRun[];
}

/** What the operation that runs the second review must be started with: its tag (every review lookup leaves it out) and the proxy's model fallback OFF (the model that answers must be the planned one). */
export const SECOND_REVIEW_OPERATION = { tag: SECOND_REVIEW_OPERATION_TAG, modelFallback: "off" } as const;

export type SecondReviewPlan =
  | { run: false; reason: SecondReviewSkipReason }
  | { run: true; mode: "shadow" | "on"; model: ModelSelection; company: Exclude<ModelCompany, "other">; downgraded?: "replay-not-passed"; against: readonly ModelIdentifier[]; operation: typeof SECOND_REVIEW_OPERATION };

const preferenceOf = (model: ModelIdentifier): number => {
  const name = canonicalModelName(model);
  const found = SECOND_REVIEW_PREFERRED_MODELS.findIndex((preferred) => name === preferred || name.startsWith(`${preferred}-`));
  return found < 0 ? SECOND_REVIEW_PREFERRED_MODELS.length : found;
};

const selectionOf = (model: ModelIdentifier): ModelSelection => ({ provider: model.provider, modelId: model.modelId });

/** Whether the evidence on record lets `model` run in `on` NOW: a verdict for its exact revision that still holds against the replay run it names. */
const verified = (input: Pick<SecondReviewPlanInput, "verdicts" | "replayRuns">, model: ModelIdentifier): boolean => {
  const key = secondReviewModelKey(model);
  return input.verdicts.some((verdict) => verdict.model === key && secondReviewVerdictHolds(verdict, input.replayRuns.find((run) => run.runId === verdict.replayRunId)));
};

/**
 * Whether a second review runs for a task's code, and on which model. It never throws and never picks a model by accident: every refusal is a fixed word.
 * - The switch off, or the configured mode `off`: nothing runs.
 * - The model must be on Amazon Bedrock (`SECOND_REVIEW_PROVIDERS`: a direct OpenAI or Google key is refused), allowed (approved list, not forbidden, not found unusable), from a known company that differs from
 *   EVERY model in `against`, and must have passed the driving test for its exact revision.
 * - Configured `shadow` runs in shadow. Configured `on` runs in `on` only on a model whose evidence still holds; with none it runs in shadow and says `downgraded: "replay-not-passed"`, so a company that set `on`
 *   before the evidence is in is never blocked by an unproven reviewer.
 */
export function planSecondReview(input: SecondReviewPlanInput): SecondReviewPlan {
  if (!input.switchOn) return { run: false, reason: "switch-off" };
  if (input.mode === "off") return { run: false, reason: "mode-off" };
  if (input.against.length === 0) return { run: false, reason: "no-reference-model" };
  const limits: CriticModelLimits = { approved: input.project.approved, forbidden: input.forbidden, unusable: input.unusable };
  const different = candidatesOf(limits, input.sources).filter((model) => secondReviewProviderAllowed(model) && input.against.every((other) => differentCompany(model, other)));
  if (different.length === 0) return { run: false, reason: "no-candidate" };
  // Stable: models with the same preference keep the critic's strongest-first order.
  const tested = different.filter(input.drivingTestPassed).map((model, index) => ({ model, index })).sort((left, right) => preferenceOf(left.model) - preferenceOf(right.model) || left.index - right.index).map((entry) => entry.model);
  if (tested.length === 0) return { run: false, reason: "untested" };
  const company = (model: ModelIdentifier): Exclude<ModelCompany, "other"> => modelCompany(model) as Exclude<ModelCompany, "other">;
  const common = { against: [...input.against], operation: SECOND_REVIEW_OPERATION };
  if (input.mode === "on") {
    const proven = tested.find((model) => verified(input, model));
    if (proven !== undefined) return { run: true, mode: "on", model: selectionOf(proven), company: company(proven), ...common };
    return { run: true, mode: "shadow", model: selectionOf(tested[0]!), company: company(tested[0]!), downgraded: "replay-not-passed", ...common };
  }
  return { run: true, mode: "shadow", model: selectionOf(tested[0]!), company: company(tested[0]!), ...common };
}

/**
 * The models the second reviewer must differ in company from: the ran model of EVERY build operation in EVERY round of the task, and the first reviewer's ran model. A model nobody recorded is unknown, and an
 * unknown model can never be shown to differ, so one missing makes the list undefined (the caller plans nothing: `no-reference-model`).
 */
export function againstModels(input: { buildRanModels: ReadonlyArray<ModelIdentifier | undefined>; firstReviewerRan: ModelIdentifier | undefined }): ModelIdentifier[] | undefined {
  if (input.buildRanModels.length === 0 || input.firstReviewerRan === undefined || input.buildRanModels.some((model) => model === undefined)) return undefined;
  const all = [...input.buildRanModels as ModelIdentifier[], input.firstReviewerRan];
  const seen = new Set<string>();
  return all.filter((model) => { const key = `${model.provider.toLowerCase()}\0${model.modelId.toLowerCase()}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * Whether a second review's report says its model could not serve this account, so the next try leaves that model out: a refused key, a model not found or not in the catalog, a 402, `MODEL_NOT_ALLOWED`, a model
 * the install does not serve. NOT `request-rejected` and NOT `unknown`: a request the provider refused includes a prompt over the model's context length (a long diff on a model with a small window), which says
 * nothing about whether the account can use the model, and the first review's rule would wrongly retire it.
 */
export function secondReviewModelUnusable(report: Pick<WorkflowReviewReport, "modelFailure">): boolean {
  const failure = report.modelFailure;
  if (failure === undefined) return false;
  return /\bthe model call failed: (?:key-rejected|model-not-found|not-in-catalog)\b/u.test(failure)
    || /\bthe model call failed: [a-z-]+(?: [A-Za-z0-9_]+)? HTTP 402\b/u.test(failure)
    || /^MODEL_NOT_ALLOWED:/u.test(failure)
    || /\bis not available on this install\b/u.test(failure);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The opinion: what a finished second review means
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** What the broker knows about the report it received, to decide whether to accept it. */
export interface SecondReportCheck {
  plan: Extract<SecondReviewPlan, { run: true }>;
  report: WorkflowReviewReport;
  /** The digest of the candidate the task has NOW. */
  currentCandidateDigest: string | undefined;
  /** The model the operation actually ran on (the operation record's `ranModel`), not the one planned. */
  ranModel: ModelIdentifier | undefined;
}

/**
 * Accepts a second report only when ALL hold: it is the code review's (CRITIC), it is about the current candidate, and the model that actually answered has the planned model's name and revision and is still a
 * different company from everything in `against`. Anything else is not accepted, and the second opinion is unavailable with the reason. (The operation also ran with the proxy's model fallback off, so a
 * substitute is not expected; this is the check that does not take the worker's word for it.)
 */
export function acceptSecondReport(input: SecondReportCheck): { accepted: true } | { accepted: false; reason: Extract<SecondOpinionUnavailableReason, "wrong-role" | "wrong-candidate" | "wrong-model" | "same-company"> } {
  if (input.report.role !== "CRITIC") return { accepted: false, reason: "wrong-role" };
  if (input.currentCandidateDigest === undefined || input.report.candidateDigest !== input.currentCandidateDigest) return { accepted: false, reason: "wrong-candidate" };
  const ran = input.ranModel;
  if (ran === undefined || secondReviewModelKey(ran) !== secondReviewModelKey(input.plan.model)) return { accepted: false, reason: "wrong-model" };
  if (!input.plan.against.every((other) => differentCompany(ran, other))) return { accepted: false, reason: "same-company" };
  return { accepted: true };
}

export interface SecondOpinionInput extends SecondReportCheck {
  /** The owner's accepted-risk findings for this candidate: a finding the owner accepted never blocks. (NOT the shadow phase's `agreed` count.) */
  accepted?: readonly AcceptedFindingRef[] | undefined;
}

/**
 * The second opinion on one candidate. In `shadow` it never blocks; `wouldHaveBlocked` records what `on` would have done, which is what the shadow phase counts. In `on` its blocking findings (the ones the change
 * introduced and that are not advisory, as for the first review) block. A report that is not accepted (`acceptSecondReport`), or that gave no answer (FAILED, INTERRUPTED or UNKNOWN), is UNAVAILABLE: it carries
 * no findings, and `secondReviewBlocksWhenUnavailable` says what that means for `on` (today: nothing blocks).
 */
export function secondOpinionOf(input: SecondOpinionInput): SecondOpinion {
  const check = acceptSecondReport(input);
  if (!check.accepted) return secondOpinionUnavailable(input.plan, check.reason);
  if (input.report.status !== "PASS" && input.report.status !== "FINDINGS") return secondOpinionUnavailable(input.plan, "no-answer", input.report);
  const blocking = blockingFindings(input.report, input.accepted);
  const wouldHaveBlocked = blocking.length > 0;
  return SecondOpinionSchema.parse({
    mode: input.plan.mode,
    ...(input.plan.downgraded === undefined ? {} : { downgraded: input.plan.downgraded }),
    company: input.plan.company,
    report: input.report,
    blockingCount: Math.min(blocking.length, 20),
    blocked: input.plan.mode === "on" && wouldHaveBlocked,
    wouldHaveBlocked,
    unavailable: false,
  });
}

/** An unavailable second opinion: no findings, nothing blocked. `report` is kept only for `no-answer` (the failed report says why, for the page); any other reason drops it, since it was not accepted. */
export function secondOpinionUnavailable(plan: Pick<Extract<SecondReviewPlan, { run: true }>, "mode" | "company" | "downgraded">, reason: SecondOpinionUnavailableReason, report?: WorkflowReviewReport): SecondOpinion {
  return SecondOpinionSchema.parse({
    mode: plan.mode, ...(plan.downgraded === undefined ? {} : { downgraded: plan.downgraded }), company: plan.company,
    ...(report !== undefined && reason === "no-answer" ? { report } : {}), unavailableReason: reason,
    blockingCount: 0, blocked: false, wouldHaveBlocked: false, unavailable: true,
  });
}

/**
 * OWNER DECISION PENDING: what `on` does when the second review cannot run (no answer, or no candidate because the project's approved list leaves none). Today's behaviour, kept in this one function: it does
 * not block. When the owner decides, change it here, and the wiring that sends work back reads only this.
 */
export function secondReviewBlocksWhenUnavailable(input: { mode: SecondReviewMode; reason: SecondOpinionUnavailableReason | SecondReviewSkipReason }): boolean {
  void input; // the owner's decision will read these
  return false;
}

/** Where a second opinion may be shown: always on the task page; on the pull request only when it blocked (a shadow opinion is never on the pull request). Not shown on the PR for an unavailable one (owner decision pending). */
export function secondOpinionShownOn(opinion: Pick<SecondOpinion, "mode" | "blocked">): { taskPage: true; pullRequest: boolean } {
  return { taskPage: true, pullRequest: opinion.mode === "on" && opinion.blocked };
}

/** The most findings and characters a second opinion puts on a pull request. */
export const SECOND_OPINION_PR_FINDINGS_MAX = 5;
export const SECOND_OPINION_PR_LINE_MAX = 300;

/**
 * The lines a second opinion adds to a pull request description, or none when it is not shown there (`secondOpinionShownOn`). Everything the model wrote is UNTRUSTED text and goes through the same
 * `inertLine` as the first review's: redacted, control characters gone, `@` broken so nobody is mentioned, links reduced to text, no image, no HTML comment, issue words neutralised. The model's name is a
 * report string and is made inert too.
 */
export function secondOpinionPrLines(opinion: SecondOpinion): string[] {
  if (!secondOpinionShownOn(opinion).pullRequest || opinion.report === undefined) return [];
  const blocking = blockingFindings(opinion.report);
  return [
    `Second review (${inertLine(`${opinion.report.provider}/${opinion.report.version}`, 80)}): ${String(blocking.length)} blocking ${blocking.length === 1 ? "finding" : "findings"}`,
    ...blocking.slice(0, SECOND_OPINION_PR_FINDINGS_MAX).map((finding) => `- ${inertLine(finding.text, SECOND_OPINION_PR_LINE_MAX)}${finding.file === undefined ? "" : ` (${inertLine(finding.file, 120)}${finding.line === undefined ? "" : `:${String(finding.line)}`})`}`),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Cost and admission
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A catalog price per million tokens. */
export interface SecondReviewPrice { inputUsdPerMTok: number; outputUsdPerMTok: number }

/** The most one second review is estimated to cost, from the catalog's price and the largest request it may make. No prompt caching is assumed (a model on Bedrock may not support it), so the estimate is the full input price. */
export function estimateSecondReviewUsd(price: SecondReviewPrice, tokens: { input: number; maxOutput: number }): number {
  return (tokens.input * price.inputUsdPerMTok + tokens.maxOutput * price.outputUsdPerMTok) / 1_000_000;
}

export type SecondReviewAdmission = { admit: true } | { admit: false; reason: Extract<SecondOpinionUnavailableReason, "budget" | "not-run"> };

/**
 * Whether the second review is admitted, by the same rules as the first review (the wiring gives the first review's own answers: the payer and its budget floor in Public, the spend ledger in Enterprise).
 * `roomUsd` is what the payer has left above the floor. A second review the payer cannot afford is not run: in `shadow` it is skipped with the reason `budget`; in `on` it is unavailable for the same reason
 * (`secondReviewBlocksWhenUnavailable` decides what that means). It runs at most once per candidate per round (`alreadyRan`), and never when the first review did not run.
 */
export function admitSecondReview(input: { mode: "shadow" | "on"; estimateUsd: number; roomUsd: number; alreadyRan: boolean }): SecondReviewAdmission {
  if (input.alreadyRan) return { admit: false, reason: "not-run" };
  if (!Number.isFinite(input.estimateUsd) || !Number.isFinite(input.roomUsd) || input.estimateUsd > input.roomUsd) return { admit: false, reason: "budget" };
  return { admit: true };
}

/** Whether a second review already ran (or is running) for this candidate in this round: the operations of the task, by their tag. */
export function secondReviewAlreadyRan(operations: ReadonlyArray<{ secondReview?: unknown; candidateDigest?: unknown; round?: unknown }>, candidateDigest: string, round: number): boolean {
  return operations.some((item) => item.secondReview === true && item.candidateDigest === candidateDigest && item.round === round);
}
