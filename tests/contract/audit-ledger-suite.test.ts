import { fixtureActor } from "../support/money-authority.js";
// tests/contract/audit-ledger-suite.test.ts
// Task 21 of the Audit Ledger plan: the isolation and failure suite. Everything runs end to end over the fakes: a hooked action
// (Plan 1's `writeBudgets`, or the outbox primitives it is built from) commits its pending audit item with the action, the flush
// or the drain sends it to the intake queue, the appender appends it, the anchor seals it (with timestamps), the export function
// builds a bundle and the standalone verifier checks that bundle. One FakeDynamoDb holds every table (the code under test names
// its own tables and the keys never collide), FakeLockedS3 is the ledger bucket, FakeKms the vault key and FakeAuditSqs the
// intake queue. The fakes enforce no IAM: the grants are pinned in audit-ledger-infrastructure.test.ts.
//
// Review Focus 1 (forks, re-seals), 2 (lost events) and 5 (cross-org reads) are the groups below; the round trip closes with the CLI.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkChain, genesisHash, recordHash, verifyBundle, type AuditBundleV1, type AuditRecordV1 } from "@rovara/audit-verifier";
import { runCli } from "../../packages/audit-verifier/src/cli.js";
import {
  AUDIT_FLUSH_DEADLINE_MS,
  AUDIT_TSA_ENDPOINTS,
  AUDIT_TSA_SPACING_MS,
  AuditEventInputSchema,
  auditOperatorId,
  sealHash,
  type AuditEventInput,
  type OrgRole,
  type OrgSealV1,
} from "@agentx/contracts";
import type { AppenderDeps } from "../../packages/broker/src/audit/appender.js";
import { processAuditBatch } from "../../packages/broker/src/audit/appender-handler.js";
import { drainAuditPending } from "../../packages/broker/src/audit/drain.js";
import { purgeAuditExports, type AuditEraseDeps } from "../../packages/broker/src/audit/erase.js";
import { auditPullRequestOpened } from "../../packages/broker/src/audit/events.js";
import {
  buildAuditBundle,
  runAuditExport,
  startAuditExport,
  type AuditExportClientDeps,
  type AuditExportDeps,
  type AuditExportEvent,
} from "../../packages/broker/src/audit/export.js";
import { flushAuditEvents } from "../../packages/broker/src/audit/flush.js";
import { AuditKeyring } from "../../packages/broker/src/audit/keyring.js";
import { auditTransact } from "../../packages/broker/src/audit/outbox.js";
import { readAuditRecords, readAuditStatus, type AuditReadDeps } from "../../packages/broker/src/audit/reader.js";
import { routeAuditAdminRequest, type AuditAdminCaller } from "../../packages/broker/src/audit/admin-routes.js";
import { routeAuditRequest, type AuditOrgCaller } from "../../packages/broker/src/audit/routes.js";
import { AUDIT_VIEW_EXPORT_PATH, AUDIT_VIEW_PATH, createAuditViewPage, type AuditViewCaller } from "../../packages/broker/src/audit/view-page.js";
import { recordsObjectKey, sealObjectKey } from "../../packages/broker/src/audit/anchor.js";
import type { TsaSettings } from "../../packages/broker/src/audit/tsa-client.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { CSRF_COOKIE, SESSION_COOKIE, type WebResponse } from "../../packages/broker/src/aws/web-session.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { writeBudgets, type BudgetDependencies } from "../../packages/broker/src/org/budget.js";
import { orgMetaKey } from "../../packages/contracts/src/org-node.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import {
  A, B, BUCKET, C, E0, E1, LEDGER, SEALS, at, crash, eventsOf, harness, iso, orgOf, run, snapshot, stateOf, storedRecords, type Command,
} from "../support/audit-anchor-harness.js";
import { routeFetch } from "../support/developer-fakes.js";
import { FakeAuditSqs } from "../support/fake-audit-sqs.js";
import { FakeExportsBucket } from "../support/fake-exports-bucket.js";
import { FakeKms } from "../support/fake-kms.js";
import { makePki } from "../support/fake-tsa.js";
import { fakeTsaHost, type FakeTsaHost } from "../support/fake-tsa-server.js";
import { fakeModelAccess } from "../support/fake-model-access.js";

const D = orgOf("d");
const E = orgOf("e");
const F = orgOf("f");
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555";
const KEYS = "keys";
const STATE = "state";
const EXPORTS_BUCKET = "audit-exports-bucket";

/** Temporary directories the rigs made for exported files: removed after each test. */
const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// ---- the rig ----------------------------------------------------------------------------------------------------------------

interface SqsMessage {
  messageId: string;
  body: string;
  attributes: { MessageGroupId: string };
}

interface PumpOptions {
  /** Redeliver 10% of the messages: every 20th while its batch is being processed (the first delivery's append is still running), and every 20th from the 10th afterwards. */
  redeliver?: boolean;
  /** Which appender to run (default: the rig's). */
  appender?: AppenderDeps;
  /** A prefix for message ids, so that two queues do not share ids. */
  label?: string;
  /** Consumers per org, side by side and not in queue order (a visibility timeout that ran out): default 1. */
  lanes?: number;
}

interface PumpStats {
  delivered: number;
  redelivered: number;
}

/**
 * The appender function's side of the intake queue: the messages the queue holds that have not been delivered yet go to the
 * appender in batches of ten, one org's messages in order and the orgs side by side, as `processAuditBatch` takes them. A message the
 * handler reports as failed is delivered again until it is accepted (SQS would), and a redelivery is a message delivered twice.
 */
async function pump(queue: FakeAuditSqs, cursors: Map<FakeAuditSqs, number>, appender: AppenderDeps, options: PumpOptions = {}): Promise<PumpStats> {
  const from = cursors.get(queue) ?? 0;
  cursors.set(queue, queue.queue.length);
  const label = options.label ?? "m";
  const messages = queue.queue.slice(from).map((message, index): SqsMessage & { n: number } => ({
    n: index, messageId: `${label}-${String(from + index)}`, body: message.body, attributes: { MessageGroupId: message.groupId },
  }));
  const stats: PumpStats = { delivered: 0, redelivered: 0 };
  const deliver = async (records: SqsMessage[]): Promise<void> => {
    let remaining = records;
    for (let round = 0; remaining.length > 0; round += 1) {
      if (round >= 25) throw new Error(`the appender never accepted ${String(remaining.length)} messages`);
      const response = await processAuditBatch(appender, { Records: remaining });
      const failed = new Set(response.batchItemFailures.map((entry) => entry.itemIdentifier));
      remaining = remaining.filter((message) => failed.has(message.messageId));
    }
  };
  const groups = new Map<string, Array<SqsMessage & { n: number }>>();
  for (const message of messages) groups.set(message.attributes.MessageGroupId, [...(groups.get(message.attributes.MessageGroupId) ?? []), message]);
  const lanes = [...groups.values()].flatMap((group) => {
    const count = Math.max(1, options.lanes ?? 1);
    return Array.from({ length: count }, (_, lane) => group.filter((_message, index) => index % count === lane));
  });
  await Promise.all(lanes.map(async (group) => {
    const late: SqsMessage[] = [];
    for (let start = 0; start < group.length; start += 10) {
      const batch = group.slice(start, start + 10);
      const inFlight = options.redeliver === true ? batch.filter((message) => message.n % 20 === 0) : [];
      await Promise.all([deliver(batch), ...inFlight.map((message) => deliver([message]))]);
      stats.delivered += batch.length;
      stats.redelivered += inFlight.length;
      if (options.redeliver === true) late.push(...batch.filter((message) => message.n % 20 === 10));
    }
    await Promise.all(late.map((message) => deliver([message])));
    stats.redelivered += late.length;
  }));
  return stats;
}

const died = () => Object.assign(new Error("the process died"), { name: "ProcessDied" });

type Wrapped = { send: (command: Command) => Promise<unknown> };

/** An appender that dies right after its `nth` ledger transaction has committed. */
function appenderDyingAfter(base: AppenderDeps, nth: number): AppenderDeps {
  let transactions = 0;
  const documentClient: Wrapped = {
    send: async (command) => {
      const result = await (base.documentClient as unknown as Wrapped).send(command);
      if (command.constructor.name === "TransactWriteCommand") {
        transactions += 1;
        if (transactions === nth) throw died();
      }
      return result;
    },
  };
  return { ...base, documentClient: documentClient as unknown as AppenderDeps["documentClient"] };
}

const PEOPLE = ["dev_1", "dev_2"] as const;
const personName = (orgId: string, developerId: string): string => `Person ${developerId} of ${orgId}`;

function rig(options: { tsa?: boolean } = {}) {
  const h = harness();
  const kms = new FakeKms(KEY_ARN);
  const keyring = (caller: "appender" | "broker") => new AuditKeyring({ documentClient: h.deps.documentClient, keysTable: KEYS, kms: kms.as(caller).client, keyId: KEY_ARN, now: () => h.clock.now });
  const logs: Array<Record<string, unknown>> = [];
  const appender: AppenderDeps = { documentClient: h.deps.documentClient, ledgerTable: LEDGER, keyring: keyring("appender"), now: () => h.clock.now, log: (entry) => logs.push(entry), sleep: async () => undefined };
  const capture = capturingAuditDeps({ db: h.db, now: () => h.clock.now });
  const exportsBucket = new FakeExportsBucket();
  const s3 = { send: (command: { input: { Bucket?: string } }) => (command.input.Bucket === EXPORTS_BUCKET ? exportsBucket.send(command) : h.s3.client.send(command as never)) } as unknown as S3Client;
  const readDeps: AuditReadDeps = { documentClient: h.deps.documentClient, ledgerTable: LEDGER, sealsTable: SEALS, keyring: keyring("broker") };
  const invocations: AuditExportEvent[] = [];
  const presigned: Array<{ bucket: string; key: string }> = [];
  const exportDeps: AuditExportDeps & AuditExportClientDeps = {
    ...readDeps,
    s3,
    ledgerBucket: BUCKET,
    exportsBucket: EXPORTS_BUCKET,
    tableName: STATE,
    audit: capture.audit,
    anchors: {},
    now: () => h.clock.now,
    log: (entry) => logs.push(entry),
    invokeExport: async (event) => { invocations.push(event); },
    presign: async (input) => {
      presigned.push({ bucket: input.bucket, key: input.key });
      return { url: `https://signed.test/${input.bucket}/${input.key}?expires=${String(input.expiresInSeconds)}`, expiresInSeconds: input.expiresInSeconds };
    },
  };
  const pems: Record<string, string> = {};
  let hosts: { digicert: FakeTsaHost; sectigo: FakeTsaHost } | undefined;
  if (options.tsa === true) {
    const digicert = fakeTsaHost({ url: AUDIT_TSA_ENDPOINTS.digicert, pki: makePki("DigiCert"), now: () => h.clock.now, behavior: "grant" });
    const sectigo = fakeTsaHost({ url: AUDIT_TSA_ENDPOINTS.sectigo, pki: makePki("Sectigo"), now: () => h.clock.now, behavior: "grant" });
    const settings: TsaSettings = {
      kind: "public", timeoutMs: 2000, spacingMs: AUDIT_TSA_SPACING_MS,
      targets: [
        { label: "digicert", url: AUDIT_TSA_ENDPOINTS.digicert, anchors: [digicert.pki.root.x509] },
        { label: "sectigo", url: AUDIT_TSA_ENDPOINTS.sectigo, anchors: [sectigo.pki.root.x509] },
      ],
    };
    h.deps.tsa = { settings, fetch: routeFetch(digicert.handler, sectigo.handler), sleep: async (ms: number) => { h.clock.now += ms; }, clock: () => h.clock.now };
    exportDeps.anchors = { digicert: [digicert.pki.root.x509], sectigo: [sectigo.pki.root.x509] };
    pems.digicert = digicert.pki.root.x509.toString();
    pems.sectigo = sectigo.pki.root.x509.toString();
    hosts = { digicert, sectigo };
  }

  // ---- hooked actions: the event is committed with the action, then the flush runs (unless the process dies first) ----
  /** Every event whose transaction committed: what the ledger must come to hold. */
  const committed: AuditEventInput[] = [];
  const crashAfterCommit = { next: 0 };
  const actionClient: Wrapped = {
    send: async (command) => {
      const result = await (h.deps.documentClient as unknown as Wrapped).send(command);
      if (command.constructor.name === "TransactWriteCommand") {
        const events = (command.input.TransactItems as Array<{ Put?: { Item?: { pk?: string; event?: AuditEventInput } } }>)
          .flatMap((entry) => (entry.Put?.Item?.pk?.startsWith("AUDIT_PENDING#") === true ? [entry.Put.Item.event!] : []));
        if (events.length > 0) {
          committed.push(...events);
          if (crashAfterCommit.next > 0) {
            crashAfterCommit.next -= 1;
            throw died();
          }
        }
      }
      return result;
    },
  };
  const budgetDeps: BudgetDependencies = { documentClient: actionClient, tableName: STATE, access: fakeModelAccess(), audit: capture.audit };
  const counters = new Map<string, number>();
  const next = (orgId: string): number => {
    const n = (counters.get(orgId) ?? 0) + 1;
    counters.set(orgId, n);
    return n;
  };

  /** One budget change in `orgId` (Plan 1's writeBudgets: one transaction of the settings and the pending item, then the flush). `crash`: the process dies after the commit, before the flush. */
  async function act(orgId: string, how: { crash?: boolean } = {}): Promise<AuditEventInput> {
    const n = next(orgId);
    h.clock.now += 1000;
    const before = committed.length;
    crashAfterCommit.next = how.crash === true ? 1 : 0;
    try {
      await writeBudgets(budgetDeps, orgId, { orgMonthlyUsd: n, memberOverrides: {} }, fixtureActor(h.db, orgId, "dev_1", true).developerId, iso(h.clock.now), { actor: { kind: "member", id: "dev_1" }, ...({}), authority: fixtureActor(h.db, orgId, "dev_1", true) });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ProcessDied") throw error;
    } finally {
      crashAfterCommit.next = 0;
    }
    expect(committed.length - before, "the action committed exactly one event").toBe(1);
    return committed.at(-1)!;
  }

  /** `act` with the intake queue never answering the flush: needs fake timers (the flush returns at its deadline). */
  async function actWhileQueueHangs(orgId: string): Promise<AuditEventInput> {
    capture.sqs.mode = "hang";
    let event: AuditEventInput | undefined;
    const done = act(orgId).then((value) => { event = value; });
    for (let step = 0; step < 20 && event === undefined; step += 1) await vi.advanceTimersByTimeAsync(AUDIT_FLUSH_DEADLINE_MS);
    await done;
    capture.sqs.mode = "ok";
    return event!;
  }

  /** The outbox primitives alone: a pull request opening with the named people's details, committed and flushed. */
  async function actDetailed(orgId: string, options: { details?: boolean } = {}): Promise<AuditEventInput> {
    const n = next(orgId);
    h.clock.now += 1000;
    const event = AuditEventInputSchema.parse(auditPullRequestOpened({
      orgId,
      actor: { kind: "member", id: PEOPLE[n % 2]! },
      occurredAt: iso(h.clock.now - 500),
      occurrence: `${orgId}-${String(n)}`,
      pullRequestId: `pr_${String(n)}`,
      number: n,
      ...(options.details === false ? {} : { details: [{ subject: "dev_1", fields: { name: personName(orgId, "dev_1") } }, { subject: "dev_2", fields: { name: personName(orgId, "dev_2") } }] }),
    }));
    await auditTransact({ audit: capture.audit, documentClient: actionClient }, { Put: { TableName: STATE, Item: { pk: `ACTION#${orgId}`, sk: event.eventId, done: true } } }, [event]);
    await flushAuditEvents(capture.deps, [event]);
    return event;
  }

  const cursors = new Map<FakeAuditSqs, number>();
  /** Delivers what `queue` holds that has not been delivered yet. */
  const pumpQueue = (queue: FakeAuditSqs, pumpOptions: PumpOptions = {}): Promise<PumpStats> => pump(queue, cursors, pumpOptions.appender ?? appender, pumpOptions);
  const deliver = (pumpOptions: PumpOptions = {}): Promise<PumpStats> => pumpQueue(capture.sqs, pumpOptions);
  let requests = 0;
  const requestId = (): string => `suite-req-${String(++requests)}`;
  const directory = mkdtempSync(join(tmpdir(), "audit-ledger-suite-"));
  directories.push(directory);
  const writeFile = (name: string, bytes: Buffer): string => {
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return path;
  };
  // The intake queue answers the flush only when the test lets it: `holdFlush()` makes the next send wait, `reached` says it is waiting.
  const gate: { hold: { markReached: () => void; released: Promise<void> } | undefined } = { hold: undefined };
  const intake = capture.audit.sqs;
  capture.audit.sqs = {
    send: async (command: unknown, sendOptions: unknown) => {
      const hold = gate.hold;
      if (hold !== undefined) {
        gate.hold = undefined;
        hold.markReached();
        await hold.released;
      }
      return (intake.send as (command: unknown, options: unknown) => Promise<unknown>)(command, sendOptions);
    },
  } as unknown as typeof capture.audit.sqs;
  function holdFlush(): { reached: Promise<void>; release: () => void } {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    gate.hold = { markReached, released };
    return { reached, release };
  }
  const seal = async (n: number): Promise<void> => {
    h.clock.now = at(n);
    await run(h, at(n));
  };
  const orgStore = new OrgStore({ documentClient: h.deps.documentClient, tableName: STATE, now: () => h.clock.now });
  for (const orgId of [A, B, C, D, E, F]) {
    h.db.set({ ...orgMetaKey(orgId), entityType: "ORG", orgId, name: "Acme", createdAt: iso(at(0)), createdBy: "system", plan: "team" });
  }
  return {
    h, kms, logs, appender, readDeps, exportDeps, exportsBucket, capture, committed, invocations, presigned, pems, hosts, orgStore,
    act, actWhileQueueHangs, actDetailed, deliver, pump: pumpQueue, seal, keyring, requestId, writeFile, holdFlush,
  };
}
type Rig = ReturnType<typeof rig>;

/** The chain of one org is whole: contiguous from genesis, every event once, every claim pointing at its own record, the head at the end. */
function expectWholeChain(r: Rig, orgId: string, expectedIds: readonly string[]): AuditRecordV1[] {
  const records = storedRecords(r.h, orgId);
  expect(checkChain(records, { seq: 0, hash: genesisHash(orgId), orgId }), orgId).toStrictEqual({ ok: true });
  expect(records.map((record) => record.seq), orgId).toStrictEqual(records.map((_, index) => index + 1));
  const ids = records.map((record) => record.eventId);
  expect(new Set(ids).size, `${orgId}: an event appears twice`).toBe(ids.length);
  expect([...ids].sort(), orgId).toStrictEqual([...expectedIds].sort());
  const claims = r.h.db.find((item) => item.pk === `AUDIT#${orgId}` && String(item.sk).startsWith("EVENT#"));
  expect(claims, orgId).toHaveLength(records.length);
  for (const record of records) expect(r.h.db.get(`AUDIT#${orgId}`, `EVENT#${record.eventId}`), `${orgId} #${String(record.seq)}`).toMatchObject({ seq: record.seq });
  expect(r.h.db.get(`AUDIT#${orgId}`, "HEAD"), orgId).toMatchObject({ seq: records.length, hash: records.at(-1)?.hash });
  return records;
}

const idsOf = (events: readonly AuditEventInput[], orgId: string): string[] => events.filter((event) => event.orgId === orgId).map((event) => event.eventId);
const countOf = (r: Rig, event: string): number => r.logs.filter((entry) => entry.event === event).length;

// ---- No forks (Review Focus 1) ---------------------------------------------------------------------------------------

describe("no forks (Review Focus 1)", () => {
  it("500 events over 5 orgs, 10% redelivered, three consumers per org and the drain racing the flush for exactly 50: every chain is contiguous and holds each event once", async () => {
    const r = rig();
    const orgs = [A, B, C, D, E];
    r.h.clock.now = at(0) - 20 * 60_000;
    // The minute's drain sends to a queue of its own: its copies are messages of their own (as they are once the queue's five-minute
    // deduplication has lapsed), so the appender sees each event the drain finds twice.
    const drainQueue = new FakeAuditSqs();
    const drainDeps = { audit: { ...r.capture.audit, sqs: drainQueue.client } };
    let raced = 0;
    for (let index = 0; index < 500; index += 1) {
      const orgId = orgs[index % orgs.length]!;
      // Actions 100 to 149: the flush sends, then its delete of the pending item fails, as in a brownout. The item stays for the drain.
      if (index >= 100 && index < 150) r.h.db.injectFault({ command: "DeleteCommand", error: { name: "InternalServerError" }, times: 1 });
      if (index === 150) {
        const swept = await drainAuditPending(drainDeps, r.h.clock.now + 60_000);
        expect(swept).toMatchObject({ examined: 50, sent: 50 });
      }
      if (index < 300 || index >= 350) {
        await r.act(orgId);
        continue;
      }
      // Actions 300 to 349: the flush is held at the queue, with the action committed, until the drain has read and sent the item.
      const hold = r.holdFlush();
      const acting = r.act(orgId);
      await hold.reached;
      const startedAt = Date.parse(r.committed.at(-1)!.occurredAt);
      // The drain leaves what is younger than 30 s to the flush that has just run; the item is read from 30 s and 1 ms on (its key must sort before the cutoff).
      expect(await drainAuditPending(drainDeps, startedAt + 29_999)).toMatchObject({ examined: 0, sent: 0 });
      expect(await drainAuditPending(drainDeps, startedAt + 30_000)).toMatchObject({ examined: 0, sent: 0 });
      expect(await drainAuditPending(drainDeps, startedAt + 30_001)).toMatchObject({ examined: 1, sent: 1 });
      raced += 1;
      hold.release();
      await acting;
    }
    expect(raced).toBe(50);
    expect(r.committed).toHaveLength(500);
    expect(r.capture.flushed()).toHaveLength(500);
    expect(r.capture.pendingItems()).toHaveLength(0);
    // 50 left behind by a failed delete, and 50 sent by the drain while the flush was still on its way: 100 copies, each of a different event.
    expect(drainQueue.queue).toHaveLength(100);
    expect(new Set(drainQueue.queue.map((message) => message.dedupId)).size).toBe(100);

    // Both queues are delivered at once, the main one by three consumers per org and with 10% of its messages delivered twice.
    const [main, drained] = await Promise.all([
      r.pump(r.capture.sqs, { redeliver: true, lanes: 3, label: "main" }),
      r.pump(drainQueue, { label: "drain" }),
    ]);
    expect(main).toStrictEqual({ delivered: 500, redelivered: 50 });
    expect(drained).toStrictEqual({ delivered: 100, redelivered: 0 });

    for (const orgId of orgs) {
      const records = expectWholeChain(r, orgId, idsOf(r.committed, orgId));
      expect(records, orgId).toHaveLength(100);
    }
    expect(countOf(r, "audit.appended")).toBe(500);
    // Every delivery after the first of an event is a duplicate: the redeliveries and the drain's copies.
    expect(countOf(r, "audit.duplicate")).toBe(150);
    expect(r.h.db.refusals).toStrictEqual([]);
  }, 120_000);

  it("a message delivered again while its first delivery is still appending, and one that arrives late, leave one record each", async () => {
    const r = rig();
    r.h.clock.now = at(0) - 5 * 60_000;
    const events: AuditEventInput[] = [];
    for (let index = 0; index < 6; index += 1) events.push(await r.act(A));
    const messages = r.capture.sqs.queue.map((message, index): SqsMessage => ({ messageId: `m${String(index)}`, body: message.body, attributes: { MessageGroupId: message.groupId } }));
    // Three copies of the same batch, side by side.
    const results = await Promise.all([processAuditBatch(r.appender, { Records: messages }), processAuditBatch(r.appender, { Records: messages }), processAuditBatch(r.appender, { Records: messages })]);
    for (const result of results) expect(result.batchItemFailures.length).toBeLessThanOrEqual(messages.length);
    // Whatever a copy gave up on (contention) is delivered again, as SQS would.
    await Promise.all(results.map(async (result) => {
      const again = new Set(result.batchItemFailures.map((entry) => entry.itemIdentifier));
      if (again.size > 0) await processAuditBatch(r.appender, { Records: messages.filter((message) => again.has(message.messageId)) });
    }));
    expectWholeChain(r, A, events.map((event) => event.eventId));
    expect(countOf(r, "audit.appended")).toBe(6);
  });

  it("consumers that ignore the queue's order (six at once on one org) still leave one whole chain, the contention left to retries", async () => {
    const r = rig();
    r.h.clock.now = at(0) - 10 * 60_000;
    const events: AuditEventInput[] = [];
    for (let index = 0; index < 60; index += 1) events.push(await r.act(A));
    const messages = r.capture.sqs.queue.map((message, index): SqsMessage => ({ messageId: `m${String(index)}`, body: message.body, attributes: { MessageGroupId: message.groupId } }));
    const lanes = [0, 1, 2, 3, 4, 5].map((lane) => messages.filter((_, index) => index % 6 === lane));
    await Promise.all(lanes.map(async (lane) => {
      let remaining = lane;
      for (let round = 0; remaining.length > 0 && round < 50; round += 1) {
        const response = await processAuditBatch(r.appender, { Records: remaining.slice(0, 10) });
        const failed = new Set(response.batchItemFailures.map((entry) => entry.itemIdentifier));
        remaining = [...remaining.slice(0, 10).filter((message) => failed.has(message.messageId)), ...remaining.slice(10)];
      }
      expect(remaining).toStrictEqual([]);
    }));
    expectWholeChain(r, A, events.map((event) => event.eventId));
    // Losing a race for a sequence number is retried inside the appender, and giving up after five is left to the queue to deliver again: either way each event is appended once.
    expect(countOf(r, "audit.appended")).toBe(60);
  });

  it("an occurrence id two orgs share (same action, same request) is recorded once in each org, never dropped as a duplicate", async () => {
    const r = rig();
    r.h.clock.now = at(0) - 60_000;
    const make = (orgId: string): AuditEventInput => AuditEventInputSchema.parse(auditPullRequestOpened({
      orgId, actor: { kind: "member", id: "dev_1" }, occurredAt: iso(r.h.clock.now), occurrence: "request-both-orgs-use", pullRequestId: "pr_1", number: 1,
    }));
    const events = [make(A), make(B)];
    expect(events[0]!.eventId).toBe(events[1]!.eventId);
    for (const event of events) {
      await auditTransact({ audit: r.capture.audit, documentClient: r.h.deps.documentClient }, { Put: { TableName: STATE, Item: { pk: `ACTION#${event.orgId}`, sk: event.eventId, done: true } } }, [event]);
    }
    await flushAuditEvents(r.capture.deps, events);
    expect(r.capture.flushed()).toHaveLength(2);
    await r.deliver();
    expectWholeChain(r, A, [events[0]!.eventId]);
    expectWholeChain(r, B, [events[1]!.eventId]);
  });

  it("refuses another org's event in this org's message group: nothing is appended for either", async () => {
    const r = rig();
    const event = await r.act(B);
    const body = r.capture.sqs.queue[0]!.body;
    const result = await processAuditBatch(r.appender, { Records: [{ messageId: "wrong-group", body, attributes: { MessageGroupId: A } }] });
    expect(result.batchItemFailures).toStrictEqual([{ itemIdentifier: "wrong-group" }]);
    expect(storedRecords(r.h, A)).toStrictEqual([]);
    expect(storedRecords(r.h, B)).toStrictEqual([]);
    expect(r.h.db.get(`AUDIT#${A}`, "HEAD")).toBeUndefined();
    expect(r.h.db.get(`AUDIT#${B}`, `EVENT#${event.eventId}`)).toBeUndefined();
  });
});

// ---- Nothing lost (Review Focus 2) ----------------------------------------------------------------------------------------

describe("nothing lost (Review Focus 2)", () => {
  it("100 actions with 30 flushes that never run, 10 hung sends, an appender that dies after 3 transactions and an anchor that dies half way: all 100 are in the chains once and sealed within two epochs", async () => {
    vi.useFakeTimers();
    const r = rig();
    const orgs = [A, B, C, D, E, F];
    r.h.clock.now = at(0) - 10 * 60_000;
    for (let index = 0; index < 100; index += 1) {
      const orgId = orgs[index % orgs.length]!;
      // Three actions in ten die after their commit, one in ten has a queue that does not answer, six go through.
      if (index % 10 === 0 || index % 10 === 3 || index % 10 === 6) await r.act(orgId, { crash: true });
      else if (index % 10 === 8) await r.actWhileQueueHangs(orgId);
      else await r.act(orgId);
    }
    expect(r.committed).toHaveLength(100);
    expect(r.capture.flushed()).toHaveLength(60);
    expect(r.capture.pendingItems()).toHaveLength(40);
    expect(r.capture.logs.filter((entry) => entry.event === "audit.flush_deadline")).toHaveLength(10);

    // The 60 that were sent reach an appender that dies right after its third transaction.
    await r.deliver({ appender: appenderDyingAfter(r.appender, 3) });
    expect(r.logs.filter((entry) => entry.event === "audit.append_failed")).toStrictEqual([expect.objectContaining({ error: "ProcessDied" })]);
    // The third transaction committed and its handler died: the retry finds the claim, and that is the only duplicate.
    expect(countOf(r, "audit.appended")).toBe(59);
    expect(countOf(r, "audit.duplicate")).toBe(1);
    const heads = Object.fromEntries(orgs.map((orgId) => [orgId, storedRecords(r.h, orgId).length]));
    expect(Object.values(heads).reduce((total, count) => total + count, 0)).toBe(60);

    // The anchor dies after half of its per-org finalizes. At that point the minute's drain runs and the stragglers are appended: after the freeze.
    let finalizes = 0;
    let frozen: Record<string, number> = {};
    r.h.hooks.before = async (command) => {
      if (command.constructor.name !== "TransactWriteCommand") return;
      const items = command.input.TransactItems as Array<Record<string, { Item?: { pk?: string } }>>;
      if (!items.some((entry) => entry.Put?.Item?.pk?.startsWith("SEALED#") === true)) return;
      finalizes += 1;
      if (finalizes < orgs.length / 2 + 1) return;
      // The process is dead from here on: every later finalize dies too.
      if (finalizes === orgs.length / 2 + 1) {
        frozen = Object.fromEntries(orgs.map((orgId) => [orgId, storedRecords(r.h, orgId).length]));
        const drained = await drainAuditPending(r.capture.deps, r.h.clock.now + 60_000);
        expect(drained).toMatchObject({ examined: 40, sent: 40 });
        await r.deliver();
      }
      throw crash();
    };
    await expect(r.seal(0)).rejects.toThrow("the process died");
    r.h.hooks.before = undefined;
    expect(orgs.filter((orgId) => stateOf(r.h, orgId) !== undefined)).toHaveLength(orgs.length / 2);
    expect(r.capture.pendingItems()).toHaveLength(0);

    // The next run finishes the epoch the dead one opened (the 60 records it froze) and then seals the 40 that arrived after the freeze.
    const resumed = await run(r.h, at(1));
    expect(resumed.epochs).toStrictEqual([
      expect.objectContaining({ epochId: E0, status: "sealed", resumed: true, records: 60 }),
      expect.objectContaining({ epochId: E1, status: "sealed", resumed: false, records: 40 }),
    ]);
    // Two epochs after the actions (the dead run's and this one), and no third run: everything is sealed and no org is left marked.
    let total = 0;
    for (const orgId of orgs) {
      const records = expectWholeChain(r, orgId, idsOf(r.committed, orgId));
      total += records.length;
      expect(stateOf(r.h, orgId)!.sealedSeq as number, `${orgId} sealed at the freeze`).toBeGreaterThanOrEqual(frozen[orgId]!);
      expect(stateOf(r.h, orgId), orgId).toMatchObject({ sealedSeq: records.length });
      expect(markerOf(r, orgId), orgId).toBeUndefined();
    }
    expect(total).toBe(100);
    expect(r.h.db.refusals).toStrictEqual([]);
    // Each org's whole chain exports and verifies.
    for (const orgId of orgs) {
      const bundle = await buildAuditBundle(r.exportDeps, orgId, { fromSeq: 1, toSeq: 200_000, withDetails: false });
      expect(verifyBundle(bundle, { anchors: {} })).toMatchObject({ ok: true, unsealedCount: 0 });
    }
  }, 120_000);

  it("appends that race the anchor, run after run, are all sealed once two quiet epochs have run, and every export of the result verifies", async () => {
    const r = rig({ tsa: true });
    const orgs = [A, B, C];
    r.h.clock.now = at(0) - 3 * 60_000;
    const events: AuditEventInput[] = [];
    for (let slot = 0; slot < 4; slot += 1) {
      // Events keep arriving (hooked action, flush, appender) while the anchor of the slot runs.
      const arriving = (async () => {
        for (let n = 0; n < 12; n += 1) {
          events.push(await r.act(orgs[n % orgs.length]!));
          await r.deliver();
        }
      })();
      await Promise.all([arriving, (async () => { await run(r.h, at(slot)); })()]);
    }
    // Two quiet epochs seal whatever arrived last.
    await run(r.h, at(4));
    await run(r.h, at(5));
    expect(events).toHaveLength(48);
    for (const orgId of orgs) {
      const records = expectWholeChain(r, orgId, idsOf(events, orgId));
      expect(stateOf(r.h, orgId), orgId).toMatchObject({ sealedSeq: records.length });
      const bundle = await buildAuditBundle(r.exportDeps, orgId, { fromSeq: 1, toSeq: 200_000, withDetails: false });
      expect(verifyBundle(bundle, { anchors: r.exportDeps.anchors }), orgId).toMatchObject({ ok: true, unsealedCount: 0 });
    }
    expect(eventsOf(r.h, "audit.chain_mismatch")).toStrictEqual([]);
  });

  it("a poison message stops its batch: it and the messages after it are reported, and the later ones append once the poison one is out of the way", async () => {
    const r = rig();
    const first = await r.act(A);
    const second = await r.act(A);
    const bodies = r.capture.sqs.queue.map((message) => message.body);
    const records: SqsMessage[] = [
      { messageId: "ok-1", body: bodies[0]!, attributes: { MessageGroupId: A } },
      { messageId: "poison", body: "{not json", attributes: { MessageGroupId: A } },
      { messageId: "ok-2", body: bodies[1]!, attributes: { MessageGroupId: A } },
    ];
    const result = await processAuditBatch(r.appender, { Records: records });
    expect(result.batchItemFailures.map((entry) => entry.itemIdentifier)).toStrictEqual(["poison", "ok-2"]);
    expect(storedRecords(r.h, A).map((record) => record.eventId)).toStrictEqual([first.eventId]);
    // Once the poison message has gone to the dead-letter queue, the rest is delivered and appended in order.
    await processAuditBatch(r.appender, { Records: [records[2]!] });
    expectWholeChain(r, A, [first.eventId, second.eventId]);
  });
});

const markerOf = (r: Rig, orgId: string) => r.h.db.get("AUDIT_DIRTY", orgId);

// ---- Re-seal (Review Focus 1) ----------------------------------------------------------------------------------------------

/** The same history in any ledger: events with fixed times and no details, so that two ledgers hold identical records until one differs. */
async function buildHistory(r: Rig, orgId: string, count: number, from: number, options: { change?: number } = {}): Promise<void> {
  for (let n = from; n < from + count; n += 1) {
    r.h.clock.now = at(0) + n * 1000 - 120_000;
    const event = AuditEventInputSchema.parse(auditPullRequestOpened({
      orgId, actor: { kind: "member", id: "dev_1" }, occurredAt: iso(r.h.clock.now - 500), occurrence: `${orgId}-${String(n)}`, pullRequestId: `pr_${String(n)}`,
      number: n === options.change ? 9999 : n,
    }));
    await auditTransact({ audit: r.capture.audit, documentClient: r.h.deps.documentClient }, { Put: { TableName: STATE, Item: { pk: `ACTION#${orgId}`, sk: event.eventId, done: true } } }, [event]);
    await flushAuditEvents(r.capture.deps, [event]);
    await r.deliver();
  }
}

/** Rewrites records `from` to `to` with another fact and re-links them, as someone with table access could. */
function rewrite(r: Rig, orgId: string, from: number, to: number): void {
  let prevHash = storedRecords(r.h, orgId)[from - 2]?.hash ?? genesisHash(orgId);
  for (let seq = from; seq <= to; seq += 1) {
    const stored = r.h.db.get(`AUDIT#${orgId}`, `SEQ#${String(seq).padStart(12, "0")}`)!;
    const { pk, sk, sealedDetails, hash: _hash, ...rest } = stored;
    void _hash;
    const changed = { ...rest, facts: { number: 8888 }, prevHash };
    const hash = recordHash(changed as unknown as AuditRecordV1);
    r.h.db.set({ pk, sk, sealedDetails, ...changed, hash });
    prevHash = hash;
  }
  r.h.db.set({ pk: `AUDIT#${orgId}`, sk: "HEAD", seq: to, hash: prevHash, updatedAt: iso(r.h.clock.now) });
}

function exportedFile(r: Rig, orgId: string, exportId: string, name: string): string {
  const meta = r.h.db.get(`ORG#${orgId}#AUDIT_EXPORT#${exportId}`, "META")!;
  return r.writeFile(name, r.exportsBucket.objects.get(String(meta.objectKey))!);
}

async function exportOf(r: Rig, orgId: string, requestId: string, range: { fromSeq: number; toSeq: number; withDetails?: boolean }): Promise<string> {
  const { exportId } = await startAuditExport(r.exportDeps, { orgId: orgId, actor: { kind: "member", id: "dev_1" } }, { requestId, ...range });
  expect(await runAuditExport(r.exportDeps, { orgId, exportId })).toBe("ready");
  return exportId;
}

function cli(r: Rig, args: string[]): { code: number; out: string } {
  let out = "";
  const trust = Object.entries(r.pems).flatMap(([label, pem]) => ["--trust", `${label}=${r.writeFile(`${label}.pem`, Buffer.from(pem))}`]);
  const code = runCli([...args, ...trust], { stdout: (text) => { out += text; }, stderr: (text) => { out += text; } });
  return { code, out };
}

describe("a rewrite cannot be sealed again (Review Focus 1, C3)", () => {
  it("is caught by the anchor when the sealed state is wound back inside one seal, and nothing in the bucket changes", async () => {
    const r = rig();
    await buildHistory(r, A, 20, 1);
    await r.seal(0);
    const locked = snapshot(r.h);
    const realState = stateOf(r.h, A)!;
    rewrite(r, A, 10, 20);
    r.h.db.set({ ...realState, sealedSeq: 9 });
    r.h.db.set({ pk: "AUDIT_DIRTY", sk: A, since: 10, lastSeq: 20 });
    await r.seal(1);
    expect(eventsOf(r.h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A, reason: "locked_seal_end", level: "error" })]);
    const after = snapshot(r.h);
    for (const [key, versions] of Object.entries(locked)) expect(after[key], key).toStrictEqual(versions);
    expect(Object.keys(after).filter((key) => key.includes(`/${A}/`) || key.includes(A))).toStrictEqual(Object.keys(locked).filter((key) => key.includes(A)));
    expect(stateOf(r.h, A)).toMatchObject({ sealedSeq: 9 });
  });

  it("is caught by the seal key when the state is wound back truthfully to an earlier seal: a second seal at the same start is never written", async () => {
    const r = rig();
    await buildHistory(r, A, 9, 1);
    await r.seal(0);
    await buildHistory(r, A, 11, 10);
    await r.seal(1);
    const firstSeal = JSON.parse(r.h.s3.currentText(sealObjectKey(A, 1))!) as { fromSeq: number };
    expect(firstSeal.fromSeq).toBe(1);
    const sealOne = r.h.db.get(`SEALS#${A}`, "000000000001")!;
    const locked = snapshot(r.h);
    rewrite(r, A, 10, 20);
    r.h.db.set({
      pk: `SEALED#${A}`, sk: "STATE", sealedSeq: 9, lastFromSeq: 1, lastSealHash: sealHash(JSON.parse(r.h.s3.currentText(sealObjectKey(A, 1))!) as OrgSealV1), lastSealVersionId: (sealOne.objects as { seal: { versionId: string } }).seal.versionId,
      lastEpochId: E0, sealedAt: iso(at(0)),
    });
    r.h.db.set({ pk: "AUDIT_DIRTY", sk: A, since: 10, lastSeq: 20 });
    await r.seal(2);
    expect(eventsOf(r.h, "audit.version_drift")).toStrictEqual([expect.objectContaining({ orgId: A, key: sealObjectKey(A, 10), level: "error" })]);
    expect(r.h.s3.versionsOf(sealObjectKey(A, 10))).toHaveLength(1);
    expect(snapshot(r.h)[sealObjectKey(A, 10)]).toStrictEqual(locked[sealObjectKey(A, 10)]);
    expect(snapshot(r.h)[recordsObjectKey(A, 10)]).toStrictEqual(locked[recordsObjectKey(A, 10)]);
    expect(stateOf(r.h, A)).toMatchObject({ sealedSeq: 9 });
  });

  it("gets 412 with different bytes when a writer gets in between the anchor's check and its write: audit.object_conflict, and the run stops", async () => {
    const r = rig();
    await buildHistory(r, A, 4, 1);
    r.h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === sealObjectKey(A, 1)) r.h.s3.forceVersion(sealObjectKey(A, 1), '{"someone":"else"}');
    };
    r.h.clock.now = at(0);
    const result = await run(r.h, at(0));
    expect(result).toMatchObject({ status: "stopped", reason: "object_conflict" });
    expect(eventsOf(r.h, "audit.object_conflict")).toStrictEqual([expect.objectContaining({ key: sealObjectKey(A, 1), level: "error" })]);
    expect(stateOf(r.h, A)).toBeUndefined();
  });

  it("records rewritten in place after a seal cannot change what the seals say, and an export that reaches the rewritten records fails the CLI's chain check", async () => {
    const r = rig({ tsa: true });
    await buildHistory(r, A, 20, 1);
    await r.seal(0);
    await buildHistory(r, A, 3, 21);
    const file = (name: string, bundle: AuditBundleV1) => r.writeFile(name, Buffer.from(JSON.stringify(bundle)));
    const before = await buildAuditBundle(r.exportDeps, A, { fromSeq: 1, toSeq: 23, withDetails: false });
    expect(cli(r, [file("before.json", before)])).toMatchObject({ code: 0 });
    expect(before.unsealed.map((record) => record.seq)).toStrictEqual([21, 22, 23]);

    // The sealed records 10 to 20 are rewritten in the table, and so is the head. The export reads the locked copies of the sealed
    // range, so what it says of that range is what the seals say, and it still passes.
    rewrite(r, A, 10, 20);
    const sealedOnly = await buildAuditBundle(r.exportDeps, A, { fromSeq: 1, toSeq: 23, withDetails: false });
    expect(sealedOnly.records).toStrictEqual(before.records);
    expect(sealedOnly.seals).toStrictEqual(before.seals);
    expect(cli(r, [file("sealed-only.json", sealedOnly)])).toMatchObject({ code: 0 });

    // The rewrite reaches the unsealed records after the seal: the chain from the locked head to the first of them no longer links.
    rewrite(r, A, 20, 23);
    const reaching = await buildAuditBundle(r.exportDeps, A, { fromSeq: 1, toSeq: 23, withDetails: false });
    expect(reaching.records).toStrictEqual(before.records);
    const failed = cli(r, [file("reaching.json", reaching)]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("FAIL chain: record 21 fails the link check");
    // The sealed copies themselves are intact: the seal's head hash and batch root still match the locked records.
    expect(failed.out).toContain("ok   headHash:");
    expect(failed.out).toContain("ok   batchRoot:");
    // The export function does not hand such a bundle out either.
    const { exportId } = await startAuditExport(r.exportDeps, { orgId: A, actor: { kind: "member", id: "dev_1" } }, { requestId: "reaching", fromSeq: 1, toSeq: 23 });
    expect(await runAuditExport(r.exportDeps, { orgId: A, exportId })).toBe("failed");
    expect(r.exportsBucket.keysUnder(`${A}/`)).toStrictEqual([]);
  });

  it("is caught by --extends against an export taken before it: a ledger that re-sealed rewritten history passes its own checks and fails the comparison", async () => {
    // The genuine ledger, and the export an auditor kept.
    const genuine = rig({ tsa: true });
    await buildHistory(genuine, A, 9, 1);
    await genuine.seal(0);
    await buildHistory(genuine, A, 11, 10);
    await genuine.seal(1);
    const olderId = await exportOf(genuine, A, "older", { fromSeq: 1, toSeq: 20 });
    const older = exportedFile(genuine, A, olderId, "older.json.gz");
    expect(cli(genuine, [older])).toMatchObject({ code: 0 });

    // A ledger that stood up the same history with record 10 changed, sealed it in its own bucket, and exported it.
    const forged = rig({ tsa: true });
    await buildHistory(forged, A, 9, 1);
    await forged.seal(0);
    await buildHistory(forged, A, 11, 10, { change: 10 });
    await forged.seal(1);
    const forgedId = await exportOf(forged, A, "forged", { fromSeq: 1, toSeq: 20 });
    const rewritten = exportedFile(forged, A, forgedId, "rewritten.json.gz");
    // On its own it is a good export: nothing inside it is inconsistent.
    expect(cli(forged, [rewritten])).toMatchObject({ code: 0 });
    // Against what the auditor kept, it is not.
    const against = cli(genuine, [rewritten, "--extends", older]);
    expect(against.code).toBe(1);
    expect(against.out).toMatch(/FAIL extends: .*seq 20/);
    // The genuine ledger's own later export continues the kept one.
    await buildHistory(genuine, A, 3, 21);
    await genuine.seal(2);
    const laterId = await exportOf(genuine, A, "later", { fromSeq: 1, toSeq: 23 });
    const later = exportedFile(genuine, A, laterId, "later.json.gz");
    const continued = cli(genuine, [later, "--extends", older]);
    expect(continued.out).toContain("ok   extends:");
    expect(continued.code).toBe(0);
  }, 60_000);
});

// ---- Two anchors at once ---------------------------------------------------------------------------------------------------

describe("two anchors at once", () => {
  it("seals each org once when two runs overlap: no alarm, one version of every object, the state where the last seal put it", async () => {
    const r = rig();
    const orgs = [A, B, C];
    for (const orgId of orgs) await buildHistory(r, orgId, 4, 1);
    r.h.clock.now = at(0);
    const [first, second] = await Promise.all([run(r.h, at(0)), run(r.h, at(0) + 1000)]);
    expect([first.status, second.status]).toContain("sealed");
    for (const orgId of orgs) {
      expect(stateOf(r.h, orgId), orgId).toMatchObject({ sealedSeq: 4, lastEpochId: E0 });
      expect(r.h.s3.versionsOf(sealObjectKey(orgId, 1)), orgId).toHaveLength(1);
      expect(r.h.s3.versionsOf(recordsObjectKey(orgId, 1)), orgId).toHaveLength(1);
      expect(r.h.db.find((item) => item.pk === `SEALS#${orgId}`), orgId).toHaveLength(1);
    }
    expect(eventsOf(r.h, "audit.chain_mismatch")).toStrictEqual([]);
    expect(eventsOf(r.h, "audit.object_conflict")).toStrictEqual([]);
  });

  it("refuses a finalize whose org's sealed state another writer has just moved: the state is not overwritten, the org is blocked, nothing is indexed", async () => {
    const r = rig();
    await buildHistory(r, A, 4, 1);
    await r.seal(0);
    await buildHistory(r, A, 2, 5);
    let moved = false;
    r.h.hooks.before = async (command) => {
      if (command.constructor.name !== "TransactWriteCommand" || moved) return;
      const items = command.input.TransactItems as Array<Record<string, { Item?: { pk?: string } }>>;
      if (!items.some((entry) => entry.Put?.Item?.pk === `SEALED#${A}`)) return;
      moved = true;
      // The other anchor's write lands between this run's checks and its finalize.
      r.h.db.set({ ...stateOf(r.h, A)!, sealedSeq: 2 });
    };
    r.h.clock.now = at(1);
    await Promise.all([run(r.h, at(1)), run(r.h, at(1) + 1000)]);
    expect(moved).toBe(true);
    expect(eventsOf(r.h, "audit.chain_mismatch").every((entry) => entry.orgId === A && entry.reason === "finalize_refused")).toBe(true);
    expect(eventsOf(r.h, "audit.chain_mismatch").length).toBeGreaterThanOrEqual(1);
    expect(stateOf(r.h, A)).toMatchObject({ sealedSeq: 2 });
    expect(r.h.db.get(`SEALS#${A}`, "000000000005")).toBeUndefined();
    expect(r.h.db.get(`EPOCH#${E1}`, `ORG#${A}`)).toMatchObject({ blocked: "chain_mismatch", finalized: false });
  });
});

// ---- Cross-org (Review Focus 5) ---------------------------------------------------------------------------------------------

/** Org A has 12 records (6 sealed in epoch 0, 4 in epoch 1, 2 not yet) and org B has 3, all with sealed details, built through hooked actions and the appender. */
async function twoOrgs(): Promise<Rig> {
  const r = rig({ tsa: true });
  r.h.clock.now = at(0) - 60_000;
  for (let n = 0; n < 6; n += 1) await r.actDetailed(A);
  for (let n = 0; n < 3; n += 1) await r.actDetailed(B);
  await r.deliver();
  await r.seal(0);
  r.h.clock.now = at(1) - 60_000;
  for (let n = 0; n < 4; n += 1) await r.actDetailed(A);
  await r.deliver();
  await r.seal(1);
  r.h.clock.now = at(2) - 60_000;
  for (let n = 0; n < 2; n += 1) await r.actDetailed(A);
  await r.deliver();
  return r;
}

const url = (path: string): URL => new URL(path, "https://rovara.test");
const member = (orgId: string, orgRole: OrgRole, developerId = "dev_1"): AuditOrgCaller => ({ developerId, orgId, orgRole });
const orgCall = (r: Rig, caller: AuditOrgCaller, method: string, path: string, body?: unknown) =>
  routeAuditRequest(r.exportDeps, caller, { method, body: body ?? {}, requestId: r.requestId() }, url(path));
const ISSUER = "https://staff-idp.example.test";
const staffCaller: AuditAdminCaller = { issuer: ISSUER, subject: "staff-1", isAdministrator: true };

function eraseDepsOf(r: Rig): AuditEraseDeps {
  return {
    audit: r.capture.audit,
    documentClient: r.h.deps.documentClient,
    keysTable: KEYS,
    tableName: STATE,
    now: () => r.h.clock.now,
    log: (entry) => r.logs.push(entry),
    purgeExports: async (orgId) => { await purgeAuditExports({ s3: r.exportsBucket.client, exportsBucket: EXPORTS_BUCKET }, orgId); },
  };
}

async function staffCall(r: Rig, method: string, path: string, body?: unknown) {
  const reply = await routeAuditAdminRequest(
    { ledger: r.exportDeps, orgExists: async (orgId) => (await r.orgStore.getOrg(orgId)) !== undefined, erase: eraseDepsOf(r) },
    staffCaller,
    { method, body: body ?? {}, requestId: r.requestId() },
    url(path),
  );
  if (reply === undefined) throw new Error(`test setup: ${path} is not a staff audit path`);
  return reply;
}

const SESSION = "11111111-1111-4111-8111-111111111111";
const CSRF = "c".repeat(43);
const ORIGIN = "https://rovara.test";

function pageOf(r: Rig, who: AuditViewCaller) {
  const handle = createAuditViewPage({ origin: ORIGIN, authenticateSession: async (sessionId) => (sessionId === SESSION ? who : undefined), ledger: r.exportDeps });
  const call = (request: Omit<AdaptedHttpRequest, "requestId">): Promise<WebResponse> => handle({ requestId: r.requestId(), ...request }, new URL(request.path, ORIGIN));
  return {
    get: (path: string) => call({ method: "GET", path, headers: { cookie: `${SESSION_COOKIE}=${SESSION}` } }),
    post: (fields: Record<string, string>) => call({
      method: "POST", path: AUDIT_VIEW_EXPORT_PATH,
      headers: { cookie: `${SESSION_COOKIE}=${SESSION}; ${CSRF_COOKIE}=${CSRF}`, "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams({ csrf: CSRF, ...fields }).toString(),
    }),
  };
}

const LEDGER_TABLES = new Set([LEDGER, SEALS, KEYS]);

describe("cross-org reads (Review Focus 5)", () => {
  it("as B's admin, every org route and the page, given A's sequence numbers, cursors and export ids, answers B's data or 404, and never touches A", async () => {
    const r = await twoOrgs();
    // A's admin makes an export and a cursor; B's admin then tries to use both.
    const mine = await orgCall(r, member(A, "admin"), "POST", "/v1/app/org/audit/exports", { requestId: "shared-name", fromSeq: 1, toSeq: 12, withDetails: true });
    const aExport = (mine.body as { exportId: string }).exportId;
    expect(await runAuditExport(r.exportDeps, { orgId: A, exportId: aExport })).toBe("ready");
    const aCursor = ((await orgCall(r, member(A, "admin"), "GET", "/v1/app/org/audit/records?limit=2")).body as { nextCursor: string }).nextCursor;
    const aPage = pageOf(r, { developerId: "dev_1", orgId: A, orgRole: "admin" });
    const aPageCursor = /cursor=([A-Za-z0-9_-]+)/.exec((await aPage.get(`${AUDIT_VIEW_PATH}?limit=2`)).body)?.[1];
    expect(aPageCursor).toBeDefined();

    const opsMark = r.h.operations.length;
    const kmsMark = r.kms.calls.length;
    const queueMark = r.capture.sqs.queue.length;
    const presignMark = r.presigned.length;
    const admin = member(B, "admin");

    // Records, by A's range, A's cursor and A's filters: B's chain, whatever the numbers.
    for (const query of ["fromSeq=7&toSeq=12", `cursor=${aCursor}`, "fromSeq=11&toSeq=12&limit=200", "actorId=dev_2&fromSeq=1&toSeq=12", "limit=200"]) {
      const reply = await orgCall(r, admin, "GET", `/v1/app/org/audit/records?${query}`);
      const body = reply.body as { records: Array<{ record: { orgId: string; seq: number }; details: Array<{ fields?: Record<string, string> }> }>; headSeq: number };
      expect(body.headSeq, query).toBe(3);
      for (const entry of body.records) {
        expect(entry.record.orgId).toBe(B);
        expect(entry.record.seq).toBeLessThanOrEqual(3);
        expect(JSON.stringify(entry.details)).toContain(personName(B, "dev_1"));
      }
      expect(JSON.stringify(reply.body), query).not.toContain(A);
    }
    expect((await orgCall(r, admin, "GET", "/v1/app/org/audit/status")).body).toMatchObject({ headSeq: 3, sealedThroughSeq: 3 });

    // A's export, by id: 404 for status, link and the repeat of its request; B's request with A's request id is B's own export.
    await expect(orgCall(r, admin, "GET", `/v1/app/org/audit/exports/${aExport}`)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    const started = (await orgCall(r, admin, "POST", "/v1/app/org/audit/exports", { requestId: "shared-name", fromSeq: 1, toSeq: 12, withDetails: true })).body as { exportId: string };
    expect(started.exportId).not.toBe(aExport);
    expect(await runAuditExport(r.exportDeps, { orgId: B, exportId: started.exportId })).toBe("ready");
    const bBundle = (await orgCall(r, admin, "GET", `/v1/app/org/audit/exports/${started.exportId}`)).body as { status: string };
    expect(bBundle.status).toBe("ready");

    // The page: A's cursor and numbers, A's export id in the address, an export form with A's request id.
    const bPage = pageOf(r, { developerId: "dev_1", orgId: B, orgRole: "admin" });
    const withCursor = await bPage.get(`${AUDIT_VIEW_PATH}?limit=200&cursor=${aPageCursor!}`);
    expect(withCursor.statusCode).toBe(200);
    expect(withCursor.body).toContain(personName(B, "dev_1"));
    expect(withCursor.body).toContain("Showing 1 record.");
    const outOfRange = await bPage.get(`${AUDIT_VIEW_PATH}?fromSeq=7&toSeq=12`);
    expect(outOfRange.statusCode).toBe(200);
    expect(outOfRange.body).toContain("Showing 0 records");
    for (const page of [withCursor, outOfRange]) {
      expect(page.body).not.toContain(A);
      expect(page.body).not.toContain(personName(A, "dev_1"));
    }
    const aExportOnBPage = await bPage.get(`${AUDIT_VIEW_PATH}?export=${aExport}`);
    expect(aExportOnBPage.body).not.toContain(A);
    expect(aExportOnBPage.body).not.toMatch(/https:\/\/signed\.test/);
    const form = await bPage.post({ requestId: "page-shared", fromSeq: "1", toSeq: "12" });
    expect(form.statusCode).toBe(303);
    expect(form.headers.location).not.toContain(aExport);

    // What B's calls touched: no Query of A's records or seals, nothing at all under A's key, no decryption with A's context, no link signed for A's files.
    const touched = r.h.operations.slice(opsMark);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.filter((operation) => operation.action === "Query" && (operation.pk === `AUDIT#${A}` || operation.pk === `SEALS#${A}`))).toStrictEqual([]);
    expect(touched.filter((operation) => operation.pk.includes(A)), "no operation under A's keys").toStrictEqual([]);
    expect(touched.filter((operation) => LEDGER_TABLES.has(operation.table)).length).toBeGreaterThan(0);
    const decrypts = r.kms.calls.slice(kmsMark).filter((call) => call.operation === "Decrypt");
    expect(decrypts.length).toBeGreaterThan(0);
    expect(decrypts.filter((call) => call.context["rovara:org"] === A)).toStrictEqual([]);
    expect(r.presigned.slice(presignMark).every((input) => input.key.startsWith(`${B}/`))).toBe(true);
    // Every read B made is recorded in B's log, and in no other.
    const recorded = r.capture.sqs.queue.slice(queueMark).map((message) => JSON.parse(message.body) as AuditEventInput);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((event) => event.orgId === B)).toBe(true);
    expect(recorded.map((event) => event.action)).toContain("audit.read");
  });

  it("answers a member of B's org the same 403 as A's for every route, and reads nothing", async () => {
    const r = await twoOrgs();
    const opsMark = r.h.operations.length;
    for (const [method, path] of [["GET", "/v1/app/org/audit/records"], ["GET", "/v1/app/org/audit/status"], ["POST", "/v1/app/org/audit/exports"]] as const) {
      await expect(orgCall(r, member(B, "member"), method, path, { requestId: "x", fromSeq: 1, toSeq: 2 })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    }
    expect(r.h.operations.length).toBe(opsMark);
    expect((await pageOf(r, { developerId: "dev_1", orgId: B, orgRole: "member" }).get(AUDIT_VIEW_PATH)).statusCode).toBe(403);
    expect(r.h.operations.length).toBe(opsMark);
  });

  it("keeps staff reads to the org in the path: B's records, A's export id is 404 under B, and the staff record lands in B's log only", async () => {
    const r = await twoOrgs();
    const aStart = (await staffCall(r, "POST", `/v1/admin/audit/${A}/exports`, { requestId: "staff-a", fromSeq: 1, toSeq: 12, reason: "A's ticket" })).body as { exportId: string };
    const queueMark = r.capture.sqs.queue.length;
    const opsMark = r.h.operations.length;
    const kmsMark = r.kms.calls.length;
    const why = "reason=Customer%20ticket&ticket=SUP-9";
    const read = await staffCall(r, "GET", `/v1/admin/audit/${B}/records?fromSeq=7&toSeq=12&${why}`);
    expect((read.body as { headSeq: number }).headSeq).toBe(3);
    expect(JSON.stringify(read.body)).not.toContain(A);
    await expect(staffCall(r, "GET", `/v1/admin/audit/${B}/exports/${aStart.exportId}?${why}`)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const own = (await staffCall(r, "POST", `/v1/admin/audit/${B}/exports`, { requestId: "staff-a", fromSeq: 1, toSeq: 3, reason: "B's ticket" })).body as { exportId: string };
    expect(own.exportId).not.toBe(aStart.exportId);
    expect(r.h.operations.slice(opsMark).filter((operation) => operation.pk.includes(A))).toStrictEqual([]);
    expect(r.kms.calls.slice(kmsMark).filter((call) => call.context["rovara:org"] === A)).toStrictEqual([]);
    const recorded = r.capture.sqs.queue.slice(queueMark).map((message) => JSON.parse(message.body) as AuditEventInput);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((event) => event.orgId === B)).toBe(true);
    expect(recorded.every((event) => event.actor.kind === "operator" && event.actor.id === auditOperatorId(ISSUER, "staff-1"))).toBe(true);
  });

  it("the export function given one org's id with another org's export id builds nothing, writes nothing and records nothing", async () => {
    const r = await twoOrgs();
    const owner = (orgId: string) => ({ orgId: orgId as never, actor: { kind: "member" as const, id: "dev_1" } });
    const aExport = (await startAuditExport(r.exportDeps, owner(A), { requestId: "pair", fromSeq: 1, toSeq: 12, withDetails: true })).exportId;
    const bExport = (await startAuditExport(r.exportDeps, owner(B), { requestId: "pair", fromSeq: 1, toSeq: 3, withDetails: true })).exportId;
    const itemsBefore = JSON.stringify(r.h.db.find((item) => String(item.pk).includes("#AUDIT_EXPORT#")));
    const queueMark = r.capture.sqs.queue.length;
    const opsMark = r.h.operations.length;
    const kmsMark = r.kms.calls.length;
    expect(await runAuditExport(r.exportDeps, { orgId: B, exportId: aExport })).toBe("unknown");
    expect(await runAuditExport(r.exportDeps, { orgId: A, exportId: bExport })).toBe("unknown");
    expect(r.exportsBucket.objects.size).toBe(0);
    expect(JSON.stringify(r.h.db.find((item) => String(item.pk).includes("#AUDIT_EXPORT#")))).toBe(itemsBefore);
    expect(r.capture.sqs.queue.length).toBe(queueMark);
    // Nothing of the ledger was read or decrypted for either call.
    expect(r.h.operations.slice(opsMark).filter((operation) => LEDGER_TABLES.has(operation.table))).toStrictEqual([]);
    expect(r.kms.calls.length).toBe(kmsMark);
    expect(r.logs.filter((entry) => entry.event === "audit.export_unknown")).toHaveLength(2);
    // The right pairs still build, each from its own org.
    expect(await runAuditExport(r.exportDeps, { orgId: A, exportId: aExport })).toBe("ready");
    expect(await runAuditExport(r.exportDeps, { orgId: B, exportId: bExport })).toBe("ready");
    expect(r.exportsBucket.keysUnder(`${A}/`)).toHaveLength(1);
    expect(r.exportsBucket.keysUnder(`${B}/`)).toHaveLength(1);
  });

  it("an event that arrives for a shredded org is still chained, with no key made again and its names unreadable", async () => {
    const r = await twoOrgs();
    r.h.db.set({ pk: `ORG#${A}`, sk: "SHREDDED", at: iso(at(3)) });
    for (const item of r.h.db.find((entry) => entry.pk === `ORG#${A}` && entry.sk !== "SHREDDED")) r.h.db.delete(item.pk as string, item.sk as string);
    const late = await r.actDetailed(A);
    await r.deliver();
    const records = storedRecords(r.h, A);
    expect(records).toHaveLength(13);
    expect(records.at(-1)!.eventId).toBe(late.eventId);
    expect(checkChain(records, { seq: 0, hash: genesisHash(A), orgId: A })).toStrictEqual({ ok: true });
    expect(r.h.db.find((entry) => entry.pk === `ORG#${A}`).map((entry) => entry.sk)).toStrictEqual(["SHREDDED"]);
    expect(JSON.stringify(await readAuditRecords(r.readDeps, A, {}))).not.toContain(personName(A, "dev_1"));
    // B is untouched by all of it.
    expect(JSON.stringify(await readAuditRecords(r.readDeps, B, {}))).toContain(personName(B, "dev_1"));
  });

  it("refuses a staff read with no reason, and one the audit intake cannot record, before reading anything", async () => {
    const r = await twoOrgs();
    const mark = r.h.operations.length;
    const queueMark = r.capture.sqs.queue.length;
    await expect(staffCall(r, "GET", `/v1/admin/audit/${B}/records`)).rejects.toMatchObject({ code: "AUDIT_REASON_REQUIRED" });
    // The record of the read cannot be made durable: the answer is 503 and the ledger is not touched.
    r.h.db.injectFault({ command: "PutCommand", match: (input) => String((input.Item as { pk?: string } | undefined)?.pk).startsWith("AUDIT_PENDING#"), error: { name: "ServiceUnavailable" }, times: 3 });
    const why = "reason=Customer%20ticket";
    await expect(staffCall(r, "GET", `/v1/admin/audit/${B}/records?${why}`)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503 });
    await expect(staffCall(r, "GET", `/v1/admin/audit/${B}/exports/${"aex_" + "0".repeat(32)}?${why}`)).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503 });
    await expect(staffCall(r, "POST", `/v1/admin/audit/${B}/exports`, { requestId: "closed", fromSeq: 1, toSeq: 3, reason: "x" })).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE", statusCode: 503 });
    // The only look at the ledger's tables is whether the org is shredded (a refusal asked before the staff record is made); no record, seal or key is read.
    const looked = r.h.operations.slice(mark).filter((operation) => LEDGER_TABLES.has(operation.table));
    expect(looked.filter((operation) => !(operation.table === KEYS && operation.action === "GetItem" && operation.pk === `ORG#${B}` && operation.sk === "SHREDDED"))).toStrictEqual([]);
    expect(r.capture.sqs.queue.length).toBe(queueMark);
    expect(r.invocations).toStrictEqual([]);
    expect(r.h.db.find((item) => String(item.pk).includes("#AUDIT_EXPORT#"))).toStrictEqual([]);
  });

  it("holds when A's person is erased and then A is shredded: B keeps its names, its keys, its exports and its reads", async () => {
    const r = await twoOrgs();
    // The same developer id in both orgs: erasing dev_1 in A is not erasing dev_1 in B.
    await exportOf(r, A, "a-before", { fromSeq: 1, toSeq: 12, withDetails: true });
    await exportOf(r, B, "b-before", { fromSeq: 1, toSeq: 3, withDetails: true });
    expect(r.exportsBucket.keysUnder(`${A}/`)).toHaveLength(1);
    expect(r.exportsBucket.keysUnder(`${B}/`)).toHaveLength(1);
    const erased = await staffCall(r, "POST", `/v1/admin/audit/${A}/erase-subject`, { requestId: "erase-1", developerId: "dev_1", reason: "asked to be forgotten" });
    expect(erased.status).toBe(200);
    expect(r.exportsBucket.keysUnder(`${A}/`)).toHaveLength(0);
    expect(r.exportsBucket.keysUnder(`${B}/`)).toHaveLength(1);
    const aRecords = await readAuditRecords(r.readDeps, A, {});
    expect(JSON.stringify(aRecords)).not.toContain(personName(A, "dev_1"));
    expect(JSON.stringify(aRecords)).toContain(personName(A, "dev_2"));
    expect(JSON.stringify(await readAuditRecords(r.readDeps, B, {}))).toContain(personName(B, "dev_1"));

    // The company A closes and its details are shredded.
    r.h.db.set({ pk: `ORG#${A}`, sk: "SHREDDED", at: iso(at(3)) });
    const aAfter = await readAuditRecords(r.readDeps, A, {});
    expect(JSON.stringify(aAfter)).not.toContain(personName(A, "dev_2"));
    await expect(staffCall(r, "POST", `/v1/admin/audit/${A}/exports`, { requestId: "late", fromSeq: 1, toSeq: 3, reason: "too late" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(orgCall(r, member(A, "admin"), "POST", "/v1/app/org/audit/exports", { requestId: "late-2", fromSeq: 1, toSeq: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });

    // B is as it was: details open, a new export builds, verifies, and holds nothing of A.
    const kmsMark = r.kms.calls.length;
    const bRecords = await readAuditRecords(r.readDeps, B, {});
    expect(JSON.stringify(bRecords)).toContain(personName(B, "dev_1"));
    expect(JSON.stringify(bRecords)).toContain(personName(B, "dev_2"));
    const bundle = await buildAuditBundle(r.exportDeps, B, { fromSeq: 1, toSeq: 3, withDetails: true });
    expect(JSON.stringify(bundle)).not.toContain(A);
    expect(verifyBundle(bundle, { anchors: r.exportDeps.anchors })).toMatchObject({ ok: true });
    expect(bundle.details!.every((part) => !("erased" in part))).toBe(true);
    expect(r.kms.calls.slice(kmsMark).filter((call) => call.context["rovara:org"] === A)).toStrictEqual([]);
    // The audit log of A still verifies without its details.
    const aBundle = await buildAuditBundle(r.exportDeps, A, { fromSeq: 1, toSeq: 12, withDetails: true });
    expect(aBundle.details!.every((part) => "erased" in part)).toBe(true);
    expect(verifyBundle(aBundle, { anchors: r.exportDeps.anchors })).toMatchObject({ ok: true });
    // The people erased in A are still B's people.
    expect(r.h.db.get(`ORG#${B}`, "SUBJECT#dev_1")).not.toHaveProperty("erasedAt");
    expect(r.h.db.get(`ORG#${A}`, "SUBJECT#dev_1")).toHaveProperty("erasedAt");
  });
});

// ---- Round trip ---------------------------------------------------------------------------------------------------------------

describe("round trip: every org's export verifies with the CLI", () => {
  it("5 orgs through hooked actions, the flush, the appender, the anchor with timestamps and the export function, then the standalone verifier", async () => {
    const r = rig({ tsa: true });
    const orgs = [A, B, C, D, E];
    r.h.clock.now = at(0) - 5 * 60_000;
    for (const orgId of orgs) for (let n = 0; n < 7; n += 1) await r.actDetailed(orgId);
    await r.deliver();
    await r.seal(0);
    r.h.clock.now = at(1) - 5 * 60_000;
    for (const orgId of orgs) for (let n = 0; n < 3; n += 1) await r.act(orgId);
    await r.deliver();
    await r.seal(1);
    r.h.clock.now = at(2) - 5 * 60_000;
    for (const orgId of orgs) await r.actDetailed(orgId);
    await r.deliver();
    expect(r.capture.pendingItems()).toHaveLength(0);

    const older = new Map<string, string>();
    for (const orgId of orgs) {
      const head = storedRecords(r.h, orgId).length;
      expect(head).toBe(11);
      const exportId = await exportOf(r, orgId, `trip-${orgId}`, { fromSeq: 1, toSeq: head, withDetails: true });
      const file = exportedFile(r, orgId, exportId, `${orgId}.json.gz`);
      older.set(orgId, file);
      const result = cli(r, [file]);
      expect(result.code, `${orgId}\n${result.out}`).toBe(0);
      expect(result.out).toContain("Sealed and checked through record 10.");
      expect(result.out).toContain("1 newer records are not sealed yet.");
      expect(result.out).toContain("Independent time: no later than");
      expect(result.out).toContain(`${String(7 * 2 + 1 * 2)} details match their commitments`);
      for (const other of orgs.filter((id) => id !== orgId)) expect(r.exportsBucket.objects.get(String(r.h.db.get(`ORG#${orgId}#AUDIT_EXPORT#${exportId}`, "META")!.objectKey))!.toString("latin1")).not.toContain(other);
    }

    // Everything is sealed one epoch later, and each org's later export continues the earlier one.
    r.h.clock.now = at(3) - 5 * 60_000;
    await r.seal(3);
    for (const orgId of orgs) {
      const head = storedRecords(r.h, orgId).length;
      const exportId = await exportOf(r, orgId, `trip2-${orgId}`, { fromSeq: 1, toSeq: head + 5 });
      const file = exportedFile(r, orgId, exportId, `${orgId}-later.json.gz`);
      const result = cli(r, [file, "--extends", older.get(orgId)!]);
      expect(result.code, `${orgId}\n${result.out}`).toBe(0);
      expect(result.out).toContain("ok   extends:");
    }
    expect(r.h.db.refusals).toStrictEqual([]);
    const status = await readAuditStatus(r.readDeps, A);
    expect(status.epochsWithoutTimestamp).toStrictEqual([]);
  }, 120_000);
});
