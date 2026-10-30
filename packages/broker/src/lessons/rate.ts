// Learning v2 L2: candidate rate limits and the burst brake (control C10, C14). A compromised member account must not be able to flood the queue.
// At most 20 new candidates per project per day and 10 per author per day (both editions: these are safety limits, not spend caps). A day with more than
// three times the 7-day median (and at least 6) pauses tier-0 auto-apply for the project and alerts the admins; a person resumes it.
import { emitAudit, RATE_LIMITS } from "./policy.js";
import type { AlertSink, LessonDeps } from "./ports.js";
import type { LessonStore, ScopeKey } from "./store.js";

const DAY = 86_400_000;
export type RateDecision = { ok: true } | { ok: false; reason: "project_daily" | "author_daily" };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Records one candidate attempt and decides whether it may go on. The attempt counts even when it is refused, so a flood is visible. */
export async function admitCandidate(deps: LessonDeps, store: LessonStore, key: ScopeKey, authors: readonly string[], alerts?: AlertSink): Promise<RateDecision> {
  const now = deps.now();
  const since = now - DAY;
  await store.recordCandidate(key, { at: now, authors });
  const days = await store.candidateDays(key, 8, now);
  await brake(deps, store, key, days[0] ?? 0, median(days.slice(1)), alerts);
  if ((await store.countCandidates(key, since)) > RATE_LIMITS.candidatesPerProjectPerDay) return { ok: false, reason: "project_daily" };
  for (const author of authors) if ((await store.countCandidates(key, since, author)) > RATE_LIMITS.candidatesPerAuthorPerDay) return { ok: false, reason: "author_daily" };
  return { ok: true };
}

async function brake(deps: LessonDeps, store: LessonStore, key: ScopeKey, today: number, medianBefore: number, alerts?: AlertSink): Promise<void> {
  if (today <= Math.max(RATE_LIMITS.burstMultiple * medianBefore, RATE_LIMITS.burstMinimum)) return;
  const flags = await store.flags(key);
  if (flags.autoTierPausedAt !== undefined) return;
  await store.setFlags(key, { autoTierPausedAt: deps.now(), autoTierPausedReason: "burst" });
  await emitAudit(deps.audit, { action: "lesson.auto_tier_paused", workspaceId: key.workspaceId, project: key.project, facts: { reason: "burst", today, medianBefore } });
  try { await alerts?.alert(key.workspaceId, key.project, "burst_auto_tier_paused"); } catch { /* the pause already holds */ }
}

/** A maintainer resumes tier-0 auto-apply after a pause. */
export async function resumeAutoTier(deps: LessonDeps, store: LessonStore, key: ScopeKey, actor: string): Promise<void> {
  const flags = await store.flags(key);
  if (flags.autoTierPausedAt === undefined) return;
  await store.setFlags(key, {});
  await emitAudit(deps.audit, { action: "lesson.auto_tier_resumed", workspaceId: key.workspaceId, project: key.project, actor, facts: {} });
}
