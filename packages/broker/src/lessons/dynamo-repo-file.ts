// Lessons in the repo, lane R2: the Dynamo side of `RepoFileStore` (repo-file-state.ts). One item per project and repository on the Team record table:
//   pk of the project (`teamRecordPk(workspace, project)`), sk `LESSONSET#REPOFILE#<16 hex of the repository place>`; attributes `state` (the validated state) and `revision`.
// The sort key starts with `LESSONSET`, which the project erase and the workspace erase already wipe. The item holds ids, fingerprints, counts, branch names and times: never a lesson's text, a person or a host's words.
// Every write is conditional on the revision that was read. The table is taken structurally (a document client and a name) so this file imports nothing from the Team record.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk } from "@agentx/contracts";
import { parseRepoFileState, type RepoFileState, type RepoFileStore } from "./repo-file-state.js";
import type { ScopeKey } from "./store.js";

export interface RepoFileTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
const PREFIX = "LESSONSET#REPOFILE#";
const keyOf = (key: ScopeKey, place: string) => ({ pk: teamRecordPk(key.workspaceId, key.project), sk: `${PREFIX}${createHash("sha256").update(place).digest("hex").slice(0, 16)}` });

export function dynamoRepoFileStore(table: RepoFileTable): RepoFileStore {
  const read = (item: { state?: unknown; revision?: unknown } | undefined): RepoFileState | undefined => {
    if (item === undefined) return undefined;
    const state = parseRepoFileState(item.state);
    // The item's own revision is the one the condition is written against.
    return state === undefined || typeof item.revision !== "number" ? undefined : { ...state, revision: item.revision };
  };
  return {
    async list(key) {
      const found: RepoFileState[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await table.documentClient.send(new QueryCommand({
          TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
          ExpressionAttributeValues: { ":pk": teamRecordPk(key.workspaceId, key.project), ":prefix": PREFIX }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })) as { Items?: Array<{ state?: unknown; revision?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
        for (const item of out.Items ?? []) { const state = read(item); if (state !== undefined) found.push(state); }
        start = out.LastEvaluatedKey;
      } while (start !== undefined && found.length < 100);
      return found.sort((a, b) => a.place.localeCompare(b.place));
    },
    async get(key, place) {
      const out = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: keyOf(key, place), ConsistentRead: true })) as { Item?: { state?: unknown; revision?: unknown } };
      return read(out.Item);
    },
    async put(key, state, expected) {
      const revision = expected + 1;
      // JSON drops the fields that are undefined, which DynamoDB would refuse.
      const stored = JSON.parse(JSON.stringify({ ...state, revision })) as RepoFileState;
      try {
        await table.documentClient.send(new PutCommand({
          TableName: table.tableName, Item: { ...keyOf(key, state.place), entityType: "LESSON_REPOFILE", state: stored, revision },
          ...(expected === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expected } }),
        }));
        return stored;
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return undefined;
        throw error;
      }
    },
  };
}
