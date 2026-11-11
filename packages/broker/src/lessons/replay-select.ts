// Lane 7 (DECISIONS 49): which past tasks the replay uses. 40 to 60 finished tasks taken from the repositories where members corrected the agent most, so that lessons actually build up. The choice is
// deterministic: the same candidates and the same seed give the same tasks, whatever order the candidates arrive in. Pure; no store, no AWS (the operator exports the candidates).
import { createHash } from "node:crypto";
import { REPLAY_TASKS_MAX, REPLAY_TASKS_MIN } from "@rovara-code/contracts";

export interface ReplayCandidate {
  taskId: string;
  project: string;
  repository: string;
  /** When the task started (ms since the epoch); the replay runs in this order. */
  at: number;
  /** Corrections members gave the task: human send-backs, change-requesting review comments, human edits, a revert. */
  memberCorrections: number;
  outcome: "merged" | "closed" | "abandoned" | "reverted";
}
export interface SelectOptions {
  seed: string;
  /** How many tasks to take; 50 unless named. */
  target?: number;
  /** The most tasks from one repository, until the pool is too concentrated to reach the target. */
  perRepoMax?: number;
  /** A task needs at least this many corrections to be a candidate. */
  minCorrections?: number;
}
export type SelectResult =
  | { ok: true; tasks: ReplayCandidate[]; repositories: Array<{ repository: string; tasks: number; corrections: number }>; meanCorrections: number; poolMeanCorrections: number; seed: string }
  | { ok: false; reason: "no_seed" | "target_out_of_range" | "bad_candidate" | "duplicate_task" | "not_enough_tasks"; detail?: string };

const OUTCOMES: ReadonlySet<string> = new Set(["merged", "closed", "abandoned", "reverted"]);
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex");

export function selectReplayTasks(candidates: readonly ReplayCandidate[], options: SelectOptions): SelectResult {
  if (options.seed.trim() === "") return { ok: false, reason: "no_seed" };
  const target = options.target ?? 50;
  if (!Number.isInteger(target) || target < REPLAY_TASKS_MIN || target > REPLAY_TASKS_MAX) return { ok: false, reason: "target_out_of_range" };
  const perRepoMax = options.perRepoMax ?? 15;
  const minCorrections = options.minCorrections ?? 1;
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c.taskId !== "string" || c.taskId === "" || typeof c.repository !== "string" || c.repository === "" || typeof c.project !== "string" || !Number.isFinite(c.at) || !Number.isInteger(c.memberCorrections) || c.memberCorrections < 0) {
      return { ok: false, reason: "bad_candidate", ...(typeof c.taskId === "string" ? { detail: c.taskId } : {}) };
    }
    if (seen.has(c.taskId)) return { ok: false, reason: "duplicate_task", detail: c.taskId };
    seen.add(c.taskId);
  }
  // Only finished tasks that members corrected at least `minCorrections` times.
  const eligible = candidates.filter((c) => OUTCOMES.has(c.outcome) && c.memberCorrections >= minCorrections);
  if (eligible.length < REPLAY_TASKS_MIN || eligible.length < target) return { ok: false, reason: "not_enough_tasks", detail: String(eligible.length) };

  const byRepo = new Map<string, ReplayCandidate[]>();
  for (const c of eligible) byRepo.set(c.repository, [...(byRepo.get(c.repository) ?? []), c]);
  const repos = [...byRepo.entries()].map(([repository, tasks]) => ({
    repository, corrections: tasks.reduce((sum, t) => sum + t.memberCorrections, 0),
    tasks: tasks.sort((a, b) => b.memberCorrections - a.memberCorrections || (hash(options.seed, a.taskId) < hash(options.seed, b.taskId) ? -1 : 1)),
  })).sort((a, b) => b.corrections - a.corrections || (hash(options.seed, a.repository) < hash(options.seed, b.repository) ? -1 : 1));

  const taken = new Map<string, ReplayCandidate[]>();
  const take = (cap: number): void => {
    for (const repo of repos) {
      const mine = taken.get(repo.repository) ?? [];
      taken.set(repo.repository, mine);
      for (const task of repo.tasks) {
        if (mine.length >= cap || [...taken.values()].reduce((n, list) => n + list.length, 0) >= target) break;
        if (!mine.includes(task)) mine.push(task);
      }
    }
  };
  take(perRepoMax);
  // A pool too concentrated to reach the target under the cap: lift the cap rather than return fewer tasks.
  if ([...taken.values()].reduce((n, list) => n + list.length, 0) < target) take(Number.POSITIVE_INFINITY);

  const tasks = [...taken.values()].flat().sort((a, b) => a.at - b.at || (a.taskId < b.taskId ? -1 : 1));
  const mean = (list: readonly ReplayCandidate[]): number => (list.length === 0 ? 0 : list.reduce((sum, t) => sum + t.memberCorrections, 0) / list.length);
  return {
    ok: true, tasks, seed: options.seed,
    repositories: repos.map((r) => ({ repository: r.repository, tasks: taken.get(r.repository)?.length ?? 0, corrections: (taken.get(r.repository) ?? []).reduce((sum, t) => sum + t.memberCorrections, 0) })).filter((r) => r.tasks > 0),
    meanCorrections: mean(tasks), poolMeanCorrections: mean(candidates),
  };
}
