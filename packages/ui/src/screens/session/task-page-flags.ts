import { useLocation } from "react-router";
/**
 * The one place that says which parts of the experience-lane task page are on (exp/task-page, 2026-11-11).
 *
 * - `plainNotices` (default ON): copy only. Repeated model-fallback notices collapse into one plain line with the raw model ids behind a "Details"
 *   disclosure, and a raw worker word ("Worker status: SUCCEEDED") reads as a plain state. No data, order or control changes.
 * - `leadingHeader` (default OFF): a header block (plain state, next step, who, why, the one existing primary action), and on a phone the order
 *   "can I approve?" line, then the decision card, then the details and evidence collapsed. It adds derived content and moves controls, so it stays off
 *   until the owner has looked at it. Preview it on any install with `?lead=1` in the page address (`?lead=0` forces it off).
 *
 * Later this function reads a runtime per-company flag instead (the nav's features); callers do not change.
 */
export interface TaskPageFlags { plainNotices: boolean; leadingHeader: boolean }
export const TASK_PAGE_DEFAULTS: Readonly<TaskPageFlags> = { plainNotices: true, leadingHeader: false };
let forced: Partial<TaskPageFlags> | undefined;
/** Tests only: force flags until called with `undefined`. */
export function forceTaskPageFlags(next: Partial<TaskPageFlags> | undefined): void { forced = next; }
/** `search` is the page address's query (the caller reads it from the router); without it only the defaults and forced flags apply. */
export function taskPageFlags(search = ""): TaskPageFlags {
 const lead = new URLSearchParams(search).get("lead");
 return { ...TASK_PAGE_DEFAULTS, ...(lead === "1" ? { leadingHeader: true } : lead === "0" ? { leadingHeader: false } : {}), ...forced };
}

/** The flags for this page: the defaults, the page address's `?lead=`, and any forced in a test. */
export function useTaskPageFlags(): TaskPageFlags { return taskPageFlags(useLocation().search); }
