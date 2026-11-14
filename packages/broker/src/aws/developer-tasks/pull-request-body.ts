import { attributionBodyLines, workflowReviewsSawPartialDiff, hideEmailAddresses, redactText, workflowIsReviewOnly, planSummaryLines } from "@rovara-code/contracts";
import { evidenceKeyOf } from "./evidence-port.js";
import { type WorkflowSnapshot, workflowFindingAccepted } from "@agentx/cloud-contracts";
import { PULL_REQUEST_PARTIAL_REVIEW_LINE, PULL_REQUEST_STATUS_END, PULL_REQUEST_STATUS_START, ROVARA_STATUS_START } from "../../developer/pull-request-feedback-section.js";
import type { DeveloperTaskRecord, OperationFacts } from "../../developer/task-records.js";
import { loadWorkflowDocument, type LoadedDocument } from "../../developer/plan-artifacts.js";
import { documentSummaryLines } from "../../developer/workflow-messages.js";
import { breakLinearKeys } from "../../rovara-code/linear-close.js";
import { inertPlanLine } from "../../rovara-code/inert-text.js";
import { reviewSameModelOf } from "../../rovara-code/review-model-lines.js";
import { secondReviewPullRequestLines } from "../../rovara-code/second-review-store.js";
import { lessonsUsedLines, rovaraPullRequestBody, rovaraStatusLines, type PullRequestBodyContext } from "../../rovara-code/pull-request-body.js";
import { loadProofContext } from "../../rovara-code/proof-inputs.js";
import { proofDesignContextOf } from "./design-proof.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";
import { inertTaskTitle } from "./common.js";

const WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES = 30_000;
const WORKFLOW_PLAN_SUMMARY_LINE_MAX = 500;
/** At most this many accepted findings are listed in the pull request description. */
const WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED = 20;

/**
 * The draft pull request's description: what the owner-approved plan set out to do, which checks and reviews passed
 * (or, first, that no automated check applied and why), where the task lives, and that a human merges it. At most
 * 30,000 bytes.
 */
export function workflowPullRequestBody(task: DeveloperTaskRecord, workflow: WorkflowSnapshot, plan: LoadedDocument | string | undefined, pageUrl: string | undefined, context?: PullRequestBodyContext, proofLines: readonly string[] = []): string {
  // S3 (C59): the description is read by everyone who can see the repository, and the plan, the findings and the title are a model's and a person's words. No email address is written on GitHub; layout is kept, so a code block still renders.
  const body = hideEmailAddresses(buildWorkflowPullRequestBody(task, workflow, plan, pageUrl, context, proofLines));
  return fitPullRequestBody(body);
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
/** Cut on a character boundary: a split multi-byte character decodes as U+FFFD, which is dropped. */
const cutBytes = (text: string, max: number): string => Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/\uFFFD+$/u, "");

/**
 * The body within the cap. A body that is over it (hiding an address can lengthen a line) loses the end of its summary, in front of the marked status block, before anything is cut from the end:
 * the block's end marker, the session link and the closing line stay, so the status updates and the Linear close line can still find the block.
 */
export function fitPullRequestBody(body: string): string {
  if (byteLength(body) <= WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES) return body;
  const markers = [PULL_REQUEST_STATUS_START, ROVARA_STATUS_START].map((marker) => body.indexOf(marker)).filter((index) => index > 0);
  const start = markers.length === 0 ? -1 : Math.min(...markers);
  if (start > 0) {
    const overflow = byteLength(body) - WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES;
    const head = body.slice(0, start);
    // Keep at least a short head: the summary's first lines.
    if (byteLength(head) > overflow + 200) return `${cutBytes(head, byteLength(head) - overflow - 5).trimEnd()}...\n\n${body.slice(start)}`;
  }
  return cutBytes(body, WORKFLOW_PULL_REQUEST_BODY_MAX_BYTES);
}

/** The title of the pull request Rovara opens: the task's title made inert, without an email address, and (for Rovara Code) without a Linear issue key. At most 256 characters. */
export function pullRequestTitle(taskTitle: string, rovaraV2: boolean): string {
  const inert = inertTaskTitle(hideEmailAddresses(taskTitle));
  return `${rovaraV2 ? "Rovara" : "AgentX"}: ${rovaraV2 ? breakLinearKeys(inert) : inert}`.slice(0, 256);
}

function buildWorkflowPullRequestBody(task: DeveloperTaskRecord, workflow: WorkflowSnapshot, plan: LoadedDocument | string | undefined, pageUrl: string | undefined, context?: PullRequestBodyContext, proofLines: readonly string[] = []): string {
  // SH34: the second review of this code (switch `cr`; none for a shadow opinion, none while `cr` is off), kept beside the workflow and never part of the first review's lines. Both versions show it.
  const secondLines = secondReviewPullRequestLines(task, workflow.candidate?.digest, workflow.acceptedFindings);
  // Rovara Code version 2 has its own description (sections, test results and a risk level); a version 1 task's is exactly as it was.
  if (workflow.definitionVersion === "1.1.0") {
    return rovaraPullRequestBody({
      summary: typeof plan === "object" && plan.format === "structured" ? planSummaryLines(plan.plan) : documentSummaryLines(typeof plan === "string" ? plan : plan?.markdown ?? ""),
      fallbackTitle: task.title, workflow, context: { ...(context ?? {}), ...(proofLines.length === 0 ? {} : { proofLines }), ...(reviewSameModelOf(task, workflow) ? { reviewSameModel: true } : {}), ...(secondLines.length === 0 ? {} : { secondReviewLines: secondLines }) }, reviewLines: (listed) => workflowReviewLines(workflow, listed), pageUrl,
    });
  }
  // A structured plan's summary is its top claims; a legacy one's is its first lines (task 18: the same as the plan's
  // Slack message). Either way each line is made inert for GitHub first.
  const summary = (typeof plan === "object" && plan.format === "structured"
    ? planSummaryLines(plan.plan).map(inertPlanLine)
    : documentSummaryLines((typeof plan === "string" ? plan : plan?.markdown ?? "").split("\n").map(inertPlanLine).join("\n")))
    .map((line) => line.slice(0, WORKFLOW_PLAN_SUMMARY_LINE_MAX));
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  // Model-written: one line, redacted and made inert like a plan line.
  const noneReason = workflow.checkPolicy?.noneReason === undefined ? "" : inertPlanLine(redactText(workflow.checkPolicy.noneReason).replace(/\s+/gu, " ")).trim();
  const lines = [
    ...(reviewOnly ? ["Not verified by automated checks (review only).", ...(noneReason === "" ? [] : [`Why: ${noneReason}`]), ""] : []),
    ...(summary.length > 0 ? summary : [inertTaskTitle(task.title)]),
    "",
    // Between markers, so a pushed PR feedback fix can bring them up to date and leave the rest as the person left it.
    PULL_REQUEST_STATUS_START,
    // R1 (re-check round 1): the lessons used belong in the description a version 1 task OPENS with, not only in one a pushed fix rewrites.
    ...workflowPullRequestStatusLines(workflow, { ...(context?.lessonsUsed === undefined ? {} : { lessonsUsed: context.lessonsUsed }), ...(secondLines.length === 0 ? {} : { secondReviewLines: secondLines }) }, proofLines),
    PULL_REQUEST_STATUS_END,
    ...attributionBodyLines(context?.attribution),
    ...(pageUrl === undefined ? [] : [`AgentX task: ${pageUrl}`]),
    "",
    `Opened as a draft by AgentX after the owner-approved plan${reviewOnly ? " and reviews" : ", checks and reviews"} passed. Merge it on GitHub.`,
  ];
  return fitPullRequestBody(lines.join("\n"));
}

/**
 * The pull request description's lines about the current code: which checks passed on it (none for review only), how
 * its reviews went, the review findings the owner accepted, and whether the reviews saw only part of the change. Each
 * line is one line, redacted and made inert for GitHub. Rewritten after a pushed PR feedback fix, so it is always about
 * the code on the pull request.
 */
export function workflowPullRequestStatusLines(workflow: WorkflowSnapshot, context?: PullRequestBodyContext, proofLines: readonly string[] = []): string[] {
  // Rovara Code version 2 rewrites its whole block (what changed, tests, reviews and risk); version 1's lines are as they were.
  if (workflow.definitionVersion === "1.1.0") return rovaraStatusLines(workflow, proofLines.length === 0 ? context ?? {} : { ...context, proofLines }, (listed) => workflowReviewLines(workflow, listed)).map((line) => hideEmailAddresses(line));
  const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.proposed ?? []), ...(workflow.checkPolicy?.optional ?? [])];
  const passed = (workflow.verification?.results ?? []).filter((result) => result.status === "PASS")
    // A proposed check's label is model-written: one line, redacted and made inert like a plan line, as every label is.
    .map((result) => `${inertPlanLine(redactText(checks.find((check) => check.id === result.checkId)?.label ?? result.checkId).replace(/\s+/gu, " "))} passed`);
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  // S3: also the path the status block is rewritten by after a pushed fix, so no line reaches GitHub with an email address.
  return [
    ...(reviewOnly ? [] : [`Checks: ${passed.length > 0 ? passed.join(", ") : "none recorded"}`]),
    ...workflowReviewLines(workflow, WORKFLOW_PULL_REQUEST_ACCEPTED_LISTED),
    ...(context?.secondReviewLines ?? []),
    ...proofLines,
    // Approve by exception (DECISIONS 24): version 1 descriptions list the lessons used too (same visibility rule as version 2).
    ...lessonsUsedLines(context?.lessonsUsed, 10),
  ].map((line) => hideEmailAddresses(line));
}

/**
 * The lines about the reviews of the current code: how they went, the findings the owner accepted (at most `listed` of them named) and whether the reviewers saw only part of the change. Each line is one line,
 * redacted and made inert for GitHub.
 */
function workflowReviewLines(workflow: WorkflowSnapshot, listed: number): string[] {
  // The issues noted are those nobody had to resolve: the findings the owner accepted are listed on their own.
  const noted = (workflow.reviews ?? []).reduce((count, review) => count + review.findings.filter((finding) => !workflowFindingAccepted(workflow, review.role, finding)).length, 0);
  const reviewWord = (role: "CRITIC" | "SECURITY") => (workflow.reviews ?? []).some((review) => review.role === role
    && review.candidateDigest === workflow.candidate?.digest && review.status === "FINDINGS") ? "passed after the owner accepted its findings" : "passed";
  const accepted = (workflow.acceptedFindings ?? []).filter((finding) => finding.candidateDigest === workflow.candidate?.digest);
  const partial = workflowReviewsSawPartialDiff(workflow);
  return [
    `Reviews: code review ${reviewWord("CRITIC")}; security review ${reviewWord("SECURITY")}${noted > 0 ? `; ${noted} earlier issue${noted === 1 ? "" : "s"} noted` : ""}`,
    ...(accepted.length === 0 ? [] : [
      `Owner accepted ${accepted.length} review finding${accepted.length === 1 ? "" : "s"}:`,
      // Reviewer text and the owner's reason, each on one line, redacted and made inert for GitHub like a plan line.
      ...accepted.slice(0, listed).map((finding) => `- [${finding.role === "SECURITY" ? "security" : "code"}] ${inertPlanLine(redactText(finding.text).replace(/\s+/gu, " "))} \u2014 accepted: ${inertPlanLine(redactText(finding.reason).replace(/\s+/gu, " "))}`),
      ...(accepted.length > listed ? [`- and ${accepted.length - listed} more; see the task page`] : []),
    ]),
    ...(partial ? [PULL_REQUEST_PARTIAL_REVIEW_LINE] : []),
  ];
}

/** Playbook P1/P3: the Proof inputs of a task (the approved plan, the browser/API rows, the test proof): the pull request's description and the task page's proof table read them through this one call. */
export async function proofContextOfTask(
  deps: Pick<DeveloperTaskRouteDependencies, "actions" | "workflowE2EScenarioResults"> & Partial<Pick<DeveloperTaskRouteDependencies, "evidence" | "documentClient" | "tableName">>, task: DeveloperTaskRecord, workflow: WorkflowSnapshot, approvedPlan: LoadedDocument | undefined, actor: "owner" | "viewer",
  /** The task's operations when the caller has already read them (the task view has), so they are not read again. */
  operations?: readonly OperationFacts[],
): ReturnType<typeof loadProofContext> {
  const evidence = deps.evidence;
  return loadProofContext({
    actions: deps.actions, scenarioResults: async () => deps.workflowE2EScenarioResults?.({ task, operations: operations ?? await deps.actions.operations(task.workspaceId), actor }),
    ...(evidence === undefined ? {} : { evidence: (digest: string) => evidence.context(evidenceKeyOf(task), digest) }),
    // Design review (DR12): the approved design's line; undefined for a task with no design review, which leaves the section as it was.
    ...(deps.documentClient === undefined || deps.tableName === undefined ? {} : { design: proofDesignContextOf({ documentClient: deps.documentClient, tableName: deps.tableName, taskId: task.taskId, readArtifact: (key, max) => deps.actions.readArtifact(key, max) }) }),
  }, task, workflow, approvedPlan, operations);
}

/**
 * The owner-approved coding plan, for the pull request's description: read through its recorded key and used only when
 * an owner approval names its digest and the text read back has that digest. Anything else (no plan, no approval of
 * it, a changed object) gives undefined, and the description falls back to the task's title.
 */
export async function approvedPlanForPullRequest(deps: Pick<DeveloperTaskRouteDependencies, "actions">, workflow: WorkflowSnapshot): Promise<LoadedDocument | undefined> {
  const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
  if (plan === undefined || !workflow.decisions.some((decision) => decision.decision === "APPROVE" && decision.artifactDigest === plan.sha256)) return undefined;
  return loadWorkflowDocument((objectKey, maxBytes) => deps.actions.readArtifact(objectKey, maxBytes), plan, {});
}

/** Selects a publication protocol from broker-validated task, plan and project state, never request fields. */
export type WorkflowPublicationAuthority = {
  mode: "COMMITTED_HEAD" | "CHECKED_TREE";
  pinnedRevision: number;
  latestRevision: number;
  materialDigest: string;
  workflowRevision: number;
  planArtifact: { id: string; type: string; version: number; objectKey: string; sha256: string; format: "markdown" | "structured" };
  ownerApproval: { requestId: string; workflowRevision: number; actorId: string; actorRole: "TASK_OWNER" | "PROJECT_ADMIN"; artifactDigest: string; workBreakdownDigest: string | null; at: string };
  workflowAuthorityDigest: string;
};
