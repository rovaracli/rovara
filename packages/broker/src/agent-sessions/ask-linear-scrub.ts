// Lane ask-linear: the comments Rovara posted on Linear issues that hold the name of a person who was erased. `eraseAskPerson` (ask-erase.ts) scrubs the stored Ask and leaves a waiting item for each of its Linear
// comments (ids only, in the org's `ASKLINEARFIX` partition). The Ask upkeep (`runAskMaintenance`) calls `settleLinearScrubs`: it rewrites the comment from the Ask's already-scrubbed record, or deletes the
// comment when there is no scrubbed text to rewrite it from, and removes the waiting item. Only comments Rovara's own account wrote are touched (the port checks the author). Bounded and repeatable: an item
// that cannot be done now stays for the next run, and is given up on (with a log line by name) after `LINEAR_SCRUB_ATTEMPTS` tries.
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { askLinearScrubPk, sessionAskKey, type OrgId } from "@agentx/contracts";
import { linearAnswerText } from "./ask.js";
import { askRecordFromItem, type AskItem, type AskStoreTable } from "./ask-erase.js";

export const LINEAR_SCRUB_ATTEMPTS = 10;
export const LINEAR_SCRUB_PER_RUN = 25;

/** What the upkeep needs of Linear: both calls refuse a comment that is not Rovara's own. */
export interface LinearScrubPort {
  update(input: { orgId: OrgId; commentId: string; text: string }): Promise<void>;
  remove(input: { orgId: OrgId; commentId: string }): Promise<void>;
}

export interface LinearScrubDependencies extends AskStoreTable {
  port: LinearScrubPort;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface LinearScrubResult { rewritten: number; removed: number; waiting: number; gaveUp: number }

const codeOf = (error: unknown): string | undefined => (typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined);

export async function settleLinearScrubs(deps: LinearScrubDependencies, orgId: OrgId, limit: number = LINEAR_SCRUB_PER_RUN): Promise<LinearScrubResult> {
  const result: LinearScrubResult = { rewritten: 0, removed: 0, waiting: 0, gaveUp: 0 };
  const page = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": askLinearScrubPk(orgId) }, Limit: limit, ConsistentRead: true })) as { Items?: AskItem[] };
  const done = (item: AskItem) => deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] } }));
  for (const item of page.Items ?? []) {
    const sessionId = item["sessionId"], askId = item["askId"], commentId = item["commentId"];
    if (item["orgId"] !== orgId || typeof commentId !== "string" || commentId === "" || typeof sessionId !== "string" || typeof askId !== "string") { await done(item); continue; }
    const posted = { commentId };
    try {
      const found = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: sessionAskKey(orgId, sessionId, askId), ConsistentRead: true }))) as { Item?: AskItem }).Item;
      const record = found?.["orgId"] === orgId ? askRecordFromItem(found) : undefined;
      if (record?.answer !== undefined && record.answer.trim() !== "") {
        await deps.port.update({ orgId, commentId: posted.commentId, text: linearAnswerText(record.answer) });
        result.rewritten += 1;
      } else {
        // No scrubbed words to put back (the Ask is gone, or kept none): the comment goes.
        await deps.port.remove({ orgId, commentId: posted.commentId });
        result.removed += 1;
      }
      await done(item);
    } catch (error) {
      // A comment that is already gone is done.
      if (codeOf(error) === "NOT_FOUND") { await done(item); continue; }
      const attempts = (typeof item["attempts"] === "number" ? item["attempts"] : 0) + 1;
      if (attempts >= LINEAR_SCRUB_ATTEMPTS) {
        deps.log?.({ event: "ask.linear_scrub_gave_up", orgId, attempts, code: codeOf(error) ?? "unknown" });
        await done(item);
        result.gaveUp += 1;
        continue;
      }
      deps.log?.({ event: "ask.linear_scrub_waiting", orgId, attempts, code: codeOf(error) ?? "unknown" });
      await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, Key: { pk: item["pk"], sk: item["sk"] }, UpdateExpression: "SET attempts = :n", ExpressionAttributeValues: { ":n": attempts } })).catch(() => undefined);
      result.waiting += 1;
    }
  }
  return result;
}
