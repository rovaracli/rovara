// Rovara Code (Plan 6 Task 19): whose approval on GitHub counts toward a merge (Finding 1), and who the requesters of a task are. Rovara's rules govern only its own Merge button: merging
// on GitHub is governed by the repository's own branch protection. Pure except for the lookups of who is a member, which the callers pass in already read.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { isWriterOrgRole, orgMemberKey } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { isTaskTakenOver, tryEffectiveTaskOwner, type TaskOwnerSource } from "../developer/task-records.js";
import type { PullRequestReview } from "../github-pull-status.js";
import { githubUserOfMember, memberForGithubUser, type GithubMemberDependencies } from "./github-members.js";

export type RepositoryPermission = "admin" | "write" | "read" | "none";

export type ApprovalRefusal = "none" | "no_write" | "self_only" | "unlinked_requester" | "stale" | "changes_requested";
export type HumanApproval =
  | { approved: true; by: { githubUserId: string; login: string }; commitId: string; approvers: Array<{ githubUserId: string; login: string }> }
  | { approved: false; reason: ApprovalRefusal };

export interface ApprovalInput {
  reviews: readonly PullRequestReview[];
  headSha: string;
  /** The head the pull request had before a run of clean merges of the base (Task 17's `syncedFrom`): an approval of that head carries when CI passes on the merged head. */
  syncedFrom: string | undefined;
  ciPassingOnHead: boolean;
  /** The live permission of each reviewer, by login. A login with no entry has no access. */
  permissions: ReadonlyMap<string, RepositoryPermission>;
  /** The GitHub accounts of the task's requesters, or "unlinked" when any requester has no linked account. */
  requesterGithubUserIds: readonly string[] | "unlinked";
  /** The GitHub accounts (among the reviewers) that are linked to a member of the org. */
  linkedGithubUserIds: ReadonlySet<string>;
  /** The App's own GitHub user: never counts, whatever its type says. */
  appUserId?: string | undefined;
  allowSelfApproval: boolean;
  /**
   * GitHub accounts (among the reviewers) that are linked to a person whose company role is not a writer's (the Auditor). Their approval never counts, in either mode: with self-approval on,
   * any account with write access would otherwise count, linked or not (I2). Absent: none known, which is how a caller built before this field behaves.
   */
  excludedGithubUserIds?: ReadonlySet<string> | undefined;
}

const permissionOf = (permissions: ReadonlyMap<string, RepositoryPermission>, login: string): RepositoryPermission => permissions.get(login) ?? permissions.get(login.toLowerCase()) ?? "none";
const writes = (permission: RepositoryPermission): boolean => permission === "admin" || permission === "write";

/** The reviewers whose standing counts for a decision: each one's latest review among approving, asking for changes and dismissal (comments say nothing), a person and not a dismissed one. */
export function latestReviewers(reviews: readonly PullRequestReview[], appUserId?: string): PullRequestReview[] {
  const latest = new Map<string, PullRequestReview>();
  const ordered = reviews.map((review, index) => ({ review, index })).sort((left, right) => left.review.submittedAt.localeCompare(right.review.submittedAt) || left.index - right.index);
  for (const { review } of ordered) {
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED" && review.state !== "DISMISSED") continue;
    latest.set(review.githubUserId, review);
  }
  return [...latest.values()].filter((review) => review.state !== "DISMISSED" && review.userType === "User" && review.githubUserId !== appUserId);
}

/**
 * Whose approval counts. Only a person (not an App or a bot) with write access counts; one of them asking for changes refuses; an approval counts on the head, or on the head before
 * a run of clean merges of the base when CI passes on the merged head. With self-approval off, the requesters must all have a linked GitHub account and only an account linked to a
 * member who is not a requester counts.
 */
export function humanApprovalOf(input: ApprovalInput): HumanApproval {
  const people = latestReviewers(input.reviews, input.appUserId);
  const withWrite = people.filter((review) => writes(permissionOf(input.permissions, review.login)));
  if (withWrite.some((review) => review.state === "CHANGES_REQUESTED")) return { approved: false, reason: "changes_requested" };
  if (!people.some((review) => review.state === "APPROVED")) return { approved: false, reason: "none" };
  const writeApprovals = withWrite.filter((review) => review.state === "APPROVED" && input.excludedGithubUserIds?.has(review.githubUserId) !== true);
  if (writeApprovals.length === 0) return { approved: false, reason: "no_write" };
  const fresh = writeApprovals.filter((review) => review.commitId === input.headSha || (input.syncedFrom !== undefined && review.commitId === input.syncedFrom && input.ciPassingOnHead));
  if (fresh.length === 0) return { approved: false, reason: "stale" };
  let counted = fresh;
  if (!input.allowSelfApproval) {
    if (input.requesterGithubUserIds === "unlinked") return { approved: false, reason: "unlinked_requester" };
    const requesters = input.requesterGithubUserIds;
    counted = fresh.filter((review) => input.linkedGithubUserIds.has(review.githubUserId) && !requesters.includes(review.githubUserId));
    if (counted.length === 0) return { approved: false, reason: fresh.some((review) => requesters.includes(review.githubUserId)) ? "self_only" : "none" };
  }
  const newest = counted[counted.length - 1]!;
  return {
    approved: true, by: { githubUserId: newest.githubUserId, login: newest.login }, commitId: newest.commitId,
    approvers: counted.map((review) => ({ githubUserId: review.githubUserId, login: review.login })).reverse(),
  };
}

// ---- the people

/** The part of a task record that says who asked for it. */
export type RequesterSource = TaskOwnerSource & {
  startedBy?: { developerId?: string | undefined } | undefined;
};

/**
 * The developers who asked for the task: its creator, whoever started it, and whoever owns it now. The owner comes from `tryEffectiveTaskOwner` (a take-over or a merge moves it), never
 * from the stored take-over record itself; `undefined` for an owner that cannot be read, which `requesterGithubIds` does not take for "no extra requester".
 */
export function requesterIds(task: RequesterSource): string[] {
  const owner = tryEffectiveTaskOwner(task)?.developerId;
  return [...new Set([task.developerId, task.startedBy?.developerId, owner].filter((id): id is string => typeof id === "string" && id !== ""))];
}

/** The requesters' GitHub accounts, or "unlinked" when any of them has none (their approval cannot be told from a reviewer's), or when the owner now cannot be read (who asked cannot be told). */
export async function requesterGithubIds(deps: GithubMemberDependencies, orgId: OrgId, task: RequesterSource): Promise<string[] | "unlinked"> {
  if (isTaskTakenOver(task) && tryEffectiveTaskOwner(task) === undefined) return "unlinked";
  const ids: string[] = [];
  for (const developerId of requesterIds(task)) {
    const github = await githubUserOfMember(deps, orgId, developerId);
    if (github === undefined) return "unlinked";
    ids.push(github);
  }
  return ids.length === 0 ? "unlinked" : ids;
}

/** Which of these GitHub accounts are linked to a member of the org, who is a member now: a link outlives a removal, so the member record is read live. */
export async function linkedAmong(deps: GithubMemberDependencies, orgId: OrgId, githubUserIds: readonly string[]): Promise<Set<string>> {
  const linked = new Set<string>();
  for (const id of new Set(githubUserIds)) {
    const developerId = await memberForGithubUser(deps, orgId, id);
    if (developerId === undefined) continue;
    const member = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    // Only a writer counts as the human whose review opens the merge: an Auditor reads the audit log and its approval is no one's (I2).
    if (member.Item !== undefined && isWriterOrgRole(member.Item["role"])) linked.add(id);
  }
  return linked;
}

/** Which of these GitHub accounts are linked to a person who is in the org now but is not a writer (the Auditor, or a role this release does not know): their approval counts for nothing. */
export async function nonWritersAmong(deps: GithubMemberDependencies, orgId: OrgId, githubUserIds: readonly string[]): Promise<Set<string>> {
  const excluded = new Set<string>();
  for (const id of new Set(githubUserIds)) {
    const developerId = await memberForGithubUser(deps, orgId, id);
    if (developerId === undefined) continue;
    const member = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
    if (member.Item !== undefined && !isWriterOrgRole(member.Item["role"])) excluded.add(id);
  }
  return excluded;
}
