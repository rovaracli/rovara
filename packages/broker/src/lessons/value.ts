// Learning v2: how much a lesson is worth (owner decision "Lesson limits"). Used to order the queue, the Lessons tab and the weekly digest, and to decide
// whether a tier-0 fact has been backed up. Order of importance: measured outcomes first (a send-back, a revert, a CI failure), then recurrence across
// tasks and people, then severity (safety and correctness above style). For an active lesson, its own helpful and harmful marks count too.
import type { Lesson, SpanKind } from "./types.js";

/** Evidence that something went measurably wrong or right, as opposed to a person's opinion. */
const MEASURED: ReadonlySet<SpanKind> = new Set(["send_back", "ci_failure", "outcome", "review_finding"]);
export const hasMeasuredOutcome = (provenance: Pick<Lesson["provenance"], "sourceKinds">): boolean => provenance.sourceKinds.some((k) => MEASURED.has(k));

/**
 * Tier-0 auto-apply needs corroboration: a measured outcome behind it, or two independent tasks (two different tasks, not one task read twice). A fact
 * from a single source waits until something backs it up.
 */
export const isCorroborated = (provenance: Pick<Lesson["provenance"], "sourceKinds" | "supportTasks">): boolean =>
  hasMeasuredOutcome(provenance) || new Set(provenance.supportTasks).size >= 2;

const SEVERITY: Record<Lesson["type"], number> = { pitfall: 3, review_check: 3, fact: 2, convention: 2, procedure: 1, preference: 0 };

/** A number to sort by, larger is more important. The three groups never overlap: measured outcomes outrank recurrence, which outranks severity. */
export function lessonValue(lesson: Pick<Lesson, "provenance" | "type" | "tier" | "counters">): number {
  const measured = hasMeasuredOutcome(lesson.provenance) ? 1 : 0;
  const recurrence = Math.min(99, new Set(lesson.provenance.supportTasks).size * 4 + new Set(lesson.provenance.authors).size * 2 + lesson.counters.helpful - lesson.counters.harmful * 3);
  const severity = SEVERITY[lesson.type] + (lesson.tier === 2 ? 1 : 0);
  return measured * 10_000 + Math.max(0, recurrence) * 10 + severity;
}
