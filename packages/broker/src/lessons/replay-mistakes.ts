// Lane 7 (CONNECT-2): the repeat-mistake metric (`metric.ts#sameMistakeTwice`) wired into the replay. The grader flags, for a replayed run, the historical corrections the run's mistakes repeat. This module does not take the
// grader's word: for each replayed task it builds the run's mistakes as corrections at the task's time, naming the historical correction as the one repeated (`repeatOf`), and asks `sameMistakeTwice` over the arm's
// FROZEN lessons. The metric believes a repeat only if the named correction exists, is a member's, is on an EARLIER task and is earlier in time, and it splits each repeat into: a lesson covering it was loaded
// into the run / a lesson existed but was not loaded / there was no lesson. It writes nothing, charges nothing and reads only the sources it is handed (never the live store).
import type { ArmSameMistakeCheck, ReplayRunRow } from "@rovara-code/contracts";
import { canonicalArm } from "@rovara-code/contracts";
import { sameMistakeTwice, type CorrectionRecord, type CorrectionSource, type MatcherSource, type MetricStore } from "./metric.js";
import { lessonContentKey } from "./replay-lessonset.js";
import type { ReplayCandidate } from "./replay-select.js";
import type { LoadManifest, ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

export interface MistakeCheckDeps {
  key: ScopeKey;
  tasks: readonly ReplayCandidate[];
  /** The historical corrections of the project (production: `v12CorrectionSource` over the learning table; a file in the harness). */
  corrections: CorrectionSource;
  /** Production: `signatureMatcher` or `fusedMatcher` (`metric-source.ts`). */
  matcher: MatcherSource;
  /** The arm's frozen lessons as the replay saw them (for the split). */
  lessonsOf(arm: string): readonly Lesson[];
}

/** A metric store over a frozen set of lessons and what each replayed task loaded (by content key). Read only. */
export function replayMetricStore(key: ScopeKey, lessons: readonly Lesson[], loadedByTask: ReadonlyMap<string, ReadonlySet<string>>): MetricStore {
  const manifests = (taskId: string): LoadManifest[] => {
    const keys = loadedByTask.get(taskId);
    const entries = lessons.filter((lesson) => keys?.has(lessonContentKey(lesson)) === true).map((lesson) => ({ id: lesson.id, version: lesson.version, score: 1, why: "scope" as const, citation: "none" as const }));
    return entries.length === 0 ? [] : [{ taskId, workspaceId: key.workspaceId, project: key.project, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "off", at: 0, lessons: entries, bytes: 0 }];
  };
  return {
    listAllHeads: async () => [...lessons],
    versions: async (_key, id) => lessons.filter((lesson) => lesson.id === id),
    manifests: async (_key, taskId) => manifests(taskId),
  };
}

export async function repeatMistakeChecks(rows: readonly ReplayRunRow[], deps: MistakeCheckDeps): Promise<ArmSameMistakeCheck[]> {
  const arms = [...new Set(rows.map((row) => canonicalArm(row.arm)))].sort();
  const history = await deps.corrections.list(deps.key, { since: 0, until: Number.MAX_SAFE_INTEGER }, 100_000);
  const byId = new Map(history.corrections.map((c) => [c.id, c] as const));
  const out: ArmSameMistakeCheck[] = [];
  for (const arm of arms) {
    const total: ArmSameMistakeCheck = { arm, confirmed: 0, unjudged: 0, split: { lessonLoaded: 0, lessonNotLoaded: 0, noLesson: 0 } };
    const mine = rows.filter((row) => canonicalArm(row.arm) === arm);
    const loadedByTask = new Map<string, Set<string>>();
    for (const row of mine) loadedByTask.set(row.task, new Set([...(loadedByTask.get(row.task) ?? []), ...row.loaded]));
    const store = replayMetricStore(deps.key, deps.lessonsOf(arm), loadedByTask);
    for (const task of deps.tasks) {
      const flagged = [...new Set(mine.filter((row) => row.task === task.taskId).flatMap((row) => row.mistakes))];
      if (flagged.length === 0) continue;
      // The run's mistakes, as corrections at the task's start. They repeat the historical correction the grader named.
      const replayed: CorrectionRecord[] = flagged.map((id, index) => {
        const named = byId.get(id);
        return {
          id: `replay:${arm}:${task.taskId}:${String(index)}`, taskId: task.taskId, at: task.at, kind: named?.kind ?? "review_comment", member: true, repeatOf: id,
          ...(named?.text === undefined ? {} : { text: named.text }), ...(named?.signature === undefined ? {} : { signature: named.signature }), ...(named?.paths === undefined ? {} : { paths: named.paths }),
        };
      });
      const source: CorrectionSource = {
        list: async () => ({ corrections: [...history.corrections.filter((c) => c.at < task.at), ...replayed], truncated: history.truncated }),
      };
      const measured = await sameMistakeTwice({ corrections: source, matcher: deps.matcher, store }, deps.key, { sinceMs: task.at, untilMs: task.at + 1 });
      total.confirmed += measured.repeats;
      total.unjudged += measured.unjudged;
      total.split.lessonLoaded += measured.split.lessonLoaded;
      total.split.lessonNotLoaded += measured.split.lessonNotLoaded;
      total.split.noLesson += measured.split.noLesson;
    }
    out.push(total);
  }
  return out;
}
