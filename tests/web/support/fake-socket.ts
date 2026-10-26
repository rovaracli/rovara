import type { RealtimeSocket } from "../../../packages/ui/src/host.js";
export class FakeSocket implements RealtimeSocket {
 readonly sent: Array<Record<string, unknown>> = [];
 closed = false;
 private opens = new Set<() => void>();private messages = new Set<(data: unknown) => void>();private closes = new Set<() => void>();private errors = new Set<() => void>();
 onOpen(listener: () => void) { this.opens.add(listener);return () => this.opens.delete(listener); }
 onMessage(listener: (data: unknown) => void) { this.messages.add(listener);return () => this.messages.delete(listener); }
 onClose(listener: () => void) { this.closes.add(listener);return () => this.closes.delete(listener); }
 onError(listener: () => void) { this.errors.add(listener);return () => this.errors.delete(listener); }
 send(value: string) { this.sent.push(JSON.parse(value) as Record<string, unknown>); }
 close() { this.closed = true;for (const listener of this.closes) listener(); }
 open() { for (const listener of this.opens) listener(); }
 message(data: unknown) { for (const listener of this.messages) listener(typeof data === "string" ? data : JSON.stringify(data)); }
 fail() { for (const listener of this.errors) listener(); }
}
