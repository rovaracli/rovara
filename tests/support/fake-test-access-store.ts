// An in-memory TestAccessStore for tests (lane TA2): the same rules as the DynamoDB adapter's conditions (versions, one-use token, one stack record), applied atomically because JavaScript is single threaded between awaits.
// `beforeNext` lets a test run code between a handler's read and its write, to stage a race.
import { AuditEventInputSchema, type AuditEventInput } from "@agentx/cloud-contracts";
import type { ConnectTokenItem, ConnectionRecord, ConsumeResult, StackItem, TestAccessStore } from "../../packages/broker/src/test-access/store.js";

export class FakeTestAccessStore implements TestAccessStore {
  readonly connections = new Map<string, ConnectionRecord>();
  readonly tokens = new Map<string, ConnectTokenItem>();
  readonly stacks = new Map<string, StackItem>();
  readonly polling = new Set<string>();
  readonly audits: AuditEventInput[] = [];
  /** Run once, before the next commit or consume writes (after the caller's reads): stage a race. */
  beforeNext: (() => void | Promise<void>) | undefined;
  /** Makes every call fail, as an outage does. */
  down = false;

  private key = (orgId: string, connectionId: string): string => `${orgId}#${connectionId}`;
  private async gate(): Promise<void> {
    if (this.down) throw new Error("store unavailable");
    const hook = this.beforeNext;
    this.beforeNext = undefined;
    if (hook !== undefined) await hook();
  }
  private audit(event: AuditEventInput | undefined): void {
    if (event !== undefined) this.audits.push(AuditEventInputSchema.parse(event));
  }

  createConnection(record: ConnectionRecord, token: ConnectTokenItem, audit: AuditEventInput): Promise<boolean> {
    if (this.down) return Promise.reject(new Error("store unavailable"));
    if (this.connections.has(this.key(record.orgId, record.connectionId)) || this.tokens.has(token.tokenHash)) return Promise.resolve(false);
    this.audit(audit);
    this.connections.set(this.key(record.orgId, record.connectionId), structuredClone(record));
    this.tokens.set(token.tokenHash, structuredClone(token));
    return Promise.resolve(true);
  }

  getConnection(orgId: string, connectionId: string): Promise<ConnectionRecord | undefined> {
    if (this.down) return Promise.reject(new Error("store unavailable"));
    const found = this.connections.get(this.key(orgId, connectionId));
    return Promise.resolve(found === undefined ? undefined : structuredClone(found));
  }

  listConnections(orgId: string, limit: number): Promise<ConnectionRecord[]> {
    if (this.down) return Promise.reject(new Error("store unavailable"));
    return Promise.resolve([...this.connections.values()].filter((record) => record.orgId === orgId).slice(0, limit).map((record) => structuredClone(record)));
  }

  async commitConnection(next: ConnectionRecord, expectedVersion: number, audit: AuditEventInput | undefined): Promise<boolean> {
    await this.gate();
    const key = this.key(next.orgId, next.connectionId);
    if (this.connections.get(key)?.version !== expectedVersion) return false;
    this.audit(audit);
    this.connections.set(key, structuredClone(next));
    if (next.status === "polling") this.polling.add(key);
    else this.polling.delete(key);
    if (next.status === "disconnected" && next.stackId !== undefined) this.stacks.delete(next.stackId);
    return true;
  }

  getToken(tokenHash: string): Promise<ConnectTokenItem | undefined> {
    if (this.down) return Promise.reject(new Error("store unavailable"));
    const found = this.tokens.get(tokenHash);
    return Promise.resolve(found === undefined ? undefined : structuredClone(found));
  }

  async consumeToken(input: { tokenHash: string; nowMs: number; stack: StackItem; next: ConnectionRecord; expectedVersion: number; audit: AuditEventInput }): Promise<ConsumeResult> {
    await this.gate();
    const token = this.tokens.get(input.tokenHash);
    if (token === undefined || token.usedAtMs !== undefined || token.expiresAtMs <= input.nowMs || token.orgId !== input.next.orgId || token.connectionId !== input.next.connectionId || token.projectId !== input.next.projectId) return "token_refused";
    if (this.stacks.has(input.stack.stackId)) return "stack_taken";
    if (this.connections.get(this.key(input.next.orgId, input.next.connectionId))?.version !== input.expectedVersion) return "connection_changed";
    this.audit(input.audit);
    this.tokens.set(input.tokenHash, { ...token, usedAtMs: input.nowMs });
    this.stacks.set(input.stack.stackId, structuredClone(input.stack));
    this.connections.set(this.key(input.next.orgId, input.next.connectionId), structuredClone(input.next));
    if (input.next.status === "polling") this.polling.add(this.key(input.next.orgId, input.next.connectionId));
    else this.polling.delete(this.key(input.next.orgId, input.next.connectionId));
    return "ok";
  }

  retireToken(tokenHash: string, nowMs: number): Promise<void> {
    if (this.down) return Promise.reject(new Error("store unavailable"));
    const token = this.tokens.get(tokenHash);
    if (token !== undefined && token.usedAtMs === undefined) this.tokens.set(tokenHash, { ...token, usedAtMs: nowMs });
    return Promise.resolve();
  }

  getStack(stackId: string): Promise<StackItem | undefined> {
    if (this.down) return Promise.reject(new Error("store unavailable"));
    const found = this.stacks.get(stackId);
    return Promise.resolve(found === undefined ? undefined : structuredClone(found));
  }

  listPolling(limit: number): Promise<Array<{ orgId: string; connectionId: string }>> {
    if (this.down) return Promise.reject(new Error("store unavailable"));
    return Promise.resolve([...this.polling].slice(0, limit).map((key) => { const [orgId, connectionId] = key.split("#") as [string, string]; return { orgId, connectionId }; }));
  }
}
