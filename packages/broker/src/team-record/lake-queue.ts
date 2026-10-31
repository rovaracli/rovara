// The lake delete queue (design 4.4.3): what the delete worker asks the lake to forget. The Athena job (the storage lane's `runLakeDeletes`) reads it through
// `listPending` and `ack`. An entry is acknowledged only after its statement ran, so a failed one stays and the next run tries again. Entries are keyed by their
// target, so enqueueing the same thing twice is one entry. Every target is a hash or one of our own ids, never text.
import { createHash } from "node:crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { teamRecordPk } from "@agentx/contracts";
import { queryPrefix } from "./store.js";
import type { TeamRecordTable } from "./types.js";

export type LakeDeleteTarget =
  | { kind: "source"; sourceHash: string }
  | { kind: "actor"; developerId: string }
  /** A person with no developer id (an outsider, an unmapped Slack user): `recordActorSourceHash(system, sourceId)`. */
  | { kind: "actor_source"; hash: string }
  /** A whole place (a deleted channel or repository, a channel that turned private): `recordScopeHash(scope)`. */
  | { kind: "scope"; hash: string }
  | { kind: "project"; project: string }
  | { kind: "fact"; factId: string };

export interface PendingLakeDelete { id: string; target: LakeDeleteTarget }

export interface LakeDeleteQueue {
  enqueue(workspaceId: string, targets: readonly LakeDeleteTarget[]): Promise<void>;
  listPending(workspaceId: string, limit: number): Promise<PendingLakeDelete[]>;
  ack(workspaceId: string, ids: string[]): Promise<void>;
}

const PREFIX = "LAKEDEL#";
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;

const idOf = (target: LakeDeleteTarget): string => createHash("sha256").update(JSON.stringify(target)).digest("hex").slice(0, 40);

/** Whether a target holds only values a delete statement may carry. */
export function validTarget(target: LakeDeleteTarget): boolean {
  switch (target.kind) {
    case "source": return HASH.test(target.sourceHash);
    case "actor": return ID.test(target.developerId);
    case "actor_source": return HASH.test(target.hash);
    case "scope": return HASH.test(target.hash);
    case "project": return ID.test(target.project);
    case "fact": return ID.test(target.factId);
  }
}

export function tableLakeDeleteQueue(table: TeamRecordTable, now: () => number = Date.now): LakeDeleteQueue {
  return {
    async enqueue(workspaceId, targets) {
      for (const target of targets) {
        if (!validTarget(target)) throw new Error("a lake delete target holds a value a statement may not carry");
        await table.documentClient.send(new PutCommand({
          TableName: table.tableName,
          Item: { pk: teamRecordPk(workspaceId), sk: `${PREFIX}${idOf(target)}`, entityType: "TEAM_RECORD_LAKE_DELETE", target, queuedAt: new Date(now()).toISOString() },
        }));
      }
    },
    async listPending(workspaceId, limit) {
      const { items } = await queryPrefix(table, workspaceId, undefined, PREFIX, limit);
      return items.flatMap((item) => (typeof item.sk === "string" && item.target !== undefined && validTarget(item.target as LakeDeleteTarget) ? [{ id: item.sk.slice(PREFIX.length), target: item.target as LakeDeleteTarget }] : []));
    },
    async ack(workspaceId, ids) {
      for (const id of ids) {
        if (!/^[0-9a-f]{40}$/.test(id)) continue;
        await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: { pk: teamRecordPk(workspaceId), sk: `${PREFIX}${id}` } }));
      }
    },
  };
}
