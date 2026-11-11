import { useLocation } from "react-router";
import { uiFlagResolve, useUiFlagServerState } from "../../ui-flags.js";
import type { UiFlagState } from "../../api/ui-flags.js";
/**
 * The one place that says which parts of the experience-lane task page are on (exp/task-page, 2026-11-11).
 *
 * - `plainNotices` (default ON): copy only. Repeated model-fallback notices collapse into one plain line with the raw model ids behind a "Details"
 *   disclosure, and a raw worker word ("Worker status: SUCCEEDED") reads as a plain state. No data, order or control changes.
 * - `leadingHeader` (default OFF): a header block (plain state, next step, who, why, the one existing primary action), and on a phone the order
 *   "can I approve?" line, then the decision card, then the details and evidence collapsed. It adds derived content and moves controls, so it stays off
 *   until the owner has looked at it. Preview it on any install with `?lead=1` in the page address (`?lead=0` forces it off).
 *
 * Runtime per-company flag (lane U5): `leadingHeader` is a server flag (ui-flags.ts). Server `on` shows it to everyone in the company (`?lead=0` does not hide it); server `preview` lets `?lead=1` show it on this device;
 * server `off` hides it whatever the address says. With no server answer (an older broker) `?lead=` works as it did.
 */
export interface TaskPageFlags { plainNotices: boolean; leadingHeader: boolean }
export const TASK_PAGE_DEFAULTS: Readonly<TaskPageFlags> = { plainNotices: true, leadingHeader: false };
let forced: Partial<TaskPageFlags> | undefined;
/** Tests only: force flags until called with `undefined`. */
export function forceTaskPageFlags(next: Partial<TaskPageFlags> | undefined): void { forced = next; }
/** `search` is the page address's query (the caller reads it from the router); without it only the defaults and forced flags apply. */
export function taskPageFlags(search = "", leadingHeaderServer?: UiFlagState): TaskPageFlags {
 const lead = new URLSearchParams(search).get("lead");
 // The address asks for the preview only with `?lead=1`; `?lead=0` stays an explicit "off" where the server leaves the choice to the device.
 const device = lead === "1" ? true : lead === "0" ? false : TASK_PAGE_DEFAULTS.leadingHeader;
 return { ...TASK_PAGE_DEFAULTS, leadingHeader: uiFlagResolve(leadingHeaderServer, device), ...forced };
}

/** The flags for this page: the defaults, the page address's `?lead=`, and any forced in a test. */
export function useTaskPageFlags(): TaskPageFlags { return taskPageFlags(useLocation().search, useUiFlagServerState("leadingHeader")); }
