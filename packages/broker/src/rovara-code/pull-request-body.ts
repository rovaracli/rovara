// Rovara Code (Plan 6 Task 13): the description of a version 2 task's pull request. It says what the approved plan set out to do, what changed, how it was tested, how the reviews went and how risky the
// code is, between markers that Rovara rewrites after every fix or sync, and it ends with the line that says a person approves and a person merges. The description is public to the repository's
// readers: every line that a model, a file name or a branch name wrote goes through `inertLine` (redacted, one line, no mention, link, image, cross-reference or hidden comment), every list is bounded,
// and the whole body stays under the byte cap with its markers, risk and closing line intact so it can always be regenerated in place.
import type { RiskAssessment, VerificationReport, WorkflowSnapshot } from "@agentx/contracts";
import { ROVARA_STATUS_END, ROVARA_STATUS_START } from "../developer/pull-request-feedback-section.js";
import { inertLine } from "./inert-text.js";
import { linearCloseLine, normalizeIssueKey } from "./linear-close.js";
import { assessRisk, riskHeading } from "./risk.js";
import { verificationReport, type ChangedFileEntry, type VerificationProject } from "./verification-report.js";

export { ROVARA_STATUS_START, ROVARA_STATUS_END };

export const ROVARA_PULL_REQUEST_CLOSING = "Opened by Rovara after the approved plan, checks and reviews. A person must approve it and a person merges it.";

/** The most bytes a description holds. */
export const PULL_REQUEST_BODY_MAX_BYTES = 30_000;
/** The most bytes of the plan summary at the top. */
const SUMMARY_MAX_BYTES = 6_000;
const SUMMARY_LINE_MAX = 500;
const ITEM_MAX = 200;
/** How many entries each list shows before it says "and N more"; the body tries these in turn until it fits. */
const LIST_LIMITS = [20, 10, 5, 2, 0] as const;

/** The changed files of a task and whether the list is whole (it is not when the diff couldn't be read in full). */
export interface ChangedFilesRead {
  files: readonly ChangedFileEntry[];
  complete: boolean;
}

/** What the description needs beyond the workflow. */
export interface PullRequestBodyContext {
  /** Absent: the list of changed files could not be read. */
  changedFiles?: ChangedFilesRead | undefined;
  /** How the pull request's CI is judged (from the tracked pull request). */
  ciBasis?: "required" | "all_checks" | undefined;
  /** The base branch's name, for the all-checks line. */
  baseBranch?: string | undefined;
  /** The Linear issue key the task's session follows (Plan 6 Task 20): the block then says `Fixes <KEY>`, which Linear's GitHub integration closes the issue on. Anything that is not a key is ignored. */
  linearIssueKey?: string | undefined;
}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** The code reviewer's level for the workflow's current code, when it gave one. */
function reviewerRiskOf(workflow: WorkflowSnapshot): RiskAssessment["level"] | undefined {
  const current = workflow.candidate?.digest;
  const reviews = (workflow.reviews ?? []).filter((review) => review.role === "CRITIC" && review.candidateDigest === current);
  return reviews.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]?.risk;
}

/** The risk of the workflow's current code, from the files, the report, the findings and the reviewer. Undefined without a candidate. */
export function assessWorkflowRisk(workflow: WorkflowSnapshot, read: ChangedFilesRead | undefined, project: VerificationProject): RiskAssessment | undefined {
  const digest = workflow.candidate?.digest;
  if (digest === undefined) return undefined;
  const files = read?.files ?? [];
  const reviewerRisk = reviewerRiskOf(workflow);
  const securityFindings = (workflow.reviews ?? [])
    .filter((review) => review.role === "SECURITY" && review.candidateDigest === digest)
    .reduce((count, review) => count + review.findings.filter((finding) => finding.origin === "INTRODUCED").length, 0);
  return assessRisk({
    changedFiles: files, changedFilesComplete: read?.complete === true, report: verificationReport(workflow, files, project),
    acceptedFindings: (workflow.acceptedFindings ?? []).filter((finding) => finding.candidateDigest === digest).map((finding) => ({ role: finding.role })),
    securityFindings, ...(reviewerRisk === undefined ? {} : { reviewerRisk }), candidateDigest: digest,
  });
}

/**
 * The workflow with its risk recomputed for its current code. Call it whenever the candidate changes (the pull request opens, a fix or a sync is pushed). A version 1 task shows no risk level and is
 * returned as it is.
 */
export function recomputeRisk(workflow: WorkflowSnapshot, read: ChangedFilesRead | undefined, project: VerificationProject): WorkflowSnapshot {
  if (workflow.definitionVersion !== "1.1.0") return workflow;
  const risk = assessWorkflowRisk(workflow, read, project);
  return risk === undefined ? workflow : { ...workflow, risk };
}

/** The risk the description shows: computed from the files when they are known, else the one recorded for this very code, else computed without the files (never low). */
function riskShown(workflow: WorkflowSnapshot, context: PullRequestBodyContext): RiskAssessment | undefined {
  if (context.changedFiles === undefined && workflow.risk !== undefined && workflow.risk.candidateDigest === workflow.candidate?.digest) return workflow.risk;
  return assessWorkflowRisk(workflow, context.changedFiles, { ...(context.ciBasis === undefined ? {} : { ciBasis: context.ciBasis }) });
}

const more = (count: number, listed: number) => (count > listed ? ` and ${count - listed} more` : "");

/** `a; b; c and 2 more`, each entry inert and cut. */
function joined(items: readonly string[], limit: number): string {
  const listed = items.slice(0, limit).map((item) => inertLine(item, ITEM_MAX));
  return `${listed.join("; ")}${more(items.length, listed.length)}`;
}

function changedLines(context: PullRequestBodyContext, limit: number): string[] {
  const read = context.changedFiles;
  if (read === undefined) return ["Rovara couldn't list the changed files."];
  if (read.files.length === 0) return [read.complete ? "No changed files were listed." : "Rovara couldn't list the changed files."];
  // A file the diff gave no count for is unknown, not 0 lines: the totals say "at least" and the file says it was not counted.
  const uncounted = read.files.filter((file) => file.added === undefined || file.removed === undefined).length;
  const added = read.files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = read.files.reduce((total, file) => total + (file.removed ?? 0), 0);
  const repositories = new Set(read.files.map((file) => file.repository));
  const countedFiles = read.files.length - uncounted;
  const counts = uncounted === 0 ? `+${added} -${removed}`
    : countedFiles === 0 ? "lines not counted"
      : `at least +${added} -${removed}; ${uncounted} ${uncounted === 1 ? "file" : "files"} not counted`;
  return [
    `${read.files.length}${read.complete ? "" : " or more"} file${read.files.length === 1 ? "" : "s"} changed (${counts})${read.complete ? "" : "; the list may be incomplete"}.`,
    ...read.files.slice(0, limit).map((file) => {
      const size = file.added === undefined || file.removed === undefined ? "lines not counted" : `+${file.added} -${file.removed}`;
      const moved = file.renamedFrom === undefined ? "" : ` renamed from ${inertLine(file.renamedFrom, ITEM_MAX)}`;
      return `- ${repositories.size > 1 ? `${inertLine(file.repository, 60)}: ` : ""}${inertLine(file.path, ITEM_MAX)}${moved} (${size})`;
    }),
    ...(read.files.length > limit && limit > 0 ? [`- and ${read.files.length - limit} more`] : []),
  ];
}

function testLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext, limit: number): string[] {
  const report: VerificationReport = verificationReport(workflow, context.changedFiles?.files ?? [], { ...(context.ciBasis === undefined ? {} : { ciBasis: context.ciBasis }) });
  const base = context.baseBranch === undefined || context.baseBranch.trim() === "" ? "the base branch" : inertLine(context.baseBranch, 100);
  const lines: string[] = [];
  if (report.ciBasis === "all_checks") lines.push(`Checked against every check on this branch, because ${base} has no required checks.`);
  if (report.passed.length > 0) lines.push(`- Passed: ${joined(report.passed.map((item) => item.label), limit)}`);
  if (report.failed.length > 0) lines.push(`- Failed: ${joined(report.failed.map((item) => `${item.label} (${item.summary})`), limit)}`);
  if (report.notChecked.length > 0) lines.push(`- Not checked: ${joined(report.notChecked.map((item) => `${item.label} (${item.reason})`), limit)}`);
  if (report.passed.length + report.failed.length + report.notChecked.length === 0) lines.push("- No checks were recorded for this code.");
  const added = report.testsAdded.map((item) => item.path);
  if (context.changedFiles === undefined) lines.push("- Tests added: Rovara couldn't list the changed files, so it can't say.");
  else if (added.length === 0) lines.push(`- Tests added: none${context.changedFiles.complete ? "" : " (the list of changed files may be incomplete)"}`);
  else lines.push(`- Tests added: ${joined(added, limit)}${context.changedFiles.complete ? "" : " (the list of changed files may be incomplete)"}`);
  return lines;
}

/**
 * The lines between the markers: What changed, Tests, Reviews and Risk, about the code now on the pull request. `reviewLines(listed)` gives the Reviews section's lines (at most `listed` accepted
 * findings named). The lists shrink until the block fits `budgetBytes`.
 */
export function rovaraStatusLines(workflow: WorkflowSnapshot, context: PullRequestBodyContext, reviewLines: (listed: number) => string[], budgetBytes = PULL_REQUEST_BODY_MAX_BYTES - SUMMARY_MAX_BYTES - 2_000): string[] {
  const risk = riskShown(workflow, context);
  const linearKey = normalizeIssueKey(context.linearIssueKey);
  let lines: string[] = [];
  for (const limit of LIST_LIMITS) {
    lines = [
      "## What changed", ...changedLines(context, limit), "",
      "## Tests", ...testLines(workflow, context, limit), "",
      "## Reviews", ...reviewLines(limit), "",
      `## Risk: ${riskHeading(risk?.level ?? "medium")}`, ...(risk?.reasons ?? ["Rovara couldn't assess this change."]).map((reason) => `- ${inertLine(reason, ITEM_MAX)}`),
      ...(linearKey === undefined ? [] : ["", linearCloseLine(linearKey)]),
    ];
    if (byteLength(lines.join("\n")) <= budgetBytes) return lines;
  }
  return lines;
}

/** The plan summary lines, each inert and cut, within their byte budget. */
function summaryOf(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const text = inertLine(line, SUMMARY_LINE_MAX);
    if (text === "") continue;
    bytes += byteLength(text) + 1;
    if (bytes > SUMMARY_MAX_BYTES) break;
    kept.push(text);
  }
  return kept;
}

/**
 * The description of a version 2 task's pull request: the plan summary (or the task's title), the marked block, the session link and the closing line. At most 30,000 bytes: the lists shrink first, and the
 * markers, the risk and the closing line always stay.
 */
export function rovaraPullRequestBody(input: {
  summary: readonly string[];
  fallbackTitle: string;
  workflow: WorkflowSnapshot;
  context: PullRequestBodyContext;
  reviewLines: (listed: number) => string[];
  pageUrl: string | undefined;
}): string {
  // The plan's words are a model's: they sit under their own heading as a quotation (a quotation holds a heading, a fence or a rule inside it), so they cannot pose as one of Rovara's sections.
  const summary = summaryOf(input.summary);
  const quoted = (summary.length > 0 ? summary : [inertLine(input.fallbackTitle, SUMMARY_LINE_MAX)]).map((line) => `> ${line}`);
  const head = ["## Plan summary", ...quoted];
  const tail = [...(input.pageUrl === undefined ? [] : [`Rovara session: ${input.pageUrl}`, ""]), ROVARA_PULL_REQUEST_CLOSING];
  const assemble = (headLines: readonly string[], block: readonly string[]) => [...headLines, "", ROVARA_STATUS_START, ...block, ROVARA_STATUS_END, ...tail].join("\n");
  const fixed = byteLength(assemble(head, []));
  const block = rovaraStatusLines(input.workflow, input.context, input.reviewLines, PULL_REQUEST_BODY_MAX_BYTES - fixed);
  // The block's budget leaves room for the summary at its largest, and the block at its shortest (no list entries) is a few kilobytes, so this always fits.
  return assemble(head, block);
}
