// Bug H (staging 0.4.11): the save that records a pull request's merge (a webhook, the merge sweep, or a pushed fix found merged) also brings what was kept about that pull request up to date,
// in the same transaction: the merge-tracking row says "merged" (it kept saying "open", because tracking stops following a task once it is MERGED), and the task's pull request record says
// "merged" (the task view's pull request list reads it). When the pull request was merged on GitHub rather than by Rovara's Merge, and no approval was recorded for it, the session's timeline
// says so, as a fact: "Merged on GitHub by <login>; no approval was recorded."
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { SessionIdSchema, mergeTrackingDecisionDigest, sessionEventId, type MergeTrackingItem, type OrgId, type WorkflowSnapshot } from "@agentx/contracts";
import { sessionEventItem } from "../agent-sessions/store.js";
import type { TransactItem } from "../agents/table-writes.js";
import { readMergeTracking, trackingWriteItem } from "./merge-tracking.js";
import { githubPullRequestAddress, mergeCommitIndexItem } from "./merge-commit-index.js";

export interface MergedStateTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
export interface MergedStateTask { taskId: string; orgId?: OrgId | undefined; sessionId?: string | undefined; workspaceId?: string | undefined }
/** What GitHub said of a pull request this save finds merged. */
export interface MergedObservation { repositoryId: string; number: number; mergedBy?: string | undefined; /** The commit the host says the pull request was merged as (SRL-3: indexed so a revert of it can be matched). */ mergeCommit?: string | undefined }
/**
 * A pull request record the caller already updates in the same transaction, and whose update already sets its state to "merged" (the pushed fix's save, which records the head a push that landed
 * without its callback left and GitHub's state in one update). DynamoDB refuses a transaction with two operations on one item, so the record is updated once, by the caller (C59).
 */
export interface MergedRecordWrittenByCaller { repositoryId: string; number: number }

/** A login GitHub could have issued; anything else is left out of the timeline. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/u;

/** The key of a pull request's record in its workspace (the same key the broker keeps it under). */
const pullRequestRecordKey = (workspaceId: string, repository: string, number: number) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `PULL_REQUEST#${repository}#${String(number).padStart(12, "0")}` });

const isMerged = (workflow: WorkflowSnapshot, repositoryId: string, number: number): boolean =>
  workflow.pullRequests?.some((pullRequest) => pullRequest.repositoryId === repositoryId && pullRequest.number === number && pullRequest.state === "MERGED") === true;

/**
 * The items that bring the merge-tracking row and the pull request record of each pull request this save moves to MERGED up to date, and the timeline line for one merged on GitHub with
 * no approval recorded. None for a pull request already merged in `before`. Reads failing are logged and leave the merge recorded without them: recording the merge never waits on this.
 */
export async function mergedStateItems(
  table: MergedStateTable, task: MergedStateTask, before: WorkflowSnapshot, after: WorkflowSnapshot, now: string, observed: readonly MergedObservation[] = [],
  recordsWrittenByCaller: readonly MergedRecordWrittenByCaller[] = [],
): Promise<TransactItem[]> {
  const newly = (after.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "MERGED" && !isMerged(before, pullRequest.repositoryId, pullRequest.number));
  if (newly.length === 0 || task.orgId === undefined) return [];
  const orgId = task.orgId;
  const items: TransactItem[] = [];
  let tracked: MergeTrackingItem[] = [];
  try {
    tracked = await readMergeTracking(table, task.taskId, orgId);
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "merged_state.tracking_unreadable", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
  }
  const session = SessionIdSchema.safeParse(task.sessionId);
  // SRL-3 (L2): merges that got no index row, by reason. Counts only (no task, repository or commit), logged once per reason after the loop.
  const missed = { no_merge_commit: 0, bad_merge_commit: 0 };
  for (const pullRequest of newly) {
    const prior = tracked.find((item) => item.repositoryId === pullRequest.repositoryId && item.number === pullRequest.number);
    if (prior !== undefined && prior.state !== "merged") {
      const { version: _version, observedAt: _observedAt, decisionDigest: _digest, ...rest } = prior; // eslint-disable-line @typescript-eslint/no-unused-vars -- recomputed on purpose
      const fields = { ...rest, state: "merged" as const };
      items.push(trackingWriteItem(table.tableName, prior, { ...fields, decisionDigest: mergeTrackingDecisionDigest(fields), version: prior.version + 1, observedAt: now }));
    }
    if (task.workspaceId !== undefined && !recordsWrittenByCaller.some((written) => written.repositoryId === pullRequest.repositoryId && written.number === pullRequest.number)) {
      const key = pullRequestRecordKey(task.workspaceId, pullRequest.repositoryId, pullRequest.number);
      try {
        const stored = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: { state?: unknown } };
        if (stored.Item !== undefined && stored.Item.state !== "merged") {
          items.push({ Update: { TableName: table.tableName, Key: key, UpdateExpression: "SET #state = :merged, updatedAt = :now", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":merged": "merged", ":now": now } } });
        }
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "merged_state.record_unreadable", taskId: task.taskId, error: error instanceof Error ? error.name : "unknown" }));
      }
    }
    // SRL-3: the index from the merge commit to this task, in the same transaction, so a revert of the commit is matched to the pull request. No commit, or an address that is not GitHub's: no row (logged).
    const mergeCommit = observed.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number)?.mergeCommit;
    const address = githubPullRequestAddress(pullRequest.url);
    const indexed = mergeCommit === undefined || address === undefined ? undefined
      : mergeCommitIndexItem(table.tableName, { orgId, repositoryFullName: address.repositoryFullName, repositoryId: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url, taskId: task.taskId, mergeCommit, now });
    if (indexed !== undefined) items.push(indexed);
    else if (address !== undefined) missed[mergeCommit === undefined ? "no_merge_commit" : "bad_merge_commit"] += 1;
    // Merged on GitHub (not by Rovara's Merge, which claims the pull request first) with no approval that counts: a fact for the timeline, not an error.
    if (prior !== undefined && prior.mergeClaim === undefined && prior.approval === undefined && session.success) {
      const by = observed.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number)?.mergedBy;
      items.push(sessionEventItem({ tableName: table.tableName }, { orgId, sessionId: session.data }, {
        eventId: sessionEventId("merged_outside", `${task.taskId}\n${pullRequest.repositoryId}\n${String(pullRequest.number)}`), at: now, type: "status", actor: { kind: "system" },
        text: by !== undefined && LOGIN.test(by) ? `Merged on GitHub by ${by}; no approval was recorded.` : "Merged on GitHub; no approval was recorded.",
      }));
    }
  }
  for (const [reason, count] of Object.entries(missed)) if (count > 0) console.log(JSON.stringify({ component: "broker", level: "warn", event: "merge_commit_index.missed", reason, count }));
  return items;
}
