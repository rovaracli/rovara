// Learning v2 L5: lesson expiry (design §4.6, decision Q7). A lesson lasts 90 days from approval or its last validated helpful use, and each such use
// renews it. The window is configurable from 14 to 365 days per project. A preference lasts 180 days unless the project chose another window. A fact whose
// code citations still validate renews whenever they validate.
import { CHANGE_APPROVAL_TTL_DAYS } from "@agentx/contracts";
import { DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, MIN_EXPIRY_DAYS, PREFERENCE_EXPIRY_DAYS, emitAudit } from "./policy.js";
import type { LessonDeps, LessonVectors } from "./ports.js";
import { dropVector } from "./similarity.js";
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

/** Renews a lesson after a validated helpful use, or after its code citations validated (facts). Never shortens an expiry. */
export async function renewLesson(store: LessonStore, key: ScopeKey, id: string, now: number, configuredDays: number | undefined, reason: "helpful" | "validated"): Promise<Lesson | undefined> {
  return store.mutate(key, id, (lesson) => {
    if (lesson.status !== "active") return undefined;
    if (reason === "validated" && lesson.type !== "fact") return { lastValidatedAt: now };
    const renewed = now + expiryWindowMs(lesson.type, configuredDays);
    return { expiresAt: Math.max(lesson.expiresAt, renewed), ...(reason === "helpful" ? { lastHelpfulAt: now } : {}), lastValidatedAt: now };
  });
}

/**
 * Moves active lessons past their expiry to `expired`, and pending lessons nobody decided in time to `expired`. A lesson in `pinned` (referenced by a
 * frozen eval snapshot) is left alone. Bounded: at most `limit` lessons per run.
 */
export async function sweepExpired(deps: LessonDeps & { vectors?: LessonVectors }, store: LessonStore, key: ScopeKey, options: { pinned?: ReadonlySet<string>; limit?: number } = {}): Promise<{ expired: string[] }> {
  const now = deps.now();
  const expired: string[] = [];
  const due = (await store.list(key, { statuses: ["active", "pending"] })).filter((l) => (l.status === "active" ? l.expiresAt <= now : (l.pendingExpiresAt ?? Infinity) <= now) && options.pinned?.has(l.id) !== true);
  for (const lesson of due.slice(0, options.limit ?? 200)) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fresh = await store.get(key, lesson.id);
      if (fresh === undefined || (fresh.status !== "active" && fresh.status !== "pending")) break;
      const setVersion = await store.setVersion(key);
      const result = await store.commit(key, setVersion, [{ ...fresh, version: nextVersion(fresh, await store.versions(key, fresh.id)), status: "expired", updatedAt: now }], now);
      if (result.ok) {
        expired.push(lesson.id);
        await dropVector(deps.vectors, key, lesson.id);
        await emitAudit(deps.audit, { action: "lesson.expired", workspaceId: key.workspaceId, project: key.project, lessonId: lesson.id, facts: { was: fresh.status } });
        break;
      }
    }
  }
  return { expired };
}
