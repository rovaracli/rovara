// Lessons in the repo, lane R2 (design rev 2 section 5): the weekly file pass inside the nightly job, so no new schedule and no infrastructure. Each night it looks, per project, at the repositories whose lessons file is switched on;
// a repository is worked on at most once a week (`runRepoFilePass` keeps its own clock), so most nights this is one Dynamo query per project and nothing else.
// Bounded in projects and time; a project that fails never stops the others. Makes no model call (decision 47). Returns counts only.
import { OrgIdSchema } from "@agentx/contracts";
import { rotated } from "./nightly-state.js";
import { finishClosings, finishErasures, runRepoFilePass, settleErasures, type RepoFileDeps, type RepoFileTarget } from "./repo-file-pass.js";

/** What the job and the routes need beyond the pass's own dependencies: how to find a project's repositories (with their code hosts). */
export interface RepoFileRuntime {
  deps: Omit<RepoFileDeps, "holder">;
  /** The project's repositories as targets. Throws when the project definition cannot be read. A repository whose host this install does not know is left out. */
  targets(workspaceId: string, project: string): Promise<RepoFileTarget[]>;
  newHolder?(): string;
}

export const MAX_REPO_FILE_PROJECTS = 200;

export async function lessonsRepoFileJob(runtime: RepoFileRuntime, orgId: string, projects: readonly string[], budgetMs: number, dayNumber: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  const counts = { repoFilePrsOpened: 0, repoFileLeft: 0, repoFileProblems: 0, repoFileFailures: 0, repoFileSkipped: 0 };
  if (!org.success) return counts;
  const started = runtime.deps.now();
  const capped = [...new Set(projects)].sort().slice(0, MAX_REPO_FILE_PROJECTS);
  // A different starting project each day, so a time budget that runs out never cuts off the same projects every night.
  for (const project of rotated(capped, capped.length === 0 ? 0 : dayNumber % capped.length)) {
    if (runtime.deps.now() - started > budgetMs) { counts.repoFileSkipped += 1; continue; }
    const key = { workspaceId: org.data, project };
    try {
      const states = await runtime.deps.state.list(key);
      // Erasure is not delivery and does not wait on the switches: every repository that has a record settles its erasures (a pull request that adds erased text is closed) and finishes the erase rows still waiting.
      const erase = await runtime.deps.state.listErase(key);
      const work = states.filter((state) => state.enabled || state.closing.length > 0 || state.pending !== undefined);
      if (work.length === 0 && states.every((state) => state.open === undefined && state.theirs.length === 0 && state.closing.length === 0) && erase.length === 0) continue;
      const targets = await runtime.targets(key.workspaceId, project);
      const deps: RepoFileDeps = { ...runtime.deps, holder: runtime.newHolder?.() ?? `nightly-${String(runtime.deps.now())}` };
      // A different repository first each day, like the projects, so a time budget that runs out never cuts off the same ones.
      const first = work.length === 0 ? 0 : dayNumber % work.length;
      for (const state of states) {
        const target = targets.find((candidate) => candidate.place === state.place);
        if (target === undefined) continue;
        try { await settleErasures(deps, key, target, state); await finishErasures(deps, key, target); } catch { counts.repoFileFailures += 1; }
      }
      for (const state of [...work.slice(first), ...work.slice(0, first)]) {
        if (runtime.deps.now() - started > budgetMs) { counts.repoFileSkipped += 1; continue; }
        const target = targets.find((candidate) => candidate.place === state.place);
        if (target === undefined) {
          // The repository left the project: say so on the row instead of failing silently.
          if (state.enabled) await runtime.deps.state.put(key, { ...state, problem: "repository_gone" }, state.revision).catch(() => undefined);
          counts.repoFileProblems += 1;
          continue;
        }
        if (!state.enabled) { await finishClosings(deps, key, target, (await runtime.deps.state.get(key, state.place)) ?? state); continue; }
        const result = await runRepoFilePass(deps, key, target);
        if (result.status === "opened") counts.repoFilePrsOpened += 1;
        else if (result.status === "left") counts.repoFileLeft += 1;
        else if (result.status === "problem") counts.repoFileProblems += 1;
      }
    } catch {
      counts.repoFileFailures += 1;
      runtime.deps.log?.("lessons_job.repo_file_failed", {});
    }
  }
  return counts;
}
