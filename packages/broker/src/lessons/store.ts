// Learning v2: the lesson store (design §4.2, §4.6). `LessonStore` is the interface; `InMemoryLessonStore` is the stand-in the tests and the first wiring use.
// The DynamoDB implementation lives beside the record core's `TeamRecord` table (R2); it must give the same guarantees:
//   - a commit is one conditional write: it applies only if the project's lesson-set version is the one the caller read, and every lesson's version
//     is exactly the previous version plus one; otherwise nothing changes ("conflict") and the caller re-reads (ACE: delta updates applied by code);
//   - every lesson version is kept, and every set version records which lesson versions it held, so a rollback restores a past set;
//   - counters and expiry bookkeeping change in place (`mutate`) without a new version.
// Every key carries the workspace and the project, so one workspace's call can never read or change another's lessons.
import { CHANGE_APPROVAL_TTL_DAYS } from "@agentx/contracts";
import { scrubLesson } from "./scrub.js";
import { LessonSchema, normId, normSource, peopleOf, recordIdsOf, type Lesson, type LessonStatus, type VOLATILE_FIELDS } from "./types.js";
import type { LessonStage } from "@agentx/contracts";

export interface ScopeKey { workspaceId: string; project: string }
export type CommitResult = { ok: true; setVersion: number; /** Lessons a rollback brought back; each comes back needing a person. */ restored?: string[] } | { ok: false; reason: "conflict" | "erased" };

/**
 * A durable record of a multi-step deletion (forget, withdraw, purge). It is written BEFORE the first step and marked finished only after the last, and each
 * step is idempotent, so a retry or a sweeper resumes the ORIGINAL intent: it never switches it (for example from keep to withdraw), and nothing is orphaned.
 */
export interface DeletionIntent {
  id: string; lessonId: string; kind: "forget" | "withdraw" | "purge"; cause: string; deleted: string[]; erased?: string;
  /** Decided once, before any write: scrub only, kept on code alone (back to a person), withdrawn, or hard-deleted. */
  outcome: "scrub" | "downgrade" | "withdraw" | "purge";
  /** Whether the lesson was in the current set when the intent was made (decides commit versus in-place rewrite). */
  inSet: boolean;
  done: string[]; finished: boolean; at: number;
}

export interface LoadManifestEntry {
  id: string; version: number; score: number; why: "scope" | "similar" | "path";
  citation: "unchecked" | "valid" | "moved" | "stale_dropped" | "unchecked_dropped" | "none";
}
export interface LoadManifest {
  taskId: string; workspaceId: string; project: string; stage: LessonStage; round: number; setVersion: number;
  memory: "live" | "off"; at: number; lessons: LoadManifestEntry[]; bytes: number;
}
export interface PendingOutcome { key: string; workspaceId: string; project: string; lessonId: string; taskId: string; dueAt: number }
/** A source paused by spike detection: its lessons are collected but held until a maintainer resumes the source. */
export interface ProjectFlags { pausedSources?: Record<string, { at: number; reason: string }>; volumeAlertedAt?: number }
export interface SetSnapshot { setVersion: number; at: number; members: Array<{ id: string; version: number }> }

export interface LessonStore {
  get(key: ScopeKey, id: string): Promise<Lesson | undefined>;
  list(key: ScopeKey, filter?: { statuses?: readonly LessonStatus[] }): Promise<Lesson[]>;
  /** Every stored head, including lessons that a rollback dropped from the current set: deletion and erasure walk these, not only the set. */
  listAllHeads(key: ScopeKey): Promise<Lesson[]>;
  /** A lesson's head whether or not it is in the current set. */
  getHead(key: ScopeKey, id: string): Promise<Lesson | undefined>;
  setVersion(key: ScopeKey): Promise<number>;
  versions(key: ScopeKey, id: string): Promise<Lesson[]>;
  snapshots(key: ScopeKey): Promise<SetSnapshot[]>;
  /** Writes new versions in one conditional step. */
  commit(key: ScopeKey, expectedSetVersion: number, writes: readonly Lesson[], at: number): Promise<CommitResult>;
  /** Restores the lessons of an earlier set version as a new set version. */
  rollback(key: ScopeKey, targetSetVersion: number, expectedSetVersion: number, at: number): Promise<CommitResult>;
  /** Changes the volatile fields of a lesson in place; `fn` returns the new values (or undefined for no change). */
  mutate(key: ScopeKey, id: string, fn: (lesson: Lesson) => Partial<Pick<Lesson, (typeof VOLATILE_FIELDS)[number]>> | undefined): Promise<Lesson | undefined>;
  putManifest(manifest: LoadManifest): Promise<boolean>;
  manifests(key: ScopeKey, taskId: string): Promise<LoadManifest[]>;
  updateManifest(manifest: LoadManifest): Promise<void>;
  /** True the first time a key is seen, false after; makes counters idempotent. */
  markOnce(key: ScopeKey, name: string): Promise<boolean>;
  addPending(entry: PendingOutcome): Promise<void>;
  duePending(key: ScopeKey, now: number, limit: number): Promise<PendingOutcome[]>;
  removePending(key: ScopeKey, pendingKey: string): Promise<void>;
  flags(key: ScopeKey): Promise<ProjectFlags>;
  setFlags(key: ScopeKey, flags: ProjectFlags): Promise<void>;
  /**
   * Rewrites the head AND every stored version of a lesson in place (no new version), for deletion and erasure: old versions must not keep what was deleted.
   * `fn` returns the scrubbed lesson; a rollback can then never bring a deleted id back.
   */
  scrub(key: ScopeKey, id: string, fn: (lesson: Lesson) => Lesson): Promise<void>;
  /** Marks a lesson as gone for good: a rollback never restores a withdrawn lesson, and skips a purged one. */
  markGone(key: ScopeKey, id: string, mode: "withdrawn" | "purged"): Promise<void>;
  /** Hard delete: the head, every version and every load-manifest reference. The id is remembered as purged so a rollback cannot bring it back. */
  purge(key: ScopeKey, id: string): Promise<void>;
  /** Forgets a source's counters and its pause (erasure of a person, deletion of a channel). */
  forgetSource(key: ScopeKey, source: string): Promise<void>;
  /**
   * The fence of a deletion or an erasure, written BEFORE anything is removed: a person is erased, or record ids are deleted. A commit that carries an erased
   * person or a deleted id is refused (a writer that read before the scrub cannot put them back). The Dynamo store does this with a conditional write on the
   * project's fence item.
   */
  fence(key: ScopeKey, fence: { people?: readonly string[]; ids?: readonly string[] }): Promise<void>;
  /** Whether a person is fenced (erased). Ids are compared case-insensitively. */
  isErased(key: ScopeKey, person: string): Promise<boolean>;
  putIntent(key: ScopeKey, intent: DeletionIntent): Promise<void>;
  getIntent(key: ScopeKey, id: string): Promise<DeletionIntent | undefined>;
  listIntents(key: ScopeKey, filter?: { finished?: boolean }): Promise<DeletionIntent[]>;
  /** One candidate from a source (for the source's own baseline). */
  recordSourceEvent(key: ScopeKey, event: { at: number; source: string }): Promise<void>;
  /** Candidates per day from one source, newest day first (index 0 is the last 24 hours). */
  sourceDays(key: ScopeKey, source: string, days: number, now: number): Promise<number[]>;
}

const DAY = 86_400_000;
/** Statuses a write may carry under the fence: each one takes the lesson out of use (never into it). */
const NARROWING_STATUSES: ReadonlySet<Lesson["status"]> = new Set(["retired", "rejected", "withdrawn", "expired", "stale"]);
/** Bookkeeping about use: carried from the head into every new version, so a commit never rewinds a counter. */
const USAGE_FIELDS = ["counters", "staleAt", "lastValidatedAt", "lastHelpfulAt"] as const;
const scopeId = (k: ScopeKey): string => `${k.workspaceId}\u0001${k.project}`;
const clone = <T>(value: T): T => structuredClone(value);

interface ProjectState {
  heads: Map<string, Lesson>; versions: Map<string, Lesson[]>; members: Map<string, number>; sets: SetSnapshot[];
  manifests: Map<string, LoadManifest>; once: Set<string>; pending: Map<string, PendingOutcome>; flags: ProjectFlags;
  sourceEvents: Array<{ at: number; source: string }>;
  gone: Map<string, "withdrawn" | "purged">;
  erased: Set<string>; deletedIds: Set<string>; intents: Map<string, DeletionIntent>;
}

export class InMemoryLessonStore implements LessonStore {
  private readonly state = new Map<string, ProjectState>();

  private of(key: ScopeKey): ProjectState {
    const id = scopeId(key);
    let value = this.state.get(id);
    if (value === undefined) {
      value = { heads: new Map(), versions: new Map(), members: new Map(), sets: [{ setVersion: 0, at: 0, members: [] }], manifests: new Map(), once: new Set(), pending: new Map(), flags: {}, sourceEvents: [], gone: new Map(), erased: new Set(), deletedIds: new Set(), intents: new Map() };
      this.state.set(id, value);
    }
    return value;
  }

  async get(key: ScopeKey, id: string): Promise<Lesson | undefined> {
    const s = this.of(key);
    const head = s.members.has(id) ? s.heads.get(id) : undefined;
    return head === undefined ? undefined : clone(head);
  }

  async list(key: ScopeKey, filter?: { statuses?: readonly LessonStatus[] }): Promise<Lesson[]> {
    const s = this.of(key);
    const out: Lesson[] = [];
    for (const id of [...s.members.keys()].sort()) {
      const head = s.heads.get(id);
      if (head !== undefined && (filter?.statuses === undefined || filter.statuses.includes(head.status))) out.push(clone(head));
    }
    return out;
  }

  async listAllHeads(key: ScopeKey): Promise<Lesson[]> { const s = this.of(key); return [...s.heads.keys()].sort().map((id) => clone(s.heads.get(id)!)); }
  async getHead(key: ScopeKey, id: string): Promise<Lesson | undefined> { const h = this.of(key).heads.get(id); return h === undefined ? undefined : clone(h); }

  async setVersion(key: ScopeKey): Promise<number> { return this.of(key).sets.at(-1)!.setVersion; }
  async versions(key: ScopeKey, id: string): Promise<Lesson[]> { return clone(this.of(key).versions.get(id) ?? []); }
  async snapshots(key: ScopeKey): Promise<SetSnapshot[]> { return clone(this.of(key).sets); }

  async commit(key: ScopeKey, expectedSetVersion: number, writes: readonly Lesson[], at: number): Promise<CommitResult> {
    const s = this.of(key);
    if (s.sets.at(-1)!.setVersion !== expectedSetVersion) return { ok: false, reason: "conflict" };
    const staged: Lesson[] = [];
    for (const raw of writes) {
      let lesson = LessonSchema.parse(raw);
      if (lesson.workspaceId !== key.workspaceId || lesson.project !== key.project) throw new Error("lesson is outside the scope it is written to");
      const existing = s.versions.get(lesson.id)?.at(-1);
      if (lesson.version !== (existing?.version ?? 0) + 1) return { ok: false, reason: "conflict" };
      if (staged.some((x) => x.id === lesson.id)) throw new Error("one commit writes a lesson once");
      // The fence: nothing that names an erased person or a deleted record may be written back, whatever the writer read earlier.
      if (s.gone.get(lesson.id) === "purged") return { ok: false, reason: "erased" };
      if (peopleOf(lesson).some((p) => s.erased.has(normId(p))) || recordIdsOf(lesson).some((id) => s.deletedIds.has(id))) {
        // A write that only NARROWS (retire, reject, withdraw: the kill switches; expire and stale: a lesson leaving use) is never refused; what it carries from a stale read is
        // scrubbed against the fence. So `sweepExpired` and the staleness check still reach a lesson that names an erased person.
        if (!NARROWING_STATUSES.has(lesson.status)) return { ok: false, reason: "erased" };
        lesson = LessonSchema.parse(scrubLesson(lesson, s.deletedIds, s.erased));
      }
      staged.push(lesson);
    }
    const members = new Map(s.members);
    for (const lesson of staged) {
      // The version item keeps the content as written. The head keeps the usage bookkeeping of the previous head: a counter changed while the writer
      // was deciding is never overwritten by what the writer read earlier.
      const versions = s.versions.get(lesson.id) ?? [];
      versions.push(clone(lesson));
      s.versions.set(lesson.id, versions);
      const previous = s.heads.get(lesson.id);
      const head = clone(lesson);
      if (previous !== undefined) for (const field of USAGE_FIELDS) (head as Record<string, unknown>)[field] = clone((previous as Record<string, unknown>)[field]);
      s.heads.set(lesson.id, head);
      members.set(lesson.id, lesson.version);
    }
    s.members = members;
    const setVersion = expectedSetVersion + 1;
    s.sets.push({ setVersion, at, members: [...members.entries()].map(([id, version]) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)) });
    return { ok: true, setVersion };
  }

  async rollback(key: ScopeKey, targetSetVersion: number, expectedSetVersion: number, at: number): Promise<CommitResult> {
    const s = this.of(key);
    if (s.sets.at(-1)!.setVersion !== expectedSetVersion) return { ok: false, reason: "conflict" };
    const target = s.sets.find((x) => x.setVersion === targetSetVersion);
    if (target === undefined || targetSetVersion >= expectedSetVersion) return { ok: false, reason: "conflict" };
    const members = new Map<string, number>();
    const restoredIds: string[] = [];
    for (const m of target.members) {
      // A withdrawn lesson stays withdrawn and a purged one stays gone, whatever the earlier set held.
      const fate = s.gone.get(m.id);
      if (fate === "purged") continue;
      if (fate === "withdrawn") { const head = s.heads.get(m.id); if (head !== undefined) members.set(m.id, head.version); continue; }
      // A lesson a person retired (or that was rejected) is not brought back by a rollback.
      const head = s.heads.get(m.id);
      if (head !== undefined && (head.status === "retired" || head.status === "rejected")) { members.set(m.id, head.version); continue; }
      const content = s.versions.get(m.id)?.find((v) => v.version === m.version);
      if (content === undefined) return { ok: false, reason: "conflict" };
      // The fence applies to a rollback too: content that names an erased person or a deleted row is never brought back, and a lesson with a deletion still open is
      // left alone until its intent finishes.
      const openIntent = [...s.intents.values()].some((i) => !i.finished && i.lessonId === m.id);
      if (head !== undefined && (openIntent || peopleOf(content).some((p) => s.erased.has(normId(p))) || recordIdsOf(content).some((id) => s.deletedIds.has(id)))) { members.set(m.id, head.version); continue; }
      const current = s.heads.get(m.id);
      const restored = clone(content);
      // Counters and expiry are bookkeeping about use, not content: a rollback does not rewind them.
      if (current !== undefined) for (const field of [...USAGE_FIELDS, "expiresAt"]) (restored as Record<string, unknown>)[field] = clone((current as Record<string, unknown>)[field]);
      // A rollback never restores approval. Automatic approval is dropped and the lesson comes back needing a person; without a person's approval it is pending, so it
      // is not loaded until the normal tier check and approval have run again.
      // A tier can only rise: the restored tier is the higher of the old version's and the head's, with the reasons of both, and a contradiction stays flagged.
      if (current !== undefined) {
        restored.tier = Math.max(restored.tier, current.tier) as Lesson["tier"];
        restored.tierReasons = [...new Set([...restored.tierReasons, ...current.tierReasons])].slice(0, 12);
        if (current.contradictsWith !== undefined) restored.contradictsWith = current.contradictsWith;
        // Approval given for a lower tier does not carry to a higher one.
        if (restored.tier > content.tier) restored.approvals = [];
      }
      restored.approvals = restored.approvals.filter((a) => a.mode !== "auto");
      restored.reviewRequired = true;
      // It always comes back pending. A person\'s earlier approval is kept as a record, but it counts only after it is re-checked against who may approve NOW and the
      // current policy (rollbackLessonSet does that); until then nothing is live.
      if (restored.status === "active" || restored.status === "stale") { restored.status = "pending"; restored.pendingExpiresAt = at + CHANGE_APPROVAL_TTL_DAYS * DAY; }
      s.heads.set(m.id, restored);
      members.set(m.id, m.version);
      restoredIds.push(m.id);
    }
    s.members = members;
    const setVersion = expectedSetVersion + 1;
    s.sets.push({ setVersion, at, members: [...members.entries()].map(([id, version]) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)) });
    return { ok: true, setVersion, restored: restoredIds };
  }

  async mutate(key: ScopeKey, id: string, fn: (lesson: Lesson) => Partial<Pick<Lesson, (typeof VOLATILE_FIELDS)[number]>> | undefined): Promise<Lesson | undefined> {
    const s = this.of(key);
    const head = s.members.has(id) ? s.heads.get(id) : undefined;
    if (head === undefined) return undefined;
    const patch = fn(clone(head));
    if (patch !== undefined) {
      const next = LessonSchema.parse({ ...head, ...clone(patch) });
      s.heads.set(id, next);
    }
    return clone(s.heads.get(id)!);
  }

  async scrub(key: ScopeKey, id: string, fn: (lesson: Lesson) => Lesson): Promise<void> {
    const s = this.of(key);
    const head = s.heads.get(id);
    if (head !== undefined) s.heads.set(id, LessonSchema.parse(fn(clone(head))));
    s.versions.set(id, (s.versions.get(id) ?? []).map((v) => LessonSchema.parse({ ...fn(clone(v)), version: v.version })));
  }
  async markGone(key: ScopeKey, id: string, mode: "withdrawn" | "purged"): Promise<void> { this.of(key).gone.set(id, mode); }
  async purge(key: ScopeKey, id: string): Promise<void> {
    const s = this.of(key);
    s.heads.delete(id);
    s.versions.delete(id);
    s.members.delete(id);
    s.gone.set(id, "purged");
    for (const [name, manifest] of s.manifests) {
      if (manifest.lessons.some((e) => e.id === id)) s.manifests.set(name, { ...manifest, lessons: manifest.lessons.filter((e) => e.id !== id) });
    }
    for (const name of [...s.once]) if (name.includes(`:${id}`) || name.includes(`${id}:`)) s.once.delete(name);
    for (const [name, entry] of s.pending) if (entry.lessonId === id) s.pending.delete(name);
  }
  async forgetSource(key: ScopeKey, source: string): Promise<void> {
    const s = this.of(key);
    const wanted = normSource(source);
    s.sourceEvents = s.sourceEvents.filter((e) => normSource(e.source) !== wanted);
    // Every spelling of the key goes: a pause stored as `member:Mallory` is forgotten when `mallory` is erased.
    const paused = s.flags.pausedSources;
    if (paused !== undefined && Object.keys(paused).some((name) => normSource(name) === wanted)) {
      s.flags = { ...s.flags, pausedSources: Object.fromEntries(Object.entries(paused).filter(([name]) => normSource(name) !== wanted)) };
    }
  }
  async fence(key: ScopeKey, fence: { people?: readonly string[]; ids?: readonly string[] }): Promise<void> {
    const s = this.of(key);
    for (const p of fence.people ?? []) s.erased.add(normId(p));
    for (const id of fence.ids ?? []) s.deletedIds.add(id);
  }
  async isErased(key: ScopeKey, person: string): Promise<boolean> { return this.of(key).erased.has(normId(person)); }
  async putIntent(key: ScopeKey, intent: DeletionIntent): Promise<void> { this.of(key).intents.set(intent.id, clone(intent)); }
  async getIntent(key: ScopeKey, id: string): Promise<DeletionIntent | undefined> { const i = this.of(key).intents.get(id); return i === undefined ? undefined : clone(i); }
  async listIntents(key: ScopeKey, filter?: { finished?: boolean }): Promise<DeletionIntent[]> {
    return [...this.of(key).intents.values()].filter((i) => filter?.finished === undefined || i.finished === filter.finished).map(clone).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  async putManifest(manifest: LoadManifest): Promise<boolean> {
    const s = this.of(manifest);
    const id = `${manifest.taskId}#${manifest.stage}#${manifest.round}`;
    if (s.manifests.has(id)) return false;
    s.manifests.set(id, clone(manifest));
    return true;
  }
  async manifests(key: ScopeKey, taskId: string): Promise<LoadManifest[]> {
    return [...this.of(key).manifests.values()].filter((m) => m.taskId === taskId).map(clone).sort((a, b) => a.at - b.at);
  }
  async updateManifest(manifest: LoadManifest): Promise<void> {
    const s = this.of(manifest);
    const id = `${manifest.taskId}#${manifest.stage}#${manifest.round}`;
    if (s.manifests.has(id)) s.manifests.set(id, clone(manifest));
  }
  /** For tests: the names of the idempotency keys written so far. */
  onceNames(key: ScopeKey): string[] { return [...this.of(key).once]; }
  async markOnce(key: ScopeKey, name: string): Promise<boolean> {
    const s = this.of(key);
    if (s.once.has(name)) return false;
    s.once.add(name);
    return true;
  }
  async addPending(entry: PendingOutcome): Promise<void> { this.of(entry).pending.set(entry.key, clone(entry)); }
  async duePending(key: ScopeKey, now: number, limit: number): Promise<PendingOutcome[]> {
    return [...this.of(key).pending.values()].filter((p) => p.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt || a.key.localeCompare(b.key)).slice(0, limit).map(clone);
  }
  async removePending(key: ScopeKey, pendingKey: string): Promise<void> { this.of(key).pending.delete(pendingKey); }
  async flags(key: ScopeKey): Promise<ProjectFlags> { return clone(this.of(key).flags); }
  async setFlags(key: ScopeKey, flags: ProjectFlags): Promise<void> { this.of(key).flags = clone(flags); }
  async recordSourceEvent(key: ScopeKey, event: { at: number; source: string }): Promise<void> { this.of(key).sourceEvents.push({ at: event.at, source: normSource(event.source) }); }
  async sourceDays(key: ScopeKey, source: string, days: number, now: number): Promise<number[]> {
    const counts = new Array<number>(days).fill(0);
    const wanted = normSource(source);
    for (const e of this.of(key).sourceEvents) {
      if (normSource(e.source) !== wanted) continue;
      const age = Math.floor((now - e.at) / DAY);
      if (age >= 0 && age < days) counts[age]! += 1;
    }
    return counts;
  }
}

/** The next version of a lesson, for a commit: the head's version plus one. */
export const nextVersion = (head: Lesson | undefined, versions: readonly Lesson[]): number => Math.max(head?.version ?? 0, versions.at(-1)?.version ?? 0) + 1;
