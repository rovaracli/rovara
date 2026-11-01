// Learning v2 L5: helpful and harmful counters, stale handling and auto-retire (design §4.6). Counters come from outcomes (merge, send-backs, reviews,
// reverts) and from two buttons on the task page ("Helpful", "Wrong here"). Every mark is idempotent per task and lesson. The judge model is tool-less and
// answers a fixed code; it can only add a harmful mark or withhold a helpful one, never approve or lower a tier.
import { resolveLearning, emitAudit, modeAllows, type LearningSettingsReader } from "./policy.js";
import type { AlertSink, CorrectionJudge, CorrectionKind, LessonDeps } from "./ports.js";
import { renewLesson } from "./expiry.js";
import { retireLesson } from "./curate.js";
import { nextVersion, type LessonStore, type LoadManifest, type ScopeKey } from "./store.js";
import { cleanForLearning, globToRegExp } from "./guards.js";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { readVisible, type LessonLog } from "./read-visible.js";
import type { IdentitySet, Lesson } from "./types.js";
import type { LoadReport } from "@agentx/contracts";

const DAY = 86_400_000;
export const REVERT_WINDOW_MS = 14 * DAY;
export const STALE_WINDOW_MS = 14 * DAY;
export const STALE_LIMIT = 3;
const MAX_JUDGE_CALLS_PER_TASK = 20;
const MAX_CORRECTIONS_PER_LESSON = 5;

/** Only a lesson the worker reported as having reached the prompt counts for anything: loaded, helpful, harmful. A dropped or unreported lesson never ran. */
const REACHED_PROMPT: ReadonlySet<string> = new Set(["valid", "moved", "none"]);
const reached = (manifests: readonly LoadManifest[]): Set<string> => new Set(manifests.flatMap((m) => m.lessons.filter((e) => REACHED_PROMPT.has(e.citation)).map((e) => e.id)));

export interface CounterDeps extends LessonDeps { store: LessonStore; judge: CorrectionJudge; settings: LearningSettingsReader; alerts?: AlertSink }

export interface TaskCorrection { kind: CorrectionKind; /** Files the correction touches, for scope matching. */ paths: readonly string[]; text: string; at: number }
export interface TaskOutcome {
  workspaceId: string; project: string; taskId: string; outcome: "merged" | "closed" | "abandoned" | "reverted"; sendBacks: number; mergedAt?: number;
  corrections: readonly TaskCorrection[];
  /** An eval run writes no counters (design §4.13). */
  evalRun?: boolean;
}

/** A correction is in a lesson's scope when the lesson has no path scope (a repository-wide lesson) or one of the correction's files matches. */
const inScope = (lesson: Lesson, correction: TaskCorrection): boolean => {
  const paths = lesson.scope.paths ?? [];
  if (paths.length === 0) return true;
  const expressions = paths.map(globToRegExp);
  return correction.paths.some((p) => expressions.some((re) => re.test(p)));
};

/** Adds one harmful mark and runs the auto-retire rule: harmful at least 2 and more than helpful. Tier 0 retires at once; others go to a person. */
async function addHarmful(deps: CounterDeps, key: ScopeKey, lessonId: string, forceProposal: boolean): Promise<void> {
  const updated = await deps.store.mutate(key, lessonId, (l) => ({ counters: { ...l.counters, harmful: l.counters.harmful + 1 } }));
  if (updated === undefined) return;
  const failing = updated.counters.harmful >= 2 && updated.counters.harmful > updated.counters.helpful;
  if (failing && updated.tier === 0 && updated.status === "active") {
    await retireLesson(deps, key, lessonId, "harmful_counters", undefined, "lesson.auto_retired");
    return;
  }
  if ((failing || forceProposal) && updated.status === "active" && updated.retireProposedAt === undefined) {
    await deps.store.mutate(key, lessonId, () => ({ retireProposedAt: deps.now() }));
    await emitAudit(deps.audit, { action: "lesson.retire_proposed", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { harmful: updated.counters.harmful, helpful: updated.counters.helpful } });
    try { await deps.alerts?.alert(key.workspaceId, key.project, "retire_proposed"); } catch { /* the proposal is stored */ }
  }
}

async function addHelpful(deps: CounterDeps, key: ScopeKey, lessonId: string, expiryDays: number | undefined): Promise<void> {
  const now = deps.now();
  const updated = await deps.store.mutate(key, lessonId, (l) => ({ counters: { ...l.counters, helpful: l.counters.helpful + 1 }, lastHelpfulAt: now }));
  if (updated !== undefined) await renewLesson(deps.store, key, lessonId, now, expiryDays, "helpful");
}

/**
 * Called when a task reaches a terminal state, and again if its outcome changes (a revert). For each lesson that was loaded for the task, corrections in
 * the lesson's scope are rated by the judge; a lesson that caused or contradicted a correction gets a harmful mark. A merged task with at most one
 * send-back and no such correction queues a helpful mark for when the 14-day revert window has passed.
 */
export async function recordTaskOutcome(deps: CounterDeps, outcome: TaskOutcome): Promise<{ harmful: string[]; queuedHelpful: string[] }> {
  const result = { harmful: [] as string[], queuedHelpful: [] as string[] };
  if (outcome.evalRun === true) return result;
  const key: ScopeKey = { workspaceId: outcome.workspaceId, project: outcome.project };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.mode, "load")) return result;

  const loaded = new Set<string>();
  for (const id of reached(await deps.store.manifests(key, outcome.taskId))) loaded.add(id);
  let judgeCalls = 0;
  for (const lessonId of [...loaded].sort()) {
    const lesson = await deps.store.get(key, lessonId);
    if (lesson === undefined) continue;
    let blamed = false;
    let unjudged = false;
    let ignored = false;
    for (const correction of outcome.corrections.filter((c) => inScope(lesson, c)).slice(0, MAX_CORRECTIONS_PER_LESSON)) {
      if (judgeCalls >= MAX_JUDGE_CALLS_PER_TASK) { unjudged = true; continue; }
      judgeCalls += 1;
      let rating: Awaited<ReturnType<CorrectionJudge["rate"]>> | undefined;
      try { rating = await deps.judge.rate({ lesson, correctionKind: correction.kind, correctionText: cleanForLearning(correction.text, 1500) }); } catch { rating = undefined; }
      if (rating === undefined) { unjudged = true; continue; }
      if (rating === "caused" || rating === "contradicts") blamed = true;
      if (rating === "same_ignored") { ignored = true; deps.metrics?.count("learning.loaded_but_ignored"); }
    }
    if (blamed) {
      if (await deps.store.markOnce(key, `harmful:${outcome.taskId}:${lessonId}`)) { await addHarmful(deps, key, lessonId, false); result.harmful.push(lessonId); }
      await deps.store.removePending(key, `helpful:${outcome.taskId}:${lessonId}`);
      continue;
    }
    if (outcome.outcome === "reverted") { await deps.store.removePending(key, `helpful:${outcome.taskId}:${lessonId}`); continue; }
    if (outcome.outcome === "merged" && outcome.sendBacks <= 1 && !unjudged && !ignored) {
      await deps.store.addPending({ key: `helpful:${outcome.taskId}:${lessonId}`, workspaceId: key.workspaceId, project: key.project, lessonId, taskId: outcome.taskId, dueAt: (outcome.mergedAt ?? deps.now()) + REVERT_WINDOW_MS });
      result.queuedHelpful.push(lessonId);
    }
  }
  return result;
}

/** Applies the helpful marks whose revert window has passed without a revert. Idempotent; bounded to `limit` per run. */
export async function settleHelpful(deps: CounterDeps, key: ScopeKey, limit = 200): Promise<number> {
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  let applied = 0;
  for (const entry of await deps.store.duePending(key, deps.now(), limit)) {
    if (await deps.store.markOnce(key, `helpful-final:${entry.taskId}:${entry.lessonId}`)) { await addHelpful(deps, key, entry.lessonId, resolved.expiryDays); applied += 1; }
    await deps.store.removePending(key, entry.key);
  }
  return applied;
}

export type FeedbackFailure = "not_loaded" | "not_found" | "repeat" | "not_permitted";
/** The task page's "Helpful" and "Wrong here". A person can mark a lesson only for a task it was loaded into, once per person. */
export async function recordFeedback(deps: CounterDeps & { access: AccessCheckPort; log?: LessonLog }, input: { workspaceId: string; project: string; taskId: string; lessonId: string; userId: string; /** What the person is in the sources (their linked ids), for the access check. */ viewer: IdentitySet; kind: "helpful" | "wrong_here" }): Promise<{ ok: true } | { ok: false; code: FeedbackFailure }> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const manifests = await deps.store.manifests(key, input.taskId);
  if (!reached(manifests).has(input.lessonId)) return { ok: false, code: "not_loaded" };
  const lesson = await deps.store.get(key, input.lessonId);
  if (lesson === undefined) return { ok: false, code: "not_found" };
  // Only a person who can read the lesson now can mark it (frozen snapshot AND the access records); an unreadable record is a no. So the two "wrong here" marks that auto-retire a lesson
  // always come from people with access.
  const permitted = await readVisible({ access: deps.access, key, viewer: input.viewer, lessons: [lesson], where: "feedback", log: deps.log }).then((list) => list.length === 1, () => false);
  if (!permitted) return { ok: false, code: "not_permitted" };
  // One mark per person per lesson (either kind, any task), made under a random reference that erasure deletes: a person cannot retire a lesson alone by marking it on several tasks, and the
  // stored key names nobody once they are erased.
  const ref = await deps.store.markRef(key, input.userId);
  if (ref === undefined) return { ok: false, code: "not_permitted" };
  if (!(await deps.store.markOnce(key, `feedback:${input.lessonId}:${ref}`))) return { ok: false, code: "repeat" };
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (input.kind === "helpful") await addHelpful(deps, key, input.lessonId, resolved.expiryDays);
  else await addHarmful(deps, key, input.lessonId, true);
  await emitAudit(deps.audit, { action: input.kind === "helpful" ? "lesson.helpful" : "lesson.wrong_here", workspaceId: key.workspaceId, project: key.project, lessonId: input.lessonId, actor: input.userId, facts: { task: input.taskId } });
  return { ok: true };
}

/**
 * Applies the worker's load report for one stage: validated lessons are renewed (facts) and stamped, moved citations are corrected as a new lesson
 * version, stale ones count toward the stale limit (3 in 14 days makes the lesson `stale`), and lessons whose check did not finish are left alone.
 * Only lessons named in the stage's manifest are touched, whatever the report says.
 */
export async function applyLoadReport(deps: CounterDeps, input: { workspaceId: string; project: string; taskId: string; stage: LoadManifest["stage"]; round: number; report: LoadReport }): Promise<void> {
  const key: ScopeKey = { workspaceId: input.workspaceId, project: input.project };
  const manifest = (await deps.store.manifests(key, input.taskId)).find((m) => m.stage === input.stage && m.round === input.round);
  if (manifest === undefined || input.report.stage !== input.stage) return;
  if (!(await deps.store.markOnce(key, `report:${input.taskId}:${input.stage}:${input.round}`))) return;
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  const now = deps.now();
  const entries = new Map(manifest.lessons.map((e) => [e.id, e] as const));
  for (const reported of input.report.lessons) {
    const entry = entries.get(reported.id);
    if (entry === undefined || entry.version !== reported.version) continue;
    entry.citation = reported.citation;
    if (reported.citation === "valid" || reported.citation === "none" || reported.citation === "moved") {
      if (await deps.store.markOnce(key, `loaded:${input.taskId}:${reported.id}`)) await deps.store.mutate(key, reported.id, (l) => ({ counters: { ...l.counters, loaded: l.counters.loaded + 1 } }));
      if (reported.citation === "moved" && reported.corrected !== undefined) await patchMovedCitations(deps, key, reported.id, reported.corrected);
      await renewLesson(deps.store, key, reported.id, now, resolved.expiryDays, "validated");
    } else if (reported.citation === "stale_dropped") {
      const updated = await deps.store.mutate(key, reported.id, (l) => ({
        counters: { ...l.counters, citationStale: l.counters.citationStale + 1 }, staleAt: [...l.staleAt.filter((t) => now - t < STALE_WINDOW_MS), now].slice(-20),
      }));
      if (updated !== undefined && updated.status === "active" && updated.staleAt.length >= STALE_LIMIT) await markStale(deps, key, updated);
    }
  }
  await deps.store.updateManifest(manifest);
}

async function patchMovedCitations(deps: CounterDeps, key: ScopeKey, id: string, corrected: ReadonlyArray<{ index: number; startLine: number; endLine: number }>): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lesson = await deps.store.get(key, id);
    if (lesson === undefined) return;
    const citations = lesson.citations.map((c, index) => {
      const fix = corrected.find((x) => x.index === index);
      return fix !== undefined && c.kind === "code" ? { ...c, startLine: fix.startLine, endLine: fix.endLine } : c;
    });
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...lesson, citations, version: nextVersion(lesson, await deps.store.versions(key, id)), updatedAt: deps.now() }], deps.now());
    if (result.ok) {
      await emitAudit(deps.audit, { action: "lesson.citation_moved", workspaceId: key.workspaceId, project: key.project, lessonId: id, facts: { citations: corrected.length } });
      return;
    }
  }
}

async function markStale(deps: CounterDeps, key: ScopeKey, lesson: Lesson): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await deps.store.get(key, lesson.id);
    if (fresh === undefined || fresh.status !== "active") return;
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, status: "stale", version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), updatedAt: deps.now() }], deps.now());
    if (result.ok) { await emitAudit(deps.audit, { action: "lesson.stale", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, facts: { stale: fresh.staleAt.length } }); return; }
  }
}
