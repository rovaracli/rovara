// Learning v2: approve by exception (owner decision 24, 2026-11-08). A low-risk lesson drafted from a project member's own correction goes LIVE ON TRIAL with no approval; a thumbs-down by a
// project member, or a later contradicting correction, retires it; after 14 days and at least 3 loads with no thumbs-down it becomes STABLE (what repository publishing may publish).
//
// What this REPLACES for the trial path only: the pilot rule "a person approves every tier-0 lesson" (`TIER0_APPROVAL_DEFAULT` "one"), the cold-start guard (9 person-approved lessons),
// the corroboration rule (Lesson limits #4) and LR-A1 as a switch-on gate. What stays: spike detection (a held source never trials), the project brake, outsider filtering, citation checks,
// second-person rules for tier 2, and every escalation (checks, security, authority, spend) going to a person.
import { foldForMatching, isMeaningfulAnchor } from "@agentx/contracts";
import { emitAudit, modeAllows, type LearningPreset, type LearningMode } from "./policy.js";
import type { LessonDeps } from "./ports.js";
import { nextVersion, type LessonStore, type ScopeKey } from "./store.js";
import type { Lesson } from "./types.js";

export const TRIAL_STABLE_AFTER_DAYS = 14;
export const TRIAL_STABLE_MIN_LOADS = 3;
const DAY = 86_400_000;
/** The approval a trial lesson carries: nobody, by design. The loader reads it (with the preset) as the only approval a trial lesson needs. */
export const TRIAL_APPROVER = "system:trial";

/**
 * Words that put a lesson with a person even though the tier rules would let it through: what it says touches money or the authority to decide (spend, budgets, billing, roles, owners,
 * approvals, policy, guardrails). The checks and security words are already tier 2 (`hasEscalationWords`); this adds spend and authority, which the owner named.
 */
const AUTHORITY_OR_SPEND: readonly RegExp[] = [
  /\b(budgets?|spend(ing)?|billing|invoices?|quotas?|payments?|pricing|prices?|costs?|credits?)\b/iu,
  /\b(authority|authori[sz]ation|entitle\w*|owners?|maintainers?|guardrails?|polic(y|ies)|governance|compliance|rbac|sudo|privileged?|escalat\w*)\b/iu,
];
export const touchesAuthorityOrSpend = (...texts: readonly string[]): boolean => texts.map(foldForMatching).some((text) => AUTHORITY_OR_SPEND.some((pattern) => pattern.test(text)));

export interface TrialContext {
  /** The preset in force (the stricter of company and project). */
  preset: LearningPreset;
  mode: LearningMode;
  /** The lesson contradicts another, is a refinement, was sent back to a person, is held by a paused source, or the project brake is on: a person decides. */
  contradiction: boolean; refinement: boolean; reviewRequired: boolean; held: boolean; braked: boolean;
}

/**
 * Why a lesson may not go live on trial, as fixed codes; empty means it may. `tier` is the tier decision already made for the lesson (tier 2 and "never" are people's, whatever else is true).
 * Every code is checked by code, from fields code set: the verified citations, the tier, the cited member sources (`provenance.memberCorrection`) and the lesson's scope and text.
 */
export function trialBlockers(lesson: Lesson, tier: Lesson["tier"], context: TrialContext): string[] {
  const why: string[] = [];
  if (context.preset !== "standard") why.push("preset_regulated");
  if (!modeAllows(context.mode, "auto_apply")) why.push("mode_not_on");
  if (tier === 2) why.push("needs_two_people");
  if (lesson.provenance.minTrust === "outsider") why.push("outsider_source");
  if (lesson.provenance.memberCorrection !== true) why.push("not_member_correction");
  if (lesson.provenance.audience.kind !== "project") why.push("restricted_source");
  if (lesson.type === "review_check") why.push("review_check");
  const checks = lesson.citationChecks ?? [];
  const code = lesson.citations.flatMap((c, index) => (c.kind === "code" ? [{ c, index }] : []));
  if (code.length === 0) why.push("no_code_citation");
  if (code.some(({ c, index }) => !isMeaningfulAnchor(c.anchor) || !checks.some((check) => check.index === index && check.result === "valid"))) why.push("citations_not_verified");
  const repos = lesson.scope.repos ?? [];
  if (repos.length === 0 || code.some(({ c }) => !repos.includes(c.repo))) why.push("scope_not_repo");
  if (touchesAuthorityOrSpend(lesson.title, lesson.description, lesson.body, ...(lesson.scope.paths ?? []))) why.push("touches_authority_or_spend");
  if (context.contradiction) why.push("contradiction");
  if (context.refinement) why.push("refinement");
  if (context.reviewRequired) why.push("review_required");
  if (context.held) why.push("source_held");
  if (context.braked) why.push("project_brake");
  return why;
}

/** Whether a lesson is live on trial or stable (it carries a trial record and the trial approval). The loader asks it together with the preset. */
export const isTrialLesson = (lesson: Pick<Lesson, "trial" | "approvals">): boolean => lesson.trial !== undefined && lesson.approvals.some((a) => a.mode === "trial" && a.by === TRIAL_APPROVER);

export interface StableDeps extends LessonDeps { store: LessonStore }

/** Whether a trial lesson has earned stable: 14 days live, at least 3 loads, no thumbs-down (a thumbs-down retires it) and no "wrong here" mark or retire proposal waiting. */
export function trialIsStable(lesson: Lesson, now: number): boolean {
  const t = lesson.trial;
  return t !== undefined && t.state === "trial" && lesson.status === "active" && now - t.startedAt >= TRIAL_STABLE_AFTER_DAYS * DAY
    && lesson.counters.loaded >= TRIAL_STABLE_MIN_LOADS && lesson.counters.harmful === 0 && lesson.retireProposedAt === undefined;
}

/** Moves one trial lesson to stable if it has earned it. Idempotent; true when this call moved it. */
export async function promoteIfStable(deps: StableDeps, key: ScopeKey, lessonId: string): Promise<boolean> {
  const now = deps.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await deps.store.get(key, lessonId);
    if (fresh === undefined || !trialIsStable(fresh, now)) return false;
    const setVersion = await deps.store.setVersion(key);
    const result = await deps.store.commit(key, setVersion, [{ ...fresh, trial: { ...fresh.trial!, state: "stable", stableAt: now }, version: nextVersion(fresh, await deps.store.versions(key, fresh.id)), updatedAt: now }], now);
    if (result.ok) {
      await emitAudit(deps.audit, { action: "lesson.trial_stable", workspaceId: key.workspaceId, project: key.project, lessonId: fresh.id, facts: { tier: fresh.tier } });
      return true;
    }
  }
  return false;
}

/** Moves every trial lesson that earned it to stable. Idempotent and bounded; returns the ids moved. For the nightly pass (a lesson that is not loaded again would otherwise wait for a load). */
export async function promoteStableTrials(deps: StableDeps, key: ScopeKey, limit = 200): Promise<string[]> {
  const moved: string[] = [];
  const now = deps.now();
  for (const lesson of await deps.store.list(key, { statuses: ["active"] })) {
    if (moved.length >= limit) break;
    if (trialIsStable(lesson, now) && (await promoteIfStable(deps, key, lesson.id))) moved.push(lesson.id);
  }
  return moved;
}

/**
 * What repository publishing (lane 6) may publish: a lesson that is stable, live, from a task shared with the project and a project-wide source, and whose text names no person. Names are
 * matched against `names` (the display names of the people the lesson names, which the caller reads), and an @handle or an e-mail address always counts as a name. Anything unknown is false.
 */
export function isPublishable(lesson: Lesson, names: readonly string[] = []): boolean {
  if (lesson.trial?.state !== "stable" || lesson.status !== "active" || lesson.provenance.fromSharedTask !== true || lesson.provenance.audience.kind !== "project") return false;
  return !namesAPerson([lesson.title, lesson.description, lesson.body].join("\n"), names);
}
/** Whether a text names a person: an @handle, an e-mail address, or any of the given display names as a whole word (case and look-alikes folded). */
export function namesAPerson(text: string, names: readonly string[]): boolean {
  const folded = foldForMatching(text);
  if (/(^|[^\w])@[a-z0-9][\w-]{0,38}/iu.test(folded) || /[\w.+-]+@[\w-]+\.[\w.-]+/u.test(folded)) return true;
  return names.map((n) => foldForMatching(n).trim()).filter((n) => n.length >= 2).some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(folded));
}
