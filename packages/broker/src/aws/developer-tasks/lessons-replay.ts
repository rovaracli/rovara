// Lane 7 (0.5.12): the replay COPY of a past task, for the lessons replay (`scripts/lessons-replay-measure.ts`). An operator route (`POST /v1/admin/tasks/{taskId}/lessons-replay`, `aws/broker/admin-and-helpers.ts`)
// hands this module the past task and the operator's body; this module is the only place that makes a copy, and it makes it ONLY through `startTask` with `RunStartOptions.evalReplay`, which writes the task record with
// `evalRun: true` and the copy's memory in the same write. There is no body field, flag or route that starts a copy without the mark, and a copy has no way to start with live memory.
//
// What a copy is: a plain start of the source task's request in the source task's project (the same repositories, workspace limits and preparation as any start), owned by the source task's owner as the e2e replay is,
// shared nowhere, with its spend limit set to the run's `maxUsd` (so it spends the company's model money like other replays, never more than the run's own budget). It is refused every publication and announcement
// (`developer/eval-copy.ts`: no pull request, no Slack, no tracker comment, no Team record row), and the lessons never learn from it (`lessons/eval-run.ts`).
// What a copy is given: `memory` off (no lessons), or EXACTLY one frozen snapshot (`lessons/replay-snapshot-store.ts`): the dispatch loads that snapshot's lessons and nothing else (`lessons/load.ts`, `deliver.ts`).
// One audit line is written BEFORE the copy starts (ids, fixed words and counts only); if it cannot be written the copy is not started.
// TODO: the file arm (the lessons file placed in the copy's checkout) needs the worker to write a file into the checkout; the route refuses it by name until it can.
import { z } from "zod";
import type { EvalCopyMemorySchema} from "@agentx/contracts";
import { agentXError } from "@agentx/contracts";
import type { RunStartOptions } from "../../agents/runs.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { isEvalRunMark } from "../../lessons/eval-run.js";
import { emitAudit, requireAudit } from "../../lessons/policy.js";
import type { LessonAuditSink } from "../../lessons/ports.js";
import { buildSnapshot, snapshotIdOf, type SnapshotStore } from "../../lessons/replay-snapshot-store.js";
import type { LessonStore } from "../../lessons/store.js";
import { lessonContentKey } from "../../lessons/replay-lessonset.js";

const LessonRefSchema = z.object({ id: z.string().regex(/^les_[0-9a-f]{20}$/u), version: z.number().int().min(1) }).strict();
export const LessonsReplayStartSchema = z.object({
  requestId: z.string().uuid(),
  /** Off, or exactly one snapshot: named by id (it must exist), or created from the lesson versions listed (its id must be the one those versions make). */
  memory: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("off") }).strict(),
    z.object({ mode: z.literal("snapshot"), snapshotId: z.string().regex(/^snp_[0-9a-f]{20}$/u), lessons: z.array(LessonRefSchema).max(300).optional() }).strict(),
  ]),
  /** The run's own spend limit in US dollars: the copy cannot spend more. */
  maxUsd: z.number().positive().max(1000),
  /** The file arm: not built; refused by name. */
  lessonsFile: z.unknown().optional(),
}).strict();
export type LessonsReplayStart = z.infer<typeof LessonsReplayStartSchema>;

export interface ReplayCopyDeps {
  store: Pick<LessonStore, "versions" | "setVersion">;
  snapshots: SnapshotStore;
  audit: LessonAuditSink;
  /** Starts the task as the source task's owner (bound to the route's own dependencies). */
  start(body: { requestId: string; project: string; instructions: string; title: string }, run: RunStartOptions): Promise<{ task: { taskId: string } }>;
  now(): number;
}

export interface ReplayCopyStarted { taskId: string; evalRun: true; memory: LessonsReplayStart["memory"]["mode"]; snapshotId?: string }

/** What the copy is asked: the source task's request as stored, or its title. A task with neither has nothing to replay. */
export const requestOf = (source: Pick<DeveloperTaskRecord, "requestText" | "title">): string | undefined => {
  const text = (source.requestText ?? "").trim();
  return text !== "" ? text : source.title.trim() !== "" ? source.title.trim() : undefined;
};

export async function startReplayCopy(deps: ReplayCopyDeps, input: { source: DeveloperTaskRecord; orgId: string; operatorId: string; body: unknown }): Promise<ReplayCopyStarted> {
  const parsed = LessonsReplayStartSchema.safeParse(input.body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the replay request is not valid");
  const body = parsed.data;
  if (body.lessonsFile !== undefined) throw agentXError("CONFIG_INVALID", "file-arm-not-built: a replay copy cannot be given a lessons file in its checkout yet");
  const { source } = input;
  // A past task of a person's work only: not a copy, not an automatic run, not a setup or a diagnosis.
  if (isEvalRunMark(source.evalRun) || source.automatic !== undefined || source.purpose !== undefined || source.orgId !== input.orgId) throw agentXError("CONFIG_INVALID", "that task cannot be replayed");
  const instructions = requestOf(source);
  if (instructions === undefined) throw agentXError("CONFIG_INVALID", "that task holds no request to replay");
  const key = { workspaceId: input.orgId, project: source.project };

  let memory: z.infer<typeof EvalCopyMemorySchema>;
  let snapshotLessons = 0;
  if (body.memory.mode === "off") memory = { mode: "off" };
  else {
    const named = body.memory;
    let snapshot = await deps.snapshots.get(key, named.snapshotId);
    if (named.lessons !== undefined) {
      // Created from the versions listed: each must exist in this project, and the id must be the one those versions make (an id cannot be made to name other lessons).
      for (const ref of named.lessons) {
        if (!(await deps.store.versions(key, ref.id)).some((version) => version.version === ref.version && version.workspaceId === key.workspaceId && version.project === key.project)) throw agentXError("CONFIG_INVALID", "the snapshot names a lesson that does not exist in this project");
      }
      if (snapshotIdOf(key, named.lessons) !== named.snapshotId) throw agentXError("CONFIG_INVALID", "the snapshot id is not the one those lessons make");
      if (snapshot === undefined) {
        snapshot = buildSnapshot({ key, refs: named.lessons, createdBy: input.operatorId, at: new Date(deps.now()).toISOString(), lessonSetVersion: await deps.store.setVersion(key) });
        await deps.snapshots.put(snapshot);
        await emitAudit(deps.audit, { action: "lesson.snapshot_created", workspaceId: key.workspaceId, project: key.project, facts: { lessonSetVersion: snapshot.lessonSetVersion, lessonCount: snapshot.lessons.length } });
      }
    }
    if (snapshot === undefined) throw agentXError("CONFIG_INVALID", "there is no such snapshot in this project");
    memory = { mode: "snapshot", snapshotId: snapshot.snapshotId };
    snapshotLessons = snapshot.lessons.length;
  }

  // The audit line first: a copy that cannot be recorded is not started.
  const audited = await requireAudit(deps.audit, {
    action: "lesson.replay_started", workspaceId: key.workspaceId, project: key.project,
    facts: { operator: input.operatorId, memory: memory.mode, snapshotLessons, maxCents: Math.round(body.maxUsd * 100), sourceTask: source.taskId },
  });
  if (!audited) throw agentXError("RUNTIME_UNAVAILABLE", "the replay could not be recorded in the audit ledger, so it was not started");

  const started = await deps.start(
    { requestId: body.requestId, project: source.project, instructions, title: `Lessons replay of ${source.taskId.slice(0, 8)}` },
    { origin: "cli", autonomous: false, runLimitUsd: body.maxUsd, evalReplay: { memory } },
  );
  return { taskId: started.task.taskId, evalRun: true, memory: memory.mode, ...(memory.mode === "snapshot" ? { snapshotId: memory.snapshotId } : {}) };
}

/** What the operator reads of a copy (and the harness's port): the mark as stored, where it stands and what it loaded, by content key. Never lesson text. */
export interface ReplayCopyView {
  taskId: string;
  /** The copy's workspace, for the operator's cancel. */
  workspaceId: string;
  /** The `evalRun` field of the record, as stored. */
  evalRun: unknown;
  state: "running" | "completed" | "failed";
  costUsd: number | null;
  /** Learning calls a copy makes: none by construction (every learning path refuses a marked task). */
  learningCalls: 0;
  loadedKeys: string[];
}

export async function replayCopyView(deps: { store: Pick<LessonStore, "manifests" | "versions"> }, task: DeveloperTaskRecord, orgId: string, state: ReplayCopyView["state"], costUsd: number | null): Promise<ReplayCopyView> {
  const key = { workspaceId: orgId, project: task.project };
  const keys = new Set<string>();
  for (const manifest of await deps.store.manifests(key, task.taskId)) {
    if (manifest.memory !== "snapshot") continue;
    for (const entry of manifest.lessons) {
      const lesson = (await deps.store.versions(key, entry.id)).find((version) => version.version === entry.version);
      if (lesson !== undefined) keys.add(lessonContentKey(lesson));
    }
  }
  return { taskId: task.taskId, workspaceId: task.workspaceId, evalRun: task.evalRun, state, costUsd, learningCalls: 0, loadedKeys: [...keys].sort() };
}
