// The sealed audit log's appender and sealer (lane AL-1), on the in-memory DynamoDB and test doubles for the two ports that are not built (AL-2 storage, AL-3 timestamps).
// What it shows: the chain links and survives restarts and races, a changed stored record is never sealed, a seal is cut every five minutes, and the seals and
// statements it writes pass the existing offline verifier (which fails when anything is changed).
import { describe, expect, it } from "vitest";
import { auditRecordDigestV1 } from "@agentx/contracts/audit-record-v1";
import { AUDIT_SEAL_INTERVAL_MINUTES } from "../../packages/contracts/src/audit.js";
import { checkChain, genesisHash } from "../../packages/audit-verifier/src/index.js";
import { CLOUD_AUDIT_ACTIONS } from "../../packages/cloud-server/src/audit-log.js";
import { SealProgressV1Schema, EpochProgressV1Schema, mapCloudAuditV1, pendingAuditV1 } from "../../packages/cloud-server/src/audit-contracts-v1.js";
import { AuditAppendContended, AuditAppendRefused, AuditAppender } from "../../packages/cloud-server/src/audit-appender.js";
import { AuditLedgerCorrupt, DynamoAuditLedgerStore, chainRecordKey } from "../../packages/cloud-server/src/audit-ledger-store.js";
import { AuditSealer, closedAtOfEpoch, epochIdOf, lastBoundary } from "../../packages/cloud-server/src/audit-sealer.js";
import { AuditSealingNotConfigured, unconfiguredLockedStorage, unconfiguredTimestampSource } from "../../packages/cloud-server/src/audit-sealing-ports.js";
import { LockedStorageDouble, TimestampDouble, assembleBundle, doubleAnchors, verifyBundle } from "../support/audit-sealing-doubles.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const CONTEXT = { installId: "install1", salt: Uint8Array.from({ length: 16 }, (_, i) => i + 1) };
const T0 = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const minutes = (n: number) => n * 60_000;

function pending(company: string, n: number, detail?: string) {
  const mapped = mapCloudAuditV1({
    id: `aud_${String(n).padStart(20, "0")}`, companyId: company, at: iso(T0), actor: { type: "person", developerId: "dev1", name: "Ada" },
    action: CLOUD_AUDIT_ACTIONS[1], subject: "", outcome: "ok", ...(detail === undefined ? {} : { detail }),
  }, CONTEXT);
  return pendingAuditV1(mapped, iso(T0));
}

function rig(options: { maxRecordsPerSeal?: number } = {}) {
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const db = new FakeDynamoDb();
  const store = new DynamoAuditLedgerStore(db, "t");
  const storage = new LockedStorageDouble(now);
  const tsa = new TimestampDouble();
  const appender = new AuditAppender(store, { now });
  const sealer = new AuditSealer(store, storage, tsa, { now, ...options });
  return { clock, now, db, store, storage, tsa, appender, sealer, epochs: [] as string[] };
}
type Rig = ReturnType<typeof rig>;
const at = (r: Rig, text: string) => { r.clock.ms = Date.parse(text); };
async function tick(r: Rig, sealer = r.sealer) {
  const report = await sealer.tick();
  if (!r.epochs.includes(report.epochId)) r.epochs.push(report.epochId);
  return report;
}

describe("appender: the hash chain", () => {
  it("links each record to the one before, from the company's genesis, in the format the verifier recomputes", async () => {
    const r = rig();
    for (let n = 1; n <= 5; n += 1) {
      r.clock.ms += 1000;
      const result = await r.appender.append(pending(A, n));
      expect(result.outcome).toBe("appended");
    }
    const records = await r.store.readRecords(A, 1, 100);
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(records[0]?.prevHash).toBe(genesisHash(A));
    for (let i = 1; i < records.length; i += 1) expect(records[i]?.prevHash).toBe(records[i - 1]?.hash);
    // The verifier's own walk, not this repo's.
    expect(checkChain(records, { seq: 0, hash: genesisHash(A), orgId: A })).toEqual({ ok: true });
    expect(records.every((record) => auditRecordDigestV1(record) === record.hash)).toBe(true);
    expect(await r.store.getHead(A)).toMatchObject({ seq: 5, hash: records[4]?.hash });
  });

  it("keeps each company's chain apart", async () => {
    const r = rig();
    await r.appender.append(pending(A, 1));
    await r.appender.append(pending(B, 2));
    const b = await r.store.readRecords(B, 1, 10);
    expect(b).toHaveLength(1);
    expect(b[0]?.prevHash).toBe(genesisHash(B));
    expect((await r.store.listCompanies()).sort()).toEqual([A, B]);
  });

  it("appends one event once: the same item again is already appended, other facts under the same identity are refused", async () => {
    const r = rig();
    const first = await r.appender.append(pending(A, 1));
    const again = await r.appender.append(pending(A, 1));
    expect(first.outcome).toBe("appended");
    expect(again.outcome).toBe("already-appended");
    expect(again.receipt).toEqual(first.receipt);
    await expect(r.appender.append(pending(A, 1, "changed"))).rejects.toThrow(AuditAppendRefused);
    expect(await r.store.readRecords(A, 1, 10)).toHaveLength(1);
  });

  it("never lets recordedAt go backwards, even when the clock does", async () => {
    const r = rig();
    r.clock.ms = T0 + minutes(10);
    await r.appender.append(pending(A, 1));
    r.clock.ms = T0;
    await r.appender.append(pending(A, 2));
    const [one, two] = await r.store.readRecords(A, 1, 2);
    expect(Date.parse(two?.recordedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(one?.recordedAt ?? ""));
    expect(two?.recordedAt).toBe(one?.recordedAt);
  });

  it("continues the chain from the stored head after a restart (a new appender, nothing remembered)", async () => {
    const r = rig();
    for (let n = 1; n <= 3; n += 1) await r.appender.append(pending(A, n));
    const restarted = new AuditAppender(new DynamoAuditLedgerStore(r.db, "t"), { now: r.now });
    const result = await restarted.append(pending(A, 4));
    expect(result.outcome === "appended" && result.record.seq).toBe(4);
    const records = await r.store.readRecords(A, 1, 10);
    expect(checkChain(records, { seq: 0, hash: genesisHash(A), orgId: A })).toEqual({ ok: true });
  });

  it("refuses a pending item that is not valid, writing nothing", async () => {
    const r = rig();
    await expect(r.appender.append({ ...pending(A, 1), factsDigest: "0".repeat(64) })).rejects.toThrow();
    expect(await r.store.getHead(A)).toBeUndefined();
  });
});

describe("appender: two writers racing do not fork the chain", () => {
  class GatedStore extends DynamoAuditLedgerStore {
    commits = 0;
    private seen = 0;
    private release: () => void = () => undefined;
    private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
    constructor(db: FakeDynamoDb, private readonly waitFor: number) { super(db, "t"); }
    override async getHead(companyId: string) {
      const head = await super.getHead(companyId);
      this.seen += 1;
      if (this.seen === this.waitFor) this.release();
      await this.gate;
      return head;
    }
    override async commitAppend(input: Parameters<DynamoAuditLedgerStore["commitAppend"]>[0]) {
      this.commits += 1;
      return super.commitAppend(input);
    }
  }

  it("two appenders that read the same head: one commits, the other re-reads and takes the next place", async () => {
    const db = new FakeDynamoDb();
    const store = new GatedStore(db, 2);
    const one = new AuditAppender(store, { now: () => new Date(T0) });
    const two = new AuditAppender(store, { now: () => new Date(T0) });
    const results = await Promise.all([one.append(pending(A, 1)), two.append(pending(A, 2))]);
    expect(results.map((result) => result.outcome)).toEqual(["appended", "appended"]);
    expect(store.commits).toBe(3); // the loser tried twice
    const records = await store.readRecords(A, 1, 10);
    expect(records.map((record) => record.seq)).toEqual([1, 2]);
    expect(checkChain(records, { seq: 0, hash: genesisHash(A), orgId: A })).toEqual({ ok: true });
  });

  it("two appenders given the same event: one record", async () => {
    const db = new FakeDynamoDb();
    const store = new GatedStore(db, 2);
    const one = new AuditAppender(store, { now: () => new Date(T0) });
    const two = new AuditAppender(store, { now: () => new Date(T0) });
    const results = await Promise.all([one.append(pending(A, 1)), two.append(pending(A, 1))]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["already-appended", "appended"]);
    expect(await store.readRecords(A, 1, 10)).toHaveLength(1);
  });

  it("an appender that checked for the event, then lost the race and reads a newer head, still writes the event once", async () => {
    const db = new FakeDynamoDb();
    class Late extends DynamoAuditLedgerStore {
      private first = true;
      release: () => void = () => undefined;
      private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
      override async getHead(companyId: string) {
        if (this.first) { this.first = false; await this.gate; }
        return super.getHead(companyId);
      }
    }
    const late = new Late(db, "t");
    const slow = new AuditAppender(late, { now: () => new Date(T0) });
    const quick = new AuditAppender(new DynamoAuditLedgerStore(db, "t"), { now: () => new Date(T0) });
    const waiting = slow.append(pending(A, 1)); // has found no receipt, now waits to read the head
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await quick.append(pending(A, 1))).outcome).toBe("appended");
    late.release();
    expect((await waiting).outcome).toBe("already-appended");
    expect(await late.readRecords(A, 1, 10)).toHaveLength(1);
  });

  it("ten appenders at once give ten records on one unbroken chain", async () => {
    const db = new FakeDynamoDb();
    const store = new DynamoAuditLedgerStore(db, "t");
    const appenders = Array.from({ length: 10 }, () => new AuditAppender(store, { now: () => new Date(T0), maxAttempts: 50 }));
    await Promise.all(appenders.map((appender, i) => appender.append(pending(A, i + 1))));
    const records = await store.readRecords(A, 1, 100);
    expect(records).toHaveLength(10);
    expect(checkChain(records, { seq: 0, hash: genesisHash(A), orgId: A })).toEqual({ ok: true });
  });

  it("gives up with a plain error, writing nothing, when the head keeps moving", async () => {
    const db = new FakeDynamoDb();
    const store = new DynamoAuditLedgerStore(db, "t");
    const stuck = { getReceipt: store.getReceipt.bind(store), getHead: store.getHead.bind(store), readRecords: store.readRecords.bind(store), commitAppend: () => Promise.resolve("head-moved" as const) };
    await expect(new AuditAppender(stuck, { maxAttempts: 3 }).append(pending(A, 1))).rejects.toThrow(AuditAppendContended);
  });

  it("the store refuses a second record at the same place and a head that is not the one read", async () => {
    const db = new FakeDynamoDb();
    const store = new DynamoAuditLedgerStore(db, "t");
    await new AuditAppender(store, { now: () => new Date(T0) }).append(pending(A, 1));
    const head = await store.getHead(A);
    const next = await new AuditAppender(new DynamoAuditLedgerStore(new FakeDynamoDb(), "t"), { now: () => new Date(T0) }).append(pending(A, 2));
    if (next.outcome !== "appended") throw new Error("setup");
    // A record that would sit at seq 1 again (it was built on genesis), with the receipt of a new event.
    const [first] = await store.readRecords(A, 1, 1);
    const forged = { record: { ...next.record, seq: 2, prevHash: first?.hash ?? "" }, receipt: next.receipt };
    expect(await store.commitAppend({ ...forged, expectedHead: { ...(head as NonNullable<typeof head>), hash: "f".repeat(64) } })).toBe("head-moved");
    expect(await store.commitAppend({ record: { ...next.record, seq: 1 }, receipt: next.receipt, expectedHead: undefined })).toBe("head-moved");
    expect((await store.readRecords(A, 1, 10)).map((record) => record.seq)).toEqual([1]);
  });
});

describe("sealer: cadence", () => {
  it("seals every five minutes: each epoch holds the records up to its boundary and no later one", async () => {
    expect(AUDIT_SEAL_INTERVAL_MINUTES).toBe(5);
    const r = rig();
    at(r, "2026-11-25T11:58:00Z"); await r.appender.append(pending(A, 1));
    at(r, "2026-11-25T11:59:00Z"); await r.appender.append(pending(A, 2));
    at(r, "2026-11-25T12:02:00Z"); await r.appender.append(pending(A, 3));
    at(r, "2026-11-25T12:06:00Z"); await r.appender.append(pending(A, 4));

    at(r, "2026-11-25T12:06:30Z");
    const first = await tick(r);
    expect(first.epochId).toBe("e20261125T1205Z");
    expect(first.planned).toEqual([{ companyId: A, fromSeq: 1, toSeq: 3 }]); // the 12:06 record is after the 12:05 boundary

    at(r, "2026-11-25T12:08:00Z");
    expect((await tick(r)).planned).toEqual([]); // same epoch: nothing more joins it

    at(r, "2026-11-25T12:10:30Z");
    const second = await tick(r);
    expect(second.epochId).toBe("e20261125T1210Z");
    expect(second.planned).toEqual([{ companyId: A, fromSeq: 4, toSeq: 4 }]);

    at(r, "2026-11-25T12:11:00Z"); await r.appender.append(pending(A, 5));
    at(r, "2026-11-25T12:12:00Z");
    expect((await tick(r)).planned).toEqual([]);
    at(r, "2026-11-25T12:15:01Z");
    expect((await tick(r)).planned).toEqual([{ companyId: A, fromSeq: 5, toSeq: 5 }]);

    expect(r.epochs).toEqual(["e20261125T1205Z", "e20261125T1210Z", "e20261125T1215Z"]);
    expect(closedAtOfEpoch("e20261125T1215Z").getTime() - closedAtOfEpoch("e20261125T1210Z").getTime()).toBe(minutes(5));
  });

  it("names epochs by the boundary they close at and reads them back", () => {
    const boundary = lastBoundary(new Date("2026-11-25T23:58:59.999Z"), 5);
    expect(boundary.toISOString()).toBe("2026-11-25T23:55:00.000Z");
    expect(epochIdOf(boundary)).toBe("e20261125T2355Z");
    expect(closedAtOfEpoch("e20261125T2355Z").toISOString()).toBe("2026-11-25T23:55:00.000Z");
    expect(() => closedAtOfEpoch("20261125")).toThrow();
  });

  it("seals nothing when there is nothing new, and a late tick does not plan into an epoch that is already passed", async () => {
    const r = rig();
    at(r, "2026-11-25T12:02:00Z"); await r.appender.append(pending(A, 1));
    at(r, "2026-11-25T12:04:00Z");
    expect((await tick(r)).planned).toEqual([]); // boundary 12:00: the record is later
    at(r, "2026-11-25T12:10:30Z");
    expect((await tick(r)).planned).toHaveLength(1);
    // A record committed late by a server whose clock is behind: its time is before the 12:05 boundary, but the 12:10 epoch is already planned.
    at(r, "2026-11-25T12:03:00Z"); await r.appender.append(pending(A, 2));
    const stale = new AuditSealer(r.store, r.storage, r.tsa, { now: () => new Date(Date.parse("2026-11-25T12:06:00Z")) });
    expect((await tick(r, stale)).planned).toEqual([]);
    expect(await r.store.getEpochSeal("e20261125T1205Z", A)).toBeUndefined();
  });

  it("cuts a long backlog into seals of at most the cap, one per epoch", async () => {
    const r = rig({ maxRecordsPerSeal: 2 });
    for (let n = 1; n <= 5; n += 1) await r.appender.append(pending(A, n));
    const ranges: Array<[number, number]> = [];
    for (const time of ["12:05:30", "12:10:30", "12:15:30"]) {
      at(r, `2026-11-25T${time}Z`);
      const report = await tick(r);
      for (const planned of report.planned) ranges.push([planned.fromSeq, planned.toSeq]);
    }
    expect(ranges).toEqual([[1, 2], [3, 4], [5, 5]]);
  });
});

async function seed(r: Rig) {
  for (let n = 1; n <= 3; n += 1) { r.clock.ms = T0 + n * 1000; await r.appender.append(pending(A, n)); }
  for (let n = 4; n <= 5; n += 1) { r.clock.ms = T0 + n * 1000; await r.appender.append(pending(B, n)); }
}

describe("sealer: what the offline verifier accepts", () => {
  it("passes the verifier across several epochs and two companies, with the epoch statements chained", async () => {
    const r = rig();
    await seed(r);
    at(r, "2026-11-25T12:05:10Z");
    const first = await tick(r);
    expect(first.blocked).toEqual([]);
    expect(first.completedEpochs).toEqual(["e20261125T1205Z"]);
    at(r, "2026-11-25T12:07:00Z"); await r.appender.append(pending(A, 6)); await r.appender.append(pending(B, 7));
    at(r, "2026-11-25T12:10:10Z"); await tick(r);
    at(r, "2026-11-25T12:11:00Z"); await r.appender.append(pending(A, 8));
    at(r, "2026-11-25T12:15:10Z"); await tick(r);

    const bundle = await assembleBundle({ store: r.store, storage: r.storage, companyId: A, epochIds: r.epochs });
    const report = verifyBundle(bundle, { anchors: doubleAnchors() });
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sealedThroughSeq).toBe(5);
    expect(report.unsealedCount).toBe(0);
    expect(report.epochsWithoutTimestamp).toEqual([]);
    expect(report.timestampedThrough).toBeDefined();
    expect(bundle.seals.map((entry) => [entry.seal.fromSeq, entry.seal.toSeq])).toEqual([[1, 3], [4, 4], [5, 5]]);
    // B's chain is its own and passes too.
    const other = verifyBundle(await assembleBundle({ store: r.store, storage: r.storage, companyId: B, epochIds: r.epochs }), { anchors: doubleAnchors() });
    expect(other.ok).toBe(true);
    // The statements chain epoch to epoch.
    const epochs = [...new Map(bundle.seals.map((entry) => [entry.epoch.epochId, entry.epoch])).values()];
    expect(epochs[1]?.prevEpochId).toBe(epochs[0]?.epochId);
  });

  it("detects a changed, removed, reordered or re-sealed record in the export", async () => {
    const r = rig();
    await seed(r);
    at(r, "2026-11-25T12:05:10Z"); await tick(r);
    const good = await assembleBundle({ store: r.store, storage: r.storage, companyId: A, epochIds: r.epochs });
    expect(verifyBundle(good, { anchors: doubleAnchors() }).ok).toBe(true);
    const copy = () => JSON.parse(JSON.stringify(good)) as typeof good;

    const edited = copy();
    (edited.records[1] as { action: string }).action = "company.budget.changed";
    expect(verifyBundle(edited, { anchors: doubleAnchors() }).ok).toBe(false);

    const removed = copy();
    removed.records.splice(1, 1);
    expect(verifyBundle(removed, { anchors: doubleAnchors() }).ok).toBe(false);

    const reordered = copy();
    reordered.records.reverse();
    expect(verifyBundle(reordered, { anchors: doubleAnchors() }).ok).toBe(false);

    const root = copy();
    (root.seals[0] as { seal: { batchRoot: string } }).seal.batchRoot = "0".repeat(64);
    expect(verifyBundle(root, { anchors: doubleAnchors() }).ok).toBe(false);
  });
});

describe("sealer: a stored record that was changed is never sealed", () => {
  it("refuses a row whose content no longer hashes to itself", async () => {
    const r = rig();
    await seed(r);
    const key = chainRecordKey(A, 2);
    const row = [...r.db.items.values()].find((item) => item.pk === key.pk && item.sk === key.sk);
    (row?.record as { action: string }).action = "company.budget.changed";
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r);
    expect(report.blocked.some((entry) => entry.refused && entry.what.includes(A))).toBe(true);
    await expect(r.store.readRecords(A, 1, 10)).rejects.toThrow(AuditLedgerCorrupt);
    // The other company is still sealed, and this one is not.
    expect(report.planned.map((planned) => planned.companyId)).toEqual([B]);
    expect(await r.store.getEpochSeal(report.epochId, A)).toBeUndefined();
    expect(await r.store.getEpochSeal(report.epochId, B)).toBeDefined();
  });

  it("refuses a chain with a record removed from the middle", async () => {
    const r = rig();
    await seed(r);
    const key = chainRecordKey(A, 2);
    const stored = [...r.db.items.entries()].find(([, item]) => item.pk === key.pk && item.sk === key.sk);
    r.db.items.delete(stored?.[0] ?? "");
    await expect(r.store.readRecords(A, 1, 10)).rejects.toThrow(AuditLedgerCorrupt);
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r);
    expect(report.blocked.some((entry) => entry.refused && entry.what.includes(A))).toBe(true);
    expect(await r.store.getEpochSeal(report.epochId, A)).toBeUndefined();
  });

  it("refuses a rewrite that re-hashes the changed record but breaks the link to the next one", async () => {
    const r = rig();
    await seed(r);
    const key = chainRecordKey(A, 2);
    const row = [...r.db.items.values()].find((item) => item.pk === key.pk && item.sk === key.sk);
    const record = row?.record as { action: string; hash: string };
    record.action = "company.budget.changed";
    record.hash = auditRecordDigestV1(record);
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r);
    expect(report.blocked.some((entry) => entry.refused && entry.what.includes(A))).toBe(true);
    expect(await r.store.getEpochSeal(report.epochId, A)).toBeUndefined();
  });

  it("refuses to lock a range that changed between planning and locking", async () => {
    const r = rig();
    await seed(r);
    r.storage.failKeyPart = "/records/";
    at(r, "2026-11-25T12:05:10Z");
    await tick(r); // planned, not locked
    const key = chainRecordKey(A, 3);
    const row = [...r.db.items.values()].find((item) => item.pk === key.pk && item.sk === key.sk);
    const record = row?.record as { action: string; hash: string };
    record.action = "company.budget.changed";
    record.hash = auditRecordDigestV1(record);
    r.storage.failKeyPart = undefined;
    at(r, "2026-11-25T12:10:10Z");
    const report = await tick(r);
    expect(report.blocked.some((entry) => entry.refused && entry.what.startsWith(`seal ${A}`))).toBe(true);
    expect(r.storage.writes.filter((key) => key.includes(`audit/${A}/`))).toEqual([]);
  });
});

describe("sealer: ports that are not built or that fail", () => {
  it("with the stand-ins every seal stays planned and says so, and nothing is claimed locked or timestamped", async () => {
    const r = rig();
    await seed(r);
    const sealer = new AuditSealer(r.store, unconfiguredLockedStorage, unconfiguredTimestampSource, { now: r.now });
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r, sealer);
    expect(report.planned).toHaveLength(2);
    expect(report.completedEpochs).toEqual([]);
    expect(report.blocked.map((entry) => entry.reason)).toEqual(["AuditSealingNotConfigured", "AuditSealingNotConfigured"]);
    expect(report.blocked.every((entry) => !entry.refused)).toBe(true);
    const seal = await r.store.getEpochSeal(report.epochId, A);
    expect((await r.store.getSealProgress(A, seal?.fromSeq ?? 0, seal?.toSeq ?? 0))?.phase).toBe("planned");
    expect(await r.store.getEpochProgress(report.epochId)).toMatchObject({ phase: "planned" });
    await expect(unconfiguredLockedStorage.putLocked({ key: "audit/x", body: new Uint8Array(), sha256: "" })).rejects.toThrow(AuditSealingNotConfigured);
    await expect(unconfiguredTimestampSource.stamp({ epochId: "e20261125T1205Z", statementHash: "" })).rejects.toThrow(AuditSealingNotConfigured);
  });

  it("a restarted sealer resumes where the last one stopped and does not lock anything twice", async () => {
    const r = rig();
    await seed(r);
    r.storage.failKeyPart = "/seals/"; // the batch locks, then the seal's own object fails
    at(r, "2026-11-25T12:05:10Z");
    const first = await tick(r);
    expect(first.completedEpochs).toEqual([]);
    const batchWrites = r.storage.writes.filter((key) => key.includes("/records/")).length;
    expect(batchWrites).toBe(2);
    r.storage.failKeyPart = ".tst";
    const fresh = new AuditSealer(new DynamoAuditLedgerStore(r.db, "t"), r.storage, r.tsa, { now: r.now });
    at(r, "2026-11-25T12:06:00Z");
    const second = await tick(r, fresh);
    expect(second.planned).toEqual([]);
    expect(r.storage.writes.filter((key) => key.includes("/records/")).length).toBe(batchWrites); // not locked again
    expect(r.tsa.asked).toEqual([first.epochId]); // stamped, token kept, upload failed
    r.storage.failKeyPart = undefined;
    const third = new AuditSealer(new DynamoAuditLedgerStore(r.db, "t"), r.storage, r.tsa, { now: r.now });
    at(r, "2026-11-25T12:07:00Z");
    expect((await tick(r, third)).completedEpochs).toEqual([first.epochId]);
    expect(r.tsa.asked).toEqual([first.epochId]); // the saved token was uploaded; the authority was not asked again
    const bundle = await assembleBundle({ store: r.store, storage: r.storage, companyId: A, epochIds: r.epochs });
    expect(verifyBundle(bundle, { anchors: doubleAnchors() }).ok).toBe(true);
  });

  it("a timestamp source that fails leaves the epoch waiting, and the next tick asks again", async () => {
    const r = rig();
    await seed(r);
    r.tsa.failNext = 1;
    at(r, "2026-11-25T12:05:10Z");
    const first = await tick(r);
    expect(first.blocked.map((entry) => entry.what)).toEqual([`epoch ${first.epochId}`]);
    expect(await r.store.getEpochProgress(first.epochId)).toMatchObject({ phase: "waiting-timestamp" });
    at(r, "2026-11-25T12:06:00Z");
    expect((await tick(r)).completedEpochs).toEqual([first.epochId]);
  });

  it("does not stamp an epoch until every seal in it is locked", async () => {
    const r = rig();
    await seed(r);
    r.storage.failKeyPart = `audit/${B}/`;
    at(r, "2026-11-25T12:05:10Z");
    await tick(r);
    expect(r.tsa.asked).toEqual([]);
    r.storage.failKeyPart = undefined;
    at(r, "2026-11-25T12:06:00Z");
    expect((await tick(r)).completedEpochs).toHaveLength(1);
    expect(r.tsa.asked).toHaveLength(1);
  });

  it("refuses evidence that is for other bytes, or kept for less than 365 days", async () => {
    const lying = rig();
    await seed(lying);
    lying.storage.lie = true;
    at(lying, "2026-11-25T12:05:10Z");
    const report = await tick(lying);
    expect(report.blocked.some((entry) => entry.refused && entry.reason === "AuditSealRefused")).toBe(true);
    expect((await lying.store.getSealProgress(A, 1, 3))?.phase).toBe("planned");

    const short = rig();
    await seed(short);
    short.storage.retentionDays = 364;
    at(short, "2026-11-25T12:05:10Z");
    await tick(short);
    expect((await short.store.getSealProgress(A, 1, 3))?.phase).toBe("planned");
  });
});

describe("sealer: two sealers racing", () => {
  it("plan one seal chain and one epoch chain, and the result still verifies", async () => {
    const r = rig();
    await seed(r);
    class Gated extends DynamoAuditLedgerStore {
      private seen = 0;
      private release: () => void = () => undefined;
      private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
      override async getSealTip(companyId: string) {
        const tip = await super.getSealTip(companyId);
        this.seen += 1;
        if (this.seen === 2) this.release();
        if (this.seen <= 2) await this.gate;
        return tip;
      }
    }
    const store = new Gated(r.db, "t");
    const one = new AuditSealer(store, r.storage, r.tsa, { now: r.now });
    const two = new AuditSealer(store, r.storage, r.tsa, { now: r.now });
    at(r, "2026-11-25T12:05:10Z");
    const [x, y] = await Promise.all([one.tick(), two.tick()]);
    r.epochs.push(x.epochId);
    expect([...x.planned, ...y.planned].filter((planned) => planned.companyId === A)).toHaveLength(1);
    expect((await store.listEpochSeals(x.epochId)).map((seal) => seal.orgId)).toEqual([A, B]);
    at(r, "2026-11-25T12:06:00Z");
    await tick(r);
    const bundle = await assembleBundle({ store: r.store, storage: r.storage, companyId: A, epochIds: r.epochs });
    expect(verifyBundle(bundle, { anchors: doubleAnchors() }).ok).toBe(true);
    expect(bundle.seals).toHaveLength(1);
  });
});

describe("store: the conditional writes that keep the chains from forking", () => {
  const checkpoint = (fromSeq: number, toSeq: number, epochId: string) => ({ fromSeq, toSeq, headHash: "a".repeat(64), prevSealHash: "b".repeat(64), epochId });
  const seal = (companyId: string, fromSeq: number, toSeq: number, epochId: string) => SealProgressV1Schema.parse({
    v: 1, kind: "seal-progress", phase: "planned", companyId, checkpoint: checkpoint(fromSeq, toSeq, epochId), batchRoot: "c".repeat(64), updatedAt: iso(T0),
  });
  const E1 = "e20261125T1205Z";
  const E2 = "e20261125T1210Z";

  it("a second seal that starts from a tip that has moved is refused", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    expect(await store.planSeal(seal(A, 1, 3, E1), { tip: undefined })).toBe("planned");
    // Another writer, still believing nothing is sealed, plans a different range in a later epoch.
    expect(await store.planSeal(seal(A, 1, 5, E2), { tip: undefined })).toBe("refused");
    // And one that read the real tip may go on.
    const tip = await store.getSealTip(A);
    expect(tip).toMatchObject({ toSeq: 3, epochId: E1 });
    expect(await store.planSeal(seal(A, 4, 5, E2), { tip })).toBe("planned");
  });

  it("a seal planned from a stale tip is refused even when it names a defined tip", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    await store.planSeal(seal(A, 1, 3, E1), { tip: undefined });
    const stale = await store.getSealTip(A);
    expect(await store.planSeal(seal(A, 4, 5, E2), { tip: stale })).toBe("planned");
    expect(await store.planSeal(seal(A, 4, 6, "e20261125T1215Z"), { tip: stale })).toBe("refused");
    expect(await store.getSealProgress(A, 4, 6)).toBeUndefined();
  });

  it("a company gets one seal in an epoch", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    expect(await store.planSeal(seal(A, 1, 3, E1), { tip: undefined })).toBe("planned");
    const tip = await store.getSealTip(A);
    expect(await store.planSeal(seal(A, 4, 5, E1), { tip })).toBe("refused");
  });

  it("no seal joins a closed epoch or one at or before a planned statement", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    expect(await store.planSeal(seal(A, 1, 3, E1), { tip: undefined })).toBe("planned");
    expect(await store.closeEpoch(E1, iso(T0))).toBe("closed");
    expect(await store.closeEpoch(E1, iso(T0))).toBe("exists");
    expect(await store.planSeal(seal(B, 1, 2, E1), { tip: undefined })).toBe("refused");
    const statement = EpochProgressV1Schema.parse({ v: 1, kind: "epoch-progress", phase: "planned", epochId: E1, ...stmt(E1, null), updatedAt: iso(T0) });
    expect(await store.planEpoch(statement, { tip: undefined })).toBe("planned");
    expect(await store.planSeal(seal(B, 1, 2, E2), { tip: undefined })).toBe("planned"); // a later epoch is fine
    expect(await store.planSeal(seal("org_cccccccccccccccccccc", 1, 2, E1), { tip: undefined })).toBe("refused");
  });

  it("a statement is planned once, only from a closed epoch, and only chained to the tip that was read", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    const first = EpochProgressV1Schema.parse({ v: 1, kind: "epoch-progress", phase: "planned", epochId: E1, ...stmt(E1, null), updatedAt: iso(T0) });
    expect(await store.planEpoch(first, { tip: undefined })).toBe("refused"); // not closed
    await store.closeEpoch(E1, iso(T0));
    await store.closeEpoch(E2, iso(T0));
    expect(await store.planEpoch(first, { tip: undefined })).toBe("planned");
    expect(await store.planEpoch(first, { tip: undefined })).toBe("refused"); // twice
    const second = EpochProgressV1Schema.parse({ v: 1, kind: "epoch-progress", phase: "planned", epochId: E2, ...stmt(E2, first), updatedAt: iso(T0) });
    expect(await store.planEpoch(second, { tip: undefined })).toBe("refused"); // chained to nothing, though a tip exists
    expect(await store.planEpoch(second, { tip: { epochId: E1, statementHash: first.statementHash } })).toBe("planned");
  });

  it("a statement planned from a stale tip, or planned a second time with the right tip, is refused", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    const E3 = "e20261125T1215Z";
    for (const id of [E1, E2, E3]) await store.closeEpoch(id, iso(T0));
    const first = EpochProgressV1Schema.parse({ v: 1, kind: "epoch-progress", phase: "planned", epochId: E1, ...stmt(E1, null), updatedAt: iso(T0) });
    await store.planEpoch(first, { tip: undefined });
    const tip1 = { epochId: E1, statementHash: first.statementHash };
    expect(await store.planEpoch(first, { tip: tip1 })).toBe("refused"); // the same epoch again
    const second = EpochProgressV1Schema.parse({ v: 1, kind: "epoch-progress", phase: "planned", epochId: E2, ...stmt(E2, tip1), updatedAt: iso(T0) });
    expect(await store.planEpoch(second, { tip: tip1 })).toBe("planned");
    const third = EpochProgressV1Schema.parse({ v: 1, kind: "epoch-progress", phase: "planned", epochId: E3, ...stmt(E3, tip1), updatedAt: iso(T0) });
    expect(await store.planEpoch(third, { tip: tip1 })).toBe("refused"); // chained to the old tip
    expect(await store.getEpochProgress(E3)).toBeUndefined();
  });

  it("a phase moves forward from the phase it was read in only", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    const planned = seal(A, 1, 3, E1);
    await store.planSeal(planned, { tip: undefined });
    const locked = { key: "audit/x", versionId: "v1", sha256: "d".repeat(64), writtenAt: iso(T0), lockMode: "COMPLIANCE" as const, retainUntil: iso(T0 + 400 * 86_400_000) };
    const next = SealProgressV1Schema.parse({ ...planned, phase: "batch-locked", batch: locked });
    expect(await store.advanceSeal(planned, next)).toBe("advanced");
    expect(await store.advanceSeal(planned, next)).toBe("stale");
    expect(await store.getSealProgress(A, 1, 3)).toMatchObject({ phase: "batch-locked" });
  });
});

import { statementHash, merkleRoot } from "../../packages/audit-verifier/src/index.js";
function stmt(epochId: string, prev: { epochId: string; statementHash: string } | null) {
  const body = { v: 1 as const, epochId, closedAt: closedAtOfEpoch(epochId).toISOString(), prevEpochId: prev?.epochId ?? null, prevStatementHash: prev?.statementHash ?? null, sealsRoot: merkleRoot([new Uint8Array([1])]), sealCount: 1 };
  return { closedAt: body.closedAt, prevEpochId: body.prevEpochId, prevStatementHash: body.prevStatementHash, sealsRoot: body.sealsRoot, sealCount: body.sealCount, statementHash: statementHash(body) };
}

describe("sealer: an epoch is never left out (pre-review MUST-1)", () => {
  it("a sealer that stalls between planning a seal and closing its epoch, while another sealer runs the next epoch, loses nothing", async () => {
    const r = rig();
    await seed(r);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let stalled: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { stalled = resolve; });
    class Stalls extends DynamoAuditLedgerStore {
      override async closeEpoch(...args: Parameters<DynamoAuditLedgerStore["closeEpoch"]>) {
        stalled();
        await gate;
        return super.closeEpoch(...args);
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    const slow = new AuditSealer(new Stalls(r.db, "t"), r.storage, r.tsa, { now: r.now }).tick();
    await reached; // its seals are planned into the 12:05 epoch; it has not closed it
    await r.appender.append(pending(A, 6));
    at(r, "2026-11-25T12:10:10Z");
    const fast = await tick(r);
    expect(fast.epochId).toBe("e20261125T1210Z");
    release();
    await slow;
    r.epochs.push("e20261125T1205Z");
    at(r, "2026-11-25T12:15:10Z");
    await tick(r);
    for (const company of [A, B]) {
      const bundle = await assembleBundle({ store: r.store, storage: r.storage, companyId: company, epochIds: r.epochs });
      expect(verifyBundle(bundle, { anchors: doubleAnchors() }).ok).toBe(true);
    }
    const first = await r.store.getEpochProgress("e20261125T1205Z");
    const second = await r.store.getEpochProgress("e20261125T1210Z");
    expect(first?.prevEpochId).toBeNull();
    expect(second?.prevEpochId).toBe("e20261125T1205Z"); // the chain did not start again
  });

  it("fencing an epoch refuses later seals into it, and the epoch is listed as holding seals", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    const plan = (company: string, epochId: string) => SealProgressV1Schema.parse({
      v: 1, kind: "seal-progress", phase: "planned", companyId: company, checkpoint: { fromSeq: 1, toSeq: 2, headHash: "a".repeat(64), prevSealHash: "b".repeat(64), epochId },
      batchRoot: "c".repeat(64), updatedAt: iso(T0),
    });
    expect(await store.planSeal(plan(A, "e20261125T1205Z"), { tip: undefined })).toBe("planned");
    expect(await store.listSealedEpochs()).toEqual(["e20261125T1205Z"]);
    await store.fenceBefore("e20261125T1210Z");
    await store.fenceBefore("e20261125T1205Z"); // never moves back
    expect(await store.planSeal(plan(B, "e20261125T1205Z"), { tip: undefined })).toBe("refused");
    expect(await store.planSeal(plan(B, "e20261125T1210Z"), { tip: undefined })).toBe("planned");
  });

  it("does not plan a later statement while an earlier closed epoch has none", async () => {
    const r = rig();
    await seed(r);
    class NoPlan extends DynamoAuditLedgerStore {
      override async planEpoch(...args: Parameters<DynamoAuditLedgerStore["planEpoch"]>) {
        if (args[0].epochId === "e20261125T1205Z") throw new Error("could not plan");
        return super.planEpoch(...args);
      }
    }
    const stuck = new AuditSealer(new NoPlan(r.db, "t"), r.storage, r.tsa, { now: r.now });
    at(r, "2026-11-25T12:05:10Z"); await tick(r, stuck);
    await r.appender.append(pending(A, 6));
    at(r, "2026-11-25T12:10:10Z");
    const report = await tick(r, stuck);
    expect(await r.store.getEpochProgress("e20261125T1210Z")).toBeUndefined();
    expect(report.blocked.map((entry) => entry.what)).toContain("epoch e20261125T1210Z");
    at(r, "2026-11-25T12:15:10Z");
    await tick(r); // a healthy sealer plans both, in order
    expect((await r.store.getEpochProgress("e20261125T1210Z"))?.prevEpochId).toBe("e20261125T1205Z");
  });
});

describe("sealer: the authority named on a statement (pre-review SHOULD-3)", () => {
  it("refuses to stamp a statement with a source other than the one it names", async () => {
    const r = rig();
    await seed(r);
    r.tsa.failNext = 1;
    at(r, "2026-11-25T12:05:10Z");
    const first = await tick(r); // the statement is locked naming "testtsa"; the stamp fails
    expect(await r.store.getEpochProgress(first.epochId)).toMatchObject({ phase: "waiting-timestamp", tsaProvider: "testtsa" });
    class Other extends TimestampDouble { override provider = "othertsa"; }
    at(r, "2026-11-25T12:06:00Z");
    const second = await tick(r, new AuditSealer(r.store, r.storage, new Other(), { now: r.now }));
    expect(second.blocked.some((entry) => entry.refused && entry.what === `epoch ${first.epochId}`)).toBe(true);
    expect(await r.store.getEpochProgress(first.epochId)).toMatchObject({ phase: "waiting-timestamp" });
  });
});

describe("sealer: the head and the chain's end (pre-review SHOULD-2, 5)", () => {
  it("stops a company whose head names a record that is not the chain's last", async () => {
    const r = rig();
    await seed(r);
    const [, headRow] = [...r.db.items.entries()].find(([, item]) => item.pk === `LEDGERHEAD#${A}`) as [string, Record<string, unknown>];
    headRow.headHash = "e".repeat(64);
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r);
    expect(report.blocked.some((entry) => entry.refused && entry.what.includes(A))).toBe(true);
    expect(report.planned.map((planned) => planned.companyId)).toEqual([B]);
  });

  it("refuses storage evidence that is not recent", async () => {
    const r = rig();
    await seed(r);
    class Old extends LockedStorageDouble {
      override async putLocked(write: Parameters<LockedStorageDouble["putLocked"]>[0]) {
        const evidence = await super.putLocked(write);
        return { ...evidence, writtenAt: "2025-01-01T00:00:00.000Z", retainUntil: "2027-01-01T00:00:00.000Z" };
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    await tick(r, new AuditSealer(r.store, new Old(r.now), r.tsa, { now: r.now }));
    expect((await r.store.getSealProgress(A, 1, 3))?.phase).toBe("planned");
  });
});

describe("sealer: evidence is compared with the clock, each way (pre-review SHOULD-5)", () => {
  async function sealedWith(change: (evidence: Awaited<ReturnType<LockedStorageDouble["putLocked"]>>, nowMs: number) => Awaited<ReturnType<LockedStorageDouble["putLocked"]>>) {
    const r = rig();
    await seed(r);
    class Changed extends LockedStorageDouble {
      override async putLocked(write: Parameters<LockedStorageDouble["putLocked"]>[0]) {
        return change(await super.putLocked(write), r.clock.ms);
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    await tick(r, new AuditSealer(r.store, new Changed(r.now), r.tsa, { now: r.now }));
    return (await r.store.getSealProgress(A, 1, 3))?.phase;
  }
  const DAY = 86_400_000;
  it("refuses an answer written long ago even when it is kept for a year from then and far into the future", async () => {
    expect(await sealedWith((evidence, now) => ({ ...evidence, writtenAt: iso(now - 2 * 3_600_000), retainUntil: iso(now + 400 * DAY) }))).toBe("planned");
  });
  it("refuses an answer written just now whose lock ends before the retention period is over, though it is a year long on its own terms", async () => {
    expect(await sealedWith((evidence, now) => ({ ...evidence, writtenAt: iso(now - 10 * 60_000), retainUntil: iso(now - 10 * 60_000 + 365 * DAY) }))).toBe("planned");
  });
  it("accepts an answer written just now and kept a year and a bit", async () => {
    expect(await sealedWith((evidence) => evidence)).toBe("locked");
  });
});

describe("sealer: the fence closes the window between listing and planning (pre-review MUST-1)", () => {
  it("a seal planned into an earlier epoch after the next tick listed its sealed epochs is refused", async () => {
    const r = rig();
    await seed(r);
    const outcomes: string[] = [];
    class Races extends DynamoAuditLedgerStore {
      override async listSealedEpochs() {
        const listed = await super.listSealedEpochs();
        // Another writer plans a seal into the earlier epoch right now: after this tick listed (and saw no seal there), before it plans anything.
        outcomes.push(await r.store.planSeal(SealProgressV1Schema.parse({
          v: 1, kind: "seal-progress", phase: "planned", companyId: B, checkpoint: { fromSeq: 1, toSeq: 2, headHash: "a".repeat(64), prevSealHash: "b".repeat(64), epochId: "e20261125T1205Z" },
          batchRoot: "c".repeat(64), updatedAt: iso(T0),
        }), { tip: undefined }));
        return listed;
      }
    }
    at(r, "2026-11-25T12:10:10Z");
    await tick(r, new AuditSealer(new Races(r.db, "t"), r.storage, r.tsa, { now: r.now }));
    expect(outcomes).toEqual(["refused"]);
  });
});
