import { useMemo } from "react";
import type { LookStorageHost } from "../../look.js";
import { useAppHost } from "../../host.js";
/**
 * The "Continue in your own tool" switch (experience lane exp/continue-in-tool, owner decision D4). This file is the ONLY place that decides whether the task page offers the panel that
 * helps a person pick a task up in their own Claude Code, Codex or Cursor. Today it is a per-device storage key (`rovara.continue` = "v2"), the same cheap switch the new look and the agent
 * publishing use: no contract change, no broker change (the ui-flags contract has no name for it yet). When per-company runtime flags exist, change `isContinueInToolOn` to read the flag and
 * nothing else moves. Off (the default, any other value, unreadable storage) leaves the task page exactly as it was: no button, no chunk, no read.
 */
export const CONTINUE_STORAGE_KEY = "rovara.continue";
export function isContinueInToolOn(host: LookStorageHost): boolean {
 try { return host.storage.get(CONTINUE_STORAGE_KEY) === "v2"; } catch { return false; }
}
export function useContinueInToolOn(): boolean { const host = useAppHost();return useMemo(() => isContinueInToolOn(host), [host]); }
