// Learning v2: the lesson store (design §4.2, §4.6). `LessonStore` is the interface; `InMemoryLessonStore` is the stand-in the tests and the first wiring use.
// The DynamoDB implementation lives beside the record core's `TeamRecord` table (R2); it must give the same guarantees:
//   - a commit is one conditional write: it applies only if the project's lesson-set version is the one the caller read, and every lesson's version
//     is exactly the previous version plus one; otherwise nothing changes ("conflict") and the caller re-reads (ACE: delta updates applied by code);
//   - every lesson version is kept, and every set version records which lesson versions it held, so a rollback restores a past set;
//   - counters and expiry bookkeeping change in place (`mutate`) without a new version.
// Every key carries the workspace and the project, so one workspace's call can never read or change another's lessons.
import { LessonSchema, type Lesson, type LessonStatus, type VOLATILE_FIELDS } from "./types.js";
import type { LessonStage } from "@agentx/contracts";

export interface ScopeKey { workspaceId: string; project: string }
export type CommitResult = { ok: true; setVersion: number } | { ok: false; reason: "conflict" };

export interface LoadManifestEntry {
  id: string; version: number; score: number; why: "scope" | "similar" | "path";
  citation: "unchecked" | "valid" | "moved" | "stale_dropped" | "unchecked_dropped" | "none";
}
export interface LoadManifest {
  taskId: string; workspaceId: string; project: string; stage: LessonStage; round: number; setVersion: number;
  memory: "live" | "off"; at: number; lessons: LoadManifestEntry[]; bytes: number;
}
export interface PendingOutcome { key: string; workspaceId: string; project: string; lessonId: string; taskId: string; dueAt: number }
export interface ProjectFlags { autoTierPausedAt?: number; autoTierPausedReason?: string }
export interface SetSnapshot { setVersion: number; at: number; members: Array<{ id: string; version: number }> }

export interface LessonStore {
  get(key: ScopeKey, id: string): Promise<Lesson | undefined>;
  list(key: ScopeKey, filter?: { statuses?: readonly LessonStatus[] }): Promise<Lesson[]>;
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
  recordCandidate(key: ScopeKey, event: { at: number; authors: readonly string[] }): Promise<void>;
  countCandidates(key: ScopeKey, sinceMs: number, author?: string): Promise<number>;
  candidateDays(key: ScopeKey, days: number, now: number): Promise<number[]>;
}

const DAY = 86_400_000;
/** Bookkeeping about use: carried from the head into every new version, so a commit never rewinds a counter. */
const USAGE_FIELDS = ["counters", "staleAt", "lastValidatedAt", "lastHelpfulAt"] as const;
const scopeId = (k: ScopeKey): string => `${k.workspaceId}\u0001${k.project}`;
const clone = <T>(value: T): T => structuredClone(value);

interface ProjectState {
  heads: Map<string, Lesson>; versions: Map<string, Lesson[]>; members: Map<string, number>; sets: SetSnapshot[];
  manifests: Map<string, LoadManifest>; once: Set<string>; pending: Map<string, PendingOutcome>; flags: ProjectFlags;
  candidates: Array<{ at: number; authors: readonly string[] }>;
}

export class InMemoryLessonStore implements LessonStore {
  private readonly state = new Map<string, ProjectState>();

  private of(key: ScopeKey): ProjectState {
    const id = scopeId(key);
    let value = this.state.get(id);
    if (value === undefined) {
      value = { heads: new Map(), versions: new Map(), members: new Map(), sets: [{ setVersion: 0, at: 0, members: [] }], manifests: new Map(), once: new Set(), pending: new Map(), flags: {}, candidates: [] };
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

  async setVersion(key: ScopeKey): Promise<number> { return this.of(key).sets.at(-1)!.setVersion; }
  async versions(key: ScopeKey, id: string): Promise<Lesson[]> { return clone(this.of(key).versions.get(id) ?? []); }
  async snapshots(key: ScopeKey): Promise<SetSnapshot[]> { return clone(this.of(key).sets); }

  async commit(key: ScopeKey, expectedSetVersion: number, writes: readonly Lesson[], at: number): Promise<CommitResult> {
    const s = this.of(key);
    if (s.sets.at(-1)!.setVersion !== expectedSetVersion) return { ok: false, reason: "conflict" };
    const staged: Lesson[] = [];
    for (const raw of writes) {
      const lesson = LessonSchema.parse(raw);
      if (lesson.workspaceId !== key.workspaceId || lesson.project !== key.project) throw new Error("lesson is outside the scope it is written to");
      const existing = s.versions.get(lesson.id)?.at(-1);
      if (lesson.version !== (existing?.version ?? 0) + 1) return { ok: false, reason: "conflict" };
      if (staged.some((x) => x.id === lesson.id)) throw new Error("one commit writes a lesson once");
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
    for (const m of target.members) {
      const content = s.versions.get(m.id)?.find((v) => v.version === m.version);
      if (content === undefined) return { ok: false, reason: "conflict" };
      const current = s.heads.get(m.id);
      const restored = clone(content);
      // Counters and expiry are bookkeeping about use, not content: a rollback does not rewind them.
      if (current !== undefined) for (const field of [...USAGE_FIELDS, "expiresAt"]) (restored as Record<string, unknown>)[field] = clone((current as Record<string, unknown>)[field]);
      s.heads.set(m.id, restored);
      members.set(m.id, m.version);
    }
    s.members = members;
    const setVersion = expectedSetVersion + 1;
    s.sets.push({ setVersion, at, members: [...members.entries()].map(([id, version]) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)) });
    return { ok: true, setVersion };
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
  async recordCandidate(key: ScopeKey, event: { at: number; authors: readonly string[] }): Promise<void> { this.of(key).candidates.push(clone(event)); }
  async countCandidates(key: ScopeKey, sinceMs: number, author?: string): Promise<number> {
    return this.of(key).candidates.filter((c) => c.at >= sinceMs && (author === undefined || c.authors.includes(author))).length;
  }
  async candidateDays(key: ScopeKey, days: number, now: number): Promise<number[]> {
    const counts = new Array<number>(days).fill(0);
    for (const c of this.of(key).candidates) {
      const age = Math.floor((now - c.at) / DAY);
      if (age >= 0 && age < days) counts[age]! += 1;
    }
    return counts;
  }
}

/** The next version of a lesson, for a commit: the head's version plus one. */
export const nextVersion = (head: Lesson | undefined, versions: readonly Lesson[]): number => Math.max(head?.version ?? 0, versions.at(-1)?.version ?? 0) + 1;
