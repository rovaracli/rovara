// Learning v2 L2/L3a: the path from a reflector draft to a lesson in front of people (or live). Curate, check the code citations against the base commit,
// classify the tier, decide whether the lesson has earned a person's attention (promotion), and apply tier 0 by itself when the policy and the mode allow.
import { AuditUnavailable, activateLesson } from "./approve.js";
import { curateDraft, type CurateDeps, type CurateOutcome } from "./curate.js";
import { pendingExpiry } from "./expiry.js";
import { approversRequired, emitAudit, modeAllows, resolveLearning, type LearningSettingsReader } from "./policy.js";
import type { CitationVerifier } from "./ports.js";
import { isHeldBySource, resumeSource } from "./sources.js";
import { lessonValue } from "./value.js";
import { isCorroborated } from "./value.js";
import { isMeaningfulAnchor } from "@agentx/contracts";
import type { LessonDraft } from "./reflect.js";
import { nextVersion, type ScopeKey } from "./store.js";
import { classifyTier, type TierContext } from "./tier.js";
import type { Lesson } from "./types.js";

export interface ProcessDeps extends CurateDeps { verifier: CitationVerifier; settings: LearningSettingsReader }
const VERIFY_TIMEOUT_MS = 3000;

/**
 * A promotion rule (design §4.5.2 step 5, with the owner's corroboration rule): two independent tasks, or one task plus a member's own signal, or a
 * corroborated tier-0 fact (a measured outcome behind it). A single-source fact waits as a candidate until something backs it up. Nothing is dropped.
 */
export function earnedAttention(lesson: Lesson, tier: Lesson["tier"]): boolean {
  if (lesson.contradictsWith !== undefined) return true;
  if (new Set(lesson.provenance.supportTasks).size >= 2) return true;
  if (lesson.provenance.supportTasks.length >= 1 && lesson.provenance.memberSignal) return true;
  return tier === 0 && isCorroborated(lesson.provenance);
}

async function verifyCitations(deps: ProcessDeps, lesson: Lesson): Promise<Lesson> {
  const now = deps.now();
  const checks: NonNullable<Lesson["citationChecks"]> = [];
  const citations = [...lesson.citations];
  for (const [index, citation] of lesson.citations.entries()) {
    if (citation.kind !== "code") continue;
    // A trivial anchor (a lone brace) proves nothing: it is recorded as stale, so the lesson cannot be tier 0.
    if (!isMeaningfulAnchor(citation.anchor)) { checks.push({ index, result: "stale", at: now }); continue; }
    try {
      const answer = await Promise.race([
        deps.verifier.verify({ workspaceId: lesson.workspaceId, repo: citation.repo, commit: citation.commit, path: citation.path, startLine: citation.startLine, endLine: citation.endLine, anchor: citation.anchor }),
        new Promise<{ result: "unknown" }>((resolve) => setTimeout(() => resolve({ result: "unknown" }), VERIFY_TIMEOUT_MS).unref?.()),
      ]);
      if (answer.result === "valid") checks.push({ index, result: "valid", at: now });
      else if (answer.result === "moved" && "startLine" in answer && answer.startLine !== undefined && answer.endLine !== undefined) {
        citations[index] = { ...citation, startLine: answer.startLine, endLine: answer.endLine };
        checks.push({ index, result: "valid", at: now });
      } else if (answer.result === "stale") checks.push({ index, result: "stale", at: now });
      // unknown: no check is recorded, so the lesson is not trusted as verified.
    } catch { /* an unreadable check is the same as no check */ }
  }
  return { ...lesson, citations, citationChecks: checks };
}

export interface SettleOptions { contradiction?: boolean; judgeEscalate?: boolean; /** Never apply by itself: used when a pause lifts, so a person decides. */ noAutoApply?: boolean }

/**
 * Verifies, tiers and routes one lesson that the curator just wrote or changed. A lesson that is not yet supported stays a candidate. A lesson that is
 * "never" is rejected (and audited as refused when it asked for a capability). Tier 0 goes live when the policy and the mode allow and the project's
 * tier-0 brake is off; everything else becomes pending for people.
 */
export async function settleLesson(deps: ProcessDeps, key: ScopeKey, lessonId: string, options: SettleOptions = {}): Promise<Lesson | undefined> {
  const resolved = await resolveLearning(deps.settings, key.workspaceId, key.project);
  if (!modeAllows(resolved.mode, "reflect")) return undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await deps.store.get(key, lessonId);
    if (current === undefined || (current.status !== "candidate" && current.status !== "pending")) return current;
    const verified = await verifyCitations(deps, current);
    // The judge's escalate flag and a contradiction stay with the lesson: settling again can raise a tier, never lower it.
    const context: TierContext = { contradiction: current.contradictsWith !== undefined || options.contradiction === true, judgeEscalate: options.judgeEscalate === true || current.tierReasons.includes("judge_escalate") };
    // A refinement is at least as risky as the lesson it replaces. A lesson already tiered keeps its tier and reasons: settling again only raises.
    const superseded = current.supersedes === undefined ? undefined : await deps.store.get(key, current.supersedes);
    if (superseded !== undefined) context.supersedesTier = superseded.tier;
    const decision = classifyTier(verified, context, current.tierReasons.length > 0 ? { tier: current.tier, reasons: current.tierReasons } : undefined);
    const now = deps.now();
    const setVersion = await deps.store.setVersion(key);
    const version = nextVersion(current, await deps.store.versions(key, lessonId));

    if (decision.tier === "never") {
      const result = await deps.store.commit(key, setVersion, [{ ...verified, version, status: "rejected", rejectedReason: decision.reasons[0] ?? "refused", updatedAt: now }], now);
      if (!result.ok) continue;
      await emitAudit(deps.audit, { action: "lesson.refused", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { reason: decision.reasons[0] ?? "refused" } });
      return deps.store.get(key, lessonId);
    }

    const flags = await deps.store.flags(key);
    // A lesson from a source that spiked is collected but held: it is not queued for people or applied until a maintainer resumes the source.
    const held = isHeldBySource(flags, [...verified.provenance.sources, ...verified.provenance.inputSources]);
    const earned = earnedAttention(verified, decision.tier) && (!held || current.status === "pending");
    // A higher tier than before means earlier approvals were for less risk: they no longer count.
    const approvals = decision.tier > current.tier ? [] : current.approvals;
    const next: Lesson = {
      ...verified, version, tier: decision.tier, tierReasons: decision.reasons.slice(0, 12), approvals, updatedAt: now,
      status: earned ? "pending" : "candidate", ...(earned ? { pendingExpiresAt: current.pendingExpiresAt ?? pendingExpiry(now) } : {}),
    };
    const result = await deps.store.commit(key, setVersion, [next], now);
    if (!result.ok) continue;
    if (next.status === "pending" && current.status !== "pending") await emitAudit(deps.audit, { action: "lesson.pending", workspaceId: key.workspaceId, project: key.project, lessonId, facts: { tier: next.tier } });

    // Auto-apply: tier 0, corroborated, not held, not a refinement of an existing lesson, and the policy and mode allow it.
    if (next.status === "pending" && next.tier === 0 && next.supersedes === undefined && isCorroborated(next.provenance) && !held
      && options.noAutoApply !== true && approversRequired(0, resolved.approval) === 0 && modeAllows(resolved.mode, "auto_apply")) {
      try {
        const active = await activateLesson(deps, key, next, [{ approvalId: `auto-${lessonId}`, by: "system:auto", at: deps.now(), mode: "auto" }], resolved.expiryDays, "lesson.auto_applied");
        if (active !== undefined) return active;
      } catch (error) {
        // If the go-live cannot be audited it does not happen: the lesson stays pending for a person.
        if (!(error instanceof AuditUnavailable)) throw error;
      }
    }
    return deps.store.get(key, lessonId);
  }
  return undefined;
}

export interface ProcessResult { outcome: CurateOutcome; lesson?: Lesson }

/** Curates one reflector draft and settles the resulting lesson. */
export async function processDraft(deps: ProcessDeps, key: ScopeKey, draft: LessonDraft): Promise<ProcessResult> {
  const outcome = await curateDraft(deps, key, draft);
  if (outcome.outcome === "dropped") return { outcome };
  const options: SettleOptions = outcome.outcome === "contradiction" ? { contradiction: true } : outcome.outcome === "added" || outcome.outcome === "updated" ? { judgeEscalate: outcome.judgeEscalate } : {};
  const lesson = await settleLesson(deps, key, outcome.lesson.id, options);
  return lesson === undefined ? { outcome } : { outcome, lesson };
}

export const RESUME_RESETTLE_LIMIT = 200;
/**
 * A maintainer resumes a paused source, and the candidates held while it was paused are settled again, most valuable first, under the rules in force now
 * (tier, corroboration, spike holds from OTHER sources that are still paused). Nothing is applied just because the pause lifted: a held lesson that has
 * earned attention goes to people as pending; it never goes live from here. Bounded at RESUME_RESETTLE_LIMIT lessons per call.
 */
export async function resumeAndResettle(deps: ProcessDeps, key: ScopeKey, source: string, actor: string): Promise<{ resumed: boolean; settled: string[] }> {
  if (!(await resumeSource(deps, deps.store, key, source, actor))) return { resumed: false, settled: [] };
  const held = (await deps.store.list(key, { statuses: ["candidate"] }))
    .filter((l) => l.provenance.sources.includes(source) || l.provenance.inputSources.includes(source))
    .sort((a, b) => lessonValue(b) - lessonValue(a) || a.id.localeCompare(b.id))
    .slice(0, RESUME_RESETTLE_LIMIT);
  const settled: string[] = [];
  for (const lesson of held) {
    const result = await settleLesson(deps, key, lesson.id, { noAutoApply: true });
    if (result !== undefined) settled.push(lesson.id);
  }
  return { resumed: true, settled };
}
