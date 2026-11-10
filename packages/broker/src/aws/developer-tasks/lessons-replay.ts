// Lane 7 (0.5.12, DECISIONS 38, 49, 68): the replay COPY of a past task, for the lessons replay (`scripts/lessons-replay-measure.ts`). The operator routes (`/v1/admin/tasks/{taskId}/lessons-replay`, `aws/broker/admin-and-helpers.ts`)
// hand this module the past task and the operator's body; this module is the only place that makes a copy, and it makes it ONLY through `startTask` with `RunStartOptions.evalReplay`, which writes the task record with
// `evalRun: true`, its memory and its source in the same write. There is no body field, flag or route that starts a copy without the mark, and a copy has no way to start with live memory.
//
// What a copy is (decision 68): a WORKFLOW task, of the shape the past task had (its path), in the past task's project, so it goes through Understand, Plan, Implement, Verify and Review as the original did and the lessons
// are delivered at those stages. It is owned and started by the OPERATOR (a company owner or admin), never by the past task's member: it is a test (`origin: "test_run"`), so it is billed to the project, counted on the
// operator's testing allowance and held to the company's per-test cap, never to a member's budget or a personal plan. It is shared nowhere, refused every publication and announcement (`developer/eval-copy.ts`), and the
// lessons never learn from it (`lessons/eval-run.ts`). Its spend limit is the run's own `maxUsd`.
// Its plan is approved automatically, by `approveReplayPlan` below and nothing else: reachable only for a task that carries the replay mark, by the operator, and audited.
// What a copy is given: `memory` off (no lessons), or EXACTLY one frozen snapshot (`lessons/replay-snapshot-store.ts`): the dispatch loads that snapshot's lessons and nothing else (`lessons/load.ts`, `deliver.ts`).
// One audit line is written BEFORE the copy starts (ids, fixed words and counts only); if it cannot be written the copy is not started.
import { z } from "zod";
import type { EvalCopyMemorySchema} from "@agentx/contracts";
import { agentXError } from "@agentx/contracts";
import type { RunStartOptions } from "../../agents/runs.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { isEvalRunMark } from "../../lessons/eval-run.js";
import { emitAudit, requireAudit } from "../../lessons/policy.js";
import type { LessonAuditSink } from "../../lessons/ports.js";
import { buildSnapshot, snapshotIdOf, type EvalSnapshotStore, type SnapshotStore } from "../../lessons/replay-snapshot-store.js";
import type { LessonStore } from "../../lessons/store.js";
import { lessonContentKey } from "../../lessons/replay-lessonset.js";

const LessonRefSchema = z.object({ id: z.string().regex(/^les_[0-9a-f]{20}$/u), version: z.number().int().min(1) }).strict();
export const LessonsReplayStartSchema = z.object({
  requestId: z.string().uuid(),
  /** Off, or exactly one snapshot: an imported eval snapshot or an existing reference snapshot named by id, or one created from the live lesson versions listed (its id must be the one those versions make). */
  memory: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("off") }).strict(),
    z.object({ mode: z.literal("snapshot"), snapshotId: z.string().regex(/^snp_[0-9a-f]{20}$/u), lessons: z.array(LessonRefSchema).max(300).optional() }).strict(),
  ]),
  /** The run's own spend limit in US dollars: what the copy may spend once its plan is approved. Planning, before the approval, is held to the project's planning limit, so a copy's worst case is the two together (the harness reserves both). */
  maxUsd: z.number().positive().max(1000),
  /** The file arm: the install places the lessons file itself from the snapshot (`file: true`); a file's text is never accepted from the request. */
  file: z.literal(true).optional(),
}).strict();
export type LessonsReplayStart = z.infer<typeof LessonsReplayStartSchema>;

export interface ReplayCopyDeps {
  store: Pick<LessonStore, "versions" | "setVersion">;
  snapshots: SnapshotStore;
  evalSnapshots: EvalSnapshotStore;
  audit: LessonAuditSink;
  /** Starts the task as the operator (bound to the route's own dependencies). */
  start(body: Record<string, unknown>, run: RunStartOptions): Promise<{ task: { taskId: string } }>;
  /** The company's per-test cap in US dollars: a copy is a test, and a test stops there. */
  perTestCapUsd(): Promise<number>;
  now(): number;
}

export interface ReplayCopyStarted { taskId: string; evalRun: true; memory: LessonsReplayStart["memory"]["mode"]; snapshotId?: string }

/** What the copy is asked: the source task's request as stored, or its title. A task with neither has nothing to replay. */
export const requestOf = (source: Pick<DeveloperTaskRecord, "requestText" | "title">): string | undefined => {
  const text = (source.requestText ?? "").trim();
  return text !== "" ? text : source.title.trim() !== "" ? source.title.trim() : undefined;
};

export async function startReplayCopy(deps: ReplayCopyDeps, input: { source: DeveloperTaskRecord; orgId: string; operatorId: string; operatorDeveloperId: string; body: unknown }): Promise<ReplayCopyStarted> {
  const parsed = LessonsReplayStartSchema.safeParse(input.body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "the replay request is not valid");
  const body = parsed.data;
  const { source } = input;
  // A past task of a person's work only: not a copy, not an automatic run, not a setup or a diagnosis. Only a workflow task has the shape a copy repeats.
  if (isEvalRunMark(source.evalRun) || source.automatic !== undefined || source.purpose !== undefined || source.orgId !== input.orgId) throw agentXError("CONFIG_INVALID", "that task cannot be replayed");
  if (source.workflow === undefined) throw agentXError("CONFIG_INVALID", "that task has no workflow to repeat");
  const instructions = requestOf(source);
  if (instructions === undefined) throw agentXError("CONFIG_INVALID", "that task holds no request to replay");
  // A copy is a test: it stops at the company's per-test cap. A run limit above it would pause the copy partway; it is refused up front.
  const cap = await deps.perTestCapUsd();
  if (body.maxUsd > cap) throw agentXError("CONFIG_INVALID", `the per-test cap is $${cap.toFixed(2)}; raise it in Spending (and the testing allowance) before replaying with a higher limit`);
  const key = { workspaceId: input.orgId, project: source.project };

  let memory: z.infer<typeof EvalCopyMemorySchema>;
  let snapshotLessons = 0;
  if (body.memory.mode === "off") memory = { mode: "off" };
  else {
    const named = body.memory;
    const imported = await deps.evalSnapshots.get(key, named.snapshotId);
    let snapshot = imported === undefined ? await deps.snapshots.get(key, named.snapshotId) : undefined;
    if (imported === undefined && named.lessons !== undefined) {
      // Created from the live versions listed: each must exist in this project, and the id must be the one those versions make (an id cannot be made to name other lessons).
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
    if (imported === undefined && snapshot === undefined) throw agentXError("CONFIG_INVALID", "there is no such snapshot in this project");
    memory = { mode: "snapshot", snapshotId: named.snapshotId };
    snapshotLessons = imported?.lessons.length ?? snapshot?.lessons.length ?? 0;
  }
  if (body.file === true && memory.mode !== "snapshot") throw agentXError("CONFIG_INVALID", "the lessons file needs a snapshot to render");

  // The audit line first: a copy that cannot be recorded is not started.
  const audited = await requireAudit(deps.audit, {
    action: "lesson.replay_started", workspaceId: key.workspaceId, project: key.project,
    facts: { operator: input.operatorId, memory: memory.mode, snapshotLessons, maxCents: Math.round(body.maxUsd * 100), sourceTask: source.taskId },
  });
  if (!audited) throw agentXError("RUNTIME_UNAVAILABLE", "the replay could not be recorded in the audit ledger, so it was not started");

  const started = await deps.start(
    { requestId: body.requestId, project: source.project, instructions, title: `Lessons replay of ${source.taskId.slice(0, 8)}`, workflow: true, workflowPath: source.workflow.path },
    { origin: "test_run", autonomous: false, startedBy: { developerId: input.operatorDeveloperId }, runLimitUsd: body.maxUsd, evalReplay: { memory, sourceTaskId: source.taskId, ...(body.file === true ? { lessonsFile: true as const } : {}) } },
  );
  return { taskId: started.task.taskId, evalRun: true, memory: memory.mode, ...(memory.mode === "snapshot" ? { snapshotId: memory.snapshotId } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Where a copy stands, and its automatic plan approval

export type ReplayCopyState = "running" | "awaiting_plan" | "completed" | "failed";
/**
 * Where a copy stands, from its workflow (not from its latest operation, which ends after every step). `completed` only when the checks and the reviews are done and the code is READY to be published (the stage a
 * real task publishes from): the copy is never published, so that is where it stops. `failed` when it is blocked (nobody will unblock an unattended copy), closed or rejected. A plan waiting for approval is
 * `awaiting_plan` (the operator route approves it).
 */
export function copyStateOf(task: Pick<DeveloperTaskRecord, "workflow" | "closedAt">): ReplayCopyState {
  const workflow = task.workflow;
  if (workflow === undefined) return "running";
  if ((workflow.stage === "PULL_REQUEST" || workflow.stage === "WAIT_FOR_MERGE" || workflow.stage === "MERGED") && workflow.candidate !== undefined) return "completed";
  if (workflow.stage === "CLOSED" || workflow.outcome === "REJECTED" || workflow.outcome === "CLOSED" || task.closedAt !== undefined) return "failed";
  if (workflow.state === "BLOCKED") return "failed";
  if (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") return "awaiting_plan";
  return "running";
}

/** What approving the copy's plan needs: the workflow revision and the digest of the plan document the decision names. Undefined when no plan waits. */
export function planWaitingOf(task: Pick<DeveloperTaskRecord, "workflow">): { revision: number; digest: string } | undefined {
  const workflow = task.workflow;
  if (workflow === undefined || workflow.stage !== "PLAN_REVIEW" || workflow.state !== "WAITING") return undefined;
  const plan = [...workflow.artifacts].reverse().find((artifact) => artifact.type === "plan");
  return plan === undefined ? undefined : { revision: workflow.revision, digest: plan.sha256 };
}

/** What the operator reads of a copy (and the harness's port): the mark as stored, where it stands and what it loaded, by content key. Never lesson text. */
export interface ReplayCopyView {
  taskId: string;
  /** The copy's workspace, for the operator's cancel. */
  workspaceId: string;
  /** The `evalRun` field of the record, as stored. */
  evalRun: unknown;
  state: ReplayCopyState;
  /** The copy's workflow stage and state, as fixed words. */
  stage?: string;
  costUsd: number | null;
  /** Learning model calls charged to the copy, counted from the spend records (null: they could not be read). Any other number than 0 stops the replay. */
  learningCalls: number | null;
  loadedKeys: string[];
}

export async function replayCopyView(deps: { store: Pick<LessonStore, "manifests" | "versions">; evalSnapshots?: EvalSnapshotStore | undefined; learningCalls?: (taskId: string) => Promise<number | null> }, task: DeveloperTaskRecord, orgId: string, costUsd: number | null): Promise<ReplayCopyView> {
  const key = { workspaceId: orgId, project: task.project };
  const keys = new Set<string>();
  const imported = task.evalMemory?.mode === "snapshot" ? await deps.evalSnapshots?.get(key, task.evalMemory.snapshotId) : undefined;
  for (const manifest of await deps.store.manifests(key, task.taskId)) {
    if (manifest.memory !== "snapshot") continue;
    for (const entry of manifest.lessons) {
      const lesson = imported?.lessons.find((l) => l.id === entry.id && l.version === entry.version) ?? (await deps.store.versions(key, entry.id)).find((version) => version.version === entry.version);
      if (lesson !== undefined) keys.add(lessonContentKey(lesson));
    }
  }
  return {
    taskId: task.taskId, workspaceId: task.workspaceId, evalRun: task.evalRun, state: copyStateOf(task), ...(task.workflow === undefined ? {} : { stage: `${task.workflow.stage}/${task.workflow.state}` }), costUsd,
    learningCalls: deps.learningCalls === undefined ? null : await deps.learningCalls(task.taskId).catch(() => null), loadedKeys: [...keys].sort(),
  };
}
