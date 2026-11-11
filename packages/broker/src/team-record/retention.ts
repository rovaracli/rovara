// Retention routing (design 4.3). One pure function says, for one record row, what is kept and for how long. Times are epoch seconds (the table's TTL unit).
//
//   A live only      : an outside source stores nothing. Rovara's own events keep their structured fields only (never text).
//   B process, drop  : an outside source stores no row (its text goes to the distiller in memory). Rovara's own events keep structured fields only.
//   C raw text 30 d  : the text and the event's vector go after 30 days (text-expiry.ts); the row itself stays like D's and reaches the lake with its structured
//                      fields only, because the archiver takes rows older than 90 days.
//   D full history   : the row stays hot for 90 days, then the archiver writes it to the lake.
//
// `hotExpiresAt` is when the row is due to leave the hot table; `indexExpiresAt` (the TTL attribute) is a grace period later so the archiver has time to copy it
// first. The Public edition's Slack source is fixed at A or B: C and D are never offered for it (Slack's API terms).
import { RECORD_HOT_DAYS, RECORD_RAW_TEXT_DAYS_C, type RecordSystem, type RetentionMode } from "@agentx/cloud-contracts";
import type { Edition } from "./types.js";

const DAY = 86_400;
/** How long past `hotExpiresAt` the TTL waits, so a nightly archiver that missed a night still finds the row. */
export const ARCHIVE_GRACE_DAYS = 7;

export interface RetentionPlan {
  /** Whether a REC row is written at all. */
  store: boolean;
  /** Whether the row may carry text. */
  keepText: boolean;
  /** Whether a vector is made for the row. Only text can be embedded. */
  embed: boolean;
  /** Whether the text goes to the distiller in memory (B). */
  distillTransient: boolean;
  textExpiresAt?: number;
  hotExpiresAt: number;
  indexExpiresAt: number;
}

const ORDER: Record<RetentionMode, number> = { A: 0, B: 1, C: 2, D: 3 };

/** The mode that keeps less of the two. */
export function lessRetention(left: RetentionMode, right: RetentionMode): RetentionMode {
  return ORDER[left] <= ORDER[right] ? left : right;
}

/** Whether `mode` keeps more than `ceiling` allows. */
export function exceedsRetention(mode: RetentionMode, ceiling: RetentionMode): boolean {
  return ORDER[mode] > ORDER[ceiling];
}

/**
 * Why a retention mode is not allowed for a source in an edition, or undefined when it is. The Public edition keeps Slack at A, or at B only with the workspace's opt-in;
 * every other combination is allowed.
 */
export function retentionRefusal(edition: Edition, source: RecordSystem, retention: RetentionMode, notesOptIn = false): "slack_public_fixed_a_b" | "slack_notes_need_opt_in" | undefined {
  if (edition !== "public" || source !== "slack") return undefined;
  if (retention === "C" || retention === "D") return "slack_public_fixed_a_b";
  // Owner decision Q4: Public Slack is read live (A); "notes with links" (B) only when the workspace chose it.
  if (retention === "B" && !notesOptIn) return "slack_notes_need_opt_in";
  return undefined;
}

export function retentionPlan(input: { retention: RetentionMode; source: RecordSystem; hasText: boolean; occurredAtSeconds: number; nowSeconds: number }): RetentionPlan {
  const { retention, source } = input;
  const own = source === "rovara";
  // The age counts from when the item happened, but never reaches into the past so far that a late arrival is gone on arrival: it keeps at least a day.
  const base = Math.min(input.nowSeconds, Math.max(input.occurredAtSeconds, input.nowSeconds - 365 * DAY));
  const hot = (days: number): { hotExpiresAt: number; indexExpiresAt: number } => {
    const hotExpiresAt = Math.max(base + days * DAY, input.nowSeconds + DAY);
    return { hotExpiresAt, indexExpiresAt: hotExpiresAt + ARCHIVE_GRACE_DAYS * DAY };
  };
  switch (retention) {
    case "A":
    case "B": {
      // The structured part of Rovara's own events is kept long-term in both editions; it follows the hot-then-lake route with no text.
      const times = hot(RECORD_HOT_DAYS);
      return { store: own, keepText: false, embed: false, distillTransient: retention === "B" && input.hasText, ...times };
    }
    case "C": {
      const times = hot(RECORD_HOT_DAYS);
      const textExpiresAt = Math.max(base + RECORD_RAW_TEXT_DAYS_C * DAY, input.nowSeconds + DAY);
      return { store: true, keepText: true, embed: input.hasText, distillTransient: false, textExpiresAt, ...times };
    }
    case "D": {
      const times = hot(RECORD_HOT_DAYS);
      return { store: true, keepText: true, embed: input.hasText, distillTransient: false, ...times };
    }
  }
}
