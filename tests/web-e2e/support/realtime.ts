import type { Page } from "@playwright/test";
import type { RealtimeNotice } from "@agentx/cloud-contracts/web";
export async function mockRealtime(page: Page) {
 await page.addInitScript(() => {
 const state = { sockets: [] as Array<{ close(): void; notice(value: unknown): void }>, connections: 0 };
 window.__mockRealtime = state;
 class FixtureSocket extends EventTarget {
 static CONNECTING = 0;static OPEN = 1;static CLOSING = 2;static CLOSED = 3;
 readyState = 0;
 private subscriptions = new Map<string, string>();
 constructor() { super();state.connections++;state.sockets.push(this);queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1;this.dispatchEvent(new Event("open")); } }); }
 send(data: string) {
 const frame = JSON.parse(data) as { type?: string; channel?: string; id?: string };
 if (frame.type === "connection_init") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "connection_ack", connectionTimeoutMs: 900_000 }) })));
 if (frame.type === "subscribe" && frame.channel && frame.id) { this.subscriptions.set(frame.id, frame.channel);this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "subscribe_success", id: frame.id }) })); }
 if (frame.type === "unsubscribe" && frame.id) this.subscriptions.delete(frame.id);
 }
 notice(value: unknown) { const id = this.subscriptions.keys().next().value;if (this.readyState === 1 && id !== undefined) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "data", id, event: [JSON.stringify(value)] }) })); }
 close() { if (this.readyState === 3) return;this.readyState = 3;this.dispatchEvent(new Event("close")); }
 }
 Object.defineProperty(window, "WebSocket", { configurable: true, value: FixtureSocket });
 });
 return {
 push: (notice: RealtimeNotice) => page.evaluate(value => { for (const socket of window.__mockRealtime?.sockets ?? []) socket.notice(value); }, notice),
 drop: () => page.evaluate(() => { for (const socket of window.__mockRealtime?.sockets ?? []) socket.close(); }),
 connections: () => page.evaluate(() => window.__mockRealtime?.connections ?? 0),
 };
}
declare global { interface Window { __mockRealtime?: { sockets: Array<{ close(): void; notice(value: unknown): void }>; connections: number } } }
