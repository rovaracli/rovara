import { NAV_REFETCH_MIN_INTERVAL_MS } from "../constants.js";
import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeNotice } from "@agentx/contracts/web";
export function queryKeysFor(notice: RealtimeNotice): unknown[][] {
 switch (notice.type) {
 case "session.updated": return [["session", notice.sessionId], ["live"]];
 case "session.event": return [["session", notice.sessionId, "events"], ["session", notice.sessionId, "messages"]];
 case "home.changed": return [["home"]];
 default: return [];
 }
}
export function createNoticeInvalidator(query: QueryClient) {
 let last = -Infinity;
 return {
 notice(notice: RealtimeNotice) {
 for (const queryKey of queryKeysFor(notice)) void query.invalidateQueries({ queryKey });
 if ((notice.type === "session.updated" || notice.type === "home.changed") && Date.now() - last >= NAV_REFETCH_MIN_INTERVAL_MS) { last = Date.now();void query.invalidateQueries({ queryKey: ["nav"] }); }
 },
 reset() { void query.invalidateQueries(); },
 stop() { last = Infinity; },
 };
}
