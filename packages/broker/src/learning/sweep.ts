// v1.2 learning loop: the learning sweep (design §3.2). Named environments delete learning items by the State table's TTL on `indexExpiresAt`; a table without a TTL (the legacy
// deployment) has only the index sweep (aws/index-expiry.ts), which clears nothing of ours. This sweep is called beside it, under the same guard, from the session reconciler.
//
// Each run walks the company's project catalog (walk.ts), reads every learning partition and deletes the items whose time has passed, so text is gone after 180 days even from a
// project nobody opens. Then it expires open suggestions whose sources have fallen below two. A run deletes at most 500 items, visits at most 50 projects and stops after 20 seconds;
// the next run resumes from the cursor in `LEARNING_WALK#sweep`. Reads elsewhere already hide an expired item, and nothing is deleted on read.
import { DeleteCommand, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, LEARNING_SUGGESTION_SOURCES_MIN, projectLearningKey, type OrgId } from "@agentx/contracts";
import { isExpired, learningItemKind, sameProject } from "./retention.js";
import { closeSuggestion, readLearningPartition, type LearningDeps } from "./store.js";
import { runLearningWalk, type ProjectJob, type WalkLimits } from "./walk.js";

type Client = { send(command: unknown): Promise<unknown> };
type Item = Record<string, unknown>;

export const LEARNING_EXPIRY_DELETES_PER_RUN = 500;
export const LEARNING_EXPIRY_PROJECTS_PER_RUN = 50;

export interface LearningExpiryLimits {
  deletes?: number;
  projects?: number;
  millis?: number;
  /** The clock that measures the run's time budget (the expiry itself is judged at the `now` argument). */
  now?: () => number;
}
export interface LearningExpiryResult { deleted: number; expiredSuggestions: number; projectsDone: number; done: boolean }

const isConditionFailure = (error: unknown) => error instanceof Error && error.name === "ConditionalCheckFailedException";

export async function expireLearningItems(
  client: Client, tableName: string, orgId: OrgId, now: Date, log: (entry: Record<string, unknown>) => void = () => undefined, limits: LearningExpiryLimits = {},
): Promise<LearningExpiryResult> {
  const nowMs = now.getTime();
  const nowSeconds = Math.floor(nowMs / 1000);
  // Everything about expiry is judged at `nowMs`; only the run's own time budget reads the real clock.
  const judged: LearningDeps = { documentClient: client, tableName, now: () => nowMs };
  const clocked: LearningDeps = { documentClient: client, tableName, now: limits.now ?? (() => Date.now()) };
  let deleted = 0, expiredSuggestions = 0;

  const job: ProjectJob = async ({ project, budget }) => {
    const stateRead = await client.send(new GetCommand({ TableName: tableName, Key: projectLearningKey(orgId, project, "STATE"), ConsistentRead: true })) as { Item?: Item };
    const projectCreatedAt = typeof stateRead.Item?.["projectCreatedAt"] === "string" ? stateRead.Item["projectCreatedAt"] : undefined;
    const stateKey = projectLearningKey(orgId, project, "STATE");
    const cancellation = (error: unknown): string[] | undefined => error instanceof Error && error.name === "TransactionCanceledException"
      ? ((error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? []).map((reason) => reason.Code ?? "None") : undefined;
    /**
     * Deletes one expired item if it is still expired. A correction of this project goes in ONE transaction with the one-less on `liveCorrections`, so the counter and the stored
     * corrections cannot disagree at any moment: a capture that finds the project full and counts the table (store.ts) sees both or neither, and what it counts is never subtracted again.
     * Returns whether the item was deleted (false: it was renewed since it was read).
     */
    const deleteExpired = async (item: Item, counted: boolean): Promise<boolean> => {
      const condition = { ConditionExpression: `${INDEX_EXPIRY_ATTRIBUTE} <= :now`, ExpressionAttributeValues: { ":now": nowSeconds } };
      const key = { pk: item["pk"], sk: item["sk"] };
      if (counted && projectCreatedAt !== undefined) {
        try {
          await client.send(new TransactWriteCommand({ TransactItems: [
            { Delete: { TableName: tableName, Key: key, ...condition } },
            { Update: { TableName: tableName, Key: stateKey, UpdateExpression: "ADD liveCorrections :minus", ConditionExpression: "projectCreatedAt = :pc AND liveCorrections >= :one", ExpressionAttributeValues: { ":minus": -1, ":one": 1, ":pc": projectCreatedAt } } },
          ] }));
          return true;
        } catch (error) {
          const reasons = cancellation(error);
          if (reasons === undefined) throw error;
          // The item was renewed: it is not expired any more.
          if (reasons[0] === "ConditionalCheckFailed") return false;
          // The counter is already at zero (or the STATE is gone): there is nothing to take off it; delete the item alone.
        }
      }
      try {
        await client.send(new DeleteCommand({ TableName: tableName, Key: key, ...condition }));
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    };

    // One page at a time, with the run's budget checked before each page and each delete: a long partition cannot outrun the time limit.
    const liveIds = new Set<string>();
    const openSuggestions: Item[] = [];
    let cursor: string | undefined;
    do {
      if (budget.exhausted()) return "partial";
      const page = await readLearningPartition(judged, { orgId, project }, { ...(cursor === undefined ? {} : { cursor }), maxItems: 100, maxPages: 1, pageSize: 100 });
      cursor = page.cursor;
      for (const item of page.items) {
        const kind = learningItemKind(String(item["sk"])).kind;
        if (isExpired(item, nowMs)) {
          if (budget.exhausted()) return "partial";
          if (!await deleteExpired(item, kind === "CORRECTION" && sameProject(item["projectCreatedAt"], projectCreatedAt))) continue;
          budget.spend(1);
          deleted += 1;
        } else if (kind === "CORRECTION" && sameProject(item["projectCreatedAt"], projectCreatedAt) && typeof item["id"] === "string") {
          liveIds.add(item["id"]);
        } else if (kind === "SUGGESTION" && item["status"] === "open" && sameProject(item["projectCreatedAt"], projectCreatedAt)) {
          openSuggestions.push(item);
        }
      }
    } while (cursor !== undefined);

    if (projectCreatedAt === undefined) return "done";
    for (const item of openSuggestions) {
      const sources = Array.isArray(item["correctionIds"]) ? item["correctionIds"].filter((id) => typeof id === "string" && liveIds.has(id)).length : 0;
      if (sources >= LEARNING_SUGGESTION_SOURCES_MIN) continue;
      if (budget.exhausted()) return "partial";
      const closed = await closeSuggestion(judged, { orgId, project, projectCreatedAt }, { id: String(item["id"]), expectedRevision: Number(item["revision"]), status: "expired" });
      budget.spend(1);
      if (closed.ok) expiredSuggestions += 1;
    }
    return "done";
  };

  const budget: WalkLimits = { writes: limits.deletes ?? LEARNING_EXPIRY_DELETES_PER_RUN, projects: limits.projects ?? LEARNING_EXPIRY_PROJECTS_PER_RUN, ...(limits.millis === undefined ? {} : { millis: limits.millis }) };
  const walked = await runLearningWalk(clocked, { orgId, kind: "sweep", job, budget });
  // Counts only: the items hold correction text.
  if (deleted > 0 || expiredSuggestions > 0) log({ event: "learning_expiry.deleted", deleted, expiredSuggestions, projectsDone: walked.projectsThisRun });
  return { deleted, expiredSuggestions, projectsDone: walked.projectsThisRun, done: walked.status === "done" };
}
