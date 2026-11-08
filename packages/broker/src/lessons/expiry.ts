// Learning v2 L5: lesson expiry (design §4.6, decision Q7). A lesson lasts 90 days from approval or its last validated helpful use, and each such use
// renews it. The window is configurable from 14 to 365 days per project. A preference lasts 180 days unless the project chose another window. A fact whose
// code citations still validate renews whenever they validate.
import { CHANGE_APPROVAL_TTL_DAYS } from "@agentx/contracts";
import { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, MIN_EXPIRY_DAYS, PREFERENCE_EXPIRY_DAYS, emitAudit } from "./policy.js";
import type { LessonDeps } from "./ports.js";
import type { LessonStore, ScopeKey } from "./store.js";
import type { Lesson, LessonType } from "./types.js";
import { nextVersion } from "./store.js";

const DAY = 86_400_000;

export function expiryWindowMs(type: LessonType, configuredDays: number | undefined): number {
  const days = configuredDays !== undefined && Number.isInteger(configuredDays) && configuredDays >= MIN_EXPIRY_DAYS && configuredDays <= MAX_EXPIRY_DAYS
    ? configuredDays : type === "preference" ? PREFERENCE_EXPIRY_DAYS : DEFAULT_EXPIRY_DAYS;
  return days * DAY;
}
export const pendingExpiry = (now: number): number => now + CHANGE_APPROVAL_TTL_DAYS * DAY;

/**
 * Renews a lesson after a validated helpful use, or after its code citations validated. Never shortens an expiry. Only a fact is renewed by a validated load (owner answer Q7: "renewed on validated helpful
 * use; facts with valid citations renew on validation"). A lesson of any other type is renewed by a helpful use only, so one that is merely loaded, and so never judged, still lapses; the one gap that left
 * (a use in the last 14 days before expiry, whose helpful mark falls due after it) is closed where the mark is queued (`recordTaskOutcome` holds the expiry until the mark settles).
 */
export async function renewLesson(store: LessonStore, key: ScopeKey, id: string, now: number, configuredDays: number | undefined, reason: "helpful" | "validated"): Promise<Lesson | undefined> {
  return store.mutate(key, id, (lesson) => {
    if (lesson.status !== "active") return undefined;
    if (reason === "validated" && lesson.type !== "fact") return { lastValidatedAt: now };
    const renewed = now + expiryWindowMs(lesson.type, configuredDays);
    return { expiresAt: Math.max(lesson.expiresAt, renewed), ...(reason === "helpful" ? { lastHelpfulAt: now } : {}), lastValidatedAt: now };
  });
}

/** Whether a lesson is due to expire now: an active one past its expiry, or a pending one nobody decided in time. */
const dueAt = (lesson: Lesson, now: number): boolean => (lesson.status === "active" ? lesson.expiresAt <= now : lesson.status === "pending" && (lesson.pendingExpiresAt ?? Infinity) <= now);

/** The lessons read at a time by the sweep. */
export const SWEEP_PAGE = 100;

/**
 * Moves active lessons past their expiry to `expired`, and pending lessons nobody decided in time to `expired`. A lesson in `pinned` (referenced by a frozen eval snapshot) is left alone. Bounded: at most `limit`
 * lessons per run, `stop` is asked before each one (the caller's time budget), and the lessons are read a page at a time. `holdPendingUntil` leaves pending lessons alone until that time (the grace window after
 * learning is switched back on). The rule is checked again on the fresh copy of each lesson, so one that was approved, edited or renewed since the page was read is left as it is.
 */
export async function sweepExpired(deps: LessonDeps, store: LessonStore, key: ScopeKey, options: { pinned?: ReadonlySet<string>; limit?: number; stop?: () => boolean; holdPendingUntil?: number } = {}): Promise<{ expired: string[]; stopped: boolean }> {
  const now = deps.now();
  const limit = options.limit ?? 200;
  const expired: string[] = [];
  const held = (lesson: Lesson): boolean => options.pinned?.has(lesson.id) === true || (lesson.status === "pending" && options.holdPendingUntil !== undefined && now < options.holdPendingUntil);
  let after: string | undefined;
  do {
    const page = await store.listPage(key, { statuses: ["active", "pending"], limit: SWEEP_PAGE, ...(after === undefined ? {} : { after }) });
    for (const lesson of page.lessons.filter((l) => dueAt(l, now) && !held(l))) {
      if (expired.length >= limit) return { expired, stopped: false };
      if (options.stop?.() === true) return { expired, stopped: true };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const fresh = await store.get(key, lesson.id);
        if (fresh === undefined || (fresh.status !== "active" && fresh.status !== "pending") || !dueAt(fresh, now) || held(fresh)) break;
        const setVersion = await store.setVersion(key);
        const result = await store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await store.versions(key, fresh.id)), status: "expired", updatedAt: now }], now);
        if (result.ok) {
          expired.push(lesson.id);
          await emitAudit(deps.audit, { action: "lesson.expired", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, facts: { was: fresh.status } });
          break;
        }
        // The fence (an erased person) is final; only a lost race is read again.
        if (result.reason !== "conflict") break;
      }
    }
    after = page.next;
  } while (after !== undefined);
  return { expired, stopped: false };
}
