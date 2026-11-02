// Second review by another AI company (SH34): what the broker keeps on the TASK RECORD about it, and the writes that keep it. Nothing here touches the workflow snapshot: a second review is an ADDED opinion, so
// its operation's result never reaches `submitWorkflowReview`, `reviewCleared`, the latest-review-for-candidate lookup, the pull request's Reviews section or `requireCrossCompanyReview`. It lives beside the workflow
// (as `reviewSameModel` does), keyed by the candidate it is about.
import { redactText, WorkflowReviewReportSchema, type AcceptedFindingRef, SecondOpinionSchema, secondReviewDidNotRunLine, blockingFindings, type ModelIdentifier, type SecondOpinion, type WorkflowReviewReport } from "@agentx/contracts";
import { z } from "zod";
import { secondReviewEnabled } from "./second-review-switch.js";
import { secondOpinionOf, secondOpinionPrLines, secondOpinionShownOn, secondOpinionUnavailable, secondReviewAcknowledgement, type SecondReviewPlan } from "./second-review.js";

type RunPlan = Extract<SecondReviewPlan, { run: true }>;

/**
 * What the broker records on a second review's OPERATION when it starts one (`operation.secondReviewPlan`): the candidate it is about and the plan it runs under (the model, the mode, who it must differ from).
 * The operation's end reads it; nothing waits on it and nothing is held (the second review runs inside the REVIEW operation, so there is no pending record on the task).
 */
export interface SecondReviewOperationPlan {
  candidateDigest: string;
  plan: Pick<RunPlan, "mode" | "company" | "model" | "against"> & { downgraded?: "replay-not-passed" };
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

type Item = { Update: { TableName: string; Key: Record<string, unknown>; UpdateExpression: string; ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } };

export interface SecondReviewEndInput {
  tableName: string;
  /** The task, with its workflow as read now (the candidate it holds and the findings the owner accepted as risks). */
  task: { taskId: string; workflow?: { candidate?: { digest: string } | undefined; acceptedFindings?: readonly AcceptedFindingRef[] | undefined } | undefined };
  /** The operation that ended, with the plan the broker recorded on it when it started. */
  operation: { id: string; model?: ModelIdentifier | undefined; secondReviewPlan?: SecondReviewOperationPlan | undefined };
  terminalStatus: string;
  result: unknown;
  now: string;
  /** Builds the key of the task record (the caller's `taskKey`). */
  taskKey: (taskId: string) => Record<string, unknown>;
}

/**
 * The write that ends a second review's operation. It changes ONLY the task's second opinion, never the workflow. An operation with no recorded plan writes nothing. An answer is accepted only when its report is
 * about the candidate the plan names (`report.candidateDigest === plan.candidateDigest`) AND the candidate the task holds now, is the code review's, and came from the planned model by the operation's record AND by
 * the report's own provider and version (`acceptSecondReport`); the findings the owner accepted as risks do not block. Anything else, an operation that did not succeed, or a missing or unreadable report, is
 * stored as unavailable. The write is idempotent for the same operation and never touches `workflow`.
 */
export function secondReviewEndItems(input: SecondReviewEndInput): Item[] {
  const recorded = input.operation.secondReviewPlan;
  if (recorded === undefined) return [];
  const plan = { run: true as const, ...recorded.plan, operation: { tag: "second-review", modelFallback: "off" } } as unknown as RunPlan;
  const reports = input.terminalStatus === "SUCCEEDED" && input.result !== null && typeof input.result === "object" ? (input.result as { workflowReviews?: unknown }).workflowReviews : undefined;
  const parsed = Array.isArray(reports) && reports.length === 1 ? WorkflowReviewReportSchema.safeParse(reports[0]) : undefined;
  const report: WorkflowReviewReport | undefined = parsed?.success === true ? parsed.data : undefined;
  const opinion = report === undefined ? secondOpinionUnavailable(plan, "no-answer")
    : report.candidateDigest !== recorded.candidateDigest ? secondOpinionUnavailable(plan, "wrong-candidate")
    : secondOpinionOf({ plan, report, currentCandidateDigest: input.task.workflow?.candidate?.digest, ranModel: input.operation.model, accepted: input.task.workflow?.acceptedFindings });
  const stored: StoredSecondOpinion = { candidateDigest: recorded.candidateDigest, opinion, recordedAt: input.now };
  return [{ Update: {
    TableName: input.tableName, Key: input.taskKey(input.task.taskId),
    UpdateExpression: "SET secondOpinion = :opinion, updatedAt = :now",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeValues: { ":opinion": stored, ":now": input.now },
  } }];
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
      ...blocking.slice(0, 5).map((finding) => `- ${plainLine(finding.text, 300)}`)],
    needsAcknowledgement: false, acknowledged: false,
  };
}
