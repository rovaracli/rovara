// Lessons in production, lane 5 (DECISIONS 23): the lesson vectors, kept WITH the lessons in the Team record table. One item beside each lesson head, `LESSON#<id>#VEC`, in the project's partition:
// the embedder spec it was made by, the hash of the text it was made from, and the vector as 32-bit floats. There is no vector index (a project holds at most ~2,000 lessons; the search is a brute-force
// cosine in memory over the vectors read for one call).
//
//   - The sort key starts with `LESSON#`, so the project erase and the workspace erase wipe it with the lesson, and a purge removes it (`remove`, and the store's own purge).
//   - One item per lesson: a new spec REPLACES the old item, so a model change leaves nothing behind, and `get` returns only a vector of the asked spec (anything else is a miss: the lesson is embedded again).
//   - The item holds no person, no text and no id but the lesson's own: a derived vector of the lesson text, which the lesson's own history already holds.
//   - A write is FENCED like the lesson's own commit: one transaction holds the vector Put, a check that the lesson head exists and a check that its GONE mark is not "purged". A curate that read the pool before
//     a purge (a person's erasure, a withdrawal that became a purge) and writes its backfill after it is refused, so no vector of erased text is left behind. A refused write is a no-op, not an error.
//   - Reads are consistent BatchGets of the ids the caller names (never a scan of the partition); an unprocessed key is retried and then reported as a miss, never as a vector.
import { BatchGetCommand, DeleteCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { lessonKey, type OrgId } from "@agentx/contracts";
import type { TeamRecordTable } from "../team-record/types.js";
import type { LessonVectors, StoredLessonVector } from "./ports.js";

const BATCH = 100;
const RETRIES = 3;
/** The wait before reading again keys the table left unprocessed: 40 ms, 80 ms, 160 ms, each with up to the same again at random. */
const BACKOFF_MS = 40;
export const VECTOR_ENTITY = "LESSON_VECTOR";

/** The sort key of a lesson's vector item. */
export const lessonVectorKey = (orgId: OrgId, project: string, id: string): { pk: string; sk: string } => {
  const head = lessonKey(orgId, project, id);
  return { pk: head.pk, sk: `${head.sk}#VEC` };
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

const toBytes = (vector: readonly number[]): Uint8Array => new Uint8Array(new Float32Array(vector).buffer);
function fromBytes(value: unknown): number[] | undefined {
  if (Array.isArray(value)) return value.every((x) => typeof x === "number") ? (value) : undefined;
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength % 4 !== 0) return undefined;
  const copy = new Uint8Array(value);
  return Array.from(new Float32Array(copy.buffer));
}

function isRefusedTransaction(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TransactionCanceledException" || name === "ConditionalCheckFailedException";
}

export function dynamoLessonVectors(table: TeamRecordTable, orgOf: (workspaceId: string) => OrgId = (id) => id): LessonVectors {
  const send = <T,>(command: unknown): Promise<T> => table.documentClient.send(command) as Promise<T>;
  const keyOf = (workspaceId: string, project: string, id: string) => lessonVectorKey(orgOf(workspaceId), project, id);
  return {
    async get(workspaceId, project, spec, ids) {
      const found = new Map<string, StoredLessonVector>();
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += BATCH) {
        let pending: Array<{ pk: string; sk: string }> = unique.slice(i, i + BATCH).map((id) => keyOf(workspaceId, project, id));
        for (let attempt = 0; pending.length > 0 && attempt <= RETRIES; attempt += 1) {
          const response = await send<{ Responses?: Record<string, Array<Record<string, unknown>>>; UnprocessedKeys?: Record<string, { Keys: Array<{ pk: string; sk: string }> }> }>(
            new BatchGetCommand({ RequestItems: { [table.tableName]: { Keys: pending, ConsistentRead: true } } }),
          );
          for (const item of response.Responses?.[table.tableName] ?? []) {
            const vector = fromBytes(item.vector);
            if (item.entityType !== VECTOR_ENTITY || item.spec !== spec || typeof item.id !== "string" || typeof item.hash !== "string" || vector === undefined) continue;
            found.set(item.id, { hash: item.hash, vector });
          }
          pending = response.UnprocessedKeys?.[table.tableName]?.Keys ?? [];
          if (pending.length > 0 && attempt < RETRIES) await pause(BACKOFF_MS * 2 ** attempt * (1 + Math.random()));
        }
      }
      return found;
    },
    async put(workspaceId, project, spec, id, stored) {
      const vectorKey = keyOf(workspaceId, project, id);
      const head = { pk: vectorKey.pk, sk: vectorKey.sk.slice(0, -"#VEC".length) };
      try {
        await send(new TransactWriteCommand({
          TransactItems: [
            { ConditionCheck: { TableName: table.tableName, Key: head, ConditionExpression: "attribute_exists(pk)" } },
            { ConditionCheck: { TableName: table.tableName, Key: { pk: head.pk, sk: `${head.sk}#GONE` }, ConditionExpression: "attribute_not_exists(pk) OR #m <> :purged", ExpressionAttributeNames: { "#m": "mode" }, ExpressionAttributeValues: { ":purged": "purged" } } },
            { Put: { TableName: table.tableName, Item: { ...vectorKey, entityType: VECTOR_ENTITY, id, spec, hash: stored.hash, vector: toBytes(stored.vector) } } },
          ],
        }));
      } catch (error) {
        // The lesson is gone (purged, erased) or never existed: there is nothing to attach a vector to. Any other fault is the caller's to log.
        if (isRefusedTransaction(error)) return;
        throw error;
      }
    },
    async remove(workspaceId, project, id) {
      await send(new DeleteCommand({ TableName: table.tableName, Key: keyOf(workspaceId, project, id) }));
    },
  };
}
