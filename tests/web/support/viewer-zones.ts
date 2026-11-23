import { vi } from "vitest";
export const VIEWER_INSTANT = "2026-11-22T01:30:00.000Z";
// Literal expectations cross a date boundary; neither side uses the production formatter.
export const VIEWER_ZONES = [
 { zone: "America/Los_Angeles", day: "Nov 21", date: "Nov 21, 2026", numeric: "11/21/2026", timestamp: "11/21/2026, 5:30:00 PM", short: "Nov 21, 05:30 PM", clock: "Nov 21, 17:30" },
 { zone: "Pacific/Auckland", day: "Nov 22", date: "Nov 22, 2026", numeric: "11/22/2026", timestamp: "11/22/2026, 2:30:00 PM", short: "Nov 22, 02:30 PM", clock: "Nov 22, 14:30" },
] as const;
export async function inViewerZones(run: (expected: typeof VIEWER_ZONES[number]) => Promise<void>) {
 for (const expected of VIEWER_ZONES) {
  vi.stubEnv("TZ", expected.zone);
  try { await run(expected); } finally { vi.unstubAllEnvs(); }
 }
}
