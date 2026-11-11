import type { LookStorageHost } from "../../look.js";
/**
 * The rich project setup switch (experience lane exp/project-setup). This file is the ONLY place that decides whether the new project setup is on. Today it is a per-device storage key (`rovara.setup` = "v2"),
 * the same cheap switch the new look uses (`isNewLookOn` in look.ts): no contract change, no broker change. When per-company runtime flags exist, change `isProjectSetupV2On` to read the flag and nothing else moves:
 * OnboardScreen only calls this function. Off (the default, any other value, and unreadable storage) keeps today's six-step onboarding exactly.
 */
export const PROJECT_SETUP_STORAGE_KEY = "rovara.setup";
export function isProjectSetupV2On(host: LookStorageHost): boolean {
 try { return host.storage.get(PROJECT_SETUP_STORAGE_KEY) === "v2"; } catch { return false; }
}
