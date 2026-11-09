// Lessons in the repo, lane R2: the Dynamo side of `RepoFileStore` (repo-file-state.ts). Items on the Team record table, all under the LESSONSET prefix a project or workspace erase already wipes:
//   - one STATE item per project and repository: pk of the project (`teamRecordPk(workspace, project)`), sk `LESSONSET#REPOFILE#<16 hex of the repository place>`; attributes `state` and `revision`;
//   - one ERASE row per (repository, pull request) that adds erased text and must be closed: sk `LESSONSET#REPOFILEPR#<16 hex of the place>#<number>`. Never part of a capped list; removed only when the host confirmed the close.
// They hold ids, fingerprints, counts, branch names and times: never a lesson's text, a person or a host's words. A state write is conditional on the revision read and is checked against its schema and size first; an item that exists
// and does not parse THROWS when read (it is never "absent", which would let a pass write a fresh state over it). The table is taken structurally so this file imports nothing from the Team record.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk } from "@agentx/contracts";
import { EraseCloseSchema, StateUnreadable, checkedState, parseRepoFileState, type EraseClose, type RepoFileState, type RepoFileStore } from "./repo-file-state.js";
import type { ScopeKey } from "./store.js";

export interface RepoFileTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
const STATE = "LESSONSET#REPOFILE#";
const ERASE = "LESSONSET#REPOFILEPR#";
const hash = (place: string): string => createHash("sha256").update(place).digest("hex").slice(0, 16);
const stateKey = (key: ScopeKey, place: string) => ({ pk: teamRecordPk(key.workspaceId, key.project), sk: `${STATE}${hash(place)}` });
const eraseKey = (key: ScopeKey, place: string, number: string) => ({ pk: teamRecordPk(key.workspaceId, key.project), sk: `${ERASE}${hash(place)}#${number}` });

export function dynamoRepoFileStore(table: RepoFileTable): RepoFileStore {
  const read = (item: { state?: unknown; revision?: unknown }): RepoFileState => {
    const state = parseRepoFileState(item.state);
    if (state === undefined || typeof item.revision !== "number") throw new StateUnreadable();
    // The item's own revision is the one the condition is written against.
    return { ...state, revision: item.revision };
  };
  const query = async (key: ScopeKey, prefix: string): Promise<Array<Record<string, unknown>>> => {
    const found: Array<Record<string, unknown>> = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await table.documentClient.send(new QueryCommand({
        TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
        ExpressionAttributeValues: { ":pk": teamRecordPk(key.workspaceId, key.project), ":prefix": prefix }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
      found.push(...(out.Items ?? []));
      start = out.LastEvaluatedKey;
    } while (start !== undefined);
    return found;
  };
  return {
    async list(key) { return (await query(key, STATE)).map(read).sort((a, b) => a.place.localeCompare(b.place)); },
    async get(key, place) {
      const out = await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: stateKey(key, place), ConsistentRead: true })) as { Item?: { state?: unknown; revision?: unknown } };
      return out.Item === undefined ? undefined : read(out.Item);
    },
    async put(key, state, expected) {
      const revision = expected + 1;
      // Checked first (schema and size): a state that would not read back is refused here, loudly. JSON drops the fields that are undefined, which DynamoDB would refuse.
      const stored = JSON.parse(JSON.stringify({ ...checkedState(state), revision })) as RepoFileState;
      try {
        await table.documentClient.send(new PutCommand({
          TableName: table.tableName, Item: { ...stateKey(key, state.place), entityType: "LESSON_REPOFILE", state: stored, revision },
          ...(expected === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expected } }),
        }));
        return stored;
      } catch (error) {
        if ((error as { name?: unknown } | null)?.name === "ConditionalCheckFailedException") return undefined;
        throw error;
      }
    },
    async listErase(key) {
      return (await query(key, ERASE)).map((item) => {
        const row = EraseCloseSchema.safeParse(item.row);
        // A row that does not parse is not "no row": reading throws, so the erasure is never forgotten silently.
        if (!row.success) throw new StateUnreadable();
        return row.data;
      });
    },
    async putErase(key, row: EraseClose) {
      const checked = EraseCloseSchema.parse(row);
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...eraseKey(key, checked.place, checked.number), entityType: "LESSON_REPOFILE_ERASE", row: JSON.parse(JSON.stringify(checked)) as EraseClose } }));
    },
    async delErase(key, place, number) {
      await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: eraseKey(key, place, number) }));
    },
  };
}
