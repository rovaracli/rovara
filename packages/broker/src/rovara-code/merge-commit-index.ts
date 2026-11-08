// SRL-3 (owner decision 24b): the index from a pull request's merge commit to the Rovara task that made it, so a revert that names a commit ("This reverts commit <sha>") can be matched
// to a Rovara pull request. Until now the merge commit was seen by the GitHub reads that record a merge and kept nowhere a revert could find it.
//
//   pk GITHUB_MERGE#<owner/repo, lower case>    sk SHA#<40 hex, lower case>
//
// The key is the repository AND the commit (a commit id alone is not unique across repositories, forks or companies), and the row names its company (`orgId`), which a reader must check.
// The row is written in the same transaction that records the merge (`merged-state.ts#mergedStateItems`), holds no person, and expires (the state table's TTL attribute) well after the
// longest time a revert is useful to the track record. The reader is `rovara-pull-request-index.ts`. GitHub only, as the reverse links read by `team-record/runtime.ts` are.
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, type OrgId } from "@agentx/contracts";
import type { TransactItem } from "../agents/table-writes.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";

export const MERGE_COMMIT_ENTITY = "GITHUB_WORKFLOW_MERGE";
/** How long a row is kept after it is written: a year and then some. */
export const MERGE_COMMIT_INDEX_KEPT_DAYS = 400;
const SHA = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const PULL_REQUEST_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/u;
const DAY_SECONDS = 86_400;

export interface MergeCommitRecord {
  pk: string;
  sk: string;
  entityType: typeof MERGE_COMMIT_ENTITY;
  orgId: OrgId;
  repositoryFullName: string;
  repositoryId: string;
  number: number;
  url: string;
  taskId: string;
  mergeCommit: string;
  createdAt: string;
  [INDEX_EXPIRY_ATTRIBUTE]: number;
}

export interface MergeCommitTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

/** The key of a repository's merge commit, or undefined when either is not one GitHub could have issued. The repository is lower-cased, the commit too. */
export function mergeCommitKey(repositoryFullName: string, sha: string): { pk: string; sk: string } | undefined {
  const commit = sha.toLowerCase();
  if (!REPOSITORY.test(repositoryFullName) || !SHA.test(commit)) return undefined;
  return { pk: `GITHUB_MERGE#${repositoryFullName.toLowerCase()}`, sk: `SHA#${commit}` };
}

/** The repository and number a GitHub pull request address names, or undefined (another host, another shape). */
export function githubPullRequestAddress(url: string): { repositoryFullName: string; number: number } | undefined {
  const match = PULL_REQUEST_URL.exec(url);
  return match === null ? undefined : { repositoryFullName: match[1]!, number: Number(match[2]) };
}

export interface MergeCommitIndexInput { orgId: OrgId; repositoryFullName: string; repositoryId: string; number: number; url: string; taskId: string; mergeCommit: string; now: string }

/** The row for one merge, or undefined when its repository or commit cannot be keyed. */
export function mergeCommitIndexRecord(input: MergeCommitIndexInput): MergeCommitRecord | undefined {
  const key = mergeCommitKey(input.repositoryFullName, input.mergeCommit);
  const at = Date.parse(input.now);
  if (key === undefined || !Number.isFinite(at)) return undefined;
  return {
    ...key, entityType: MERGE_COMMIT_ENTITY, orgId: input.orgId, repositoryFullName: input.repositoryFullName.toLowerCase(), repositoryId: input.repositoryId, number: input.number, url: input.url,
    taskId: input.taskId, mergeCommit: input.mergeCommit.toLowerCase(), createdAt: input.now, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + MERGE_COMMIT_INDEX_KEPT_DAYS * DAY_SECONDS,
  };
}

/** The Put that goes in the merge's transaction. Unconditional: a replay writes the same values, and one commit is one row. */
export function mergeCommitIndexItem(tableName: string, input: MergeCommitIndexInput): TransactItem | undefined {
  const record = mergeCommitIndexRecord(input);
  return record === undefined ? undefined : { Put: { TableName: tableName, Item: record } };
}

/**
 * The row for a repository's commit, or undefined. A row that does not say what its key says (its repository, its commit, its entity type) is not a row for this lookup. The caller still
 * has to check the company (`orgId`) and the task; nothing here grants anything.
 */
export async function findMergeCommit(table: MergeCommitTable, input: { repositoryFullName: string; sha: string }): Promise<MergeCommitRecord | undefined> {
  const key = mergeCommitKey(input.repositoryFullName, input.sha);
  if (key === undefined) return undefined;
  const item = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined || item.entityType !== MERGE_COMMIT_ENTITY) return undefined;
  const { repositoryFullName, mergeCommit, orgId, repositoryId, url, taskId, number } = item;
  if (typeof repositoryFullName !== "string" || typeof mergeCommit !== "string" || mergeCommitKey(repositoryFullName, mergeCommit)?.pk !== key.pk || mergeCommit.toLowerCase() !== key.sk.slice("SHA#".length)
    || typeof orgId !== "string" || typeof repositoryId !== "string" || typeof url !== "string" || typeof taskId !== "string" || typeof number !== "number" || !Number.isSafeInteger(number)) return undefined;
  return item as unknown as MergeCommitRecord;
}

export interface BackfillOptions {
  /** Items read per page. */
  pageSize?: number;
  /** Stop after this many milliseconds and answer where to resume. */
  maxMs?: number;
  /** Where the last run stopped (its `resume`). */
  start?: Record<string, unknown>;
  /** Pause between pages, so the scan does not compete with the live broker. */
  pauseMs?: number;
}
export interface BackfillResult { scanned: number; created: number; existing: number; skipped: number; finished: boolean; resume?: Record<string, unknown> }

/**
 * The optional operator step for merges recorded before the index existed (release step, idempotent, resumable). It reads the track record's outcome samples that already hold a merge
 * commit GitHub gave (`pr.mergeCommit`), checks each against the task (same company, the pull request recorded MERGED, its address a GitHub one) and puts the missing row with
 * `attribute_not_exists`. It only reads and puts. Merges whose samples have expired (180 days) or that were never scored have no commit on record and stay unmatched.
 */
export async function backfillMergeCommitIndex(table: MergeCommitTable & { now: () => number }, options: BackfillOptions = {}): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, created: 0, existing: 0, skipped: 0, finished: false };
  const deadline = options.maxMs === undefined ? Number.POSITIVE_INFINITY : table.now() + options.maxMs;
  const seen = new Set<string>();
  let start = options.start;
  for (;;) {
    const page = await table.documentClient.send(new ScanCommand({
      TableName: table.tableName, FilterExpression: "#type = :type AND attribute_exists(#pr)", ExpressionAttributeNames: { "#type": "entityType", "#pr": "pr" },
      ExpressionAttributeValues: { ":type": "OUTCOME_SAMPLE" }, ConsistentRead: true, ...(options.pageSize === undefined ? {} : { Limit: options.pageSize }), ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const sample of page.Items ?? []) {
      result.scanned += 1;
      const outcome = await backfillOne(table, sample, seen);
      result[outcome] += 1;
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) { result.finished = true; return result; }
    if (table.now() >= deadline) { result.resume = start; return result; }
    if ((options.pauseMs ?? 0) > 0) await new Promise((resolve) => { setTimeout(resolve, options.pauseMs); });
  }
}

async function backfillOne(table: MergeCommitTable & { now: () => number }, sample: Record<string, unknown>, seen: Set<string>): Promise<"created" | "existing" | "skipped"> {
  const pr = sample.pr as { repositoryId?: unknown; number?: unknown; mergeCommit?: unknown } | undefined;
  if (pr === undefined || typeof sample.orgId !== "string" || typeof sample.taskId !== "string" || typeof pr.repositoryId !== "string" || typeof pr.number !== "number" || typeof pr.mergeCommit !== "string" || !SHA.test(pr.mergeCommit)) return "skipped";
  const once = `${sample.taskId}|${pr.repositoryId}|${String(pr.number)}`;
  if (seen.has(once)) return "skipped";
  seen.add(once);
  const task = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: taskKey(sample.taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord }).Item;
  if (task === undefined || task.orgId !== sample.orgId) return "skipped";
  const entry = task.workflow?.pullRequests?.find((candidate) => candidate.repositoryId === pr.repositoryId && candidate.number === pr.number);
  const address = entry === undefined ? undefined : githubPullRequestAddress(entry.url);
  if (entry === undefined || entry.state !== "MERGED" || address === undefined || address.number !== pr.number) return "skipped";
  const record = mergeCommitIndexRecord({ orgId: task.orgId, repositoryFullName: address.repositoryFullName, repositoryId: entry.repositoryId, number: entry.number, url: entry.url, taskId: task.taskId, mergeCommit: pr.mergeCommit, now: new Date(table.now()).toISOString() });
  if (record === undefined) return "skipped";
  try {
    await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: record, ConditionExpression: "attribute_not_exists(pk)" }));
    return "created";
  } catch (error) {
    if ((error as { name?: string } | undefined)?.name === "ConditionalCheckFailedException") return "existing";
    throw error;
  }
}
