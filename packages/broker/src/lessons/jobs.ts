// Lessons in production, lane 2: the lessons' two scheduled jobs, run for one company inside the Team record's own schedules (aws/broker/lessons-wiring.ts hooks them to `jobs.extend`):
//   - hourly (job id "lessons-resume"): finishes every deletion that was started and not finished in the company's projects (`resumePending`, WB-7), whatever the learning mode (an erase must finish);
//   - nightly (job id "lessons-reverts"): re-reflects tasks whose change was reverted in the last 26 hours. One message per task to the same queue as a task's end, with the outcome `reverted`; the worker's
//     once-claim on `LEARN#<task>#reverted` makes a revert reflected once however many nights see the row (26 hours covers the daily run with a margin for a late one). The same nightly run then moves every
//     trial lesson that earned it to stable (`lessonsPromoteJob`, DECISIONS 24: 14 days live, 3 loads, no thumbs-down), because a lesson that is never loaded again would otherwise wait for a load that never comes.
//     Before that it moves lessons past their expiry (and pending ones nobody decided in time) to `expired` (`lessonsExpireJob`), so an expired lesson is never promoted or published.
// Both are bounded (projects, tasks, time) and a failure of one project never stops the others.
import { createHash } from "node:crypto";
import { OrgIdSchema, type OrgId } from "@agentx/contracts";
import { modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { ReflectQueue } from "./reflect-queue.js";
import type { TeamRecordTable } from "../team-record/types.js";
import { revertedTasksSince } from "./task-outcome-rows.js";
import { sweepExpired } from "./expiry.js";
import { promoteStableTrials, type StableDeps } from "./trial.js";

export const REVERT_WINDOW_MS = 26 * 60 * 60 * 1000;
export const MAX_PROJECTS_PER_JOB = 200;
export const MAX_REVERTS_PER_PROJECT = 100;

export interface LessonsJobDeps {
  table: TeamRecordTable;
  settings: LearningSettingsReader;
  queue?: ReflectQueue | undefined;
  /** What the nightly upkeep needs (the lessons' store, audit and clock): the expiry sweep and the trial-to-stable pass. Absent: neither runs. */
  maintain?: StableDeps | undefined;
  /** Tries every unfinished deletion of the project (`LessonDeletionPort.resumeAll`): one that fails never stops the ones after it. */
  resume(orgId: string, project: string): Promise<{ finished: number; failed: number }>;
  now(): number;
  newRequestId(): string;
  log(event: string, fields: Record<string, string | number>): void;
}

/** Hourly. Returns counts only. */
export async function lessonsResumeJob(deps: Pick<LessonsJobDeps, "resume" | "now" | "log">, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const started = deps.now();
  let finished = 0, failed = 0, skipped = 0;
  for (const project of projects.slice(0, MAX_PROJECTS_PER_JOB)) {
    if (deps.now() - started > budgetMs) { skipped += 1; continue; }
    try {
      const result = await deps.resume(orgId, project);
      finished += result.finished;
      // L4: an intent that could not be finished is counted and named in one fixed line (no ids); the project's other intents were still tried.
      if (result.failed > 0) { failed += result.failed; deps.log("lessons_job.resume_failed", { intents: result.failed }); }
    } catch { failed += 1; deps.log("lessons_job.resume_failed", {}); }
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
      // L3: a project cut off by the page limit says so in one fixed line, the project only as a hash.
      if (found.truncated) { truncated += 1; deps.log("lessons_job.revert_window_truncated", { project: createHash("sha256").update(`${orgId}\u0000${project}`).digest("hex").slice(0, 12) }); }
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

export const MAX_PROMOTIONS_PER_PROJECT = 200;

/**
 * Nightly. Moves each project's trial lessons that earned stable to stable (`promoteStableTrials`, which writes the audit entry first and commits through the store's erasure fence). Only where trial lessons
 * can exist: the project's resolved learning must allow them (Standard preset, mode On, no company approval floor). A project that is Off, Collect, Suggest or Regulated is left alone. Bounded in projects, lessons and
 * time; one project failing never stops the others. Returns counts only.
 */
export async function lessonsPromoteJob(deps: Pick<LessonsJobDeps, "settings" | "maintain" | "now" | "log">, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success || deps.maintain === undefined) return { trialsPromoted: 0 };
  const started = deps.now();
  const outOfTime = (): boolean => deps.now() - started > budgetMs;
  let promoted = 0, failed = 0;
  for (const project of projects.slice(0, MAX_PROJECTS_PER_JOB)) {
    if (outOfTime()) break;
    try {
      if (!(await resolveLearning(deps.settings, org.data, project)).trialAllowed) continue;
      promoted += (await promoteStableTrials(deps.maintain, { workspaceId: org.data, project }, MAX_PROMOTIONS_PER_PROJECT, outOfTime)).length;
    } catch {
      failed += 1;
      deps.log("lessons_job.promote_failed", {});
    }
  }
  return { trialsPromoted: promoted, promoteFailures: failed };
}

/**
 * Nightly. Marks lessons past their expiry (active) and pending lessons nobody decided in time as `expired` (`sweepExpired`: audited, committed through the store's erasure fence). Loading already ignores an expired
 * lesson; this makes the Lessons tab, the counts and repository publishing agree. A project whose learning is Off is left alone. Bounded in projects, lessons and time; a failing project never stops the others.
 */
export async function lessonsExpireJob(deps: Pick<LessonsJobDeps, "settings" | "maintain" | "now" | "log">, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const org = OrgIdSchema.safeParse(orgId);
  if (!org.success || deps.maintain === undefined) return { lessonsExpired: 0 };
  const started = deps.now();
  let expired = 0, failed = 0;
  for (const project of projects.slice(0, MAX_PROJECTS_PER_JOB)) {
    if (deps.now() - started > budgetMs) break;
    try {
      if ((await resolveLearning(deps.settings, org.data, project)).mode === "Off") continue;
      expired += (await sweepExpired(deps.maintain, deps.maintain.store, { workspaceId: org.data, project }, { limit: MAX_PROMOTIONS_PER_PROJECT })).expired.length;
    } catch {
      failed += 1;
      deps.log("lessons_job.expire_failed", {});
    }
  }
  return { lessonsExpired: expired, expireFailures: failed };
}

/** The nightly run: the revert re-reflection with the first half of the budget, then the expiry sweep and the trial promotion with what is left, so neither can starve the other. */
export async function lessonsNightlyJob(deps: LessonsJobDeps, orgId: string, projects: readonly string[], budgetMs: number): Promise<Record<string, number>> {
  const started = deps.now();
  const reverts = await lessonsRevertJob(deps, orgId, projects, budgetMs / 2);
  const expiries = await lessonsExpireJob(deps, orgId, projects, Math.max(0, (budgetMs - (deps.now() - started)) / 2));
  const promotions = await lessonsPromoteJob(deps, orgId, projects, Math.max(0, budgetMs - (deps.now() - started)));
  return { ...reverts, ...expiries, ...promotions };
}
