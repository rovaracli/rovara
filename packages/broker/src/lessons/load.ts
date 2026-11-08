// Learning v2 L4: the loader (design §4.7). At a stage's dispatch it picks the lessons that apply and returns the `learnedContext` payload for the worker
// and the manifest that records what was chosen. It never blocks a task: any failure loads nothing. Wiring it into the dispatch is one small hunk in
// aws/broker.ts beside the promptSection composition (see the report, "Wiring pending (hot file)").
import {
  LEARNED_CONTEXT_FEATURE, LEARNED_CONTEXT_MAX_BYTES, LEARNED_CONTEXT_MAX_LESSONS, cleanLessonText, type CodeCitation, type LearnedContext, type LearnedLesson, type LessonStage,
} from "@agentx/contracts";
import { globToRegExp } from "./guards.js";
import { safeScopeLabel } from "./render.js";
import { approversRequired, modeAllows, resolveLearning, type ApprovalPolicy, type LearningSettingsReader } from "./policy.js";
import { isTrialLesson } from "./trial.js";
import type { Embedder, LessonDeps, LessonVectors } from "./ports.js";
import type { LessonStore, LoadManifest, LoadManifestEntry, ScopeKey } from "./store.js";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { createLessonLiveReader, lessonTaskRefs } from "./live-visibility.js";
import { readVisible, readVisibleRanked } from "./read-visible.js";
import { memberView, type MemberOf, type MemberResolver } from "./members.js";
import { isRestricted, normId, type IdentitySet, type Lesson } from "./types.js";

export const LOAD_MAX_LESSONS = LEARNED_CONTEXT_MAX_LESSONS;
export const LOAD_MAX_BYTES = LEARNED_CONTEXT_MAX_BYTES;
/** Over-fetch so recall survives the scope and audience filters. */
const VECTOR_FETCH = 60;
const DAY = 86_400_000;
/** The reviewer's list of what earlier stages loaded is kept short (about 1 KB of titles), so it cannot crowd the lessons budget. */
const PRIOR_LOADED_MAX = 12;
/** The ranked candidates are checked against the access records and the source tasks' live visibility this many at a time (LV-1 M1), until enough survive. */
const CHECK_PAGE = 3 * LOAD_MAX_LESSONS;
/** The whole visibility work of one load must end inside the dispatcher's 2.5 s deadline (`lessons-dispatch.ts`): what is not checked by then is not offered, and each batched task read is cut at the same time. */
export const LOAD_VISIBILITY_BUDGET_MS = 1_800;

/** Who reads what a stage produces. Only "shared": the reader is the running task's audience, read live (decision 31), never one named person (a "private" reader would let a lesson only some people may read reach an agent several people can see). */
export type TaskAudience = { kind: "shared" };
export interface LoadRequest {
  workspaceId: string; project: string; taskId: string; stage: LessonStage | "CHECKS"; round: number;
  /** The task's intent and, from PLAN on, the plan summary: both are text the project already holds. */
  intent: string; planSummary?: string;
  repos: readonly string[]; files: readonly string[]; languages: readonly string[];
  taskAudience: TaskAudience;
  /** Only an eval-batch dispatch may ask for `off`; the broker route refuses it from production (design §4.13, task L8). */
  memory?: { mode: "off" | "live" };
}
export type LoadSkip = "mode" | "stage" | "memory_off" | "index_unreachable" | "no_lessons" | "access_unavailable" | "members_unavailable";
export interface LoadResult { context?: LearnedContext; manifest: LoadManifest; skipped?: LoadSkip }

export interface LoadDeps extends LessonDeps {
  store: LessonStore; embedder: Embedder; vectors: LessonVectors; settings: LearningSettingsReader;
  /**
   * The record core's access check. Each lesson's source places are checked against the access records at load time (not only against the snapshot the lesson froze), so a person
   * removed from a channel stops getting its lessons. REQUIRED: a caller that cannot supply it gets no lessons (fail closed, with a log line), never the frozen snapshot alone.
   */
  access: AccessCheckPort;
  /**
   * Follows a merged developer to the member they became. The people a tier needs are counted as members, so two approvals given by two accounts that were merged into one person count once. Absent:
   * ids are counted as they are. A lookup that fails loads nothing (fail closed).
   */
  resolveMember?: MemberResolver;
  log?: (event: string, fields: Record<string, unknown>) => void;
}


interface ScopeMatch { matches: boolean; byPath: boolean }
export function scopeMatch(lesson: Lesson, request: Pick<LoadRequest, "repos" | "files" | "languages">): ScopeMatch {
  const { repos, paths, languages } = lesson.scope;
  if (repos !== undefined && repos.length > 0 && !repos.some((r) => request.repos.includes(r))) return { matches: false, byPath: false };
  if (languages !== undefined && languages.length > 0 && request.languages.length > 0 && !languages.some((l) => request.languages.includes(l))) return { matches: false, byPath: false };
  if (paths !== undefined && paths.length > 0 && request.files.length > 0) {
    const expressions = paths.map(globToRegExp);
    const hit = request.files.some((file) => expressions.some((re) => re.test(file)));
    return { matches: hit, byPath: hit };
  }
  return { matches: true, byPath: false };
}

/** The lower bound of the Wilson interval for helpful of loaded (95%). Zero when a lesson has never been loaded. */
export function wilsonLower(helpful: number, loaded: number): number {
  if (loaded <= 0) return 0;
  const n = loaded;
  const p = Math.min(1, Math.max(0, helpful / n));
  const z = 1.96;
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n));
}

/**
 * Only approved lessons are used (the pilot rule): an active lesson loads only while the approvals it carries still meet what the project's policy asks of its tier NOW, counting people only.
 * Tier 2 always needs two people (or the audited sole-owner exception); tier 1 needs what `approval.tier1` says; tier 0 needs what `approval.tier0` says, which is one person unless a project
 * has turned automatic go-live on (and `resolveLearning` reads "auto" as "one" while that is off). A lesson sent back to a person (`reviewRequired`) needs at least one person whatever its tier.
 * This is a second line behind the status: an old row, a hand edit or a bug that left a lesson `active` without its approvals does not reach an agent.
 */
export function approvedForUse(lesson: Lesson, policy: ApprovalPolicy, member: MemberOf = normId, trialAllowed = false): boolean {
  // A lesson live on trial or stable (DECISIONS 24) needs no person, but only while every setting in force allows that (`ResolvedLearning.trialAllowed`: Standard, mode On, no company approval floor, no
  // required group, no two-person requirement) and the lesson is not tier 2. A stricter setting stops them at once (default: stopped).
  if (isTrialLesson(lesson)) return trialAllowed && lesson.tier < 2;
  const people = new Set(lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => member(a.by))).size;
  if (lesson.tier === 2) return isTierTwoApproved(lesson, member);
  const needed = Math.max(approversRequired(lesson.tier, policy), lesson.reviewRequired === true ? 1 : 0);
  return people >= needed;
}

/** A code citation the broker's own check found stale keeps its lesson out; the worker checks again at the base commit. */
export const hasStaleCitation = (lesson: Lesson): boolean => (lesson.citationChecks ?? []).some((check) => check.result === "stale");

/**
 * A tier-2 lesson loads after two different people approved it. The audited sole-owner exception stands in for the second person EXCEPT for a lesson that asks for a capability change (more tools,
 * domains, budget or approvals): that text reaches the agent only after two people, always.
 */
const isTierTwoApproved = (lesson: Lesson, member: MemberOf = normId): boolean => lesson.tier === 2 && (new Set(lesson.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => member(a.by))).size >= 2
  || (!lesson.tierReasons.includes("capability_request") && lesson.approvals.some((a) => a.mode === "sole_owner_exception")));

/** Which lesson types a stage may load (design §4.7). Reviewer stages get only tier-2-approved review checks. */
export function stageAllows(lesson: Lesson, stage: LessonStage, member: MemberOf = normId): boolean {
  if (!lesson.stages.includes(stage)) return false;
  switch (stage) {
    case "UNDERSTAND": case "PLAN": return lesson.type !== "review_check";
    case "IMPLEMENT": return lesson.type === "convention" || lesson.type === "pitfall" || (lesson.type === "fact" && lesson.citations.some((c) => c.kind === "code"));
    case "PLAN_CRITIQUE": case "REVIEW": return lesson.type === "review_check" && isTierTwoApproved(lesson, member);
  }
}

const scopeLabel = (lesson: Lesson): string => safeScopeLabel(lesson.scope);

export function toLearned(lesson: Lesson): LearnedLesson {
  return {
    id: lesson.id, version: lesson.version, type: lesson.type, title: lesson.title, description: lesson.description, body: lesson.body, scopeLabel: scopeLabel(lesson),
    citations: lesson.citations.filter((c): c is CodeCitation => c.kind === "code"),
  };
}
const sizeOf = (lesson: LearnedLesson): number => Buffer.byteLength(JSON.stringify(lesson), "utf8");

export async function loadLessonsForStage(deps: LoadDeps, request: LoadRequest): Promise<LoadResult> {
  const key: ScopeKey = { workspaceId: request.workspaceId, project: request.project };
  const now = deps.now();
  const empty = async (skipped: LoadSkip, setVersion?: number): Promise<LoadResult> => ({
    skipped, manifest: { taskId: request.taskId, workspaceId: key.workspaceId, project: key.project, stage: request.stage === "CHECKS" ? "PLAN" : request.stage, round: request.round, setVersion: setVersion ?? 0, memory: skipped === "memory_off" ? "off" : "live", at: now, lessons: [], bytes: 0 },
  });
  if (request.memory?.mode === "off") return empty("memory_off");
  if (request.stage === "CHECKS") return empty("stage");
  const stage = request.stage;
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.mode, "load")) return empty("mode");

  let setVersion = 0;
  let similarity: Map<string, number>;
  let active: Lesson[];
  try {
    setVersion = await deps.store.setVersion(key);
    active = (await deps.store.list(key, { statuses: ["active"] })).filter((l) => l.expiresAt > now && !hasStaleCitation(l));
    const text = cleanLessonText(`${request.intent}\n${request.planSummary ?? ""}`, 2000);
    const hits = await deps.vectors.query(key.workspaceId, key.project, await deps.embedder.embed(text), VECTOR_FETCH);
    similarity = new Map(hits.map((h) => [h.id, Math.max(0, Math.min(1, h.score))]));
  } catch {
    // Fail closed: with the index or the store unreachable the task runs as it would without memory.
    deps.metrics?.count("learning_load_skipped", { reason: "index_unreachable" });
    return empty("index_unreachable", setVersion);
  }

  // The people a tier needs are counted as MEMBERS (a merged developer is the member they became); a merge record that cannot be read loads nothing.
  const member = await memberView(deps.resolveMember, key.workspaceId, active.flatMap((l) => l.approvals.filter((a) => a.mode !== "auto" && a.mode !== "trial").map((a) => a.by)));
  if (member === undefined) {
    deps.metrics?.count("learning_load_skipped", { reason: "members_unavailable" });
    return empty("members_unavailable", setVersion);
  }
  active = active.filter((l) => approvedForUse(l, resolved.approval, member, resolved.trialAllowed));

  // The access records, asked now for the places each candidate lesson was learned from (one batch for the whole load). A record that cannot be read loads nothing.
  if ((deps.access as AccessCheckPort | undefined) === undefined) {
    deps.log?.("learning.load_no_access_port", { stage });
    deps.metrics?.count("learning_load_skipped", { reason: "access_unavailable" });
    return empty("access_unavailable", setVersion);
  }
  // Every candidate goes through the one read path: the frozen snapshot AND the access records AND the source tasks' live visibility. The candidates are scored and scope-matched FIRST (cheap, no reads), then the
  // best ones are checked a page at a time until enough survive (LV-1 M1), with one reader for the whole load so no task is read twice.
  // No single person is the reader: restricted lessons and restricted places are checked as for nobody in particular, and the source tasks against the running task's audience.
  const viewer: IdentitySet | undefined = undefined;
  const scored: Array<{ lesson: Lesson; score: number; why: LoadManifestEntry["why"] }> = [];
  for (const lesson of active) {
    if (!stageAllows(lesson, stage, member)) continue;
    const match = scopeMatch(lesson, request);
    if (!match.matches) continue;
    const sim = similarity.get(lesson.id) ?? 0;
    const recency = Math.exp(-Math.max(0, now - (lesson.lastValidatedAt ?? lesson.updatedAt)) / (90 * DAY));
    const score = 0.6 * sim + 0.3 * wilsonLower(lesson.counters.helpful, lesson.counters.loaded) + 0.1 * recency;
    scored.push({ lesson, score, why: match.byPath ? "path" : sim >= 0.6 ? "similar" : "scope" });
  }
  scored.sort((a, b) => b.score - a.score || a.lesson.id.localeCompare(b.lesson.id));
  const rank = new Map(scored.map((entry) => [entry.lesson.id, entry] as const));

  const log = (event: string, fields: Record<string, unknown>): void => {
    deps.log?.(event, fields);
    if (fields.reason === "bound") deps.metrics?.count("learning_live_bound_hit", { where: "load" });
  };
  const deadlineAt = Date.now() + LOAD_VISIBILITY_BUDGET_MS;
  // Each batched task read gets only the time that is left, so the whole load stays inside the dispatcher's deadline whatever the State table does.
  const live = createLessonLiveReader({ port: deps.access.taskVisibility, key, where: "load", log, running: { taskId: request.taskId }, timeoutMs: () => Math.max(1, deadlineAt - Date.now()) });
  const chosen: LearnedLesson[] = [];
  const entries: LoadManifestEntry[] = [];
  let bytes = 0;
  const choose = (lessons: readonly Lesson[]): void => {
    chosen.length = 0; entries.length = 0; bytes = 0;
    for (const lesson of lessons) {
      if (chosen.length >= LOAD_MAX_LESSONS) break;
      const picked = rank.get(lesson.id)!;
      const learned = toLearned(lesson);
      const size = sizeOf(learned);
      if (bytes + size > LOAD_MAX_BYTES) continue;
      chosen.push(learned);
      entries.push({ id: lesson.id, version: lesson.version, score: Math.round(picked.score * 1000) / 1000, why: picked.why, citation: "unchecked", taskIds: lessonTaskRefs(lesson).taskIds });
      bytes += size;
    }
  };
  try {
    const checked = await readVisibleRanked({
      access: deps.access, key, viewer, where: "load", log, live, ranked: scored.map((entry) => entry.lesson), pageSize: CHECK_PAGE,
      enough: (kept) => { choose(kept); return chosen.length >= LOAD_MAX_LESSONS; }, deadlineAt,
    });
    choose(checked.kept);
    if (!checked.complete) { deps.log?.("learning.load_visibility_budget", { checked: checked.checked, ranked: scored.length }); deps.metrics?.count("learning_load_budget_hit"); }
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "access_unavailable" });
    return empty("access_unavailable", setVersion);
  }

  let priorLoaded: LearnedContext["priorLoaded"];
  if (stage === "PLAN_CRITIQUE" || stage === "REVIEW") {
    // Reviewers see what the planner and coder were told, so they can check whether a lesson drove a bad change.
    const seen = new Map<string, { id: string; type: Lesson["type"]; title: string }>();
    for (const manifest of await deps.store.manifests(key, request.taskId)) {
      if (manifest.stage === "PLAN_CRITIQUE" || manifest.stage === "REVIEW") continue;
      for (const entry of manifest.lessons) {
        if (seen.has(entry.id) || seen.size >= PRIOR_LOADED_MAX) continue;
        const lesson = await deps.store.get(key, entry.id);
        if (lesson !== undefined && !isRestricted(lesson)) seen.set(entry.id, { id: lesson.id, type: lesson.type, title: lesson.title });
      }
    }
    // The titles go through the same read path: a lesson whose source place turned private since is not listed for a task that may no longer read it.
    const shown = new Set((await readVisible({ access: deps.access, key, viewer, live, lessons: (await Promise.all([...seen.keys()].map((id) => deps.store.get(key, id)))).flatMap((l) => (l === undefined ? [] : [l])), where: "load", log })).map((l) => l.id));
    priorLoaded = [...seen.values()].filter((entry) => shown.has(entry.id));
  }

  const manifest: LoadManifest = { taskId: request.taskId, workspaceId: key.workspaceId, project: key.project, stage, round: request.round, setVersion, memory: "live", at: now, lessons: entries, bytes };
  await deps.store.putManifest(manifest);
  // `loaded` is counted when the worker reports the lesson reached the prompt (applyLoadReport), not here: a lesson the worker dropped was never loaded.
  if (chosen.length === 0 && priorLoaded === undefined) return { manifest, skipped: "no_lessons" };
  return { manifest, context: { v: 1, setVersion, stage, lessons: chosen, ...(priorLoaded === undefined ? {} : { priorLoaded }) } };
}

/**
 * The single call the dispatch makes (the hunk in aws/broker.ts). It returns an object to spread into the worker invocation:
 * `{ learnedContext }` when something loads, `{}` otherwise. Called with a worker that does not list the feature, it returns `{}` and records nothing (no manifest, no counters). The dispatch
 * itself asks as for a worker that lists it, and delivery (`ec2-delivery.ts withoutLearnedContext`) removes the field for an older worker: so a manifest can name lessons that an older worker
 * never received (the task page shows them as "not checked yet"). Any failure inside is swallowed: learning never blocks a stage.
 */
export async function learnedContextForDispatch(deps: LoadDeps, request: LoadRequest, workerFeatures: readonly string[]): Promise<{ learnedContext?: LearnedContext }> {
  if (!workerFeatures.includes(LEARNED_CONTEXT_FEATURE)) return {};
  try {
    const result = await loadLessonsForStage(deps, request);
    return result.context === undefined ? {} : { learnedContext: result.context };
  } catch {
    deps.metrics?.count("learning_load_skipped", { reason: "error" });
    return {};
  }
}
