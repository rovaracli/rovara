// Lane 7: the frozen snapshots a replay copy reads (contracts `MemorySnapshot`, `memorySnapshotKey`). A snapshot names lessons by id AND version, never by text: the text is read from the lesson store's own version
// history when the copy loads, so an erased or withdrawn lesson is simply gone from the snapshot (privacy wins over reproducibility; `incomplete` says so) and no copy of lesson text is kept here. The id is derived from
// the content (`snp_` + a digest of the sorted references), so an id cannot be made to name other lessons. One item per snapshot in the project's partition under `SNAPSHOT#`, written only if absent.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { MemorySnapshotSchema, memorySnapshotKey, type MemorySnapshot, type OrgId } from "@agentx/contracts";
import type { TeamRecordTable } from "../team-record/types.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

/** The most lessons one snapshot names (a project's active set is far below it). */
export const SNAPSHOT_MAX_LESSONS = 300;

export interface LessonRef { id: string; version: number }
export interface SnapshotStore {
  /** Writes the snapshot if there is none under its id; the same id with other content is refused (it cannot happen for an id made by `snapshotIdOf`). */
  put(snapshot: MemorySnapshot): Promise<"created" | "exists">;
  get(key: ScopeKey, snapshotId: string): Promise<MemorySnapshot | undefined>;
}

const sortedRefs = (refs: readonly LessonRef[]): LessonRef[] => [...refs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
export const contentDigestOf = (refs: readonly LessonRef[]): string => createHash("sha256").update(JSON.stringify(sortedRefs(refs).map((r) => [r.id, r.version]))).digest("hex");
/** The snapshot's id: made from its content, so naming an id names exactly those lessons. */
export const snapshotIdOf = (key: ScopeKey, refs: readonly LessonRef[]): string => `snp_${createHash("sha256").update(JSON.stringify([key.workspaceId, key.project, contentDigestOf(refs)])).digest("hex").slice(0, 20)}`;

export function buildSnapshot(input: { key: ScopeKey; refs: readonly LessonRef[]; createdBy: string; at: string; lessonSetVersion?: number }): MemorySnapshot {
  if (input.refs.length > SNAPSHOT_MAX_LESSONS) throw new RangeError(`A snapshot names at most ${String(SNAPSHOT_MAX_LESSONS)} lessons.`);
  if (new Set(input.refs.map((r) => r.id)).size !== input.refs.length) throw new RangeError("A snapshot names a lesson once.");
  return MemorySnapshotSchema.parse({
    snapshotId: snapshotIdOf(input.key, input.refs), workspaceId: input.key.workspaceId, project: input.key.project, createdAt: input.at, createdBy: input.createdBy,
    lessonSetVersion: input.lessonSetVersion ?? 0, lessons: sortedRefs(input.refs), skills: [], embeddingModelId: "none", contentDigest: contentDigestOf(input.refs),
  });
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly items = new Map<string, MemorySnapshot>();
  async put(snapshot: MemorySnapshot): Promise<"created" | "exists"> {
    const k = `${snapshot.workspaceId}\u0000${snapshot.project}\u0000${snapshot.snapshotId}`;
    const known = this.items.get(k);
    if (known !== undefined) { if (known.contentDigest !== snapshot.contentDigest) throw new Error("snapshot id reused"); return "exists"; }
    this.items.set(k, snapshot);
    return "created";
  }
  async get(key: ScopeKey, snapshotId: string): Promise<MemorySnapshot | undefined> { return this.items.get(`${key.workspaceId}\u0000${key.project}\u0000${snapshotId}`); }
}

export function dynamoSnapshotStore(table: TeamRecordTable, orgOf: (workspaceId: string) => OrgId = (id) => id): SnapshotStore {
  return {
    async put(snapshot) {
      const k = memorySnapshotKey(orgOf(snapshot.workspaceId), snapshot.project, snapshot.snapshotId);
      try {
        await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...k, entityType: "MEMORY_SNAPSHOT", ...snapshot }, ConditionExpression: "attribute_not_exists(pk)" }));
        return "created";
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== "ConditionalCheckFailedException") throw error;
        const known = await this.get({ workspaceId: snapshot.workspaceId, project: snapshot.project }, snapshot.snapshotId);
        if (known === undefined || known.contentDigest !== snapshot.contentDigest) throw new Error("snapshot id reused", { cause: error });
        return "exists";
      }
    },
    async get(key, snapshotId) {
      const k = memorySnapshotKey(orgOf(key.workspaceId), key.project, snapshotId);
      const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: k, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
      if (item === undefined) return undefined;
      const { pk: _pk, sk: _sk, entityType: _entity, ...rest } = item;
      void _pk; void _sk; void _entity;
      const parsed = MemorySnapshotSchema.safeParse(rest);
      return parsed.success && parsed.data.workspaceId === key.workspaceId && parsed.data.project === key.project ? parsed.data : undefined;
    },
  };
}

/**
 * The lessons a snapshot names, at the versions it names, read from the lesson store's history. A lesson or version that is gone (erased, withdrawn, purged) is left out and `incomplete` is true; nothing else is
 * ever added, so the copy sees EXACTLY these lessons and never the live set.
 */
export async function resolveSnapshotLessons(store: Pick<LessonStore, "versions">, key: ScopeKey, snapshot: MemorySnapshot): Promise<{ lessons: Lesson[]; incomplete: boolean }> {
  if (snapshot.workspaceId !== key.workspaceId || snapshot.project !== key.project) return { lessons: [], incomplete: true };
  const lessons: Lesson[] = [];
  let incomplete = snapshot.incomplete === true;
  for (const ref of snapshot.lessons) {
    const found = (await store.versions(key, ref.id)).find((version) => version.version === ref.version);
    if (found === undefined) incomplete = true; else lessons.push(found);
  }
  return { lessons, incomplete };
}
