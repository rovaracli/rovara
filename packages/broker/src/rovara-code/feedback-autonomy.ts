// Rovara Code (Plan 6 Task 16): fixing review comments under autonomy. The feedback slot of merge tracking. When the owner's feedback card waits (a complete review of the comments on a
// pull request Rovara opened), Rovara may decide it itself, as itself (`actorId: "rovara"`, `actorRole: "ROVARA_AUTONOMY"`, never the owner's), but only when ALL of these hold:
//   - the task's autonomy is `prepare` or `run` (`suggest` asks about everything);
//   - fewer than `FEEDBACK_AUTO_ROUNDS_MAX` automatic rounds have run on the task;
//   - every comment of the round's WHOLE comment set was written by a human with write access to the repository (read live, from GitHub, in this pass), whatever the findings cite;
//   - every finding is one the review marked actionable and recommended (a fix to make).
// Anything else leaves the card to the owner, as before. Comments are untrusted input: the rule never reads what a comment says, only who wrote it and what the review made of it, and a
// comment cannot change the run's tools, limits, push target or path (the round is an ordinary coding run, paid like any other, that pushes to the task's own branch at the expected head).
// While the card waits, failing CI is added to it (and folded into the decision that follows) instead of starting a CI round of its own.
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  FEEDBACK_AUTONOMY_ACTOR_ID,
  FEEDBACK_AUTO_ROUNDS_MAX,
  FEEDBACK_CI_CHECKS_MAX,
  INDEX_EXPIRY_ATTRIBUTE,
  decideWorkflowFeedbackFindings,
  feedbackCardCiFailures,
  feedbackCiFailuresDigest,
  feedbackFixedReply,
  recordWorkflowFeedbackCiFailures,
  workflowFixRounds,
  workflowRequestId,
  type Autonomy,
  type OrgId,
  type WorkflowFixRounds,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { GithubMergeRateLimitError, type GitHubTokenScope } from "../github-app.js";
import type { GithubMergeReadBudget } from "../aws/workflow-merge-recovery.js";
import { WORKFLOW_NO_CANDIDATE_DIGEST, workflowDispatchItem } from "../aws/broker-shared.js";
import type { TransactItem } from "../agents/table-writes.js";
import { ciEvidenceItem, ciOutputBlock, collectCiEvidence, oneLine } from "./ci-fix.js";
import { codeMilestoneItems } from "./milestones.js";
import { PERMISSION_LOOKUPS_MAX, TrackingRequestCapError, registerMergeActionDecider, type MergeActionContext, type MergeActionInput, type MergeActionRequest, type RepositoryStanding } from "./merge-tracking.js";

/** A login GitHub gives only to an App's bot account ends like this; a person's login can never contain brackets. */
export function isBotLogin(login: string): boolean {
  return /\[bot\]$/iu.test(login);
}

/** The key a person's standing is kept under: they are looked up on the repository of the pull request their comment is on (a writer on one repository may only read another). */
export const standingKey = (repositoryId: string, login: string): string => `${repositoryId}\u0000${login.toLowerCase()}`;

/** What the rule reads of a round: who wrote each comment of the whole set (and on which repository), and what the review made of each finding. */
export interface FeedbackRound {
  comments: ReadonlyArray<{ id: string; author: string; repositoryId: string }>;
  findings: ReadonlyArray<{ assessment: string; recommended: boolean }>;
}

/**
 * Whether Rovara may fix a feedback round on its own (question 5). `standings` holds each author's live permission on the repository of their comment, under `standingKey`; an author nobody looked up is unknown, and unknown
 * is not a writer. A bot, or any account GitHub does not call a `User` (an organization, a bot), never counts, whatever its permission. Any finding that is not actionable, or has no fix to make, sends
 * the whole round to the owner.
 */
export function autoFixableRound(round: FeedbackRound, standings: ReadonlyMap<string, RepositoryStanding>, autonomy: Autonomy, fixRounds: WorkflowFixRounds): boolean {
  if (autonomy !== "prepare" && autonomy !== "run") return false;
  if (fixRounds.feedbackAuto >= FEEDBACK_AUTO_ROUNDS_MAX) return false;
  if (round.comments.length === 0 || round.findings.length === 0) return false;
  for (const comment of round.comments) {
    const standing = standings.get(standingKey(comment.repositoryId, comment.author));
    if (standing === undefined || isBotLogin(comment.author)) return false;
    if (standing.userType !== undefined && standing.userType !== "User") return false;
    if (standing.permission !== "write" && standing.permission !== "admin") return false;
  }
  return round.findings.every((finding) => finding.assessment === "ACTIONABLE" && finding.recommended);
}

/** Every different author of the round's comments on each repository, in the order they first appear (logins compared without regard to case). */
export function commentAuthors(workflow: Pick<WorkflowSnapshot, "feedbackReview">): Array<{ repositoryId: string; login: string }> {
  const seen = new Map<string, { repositoryId: string; login: string }>();
  for (const bundle of workflow.feedbackReview?.bundleRefs ?? []) {
    for (const comment of bundle.comments) if (!seen.has(standingKey(bundle.repositoryId, comment.author))) seen.set(standingKey(bundle.repositoryId, comment.author), { repositoryId: bundle.repositoryId, login: comment.author });
  }
  return [...seen.values()];
}

const isPassLimit = (error: unknown): boolean => error instanceof GithubMergeRateLimitError || error instanceof TrackingRequestCapError || (error instanceof Error && error.name === "GithubBudgetExhaustedError");

/** The cheap checks first, so a round that cannot be automatic costs nobody a lookup: autonomy, rounds left, what the review made of every finding, how many people wrote. */
function mayBeAutomatic(workflow: WorkflowSnapshot, autonomy: Autonomy): boolean {
  const review = workflow.feedbackReview;
  if (review?.status !== "PENDING" || review.reviewRef.status !== "COMPLETE") return false;
  if (autonomy !== "prepare" && autonomy !== "run") return false;
  if (workflowFixRounds(workflow).feedbackAuto >= FEEDBACK_AUTO_ROUNDS_MAX) return false;
  // A work plan of ordered parts resumes through the owner's own approval.
  if (workflow.workflowDependenciesApproval !== undefined) return false;
  const findings = review.reviewRef.findingRefs;
  if (findings.length === 0 || !findings.every((finding) => finding.assessment === "ACTIONABLE" && finding.recommended)) return false;
  const authors = commentAuthors(workflow);
  return authors.length > 0 && authors.length <= PERMISSION_LOOKUPS_MAX && !authors.some((author) => isBotLogin(author.login));
}

/** The pull request whose pass owns the card's failing checks: the first open one, so several pull requests never take turns rewriting the same list. */
function drivesCard(workflow: WorkflowSnapshot, context: MergeActionContext): boolean {
  const open = (workflow.pullRequests ?? []).filter((entry) => entry.state === "OPEN" || entry.state === "UNKNOWN")
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);
  return open[0]?.repositoryId === context.repositoryId && open[0].number === context.pullRequestNumber;
}

/** Whether the round is Rovara's to fix, from live reads. A lookup that fails, a report that cannot be read, or a person who cannot be told from a writer leaves it to the owner. */
async function roundIsAutomatic(input: MergeActionInput, context: MergeActionContext): Promise<boolean> {
  const { workflow, autonomy } = input;
  if (!mayBeAutomatic(workflow, autonomy) || context.standingOf === undefined || context.feedbackRoundCheck === undefined) return false;
  try {
    // The stored report and comments are read before anyone is asked about on GitHub: it is free of the allowance.
    if (!await context.feedbackRoundCheck()) return false;
    const standings = new Map<string, RepositoryStanding>();
    for (const author of commentAuthors(workflow)) standings.set(standingKey(author.repositoryId, author.login), await context.standingOf(author.login, author.repositoryId));
    const review = workflow.feedbackReview!;
    return autoFixableRound({
      comments: review.bundleRefs.flatMap((bundle) => bundle.comments.map((comment) => ({ id: comment.id, author: comment.author, repositoryId: bundle.repositoryId }))),
      findings: review.reviewRef!.findingRefs.map((finding) => ({ assessment: finding.assessment, recommended: finding.recommended })),
    }, standings, autonomy, workflowFixRounds(workflow));
  } catch (error) {
    if (error instanceof TrackingRequestCapError) {
      // Out of requests while deciding: the card stays with the owner for now, and the pass is tried again once its item is written.
      context.noteCapped?.();
      return false;
    }
    if (isPassLimit(error)) throw error;
    context.log?.("feedback_autonomy.round_unchecked", { taskId: context.taskId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

const names = (checks: readonly string[]): string => checks.slice(0, 3).join(", ") + (checks.length > 3 ? ` and ${String(checks.length - 3)} more` : "");

/**
 * The feedback slot. Called only while the owner's card is being prepared or waits (`nextMergeAction`); it acts only on a complete review waiting for a decision.
 * Either Rovara decides it (a counted round, decided as Rovara's own, with the coding run's dispatch row and its milestone), or the failing checks are added to (or taken off) the card.
 */
export async function feedbackDecider(input: MergeActionInput): Promise<MergeActionRequest | undefined> {
  const { item, workflow, context } = input;
  if (context === undefined) return undefined;
  const review = workflow.feedbackReview;
  if (review?.status !== "PENDING" || review.reviewRef.status !== "COMPLETE") return undefined;
  const at = new Date(input.now).toISOString();
  const driver = drivesCard(workflow, context);
  const failing = driver && item.ci === "failing"
    ? [...new Set(item.failingChecks.map((check) => oneLine(check, 200)).filter((check) => check !== ""))].sort().slice(0, FEEDBACK_CI_CHECKS_MAX) : [];
  const shown = feedbackCardCiFailures(workflow);
  const changes = driver && (failing.length === 0 ? shown !== undefined : shown?.digest !== feedbackCiFailuresDigest(failing));
  const automatic = await roundIsAutomatic(input, context);
  if (!automatic && !changes) return undefined;

  let next = workflow;
  const items: TransactItem[] = [];
  if (changes) {
    next = recordWorkflowFeedbackCiFailures(next, { checks: failing, now: at });
    // What CI said, kept for the decision that follows (under the revision that added it to the card).
    if (failing.length > 0) {
      const evidence = await collectCiEvidence(context);
      items.push(ciEvidenceItem(context.tableName, { orgId: context.orgId, taskId: context.taskId, revision: next.revision, block: ciOutputBlock(evidence), now: input.now }));
    }
  }
  if (!automatic) return { slot: "feedback", workflow: next, items };

  const decided = decideWorkflowFeedbackFindings(next, {
    requestId: workflowRequestId("agentx-auto-feedback", context.taskId, workflow.revision, review.reviewRef.sha256),
    expectedRevision: next.revision, reviewDigest: review.reviewRef.sha256, proposalDigest: review.reviewRef.proposalDigest,
    bundleDigests: review.bundleRefs.map((bundle) => bundle.sha256), selectedFindingIds: review.reviewRef.findingRefs.map((finding) => finding.id), decision: "APPROVE",
  }, {
    actorId: FEEDBACK_AUTONOMY_ACTOR_ID, role: "ROVARA_AUTONOMY",
    autonomy: { level: input.autonomy as "prepare" | "run", ...(context.recipeDigest === undefined ? {} : { recipeDigest: context.recipeDigest }) },
  }, at);
  const round = workflowFixRounds(decided).feedbackAuto;
  items.push(
    workflowDispatchItem(context.tableName, context.taskId, decided.revision, "IMPLEMENT", decided.candidate?.digest ?? WORKFLOW_NO_CANDIDATE_DIGEST, at),
    ...codeMilestoneItems({ tableName: context.tableName }, {
      kind: "fixing", orgId: context.orgId, taskId: context.taskId, ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }), at,
      text: `Rovara is fixing the review comments on its own (round ${String(round)} of ${String(FEEDBACK_AUTO_ROUNDS_MAX)}).${failing.length === 0 ? "" : ` It is fixing the failing ${names(failing)} in the same round.`}`.slice(0, 500),
      pullRequests: [{ repository: context.repositoryId, number: context.pullRequestNumber, url: context.pullRequestUrl }],
    }, decided.revision),
  );
  return { slot: "feedback", workflow: decided, items };
}

let installed: (() => void) | undefined;

/** Fills the feedback slot of merge tracking, once for the process. */
export function installFeedbackDecider(): void {
  installed ??= registerMergeActionDecider("feedback", feedbackDecider);
}

/** For tests: empties the slot again. */
export function uninstallFeedbackDecider(): void {
  installed?.();
  installed = undefined;
}

// ---- the one reply on each fixed thread

/** How many times one reply item is tried before it is given up (a courtesy, never worth a loop). */
export const FEEDBACK_REPLY_ATTEMPTS_MAX = 3;
const REPLY_RETENTION_SECONDS = 30 * 86_400;

export const feedbackReplyKey = (taskId: string, requestId: string, repositoryId: string, number: number): { pk: string; sk: string } =>
  ({ pk: `DEVTASK#${taskId}`, sk: `FEEDBACK_REPLY#${requestId}#${repositoryId}#${String(number)}` });

/**
 * The reply a push leaves behind, written in the transaction that records the push: for a round Rovara decided itself, one reply on each review thread whose comments it fixed (the first selected
 * comment of the thread, naming the commit that holds the fix). A round a person decided leaves none. No thread, no item.
 */
export function feedbackReplyItems(input: { tableName: string; orgId: string; workflow: WorkflowSnapshot; repositoryId: string; number: number; head: string; now: string }): TransactItem[] {
  const decision = [...(input.workflow.feedbackDecisions ?? [])].reverse().find((entry) => entry.decision === "APPROVE" && entry.actorRole === "ROVARA_AUTONOMY");
  const review = input.workflow.feedbackReview;
  if (decision === undefined || review?.status !== "APPROVED" || review.reviewRef.sha256 !== decision.reviewDigest) return [];
  const bundle = review.bundleRefs.find((entry) => entry.repositoryId === input.repositoryId && entry.number === input.number);
  if (bundle === undefined) return [];
  const firstOfThread = new Map<string, string>();
  for (const comment of bundle.comments) {
    const id = /^review_comment:([1-9][0-9]*)$/u.exec(comment.id)?.[1];
    if (id === undefined || comment.threadId === undefined || !decision.selectedCommentIds.includes(comment.id) || firstOfThread.has(comment.threadId)) continue;
    firstOfThread.set(comment.threadId, id);
  }
  if (firstOfThread.size === 0) return [];
  return [{ Put: {
    TableName: input.tableName, ConditionExpression: "attribute_not_exists(pk)",
    Item: { ...feedbackReplyKey(input.workflow.taskId, decision.requestId, input.repositoryId, input.number), entityType: "FEEDBACK_REPLY", orgId: input.orgId, taskId: input.workflow.taskId,
      repositoryId: input.repositoryId, number: input.number, head: input.head, commentIds: [...firstOfThread.values()], repliedIds: [], state: "pending", attempts: 0,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(input.now) / 1000) + REPLY_RETENTION_SECONDS },
  } }];
}

export interface FeedbackReplyDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now(): number;
  github: { replyToReviewThread(repositoryUrl: string, number: number, commentId: string, body: string, scope: GitHubTokenScope, budget?: GithubMergeReadBudget): Promise<"replied" | "gone"> };
  scope(orgId: OrgId): GitHubTokenScope;
  repositoryUrl(project: string, revision: number, repositoryId: string, orgId: OrgId): Promise<string | undefined>;
  log?(event: string, fields: Record<string, unknown>): void;
}

/**
 * Sends the replies a landed push left to send, each once: a reply is claimed (one more attempt, up to `FEEDBACK_REPLY_ATTEMPTS_MAX`), sent, and written down before the next, so a retry never
 * repeats one that went. A thread that is gone is not an error. A failure leaves the rest for the next pass, and a rate limit goes up to the sweep.
 */
export async function sendFeedbackReplies(deps: FeedbackReplyDependencies, task: { taskId: string; orgId: OrgId; project: string; startingRevision: number }, budget?: GithubMergeReadBudget): Promise<number> {
  const found = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `DEVTASK#${task.taskId}`, ":prefix": "FEEDBACK_REPLY#" },
  })) as { Items?: Array<Record<string, unknown>> };
  let sent = 0;
  for (const stored of found.Items ?? []) {
    if (stored["orgId"] !== task.orgId || stored["taskId"] !== task.taskId || stored["state"] !== "pending") continue;
    const attempts = typeof stored["attempts"] === "number" ? stored["attempts"] : FEEDBACK_REPLY_ATTEMPTS_MAX;
    const repositoryId = stored["repositoryId"];
    const number = stored["number"];
    const head = stored["head"];
    const commentIds = Array.isArray(stored["commentIds"]) ? stored["commentIds"].filter((id): id is string => typeof id === "string") : [];
    const repliedIds = Array.isArray(stored["repliedIds"]) ? stored["repliedIds"].filter((id): id is string => typeof id === "string") : [];
    if (attempts >= FEEDBACK_REPLY_ATTEMPTS_MAX || typeof repositoryId !== "string" || typeof number !== "number" || typeof head !== "string" || !/^[a-f0-9]{40}$/u.test(head)) continue;
    const key = { pk: String(stored["pk"]), sk: String(stored["sk"]) };
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "SET attempts = :next", ConditionExpression: "#state = :pending AND attempts = :seen",
        ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":next": attempts + 1, ":seen": attempts, ":pending": "pending" },
      }));
    } catch (error) {
      // Another pass holds it (or it is done): not this one's.
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") continue;
      throw error;
    }
    const url = await deps.repositoryUrl(task.project, task.startingRevision, repositoryId, task.orgId);
    if (url === undefined) continue;
    try {
      for (const commentId of commentIds.filter((id) => !repliedIds.includes(id))) {
        await deps.github.replyToReviewThread(url, number, commentId, feedbackFixedReply(head), deps.scope(task.orgId), budget);
        repliedIds.push(commentId);
        sent += 1;
        await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, UpdateExpression: "SET repliedIds = :replied", ExpressionAttributeValues: { ":replied": repliedIds } }));
      }
      await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: key, UpdateExpression: "SET #state = :done", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":done": "done" } }));
    } catch (error) {
      if (isPassLimit(error) && !(error instanceof TrackingRequestCapError)) throw error;
      deps.log?.("feedback_autonomy.reply_failed", { taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return sent;
}

// ---- what still has to hold when the worker starts

/**
 * Whether a stored decision and the approval the worker presents agree about who decided: the role and the binding go together (a decision Rovara made carries, and is bound to, the autonomy it was
 * made under; a person's carries none), and both name the same failing checks (or none).
 */
export function feedbackApprovalMatchesDecision(
  decision: { actorRole: "TASK_OWNER" | "ROVARA_AUTONOMY"; autonomy?: { level: string; recipeDigest?: string | undefined } | undefined; ciFailures?: { digest: string } | undefined },
  approval: { autonomy?: { level: string; recipeDigest?: string | undefined } | undefined; ciFailuresDigest?: string | undefined },
): boolean {
  // Field by field: a stored map comes back from DynamoDB in no particular key order.
  const sameAutonomy = decision.actorRole === "TASK_OWNER" ? approval.autonomy === undefined
    : approval.autonomy !== undefined && decision.autonomy !== undefined && decision.autonomy.level === approval.autonomy.level && decision.autonomy.recipeDigest === approval.autonomy.recipeDigest;
  return sameAutonomy && decision.ciFailures?.digest === approval.ciFailuresDigest;
}

export interface AutonomyHoldDependencies {
  /** The task's autonomy and the digest of its frozen recipe, read now: the stricter of the recipe and the company's limit (`suggest` when it cannot be read). */
  autonomy(): Promise<{ autonomy: Autonomy; recipeDigest?: string | undefined }>;
  repositoryUrl(repositoryId: string): Promise<string | undefined>;
  /** A person's standing on a repository, read now; undefined where this provider cannot ask. */
  standing: ((repositoryUrl: string, login: string) => Promise<RepositoryStanding>) | undefined;
}

/**
 * Whether Rovara's own decision on review comments still stands when the worker starts: the task's autonomy (read now) is still `prepare` or `run` and the recipe is the one the decision was bound to,
 * and every person who wrote a comment of the round still has write access on GitHub and is a person, not a bot (read now). Anything it cannot read fails closed.
 */
export async function autonomyStillHolds(
  deps: AutonomyHoldDependencies,
  task: { workflow?: Pick<WorkflowSnapshot, "feedbackReview"> | undefined },
  binding: { autonomy?: { level: string; recipeDigest?: string | undefined } | undefined },
): Promise<boolean> {
  const bound = binding.autonomy;
  const review = task.workflow?.feedbackReview;
  if (bound === undefined || review === undefined || deps.standing === undefined) return false;
  const live = await deps.autonomy();
  if (live.autonomy !== "prepare" && live.autonomy !== "run") return false;
  if (live.recipeDigest !== bound.recipeDigest) return false;
  try {
    for (const bundle of review.bundleRefs) {
      const url = await deps.repositoryUrl(bundle.repositoryId);
      if (url === undefined) return false;
      for (const login of new Set(bundle.comments.map((comment) => comment.author))) {
        if (isBotLogin(login)) return false;
        const standing = await deps.standing(url, login);
        if ((standing.permission !== "write" && standing.permission !== "admin") || (standing.userType !== undefined && standing.userType !== "User")) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}
