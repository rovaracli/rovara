// Pre-review additions for lane AL-1 (Sonnet reviewer). Test-only. Cases the lane's own file does not pin:
//   - the guards that M3b, M3c, M12 and M16 showed were only ever tested together with their twin guard;
//   - restart and late-record paths of the epoch protocol;
//   - known gaps, written as `it.fails` (they PASS today because the behaviour is wrong; when the product is fixed they FAIL, and the fixer removes `.fails`).
import { describe, expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { checkChain, genesisHash } from "../../packages/audit-verifier/src/index.js";
import { CLOUD_AUDIT_ACTIONS } from "../../packages/cloud-server/src/audit-log.js";
import { EpochProgressV1Schema, SealProgressV1Schema, mapCloudAuditV1, materializeAuditRecordV1, pendingAuditV1 } from "../../packages/cloud-server/src/audit-contracts-v1.js";
import { AuditAppender } from "../../packages/cloud-server/src/audit-appender.js";
import { AuditLedgerCorrupt, DynamoAuditLedgerStore, chainHeadKey, chainRecordKey } from "../../packages/cloud-server/src/audit-ledger-store.js";
import { AuditSealer, closedAtOfEpoch } from "../../packages/cloud-server/src/audit-sealer.js";
import { unconfiguredTimestampSource } from "../../packages/cloud-server/src/audit-sealing-ports.js";
import { LockedStorageDouble, TimestampDouble, assembleBundle, doubleAnchors, verifyBundle } from "../support/audit-sealing-doubles.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { merkleRoot, statementHash } from "../../packages/audit-verifier/src/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const CONTEXT = { installId: "install1", salt: Uint8Array.from({ length: 16 }, (_, i) => i + 1) };
const T0 = Date.parse("2026-11-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const E1 = "e20261125T1205Z";
const E2 = "e20261125T1210Z";

function mapped(company: string, n: number) {
  return mapCloudAuditV1({
    id: `aud_${String(n).padStart(20, "0")}`, companyId: company, at: iso(T0), actor: { type: "person", developerId: "dev1", name: "Ada" },
    action: CLOUD_AUDIT_ACTIONS[1], subject: "", outcome: "ok",
  }, CONTEXT);
}
const pending = (company: string, n: number) => pendingAuditV1(mapped(company, n), iso(T0));

function rig() {
  const clock = { ms: T0 };
  const now = () => new Date(clock.ms);
  const db = new FakeDynamoDb();
  const store = new DynamoAuditLedgerStore(db, "t");
  const storage = new LockedStorageDouble(now);
  const tsa = new TimestampDouble();
  const appender = new AuditAppender(store, { now });
  const sealer = new AuditSealer(store, storage, tsa, { now });
  return { clock, now, db, store, storage, tsa, appender, sealer, epochs: [] as string[] };
}
type Rig = ReturnType<typeof rig>;
const at = (r: Rig, text: string) => { r.clock.ms = Date.parse(text); };
async function tick(r: Rig, sealer: AuditSealer = r.sealer) {
  const report = await sealer.tick();
  if (!r.epochs.includes(report.epochId)) r.epochs.push(report.epochId);
  return report;
}
const rowOf = (r: Rig, key: { pk: string; sk: string }) => [...r.db.items.entries()].find(([, item]) => item.pk === key.pk && item.sk === key.sk);

describe("review: the append guards each stand on their own", () => {
  it("a head row rolled back to an earlier record cannot let a second record in at a seq that exists (the record's own condition)", async () => {
    const r = rig();
    for (let n = 1; n <= 3; n += 1) await r.appender.append(pending(A, n));
    const [first, second] = await r.store.readRecords(A, 1, 2);
    if (first === undefined || second === undefined) throw new Error("setup");
    // Whoever can write the table sets the head back to record 1 (the head row is not the only thing that protects the chain).
    await r.db.send(new PutCommand({ TableName: "t", Item: { ...chainHeadKey(A), headSeq: 1, headHash: first.hash, headRecordedAt: first.recordedAt } }));
    const rolledBack = await r.store.getHead(A);
    const other = pending(A, 99);
    const record = materializeAuditRecordV1({ source: other.source, factsDigest: other.factsDigest, event: other.event }, { seq: 2, recordedAt: second.recordedAt, prevHash: first.hash });
    const receipt = { v: 1 as const, kind: "receipt" as const, source: other.source, factsDigest: other.factsDigest, seq: 2, recordHash: record.hash, committedAt: record.recordedAt };
    expect(await r.store.commitAppend({ record, receipt, expectedHead: rolledBack })).toBe("head-moved");
    expect((await r.store.readRecords(A, 1, 10)).map((x) => x.hash)).toHaveLength(3);
    expect((await r.store.readRecords(A, 2, 1))[0]?.hash).toBe(second.hash);
    expect(await r.store.getReceipt(other.source)).toBeUndefined();
  });

  it("a head row that exists with no record under it cannot start a chain again (the head's own first-record condition)", async () => {
    const r = rig();
    await r.appender.append(pending(A, 1));
    const key = rowOf(r, chainRecordKey(A, 1));
    r.db.items.delete(key?.[0] ?? "");
    const other = pending(A, 2);
    const record = materializeAuditRecordV1({ source: other.source, factsDigest: other.factsDigest, event: other.event }, { seq: 1, recordedAt: iso(T0), prevHash: genesisHash(A) });
    const receipt = { v: 1 as const, kind: "receipt" as const, source: other.source, factsDigest: other.factsDigest, seq: 1, recordHash: record.hash, committedAt: record.recordedAt };
    expect(await r.store.commitAppend({ record, receipt, expectedHead: undefined })).toBe("head-moved");
    expect(await r.store.getReceipt(other.source)).toBeUndefined();
  });
});

describe("review: the sealer's guards each stand on their own", () => {
  it("the store refuses a seal into an epoch before a planned statement even when that epoch is still open", async () => {
    const store = new DynamoAuditLedgerStore(new FakeDynamoDb(), "t");
    await store.closeEpoch(E2, iso(T0));
    const body = { v: 1 as const, epochId: E2, closedAt: closedAtOfEpoch(E2).toISOString(), prevEpochId: null, prevStatementHash: null, sealsRoot: merkleRoot([new Uint8Array([1])]), sealCount: 1 };
    const statement = EpochProgressV1Schema.parse({ ...body, kind: "epoch-progress", phase: "planned", statementHash: statementHash(body), updatedAt: iso(T0) });
    expect(await store.planEpoch(statement, { tip: undefined })).toBe("planned");
    // E1 is NOT closed (so the closed-epoch condition cannot be what refuses this): only the planned-statement condition can.
    const seal = SealProgressV1Schema.parse({
      v: 1, kind: "seal-progress", phase: "planned", companyId: A,
      checkpoint: { fromSeq: 1, toSeq: 2, headHash: "a".repeat(64), prevSealHash: "b".repeat(64), epochId: E1 }, batchRoot: "c".repeat(64), updatedAt: iso(T0),
    });
    expect(await store.planSeal(seal, { tip: undefined })).toBe("refused");
    expect(await store.getEpochSeal(E1, A)).toBeUndefined();
  });

  it("a tick for an epoch that is already planned past makes no attempt to plan a seal", async () => {
    const r = rig();
    at(r, "2026-11-25T12:02:00Z"); await r.appender.append(pending(A, 1));
    at(r, "2026-11-25T12:10:30Z"); await tick(r);
    at(r, "2026-11-25T12:03:00Z"); await r.appender.append(pending(A, 2));
    let attempts = 0;
    class Counting extends DynamoAuditLedgerStore {
      override async planSeal(...args: Parameters<DynamoAuditLedgerStore["planSeal"]>) { attempts += 1; return super.planSeal(...args); }
    }
    const stale = new AuditSealer(new Counting(r.db, "t"), r.storage, r.tsa, { now: () => new Date(Date.parse("2026-11-25T12:06:00Z")) });
    expect((await stale.tick()).planned).toEqual([]);
    expect(attempts).toBe(0);
  });
});

describe("review: restarts and late records", () => {
  it("a sealer that stops after the epoch is closed and before its statement is planned is picked up by the next tick", async () => {
    const r = rig();
    for (let n = 1; n <= 2; n += 1) await r.appender.append(pending(A, n));
    class Crashy extends DynamoAuditLedgerStore {
      override async planEpoch(): ReturnType<DynamoAuditLedgerStore["planEpoch"]> { throw new Error("process stopped"); }
    }
    at(r, "2026-11-25T12:05:10Z");
    const crashed = await tick(r, new AuditSealer(new Crashy(r.db, "t"), r.storage, r.tsa, { now: r.now }));
    expect(crashed.blocked.map((x) => x.what)).toEqual([`epoch ${E1}`]);
    expect(await r.store.getEpochProgress(E1)).toBeUndefined();
    at(r, "2026-11-25T12:06:00Z");
    expect((await tick(r)).completedEpochs).toEqual([E1]);
  });

  it("a record that a slow clock stamped before an already sealed boundary is sealed in the next epoch and the export still verifies", async () => {
    const r = rig();
    at(r, "2026-11-25T12:02:00Z"); await r.appender.append(pending(A, 1));
    at(r, "2026-11-25T12:05:10Z"); await tick(r);
    at(r, "2026-11-25T12:03:00Z"); await r.appender.append(pending(A, 2)); // clamped to record 1's time: before the 12:05 boundary
    at(r, "2026-11-25T12:06:00Z");
    expect((await tick(r)).planned).toEqual([]); // E1 is passed: cannot join
    at(r, "2026-11-25T12:10:10Z");
    expect((await tick(r)).planned).toEqual([{ companyId: A, fromSeq: 2, toSeq: 2 }]);
    at(r, "2026-11-25T12:11:00Z"); await tick(r);
    const bundle = await assembleBundle({ store: r.store, storage: r.storage, companyId: A, epochIds: r.epochs });
    expect(bundle.seals.map((s) => [s.seal.fromSeq, s.seal.toSeq])).toEqual([[1, 1], [2, 2]]);
    expect(verifyBundle(bundle, { anchors: doubleAnchors() }).ok).toBe(true);
  });

  it("a pending item whose source names one company and whose event names another is refused, writing nothing (the contract's own check)", async () => {
    const r = rig();
    const good = pending(A, 1);
    const crossed = { ...good, event: { ...good.event, orgId: B } };
    await expect(r.appender.append(crossed)).rejects.toThrow();
    expect(await r.store.getHead(B)).toBeUndefined();
    expect(await r.store.getReceipt(good.source)).toBeUndefined();
  });

  it("a bad row of another company copied into this company's chain is refused, and the other company is still sealed", async () => {
    const r = rig();
    await r.appender.append(pending(A, 1));
    await r.appender.append(pending(B, 2));
    const b = rowOf(r, chainRecordKey(B, 1))?.[1];
    const a = rowOf(r, chainRecordKey(A, 1))?.[1];
    if (b === undefined || a === undefined) throw new Error("setup");
    a.record = structuredClone(b.record); // B's own valid record, in A's slot
    await expect(r.store.readRecords(A, 1, 1)).rejects.toThrow(AuditLedgerCorrupt);
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r);
    expect(report.planned.map((p) => p.companyId)).toEqual([B]);
    expect(report.blocked.some((x) => x.refused && x.what.includes(A))).toBe(true);
  });
});

describe("review: KNOWN GAPS (it.fails: these pass while the gap exists; remove `.fails` with the fix)", () => {
  // MUST-1: an epoch that holds a planned seal is closed only by a tick that runs inside that same five minutes.
  it.fails("a seal planned in an epoch whose tick stopped before closing it still ends up in a closed epoch with a statement, and the chain verifies", async () => {
    const r = rig();
    for (let n = 1; n <= 3; n += 1) await r.appender.append(pending(A, n));
    class StopsBeforeClose extends DynamoAuditLedgerStore {
      override async closeEpoch(): Promise<"closed" | "exists"> { throw new Error("process stopped"); }
    }
    at(r, "2026-11-25T12:05:10Z");
    await expect(new AuditSealer(new StopsBeforeClose(r.db, "t"), r.storage, r.tsa, { now: r.now }).tick()).rejects.toThrow("process stopped");
    r.epochs.push(E1);
    at(r, "2026-11-25T12:07:00Z"); await r.appender.append(pending(A, 4));
    for (const time of ["12:10:10", "12:15:10", "12:20:10"]) { at(r, `2026-11-25T${time}Z`); await tick(r); }
    expect(await r.store.getEpochProgress(E1)).toBeDefined();
    const bundle = await assembleBundle({ store: r.store, storage: r.storage, companyId: A, epochIds: r.epochs });
    expect(bundle.seals.map((s) => [s.seal.fromSeq, s.seal.toSeq])).toEqual([[1, 3], [4, 4]]);
    expect(verifyBundle(bundle, { anchors: doubleAnchors() }).ok).toBe(true);
  });

  // SHOULD-1: a TransactionCanceledException that is a conflict with another transaction (no failed condition) is thrown out, not retried like a lost race.
  it.fails("an append that meets a transaction conflict is retried like a lost race", async () => {
    const r = rig();
    r.db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] }, times: 1 });
    expect((await r.appender.append(pending(A, 1))).outcome).toBe("appended");
  });

  // SHOULD-2: the stored head says seq 3 but the row for 3 is gone: the sealer seals 1..2 and says nothing.
  it.fails("a record that the head names but that is missing from the end of the chain stops that company", async () => {
    const r = rig();
    for (let n = 1; n <= 3; n += 1) await r.appender.append(pending(A, n));
    r.db.items.delete(rowOf(r, chainRecordKey(A, 3))?.[0] ?? "");
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r);
    expect(report.blocked.some((x) => x.refused && x.what.includes(A))).toBe(true);
    expect(report.planned).toEqual([]);
  });

  // SHOULD-3: the statement's timestamp provider label is stored when the statement is locked, before any timestamp source exists.
  it.fails("a statement locked while no timestamp source is wired is not stamped with the label of the stand-in once a real source comes", async () => {
    const r = rig();
    await r.appender.append(pending(A, 1));
    at(r, "2026-11-25T12:05:10Z");
    await tick(r, new AuditSealer(r.store, r.storage, unconfiguredTimestampSource, { now: r.now }));
    at(r, "2026-11-25T12:06:00Z");
    expect((await tick(r)).completedEpochs).toEqual([E1]);
    expect(await r.store.getEpochProgress(E1)).toMatchObject({ phase: "timestamped", tsaProvider: r.tsa.provider });
  });

  // SHOULD-4: the seal row that goes into the statement is not compared with the seal's own progress row.
  it.fails("a seal row changed after it was planned is not put into the epoch statement", async () => {
    const r = rig();
    await r.appender.append(pending(A, 1));
    class ChangesTheLeaf extends DynamoAuditLedgerStore {
      override async closeEpoch(...args: Parameters<DynamoAuditLedgerStore["closeEpoch"]>) {
        const result = await super.closeEpoch(...args);
        const leaf = [...r.db.items.values()].find((item) => typeof item.pk === "string" && item.pk.startsWith("EPOCHSEAL#"));
        (leaf?.seal as { batchRoot: string }).batchRoot = "0".repeat(64);
        return result;
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    const report = await tick(r, new AuditSealer(new ChangesTheLeaf(r.db, "t"), r.storage, r.tsa, { now: r.now }));
    expect(await r.store.getEpochProgress(E1)).toBeUndefined();
    expect(report.blocked.some((x) => x.refused)).toBe(true);
  });

  // SHOULD-5: the evidence is checked for its own length of retention, not against the clock: a version whose lock has already run out is taken.
  it.fails("storage evidence whose retention already ended is refused", async () => {
    const r = rig();
    await r.appender.append(pending(A, 1));
    class Expired extends LockedStorageDouble {
      override async putLocked(write: Parameters<LockedStorageDouble["putLocked"]>[0]) {
        const evidence = await super.putLocked(write);
        return { ...evidence, writtenAt: "2020-01-01T00:00:00.000Z", retainUntil: "2021-06-01T00:00:00.000Z" };
      }
    }
    at(r, "2026-11-25T12:05:10Z");
    await tick(r, new AuditSealer(r.store, new Expired(r.now), r.tsa, { now: r.now }));
    expect((await r.store.getSealProgress(A, 1, 1))?.phase).toBe("planned");
  });
});

describe("review: a record whose clock ran ahead (documented, not asserted as fixed)", () => {
  it("holds back that company's later records until the clock catches up, and does not seal around it", async () => {
    const r = rig();
    at(r, "2026-11-25T12:02:00Z"); await r.appender.append(pending(A, 1));
    at(r, "2026-11-26T12:00:00Z"); await r.appender.append(pending(A, 2)); // a server a day ahead
    at(r, "2026-11-25T12:03:00Z"); await r.appender.append(pending(A, 3)); // clamped to the day-ahead time
    at(r, "2026-11-25T12:05:10Z");
    expect((await tick(r)).planned).toEqual([{ companyId: A, fromSeq: 1, toSeq: 1 }]);
    at(r, "2026-11-25T18:00:10Z");
    expect((await tick(r)).planned).toEqual([]); // records 2 and 3 wait about a day
    const records = await r.store.readRecords(A, 1, 10);
    expect(checkChain(records, { seq: 0, hash: genesisHash(A), orgId: A })).toEqual({ ok: true });
  });
});
