// Gaps 5, 12 and 10g: the one place a workflow task's thread post is worded. Each (stage, state) has one brief,
// plain message (at most 1,200 visible characters), and every blocked step carries its ways out as buttons. Every
// value from a record, the model or a reviewer is redacted where it is free text, cut short and escaped here.
import { designClassificationNoteOf } from "../design-review/mode.js";
import {
  DECISION_LABELS, WORKFLOW_AUTO_IMPLEMENT_FAILED_MESSAGE, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE,
  answeredMessage, formatMinutes, formatRunLimitUsd, runLimitRaiseText, intentQuestionsMessage, isBranchSyncBlockReason, isCiFixBlockReason, isNoCodeChangedReason, isRunLimitBlockReason, workflowAnswer, NO_CODE_CHANGED_LEGACY_REASONS, type NoChangeNeeded, WORKFLOW_KEEP_PULL_REQUESTS_NOTE, WORKFLOW_RESOLVE_FINDINGS_MAX, openReviewFindings, hideEmailAddresses, redactText, workflowKeepPullRequestsOffered, sendBackProblems, workflowIsReviewOnly, workflowReviewsSawPartialDiff, workflowCheckResultBroken, workflowSelectedChecks, workflowSendBackOffered, workflowApplicationEvidenceCodes, workflowReadmitsApplicationRound, workflowReviseOffered, type RunEstimate, type WorkflowSnapshot, FEEDBACK_NOT_RUN_REASON, FEEDBACK_STOPPED_REASON, feedbackDecidedByText,
} from "@agentx/contracts";
import { E2E_OWNER_SENTENCES } from "../e2e/owner-sentences.js";
import { critiqueLines } from "../rovara-code/critique-lines.js";
import { mergedLines } from "../rovara-code/merged-lines.js";
import { WORKFLOW_ACTION_IDS } from "./workflow-actions.js";
import { isE2EPlanCorrectionBlockReason } from "./task-records.js";
import { reviewModelLines } from "../rovara-code/review-model-lines.js";
import { workflowReviewRound } from "../rovara-code/verification-report.js";
import { PLAN_UNREADABLE_SENTENCES, type PlanUnreadableCategory } from "./plan-check-summary.js";
import { autoFixCardLines, fixSetupWording, type AutoFixAsk } from "./autofix-messages.js";
import { maskForSlack, noCodeChangedText } from "./no-change-findings-text.js";

export interface WorkflowMessageContext {
  taskId: string;
  /** E: default-off Task People control on Slack workflow cards. */
  peopleEnabled?: boolean | undefined;
  ownerSlackUserId?: string | undefined;
  workflow: WorkflowSnapshot;
  /** Where the full document reads (a Canvas, or the task page); absent when no link could be made. */
  documentLink?: { url: string } | undefined;
  documentSummary?: readonly string[] | undefined;
  /** The digest the Owner must include when approving a structured coding plan with a work breakdown. */
  workBreakdownDigest?: string | undefined;
  /**
   * A structured document's card: its top claims in rank order (for a tiny plan every claim, a child's text starting
   * with two spaces per level), how many claims and decisions it has in all, and whether it is tiny. Replaces `documentSummary`.
   */
  structured?: {
    claims: string[]; claimCount: number; decisionCount: number; tiny: boolean; noChangeNeeded?: NoChangeNeeded | undefined;
    /** PLANVIEW: the answer each decision gets if the owner approves here (AgentX's recommended option), in plan order. */
    decisions?: ReadonlyArray<{ id: string; question: string; answer: string }> | undefined;
    /** PLANVIEW: one plain line per browser or API scenario and proposed check the plan adds (`planCheckSummary(plan).lines`). */
    checkLines?: readonly string[] | undefined;
    /** What AgentX's plan check says of the plan (`planCheckSummary(plan).selfCheckLines`): its findings' sentences, or "Not checked by AgentX's plan check."; empty when it ran and found nothing. */
    selfCheckLines?: readonly string[] | undefined;
  } | undefined;
  /** PLANREADMSG: why the plan could not be read, as a fixed category; absent when not known (the card then says only that it could not be read). */
  planUnreadableCategory?: PlanUnreadableCategory | undefined;
  /** PLANREADMSG: AgentX already asked the planner a second time by itself and the answer could not be read either. */
  planUnreadableAutoRetried?: boolean | undefined;
  findingsUrl?: string | undefined;
  /** The reviews of the current code ran on the build's own model (`reviewSameModelOf`): the message says so. */
  reviewSameModel?: boolean | undefined;
  /** The task page, where every thread reply can be read. */
  taskPageUrl?: string | undefined;
  /** Thread replies saved and not yet given to a step. */
  newReplies?: number | undefined;
  /**
   * After Request changes that sent comments: how many of them the planner answered, and the version they were sent on. After
   * an Approve that sent comments, `approvedOn` names the approved document, the first comment answered (for the link) and
   * whether every comment was the owner's.
   */
  commentAnswers?: { answered: number; total: number; fromVersion: number; approvedOn?: { document: DocumentName; commentId?: string; allOwners: boolean } } | undefined;
  /** AgentX's own draft pull request did not open; `codeChanged` when the workspace no longer held the checked code. */
  publishFailure?: { category: string; codeChanged?: boolean | undefined } | undefined;
  /** The step a closed required pull request's reopening started (the numbers reopened; empty when not known). */
  pullRequestReopened?: ReadonlyArray<{ repositoryId: string; number: number }> | undefined;
  /** Plan 3, Task 34: what the coding plan under review is expected to cost and the run limit approving it accepts; the plan-ready message says it. */
  runEstimate?: RunEstimate | undefined;
  /** The name of the agent doing the work, for the max-per-run line (Rovara Code when absent). */
  agentName?: string | undefined;
  /** The task's project, for the plan check's note that the project allows only one model. */
  project?: string | undefined;
  /** AUTOFIX: automatic fixing is on for this deployment; a blocked checks or reviews card then says what Rovara already tried and, from `autoFixAsk`, why it is asking. Absent: the card reads as it always did. */
  autoFix?: { ask?: AutoFixAsk | undefined } | undefined;
  /** T7c: the coding plan is written and held back while its must-not-change checks run on the current app; no card to approve yet. */
  planGroundingHeld?: boolean | undefined;
  /**
   * Design review (ON-1): the design under review is approved ONLY on its decision card, so an Approve here would be refused (`DESIGN_CARD_ONLY_MESSAGE`). Set (by the notifier, when the task carries a design review and
   * waits on its design) to the card's address in the app, `/app/sessions/<id>?decision=approve_design:<task>`, or the task page when the session is not known: the message offers "Open in Rovara" there in
   * place of Approve. Request changes and Close stay.
   */
  designCardUrl?: string | undefined;
  /**
   * Slice 2: this coding plan is medium or high risk (`medium`, `high`: decided in the app, high after a recent sign-in). The message offers "Open in Rovara" to `url` (the plan review page, which exists whether or
   * not the decision cards are on) in place of Approve. (0.5.11, QA6-12b: a plan that raises the run limit is no longer sent to the app; see `runLimitRaise`.)
   */
  planOpen?: { url: string; why: "medium" | "high" } | undefined;
  /**
   * 0.5.11 (QA6-12b; this replaces `planOpen` with `why: "run_limit"`): approving this coding plan raises the run limit. The message says "This raises the run limit from $A to $B", the Approve button says the new limit and
   * carries it (`runLimitUsd` in its value), and the broker refuses the press if approving would now set another amount.
   */
  runLimitRaise?: { currentUsd: number; proposedUsd: number } | undefined;
}
export interface WorkflowMessage { text: string; blocks: Array<Record<string, unknown>> }

/** Every button `workflowSlackHandlers` answers. */
export { WORKFLOW_ACTION_IDS };

/** Escapes what Slack would read as markup: a mention, a link or a broadcast. */
export const slackText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const SECTION_TEXT_LIMIT = 2_800;
const SUMMARY_LINE_MAX = 160;
const FINDING_TEXT_MAX = 180;
const FINDINGS_SHOWN = 3;
const REGRESSED_TEST_MAX = 100;
/** Said after a failed feedback review or push: the pull request's merge is still tracked. */
const STILL_WATCHING = "I'm still watching the pull request and will finish this task when it's merged.";
const GENERIC_REASON = "Something went wrong on AgentX's side.";
/** Said once per reopening of a closed required pull request (D3) when which one is not known. */
export const PULL_REQUEST_REOPENED = "The pull request was reopened, so I'm following it again.";

/** Said once per reopening (D3): which pull requests were reopened, by name. */
function pullRequestReopened(workflow: WorkflowSnapshot, which: ReadonlyArray<{ repositoryId: string; number: number }>): string {
  const reopened = (workflow.pullRequests ?? []).filter((pullRequest) => which.some((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number));
  if (reopened.length === 0) return PULL_REQUEST_REOPENED;
  const names = pullRequestNames(reopened, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
  return reopened.length === 1 ? `${names} was reopened, so I'm following it again.` : `${names} were reopened, so I'm following them again.`;
}

type DocumentName = "coding plan" | "requirements" | "design";

/** The document an approval step is about, by the task's path and phase. */
export function workflowDocumentName(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">): DocumentName {
  if (workflow.path !== "FULL") return "coding plan";
  return workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : workflow.reviewPhase === "DESIGN" ? "design" : "coding plan";
}

/** The saved document type behind each name. */
export function workflowDocumentType(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">): "plan" | "requirements" | "design" {
  const name = workflowDocumentName(workflow);
  return name === "coding plan" ? "plan" : name;
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The approval modal's title and submit label, named after the document being decided on. */
export function workflowModalCopy(workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">, decision: "APPROVE" | "REQUEST_CHANGES"): { title: string; submit: string } {
  if (decision === "REQUEST_CHANGES") return { title: "Request changes", submit: "Send changes" };
  const name = workflowDocumentName(workflow);
  return { title: `Approve ${name}`, submit: name === "coding plan" ? "Approve and start coding" : "Approve and continue" };
}

/** What the owner is told when a custom sequence without a pull request step has run every step. */
export const SEQUENCE_FINISHED_TEXT = "Rovara finished every step. The changes are kept in this task's workspace until you close the task.";

/** Block reasons written for people, shown word for word; matched exactly, never by prefix. */
const PLAIN_REASONS: ReadonlySet<string> = new Set([
  WORKFLOW_AUTO_IMPLEMENT_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_HISTORY_REWRITTEN_MESSAGE,
  ...Object.values(WORKFLOW_BLOCK_REASONS),
]);

/** Block reasons stored before their wording changed, and what they read as now. */
const REWORDED_REASONS: ReadonlyMap<string, string> = new Map([
  ...NO_CODE_CHANGED_LEGACY_REASONS.map((legacy): [string, string] => [legacy, WORKFLOW_BLOCK_REASONS.noCodeChanged]),
  ["No checks ran: this project has no required checks and the task selected no optional checks. Configure or select at least one check, then retry.", WORKFLOW_BLOCK_REASONS.noChecksConfigured],
  ...["failed", "interrupted", "cancelled"].map((status): [string, string] => [`PR feedback review operation ended ${status}`, WORKFLOW_BLOCK_REASONS.feedbackReviewFailed]),
  ["PR feedback review report was invalid, incomplete, or stale", WORKFLOW_BLOCK_REASONS.feedbackReviewFailed],
]);

/** Whether a pull request's feedback review failed, by the reason stored now or before its wording changed. */
export function isFeedbackReviewFailure(blockReason: string | undefined): boolean {
  // The feedback review also stops, before it reads anything, when the programs earlier work left running cannot be stopped.
  return blockReason !== undefined && (blockReason === WORKFLOW_BLOCK_REASONS.feedbackReviewFailed || blockReason === WORKFLOW_BLOCK_REASONS.leftoverProcesses
    || REWORDED_REASONS.get(blockReason) === WORKFLOW_BLOCK_REASONS.feedbackReviewFailed);
}

/** The step a stopped run ran, as the first word of the sentence that says it was stopped (keys: `workflowRunEndedReason`'s step names). */
const STOPPED_STEP_NAME: Readonly<Record<string, string>> = { understanding: "Understanding", planning: "Planning", "plan check": "The plan check", implementation: "Coding", "verification retry": "Checking", "independent review": "Reviewing" };

const STOPPED_BY_OWNER = /^(understanding|planning|plan check|implementation|verification retry|independent review) operation ended (cancelled|interrupted)$/;
/** Whether a step's block reason is a stop the owner asked for, which `plainBlockReason` words as a whole sentence of its own. */
const stoppedByOwner = (blockReason: string | undefined): boolean => blockReason !== undefined && STOPPED_BY_OWNER.test(blockReason);

/** The broker's own reason a step stopped, in words the owner can act on; any other reason is internal. */
export function plainBlockReason(blockReason: string | undefined, as: "AgentX" | "Rovara" = "AgentX"): string {
  const generic = as === "Rovara" ? GENERIC_REASON.replace("AgentX", "Rovara") : GENERIC_REASON;
  if (blockReason === undefined) return generic;
  if (isE2EPlanCorrectionBlockReason(blockReason)) return slackText(blockReason);
  const reworded = REWORDED_REASONS.get(blockReason);
  if (reworded !== undefined) return slackText(reworded);
  // PLANINC-2: a stop the owner asked for (cancelled, or interrupted when the stop could not be delivered) says so and what to do; only a failed run is unexpected.
  const stopped = STOPPED_BY_OWNER.exec(blockReason);
  if (stopped !== null) return `${STOPPED_STEP_NAME[stopped[1]!]!} was stopped before it finished. Choose Retry to run it again.`;
  if (/operation ended (failed|interrupted|cancelled)$/.test(blockReason)) return "The run stopped unexpectedly.";
  if (/ was invalid, incomplete, or stale$/.test(blockReason)) return "The result couldn't be trusted, so nothing moved forward.";
  if (blockReason === FEEDBACK_NOT_RUN_REASON || blockReason === FEEDBACK_STOPPED_REASON) return slackText(blockReason);
  return PLAIN_REASONS.has(blockReason) ? slackText(blockReason) : generic;
}

/** PLANREADMSG: an unreadable plan says why in a fixed category sentence (never the validator's words) and what to do. */
function planUnreadableText(context: WorkflowMessageContext): string {
  const name = workflowDocumentName(context.workflow);
  const category = context.planUnreadableCategory;
  const again = context.planUnreadableAutoRetried === true ? " AgentX tried once more by itself and got the same problem." : "";
  if (category === undefined) return `AgentX couldn't read the ${name} it wrote.${again}`;
  return `AgentX couldn't read the ${name} it wrote: ${PLAN_UNREADABLE_SENTENCES[category]}.${again} Choose Retry planning (it gets the problems found), or Close.`;
}

/** A review-only task's blocked verification, without advice to rerun checks it does not have. */
const REVIEW_ONLY_VERIFY_REASONS: Record<string, string> = {
  [WORKFLOW_BLOCK_REASONS.checksUnconfirmed]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.checkReportUnreadable]: "AgentX couldn't read its report on the final code.",
  [WORKFLOW_BLOCK_REASONS.checkRunnerFailed]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.noChecksConfigured]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.noCheckResults]: "AgentX couldn't confirm the final code.",
  [WORKFLOW_BLOCK_REASONS.repositoriesIncomplete]: "AgentX couldn't find every repository in the final code.",
  [WORKFLOW_BLOCK_REASONS.codeChangedAfterChecks]: "The code changed while AgentX was checking it.",
  [WORKFLOW_BLOCK_REASONS.startUnrecorded]: "AgentX could not record where this change started.",
  [WORKFLOW_BLOCK_REASONS.startChanged]: "The code's starting point changed.",
};

/** Why one review did not qualify, by its recorded reason; never the reviewer's own output. */
const REVIEW_FAILURES: Record<string, string> = {
  RESPONSE_MISSING: "the reviewer gave no answer",
  RESPONSE_TOO_LARGE: "its answer was too long",
  INVALID_JSON: "its answer wasn't in the expected format",
  INVALID_SHAPE: "its answer wasn't in the expected format",
  TIMEOUT: "it ran out of time",
  INTERRUPTED: "it was stopped",
  CANDIDATE_CHANGED: "the code changed during the review",
  SESSION_FAILED: "the reviewer couldn't start",
  USAGE_UNAVAILABLE: "its usage couldn't be recorded",
  BASE_UNAVAILABLE: "the task's starting point wasn't recorded",
  DIFF_UNAVAILABLE: "the change couldn't be compared with the task's starting point",
};
const plainReviewFailure = (reason: string | undefined, status: string) =>
  (reason === undefined ? undefined : REVIEW_FAILURES[reason]) ?? (status === "INTERRUPTED" ? "it was stopped" : "it gave no usable answer");

/** Why AgentX's draft pull request did not open, by the failure's category. */
const PUBLISH_FAILURES: Record<string, string> = {
  publication_failed: "GitHub didn't accept it",
  interrupted: "the run was stopped",
  worker_unavailable: "no worker was free to open it",
  timed_out: "it ran out of time",
};
const plainPublishFailure = (category: string) => PUBLISH_FAILURES[category] ?? "something went wrong on AgentX's side";

/**
 * One line of free text from a reviewer or the model: on one line, redacted, cut short, escaped, and never a link: a
 * zero-width joiner follows each `://` and the `www` of `www.`, so Slack does not turn a bare address into one.
 */
export function cleanLine(text: string, limit: number): string {
  const line = hideEmailAddresses(redactText(text)).replace(/\s+/g, " ").trim()
    .replaceAll("://", "://‍")
    .replace(/\bwww\./giu, (match) => `${match.slice(0, 3)}‍.`);
  return slackText(line.length > limit ? `${line.slice(0, limit - 3).trimEnd()}...` : line);
}

/**
 * Up to `max` lines that say what a document is about: its first lines of prose or list items, with headings, code,
 * rules and Markdown markup left out, each redacted and at most 160 characters. Escaping is the caller's.
 */
export function documentSummaryLines(markdown: string, max = 3): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) { fenced = !fenced; continue; }
    if (fenced || trimmed === "" || /^#{1,6}(\s|$)/.test(trimmed) || /^([-*_=]\s*){3,}$/.test(trimmed) || trimmed.startsWith("|")) continue;
    const plain = trimmed
      .replace(/^>+\s*/, "")
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|`)/g, "")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
    if (plain === "") continue;
    const redacted = hideEmailAddresses(redactText(plain));
    lines.push(redacted.length > SUMMARY_LINE_MAX ? `${redacted.slice(0, SUMMARY_LINE_MAX - 3).trimEnd()}...` : redacted);
    if (lines.length >= max) break;
  }
  return lines;
}

type Button = Record<string, unknown>;

/** The last owner decision, when it is what led to the current revision (it was recorded, then the step started). */
function leadingDecision(workflow: WorkflowSnapshot) {
  const latest = (workflow.decisions ?? []).at(-1);
  return latest !== undefined && latest.workflowRevision >= workflow.revision - 2 ? latest : undefined;
}

function checkCount(workflow: WorkflowSnapshot): number {
  return workflowSelectedChecks(workflow.checkPolicy).length;
}

/** Whether there are checks to retry: ones the task runs, or optional project checks the owner can choose. */
const checksConfigured = (workflow: WorkflowSnapshot) => checkCount(workflow) > 0 || (workflow.checkPolicy?.optional.length ?? 0) > 0;

/** The longest the plan card's line of proposed check labels may be, so the card stays brief. */
const PROPOSED_LINE_MAX = 400;

/**
 * The coding plan card's one line on checks: the labels of the checks AgentX proposed (escaped, as many as fit) and how
 * many the project requires, that none apply (review only, with the plan's reason, unless an optional check is chosen),
 * or that the proposal could not be read. Nothing for other documents or a task stored without a check policy.
 */
function planChecksLine(workflow: WorkflowSnapshot): string | undefined {
  const policy = workflow.checkPolicy;
  if (policy === undefined || workflowDocumentType(workflow) !== "plan") return undefined;
  if (policy.proposalNote !== undefined) return `${cleanLine(policy.proposalNote, 200)}.`;
  if (checkCount(workflow) === 0) {
    const reviewOnly = policy.optional.length > 0 ? "Review only unless you choose an optional check." : "Review only.";
    return policy.noneReason === undefined ? `No automated checks apply. ${reviewOnly}`
      : `No automated checks apply: ${cleanLine(policy.noneReason, 300).replace(/[.\s]+$/, "")}. ${reviewOnly}`;
  }
  const proposed = policy.proposed ?? [];
  const project = policy.required.length > 0 ? plural(policy.required.length, "project check") : "";
  if (proposed.length === 0) return `Checks: ${project}.`;
  const tail = project === "" ? "." : `; plus ${project}.`;
  // Room for ", and 8 more" when not every label fits.
  const reserve = ", and 8 more".length + tail.length;
  let line = "Checks proposed by AgentX: ";
  let listed = 0;
  for (const check of proposed) {
    const label = `${listed === 0 ? "" : ", "}${cleanLine(check.label, 80)}`;
    if (line.length + label.length + (listed + 1 < proposed.length ? reserve : tail.length) > PROPOSED_LINE_MAX) break;
    line += label;
    listed += 1;
  }
  return listed === proposed.length ? `${line}${tail}` : `${line}${listed === 0 ? "" : ","} and ${proposed.length - listed} more${tail}`;
}

/** The current code's reviews; older reviews describe code that is gone. */
function currentReviews(workflow: WorkflowSnapshot) {
  const current = workflow.candidate?.digest;
  return (workflow.reviews ?? []).filter((review) => current === undefined || review.candidateDigest === current);
}

function checkedAndPassing(workflow: WorkflowSnapshot): boolean {
  const current = workflow.candidate?.digest;
  return current !== undefined && workflow.verification?.candidateDigest === current
    && (workflow.verification.results ?? []).every((result) => result.status === "PASS");
}

/**
 * The owner's ways out of a step, as buttons, each naming the task and the revision it was offered at so a stale press
 * is refused. Close task is always last; it asks for confirmation before anything is discarded.
 */
function exitButtons(context: WorkflowMessageContext) {
  const { taskId, workflow } = context;
  const at = JSON.stringify({ taskId, revision: workflow.revision });
  const button = (actionId: string, label: string, options: { value?: string; primary?: boolean } = {}): Button => ({
    type: "button", action_id: actionId, text: { type: "plain_text", text: label }, value: options.value ?? at, ...(options.primary === true ? { style: "primary" } : {}),
  });
  const sendBack = (): Button[] => workflowSendBackOffered(workflow) ? [button("agentx_workflow_send_back", "Send back to coding", { primary: true })] : [];
  return {
    button,
    sendBack,
    /** Resolve findings opens the modal that answers each blocking review finding; it names the code the findings are about. */
    resolveFindings: (): Button[] => workflow.candidate === undefined ? []
      : [button("agentx_workflow_resolve_findings", "Resolve findings", { primary: true, value: JSON.stringify({ taskId, revision: workflow.revision, candidateDigest: workflow.candidate.digest }) })],
    close: button("agentx_workflow_close", "Close task"),
    // A required browser and API round can be retried with no project check to choose: the retry re-admits the approved round (`workflowReadmitsApplicationRound`).
    retryChecks: (label = "Choose checks and retry"): Button[] => checksConfigured(workflow) || workflowReadmitsApplicationRound(workflow)
      ? [button("agentx_workflow_retry_checks", checksConfigured(workflow) ? label : "Retry checks")] : [],
    retryReviews: (): Button[] => checkedAndPassing(workflow)
      ? [button("agentx_workflow_retry_reviews", "Retry reviews", { value: JSON.stringify({ taskId, revision: workflow.revision, candidateDigest: workflow.candidate?.digest }) })] : [],
    retryPublish: button("agentx_workflow_retry_publish", "Retry opening the pull request"),
  };
}

const link = (url: string, label: string) => `<${slackText(url)}|${label}>`;

/** The visible characters of a Slack text, the way the brief limit counts them: `<url|label>` reads as its label. */
const visibleLength = (text: string) => text.replace(/<([^<>|]*)\|([^<>]*)>/g, "$2").replace(/<([^<>|]+)>/g, "$1").length;

/** A card is brief: at most this many visible characters, button labels included. */
const CARD_BRIEF_LIMIT = 1_200;
const CARD_CLAIMS_SHOWN = 3;
/** The shortest a claim is cut to; with less room than this the claim is left out. */
const CLAIM_MIN_VISIBLE = 24;

/** The page's address for a document: the task page at that document and version. Never a link to a version alone. */
export function planReviewLink(taskPageUrl: string, workflow: Pick<WorkflowSnapshot, "path" | "reviewPhase">, version: number): string {
  const anchor = workflowDocumentName(workflow).replace(" ", "-");
  return pageDocumentLink(taskPageUrl, `doc=${anchor}&from=${version}`, anchor);
}

/**
 * UX2 slice 2 item 4: a link to one document on the task's page. On the app's task page (`/app/sessions/<id>`) it opens the document's tab (`#design` or `#plan`); the legacy page (a task with no session)
 * keeps its `?doc=` address.
 */
export function pageDocumentLink(page: string, query: string, anchor: string, documentName: string = anchor): string {
  if (page.includes("/app/sessions/")) return `${page}#${documentName.startsWith("design") ? "design" : "plan"}`;
  return `${page}?${query}#${anchor}`;
}

/** One claim as a quoted line, its indent kept (two spaces a level); escaped, one line, cut to `limit` characters. */
function claimLine(claim: string, limit: number): string {
  const indent = claim.length - claim.trimStart().length;
  return `>${" ".repeat(indent + 1)}${cleanLine(claim, limit)}`;
}

/**
 * The claims a structured card shows: as many of the ranked claims as fit in `room` visible characters (each cut to
 * 160), then "And N more claims." for those left out. The first claim is cut short before it is dropped.
 */
function structuredClaimLines(structured: NonNullable<WorkflowMessageContext["structured"]>, room: number): string[] {
  const candidates = structured.tiny ? structured.claims : structured.claims.slice(0, CARD_CLAIMS_SHOWN);
  const lines = candidates.map((claim) => claimLine(claim, SUMMARY_LINE_MAX));
  const moreLine = (shown: number) => (structured.claimCount > shown ? [`And ${plural(structured.claimCount - shown, "more claim")}.`] : []);
  const cost = (taken: string[], shown: number) => [...taken, ...moreLine(shown)].reduce((total, line) => total + visibleLength(line) + 1, 0);
  for (let shown = lines.length; shown > 0; shown -= 1) {
    const taken = lines.slice(0, shown);
    if (cost(taken, shown) <= room) return [...taken, ...moreLine(shown)];
  }
  // Not even one whole claim fits: cut the first to what is left, or leave claims out altogether.
  if (candidates.length > 0) {
    for (let limit = SUMMARY_LINE_MAX - 10; limit >= CLAIM_MIN_VISIBLE; limit -= 10) {
      const taken = [claimLine(candidates[0]!, limit)];
      if (cost(taken, 1) <= room) return [...taken, ...moreLine(1)];
    }
  }
  return moreLine(0).filter((line) => visibleLength(line) + 1 <= room);
}

/**
 * Plan 3, Task 34: the plan-ready lines for what the run is expected to cost: the range and the run limit, and, when the agent's max per run would stop the
 * run before its run limit, that. Dollars are written as they are (fifty-cent steps: `$1.5`, `$4`).
 */
function runEstimateLines(estimate: RunEstimate, agentName: string, workflow: WorkflowSnapshot): string[] {
  const lines = [`Estimated cost: about $${String(estimate.lowUsd)}\u2013$${String(estimate.highUsd)}. Run limit: $${String(estimate.runLimitUsd)}.`];
  if (estimate.stopAtUsd < estimate.runLimitUsd) lines.push(`${cleanLine(agentName, 60)}'s max per run is $${String(estimate.stopAtUsd)}, so this run will stop at $${String(estimate.stopAtUsd)}, before its run limit.`);
  // Plan 6 Task 7: a version 2 plan also says how long to a pull request, after the cost lines. Version 1 messages stay as recorded.
  if (estimate.minutes !== undefined && workflow.definitionVersion === "1.1.0") lines.push(`Estimated time: ${formatMinutes(estimate.minutes.low, estimate.minutes.high)} to a pull request.`);
  return lines;
}

/** PLANVIEW: what a plan card lists about the answers Approve takes and the checks the plan adds, within the same brief limit as every card. */
const CARD_CLAIMS_RESERVE = 190;
const CARD_DECISIONS_SHOWN = 3;
/** With checks to list too, only the first two decisions are spelled out (the rest read "And N more decisions"). */
const CARD_DECISIONS_WITH_CHECKS = 2;
const CARD_CHECK_LINES_SHOWN = 8;
const CARD_CHECK_LINE_MAX = 280;
const CARD_DECISION_QUESTION_MAX = 50;
const CARD_DECISION_ANSWER_MAX = 40;

/** The most plan-check lines a card spells out; the rest read "And N more" and are on the task page. */
const CARD_SELF_CHECK_SHOWN = 3;
const CARD_SELF_CHECK_LINE_MAX = 240;

/**
 * The lines an Approve in Slack must show, in what is left of the brief limit once the fixed lines and a claim's worth of
 * room are kept: the answer each decision gets (the owner sees them before approving), what AgentX's plan check says of the
 * plan (its findings, or that it was not checked), then up to 8 lines for the checks the plan adds, each with "And N more ..."
 * when some are left out. Every value is the plan's own text: `cleanLine` redacts, cuts and escapes it. A line that does not
 * fit is left out, never cut mid-sentence; the plan check and the checks are never both silent (a short notice stands in).
 */
export function structuredExtraLines(structured: NonNullable<WorkflowMessageContext["structured"]>, room: number): string[] {
  const out: string[] = [];
  const cost = (lines: readonly string[]) => lines.reduce((total, line) => total + visibleLength(line) + 1, 0);
  const takeUpTo = (lines: readonly string[], more: (taken: number) => string[], left: number): number => {
    for (let taken = lines.length; taken > 0; taken -= 1) {
      const block = [...lines.slice(0, taken), ...more(taken)];
      if (cost(block) <= left) { out.push(...block); return cost(block); }
    }
    return 0;
  };
  const checks = structured.checkLines ?? [];
  const checkLines = checks.slice(0, CARD_CHECK_LINES_SHOWN).map((line) => `• ${cleanLine(line, CARD_CHECK_LINE_MAX)}`);
  const checkMore = (taken: number) => (checks.length > taken ? [`And ${checks.length - taken} more on the task page.`] : []);
  // Never silent: when no check line fits, one line still says the plan adds checks and where they read.
  const notice = checks.length === 0 ? [] : [`This plan adds ${plural(checks.length, "check")}; read ${checks.length === 1 ? "it" : "them"} on the task page.`];
  const selfCheck = structured.selfCheckLines ?? [];
  const selfCheckLines = selfCheck.slice(0, CARD_SELF_CHECK_SHOWN).map((line) => `• ${cleanLine(line, CARD_SELF_CHECK_LINE_MAX)}`);
  const selfCheckMore = (taken: number) => (selfCheck.length > taken ? [`And ${plural(selfCheck.length - taken, "more plan check note")} on the task page.`] : []);
  const selfCheckNotice = selfCheck.length === 0 ? [] : ["AgentX's plan check: read its result on the task page."];
  // The decisions go first, but leave room for the first plan-check line (or its notice) and the first check line (or the notice).
  const firstSelfCheck = selfCheck.length === 0 ? 0 : cost([selfCheckLines[0]!, ...selfCheckMore(1)]);
  const reserveSelfCheck = selfCheck.length === 0 ? 0 : firstSelfCheck <= room ? firstSelfCheck : cost(selfCheckNotice);
  const firstCheck = checks.length === 0 ? 0 : cost([checkLines[0]!, ...checkMore(1)]);
  const reserveChecks = checks.length === 0 ? 0 : firstCheck <= room - reserveSelfCheck ? firstCheck : cost(notice);
  const decisions = structured.decisions ?? [];
  const shown = decisions.slice(0, checks.length === 0 ? CARD_DECISIONS_SHOWN : CARD_DECISIONS_WITH_CHECKS)
    .map((decision) => `• ${cleanLine(decision.id, 12)}: ${cleanLine(decision.question, CARD_DECISION_QUESTION_MAX)} Answer: ${cleanLine(decision.answer, CARD_DECISION_ANSWER_MAX)}`);
  const usedByDecisions = takeUpTo(shown, (taken) => (decisions.length > taken ? [`And ${plural(decisions.length - taken, "more decision")} on the task page.`] : []), room - reserveSelfCheck - reserveChecks);
  const usedBySelfCheck = takeUpTo(selfCheckLines, selfCheckMore, room - usedByDecisions - reserveChecks);
  // Never silent either: when no plan-check line fits, the notice stands in (the claims' reserve is what makes room for it).
  const usedNotice = usedBySelfCheck === 0 && selfCheck.length > 0 ? cost(selfCheckNotice) : 0;
  if (usedNotice > 0) out.push(...selfCheckNotice);
  const checksRoom = room - usedByDecisions - usedBySelfCheck - usedNotice;
  if (takeUpTo(checkLines, checkMore, checksRoom) === 0 && checks.length > 0) out.push(...notice);
  return out;
}

function planReview(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow, structured } = context;
  const name = workflowDocumentName(workflow);
  const document = workflow.artifacts.filter((artifact) => artifact.type === workflowDocumentType(workflow)).at(-1);
  const needsE2ECorrection = isE2EPlanCorrectionBlockReason(workflow.blockReason);
  const header = needsE2ECorrection
    ? `*${capitalized(name)}${document === undefined ? "" : ` v${document.version}`} needs changes before approval.* ${plainBlockReason(workflow.blockReason)}`
    : `*${capitalized(name)}${document === undefined ? "" : ` v${document.version}`} is ready for your approval.* ${workflow.candidate === undefined ? "No code has changed yet." : "The existing candidate is retained while this plan is reviewed."}`;
  // A raise is shown and confirmed only on the coding plan, and not where the design is decided on its card instead.
  const raise = context.designCardUrl === undefined && workflowDocumentType(workflow) === "plan" ? context.runLimitRaise : undefined;
  const decide = (decision: "APPROVE" | "REQUEST_CHANGES") => JSON.stringify({ taskId: context.taskId, revision: workflow.revision, digest: document?.sha256, decision,
    ...(decision === "APPROVE" && context.workBreakdownDigest !== undefined ? { workBreakdownDigest: context.workBreakdownDigest } : {}),
    ...(decision === "APPROVE" && raise !== undefined ? { runLimitUsd: raise.proposedUsd } : {}) });
  // A design under review is approved on its card only: the message links to that card ("Open in Rovara") and never offers an Approve the server refuses. A link button carries no value, so a press is not an action.
  const planOpen = context.designCardUrl === undefined && workflowDocumentType(workflow) === "plan" ? context.planOpen : undefined;
  const cardUrl = context.designCardUrl ?? planOpen?.url;
  const cardOnly = cardUrl !== undefined;
  const approve: Button = cardOnly
    ? { type: "button", action_id: "agentx_open_decision", text: { type: "plain_text", text: DECISION_LABELS.openInRovara }, url: cardUrl, style: "primary" }
    : exits.button("agentx_workflow_approve", raise === undefined ? `${DECISION_LABELS.approve} ${name}` : `${DECISION_LABELS.approve} ${name} and raise the limit to ${formatRunLimitUsd(raise.proposedUsd)}`, { value: decide("APPROVE"), primary: true });
  const decisions = document === undefined ? [exits.close] : needsE2ECorrection ? [
    exits.button("agentx_workflow_changes", DECISION_LABELS.requestChanges, { value: decide("REQUEST_CHANGES") }), exits.close,
  ] : [
    approve,
    exits.button("agentx_workflow_changes", DECISION_LABELS.requestChanges, { value: decide("REQUEST_CHANGES") }),
    exits.close,
  ];
  const tail: string[] = [];
  const checks = planChecksLine(workflow);
  if (checks !== undefined) tail.push(checks);
  if ((context.newReplies ?? 0) > 0) tail.push(`${plural(context.newReplies!, "thread reply", "thread replies")} since the last step will be included.`);
  const answered = context.commentAnswers;
  if (answered?.approvedOn !== undefined) {
    // Comments sent with the Approve of the document before: said only when the planner replied to some, linked to the first reply.
    if (answered.answered > 0) {
      const { document: approved, commentId, allOwners } = answered.approvedOn;
      const comments = `${allOwners ? "your " : ""}${plural(answered.total, "comment")}`;
      const line = `AgentX replied to ${answered.answered === answered.total ? "" : `${answered.answered} of `}${comments} on the ${approved}.`;
      tail.push(context.taskPageUrl === undefined || commentId === undefined ? line : link(pageDocumentLink(context.taskPageUrl, `doc=${approved.replace(" ", "-")}`, `comment-${commentId}`, approved), line));
    }
  } else if (answered !== undefined && answered.total > 0) tail.push(`AgentX answered ${answered.answered} of ${plural(answered.total, "comment")} from v${answered.fromVersion}.`);
  if (context.runEstimate !== undefined && workflowDocumentType(workflow) === "plan") tail.push(...runEstimateLines(context.runEstimate, context.agentName ?? "Rovara Code", workflow));
  // Plan 6 Task 8: what the second model made of a version 2 plan. Its words are the critic's, so each line is redacted, on one line, cut and escaped.
  if (workflow.definitionVersion === "1.1.0" && workflowDocumentType(workflow) === "plan") tail.push(...critiqueLines(workflow.critique, context.project ?? "this project").map((line) => cleanLine(line, 300)));
  // The owner can always reach the plan: when the document could not be shown or linked, the task page is, and an
  // administrator is named only when no task page exists at all.
  const unlinked = context.taskPageUrl === undefined
    ? `I couldn't link the full ${name}; ask an AgentX admin to check the task page.`
    : `I couldn't show the plan summary here. ${link(context.taskPageUrl, "Open the task page to read the plan")}`;
  if (structured === undefined) {
    // A Markdown document: its first lines, and where the whole text reads.
    const lines = [header];
    for (const line of (context.documentSummary ?? []).slice(0, 3)) lines.push(`> ${cleanLine(line, SUMMARY_LINE_MAX)}`);
    lines.push(...tail, context.documentLink === undefined ? unlinked : link(context.documentLink.url, `Read the full ${name}`));
    return { text: lines.join("\n"), buttons: decisions };
  }
  // Rovara Code version 2: the planner found that no code change is needed. The card gives the answer (a model's words, escaped for Slack) and says what the owner can do with it.
  if (structured.noChangeNeeded !== undefined && !needsE2ECorrection) {
    const lines = [slackText(maskForSlack(answeredMessage(structured.noChangeNeeded))), "", "Close it as answered, or ask for the change anyway: both are on the task page, and Request changes here asks for it too.",
      context.documentLink === undefined ? unlinked : link(context.documentLink.url, `Open the ${name}`)];
    return { text: lines.join("\n"), buttons: decisions };
  }
  // FR-036: what Approve in Slack takes. A tiny plan (FR-037) is approved in Slack as it is, so its card is unchanged.
  const approveLead = cardOnly ? [planOpen === undefined ? `Approve the ${name} on its card in Rovara.` : `This ${name} is ${planOpen.why} risk: approve it in Rovara${planOpen.why === "high" ? " after signing in again" : ""}.`] : structured.decisionCount > 0
    ? [`Approve here uses AgentX's answers for ${plural(structured.decisionCount, "decision")} and includes the open comments (up to 25) from the task page.`]
    : structured.tiny ? [] : ["Approve here includes the open comments (up to 25) from the task page."];
  // QA6-12b: the raise, in the owner's exact words, before the buttons; pressing Approve here confirms the new limit.
  const lead = !cardOnly && raise !== undefined ? [`${runLimitRaiseText(raise.currentUsd, raise.proposedUsd)}. Approve here confirms ${formatRunLimitUsd(raise.proposedUsd)} as the run limit.`, ...approveLead] : approveLead;
  tail.unshift(...lead);
  tail.push(context.documentLink === undefined ? unlinked : link(context.documentLink.url, structured.tiny ? `Open the ${name}` : `Open the full ${name}`));
  const buttons: Button[] = context.documentLink === undefined ? decisions
    : [{ type: "button", action_id: "agentx_open_review", text: { type: "plain_text", text: "Open review" }, url: context.documentLink.url }, ...decisions];
  // What is fixed (the buttons' labels count toward the limit too), then the claims that fit in what is left.
  const labels = buttons.reduce((total, button) => total + (button["text"] as { text: string }).text.length, 0);
  const fixed = [header, ...tail].reduce((total, line) => total + visibleLength(line) + 1, 0) + labels;
  // The decision answers and the checks come right after the line that says what Approve takes; the claims get the room they leave.
  const extras = structuredExtraLines(structured, Math.max(0, CARD_BRIEF_LIMIT - fixed - CARD_CLAIMS_RESERVE));
  const extrasCost = extras.reduce((total, line) => total + visibleLength(line) + 1, 0);
  return { text: [header, ...structuredClaimLines(structured, CARD_BRIEF_LIMIT - fixed - extrasCost), ...tail.slice(0, lead.length), ...extras, ...tail.slice(lead.length)].join("\n"), buttons };
}

function reviewBlocked(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const reviews = currentReviews(context.workflow);
  // The blocking findings still open: the change introduced them, they are not advisory, and the owner has not accepted them.
  const introduced = openReviewFindings(context.workflow);
  if (introduced.length > 0) {
    const older = reviews.reduce((total, review) => total + (review.findings ?? []).filter((finding) => typeof finding !== "string" && finding.origin === "PRE_EXISTING").length, 0);
    const lines = [`Reviews found ${plural(introduced.length, "issue")} in this change.`,
      ...introduced.slice(0, FINDINGS_SHOWN).map((finding) => {
        const where = finding.file === undefined ? "" : ` (${cleanLine(finding.file, 120)}${finding.line === undefined ? "" : `:${finding.line}`})`;
        return `• [${finding.role === "SECURITY" ? "security" : "code"}] ${cleanLine(finding.text, FINDING_TEXT_MAX)}${where}`;
      })];
    if (introduced.length > FINDINGS_SHOWN) lines.push(`And ${introduced.length - FINDINGS_SHOWN} more.`);
    if (older > 0) lines.push(`${older} older ${older === 1 ? "issue was" : "issues were"} noted but ${older === 1 ? "doesn't" : "don't"} block.`);
    if (workflowReviewsSawPartialDiff(context.workflow)) lines.push(PARTIAL_REVIEW);
    lines.push(...reviewModelNotes(context));
    if (context.findingsUrl !== undefined) lines.push(link(context.findingsUrl, "See all findings"));
    // Resolve findings answers up to 20 at once; with more open, only sending the whole change back to coding is left.
    const first = introduced.length <= WORKFLOW_RESOLVE_FINDINGS_MAX ? exits.resolveFindings() : exits.sendBack();
    return { text: lines.join("\n"), buttons: [...first, ...exits.retryReviews(), exits.close] };
  }
  const unfinished = reviews.filter((review) => ["UNKNOWN", "FAILED", "INTERRUPTED"].includes(review.status));
  const text = unfinished.length > 0
    ? `A review couldn't finish (${unfinished.map((review) => `${review.role === "SECURITY" ? "security" : "code"} review: ${plainReviewFailure(review.failureReason, review.status)}`).join("; ")}). Nothing was sent to GitHub.`
    : `${context.workflow.verification?.reviewOnly === true && workflowIsReviewOnly(context.workflow.checkPolicy) ? "No automated check applied, and" : "The checks passed, but"} the reviews couldn't finish. ${plainBlockReason(context.workflow.blockReason)} Nothing was sent to GitHub.`;
  return { text: [text, ...reviewModelNotes(context)].join("\n"), buttons: [...exits.retryReviews(), exits.close] };
}

function verifyBlocked(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow } = context;
  const e2eFailure = sendBackProblems(workflow).some((problem) => problem.source === "check"
    && problem.text.startsWith("required E2E verification failed for the current round"));
  if (e2eFailure && workflowSendBackOffered(workflow)) {
    return { text: "The required end-to-end verification failed for the current code. Send it back to coding, or close the task.",
      buttons: [...exits.sendBack(), exits.close] };
  }
  const verification = workflow.candidate !== undefined && workflow.verification?.candidateDigest === workflow.candidate.digest ? workflow.verification : undefined;
  const results = verification?.results ?? [];
  const failed = results.filter((result) => result.status === "FAILED");
  if (failed.length > 0) {
    const checks = [...(workflow.checkPolicy?.required ?? []), ...(workflow.checkPolicy?.proposed ?? []), ...(workflow.checkPolicy?.optional ?? [])];
    const labelOf = (result: { checkId: string }) => cleanLine(checks.find((check) => check.id === result.checkId)?.label ?? result.checkId, 80);
    // A check whose command could not run is not the code failing: rerunning or coding again won't help, so the owner
    // can remove that check or close the task.
    const allBroken = failed.filter(workflowCheckResultBroken);
    // A check whose process never started is not broken: it may start on a retry, so no project admin is needed.
    const unstarted = allBroken.filter((result) => result.neverStarted === true);
    const broken = allBroken.filter((result) => result.neverStarted !== true);
    const real = failed.filter((result) => !workflowCheckResultBroken(result));
    // A required project check can't be unticked: only a project admin can fix it, or the task is closed.
    const requiredIds = new Set((workflow.checkPolicy?.required ?? []).map((check) => check.id));
    const notInstalledFor = (group: typeof broken) => [...new Set(group.filter((result) => result.programNotFound === true)
      .flatMap((result) => checks.filter((check) => check.id === result.checkId).map((check) => cleanLine(check.command.executable, 80))))]
      .map((program) => ` ${program} is not installed on the AgentX worker.`).join("");
    const brokenRequired = broken.filter((result) => requiredIds.has(result.checkId));
    const brokenOther = broken.filter((result) => !requiredIds.has(result.checkId));
    const requiredNote = brokenRequired.length === 0 ? ""
      : `${brokenRequired.map((result) => `${labelOf(result)} is a project check and couldn't run; ask a project admin to fix it, or close the task.`).join(" ")}${notInstalledFor(brokenRequired)}`;
    const brokenLabels = brokenOther.map(labelOf).join(", ");
    const unstartedNote = unstarted.length === 0 ? ""
      : `${unstarted.map(labelOf).join(", ")} couldn't start on the AgentX worker this time. Choose checks and retry to run ${unstarted.length === 1 ? "it" : "them"} again, or close the task.`;
    if (real.length === 0) {
      const optional = brokenOther.length === 0 ? ""
        : `These checks couldn't run because the check itself is broken: ${brokenLabels}.${notInstalledFor(brokenOther)} Untick them with Choose checks and retry, or close the task.`;
      return { text: [optional, requiredNote, unstartedNote].filter((part) => part !== "").join(" "), buttons: [...exits.retryChecks(), exits.close] };
    }
    const brokenNote = brokenOther.length === 0 ? "" : ` Couldn't run because the check itself is broken: ${brokenLabels}.${notInstalledFor(brokenOther)}`;
    return { text: `${real.length} of ${plural(results.length, "check")} didn't pass: ${real.map(labelOf).join(", ")}.${brokenNote}${requiredNote === "" ? "" : ` ${requiredNote}`}${unstartedNote === "" ? "" : ` ${unstartedNote}`} Nothing was sent to GitHub.`,
      buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
  }
  if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.regressionFound) {
    const regressed = workflow.regressedChecks ?? [];
    const what = regressed.length === 0 ? plainBlockReason(workflow.blockReason)
      : `${regressed.length === 1 ? "This test passed before this change and fails" : "These tests passed before this change and fail"} now: ${regressed.map((test) => cleanLine(test, REGRESSED_TEST_MAX)).join(", ")}. Send it back to coding, or close the task.`;
    return { text: `${what} Nothing was sent to GitHub.`, buttons: [...exits.sendBack(), exits.close] };
  }
  // Rewritten history can't be checked again: a new task is the way on.
  if (workflow.blockReason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE) {
    return { text: `The code is written, but I couldn't run the checks. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.close] };
  }
  if (workflow.e2e?.required === true && workflow.e2e.currentRoundId !== undefined
    && workflow.blockReason?.startsWith("admitted E2E evidence is incomplete or unknown") === true) {
    // RUN-2: when every group ended with a code that has a fixed sentence, say why in those sentences (each distinct one once, three at most, then how many more), and offer Send back where the candidate
    // is the cause (`workflowSendBackOffered`). Any reason that is not exactly `group: code` keeps the one fixed text: nothing the worker said is ever repeated.
    const codes = [...new Set(workflowApplicationEvidenceCodes(workflow.blockReason) ?? [])];
    const sentences = codes.map((code) => E2E_OWNER_SENTENCES.groupSentence(code));
    if (codes.length > 0 && sentences.every((sentence) => sentence !== undefined)) {
      const more = sentences.length - 3;
      return { text: `The required browser and API checks could not finish. ${sentences.slice(0, 3).join(" ")}${more > 0 ? ` And ${more} more.` : ""} Nothing was sent to GitHub.`,
        buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
    }
    return { text: "The required E2E evidence is incomplete or unavailable. Some required runtime checks may not have run. Nothing was sent to GitHub.",
      buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
  }
  // Review only: no check runs, so the way on is coding again, or a check the owner chooses when the project has one.
  if (workflowIsReviewOnly(workflow.checkPolicy)) {
    const reason = REVIEW_ONLY_VERIFY_REASONS[workflow.blockReason ?? ""] ?? plainBlockReason(workflow.blockReason);
    return { text: `The code is written, but I couldn't pass it to review. ${reason} Send it back to coding, or close the task.`,
      buttons: [...exits.sendBack(), ...exits.retryChecks(), exits.close] };
  }
  return { text: `The code is written, but I couldn't run the checks. ${plainBlockReason(workflow.blockReason)}`,
    buttons: [...exits.retryChecks(), exits.close] };
}

function publishFailed(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>, failure: { category: string; codeChanged?: boolean | undefined }): { text: string; buttons: Button[] } {
  if (failure.codeChanged === true) {
    // Review only: there is no check to run again, so coding again is the way on.
    if (workflowIsReviewOnly(context.workflow.checkPolicy) && !checksConfigured(context.workflow)) {
      return { text: "The code changed after its reviews passed, so I didn't open the pull request. Send it back to coding, or close the task.",
        buttons: [...exits.sendBack(), exits.close] };
    }
    // Retrying the same publication would fail the same way: the way on is coding again, or checking the current code.
    return { text: "The code changed after its checks and reviews passed, so I didn't open the pull request. Send it back to coding, or run the checks again on the current code.",
      buttons: [...exits.sendBack(), ...((context.workflow.pullRequests?.length ?? 0) === 0 ? exits.retryChecks("Run checks again") : []), exits.close] };
  }
  return { text: `Checks and reviews passed, but I couldn't open the draft pull request (${plainPublishFailure(failure.category)}). The checked code is kept.`,
    buttons: [exits.retryPublish, exits.close] };
}

/** The owner's PR-feedback decision that led to this revision, when it kept the pull request as it is. */
function freshFeedbackAnswer(workflow: WorkflowSnapshot) {
  const latest = (workflow.feedbackDecisions ?? []).at(-1);
  return latest !== undefined && latest.decision !== "APPROVE" && latest.workflowRevision === workflow.revision - 1 ? latest : undefined;
}

function waitingForMerge(workflow: WorkflowSnapshot): string | undefined {
  const answer = freshFeedbackAnswer(workflow);
  if (answer?.decision === "REQUEST_CHANGES") return "Got it. I saved your note for the next round of PR feedback; the pull request stays as it is.";
  if (answer?.decision === "DISMISS" && answer.ownerNote === WORKFLOW_KEEP_PULL_REQUESTS_NOTE) return "Got it. The pull request stays as it is; I'll finish this task when it's merged.";
  if (answer?.decision === "DISMISS") return "PR feedback dismissed. The pull request stays as it is.";
  const required = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required);
  if (required.length === 0) return undefined;
  const name = (pullRequest: { url: string; number: number }) => link(pullRequest.url, `PR #${pullRequest.number}`);
  const merged = required.filter((pullRequest) => pullRequest.state === "MERGED").length;
  // Rovara Code (version 2, staging 0.4.11 Bug G): Merge is pressed in Rovara once a person has approved the pull request on GitHub.
  const tracked = workflow.definitionVersion === "1.1.0";
  const review = (many: boolean): string => (tracked
    ? `Approve ${many ? "the PRs" : "the PR"} on GitHub, then press Merge in Rovara; I'll finish this task when ${many ? "they're all" : "it's"} merged.`
    : `${many ? "Review them and merge them" : "Review it and merge it"} on GitHub; I'll finish this task when ${many ? "they're all" : "it's"} merged.`);
  if (merged === 0) {
    // Plan 6 Task 17: Rovara brought a pull request up to date with its base branch (a clean merge, not a fix).
    const synced = required.filter((pullRequest) => pullRequest.syncedFrom !== undefined);
    if (workflow.pullRequestUpdatedAt !== undefined && synced.length > 0) {
      return required.length === 1
        ? `Brought ${name(required[0]!)} up to date with its base branch. ${review(false)}`
        : `Brought ${pullRequestNames(synced, name)} up to date with the base branch. ${review(true)}`;
    }
    // After approved PR feedback, AgentX pushed the fixed code to the same pull requests.
    if (workflow.pullRequestUpdatedAt !== undefined) {
      return required.length === 1
        ? `Pushed the fix to ${name(required[0]!)}. ${review(false)}`
        : `Pushed the fix to ${pullRequestNames(required, name)}. ${review(true)}`;
    }
    return required.length === 1
      ? `Draft pull request opened: ${name(required[0]!)}. ${review(false)}`
      : `Draft pull requests opened: ${required.map(name).join(", ")}. ${review(true)}`;
  }
  const remaining = required.filter((pullRequest) => pullRequest.state !== "MERGED")
    .map((pullRequest) => `${name(pullRequest)} is still ${pullRequest.state === "CLOSED" ? "closed" : "open"}.`).join(" ");
  return `GitHub update: ${merged} of ${plural(required.length, "pull request")} merged. ${remaining}`.trim();
}

/** "PR #3", or "PRs #3 and #4" (and "PRs #3, #4 and #5"), each named by `name`. */
function pullRequestNames(pullRequests: ReadonlyArray<{ url: string; number: number }>, name: (pullRequest: { url: string; number: number }) => string): string {
  const sorted = [...pullRequests].sort((left, right) => left.number - right.number);
  if (sorted.length === 1) return name(sorted[0]!);
  const names = sorted.map((pullRequest) => name(pullRequest).replace("PR #", "#"));
  return `PRs ${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

/**
 * Said while a review of the pull requests' feedback starts: which pull requests, and how many different comments. The
 * same author posting the same text again counts once. Nothing is said once the owner has approved a fix.
 */
function feedbackReviewStarted(workflow: WorkflowSnapshot): string | undefined {
  const review = workflow.feedbackReview;
  if (review?.status !== "COLLECTING" || workflow.feedbackDispatchApproval !== undefined) return undefined;
  const comments = new Set(review.bundleRefs.flatMap((bundle) => bundle.comments.map((comment) => `${comment.author}\n${comment.bodyDigest}`)));
  if (comments.size === 0) return undefined;
  const opened = workflow.pullRequests ?? [];
  // A pull request the task opened is linked; one it did not open is named only.
  const pullRequests = review.bundleRefs.map((bundle) => ({ number: bundle.number,
    url: opened.find((pullRequest) => pullRequest.repositoryId === bundle.repositoryId && pullRequest.number === bundle.number)?.url ?? "" }));
  const names = pullRequestNames(pullRequests, (pullRequest) => (pullRequest.url === "" ? `PR #${pullRequest.number}` : link(pullRequest.url, `PR #${pullRequest.number}`)));
  return `Reviewing the feedback on ${names} (${plural(comments.size, "comment")}). I'll propose a fix here before changing any code.`;
}


/** The Retry review button of a failed PR feedback review's card. */
export const FEEDBACK_REVIEW_RETRY_ACTION = "agentx_feedback_review_retry";

/**
 * Why a PR feedback review failed, in the owner's words, by the check its stored reason names. The reason holds only
 * AgentX's own words, and this never shows it: an unknown reason reads as an answer that couldn't be read.
 */
export function feedbackReviewFailurePlainReason(blockReason: string | undefined, status?: string): string {
  const reason = blockReason ?? "";
  if (status === "INTERRUPTED" || /^review was cancelled/.test(reason)) return "the review was stopped before it finished";
  if (reason === "review timed out") return "the review timed out";
  if (/^candidate changed (?:before|during) review$/.test(reason)) return "the code changed during the review";
  if (reason === "review could not verify the exact candidate") return "the review couldn't check the code";
  if (/not accounted for|answered more than once|names a comment or bundle that was not supplied/.test(reason)) return "the reviewer didn't answer every comment";
  if (/^reviewer output: fixProposal\.(?:replacementChecks|obsoleteChecks)/.test(reason)) return "the reviewer proposed a check change AgentX can't use";
  if (/^reviewer output: .*fixProposal/.test(reason)) return "the reviewer's proposal was incomplete";
  // An answer that was read but broke a rule is named by the rule; only an answer that could not be read says so.
  if (/^reviewer output: finding \d+ is uncertain but not left for the owner$/.test(reason)) return "the reviewer was unsure but didn't leave the choice to you";
  if (/^reviewer output: (?:finding \d+ (?:field .+ is missing or invalid|does not have the required fields)|finding IDs are not unique)$/.test(reason)) return "the reviewer's answer was missing details";
  return "the reviewer's answer couldn't be read";
}

/**
 * A failed PR feedback review, said once by its report: which pull requests, why in plain words, and the owner's ways
 * on (Retry review here, or merge or close on GitHub). The button names the task, the step and the failed report, so a
 * stale press is refused.
 */
export function feedbackReviewFailedMessage(input: {
  taskId: string; revision: number; reviewDigest: string; blockReason: string | undefined;
  /** The report's status: anything but complete (failed, blocked, interrupted). */
  status?: string;
  pullRequests: ReadonlyArray<{ number: number; url: string }>;
}): WorkflowMessage {
  const names = pullRequestNames(input.pullRequests, (pullRequest) => (pullRequest.url === "" ? `PR #${pullRequest.number}` : link(pullRequest.url, `PR #${pullRequest.number}`)));
  const which = input.pullRequests.length === 1 ? "the pull request" : "the pull requests";
  const text = `I couldn't review the feedback on ${names}: ${feedbackReviewFailurePlainReason(input.blockReason, input.status)}. You can retry the review, or merge or close ${which} on GitHub.`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [{ type: "button", action_id: FEEDBACK_REVIEW_RETRY_ACTION, style: "primary", text: { type: "plain_text", text: "Retry review" },
        value: JSON.stringify({ taskId: input.taskId, revision: input.revision, reviewDigest: input.reviewDigest }) }] },
    ],
  };
}
/**
 * Why pushing the fix failed, in the owner's words, by its recorded cause, and what follows: the merge is still followed,
 * except after the pull request changed on GitHub (a merge of someone else's head never completes the task).
 */
const PULL_REQUEST_UPDATE_CAUSES: Record<string, { cause: string; then: string }> = {
  HEAD_MOVED: { cause: "it changed on GitHub since I opened it", then: "I've stopped following it, so merge or close it on GitHub and then close this task." },
  PUSH_REFUSED: { cause: "GitHub refused the push", then: STILL_WATCHING },
  // Plan 6 Task 17: the fix to a conflict would have dropped what the base branch brought.
  BASE_CHANGES_DROPPED: { cause: "the fix would have dropped changes the base branch made, so I didn't push it (a fix may change the files that conflicted, not a file the base changed without a conflict)", then: "Update the branch on GitHub, or close this task. I'll keep watching for the merge." },
};

/** The approved fix could not be pushed to the pull requests: which, and why, when AgentX knows. */
function pullRequestUpdateFailed(workflow: WorkflowSnapshot): string {
  const failure = workflow.pullRequestUpdateFailure;
  if (failure?.cause === "WORKER_OUTDATED") return `I couldn't push the fix because this AgentX worker is out of date. Ask an admin to run agentx upgrade. ${STILL_WATCHING}`;
  const failed = (workflow.pullRequests ?? []).filter((pullRequest) => failure?.numbers.includes(pullRequest.number) === true);
  if (failed.length === 0) return `${plainBlockReason(workflow.blockReason)} ${STILL_WATCHING}`;
  const cause = failure?.cause === undefined ? undefined : PULL_REQUEST_UPDATE_CAUSES[failure.cause];
  const names = pullRequestNames(failed, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
  return `I couldn't push the fix to ${names}${cause === undefined ? "" : `: ${cause.cause}`}. ${cause?.then ?? STILL_WATCHING}`;
}

/** The pull requests the fix is being pushed to: those already open that hold earlier code. */
function pushingFixTo(workflow: WorkflowSnapshot): string | undefined {
  const pending = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.candidateDigest !== workflow.candidate?.digest
    && (pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN"));
  return pending.length === 0 ? undefined : pullRequestNames(pending, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
}

/** AUTOFIX: the lines for what Rovara already tried and why it is asking, under a blocked card; nothing when automatic fixing is off or has nothing to add. */
/**
 * Whether the checks on this code are being run a second time: the owner pressed Retry checks, or Rovara retried them by itself, and the change was not sent back since (a send back is new code,
 * and its first run is a first run). The first run after coding has no such sign, so it must not say "again".
 */
function checksRunBefore(workflow: WorkflowSnapshot): boolean {
  const decisions = workflow.decisions ?? [];
  const last = decisions.at(-1);
  if (last?.source === "AUTO_RETRY" && last.auto?.stage === "VERIFY") return true;
  const retry = workflow.verificationRetries?.at(-1);
  return retry !== undefined && (last === undefined || retry.at > last.at);
}

function withAutoFix(context: WorkflowMessageContext, copy: { text: string; buttons: Button[] }): { text: string; buttons: Button[] } {
  const lines = context.autoFix === undefined ? [] : autoFixCardLines(context.workflow, context.autoFix.ask, fixSetupWording(context.workflow));
  return lines.length === 0 ? copy : { ...copy, text: `${copy.text}\n${lines.map(slackText).join("\n")}` };
}

function implementRunning(context: WorkflowMessageContext): string {
  const { workflow } = context;
  // Plan 6 Task 17: the first run of a conflict round says so, naming the files (the repository's own words, escaped); what the fix's own checks and reviews send back says what a send-back says.
  if (workflow.fixSource === "conflict" && sendBackProblems(workflow).length === 0) {
    const names = (workflow.fixProblems ?? []).map(slackText);
    return `The pull request's branch conflicts with the base branch${names.length === 0 ? "" : ` (${names.join(", ")})`}. Resolving it now; the checks and reviews run again after, and I'll push the merge if they pass.`;
  }
  // Plan 6 Task 15: the first run of a fix for failing CI says so, in the failing checks' own names (GitHub's words, escaped); what the fix's own checks and reviews send back says what a send-back says.
  if (workflow.fixSource === "ci" && sendBackProblems(workflow).length === 0) {
    const names = (workflow.fixProblems ?? []).map(slackText);
    const what = names.length === 0 ? "CI" : `the failing CI ${names.length === 1 ? "check" : "checks"} (${names.join(", ")})`;
    return `Fixing ${what}. The checks and reviews run again after, and I'll push the fix to the pull request if they pass.`;
  }
  const decision = leadingDecision(workflow);
  const feedback = (workflow.feedbackDecisions ?? []).at(-1);
  if (feedback?.decision === "APPROVE" && feedback.workflowRevision >= workflow.revision - 2 && (decision === undefined || feedback.at >= decision.at)) {
    // Plan 6 Task 16: a round Rovara decided itself says so and under which autonomy; it is never worded as the owner's approval.
    if (feedback.actorRole === "ROVARA_AUTONOMY" && feedback.autonomy !== undefined) {
      return `${feedbackDecidedByText(feedback.autonomy.level)}: the review comments are from people who can write to the repository, so I'm fixing them now. The checks and reviews run again after.`;
    }
    return "PR feedback approved. Updating the code now; the checks and reviews run again after.";
  }
  if (decision?.source === "AUTO_FIX") return "Rovara sent this back to coding by itself. Checks and reviews will run again after.";
  // Rovara Code version 2 (Task 12): a review round that found problems sends the work back on its own, and the thread says which round it is. It comes after the
  // approved PR feedback fix (above), and an owner's own send-back keeps its wording (below); a version 1 task, and a fix for CI, a conflict or comments, have no round.
  const round = workflowReviewRound(workflow);
  if (round !== undefined && decision?.source !== "SEND_BACK" && decision?.source !== "FINDINGS") return round.message;
  if (decision?.source === "SEND_BACK" || decision?.source === "FINDINGS") {
    const problems = sendBackProblems(workflow);
    const issues = problems.filter((problem) => problem.source !== "check").length;
    const checks = problems.length - issues;
    const what = [...(issues > 0 ? [plural(issues, "review issue")] : []), ...(checks > 0 ? [plural(checks, "failed check")] : [])].join(" and ");
    return `Sent back to coding with ${what === "" ? "your note" : what}. Checks and reviews will run again after.`;
  }
  if (decision?.decision === "APPROVE") {
    const count = checkCount(workflow);
    return `Coding plan approved${approvedBy(context, decision)}. Writing the code now${count > 0 ? `; then I'll run ${plural(count, "check")}` : ""}.`;
  }
  return "Trying the coding step again.";
}

/**
 * An approved PR feedback fix left the pull request's code as it was: nothing was pushed. The owner retries the fix, keeps
 * the pull request as it is (when its checked code is still the task's, the task simply waits for the merge again), or
 * closes the task. Either way the merge is still followed.
 */
function fixChangedNothing(context: WorkflowMessageContext, exits: ReturnType<typeof exitButtons>): { text: string; buttons: Button[] } {
  const { workflow } = context;
  const open = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "OPEN" || pullRequest.state === "UNKNOWN");
  const names = open.length === 0 ? "the pull request" : pullRequestNames(open, (pullRequest) => link(pullRequest.url, `PR #${pullRequest.number}`));
  const keep = workflowKeepPullRequestsOffered(workflow);
  return {
    text: `The approved fix didn't change any code, so nothing was pushed to ${names}. ${keep
      ? "Retry coding, keep the pull request as it is, or close the task."
      : `Retry coding, or close the task. ${STILL_WATCHING}`}`,
    buttons: [exits.button("agentx_workflow_retry_implementation", "Retry coding"),
      ...(keep ? [exits.button("agentx_workflow_keep_pull_requests", "Keep the pull request as it is")] : []), exits.close],
  };
}

/** " by @owner" when the task's owner made this approval and their Slack user is known; otherwise nothing. */
function approvedBy(context: WorkflowMessageContext, decision: { actorRole: string }): string {
  return context.ownerSlackUserId === undefined || decision.actorRole !== "TASK_OWNER" ? "" : ` by <@${context.ownerSlackUserId}>`;
}

/** T7c: said while the plan waits for its check on the current app (a few minutes). */
export const PLAN_GROUNDING_HOLD_LINE = "Checking the coding plan against the current app before asking you (a few minutes).";

function planRunning(context: WorkflowMessageContext): string {
  const { workflow } = context;
  const name = workflowDocumentName(workflow);
  const decision = leadingDecision(workflow);
  if (decision?.decision === "REQUEST_CHANGES") return `Got it. Revising the ${name} with your changes.`;
  // Plan 6 Task 8: the plan check sent the plan back to its planner (no person decided).
  if (workflow.critique !== undefined && workflow.critique.revisions > 0 && workflow.critique.critiques.length > 0 && workflow.critique.critiques.length <= workflow.critique.revisions) {
    return `A second model checked the ${name} and found problems. Revising the ${name}.`;
  }
  if (decision?.decision === "APPROVE" && workflow.path === "FULL") {
    const previous = workflow.reviewPhase === "DESIGN" ? "requirements" : "design";
    return `${capitalized(previous)} approved${approvedBy(context, decision)}. Writing the ${name} next.`;
  }
  return `Working on the ${name}. I'll post it here for your approval; nothing changes in the code until you approve.`;
}

/**
 * The message that gives an answered task's answer; a task whose answer can't be read still says that no code change was needed. The answer is a model's words about files it read, so it is
 * masked for Slack like the no-change findings are (a thread can be read by people who cannot see the task): `NAME=value` and opaque runs have their value hidden.
 */
function answeredText(workflow: WorkflowSnapshot): string {
  const answer = workflowAnswer(workflow);
  return answer === undefined ? "No code change is needed." : maskForSlack(answeredMessage(answer));
}

/** A step's refusal for a model the company or the project doesn't allow (Plan 3's words); shown as it is, escaped. */
const MODEL_REFUSAL = /^.{1,120}'s .{1,60} step uses [\w./:@-]{1,120}, which isn't allowed on .{1,80}\. Ask the agent's owner to pick another model\.$/u;

function copyOf(context: WorkflowMessageContext): { text: string; buttons: Button[] } | undefined {
  const { workflow } = context;
  const exits = exitButtons(context);
  const plain = (text: string | undefined) => (text === undefined ? undefined : { text, buttons: [] as Button[] });
  const passed = workflow.verification?.results.length;
  // Review only: no automated check applied, so nothing "passed".
  const reviewOnly = workflow.verification?.reviewOnly === true && workflowIsReviewOnly(workflow.checkPolicy);
  const allPassed = reviewOnly ? "No automated check applied." : passed === undefined ? "The checks passed." : passed === 1 ? "The check passed." : `All ${passed} checks passed.`;
  const checksAndReviewsPassed = reviewOnly ? "Reviews passed (no automated check applied)." : "Checks and reviews passed.";
  if (context.publishFailure !== undefined && workflow.stage === "PULL_REQUEST") return publishFailed(context, exits, context.publishFailure);
  switch (`${workflow.stage}/${workflow.state}`) {
    // Rovara Code version 2: Understand reads the request and the code first, and asks its questions (a model's words, escaped here; the thread's reply answers all of them) when it must.
    case "UNDERSTAND/WAITING": {
      const asked = workflow.intent?.assessment;
      return asked?.kind === "questions" ? plain(slackText(intentQuestionsMessage(asked.questions))) : undefined;
    }
    case "UNDERSTAND/RUNNING": return plain("Reading your request and the code before I plan. I'll ask a question here if I need one; nothing changes in the code until you approve a plan.");
    case "UNDERSTAND/BLOCKED": return { text: `I couldn't finish understanding this task. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.button("agentx_workflow_retry_plan", "Retry understanding"), exits.close] };
    case "PLAN/RUNNING": return plain(context.planGroundingHeld === true ? PLAN_GROUNDING_HOLD_LINE : planRunning(context));
    case "PLAN/BLOCKED": return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.planUnreadable
      ? planUnreadableText(context)
      : stoppedByOwner(workflow.blockReason) ? plainBlockReason(workflow.blockReason)
      : `I couldn't finish the ${workflowDocumentName(workflow)}. ${plainBlockReason(workflow.blockReason)}`,
      buttons: [exits.button("agentx_workflow_retry_plan", "Retry planning"), exits.close] };
    // Plan 6 Task 8: the plan check runs between the plan and its approval; the plan is posted once, after it. A check that stopped says so and can be closed.
    // Only a model the company chose for the check, and that it may not use, or a base whose rule files could not be verified (its fixed reason), blocks it; the rest of what can go wrong with the check lets the plan go on, unchecked.
    case "PLAN_CRITIQUE/BLOCKED": {
      const reason = workflow.blockReason;
      const said = reason !== undefined && MODEL_REFUSAL.test(reason) ? slackText(reason) : plainBlockReason(reason, "Rovara");
      const stopped = reason !== undefined && /^plan check operation ended (cancelled|interrupted)$/u.test(reason);
      return { text: stopped ? said : `The plan check stopped before it finished. ${said}`, buttons: [exits.button("agentx_workflow_retry_plan_check", "Retry plan check"), exits.close] };
    }
    case "PLAN_REVIEW/WAITING": return planReview(context, exits);
    // Only a task view shows this (never stored): the saved document failed its digest check, so it can't be approved.
    case "PLAN_REVIEW/BLOCKED": return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.documentUnverified
      ? `The saved ${workflowDocumentName(workflow)} couldn't be checked, so I stopped. Close this task and start again.`
      : `I stopped before your approval of the ${workflowDocumentName(workflow)}. ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.close] };
    case "IMPLEMENT/RUNNING": return plain(implementRunning(context));
    // Approving the plan needs someone else to accept its run limit (Task 34): the words say who, and coding starts once they do, so there is nothing to retry.
    case "IMPLEMENT/BLOCKED": if (workflow.blockReason !== undefined && isRunLimitBlockReason(workflow.blockReason)) return { text: slackText(workflow.blockReason), buttons: [exits.close] };
      if (workflow.blockReason === WORKFLOW_BLOCK_REASONS.fixChangedNothing) return fixChangedNothing(context, exits);
      // The run finished and no change was needed: what the agent found, then the choices (reply and Retry coding to ask for a change, or close). No tests were run and no pull request was opened, and nothing here says otherwise.
      if (isNoCodeChangedReason(workflow.blockReason)) return { text: noCodeChangedText(workflow.noChangeFindings, context.taskPageUrl), buttons: [exits.button("agentx_workflow_retry_implementation", "Retry coding"), exits.close] };
      // Live steer: the owner's live message asked for a change outside the approved plan and the plan can take it in: Revise the plan plans again with that change and the owner approves the revised plan before coding continues.
      if (workflowReviseOffered(workflow)) return { text: `Coding stopped before it finished. ${plainBlockReason(workflow.blockReason)}`,
        buttons: [exits.button("agentx_workflow_revise_plan", "Revise the plan", { primary: true }), exits.button("agentx_workflow_retry_implementation", "Retry coding"), exits.close] };
      // CANCELDUP: a stop the owner asked for already reads "Coding was stopped before it finished. Choose Retry ..."; saying it twice is noise.
      return { text: stoppedByOwner(workflow.blockReason) ? plainBlockReason(workflow.blockReason)
      : `Coding stopped before it finished. ${plainBlockReason(workflow.blockReason)}`,
      // Rewritten history can't be coded on again: a new task is the way on.
      buttons: workflow.blockReason === WORKFLOW_HISTORY_REWRITTEN_MESSAGE ? [exits.close] : [exits.button("agentx_workflow_retry_implementation", "Retry coding"), exits.close] };
    case "VERIFY/RUNNING": return plain(`Running the selected checks${checksRunBefore(workflow) ? " again" : ""} on the current code. No code is being changed.`);
    case "VERIFY/BLOCKED": return withAutoFix(context, verifyBlocked(context, exits));
    case "REVIEW/WAITING": return plain(`${allPassed} Starting the code and security reviews.`);
    case "REVIEW/RUNNING": return plain(`${allPassed} Code and security reviews are running on the ${reviewOnly ? "current" : "checked"} code.`);
    case "REVIEW/BLOCKED": return withAutoFix(context, reviewBlocked(context, exits));
    // The pull requests are already open after approved PR feedback: the fix is pushed to them. While it runs, nothing new is said.
    case "PULL_REQUEST/READY": case "PULL_REQUEST/RUNNING": {
      const pushing = pushingFixTo(workflow);
      if (pushing === undefined && workflow.state === "RUNNING") return undefined;
      return plain(`${checksAndReviewsPassed} ${pushing === undefined ? "Opening a draft pull request." : `Pushing the fix to ${pushing}.`}${partialReviewNote(workflow)}${reviewModelNotes(context).map((line) => `\n${line}`).join("")}`);
    }
    case "PULL_REQUEST/BLOCKED": return { text: `${checksAndReviewsPassed} ${plainBlockReason(workflow.blockReason)}`, buttons: [exits.retryPublish, exits.close] };
    // The owner can close the task while its pull request is open (the pull request stays on GitHub).
    case "WAIT_FOR_MERGE/WAITING": {
      const text = context.pullRequestReopened !== undefined ? pullRequestReopened(workflow, context.pullRequestReopened) : waitingForMerge(workflow);
      // UX2 slice 2: "press Merge in Rovara" carries the link to the task's page, where Merge is.
      const merge = workflow.definitionVersion === "1.1.0" && context.taskPageUrl !== undefined ? `\n${link(context.taskPageUrl, "Open the task in Rovara to merge")}` : "";
      return text === undefined ? undefined : { text: `${text}${merge}`, buttons: [exits.close] };
    }
    // The feedback review runs before anything is proposed; no button, as nothing is waiting on the owner yet.
    // Plan 6 Task 17: while the base branch is merged into the pull request's branch nothing is said (nothing the owner can act on, and a merge that changes nothing must not leave a message the thread never takes back).
    case "WAIT_FOR_MERGE/RUNNING": return plain(workflow.branchSync === undefined ? feedbackReviewStarted(workflow) : undefined);
    // Nothing on GitHub is retried from here: the owner closes the task (its pull request stays on GitHub). Only a changed
    // pull request ends the following; a failed feedback review or push leaves the merge still tracked.
    // Plan 6 Task 15: CI failing and a person needed (Rovara is set to suggest, three fixes did not help, or a fix changed nothing): the reason says it (its check name and log line are GitHub's words, escaped); Retry the fix is in the app.
    // Plan 6 Task 17: the branch still conflicts after the conflict rounds, or the base changed CI workflow files, which Rovara can't push: a person updates the branch on GitHub.
    case "WAIT_FOR_MERGE/BLOCKED": if (isCiFixBlockReason(workflow.blockReason) || isBranchSyncBlockReason(workflow.blockReason)) {
      // UX2 slice 2: "Retry the fix" is in the app: the line carries the link to the task's page.
      return { text: `${slackText(workflow.blockReason!)}${context.taskPageUrl === undefined ? "" : `\n${link(context.taskPageUrl, "Open the task in Rovara to retry")}`}`, buttons: [exits.close] };
    }
      return { text: workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestChanged
      ? `I stopped following the pull request. ${plainBlockReason(workflow.blockReason)}`
      : workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestClosed ? plainBlockReason(workflow.blockReason)
      : workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed ? pullRequestUpdateFailed(workflow)
        : `${plainBlockReason(workflow.blockReason)} ${STILL_WATCHING}`, buttons: [exits.close] };
    case "MERGED/COMPLETE": {
      // A Rovara Code (version 2) task says it as `Merged: <url>`, a line for each pull request (Plan 6 Task 20); version 1 keeps its words.
      const lines = workflow.definitionVersion === "1.1.0" ? mergedLines(workflow.pullRequests ?? []) : [];
      if (lines.length > 0) return plain(lines.join("\n"));
      const total = (workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required).length;
      return plain(total <= 1 ? "The pull request is merged. This task is complete." : `All ${total} pull requests are merged. This task is complete.`);
    }
    // A custom sequence with no pull request step ran every step: its changes stay in the workspace, and only closing the task gives it back.
    // A question that needed no code change: the answer, as a plain message (a model's words, escaped for Slack).
    case "CLOSED/COMPLETE": return plain(workflow.outcome === "ANSWERED" ? slackText(answeredText(workflow))
      : workflow.outcome === "REJECTED" ? "Closed without changes."
      : workflow.outcome === "PASSED" ? SEQUENCE_FINISHED_TEXT
      // A version 2 task whose Understand never came back in time was ended, and says why.
      : workflow.outcome === "CLOSED" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.understandTimedOut ? WORKFLOW_BLOCK_REASONS.understandTimedOut : "This task is closed.");
    default: return undefined;
  }
}

/** Slack section blocks hold 3,000 characters; a long text is split at a line break where it can be. */
export function slackSectionTexts(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > SECTION_TEXT_LIMIT) {
    // At a line break whenever one fits, so a line (a check's command, say) is never split; only a single line too long
    // for one section is split, at a safe place.
    const lineBreak = remaining.lastIndexOf("\n", SECTION_TEXT_LIMIT);
    const splitAt = lineBreak > 0 ? lineBreak : safeSplit(remaining, SECTION_TEXT_LIMIT);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Where to split one over-long line at or before `limit`: never inside an escaped character ("&lt;") and, when it can,
 * not inside a code span (before its opening backtick instead).
 */
function safeSplit(line: string, limit: number): number {
  let splitAt = limit;
  const amp = line.lastIndexOf("&", splitAt - 1);
  if (amp >= 0 && amp > splitAt - 10 && /^&[A-Za-z#0-9]{1,8};/.test(line.slice(amp)) && line.indexOf(";", amp) >= splitAt) splitAt = amp;
  const ticks = (line.slice(0, splitAt).match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    const opening = line.lastIndexOf("`", splitAt - 1);
    if (opening > 0) splitAt = opening;
  }
  return splitAt > 0 ? splitAt : limit;
}

/**
 * A card someone answered: its text kept, its buttons gone, and `note` (who chose what) beneath it. The text is the
 * card's own, already written for Slack; only a broadcast (`<!channel>`, `<!here>`) in it is made inert.
 */
export function answeredWorkflowCard(text: string, note: string): Array<Record<string, unknown>> {
  const inert = text.replaceAll("<!", "&lt;!");
  return [
    ...slackSectionTexts(inert).map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } })),
    { type: "context", elements: [{ type: "mrkdwn", text: note }] },
  ];
}

/**
 * What makes two posts the same post, so the thread hears it once: by default the step's revision. The merge step is
 * keyed by what it says (each required pull request's head and state), so a later revision that left them as they
 * were says nothing; opening the pull requests is said once per checked code. A planning run that the plan self-check sent back to the planner
 * (`planAutoRevisions` of them, each one revision on, nothing else changed) is the same run: it is keyed by the revision the run started at.
 */
export function workflowMessageKey(workflow: WorkflowSnapshot, options: { planAutoRevisions?: number } = {}): string {
  if (workflow.stage === "PLAN" && workflow.state === "RUNNING" && (options.planAutoRevisions ?? 0) > 0) return `revision:${workflow.revision - options.planAutoRevisions!}`;
  if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING" && freshFeedbackAnswer(workflow) === undefined) {
    return `merge:${(workflow.pullRequests ?? []).filter((pullRequest) => pullRequest.required)
      .map((pullRequest) => `${pullRequest.repositoryId}#${pullRequest.number}@${pullRequest.headSha ?? pullRequest.candidateDigest}=${pullRequest.state === "MERGED" ? "merged" : pullRequest.state === "CLOSED" ? "closed" : "open"}`)
      .join(",")}`;
  }
  // Pushing a fix to the pull requests already open says the same as getting ready to: said once per checked code.
  if (workflow.stage === "PULL_REQUEST" && (workflow.state === "READY" || workflow.state === "RUNNING")) return `opening:${workflow.candidate?.digest ?? workflow.revision}`;
  return `revision:${workflow.revision}`;
}

/** Said when a review saw only part of the change: its diff was too large to show in full. */
const PARTIAL_REVIEW = "The change was too large to show the reviewers in full, so they reviewed only part of it.";
/** The lines naming the model that reviewed the current code, and the same-model note when it was the build's (Rovara Code version 2 only; a model name is a report's text, so each line is cleaned). */
const reviewModelNotes = (context: Pick<WorkflowMessageContext, "workflow" | "reviewSameModel">): string[] => reviewModelLines(context.workflow, context.reviewSameModel === true).map((line) => cleanLine(line, 300));
const partialReviewNote = (workflow: WorkflowSnapshot) => (workflowReviewsSawPartialDiff(workflow) ? ` ${PARTIAL_REVIEW}` : "");

/**
 * Replies posted after the plan reach only a planning or coding step. Where none is next (the draft pull request is
 * open, or a step stopped), the post says they came in and where to read them; a step's own Send back, where it has
 * one, stays offered and gives them to the coder.
 */
function laterRepliesLine(context: WorkflowMessageContext): string | undefined {
  const { workflow } = context;
  const count = context.newReplies ?? 0;
  if (count === 0 || !(workflow.state === "BLOCKED" || (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING"))) return undefined;
  const page = context.taskPageUrl === undefined ? "see the task page" : `see ${link(context.taskPageUrl, "the task page")}`;
  return `${plural(count, "thread reply", "thread replies")} came in after the plan; ${page}.`;
}

/** The thread post for the task's current step, or undefined when this step has nothing to say. */
export function workflowMessage(context: WorkflowMessageContext): WorkflowMessage | undefined {
  const copy = copyOf(context);
  if (copy === undefined) return undefined;
  const replies = laterRepliesLine(context);
  // Design review (DR11): the first card of a task whose design is reviewed says so, and why, in plain text. Nothing is added for a task with no design review.
  const classification = designClassificationNoteOf(context.workflow);
  const text = [copy.text, replies, classification].filter((line): line is string => line !== undefined).join("\n");
  const buttons = context.peopleEnabled === true
    ? [...copy.buttons, { type: "button", action_id: "agentx_task_people", text: { type: "plain_text", text: "People" }, value: JSON.stringify({ taskId: context.taskId }) }]
    : copy.buttons;
  return {
    text,
    blocks: [
      ...slackSectionTexts(text).map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } })),
      ...(buttons.length === 0 ? [] : [{ type: "actions", elements: buttons }]),
    ],
  };
}
