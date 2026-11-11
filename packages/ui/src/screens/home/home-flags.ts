import type { LookStorageHost } from "../../look.js";
/**
 * The new Home switch (experience lane exp/home). This file is the ONLY place that decides whether the new Home is on. Today it is a per-device storage key (`rovara.home` = "v2"),
 * the same cheap switch the new look uses: no contract change, no broker change. When per-company runtime flags exist, change `isNewHomeOn` to read the flag and nothing else moves:
 * HomeScreen only calls this function. Off (the default, and any other value, and unreadable storage) keeps today's Home exactly.
 */
export const HOME_STORAGE_KEY = "rovara.home";
export function isNewHomeOn(host: LookStorageHost): boolean {
 try { return host.storage.get(HOME_STORAGE_KEY) === "v2"; } catch { return false; }
}
