// Lane 7: pipeline B ("the current pipeline") as a snapshot builder, READ ONLY. The current pipeline already ran for real on the install, so the lessons it held on a past day are in the lesson store's version
// history: the snapshot for a simulated day is the set of lessons that were live (active, not expired, created) at the START of that day, at the version they had then. Nothing is reflected, curated or judged
// here, no model is called, nothing is written. Consequences, stated in the report: its learning cost is NOT measured (null), and it reflects what B did when it ran, not what B would do on the replay's tasks.
// `pin` (optional) materialises the snapshot so a replayed task can load it; the loader's snapshot mode does not exist yet (see replay-executor.ts), so without a `pin` the snapshot is a plan-only id.
import { snapshotIdOf } from "./replay-snapshot-store.js";
import type { SnapshotBuilder, SnapshotRequest, SnapshotResult } from "./replay-harness.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";


/** The lessons live at `t`: for each lesson the last version written by then, kept if active, created by then and not expired. */
export function lessonsAsOf(versionsByLesson: ReadonlyMap<string, readonly Lesson[]>, t: number): Lesson[] {
  const out: Lesson[] = [];
  for (const versions of versionsByLesson.values()) {
    let at: Lesson | undefined;
    for (const version of versions) if (version.updatedAt <= t && (at === undefined || version.version >= at.version)) at = version;
    if (at !== undefined && at.createdAt <= t && at.status === "active" && at.expiresAt > t) out.push(at);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface AsOfDeps {
  store: Pick<LessonStore, "listAllHeads" | "versions">;
  key: ScopeKey;
  /** Stores the snapshot under its id so a task can load it. Absent: the id only names it. */
  pin?(snapshotId: string, lessons: readonly Lesson[]): Promise<void>;
}

export function asOfSnapshotBuilder(deps: AsOfDeps): SnapshotBuilder {
  return {
    async build(request: SnapshotRequest): Promise<SnapshotResult> {
      const t = Date.parse(`${request.day}T00:00:00.000Z`);
      if (!Number.isFinite(t)) throw new RangeError("A snapshot is for a UTC date.");
      const heads = (await deps.store.listAllHeads(deps.key)).filter((h) => h.workspaceId === deps.key.workspaceId && h.project === deps.key.project);
      const versions = new Map<string, readonly Lesson[]>();
      for (const head of heads) versions.set(head.id, await deps.store.versions(deps.key, head.id));
      const lessons = lessonsAsOf(versions, t);
      // The id the install derives from the same lessons (`replay-snapshot-store.ts#snapshotIdOf`), so the snapshot a copy is started on is the one named here.
      const snapshotId = snapshotIdOf(deps.key, lessons.map((l) => ({ id: l.id, version: l.version })));
      if (deps.pin !== undefined) await deps.pin(snapshotId, lessons);
      return { snapshotId, lessons, costUsd: null, calls: null };
    },
  };
}
