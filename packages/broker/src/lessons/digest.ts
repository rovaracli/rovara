// Learning v2 L3a: the weekly digest for the project maintainer (owner decisions Q2 and "Lesson limits"). It leads with the top lessons by importance, then
// lists what went live by itself (only where a project chose "auto"), what waits for people, what was retired, which sources are paused and how many candidates are queued. This builds the
// content; where it is delivered (Slack, email, the Home card) is a later UI task. A lesson from a restricted source appears, with its text, only for a
// viewer who could see that source; for everyone else it is counted and nothing more.
import { OrgIdSchema } from "@agentx/contracts";
import type { LessonStore, ScopeKey } from "./store.js";
import type { AccessCheckPort } from "../team-record/access-port.js";
import { lessonPlaces, satisfiesAcl, type IdentitySet, type Lesson } from "./types.js";
import { lessonValue } from "./value.js";

const WEEK = 7 * 86_400_000;
export const DIGEST_TOP = 5;
export interface DigestItem { id: string; title: string; type: Lesson["type"]; tier: Lesson["tier"]; scope: Lesson["scope"]; links: string[] }
export interface WeeklyDigest {
  since: number;
  /** The most important lessons (active or waiting), by measured outcomes, then recurrence, then severity. */
  top: DigestItem[];
  /** Lessons that stay live but were sent back to a person (for example kept on code alone after their sources were deleted). */
  needsReview: DigestItem[];
  autoApplied: DigestItem[]; waiting: DigestItem[]; retired: DigestItem[]; staleOrRetireProposed: DigestItem[];
  /** Candidates collected and not yet in front of people. Nothing is dropped. */
  queuedCount: number;
  /** Sources paused by spike detection and waiting for the maintainer. A key is named only when the viewer can see every lesson that mentions it. */
  pausedSources: string[];
  /** Paused sources whose key is withheld because naming it could identify a restricted source the viewer cannot see. */
  pausedSourcesHidden: number;
  /** Lessons left out because the viewer could not see their source. */
  restrictedHidden: number;
}

export async function buildWeeklyDigest(store: LessonStore, key: ScopeKey, now: number, viewer: IdentitySet, access: AccessCheckPort, log?: (event: string, fields: Record<string, unknown>) => void): Promise<WeeklyDigest> {
  const since = now - WEEK;
  const all = await store.list(key);
  const item = (l: Lesson): DigestItem => ({ id: l.id, title: l.title, type: l.type, tier: l.tier, scope: l.scope, links: l.citations.flatMap((c) => (c.kind === "pr" ? [c.url] : [])) });
  // The frozen snapshot AND the access records now, for the places each lesson was learned from (an unreadable record fails the digest rather than showing or hiding a guess).
  const current = new Map<string, boolean>();
  const noPort = (access as AccessCheckPort | undefined) === undefined;
  if (noPort) log?.("learning.digest_no_access_port", {}); // fail closed: no lesson is shown without the check
  else {
    const placed = all.filter((l) => lessonPlaces(l).scopes.length > 0);
    const answers = placed.length === 0 ? [] : await access.mayRead(OrgIdSchema.parse(key.workspaceId), viewer, placed.map((l) => lessonPlaces(l)));
    for (const [index, l] of placed.entries()) current.set(l.id, answers[index] === true);
  }
  const visible = (l: Lesson): boolean => (l.provenance.audience.kind !== "restricted" || satisfiesAcl(viewer, l.provenance.audience.acl)) && !noPort && current.get(l.id) !== false;
  const shown = all.filter(visible);
  const byValue = (a: Lesson, b: Lesson): number => lessonValue(b) - lessonValue(a) || a.id.localeCompare(b.id);
  return {
    since,
    top: shown.filter((l) => l.status === "active" || l.status === "pending").sort(byValue).slice(0, DIGEST_TOP).map(item),
    needsReview: shown.filter((l) => l.reviewRequired === true && l.status === "active").sort(byValue).map(item),
    autoApplied: shown.filter((l) => l.status === "active" && l.approvals.some((a) => a.mode === "auto") && l.updatedAt >= since).sort(byValue).map(item),
    waiting: shown.filter((l) => l.status === "pending").sort(byValue).map(item),
    retired: shown.filter((l) => (l.status === "retired" || l.status === "expired") && l.updatedAt >= since).map(item),
    staleOrRetireProposed: shown.filter((l) => l.status === "stale" || (l.status === "active" && l.retireProposedAt !== undefined)).map(item),
    queuedCount: all.filter((l) => l.status === "candidate").length,
    ...(await pausedSourcesFor(store, key, all, visible)),
    restrictedHidden: all.length - shown.length,
  };
}

/** Keys that are plainly about a project member or CI are always safe to name; anything else (a channel, a tracker folder) only if known lessons mention it and the viewer sees all of them. */
const ALWAYS_NAMEABLE = /^(member:|ci$|kind:)/u;
async function pausedSourcesFor(store: LessonStore, key: ScopeKey, all: readonly Lesson[], visible: (l: Lesson) => boolean): Promise<{ pausedSources: string[]; pausedSourcesHidden: number }> {
  const keys = Object.keys((await store.flags(key)).pausedSources ?? {}).sort();
  const named: string[] = [];
  for (const source of keys) {
    const mentions = all.filter((l) => l.provenance.sources.includes(source) || l.provenance.inputSources.includes(source));
    if (ALWAYS_NAMEABLE.test(source) || (mentions.length > 0 && mentions.every(visible))) named.push(source);
  }
  return { pausedSources: named, pausedSourcesHidden: keys.length - named.length };
}
