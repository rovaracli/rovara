// Learning v2 L3a: the weekly digest for the project maintainer (owner decisions Q2 and "Lesson limits"). It leads with the top lessons by importance, then
// lists what went live by itself, what waits for people, what was retired, which sources are paused and how many candidates are queued. This builds the
// content; where it is delivered (Slack, email, the Home card) is a later UI task. A lesson from a restricted source appears, with its text, only for a
// viewer who could see that source; for everyone else it is counted and nothing more.
import type { LessonStore, ScopeKey } from "./store.js";
import { satisfiesAcl, type IdentitySet, type Lesson } from "./types.js";
import { lessonValue } from "./value.js";

const WEEK = 7 * 86_400_000;
export const DIGEST_TOP = 5;
export interface DigestItem { id: string; title: string; type: Lesson["type"]; tier: Lesson["tier"]; scope: Lesson["scope"]; links: string[] }
export interface WeeklyDigest {
  since: number;
  /** The most important lessons (active or waiting), by measured outcomes, then recurrence, then severity. */
  top: DigestItem[];
  autoApplied: DigestItem[]; waiting: DigestItem[]; retired: DigestItem[]; staleOrRetireProposed: DigestItem[];
  /** Candidates collected and not yet in front of people. Nothing is dropped. */
  queuedCount: number;
  /** Sources paused by spike detection and waiting for the maintainer. */
  pausedSources: string[];
  /** Lessons left out because the viewer could not see their source. */
  restrictedHidden: number;
}

export async function buildWeeklyDigest(store: LessonStore, key: ScopeKey, now: number, viewer: IdentitySet): Promise<WeeklyDigest> {
  const since = now - WEEK;
  const all = await store.list(key);
  const item = (l: Lesson): DigestItem => ({ id: l.id, title: l.title, type: l.type, tier: l.tier, scope: l.scope, links: l.citations.flatMap((c) => (c.kind === "pr" ? [c.url] : [])) });
  const visible = (l: Lesson): boolean => l.provenance.audience.kind !== "restricted" || satisfiesAcl(viewer, l.provenance.audience.acl);
  const shown = all.filter(visible);
  const byValue = (a: Lesson, b: Lesson): number => lessonValue(b) - lessonValue(a) || a.id.localeCompare(b.id);
  return {
    since,
    top: shown.filter((l) => l.status === "active" || l.status === "pending").sort(byValue).slice(0, DIGEST_TOP).map(item),
    autoApplied: shown.filter((l) => l.status === "active" && l.approvals.some((a) => a.mode === "auto") && l.updatedAt >= since).sort(byValue).map(item),
    waiting: shown.filter((l) => l.status === "pending").sort(byValue).map(item),
    retired: shown.filter((l) => (l.status === "retired" || l.status === "expired") && l.updatedAt >= since).map(item),
    staleOrRetireProposed: shown.filter((l) => l.status === "stale" || (l.status === "active" && l.retireProposedAt !== undefined)).map(item),
    queuedCount: all.filter((l) => l.status === "candidate").length,
    pausedSources: Object.keys((await store.flags(key)).pausedSources ?? {}).sort(),
    restrictedHidden: all.length - shown.length,
  };
}
