// Second review by a different AI company (setup-test-health design section 9; owner decision 9, 2026-11-01): an ADDED second opinion on a task's code from a model of another company than the one
// that wrote it, in `shadow` (recorded and shown on the task page as "second opinion", never blocking, never on the pull request) and then `on` (its blocking findings block like the first review's:
// a code failure, send back). This is the one place the choice and the verdict are made, over values the caller gives it (the recorded models, what the account can serve, the driving tests, the
// verdicts); it reads nothing and calls no model. The install switch is `cr` (second-review-switch.ts): off, nothing is planned.
//
// What this relies on (do not weaken): `modelCompany` reads a Bedrock id's maker with or without a geography (`openai.gpt-oss` over Bedrock is OpenAI, as `gpt-5` is), and a model it cannot place is `other`,
// which never counts as different (`differentCompany`). The forbidden-model check is `forbiddenModelMatcher` through the critic's `candidatesOf`, which refuses an unrecognised Bedrock id whenever
// anything is forbidden and matches by `canonicalModelName`, so another route to a forbidden model is forbidden too.
import {
  SecondOpinionSchema, canonicalModelName, blockingFindings, modelCompany,
  type AcceptedFindingRef, type ModelCompany, type ModelIdentifier, type ModelSelection, type SecondOpinion, type SecondReviewMode, type SecondReviewSkipReason, type SecondReviewVerdict,
  type WorkflowReviewReport,
} from "@agentx/contracts";
import { differentCompany } from "../agents/dispatch.js";
import { candidatesOf, criticModelUnusable, type CriticModelLimits } from "./critic.js";

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
 * The gate for "a model that has not passed the driving test is refused": a model passes only when the LATEST test on record for its provider and canonical name passed. A model never tested, a model
 * whose last test failed, and a model of a provider with no record are all refused. The canonical name is used, not the exact id, because a geography prefix (`eu.amazon.nova-pro-v1:0`) is the same
 * model; the test says whether the model can follow the tool and output shape, which a geography does not change.
 */
export function drivingTestGate(records: readonly DrivingTestRecord[]): (model: ModelIdentifier) => boolean {
  const latest = new Map<string, DrivingTestRecord>();
  for (const record of records) {
    const key = `${record.provider.toLowerCase()}\0${canonicalModelName(record)}`;
    const seen = latest.get(key);
    if (seen === undefined || seen.testedAt < record.testedAt) latest.set(key, record);
  }
  return (model) => latest.get(`${model.provider.toLowerCase()}\0${canonicalModelName(model)}`)?.outcome === "passed";
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
  /** The recorded models the second reviewer must differ in company from: the build's, and the first review's. Empty: nothing can be shown to differ, so nothing runs. */
  against: readonly ModelIdentifier[];
  project: { approved?: readonly ModelIdentifier[] | undefined };
  forbidden: CriticModelLimits["forbidden"];
  /** The models the project's sources can serve for this org (empty when that is not known: the approved list stands in). */
  sources: readonly ModelIdentifier[];
  /** Models an earlier try of this task's second review found the account could not use (`secondReviewModelUnusable`). */
  unusable?: readonly ModelIdentifier[] | undefined;
  /** `drivingTestGate` over the driving tests on record. */
  drivingTestPassed: (model: ModelIdentifier) => boolean;
  /** The verdicts on record; `on` is allowed for a model only with a verdict that passed both the replay check and the shadow phase. */
  verdicts: readonly SecondReviewVerdict[];
}

export type SecondReviewPlan =
  | { run: false; reason: SecondReviewSkipReason }
  | { run: true; mode: "shadow" | "on"; model: ModelSelection; company: Exclude<ModelCompany, "other">; downgraded?: "replay-not-passed" };

const preferenceOf = (model: ModelIdentifier): number => {
  const name = canonicalModelName(model);
  const found = SECOND_REVIEW_PREFERRED_MODELS.findIndex((preferred) => name === preferred || name.startsWith(`${preferred}-`));
  return found < 0 ? SECOND_REVIEW_PREFERRED_MODELS.length : found;
};

const selectionOf = (model: ModelIdentifier): ModelSelection => ({ provider: model.provider, modelId: model.modelId });

/** Whether a verdict on record lets `model` run in `on`: the same canonical name, and both the replay check and the shadow phase passed. */
const verified = (verdicts: readonly SecondReviewVerdict[], model: ModelIdentifier): boolean => {
  const name = canonicalModelName(model);
  return verdicts.some((verdict) => verdict.model === name && verdict.replayPassed && verdict.shadowPassed);
};

/**
 * Whether a second review runs for a task's code, and on which model. It never throws and never picks a model by accident: every refusal is a fixed word.
 * - The switch off, or the configured mode `off`: nothing runs.
 * - The model must be allowed (approved list, not forbidden, not found unusable), from a known company that differs from EVERY model in `against`, and must have passed the driving test.
 * - Configured `shadow` runs in shadow. Configured `on` runs in `on` only on a model with a passing verdict; with none it runs in shadow and says `downgraded: "replay-not-passed"`, so a company that set
 *   `on` before the evidence is in is never blocked by an unproven reviewer.
 */
export function planSecondReview(input: SecondReviewPlanInput): SecondReviewPlan {
  if (!input.switchOn) return { run: false, reason: "switch-off" };
  if (input.mode === "off") return { run: false, reason: "mode-off" };
  if (input.against.length === 0) return { run: false, reason: "no-reference-model" };
  const limits: CriticModelLimits = { approved: input.project.approved, forbidden: input.forbidden, unusable: input.unusable };
  const different = candidatesOf(limits, input.sources).filter((model) => input.against.every((other) => differentCompany(model, other)));
  if (different.length === 0) return { run: false, reason: "no-candidate" };
  // Stable: models with the same preference keep the critic's strongest-first order.
  const tested = different.filter(input.drivingTestPassed).map((model, index) => ({ model, index })).sort((left, right) => preferenceOf(left.model) - preferenceOf(right.model) || left.index - right.index).map((entry) => entry.model);
  if (tested.length === 0) return { run: false, reason: "untested" };
  const company = (model: ModelIdentifier): Exclude<ModelCompany, "other"> => modelCompany(model) as Exclude<ModelCompany, "other">;
  if (input.mode === "on") {
    const proven = tested.find((model) => verified(input.verdicts, model));
    if (proven !== undefined) return { run: true, mode: "on", model: selectionOf(proven), company: company(proven) };
    return { run: true, mode: "shadow", model: selectionOf(tested[0]!), company: company(tested[0]!), downgraded: "replay-not-passed" };
  }
  return { run: true, mode: "shadow", model: selectionOf(tested[0]!), company: company(tested[0]!) };
}

/** Whether a second review's report says its model could not serve this account (the plan check's rule), so the next try leaves that model out. */
export const secondReviewModelUnusable = (report: Pick<WorkflowReviewReport, "modelFailure">): boolean => report.modelFailure !== undefined && criticModelUnusable(report.modelFailure);

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The opinion: what a finished second review means
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface SecondOpinionInput {
  /** The plan that ran (`planSecondReview` with `run: true`). */
  plan: Extract<SecondReviewPlan, { run: true }>;
  /** The worker's report for the second reviewer's model: an ordinary review report, untrusted text. */
  report: WorkflowReviewReport;
  /** The owner's accepted findings for this candidate: an accepted finding never blocks. */
  accepted?: readonly AcceptedFindingRef[] | undefined;
}

/**
 * The second opinion on one candidate. In `shadow` it never blocks; `wouldHaveBlocked` records what `on` would have done, which is what the shadow phase counts. In `on` its blocking findings (the ones the
 * change introduced and that are not advisory, as for the first review) block. A report with no answer (FAILED, INTERRUPTED or UNKNOWN) blocks nothing and is marked `unavailable`: the added opinion is
 * never a reason a task stops, and the page says it did not run.
 */
export function secondOpinionOf(input: SecondOpinionInput): SecondOpinion {
  const answered = input.report.status === "PASS" || input.report.status === "FINDINGS";
  const blocking = answered ? blockingFindings(input.report, input.accepted) : [];
  const wouldHaveBlocked = blocking.length > 0;
  return SecondOpinionSchema.parse({
    mode: input.plan.mode,
    ...(input.plan.downgraded === undefined ? {} : { downgraded: input.plan.downgraded }),
    company: input.plan.company,
    report: input.report,
    blockingCount: Math.min(blocking.length, 20),
    blocked: input.plan.mode === "on" && wouldHaveBlocked,
    wouldHaveBlocked,
    unavailable: !answered,
  });
}

/** Where a second opinion may be shown: always on the task page; on the pull request only when it blocked (a shadow opinion is never on the pull request). */
export function secondOpinionShownOn(opinion: Pick<SecondOpinion, "mode" | "blocked">): { taskPage: true; pullRequest: boolean } {
  return { taskPage: true, pullRequest: opinion.mode === "on" && opinion.blocked };
}
