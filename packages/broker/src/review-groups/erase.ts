// Review groups (owner decision 9): a person's erase takes them out of review groups and out of the claims they hold. Called by the Team record's person erase, in its `config`
// step, for every project of the company (`team-record/erase.ts`; the registry row is in `team-record/person-fields.ts`).
//
//   - every group of the project's `REVIEW_GROUPS#<project>` document loses the person; the document moves to its next revision (conditioned on the one read), so a maintainer's
//     save made on the old revision is refused as stale instead of writing the person back;
//   - every claim in the project's `REVIEW_CLAIMS#<project>` partition that the person holds goes back to the group: holder, group, time and host state are removed and the
//     claim's revision moves on (conditioned on the holder and revision read).
//
// Each returns whether it finished. Anything it could not do (a document that does not read, a lost race, the read budget spent) is "not finished": the erase step reports it
// and the next run, and the delayed second pass, try again. Nothing is deleted outright: the documents keep their revisions, so their audit occurrences stay unique.
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { reviewClaimsPk, reviewGroupsKey } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { ERASED_DEVELOPER_ID } from "../team-record/store.js";
import { readReviewGroups } from "./groups.js";

export interface ReviewEraseTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

const isConditional = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
/** The most claim items one call reads in one project. */
export const REVIEW_CLAIM_ERASE_READS_MAX = 2_000;
const PAGE = 100;

/** Who last changed an item becomes the 64-zero stand-in when it was the erased person (as `scrubTier0Developer` does), whatever else the item says. */
async function scrubUpdatedBy(table: ReviewEraseTable, key: { pk: unknown; sk: unknown }, developerId: string): Promise<void> {
  await table.documentClient.send(new UpdateCommand({
    TableName: table.tableName, Key: key, UpdateExpression: "SET updatedBy = :zero", ConditionExpression: "updatedBy = :erased",
    ExpressionAttributeValues: { ":zero": ERASED_DEVELOPER_ID, ":erased": developerId },
  })).catch((error: unknown) => { if (!isConditional(error)) throw error; });
}

/** Takes the person out of every group of the project, and out of the document's `updatedBy`. True when nothing of theirs is left in the document. */
export async function scrubReviewGroupsPerson(table: ReviewEraseTable, orgId: OrgId, project: string, developerId: string, at: string): Promise<boolean> {
  const stored = await readReviewGroups(table, orgId, project);
  // `updatedBy` first, whether or not they are in a group now and whether or not the groups read: they may have saved the document and since left every group.
  await scrubUpdatedBy(table, reviewGroupsKey(orgId, project), developerId);
  if (stored === "unreadable") return false;
  if (!stored.groups.some((group) => group.members.includes(developerId))) return true;
  const groups = stored.groups.map((group) => ({ ...group, members: group.members.filter((member) => member !== developerId) }));
  try {
    await table.documentClient.send(new PutCommand({
      TableName: table.tableName,
      Item: {
        // No `lastRequestId`: a repeat of the maintainer's last request must not answer with the document that still named the person.
        ...reviewGroupsKey(orgId, project), entityType: "REVIEW_GROUPS", orgId, project, revision: stored.revision + 1, groups, updatedAt: at, updatedBy: "erase",
      },
      ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": stored.revision },
    }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** Gives back to the group every claim of the project that the person holds. True when none is left and the partition was read to its end. */
export async function scrubReviewClaimsPerson(table: ReviewEraseTable, orgId: OrgId, project: string, developerId: string, at: string, maxReads = REVIEW_CLAIM_ERASE_READS_MAX): Promise<boolean> {
  let start: Record<string, unknown> | undefined;
  let read = 0;
  let finished = true;
  do {
    if (read >= maxReads) return false;
    const page = await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :task)", ConsistentRead: true, Limit: PAGE,
      ExpressionAttributeValues: { ":pk": reviewClaimsPk(orgId, project), ":task": "TASK#" },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      read += 1;
      // Who last changed a claim they don't hold (they released it, reassigned it, claimed it and lost it): that id goes too.
      if (item["holder"] !== developerId && item["updatedBy"] === developerId) await scrubUpdatedBy(table, { pk: item["pk"], sk: item["sk"] }, developerId);
      if (item["holder"] !== developerId || typeof item["revision"] !== "number") continue;
      try {
        await table.documentClient.send(new UpdateCommand({
          TableName: table.tableName, Key: { pk: item["pk"], sk: item["sk"] },
          UpdateExpression: "REMOVE holder, groupId, claimedAt, hostSync, reviewKey, lastRequestId, lastRequestDigest SET #revision = :next, lastAction = :erased, updatedAt = :at, updatedBy = :erase",
          ConditionExpression: "holder = :holder AND #revision = :revision",
          ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":holder": developerId, ":revision": item["revision"], ":next": item["revision"] + 1, ":erased": "erased", ":at": at, ":erase": "erase" },
        }));
      } catch (error) {
        if (!isConditional(error)) throw error;
        finished = false;
      }
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return finished;
}

/** Both scrubs, for one project. */
export async function eraseReviewPerson(table: ReviewEraseTable, orgId: OrgId, project: string, developerId: string, at: string): Promise<boolean> {
  const groups = await scrubReviewGroupsPerson(table, orgId, project, developerId, at);
  const claims = await scrubReviewClaimsPerson(table, orgId, project, developerId, at);
  return groups && claims;
}
