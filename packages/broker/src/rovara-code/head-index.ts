// Rovara Code (Plan 6 Task 14): the index from (org, repository, commit) and from the Rovara branch to the task, written wherever Rovara records a pull request's head.
import { INDEX_EXPIRY_ATTRIBUTE, prHeadKey, type OrgId } from "@rovara-code/contracts";
import type { TransactItem } from "../agents/table-writes.js";

/** How long a head's index item lives after it was written (the table's expiry): a task's pull request does not outlive it. */
const HEAD_INDEX_RETENTION_SECONDS = 90 * 86_400;

/** The index items for a pull request's head and its branch: put with the change that records the head, in the same transaction. A later head is another item. */
export function prHeadItems(
  tableName: string,
  input: { orgId: OrgId; repositoryFullName: string; headSha: string; taskId: string; repositoryId: string; number: number; branch?: string | undefined },
  now: number,
): TransactItem[] {
  const fullName = input.repositoryFullName.toLowerCase();
  const expires = Math.floor(now / 1_000) + HEAD_INDEX_RETENTION_SECONDS;
  const item = (sk: string): TransactItem => ({
    Put: {
      TableName: tableName,
      Item: {
        ...prHeadKey(input.orgId, fullName, sk), entityType: "PR_HEAD", orgId: input.orgId, taskId: input.taskId, repositoryId: input.repositoryId, number: input.number,
        [INDEX_EXPIRY_ATTRIBUTE]: expires,
      },
    },
  });
  return [item(input.headSha), ...(input.branch === undefined ? [] : [item(`branch:${input.branch}`)])];
}
