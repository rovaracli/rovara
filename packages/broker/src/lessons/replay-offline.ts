// Lane 7 (DECISIONS 68; re-check "faithful B"): the OFFLINE lesson pipeline of an arm. Each arm learns from the SAME historical tasks, in time order, from their ORIGINAL outcomes only (a replayed copy is never among them: a copy's
// subject is refused by the reflector). Pipeline B is the current one: the real reflector, then the real curator (similarity, the judge, tiers, the trial rules, the citation check) into a fresh in-memory lesson store that is
// nobody's live set, UNDER THE PROJECT'S REAL SETTINGS (read through the install: mode, preset, the approval each tier needs, the company's floor and lock, whether auto-apply is on). After each simulated day the store is
// exported by the one rule every arm uses (`replay-export.ts`): only what is ACTIVE and would be delivered WITHOUT a person under those rules. What the pipeline proposed that would have needed a person is counted and reported
// per arm, not delivered. Every model call goes through `model` (the company's own model path, `eval-model.ts`) and is counted; a call that fails is counted too (`droppedCalls`), never silently lost.
// What this still approximates, stated in the report: without a `verifier` and `facts` over a checkout (the staging module passes ones that read the operator's clones at the cited commit) citations are not checked; without an
// `embedder` the shortlist is keywords and cited paths (as on an install that has none). The offline run assumes the install's lessons switch is ON (that is the question the replay asks) and the auto-apply switch as the install has it.
// Pipeline C (the consolidation pass, lane 8) has no builder yet: `consolidatedBuilderStub` refuses by name; when it is ported it MUST export through `exportWithoutAPerson` (the harness refuses a builder that does not).
import { ArmNotBuiltError, type SnapshotBuilder, type SnapshotRequest, type SnapshotResult } from "./replay-harness.js";
import { processDraft, type ProcessDeps } from "./process.js";
import { InMemoryLessonStore, type ScopeKey } from "./store.js";
import { reflectSubject, type ReflectDeps } from "./reflect.js";
import type { ReflectSubject } from "./reflect-input.js";
import { autoApplyOn, modeAllows, resolveLearning, setAutoApplyGate, setLearnedLessonsGate, type LearningSettingsReader } from "./policy.js";
import type { CitationVerifier, CodeFacts, LearningSpend, LessonAuditSink, LessonEmbedder, LessonVectors, PipelineModel } from "./ports.js";
import { exportWithoutAPerson } from "./replay-export.js";
import type { ReplayCandidate } from "./replay-select.js";

export interface OfflineBuilderDeps {
  key: ScopeKey;
  /** A historical task's subject as the reflector sees it at the task's end (its spans, trusts and outcome). Undefined: the task teaches nothing. Never a replay copy (the reflector refuses those). */
  subjectOf(taskId: string): Promise<ReflectSubject | undefined>;
  /** The company's own model path (reflector and judge). Its cost is read from each reply. */
  model: PipelineModel;
  /** The project's REAL learning settings (read through the install). The pipeline runs under exactly these. */
  settings: LearningSettingsReader;
  /** Whether the install's auto-apply switch is on (read through the install with the settings). */
  autoApply: boolean;
  /** Which of the project's repositories exist (for the curator's scope check). */
  repositories: readonly string[];
  /** The install's embedder and where its vectors are kept, together; absent (as on an install without one): keywords and cited paths. */
  similarity?: { embedder: LessonEmbedder; vectors: LessonVectors };
  /** The real citation check and code facts, over a checkout at the cited commit. Absent: citations are "unknown" (so nothing is tier 0 on a verified citation) and the report says so. */
  code?: { verifier: CitationVerifier; facts: CodeFacts };
}

const DAY = 86_400_000;
const NO_VECTORS: LessonVectors = { get: async () => new Map(), put: async () => undefined, remove: async () => undefined };
const NO_AUDIT: LessonAuditSink = { emit: async () => undefined };
const UNLIMITED: LearningSpend = { admit: async () => true, look: async () => "ok" };
const UNCHECKED: CitationVerifier = { verify: async () => ({ result: "unknown" }) as never };

/** Runs `run` with the lessons switch ON and the auto-apply switch as the install has it (process-local: this is the operator's offline run, not the install), and puts both back. */
async function underInstallGates<T>(autoApply: boolean, run: () => Promise<T>): Promise<T> {
  const before = autoApplyOn();
  setLearnedLessonsGate(() => true);
  setAutoApplyGate(() => autoApply);
  try { return await run(); } finally { setLearnedLessonsGate(undefined); setAutoApplyGate(() => before); }
}

export function offlinePipelineBuilder(deps: OfflineBuilderDeps): SnapshotBuilder {
  const store = new InMemoryLessonStore();
  const done = new Set<string>();
  let usd = 0, calls = 0, dropped = 0;
  let clock = 0;
  const model: PipelineModel = {
    ...(deps.model.quote === undefined ? {} : { quote: deps.model.quote.bind(deps.model) }),
    complete: async (request) => {
      try { const reply = await deps.model.complete(request); usd += reply.costUsd; calls += 1; return reply; } catch (error) { dropped += 1; throw error; }
    },
  };
  const facts: CodeFacts = deps.code?.facts ?? { identifiers: async () => undefined, pathExists: async () => undefined, repositories: async () => [...deps.repositories] };
  let counter = 0;
  const now = (): number => clock;
  const reflect: ReflectDeps = { model, spend: UNLIMITED, audit: NO_AUDIT, settings: deps.settings, edition: "enterprise", now, newId: () => `offline-${String(++counter)}` };
  const process: ProcessDeps = {
    store, embedder: deps.similarity?.embedder, vectors: deps.similarity?.vectors ?? NO_VECTORS, judgeModel: model, spend: UNLIMITED, audit: NO_AUDIT, now, verifier: deps.code?.verifier ?? UNCHECKED, facts,
    settings: deps.settings, newId: () => `les_${(++counter).toString(16).padStart(20, "0")}`,
  };
  return {
    build: (request: SnapshotRequest): Promise<SnapshotResult> => underInstallGates(deps.autoApply, async () => {
      const resolved = await resolveLearning(deps.settings, deps.key.workspaceId, deps.key.project);
      // The project does not let lessons be made (Off or Collect, or its settings do not read): the pipeline would learn nothing, and an empty arm must not pass for a result.
      if (!modeAllows(resolved.mode, "reflect")) throw new ArmNotBuiltError(`on:${request.pipeline}`, `the project's learning mode is ${resolved.chosenMode}, which does not make lessons: set it to Suggest or On before the replay.`);
      const before = { usd, calls, dropped };
      const dayStart = Date.parse(`${request.day}T00:00:00.000Z`);
      for (const task of [...request.historical].sort((a: ReplayCandidate, b: ReplayCandidate) => a.at - b.at || (a.taskId < b.taskId ? -1 : 1))) {
        if (done.has(task.taskId)) continue;
        done.add(task.taskId);
        // The pipeline's own clock is the simulated time the task ended (never later than the day it builds for).
        clock = Math.min(task.at + DAY, dayStart);
        const subject = await deps.subjectOf(task.taskId);
        if (subject === undefined) continue;
        let reflected: Awaited<ReturnType<typeof reflectSubject>>;
        try { reflected = await reflectSubject(reflect, subject); } catch { dropped += 1; continue; }
        if (reflected.status !== "ok") continue;
        for (const draft of reflected.drafts) await processDraft(process, deps.key, draft).catch(() => { dropped += 1; });
      }
      clock = dayStart;
      const exported = exportWithoutAPerson({ lessons: await store.list(deps.key), approval: resolved.approval, trialAllowed: resolved.trialAllowed });
      return { snapshotId: "", lessons: exported.lessons, costUsd: usd - before.usd, calls: calls - before.calls,
        export: { rule: exported.rule, proposed: exported.proposed, needsPerson: exported.needsPerson, truncated: exported.truncated, droppedCalls: dropped - before.dropped } };
    }),
  };
}

/** Pipeline C: the reflector's capture plus the nightly consolidation pass (lane 8). Not built; a replay with this arm refuses by name. */
export const consolidatedBuilderStub: SnapshotBuilder = {
  async build(): Promise<SnapshotResult> { throw new ArmNotBuiltError("on:consolidated", "the consolidation pass (lane 8) is not built yet, so its lessons cannot be made offline."); },
};
