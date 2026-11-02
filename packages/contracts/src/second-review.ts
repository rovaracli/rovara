// Second review by a different AI company (setup-test-health design section 9, owner decision 9): an ADDED second opinion on a task's code from a model of another company than the one that
// wrote it. It runs in `shadow` first (the findings are recorded and shown on the task page as "second opinion", never block, never go on the pull request) and only later in `on` (its blocking
// findings block like the first review's: a code failure, send back). It is off by default, and `on` is reached only for a model that passed the replay check and the shadow acceptance below.
//
// This file is pure and browser-safe: names, fixed words, strict shapes and small pure functions. Nothing here carries a model's text except through the existing review report shape, which the
// task page renders as plain text like the first review's.
import { z } from "zod";
import { MODEL_COMPANIES } from "./models.js";
import { bedrockWithoutRegion } from "./models-node.js";
import { WorkflowReviewReportSchema } from "./task-workflow.js";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The setting: `review.otherCompany`
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The only providers a second review runs on (design 9.1 item 4): Amazon Bedrock, so the model call is on the customer's own Bedrock in Enterprise and on Rovara's in Public. A direct OpenAI, Google or other key is
 * not used for a second review, whatever the company's other model sources allow.
 */
export const SECOND_REVIEW_PROVIDERS: readonly string[] = ["amazon-bedrock"];
export const secondReviewProviderAllowed = (model: { provider: string }): boolean => SECOND_REVIEW_PROVIDERS.includes(model.provider.toLowerCase());

/** The tag a second review's operation record carries (`secondReview: true`) and its receipts' purpose. Every lookup that reads reviews of a task must leave such an operation out. */
export const SECOND_REVIEW_OPERATION_TAG = "second-review";
/** Whether an operation item is a second review's. */
export const isSecondReviewOperation = (item: { secondReview?: unknown }): boolean => item.secondReview === true;

/** Ordered from the least careful to the most careful: the order a company lock compares in. */
export const SECOND_REVIEW_MODES = ["off", "shadow", "on"] as const;
export const SecondReviewModeSchema = z.enum(SECOND_REVIEW_MODES);
export type SecondReviewMode = z.infer<typeof SecondReviewModeSchema>;

/** The project setting `review.otherCompany`: a mode, or absent (the company's default stands). */
export const SecondReviewProjectSettingSchema = z.object({ otherCompany: SecondReviewModeSchema }).strict();
/** The company's side: a default for projects that did not choose, and a lock (a floor) projects cannot go below. */
export const SecondReviewCompanySettingSchema = z.object({ default: SecondReviewModeSchema.optional(), lock: SecondReviewModeSchema.optional() }).strict();
export type SecondReviewProjectSetting = z.infer<typeof SecondReviewProjectSettingSchema>;
export type SecondReviewCompanySetting = z.infer<typeof SecondReviewCompanySettingSchema>;

/**
 * What a driving test or a verdict is about: the exact model REVISION, not the family. `canonicalModelName` drops a Bedrock revision on purpose (so a forbidden `nova-pro` covers every version), but a test or a
 * verdict on `amazon.nova-pro-v1:0` says nothing about `amazon.nova-pro-v2:0`. The key is the provider and the model id with a Bedrock geography dropped (`us.amazon.nova-pro-v1:0` and `eu.amazon.nova-pro-v1:0` are
 * the same model, v1 and v2 are not); any other provider's id is lower-cased as it is.
 */
export function secondReviewModelKey(model: { provider: string; modelId: string }): string {
  const provider = model.provider.toLowerCase();
  return `${provider}:${provider === "amazon-bedrock" ? bedrockWithoutRegion(model.modelId) : model.modelId.toLowerCase()}`;
}

const modeRank = (mode: SecondReviewMode): number => SECOND_REVIEW_MODES.indexOf(mode);

/** The more careful of two modes (a company lock is a floor: M8, stricter only). */
export const stricterSecondReviewMode = (left: SecondReviewMode, right: SecondReviewMode): SecondReviewMode => (modeRank(left) >= modeRank(right) ? left : right);

/**
 * Lowering needs a second person, like loosening a company lock (SH29): a project's `review.otherCompany` going from `on` to `shadow` or `off`, and a company lock going to any lower mode (or being removed).
 * Raising, and a project going from `off` to `shadow`, from `shadow` to `off`, or between the same modes, applies at once (it only observes, or only makes work more careful). The route that applies a change
 * asks this and, when true, takes it through `decideSecondPersonApproval` (and its sole-owner exception) before it writes.
 */
export const projectSecondReviewLoweringNeedsSecondPerson = (from: SecondReviewMode, to: SecondReviewMode): boolean => from === "on" && to !== "on";
export const lockSecondReviewLoweringNeedsSecondPerson = (from: SecondReviewMode | undefined, to: SecondReviewMode | undefined): boolean => modeRank(to ?? "off") < modeRank(from ?? "off");

/**
 * The mode a project is configured for: its own choice, else the company's default, else `off`; never below the company's lock. A lock never loosens a project, and a project's own choice never
 * goes under the lock. This is the CONFIGURED mode: `on` still needs a model that earned it (`SecondReviewVerdict`), and the install switch `cr` still has to be on.
 */
export function configuredSecondReviewMode(input: { project?: SecondReviewMode | undefined; companyDefault?: SecondReviewMode | undefined; companyLock?: SecondReviewMode | undefined }): SecondReviewMode {
  const chosen = input.project ?? input.companyDefault ?? "off";
  return stricterSecondReviewMode(chosen, input.companyLock ?? "off");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// What a second review leaves on the task: the second opinion
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Why a second review did not run (fixed words, shown as such). */
export const SECOND_REVIEW_SKIP_REASONS = ["switch-off", "mode-off", "no-reference-model", "no-candidate", "untested"] as const;
export type SecondReviewSkipReason = (typeof SECOND_REVIEW_SKIP_REASONS)[number];

/**
 * The second opinion on one candidate of a task. `report` is the ordinary review report the worker wrote for the second reviewer's model; `mode` is the mode it RAN in (never the configured one:
 * a configured `on` that had no verified model ran in `shadow`, and says `downgraded`). `blocked` is whether it blocked; in `shadow` it is always false, and `wouldHaveBlocked` says what `on` would have done.
 * `unavailable` is set when the reviewer gave no answer (the report is FAILED, INTERRUPTED or UNKNOWN): the first review stands alone, and the task page says the second opinion did not run.
 */
/** Why a second opinion is unavailable (fixed words): the reviewer gave no answer, or its answer was not accepted. */
export const SECOND_OPINION_UNAVAILABLE_REASONS = ["no-answer", "wrong-role", "wrong-candidate", "wrong-model", "same-company", "budget", "not-run", "no-candidate"] as const;
export type SecondOpinionUnavailableReason = (typeof SECOND_OPINION_UNAVAILABLE_REASONS)[number];

export const SecondOpinionSchema = z.object({
  mode: z.enum(["shadow", "on"]),
  downgraded: z.literal("replay-not-passed").optional(),
  /** The company of the second reviewer's model, never `other`. Absent only when no model was ever chosen (`no-candidate`). */
  company: z.enum(MODEL_COMPANIES.filter((company) => company !== "other") as [string, ...string[]]).optional(),
  /** The accepted report; absent when the second review did not run or its answer was not accepted (then `unavailableReason` says why). */
  report: WorkflowReviewReportSchema.optional(),
  unavailableReason: z.enum(SECOND_OPINION_UNAVAILABLE_REASONS).optional(),
  blockingCount: z.number().int().min(0).max(20),
  blocked: z.boolean(),
  wouldHaveBlocked: z.boolean(),
  unavailable: z.boolean(),
}).strict().superRefine((opinion, context) => {
  if (opinion.mode === "shadow" && opinion.blocked) context.addIssue({ code: "custom", path: ["blocked"], message: "a shadow second opinion never blocks" });
  if (opinion.unavailable !== (opinion.report === undefined || opinion.unavailableReason !== undefined)) context.addIssue({ code: "custom", path: ["unavailable"], message: "unavailable exactly when there is no accepted answer" });
  if (!opinion.unavailable && opinion.company === undefined) context.addIssue({ code: "custom", path: ["company"], message: "an answered second opinion names the company of its model" });
  if (opinion.unavailable && (opinion.blocked || opinion.wouldHaveBlocked || opinion.blockingCount > 0)) context.addIssue({ code: "custom", path: ["blocked"], message: "an unavailable second opinion has no findings and blocks nothing" });
  if (opinion.blocked && !opinion.wouldHaveBlocked) context.addIssue({ code: "custom", path: ["blocked"], message: "a second opinion that blocked would have blocked" });
});
export type SecondOpinion = z.infer<typeof SecondOpinionSchema>;

/**
 * The words after "Second review did not run: " for each reason (owner decision, 2026-11-02, "Retry, then flag"). Fixed text, never a model's: it goes on the task page and, for `on`, on the pull request.
 */
export const SECOND_OPINION_UNAVAILABLE_TEXT: Readonly<Record<SecondOpinionUnavailableReason, string>> = {
  "no-answer": "the reviewer gave no usable answer after retrying",
  "wrong-role": "the answer was not the code review's",
  "wrong-candidate": "the answer was for other code than the current change",
  "wrong-model": "the answer came from a model other than the one planned",
  "same-company": "the model that answered is not from a different AI company",
  "budget": "there was not enough budget left",
  "not-run": "it had already run for this change",
  "no-candidate": "no allowed model from a different AI company could be used",
};
export const secondReviewDidNotRunLine = (reason: SecondOpinionUnavailableReason): string => `Second review did not run: ${SECOND_OPINION_UNAVAILABLE_TEXT[reason]}`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The replay check (section 9.2). The quality suite (a manual run) fills one case per past task or planted diff; this file defines the fields and the bar.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The starting numbers of section 9.2, for the owner to adjust (change them here, in one place): 30+ past tasks with a known defect and 20+ planted-bug diffs; the candidate catches at least 80% of what
 * the current reviewer catches; it adds a real catch on at least 1 task in 10; its blocking findings that humans would dismiss stay under 1 per 5 tasks; then 2 weeks of shadow with more than 30% of
 * its findings accepted.
 */
export const SECOND_REVIEW_BAR = {
  minKnownDefects: 30,
  minPlantedBugs: 20,
  /** As a share out of 10: 8 is 80%. */
  catchShareTenths: 8,
  /** One real extra catch per this many tasks. */
  extraCatchEveryTasks: 10,
  /** Dismissed blocking findings must stay UNDER one per this many tasks. */
  dismissedUnderOnePerTasks: 5,
  shadowDays: 14,
  /** Agreed findings must be MORE than this many in 10 (3 is 30%). */
  shadowAgreedOverTenths: 3,
} as const;

export const SECOND_REVIEW_REPLAY_CASES_MAX = 400;

/** One past task or planted diff, run through the current reviewer (the baseline) and through the candidate. Counts and flags only: no model text. */
export const SecondReviewReplayCaseSchema = z.object({
  caseId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  kind: z.enum(["known_defect", "planted_bug"]),
  baselineCaught: z.boolean(),
  candidateCaught: z.boolean(),
  /** Blocking findings the candidate raised on this case, and how many of them a human would dismiss (they are not the defect). */
  candidateBlockingFindings: z.number().int().min(0).max(20),
  candidateDismissedBlocking: z.number().int().min(0).max(20),
}).strict().refine((entry) => entry.candidateDismissedBlocking <= entry.candidateBlockingFindings, { message: "dismissed findings are a part of the blocking ones", path: ["candidateDismissedBlocking"] });
export type SecondReviewReplayCase = z.infer<typeof SecondReviewReplayCaseSchema>;

/** One replay run: the candidate and baseline models, when it ran and its cases. Fields for the quality suite to write; the broker only reads the verdict. */
export const SecondReviewReplayRunSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  ranAt: z.string().datetime(),
  candidate: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict(),
  baseline: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict(),
  cases: z.array(SecondReviewReplayCaseSchema).max(SECOND_REVIEW_REPLAY_CASES_MAX),
}).strict().refine((run) => new Set(run.cases.map((entry) => entry.caseId)).size === run.cases.length, { message: "a case appears twice", path: ["cases"] });
export type SecondReviewReplayRun = z.infer<typeof SecondReviewReplayRunSchema>;

export const SECOND_REVIEW_REPLAY_FAILURES = ["too-few-known-defects", "too-few-planted-bugs", "baseline-caught-nothing", "catch-share-low", "few-extra-catches", "too-many-dismissed"] as const;
export type SecondReviewReplayFailure = (typeof SECOND_REVIEW_REPLAY_FAILURES)[number];

export interface SecondReviewReplaySummary {
  tasks: number;
  knownDefects: number;
  plantedBugs: number;
  baselineCaught: number;
  /** Cases the baseline caught and the candidate caught too. */
  bothCaught: number;
  /** Cases the candidate caught and the baseline missed: real adds. */
  extraCatches: number;
  dismissedBlocking: number;
  passed: boolean;
  failures: SecondReviewReplayFailure[];
}

/** Scores a replay run against the bar. Integer arithmetic only (no rounding to argue about); a run that does not meet every part of the bar does not pass, and says which parts. */
export function summarizeSecondReviewReplay(cases: readonly SecondReviewReplayCase[]): SecondReviewReplaySummary {
  const knownDefects = cases.filter((entry) => entry.kind === "known_defect").length;
  const plantedBugs = cases.filter((entry) => entry.kind === "planted_bug").length;
  const baselineCaught = cases.filter((entry) => entry.baselineCaught).length;
  const bothCaught = cases.filter((entry) => entry.baselineCaught && entry.candidateCaught).length;
  const extraCatches = cases.filter((entry) => !entry.baselineCaught && entry.candidateCaught).length;
  const dismissedBlocking = cases.reduce((total, entry) => total + entry.candidateDismissedBlocking, 0);
  const tasks = cases.length;
  const failures: SecondReviewReplayFailure[] = [];
  if (knownDefects < SECOND_REVIEW_BAR.minKnownDefects) failures.push("too-few-known-defects");
  if (plantedBugs < SECOND_REVIEW_BAR.minPlantedBugs) failures.push("too-few-planted-bugs");
  if (baselineCaught === 0) failures.push("baseline-caught-nothing");
  else if (bothCaught * 10 < baselineCaught * SECOND_REVIEW_BAR.catchShareTenths) failures.push("catch-share-low");
  if (tasks === 0 || extraCatches * SECOND_REVIEW_BAR.extraCatchEveryTasks < tasks) failures.push("few-extra-catches");
  if (tasks > 0 && dismissedBlocking * SECOND_REVIEW_BAR.dismissedUnderOnePerTasks >= tasks) failures.push("too-many-dismissed");
  return { tasks, knownDefects, plantedBugs, baselineCaught, bothCaught, extraCatches, dismissedBlocking, passed: failures.length === 0, failures };
}

/**
 * The shadow phase: at least 2 weeks of live tasks, with more than 30% of the second opinion's findings AGREED WITH or FIXED by people. `agreed` is its own count (a person marked the finding right, or the next
 * round fixed what it named); it is NOT the owner's accepted-risk list (`AcceptedFindingRef`), which means "ship it anyway" and is the opposite signal.
 */
export const SecondReviewShadowResultSchema = z.object({
  days: z.number().int().min(0).max(3650),
  findings: z.number().int().min(0).max(1_000_000),
  agreed: z.number().int().min(0).max(1_000_000),
}).strict().refine((result) => result.agreed <= result.findings, { message: "agreed findings are a part of the findings", path: ["agreed"] });
export type SecondReviewShadowResult = z.infer<typeof SecondReviewShadowResultSchema>;

export function secondReviewShadowPassed(result: SecondReviewShadowResult): boolean {
  return result.days >= SECOND_REVIEW_BAR.shadowDays && result.findings > 0 && result.agreed * 10 > result.findings * SECOND_REVIEW_BAR.shadowAgreedOverTenths;
}

/**
 * The evidence that lets a model run in `on`. It holds NO verdict flag: whether the replay check passed and whether the shadow phase passed are recomputed by the broker every time, from the stored replay run
 * (`summarizeSecondReviewReplay`) and the shadow window's timestamps and counts (`secondReviewVerdictHolds`). No route writes a pass; a record is created only by Rovara staff in Public or by the install in
 * Enterprise (never by a project), and an admin can only WITHDRAW it (`withdrawnAt`).
 */
export const SecondReviewVerdictSchema = z.object({
  /** `secondReviewModelKey` of the candidate: the exact revision, so a verdict on v1 never covers v2. */
  model: z.string().min(1).max(256),
  /** The stored replay run this verdict rests on, and the baseline reviewer it was compared with. */
  replayRunId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  baseline: z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict(),
  /** The shadow window (it must start after the replay run) and what it counted. */
  shadow: z.object({ startedAt: z.string().datetime(), endedAt: z.string().datetime(), findings: z.number().int().min(0).max(1_000_000), agreed: z.number().int().min(0).max(1_000_000) }).strict()
    .refine((window) => window.agreed <= window.findings, { message: "agreed findings are a part of the findings", path: ["agreed"] }),
  createdAt: z.string().datetime(),
  /** Who recorded it: a Rovara staff member (Public) or the install (Enterprise); never a project member. */
  createdBy: z.string().min(1).max(128),
  withdrawnAt: z.string().datetime().optional(),
  withdrawnBy: z.string().min(1).max(128).optional(),
}).strict().refine((verdict) => (verdict.withdrawnAt === undefined) === (verdict.withdrawnBy === undefined), { message: "withdrawnAt and withdrawnBy go together", path: ["withdrawnBy"] });
export type SecondReviewVerdict = z.infer<typeof SecondReviewVerdictSchema>;

const DAY_MS = 86_400_000;
const sameModelRef = (left: { provider: string; modelId: string }, right: { provider: string; modelId: string }): boolean => left.provider.toLowerCase() === right.provider.toLowerCase() && left.modelId.toLowerCase() === right.modelId.toLowerCase();

/**
 * Whether a verdict lets its model run in `on` NOW: not withdrawn; the replay run it names is the one given, ran this model against this baseline, and PASSES the bar when scored afresh; the shadow window
 * starts after that run, lasts the bar's days, and its counts clear the bar's share. Anything unreadable or missing is false.
 */
export function secondReviewVerdictHolds(verdict: SecondReviewVerdict, run: SecondReviewReplayRun | undefined): boolean {
  if (verdict.withdrawnAt !== undefined || run === undefined || run.runId !== verdict.replayRunId) return false;
  if (secondReviewModelKey(run.candidate) !== verdict.model || !sameModelRef(run.baseline, verdict.baseline)) return false;
  if (!summarizeSecondReviewReplay(run.cases).passed) return false;
  const started = Date.parse(verdict.shadow.startedAt);
  const ended = Date.parse(verdict.shadow.endedAt);
  const replayed = Date.parse(run.ranAt);
  if ([started, ended, replayed].some(Number.isNaN) || started <= replayed || ended < started) return false;
  return secondReviewShadowPassed({ days: Math.floor((ended - started) / DAY_MS), findings: verdict.shadow.findings, agreed: verdict.shadow.agreed });
}
