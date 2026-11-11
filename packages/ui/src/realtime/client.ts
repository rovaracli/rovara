import { ChangesFeedPageReaderSchema, RealtimeNoticeReaderSchema, RealtimeTokenResponseReaderSchema, parseRealtimeChannel, sessionChannel, SessionIdSchema, type RealtimeNotice, type OrgId } from "@agentx/cloud-contracts/web";
import { REALTIME_BACKOFF_MS, REALTIME_REFRESH_BEFORE_SECONDS } from "../constants.js";
import type { AppHost, RealtimeSocket } from "../host.js";
export function createRealtimeClient(host: AppHost, options: { onNotice: (notice: RealtimeNotice) => void; onStatus: (status: string) => void; onReset?: () => void }) {
 let running = false, generation = 0, attempt = 0, socket: RealtimeSocket | undefined, token = "", org: OrgId | undefined, ready = false, cursor: string | undefined;
 let retryTimer: ReturnType<typeof setTimeout> | undefined, refreshTimer: ReturnType<typeof setTimeout> | undefined, aliveTimer: ReturnType<typeof setTimeout> | undefined;
 let timeout = 300_000, serial = 0;
 const sessions = new Set<string>(), subscriptions = new Map<string, string>(), revisions = new Map<string, number>(), seen = new Set<string>();
 let cleanup: Array<() => void> = [];
 function disconnect() { for (const remove of cleanup) remove();cleanup = [];clearTimeout(refreshTimer);clearTimeout(aliveTimer);socket?.close();socket = undefined;ready = false;subscriptions.clear(); }
 function retry() { if (!running) return;generation++;disconnect();options.onStatus("reconnecting");clearTimeout(retryTimer);retryTimer = setTimeout(() => { void connect(); }, REALTIME_BACKOFF_MS[Math.min(attempt++, REALTIME_BACKOFF_MS.length - 1)]); }
 function alive() { clearTimeout(aliveTimer);aliveTimer = setTimeout(retry, timeout); }
 function emit(value: unknown) {
 const parsed = RealtimeNoticeReaderSchema.safeParse(value);if (!parsed.success || parsed.data.type === "unknown") return;
 const notice = parsed.data as RealtimeNotice;
 if ("revision" in notice) { const key = "sessionId" in notice ? notice.sessionId : "home";if ((revisions.get(key) ?? -1) >= notice.revision) return;revisions.set(key, notice.revision); }
 options.onNotice(notice);
 }
 async function catchUp(version: number) {
 try { for (let count = 0; count < 100 && running && generation === version; count++) {
 const response = await host.transport.request({ method: "GET", path: "/v1/app/changes" + (cursor === undefined ? "" : "?since=" + encodeURIComponent(cursor)) });
 if (!running || generation !== version || response.status !== 200) return;
 const page = ChangesFeedPageReaderSchema.parse(response.body);if (page.reset === true) options.onReset?.();
 for (const notice of page.notices) if (!seen.has(notice.sk)) { seen.add(notice.sk);emit(notice); }
 const previous = cursor;cursor = page.next;if (page.notices.length === 0 || previous === cursor) return;
 } } catch { options.onReset?.(); }
 }
 function subscribe(channel: string) { if (!ready || subscriptions.has(channel)) return;const id = String(++serial);subscriptions.set(channel, id);socket?.send(JSON.stringify({ type: "subscribe", id, channel, authorization: { Authorization: token } })); }
 async function connect() {
 if (!running) return;const version = ++generation;disconnect();
 try {
 const answer = RealtimeTokenResponseReaderSchema.parse(await host.realtimeToken());if (!running || version !== generation) return;
 const endpoint = new URL(answer.endpoint), user = parseRealtimeChannel(answer.channels.user);const remaining = Date.parse(answer.expiresAt) - Date.now() - REALTIME_REFRESH_BEFORE_SECONDS * 1000;
 if (endpoint.protocol !== "wss:" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || user?.kind !== "user" || remaining <= 0) throw new Error("Invalid connection");
 token = answer.token;org = ("org_" + user.orgBody);
 const header = JSON.stringify({ Authorization: token, host: endpoint.host.replace(".appsync-realtime-api.", ".appsync-api.") });
 const encoded = btoa(header).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
 socket = host.openSocket(endpoint.href, ["aws-appsync-event-ws", "header-" + encoded]);
 cleanup.push(socket.onOpen(() => { socket?.send(JSON.stringify({ type: "connection_init" }));timeout = 10_000;alive(); }), socket.onError(retry), socket.onClose(retry), socket.onMessage(data => {
 if (!running || generation !== version || typeof data !== "string") return;
 try { const frame = JSON.parse(data) as { type?: string; id?: string; event?: unknown; connectionTimeoutMs?: number };
 if (frame.type === "connection_ack") { ready = true;attempt = 0;timeout = typeof frame.connectionTimeoutMs === "number" && frame.connectionTimeoutMs > 0 ? frame.connectionTimeoutMs : 300_000;alive();options.onStatus("online");subscribe(answer.channels.user);for (const channel of Object.values(answer.channels.projects)) { const parsed = parseRealtimeChannel(channel);if (parsed?.kind === "project" && parsed.orgBody === user.orgBody) subscribe(channel); }for (const id of sessions) subscribe(sessionChannel("org_" + user.orgBody, id));void catchUp(version); }
 else if (frame.type === "ka") alive();
 else if (frame.type === "data" && [...subscriptions.values()].includes(frame.id ?? "") && Array.isArray(frame.event)) for (const item of frame.event) { try { if (typeof item === "string") emit(JSON.parse(item)); } catch { /* malformed notice */ } }
 else if (frame.type === "connection_error") retry();
 } catch { /* malformed frame */ }
 }));
 refreshTimer = setTimeout(() => { void connect(); }, remaining);
 } catch { if (running && generation === version) retry(); }
 }
 return {
 start() { if (running) return;running = true;options.onStatus("connecting");void connect(); },
 stop() { running = false;generation++;clearTimeout(retryTimer);disconnect();sessions.clear();seen.clear();revisions.clear();token = "";org = undefined; },
 subscribeSession(id: string) { if (!SessionIdSchema.safeParse(id).success) return;sessions.add(id);if (org !== undefined) subscribe(sessionChannel(org, id)); },
 unsubscribeSession(id: string) { if (!SessionIdSchema.safeParse(id).success) return;sessions.delete(id);if (org === undefined) return;const channel = sessionChannel(org, id), subscription = subscriptions.get(channel);if (subscription !== undefined) { socket?.send(JSON.stringify({ type: "unsubscribe", id: subscription }));subscriptions.delete(channel); } },
 };
}
