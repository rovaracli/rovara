// Learning v2 L3a: the weekly digest for the project maintainer (owner decision Q2). It lists what went live by itself, what waits for people, and what
// was retired, so a maintainer can remove any lesson. This builds the content; where and how it is delivered (Slack, email, the Home card) is a later
// UI task. Text of a lesson from a restricted source is left out of the digest: only a count is shown.
import type { LessonStore, ScopeKey } from "./store.js";
import { isRestricted, type Lesson } from "./types.js";

const WEEK = 7 * 86_400_000;
export interface DigestItem { id: string; title: string; type: Lesson["type"]; tier: Lesson["tier"]; scope: Lesson["scope"]; links: string[] }
export interface WeeklyDigest {
  since: number; autoApplied: DigestItem[]; waiting: DigestItem[]; retired: DigestItem[]; staleOrRetireProposed: DigestItem[];
  /** Lessons left out of the lists because their source is restricted. */
  restrictedCount: number;
}

export async function buildWeeklyDigest(store: LessonStore, key: ScopeKey, now: number): Promise<WeeklyDigest> {
  const since = now - WEEK;
  const lessons = await store.list(key);
  const item = (l: Lesson): DigestItem => ({ id: l.id, title: l.title, type: l.type, tier: l.tier, scope: l.scope, links: l.citations.flatMap((c) => (c.kind === "pr" ? [c.url] : [])) });
  const open = lessons.filter((l) => !isRestricted(l));
  return {
    since,
    autoApplied: open.filter((l) => l.status === "active" && l.approvals.some((a) => a.mode === "auto") && l.updatedAt >= since).map(item),
    waiting: open.filter((l) => l.status === "pending").map(item),
    retired: open.filter((l) => (l.status === "retired" || l.status === "expired") && l.updatedAt >= since).map(item),
    staleOrRetireProposed: open.filter((l) => l.status === "stale" || (l.status === "active" && l.retireProposedAt !== undefined)).map(item),
    restrictedCount: lessons.length - open.length,
  };
}
