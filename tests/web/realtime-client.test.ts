import { afterEach, expect, it, vi } from "vitest";
import { createRealtimeClient } from "../../packages/ui/src/realtime/client.js";
import { createNoticeInvalidator, queryKeysFor } from "../../packages/ui/src/realtime/invalidate.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost, USER_CHANNEL, PROJECT_CHANNEL, REALTIME_ENDPOINT } from "./support/fake-host.js";
const SID = "ses_aaaaaaaaaaaaaaaaaaaa", NOW = new Date("2026-10-23T12:00:00Z");
afterEach(() => { vi.useRealTimers(); });
function clock() { vi.useFakeTimers();vi.setSystemTime(NOW); }
const settle = () => vi.advanceTimersByTimeAsync(0);
it("uses authorization subprotocols, subscribes after ack and reads only known notice data", async () => {
 clock();const f = fakeHost(), notices: unknown[] = [], statuses: string[] = [];
 const client = createRealtimeClient(f.host, { onNotice: notice => notices.push(notice), onStatus: status => statuses.push(status) });client.start();client.subscribeSession(SID);await settle();
 expect(f.sockets).toHaveLength(1);const { socket, url, protocols } = f.sockets[0]!;expect(url).toBe(REALTIME_ENDPOINT);expect(new URL(url).search).toBe("");expect(protocols).toContain("aws-appsync-event-ws");
 const encoded = protocols.find(value => value.startsWith("header-"))!.slice(7);expect(JSON.parse(Buffer.from(encoded, "base64url").toString())).toEqual({ Authorization: "fixture-realtime-value", host: "fixture.appsync-api.us-west-2.amazonaws.com" });
 socket.open();expect(socket.sent).toEqual([{ type: "connection_init" }]);socket.message({ type: "connection_ack", connectionTimeoutMs: 900_000 });await settle();
 const subscriptions = socket.sent.filter(message => message.type === "subscribe");expect(subscriptions.map(message => message.channel).sort()).toEqual([USER_CHANNEL, PROJECT_CHANNEL, "/rovara/o-aaaaaaaaaaaaaaaaaaaa/s/s-aaaaaaaaaaaaaaaaaaaa"].sort());
 for (const subscription of subscriptions) expect(subscription.authorization).toEqual({ Authorization: "fixture-realtime-value" });
 const id = subscriptions[0]!.id;socket.message({ type: "data", id, event: [JSON.stringify({ type: "session.updated", sessionId: SID, revision: 2, added: true }), JSON.stringify({ type: "future.notice", value: "ignored" }), "not json"] });
 expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({ type: "session.updated", sessionId: SID, revision: 2 });expect(statuses).toContain("online");
 client.unsubscribeSession(SID);expect(socket.sent.filter(message => message.type === "unsubscribe")).toHaveLength(1);client.stop();expect(socket.closed).toBe(true);
});
it("refreshes sixty seconds before expiry and does no work after stop", async () => {
 clock();const f = fakeHost(), client = createRealtimeClient(f.host, { onNotice: vi.fn(), onStatus: vi.fn() });client.start();await settle();
 f.sockets[0]!.socket.open();f.sockets[0]!.socket.message({ type: "connection_ack", connectionTimeoutMs: 900_000 });await settle();
 await vi.advanceTimersByTimeAsync(839_999);expect(f.realtimeToken).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(f.realtimeToken).toHaveBeenCalledTimes(2);expect(f.sockets).toHaveLength(2);
 client.stop();const calls = f.realtimeToken.mock.calls.length;await vi.advanceTimersByTimeAsync(2_000_000);expect(f.realtimeToken).toHaveBeenCalledTimes(calls);expect(f.sockets.every(({ socket }) => socket.closed)).toBe(true);
});
it("reconnects with the capped one, two, five, ten and thirty second delays", async () => {
 clock();const f = fakeHost();f.realtimeToken.mockRejectedValue(new Error("private token transport detail"));const client = createRealtimeClient(f.host, { onNotice: vi.fn(), onStatus: vi.fn() });client.start();await settle();expect(f.realtimeToken).toHaveBeenCalledTimes(1);
 for (const [index, delay] of [1000, 2000, 5000, 10000, 30000, 30000].entries()) { await vi.advanceTimersByTimeAsync(delay - 1);expect(f.realtimeToken).toHaveBeenCalledTimes(index + 1);await vi.advanceTimersByTimeAsync(1);expect(f.realtimeToken).toHaveBeenCalledTimes(index + 2); }
 client.stop();
});
it("catches up in pages in feed order, drops repeated sk values, and reports reset", async () => {
 clock();const first = { type: "session.updated", sessionId: SID, revision: 2, at: NOW.toISOString(), sk: "entry-1" }, second = { type: "session.event", sessionId: SID, eventId: "evt_" + "a".repeat(24), at: NOW.toISOString(), sk: "entry-2" };
 let page = 0;const f = fakeHost(async () => ({ status: 200, body: ++page === 1 ? { notices: [first], next: "page-2", reset: true } : page === 2 ? { notices: [first, second, second], next: "settled" } : { notices: [], next: "settled" } }));
 const notices: unknown[] = [], reset = vi.fn();const client = createRealtimeClient(f.host, { onNotice: notice => notices.push(notice), onStatus: vi.fn(), onReset: reset });client.start();await settle();f.sockets[0]!.socket.open();f.sockets[0]!.socket.message({ type: "connection_ack", connectionTimeoutMs: 900_000 });await settle();
 expect(notices.map(value => (value as { type: string }).type)).toEqual(["session.updated", "session.event"]);expect(reset).toHaveBeenCalledTimes(1);expect(f.request.mock.calls.map(([input]) => input.path)).toEqual(["/v1/app/changes", "/v1/app/changes?since=page-2", "/v1/app/changes?since=settled"]);client.stop();
});
it("never resurrects a connection when a token response arrives after stop", async () => {
 clock();const f = fakeHost();let release: (() => void) | undefined;f.realtimeToken.mockImplementation(() => new Promise(resolve => { release = () => resolve({ token: "late-fixture", expiresAt: new Date(Date.now() + 900_000).toISOString(), endpoint: REALTIME_ENDPOINT, channels: { user: USER_CHANNEL, projects: {} } }); }));
 const client = createRealtimeClient(f.host, { onNotice: vi.fn(), onStatus: vi.fn() });client.start();client.stop();release!();await settle();expect(f.sockets).toHaveLength(0);
});
it("drops old revisions, ignores frames for unknown subscriptions, and detects missing keepalives", async () => {
 clock();const f = fakeHost(), notices: unknown[] = [];const client = createRealtimeClient(f.host, { onNotice: notice => notices.push(notice), onStatus: vi.fn() });client.start();await settle();const socket = f.sockets[0]!.socket;socket.open();socket.message({ type: "connection_ack", connectionTimeoutMs: 5000 });await settle();const id = socket.sent.find(message => message.type === "subscribe")!.id;
 for (const revision of [3, 2, 3]) socket.message({ type: "data", id, event: [JSON.stringify({ type: "session.updated", sessionId: SID, revision })] });
 socket.message({ type: "data", id: "not-subscribed", event: [JSON.stringify({ type: "session.updated", sessionId: SID, revision: 4 })] });expect(notices).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(4000);socket.message({ type: "ka" });await vi.advanceTimersByTimeAsync(4999);expect(socket.closed).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(socket.closed).toBe(true);client.stop();
});
it("throttles nav across fifty updates, never on session events, and invalidates everything on reset", async () => {
 clock();const query = createQueryClient(), invalidate = vi.spyOn(query, "invalidateQueries").mockResolvedValue(undefined), apply = createNoticeInvalidator(query);
 expect(queryKeysFor({ type: "session.event", sessionId: SID, eventId: "evt_" + "a".repeat(24) })).toEqual([["session", SID, "events"], ["session", SID, "messages"]]);
 for (let revision = 1; revision <= 50; revision += 1) apply.notice({ type: "session.updated", sessionId: SID, revision });
 await settle();expect(invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === '["nav"]')).toHaveLength(1);await vi.advanceTimersByTimeAsync(3000);expect(invalidate.mock.calls.filter(([options]) => JSON.stringify(options?.queryKey) === '["nav"]')).toHaveLength(1);
 invalidate.mockClear();for (let index = 0; index < 50; index++) apply.notice({ type: "session.event", sessionId: SID, eventId: "evt_" + "a".repeat(24) });await vi.advanceTimersByTimeAsync(5000);expect(invalidate.mock.calls.some(([options]) => JSON.stringify(options?.queryKey) === '["nav"]')).toBe(false);
 apply.reset();expect(invalidate.mock.lastCall?.[0]).toBeUndefined();apply.stop();query.clear();
});
it("ignores an invalid session unsubscribe without disrupting a live connection", async () => {
 clock();const f = fakeHost(), client = createRealtimeClient(f.host, { onNotice: vi.fn(), onStatus: vi.fn() });client.start();await settle();
 expect(() => client.unsubscribeSession("invalid")).not.toThrow();client.stop();
});
