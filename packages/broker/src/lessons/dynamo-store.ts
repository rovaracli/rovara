// Learning v2 wiring (LR-W2): the DynamoDB `LessonStore`. It gives the guarantees `InMemoryLessonStore` defines (store.ts), on the `TeamRecord` table's existing key patterns: no new
// table and no new index. Every item lives in the project's partition (`teamRecordPk`), under a sort key the project erase already wipes (`LESSON#...` and `LESSONSET...`).
//
// Items (sort key):
//   LESSON#<id>                    the head: the lesson as last written, plus `latest` (the highest version ever written) and `rev` (bumped by every in-place change)
//   LESSON#<id>#V#<version>        every version, kept for rollback
//   LESSON#<id>#GONE               the withdrawn / purged mark (a rollback skips a purged lesson, a commit refuses it)
//   LESSON#<id>#REF#<hash>         a load manifest that names the lesson (so a purge finds the manifests without scanning)
//   LESSON#<id>#ONCE#<hash>        an idempotency key whose name holds the lesson id (a purge removes them)
//   LESSON#<id>#PEND#<hash>        a pending outcome of the lesson
//   LESSONSET                      the current set: its version and which version of each lesson is in it
//   LESSONSET#SNAP#<version>       what each set version held (rollback restores one)
//   LESSONSET#FENCE#P|I|S#<hash>   one fence item per erased person, deleted record id or erased source id (hashes only); LESSONSET#FENCEVER counts the fence writes
//   LESSONSET#INTENT#O|F#<hash>    a deletion intent, open or finished (the open ones are the sparse "open intent" list)
//   LESSONSET#ONCE#<hash>, #PENDK#<hash> (pointer), #PEND#<due>#<hash> (sorted by due time), #FLAGS, #SRC#<hash>#<time>#<n> (one item per candidate event, with the table's TTL)
//   LOAD#<task>#<stage>#<round>    load manifests (the record core's builder)
//
// How the guarantees are kept:
//   - A commit is ONE transaction: it applies only if the set item still holds the version the caller read, every lesson's version is exactly the previous version plus one (the version item
//     must not exist yet, the head's `latest` and `rev` must be as read) and the fence has not moved since the commit read it (a ConditionCheck on the fence counter). It then writes the
//     version items, the heads, the set and a snapshot together; otherwise nothing changes and the caller re-reads.
//   - The fence is written BEFORE anything is removed: one item per entry, then the counter is bumped (in the same transaction as the last entries). A commit or rollback that read the fence
//     before a later erase carries the old counter, and its transaction fails.
//   - A rollback applies `store-rules.planRollback`, the same rules as the in-memory store (skip purged, keep withdrawn / retired / rejected, tier floor, always pending, fence, refuse an
//     open intent). A rollback that restores more heads than one transaction holds writes the extra heads first, each conditional and each pending and fenced; the set is then flipped by
//     the final transaction, which is the same size as any other rollback. A rewrite before the flip only makes a lesson pending, and a retry rewrites the same content.
//   - Bounded: a set holds at most MAX_SET_MEMBERS lessons and a commit at most MAX_COMMIT_WRITES lessons; beyond that the call throws (fail closed), it never writes part of a commit.
import { createHash, randomUUID } from "node:crypto";
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, INDEX_EXPIRY_ATTRIBUTE, agentXError, lessonKey, lessonSetKey, lessonVersionKey, loadManifestKey, type OrgId } from "@agentx/contracts";
import { NOT_EXISTS, errorName, failedIndexes, isTransactionConflict, type Item, type TransactItem } from "../agents/table-writes.js";
import type { TeamRecordTable } from "../team-record/types.js";
import type { CommitResult, DeletionIntent, LessonStore, LoadManifest, PendingOutcome, ProjectFlags, ScopeKey, SetSnapshot } from "./store.js";
import { applyWriteFence, planRollback, withUsageOf, type FenceView } from "./store-rules.js";
import { LessonSchema, normId, normSource, peopleOf, recordIdsOf, type Lesson, type LessonStatus, type VOLATILE_FIELDS } from "./types.js";

export const MAX_SET_MEMBERS = 2_000;
export const MAX_COMMIT_WRITES = 30;
/** snapshots() reads only the newest this many (a rollback reads its target directly). */
export const MAX_SNAPSHOTS_READ = 500;
const MAX_QUERY_ITEMS = 20_000;
const TX_LIMIT = 100;
/** L5: after this many busy refusals on one unfinished change, it is recorded as an alert and the refusal says an administrator is needed. */
export const LESSON_STUCK_AFTER_TRIES = 5;
const RETRIES = 5;
const DAY = 86_400_000;
const SOURCE_EVENT_TTL_DAYS = 60;

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const pad = (n: number, width = 12): string => String(Math.max(0, Math.trunc(n))).padStart(width, "0");
const clone = <T>(value: T): T => structuredClone(value);
/** A JSON copy: DynamoDB's document client refuses `undefined`. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const INTERNAL = ["pk", "sk", "entityType", "latest", "rev"] as const;
const dropInternal = (item: Item): Item => Object.fromEntries(Object.entries(item).filter(([name]) => !(INTERNAL as readonly string[]).includes(name)));
const unavailable = (message: string) => agentXError("RUNTIME_UNAVAILABLE", message);
const chunks = <T>(list: readonly T[], size: number): T[][] => { const out: T[][] = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; };

interface Head { lesson: Lesson; latest: number; rev: number }
interface Names { [alias: string]: string }

export class DynamoLessonStore implements LessonStore {
  /** `orgOf` maps a scope's workspace id to the org id that keys the partition; the default is the id itself (the workspace IS the org). Tests with made-up workspace ids pass a mapper. */
  constructor(private readonly table: TeamRecordTable, private readonly now: () => number = Date.now, private readonly orgOf: (workspaceId: string) => OrgId = (id) => id, private readonly log: (event: string, fields: Record<string, string | number>) => void = (event, fields) => console.log(JSON.stringify({ component: "lessons", event, ...fields }))) {}

  // ---- keys
  private pk(key: ScopeKey): string { return lessonSetKey(this.orgOf(key.workspaceId), key.project).pk; }
  private k(key: ScopeKey, sk: string): { pk: string; sk: string } { return { pk: this.pk(key), sk }; }
  private setKey(key: ScopeKey) { return lessonSetKey(this.orgOf(key.workspaceId), key.project); }
  private headKey(key: ScopeKey, id: string) { return lessonKey(this.orgOf(key.workspaceId), key.project, id); }
  private versionKey(key: ScopeKey, id: string, version: number) { return lessonVersionKey(this.orgOf(key.workspaceId), key.project, id, version); }
  private sub(key: ScopeKey, id: string, suffix: string) { return this.k(key, `${this.headKey(key, id).sk}#${suffix}`); }
  private snapKey(key: ScopeKey, version: number) { return this.k(key, `LESSONSET#SNAP#${pad(version)}`); }
  private fenceKey(key: ScopeKey, kind: "P" | "I" | "S", value: string) { return this.k(key, `LESSONSET#FENCE#${kind}#${sha(value)}`); }
  private fenceVerKey(key: ScopeKey) { return this.k(key, "LESSONSET#FENCEVER"); }
  private intentKey(key: ScopeKey, id: string, open: boolean) { return this.k(key, `LESSONSET#INTENT#${open ? "O" : "F"}#${sha(id)}`); }

  // ---- low-level reads and writes
  private send<T = unknown>(command: unknown): Promise<T> { return this.table.documentClient.send(command) as Promise<T>; }

  private async getItem(key: { pk: string; sk: string }): Promise<Item | undefined> {
    const response = await this.send<{ Item?: Item }>(new GetCommand({ TableName: this.table.tableName, Key: key, ConsistentRead: true }));
    return response.Item;
  }

  /** Consistent reads of many items, 100 at a time; an unprocessed key is retried and, if it stays unprocessed, the call throws (never a silent gap). */
  private async batchGet(keys: ReadonlyArray<{ pk: string; sk: string }>): Promise<Map<string, Item>> {
    const found = new Map<string, Item>();
    const unique = [...new Map(keys.map((k) => [`${k.pk}\u0001${k.sk}`, k])).values()];
    for (const group of chunks(unique, TX_LIMIT)) {
      let pending: Array<{ pk: string; sk: string }> = group;
      for (let attempt = 0; pending.length > 0; attempt += 1) {
        if (attempt > RETRIES) throw unavailable("a batch read of lessons did not finish");
        const response = await this.send<{ Responses?: Record<string, Item[]>; UnprocessedKeys?: Record<string, { Keys: Array<{ pk: string; sk: string }> }> }>(
          new BatchGetCommand({ RequestItems: { [this.table.tableName]: { Keys: pending, ConsistentRead: true } } }),
        );
        for (const item of response.Responses?.[this.table.tableName] ?? []) found.set(`${String(item.pk)}\u0001${String(item.sk)}`, item);
        pending = response.UnprocessedKeys?.[this.table.tableName]?.Keys ?? [];
      }
    }
    return found;
  }
  private pick(found: Map<string, Item>, key: { pk: string; sk: string }): Item | undefined { return found.get(`${key.pk}\u0001${key.sk}`); }

  private async queryPrefix(key: ScopeKey, prefix: string, filter?: { entityType: string }): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    for (;;) {
      const response = await this.send<{ Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> }>(new QueryCommand({
        TableName: this.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true,
        ExpressionAttributeValues: { ":pk": this.pk(key), ":p": prefix, ...(filter === undefined ? {} : { ":t": filter.entityType }) },
        ...(filter === undefined ? {} : { FilterExpression: "entityType = :t" }),
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }));
      items.push(...(response.Items ?? []));
      if (items.length > MAX_QUERY_ITEMS) throw unavailable("too many items to read at once");
      start = response.LastEvaluatedKey;
      if (start === undefined) return items;
    }
  }

  private async queryRange(key: ScopeKey, low: string, high: string, limit?: number): Promise<Item[]> {
    const items: Item[] = [];
    let start: Record<string, unknown> | undefined;
    for (;;) {
      const response = await this.send<{ Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> }>(new QueryCommand({
        TableName: this.table.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high", ConsistentRead: true,
        ExpressionAttributeValues: { ":pk": this.pk(key), ":low": low, ":high": high },
        ...(limit === undefined ? {} : { Limit: limit - items.length }), ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      }));
      items.push(...(response.Items ?? []));
      if (items.length > MAX_QUERY_ITEMS) throw unavailable("too many items to read at once");
      start = response.LastEvaluatedKey;
      if (start === undefined || (limit !== undefined && items.length >= limit)) return items;
    }
  }

  private async put(item: Item, condition?: string): Promise<boolean> {
    try {
      await this.send(new PutCommand({ TableName: this.table.tableName, Item: plain(item), ...(condition === undefined ? {} : { ConditionExpression: condition }) }));
      return true;
    } catch (error) {
      if (condition !== undefined && errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
  private async del(key: { pk: string; sk: string }): Promise<void> { await this.send(new DeleteCommand({ TableName: this.table.tableName, Key: key })); }

  private async transact(items: TransactItem[]): Promise<"ok" | "cancelled"> {
    if (items.length > TX_LIMIT) throw unavailable("a lesson write is too large for one transaction");
    try {
      await this.send(new TransactWriteCommand({ TransactItems: items }));
      return "ok";
    } catch (error) {
      if (failedIndexes(error) !== undefined || isTransactionConflict(error)) return "cancelled";
      throw error;
    }
  }
  private put_(item: Item, condition?: { expression: string; names?: Names; values?: Item }): TransactItem {
    return { Put: { TableName: this.table.tableName, Item: plain(item), ...(condition === undefined ? {} : { ConditionExpression: condition.expression, ...(condition.names === undefined ? {} : { ExpressionAttributeNames: condition.names }), ...(condition.values === undefined ? {} : { ExpressionAttributeValues: condition.values }) }) } };
  }
  private delete_(key: { pk: string; sk: string }): TransactItem { return { Delete: { TableName: this.table.tableName, Key: key } }; }

  // ---- parsing
  private headOf(item: Item | undefined): Head | undefined {
    if (item?.entityType !== "LESSON") return undefined;
    const parsed = LessonSchema.safeParse(dropInternal(item));
    if (!parsed.success) return undefined;
    const latest = typeof item.latest === "number" ? item.latest : parsed.data.version;
    return { lesson: parsed.data, latest, rev: typeof item.rev === "number" ? item.rev : 0 };
  }
  private versionOf(item: Item | undefined): Lesson | undefined {
    if (item?.entityType !== "LESSON_VERSION") return undefined;
    const parsed = LessonSchema.safeParse(dropInternal(item));
    return parsed.success ? parsed.data : undefined;
  }
  private headItem(key: ScopeKey, lesson: Lesson, latest: number, rev: number): Item { return { ...this.headKey(key, lesson.id), entityType: "LESSON", ...plain(lesson), latest, rev }; }
  private versionItem(key: ScopeKey, lesson: Lesson): Item { return { ...this.versionKey(key, lesson.id, lesson.version), entityType: "LESSON_VERSION", ...plain(lesson) }; }

  private async readSet(key: ScopeKey): Promise<{ setVersion: number; rev: number; members: Record<string, number> }> {
    const item = await this.getItem(this.setKey(key));
    return item === undefined ? { setVersion: 0, rev: 0, members: {} } : { setVersion: Number(item.setVersion ?? 0), rev: Number(item.rev ?? 0), members: (item.members ?? {}) as Record<string, number> };
  }
  /** `rev` counts changes to the set that do not move its version (a purge takes a lesson out): a writer that read before one cannot write the set it read. */
  private setItem(key: ScopeKey, setVersion: number, members: Record<string, number>, at: number, rev: number): Item { return { ...this.setKey(key), entityType: "LESSON_SET", setVersion, rev, members, updatedAt: at }; }
  private snapItem(key: ScopeKey, setVersion: number, members: Record<string, number>, at: number): Item {
    return { ...this.snapKey(key, setVersion), entityType: "LESSON_SNAPSHOT", setVersion, at, members: Object.entries(members).map(([id, version]) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)) };
  }
  private setCondition(expected: number, rev: number): { expression: string; names?: Names; values?: Item } {
    // No set item yet is version 0, rev 0. Every set item this store writes carries its rev.
    return expected === 0 && rev === 0 ? { expression: "attribute_not_exists(pk)" } : { expression: "#sv = :sv AND #r = :rv", names: { "#sv": "setVersion", "#r": "rev" }, values: { ":sv": expected, ":rv": rev } };
  }
  private headCondition(head: Head | undefined): { expression: string; names?: Names; values?: Item } {
    return head === undefined ? { expression: NOT_EXISTS } : { expression: "#l = :l AND #r = :r", names: { "#l": "latest", "#r": "rev" }, values: { ":l": head.latest, ":r": head.rev } };
  }
  private fenceCheck(key: ScopeKey, version: number): TransactItem {
    const names = { "#v": "ver" };
    return { ConditionCheck: { TableName: this.table.tableName, Key: this.fenceVerKey(key), ...(version === 0 ? { ConditionExpression: NOT_EXISTS } : { ConditionExpression: "#v = :v", ExpressionAttributeNames: names, ExpressionAttributeValues: { ":v": version } }) } };
  }
  private goneAbsent(key: ScopeKey, id: string): TransactItem {
    // A withdrawn lesson may still be written (narrowed); a purged one never.
    return { ConditionCheck: { TableName: this.table.tableName, Key: this.sub(key, id, "GONE"), ConditionExpression: "attribute_not_exists(pk) OR #m <> :purged", ExpressionAttributeNames: { "#m": "mode" }, ExpressionAttributeValues: { ":purged": "purged" } } };
  }
  private async fenceVersion(key: ScopeKey): Promise<number> {
    const item = await this.getItem(this.fenceVerKey(key));
    return item === undefined ? 0 : Number(item.ver ?? 0);
  }

  /** Reads which of the fence items a set of lessons could hit, and answers the fence questions about exactly those. */
  private async fenceViewFor(key: ScopeKey, lessons: readonly Lesson[]): Promise<FenceView> {
    const keys: Array<{ pk: string; sk: string }> = [];
    for (const lesson of lessons) {
      for (const person of peopleOf(lesson)) keys.push(this.fenceKey(key, "P", normId(person)));
      for (const id of recordIdsOf(lesson)) keys.push(this.fenceKey(key, "I", id));
      const audience = lesson.provenance.audience;
      if (audience.kind === "restricted") for (const id of audience.acl.principals ?? []) keys.push(this.fenceKey(key, "S", id));
    }
    const found = await this.batchGet(keys);
    const has = (kind: "P" | "I" | "S", value: string): boolean => this.pick(found, this.fenceKey(key, kind, value)) !== undefined;
    return { personErased: (p) => has("P", normId(p)), idDeleted: (id) => has("I", id), sourceErased: (id) => has("S", id) };
  }

  // ---- reads
  async get(key: ScopeKey, id: string): Promise<Lesson | undefined> {
    const found = await this.batchGet([this.setKey(key), this.headKey(key, id)]);
    const set = this.pick(found, this.setKey(key));
    const members = (set?.members ?? {}) as Record<string, number>;
    if (members[id] === undefined) return undefined;
    return this.headOf(this.pick(found, this.headKey(key, id)))?.lesson;
  }

  async list(key: ScopeKey, filter?: { statuses?: readonly LessonStatus[] }): Promise<Lesson[]> {
    const { members } = await this.readSet(key);
    const ids = Object.keys(members).sort();
    const found = await this.batchGet(ids.map((id) => this.headKey(key, id)));
    const out: Lesson[] = [];
    for (const id of ids) {
      const head = this.headOf(this.pick(found, this.headKey(key, id)));
      if (head !== undefined && (filter?.statuses === undefined || filter.statuses.includes(head.lesson.status))) out.push(head.lesson);
    }
    return out;
  }

  async listPage(key: ScopeKey, filter: { statuses?: readonly LessonStatus[]; after?: string; limit: number }): Promise<{ lessons: Lesson[]; next?: string }> {
    const { members } = await this.readSet(key);
    const ids = Object.keys(members).sort().filter((id) => filter.after === undefined || id > filter.after);
    const page = ids.slice(0, Math.max(1, filter.limit));
    const found = await this.batchGet(page.map((id) => this.headKey(key, id)));
    const lessons: Lesson[] = [];
    for (const id of page) {
      const head = this.headOf(this.pick(found, this.headKey(key, id)));
      if (head !== undefined && (filter.statuses === undefined || filter.statuses.includes(head.lesson.status))) lessons.push(head.lesson);
    }
    return { lessons, ...(ids.length > page.length ? { next: page[page.length - 1]! } : {}) };
  }

  async listAllHeads(key: ScopeKey): Promise<Lesson[]> {
    const items = await this.queryPrefix(key, "LESSON#", { entityType: "LESSON" });
    return items.map((item) => {
      const head = this.headOf(item);
      // Erasure walks these: a head that does not parse must not be skipped silently.
      if (head === undefined) throw unavailable("a stored lesson does not parse");
      return head.lesson;
    }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async getHead(key: ScopeKey, id: string): Promise<Lesson | undefined> { return this.headOf(await this.getItem(this.headKey(key, id)))?.lesson; }
  async setVersion(key: ScopeKey): Promise<number> { return (await this.readSet(key)).setVersion; }

  async versions(key: ScopeKey, id: string): Promise<Lesson[]> {
    const items = await this.queryPrefix(key, `${this.headKey(key, id).sk}#V#`, { entityType: "LESSON_VERSION" });
    return items.sort((a, b) => String(a.sk).localeCompare(String(b.sk))).flatMap((item) => { const v = this.versionOf(item); return v === undefined ? [] : [v]; });
  }

  async snapshots(key: ScopeKey): Promise<SetSnapshot[]> {
    // Only the newest MAX_SNAPSHOTS_READ, newest first from the table and returned oldest first. Version 0 (the empty set) is included only when nothing older was left out.
    const response = await this.send<{ Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> }>(new QueryCommand({
      TableName: this.table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, ScanIndexForward: false, Limit: MAX_SNAPSHOTS_READ,
      ExpressionAttributeValues: { ":pk": this.pk(key), ":p": "LESSONSET#SNAP#" },
    }));
    const stored = (response.Items ?? []).reverse().map((item) => ({ setVersion: Number(item.setVersion), at: Number(item.at), members: clone(item.members as SetSnapshot["members"]) }));
    return response.LastEvaluatedKey === undefined ? [{ setVersion: 0, at: 0, members: [] }, ...stored] : stored;
  }

  // ---- commit
  async commit(key: ScopeKey, expectedSetVersion: number, writes: readonly Lesson[], at: number, conditions?: readonly unknown[]): Promise<CommitResult> {
    if (writes.length > MAX_COMMIT_WRITES) throw unavailable("a commit holds too many lessons");
    const parsed: Lesson[] = [];
    for (const raw of writes) {
      const lesson = LessonSchema.parse(raw);
      if (lesson.workspaceId !== key.workspaceId || lesson.project !== key.project) throw new Error("lesson is outside the scope it is written to");
      if (parsed.some((x) => x.id === lesson.id)) throw new Error("one commit writes a lesson once");
      parsed.push(lesson);
    }
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      await this.healBeforeWrite(key);
      const set = await this.readSet(key);
      if (set.setVersion !== expectedSetVersion) return { ok: false, reason: "conflict" };
      const fenceVer = await this.fenceVersion(key);
      const found = await this.batchGet(parsed.flatMap((l) => [this.headKey(key, l.id), this.sub(key, l.id, "GONE")]));
      const staged: Array<{ lesson: Lesson; previous: Head | undefined }> = [];
      const fence = await this.fenceViewFor(key, parsed);
      for (const lesson of parsed) {
        const previous = this.headOf(this.pick(found, this.headKey(key, lesson.id)));
        if (lesson.version !== (previous?.latest ?? 0) + 1) return { ok: false, reason: "conflict" };
        if (this.pick(found, this.sub(key, lesson.id, "GONE"))?.mode === "purged") return { ok: false, reason: "erased" };
        const fenced = applyWriteFence(lesson, fence);
        if (fenced === "erased") return { ok: false, reason: "erased" };
        staged.push({ lesson: fenced, previous });
      }
      const members = { ...set.members };
      for (const { lesson } of staged) members[lesson.id] = lesson.version;
      if (Object.keys(members).length > MAX_SET_MEMBERS) throw unavailable("the lesson set is too large");
      const setVersion = expectedSetVersion + 1;
      // The decision's own conditions (who may approve) commit with the write: a person removed since the read stops it.
      const items: TransactItem[] = [...(conditions === undefined ? [] : (conditions as TransactItem[])), this.fenceCheck(key, fenceVer), this.put_(this.setItem(key, setVersion, members, at, set.rev), this.setCondition(expectedSetVersion, set.rev)), this.put_(this.snapItem(key, setVersion, members, at), { expression: NOT_EXISTS })];
      for (const { lesson, previous } of staged) {
        // A purge writes the lesson's GONE mark before it removes anything: a commit that read before it cannot write a version or a head after it.
        items.push(this.goneAbsent(key, lesson.id));
        items.push(this.put_(this.versionItem(key, lesson), { expression: NOT_EXISTS }));
        items.push(this.put_(this.headItem(key, withUsageOf(lesson, previous?.lesson), lesson.version, (previous?.rev ?? 0) + 1), this.headCondition(previous)));
      }
      if ((await this.transact(items)) === "ok") return { ok: true, setVersion };
      // Cancelled: another writer moved the set, a head or the fence. If the set moved, this write lost; otherwise read again and decide on fresh state.
      if ((await this.readSet(key)).setVersion !== expectedSetVersion) return { ok: false, reason: "conflict" };
    }
    return { ok: false, reason: "conflict" };
  }

  // ---- rollback
  async rollback(key: ScopeKey, targetSetVersion: number, expectedSetVersion: number, at: number): Promise<CommitResult> {
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      // A staged rollback that never finished is put back before anything else is decided.
      await this.healBeforeWrite(key);
      const set = await this.readSet(key);
      if (set.setVersion !== expectedSetVersion || targetSetVersion >= expectedSetVersion || targetSetVersion < 0) return { ok: false, reason: "conflict" };
      let target: ReadonlyArray<{ id: string; version: number }> = [];
      if (targetSetVersion > 0) {
        const snap = await this.getItem(this.snapKey(key, targetSetVersion));
        if (snap === undefined) return { ok: false, reason: "conflict" };
        target = snap.members as Array<{ id: string; version: number }>;
      }
      const fenceVer = await this.fenceVersion(key);
      const ids = target.map((m) => m.id);
      const found = await this.batchGet([
        ...ids.flatMap((id) => [this.headKey(key, id), this.sub(key, id, "GONE")]),
        ...target.map((m) => this.versionKey(key, m.id, m.version)),
      ]);
      const contents = target.flatMap((m) => { const c = this.versionOf(this.pick(found, this.versionKey(key, m.id, m.version))); return c === undefined ? [] : [c]; });
      const fence = await this.fenceViewFor(key, contents);
      const openIntents = new Set((await this.queryPrefix(key, "LESSONSET#INTENT#O#")).map((i) => String(i.lessonId)));
      const heads = new Map<string, Head | undefined>(ids.map((id) => [id, this.headOf(this.pick(found, this.headKey(key, id)))]));
      const plan = planRollback(target, {
        gone: (id) => { const mode = this.pick(found, this.sub(key, id, "GONE"))?.mode; return mode === "withdrawn" || mode === "purged" ? mode : undefined; },
        head: (id) => heads.get(id)?.lesson,
        content: (id, version) => this.versionOf(this.pick(found, this.versionKey(key, id, version))),
        openIntent: (id) => openIntents.has(id), fence,
      }, at);
      if (!plan.ok) return { ok: false, reason: "conflict" };
      const members = Object.fromEntries(plan.members);
      const setVersion = expectedSetVersion + 1;
      const headWrites = [...plan.restoredHeads].map(([id, restored]) => {
        const current = heads.get(id);
        return this.put_(this.headItem(key, restored, current?.latest ?? restored.version, (current?.rev ?? 0) + 1), this.headCondition(current));
      });
      // The heads that do not fit the final transaction go first, each in a transaction that carries the fence check and the check that the rollback's open intent is still open. A rewrite
      // before the set flips only makes a lesson pending, and the intent says which lessons were rewritten: whoever finds it open and unfinished (the next commit, rollback or `heal`) puts
      // them back, so the store never stays half rolled back.
      const finalHeads = headWrites.slice(-(TX_LIMIT - 4));
      const early = headWrites.slice(0, headWrites.length - finalHeads.length);
      const staged = early.length > 0;
      const nonce = randomUUID();
      if (staged) {
        const earlyIds = [...plan.restoredHeads.keys()].slice(0, early.length);
        const opened = await this.put({ ...this.intentRbKey(key), entityType: "LESSON_ROLLBACK_INTENT", nonce, state: "open", ids: earlyIds, at }, NOT_EXISTS);
        if (!opened) continue;
      }
      let cancelled = false;
      for (const group of chunks(early, TX_LIMIT - 2)) {
        if ((await this.transact([this.fenceCheck(key, fenceVer), this.rbIntentOpen(key, nonce), ...group])) !== "ok") { cancelled = true; break; }
      }
      if (cancelled) continue;
      const final: TransactItem[] = [
        this.fenceCheck(key, fenceVer), this.put_(this.setItem(key, setVersion, members, at, set.rev), this.setCondition(expectedSetVersion, set.rev)), this.put_(this.snapItem(key, setVersion, members, at), { expression: NOT_EXISTS }),
        ...(staged ? [{ Delete: { TableName: this.table.tableName, Key: this.intentRbKey(key), ConditionExpression: "#n = :n AND #s = :open", ExpressionAttributeNames: { "#n": "nonce", "#s": "state" }, ExpressionAttributeValues: { ":n": nonce, ":open": "open" } } } as TransactItem] : []),
        ...finalHeads,
      ];
      if ((await this.transact(final)) === "ok") return { ok: true, setVersion, restored: plan.restored };
      if ((await this.readSet(key)).setVersion !== expectedSetVersion) { await this.heal(key); return { ok: false, reason: "conflict" }; }
    }
    await this.heal(key);
    return { ok: false, reason: "conflict" };
  }

  private intentRbKey(key: ScopeKey) { return this.k(key, "LESSONSET#RBINTENT"); }
  private rbIntentOpen(key: ScopeKey, nonce: string): TransactItem {
    return { ConditionCheck: { TableName: this.table.tableName, Key: this.intentRbKey(key), ConditionExpression: "#n = :n AND #s = :open", ExpressionAttributeNames: { "#n": "nonce", "#s": "state" }, ExpressionAttributeValues: { ":n": nonce, ":open": "open" } } };
  }

  /**
   * WB-7: a write that meets an unfinished earlier change (a stuck intent) resumes it first (`heal`), and once more if that did not finish. Still stuck is a fixed LESSON_BUSY refusal ("try again"), never the
   * RUNTIME_UNAVAILABLE `heal` throws, which a route would show as the service being down. A fault of the table itself (anything but the intent's own refusal) is not hidden by this.
   */
  private async healBeforeWrite(key: ScopeKey): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.heal(key); }
      catch (error) {
        if (!(error instanceof AgentXError) || error.code !== "RUNTIME_UNAVAILABLE") throw error;
        if (attempt >= 1) {
          // L5: still stuck. The refusal is counted on the intent; from the fifth on it is recorded as an alert and no longer reads as "try again" (a permanent fault must not look like a passing one).
          const tries = await this.noteBusy(key);
          throw agentXError("LESSON_BUSY", tries !== undefined && tries >= LESSON_STUCK_AFTER_TRIES
            ? "These lessons could not be repaired automatically after several tries. An administrator needs to look at them."
            : "These lessons are being tidied up from an earlier change. Try again in a moment.");
        }
      }
    }
  }

  /**
   * L5: counts a busy refusal on the stuck intent (best effort: a fault of this write never changes the refusal), logs one fixed line (the scope as a hash, the intent's age and the number of tries; no ids, no text),
   * and on the fifth records the alert on the intent itself (`stuckAt`, once) with its own line. Returns the number of tries, or undefined when it could not be counted.
   */
  private async noteBusy(key: ScopeKey): Promise<number | undefined> {
    try {
      const nowMs = this.now();
      const updated = await this.send<{ Attributes?: Item }>(new UpdateCommand({
        TableName: this.table.tableName, Key: this.intentRbKey(key), UpdateExpression: "SET lastBusyAt = :now ADD busyCount :one", ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":now": nowMs, ":one": 1 }, ReturnValues: "ALL_NEW",
      }));
      const row = updated.Attributes;
      const tries = Number(row?.["busyCount"]);
      if (!Number.isFinite(tries)) return undefined;
      const at = Number(row?.["at"]);
      const scope = createHash("sha256").update(`${key.workspaceId}\u0000${key.project}`).digest("hex").slice(0, 12);
      this.log("lessons.intent_stuck", { scope, tries, ageMs: Number.isFinite(at) ? Math.max(0, nowMs - at) : -1 });
      if (tries >= LESSON_STUCK_AFTER_TRIES && row?.["stuckAt"] === undefined) {
        await this.send(new UpdateCommand({
          TableName: this.table.tableName, Key: this.intentRbKey(key), UpdateExpression: "SET stuckAt = :now", ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(stuckAt)", ExpressionAttributeValues: { ":now": nowMs },
        })).then(() => this.log("lessons.intent_stuck_alert", { scope, tries }), (error: unknown) => { if (errorName(error) !== "ConditionalCheckFailedException") throw error; });
      }
      return tries;
    } catch {
      return undefined;
    }
  }

  /**
   * Finishes what an unfinished staged rollback left: the lessons it had rewritten (the intent names them) go back to the version the current set holds for them, with the usage
   * bookkeeping they have now. The intent is first marked "healing" (so a rollback still running can no longer pass its checks), then the lessons are put back (each repeatable),
   * then the intent is deleted. A crash in between is finished by the next call. Called at the start of every commit and rollback; safe to call at any time.
   */
  async heal(key: ScopeKey): Promise<void> {
    const intent = await this.getItem(this.intentRbKey(key));
    if (intent === undefined) return;
    if (intent.state === "open") {
      try {
        await this.send(new UpdateCommand({
          TableName: this.table.tableName, Key: this.intentRbKey(key), UpdateExpression: "SET #s = :healing", ConditionExpression: "#n = :n AND #s = :open",
          ExpressionAttributeNames: { "#s": "state", "#n": "nonce" }, ExpressionAttributeValues: { ":healing": "healing", ":open": "open", ":n": intent.nonce },
        }));
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
        // Finished or claimed by someone else meanwhile: look again.
        return this.heal(key);
      }
    }
    for (const id of (intent.ids ?? []) as string[]) {
      let done = false;
      for (let attempt = 0; attempt < RETRIES && !done; attempt += 1) {
        const set = await this.readSet(key);
        const wanted = set.members[id];
        const head = this.headOf(await this.getItem(this.headKey(key, id)));
        // Out of the set, gone, or already as the set has it: nothing to put back.
        if (wanted === undefined || head === undefined || head.lesson.version === wanted) { done = true; break; }
        const content = this.versionOf(await this.getItem(this.versionKey(key, id, wanted)));
        // The version the set holds for it must be there: without it the lesson cannot be put back, and the intent stays so the next call tries again (and an operator sees it).
        if (content === undefined) throw unavailable("a lesson of an unfinished rollback cannot be put back: its version is missing");
        const restored: Lesson = { ...withUsageOf(content, head.lesson), expiresAt: head.lesson.expiresAt };
        if (head.lesson.retireProposedAt === undefined) delete restored.retireProposedAt; else restored.retireProposedAt = head.lesson.retireProposedAt;
        done = await this.putHeadIf(key, LessonSchema.parse(restored), head);
      }
      if (!done) throw unavailable("a lesson of an unfinished rollback kept changing; the intent stays");
    }
    await this.del(this.intentRbKey(key));
  }

  // ---- in-place changes
  async mutate(key: ScopeKey, id: string, fn: (lesson: Lesson) => Partial<Pick<Lesson, (typeof VOLATILE_FIELDS)[number]>> | undefined): Promise<Lesson | undefined> {
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      const found = await this.batchGet([this.setKey(key), this.headKey(key, id)]);
      const members = (this.pick(found, this.setKey(key))?.members ?? {}) as Record<string, number>;
      const head = members[id] === undefined ? undefined : this.headOf(this.pick(found, this.headKey(key, id)));
      if (head === undefined) return undefined;
      const patch = fn(clone(head.lesson));
      if (patch === undefined) return head.lesson;
      const next = LessonSchema.parse({ ...head.lesson, ...clone(patch) });
      if (await this.putHeadIf(key, next, head)) return next;
    }
    throw unavailable("a lesson changed too often to update");
  }

  private async putHeadIf(key: ScopeKey, lesson: Lesson, head: Head): Promise<boolean> {
    try {
      await this.send(new PutCommand({
        TableName: this.table.tableName, Item: plain(this.headItem(key, lesson, head.latest, head.rev + 1)),
        ConditionExpression: "#l = :l AND #r = :r", ExpressionAttributeNames: { "#l": "latest", "#r": "rev" }, ExpressionAttributeValues: { ":l": head.latest, ":r": head.rev },
      }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async scrub(key: ScopeKey, id: string, fn: (lesson: Lesson) => Lesson): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (attempt >= RETRIES) throw unavailable("a lesson changed too often to scrub");
      const head = this.headOf(await this.getItem(this.headKey(key, id)));
      if (head === undefined) break;
      if (await this.putHeadIf(key, LessonSchema.parse(fn(clone(head.lesson))), head)) break;
    }
    for (const item of await this.queryPrefix(key, `${this.headKey(key, id).sk}#V#`, { entityType: "LESSON_VERSION" })) {
      const version = this.versionOf(item);
      if (version === undefined) continue;
      await this.put(this.versionItem(key, LessonSchema.parse({ ...fn(clone(version)), version: version.version })));
    }
  }

  async markGone(key: ScopeKey, id: string, mode: "withdrawn" | "purged"): Promise<void> {
    await this.put({ ...this.sub(key, id, "GONE"), entityType: "LESSON_GONE", mode });
  }

  async purge(key: ScopeKey, id: string): Promise<void> {
    // The mark first: from here a rollback skips the lesson and a commit refuses it, whatever happens next. Every step after it can be repeated.
    await this.markGone(key, id, "purged");
    // The set loses it and its rev moves, whether or not it was in the set: a writer that read the set before this cannot write the set it read (its condition is on the rev).
    for (let attempt = 0; ; attempt += 1) {
      if (attempt >= RETRIES) throw unavailable("the lesson set changed too often to purge from");
      const set = await this.readSet(key);
      // No set item yet: nothing to take it out of.
      if (set.setVersion === 0 && set.rev === 0 && (await this.getItem(this.setKey(key))) === undefined) break;
      const { [id]: _removed, ...members } = set.members;
      void _removed;
      const outcome = await this.transact([this.put_(this.setItem(key, set.setVersion, members, Number(this.now()), set.rev + 1), this.setCondition(set.setVersion, set.rev))]);
      if (outcome === "ok") break;
    }
    // Manifests that name the lesson lose the entry.
    for (const ref of await this.queryPrefix(key, `${this.headKey(key, id).sk}#REF#`)) {
      const manifestKey = this.k(key, String(ref.manifestSk));
      const manifest = await this.getItem(manifestKey);
      if (manifest !== undefined && Array.isArray(manifest.lessons)) {
        await this.put({ ...manifest, lessons: (manifest.lessons as Array<{ id: string }>).filter((e) => e.id !== id) }, "attribute_exists(pk)");
      }
      await this.del({ pk: String(ref.pk), sk: String(ref.sk) });
    }
    // Pending outcomes and idempotency keys that name it.
    for (const ref of await this.queryPrefix(key, `${this.headKey(key, id).sk}#PEND#`)) {
      await this.del(this.k(key, `LESSONSET#PENDK#${String(ref.hash)}`));
      await this.del(this.k(key, `LESSONSET#PEND#${pad(Number(ref.dueAt), 15)}#${String(ref.hash)}`));
      await this.del({ pk: String(ref.pk), sk: String(ref.sk) });
    }
    for (const ref of await this.queryPrefix(key, `${this.headKey(key, id).sk}#ONCE#`)) {
      await this.del(this.k(key, `LESSONSET#ONCE#${String(ref.hash)}`));
      await this.del({ pk: String(ref.pk), sk: String(ref.sk) });
    }
    // Every version, then the head.
    for (const item of await this.queryPrefix(key, `${this.headKey(key, id).sk}#V#`)) await this.del({ pk: String(item.pk), sk: String(item.sk) });
    await this.del(this.headKey(key, id));
  }

  // ---- sources
  async forgetSource(key: ScopeKey, source: string): Promise<void> {
    const wanted = normSource(source);
    for (const item of await this.queryPrefix(key, `LESSONSET#SRC#${sha(wanted)}#`)) await this.del({ pk: String(item.pk), sk: String(item.sk) });
    // Every spelling of the key goes: a pause stored as `member:Mallory` is forgotten when `mallory` is erased.
    const flags = await this.flags(key);
    const paused = flags.pausedSources;
    if (paused !== undefined && Object.keys(paused).some((name) => normSource(name) === wanted)) {
      await this.setFlags(key, { ...flags, pausedSources: Object.fromEntries(Object.entries(paused).filter(([name]) => normSource(name) !== wanted)) });
    }
  }

  async recordSourceEvent(key: ScopeKey, event: { at: number; source: string }): Promise<void> {
    const source = normSource(event.source);
    await this.put({
      ...this.k(key, `LESSONSET#SRC#${sha(source)}#${pad(event.at, 15)}#${randomUUID()}`), entityType: "LESSON_SOURCE_EVENT", at: event.at,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.ceil((event.at + SOURCE_EVENT_TTL_DAYS * DAY) / 1000),
    });
  }

  async sourceDays(key: ScopeKey, source: string, days: number, now: number): Promise<number[]> {
    const counts = new Array<number>(days).fill(0);
    const prefix = `LESSONSET#SRC#${sha(normSource(source))}#`;
    // An event is counted when its age, floor((now - at) / DAY), is from 0 to days - 1: at is above now - days * DAY and not after now.
    const items = await this.queryRange(key, `${prefix}${pad(now - days * DAY + 1, 15)}`, `${prefix}${pad(now, 15)}#￿`);
    for (const item of items) {
      const age = Math.floor((now - Number(item.at)) / DAY);
      if (age >= 0 && age < days) counts[age]! += 1;
    }
    return counts;
  }

  async flags(key: ScopeKey): Promise<ProjectFlags> {
    const item = await this.getItem(this.k(key, "LESSONSET#FLAGS"));
    return item === undefined ? {} : clone((item.flags ?? {}) as ProjectFlags);
  }
  async setFlags(key: ScopeKey, flags: ProjectFlags): Promise<void> { await this.put({ ...this.k(key, "LESSONSET#FLAGS"), entityType: "LESSON_FLAGS", flags }); }

  // ---- the fence
  async fence(key: ScopeKey, fence: { people?: readonly string[]; ids?: readonly string[]; sourceIds?: readonly string[] }): Promise<void> {
    const entries: Item[] = [
      ...(fence.people ?? []).map((p) => ({ ...this.fenceKey(key, "P", normId(p)), entityType: "LESSON_FENCE", kind: "person" })),
      ...(fence.ids ?? []).map((id) => ({ ...this.fenceKey(key, "I", id), entityType: "LESSON_FENCE", kind: "id" })),
      ...(fence.sourceIds ?? []).map((id) => ({ ...this.fenceKey(key, "S", id), entityType: "LESSON_FENCE", kind: "source" })),
    ];
    const groups = chunks([...new Map(entries.map((e) => [String(e.sk), e])).values()], TX_LIMIT - 2);
    const bump: TransactItem = { Update: { TableName: this.table.tableName, Key: this.fenceVerKey(key), UpdateExpression: "ADD #v :one", ExpressionAttributeNames: { "#v": "ver" }, ExpressionAttributeValues: { ":one": 1 } } };
    // Entries first, the counter last (in the same transaction as the last entries): a commit that read the old counter fails once the counter moves.
    for (const [index, group] of (groups.length === 0 ? [[]] : groups).entries()) {
      const last = index === Math.max(groups.length, 1) - 1;
      const items: TransactItem[] = [...group.map((entry) => this.put_(entry)), ...(last ? [bump] : [])];
      if (items.length === 0) continue;
      const outcome = await this.transact(items);
      if (outcome !== "ok") throw unavailable("the fence could not be written");
    }
  }

  async isErased(key: ScopeKey, person: string): Promise<boolean> { return (await this.getItem(this.fenceKey(key, "P", normId(person)))) !== undefined; }
  private markRefKey(key: ScopeKey, person: string) { return this.k(key, `LESSONSET#MARKREF#${sha(normId(person))}`); }
  async markRef(key: ScopeKey, person: string): Promise<string | undefined> {
    if (await this.isErased(key, person)) return undefined;
    const at = this.markRefKey(key, person);
    let item = await this.getItem(at);
    if (item === undefined) {
      const ref = randomUUID().replaceAll("-", "").slice(0, 24);
      await this.put({ ...at, entityType: "LESSON_MARK_REF", ref }, NOT_EXISTS);
      item = await this.getItem(at);
      // An erasure that raced the creation: its fence is up now, so the link is removed again and no mark is made.
      if (await this.isErased(key, person)) { await this.del(at); return undefined; }
    }
    return typeof item?.ref === "string" ? item.ref : undefined;
  }
  async forgetMarkRef(key: ScopeKey, person: string): Promise<void> { await this.del(this.markRefKey(key, person)); }

  // ---- deletion intents
  async putIntent(key: ScopeKey, intent: DeletionIntent): Promise<void> {
    const item = { ...this.intentKey(key, intent.id, !intent.finished), entityType: "LESSON_INTENT", ...plain(intent) };
    const outcome = await this.transact([this.put_(item), this.delete_(this.intentKey(key, intent.id, intent.finished))]);
    if (outcome !== "ok") throw unavailable("the deletion record could not be written");
  }
  async getIntent(key: ScopeKey, id: string): Promise<DeletionIntent | undefined> {
    const found = await this.batchGet([this.intentKey(key, id, true), this.intentKey(key, id, false)]);
    const item = this.pick(found, this.intentKey(key, id, true)) ?? this.pick(found, this.intentKey(key, id, false));
    return item === undefined ? undefined : (dropInternal(item) as unknown as DeletionIntent);
  }
  async listIntents(key: ScopeKey, filter?: { finished?: boolean }): Promise<DeletionIntent[]> {
    const open = filter?.finished === true ? [] : await this.queryPrefix(key, "LESSONSET#INTENT#O#");
    const done = filter?.finished === false ? [] : await this.queryPrefix(key, "LESSONSET#INTENT#F#");
    return [...open, ...done].map((i) => dropInternal(i) as unknown as DeletionIntent).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  // ---- manifests
  private manifestKey(m: Pick<LoadManifest, "workspaceId" | "project" | "taskId" | "stage" | "round">) { return loadManifestKey(this.orgOf(m.workspaceId), m.project, m.taskId, m.stage, m.round); }
  private async writeRefs(m: LoadManifest): Promise<void> {
    const key: ScopeKey = { workspaceId: m.workspaceId, project: m.project };
    const manifestSk = this.manifestKey(m).sk;
    for (const id of new Set(m.lessons.map((e) => e.id))) {
      await this.put({ ...this.sub(key, id, `REF#${sha(manifestSk)}`), entityType: "LESSON_REF", manifestSk });
    }
  }
  async putManifest(manifest: LoadManifest): Promise<boolean> {
    // The references first: a reference without a manifest is harmless, a manifest without its references would escape a purge.
    await this.writeRefs(manifest);
    return this.put({ ...this.manifestKey(manifest), entityType: "LESSON_LOAD", ...plain(manifest) }, NOT_EXISTS);
  }
  async manifests(key: ScopeKey, taskId: string): Promise<LoadManifest[]> {
    const items = await this.queryPrefix(key, `LOAD#${taskId}#`, { entityType: "LESSON_LOAD" });
    return items.map((item) => dropInternal(item) as unknown as LoadManifest).filter((m) => m.taskId === taskId).sort((a, b) => a.at - b.at);
  }
  async updateManifest(manifest: LoadManifest): Promise<void> {
    await this.writeRefs(manifest);
    await this.put({ ...this.manifestKey(manifest), entityType: "LESSON_LOAD", ...plain(manifest) }, "attribute_exists(pk)");
  }

  // ---- once keys and pending outcomes
  async markOnce(key: ScopeKey, name: string): Promise<boolean> {
    const hash = sha(name);
    // A name that holds a lesson id is also filed under the lesson, so a purge of the lesson finds it.
    const ids = [...new Set(name.split(":").filter((part) => /^[A-Za-z0-9_-]{4,64}$/u.test(part)))].slice(0, 8);
    const items: TransactItem[] = [this.put_({ ...this.k(key, `LESSONSET#ONCE#${hash}`), entityType: "LESSON_ONCE", name, hash }, { expression: NOT_EXISTS })];
    for (const id of ids) items.push(this.put_({ ...this.sub(key, id, `ONCE#${hash}`), entityType: "LESSON_ONCE_REF", hash }));
    try {
      await this.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (failedIndexes(error)?.has(0) === true) return false;
      if (failedIndexes(error) !== undefined || isTransactionConflict(error)) throw unavailable("the once-key write was interrupted");
      throw error;
    }
  }

  async seenOnce(key: ScopeKey, name: string): Promise<boolean> { return (await this.getItem(this.k(key, `LESSONSET#ONCE#${sha(name)}`))) !== undefined; }

  async hasPending(key: ScopeKey, lessonId: string): Promise<boolean> {
    return (await this.queryPrefix(key, `${this.headKey(key, lessonId).sk}#PEND#`)).length > 0;
  }

  async addPending(entry: PendingOutcome): Promise<void> {
    const key: ScopeKey = { workspaceId: entry.workspaceId, project: entry.project };
    const hash = sha(entry.key);
    const pointerKey = this.k(key, `LESSONSET#PENDK#${hash}`);
    const old = await this.getItem(pointerKey);
    const items: TransactItem[] = [
      this.put_({ ...pointerKey, entityType: "LESSON_PENDING_POINTER", dueAt: entry.dueAt, lessonId: entry.lessonId, entry: plain(entry) }),
      this.put_({ ...this.k(key, `LESSONSET#PEND#${pad(entry.dueAt, 15)}#${hash}`), entityType: "LESSON_PENDING", entry: plain(entry) }),
      this.put_({ ...this.sub(key, entry.lessonId, `PEND#${hash}`), entityType: "LESSON_PENDING_REF", hash, dueAt: entry.dueAt }),
    ];
    // The same key queued again replaces the earlier entry: its old sorted item and lesson reference go.
    if (old !== undefined) {
      if (Number(old.dueAt) !== entry.dueAt) items.push(this.delete_(this.k(key, `LESSONSET#PEND#${pad(Number(old.dueAt), 15)}#${hash}`)));
      if (String(old.lessonId) !== entry.lessonId) items.push(this.delete_(this.sub(key, String(old.lessonId), `PEND#${hash}`)));
    }
    if ((await this.transact(items)) !== "ok") throw unavailable("the pending outcome could not be written");
  }

  async duePending(key: ScopeKey, now: number, limit: number): Promise<PendingOutcome[]> {
    const items = await this.queryRange(key, `LESSONSET#PEND#${pad(0, 15)}`, `LESSONSET#PEND#${pad(now, 15)}#￿`, Math.max(limit, 1));
    return items.map((i) => clone(i.entry as PendingOutcome)).filter((p) => p.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.key.localeCompare(b.key)).slice(0, limit);
  }

  async removePending(key: ScopeKey, pendingKey: string): Promise<void> {
    const hash = sha(pendingKey);
    const pointerKey = this.k(key, `LESSONSET#PENDK#${hash}`);
    const pointer = await this.getItem(pointerKey);
    if (pointer === undefined) return;
    await this.transact([
      this.delete_(pointerKey), this.delete_(this.k(key, `LESSONSET#PEND#${pad(Number(pointer.dueAt), 15)}#${hash}`)), this.delete_(this.sub(key, String(pointer.lessonId), `PEND#${hash}`)),
    ]);
  }
}
