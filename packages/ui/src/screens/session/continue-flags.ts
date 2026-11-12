import { useState } from "react";
import type { LookStorageHost } from "../../look.js";
import { useAppHost } from "../../host.js";
import { uiFlagOn } from "../../ui-flags.js";
/**
 * The "Continue in your own tool" switch (experience lane exp/continue-in-tool, owner decision D4). This file is the ONLY place that decides whether the task page offers the panel that
 * helps a person pick a task up in their own Claude Code, Codex or Cursor, and whether the task-lead shows "Changed outside Rovara". Runtime per-company flag (lane U5, decision 98): this function
 * calls `uiFlagOn` (ui-flags.ts) with the flag `continue`: the company's value from the navigation answer wins when it is on or off, and this device's key (`rovara.continue` = "v2") only decides when
 * the company allows previews or the server sends no answer. It is read ONCE, when the task page mounts (`useContinueInToolOn`, called by SessionScreen, which hands the value to TaskLead), so the panel and the
 * "Changed outside Rovara" chip always agree, and a change of the company's answer reaches a person when the task page next mounts.
 * Off (the default, any other value, unreadable storage) leaves the task page exactly as it was: no button, no chunk, no read.
 */
export const CONTINUE_STORAGE_KEY = "rovara.continue";
export function isContinueInToolOn(host: LookStorageHost): boolean {
 return uiFlagOn(host, "continue", CONTINUE_STORAGE_KEY);
}
/** The switch as the task page saw it when it mounted: later navigation answers do not move it until the page mounts again. */
export function useContinueInToolOn(): boolean { const host = useAppHost();const [on] = useState(() => isContinueInToolOn(host));return on; }
