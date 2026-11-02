// Second review by another AI company (SH34): what the broker keeps on the TASK RECORD about it, and the writes that keep it. Nothing here touches the workflow snapshot: a second review is an ADDED opinion, so
// its operation's result never reaches `submitWorkflowReview`, `reviewCleared`, the latest-review-for-candidate lookup, the pull request's Reviews section or `requireCrossCompanyReview`. It lives beside the workflow
// (as `reviewSameModel` does), keyed by the candidate it is about.
import { redactText, type AcceptedFindingRef, SECOND_REVIEW_RESULT_KEY, SecondOpinionSchema, SecondReviewResultSchema, secondReviewDidNotRunLine, secondReviewedByLine, blockingFindings, type SecondOpinion, type SecondOpinionUnavailableReason, type SecondReviewChoice } from "@agentx/contracts";
import { z } from "zod";
import { secondReviewEnabled } from "./second-review-switch.js";
import { SECOND_REVIEW_OPERATION, mergeWaitsForSecondReview, secondOpinionOf, secondOpinionPrLines, secondOpinionShownOn, secondOpinionUnavailable, secondReviewAcknowledgement, type SecondReviewPlan } from "./second-review.js";

type RunPlan = Extract<SecondReviewPlan, { run: true }>;

/**
 * What the broker records on the REVIEW operation that carries a second reviewer (`operation.secondReviewPlan`): the candidate it is about and either the plan the worker was handed (models, mode, who it
 * must differ from, why this model) or the fixed reason no second review could be started (`notRun`: no candidate, the chosen model no longer qualifies, budget). The one REVIEW end reads it and nothing waits on it;
 * nothing is held (the second reviewer runs inside the operation, so there is no pending record on the task).
 */
export interface SecondReviewOperationPlan {
  candidateDigest: string;
  plan?: Pick<RunPlan, "mode" | "company" | "model" | "candidates" | "against" | "choice"> & { downgraded?: "replay-not-passed"; defaultChanged?: true };
  /** The proxy aliases the planned models are called by (the model proxy key may call these in addition to the review's own), and, for a routed model, the alias its report names as the model that ran (by model key). */
  aliases?: string[];
  routeAliases?: Record<string, string>;
  notRun?: { mode: "shadow" | "on"; reason: SecondOpinionUnavailableReason; choice?: SecondReviewChoice | undefined };
}

/** The second opinion of one candidate, as the task keeps it. */
export interface StoredSecondOpinion { candidateDigest: string; opinion: SecondOpinion; recordedAt: string }

const StoredSecondOpinionSchema = z.object({ candidateDigest: z.string().regex(/^[a-f0-9]{64}$/u), opinion: SecondOpinionSchema, recordedAt: z.string().datetime() }).strict();

/** The task's second opinion for the code it holds NOW, or none: an opinion about another candidate says nothing about this one, and one that does not parse is none. */
export function secondOpinionOfTask(task: { secondOpinion?: unknown }, candidateDigest: string | undefined): SecondOpinion | undefined {
  if (candidateDigest === undefined) return undefined;
  const parsed = StoredSecondOpinionSchema.safeParse(task.secondOpinion);
  return parsed.success && parsed.data.candidateDigest === candidateDigest ? parsed.data.opinion : undefined;
}

export interface SecondOpinionFromResultInput {
  /** `operation.secondReviewPlan`. */
  recorded: SecondReviewOperationPlan | undefined;
  operationId: string;
  /** The result of the REVIEW operation that ended (any status). */
  terminalStatus: string;
  result: unknown;
  /** The digest of the candidate the task holds now, and the findings the owner accepted as risks. */
  currentCandidateDigest: string | undefined;
  accepted?: readonly AcceptedFindingRef[] | undefined;
  now: string;
}

/**
 * The task's second opinion from the end of the REVIEW operation that carried the second reviewer: undefined when none was planned (and cr off, always). Anything but a clean answer is stored as UNAVAILABLE with a
 * fixed reason: a fixed `notRun` reason from the start; no `workflowSecondReview` key in a result that succeeded (the worker is older and never ran it: `older-worker`); an operation that did not succeed, a missing,
 * unreadable or failed report (`no-answer`); a report for another candidate, role or model, or from the same company as the code (`acceptSecondReport`). The findings the owner accepted as risks do not block.
 * It never touches the workflow: the caller stores it in the same single task Update as the workflow's own transition.
 */
export function secondOpinionFromReviewResult(input: SecondOpinionFromResultInput): StoredSecondOpinion | undefined {
  const recorded = input.recorded;
  if (recorded === undefined) return undefined;
  const store = (opinion: SecondOpinion): StoredSecondOpinion => ({ candidateDigest: recorded.candidateDigest, opinion, recordedAt: input.now });
  if (recorded.notRun !== undefined) return store(secondOpinionUnavailable({ mode: recorded.notRun.mode, choice: recorded.notRun.choice }, recorded.notRun.reason));
  const planned = recorded.plan;
  if (planned === undefined) return undefined;
  const plan = { run: true as const, ...planned, skipped: [], operation: SECOND_REVIEW_OPERATION } as RunPlan;
  const reported = input.result !== null && typeof input.result === "object" ? (input.result as Record<string, unknown>) : {};
  if (input.terminalStatus !== "SUCCEEDED") return store(secondOpinionUnavailable(plan, "no-answer"));
  // A succeeded review whose result has no second-review key came from a worker that did not run it (the field is dropped for an older worker at delivery).
  if (!(SECOND_REVIEW_RESULT_KEY in reported)) return store(secondOpinionUnavailable(plan, "older-worker"));
  const parsed = SecondReviewResultSchema.safeParse(reported[SECOND_REVIEW_RESULT_KEY]);
  const report = parsed.success ? parsed.data.report : undefined;
  if (report === undefined || report.operationId !== input.operationId) return store(secondOpinionUnavailable(plan, "no-answer"));
  if (report.candidateDigest !== recorded.candidateDigest) return store(secondOpinionUnavailable(plan, "wrong-candidate"));
  return store(secondOpinionOf({ plan, report, currentCandidateDigest: input.currentCandidateDigest, accepted: input.accepted, routeAliases: recorded.routeAliases }));
}

/**
 * The lines a pull request description carries about the second review of the code it holds: none while the install switch `cr` is off, none for a shadow opinion, one fixed line for an `on` review that did not
 * run, and the blocking findings (made inert) for an `on` review that blocked. Never the first review's lines, and never read from the workflow.
 */
export function secondReviewPullRequestLines(task: { secondOpinion?: unknown }, candidateDigest: string | undefined, accepted?: readonly AcceptedFindingRef[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (!secondReviewEnabled(env)) return [];
  const opinion = secondOpinionOfTask(task, candidateDigest);
  return opinion === undefined ? [] : secondOpinionPrLines(opinion, accepted);
}

/**
 * Why a merge must wait for the task owner: an `on` second review that did not run, for the code the task holds, that nobody has acknowledged (`mergeWaitsForSecondReview`). Rovara opens pull requests as drafts and never
 * marks them ready, so this gate IS the merge card: Merge is refused with these words until the owner acknowledges on the task page. Undefined while `cr` is off, for a shadow review, once acknowledged, or for other code.
 */
export function secondReviewMergeWait(task: { secondOpinion?: unknown; secondReviewAcknowledged?: readonly string[] | undefined; workflow?: { candidate?: { digest: string } | undefined } | undefined }, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!secondReviewEnabled(env)) return undefined;
  const digest = task.workflow?.candidate?.digest;
  const opinion = secondOpinionOfTask(task, digest);
  if (opinion === undefined || digest === undefined || !mergeWaitsForSecondReview(opinion, digest, task.secondReviewAcknowledged ?? [])) return undefined;
  return `${secondReviewDidNotRunLine(opinion.unavailableReason ?? "no-answer")}. The task owner has to acknowledge it on the task page before this can be merged.`;
}

const plainLine = (text: string, max: number): string => Array.from(redactText(text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()).slice(0, max).join("");

/**
 * What the task page shows about the second review of the code the task holds (the full read only; none while `cr` is off). An answer lists its blocking findings (up to 5, plain single lines, redacted: the page
 * escapes them for its markup) with the model's name and whether they block; an `on` review that did not run says so in the fixed line and asks for the owner's acknowledgement; a shadow review that did not run is silent.
 */
export function secondReviewTaskView(task: { secondOpinion?: unknown; secondReviewAcknowledged?: readonly string[] | undefined; workflow?: { acceptedFindings?: readonly AcceptedFindingRef[] | undefined } | undefined }, candidateDigest: string | undefined, env: NodeJS.ProcessEnv = process.env): { lines: string[]; needsAcknowledgement: boolean; acknowledged: boolean } | undefined {
  if (!secondReviewEnabled(env)) return undefined;
  const opinion = secondOpinionOfTask(task, candidateDigest);
  if (opinion === undefined || candidateDigest === undefined || !secondOpinionShownOn(opinion).taskPage) return undefined;
  if (opinion.unavailable) {
    const ack = secondReviewAcknowledgement(opinion, candidateDigest);
    return { lines: [secondReviewDidNotRunLine(opinion.unavailableReason ?? "no-answer")], needsAcknowledgement: ack.required, acknowledged: ack.required && (task.secondReviewAcknowledged ?? []).includes(ack.key) };
  }
  const report = opinion.report;
  if (report === undefined) return undefined;
  // The same list the opinion blocked on: a finding the owner accepted as a risk is neither blocking nor listed.
  const blocking = blockingFindings(report, task.workflow?.acceptedFindings);
  // Every finding it had was accepted as a risk: nothing left to show.
  if (blocking.length === 0 && opinion.wouldHaveBlocked) return undefined;
  const name = plainLine(`${report.provider}/${report.version}`, 80);
  const kind = opinion.mode === "on" ? "Second review" : "Second opinion (not blocking)";
  return {
    lines: [`${kind} (${name}): ${String(blocking.length)} ${blocking.length === 1 ? "finding" : "findings"}${opinion.downgraded === undefined ? "" : ", shown as an opinion only because this model has not yet passed the replay check"}`,
      ...blocking.slice(0, 5).map((finding) => `- ${plainLine(finding.text, 300)}`),
      // Which model reviewed and why (the default says how to change it).
      plainLine(secondReviewedByLine({ provider: report.provider, modelId: report.version, choice: opinion.choice, defaultChanged: opinion.defaultChanged }), 160)],
    needsAcknowledgement: false, acknowledged: false,
  };
}
