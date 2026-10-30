// tests/contract/audit-erase.test.ts
// Task 15 of the Audit Ledger plan: erasing a person's details (a tombstone), shredding a closed company's details (SHREDDED, 30 days
// after it closed), and the stated window for every copy of the details that is not the vault. The tables are kept apart (a
// TableScopedDynamoDb): the keys table's partition `ORG#<org>` is also the State table's org record, and a sweep must not touch it.
import { gunzipSync } from "node:zlib";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import type { S3Client } from "@aws-sdk/client-s3";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { parseBundle, verifyBundle } from "@rovara/audit-verifier";
import {
  AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS,
  AUDIT_PENDING_TTL_DAYS,
  AUDIT_TRANSIENT_COPY_DAYS,
  AuditEventInputSchema,
  auditEventId,
  auditOperatorId,
  type AuditEventInput,
} from "@agentx/contracts";
import { appendEvent, type AppenderDeps } from "../../packages/broker/src/audit/appender.js";
import {
  AUDIT_COPIES_GONE_WITHIN_DAYS,
  AUDIT_DETAIL_STORES,
  AUDIT_EXPORT_PURGE_SOURCE,
  AUDIT_SHRED_DUE_PARTITION,
  AUDIT_SHRED_MARGIN_MS,
  AUDIT_SHRED_SETTLE_MS,
  auditErasedMessage,
  eraseAuditSubject,
  processDueShreds,
  purgeAuditExports,
  scheduleAuditShred,
  type AuditEraseDeps,
  type AuditShredDeps,
} from "../../packages/broker/src/audit/erase.js";
import { routeAuditAdminRequest, type AuditAdminCaller } from "../../packages/broker/src/audit/admin-routes.js";
import { handleAuditExportEvent } from "../../packages/broker/src/audit/export-handler.js";
import { exportPurger } from "../../packages/broker/src/audit/export-wiring.js";
import {
  auditExportId,
  exportDownloadUrl,
  runAuditExport,
  startAuditExport,
  type AuditExportClientDeps,
  type AuditExportDeps,
} from "../../packages/broker/src/audit/export.js";
import { AuditKeyring, AUDIT_KEY_CACHE_MS } from "../../packages/broker/src/audit/keyring.js";
import type { AuditRuntime } from "../../packages/broker/src/audit/outbox.js";
import { readAuditRecords } from "../../packages/broker/src/audit/reader.js";
import { routeAuditRequest } from "../../packages/broker/src/audit/routes.js";
import { BUCKET, A as ROUTES_A, B as ROUTES_B, appendRecords, eventsOf, harness, run, storedRecords, at } from "../support/audit-anchor-harness.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { world as routesWorld, orgStore, type Bench as RoutesBench } from "../support/audit-routes-bench.js";
import { FakeAuditSqs } from "../support/fake-audit-sqs.js";
import { FakeExportsBucket } from "../support/fake-exports-bucket.js";
import { FakeKms } from "../support/fake-kms.js";
import { TableScopedDynamoDb } from "../support/table-scoped-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const KEYS = "keys";
const STATE = "state";
const LEDGER = "ledger";
const EXPORTS_BUCKET = "audit-exports-bucket";
const QUEUE_URL = "https://sqs.test/agentx-test-audit-intake.fifo";
const START = Date.parse("2026-10-20T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const STAFF = { kind: "operator" as const, id: auditOperatorId("https://staff-idp.example.test", "staff-1") };
const ALICE = "Alice Example";
const BOB = "Bob Example";

interface Operation { command: string; table: string; key?: { pk: string; sk: string }; condition?: string; values?: Record<string, unknown> }

function bench() {
  const db = new TableScopedDynamoDb();
  const kms = new FakeKms(KEY_ARN);
  const clock = { now: START };
  const logs: Array<Record<string, unknown>> = [];
  const operations: Operation[] = [];
  const hooks: { onSleep?: ((ms: number) => void | Promise<void>) | undefined } = {};
  db.before = (command) => {
    const input = command.input;
    if (command.constructor.name === "TransactWriteCommand") {
      for (const entry of input.TransactItems as Array<Record<string, Record<string, unknown>>>) {
        const [kind, action] = Object.entries(entry)[0] as [string, Record<string, unknown>];
        operations.push({ command: `Transact${kind}`, table: String(action.TableName), key: (action.Key ?? action.Item) as { pk: string; sk: string } });
      }
    } else {
      operations.push({
        command: command.constructor.name,
        table: String(input.TableName),
        ...(input.Key === undefined && input.Item === undefined ? {} : { key: (input.Key ?? input.Item) as { pk: string; sk: string } }),
        ...(typeof input.ConditionExpression === "string" ? { condition: input.ConditionExpression, values: input.ExpressionAttributeValues as Record<string, unknown> } : {}),
      });
    }
  };
  const keyring = (caller: "appender" | "broker" = "appender") => new AuditKeyring({ documentClient: db.client, keysTable: KEYS, kms: kms.as(caller).client, keyId: KEY_ARN, now: () => clock.now });
  // The queue is down unless a test says otherwise, so that the pending items stay where a test can see them.
  const sqs = new FakeAuditSqs();
  sqs.mode = "throw";
  const audit: AuditRuntime = { sqs: sqs.client, queueUrl: QUEUE_URL, documentClient: db.client, tableName: STATE, now: () => clock.now, log: (entry) => logs.push(entry) };
  const bucket = new FakeExportsBucket();
  const appender: AppenderDeps = { documentClient: db.client, ledgerTable: LEDGER, keyring: keyring(), now: () => clock.now, log: (entry) => logs.push(entry), sleep: async () => undefined };
  const erase: AuditEraseDeps = {
    documentClient: db.client,
    keysTable: KEYS,
    tableName: STATE,
    audit,
    now: () => clock.now,
    log: (entry) => logs.push(entry),
    purgeExports: async (orgId) => { await purgeAuditExports({ s3: bucket.client, exportsBucket: EXPORTS_BUCKET }, orgId); },
  };
  const sleeps: number[] = [];
  const shred: AuditShredDeps = {
    documentClient: db.client,
    keysTable: KEYS,
    stateTable: STATE,
    s3: bucket.client,
    exportsBucket: EXPORTS_BUCKET,
    now: () => clock.now,
    log: (entry) => logs.push(entry),
    sleep: async (ms) => {
      sleeps.push(ms);
      await hooks.onSleep?.(ms);
      clock.now += ms;
    },
  };
  /** Gives an org a data key, a pseudonym key and a key for each subject, as its first sealed records would. */
  const seedKeys = async (orgId: string, subjects: string[] = ["org", "dev_1", "dev_2"]): Promise<void> => {
    const ring = keyring();
    await ring.sealDetails(orgId, 1, subjects.map((subject) => ({ subject, fields: { name: subject === "dev_1" ? ALICE : subject === "dev_2" ? BOB : "Acme" } })));
    await ring.pseudonym(orgId, "repository", "acme/widgets");
  };
  const keyItems = (orgId: string) => db.find(KEYS, (item) => item.pk === `ORG#${orgId}`);
  const sorts = (orgId: string) => keyItems(orgId).map((item) => String(item.sk)).sort();
  const pending = () => db.find(STATE, (item) => String(item.pk).startsWith("AUDIT_PENDING#")).map((item) => item.event as AuditEventInput);
  const dueItems = () => db.find(STATE, (item) => item.pk === AUDIT_SHRED_DUE_PARTITION);
  const orgMeta = (orgId: string) => ({ pk: `ORG#${orgId}`, sk: "META", entityType: "ORG", orgId, name: "Acme Inc", createdAt: iso(START) });
  const putObjects = (orgId: string, count: number, text = "export"): string[] => {
    const keys = Array.from({ length: count }, (_, index) => `${orgId}/aex_${String(index).padStart(32, "0")}.${"0123456789abcdef"}.rovara-audit.json.gz`);
    for (const key of keys) bucket.objects.set(key, Buffer.from(text));
    return keys;
  };
  /** Closes an org the way Task 18's closeOrg will: the due item and the pending event in one transaction. */
  const scheduleShred = async (orgId: string, closedAtMs: number): Promise<void> => {
    const items = scheduleAuditShred({ audit, tableName: STATE }, { orgId, closedAt: iso(closedAtMs), actor: { kind: "member", id: "dev_1" } });
    await db.client.send(new TransactWriteCommand({ TransactItems: items }));
  };
  return { db, kms, clock, logs, operations, hooks, keyring, sqs, audit, bucket, appender, erase, shred, sleeps, seedKeys, keyItems, sorts, pending, dueItems, orgMeta, putObjects, scheduleShred };
}
type Bench = ReturnType<typeof bench>;

const request = (overrides: Partial<Parameters<typeof eraseAuditSubject>[1]> = {}) => ({ orgId: A as never, developerId: "dev_1", by: STAFF, reason: "Asked to be forgotten (ticket SUP-9)", requestId: "erase-1", ...overrides });

function event(orgId: string, n: number, subjects: Array<[string, string]> = [["dev_1", ALICE]]): AuditEventInput {
  return AuditEventInputSchema.parse({
    eventId: auditEventId("pull_request.opened", `${orgId}-${String(n)}`),
    orgId,
    action: "pull_request.opened",
    actor: { kind: "member", id: "dev_1" },
    target: { kind: "pull_request", id: `pr_${String(n)}` },
    occurredAt: iso(START + n * 1000),
    facts: { number: n },
    details: subjects.map(([subject, name]) => ({ subject, fields: { name } })),
  });
}

describe("eraseAuditSubject and the learning loop (B7)", () => {
  it("clears the person's learning data after the tombstone, and again on a repeat of the request", async () => {
    const b = bench();
    await b.seedKeys(A);
    const asked: Array<[string, string]> = [];
    const deps: AuditEraseDeps = { ...b.erase, eraseLearning: async (orgId, developerId) => { asked.push([orgId, developerId]); } };
    await eraseAuditSubject(deps, request());
    await eraseAuditSubject(deps, request());
    expect(asked).toEqual([[A, "dev_1"], [A, "dev_1"]]);
  });

  it("answers that the request should be sent again when the learning clean-up fails, after the details are erased, and logs the error's name only", async () => {
    const b = bench();
    await b.seedKeys(A);
    const deps: AuditEraseDeps = { ...b.erase, eraseLearning: async () => { throw new Error("SECRET-CORRECTION-WORDS"); } };
    await expect(eraseAuditSubject(deps, request())).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(b.keyItems(A).find((item) => item.sk === "SUBJECT#dev_1")).toHaveProperty("erasedAt");
    expect(JSON.stringify(b.logs)).not.toContain("SECRET-CORRECTION-WORDS");
    const again = await eraseAuditSubject({ ...b.erase, eraseLearning: async () => undefined }, request());
    expect(again.alreadyErased).toBe(true);
  });
});

describe("eraseAuditSubject", () => {
  it("replaces the person's key with a tombstone and puts audit.subject_erased in one transaction across the keys and State tables", async () => {
    const b = bench();
    await b.seedKeys(A);
    expect(b.sorts(A)).toStrictEqual(["DATA_KEY", "PSEUDONYM_KEY", "SUBJECT#dev_1", "SUBJECT#dev_2", "SUBJECT#org"]);
    b.operations.length = 0;
    b.db.sent.length = 0;
    const result = await eraseAuditSubject(b.erase, request());
    expect(result).toStrictEqual({ erasedAt: iso(START), alreadyErased: false });
    // The tombstone is exactly { erasedAt }: no IV, no wrapped key.
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")).toStrictEqual({ pk: `ORG#${A}`, sk: "SUBJECT#dev_1", erasedAt: iso(START) });
    const events = b.pending();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orgId: A,
      action: "audit.subject_erased",
      actor: STAFF,
      target: { kind: "member", id: "dev_1" },
      details: [{ subject: "org", fields: { reason: "Asked to be forgotten (ticket SUP-9)" } }],
    });
    // One transaction wrote both; no single-item put of either.
    expect(b.db.sent.filter((entry) => entry.command === "TransactWriteCommand")).toStrictEqual([{ command: "TransactWriteCommand", tables: [KEYS, STATE] }]);
    expect(b.operations.filter((operation) => operation.command.startsWith("Transact"))).toStrictEqual([
      { command: "TransactPut", table: KEYS, key: { pk: `ORG#${A}`, sk: "SUBJECT#dev_1", erasedAt: iso(START) } },
      { command: "TransactPut", table: STATE, key: expect.objectContaining({ pk: expect.stringMatching(/^AUDIT_PENDING#/) as string }) as never },
    ]);
    expect(b.operations.filter((operation) => operation.command === "PutCommand")).toStrictEqual([]);
  });

  it("changes nothing but that one key: the other people's keys, the data key, the pseudonym key and another org's key for the same developer id survive", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.seedKeys(B);
    const before = (orgId: string) => JSON.stringify(b.keyItems(orgId).sort((left, right) => String(left.sk).localeCompare(String(right.sk))));
    const bBefore = before(B);
    const aBefore = new Map(b.keyItems(A).map((item) => [String(item.sk), JSON.stringify(item)]));
    await eraseAuditSubject(b.erase, request());
    expect(before(B)).toBe(bBefore);
    for (const item of b.keyItems(A)) if (item.sk !== "SUBJECT#dev_1") expect(JSON.stringify(item), String(item.sk)).toBe(aBefore.get(String(item.sk)));
    expect(b.sorts(A)).toStrictEqual(["DATA_KEY", "PSEUDONYM_KEY", "SUBJECT#dev_1", "SUBJECT#dev_2", "SUBJECT#org"]);
    expect(b.db.get(KEYS, `ORG#${B}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
  });

  it("writes a tombstone for a person who has no key yet, so that no key is ever made for them", async () => {
    const b = bench();
    await b.seedKeys(A, ["org"]);
    await eraseAuditSubject(b.erase, request());
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")).toMatchObject({ erasedAt: iso(START) });
    // A new event for dev_1 (with dev_2 beside) is recorded without dev_1's details and creates no key for dev_1.
    const outcome = await appendEvent(b.appender, event(A, 1, [["dev_1", ALICE], ["dev_2", BOB]]));
    expect(outcome).toMatchObject({ result: "appended" });
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")).toStrictEqual({ pk: `ORG#${A}`, sk: "SUBJECT#dev_1", erasedAt: iso(START) });
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_2")).toHaveProperty("wrapped");
    expect(b.db.dump()).not.toContain(ALICE);
  });

  it("makes a person's earlier details unreadable at once, and a later erase of the same person is a no-op that records nothing twice", async () => {
    const b = bench();
    await b.seedKeys(A);
    const ring = b.keyring("broker");
    const sealed = await b.keyring().sealDetails(A, 7, [{ subject: "dev_1", fields: { name: ALICE } }, { subject: "dev_2", fields: { name: BOB } }]);
    expect(await ring.openDetails(A, 7, sealed.sealed)).toMatchObject([{ fields: { name: ALICE } }, { fields: { name: BOB } }]);
    await eraseAuditSubject(b.erase, request());
    expect(await ring.openDetails(A, 7, sealed.sealed)).toMatchObject([{ subject: "dev_1", erased: true }, { fields: { name: BOB } }]);
    const offered = b.sqs.offered();
    const again = await eraseAuditSubject(b.erase, request());
    expect(b.sqs.offered(), "a repeat sends no event").toBe(offered);
    expect(again).toStrictEqual({ erasedAt: iso(START), alreadyErased: true });
    const later = await eraseAuditSubject(b.erase, request({ requestId: "erase-2" }));
    expect(later).toMatchObject({ alreadyErased: true });
    expect(b.pending()).toHaveLength(1);
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")!.erasedAt).toBe(iso(START));
  });

  it("is all or nothing: a transaction that fails leaves neither the tombstone nor the event, and the exports are not touched", async () => {
    const b = bench();
    await b.seedKeys(A);
    const files = b.putObjects(A, 2);
    b.db.fake.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] } });
    await expect(eraseAuditSubject(b.erase, request())).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
    expect(b.pending()).toStrictEqual([]);
    expect(b.keyItems(A).filter((item) => item.erasedAt !== undefined)).toStrictEqual([]);
    expect(b.bucket.keys()).toStrictEqual(files.sort());
    // The retry of the same request then does both.
    await eraseAuditSubject(b.erase, request());
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")).toMatchObject({ erasedAt: iso(START) });
    expect(b.pending()).toHaveLength(1);
  });

  it("writes no tombstone when the event cannot be made (no outbox on the install, or an event the schema refuses)", async () => {
    const b = bench();
    await b.seedKeys(A);
    const { audit: _audit, ...withoutOutbox } = b.erase;
    void _audit;
    await expect(eraseAuditSubject(withoutOutbox, request())).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    await expect(eraseAuditSubject(b.erase, request({ reason: "x".repeat(5000) }))).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
    expect(b.pending()).toStrictEqual([]);
  });

  it("refuses a subject that is not one person's id: the org subject, or a key that would name another item", async () => {
    const b = bench();
    await b.seedKeys(A);
    for (const developerId of ["org", "", "dev_1#x", "dev 1", "dev_1\n", "x".repeat(101), "DATA_KEY#", "../dev"]) {
      await expect(eraseAuditSubject(b.erase, request({ developerId })), JSON.stringify(developerId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(b.sorts(A)).toStrictEqual(["DATA_KEY", "PSEUDONYM_KEY", "SUBJECT#dev_1", "SUBJECT#dev_2", "SUBJECT#org"]);
    expect(b.pending()).toStrictEqual([]);
    expect(b.operations.filter((operation) => operation.command.startsWith("Transact"))).toStrictEqual([]);
  });

  it("refuses an org that is already shredded, and writes nothing into its partition", async () => {
    const b = bench();
    b.db.set(KEYS, { pk: `ORG#${A}`, sk: "SHREDDED", at: iso(START) });
    await expect(eraseAuditSubject(b.erase, request())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    expect(b.pending()).toStrictEqual([]);
  });

  it("deletes the org's export files, and only that org's, after the tombstone is committed", async () => {
    const b = bench();
    await b.seedKeys(A);
    const mine = b.putObjects(A, 3, `export with ${ALICE}`);
    const theirs = b.putObjects(B, 2, `export with ${ALICE}`);
    b.bucket.objects.set(`${A}.stray`, Buffer.from("not under the org's folder"));
    let tombstoneWhenDeleting: unknown;
    b.bucket.beforeDelete = () => { tombstoneWhenDeleting ??= b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1"); };
    await eraseAuditSubject(b.erase, request());
    expect(tombstoneWhenDeleting).toMatchObject({ erasedAt: iso(START) });
    expect(b.bucket.keysUnder(`${A}/`)).toStrictEqual([]);
    expect(b.bucket.keys()).toStrictEqual([`${A}.stray`, ...theirs].sort());
    expect(mine).toHaveLength(3);
    // Everything the bucket was asked to do was scoped to the org's folder.
    for (const call of b.bucket.calls) expect(call.command === "ListObjectsV2" ? call.prefix : call.key, JSON.stringify(call)).toMatch(new RegExp(`^${A}/`));
  });

  it("when the exports cannot be cleared, the erasure stands, the caller is told, and the same request finishes the job without a second event", async () => {
    const b = bench();
    await b.seedKeys(A);
    b.putObjects(A, 2);
    let failures = 1;
    b.bucket.beforeList = () => { if (failures-- > 0) throw Object.assign(new Error("throttled"), { name: "SlowDown" }); };
    await expect(eraseAuditSubject(b.erase, request())).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(b.db.get(KEYS, `ORG#${A}`, "SUBJECT#dev_1")).toMatchObject({ erasedAt: iso(START) });
    expect(b.bucket.keysUnder(`${A}/`)).toHaveLength(2);
    const retry = await eraseAuditSubject(b.erase, request());
    expect(retry.alreadyErased).toBe(true);
    expect(b.bucket.keysUnder(`${A}/`)).toStrictEqual([]);
    expect(b.pending()).toHaveLength(1);
  });

  it("tries to deliver the event after the commit, and a queue that is down does not fail the erasure", async () => {
    const b = bench();
    await b.seedKeys(A);
    b.sqs.mode = "throw";
    await eraseAuditSubject(b.erase, request());
    expect(b.pending()).toHaveLength(1);
    const delivered = bench();
    delivered.sqs.mode = "ok";
    await delivered.seedKeys(A);
    await eraseAuditSubject(delivered.erase, request());
    expect(delivered.sqs.queue).toHaveLength(1);
    expect(JSON.parse(delivered.sqs.queue[0]!.body)).toMatchObject({ action: "audit.subject_erased", orgId: A });
    // Delivered, so its pending item is gone.
    expect(delivered.pending()).toStrictEqual([]);
  });
});

describe("purgeAuditExports", () => {
  it("lists and deletes every page of one org's folder, and nothing outside it", async () => {
    const b = bench();
    b.bucket.pageSize = 7;
    b.putObjects(A, 30);
    const others = b.putObjects(B, 5);
    b.bucket.objects.set(`${A}x/file`, Buffer.from("a different folder whose name starts the same"));
    const count = await purgeAuditExports({ s3: b.bucket.client, exportsBucket: EXPORTS_BUCKET }, A);
    expect(count).toBe(30);
    expect(b.bucket.keys()).toStrictEqual([`${A}x/file`, ...others].sort());
    expect(b.bucket.calls.filter((call) => call.command === "ListObjectsV2").length).toBeGreaterThan(4);
  });

  it("refuses an org id that is not one, so that a bad id can never widen the prefix", async () => {
    const b = bench();
    b.putObjects(A, 2);
    for (const orgId of ["", "org_", "*", "org_aaaaaaaaaaaaaaaaaaaa/", "../org_aaaaaaaaaaaaaaaaaaaa"]) {
      await expect(purgeAuditExports({ s3: b.bucket.client, exportsBucket: EXPORTS_BUCKET }, orgId), orgId).rejects.toThrow();
    }
    expect(b.bucket.calls).toStrictEqual([]);
    expect(b.bucket.keysUnder(`${A}/`)).toHaveLength(2);
  });
});

describe("scheduleAuditShred", () => {
  it("returns the due item and the audit.org_shred_scheduled event for the close transaction, which commit together", async () => {
    const b = bench();
    const items = scheduleAuditShred({ audit: b.audit, tableName: STATE }, { orgId: A, closedAt: iso(START), actor: { kind: "member", id: "dev_1" } });
    expect(items).toHaveLength(2);
    expect(items[0]).toStrictEqual({ Put: { TableName: STATE, Item: { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(START + AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS * DAY)}#${A}`, orgId: A, closedAt: iso(START) } } });
    expect(items[1]!.Put!.Item).toMatchObject({ event: { action: "audit.org_shred_scheduled", orgId: A, facts: { shredAfterDays: 30 } } });
    expect(AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS).toBe(30);
    await b.scheduleShred(A, START);
    expect(b.dueItems()).toHaveLength(1);
    expect(b.pending()).toHaveLength(1);
    expect(b.db.sent.filter((entry) => entry.command === "TransactWriteCommand")[0]!.tables).toStrictEqual([STATE, STATE]);
  });

  it("is the same item for the same close, whenever it is retried, and gives nothing on an install with no ledger", async () => {
    const b = bench();
    await b.scheduleShred(A, START);
    await b.scheduleShred(A, START);
    expect(b.dueItems()).toHaveLength(1);
    expect(b.pending()).toHaveLength(1);
    expect(scheduleAuditShred({ tableName: STATE }, { orgId: A, closedAt: iso(START), actor: { kind: "member", id: "dev_1" } })).toStrictEqual([]);
  });
});

describe("processDueShreds", () => {
  /** Org A closed at START with keys, exports and an org record; org B has the same and is not due. */
  async function world(): Promise<Bench> {
    const b = bench();
    await b.seedKeys(A);
    await b.seedKeys(B);
    await eraseAuditSubject(b.erase, request({ orgId: A, developerId: "dev_2" }));
    b.db.set(STATE, b.orgMeta(A));
    b.db.set(STATE, b.orgMeta(B));
    b.putObjects(A, 4, `export with ${ALICE}`);
    b.putObjects(B, 3);
    await b.scheduleShred(A, START);
    await b.scheduleShred(B, START + 10 * DAY);
    return b;
  }

  it("does nothing at day 29 and everything at day 30, including the export files", async () => {
    const b = await world();
    const snapshot = () => b.db.dump() + JSON.stringify(b.bucket.keys());
    b.clock.now = START + 29 * DAY;
    const before = snapshot();
    expect(await processDueShreds(b.shred, b.clock.now)).toStrictEqual({ shredded: [], failed: [] });
    expect(snapshot()).toBe(before);
    expect(b.sleeps).toStrictEqual([]);
    b.clock.now = START + 30 * DAY;
    expect(await processDueShreds(b.shred, b.clock.now)).toStrictEqual({ shredded: [A], failed: [] });
    // Org A: only the marker is left in the keys table; the exports are gone; the due item is gone.
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    expect(b.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toStrictEqual({ pk: `ORG#${A}`, sk: "SHREDDED", at: iso(START + 30 * DAY) });
    expect(b.bucket.keysUnder(`${A}/`)).toStrictEqual([]);
    expect(b.dueItems().map((item) => item.orgId)).toStrictEqual([B]);
    // Org B is untouched: keys, exports and its not-yet-due item.
    expect(b.sorts(B)).toStrictEqual(["DATA_KEY", "PSEUDONYM_KEY", "SUBJECT#dev_1", "SUBJECT#dev_2", "SUBJECT#org"]);
    expect(b.bucket.keysUnder(`${B}/`)).toHaveLength(3);
  });

  it("proves another org's items survive: its keys, its exports, its org record and its due item are the very same after the shred", async () => {
    const b = await world();
    const bKeys = JSON.stringify(b.keyItems(B));
    const bFiles = JSON.stringify(b.bucket.keysUnder(`${B}/`));
    b.clock.now = START + 30 * DAY;
    await processDueShreds(b.shred, b.clock.now);
    expect(JSON.stringify(b.keyItems(B))).toBe(bKeys);
    expect(JSON.stringify(b.bucket.keysUnder(`${B}/`))).toBe(bFiles);
    expect(b.db.get(STATE, `ORG#${B}`, "META")).toMatchObject({ name: "Acme Inc" });
    expect(b.dueItems()).toHaveLength(1);
    // Both orgs close on the same day and are shredded in one run: still each only its own.
    b.clock.now = START + 40 * DAY;
    await processDueShreds(b.shred, b.clock.now);
    expect(b.sorts(B)).toStrictEqual(["SHREDDED"]);
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
  });

  it("keeps the org's own record: nothing deletes or hides the org META (staff still need the log of a closed company)", async () => {
    const b = await world();
    b.clock.now = START + 30 * DAY;
    await processDueShreds(b.shred, b.clock.now);
    expect(b.db.get(STATE, `ORG#${A}`, "META")).toStrictEqual(b.orgMeta(A));
    expect(b.operations.filter((operation) => operation.command === "DeleteCommand" && operation.table === STATE).map((operation) => operation.key)).toStrictEqual([
      expect.objectContaining({ pk: AUDIT_SHRED_DUE_PARTITION }),
    ]);
  });

  it("scopes every delete to the org: only its keys partition (never the marker), only the due item in the State table, only its folder in the bucket", async () => {
    const b = await world();
    b.clock.now = START + 30 * DAY;
    b.operations.length = 0;
    b.bucket.calls.length = 0;
    await processDueShreds(b.shred, b.clock.now);
    const deletes = b.operations.filter((operation) => operation.command === "DeleteCommand");
    expect(deletes.length).toBeGreaterThan(5);
    for (const operation of deletes) {
      if (operation.table === KEYS) {
        expect(operation.key!.pk).toBe(`ORG#${A}`);
        expect(operation.key!.sk).not.toBe("SHREDDED");
      } else {
        expect(operation).toMatchObject({ table: STATE, key: { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(START + 30 * DAY)}#${A}` } });
      }
    }
    // Writes: only the marker, in the keys table.
    const puts = b.operations.filter((operation) => operation.command === "PutCommand");
    expect(puts.map(({ command, table, key }) => ({ command, table, key }))).toStrictEqual([{ command: "PutCommand", table: KEYS, key: { pk: `ORG#${A}`, sk: "SHREDDED", at: iso(START + 30 * DAY) } }]);
    // Every query reads one org's partition or the due partition, and nothing reads an item.
    for (const call of b.bucket.calls) expect(call.command === "ListObjectsV2" ? call.prefix : call.key).toMatch(new RegExp(`^${A}/`));
    expect(b.bucket.calls.every((call) => call.command === "ListObjectsV2" || call.command === "DeleteObject")).toBe(true);
  });

  it("writes SHREDDED first, then waits at least 35 seconds (the appender's 30 plus 5 of margin), and only then deletes: nothing is deleted while a create may be in flight", async () => {
    const b = await world();
    b.clock.now = START + 30 * DAY;
    const seen: Array<{ marker: unknown; keys: string[]; files: number }> = [];
    b.hooks.onSleep = () => { seen.push({ marker: b.db.get(KEYS, `ORG#${A}`, "SHREDDED"), keys: b.sorts(A), files: b.bucket.keysUnder(`${A}/`).length }); };
    await processDueShreds(b.shred, b.clock.now);
    expect(b.sleeps).toStrictEqual([AUDIT_SHRED_SETTLE_MS]);
    // The appender can take 30 s to land a key creation that started just before SHREDDED was written; the margin covers the rest.
    expect(AUDIT_SHRED_SETTLE_MS).toBeGreaterThanOrEqual(35_000);
    // And the wait still fits, with the sweep's own margin, in the anchor's 300 s timeout.
    expect(AUDIT_SHRED_SETTLE_MS + AUDIT_SHRED_MARGIN_MS).toBeLessThan(300_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.marker).toMatchObject({ at: iso(START + 30 * DAY) });
    expect(seen[0]!.keys).toContain("DATA_KEY");
    expect(seen[0]!.files).toBe(4);
  });

  it("removes a key created in a race with SHREDDED, and the marker survives (and the marker stays on every later run)", async () => {
    const b = await world();
    b.clock.now = START + 30 * DAY;
    // An appender that read the org as not shredded just before the marker lands creates keys after it.
    b.hooks.onSleep = () => {
      b.db.set(KEYS, { pk: `ORG#${A}`, sk: "SUBJECT#dev_9", iv: "AAAA", wrapped: "AAAA" });
      b.db.set(KEYS, { pk: `ORG#${A}`, sk: "PSEUDONYM_KEY", iv: "BBBB", wrapped: "BBBB" });
      b.db.set(KEYS, { pk: `ORG#${A}`, sk: "DATA_KEY", wrapped: "CCCC", createdAt: iso(START) });
    };
    await processDueShreds(b.shred, b.clock.now);
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    b.hooks.onSleep = undefined;
    for (const days of [31, 100, 4000]) {
      await processDueShreds(b.shred, START + days * DAY);
      expect(b.sorts(A), `day ${String(days)}`).toStrictEqual(["SHREDDED"]);
      expect(b.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toMatchObject({ at: iso(START + 30 * DAY) });
    }
  });

  it("leaves the keyring unable to make a key for the shredded org, and its names pseudonymize to n_shredded", async () => {
    const b = await world();
    b.clock.now = START + 30 * DAY;
    await processDueShreds(b.shred, b.clock.now);
    const ring = b.keyring();
    expect(await ring.dataKey(A, true)).toBe("shredded");
    expect(await ring.subjectKey(A, "dev_1", true)).toBe("shredded");
    expect(await ring.pseudonym(A, "repository", "acme/widgets")).toBe("n_shredded");
    expect(await ring.sealDetails(A, 9, [{ subject: "dev_1", fields: { name: ALICE } }])).toStrictEqual({ commits: [], sealed: [] });
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
  });

  it("is idempotent: a second run (and a run after a crash that left the due item behind) is a no-op", async () => {
    const b = await world();
    b.clock.now = START + 30 * DAY;
    await processDueShreds(b.shred, b.clock.now);
    b.sleeps.length = 0;
    b.operations.length = 0;
    b.bucket.calls.length = 0;
    expect(await processDueShreds(b.shred, b.clock.now + 60_000)).toStrictEqual({ shredded: [], failed: [] });
    expect(b.sleeps).toStrictEqual([]);
    expect(b.operations.filter((operation) => /^(Delete|Put|Update)Command$/.test(operation.command))).toStrictEqual([]);
    expect(b.bucket.calls.filter((call) => call.command === "DeleteObject")).toStrictEqual([]);
    // The crash case: everything is done, only the due item is back.
    b.db.set(STATE, { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(START + 30 * DAY)}#${A}`, orgId: A, closedAt: iso(START) });
    b.operations.length = 0;
    expect(await processDueShreds(b.shred, b.clock.now + 120_000)).toStrictEqual({ shredded: [A], failed: [] });
    expect(b.sleeps).toStrictEqual([]);
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    expect(b.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toMatchObject({ at: iso(START + 30 * DAY) });
    expect(b.dueItems().map((item) => item.orgId)).toStrictEqual([B]);
  });

  it("waits only what is left of the 35 seconds when an earlier run wrote SHREDDED and stopped", async () => {
    const b = await world();
    b.db.set(KEYS, { pk: `ORG#${A}`, sk: "SHREDDED", at: iso(START + 30 * DAY - 25_000) });
    b.clock.now = START + 30 * DAY;
    await processDueShreds(b.shred, b.clock.now);
    expect(b.sleeps).toStrictEqual([10_000]);
    expect(b.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toMatchObject({ at: iso(START + 30 * DAY - 25_000) });
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
  });

  it("goes through many pages of keys and of files", async () => {
    const b = bench();
    b.bucket.pageSize = 100;
    for (let index = 0; index < 250; index += 1) b.db.set(KEYS, { pk: `ORG#${A}`, sk: `SUBJECT#dev_${String(index).padStart(4, "0")}`, iv: "AA", wrapped: "AA" });
    b.putObjects(A, 330);
    b.putObjects(B, 120);
    await b.scheduleShred(A, START);
    await processDueShreds(b.shred, START + 30 * DAY);
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    expect(b.bucket.keysUnder(`${A}/`)).toStrictEqual([]);
    expect(b.bucket.keysUnder(`${B}/`)).toHaveLength(120);
  });

  it("when one org's shred fails, says so, keeps its due item for the next run, and still shreds the others", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.seedKeys(B);
    b.putObjects(A, 2);
    b.putObjects(B, 2);
    await b.scheduleShred(A, START);
    await b.scheduleShred(B, START);
    b.bucket.beforeDelete = (key) => { if (key.startsWith(`${A}/`)) throw Object.assign(new Error("denied"), { name: "AccessDenied" }); };
    const first = await processDueShreds(b.shred, START + 30 * DAY);
    expect(first).toStrictEqual({ shredded: [B], failed: [A] });
    expect(b.logs).toContainEqual(expect.objectContaining({ event: "audit.shred_failed", level: "error", orgId: A, error: "AccessDenied" }));
    expect(b.dueItems().map((item) => item.orgId)).toStrictEqual([A]);
    expect(b.sorts(B)).toStrictEqual(["SHREDDED"]);
    expect(b.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toBeDefined();
    // The next run, with the fault gone, finishes A without waiting again.
    b.bucket.beforeDelete = undefined;
    b.sleeps.length = 0;
    expect(await processDueShreds(b.shred, START + 30 * DAY + 900_000)).toStrictEqual({ shredded: [A], failed: [] });
    expect(b.sleeps).toStrictEqual([]);
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    expect(b.bucket.keys()).toStrictEqual([]);
    expect(b.dueItems()).toStrictEqual([]);
  });

  it("reads a due item whose key does not name its org as damaged: it logs, deletes nothing and keeps the item", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.seedKeys(B);
    b.putObjects(A, 1);
    b.db.set(STATE, { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(START)}#${A}`, orgId: B, closedAt: iso(START) });
    b.db.set(STATE, { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(START)}#not-an-org`, orgId: "not-an-org", closedAt: iso(START) });
    b.db.set(STATE, { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(START)}#${A}x`, orgId: `${A}x` });
    const outcome = await processDueShreds(b.shred, START + DAY);
    expect(outcome).toStrictEqual({ shredded: [], failed: [] });
    expect(b.logs.filter((entry) => entry.event === "audit.shred_item_invalid")).toHaveLength(3);
    expect(b.sorts(A)).toHaveLength(5);
    expect(b.sorts(B)).toHaveLength(5);
    expect(b.bucket.keysUnder(`${A}/`)).toHaveLength(1);
    expect(b.dueItems()).toHaveLength(3);
    expect(b.sleeps).toStrictEqual([]);
  });
});

describe("processDueShreds: the fix round", () => {
  it("deletes the due item only if it still names the org (a conditional delete)", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.scheduleShred(A, START);
    b.operations.length = 0;
    await processDueShreds(b.shred, START + 30 * DAY);
    const due = b.operations.filter((operation) => operation.command === "DeleteCommand" && operation.table === STATE);
    expect(due).toHaveLength(1);
    expect(due[0]!.condition).toBe("orgId = :org");
    expect(due[0]!.values).toStrictEqual({ ":org": A });
  });

  it("keeps a due item that changed under it: the delete fails its condition, the org is reported failed, the next run clears it", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.scheduleShred(A, START);
    const sk = `${iso(START + 30 * DAY)}#${A}`;
    b.hooks.onSleep = () => { b.db.set(STATE, { pk: AUDIT_SHRED_DUE_PARTITION, sk, orgId: B, closedAt: iso(START) }); };
    const first = await processDueShreds(b.shred, START + 30 * DAY);
    expect(first).toStrictEqual({ shredded: [], failed: [A] });
    expect(b.db.get(STATE, AUDIT_SHRED_DUE_PARTITION, sk)).toMatchObject({ orgId: B });
    expect(b.sorts(B)).toStrictEqual([]);
  });

  it("stamps SHREDDED with the time it is written, not the time the run began, and waits 35 seconds from that", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.scheduleShred(A, START);
    // The run began at day 30; the epoch work before the sweep took 7 seconds.
    b.clock.now = START + 30 * DAY + 7000;
    await processDueShreds(b.shred, START + 30 * DAY);
    expect(b.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toStrictEqual({ pk: `ORG#${A}`, sk: "SHREDDED", at: iso(START + 30 * DAY + 7000) });
    expect(b.sleeps).toStrictEqual([AUDIT_SHRED_SETTLE_MS]);
  });

  it("writes the marker but waits for nothing when the wait does not fit, and does nothing at all when even the marker does not: it logs audit.shred_deferred and keeps the due items", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.scheduleShred(A, START);
    b.operations.length = 0;
    // 94 s left: the marker fits, the 35 s wait plus the 60 s margin does not.
    const outcome = await processDueShreds({ ...b.shred, remainingMs: () => 94_000 }, START + 30 * DAY);
    expect(outcome).toStrictEqual({ shredded: [], failed: [] });
    expect(b.logs).toContainEqual(expect.objectContaining({ event: "audit.shred_deferred", level: "error", orgs: 1 }));
    expect(b.sleeps).toStrictEqual([]);
    expect(b.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toBeDefined();
    expect(b.operations.filter((operation) => operation.command === "DeleteCommand")).toStrictEqual([]);
    expect(b.sorts(A)).toHaveLength(6);
    expect(b.dueItems()).toHaveLength(1);
    // The next run, with time, finds the marker (older than 35 s by then) and sweeps without waiting.
    b.clock.now += 900_000;
    b.logs.length = 0;
    expect(await processDueShreds(b.shred, START + 30 * DAY + 900_000)).toStrictEqual({ shredded: [A], failed: [] });
    expect(b.sleeps).toStrictEqual([]);
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    // And with almost nothing left, nothing is written.
    const c = bench();
    await c.seedKeys(A);
    await c.scheduleShred(A, START);
    c.operations.length = 0;
    await processDueShreds({ ...c.shred, remainingMs: () => 10_000 }, START + 30 * DAY);
    expect(c.db.get(KEYS, `ORG#${A}`, "SHREDDED")).toBeUndefined();
    expect(c.operations.filter((operation) => /^(Put|Delete)Command$/.test(operation.command))).toStrictEqual([]);
    expect(c.logs).toContainEqual(expect.objectContaining({ event: "audit.shred_deferred", orgs: 1 }));
  });

  it("stops between orgs when the time runs low: the orgs it finished are done, the rest are deferred (logged), and the next run finishes them", async () => {
    const b = bench();
    for (const orgId of [A, B]) { await b.seedKeys(orgId); b.putObjects(orgId, 2); await b.scheduleShred(orgId, START); }
    let left = 10 * 60_000;
    // The first org's sweep uses the time; by the second there is not enough left.
    b.bucket.beforeDelete = () => { left = 30_000; };
    const outcome = await processDueShreds({ ...b.shred, remainingMs: () => left }, START + 30 * DAY);
    expect(outcome).toStrictEqual({ shredded: [A], failed: [] });
    expect(b.logs).toContainEqual(expect.objectContaining({ event: "audit.shred_deferred", orgs: 1 }));
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    expect(b.db.get(KEYS, `ORG#${B}`, "SHREDDED")).toBeDefined();
    expect(b.dueItems().map((item) => item.orgId)).toStrictEqual([B]);
    b.bucket.beforeDelete = undefined;
    left = 10 * 60_000;
    expect(await processDueShreds({ ...b.shred, remainingMs: () => left }, START + 30 * DAY + 900_000)).toStrictEqual({ shredded: [B], failed: [] });
    expect(b.sorts(B)).toStrictEqual(["SHREDDED"]);
    expect(b.bucket.keys()).toStrictEqual([]);
  });

  it("is not starved by damaged items at the head of the due list: it pages past any number of them", async () => {
    const b = bench();
    await b.seedKeys(A);
    await b.scheduleShred(A, START + DAY);
    for (let index = 0; index < 60; index += 1) b.db.set(STATE, { pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(START + index * 1000)}#damaged-${String(index)}`, orgId: "damaged" });
    const outcome = await processDueShreds(b.shred, START + 31 * DAY);
    expect(outcome.shredded).toStrictEqual([A]);
    expect(b.sorts(A)).toStrictEqual(["SHREDDED"]);
    expect(b.logs.filter((entry) => entry.event === "audit.shred_item_invalid")).toHaveLength(60);
  });

  it("is not starved by orgs whose shred keeps failing: they stay at the head, and a later org is still shredded", async () => {
    const b = bench();
    const failing: string[] = []; void failing;
    for (let index = 0; index < 30; index += 1) {
      const orgId = `org_${String(index).padStart(20, "0")}`;
      failing.push(orgId);
      await b.scheduleShred(orgId, START);
    }
    await b.seedKeys(B);
    await b.scheduleShred(B, START + DAY);
    // Every one of the 30 fails at its first read of the keys table; B's reads are untouched.
    b.db.fake.injectFault({
      command: "QueryCommand",
      match: (input) => String((input.ExpressionAttributeValues as Record<string, unknown>)[":pk"]).includes("ORG#org_0000"),
      times: 1000,
      error: { name: "AccessDeniedException" },
    });
    const outcome = await processDueShreds(b.shred, START + 31 * DAY);
    expect(outcome.shredded).toStrictEqual([B]);
    expect(outcome.failed).toHaveLength(30);
    expect(b.sorts(B)).toStrictEqual(["SHREDDED"]);
  });
});

describe("what holds a person's details, and for how long", () => {
  it("lists each store once with a window of at most 35 days, and the stores the plan names", () => {
    expect(AUDIT_DETAIL_STORES.map((store) => store.id)).toStrictEqual(["intake-queue", "dead-letter-queue", "pending-items", "pending-items-backups", "pending-items-stream", "exports-bucket", "key-cache"]);
    for (const store of AUDIT_DETAIL_STORES) {
      expect(store.maxDays, store.id).toBeGreaterThan(0);
      expect(store.maxDays, store.id).toBeLessThanOrEqual(AUDIT_TRANSIENT_COPY_DAYS);
    }
    expect(AUDIT_TRANSIENT_COPY_DAYS).toBe(35);
    // The notice promises the worst case: an event stuck in the State table for its 14 days, then the table's 35 days of backups.
    expect(AUDIT_COPIES_GONE_WITHIN_DAYS).toBe(49);
    expect(AUDIT_COPIES_GONE_WITHIN_DAYS).toBe(AUDIT_PENDING_TTL_DAYS + AUDIT_TRANSIENT_COPY_DAYS);
    expect(AUDIT_DETAIL_STORES.find((store) => store.id === "key-cache")!.maxDays).toBeCloseTo(AUDIT_KEY_CACHE_MS / DAY, 6);
    expect(AUDIT_DETAIL_STORES.find((store) => store.id === "pending-items")!.maxDays).toBe(AUDIT_PENDING_TTL_DAYS);
  });

  /**
   * Walks one marker name through the fakes: sent to the queue, held as a pending item, appended (sealed), exported, erased. At each
   * step, every store the list names is searched for the plaintext, and the test says where it may still be and until when.
   */
  it("finds the plaintext only in the stores the list names, and in none of them once its window has passed", async () => {
    const b = bench();
    b.sqs.mode = "ok";
    await b.seedKeys(A, ["org"]);
    const marker = event(A, 1, [["dev_1", ALICE]]);
    // 1. The action commits: a pending item holds the details (the outbox), and the flush sends them to the queue.
    const { auditTransact } = await import("../../packages/broker/src/audit/outbox.js");
    const { flushAuditEvents } = await import("../../packages/broker/src/audit/flush.js");
    await auditTransact({ audit: b.audit, documentClient: b.db.client }, { Put: { TableName: STATE, Item: { pk: "ACTION#1", sk: "META" } } }, [marker]);
    const holders = () => ({
      pending: b.pending().filter((e) => JSON.stringify(e).includes(ALICE)).length,
      queue: b.sqs.queue.filter((message) => message.body.includes(ALICE)).length,
      ledgerAndKeys: b.db.find(LEDGER).concat(b.db.find(KEYS)).filter((item) => JSON.stringify(item).includes(ALICE)).length,
      exports: [...b.bucket.objects.values()].filter((body) => body.toString().includes(ALICE)).length,
    });
    expect(holders()).toStrictEqual({ pending: 1, queue: 0, ledgerAndKeys: 0, exports: 0 });
    const pendingItem = b.db.find(STATE, (item) => String(item.pk).startsWith("AUDIT_PENDING#"))[0]!;
    // Its time to live is the stated 14 days (the table's TTL removes it), never longer than the window.
    expect(pendingItem.indexExpiresAt).toBe(Math.floor(START / 1000) + AUDIT_PENDING_TTL_DAYS * 86_400);
    await flushAuditEvents({ audit: b.audit }, [marker]);
    // 2. Sent: the pending item is deleted; the queue holds the message until the appender takes it (SQS keeps one at most 14 days).
    expect(holders()).toStrictEqual({ pending: 0, queue: 1, ledgerAndKeys: 0, exports: 0 });
    // 3. The appender appends it: only ciphertext is stored, and the plaintext is in no table.
    await appendEvent(b.appender, AuditEventInputSchema.parse(JSON.parse(b.sqs.queue.splice(0)[0]!.body)));
    expect(holders()).toStrictEqual({ pending: 0, queue: 0, ledgerAndKeys: 0, exports: 0 });
    // 4. A copy in an export file, until it is erased or the bucket's 7-day lifecycle removes it.
    b.bucket.objects.set(`${A}/aex_x.0123456789abcdef.rovara-audit.json.gz`, Buffer.from(`{"details":{"name":"${ALICE}"}}`));
    expect(holders().exports).toBe(1);
    await eraseAuditSubject(b.erase, request());
    expect(holders()).toStrictEqual({ pending: 0, queue: 0, ledgerAndKeys: 0, exports: 0 });
    // 5. What is left is only what the list gives a window to; an undelivered pending item expires with its TTL, and a stuck queue
    // message with the queue's retention.
    const stuck = event(A, 2, [["dev_1", ALICE]]);
    b.sqs.mode = "throw";
    await auditTransact({ audit: b.audit, documentClient: b.db.client }, { Put: { TableName: STATE, Item: { pk: "ACTION#2", sk: "META" } } }, [stuck]);
    await flushAuditEvents({ audit: b.audit }, [stuck]);
    expect(holders()).toMatchObject({ pending: 1 });
    const left = b.db.find(STATE, (item) => String(item.pk).startsWith("AUDIT_PENDING#") && JSON.stringify(item).includes(ALICE))[0]!;
    expect(Number(left.indexExpiresAt) * 1000 - b.clock.now).toBeLessThanOrEqual(AUDIT_PENDING_TTL_DAYS * DAY);
    // The ledger table, the seals table, the keys table and the ledger bucket never held the plaintext at any step.
    expect(holders().ledgerAndKeys).toBe(0);
  });
});


// ---- a shred stops exports -----------------------------------------------------------------------------------------------
// The bench of Tasks 11 and 12 (one store for every table; org A has 12 records with details, 10 of them sealed). The marker is
// written directly: the shred itself is proven above. Which code answers is named in each test.

const MISSING = "NOT_FOUND: That organization's audit details have been deleted, so it can't be exported.";

function exportBench(b: RoutesBench) {
  const bucket = new FakeExportsBucket();
  const s3 = { send: (command: { input: { Bucket?: string } }) => (command.input.Bucket === EXPORTS_BUCKET ? bucket.send(command) : b.h.s3.client.send(command as never)) } as unknown as S3Client;
  const deps: AuditExportDeps & AuditExportClientDeps = { ...b.deps, s3, ledgerBucket: BUCKET, anchors: {} };
  const markShredded = (orgId = ROUTES_A): void => { b.h.db.set({ pk: `ORG#${orgId}`, sk: "SHREDDED", at: iso(b.h.clock.now) }); };
  const requester = { orgId: ROUTES_A as never, actor: { kind: "member" as const, id: "dev_1" } };
  /** A finished export: started and run by the export function. */
  const finished = async (requestId: string, withDetails = false): Promise<string> => {
    const { exportId } = await startAuditExport(deps, requester, { requestId, fromSeq: 1, toSeq: 12, withDetails });
    expect(await runAuditExport(deps, { orgId: ROUTES_A, exportId })).toBe("ready");
    return exportId;
  };
  const fileOf = (exportId: string): string => String(b.h.db.get(`ORG#${ROUTES_A}#AUDIT_EXPORT#${exportId}`, "META")!.objectKey);
  const meta = (exportId: string) => b.h.db.get(`ORG#${ROUTES_A}#AUDIT_EXPORT#${exportId}`, "META");
  return { bucket, deps, markShredded, requester, finished, fileOf, meta };
}

describe("after a shred: no new export, and no link for an old one", () => {
  it("startAuditExport (export.ts) refuses a shredded org with NOT_FOUND, records nothing and starts nothing", async () => {
    const b = await routesWorld();
    const x = exportBench(b);
    x.markShredded();
    await expect(startAuditExport(x.deps, x.requester, { requestId: "late", fromSeq: 1, toSeq: 4 })).rejects.toMatchObject({ code: "NOT_FOUND", message: MISSING });
    expect(b.h.db.get(`ORG#${ROUTES_A}#AUDIT_EXPORT#${auditExportId(ROUTES_A, "late")}`, "META")).toBeUndefined();
    expect(b.invocations).toStrictEqual([]);
    // Another org is not affected: B can still start its own.
    expect(await startAuditExport(x.deps, { orgId: ROUTES_B, actor: { kind: "member", id: "dev_1" } }, { requestId: "other", fromSeq: 1, toSeq: 2 })).toMatchObject({ status: "running" });
  });

  it("exportDownloadUrl (export.ts) signs no link for a ready export once the org is shredded, and still does for another org's", async () => {
    const b = await routesWorld();
    const x = exportBench(b);
    const exportId = await x.finished("ready-before");
    await expect(exportDownloadUrl(x.deps, ROUTES_A, exportId)).resolves.toMatchObject({ expiresInSeconds: 900 });
    b.presigned.length = 0;
    x.markShredded();
    await expect(exportDownloadUrl(x.deps, ROUTES_A, exportId)).rejects.toMatchObject({ code: "NOT_FOUND", message: "NOT_FOUND: That export was deleted with the organization's audit details." });
    expect(b.presigned).toStrictEqual([]);
  });

  it("the org's routes and the staff routes answer with those two refusals, and the download route signs nothing", async () => {
    const b = await routesWorld();
    const x = exportBench(b);
    const exportId = await x.finished("ready-before");
    x.markShredded();
    b.presigned.length = 0;
    b.invocations.length = 0;
    const caller = { developerId: "dev_1", orgId: ROUTES_A as never, orgRole: "owner" as const };
    const call = (method: string, path: string, body?: unknown) => routeAuditRequest(x.deps, caller, { method, body: body ?? {}, requestId: `r-${path}` }, new URL(path, "https://rovara.test"));
    await expect(call("POST", "/v1/app/org/audit/exports", { requestId: "after", fromSeq: 1, toSeq: 2 })).rejects.toMatchObject({ code: "NOT_FOUND", message: MISSING });
    await expect(call("GET", `/v1/app/org/audit/exports/${exportId}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const staff: AuditAdminCaller = { issuer: "https://staff-idp.example.test", subject: "staff-1", isAdministrator: true };
    const orgs = orgStore(b);
    const staffCall = (method: string, path: string, body?: unknown) => routeAuditAdminRequest({ ledger: x.deps, orgExists: async (orgId) => (await orgs.getOrg(orgId)) !== undefined }, staff, { method, body: body ?? {}, requestId: `s-${path}` }, new URL(path, "https://rovara.test"));
    // A staff read that never happens is not recorded: the closed company's log is permanent, and nothing of the request (its reason,
    // its ticket) goes into the outbox, the queue or the backups. Counted over the queue and the pending items together.
    const staffReads = (): number => [...b.sqs.queue.map((message) => message.body), ...b.h.db.find((item) => String(item.pk).startsWith("AUDIT_PENDING#")).map((item) => JSON.stringify(item.event))].filter((text) => text.includes("audit.staff_read")).length;
    const readsBefore = staffReads();
    const operationsBefore = b.h.operations.length;
    await expect(staffCall("POST", `/v1/admin/audit/${ROUTES_A}/exports`, { requestId: "staff-after", fromSeq: 1, toSeq: 2, reason: "x" })).rejects.toMatchObject({ code: "NOT_FOUND", message: MISSING });
    await expect(staffCall("GET", `/v1/admin/audit/${ROUTES_A}/exports/${exportId}?reason=x`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(staffReads()).toBe(readsBefore);
    expect(b.h.operations.slice(operationsBefore).filter((operation) => /^(Put|Update|Delete|Transact)/.test(operation.action))).toStrictEqual([]);
    expect(b.presigned).toStrictEqual([]);
    expect(b.invocations).toStrictEqual([]);
    // A staff read of the records does happen on a shredded org, so it is still recorded first.
    const staffRecords = await staffCall("GET", `/v1/admin/audit/${ROUTES_A}/records?limit=1&reason=x`);
    expect(staffRecords?.status).toBe(200);
    expect(staffReads()).toBe(readsBefore + 1);
    // The records themselves are still read: a closed company's log is evidence, only its details are gone.
    const page = await call("GET", "/v1/app/org/audit/records?limit=2");
    expect(page.status).toBe(200);
    expect((page.body as { records: Array<{ details: unknown }> }).records[0]!.details).toStrictEqual([{ subject: "dev_1", erased: true }]);
  });

  it("runAuditExport (export.ts) fails a queued export of a shredded org with ORG_SHREDDED and writes no file", async () => {
    const b = await routesWorld();
    const x = exportBench(b);
    const { exportId } = await startAuditExport(x.deps, x.requester, { requestId: "queued", fromSeq: 1, toSeq: 12 });
    x.markShredded();
    expect(await runAuditExport(x.deps, { orgId: ROUTES_A, exportId })).toBe("failed");
    expect(x.meta(exportId)).toMatchObject({ status: "failed", failure: { code: "ORG_SHREDDED" } });
    expect(x.bucket.calls).toStrictEqual([]);
  });

  it("runAuditExport also stops a run that a shred overtakes while it builds: the file it just wrote is deleted, and the export fails", async () => {
    const b = await routesWorld();
    const x = exportBench(b);
    const { exportId } = await startAuditExport(x.deps, x.requester, { requestId: "overtaken", fromSeq: 1, toSeq: 12, withDetails: true });
    // SHREDDED lands after the run's first look and before it commits: the file it put must not outlive that.
    x.bucket.beforePut = () => { x.markShredded(); };
    expect(await runAuditExport(x.deps, { orgId: ROUTES_A, exportId })).toBe("failed");
    expect(x.meta(exportId)).toMatchObject({ status: "failed", failure: { code: "ORG_SHREDDED" } });
    expect(x.bucket.keys()).toStrictEqual([]);
    expect(x.bucket.calls.map((call) => call.command)).toStrictEqual(["PutObject", "DeleteObject"]);
  });

  it("an export started before the erasure of a person is cleared with the rest of the org's files by the erasure", async () => {
    const b = await routesWorld();
    const x = exportBench(b);
    const exportId = await x.finished("with-details", true);
    const before = gunzipSync(x.bucket.objects.get(x.fileOf(exportId))!).toString("utf8");
    expect(before).toContain(`Person of ${ROUTES_A}`);
    const erase: AuditEraseDeps = {
      documentClient: b.h.deps.documentClient, keysTable: KEYS, tableName: STATE, ...(b.deps.audit === undefined ? {} : { audit: b.deps.audit }), now: () => b.h.clock.now, log: () => undefined,
      purgeExports: async (orgId) => { await purgeAuditExports({ s3: x.bucket.client, exportsBucket: EXPORTS_BUCKET }, orgId); },
    };
    await eraseAuditSubject(erase, request({ orgId: ROUTES_A }));
    expect(x.bucket.keysUnder(`${ROUTES_A}/`)).toStrictEqual([]);
    // A new export with details shows dev_1 erased, verifies, and holds the name nowhere.
    const second = await x.finished("after-erase", true);
    const text = gunzipSync(x.bucket.objects.get(x.fileOf(second))!).toString("utf8");
    expect(text).not.toContain("Person of");
    const bundle = parseBundle(JSON.parse(text));
    expect(bundle.details!.filter((entry) => entry.subject === "dev_1").every((entry) => "erased" in entry && entry.erased)).toBe(true);
    expect(bundle.details!.some((entry) => entry.subject === "dev_1")).toBe(true);
    expect(verifyBundle(bundle, { anchors: {} })).toMatchObject({ ok: true });
  });
});

describe("the export function's purge event", () => {
  it("deletes the folder of the org it names, answers how many, and ignores any other event, any other source and any bad org id", async () => {
    const b = await routesWorld();
    const x = exportBench(b);
    await x.finished("one");
    await x.finished("two");
    x.bucket.objects.set(`${ROUTES_B}/aex_other.0123456789abcdef.rovara-audit.json.gz`, Buffer.from("b"));
    expect(x.bucket.keysUnder(`${ROUTES_A}/`)).toHaveLength(2);
    x.bucket.calls.length = 0;
    for (const event of [{ source: "agentx.audit-drain", orgId: ROUTES_A }, { source: AUDIT_EXPORT_PURGE_SOURCE }, { source: AUDIT_EXPORT_PURGE_SOURCE, orgId: "*" }, { source: AUDIT_EXPORT_PURGE_SOURCE, orgId: `${ROUTES_A}/` }, {}]) {
      expect(await handleAuditExportEvent(x.deps, event)).toStrictEqual({ status: "ignored" });
    }
    expect(x.bucket.calls).toStrictEqual([]);
    expect(await handleAuditExportEvent(x.deps, { source: AUDIT_EXPORT_PURGE_SOURCE, orgId: ROUTES_A })).toStrictEqual({ purged: 2 });
    expect(x.bucket.keysUnder(`${ROUTES_A}/`)).toStrictEqual([]);
    expect(x.bucket.keysUnder(`${ROUTES_B}/`)).toHaveLength(1);
    // Nothing about the purge event looks like an export: the export event still works.
    expect(await handleAuditExportEvent(x.deps, { source: "agentx.audit-export", orgId: ROUTES_A, exportId: "aex_" + "0".repeat(32) })).toMatchObject({ outcome: "unknown" });
  });

  it("is invoked by the broker synchronously, and a function error or an odd status is a failure the erasure reports", async () => {
    const sent: Array<{ input: Record<string, unknown> }> = [];
    let answer: Record<string, unknown> = { StatusCode: 200 };
    const lambda = { send: async (command: unknown) => { sent.push(command as { input: Record<string, unknown> }); return answer; } };
    const purge = exportPurger(lambda as never, "agentx-acme-AuditExport");
    await purge(ROUTES_A);
    expect(sent[0]).toBeInstanceOf(InvokeCommand);
    expect(sent[0]!.input).toMatchObject({ FunctionName: "agentx-acme-AuditExport", InvocationType: "RequestResponse" });
    expect(JSON.parse(Buffer.from(sent[0]!.input.Payload as Uint8Array).toString("utf8"))).toStrictEqual({ source: AUDIT_EXPORT_PURGE_SOURCE, orgId: ROUTES_A });
    answer = { StatusCode: 200, FunctionError: "Unhandled" };
    await expect(purge(ROUTES_A as never)).rejects.toThrow(/purge/);
    answer = { StatusCode: 202 };
    await expect(purge(ROUTES_A as never)).rejects.toThrow(/purge/);
  });
});

// ---- the staff route ------------------------------------------------------------------------------------------------------

describe("POST /v1/admin/audit/{orgId}/erase-subject", () => {
  const staff: AuditAdminCaller = { issuer: "https://staff-idp.example.test", subject: "staff-1", isAdministrator: true };
  const BODY = { requestId: "erase-route-1", developerId: "dev_1", reason: "Asked to be forgotten (ticket SUP-9)" };
  let counter = 0;

  async function routed() {
    const b = await routesWorld();
    const bucket = new FakeExportsBucket();
    for (const orgId of [ROUTES_A, ROUTES_B]) bucket.objects.set(`${orgId}/aex_${"0".repeat(32)}.0123456789abcdef.rovara-audit.json.gz`, Buffer.from("Person of " + orgId));
    const erase: AuditEraseDeps = {
      documentClient: b.h.deps.documentClient, keysTable: KEYS, tableName: STATE, ...(b.deps.audit === undefined ? {} : { audit: b.deps.audit }), now: () => b.h.clock.now, log: () => undefined,
      purgeExports: async (orgId) => { await purgeAuditExports({ s3: bucket.client, exportsBucket: EXPORTS_BUCKET }, orgId); },
    };
    const orgs = orgStore(b);
    const names = new Map([["dev_1", "Alice Example"]]);
    const call = async (path: string, body: unknown = BODY, options: { caller?: AuditAdminCaller; method?: string; withErase?: boolean; ledger?: boolean } = {}) => {
      const reply = await routeAuditAdminRequest(
        {
          ledger: options.ledger === false ? undefined : b.deps,
          ...(options.withErase === false ? {} : { erase }),
          orgExists: async (orgId) => (await orgs.getOrg(orgId)) !== undefined,
          personName: async (developerId) => names.get(developerId),
        },
        options.caller ?? staff,
        { method: options.method ?? "POST", body, requestId: `erase-req-${String(++counter)}` },
        new URL(path, "https://rovara.test"),
      );
      if (reply === undefined) throw new Error("the staff router did not take this path");
      return reply;
    };
    return { b, bucket, erase, call, names };
  }

  it("erases the person, clears the org's export files, and answers with the exact sentence naming them", async () => {
    const { b, bucket, call } = await routed();
    const reply = await call(`/v1/admin/audit/${ROUTES_A}/erase-subject`);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      message: "Alice Example's details in the audit ledger can't be read any more. Copies in queues, backups and recent exports are gone within 49 days.",
      alreadyErased: false,
    });
    expect(auditErasedMessage("Alice Example")).toBe((reply.body as { message: string }).message);
    expect(b.h.db.get(`ORG#${ROUTES_A}`, "SUBJECT#dev_1")).toMatchObject({ erasedAt: iso(b.h.clock.now) });
    // Org B's key for the same developer id, and its export file, are untouched.
    expect(b.h.db.get(`ORG#${ROUTES_B}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
    expect(bucket.keys()).toStrictEqual([`${ROUTES_B}/aex_${"0".repeat(32)}.0123456789abcdef.rovara-audit.json.gz`]);
    // The event is the operator's, about the person, in the path's org.
    const sent = b.sqs.queue.map((message) => JSON.parse(message.body) as { action: string; orgId: string; actor: { kind: string }; target: unknown });
    expect(sent).toMatchObject([{ action: "audit.subject_erased", orgId: ROUTES_A, actor: { kind: "operator" }, target: { kind: "member", id: "dev_1" } }]);
  });

  it("names the person with a plain phrase when it has no name for them", async () => {
    const { call } = await routed();
    const reply = await call(`/v1/admin/audit/${ROUTES_A}/erase-subject`, { ...BODY, developerId: "dev_2" });
    expect((reply.body as { message: string }).message).toBe("That person's details in the audit ledger can't be read any more. Copies in queues, backups and recent exports are gone within 49 days.");
  });

  it("shows the name as plain text: control, format and bidi characters are dropped, and a name of nothing but those is the plain phrase", async () => {
    const { call, names } = await routed();
    names.set("dev_3", "Eve\u202e \u001b[31mExample\u200b\n");
    names.set("dev_4", "\u202e\u200b\u001b");
    const cleaned = await call(`/v1/admin/audit/${ROUTES_A}/erase-subject`, { ...BODY, developerId: "dev_3" });
    expect((cleaned.body as { message: string }).message.startsWith("Eve [31mExample's details")).toBe(true);
    const empty = await call(`/v1/admin/audit/${ROUTES_A}/erase-subject`, { ...BODY, developerId: "dev_4" });
    expect((empty.body as { message: string }).message.startsWith("That person's details")).toBe(true);
  });

  it("is the staff pool's only: a caller without the administrator claim is FORBIDDEN, and nothing is written, read or deleted", async () => {
    const { b, bucket, call } = await routed();
    const mark = b.h.operations.length;
    await expect(call(`/v1/admin/audit/${ROUTES_A}/erase-subject`, BODY, { caller: { ...staff, isAdministrator: false } })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(b.h.operations.length).toBe(mark);
    expect(bucket.calls).toStrictEqual([]);
    expect(b.h.db.get(`ORG#${ROUTES_A}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
  });

  it("takes the org from the path alone, and an org that does not exist is NOT_FOUND with no tombstone", async () => {
    const { b, call } = await routed();
    await expect(call(`/v1/admin/audit/org_cccccccccccccccccccc/erase-subject`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(`/v1/admin/audit/not-an-org/erase-subject`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(`/v1/admin/audit/${ROUTES_A}/erase-subject`, { ...BODY, orgId: ROUTES_B })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(b.h.db.find((item) => item.erasedAt !== undefined)).toStrictEqual([]);
    expect(b.h.db.get(`ORG#${ROUTES_B}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
  });

  it("refuses a bad request before it writes anything: no reason, a reason with control characters, no request id, a bad person id, extra fields, query parameters", async () => {
    const { b, call } = await routed();
    const path = `/v1/admin/audit/${ROUTES_A}/erase-subject`;
    await expect(call(path, { ...BODY, reason: undefined })).rejects.toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
    await expect(call(path, { ...BODY, reason: "   " })).rejects.toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
    await expect(call(path, { ...BODY, reason: "line\nbreak" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(call(path, { ...BODY, reason: "r".repeat(301) })).rejects.toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
    for (const requestId of [undefined, "", 7, "x".repeat(201)]) await expect(call(path, { ...BODY, requestId }), String(requestId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    for (const developerId of [undefined, 7, "", "org", "dev_1#x", "a b"]) await expect(call(path, { ...BODY, developerId }), String(developerId)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(call(path, { ...BODY, ticket: "SUP-1", extra: true })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(call(`${path}?probe=1`)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(call(path, "not an object")).rejects.toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
    expect(b.h.db.find((item) => item.erasedAt !== undefined)).toStrictEqual([]);
    expect(b.sqs.offered()).toBe(0);
  });

  it("answers GET and every other method NOT_FOUND, and the route does not exist where the ledger or the erase wiring is missing", async () => {
    const { b, call } = await routed();
    const path = `/v1/admin/audit/${ROUTES_A}/erase-subject`;
    await expect(call(path, {}, { method: "GET" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(path, BODY, { method: "DELETE" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(path, BODY, { ledger: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(call(path, BODY, { withErase: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(b.h.db.find((item) => item.erasedAt !== undefined)).toStrictEqual([]);
  });

  it("when the export files cannot be cleared it says so (503) with the tombstone in place, and the same request finishes the job", async () => {
    const { b, bucket, call } = await routed();
    let failures = 1;
    bucket.beforeList = () => { if (failures-- > 0) throw Object.assign(new Error("throttled"), { name: "SlowDown" }); };
    await expect(call(`/v1/admin/audit/${ROUTES_A}/erase-subject`)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", statusCode: 503 });
    expect(b.h.db.get(`ORG#${ROUTES_A}`, "SUBJECT#dev_1")).toMatchObject({ erasedAt: iso(b.h.clock.now) });
    const retry = await call(`/v1/admin/audit/${ROUTES_A}/erase-subject`);
    expect(retry.body).toMatchObject({ alreadyErased: true });
    expect(bucket.keysUnder(`${ROUTES_A}/`)).toStrictEqual([]);
    expect(b.sqs.queue.filter((message) => message.body.includes("audit.subject_erased"))).toHaveLength(1);
  });

  it("is recorded in the org's own chain: the appender appends audit.subject_erased by the operator, with the reason sealed under the org", async () => {
    const { b, call } = await routed();
    await call(`/v1/admin/audit/${ROUTES_A}/erase-subject`);
    for (const message of b.sqs.queue.splice(0)) await appendEvent(b.appender, AuditEventInputSchema.parse(JSON.parse(message.body)));
    const page = await readAuditRecords(b.readDeps, ROUTES_A, { fromSeq: 13, toSeq: 13 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.record).toMatchObject({ action: "audit.subject_erased", target: { kind: "member", id: "dev_1" }, actor: { kind: "operator" } });
    expect(page.records[0]!.details).toMatchObject([{ subject: "org", fields: { reason: BODY.reason } }]);
  });
});


// ---- the broker's handler ---------------------------------------------------------------------------------------------------

describe("through the broker's handler", () => {
  const PATH = `/v1/admin/audit/${ROUTES_A}/erase-subject`;
  const BODY = { requestId: "handler-1", developerId: "dev_1", reason: "Asked to be forgotten" };

  async function wired(options: { erase?: boolean } = {}) {
    const b = await routesWorld();
    const bucket = new FakeExportsBucket();
    bucket.objects.set(`${ROUTES_A}/aex_x.0123456789abcdef.rovara-audit.json.gz`, Buffer.from("export"));
    const erase: AuditEraseDeps = {
      documentClient: b.h.deps.documentClient, keysTable: KEYS, tableName: STATE, ...(b.deps.audit === undefined ? {} : { audit: b.deps.audit }), now: () => b.h.clock.now, log: () => undefined,
      purgeExports: async (orgId) => { await purgeAuditExports({ s3: bucket.client, exportsBucket: EXPORTS_BUCKET }, orgId); },
    };
    const developer = {
      issuer: "https://dev.example.test", env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin",
      channelMembers: async () => ({ ok: true as const, memberOf: [] }),
      verifyAccessToken: async () => { throw new Error("not used by the staff path"); },
    } as unknown as DeveloperApiConfiguration;
    const { handler } = await createAdminBroker({ developer, extra: { documentClient: b.h.deps.documentClient, tableName: STATE, auditLedger: b.deps, audit: b.deps.audit, ...(options.erase === false ? {} : { auditErase: erase }) } });
    b.h.db.set({ pk: "DEVELOPER#dev_1", sk: "META", developerId: "dev_1", provider: "slack", displayName: "Maya Chen" });
    return { b, bucket, handler };
  }

  it("erases for a staff token, naming the person from their sign-in record", async () => {
    const { b, bucket, handler } = await wired();
    const answer = await adminCall(handler, { method: "POST", path: PATH, body: BODY, subject: "staff-1" });
    expect(answer.status).toBe(200);
    expect(answer.body.message).toBe("Maya Chen's details in the audit ledger can't be read any more. Copies in queues, backups and recent exports are gone within 49 days.");
    expect(b.h.db.get(`ORG#${ROUTES_A}`, "SUBJECT#dev_1")).toMatchObject({ erasedAt: iso(b.h.clock.now) });
    expect(bucket.keys()).toStrictEqual([]);
  });

  it("refuses a token that is not staff's (403), and changes nothing", async () => {
    const { b, bucket, handler } = await wired();
    const answer = await adminCall(handler, { method: "POST", path: PATH, body: BODY, admin: false });
    expect(answer.status).toBe(403);
    expect(b.h.db.get(`ORG#${ROUTES_A}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
    expect(bucket.keys()).toHaveLength(1);
    expect(b.sqs.offered()).toBe(0);
  });

  it("is on the staff path only: the member-facing prefix and a longer path never reach the erase", async () => {
    const { b, handler } = await wired();
    for (const path of [`/v1/app/org/audit/erase-subject`, `/v1/app/admin/audit/${ROUTES_A}/erase-subject`, `/v1/admin/audit/${ROUTES_A}/erase-subject/extra`]) {
      const answer = await adminCall(handler, { method: "POST", path, body: BODY });
      expect(answer.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(b.h.db.get(`ORG#${ROUTES_A}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
  });

  it("does not exist on an install with no ledger wiring", async () => {
    const { b, handler } = await wired({ erase: false });
    const answer = await adminCall(handler, { method: "POST", path: PATH, body: BODY, subject: "staff-1" });
    expect(answer.status).toBe(404);
    expect(b.h.db.get(`ORG#${ROUTES_A}`, "SUBJECT#dev_1")).toHaveProperty("wrapped");
  });
});

// ---- the anchor runs the shreds ---------------------------------------------------------------------------------------------

describe("the anchor sweeps due shreds on every run", () => {
  function anchored() {
    const h = harness();
    const bucket = new FakeExportsBucket();
    const ledgerClient = h.deps.s3;
    h.deps.s3 = { send: (command: { input: { Bucket?: string } }) => (command.input.Bucket === EXPORTS_BUCKET ? bucket.send(command) : ledgerClient.send(command as never)) };
    h.deps.shred = { keysTable: KEYS, stateTable: STATE, exportsBucket: EXPORTS_BUCKET };
    h.clock.now = at(0);
    const seed = (orgId: string): void => {
      h.db.set({ pk: `ORG#${orgId}`, sk: "DATA_KEY", wrapped: "x", createdAt: iso(at(0)) });
      h.db.set({ pk: `ORG#${orgId}`, sk: "SUBJECT#dev_1", iv: "x", wrapped: "y" });
      bucket.objects.set(`${orgId}/aex_x.0123456789abcdef.rovara-audit.json.gz`, Buffer.from("export"));
    };
    const due = (orgId: string, dueAt: number): void => { h.db.set({ pk: AUDIT_SHRED_DUE_PARTITION, sk: `${iso(dueAt)}#${orgId}`, orgId, closedAt: iso(dueAt - 30 * DAY) }); };
    return { h, bucket, seed, due, keys: (orgId: string) => h.db.find((item) => item.pk === `ORG#${orgId}`).map((item) => String(item.sk)).sort() };
  }

  it("shreds a due org in a run that has nothing to seal, leaves the not-yet-due one, and does it only once", async () => {
    const x = anchored();
    x.seed(ROUTES_A);
    x.seed(ROUTES_B);
    x.due(ROUTES_A, at(0) - 1000);
    x.due(ROUTES_B, at(0) + DAY);
    const first = await run(x.h, at(0));
    expect(first).toMatchObject({ status: "idle" });
    expect(x.keys(ROUTES_A)).toStrictEqual(["SHREDDED"]);
    expect(x.keys(ROUTES_B)).toStrictEqual(["DATA_KEY", "SUBJECT#dev_1"]);
    expect(x.bucket.keysUnder(`${ROUTES_A}/`)).toStrictEqual([]);
    expect(x.bucket.keysUnder(`${ROUTES_B}/`)).toHaveLength(1);
    expect(eventsOf(x.h, "audit.org_shredded")).toHaveLength(1);
    x.bucket.calls.length = 0;
    await run(x.h, at(1));
    expect(x.bucket.calls.filter((call) => call.command === "DeleteObject")).toStrictEqual([]);
    x.h.clock.now = at(0) + DAY + 1;
    await run(x.h, at(0) + DAY + 1);
    expect(x.keys(ROUTES_B)).toStrictEqual(["SHREDDED"]);
  });

  it("does it after the sealing, and a shred that fails does not stop the run or the seal (it is logged for the alarm)", async () => {
    const x = anchored();
    x.seed(ROUTES_A);
    x.due(ROUTES_A, at(0) - 1000);
    x.bucket.beforeList = () => { throw Object.assign(new Error("denied"), { name: "AccessDenied" }); };
    appendRecords(x.h, ROUTES_B, 3);
    const result = await run(x.h, at(0));
    expect(result.status).toBe("sealed");
    expect(storedRecords(x.h, ROUTES_B)).toHaveLength(3);
    expect(x.h.db.get("SEALED#" + ROUTES_B, "STATE")).toMatchObject({ sealedSeq: 3 });
    expect(eventsOf(x.h, "audit.shred_failed")).toMatchObject([{ orgId: ROUTES_A, level: "error", error: "AccessDenied" }]);
    expect(x.h.db.find((item) => item.pk === AUDIT_SHRED_DUE_PARTITION)).toHaveLength(1);
    x.bucket.beforeList = undefined;
    await run(x.h, at(1));
    expect(x.keys(ROUTES_A)).toStrictEqual(["SHREDDED"]);
    expect(x.h.db.find((item) => item.pk === AUDIT_SHRED_DUE_PARTITION)).toStrictEqual([]);
  });

  it("shreds even when the epoch work stops (a lock mismatch must not hold back an erasure that is due)", async () => {
    const x = anchored();
    x.seed(ROUTES_A);
    x.due(ROUTES_A, at(0) - 1000);
    x.h.s3.versioning = "Suspended";
    const result = await run(x.h, at(0));
    expect(["stopped", "idle"]).toContain(result.status);
    expect(x.keys(ROUTES_A)).toStrictEqual(["SHREDDED"]);
  });

  it("tells the sweep how much of the function's time is left, and a sweep that does not fit is deferred and logged for the alarm", async () => {
    const x = anchored();
    x.seed(ROUTES_A);
    x.due(ROUTES_A, at(0) - 1000);
    x.h.deps.shred = { ...x.h.deps.shred!, remainingMs: () => 5000 };
    await run(x.h, at(0));
    expect(eventsOf(x.h, "audit.shred_deferred")).toMatchObject([{ level: "error", orgs: 1 }]);
    expect(x.keys(ROUTES_A)).toStrictEqual(["DATA_KEY", "SUBJECT#dev_1"]);
    x.h.deps.shred = { ...x.h.deps.shred, remainingMs: () => 240_000 };
    await run(x.h, at(1));
    expect(x.keys(ROUTES_A)).toStrictEqual(["SHREDDED"]);
  });

  it("does nothing about shreds on an install whose anchor has no shred settings", async () => {
    const x = anchored();
    x.seed(ROUTES_A);
    x.due(ROUTES_A, at(0) - 1000);
    delete x.h.deps.shred;
    await run(x.h, at(0));
    expect(x.keys(ROUTES_A)).toStrictEqual(["DATA_KEY", "SUBJECT#dev_1"]);
  });
});
