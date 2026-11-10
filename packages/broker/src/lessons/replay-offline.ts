// Lane 7 (DECISIONS 68): the OFFLINE lesson pipeline of an arm. Each arm learns from the SAME historical tasks, in time order, from their ORIGINAL outcomes only (a replayed copy is never among them: a copy's subject is
// refused by the reflector). Pipeline B is the current one: the reflector, then the curator (similarity, the judge, tiers, trial) into a fresh in-memory lesson store that is nobody's live set. After each
// simulated day the store's active lessons are the arm's snapshot for that day (`replay-harness.ts#buildSnapshots`); the harness imports them as frozen snapshots (`agentx admin lessons-replay import-snapshot`).
// Every model call goes through `model` (the company's own model path, `eval-model.ts`) and is counted: the arm's learning cost is a real number that the run's budget includes.
// What this approximates, stated in the report: citations are not verified against the repository (no repository is read offline; the worker re-checks each cited line at the copy's base commit), there is no
// embedder (the shortlist is keywords and cited paths), and settings are the Standard preset with the project's mode On, and every lesson the pipeline proposes is treated as approved by a person (nobody decides offline).
// Pipeline C (the consolidation pass, lane 8) has no builder yet: `consolidatedBuilderStub` refuses by name.
import { ArmNotBuiltError, type SnapshotBuilder, type SnapshotRequest, type SnapshotResult } from "./replay-harness.js";
import { processDraft, type ProcessDeps } from "./process.js";
import { InMemoryLessonStore, type ScopeKey } from "./store.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { ReflectSubject } from "./reflect-input.js";
import type { LearningSettingsReader } from "./policy.js";
import type { CitationVerifier, CodeFacts, LearningSpend, LessonAuditSink, LessonVectors, PipelineModel } from "./ports.js";
import type { ReplayCandidate } from "./replay-select.js";
import { EVAL_SNAPSHOT_MAX_LESSONS } from "./replay-snapshot-store.js";

export interface OfflineBuilderDeps {
  key: ScopeKey;
  /** A historical task's subject as the reflector sees it at the task's end (its spans, trusts and outcome). Undefined: the task teaches nothing. Never a replay copy (the reflector refuses those). */
  subjectOf(taskId: string): Promise<ReflectSubject | undefined>;
  /** The company's own model path (reflector and judge). Its cost is read from each reply. */
  model: PipelineModel;
  /** The learning settings the pipeline runs under; default: Standard preset, mode On. */
  settings?: LearningSettingsReader;
  /** Which of the project's repositories exist (for the curator's scope check). */
  repositories: readonly string[];
}

const DAY = 86_400_000;
const NO_VECTORS: LessonVectors = { get: async () => new Map(), put: async () => undefined, remove: async () => undefined };
const NO_AUDIT: LessonAuditSink = { emit: async () => undefined };
const UNLIMITED: LearningSpend = { admit: async () => true, look: async () => "ok" };
const UNCHECKED: CitationVerifier = { verify: async () => ({ result: "unknown" }) as never };

export function offlinePipelineBuilder(deps: OfflineBuilderDeps): SnapshotBuilder {
  const store = new InMemoryLessonStore();
  const done = new Set<string>();
  let usd = 0, calls = 0;
  let clock = 0;
  const model: PipelineModel = {
    ...(deps.model.quote === undefined ? {} : { quote: deps.model.quote.bind(deps.model) }),
    complete: async (request) => { const reply = await deps.model.complete(request); usd += reply.costUsd; calls += 1; return reply; },
  };
  const settings: LearningSettingsReader = deps.settings ?? { read: async () => ({ mode: "On", preset: "standard" }) };
  const facts: CodeFacts = { identifiers: async () => undefined, pathExists: async () => undefined, repositories: async () => [...deps.repositories] };
  let counter = 0;
  const now = (): number => clock;
  const reflect: ReflectDeps = { model, spend: UNLIMITED, audit: NO_AUDIT, settings, edition: "enterprise", now, newId: () => `offline-${String(++counter)}` };
  const process: ProcessDeps = { store, embedder: undefined, vectors: NO_VECTORS, judgeModel: model, spend: UNLIMITED, audit: NO_AUDIT, now, verifier: UNCHECKED, facts, settings, newId: () => `les_${(++counter).toString(16).padStart(20, "0")}` };
  return {
    async build(request: SnapshotRequest): Promise<SnapshotResult> {
      const before = { usd, calls };
      const dayStart = Date.parse(`${request.day}T00:00:00.000Z`);
      for (const task of [...request.historical].sort((a: ReplayCandidate, b: ReplayCandidate) => a.at - b.at || (a.taskId < b.taskId ? -1 : 1))) {
        if (done.has(task.taskId)) continue;
        done.add(task.taskId);
        // The pipeline's own clock is the simulated time the task ended (never later than the day it builds for).
        clock = Math.min(task.at + DAY, dayStart);
        const subject = await deps.subjectOf(task.taskId);
        if (subject === undefined) continue;
        const reflected = await reflectSubject(reflect, subject);
        if (reflected.status !== "ok") continue;
        for (const draft of reflected.drafts) await processDraft(process, deps.key, draft).catch(() => undefined);
      }
      clock = dayStart;
      // The approval policy of an offline replay: every lesson the pipeline PROPOSES is treated as approved by a person (the live pipeline puts them in front of people; here nobody decides). The replay measures the
      // lessons each pipeline makes, not people's approval habits. Lessons that were retired, rejected, withdrawn, expired or stale are left out; the newest EVAL_SNAPSHOT_MAX_LESSONS are kept.
      const proposed = (await store.list(deps.key)).filter((lesson) => lesson.status === "active" || lesson.status === "pending" || lesson.status === "candidate");
      const lessons = proposed.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)).slice(0, EVAL_SNAPSHOT_MAX_LESSONS)
        .map((lesson) => ({ ...lesson, status: "active" as const, approvals: lesson.approvals.length > 0 ? lesson.approvals : [{ approvalId: "offline-replay", by: "offline-replay", at: dayStart, mode: "one" as const }], expiresAt: Math.max(lesson.expiresAt, dayStart + 90 * DAY) }));
      return { snapshotId: "", lessons, costUsd: usd - before.usd, calls: calls - before.calls };
    },
  };
}

/** Pipeline C: the reflector's capture plus the nightly consolidation pass (lane 8). Not built; a replay with this arm refuses by name. */
export const consolidatedBuilderStub: SnapshotBuilder = {
  async build(): Promise<SnapshotResult> { throw new ArmNotBuiltError("on:consolidated", "the consolidation pass (lane 8) is not built yet, so its lessons cannot be made offline."); },
};
