/**
 * The Insights switch (experience lane exp/insights). This file is the ONLY place that decides whether Insights is on. Today it is a per-device storage key (`rovara.insights` = "v2"),
 * the same cheap switch the new look uses (`isNewLookOn`): no contract change, no broker change. When per-company runtime flags exist, change `isInsightsOn` to read the flag and nothing else moves.
 * Off (the default, any other value, and unreadable storage) means no Insights route, no navigation entry and no Insights request, so today's app is unchanged.
 * Even when it is on, the navigation entry shows only while the server says this person may see Insights (the overview read).
 */
export interface InsightsStorageHost { storage: { get(key: string): string | undefined } }
export const INSIGHTS_STORAGE_KEY = "rovara.insights";
export function isInsightsOn(host: InsightsStorageHost): boolean {
 try { return host.storage.get(INSIGHTS_STORAGE_KEY) === "v2"; } catch { return false; }
}
