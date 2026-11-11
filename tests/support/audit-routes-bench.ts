// The Task 11/12 test bench for the audit routes and pages: FakeDynamoDb for every table, the real appender (so that details are
// really sealed), a fake KMS and a fake intake queue, with a world of org A (12 records, 10 sealed) and org B (3 records).
// Shared by audit-routes.test.ts and audit-view-page.test.ts.
import { expect } from "vitest";
import { AuditEventInputSchema, auditEventId, type AuditEventInput } from "@agentx/cloud-contracts";
import { appendEvent, type AppenderDeps } from "../../packages/broker/src/audit/appender.js";
import type { AuditExportClientDeps, AuditExportEvent } from "../../packages/broker/src/audit/export.js";
import { AuditKeyring } from "../../packages/broker/src/audit/keyring.js";
import type { AuditReadDeps } from "../../packages/broker/src/audit/reader.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { orgMetaKey } from "../../packages/cloud-contracts/src/org-node.js";
import { FakeAuditSqs } from "./fake-audit-sqs.js";
import { FakeKms } from "./fake-kms.js";
import { A, B, LEDGER, SEALS, at, harness, iso, run, type Harness } from "./audit-anchor-harness.js";

export const C = "org_cccccccccccccccccccc";
export const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
export const KEYS = "keys";
export const STATE = "state";
export const EXPORTS_BUCKET = "audit-exports-bucket";
export const QUEUE_URL = "https://sqs.test/agentx-test-audit-intake.fifo";

export interface Bench {
  h: Harness;
  deps: AuditExportClientDeps;
  readDeps: AuditReadDeps;
  appender: AppenderDeps;
  sqs: FakeAuditSqs;
  invocations: AuditExportEvent[];
  presigned: Array<{ bucket: string; key: string; expiresInSeconds: number }>;
  logs: Array<Record<string, unknown>>;
  /** What the presigner does next: undefined answers a link; a function may throw. */
  presignFault: { error?: Error };
  append: (orgId: string, count: number) => Promise<void>;
  seal: (n: number) => Promise<void>;
}

export function bench(): Bench {
  const h = harness();
  const kms = new FakeKms(KEY_ARN);
  const keyring = (caller: "appender" | "broker") => new AuditKeyring({ documentClient: h.deps.documentClient, keysTable: KEYS, kms: kms.as(caller).client, keyId: KEY_ARN, now: () => h.clock.now });
  const logs: Array<Record<string, unknown>> = [];
  const appender: AppenderDeps = { documentClient: h.deps.documentClient, ledgerTable: LEDGER, keyring: keyring("appender"), now: () => h.clock.now, log: (entry) => logs.push(entry), sleep: async () => undefined };
  const sqs = new FakeAuditSqs();
  const invocations: AuditExportEvent[] = [];
  const presigned: Bench["presigned"] = [];
  const presignFault: Bench["presignFault"] = {};
  const readDeps: AuditReadDeps = { documentClient: h.deps.documentClient, ledgerTable: LEDGER, sealsTable: SEALS, keyring: keyring("broker") };
  const deps: AuditExportClientDeps = {
    ...readDeps,
    exportsBucket: EXPORTS_BUCKET,
    tableName: STATE,
    audit: { sqs: sqs.client, queueUrl: QUEUE_URL, documentClient: h.deps.documentClient, tableName: STATE, now: () => h.clock.now, log: (entry) => logs.push(entry) },
    now: () => h.clock.now,
    log: (entry) => logs.push(entry),
    invokeExport: async (event) => { invocations.push(event); },
    presign: async (input) => {
      if (presignFault.error !== undefined) throw presignFault.error;
      presigned.push(input);
      return { url: `https://signed.test/${input.bucket}/${input.key}?expires=${String(input.expiresInSeconds)}`, expiresInSeconds: input.expiresInSeconds };
    },
  };
  const counters = new Map<string, number>();
  const append = async (orgId: string, count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      const n = (counters.get(orgId) ?? 0) + 1;
      counters.set(orgId, n);
      h.clock.now += 1000;
      const event: AuditEventInput = AuditEventInputSchema.parse({
        eventId: auditEventId("pull_request.opened", `${orgId}-${String(n)}`),
        orgId,
        action: "pull_request.opened",
        actor: { kind: "member", id: n % 2 === 0 ? "dev_2" : "dev_1" },
        target: { kind: "pull_request", id: `pr_${String(n)}` },
        occurredAt: iso(h.clock.now - 500),
        facts: { number: n },
        details: [{ subject: "dev_1", fields: { name: `Person of ${orgId}` } }],
      });
      expect(await appendEvent(appender, event)).toMatchObject({ result: "appended" });
    }
  };
  const seal = async (n: number): Promise<void> => {
    h.clock.now = at(n);
    await run(h, at(n));
  };
  return { h, deps, readDeps, appender, sqs, invocations, presigned, presignFault, logs, append, seal };
}

/** Org A has 6 records sealed in epoch 0 (org B has 3), 4 more sealed in epoch 1, and 2 not sealed yet. */
export async function world(): Promise<Bench> {
  const b = bench();
  b.h.clock.now = at(0) - 60_000;
  await b.append(A, 6);
  await b.append(B, 3);
  await b.seal(0);
  b.h.clock.now = at(1) - 60_000;
  await b.append(A, 4);
  await b.seal(1);
  b.h.clock.now = at(2) - 60_000;
  await b.append(A, 2);
  seedOrgs(b);
  return b;
}

export function seedOrgs(b: Bench): void {
  for (const orgId of [A, B]) b.h.db.set({ ...orgMetaKey(orgId), entityType: "ORG", orgId, name: "Acme", createdAt: iso(at(0)), createdBy: "system", plan: "team" });
}

export const orgStore = (b: Bench): OrgStore => new OrgStore({ documentClient: b.h.deps.documentClient, tableName: STATE, now: () => b.h.clock.now });
