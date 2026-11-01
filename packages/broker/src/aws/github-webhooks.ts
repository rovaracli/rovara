import { createHash, randomUUID } from "node:crypto";
import { verifyGithubWebhookSignature } from "../plugins/code-host/github/signature.js";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { WORKFLOW_BLOCK_REASONS, WorkflowFeedbackBundleSchema, WorkflowFeedbackBundleCommentsSchema, WorkflowFeedbackBundleRefSchema, WorkflowSnapshotSchema, collectWorkflowFeedbackBundles, type OrgId, type WorkflowFeedbackBundle, type WorkflowFeedbackBundleRef, type WorkflowFeedbackThreadObservation, observeWorkflowPullRequest, observeWorkflowPullRequestMergedWithFix, recordWorkflowPullRequestHeadTrees, recordWorkflowPullRequestUpdate, workflowFollowsOnlyMerge, type WorkflowSnapshot, type AuditEventInput, auditPullRequestId, projectMonthStatsKey } from "@agentx/contracts";
import { auditOccurrence, auditPullRequestMerged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { type GithubWorkflowPullRequestRecord } from "../developer/task-records.js";
import { findLegacyGithubLink, findLinkedChangeRequest } from "../rovara-code/linked-change-requests.js";
import { parseGitHubRepository, type GitHubPullRequestFeedback } from "../github-app.js";
import { isConditional } from "./broker-shared.js";
import { failedIndexes, isTransactionConflict } from "../agents/table-writes.js";
import type { InstallationCreatedPayload } from "../org/github-install-requests.js";
import type { InstallationLifecycleEvent } from "../org/github-connection.js";
import { feedbackReopenedMeasure, type FeedbackReviewMeasure } from "../developer/feedback-review-measures.js";
import { mergedMilestoneItems } from "../rovara-code/merged.js";
import { mergedStateItems } from "../rovara-code/merged-state.js";

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GitHubWebhookPayloadSchema = z.object({
  action: z.string().min(1).max(80),
  installation: z.object({ id: z.number().int().positive() }).passthrough(),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(300) }).passthrough(),
  issue: z.object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]).optional(), pull_request: z.object({ url: z.string().url() }).passthrough().optional() }).passthrough().optional(),
  pull_request: z.object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]).optional(), merged: z.boolean().optional(),
    head: z.object({ sha: z.string() }).passthrough().optional() }).passthrough().optional(),
  review: z.object({ id: z.number().int().positive(), body: z.string().max(65_536).nullable().optional(), html_url: z.string().url(), updated_at: z.string().datetime().optional(), user: z.object({ login: z.string().min(1).max(100) }).passthrough() }).passthrough().optional(),
  comment: z.object({ id: z.number().int().positive(), body: z.string().max(65_536).nullable().optional(), html_url: z.string().url(), updated_at: z.string().datetime().optional(), path: z.string().max(500).optional(), line: z.number().int().positive().optional(), diff_hunk: z.string().max(8_000).optional(), user: z.object({ login: z.string().min(1).max(100) }).passthrough() }).passthrough().optional(),
}).passthrough();

/** A `check_suite`, `check_run` or `status` delivery: it names a commit, not a pull request. Everything is read from GitHub again after it; the body only says which commit. */
const HeadEventPayloadSchema = z.object({
  installation: z.object({ id: z.number().int().positive() }).passthrough(),
  repository: z.object({ id: z.number().int().positive(), full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(300) }).passthrough(),
  action: z.string().min(1).max(80).optional(),
  sha: z.string().optional(),
  branches: z.array(z.object({ name: z.string().max(255) }).passthrough()).max(100).optional(),
  check_suite: z.object({ head_sha: z.string(), head_branch: z.string().max(255).nullable().optional() }).passthrough().optional(),
  check_run: z.object({ head_sha: z.string(), check_suite: z.object({ head_branch: z.string().max(255).nullable().optional() }).passthrough().optional() }).passthrough().optional(),
}).passthrough();

const HEAD_EVENT_NAMES: ReadonlySet<string> = new Set(["check_suite", "check_run", "status"]);
const COMMIT_SHA = /^[a-f0-9]{40}$/;
/** The branch Rovara opens its pull requests from. */
const ROVARA_BRANCH = /^agentx\/[A-Za-z0-9._-]{1,200}$/;

const COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);
const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "edited", "closed", "synchronize", "ready_for_review", "converted_to_draft"]);
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);
const MAX_REVIEW_COMMENT_CHARS = 8_000;
export const GITHUB_WEBHOOK_RECOVERY_INDEX = "github-webhook-recovery";
const GITHUB_WEBHOOK_RECOVERY_PK = "GITHUB_WEBHOOK_RECOVERY";
const MAX_WEBHOOK_ATTEMPTS = 8;

/** The events (GitHub's `X-GitHub-Event` names) that can start a trigger, as well as being, for pull requests, feedback on a linked task. A `push` is not a trigger: it is a meta repo's config changing (meta-repo/config-import.ts). */
export const GITHUB_TRIGGER_EVENT_NAMES: ReadonlySet<string> = new Set(["pull_request", "issues", "deployment_status", "workflow_run", "push"]);

export const GITHUB_WEBHOOK_SIGNATURE_INVALID = "GitHub webhook signature is invalid";

export class GithubWebhookRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubWebhookRefusal";
  }
}

/**
 * A signed delivery that nothing of the pull request feedback path can use: an event type it does not follow, a body it cannot read, or a repository that is not a linked
 * task's. Where trigger events are handled (`handleGithubWebhook`'s `triggerEvents`) it is answered 202 and ignored; elsewhere it is the refusal it always was.
 */
export class GithubWebhookIgnorable extends GithubWebhookRefusal {
  /** Set when the delivery was verified and reserved nothing: a check or status event no task follows. It is answered 202 IGNORED whether or not triggers are set up. */
  ignoredDeliveryId?: string;
  constructor(message: string) {
    super(message);
    this.name = "GithubWebhookIgnorable";
  }
}

/** Transient delivery conflicts must receive a retryable response, not an authorization refusal. */
export class GithubWebhookRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubWebhookRetryableError";
  }
}

export interface ReceiveGithubWebhookInput {
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  /**
   * Whether the delivery's repository is one a task follows through this installation. A pull request event names the pull request; a check or status event names a
   * commit (`headSha`, and a Rovara branch it was on, when it says): either way the answer is the caller's own check against what Rovara recorded.
   */
  authorizeRepository(scope: { installationId: number; repositoryId: number; fullName: string; pullRequestNumber: number } | { installationId: number; repositoryId: number; fullName: string; headSha: string; branch?: string }): Promise<boolean>;
  reserveDelivery(delivery: { deliveryId: string; installationId: number; repositoryId: number; eventHash: string; event: ReceivedGithubWebhook["event"] }): Promise<"reserved" | "retry" | "duplicate" | "conflict">;
  /**
   * Called once the signature, the delivery id and the JSON have been checked, before the event is looked at: the one place a delivery's verified body is handed on. It is how
   * trigger events share this function's verification instead of repeating it. When it is given, an event type this function does not follow is not refused until it has run.
   */
  onVerified?(verified: { eventName: string | undefined; deliveryId: string; payload: unknown }): Promise<void>;
}

/** A check or status delivery for a commit: only a nudge. The tracking pass that follows reads GitHub itself. */
export interface HeadWebhookEvent {
  kind: "HEAD_STATUS";
  action: string;
  installationId: number;
  repositoryId: number;
  fullName: string;
  headSha: string;
  /** The Rovara branch (`agentx/...`) the event names, when it names one: a second way to find the task. */
  branch?: string;
}

export interface ReceivedGithubWebhook {
  delivery: "ACCEPTED" | "DUPLICATE";
  deliveryId: string;
  event: PullRequestWebhookEvent | HeadWebhookEvent;
}

export interface PullRequestWebhookEvent {
    kind: "PULL_REQUEST" | "PR_COMMENT";
    action: string;
    installationId: number;
    repositoryId: number;
    fullName: string;
    number: number;
    /** A push to the pull request (synchronize): the head GitHub says it now has. A hint, checked against GitHub's own read. */
    headSha?: string;
    comment?: { id: number; body: string; truncated: boolean; url: string; author: string; updatedAt?: string; path?: string; line?: number; diffHunk?: string; source: "review" | "review_comment" | "pr_discussion" };
}

/** Looks up only an already-published PR; webhooks cannot associate arbitrary GitHub work with a task. Reads the link as it was written before P6 (the old GitHub row). */
export async function findLinkedGithubWorkflowPullRequest(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  repositoryFullName: string;
  number: number;
}): Promise<GithubWorkflowPullRequestRecord | undefined> {
  return findLegacyGithubLink({ documentClient: input.documentClient, tableName: input.tableName }, input);
}

/** Requires the PR index, live workflow snapshot, pinned project repo and GitHub App identity to agree. */
export async function authorizeLinkedGithubWebhook(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  scope: { installationId: number; repositoryId: number; fullName: string; pullRequestNumber: number };
  loadTask(taskId: string): Promise<{ project: string; startingRevision: number; orgId?: OrgId | undefined; workflow?: {
    stage: string;
    state?: string | undefined;
    blockReason?: string | undefined;
    candidate?: { digest: string } | undefined;
    pullRequests?: Array<{ repositoryId: string; number: number; url: string; candidateDigest: string }> | undefined;
  } | undefined } | undefined>;
  repositoryUrl(projectName: string, revision: number, repositoryId: string, orgId?: OrgId): Promise<string | undefined>;
  verifyRepository(url: string, scope: { installationId: number; repositoryId: number; fullName: string }): Promise<boolean>;
}): Promise<boolean> {
  // P6: the link is read from the neutral row, then the old GitHub row.
  const linked = await findLinkedChangeRequest(
    { documentClient: input.documentClient, tableName: input.tableName },
    { hostKind: "github", repositoryAddress: `https://github.com/${input.scope.fullName}`, id: String(input.scope.pullRequestNumber) },
  );
  if (linked === undefined) return false;
  const task = await input.loadTask(linked.taskId);
  const workflow = task?.workflow;
  if (task === undefined || workflow === undefined || !tracksLinkedPullRequests(workflow)
    || !workflow.pullRequests?.some((pullRequest) => pullRequest.repositoryId === linked.repositoryId
      && pullRequest.number === linked.number && pullRequest.url === linked.url
      && pullRequest.candidateDigest === linked.candidateDigest)) return false;
  const repositoryUrl = await input.repositoryUrl(task.project, task.startingRevision, linked.repositoryId, task.orgId);
  if (repositoryUrl === undefined) return false;
  return input.verifyRepository(repositoryUrl, {
    installationId: input.scope.installationId,
    repositoryId: input.scope.repositoryId,
    fullName: input.scope.fullName,
  });
}

/**
 * Whether the task follows its linked pull requests: from the first one opened until the task closes, in every stage (an
 * approved fix being coded, checked, reviewed or pushed included). Each linked pull request is matched by the reviewed code
 * it was recorded with, so a merge of the head GitHub has is observed in every one of these.
 */
function tracksLinkedPullRequests(workflow: { stage: string; pullRequests?: readonly unknown[] | undefined }): boolean {
  return workflow.stage !== "CLOSED" && (workflow.pullRequests ?? []).length > 0;
}

/** An approved fix's push that was taken for failed but that GitHub shows landed on a linked pull request. */
export interface LandedFixPush {
  workspaceId: string; repositoryId: string; repositoryFullName: string; number: number; url: string;
  headSha: string; previousHeadSha: string; candidateDigest: string; previousCandidateDigest: string; state: "open";
}

export interface ReconcileTaskPullRequestFeedbackInput {
  documentClient: { send(command: unknown): Promise<unknown> }; tableName: string;
  repositoryFullName: string; number: number; deliveryId: string;
  /** Broker-local bounded polling mode; omitted callers retain the full feedback behavior. */
  observationMode?: "feedback" | "merge";
  /** B8: in-memory identity only, after a successful reconcile commit; failures never fail delivery. */
  onFeedbackRead?(task: { taskId: string; project: string; orgId: OrgId | undefined; repositoryId: string }, comments: GitHubPullRequestFeedback["comments"]): Promise<void>;
  /** The head a push event says the pull request now has (a hint): until GitHub's own read shows it, nothing is decided. */
  expectedHeadSha?: string;
  loadTask(taskId: string): Promise<{ project: string; startingRevision: number; orgId?: OrgId | undefined; sessionId?: string | undefined; closedAt?: string; workflow?: WorkflowSnapshot } | undefined>;
  repositoryUrl(project: string, revision: number, repositoryId: string, orgId?: OrgId): Promise<string | undefined>;
  /** `orgId` is the task's org: the GitHub token that reads the pull request is minted for it (Plan 2, Task 15). */
  getCurrentFeedback(repositoryUrl: string, number: number, orgId: OrgId | undefined): Promise<GitHubPullRequestFeedback>;
  /** Writes exact payload bytes to immutable content-addressed storage; never overwrites an artifact. */
  persistBundle(bundle: WorkflowFeedbackBundle, bytes: string, sha256: string): Promise<string>;
  /**
   * Saves the workflow if its revision is still `expectedRevision`. `extraItems` are written in the same transaction (the
   * pending audit items of what the save records); none or an empty list is the plain conditional update.
   */
  saveWorkflow(taskId: string, expectedRevision: number, workflow: WorkflowSnapshot, extraItems?: TransactItem[]): Promise<void>;
  /** The head AgentX last pushed to a pull request (its pull request record), when it has one. */
  recordedHead?(workspaceId: string, repositoryId: string, number: number): Promise<string | undefined>;
  /** A commit's parents, as GitHub says. */
  commitParents?(repositoryUrl: string, commit: string, orgId: OrgId | undefined): Promise<string[]>;
  /**
   * The comments a completed review was given (each one's ID, edit time and body digest), read from its immutable
   * bundles; undefined when they cannot be read.
   */
  reviewedComments?(taskId: string, bundleDigests: readonly string[]): Promise<Array<{ id: string; updatedAt: string; bodyDigest: string }> | undefined>;
  /**
   * Saves the workflow with the fix pushes it records that were taken for failed but landed, together with each pull
   * request's link to the task (now naming the fix) and its pull request record (now at the landed head). `extraItems` as for
   * `saveWorkflow`.
   */
  saveLandedPushes?(taskId: string, expectedRevision: number, workflow: WorkflowSnapshot, pushes: readonly LandedFixPush[], extraItems?: TransactItem[]): Promise<void>;
  /** The Audit Ledger's outbox; absent on a legacy install, where a merge records nothing. */
  audit?: AuditRuntime;
  /** The org a task belongs to, for its merge's audit event, when the task's record names none. */
  auditOrgId?(taskId: string): Promise<OrgId>;
  /** Aggregate-only telemetry callback; must not add task/comment/user context. */
  measure?(entry: FeedbackReviewMeasure): void;
  now: string;
}

/** How long after AgentX records a push GitHub's read may still show the head before it (it takes seconds; this is generous). */
export const GITHUB_HEAD_LAG_WINDOW_MS = 10 * 60_000;

/**
 * The `pull_request.merged` event of each pull request this save moves to MERGED (its record changes from anything else; a
 * redelivered merge changes nothing and so records nothing). The chain names the pull request by an opaque id and not by
 * the repository's name, which goes in `details`; the observer is Rovara, because GitHub's read does not say who merged.
 * A builder or org lookup that fails is logged and the save goes on without the event. At most 32 events (a workflow's cap on
 * pull requests), so even with a landed-push save (1 + 2 x 32 items) plus the month count (1) and the merged milestone (2), the transaction stays within the 100 items DynamoDB allows.
 */
/** The pull requests this save moves to MERGED: their record changes from anything else to merged. */
function newlyMerged<Read extends { pr: { repositoryId: string; number: number; state: string } }>(next: WorkflowSnapshot, reads: ReadonlyArray<Read>): Read[] {
  return reads.filter(({ pr }) => pr.state !== "MERGED"
    && next.pullRequests?.some(after => after.repositoryId === pr.repositoryId && after.number === pr.number && after.state === "MERGED") === true);
}

/**
 * The item that adds `count` merged pull requests to a project's month count (Plan 5 Task 16). It is added by the same transaction as the workflow's move to MERGED, whatever path made it
 * (a webhook or sweep read, or a pushed fix found merged), so the count has one meaning: a replay changes nothing and so adds nothing. The month is the UTC month of `now`.
 */
export function mergedPullRequestCountItem(tableName: string, orgId: OrgId, project: string, now: string, count: number): TransactItem {
  const month = now.slice(0, 7);
  return {
    Update: {
      TableName: tableName, Key: projectMonthStatsKey(orgId, project, month),
      UpdateExpression: "SET entityType = :type, orgId = :orgId, #project = :project, #month = :month ADD mergedPullRequests :merged",
      ExpressionAttributeNames: { "#project": "project", "#month": "month" },
      ExpressionAttributeValues: { ":type": "PROJECT_SESSION_STATS", ":orgId": orgId, ":project": project, ":month": month, ":merged": count },
    },
  };
}

/**
 * The project's month count of merged pull requests (Plan 5 Task 16): one more for each pull request this save moves to MERGED, added by the same transaction as the move, so a
 * redelivered merge (which changes nothing) adds nothing and a save that does not commit counts nothing. The month is the UTC month the merge was found. A task whose org is not known
 * is not counted (the count is the org's own); a failing lookup is the same, and never stops the save.
 */
export async function mergedPullRequestStats(
  input: ReconcileTaskPullRequestFeedbackInput,
  task: { orgId?: OrgId | undefined; project: string },
  taskId: string,
  next: WorkflowSnapshot,
  reads: ReadonlyArray<{ pr: { repositoryId: string; number: number; state: string } }>,
): Promise<TransactItem[]> {
  const merged = newlyMerged(next, reads);
  if (merged.length === 0) return [];
  // The save goes on without the count; the log is the only trace of an undercount.
  const skipped = (reason: string, error?: unknown) => console.log(JSON.stringify({
    component: "broker", event: "merged_count.skipped", reason, taskId, project: task.project, ...(error instanceof Error ? { error: error.name } : {}),
  }));
  try {
    const orgId = task.orgId ?? await input.auditOrgId?.(taskId);
    if (orgId === undefined) { skipped("org_unknown"); return []; }
    return [mergedPullRequestCountItem(input.tableName, orgId, task.project, input.now, merged.length)];
  } catch (error) {
    skipped("lookup_failed", error);
    return [];
  }
}

function mergedPullRequestEvents(
  input: ReconcileTaskPullRequestFeedbackInput,
  task: { orgId?: OrgId | undefined },
  taskId: string,
  next: WorkflowSnapshot,
  reads: ReadonlyArray<{ pr: { repositoryId: string; number: number; state: string }; fullName: string }>,
): Promise<AuditEventInput[]> {
  return tryAuditEvents(input, async () => {
    const merged = newlyMerged(next, reads);
    if (merged.length === 0) return [];
    const orgId = task.orgId ?? await input.auditOrgId?.(taskId);
    if (orgId === undefined) throw new Error("the task's org is unknown");
    return merged.map(({ pr, fullName }) => auditPullRequestMerged({
      orgId, actor: { kind: "system", id: "rovara" }, occurredAt: input.now, occurrence: auditOccurrence(fullName, String(pr.number)),
      pullRequestId: auditPullRequestId(fullName, pr.number), number: pr.number,
      details: [{ subject: "org", fields: { repository: fullName } }],
    }));
  });
}

/** Who GitHub says merged each pull request that was read (a merged one only). */
function observedMerges(reads: ReadonlyArray<{ pr: { repositoryId: string; number: number }; feedback: GitHubPullRequestFeedback }>): Array<{ repositoryId: string; number: number; mergedBy?: string | undefined }> {
  return reads.map(({ pr, feedback }) => ({ repositoryId: pr.repositoryId, number: pr.number, mergedBy: feedback.pullRequest.mergedBy }));
}

/** How many times a save that lost only to another transaction on the same items (a hot item such as the project's month count) is tried again before it fails. */
export const WORKFLOW_SAVE_CONFLICT_RETRIES = 3;

/**
 * Runs a workflow save, and again (up to `WORKFLOW_SAVE_CONFLICT_RETRIES` more times, after a short, growing pause) when it failed only because another transaction held one of its items right
 * now: the whole-call `TransactionConflictException`, or a cancellation whose reasons hold a `TransactionConflict` and no failed condition. Nothing was written then, and the same save
 * is tried again as it is, without reading GitHub again. A failed condition is the caller's compare-and-set and is not retried here. The last conflict is thrown (a cancelled transaction as a `GithubWebhookRetryableError`, so that no caller takes it for a lost compare-and-set).
 */
async function saveRetryingConflicts(save: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await save();
      return;
    } catch (error) {
      const conflictOnly = isTransactionConflict(error) && (failedIndexes(error)?.size ?? 0) === 0;
      if (!conflictOnly) throw error;
      if (attempt >= WORKFLOW_SAVE_CONFLICT_RETRIES) {
        // A cancelled transaction would read as a lost compare-and-set to the callers (`isConditional`), which read GitHub again and save again; a conflict is not one. It is given up here, for the
        // delivery to be tried again later (the recovery sweep).
        if (isConditional(error)) throw new GithubWebhookRetryableError("the workflow's items stayed busy with another transaction");
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

/** Event payloads are hints only. Recollect all linked PRs on every CAS retry. */
export async function reconcileTaskPullRequestFeedback(input: ReconcileTaskPullRequestFeedbackInput): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest(input);
  if (!linked) throw new GithubWebhookRefusal("GitHub pull request is not linked to an AgentX workflow");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await input.loadTask(linked.taskId);
    const current = task?.workflow;
    // A task whose pull requests all merged is complete, and a closed task no longer follows its pull requests: a later
    // event (a redelivered merge, a comment, a merge after the owner closed the task) changes nothing, so it is neither
    // recorded nor said, and is not retried.
    if (task?.closedAt !== undefined || (current?.stage === "MERGED" && current.state === "COMPLETE")) return false;
    if (!task || !current || !tracksLinkedPullRequests(current)
      || !current.pullRequests?.some(pr => pr.repositoryId === linked.repositoryId && pr.number === linked.number
        && pr.url === linked.url && pr.candidateDigest === linked.candidateDigest)) {
      throw new GithubWebhookRefusal("linked workflow no longer matches the PR candidate");
    }
    const reads: Array<{ pr: NonNullable<WorkflowSnapshot["pullRequests"]>[number]; feedback: GitHubPullRequestFeedback; url: string; fullName: string }> = [];
    const captureFeedback = async () => {
      if (input.observationMode === "merge" || input.onFeedbackRead === undefined) return;
      let abandoned = false, timer: ReturnType<typeof setTimeout> | undefined;
      const work = (async () => {
        for (const { pr, feedback } of reads) {
          if (abandoned) break;
          try { await input.onFeedbackRead!({ taskId: linked.taskId, project: task.project, orgId: task.orgId, repositoryId: pr.repositoryId }, feedback.comments); }
          catch { if (!abandoned) console.log(JSON.stringify({ component: "broker", event: "learning.pr_capture_failed" })); }
        }
        return "done" as const;
      })();
      const limit = new Promise<"timeout">(resolve => { timer = setTimeout(() => { abandoned = true; resolve("timeout"); }, 1500); });
      try { if (await Promise.race([work, limit]) === "timeout") console.log(JSON.stringify({ component: "broker", event: "learning.pr_capture_timeout" })); }
      finally { clearTimeout(timer); }
    };
    for (const pr of [...(current.pullRequests ?? [])].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number)) {
      const url = await input.repositoryUrl(task.project, task.startingRevision, pr.repositoryId, task.orgId);
      if (!url) throw new GithubWebhookRefusal("linked PR repository is missing from the pinned project");
      const parsed = parseGitHubRepository(url);
      const fullName = `${parsed.owner}/${parsed.name}`;
      const index = await findLinkedGithubWorkflowPullRequest({ ...input, repositoryFullName: fullName, number: pr.number });
      if (!index || index.taskId !== linked.taskId || index.repositoryId !== pr.repositoryId
        || index.url !== pr.url || index.candidateDigest !== pr.candidateDigest
        || pr.url !== `https://github.com/${fullName}/pull/${pr.number}`) throw new GithubWebhookRefusal("linked task PR scope mismatch");
      const feedback = await input.getCurrentFeedback(url, pr.number, task.orgId);
      if (feedback.pullRequest.number !== pr.number || feedback.pullRequest.url !== pr.url
        || feedback.comments.some(comment => !comment.url.startsWith(`${pr.url}#`))) throw new GithubWebhookRefusal("current GitHub feedback scope mismatch");
      if (input.observationMode === "merge" && (feedback.comments.length !== 0 || feedback.threads.length !== 0)) {
        throw new GithubWebhookRefusal("merge observation contained feedback data");
      }
      reads.push({ pr, feedback, url, fullName });
    }
    if (input.observationMode === "merge") {
      const completePublishedSet = current.candidate !== undefined && current.candidate.repositories.every(repository =>
        current.pullRequests?.some(pr => pr.required && pr.repositoryId === repository.repositoryId));
      let next = current;
      for (const { pr, feedback } of reads) {
        const state = feedback.pullRequest.state === "merged" ? "MERGED" : feedback.pullRequest.state === "closed" ? "CLOSED" : "OPEN";
        const exactHead = pr.headSha !== undefined && pr.headSha === feedback.pullRequest.headCommit;
        const expectedTree = pr.headTreeSha ?? current.candidate?.repositories.find(repository => repository.repositoryId === pr.repositoryId)?.treeSha;
        const exactIdentity = exactHead && expectedTree !== undefined && expectedTree === feedback.pullRequest.headTreeSha;
        if ((state === "MERGED" && (!exactIdentity || !completePublishedSet)) || (state === "OPEN" && !exactIdentity)) continue;
        // While a fix is made or pushed only a merge is followed (as in the feedback path below): an open pull request that was not yet recorded as open is not written down now. Writing it
        // would move the workflow's revision under the dispatch row a fix has just been given (Plan 6 Task 15), and the run would never start.
        if (state === "OPEN" && workflowFollowsOnlyMerge(current)) continue;
        if (pr.state !== state) next = observeWorkflowPullRequest(next, { repositoryId: pr.repositoryId, number: pr.number,
          candidateDigest: pr.candidateDigest, state, source: "GITHUB_API", observedAt: input.now }, input.now);
      }
      if (next === current) return false;
      const events = await mergedPullRequestEvents(input, task, linked.taskId, next, reads);
      try {
        const items = [...events.flatMap(event => auditPending(input, event)), ...await mergedPullRequestStats(input, task, linked.taskId, next, reads),
          ...await mergedMilestoneItems(input, { taskId: linked.taskId, orgId: task.orgId, sessionId: task.sessionId }, current, next, input.now),
          ...await mergedStateItems(input, { taskId: linked.taskId, orgId: task.orgId, sessionId: task.sessionId, workspaceId: linked.workspaceId }, current, next, input.now, observedMerges(reads))];
        await saveRetryingConflicts(() => input.saveWorkflow(linked.taskId, current.revision, next, items));
        await flushAuditEvents(input, events);
        return true;
      } catch (error) {
        if (!isConditional(error)) throw error;
        continue;
      }
    }
    // GitHub moves a pull request's head a moment after a push. A push event whose head GitHub's read does not show yet,
    // while the read shows the head AgentX recorded or the pushed commit's parent, is read again later (the recovery
    // sweep): someone else's push is never missed, and AgentX's own push is never taken for someone else's.
    const pushed = input.expectedHeadSha === undefined ? undefined
      : reads.find(read => read.pr.number === input.number && read.fullName.toLowerCase() === input.repositoryFullName.toLowerCase());
    if (pushed !== undefined && input.expectedHeadSha !== undefined && pushed.feedback.pullRequest.state === "open"
      && pushed.feedback.pullRequest.headCommit !== input.expectedHeadSha) {
      const shown = pushed.feedback.pullRequest.headCommit;
      const behind = shown === pushed.pr.headSha
        || (input.commitParents !== undefined && (await input.commitParents(pushed.url, input.expectedHeadSha, task.orgId).catch(() => [] as string[])).includes(shown));
      if (behind) throw new GithubWebhookRetryableError("GitHub has not caught up with the pull request's head yet");
    }
    // The same lag, with no push event to hint at it: any event (a comment, a review, an edit) read just after AgentX
    // recorded its own push may still see the head before it. When GitHub's head is exactly the only parent of the head
    // AgentX recorded, the event is read again later instead of being taken for someone else's change. This only defers.
    // Only for a while after AgentX recorded its push: past that, GitHub has long caught up, and a head at the commit before
    // AgentX's push is someone resetting the branch, which the usual rules then judge (never as AgentX's own push).
    const recordedAt = current.pullRequestUpdatedAt === undefined ? Number.NaN : Date.parse(current.pullRequestUpdatedAt);
    const lagWindow = Number.isFinite(recordedAt) && Date.parse(input.now) - recordedAt <= GITHUB_HEAD_LAG_WINDOW_MS;
    if (input.commitParents !== undefined && lagWindow) {
      for (const read of reads) {
        const shown = read.feedback.pullRequest.headCommit;
        if (read.feedback.pullRequest.state !== "open" || read.pr.headSha === undefined || shown === read.pr.headSha) continue;
        const parents = await input.commitParents(read.url, read.pr.headSha, task.orgId).catch(() => [] as string[]);
        // A fix is one commit on the head; a merge of the base branch (Plan 6 Task 17) is two, the head first.
        if ((parents.length === 1 || parents.length === 2) && parents[0] === shown) throw new GithubWebhookRetryableError("GitHub has not caught up with the pull request's head yet");
      }
    }
    // The head AgentX recorded, holding the tree recorded with it (the checked tree, for a record that has none).
    const headMatchesCandidate = ({ pr, feedback }: Pick<typeof reads[number], "pr" | "feedback">): boolean => pr.headSha !== undefined
      && pr.headSha === feedback.pullRequest.headCommit
      && (pr.headTreeSha ?? current.candidate?.repositories.find(repo => repo.repositoryId === pr.repositoryId)?.treeSha) === feedback.pullRequest.headTreeSha;
    const changedHead = reads.some(read => (read.feedback.pullRequest.state === "open" || read.feedback.pullRequest.state === "merged")
      && !headMatchesCandidate(read));
    // While an approved fix is made or pushed (its push moves the head), or after its push failed, only a merge is followed.
    const onlyMerge = workflowFollowsOnlyMerge(current);
    // Only a fix whose checks and reviews passed is pushed: while it is pushed, or after its push failed.
    const fixPushed = current.stage === "PULL_REQUEST" || (current.state === "BLOCKED" && current.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed);
    // A pull request an earlier release recorded without its head's tree learns it while the candidate is still the code it
    // was opened with: once an approved fix is coded, the candidate is the fix's.
    const headTrees = onlyMerge ? [] : reads.filter(read => read.pr.headTreeSha === undefined && read.pr.headSha !== undefined
      && read.pr.candidateDigest === current.candidate?.digest && headMatchesCandidate(read))
      .map(({ pr, feedback }) => ({ repositoryId: pr.repositoryId, number: pr.number, headSha: pr.headSha!, headTreeSha: feedback.pullRequest.headTreeSha }));
    /**
     * Whether GitHub's head is the approved fix AgentX pushed, not yet recorded on the task (its result was late, lost, or
     * taken for failed): the head's tree is exactly the fix's reviewed tree, and the pull request's record names that head
     * or the head's only parent is the head the task recorded.
     */
    const landedFix = async ({ pr, feedback, url }: typeof reads[number]): Promise<boolean> => {
      const head = feedback.pullRequest.headCommit;
      const fixTree = current.candidate?.repositories.find(repo => repo.repositoryId === pr.repositoryId)?.treeSha;
      if (!fixPushed || pr.headSha === undefined || pr.state === "MERGED" || pr.candidateDigest === current.candidate?.digest
        || fixTree === undefined || fixTree !== feedback.pullRequest.headTreeSha || head === pr.headSha || !/^[a-f0-9]{40}$/.test(head)) return false;
      if (await input.recordedHead?.(linked.workspaceId, pr.repositoryId, pr.number) === head) return true;
      try {
        return input.commitParents !== undefined && JSON.stringify(await input.commitParents(url, head, task.orgId)) === JSON.stringify([pr.headSha]);
      } catch {
        return false;
      }
    };
    // A task blocked because its fix's push was taken for failed records that push once GitHub shows it landed.
    const pushTakenForFailed = current.state === "BLOCKED" && current.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed;
    const landed: LandedFixPush[] = [];
    let next = current;
    for (const read of reads) {
      const { pr, feedback } = read;
      const state = feedback.pullRequest.state === "merged" ? "MERGED" : feedback.pullRequest.state === "closed" ? "CLOSED" : "OPEN";
      if (onlyMerge && state !== "MERGED") {
        if (state === "OPEN" && pushTakenForFailed && input.saveLandedPushes !== undefined && current.candidate !== undefined && await landedFix(read)) {
          landed.push({ workspaceId: linked.workspaceId, repositoryId: pr.repositoryId, repositoryFullName: read.fullName, number: pr.number, url: pr.url,
            headSha: feedback.pullRequest.headCommit, previousHeadSha: pr.headSha!, candidateDigest: current.candidate.digest,
            previousCandidateDigest: pr.candidateDigest, state: "open" });
        }
        continue;
      }
      // A merge only completes this candidate-bound task when the merged PR still points at its checked publication.
      // Keep mismatched merged PRs in their prior workflow state so the task cannot become terminally complete.
      if (state === "MERGED" && !headMatchesCandidate({ pr, feedback })) {
        // The one exception: GitHub merged the approved fix AgentX pushed before its push was recorded.
        if (onlyMerge && await landedFix(read)) {
          next = observeWorkflowPullRequestMergedWithFix(next, { repositoryId: pr.repositoryId, number: pr.number,
            headSha: feedback.pullRequest.headCommit, headTreeSha: feedback.pullRequest.headTreeSha, observedAt: input.now }, input.now);
        }
        continue;
      }
      if (pr.state !== state) next = observeWorkflowPullRequest(next, { repositoryId: pr.repositoryId, number: pr.number,
        candidateDigest: pr.candidateDigest, state, source: "GITHUB_API", observedAt: input.now }, input.now);
    }
    // Recorded as a push would have been: the task waits for the merge again once every pull request holds the fix.
    const recordedPushes = landed.length > 0 && next.stage === "WAIT_FOR_MERGE" && next.state === "BLOCKED" ? landed : [];
    if (recordedPushes.length > 0) {
      next = recordWorkflowPullRequestUpdate(next, { updates: recordedPushes.map(push => ({ repositoryId: push.repositoryId, number: push.number,
        headSha: push.headSha, headTreeSha: current.candidate!.repositories.find(repo => repo.repositoryId === push.repositoryId)!.treeSha })), now: input.now });
    }
    const open = reads.filter(r => r.feedback.pullRequest.state === "open");
    let reopenedFeedback = false;
    if (onlyMerge) {
      if (next === current) return false;
    } else if (changedHead || open.length === 0) {
      if (!current.feedbackReview && next === current
        && (!changedHead || current.state === "BLOCKED")) {
        if (headTrees.length === 0) return false;
      } else {
        const previousReport = current.feedbackReview?.reviewRef;
        const history = [...(current.feedbackReviewHistory ?? [])];
        if (previousReport && !history.some(r => r.sha256 === previousReport.sha256)) history.push(previousReport);
        next = WorkflowSnapshotSchema.parse({ ...next, revision: next.revision + 1,
          ...(changedHead ? { state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestChanged } : {}),
          feedbackReview: undefined, feedbackReviewHistory: history, updatedAt: input.now });
      }
    } else {
      const observations: WorkflowFeedbackThreadObservation[] = [];
      const bundles = open.map(({ pr, feedback }): WorkflowFeedbackBundle => {
        const comments = feedback.comments.map(({ authorId, authorType, ...c }) => { void authorId; void authorType; return { ...c, bodyDigest: digest(c.body), bodyBytes: Buffer.byteLength(c.body, "utf8") }; });
        const eligible = new Set(comments.filter(c => c.kind !== "REVIEW_COMMENT").map(c => c.id));
        const threadIds = new Set<string>();
        for (const thread of feedback.threads) {
          if (threadIds.has(thread.id)) throw new GithubWebhookRetryableError("duplicate thread state");
          threadIds.add(thread.id);
          const members = thread.commentIds.map(id => comments.find(c => c.id === id && c.threadId === thread.id));
          if (members.some(c => c === undefined) || new Set(thread.commentIds).size !== thread.commentIds.length) throw new GithubWebhookRetryableError("thread comment state is incomplete");
          const prior = (current.feedbackReview?.threadObservations ?? (current.feedbackReview === undefined ? current.feedbackThreadObservations : undefined))?.find(t => t.repositoryId === pr.repositoryId && t.number === pr.number && t.threadId === thread.id);
          const ids = members.flatMap(comment => {
            if (!comment) return [];
            if (!thread.resolved) return [comment.id];
            // A resolved thread starts excluded. Once observed resolved, new/edited feedback remains eligible across retries.
            const previous = prior?.comments.find(c => c.id === comment.id);
            return prior?.resolved && (!previous || previous.updatedAt !== comment.updatedAt || previous.bodyDigest !== comment.bodyDigest
              || prior.eligibleCommentIds.includes(comment.id)) ? [comment.id] : [];
          });
          if (prior?.resolved && (!thread.resolved || ids.some(id => !prior.eligibleCommentIds.includes(id)))) reopenedFeedback = true;
          ids.forEach(id => eligible.add(id));
          observations.push({ repositoryId: pr.repositoryId, number: pr.number, threadId: thread.id, resolved: thread.resolved,
            comments: members.map(c => ({ id: c!.id, updatedAt: c!.updatedAt, bodyDigest: c!.bodyDigest })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), eligibleCommentIds: ids.sort() });
        }
        if (comments.some(c => c.kind === "REVIEW_COMMENT" && (!c.threadId || !threadIds.has(c.threadId)))) throw new GithubWebhookRetryableError("inline thread state is incomplete");
        // Approval authorizes future work. It does not establish that GitHub feedback was addressed.
        const selected = comments.filter(c => eligible.has(c.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        const normalizedComments = WorkflowFeedbackBundleCommentsSchema.parse(selected);
        const normalized = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId: current.taskId, repositoryId: pr.repositoryId, number: pr.number,
          headSha: feedback.pullRequest.headCommit, headTreeSha: feedback.pullRequest.headTreeSha,
          candidateDigest: current.candidate!.digest, commentSetDigest: digest(JSON.stringify(normalizedComments)),
          producer: "agentx-github-reconciler", version: "1", recordedAt: input.now, comments: normalizedComments, sourceDeliveryIds: [input.deliveryId] });
        return WorkflowFeedbackBundleSchema.parse({ ...normalized, commentSetDigest: digest(JSON.stringify(normalized.comments)) });
      });
      observations.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number || a.threadId.localeCompare(b.threadId));
      const prior = current.feedbackReview;
      const same = prior && prior.bundleRefs.length === bundles.length && bundles.every(b => prior.bundleRefs.some(p =>
        p.repositoryId === b.repositoryId && p.number === b.number && p.headSha === b.headSha && p.headTreeSha === b.headTreeSha
        && p.candidateDigest === b.candidateDigest && p.commentSetDigest === b.commentSetDigest));
      // Unchanged content (comment set, heads, trees and threads) is never collected again: a new bundle would be recorded
      // under another digest only for its delivery ID and time, and an owner's decision bound to the old one would be stale.
      // No feedback yet and none now (an approval with no summary, a pull request marked ready): nothing to review or say.
      // Feedback only in resolved review threads is no feedback either: a resolved thread starts excluded.
      // The feedback a finished round already reviewed is not new either: once its approved fix is pushed, GitHub's event for
      // that push (or any later event before someone says something new) finds the same comments on the pull request.
      // "The same" is each comment's identity, words and edit time: an inline comment the fix outdated loses its line, and
      // a thread resolved after the fix leaves the set, without anything new having been said.
      const lastReviewed = current.feedbackReviewHistory?.at(-1);
      let alreadyReviewed = false;
      if (prior === undefined && lastReviewed?.status === "COMPLETE") {
        const reviewed = await input.reviewedComments?.(linked.taskId, lastReviewed.bundleDigests).catch(() => undefined);
        alreadyReviewed = reviewed !== undefined
          ? bundles.every(b => b.comments.every(c => reviewed.some(r => r.id === c.id && r.updatedAt === c.updatedAt && r.bodyDigest === c.bodyDigest)))
          : lastReviewed.candidateBindings.length === bundles.length && bundles.every(b => lastReviewed.candidateBindings.some(binding =>
            binding.repositoryId === b.repositoryId && binding.number === b.number && binding.commentSetDigest === b.commentSetDigest));
      }
      const nothingToReview = prior === undefined && (alreadyReviewed
        || (observations.every(o => o.eligibleCommentIds.length === 0) && bundles.every(b => b.comments.length === 0)));
      if (same && sameThreadObservations(prior.threadObservations ?? [], observations) && next === current) {
        if (headTrees.length === 0) return false;
      } else if (nothingToReview) {
        // Feedback only in resolved threads: nothing to review, but the threads are remembered as seen, so a later reply
        // in one of them is compared with what was there.
        if (observations.length > 0 && !sameThreadObservations(current.feedbackThreadObservations ?? [], observations)) {
          next = WorkflowSnapshotSchema.parse({ ...next, revision: next.revision + 1, feedbackThreadObservations: observations, updatedAt: input.now });
        }
        if (next === current && headTrees.length === 0) return false;
      } else {
        // A step is running (the review of earlier feedback): nothing can be collected now, so nothing is stored. The
        // delivery is kept, and the recovery sweep collects again once the step is done.
        if (current.state === "RUNNING") throw new GithubWebhookRetryableError("the task is running a step");
        const refs: WorkflowFeedbackBundleRef[] = [];
        for (const bundle of bundles) {
          const bytes = JSON.stringify(bundle); const sha256 = digest(bytes);
          const objectKey = await input.persistBundle(bundle, bytes, sha256);
          const { sourceDeliveryIds: deliveryIds, comments, ...metadata } = bundle;
          void deliveryIds;
          refs.push(WorkflowFeedbackBundleRefSchema.parse({ ...metadata, sha256, objectKey, comments: comments.map(({ body, ...ref }) => { void body; return ref; }) }));
        }
        next = collectWorkflowFeedbackBundles(next, { bundleRefs: refs, threadObservations: observations }, input.now);
        if (next.feedbackThreadObservations !== undefined) next = WorkflowSnapshotSchema.parse({ ...next, feedbackThreadObservations: undefined });
      }
    }
    if (headTrees.length > 0) next = recordWorkflowPullRequestHeadTrees(next, headTrees, input.now);
    const events = await mergedPullRequestEvents(input, task, linked.taskId, next, reads);
    const extraItems = [...events.flatMap(event => auditPending(input, event)), ...await mergedPullRequestStats(input, task, linked.taskId, next, reads),
      ...await mergedMilestoneItems(input, { taskId: linked.taskId, orgId: task.orgId, sessionId: task.sessionId }, current, next, input.now),
      ...await mergedStateItems(input, { taskId: linked.taskId, orgId: task.orgId, sessionId: task.sessionId, workspaceId: linked.workspaceId }, current, next, input.now, observedMerges(reads))];
    try {
      await saveRetryingConflicts(() => recordedPushes.length > 0
        ? input.saveLandedPushes!(linked.taskId, current.revision, next, recordedPushes, extraItems)
        : input.saveWorkflow(linked.taskId, current.revision, next, extraItems));
      await flushAuditEvents(input, events);
      await captureFeedback();
      if (reopenedFeedback) {
        const measure = feedbackReopenedMeasure(input.now);
        if (measure !== undefined) input.measure?.(measure);
      }
      return true;
    }
    catch (error) { if (!isConditional(error)) throw error; }
  }
  throw new GithubWebhookRetryableError("workflow kept changing during feedback reconciliation");
}

/** Re-fetches every linked PR at worker start and proves the saved approval still covers that exact snapshot. */
export async function verifyTaskPullRequestFeedbackCurrent(input: Pick<ReconcileTaskPullRequestFeedbackInput, "documentClient" | "tableName" | "loadTask" | "repositoryUrl" | "getCurrentFeedback" | "repositoryFullName" | "number">): Promise<boolean> {
  const linked = await findLinkedGithubWorkflowPullRequest(input);
  if (!linked) return false;
  const task = await input.loadTask(linked.taskId);
  const workflow = task?.workflow;
  const approval = workflow?.feedbackDispatchApproval;
  const review = workflow?.feedbackReview;
  if (!task || !workflow || !approval || !review || review.status !== "APPROVED" || workflow.candidate?.digest !== approval.candidateDigest) return false;
  const prs = [...(workflow.pullRequests ?? [])].filter(pr => pr.state === "OPEN" || pr.state === "UNKNOWN")
    .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number);
  if (prs.length !== review.bundleRefs.length) return false;
  const observations: WorkflowFeedbackThreadObservation[] = [];
  for (const pr of prs) {
    const url = await input.repositoryUrl(task.project, task.startingRevision, pr.repositoryId, task.orgId);
    if (!url) return false;
    const fullName = (() => { const parsed = parseGitHubRepository(url); return `${parsed.owner}/${parsed.name}`; })();
    const index = await findLinkedGithubWorkflowPullRequest({ ...input, repositoryFullName: fullName, number: pr.number });
    if (!index || index.taskId !== linked.taskId || index.repositoryId !== pr.repositoryId || index.url !== pr.url || index.candidateDigest !== approval.candidateDigest) return false;
    const feedback = await input.getCurrentFeedback(url, pr.number, task.orgId);
    if (feedback.pullRequest.state !== "open" || feedback.pullRequest.headCommit !== pr.headSha
      || feedback.pullRequest.headTreeSha !== workflow.candidate.repositories.find(repo => repo.repositoryId === pr.repositoryId)?.treeSha
      || feedback.pullRequest.url !== pr.url || feedback.comments.some(comment => !comment.url.startsWith(`${pr.url}#`))) return false;
    const comments = feedback.comments.map(({ authorId, authorType, ...comment }) => { void authorId; void authorType; return { ...comment, bodyDigest: digest(comment.body), bodyBytes: Buffer.byteLength(comment.body, "utf8") }; });
    const eligible = new Set(comments.filter(comment => comment.kind !== "REVIEW_COMMENT").map(comment => comment.id));
    const seenThreads = new Set<string>();
    for (const thread of feedback.threads) {
      if (seenThreads.has(thread.id)) return false;
      seenThreads.add(thread.id);
      const members = thread.commentIds.map(id => comments.find(comment => comment.id === id && comment.threadId === thread.id));
      if (members.some(comment => comment === undefined) || new Set(thread.commentIds).size !== thread.commentIds.length) return false;
      const prior = review.threadObservations?.find(item => item.repositoryId === pr.repositoryId && item.number === pr.number && item.threadId === thread.id);
      const eligibleIds = members.flatMap(comment => {
        if (!comment) return [];
        if (!thread.resolved) return [comment.id];
        const previous = prior?.comments.find(item => item.id === comment.id);
        return prior?.resolved && (!previous || previous.updatedAt !== comment.updatedAt || previous.bodyDigest !== comment.bodyDigest
          || prior.eligibleCommentIds.includes(comment.id)) ? [comment.id] : [];
      }).sort();
      eligibleIds.forEach(id => eligible.add(id));
      observations.push({ repositoryId: pr.repositoryId, number: pr.number, threadId: thread.id, resolved: thread.resolved,
        comments: members.map(comment => ({ id: comment!.id, updatedAt: comment!.updatedAt, bodyDigest: comment!.bodyDigest })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), eligibleCommentIds: eligibleIds });
    }
    if (comments.some(comment => comment.kind === "REVIEW_COMMENT" && (!comment.threadId || !seenThreads.has(comment.threadId)))) return false;
    const selected = comments.filter(comment => eligible.has(comment.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const normalizedComments = WorkflowFeedbackBundleCommentsSchema.parse(selected);
    const ref = review.bundleRefs.find(bundle => bundle.repositoryId === pr.repositoryId && bundle.number === pr.number);
    if (!ref || ref.candidateDigest !== approval.candidateDigest || ref.headSha !== feedback.pullRequest.headCommit
      || ref.headTreeSha !== feedback.pullRequest.headTreeSha
      || ref.commentSetDigest !== digest(JSON.stringify(normalizedComments))) return false;
  }
  observations.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.number - b.number || a.threadId.localeCompare(b.threadId));
  return sameThreadObservations(review.threadObservations ?? [], observations);
}

/**
 * Whether two thread observation lists hold the same content, compared field by field. A stored list is read back from
 * DynamoDB, which keeps no map's attribute order, so its JSON text differs from a freshly built list's even when every
 * value is the same.
 */
function sameThreadObservations(left: readonly WorkflowFeedbackThreadObservation[], right: readonly WorkflowFeedbackThreadObservation[]): boolean {
  const content = (observations: readonly WorkflowFeedbackThreadObservation[]) => JSON.stringify(observations.map(observation => [
    observation.repositoryId, observation.number, observation.threadId, observation.resolved,
    observation.comments.map(comment => [comment.id, comment.updatedAt, comment.bodyDigest]), observation.eligibleCommentIds,
  ]));
  return content(left) === content(right);
}
function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function removeControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d || code === 0x7f ? " " : character;
  }).join("");
}

export async function reserveGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  installationId: number;
  repositoryId: number;
  eventHash: string;
  event: ReceivedGithubWebhook["event"];
  now: string;
}): Promise<"reserved" | "retry" | "duplicate" | "conflict"> {
  if (!DELIVERY_ID.test(input.deliveryId) || !/^[a-f0-9]{64}$/.test(input.eventHash)
    || !Number.isSafeInteger(input.installationId) || input.installationId < 1
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1) {
    throw new GithubWebhookRefusal("GitHub delivery identity is invalid");
  }
  const key = { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" };
  const record = {
    ...key,
    entityType: "GITHUB_WEBHOOK_DELIVERY",
    deliveryId: input.deliveryId,
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    eventHash: input.eventHash,
    status: "RECEIVED",
    receivedAt: input.now,
    event: input.event,
    nextAttemptAt: input.now,
    webhookRecoveryPk: GITHUB_WEBHOOK_RECOVERY_PK,
    webhookRecoverySk: `${input.now}#${input.deliveryId}`,
  };
  try {
    await input.documentClient.send(new PutCommand({
      TableName: input.tableName,
      Item: record,
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return "reserved";
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
  const stored = await input.documentClient.send(new GetCommand({ TableName: input.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  if (stored.Item?.eventHash === input.eventHash
    && stored.Item?.installationId === input.installationId
    && stored.Item?.repositoryId === input.repositoryId) {
    return stored.Item.status === "COMPLETED" ? "duplicate" : "retry";
  }
  return "conflict";
}

/** Marks a delivery complete only after all of its task effects have been durably recorded. */
export async function completeGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
}): Promise<void> {
  if (!DELIVERY_ID.test(input.deliveryId) || !/^[0-9a-f-]{36}$/i.test(input.leaseToken) || !Number.isFinite(Date.parse(input.now))) {
    throw new GithubWebhookRefusal("GitHub delivery completion identity is invalid");
  }
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: "SET #status = :completed, completedAt = :now REMOVE leaseToken, leaseExpiresAt, webhookRecoveryPk, webhookRecoverySk, nextAttemptAt",
      ConditionExpression: "#status = :processing AND leaseToken = :leaseToken",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":processing": "PROCESSING", ":leaseToken": input.leaseToken, ":completed": "COMPLETED", ":now": input.now },
    }));
  } catch (error) {
    if (isConditional(error)) throw new GithubWebhookRefusal("GitHub delivery is missing or already complete");
    throw error;
  }
}

/** Claims a received/retryable delivery, or recovers a worker whose processing lease expired. */
export async function claimGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
  leaseMs?: number;
}): Promise<boolean> {
  const leaseMs = input.leaseMs ?? 60_000;
  const now = Date.parse(input.now);
  if (!DELIVERY_ID.test(input.deliveryId) || !/^[0-9a-f-]{36}$/i.test(input.leaseToken)
    || !Number.isFinite(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 15 * 60_000) {
    throw new GithubWebhookRefusal("GitHub delivery claim identity is invalid");
  }
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: "SET #status = :processing, leaseToken = :leaseToken, leaseExpiresAt = :leaseExpiresAt, webhookRecoveryPk = :recoveryPk, webhookRecoverySk = :recoverySk, updatedAt = :now REMOVE nextAttemptAt ADD attempts :one",
      ConditionExpression: "((#status = :received OR #status = :retryable) AND (attribute_not_exists(nextAttemptAt) OR nextAttemptAt <= :now)) OR (#status = :processing AND leaseExpiresAt <= :now)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":processing": "PROCESSING", ":received": "RECEIVED", ":retryable": "RETRYABLE", ":leaseToken": input.leaseToken,
        ":leaseExpiresAt": new Date(now + leaseMs).toISOString(), ":now": input.now, ":one": 1,
        ":recoveryPk": GITHUB_WEBHOOK_RECOVERY_PK,
        ":recoverySk": `${new Date(now + leaseMs).toISOString()}#${input.deliveryId}`,
      },
    }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** Releases an owned claim for durable retry; stale workers cannot overwrite a newer claim. */
export async function retryGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
}): Promise<void> {
  const existing = await input.documentClient.send(new GetCommand({
    TableName: input.tableName,
    Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
    ConsistentRead: true,
  })) as { Item?: { attempts?: number } };
  const attempts = typeof existing.Item?.attempts === "number" ? existing.Item.attempts : 1;
  const terminal = attempts >= MAX_WEBHOOK_ATTEMPTS;
  const delayMs = Math.min(60_000 * (2 ** Math.max(0, attempts - 1)), 60 * 60_000);
  const nextAttemptAt = new Date(Date.parse(input.now) + delayMs).toISOString();
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: terminal
        ? "SET #status = :dead, updatedAt = :now REMOVE leaseToken, leaseExpiresAt, webhookRecoveryPk, webhookRecoverySk, nextAttemptAt"
        : "SET #status = :retryable, updatedAt = :now, nextAttemptAt = :nextAttemptAt, webhookRecoveryPk = :recoveryPk, webhookRecoverySk = :recoverySk REMOVE leaseToken, leaseExpiresAt",
      ConditionExpression: "#status = :processing AND leaseToken = :leaseToken",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        // DynamoDB refuses a request that carries a value no expression uses, so each branch sends only its own.
        ":processing": "PROCESSING", ":leaseToken": input.leaseToken, ":now": input.now,
        ...(terminal
          ? { ":dead": "DEAD" }
          : { ":retryable": "RETRYABLE", ":nextAttemptAt": nextAttemptAt, ":recoveryPk": GITHUB_WEBHOOK_RECOVERY_PK, ":recoverySk": `${nextAttemptAt}#${input.deliveryId}` }),
      },
    }));
  } catch (error) {
    if (isConditional(error)) throw new GithubWebhookRefusal("GitHub delivery claim is no longer owned by this worker");
    throw error;
  }
}

/** Permanently refused events leave the retry index; transient failures use the backoff path. */
export async function rejectGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  deliveryId: string;
  leaseToken: string;
  now: string;
}): Promise<void> {
  try {
    await input.documentClient.send(new UpdateCommand({
      TableName: input.tableName,
      Key: { pk: `GITHUB_DELIVERY#${input.deliveryId}`, sk: "META" },
      UpdateExpression: "SET #status = :dead, updatedAt = :now REMOVE leaseToken, leaseExpiresAt, webhookRecoveryPk, webhookRecoverySk, nextAttemptAt",
      ConditionExpression: "#status = :processing AND leaseToken = :leaseToken",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":processing": "PROCESSING", ":dead": "DEAD", ":leaseToken": input.leaseToken, ":now": input.now },
    }));
  } catch (error) {
    if (isConditional(error)) throw new GithubWebhookRefusal("GitHub delivery claim is no longer owned by this worker");
    throw error;
  }
}

/** Reads only due delivery rows through the sparse recovery index. */
export async function listDueGithubWebhookDeliveries(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: string;
  limit?: number;
}): Promise<Array<{ deliveryId: string; event: ReceivedGithubWebhook["event"] }>> {
  const response = await input.documentClient.send(new QueryCommand({
    TableName: input.tableName,
    IndexName: GITHUB_WEBHOOK_RECOVERY_INDEX,
    KeyConditionExpression: "webhookRecoveryPk = :pk AND webhookRecoverySk <= :sk",
    ExpressionAttributeValues: { ":pk": GITHUB_WEBHOOK_RECOVERY_PK, ":sk": `${input.now}#~` },
    Limit: Math.min(Math.max(input.limit ?? 25, 1), 100),
  })) as { Items?: Array<Record<string, unknown>> };
  return (response.Items ?? []).flatMap((item) => typeof item.deliveryId === "string" && item.event !== undefined
    && item.status !== "COMPLETED" && item.status !== "DEAD"
    ? [{ deliveryId: item.deliveryId, event: item.event as ReceivedGithubWebhook["event"] }]
    : []);
}

/** Processes one reserved event under a lease; provider failure leaves a durable retry state. */
export async function processGithubWebhookDelivery(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  received: ReceivedGithubWebhook;
  process(event: ReceivedGithubWebhook["event"], deliveryId: string): Promise<void>;
  now(): string;
  log?: (entry: Record<string, unknown>) => void;
}): Promise<"PROCESSED" | "DUPLICATE" | "IN_PROGRESS"> {
  if (input.received.delivery === "DUPLICATE") return "DUPLICATE";
  const leaseToken = randomUUID();
  const claimAt = input.now();
  const claimed = await claimGithubWebhookDelivery({
    documentClient: input.documentClient,
    tableName: input.tableName,
    deliveryId: input.received.deliveryId,
    leaseToken,
    now: claimAt,
  });
  if (!claimed) return "IN_PROGRESS";
  try {
    await input.process(input.received.event, input.received.deliveryId);
    await completeGithubWebhookDelivery({
      documentClient: input.documentClient,
      tableName: input.tableName,
      deliveryId: input.received.deliveryId,
      leaseToken,
      now: input.now(),
    });
    return "PROCESSED";
  } catch (error) {
    // Record the cause first so a failure while saving the delivery's state cannot hide it. Name and code only:
    // messages can carry request or response text.
    const log = input.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", ...entry })));
    const code = (error as { code?: unknown } | null)?.code;
    log({
      event: "github_webhook.delivery_failed",
      deliveryId: input.received.deliveryId,
      error: error instanceof Error ? error.name : "unknown",
      ...(typeof code === "string" ? { code } : {}),
      outcome: error instanceof GithubWebhookRefusal ? "rejected" : "retry",
    });
    if (error instanceof GithubWebhookRefusal) {
      await rejectGithubWebhookDelivery({ documentClient: input.documentClient, tableName: input.tableName, deliveryId: input.received.deliveryId, leaseToken, now: input.now() });
    } else {
      await retryGithubWebhookDelivery({ documentClient: input.documentClient, tableName: input.tableName, deliveryId: input.received.deliveryId, leaseToken, now: input.now() });
    }
    throw error;
  }
}

/** The part of an `installation` webhook Task 14 reads. `requester` is an object or null (absent counts as null). */
const InstallationCreatedSchema = z.object({
  action: z.literal("created"),
  installation: z.object({
    id: z.number().int().positive(),
    created_at: z.union([z.string().min(1).max(64), z.number().positive()]),
    account: z.object({ login: z.string().min(1).max(100), id: z.number().int().positive(), type: z.string().min(1).max(40) }).passthrough(),
  }).passthrough(),
  requester: z.object({ id: z.number().int().positive(), login: z.string().min(1).max(100) }).passthrough().nullish(),
  sender: z.object({ id: z.number().int().positive(), login: z.string().min(1).max(100) }).passthrough(),
}).passthrough();

/** The parts of the other `installation` actions and of `installation_repositories` that Task 15 reads. */
const InstallationLifecycleSchema = z.object({
  action: z.string().min(1).max(64),
  installation: z.object({
    id: z.number().int().positive(), repository_selection: z.enum(["all", "selected"]).optional(),
    updated_at: z.union([z.string().max(64), z.number()]).nullish(), suspended_at: z.union([z.string().max(64), z.number()]).nullish(),
  }).passthrough(),
  repository_selection: z.enum(["all", "selected"]).optional(),
}).passthrough();

/**
 * An `installation` event (Plan 2, Tasks 14 and 15) or `installation_repositories` event: verified like any delivery. `created` goes to the
 * install-request flow; the other actions to the lifecycle handler. Both do their own deduplication of the delivery id. They have no repository
 * to authorize, so they are not reserved or recovered like a pull request event.
 */
async function handleInstallationEvent(
  input: { rawBody: string; headers: Record<string, string | undefined>; secret: string },
  handlers: { created?: (deliveryId: string, payload: InstallationCreatedPayload) => Promise<unknown>; lifecycle?: (deliveryId: string, event: InstallationLifecycleEvent) => Promise<unknown> },
): Promise<{ status: "ACCEPTED"; deliveryId: string; lifecycle?: true }> {
  if (Buffer.byteLength(input.rawBody, "utf8") > 1_048_576) throw new GithubWebhookRefusal("GitHub webhook payload exceeds the size limit");
  const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!verifyGithubWebhookSignature(input.rawBody, headers["x-hub-signature-256"], input.secret)) throw new GithubWebhookRefusal(GITHUB_WEBHOOK_SIGNATURE_INVALID);
  const deliveryId = headers["x-github-delivery"];
  if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) throw new GithubWebhookRefusal("GitHub webhook delivery ID is invalid");
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new GithubWebhookRefusal("GitHub webhook JSON body is invalid");
  }
  const githubEvent = headers["x-github-event"];
  const action = raw !== null && typeof raw === "object" && "action" in raw ? raw.action : undefined;
  if (githubEvent === "installation_repositories" || (githubEvent === "installation" && action !== "created")) {
    // Task 15: GitHub's own changes to an installation. An action Rovara does not follow (new permissions accepted, ...) is accepted and ignored.
    const lifecycle = handlers.lifecycle;
    const change = InstallationLifecycleSchema.safeParse(raw);
    if (lifecycle === undefined || !change.success) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
    const installationId = change.data.installation.id;
    // When GitHub says the installation last changed: `updated_at`, and for a suspension the moment it was suspended if that is later. It
    // orders deliveries; a payload with neither is applied in the order it arrives.
    const stamps = [change.data.installation.updated_at, change.data.action === "suspend" ? change.data.installation.suspended_at : undefined]
      .flatMap((value) => {
        const time = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : Number.NaN;
        return Number.isFinite(time) ? [time] : [];
      });
    const eventAt = stamps.length === 0 ? undefined : Math.max(...stamps);
    const at = eventAt === undefined ? {} : { eventAt };
    if (githubEvent === "installation_repositories") {
      const repositorySelection = change.data.repository_selection ?? change.data.installation.repository_selection;
      if (repositorySelection !== undefined) await lifecycle(deliveryId, { kind: "repositories", installationId, repositorySelection, ...at });
    } else if (change.data.action === "deleted" || change.data.action === "suspend" || change.data.action === "unsuspend") {
      await lifecycle(deliveryId, { kind: "installation", action: change.data.action, installationId, ...at });
    }
    return { status: "ACCEPTED", deliveryId, lifecycle: true };
  }
  const parsed = InstallationCreatedSchema.safeParse(raw);
  const bind = handlers.created;
  if (!parsed.success || bind === undefined) throw new GithubWebhookRefusal("GitHub webhook event payload is unsupported or incomplete");
  const { installation, requester, sender } = parsed.data;
  await bind(deliveryId, {
    installation: { id: installation.id, created_at: installation.created_at, account: { login: installation.account.login, id: installation.account.id, type: installation.account.type } },
    requester: requester === undefined || requester === null ? null : { id: requester.id, login: requester.login },
    sender: { id: sender.id, login: sender.login },
  });
  return { status: "ACCEPTED", deliveryId };
}

/** Longest the Team record tap may hold a delivery's answer (GitHub gives up on a webhook after ten seconds and does not retry by itself). */
export const RECORD_TAP_BUDGET_MS = 3_000;

/** Waits for `work` at most `ms`, and never throws: a slow or failing tap changes nothing about the delivery. */
async function withinBudget(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Shared endpoint path: verify, durably reserve, claim, process, then record the outcome. */
export async function handleGithubWebhook(input: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
  secret: string;
  authorizeRepository: ReceiveGithubWebhookInput["authorizeRepository"];
  process(event: ReceivedGithubWebhook["event"], deliveryId: string): Promise<void>;
  /** Plan 2, Task 14: where an `installation.created` delivery goes, before anything else. Absent, the event is unsupported as before. */
  installationCreated?: (deliveryId: string, payload: InstallationCreatedPayload) => Promise<unknown>;
  /** Plan 2, Task 15: where the other `installation` actions and `installation_repositories` go. Absent, they are unsupported as before. */
  installationLifecycle?: (deliveryId: string, event: InstallationLifecycleEvent) => Promise<unknown>;
  /**
   * Plan 4 Task 21: where a verified pull request, issue, deployment status or workflow run event goes to start triggers' work, whether or not it is a linked pull request's. Absent,
   * those events are what they were (refused unless they are a linked pull request's feedback). Present, a signed event neither this nor the feedback path uses is answered `IGNORED`.
   */
  triggerEvents?: (input: { eventName: string; payload: unknown; installationId: number }) => Promise<{ events: number; duplicates: number }>;
  /**
   * Team record (R5): offered every verified delivery before it is looked at (`createGithubRecordTap`). It never throws and decides for itself what to keep;
   * an event it does not use, or a repository no project has registered, is left alone. Absent: nothing is offered, as before.
   */
  recordTap?: (verified: { eventName: string | undefined; deliveryId: string; payload: unknown }) => Promise<unknown>;
  now(): string;
}): Promise<{ status: "ACCEPTED" | "DUPLICATE" | "IN_PROGRESS" | "IGNORED"; deliveryId: string; lifecycle?: true; trigger?: true }> {
  if ((input.installationCreated !== undefined || input.installationLifecycle !== undefined)
    && Object.entries(input.headers).some(([key, value]) => key.toLowerCase() === "x-github-event" && (value === "installation" || value === "installation_repositories"))) {
    return handleInstallationEvent(input, {
      ...(input.installationCreated === undefined ? {} : { created: input.installationCreated }),
      ...(input.installationLifecycle === undefined ? {} : { lifecycle: input.installationLifecycle }),
    });
  }
  const triggerEvents = input.triggerEvents;
  let verifiedDelivery: string | undefined;
  let triggered: { events: number; duplicates: number } | undefined;
  let received: ReceivedGithubWebhook;
  try {
    received = await receiveGithubWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      secret: input.secret,
      authorizeRepository: input.authorizeRepository,
      reserveDelivery: (delivery) => reserveGithubWebhookDelivery({
        documentClient: input.documentClient,
        tableName: input.tableName,
        ...delivery,
        now: input.now(),
      }),
      ...(triggerEvents === undefined && input.recordTap === undefined ? {} : {
        onVerified: async ({ eventName, deliveryId, payload }) => {
          verifiedDelivery = deliveryId;
          if (input.recordTap !== undefined) await withinBudget(input.recordTap({ eventName, deliveryId, payload }), RECORD_TAP_BUDGET_MS);
          if (triggerEvents === undefined || eventName === undefined || !GITHUB_TRIGGER_EVENT_NAMES.has(eventName)) return;
          const installation = z.object({ installation: z.object({ id: z.number().int().positive() }).passthrough() }).passthrough().safeParse(payload);
          if (installation.success) triggered = await triggerEvents({ eventName, payload, installationId: installation.data.installation.id });
        },
      }),
    });
  } catch (error) {
    // A check or status event no task follows is ignored, whether or not triggers are set up.
    if (error instanceof GithubWebhookIgnorable && error.ignoredDeliveryId !== undefined) return { status: "IGNORED", deliveryId: error.ignoredDeliveryId };
    // A signed event the feedback path has no use for: if triggers took it, it is accepted (or a duplicate); if nothing did, it is ignored, and neither is a refusal.
    if (triggerEvents === undefined || !(error instanceof GithubWebhookIgnorable) || verifiedDelivery === undefined) throw error;
    if (triggered === undefined) return { status: "IGNORED", deliveryId: verifiedDelivery };
    const taken: { events: number; duplicates: number } = triggered;
    return { status: taken.events === 0 && taken.duplicates > 0 ? "DUPLICATE" : "ACCEPTED", deliveryId: verifiedDelivery, trigger: true };
  }
  const processed = await processGithubWebhookDelivery({
    documentClient: input.documentClient,
    tableName: input.tableName,
    received,
    process: (event, deliveryId) => input.process(event, deliveryId),
    now: () => input.now(),
  });
  return {
    status: processed === "PROCESSED" ? "ACCEPTED" : processed,
    deliveryId: received.deliveryId,
  };
}

/** Validates GitHub's X-Hub-Signature-256 over the unchanged UTF-8 request body (P6: the one implementation lives with the neutral normaliser). */
export { verifyGithubWebhookSignature } from "../plugins/code-host/github/signature.js";

/** Verifies provider signature, event shape and configured repository scope before reserving a delivery. */
export async function receiveGithubWebhook(input: ReceiveGithubWebhookInput): Promise<ReceivedGithubWebhook> {
  if (Buffer.byteLength(input.rawBody, "utf8") > 1_048_576) throw new GithubWebhookRefusal("GitHub webhook payload exceeds the size limit");
  const headers = Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!verifyGithubWebhookSignature(input.rawBody, headers["x-hub-signature-256"], input.secret)) {
    throw new GithubWebhookRefusal(GITHUB_WEBHOOK_SIGNATURE_INVALID);
  }
  const deliveryId = headers["x-github-delivery"];
  if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) throw new GithubWebhookRefusal("GitHub webhook delivery ID is invalid");
  const eventName = headers["x-github-event"];
  const followed = eventName === "pull_request" || eventName === "pull_request_review" || eventName === "pull_request_review_comment" || eventName === "issue_comment"
    || (eventName !== undefined && HEAD_EVENT_NAMES.has(eventName));
  if (!followed && input.onVerified === undefined) throw new GithubWebhookRefusal("GitHub webhook event type is unsupported");
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new GithubWebhookRefusal("GitHub webhook JSON body is invalid");
  }
  await input.onVerified?.({ eventName, deliveryId, payload: raw });
  if (!followed) throw new GithubWebhookIgnorable("GitHub webhook event type is unsupported");
  if (eventName !== undefined && HEAD_EVENT_NAMES.has(eventName)) return receiveHeadEvent(input, { eventName, deliveryId, rawBody: input.rawBody, raw });
  const parsed = GitHubWebhookPayloadSchema.safeParse(raw);
  const object = parsed.success ? parsed.data : undefined;
  if (object === undefined) throw new GithubWebhookIgnorable("GitHub webhook event payload is unsupported or incomplete");
  let number: number;
  let comment: PullRequestWebhookEvent["comment"];
  if (eventName === "pull_request" && object.pull_request !== undefined && PULL_REQUEST_ACTIONS.has(object.action)) {
    number = object.pull_request.number;
  } else if (eventName === "pull_request_review" && object.pull_request !== undefined && object.review !== undefined && REVIEW_ACTIONS.has(object.action)) {
    number = object.pull_request.number;
    comment = toComment(object.review, "review");
  } else if (eventName === "pull_request_review_comment" && object.pull_request !== undefined && object.comment !== undefined && COMMENT_ACTIONS.has(object.action)) {
    number = object.pull_request.number;
    comment = toComment(object.comment, "review_comment");
  } else if (eventName === "issue_comment" && object.issue?.pull_request !== undefined && object.comment !== undefined && COMMENT_ACTIONS.has(object.action)) {
    number = object.issue.number;
    comment = toComment(object.comment, "pr_discussion");
  } else {
    throw new GithubWebhookIgnorable("GitHub webhook event payload is unsupported or incomplete");
  }
  const scope = {
    installationId: object.installation.id,
    repositoryId: object.repository.id,
    fullName: object.repository.full_name.toLowerCase(),
    pullRequestNumber: number,
  };
  if (!await input.authorizeRepository(scope)) throw new GithubWebhookIgnorable("GitHub webhook repository is outside the registered installation and repository scope");
  const event: PullRequestWebhookEvent = {
    kind: comment === undefined ? "PULL_REQUEST" : "PR_COMMENT",
    action: object.action,
    installationId: scope.installationId,
    repositoryId: scope.repositoryId,
    fullName: scope.fullName,
    number,
    ...(eventName === "pull_request" && object.action === "synchronize" && /^[a-f0-9]{40}$/.test(object.pull_request?.head?.sha ?? "") ? { headSha: object.pull_request!.head!.sha } : {}),
    ...(comment === undefined ? {} : { comment }),
  };
  const reserved = await input.reserveDelivery({
    deliveryId,
    ...scope,
    // GitHub signs the body, not X-GitHub-Event; bind the unsigned dispatch header into the
    // idempotency identity so a reused delivery cannot be reinterpreted as another event type.
    eventHash: createHash("sha256").update(eventName, "utf8").update("\0").update(input.rawBody, "utf8").digest("hex"),
    event,
  });
  if (reserved === "conflict") throw new GithubWebhookRefusal("GitHub delivery ID was reused with different content");
  return {
    delivery: reserved === "duplicate" ? "DUPLICATE" : "ACCEPTED",
    deliveryId,
    event,
  };
}

/**
 * A check or status delivery (Plan 6 Task 14). It is matched to a task by the commit (and the Rovara branch when it names one), through the caller's `authorizeRepository`; one no task
 * follows is answered IGNORED (a 202), as an event Rovara has no use for. Its body is only a nudge: nothing in it is believed.
 */
async function receiveHeadEvent(
  input: ReceiveGithubWebhookInput,
  delivery: { eventName: string; deliveryId: string; rawBody: string; raw: unknown },
): Promise<ReceivedGithubWebhook> {
  const ignore = (message: string): never => {
    const ignorable = new GithubWebhookIgnorable(message);
    ignorable.ignoredDeliveryId = delivery.deliveryId;
    throw ignorable;
  };
  const parsed = HeadEventPayloadSchema.safeParse(delivery.raw);
  if (!parsed.success) return ignore("GitHub webhook event payload is unsupported or incomplete");
  const body = parsed.data;
  const headSha = (delivery.eventName === "status" ? body.sha : delivery.eventName === "check_suite" ? body.check_suite?.head_sha : body.check_run?.head_sha) ?? "";
  if (!COMMIT_SHA.test(headSha)) return ignore("GitHub webhook event names no commit");
  const branches = delivery.eventName === "status" ? (body.branches ?? []).map((branch) => branch.name)
    : [delivery.eventName === "check_suite" ? body.check_suite?.head_branch : body.check_run?.check_suite?.head_branch ?? undefined];
  const branch = branches.find((name): name is string => typeof name === "string" && ROVARA_BRANCH.test(name));
  const scope = {
    installationId: body.installation.id, repositoryId: body.repository.id, fullName: body.repository.full_name.toLowerCase(), headSha,
    ...(branch === undefined ? {} : { branch }),
  };
  if (!await input.authorizeRepository(scope)) return ignore("GitHub webhook repository or commit is not followed by a task");
  const event: HeadWebhookEvent = {
    kind: "HEAD_STATUS", action: body.action ?? "status", installationId: scope.installationId, repositoryId: scope.repositoryId, fullName: scope.fullName, headSha,
    ...(branch === undefined ? {} : { branch }),
  };
  const reserved = await input.reserveDelivery({
    deliveryId: delivery.deliveryId, installationId: scope.installationId, repositoryId: scope.repositoryId,
    eventHash: createHash("sha256").update(delivery.eventName, "utf8").update("\0").update(delivery.rawBody, "utf8").digest("hex"),
    event,
  });
  if (reserved === "conflict") throw new GithubWebhookRefusal("GitHub delivery ID was reused with different content");
  return { delivery: reserved === "duplicate" ? "DUPLICATE" : "ACCEPTED", deliveryId: delivery.deliveryId, event };
}

function toComment(input: { id: number; body?: string | null | undefined; html_url: string; updated_at?: string | undefined; path?: string | undefined; line?: number | undefined; diff_hunk?: string | undefined; user: { login: string } }, source: NonNullable<PullRequestWebhookEvent["comment"]>["source"]): NonNullable<PullRequestWebhookEvent["comment"]> {
  let url: URL;
  try {
    url = new URL(input.html_url);
  } catch {
    throw new GithubWebhookRefusal("GitHub PR comment URL is invalid");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username !== "" || url.password !== "") {
    throw new GithubWebhookRefusal("GitHub PR comment URL is outside the GitHub web origin");
  }
  const body = removeControlCharacters(input.body ?? "");
  return {
    id: input.id,
    body: body.slice(0, MAX_REVIEW_COMMENT_CHARS),
    truncated: body.length > MAX_REVIEW_COMMENT_CHARS,
    url: url.toString(),
    author: input.user.login,
    ...(input.updated_at === undefined ? {} : { updatedAt: input.updated_at }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.line === undefined ? {} : { line: input.line }),
    ...(input.diff_hunk === undefined ? {} : { diffHunk: input.diff_hunk.slice(0, 4_000) }),
    source,
  };
}
