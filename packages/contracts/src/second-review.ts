// Second review by a different AI company (setup-test-health design section 9, owner decision 9): an ADDED second opinion on a task's code from a model of another company than the one that
// wrote it. It runs in `shadow` first (the findings are recorded and shown on the task page as "second opinion", never block, never go on the pull request) and only later in `on` (its blocking
// findings block like the first review's: a code failure, send back). It is off by default, and `on` is reached only for a model that passed the replay check and the shadow acceptance below.
//
// This file is pure and browser-safe: names, fixed words, strict shapes and small pure functions. Nothing here carries a model's text except through the existing review report shape, which the
// task page renders as plain text like the first review's.
import { z } from "zod";
import { MODEL_COMPANIES } from "./models.js";
import { WorkflowReviewReportSchema } from "./task-workflow.js";

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The setting: `review.otherCompany`
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

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

const modeRank = (mode: SecondReviewMode): number => SECOND_REVIEW_MODES.indexOf(mode);

/** The more careful of two modes (a company lock is a floor: M8, stricter only). */
export const stricterSecondReviewMode = (left: SecondReviewMode, right: SecondReviewMode): SecondReviewMode => (modeRank(left) >= modeRank(right) ? left : right);

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
export const SecondOpinionSchema = z.object({
  mode: z.enum(["shadow", "on"]),
  downgraded: z.literal("replay-not-passed").optional(),
  /** The company of the second reviewer's model, never `other`. */
  company: z.enum(MODEL_COMPANIES.filter((company) => company !== "other") as [string, ...string[]]),
  report: WorkflowReviewReportSchema,
  blockingCount: z.number().int().min(0).max(20),
  blocked: z.boolean(),
  wouldHaveBlocked: z.boolean(),
  unavailable: z.boolean(),
}).strict().superRefine((opinion, context) => {
  if (opinion.mode === "shadow" && opinion.blocked) context.addIssue({ code: "custom", path: ["blocked"], message: "a shadow second opinion never blocks" });
  if (opinion.blocked && !opinion.wouldHaveBlocked) context.addIssue({ code: "custom", path: ["blocked"], message: "a second opinion that blocked would have blocked" });
});
export type SecondOpinion = z.infer<typeof SecondOpinionSchema>;

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
  /** Accepted findings must be MORE than this many in 10 (3 is 30%). */
  shadowAcceptedOverTenths: 3,
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

/** The shadow phase: at least 2 weeks of live tasks, with more than 30% of the second opinion's findings accepted by people. */
export const SecondReviewShadowResultSchema = z.object({
  days: z.number().int().min(0).max(3650),
  findings: z.number().int().min(0).max(1_000_000),
  accepted: z.number().int().min(0).max(1_000_000),
}).strict().refine((result) => result.accepted <= result.findings, { message: "accepted findings are a part of the findings", path: ["accepted"] });
export type SecondReviewShadowResult = z.infer<typeof SecondReviewShadowResultSchema>;

export function secondReviewShadowPassed(result: SecondReviewShadowResult): boolean {
  return result.days >= SECOND_REVIEW_BAR.shadowDays && result.findings > 0 && result.accepted * 10 > result.findings * SECOND_REVIEW_BAR.shadowAcceptedOverTenths;
}

/**
 * What the broker reads to allow `on` for one model: the canonical name of the candidate (`canonicalModelName`) and the two results. `on` needs both; the quality suite and the shadow count write it,
 * a person (an admin) can withdraw it. A verdict for one model says nothing about another.
 */
export const SecondReviewVerdictSchema = z.object({
  /** `canonicalModelName` of the candidate. */
  model: z.string().min(1).max(256),
  replayPassed: z.boolean(),
  shadowPassed: z.boolean(),
  decidedAt: z.string().datetime(),
}).strict();
export type SecondReviewVerdict = z.infer<typeof SecondReviewVerdictSchema>;
