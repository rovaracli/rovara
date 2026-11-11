import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
/** Keeps the list fresh while it is showing: connects the realtime client once the first answer is in, refetches on notices, and reports "connecting" | "online" | "reconnecting". */
export function useLiveUpdates(ready: boolean): string {
 const host = useAppHost(), query = useQueryClient(), [connection, setConnection] = useState("connecting");
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: setConnection, onReset: () => invalidator.reset() });realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, query, ready]);
 return connection;
}
