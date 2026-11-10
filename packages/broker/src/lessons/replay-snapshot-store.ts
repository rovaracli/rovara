// Lane 7: the frozen snapshots a replay copy reads (contracts `MemorySnapshot`, `memorySnapshotKey`). A snapshot names lessons by id AND version, never by text: the text is read from the lesson store's own version
// history when the copy loads, so an erased or withdrawn lesson is simply gone from the snapshot (privacy wins over reproducibility; `incomplete` says so) and no copy of lesson text is kept here. The id is derived from
// the content (`snp_` + a digest of the sorted references), so an id cannot be made to name other lessons. One item per snapshot in the project's partition under `SNAPSHOT#`, written only if absent.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { MemorySnapshotSchema, memorySnapshotKey, type MemorySnapshot, type OrgId } from "@agentx/contracts";
import { LessonSchema } from "./types.js";
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

// ---------------------------------------------------------------------------------------------------------------------------
// Eval snapshots: the lessons an ARM'S OWN pipeline built offline from the same historical tasks (DECISIONS 68). Unlike a snapshot above (ids and versions of the install's live lessons), these hold the lessons'
// texts, because an offline pipeline's lessons exist nowhere in the live store (and must not: `LESSON#` items are the live set). They are written under `SNAPSHOT#` beside the others (so a project or company erase wipes
// them), carry an expiry, are never listed, loaded or counted as live lessons, and are read only by a replay copy's dispatch and delivery. Lessons keep their provenance (audience, source places and tasks), so
// every access and visibility check the loader makes still applies to them, and they keep their citations (the worker checks the cited code at the copy's base commit).
export const EVAL_SNAPSHOT_MAX_LESSONS = 80;
export const EVAL_SNAPSHOT_MAX_BYTES = 300_000;
const EVAL_SNAPSHOT_KEEP_DAYS = 14;

export interface EvalSnapshot {
  snapshotId: string; workspaceId: string; project: string; pipeline: string; day: string; createdAt: string; createdBy: string; contentDigest: string;
  lessons: Lesson[];
}
export interface EvalSnapshotStore {
  put(snapshot: EvalSnapshot): Promise<"created" | "exists">;
  get(key: ScopeKey, snapshotId: string): Promise<EvalSnapshot | undefined>;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
export const evalContentDigest = (lessons: readonly Lesson[]): string => createHash("sha256").update(canonical([...lessons].sort((a, b) => (a.id < b.id ? -1 : 1)))).digest("hex");
/** The id of an eval snapshot, made from the project and the lessons' whole content: an id cannot name other lessons. */
export const evalSnapshotIdOf = (key: ScopeKey, lessons: readonly Lesson[]): string => `snp_${createHash("sha256").update(JSON.stringify(["eval", key.workspaceId, key.project, evalContentDigest(lessons)])).digest("hex").slice(0, 20)}`;

/** Builds an eval snapshot from lessons, or throws: at most 80 lessons and 300 KB, each of this project, active, once. */
export function buildEvalSnapshot(input: { key: ScopeKey; pipeline: string; day: string; lessons: readonly Lesson[]; createdBy: string; at: string }): EvalSnapshot {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/u.test(input.pipeline) || !/^\d{4}-\d{2}-\d{2}$/u.test(input.day)) throw new RangeError("An eval snapshot names its pipeline label and its day.");
  if (input.lessons.length > EVAL_SNAPSHOT_MAX_LESSONS) throw new RangeError(`An eval snapshot holds at most ${String(EVAL_SNAPSHOT_MAX_LESSONS)} lessons.`);
  if (new Set(input.lessons.map((l) => l.id)).size !== input.lessons.length) throw new RangeError("An eval snapshot holds a lesson once.");
  for (const lesson of input.lessons) {
    if (lesson.workspaceId !== input.key.workspaceId || lesson.project !== input.key.project) throw new RangeError("An eval snapshot holds this project's lessons only.");
    if (lesson.status !== "active") throw new RangeError("An eval snapshot holds active lessons only.");
  }
  if (Buffer.byteLength(JSON.stringify(input.lessons), "utf8") > EVAL_SNAPSHOT_MAX_BYTES) throw new RangeError("That eval snapshot is too large.");
  return { snapshotId: evalSnapshotIdOf(input.key, input.lessons), workspaceId: input.key.workspaceId, project: input.key.project, pipeline: input.pipeline, day: input.day, createdAt: input.at, createdBy: input.createdBy, contentDigest: evalContentDigest(input.lessons), lessons: [...input.lessons] };
}

export class InMemoryEvalSnapshotStore implements EvalSnapshotStore {
  private readonly items = new Map<string, EvalSnapshot>();
  async put(snapshot: EvalSnapshot): Promise<"created" | "exists"> {
    const k = `${snapshot.workspaceId}\u0000${snapshot.project}\u0000${snapshot.snapshotId}`;
    const known = this.items.get(k);
    if (known !== undefined) { if (known.contentDigest !== snapshot.contentDigest) throw new Error("snapshot id reused"); return "exists"; }
    this.items.set(k, JSON.parse(JSON.stringify(snapshot)) as EvalSnapshot);
    return "created";
  }
  async get(key: ScopeKey, snapshotId: string): Promise<EvalSnapshot | undefined> {
    const found = this.items.get(`${key.workspaceId}\u0000${key.project}\u0000${snapshotId}`);
    return found === undefined ? undefined : JSON.parse(JSON.stringify(found)) as EvalSnapshot;
  }
}

export function dynamoEvalSnapshotStore(table: TeamRecordTable, orgOf: (workspaceId: string) => OrgId = (id) => id as OrgId, now: () => number = Date.now): EvalSnapshotStore {
  const keyOf = (workspaceId: string, project: string, id: string) => memorySnapshotKey(orgOf(workspaceId), project, id);
  return {
    async put(snapshot) {
      const k = keyOf(snapshot.workspaceId, snapshot.project, snapshot.snapshotId);
      try {
        await table.documentClient.send(new PutCommand({ TableName: table.tableName, ConditionExpression: "attribute_not_exists(pk)",
          Item: { ...k, entityType: "EVAL_SNAPSHOT", ...snapshot, expiresAt: Math.floor(now() / 1000) + EVAL_SNAPSHOT_KEEP_DAYS * 86_400 } }));
        return "created";
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== "ConditionalCheckFailedException") throw error;
        const known = await this.get({ workspaceId: snapshot.workspaceId, project: snapshot.project }, snapshot.snapshotId);
        if (known === undefined || known.contentDigest !== snapshot.contentDigest) throw new Error("snapshot id reused", { cause: error });
        return "exists";
      }
    },
    async get(key, snapshotId) {
      const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: keyOf(key.workspaceId, key.project, snapshotId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
      if (item === undefined || item["entityType"] !== "EVAL_SNAPSHOT" || item["workspaceId"] !== key.workspaceId || item["project"] !== key.project || item["snapshotId"] !== snapshotId || !Array.isArray(item["lessons"])) return undefined;
      const lessons = (item["lessons"] as unknown[]).map((raw) => LessonSchema.safeParse(raw));
      if (lessons.some((l) => !l.success)) return undefined;
      return { snapshotId, workspaceId: key.workspaceId, project: key.project, pipeline: String(item["pipeline"]), day: String(item["day"]), createdAt: String(item["createdAt"]), createdBy: String(item["createdBy"]), contentDigest: String(item["contentDigest"]),
        lessons: lessons.map((l) => (l as { data: Lesson }).data) };
    },
  };
}

/**
 * What a replay copy is given for a snapshot id: an eval snapshot's own lessons (texts imported), else the live store's lessons at the versions a reference snapshot names. Undefined when neither exists in this project.
 * `incomplete` is true when a referenced lesson is gone (privacy wins over reproducibility).
 */
export async function resolveAnySnapshot(deps: { snapshots?: SnapshotStore | undefined; evalSnapshots?: EvalSnapshotStore | undefined; store: Pick<LessonStore, "versions"> }, key: ScopeKey, snapshotId: string): Promise<{ lessons: Lesson[]; incomplete: boolean } | undefined> {
  const imported = await deps.evalSnapshots?.get(key, snapshotId);
  if (imported !== undefined) return { lessons: imported.lessons, incomplete: false };
  const referenced = await deps.snapshots?.get(key, snapshotId);
  return referenced === undefined ? undefined : resolveSnapshotLessons(deps.store, key, referenced);
}
