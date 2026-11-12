import type { LookStorageHost } from "../../look.js";
import { uiFlagOn } from "../../ui-flags.js";
/**
 * The new Home switch (experience lane exp/home). This file is the ONLY place that decides whether the new Home is on. Today it is a per-device storage key (`rovara.home` = "v2"),
 * the same cheap switch the new look uses: no contract change, no broker change. Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer:
 * HomeScreen only calls this function. Off (the server's off, or with no server answer a device key that is not "v2") keeps today's Home exactly. The server's answer is `on` by default (decision 116).
 */
export const HOME_STORAGE_KEY = "rovara.home";
export function isNewHomeOn(host: LookStorageHost): boolean {
 return uiFlagOn(host, "home", HOME_STORAGE_KEY);
}
