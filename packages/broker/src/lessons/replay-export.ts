// Lane 7 (DECISIONS 68; re-check "faithful B"): the ONE rule by which an offline pipeline's lessons become an arm's frozen snapshot. A pipeline (B now, C when lane 8 is ported) runs the real curator against its own
// store; at the end of each simulated day its store is exported by this function and by nothing else. A lesson is exported only if it is ACTIVE and would be delivered WITHOUT a person under the project's real rules:
// the same `approvedForUse` the loader and delivery apply (tier, approvals required, the trial rules, `trialAllowed` from the project's real settings) and not stale. Everything else the pipeline proposed (pending,
// candidate, or active but short of the approvals the project asks for) is COUNTED, not delivered: it is what the live system would have put in front of people, and the replay does not pretend they said yes.
// The same function is the port contract: `buildSnapshots` refuses a builder whose result does not carry `REPLAY_EXPORT_RULE`, so a pipeline that exports by any other rule cannot be an arm.
import { approvedForUse, hasStaleCitation } from "./load.js";
import type { ApprovalPolicy } from "./policy.js";
import { EVAL_SNAPSHOT_MAX_LESSONS } from "./replay-snapshot-store.js";
import type { Lesson } from "./types.js";

export const REPLAY_EXPORT_RULE = "active-without-a-person/v1" as const;

/** What a pipeline's export of one simulated day says, beside its lessons. */
export interface ReplayExport {
  rule: typeof REPLAY_EXPORT_RULE;
  /** The lessons delivered: active, approved for use without a person under the project's rules, not stale; newest first, at most the snapshot cap. */
  lessons: Lesson[];
  /** Lessons the pipeline proposed that are still live proposals: active, pending or candidate. */
  proposed: number;
  /** Of those, how many would have needed a person (not delivered). */
  needsPerson: number;
  /** Lessons that qualified but were cut at the snapshot cap. */
  truncated: number;
  /** Proposed lessons with a code citation that was not verified (checked "unknown", or not checked at all): under the live rule they do not go live on trial, so they wait for a person. */
  unverified: number;
}

/** Whether a proposed lesson has a code citation nobody verified. A check is recorded only when the verifier could tell (valid, moved or stale); "unknown" leaves none. A citation found stale is a known answer, not an unverified one. */
const hasUnverifiedCitation = (lesson: Lesson): boolean => lesson.citations.some((citation, index) => citation.kind === "code" && !(lesson.citationChecks ?? []).some((check) => check.index === index));

/**
 * What an offline pipeline's delivered lessons must look like, whatever the builder says about itself: each is ACTIVE, and none carries the approval of a person (offline there are none; a trial or automatic approval is the
 * pipeline's own). A builder that exports pending lessons as active, or makes up a person's approval, fails here. Pure.
 */
export function exportViolations(lessons: readonly Lesson[]): string[] {
  const out: string[] = [];
  for (const lesson of lessons) {
    if (lesson.status !== "active") out.push(`${lesson.id}: not active`);
    if (lesson.approvals.some((approval) => approval.mode !== "auto" && approval.mode !== "trial")) out.push(`${lesson.id}: carries a person's approval`);
  }
  return out;
}

export function exportWithoutAPerson(input: { lessons: readonly Lesson[]; approval: ApprovalPolicy; trialAllowed: boolean }): ReplayExport {
  const proposed = input.lessons.filter((lesson) => lesson.status === "active" || lesson.status === "pending" || lesson.status === "candidate");
  const qualified = proposed.filter((lesson) => lesson.status === "active" && !hasStaleCitation(lesson) && approvedForUse(lesson, input.approval, (id) => id, input.trialAllowed));
  const ordered = [...qualified].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
  return { rule: REPLAY_EXPORT_RULE, lessons: ordered.slice(0, EVAL_SNAPSHOT_MAX_LESSONS), proposed: proposed.length, needsPerson: proposed.length - qualified.length, truncated: Math.max(0, ordered.length - EVAL_SNAPSHOT_MAX_LESSONS), unverified: proposed.filter(hasUnverifiedCitation).length };
}
