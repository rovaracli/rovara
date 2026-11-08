// Lessons in production, lane 2: the lessons' two scheduled jobs, run for one company inside the Team record's own schedules (aws/broker/lessons-wiring.ts hooks them to `jobs.extend`):
//   - hourly (job id "lessons-resume"): finishes every deletion that was started and not finished in the company's projects (`resumePending`, WB-7), whatever the learning mode (an erase must finish);
//   - nightly (job id "lessons-reverts"): re-reflects tasks whose change was reverted in the last 26 hours. One message per task to the same queue as a task's end, with the outcome `reverted`; the worker's
//     once-claim on `LEARN#<task>#reverted` makes a revert reflected once however many nights see the row (26 hours covers the daily run with a margin for a late one).
// Both are bounded (projects, tasks, time) and a failure of one project never stops the others.
import { OrgIdSchema, type OrgId } from "@agentx/contracts";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ReflectQueue } from "./reflect-queue.js";
import type { TeamRecordTable } from "../team-record/types.js";
import { revertedTasksSince } from "./task-outcome-rows.js";

export const REVERT_WINDOW_MS = 26 * 60 * 60 * 1000;
export const MAX_PROJECTS_PER_JOB = 200;
export const MAX_REVERTS_PER_PROJECT = 100;

export interface LessonsJobDeps {
  table: TeamRecordTable;
  settings: LearningSettingsReader;
  queue?: ReflectQueue | undefined;
  resumePending(orgId: string, project: string): Promise<number>;
  now(): number;
  newRequestId(): string;
  log(event: string, fields: Record<string, string | number>): void;
}

/** Hourly. Returns counts only. */
export async function lessonsResumeJob(deps: LessonsJobDeps, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const started = deps.now();
  let finished = 0, failed = 0, skipped = 0;
  for (const project of projects.slice(0, MAX_PROJECTS_PER_JOB)) {
    if (deps.now() - started > budgetMs) { skipped += 1; continue; }
    try { finished += await deps.resumePending(orgId, project); } catch { failed += 1; deps.log("lessons_job.resume_failed", {}); }
  }
  return { lessonDeletionsResumed: finished, lessonResumeFailures: failed, lessonResumeSkipped: skipped };
}

/** Nightly. Returns counts only. */
export async function lessonsRevertJob(deps: LessonsJobDeps, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success || deps.queue === undefined) return { revertsEnqueued: 0 };
  const workspaceId: OrgId = org.data;
  const started = deps.now();
  let enqueued = 0, failed = 0, truncated = 0;
  for (const project of projects.slice(0, MAX_PROJECTS_PER_JOB)) {
    if (deps.now() - started > budgetMs) break;
    try {
      // The worker checks the mode too (L4); asking here keeps a project with learning off from sending anything.
      if (!modeAllows((await resolveLearning(deps.settings, orgId, project)).mode, "reflect")) continue;
      const found = await revertedTasksSince(deps.table, workspaceId, project, deps.now() - REVERT_WINDOW_MS, { nowSeconds: Math.floor(deps.now() / 1000) });
      if (found.truncated) truncated += 1;
      for (const taskId of found.taskIds.slice(0, MAX_REVERTS_PER_PROJECT)) {
        try { await deps.queue.send({ orgId: workspaceId, taskId, outcome: "reverted", requestId: deps.newRequestId() }); enqueued += 1; } catch { failed += 1; deps.log("lessons_job.enqueue_failed", {}); }
      }
    } catch {
      failed += 1;
      deps.log("lessons_job.revert_failed", {});
    }
  }
  return { revertsEnqueued: enqueued, revertFailures: failed, revertWindowsTruncated: truncated };
}
