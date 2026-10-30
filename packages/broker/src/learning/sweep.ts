// v1.2 learning loop: the learning sweep (design §3.2). Named environments delete learning items by the State table's TTL on `indexExpiresAt`; a table without a TTL (the legacy
// deployment) has only the index sweep (aws/index-expiry.ts), which clears nothing of ours. This sweep is called beside it, under the same guard, from the session reconciler.
//
// Each run walks the company's project catalog (walk.ts), reads every learning partition and deletes the items whose time has passed, so text is gone after 180 days even from a
// project nobody opens. Then it expires open suggestions whose sources have fallen below two. A run deletes at most 500 items, visits at most 50 projects and stops after 20 seconds;
// the next run resumes from the cursor in `LEARNING_WALK#sweep`. Reads elsewhere already hide an expired item, and nothing is deleted on read.
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
    const items: Item[] = [];
    let cursor: string | undefined;
    do {
      const page = await readLearningPartition(judged, { orgId, project }, { ...(cursor === undefined ? {} : { cursor }), maxItems: 1000, maxPages: 10, pageSize: 100 });
      items.push(...page.items);
      cursor = page.cursor;
    } while (cursor !== undefined);

    const state = items.find((item) => item["sk"] === "STATE");
    const projectCreatedAt = typeof state?.["projectCreatedAt"] === "string" ? state["projectCreatedAt"] : undefined;
    let correctionsDeleted = 0;
    const settleCounter = async () => {
      if (correctionsDeleted === 0 || projectCreatedAt === undefined) return;
      try {
        await client.send(new UpdateCommand({
          TableName: tableName, Key: projectLearningKey(orgId, project, "STATE"), UpdateExpression: "ADD liveCorrections :minus",
          ConditionExpression: "projectCreatedAt = :pc AND liveCorrections >= :count", ExpressionAttributeValues: { ":minus": -correctionsDeleted, ":count": correctionsDeleted, ":pc": projectCreatedAt },
        }));
      } catch (error) {
        // A counter that is already lower is put right by the next capture that finds the project full.
        if (!isConditionFailure(error)) throw error;
      }
      correctionsDeleted = 0;
    };

    const expired = items.filter((item) => isExpired(item, nowMs));
    const liveIds = new Set<string>();
    for (const item of items) if (learningItemKind(String(item["sk"])).kind === "CORRECTION" && !isExpired(item, nowMs) && sameProject(item["projectCreatedAt"], projectCreatedAt) && typeof item["id"] === "string") liveIds.add(item["id"]);

    for (const item of expired) {
      if (budget.exhausted()) { await settleCounter(); return "partial"; }
      try {
        await client.send(new DeleteCommand({
          TableName: tableName, Key: { pk: item["pk"], sk: item["sk"] }, ConditionExpression: `${INDEX_EXPIRY_ATTRIBUTE} <= :now`, ExpressionAttributeValues: { ":now": nowSeconds },
        }));
      } catch (error) {
        // Renewed since it was read: it is not expired any more.
        if (isConditionFailure(error)) continue;
        throw error;
      }
      budget.spend(1);
      deleted += 1;
      if (learningItemKind(String(item["sk"])).kind === "CORRECTION" && sameProject(item["projectCreatedAt"], projectCreatedAt)) correctionsDeleted += 1;
    }
    await settleCounter();

    if (projectCreatedAt === undefined) return "done";
    for (const item of items) {
      if (learningItemKind(String(item["sk"])).kind !== "SUGGESTION" || item["status"] !== "open" || isExpired(item, nowMs) || !sameProject(item["projectCreatedAt"], projectCreatedAt)) continue;
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
