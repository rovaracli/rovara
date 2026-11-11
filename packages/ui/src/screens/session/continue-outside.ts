import { CHANGED_OUTSIDE_LABEL } from "@agentx/cloud-contracts/web";
import type { ReadTask } from "./workspace-types.js";
/**
 * "Changed outside Rovara · checks needed" (lane exp/continue-loop): what the task view's `continueLoop.outside` rows say, as plain functions with no React and no reads. The task page's plain state
 * and the "Continue in your own tool" panel both use them, so the two say the same words. The words themselves come from the contracts (`CHANGED_OUTSIDE_LABEL`); nothing here invents a state.
 */
export type ContinueLoop = NonNullable<ReadTask["continueLoop"]>;
export type OutsideRow = ContinueLoop["outside"][number];
export const CHANGED_OUTSIDE = CHANGED_OUTSIDE_LABEL;
export const OUTSIDE_WHY = "Someone outside Rovara pushed to the branch, so Rovara's checks don't cover the new code.";

/** The rows that say "changed outside Rovara" for this task, or none. */
export const outsideRowsOf = (loop: ContinueLoop | undefined): readonly OutsideRow[] => loop?.outside ?? [];

/** A time as "5m ago" / "2h ago" / "3d ago". Anything that is not a time gives undefined, so the line leaves it out. */
export function agoShort(at: string, now: number): string | undefined {
 const time = Date.parse(at);
 if (Number.isNaN(time)) return undefined;
 const minutes = Math.max(0, Math.floor((now - time) / 60_000));
 return minutes < 1 ? "just now" : minutes < 60 ? String(minutes) + "m ago" : minutes < 1440 ? String(Math.floor(minutes / 60)) + "h ago" : String(Math.floor(minutes / 1440)) + "d ago";
}

/**
 * "Last pushed by <login> <time>", or "Last pushed by someone outside Rovara" where the host's own push event named nobody for this head. With more than one row, each line starts with where it is
 * ("repo #7: ..."), so the lines can be told apart.
 */
export function pushedByWords(row: OutsideRow, now: number, withPlace: boolean): string {
 const ago = row.lastPushedBy === undefined ? undefined : agoShort(row.lastPushedBy.at, now);
 const who = row.lastPushedBy === undefined ? "someone outside Rovara" : row.lastPushedBy.login + (ago === undefined ? "" : " " + ago);
 return (withPlace ? row.repository + (row.number === undefined ? "" : " #" + String(row.number)) + ": " : "") + "Last pushed by " + who;
}
export const pushedByLines = (rows: readonly OutsideRow[], now: number): string[] => rows.map(row => pushedByWords(row, now, rows.length > 1));
