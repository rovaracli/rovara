// Rovara Code (Plan 6 Task 19): a person approves, and a person presses Merge. Rovara never merges by itself (owner decision 1; confirmed 2026-10-27: no automatic merge).
//
// Owner decision 2026-10-27: pressing Merge in the web app is ONE click for every pull request (a browser session with its CSRF token, one confirm dialog in the app, no email-code sign-in): the press
// merges at once, through the same path as the confirmation page. The risk of the code (Low, Medium or High, with its reasons) is shown next to Merge, and a press must have seen the current level.
// Where the repository has a CODEOWNERS file that covers the changed paths, a code owner has to approve first. A token (the CLI, an AI tool) never merges: its press is the confirmation link below.
//
// - `humanApprovalOf` says whose approval on GitHub counts (a person with write access, a member of the org who is not a requester unless the org allows self-approval, on the head).
// - `mergeReadiness` says whether every required pull request of a task may be merged, in the exact words of `MERGE_NOT_READY`.
// - `pressMerge` (`POST /v1/app/sessions/{id}/merge`) turns a press into ONE pending change that lists every pull request and its head. Its presser decides it on Plan 3's
//   confirmation page (R66); the CLI and the AI tools never decide.
// - The change's handler is the single merge path: it re-reads every pull request and every reviewer from GitHub (never the stored items), re-checks readiness for the exact heads,
//   and only then claims each pull request on its tracking item and merges it, in repository order, with the checked head as `sha`.
import { createHash } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  MERGE_CLAIM_SECONDS,
  MERGE_NOT_READY_MESSAGES as M,
  MERGE_VIEW_MESSAGE_MAX,
  MergePressBodySchema,
  agentXError,
  auditPullRequestId,
  isBranchSyncBlockReason,
  isCiFixBlockReason,
  mergeTrackingKey,
  sessionEventId,
  type AuditProof,
  type CodeSettings,
  type MergeTrackingItem,
  type MergeDone,
  type MergeRisk,
  type MergeView,
  type NeedsConfirmation,
  type OrgId,
  type WorkflowSnapshot,
} from "@agentx/contracts";
import { auditOccurrence, auditPullRequestMergeRequested } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { findLinkedGithubWorkflowPullRequest } from "../aws/github-webhooks.js";
import { requireSessionLevel } from "../agent-sessions/access.js";
import { confirmationReply, type SessionShareDependencies, type ShareCaller } from "../agent-sessions/shares.js";
import { sessionEventItem } from "../agent-sessions/store.js";
import { createPendingChange, registerApprovalSubjectHandler, registerApproverRule, type ApprovalDependencies } from "../agents/approvals.js";
import type { AnyApprovalRecord } from "../agents/approvals-store.js";
import { personNameForText } from "../developer/requester-text.js";
import { ownerDisplayName, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { GitHubTokenScope, MergePullRequestResult } from "../github-app.js";
import { parseGitHubRepository } from "../github-app.js";
import type { PullRequestStatus } from "../github-pull-status.js";
import { readCodeSettings } from "./code-settings.js";
import { codeOwnerVerdict, type CodeOwnerVerdict } from "./code-owners.js";
import { humanApprovalOf, latestReviewers, linkedAmong, requesterGithubIds, type HumanApproval, type ApprovalRefusal, type RepositoryPermission } from "./approval.js";
import { githubUserOfMember } from "./github-members.js";
import { codeMilestoneItems, deliverCodeMilestones } from "./milestones.js";
import { PERMISSION_LOOKUPS_MAX, readBranch, readCi, readMergeTracking, tracksMerge } from "./merge-tracking.js";

/** The rule a merge change names: only the person who pressed Merge decides it, while they can still press it. */
export const MERGE_RULE = "pull_request_merge";


// ---- whether the pull requests may be merged

/** What readiness needs of one pull request: from the tracking item (a view) or from a fresh read of GitHub (the press and the handler). */
export interface MergePullRequestFacts {
  repositoryId: string;
  number: number;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  baseBranch: string;
  ci: "none" | "pending" | "passing" | "failing";
  branch: "up_to_date" | "behind" | "conflicted" | "unknown";
  /** GitHub itself calls the branch behind (it does so only for a base that requires up-to-date branches). */
  behindRequired: boolean;
}

export interface ReadinessWorkflow {
  stage: string;
  state: string;
  blockReason?: string | undefined;
  fixSource?: unknown;
  branchSync?: unknown;
  feedbackReview?: { status?: string | undefined } | undefined;
}

export interface ReadinessInput {
  /** Every required pull request of the task, in repository order. */
  pullRequests: readonly MergePullRequestFacts[];
  /** Each pull request's counted approval, by `repositoryId#number`; a missing one is none. */
  approvals: ReadonlyMap<string, HumanApproval>;
  workflow: ReadinessWorkflow;
  /** The base branch each pull request was opened against, by `repositoryId#number`. */
  recordedBases: ReadonlyMap<string, string>;
  presser: { githubUserId: string | undefined };
  allowSelfApproval: boolean;
  /** The name the person who asked is called by, for the words of an approval that must come from someone else. */
  requesterName: string;
  /** Whether a code owner approved, by `repositoryId#number`, where the repository has a CODEOWNERS file that covers the changed paths (read fresh; absent where nothing was read). */
  codeOwners?: ReadonlyMap<string, CodeOwnerVerdict> | undefined;
}

export type Readiness = { ready: true } | { ready: false; message: string };
export const pullRequestKey = (pr: { repositoryId: string; number: number }): string => `${pr.repositoryId}#${String(pr.number)}`;
const notReady = (message: string): Readiness => ({ ready: false, message });

function approvalMessage(reason: ApprovalRefusal, repository: string, input: Pick<ReadinessInput, "allowSelfApproval" | "requesterName">): string {
  switch (reason) {
    case "none": return input.allowSelfApproval ? M.needsWriteApproval(repository) : M.needsOtherApproval(input.requesterName);
    case "no_write": return M.needsWriteApproval(repository);
    case "self_only": return M.needsOtherApproval(input.requesterName);
    case "unlinked_requester": return M.linkGithub;
    case "stale": return M.staleApproval;
    case "changes_requested": return M.changesRequested;
  }
}

function codeOwnerRefusal(verdict: CodeOwnerVerdict | undefined): string | undefined {
  if (verdict === undefined || verdict.ok) return undefined;
  return "unreadable" in verdict ? M.codeOwnersUnreadable : M.needsCodeOwner(verdict.owners);
}

function workflowRefusal(workflow: ReadinessWorkflow): string | undefined {
  if (workflow.stage === "MERGED" || workflow.stage === "CLOSED") return M.taskClosed;
  if (workflow.stage !== "WAIT_FOR_MERGE") return M.changing;
  if (workflow.state === "BLOCKED") {
    if (isCiFixBlockReason(workflow.blockReason)) return M.checks;
    if (isBranchSyncBlockReason(workflow.blockReason)) return workflow.blockReason;
    return M.changing;
  }
  const card = workflow.feedbackReview?.status;
  if (workflow.state !== "WAITING" || workflow.fixSource !== undefined || workflow.branchSync !== undefined || card === "PENDING" || card === "COLLECTING") return M.changing;
  return undefined;
}

/**
 * Ready needs, for every required pull request that is not merged yet: it is open, on the base it was opened against, not a draft, with CI passing (or none to wait for), a branch
 * that does not conflict and is not behind a base that requires it up to date, and a counted approval; and the task is waiting for the merge with nothing being changed. With
  * the presser must have a linked GitHub account and, with self-approval off, must not be the only approver of any pull request. With several pull requests a refusal names the repository.
 */
export function mergeReadiness(input: ReadinessInput): Readiness {
  const refusal = workflowRefusal(input.workflow);
  if (refusal !== undefined) return notReady(refusal);
  const open = input.pullRequests.filter((pr) => pr.state !== "merged");
  if (open.length === 0) return notReady(M.taskClosed);
  const several = input.pullRequests.length > 1;
  for (const pr of open) {
    const key = pullRequestKey(pr);
    const approval = input.approvals.get(key) ?? { approved: false as const, reason: "none" as const };
    const owner = codeOwnerRefusal(input.codeOwners?.get(key));
    const reason = pr.state !== "open" ? M.notOpen
      : input.recordedBases.get(key) !== pr.baseBranch ? M.baseChanged(pr.baseBranch)
      : pr.draft ? M.draft
      : pr.ci !== "passing" && pr.ci !== "none" ? M.checks
      : pr.branch === "conflicted" ? M.conflicted(pr.baseBranch)
      : !approval.approved ? approvalMessage(approval.reason, pr.repositoryId, input)
      : owner !== undefined ? owner
      // Only a branch that is approved is brought up to date (an approval none counts needs no up-to-date branch yet).
      : pr.branch === "behind" && pr.behindRequired ? M.behind(pr.baseBranch)
      : undefined;
    if (reason !== undefined) return notReady(several ? M.repository(pr.repositoryId, reason) : reason);
  }
  // Whoever presses Merge must have a linked GitHub account, whether the org allows self-approval or not (controller ruling 2026-10-26).
  if (input.presser.githubUserId === undefined) return notReady(M.linkGithub);
  if (!input.allowSelfApproval) {
    for (const pr of open) {
      const approval = input.approvals.get(pullRequestKey(pr));
      if (approval?.approved === true && approval.approvers.length === 1 && approval.approvers[0]!.githubUserId === input.presser.githubUserId) return notReady(M.presserApproved);
    }
  }
  return { ready: true };
}

export { humanApprovalOf, type HumanApproval, type ApprovalRefusal, type RepositoryPermission };

// ---- what the merge needs of the broker

export interface CodeMergeGithub {
  getPullRequestStatus(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<PullRequestStatus>;
  getRepositoryPermission(repositoryUrl: string, login: string, scope: GitHubTokenScope): Promise<RepositoryPermission>;
  mergePullRequest(repositoryUrl: string, number: number, input: { sha: string; method: "squash" | "merge" }, scope: GitHubTokenScope): Promise<MergePullRequestResult>;
  /** The CODEOWNERS file of a branch, undefined where there is none (throws when it cannot be read). Without the three reads below no code owner is asked for. */
  readCodeOwners?(repositoryUrl: string, branch: string, scope: GitHubTokenScope): Promise<string | undefined>;
  /** Every path the pull request changes (a renamed file under both names), and whether that is all of them. */
  listChangedPaths?(repositoryUrl: string, number: number, scope: GitHubTokenScope): Promise<{ paths: string[]; complete: boolean }>;
  /** Whether a person is in a team (`org/slug`) of the repository's organization; `unknown` when that cannot be told. */
  isTeamMember?(repositoryUrl: string, team: string, login: string, scope: GitHubTokenScope): Promise<"member" | "not_member" | "unknown">;
}

export interface CodeMergeHost {
  github: CodeMergeGithub;
  scope(orgId: OrgId): GitHubTokenScope;
  loadTask(taskId: string): Promise<DeveloperTaskRecord | undefined>;
  /** The repository's URL as the task's project pins it. */
  repositoryUrl(project: string, revision: number, repositoryId: string, orgId: OrgId): Promise<string | undefined>;
  /** The base branch the pull request was opened against, from Rovara's own record of it. */
  recordedBase(workspaceId: string, repositoryId: string, number: number): Promise<string | undefined>;
  /** Wakes the tracking pass so a branch GitHub needs up to date is brought up to date (Task 17's sync slot). Only the press calls it. */
  requireSyncForMerge?(task: DeveloperTaskRecord): Promise<void>;
  log?(event: string, fields: Record<string, unknown>): void;
}

type StoreDeps = Pick<ApprovalDependencies, "documentClient" | "tableName" | "now">;
type PullRequestEntry = NonNullable<WorkflowSnapshot["pullRequests"]>[number];

const byRepository = <T extends { repositoryId: string; number: number }>(list: readonly T[]): T[] =>
  [...list].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);

/** The pull requests the task needs merged, in repository order (the merged ones stay: they are skipped, not forgotten). */
export function requiredPullRequests(workflow: WorkflowSnapshot): PullRequestEntry[] {
  return byRepository((workflow.pullRequests ?? []).filter((pr) => pr.required));
}

/** Who asked, for the words of a refusal: never an email address (C60; the display name without it, else "the person who asked"). */
const requesterNameForWords = (name: string): string => {
  const shown = personNameForText(name.replace(/[\p{Cc}\p{Cf}]/gu, " ")) ?? "";
  return shown.slice(0, 80).trim() || "the person who asked";
};
const requesterNameOf = (task: DeveloperTaskRecord): string => requesterNameForWords(ownerDisplayName(task));

// ---- readiness from what tracking stored (the press and the view)

export function factsFromItem(item: MergeTrackingItem, behindRequired = false): MergePullRequestFacts {
  return { repositoryId: item.repositoryId, number: item.number, headSha: item.headSha, state: item.state, draft: item.draft, baseBranch: item.baseBranch, ci: item.ci, branch: item.branch, behindRequired };
}

/** The approval merge tracking stored for a pull request, judged by the same rules: it holds only the latest approval of a person with write access. */
async function approvalOfItem(
  deps: StoreDeps, orgId: OrgId, item: MergeTrackingItem, pullRequest: PullRequestEntry | undefined,
  ctx: { requesters: string[] | "unlinked"; allowSelfApproval: boolean },
): Promise<HumanApproval> {
  if (item.review === "changes_requested") return { approved: false, reason: "changes_requested" };
  if (item.approval === undefined) return { approved: false, reason: "none" };
  const { githubUserId, login, commitId } = item.approval;
  return humanApprovalOf({
    reviews: [{ githubUserId, login, userType: "User", state: "APPROVED", commitId, submittedAt: item.observedAt }],
    headSha: item.headSha, syncedFrom: pullRequest?.syncedFrom, ciPassingOnHead: item.ci === "passing" || item.ci === "none",
    permissions: new Map([[login, "write" as const]]), requesterGithubUserIds: ctx.requesters, linkedGithubUserIds: await linkedAmong(deps, orgId, [githubUserId]),
    allowSelfApproval: ctx.allowSelfApproval,
  });
}

interface StoredReadiness { readiness: Readiness; items: MergeTrackingItem[]; settings: CodeSettings; entries: PullRequestEntry[] }

async function readinessFromItems(
  deps: StoreDeps, host: CodeMergeHost, task: DeveloperTaskRecord & { orgId: OrgId; workflow: WorkflowSnapshot }, items: readonly MergeTrackingItem[], presserDeveloperId: string,
  options: { behindRequired?: ReadonlyMap<string, boolean> } = {},
): Promise<StoredReadiness> {
  const settings = await readCodeSettings(deps, task.orgId, task.project);
  const entries = requiredPullRequests(task.workflow).filter((entry) => entry.state !== "MERGED");
  const itemOf = new Map(items.map((item) => [pullRequestKey(item), item]));
  const requesters = await requesterGithubIds(deps, task.orgId, task);
  const presser = { githubUserId: await githubUserOfMember(deps, task.orgId, presserDeveloperId) };
  const facts: MergePullRequestFacts[] = [];
  const approvals = new Map<string, HumanApproval>();
  const bases = new Map<string, string>();
  for (const entry of entries) {
    const key = pullRequestKey(entry);
    const item = itemOf.get(key);
    // Tracking has not read this pull request yet: nothing is known of it.
    if (item === undefined) return { readiness: notReady(M.notTrackedYet), items: [...items], settings, entries };
    facts.push(factsFromItem(item, options.behindRequired?.get(key) ?? false));
    approvals.set(key, await approvalOfItem(deps, task.orgId, item, entry, { requesters, allowSelfApproval: settings.allowSelfApproval }));
    const base = await host.recordedBase(task.workspaceId, entry.repositoryId, entry.number);
    if (base !== undefined) bases.set(key, base);
  }
  const readiness = mergeReadiness({
    pullRequests: facts, approvals, workflow: task.workflow, recordedBases: bases, presser, allowSelfApproval: settings.allowSelfApproval, requesterName: requesterNameOf(task),
  });
  return { readiness, items: [...items], settings, entries };
}

/** The task view's `merge`: whether the viewer pressing Merge now would be allowed to, from what tracking last read. Undefined where nothing is tracked or merging is not set up. */
export async function mergeViewOf(
  deps: ApprovalDependencies, task: DeveloperTaskRecord, items: readonly MergeTrackingItem[], viewerDeveloperId: string,
): Promise<MergeView | undefined> {
  const host = deps.codeMerge;
  if (host === undefined || items.length === 0 || task.orgId === undefined || !tracksMerge(task.workflow)) return undefined;
  const { readiness } = await readinessFromItems(deps, host, task as DeveloperTaskRecord & { orgId: OrgId; workflow: WorkflowSnapshot }, items, viewerDeveloperId);
  return { ...mergeViewFromReadiness(readiness), risk: riskOfTask(task.workflow, items) };
}

/**
 * The risk the Merge section shows (owner decision 2026-10-27): the level and reasons recorded for the pull request's code. When none is recorded, when it was judged for other code than the workflow's
 * current candidate, or when someone else pushed to a pull request since, the code Rovara would merge is not the code it judged, so the level is at least medium and says so.
 */
export function riskOfTask(workflow: WorkflowSnapshot | undefined, items: ReadonlyArray<{ headByRovara: boolean }>): MergeRisk {
  const recorded = workflow?.risk;
  if (recorded === undefined) return { level: "medium", reasons: ["Rovara hasn't judged the risk of this change yet."] };
  const current = workflow?.candidate?.digest;
  if (current !== undefined && current !== recorded.candidateDigest) return { level: "medium", reasons: ["The risk was judged for earlier code, not the code that would be merged."] };
  if (items.some((item) => !item.headByRovara)) {
    return { level: recorded.level === "low" ? "medium" : recorded.level, reasons: ["Someone else pushed to this pull request after Rovara judged its risk.", ...recorded.reasons].slice(0, 8) };
  }
  return { level: recorded.level, reasons: [...recorded.reasons] };
}

/**
 * The view's `merge` for a readiness. The words of a refusal can carry a repository ID (up to 200 characters) and a branch name (up to 255), so with several pull requests they can pass the
 * 500 the view allows; a view that is too long fails the task view of every client that reads it, so it is cut here, with an ellipsis. The press itself still says the words in full.
 */
export function mergeViewFromReadiness(readiness: Readiness): MergeView {
  if (readiness.ready) return { ready: true };
  if (readiness.message.length <= MERGE_VIEW_MESSAGE_MAX) return { ready: false, message: readiness.message };
  const kept = readiness.message.slice(0, MERGE_VIEW_MESSAGE_MAX - 1);
  // Never end on half of a surrogate pair.
  const last = kept.charCodeAt(kept.length - 1);
  return { ready: false, message: `${last >= 0xd800 && last <= 0xdbff ? kept.slice(0, -1) : kept}\u2026` };
}

// ---- pressing Merge

const UNAVAILABLE = "Merging isn't available right now.";
const changeText = (repository: string, number: number, method: string): string => `Merge ${repository} pull request ${String(number)} (${method})`;

/** The body of a press: `{ requestId }`, and for the web app the risk level the person saw. Nothing else. */
function parsePressBody(raw: unknown) {
  const parsed = MergePressBodySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

export type MergePressReply = { status: 200; body: MergeDone } | { status: 202; body: NeedsConfirmation };

/**
 * `POST /v1/app/sessions/{id}/merge { requestId, risk? }`: the session's effective owner, a maintainer of its project or an org owner or admin presses Merge. Readiness is checked from what tracking
 * stored (the merge re-reads GitHub); a branch GitHub needs up to date is brought up to date first. Not ready, it answers `409 MERGE_NOT_READY` and writes nothing.
 *
 * - A browser session (the web boundary vouched for the cookie and the CSRF token: `caller.browserSession`) merges at once at low or medium risk: one click and the app's own confirm dialog, no email-code
 *   sign-in. The press must name the risk level the person saw when it is medium or high; one that saw another level is refused. Answers `200` with the pull requests merged. At HIGH risk it never merges
 *   on a click: it answers like a token press (below), so the person decides on the confirmation page with a fresh sign-in (owner decision 2026-10-30).
 * - Any other caller (the CLI, an AI tool: a token) never merges. It gets `202 NEEDS_CONFIRMATION` with ONE pending change that lists every required pull request and its head, decided only by the
 *   presser on the confirmation page (R66) with a fresh sign-in.
 */
export async function pressMerge(
  deps: SessionShareDependencies, caller: ShareCaller, sessionId: string, rawBody: unknown, approvals: ApprovalDependencies | undefined,
): Promise<MergePressReply> {
  const { requestId, risk: seen } = parsePressBody(rawBody);
  const host = approvals?.codeMerge;
  if (approvals === undefined || host === undefined) throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
  const access = await requireSessionLevel(deps, caller, sessionId, "view", "merge it");
  if (!access.owner && access.projectRole !== "maintainer" && !access.orgAdmin) {
    throw agentXError("FORBIDDEN", `Only ${requesterNameForWords(access.effectiveOwner.name)}, who asked for this, or a maintainer of ${access.session.project ?? "its project"} can press Merge.`);
  }
  if (access.session.subject.kind !== "task") throw agentXError("CONFIG_INVALID", "Only a task's pull requests are merged from Rovara.");
  const task = await host.loadTask(access.session.subject.taskId);
  if (task === undefined || task.orgId !== caller.orgId) throw agentXError("NOT_FOUND", "session not found");
  if (task.closedAt !== undefined || task.releasedAt !== undefined) throw agentXError("MERGE_NOT_READY", M.taskClosed);
  if (task.orgId === undefined || !tracksMerge(task.workflow)) throw agentXError("CONFIG_INVALID", "This task's pull requests are merged on GitHub.");
  const tracked = task as DeveloperTaskRecord & { orgId: OrgId; workflow: WorkflowSnapshot };
  const items = await readMergeTracking(deps, tracked.taskId, tracked.orgId);

  // A branch that is behind may be one GitHub wants up to date before it merges: only GitHub says so (its `mergeable_state` is `behind`), so it is asked for those alone.
  const behindRequired = new Map<string, boolean>();
  const scope = host.scope(tracked.orgId);
  for (const item of items.filter((candidate) => candidate.branch === "behind")) {
    const entry = requiredPullRequests(tracked.workflow).find((pr) => pr.repositoryId === item.repositoryId && pr.number === item.number);
    const url = entry === undefined ? undefined : await host.repositoryUrl(tracked.project, tracked.startingRevision, entry.repositoryId, tracked.orgId);
    if (url === undefined) continue;
    behindRequired.set(pullRequestKey(item), (await host.github.getPullRequestStatus(url, item.number, scope)).mergeableState === "behind");
  }
  const checked = await readinessFromItems(deps, host, tracked, items, caller.developerId, { behindRequired });
  if (!checked.readiness.ready) {
    // Only the press asks for the sync (a read of the task never does): the tracking pass merges the base in, and the person presses again.
    const behind = items.find((item) => behindRequired.get(pullRequestKey(item)) === true);
    if (behind !== undefined && checked.readiness.message.includes(M.behind(behind.baseBranch))) await host.requireSyncForMerge?.(task);
    throw agentXError("MERGE_NOT_READY", checked.readiness.message);
  }
  const open = checked.entries.filter((entry) => entry.state !== "MERGED");
  const heads = new Map(items.map((item) => [pullRequestKey(item), item.headSha]));
  const subject = {
    kind: MERGE_RULE as typeof MERGE_RULE, taskId: tracked.taskId,
    pullRequests: byRepository(open.map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number, headSha: heads.get(pullRequestKey(entry))! }))),
  };

  // What the person saw in the dialog has to be what is true now: a medium or high risk is part of the click, and a risk that changed since is a new question.
  const current = riskOfTask(tracked.workflow, items).level;
  if (caller.browserSession === true && (seen ?? "low") !== current) throw agentXError("MERGE_NOT_READY", M.riskChanged(current));
  // Owner decision 2026-10-30: a HIGH-risk change never merges on a click. Even a browser session decides it on the confirmation page, with a fresh sign-in (below, as for a token).
  if (caller.browserSession === true && current !== "high") {
    const merged = await mergeTask(approvals, host, tracked, subject, { decidedBy: caller.developerId, occurrence: requestId });
    return { status: 200, body: { status: "MERGED", pullRequests: merged } };
  }

  const record = await createPendingChange(approvals, {
    orgId: caller.orgId, requestId, requestedBy: caller.developerId, subject,
    changes: subject.pullRequests.map((pr) => changeText(pr.repositoryId, pr.number, checked.settings.mergeMethod)),
    approvers: { kind: "rule", rule: MERGE_RULE, candidates: [caller.developerId] },
  });
  // A replay of a press that was decided since is not waiting any more.
  if (record.status !== "PENDING") throw agentXError("APPROVAL_CLOSED", "this request was already decided");
  return confirmationReply(approvals, caller, record);
}

// ---- confirming it

const isChange = (record: AnyApprovalRecord): record is Extract<AnyApprovalRecord, { kind: "change" }> => record.kind === "change";
const REFUSAL_REASONS = {
  head_changed: "the pull request changed", not_mergeable: "GitHub would not merge it", closed: "it is closed", forbidden: "GitHub did not allow Rovara to merge it",
} as const;

/** Why GitHub would not merge, in the words Rovara has for it and, where GitHub gave one, GitHub's own reason (branch protection, a required check, a ruleset), already cleaned. */
function refusalWords(result: Extract<MergePullRequestResult, { outcome: "refused" }>): string {
  const base = REFUSAL_REASONS[result.reason];
  return result.githubMessage === undefined ? base : `${base} (GitHub says: ${result.githubMessage})`;
}

async function mergeableNow(
  deps: ApprovalDependencies, host: CodeMergeHost, task: DeveloperTaskRecord & { orgId: OrgId; workflow: WorkflowSnapshot }, subject: PullRequestMergeSubject, presserDeveloperId: string,
): Promise<{ plan: Array<{ entry: PullRequestEntry; url: string; headSha: string }>; settings: CodeSettings; alreadyMerged: boolean; mergedBefore: string[]; entries: PullRequestEntry[] }> {
  // The change lists the pull requests that were unmerged when it was pressed. Those that merged since (a half merge being finished) are not in the way; one that is new is.
  const required = requiredPullRequests(task.workflow);
  const entries = required.filter((entry) => entry.state !== "MERGED");
  const mergedByWorkflow = required.filter((entry) => entry.state === "MERGED").map((entry) => entry.repositoryId);
  const wanted = byRepository(subject.pullRequests);
  if (entries.length !== wanted.length || entries.some((entry, index) => entry.repositoryId !== wanted[index]!.repositoryId || entry.number !== wanted[index]!.number)) {
    throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  }
  const settings = await readCodeSettings(deps, task.orgId, task.project);
  const scope = host.scope(task.orgId);
  const requesters = await requesterGithubIds(deps, task.orgId, task);
  const permissions = new Map<string, Promise<RepositoryPermission>>();
  const facts: MergePullRequestFacts[] = [];
  const approvals = new Map<string, HumanApproval>();
  const bases = new Map<string, string>();
  const codeOwners = new Map<string, CodeOwnerVerdict>();
  const plan: Array<{ entry: PullRequestEntry; url: string; headSha: string }> = [];
  const items = new Map((await readMergeTracking(deps, task.taskId, task.orgId)).map((item) => [pullRequestKey(item), item]));
  for (const [index, entry] of entries.entries()) {
    const key = pullRequestKey(entry);
    const url = await host.repositoryUrl(task.project, task.startingRevision, entry.repositoryId, task.orgId);
    if (url === undefined) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    // The pull request must be the one Rovara linked to this task: nothing a stored field says moves it to another.
    const repository = parseGitHubRepository(url);
    const linked = await findLinkedGithubWorkflowPullRequest({ documentClient: deps.documentClient, tableName: deps.tableName, repositoryFullName: `${repository.owner}/${repository.name}`, number: entry.number });
    if (linked === undefined || linked.taskId !== task.taskId || linked.repositoryId !== entry.repositoryId || linked.url !== entry.url) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    const status = await host.github.getPullRequestStatus(url, entry.number, scope);
    if (status.number !== entry.number) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub answered for another pull request");
    if (status.state !== "merged" && status.headSha !== wanted[index]!.headSha) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
    const item = items.get(key);
    const ci = readCi(status, { checksEverSeen: item?.checksEverSeen ?? status.checks.length > 0, lastRovaraPushAt: item?.lastRovaraPushAt === undefined ? undefined : Date.parse(item.lastRovaraPushAt), now: deps.now() });
    facts.push({
      repositoryId: entry.repositoryId, number: entry.number, headSha: status.headSha, state: status.state, draft: status.draft, baseBranch: status.baseBranch,
      ci: ci.ci, branch: readBranch(status), behindRequired: status.mergeableState === "behind",
    });
    const approval = await approvalFromStatus(deps, host, { url, scope, orgId: task.orgId, status, syncedFrom: entry.syncedFrom, ciPassing: ci.ci === "passing" || ci.ci === "none", requesters, allowSelfApproval: settings.allowSelfApproval, permissions });
    approvals.set(key, approval);
    // Where the repository names code owners for the changed paths, one of them has to have approved (read fresh, and only once an approval counts: the approval words come first).
    if (approval.approved && status.state === "open") codeOwners.set(key, await codeOwnersOf(host, { url, scope, baseBranch: status.baseBranch, number: entry.number, approval }));
    const base = await host.recordedBase(task.workspaceId, entry.repositoryId, entry.number);
    if (base !== undefined) bases.set(key, base);
    plan.push({ entry, url, headSha: status.headSha });
  }
  const mergedBefore = [...mergedByWorkflow, ...facts.filter((fact) => fact.state === "merged").map((fact) => fact.repositoryId)];
  if (facts.every((fact) => fact.state === "merged")) return { plan: [], settings, alreadyMerged: true, mergedBefore, entries };
  const presser = { githubUserId: await githubUserOfMember(deps, task.orgId, presserDeveloperId) };
  const readiness = mergeReadiness({
    pullRequests: facts, approvals, workflow: task.workflow, recordedBases: bases, presser, allowSelfApproval: settings.allowSelfApproval, requesterName: requesterNameOf(task), codeOwners,
  });
  if (!readiness.ready) throw agentXError("MERGE_NOT_READY", readiness.message);
  return { plan: plan.filter((_, index) => facts[index]!.state !== "merged"), settings, alreadyMerged: false, mergedBefore, entries };
}

/** Whether a code owner approved, for one pull request: nothing is asked of GitHub when the host cannot read code owners or the repository has no CODEOWNERS file. Anything unreadable fails closed. */
async function codeOwnersOf(
  host: CodeMergeHost, ctx: { url: string; scope: GitHubTokenScope; baseBranch: string; number: number; approval: Extract<HumanApproval, { approved: true }> },
): Promise<CodeOwnerVerdict> {
  const github = host.github;
  if (github.readCodeOwners === undefined || github.listChangedPaths === undefined) return { ok: true };
  try {
    const text = await github.readCodeOwners(ctx.url, ctx.baseBranch, ctx.scope);
    if (text === undefined) return { ok: true };
    const changed = await github.listChangedPaths(ctx.url, ctx.number, ctx.scope);
    // A list cut short could hide a path a code owner owns.
    if (!changed.complete) return { ok: false, unreadable: true };
    return await codeOwnerVerdict({
      codeOwnersText: text, paths: changed.paths, approverLogins: ctx.approval.approvers.map((approver) => approver.login),
      teamMember: async (team, login) => (await github.isTeamMember?.(ctx.url, team, login, ctx.scope)) ?? "unknown",
    });
  } catch {
    return { ok: false, unreadable: true };
  }
}

/** The approval a fresh read of GitHub gives: each reviewer's permission is looked up now (once), and a reviewer's link to a member is read now. */
async function approvalFromStatus(
  deps: ApprovalDependencies, host: CodeMergeHost,
  ctx: {
    url: string; scope: GitHubTokenScope; orgId: OrgId; status: PullRequestStatus; syncedFrom: string | undefined; ciPassing: boolean; requesters: string[] | "unlinked";
    allowSelfApproval: boolean; permissions: Map<string, Promise<RepositoryPermission>>;
  },
): Promise<HumanApproval> {
  const { status } = ctx;
  if (status.reviewsIncomplete === true) return { approved: false, reason: "none" };
  const reviewers = latestReviewers(status.reviews);
  if (reviewers.length > PERMISSION_LOOKUPS_MAX) return { approved: false, reason: "none" };
  const permissions = new Map<string, RepositoryPermission>();
  for (const review of reviewers) {
    const key = `${ctx.url}:${review.login.toLowerCase()}`;
    let asked = ctx.permissions.get(key);
    if (asked === undefined) {
      asked = host.github.getRepositoryPermission(ctx.url, review.login, ctx.scope);
      ctx.permissions.set(key, asked);
    }
    permissions.set(review.login, await asked);
  }
  return humanApprovalOf({
    reviews: status.reviews, headSha: status.headSha, syncedFrom: ctx.syncedFrom, ciPassingOnHead: ctx.ciPassing, permissions,
    requesterGithubUserIds: ctx.requesters, linkedGithubUserIds: await linkedAmong(deps, ctx.orgId, reviewers.map((review) => review.githubUserId)), allowSelfApproval: ctx.allowSelfApproval,
  });
}

export interface PullRequestMergeSubject {
  kind: typeof MERGE_RULE;
  taskId: string;
  pullRequests: Array<{ repositoryId: string; number: number; headSha: string }>;
}

/** Claims the merge of one pull request on its tracking item: only when nobody holds it, or the holder's claim is older than `MERGE_CLAIM_SECONDS`. The claim bumps the item's version. */
async function claimMerge(
  deps: ApprovalDependencies, task: { taskId: string; orgId: OrgId }, pr: { repositoryId: string; number: number; url: string }, headSha: string, by: string,
  audit: { occurrence: string; approvalId?: string | undefined; method: string; proof?: AuditProof | undefined },
): Promise<string | undefined> {
  const now = deps.now();
  const at = new Date(now).toISOString();
  // The audit fact commits with the claim, so a claim that was lost leaves none and a claim that was made always leaves one (the appender drops a repeat of the same occurrence).
  const repository = parseGitHubRepository(pr.url);
  const fullName = `${repository.owner}/${repository.name}`;
  const events = await tryAuditEvents(deps, () => [auditPullRequestMergeRequested({
    orgId: task.orgId, actor: auditActorOf(by), occurredAt: at, occurrence: auditOccurrence(audit.occurrence, pr.repositoryId, String(pr.number)), ...(audit.approvalId === undefined ? {} : { related: [audit.approvalId] }),
    ...(audit.proof === undefined ? {} : { proof: audit.proof }),
    pullRequestId: auditPullRequestId(fullName, pr.number), number: pr.number, method: audit.method,
    details: [{ subject: "org", fields: { repository: fullName } }],
  })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: deps.tableName, Key: mergeTrackingKey(task.taskId, pr.repositoryId, pr.number),
        UpdateExpression: "SET mergeClaim = :claim, #version = #version + :one",
        ConditionExpression: "attribute_exists(pk) AND orgId = :org AND taskId = :task AND (attribute_not_exists(mergeClaim) OR mergeClaim.#at <= :cutoff)",
        ExpressionAttributeNames: { "#at": "at", "#version": "version" },
        ExpressionAttributeValues: { ":claim": { headSha, by, at }, ":one": 1, ":org": task.orgId, ":task": task.taskId, ":cutoff": new Date(now - MERGE_CLAIM_SECONDS * 1000).toISOString() },
      } },
      ...events.flatMap((event) => auditPending(deps, event)),
    ] }));
    await flushAuditEvents(deps, events);
    return at;
  } catch (error) {
    if (error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException")) return undefined;
    throw error;
  }
}

/**
 * Lets go of the claim after GitHub said no (nothing was merged, so nobody else needs to wait for the claim to age): only the claim this run made, found by who and when, so a claim somebody
 * else took since stays. Best effort: a claim that stays only costs the next press the wait it always cost. A GitHub failure whose outcome is unknown keeps its claim (the next run finds out).
 */
async function releaseMergeClaim(deps: ApprovalDependencies, task: { taskId: string; orgId: OrgId }, pr: { repositoryId: string; number: number }, claim: { by: string; at: string }): Promise<void> {
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: mergeTrackingKey(task.taskId, pr.repositoryId, pr.number),
    UpdateExpression: "REMOVE mergeClaim SET #version = #version + :one",
    ConditionExpression: "attribute_exists(pk) AND orgId = :org AND taskId = :task AND mergeClaim.#by = :by AND mergeClaim.#at = :at",
    ExpressionAttributeNames: { "#at": "at", "#by": "by", "#version": "version" },
    ExpressionAttributeValues: { ":one": 1, ":org": task.orgId, ":task": task.taskId, ":by": claim.by, ":at": claim.at },
  })).catch(() => undefined);
}

const hashNumber = (seed: string): number => Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 6), 16) % 1_000_000;

async function writeAll(deps: StoreDeps, items: ReturnType<typeof codeMilestoneItems>): Promise<void> {
  if (items.length > 0) await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
}

async function mergeApprovedChange(deps: ApprovalDependencies, host: CodeMergeHost, record: Extract<AnyApprovalRecord, { kind: "change" }>, decision?: { proof?: AuditProof }): Promise<void> {
  if (record.decidedBy === undefined) throw agentXError("CONFIG_INVALID", "this change has not been decided by anyone, so it can't be applied");
  const subject = record.subject as unknown as PullRequestMergeSubject;
  const task = await host.loadTask(subject.taskId);
  if (task === undefined || task.orgId !== record.orgId || task.closedAt !== undefined || task.releasedAt !== undefined || task.orgId === undefined || !tracksMerge(task.workflow)) throw agentXError("MERGE_NOT_READY", M.changedAfterConfirm);
  // A rerun (the sweep tries a handler again) re-checks who pressed: someone who lost the right to merge this task since is not merging it now.
  if (!await mayStillPress(deps, { orgId: record.orgId, developerId: record.decidedBy }, subject.taskId)) throw agentXError("MERGE_NOT_READY", M.presserLostRight);
  const tracked = task as DeveloperTaskRecord & { orgId: OrgId; workflow: WorkflowSnapshot };
  await mergeTask(deps, host, tracked, subject, { decidedBy: record.decidedBy, occurrence: record.approvalId, approvalId: record.approvalId, ...(decision?.proof === undefined ? {} : { proof: decision.proof }) });
}

/**
 * The single merge path (the confirmation page's handler and the web app's one click both end here): re-reads every pull request, every reviewer and the code owners from GitHub, checks readiness for
 * the exact heads, claims each pull request on its tracking item (the audit fact in the claim's transaction) and merges in repository order with the checked head as `sha`. Returns the pull requests
 * that are merged when it ends.
 */
async function mergeTask(
  deps: ApprovalDependencies, host: CodeMergeHost, tracked: DeveloperTaskRecord & { orgId: OrgId; workflow: WorkflowSnapshot }, subject: PullRequestMergeSubject,
  who: { decidedBy: string; occurrence: string; approvalId?: string; proof?: AuditProof },
): Promise<Array<{ repositoryId: string; number: number }>> {
  const { plan, settings, alreadyMerged, mergedBefore, entries } = await mergeableNow(deps, host, tracked, subject, who.decidedBy);
  if (alreadyMerged) return entries.map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number }));
  const scope = host.scope(tracked.orgId);
  // What an earlier run of this handler already merged counts, so a rerun that finds the second pull request refused still says the first merged.
  const merged: string[] = [...mergedBefore];
  for (const step of plan) {
    const { entry, url, headSha } = step;
    const claimedAt = await claimMerge(deps, tracked, { repositoryId: entry.repositoryId, number: entry.number, url }, headSha, who.decidedBy, { occurrence: who.occurrence, approvalId: who.approvalId, method: settings.mergeMethod, proof: who.proof });
    // Another handler holds the claim, or tracking has no item for the pull request yet: whichever it is, a later run finds out (the pull request merged, the claim gone stale).
    if (claimedAt === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Rovara is already merging this pull request.");
    const result = await host.github.mergePullRequest(url, entry.number, { sha: headSha, method: settings.mergeMethod }, scope);
    if (result.outcome === "merged" || result.outcome === "already_merged") {
      merged.push(entry.repositoryId);
      if (result.outcome === "merged" && result.fellBack && tracked.sessionId !== undefined) {
        const other = result.method === "merge" ? "squash" : "merge";
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [sessionEventItem({ tableName: deps.tableName }, { orgId: tracked.orgId, sessionId: tracked.sessionId }, {
          eventId: sessionEventId("merge_method", `${tracked.taskId}\n${entry.repositoryId}\n${String(entry.number)}`), at: new Date(deps.now()).toISOString(), type: "status", actor: { kind: "system" },
          text: `Merged ${entry.repositoryId} pull request ${String(entry.number)} using ${result.method}, because ${other} isn't allowed in that repository.`,
        })] })).catch(() => undefined);
      }
      continue;
    }
    // GitHub said no: nothing merged, so the claim goes at once and a second press right after is not told Rovara is already merging.
    await releaseMergeClaim(deps, tracked, entry, { by: who.decidedBy, at: claimedAt });
    const why = refusalWords(result);
    if (merged.length === 0) {
      throw agentXError("MERGE_NOT_READY", result.reason === "head_changed" ? M.changedAfterConfirm : M.notMerged(entry.repositoryId, why));
    }
    // A merge that fails after an earlier pull request merged stops: a person finishes it, and is told.
    const text = M.halfMerged(merged.join(", "), entry.repositoryId, why);
    const at = new Date(deps.now()).toISOString();
    await writeAll(deps, codeMilestoneItems({ tableName: deps.tableName }, {
      kind: "stuck", orgId: tracked.orgId, taskId: tracked.taskId, ...(tracked.sessionId === undefined ? {} : { sessionId: tracked.sessionId }), at, text,
      pullRequests: plan.map((p) => ({ repository: p.entry.repositoryId, number: p.entry.number, url: p.entry.url })).slice(0, 32),
    }, hashNumber(who.occurrence), { definitionVersion: tracked.workflow.definitionVersion })).catch(() => undefined);
    await deliverCodeMilestones({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, tracked.taskId).catch(() => undefined);
    throw agentXError("MERGE_NOT_READY", text);
  }
  return byRepository([...mergedBeforeEntries(tracked), ...plan.map((step) => ({ repositoryId: step.entry.repositoryId, number: step.entry.number }))]);
}

/** The pull requests the workflow already holds as merged (a half merge being finished): they are part of what the press answers. */
const mergedBeforeEntries = (task: { workflow: WorkflowSnapshot }): Array<{ repositoryId: string; number: number }> =>
  requiredPullRequests(task.workflow).filter((entry) => entry.state === "MERGED").map((entry) => ({ repositoryId: entry.repositoryId, number: entry.number }));

/** May the person still press Merge on this task: its effective owner, a maintainer of its project or an org owner or admin, read now. */
async function mayStillPress(deps: ApprovalDependencies, caller: { orgId: OrgId; developerId: string }, taskId: string): Promise<boolean> {
  const sessions = deps.agentSessions;
  const host = deps.codeMerge;
  if (sessions === undefined || host === undefined) return false;
  const task = await host.loadTask(taskId);
  if (task === undefined || task.orgId !== caller.orgId || task.sessionId === undefined) return false;
  try {
    const access = await requireSessionLevel(sessions, caller, task.sessionId, "view", "merge it");
    return access.owner || access.projectRole === "maintainer" || access.orgAdmin;
  } catch (error) {
    if (error instanceof Error && error.name === "AgentXError") return false;
    throw error;
  }
}

/** Registers the rule and the handler behind `pull_request_merge`. Safe to call more than once. */
export function registerMergeApprovals(): void {
  // The presser and nobody else, while they can still press Merge on the task: read now, never from what they could do when they pressed.
  registerApproverRule(MERGE_RULE, async (deps, record, caller) => {
    if (!isChange(record) || record.subject.kind !== MERGE_RULE || caller.orgId !== record.orgId || caller.developerId !== record.requestedBy) return false;
    return mayStillPress(deps, caller, (record.subject).taskId);
  });
  registerApprovalSubjectHandler(MERGE_RULE, async (deps, record, decision) => {
    if (!isChange(record)) return;
    const host = deps.codeMerge;
    if (host === undefined) throw agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE);
    await mergeApprovedChange(deps, host, record, decision);
  });
}

