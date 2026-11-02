// K1 lane D, D3: the broker's record of a code review's walk of the spec, and the export W4's requirement-to-evidence table reads. The worker's report is read again here (schema, bounds), is kept only
// when it is about the commit the broker recorded for the spec, and is written with the review's own result.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SpecReviewResultSchema, specRequirementRows, type SpecReviewResult } from "@agentx/contracts";
import type { TransactItem } from "./hooks.js";
import type { SpecStore } from "./hooks.js";

export const SPEC_REVIEW_SK_PREFIX = "SPEC#REVIEW#";

export interface SpecReviewRecordEnvironment {
  tableName: string;
  store: SpecStore;
  now(): string;
}

export type StoredSpecReview = SpecReviewResult & { pk: string; sk: string; entityType: "SPEC_REVIEW"; taskId: string; operationId: string; recordedAt: string };

/** The item to write with a review operation's result, or none: not a review, no walk reported, a walk that is not valid, or one about another commit than the spec's recorded one. */
export async function specReviewRecordItems(
  env: SpecReviewRecordEnvironment, taskId: string, operation: { id: string; kind: string; workflowMode?: string | undefined }, outcome: { status: string; result: unknown },
): Promise<TransactItem[]> {
  if (operation.kind !== "task" || operation.workflowMode !== "REVIEW" || outcome.status !== "SUCCEEDED") return [];
  const reported = outcome.result !== null && typeof outcome.result === "object" ? (outcome.result as { specReview?: unknown }).specReview : undefined;
  if (reported === undefined) return [];
  const parsed = SpecReviewResultSchema.safeParse(reported);
  if (!parsed.success) return [];
  const { state } = await env.store.load(taskId);
  if (state?.specPullRequest === undefined || state.specPullRequest.commit !== parsed.data.specCommit) return [];
  const item: StoredSpecReview = { pk: `DEVTASK#${taskId}`, sk: `${SPEC_REVIEW_SK_PREFIX}${operation.id}`, entityType: "SPEC_REVIEW", taskId, operationId: operation.id, recordedAt: env.now(), ...parsed.data };
  return [{ Put: { TableName: env.tableName, Item: item } }];
}

/** The requirement rows of every spec walk recorded for the task, oldest first: `(specPath, specCommit, id)` with the verdict, reason and evidence. This is the export W4 reads. */
export async function specRequirementRowsOfTask(
  deps: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, taskId: string,
): Promise<Array<ReturnType<typeof specRequirementRows>[number] & { operationId: string; recordedAt: string }>> {
  const rows: Array<ReturnType<typeof specRequirementRows>[number] & { operationId: string; recordedAt: string }> = [];
  // Every recorded walk, a page at a time, bounded at 20 pages.
  let cursor: Record<string, unknown> | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${taskId}`, ":prefix": SPEC_REVIEW_SK_PREFIX }, Limit: 20, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
    })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of result.Items ?? []) {
      const record = item as Partial<StoredSpecReview>;
      const parsed = SpecReviewResultSchema.safeParse(record);
      if (!parsed.success || typeof record.operationId !== "string" || typeof record.recordedAt !== "string") continue;
      for (const row of specRequirementRows(parsed.data)) rows.push({ ...row, operationId: record.operationId, recordedAt: record.recordedAt });
    }
    cursor = result.LastEvaluatedKey;
    if (cursor === undefined) break;
  }
  return rows.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}
