import { LIVE_REFETCH_DEBOUNCE_MS, NAV_REFETCH_MIN_INTERVAL_MS } from "../constants.js";
import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeNotice } from "@agentx/contracts/web";
export function queryKeysFor(notice: RealtimeNotice): unknown[][] {
 switch (notice.type) {
 // "work" is the task page's and the Work page's reads (plan, proof, build activity, comments): they change when the session does.
 case "session.updated": return [["session", notice.sessionId], ["live"], ["work"]];
 case "session.event": return [["session", notice.sessionId, "events"], ["session", notice.sessionId, "messages"]];
 case "home.changed": return [["home"]];
 default: return [];
 }
}
export function createNoticeInvalidator(query: QueryClient) {
 let last = -Infinity, stopped = false;
 let liveTimer: ReturnType<typeof setTimeout> | undefined;
 const queued = new Set<string>();
 return {
 notice(notice: RealtimeNotice) {
 if (stopped) return;
 for (const queryKey of queryKeysFor(notice)) {
 if (queryKey[0] === "live" || queryKey[0] === "work") { queued.add(String(queryKey[0]));if (liveTimer === undefined) liveTimer = setTimeout(() => { liveTimer = undefined;const keys = [...queued];queued.clear();for (const key of keys) void query.invalidateQueries({ queryKey: [key] }); }, LIVE_REFETCH_DEBOUNCE_MS); }
 else void query.invalidateQueries({ queryKey });
 }
 if ((notice.type === "session.updated" || notice.type === "home.changed") && Date.now() - last >= NAV_REFETCH_MIN_INTERVAL_MS) { last = Date.now();void query.invalidateQueries({ queryKey: ["nav"] }); }
 },
 reset() { if (stopped) return;clearTimeout(liveTimer);liveTimer = undefined;queued.clear();void query.invalidateQueries(); },
 stop() { stopped = true;last = Infinity;clearTimeout(liveTimer);liveTimer = undefined;queued.clear(); },
 };
}
