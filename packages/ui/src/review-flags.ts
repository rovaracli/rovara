/**
 * The review groups switch (lane exp/review-groups). This file is the ONLY place that decides whether the Review groups section of a project and the review card of a task are on in the app.
 * Today the switch is a per-device storage key (`rovara.reviews` = "v2"), the same cheap switch the company switcher uses (company-flags.ts): no contract change, no broker change.
 * Off, the project page and the task page are exactly as they were and the review routes are never called. When the server sends a flag for it, change `isReviewGroupsOn` to read it and nothing else moves.
 */
export interface ReviewStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const REVIEWS_STORAGE_KEY = "rovara.reviews";
export function isReviewGroupsOn(host: ReviewStorageHost): boolean {
 try { return host.storage.get(REVIEWS_STORAGE_KEY) === "v2"; } catch { return false; }
}
