// An in-memory TestAccountStore for tests (test services TS26): optimistic versions like the DynamoDB adapter's condition, the audit events and approval conditions it was handed kept for the test to read, and
// a day counter. It has none of the adapter's cross-item races (the company cap and the daily roll-up are counted here without a transaction).
import { AuditEventInputSchema, type AuditEventInput, type OrgId } from "@agentx/contracts";
import type { DayUsage, StoredTestAccount, TestAccountStore } from "../../packages/broker/src/test-env/test-accounts.js";
import type { TransactItem } from "../../packages/broker/src/audit/outbox.js";

export class FakeTestAccountStore implements TestAccountStore {
  readonly rows = new Map<string, StoredTestAccount>();
  readonly audits: AuditEventInput[] = [];
  readonly conditions: Array<readonly TransactItem[]> = [];
  readonly usage = new Map<string, DayUsage>();
  /** When true, the next commit loses its race (as if the row changed meanwhile). */
  failNextCommit = false;
  private readonly key = (orgId: string, id: string) => `${orgId}#${id}`;

  get(orgId: OrgId, id: string): Promise<StoredTestAccount | undefined> {
    const row = this.rows.get(this.key(orgId, id));
    return Promise.resolve(row === undefined ? undefined : structuredClone(row));
  }

  list(orgId: OrgId, limit: number): Promise<StoredTestAccount[]> {
    return Promise.resolve([...this.rows.entries()].filter(([key]) => key.startsWith(`${orgId}#`)).slice(0, limit).map(([, row]) => structuredClone(row)));
  }

  commit(next: StoredTestAccount, expectedVersion: number | null, audit: AuditEventInput | undefined, conditions: readonly TransactItem[]): Promise<boolean> {
    if (this.failNextCommit) { this.failNextCommit = false; return Promise.resolve(false); }
    const key = this.key(next.account.orgId, next.account.id);
    const existing = this.rows.get(key);
    if ((existing?.version ?? null) !== expectedVersion) return Promise.resolve(false);
    if (audit !== undefined) {
      // The adapter writes the event through the outbox, which validates it: so does this.
      this.audits.push(AuditEventInputSchema.parse(audit));
    }
    this.conditions.push(conditions);
    this.rows.set(key, structuredClone(next));
    return Promise.resolve(true);
  }

  remove(orgId: OrgId, id: string, expectedVersion: number, audit: AuditEventInput): Promise<boolean> {
    const key = this.key(orgId, id);
    if (this.rows.get(key)?.version !== expectedVersion) return Promise.resolve(false);
    this.audits.push(AuditEventInputSchema.parse(audit));
    this.rows.delete(key);
    return Promise.resolve(true);
  }

  usageOn(orgId: OrgId, id: string, day: string): Promise<DayUsage> {
    return Promise.resolve(this.usage.get(`${this.key(orgId, id)}#${day}`) ?? { rounds: 0, requests: 0 });
  }

  addUsage(orgId: OrgId, id: string, _projectId: string, day: string, add: DayUsage, audit: AuditEventInput): Promise<DayUsage> {
    const key = `${this.key(orgId, id)}#${day}`;
    const before = this.usage.get(key) ?? { rounds: 0, requests: 0 };
    const after = { rounds: before.rounds + add.rounds, requests: before.requests + add.requests };
    this.usage.set(key, after);
    this.audits.push(AuditEventInputSchema.parse(audit));
    return Promise.resolve(after);
  }
}
