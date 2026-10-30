// Track record (v1.2, slice 1): how the earned record of a stage is worded. One record is the count of what happened to one kind of claim in the last 30 days (outcomes.ts): it shows on the How we
// work stage cards, next to a less-safe change in a confirmation, and (for the PR risk claim alone, and only to the task's owner) as the early signal on the task page.
// Browser-safe: nothing here imports a Node module, and every text is plain text that a reader escapes for its own markup.
import { z } from "zod";
import { OUTCOME_READ_CAP, OUTCOME_WINDOW_DAYS } from "./outcomes.js";

/** The claims a stage card shows. The PR risk claim is no part of it: it is private to the task's owner (`EarlyRiskSignalSchema`). */
export const HOW_WE_WORK_TRACK_CLAIMS = ["plan_ready", "review_pass:CRITIC", "review_pass:SECURITY", "proves_change"] as const;
export type HowWeWorkTrackClaim = (typeof HOW_WE_WORK_TRACK_CLAIMS)[number];

const Count = z.number().int().min(0).max(OUTCOME_READ_CAP);

/** What one stage card says of one claim: counts only (no task names, no people). `held` and `notHeld` are the rate; the rest are the limits that go beside it. */
export const HowWeWorkTrackRecordSchema = z
  .object({
    claim: z.enum(HOW_WE_WORK_TRACK_CLAIMS),
    held: Count,
    notHeld: Count,
    closedUnmerged: Count,
    noOutcome: Count,
    unreviewedMerges: Count,
    windowDays: z.literal(OUTCOME_WINDOW_DAYS),
    /** The read stopped at its cap: the figures are for the newest samples. */
    capped: z.boolean(),
    /** At least ten samples were held or not held. */
    enough: z.boolean(),
  })
  .strict();
export type HowWeWorkTrackRecord = z.infer<typeof HowWeWorkTrackRecordSchema>;

/** The record of a stage: one per claim (the review stage carries two, one for code review and one for security review). */
export const HowWeWorkTrackRecordsSchema = z.array(HowWeWorkTrackRecordSchema).min(1).max(HOW_WE_WORK_TRACK_CLAIMS.length);

/** The claims a stage of this kind is scored on, and the stage the samples are kept under (the stage kinds a card shows). */
export const HOW_WE_WORK_STAGE_CLAIMS = {
  plan_critic: { stage: "plan_critic", claims: ["plan_ready"] },
  review: { stage: "review", claims: ["review_pass:CRITIC", "review_pass:SECURITY"] },
  check: { stage: "check", claims: ["proves_change"] },
} as const satisfies Record<string, { stage: "plan_critic" | "review" | "check"; claims: readonly HowWeWorkTrackClaim[] }>;

export const hasTrackRecord = (kind: string): kind is keyof typeof HOW_WE_WORK_STAGE_CLAIMS => Object.hasOwn(HOW_WE_WORK_STAGE_CLAIMS, kind);

/** What every line about a review says it cannot see yet. */
export const REVERTS_NOT_TRACKED = "Reverts after merge aren't tracked yet";
const TESTS_CI_NOTE = "CI failures unrelated to the change also count";

const TITLES: Record<HowWeWorkTrackClaim, string> = {
  plan_ready: "Plan check",
  "review_pass:CRITIC": "Code review",
  "review_pass:SECURITY": "Security review",
  proves_change: "Tests",
};

export interface TrackRecordLines {
  /** What the record is about: "Plan check", "Code review", "Security review" or "Tests". */
  title: string;
  /** Line 1: the rate, or "Not enough history yet (N so far)". */
  rate: string;
  /** Line 2: the limits (counts that are not 0, and what Rovara can't see). Absent when there is nothing to say. */
  limits?: string;
}

const times = (count: number) => (count === 1 ? "time" : "times");

/** The two lines of a record, in plain words. A claim this build does not know (a newer server's) has no words: the caller shows nothing for it. */
export function trackRecordLines(record: HowWeWorkTrackRecord): TrackRecordLines {
  const total = record.held + record.notHeld;
  const window = `last ${String(record.windowDays)} days`;
  let rate: string;
  if (!record.enough) rate = `Not enough history yet (${String(total)} so far)`;
  else if (record.claim === "plan_ready") rate = `The person approved the plan ${String(record.held)} of ${String(total)} ${times(total)} (${window})`;
  else if (record.claim === "proves_change") rate = `CI passed on ${String(record.held)} of ${String(total)} PRs where tests said they prove the change (${window})`;
  else rate = `No changes requested by a person on ${String(record.held)} of ${String(total)} merged PRs (${window})`;
  if (record.capped) rate += ` (based on the latest ${String(OUTCOME_READ_CAP)})`;
  const parts: string[] = [];
  if (record.closedUnmerged > 0) parts.push(`${String(record.closedUnmerged)} closed unmerged`);
  if (record.claim.startsWith("review_pass:") && record.unreviewedMerges > 0) parts.push(`${String(record.unreviewedMerges)} merged without a person's review`);
  if (record.noOutcome > 0) parts.push(`${String(record.noOutcome)} with no result to check`);
  if (record.claim.startsWith("review_pass:")) parts.push(REVERTS_NOT_TRACKED);
  if (record.claim === "proves_change") parts.push(TESTS_CI_NOTE);
  return { title: TITLES[record.claim], rate, ...(parts.length === 0 ? {} : { limits: parts.join(" · ") }) };
}

/** Whether a record read from a server is one this build can word (a newer server's claim reads as "unknown" and is left out). */
export const isWordedRecord = (record: { claim: string }): record is HowWeWorkTrackRecord => Object.hasOwn(TITLES, record.claim);

/**
 * The stage a less-safe change is about, so its record can be shown beside it: the stage whose name the change quotes (`... the step "Review" ...`), or else the one it names by kind ("plan check",
 * "review step"). A change about no stage with a record (a tool, a model company, an approval step, the company's defaults) maps to nothing: the confirmation shows no record for it.
 */
export function stageOfLessSafeReason(reason: string, stages: ReadonlyArray<{ id: string; name: string; kind: string }>): string | undefined {
  for (const match of reason.matchAll(/"([^"]+)"/g)) {
    const named = stages.find((stage) => stage.name === match[1]);
    if (named !== undefined) return hasTrackRecord(named.kind) ? named.id : undefined;
  }
  // No step is quoted: only the plain kind words count, and only when no quoted step turned out to be some other stage (a quoted name that is no stage here is a name from another recipe).
  if (/"[^"]+"/.test(reason)) return undefined;
  const kind = /\bplan check\b/i.test(reason) ? "plan_critic" : /\breview step\b/i.test(reason) ? "review" : undefined;
  return kind === undefined ? undefined : stages.find((stage) => stage.kind === kind)?.id;
}

// ---- the early signal for the task's owner (PR risk "low")

/**
 * What the owner of a task reads on the task page when its pull request was published with risk "low": how PRs this project rated low risk went in the last 30 days. Private: the broker sets it only
 * when the viewer is the task's owner, and it is never on the shared card, in a thread or on the pull request. It stays private even above ten samples.
 */
export const EarlyRiskSignalSchema = z
  .object({ held: Count, notHeld: Count, windowDays: z.literal(OUTCOME_WINDOW_DAYS), capped: z.boolean(), enough: z.boolean() })
  .strict();
export type EarlyRiskSignal = z.infer<typeof EarlyRiskSignalSchema>;

/** The words of the early signal. The sample count is always there; below ten samples it says "Early signal, few samples". */
export function earlyRiskSignalText(signal: EarlyRiskSignal): string {
  const total = signal.held + signal.notHeld;
  const lead = signal.enough ? "Early signal" : "Early signal, few samples";
  const cap = signal.capped ? ` (based on the latest ${String(OUTCOME_READ_CAP)})` : "";
  if (total === 0) return `${lead}: no PRs this project rated low risk have been scored yet (last ${String(signal.windowDays)} days). ${REVERTS_NOT_TRACKED}.`;
  return `${lead}: PRs this project rated low risk were merged with no changes requested by a person ${String(signal.held)} of ${String(total)} times (last ${String(signal.windowDays)} days)${cap}. ${REVERTS_NOT_TRACKED}.`;
}
