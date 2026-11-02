// Second review by another AI company (SH34): what the broker keeps on the TASK RECORD about it, and the writes that keep it. Nothing here touches the workflow snapshot: a second review is an ADDED opinion, so
// its operation's result never reaches `submitWorkflowReview`, `reviewCleared`, the latest-review-for-candidate lookup, the pull request's Reviews section or `requireCrossCompanyReview`. It lives beside the workflow
// (as `reviewSameModel` does), keyed by the candidate it is about.
import { redactText, WorkflowReviewReportSchema, SecondOpinionSchema, secondReviewDidNotRunLine, blockingFindings, type ModelIdentifier, type SecondOpinion, type WorkflowReviewReport } from "@agentx/contracts";
import { z } from "zod";
import { secondReviewEnabled } from "./second-review-switch.js";
import { secondOpinionOf, secondOpinionPrLines, secondOpinionShownOn, secondOpinionUnavailable, secondReviewAcknowledgement, type SecondReviewAttempt, type SecondReviewPlan } from "./second-review.js";

type RunPlan = Extract<SecondReviewPlan, { run: true }>;

/** A second review that is running for one candidate. `deadlineAt` bounds the wait: past it the review counts as "did not run". */
export interface SecondReviewPending {
  operationId: string;
  candidateDigest: string;
  startedAt: string;
  deadlineAt: string;
  /** The plan it was started under (the model, the mode it ran in, who it must differ from). */
  plan: Pick<RunPlan, "mode" | "company" | "model" | "against"> & { downgraded?: "replay-not-passed" };
  /** The tries that gave no answer so far (at most `SECOND_REVIEW_TRIES_MAX`). */
  attempts: SecondReviewAttempt[];
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
  /** The task, with its pending record and workflow as read now. */
  task: { taskId: string; secondReviewPending?: SecondReviewPending | undefined; workflow?: { candidate?: { digest: string } | undefined } | undefined };
  operation: { id: string; model?: ModelIdentifier | undefined };
  terminalStatus: string;
  result: unknown;
  now: string;
  /** Builds the key of the task record (the caller's `taskKey`). */
  taskKey: (taskId: string) => Record<string, unknown>;
}

/**
 * The write that ends a second review's operation. It changes ONLY the task's second-review attributes, never the workflow: the pending record goes, and the opinion for this candidate is stored. Conditional on the
 * pending record still being this operation's (a late or duplicate end writes nothing, and a second review of a candidate that has since changed is stored as unavailable `wrong-candidate`, never as an answer).
 * An answer is judged by `secondOpinionOf` (the code review, the current candidate, the planned model, still another company). An operation that did not succeed, or whose report is missing or unreadable, is `no-answer`.
 */
export function secondReviewEndItems(input: SecondReviewEndInput): Item[] {
  const pending = input.task.secondReviewPending;
  if (pending === undefined || pending.operationId !== input.operation.id) return [];
  const plan = { run: true as const, ...pending.plan, operation: { tag: "second-review", modelFallback: "off" } } as unknown as RunPlan;
  const reports = input.terminalStatus === "SUCCEEDED" && input.result !== null && typeof input.result === "object" ? (input.result as { workflowReviews?: unknown }).workflowReviews : undefined;
  const parsed = Array.isArray(reports) && reports.length === 1 ? WorkflowReviewReportSchema.safeParse(reports[0]) : undefined;
  const report: WorkflowReviewReport | undefined = parsed?.success === true ? parsed.data : undefined;
  const opinion = report === undefined
    ? secondOpinionUnavailable(plan, "no-answer")
    : secondOpinionOf({ plan, report, currentCandidateDigest: input.task.workflow?.candidate?.digest, ranModel: input.operation.model });
  const stored: StoredSecondOpinion = { candidateDigest: pending.candidateDigest, opinion, recordedAt: input.now };
  return [{ Update: {
    TableName: input.tableName, Key: input.taskKey(input.task.taskId),
    UpdateExpression: "SET secondOpinion = :opinion, updatedAt = :now REMOVE secondReviewPending",
    ConditionExpression: "attribute_exists(pk) AND secondReviewPending.operationId = :operation",
    ExpressionAttributeValues: { ":opinion": stored, ":now": input.now, ":operation": pending.operationId },
  } }];
}

/**
 * The write that gives up a second review whose time ran out (the existing stale-operation sweep calls it): the pending record goes and the opinion for its candidate is "did not run: no answer". Nothing is held
 * past the deadline, and nothing is blocked; `on` flags it. Conditional on the same pending operation.
 */
export function secondReviewExpiredItems(input: Pick<SecondReviewEndInput, "tableName" | "task" | "now" | "taskKey">): Item[] {
  const pending = input.task.secondReviewPending;
  if (pending === undefined || Date.parse(pending.deadlineAt) > Date.parse(input.now)) return [];
  const plan = { run: true as const, ...pending.plan } as unknown as RunPlan;
  const stored: StoredSecondOpinion = { candidateDigest: pending.candidateDigest, opinion: secondOpinionUnavailable(plan, "no-answer"), recordedAt: input.now };
  return [{ Update: {
    TableName: input.tableName, Key: input.taskKey(input.task.taskId),
    UpdateExpression: "SET secondOpinion = :opinion, updatedAt = :now REMOVE secondReviewPending",
    ConditionExpression: "attribute_exists(pk) AND secondReviewPending.operationId = :operation",
    ExpressionAttributeValues: { ":opinion": stored, ":now": input.now, ":operation": pending.operationId },
  } }];
}

/**
 * The lines a pull request description carries about the second review of the code it holds: none while the install switch `cr` is off, none for a shadow opinion, one fixed line for an `on` review that did not
 * run, and the blocking findings (made inert) for an `on` review that blocked. Never the first review's lines, and never read from the workflow.
 */
export function secondReviewPullRequestLines(task: { secondOpinion?: unknown }, candidateDigest: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!secondReviewEnabled(env)) return [];
  const opinion = secondOpinionOfTask(task, candidateDigest);
  return opinion === undefined ? [] : secondOpinionPrLines(opinion);
}

const plainLine = (text: string, max: number): string => Array.from(redactText(text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()).slice(0, max).join("");

/**
 * What the task page shows about the second review of the code the task holds (the full read only; none while `cr` is off). An answer lists its blocking findings (up to 5, plain single lines, redacted: the page
 * escapes them for its markup) with the model's name and whether they block; an `on` review that did not run says so in the fixed line and asks for the owner's acknowledgement; a shadow review that did not run is silent.
 */
export function secondReviewTaskView(task: { secondOpinion?: unknown; secondReviewAcknowledged?: readonly string[] | undefined }, candidateDigest: string | undefined, env: NodeJS.ProcessEnv = process.env): { lines: string[]; needsAcknowledgement: boolean; acknowledged: boolean } | undefined {
  if (!secondReviewEnabled(env)) return undefined;
  const opinion = secondOpinionOfTask(task, candidateDigest);
  if (opinion === undefined || candidateDigest === undefined || !secondOpinionShownOn(opinion).taskPage) return undefined;
  if (opinion.unavailable) {
    const ack = secondReviewAcknowledgement(opinion, candidateDigest);
    return { lines: [secondReviewDidNotRunLine(opinion.unavailableReason ?? "no-answer")], needsAcknowledgement: ack.required, acknowledged: ack.required && (task.secondReviewAcknowledged ?? []).includes(ack.key) };
  }
  const report = opinion.report;
  if (report === undefined) return undefined;
  const blocking = blockingFindings(report);
  const name = plainLine(`${report.provider}/${report.version}`, 80);
  const kind = opinion.mode === "on" ? "Second review" : "Second opinion (not blocking)";
  return {
    lines: [`${kind} (${name}): ${String(blocking.length)} ${blocking.length === 1 ? "finding" : "findings"}${opinion.downgraded === undefined ? "" : ", shown as an opinion only because this model has not yet passed the replay check"}`,
      ...blocking.slice(0, 5).map((finding) => `- ${plainLine(finding.text, 300)}`)],
    needsAcknowledgement: false, acknowledged: false,
  };
}
