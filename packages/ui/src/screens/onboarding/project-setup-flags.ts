import type { LookStorageHost } from "../../look.js";
import { uiFlagOn } from "../../ui-flags.js";
/**
 * The rich project setup switch (experience lane exp/project-setup). This file is the ONLY place that decides whether the new project setup is on. Today it is a per-device storage key (`rovara.setup` = "v2"),
 * the same kind of switch as the other `*-flags.ts` files: no contract change, no broker change. Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer:
 * OnboardScreen only calls this function. Off (the default, any other value, and unreadable storage) keeps today's six-step onboarding exactly.
 */
export const PROJECT_SETUP_STORAGE_KEY = "rovara.setup";
export function isProjectSetupV2On(host: LookStorageHost): boolean {
 return uiFlagOn(host, "setup", PROJECT_SETUP_STORAGE_KEY);
}
