import { LIVE_REFETCH_DEBOUNCE_MS, NAV_REFETCH_MIN_INTERVAL_MS } from "../constants.js";
import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeNotice } from "@agentx/cloud-contracts/web";
export function queryKeysFor(notice: RealtimeNotice): unknown[][] {
 switch (notice.type) {
 // UX2 slice 2: a session that changed may have moved on Home's one "needs you" list (a decision card, a blocked or paused card), so Home and the cards are read again too.
 case "session.updated": return [["session", notice.sessionId], ["live"], ["home"], ["decisions"]];
 case "session.event": return [["session", notice.sessionId, "events"], ["session", notice.sessionId, "messages"]];
 case "home.changed": return [["home"], ["decisions"]];
 default: return [];
 }
}
export function createNoticeInvalidator(query: QueryClient) {
 let last = -Infinity, stopped = false;
 let liveTimer: ReturnType<typeof setTimeout> | undefined;
 return {
 notice(notice: RealtimeNotice) {
 if (stopped) return;
 for (const queryKey of queryKeysFor(notice)) {
 if (queryKey[0] === "live") { if (liveTimer === undefined) liveTimer = setTimeout(() => { liveTimer = undefined;void query.invalidateQueries({ queryKey: ["live"] }); }, LIVE_REFETCH_DEBOUNCE_MS); }
 else void query.invalidateQueries({ queryKey });
 }
 if ((notice.type === "session.updated" || notice.type === "home.changed") && Date.now() - last >= NAV_REFETCH_MIN_INTERVAL_MS) { last = Date.now();void query.invalidateQueries({ queryKey: ["nav"] }); }
 },
 reset() { if (stopped) return;clearTimeout(liveTimer);liveTimer = undefined;void query.invalidateQueries(); },
 stop() { stopped = true;last = Infinity;clearTimeout(liveTimer);liveTimer = undefined; },
 };
}
