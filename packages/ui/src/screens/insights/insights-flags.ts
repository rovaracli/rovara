import { uiFlagOn } from "../../ui-flags.js";
/**
 * The Insights switch (experience lane exp/insights). This file is the ONLY place that decides whether Insights is on. Today it is a per-device storage key (`rovara.insights` = "v2"),
 * the same cheap switch the new look uses (`isNewLookOn`): no contract change, no broker change. Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer.
 * The server's answer is `on` by default (decision 116); the broker's own switch (`in`) still decides whether there is anything to show. Off (the server's off, or with no server answer a device key that is not "v2") means no Insights route, no navigation entry and no Insights request, so today's app is unchanged.
 * Even when it is on, the navigation entry shows only while the server says this person may see Insights (the overview read).
 */
export interface InsightsStorageHost { storage: { get(key: string): string | undefined } }
export const INSIGHTS_STORAGE_KEY = "rovara.insights";
export function isInsightsOn(host: InsightsStorageHost): boolean {
 return uiFlagOn(host, "insights", INSIGHTS_STORAGE_KEY);
}
