// packages/broker/src/developer/merged-owner-backfill.ts
// 0.5.18 (Slack merged identity): the backfill for tasks still held by a merged-away id (scripts/backfill-merged-task-owners.ts runs it). Before this release a Slack-only sign-in that had been
// merged into the person's web sign-in still started tasks under the merged-away id, after the merge's own mover had run, so nothing ever handed them on and the owner could not be seated.
//
// For every sign-in record with `mergedInto` it follows the chain to the survivor, reads the survivor's company, and hands each OPEN task the duplicate lists on to the survivor with the merge
// mover's own step (`handOnMergedTask`): the survivor becomes the task's current owner, pays where the duplicate did and gets the task-list row. The task's `developerId` and `ownerKey` are NOT
// rewritten: the owner key is the task's principal (its workspace, its artifacts' paths and its idempotency keys are under it), and the creator stays as history, as the merge mover leaves it.
//
// SAFE: a dry run by default (reads only; `apply: false`); every write is conditional on the owner it was read with, so a repeat, or a run after the read-time hand-on (owner-seat.ts) already
// did it, changes nothing ("already"). A task of a company the survivor is not a member of is never touched ("gone"); a task closed since it was listed is not handed on (the write is
// conditional on it being open: "closed"); a survivor whose sign-in is revoked or who is banned from the company gets nothing ("refused"). Only counts and task ids (random UUIDs) are reported, never a person's id.
import { GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { developerOrgKey } from "@agentx/cloud-contracts";
import { handOnMergedTask, type MergedTaskHandOn } from "../agent-sessions/lifecycle.js";
import { mergeSurvivor } from "./merged-owner.js";
import type { DeveloperRecord } from "./store.js";
import { taskKey, type DeveloperTaskRecord } from "./task-records.js";

type Send = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;

export interface MergedOwnerBackfillDeps {
  documentClient: Send;
  /** The State table: tasks, task-list rows, memberships. */
  stateTable: string;
  /** The sign-in table: `DEVELOPER#<id>` / `META` records with `mergedInto`. */
  signInTable: string;
  now: () => number;
  pageSize?: number;
}

export interface MergedOwnerBackfillSummary {
  apply: boolean;
  /** Merged-away sign-in records found. */
  merged: number;
  /** A merge chain that loops or is too long: nothing done for that duplicate. */
  chainUnreadable: number;
  /** A survivor with no company now: nothing done (nobody to hand the tasks to). */
  survivorNoCompany: number;
  /** Task-list rows of duplicates read. */
  tasksSeen: number;
  closedSkipped: number;
  /** Per outcome of `handOnMergedTask` (`would_hand` only in a dry run; `closed`: closed since it was listed; `refused`: the survivor is revoked or banned). */
  outcomes: Record<MergedTaskHandOn, number>;
  /** The tasks handed on (or, in a dry run, that would be). */
  taskIds: string[];
}

const MEMBER_ID = /^[a-f0-9]{64}$/;

async function get(deps: MergedOwnerBackfillDeps, table: string, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** Runs the backfill (see the header). `apply: false` is the dry run. */
export async function backfillMergedTaskOwners(deps: MergedOwnerBackfillDeps, options: { apply: boolean }): Promise<MergedOwnerBackfillSummary> {
  const summary: MergedOwnerBackfillSummary = {
    apply: options.apply, merged: 0, chainUnreadable: 0, survivorNoCompany: 0, tasksSeen: 0, closedSkipped: 0,
    outcomes: { handed: 0, already: 0, gone: 0, other: 0, would_hand: 0, closed: 0, refused: 0 }, taskIds: [],
  };
  const readRecord = async (id: string) => await get(deps, deps.signInTable, { pk: `DEVELOPER#${id}`, sk: "META" }) as DeveloperRecord | undefined;
  const lifecycle = { documentClient: deps.documentClient, tableName: deps.stateTable, now: deps.now, signInStore: { getDeveloper: readRecord } };
  let start: Item | undefined;
  do {
    const page = await deps.documentClient.send(new ScanCommand({
      TableName: deps.signInTable, Limit: deps.pageSize ?? 100, ConsistentRead: true,
      FilterExpression: "sk = :meta AND begins_with(pk, :developer) AND attribute_exists(mergedInto)", ExpressionAttributeValues: { ":meta": "META", ":developer": "DEVELOPER#" },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Item };
    for (const record of page.Items ?? []) {
      const duplicateId = String(record["pk"]).slice("DEVELOPER#".length);
      if (!MEMBER_ID.test(duplicateId)) continue;
      summary.merged += 1;
      const survivorId = await mergeSurvivor(readRecord, duplicateId);
      if (survivorId === undefined || survivorId === duplicateId) {
        summary.chainUnreadable += 1;
        continue;
      }
      const orgId = (await get(deps, deps.stateTable, developerOrgKey(survivorId)))?.["orgId"];
      if (typeof orgId !== "string") {
        summary.survivorNoCompany += 1;
        continue;
      }
      await eachTaskRow(deps, duplicateId, async (taskId) => {
        summary.tasksSeen += 1;
        const task = await get(deps, deps.stateTable, taskKey(taskId)) as DeveloperTaskRecord | undefined;
        if (task?.closedAt !== undefined) {
          summary.closedSkipped += 1;
          return;
        }
        const outcome = await handOnMergedTask(lifecycle, { orgId, taskId, duplicateId, survivorId, dryRun: !options.apply });
        summary.outcomes[outcome] += 1;
        if (outcome === "handed" || outcome === "would_hand") summary.taskIds.push(taskId);
      });
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return summary;
}

/** The task ids of a developer's task-list rows (`DEVELOPER#<id>` / `TASK#<createdAt>#<taskId>` in the State table), page by page. */
async function eachTaskRow(deps: MergedOwnerBackfillDeps, developerId: string, visit: (taskId: string) => Promise<void>): Promise<void> {
  let start: Item | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.stateTable, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "TASK#" },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Item };
    for (const row of page.Items ?? []) {
      const taskId = row["taskId"];
      if (typeof taskId === "string" && String(row["sk"]).endsWith(`#${taskId}`)) await visit(taskId);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
}
