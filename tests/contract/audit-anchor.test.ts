// tests/contract/audit-anchor.test.ts
// Task 8 of the Audit Ledger plan: the epoch sealer. DynamoDB is FakeDynamoDb (one in-memory store for both tables: their
// partition keys do not overlap, and a recording wrapper checks every operation against the table it was sent to), S3 is
// FakeLockedS3 (versioning, default retention, 412 on a second write, 400 without a checksum). The fakes do not enforce IAM:
// the anchor's grants are pinned in audit-ledger-infrastructure.test.ts, and the wrapper here proves the code uses nothing
// beyond them.
import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  checkChain,
  genesisHash,
  inclusionPath,
  recordHash,
  sealHash,
  sealLeafData,
  statementHash,
  verifyBundle,
  verifyExtends,
  type AuditBundleV1,
  type AuditRecordV1,
  type BundleSeal,
  type EpochStatementV1,
  type LockedObjectV1,
  type OrgSealV1,
} from "@rovara/audit-verifier";
import { AUDIT_BACKSTOP_SEAL_AGE_MINUTES, AUDIT_MAX_RECORDS_PER_ORG_EPOCH, auditCanonicalJson } from "@agentx/cloud-contracts";
import {
  AUDIT_EPOCH_SOURCE,
  auditS3ClientConfig,
  epochIdAt,
  leavesObjectKey,
  lockedPutInput,
  recordsObjectKey,
  sealObjectKey,
  statementObjectKey,
} from "../../packages/broker/src/audit/anchor.js";
import { handleAuditEpochEvent } from "../../packages/broker/src/audit/anchor-handler.js";

import {
  A, B, C, E0, E1, E2, LEDGER, SEALS, BUCKET, START, at, orgOf, pad12, iso, harness, appendRecords, run, eventsOf, stateOf, metaOf, intentOf, epochHead, markerOf, storedRecords, crash, snapshot,
  type Harness,
} from "../support/audit-anchor-harness.js";

describe("the object keys and the epoch id", () => {
  it("keys records and seals by org and first sequence number, and epochs by date", () => {
    expect(recordsObjectKey(A, 10001)).toBe(`orgs/${A}/records/000000010001.jsonl`);
    expect(sealObjectKey(A, 1)).toBe(`orgs/${A}/seals/000000000001.json`);
    expect(statementObjectKey(E0)).toBe(`epochs/2026/10/20/${E0}.json`);
    expect(leavesObjectKey(E0)).toBe(`epochs/2026/10/20/${E0}.leaves.json`);
  });

  it("takes the epoch id from the 15-minute slot", () => {
    expect(epochIdAt(Date.parse("2026-10-20T12:00:00.000Z"))).toBe(E0);
    expect(epochIdAt(Date.parse("2026-10-20T12:14:59.999Z"))).toBe(E0);
    expect(epochIdAt(Date.parse("2026-10-20T12:15:00.000Z"))).toBe(E1);
    expect(epochIdAt(Date.parse("2026-12-31T23:59:59.999Z"))).toBe("e20261231T2345Z");
  });
});

describe("sealing one org", () => {
  it("writes the records, the seal, the leaves and the statement under create-only keys and records the state", async () => {
    const h = harness();
    appendRecords(h, A, 5);
    const result = await run(h, at(0));
    expect(result).toMatchObject({ status: "sealed" });
    expect(h.s3.keys()).toStrictEqual([statementObjectKey(E0), leavesObjectKey(E0), recordsObjectKey(A, 1), sealObjectKey(A, 1)].sort());

    const records = storedRecords(h, A);
    const seal: OrgSealV1 = JSON.parse(h.s3.currentText(sealObjectKey(A, 1))!) as OrgSealV1;
    expect(seal).toStrictEqual({
      v: 1, orgId: A, fromSeq: 1, toSeq: 5, batchRoot: seal.batchRoot, headHash: records[4]!.hash, prevSealHash: genesisHash(A), epochId: E0,
    });
    expect(h.s3.currentText(sealObjectKey(A, 1))).toBe(auditCanonicalJson(seal));
    // One canonical record per line, in sequence order, without the stored extras.
    expect(h.s3.currentText(recordsObjectKey(A, 1))).toBe(`${records.map((record) => auditCanonicalJson(record)).join("\n")}\n`);
    expect(h.s3.currentText(recordsObjectKey(A, 1))).not.toContain("sealedDetails");
    expect(h.s3.currentText(recordsObjectKey(A, 1))).not.toContain('"pk"');

    const sealVersion = h.s3.versionsOf(sealObjectKey(A, 1))[0]!;
    const meta = metaOf(h, E0)!;
    expect(meta).toMatchObject({ status: "sealed", prevEpochId: null, prevStatementHash: null });
    const statement = meta.statement as EpochStatementV1;
    expect(statement).toMatchObject({ v: 1, epochId: E0, prevEpochId: null, prevStatementHash: null, sealCount: 1, closedAt: iso(at(0)) });
    expect(h.s3.currentText(statementObjectKey(E0))).toBe(auditCanonicalJson(statement));
    expect(JSON.parse(h.s3.currentText(leavesObjectKey(E0))!)).toStrictEqual({ v: 1, epochId: E0, seals: [seal] });

    expect(stateOf(h, A)).toStrictEqual({
      pk: `SEALED#${A}`, sk: "STATE", sealedSeq: 5, lastFromSeq: 1, lastSealHash: sealHash(seal), lastSealVersionId: sealVersion.versionId,
      lastEpochId: E0, sealedAt: iso(at(0)),
    });
    const intent = intentOf(h, E0, A)!;
    expect(intent).toMatchObject({ fromSeq: 1, toSeq: 5, finalized: true, seal, index: { index: 0, size: 1 } });
    const objects = intent.objects as { records: LockedObjectV1; seal: LockedObjectV1 };
    expect(objects.seal).toStrictEqual({ key: sealObjectKey(A, 1), versionId: sealVersion.versionId, lastModified: iso(at(0)), lockMode: "COMPLIANCE", retainUntil: iso(at(0) + 1096 * 86_400_000) });
    expect(objects.records.key).toBe(recordsObjectKey(A, 1));
    expect(h.db.get(`SEALS#${A}`, pad12(1))).toStrictEqual({ pk: `SEALS#${A}`, sk: pad12(1), epochId: E0, toSeq: 5, objects });
    expect(markerOf(h, A)).toBeUndefined();
    expect(epochHead(h)).toStrictEqual({ pk: "EPOCH_HEAD", sk: "HEAD", epochId: E0, statementHash: statementHash(statement), closedAt: iso(at(0)) });
    expect(meta.objects).toMatchObject({ statement: { key: statementObjectKey(E0) }, leaves: { key: leavesObjectKey(E0) } });
    expect(eventsOf(h, "audit.epoch_sealed")).toStrictEqual([expect.objectContaining({ epochId: E0, status: "sealed", orgs: 1, skipped: 0, records: 5 })]);
  });

  it("chains the next epoch to the last one and the next seal to the last seal", async () => {
    const h = harness();
    appendRecords(h, A, 5);
    await run(h, at(0));
    const first = metaOf(h, E0)!.statement as EpochStatementV1;
    const firstSeal = JSON.parse(h.s3.currentText(sealObjectKey(A, 1))!) as OrgSealV1;
    h.clock.now = at(1);
    appendRecords(h, A, 3);
    await run(h, at(1));
    const second = metaOf(h, E1)!.statement as EpochStatementV1;
    expect(second).toMatchObject({ epochId: E1, prevEpochId: E0, prevStatementHash: statementHash(first), sealCount: 1 });
    expect(JSON.parse(h.s3.currentText(sealObjectKey(A, 6))!)).toMatchObject({ fromSeq: 6, toSeq: 8, prevSealHash: sealHash(firstSeal), epochId: E1 });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 8, lastFromSeq: 6, lastEpochId: E1 });
    expect(epochHead(h)).toMatchObject({ epochId: E1, statementHash: statementHash(second) });
    // Nothing from the first epoch was touched.
    expect(h.s3.versionsOf(sealObjectKey(A, 1))).toHaveLength(1);
  });

  it("does nothing when there is nothing to seal, and says so", async () => {
    const h = harness();
    expect(await run(h, at(0))).toMatchObject({ status: "idle", reason: "nothing_to_seal" });
    expect(h.db.find((item) => String(item.pk).startsWith("EPOCH"))).toHaveLength(0);
    // Only the lock checks' three reads of the bucket's configuration: no object is touched.
    expect(h.s3.calls.map((call) => call.command).sort()).toStrictEqual(["GetBucketPolicy", "GetBucketVersioning", "GetObjectLockConfiguration"]);
    expect(eventsOf(h, "audit.epoch_sealed")).toStrictEqual([expect.objectContaining({ status: "idle", reason: "nothing_to_seal" })]);
  });

  it("clears a stale marker (everything it names is sealed already) without opening an epoch", async () => {
    const h = harness();
    appendRecords(h, A, 2);
    await run(h, at(0));
    h.db.set({ pk: "AUDIT_DIRTY", sk: A, since: 1, lastSeq: 2 });
    h.clock.now = at(1);
    expect(await run(h, at(1))).toMatchObject({ status: "idle" });
    expect(markerOf(h, A)).toBeUndefined();
    expect(metaOf(h, E1)).toBeUndefined();
  });

});

describe("an end-to-end export of what the anchor wrote verifies with the standalone verifier", () => {
  const objectOf = (h: Harness, key: string): LockedObjectV1 => {
    const version = h.s3.versionsOf(key)[0]!;
    return { key, versionId: version.versionId, lastModified: iso(version.lastModified), lockMode: version.lockMode, retainUntil: iso(version.retainUntil) };
  };

  /** A small stand-in for the export builder (Task 11): everything comes from the locked objects and the records. */
  function exportBundle(h: Harness, orgId: string): AuditBundleV1 {
    const all = storedRecords(h, orgId);
    const indexItems = h.db.find((item) => item.pk === `SEALS#${orgId}`).sort((left, right) => String(left.sk).localeCompare(String(right.sk)));
    const seals: BundleSeal[] = indexItems.map((item) => {
      const fromSeq = Number(item.sk);
      const seal = JSON.parse(h.s3.currentText(sealObjectKey(orgId, fromSeq))!) as OrgSealV1;
      const epoch = JSON.parse(h.s3.currentText(statementObjectKey(String(item.epochId)))!) as EpochStatementV1;
      const leaves = (JSON.parse(h.s3.currentText(leavesObjectKey(String(item.epochId)))!) as { seals: OrgSealV1[] }).seals;
      const index = leaves.findIndex((leaf) => leaf.orgId === orgId);
      const objects = item.objects as { records: LockedObjectV1; seal: LockedObjectV1 };
      return {
        seal, sealObject: objects.seal, recordsObject: objects.records,
        inclusion: { index, size: leaves.length, path: inclusionPath(leaves.map(sealLeafData), index) },
        epoch, epochObject: objectOf(h, statementObjectKey(String(item.epochId))), timestamps: [],
      };
    });
    const through = seals.at(-1)?.seal.toSeq ?? 0;
    return {
      format: "rovara-audit-bundle", v: 1, orgId, exportedAt: iso(h.clock.now), previous: { seq: 0, hash: genesisHash(orgId) }, previousSeal: null,
      records: all.filter((record) => record.seq <= through), seals, unsealed: all.filter((record) => record.seq > through),
    };
  }

  it("passes every check, including the epochs check, across epochs; and a later export extends an earlier one", async () => {
    const h = harness();
    appendRecords(h, A, 6);
    appendRecords(h, B, 3);
    await run(h, at(0));
    h.clock.now = at(1);
    appendRecords(h, A, 4);
    const early = exportBundle(h, A);
    expect(verifyBundle(early, { anchors: {} })).toMatchObject({ ok: true, sealedThroughSeq: 6, unsealedCount: 4 });
    await run(h, at(1));
    h.clock.now = at(2);
    appendRecords(h, A, 2);
    appendRecords(h, B, 1);
    await run(h, at(2));
    const late = exportBundle(h, A);
    const report = verifyBundle(late, { anchors: {} });
    expect(report.checks.filter((check) => !check.ok), JSON.stringify(report.checks)).toStrictEqual([]);
    expect(report).toMatchObject({ ok: true, sealedThroughSeq: 12, unsealedCount: 0 });
    expect(late.seals.map((entry) => entry.epoch.epochId)).toStrictEqual([E0, E1, E2]);
    expect(report.checks.find((check) => check.name === "epochs")).toMatchObject({ ok: true });
    expect(verifyExtends(late, early)).toMatchObject({ ok: true });
    // The two orgs share epoch E0: the proof for B's seal is in the same seals root.
    const other = exportBundle(h, B);
    expect(verifyBundle(other, { anchors: {} }).ok).toBe(true);
    expect(other.seals[0]!.inclusion).toMatchObject({ size: 2 });
  });
});

describe("C1: per-org finalize at scale", () => {
  const ORGS = 150;
  const orgs = Array.from({ length: ORGS }, (_, index) => `org_${String(index).padStart(20, "0")}`);

  it("seals 150 orgs in one epoch, with at most 4 items in a transaction and no item over 10 KB", async () => {
    const h = harness();
    for (const org of orgs) appendRecords(h, org, 3);
    const result = await run(h, at(0));
    expect(result).toMatchObject({ status: "sealed" });
    for (const org of orgs) expect(stateOf(h, org), org).toMatchObject({ sealedSeq: 3, lastEpochId: E0 });
    expect((metaOf(h, E0)!.statement as EpochStatementV1).sealCount).toBe(ORGS);
    expect(Math.max(...h.transactions.map((transaction) => transaction.items))).toBeLessThanOrEqual(4);
    // One transaction per org finalizes (4 items), plus the epoch's opening and closing pairs.
    expect(h.transactions.filter((transaction) => transaction.items === 4)).toHaveLength(ORGS);
    const written = h.db.find((item) => /^(EPOCH|SEALED#|SEALS#)/.test(String(item.pk)));
    expect(written.length).toBeGreaterThan(ORGS * 3);
    for (const item of written) expect(Buffer.byteLength(JSON.stringify(item), "utf8"), `${String(item.pk)} ${String(item.sk)}`).toBeLessThan(10 * 1024);
    // Every org's marker is gone.
    expect(h.db.find((item) => item.pk === "AUDIT_DIRTY")).toHaveLength(0);
  });

  it("finishes after a crash following 40 per-org finalizes: the other 110 are finalized, META and HEAD are written last, and objects are not rewritten", async () => {
    const h = harness();
    for (const org of orgs) appendRecords(h, org, 3);
    let finalizes = 0;
    h.hooks.before = (command) => {
      if (command.constructor.name !== "TransactWriteCommand") return;
      const items = command.input.TransactItems as Array<Record<string, { Item?: { pk?: string } }>>;
      if (items.some((entry) => entry.Put?.Item?.pk?.startsWith("SEALED#") === true)) {
        finalizes += 1;
        if (finalizes >= 41) throw crash();
      }
    };
    await expect(run(h, at(0))).rejects.toThrow("the process died");
    expect(orgs.filter((org) => stateOf(h, org) !== undefined)).toHaveLength(40);
    expect(metaOf(h, E0)).toMatchObject({ status: "frozen" });
    expect(epochHead(h)).toMatchObject({ openEpochId: E0 });
    const before = snapshot(h);
    const writesBefore = h.operations.length;

    h.hooks.before = undefined;
    h.clock.now = at(1);
    const result = await run(h, at(1));
    expect(result).toMatchObject({ status: "sealed" });
    expect(result.epochs).toStrictEqual([expect.objectContaining({ epochId: E0, status: "sealed", resumed: true })]);
    for (const org of orgs) expect(stateOf(h, org), org).toMatchObject({ sealedSeq: 3, lastEpochId: E0 });
    // Nothing in the bucket was written again: same versions, same bytes.
    expect(snapshot(h)).toStrictEqual(before);

    // The last write of the resume is the closing transaction: META `sealed` and HEAD together, after every org's finalize.
    const resumeWrites = h.transactions.filter((transaction) => transaction.operations.some((operation) => operation.table === SEALS));
    const closing = resumeWrites.at(-1)!;
    expect(closing.operations.map((operation) => operation.pk).sort()).toStrictEqual([`EPOCH#${E0}`, "EPOCH_HEAD"].sort());
    expect(resumeWrites.slice(0, -1).filter((transaction) => transaction.items === 4)).toHaveLength(ORGS);
    expect(h.operations.length).toBeGreaterThan(writesBefore);
    expect(metaOf(h, E0)).toMatchObject({ status: "sealed" });
    expect(epochHead(h)).toMatchObject({ epochId: E0 });
    expect(epochHead(h)).not.toHaveProperty("openEpochId");
  });
});

describe("C2: the dirty marker and the backstop", () => {
  it("keeps the marker when records are appended between the freeze and the finalize, and seals them next epoch with no further appends", async () => {
    const h = harness();
    appendRecords(h, A, 5);
    let appended = false;
    h.s3.before = (call) => {
      // The statement is written after every org is frozen and sealed, and before the finalize.
      if (call.command === "PutObject" && call.key === statementObjectKey(E0) && !appended) {
        appended = true;
        h.clock.now += 1000;
        appendRecords(h, A, 3);
      }
    };
    await run(h, at(0));
    expect(appended).toBe(true);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 5 });
    expect(markerOf(h, A)).toMatchObject({ lastSeq: 8 });
    // The transaction was retried without the marker's delete after that one condition failed.
    expect(h.transactions.filter((transaction) => transaction.operations.some((operation) => operation.action === "DeleteItem"))).toHaveLength(1);

    h.s3.before = undefined;
    h.clock.now = at(1);
    await run(h, at(1));
    expect(JSON.parse(h.s3.currentText(sealObjectKey(A, 6))!)).toMatchObject({ fromSeq: 6, toSeq: 8, epochId: E1 });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 8 });
    expect(markerOf(h, A)).toBeUndefined();
  });

  it("retries the finalize without the marker only when the marker was the one condition that failed", async () => {
    const h = harness();
    appendRecords(h, A, 5);
    appendRecords(h, B, 2);
    h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === statementObjectKey(E0)) appendRecords(h, B, 1);
    };
    await run(h, at(0));
    expect(markerOf(h, A)).toBeUndefined();
    expect(markerOf(h, B)).toMatchObject({ lastSeq: 3 });
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 2 });
  });

  it("retries a TransactionConflict on the finalize", async () => {
    const h = harness();
    appendRecords(h, A, 2);
    let conflicts = 0;
    h.hooks.before = (command) => {
      if (command.constructor.name !== "TransactWriteCommand") return;
      const items = command.input.TransactItems as Array<Record<string, { Item?: { pk?: string } }>>;
      if (items.some((entry) => entry.Put?.Item?.pk?.startsWith("SEALED#") === true) && conflicts < 2) {
        conflicts += 1;
        throw Object.assign(new Error("conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "None" }, { Code: "TransactionConflict" }] });
      }
    };
    await run(h, at(0));
    expect(conflicts).toBe(2);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 2 });
    expect(markerOf(h, A)).toBeUndefined();
  });

  describe("the hourly backstop", () => {
    /** An org with unsealed records, no marker, and a last seal at `sealedAtMs`. */
    function lostMarker(h: Harness, sealedAtMs: number) {
      appendRecords(h, A, 3);
      h.db.set({ pk: `SEALED#${A}`, sk: "STATE", sealedSeq: 3, lastFromSeq: 1, lastSealHash: "0".repeat(64), lastSealVersionId: "x", lastEpochId: E0, sealedAt: iso(sealedAtMs) });
      appendRecords(h, A, 2);
      h.db.delete({ pk: "AUDIT_DIRTY", sk: A });
    }

    it("re-marks an org whose marker was lost, at the first run of the hour, and seals it in that run", async () => {
      const h = harness();
      // The previous seal needs a real locked seal for the continuity check: seal for real first, then lose the marker.
      appendRecords(h, A, 3);
      await run(h, at(0));
      appendRecords(h, A, 2);
      h.db.delete({ pk: "AUDIT_DIRTY", sk: A });
      // Runs inside the same hour do not look (the backstop ran at the first run of the hour).
      for (const slot of [1, 2, 3]) {
        h.clock.now = at(slot);
        expect(await run(h, at(slot))).toMatchObject({ status: "idle" });
      }
      expect(eventsOf(h, "audit.backstop_marked")).toHaveLength(0);
      // The first run of the next hour: the last seal is 60 minutes old.
      h.clock.now = at(4);
      const result = await run(h, at(4));
      expect(eventsOf(h, "audit.backstop_marked")).toStrictEqual([expect.objectContaining({ orgId: A, headSeq: 5, sealedSeq: 3 })]);
      expect(result.status).toBe("sealed");
      expect(stateOf(h, A)).toMatchObject({ sealedSeq: 5 });
    });

    it("looks at an org only once its last seal is at least AUDIT_BACKSTOP_SEAL_AGE_MINUTES old", async () => {
      expect(AUDIT_BACKSTOP_SEAL_AGE_MINUTES).toBe(60);
      const h = harness();
      lostMarker(h, Date.parse("2026-10-20T12:01:00.000Z"));
      h.clock.now = Date.parse("2026-10-20T13:00:05.000Z");
      // Only 59 minutes and 5 seconds since the last seal.
      await run(h, h.clock.now);
      expect(markerOf(h, A)).toBeUndefined();
      expect(eventsOf(h, "audit.backstop_marked")).toHaveLength(0);
      h.clock.now = Date.parse("2026-10-20T14:00:05.000Z");
      await run(h, h.clock.now).catch(() => undefined);
      expect(eventsOf(h, "audit.backstop_marked")).toHaveLength(1);
    });

    it("pages through the org list once per hour, not at every run", async () => {
      const h = harness();
      appendRecords(h, A, 1);
      // The backstop pages through the whole list; the version sweep (Task 9) reads a bounded slice of it, with a Limit, every run.
      let reads = 0;
      h.hooks.before = (command) => {
        const values = command.input.ExpressionAttributeValues as Record<string, unknown> | undefined;
        if (command.constructor.name === "QueryCommand" && values?.[":pk"] === "AUDIT_ORGS" && command.input.Limit === undefined) reads += 1;
      };
      const orgListReads = () => reads;
      await run(h, at(0));
      expect(orgListReads()).toBe(1);
      for (const slot of [1, 2, 3]) {
        h.clock.now = at(slot);
        await run(h, at(slot));
      }
      expect(orgListReads()).toBe(1);
      h.clock.now = at(4);
      await run(h, at(4));
      expect(orgListReads()).toBe(2);
    });

    it("does not mark an org that is sealed, and does not touch a marker that is still there", async () => {
      const h = harness();
      appendRecords(h, A, 3);
      await run(h, at(0));
      h.clock.now = at(4);
      appendRecords(h, B, 2);
      await run(h, at(4));
      expect(eventsOf(h, "audit.backstop_marked")).toHaveLength(0);
    });
  });
});

describe("the size limit per org and epoch", () => {
  it("seals 10,000 records per epoch for an org with 25,000 new records, over three epochs", async () => {
    expect(AUDIT_MAX_RECORDS_PER_ORG_EPOCH).toBe(10000);
    const h = harness();
    appendRecords(h, A, 25000);
    for (const [slot, expected] of [[0, { fromSeq: 1, toSeq: 10000 }], [1, { fromSeq: 10001, toSeq: 20000 }], [2, { fromSeq: 20001, toSeq: 25000 }]] as const) {
      h.clock.now = at(slot);
      await run(h, at(slot));
      const seal = JSON.parse(h.s3.currentText(sealObjectKey(A, expected.fromSeq))!) as OrgSealV1;
      expect(seal).toMatchObject(expected);
      expect(stateOf(h, A)).toMatchObject({ sealedSeq: expected.toSeq });
      // The marker stays while records remain beyond this seal.
      if (slot < 2) expect(markerOf(h, A)).toMatchObject({ lastSeq: 25000 });
    }
    expect(markerOf(h, A)).toBeUndefined();
    const seals = [1, 10001, 20001].map((from) => JSON.parse(h.s3.currentText(sealObjectKey(A, from))!) as OrgSealV1);
    expect(seals[1]!.prevSealHash).toBe(sealHash(seals[0]!));
    expect(seals[2]!.prevSealHash).toBe(sealHash(seals[1]!));
    expect(checkChain(storedRecords(h, A), { seq: 0, hash: genesisHash(A), orgId: A })).toStrictEqual({ ok: true });
  }, 60_000);
});

describe("C3 (Review Focus 1): a rewrite cannot be sealed again", () => {
  /** Rewrites records `from` to `to` with a new fact and re-links them, as someone with table access could. */
  function rewrite(h: Harness, orgId: string, from: number, to: number): void {
    let prevHash = storedRecords(h, orgId)[from - 2]?.hash ?? genesisHash(orgId);
    for (let seq = from; seq <= to; seq += 1) {
      const stored = h.db.get(`AUDIT#${orgId}`, `SEQ#${pad12(seq)}`)!;
      const { pk, sk, sealedDetails, hash: _hash, ...rest } = stored;
      void _hash;
      const changed = { ...rest, facts: { n: seq, rewritten: true }, prevHash };
      const hash = recordHash(changed as unknown as AuditRecordV1);
      h.db.set({ pk, sk, sealedDetails, ...changed, hash });
      prevHash = hash;
    }
    h.db.set({ pk: `AUDIT#${orgId}`, sk: "HEAD", seq: to, hash: prevHash, updatedAt: iso(h.clock.now) });
  }

  it("fails the continuity check against the locked seal when the sealed state is wound back inside one seal", async () => {
    const h = harness();
    appendRecords(h, A, 20);
    await run(h, at(0));
    const locked = snapshot(h);
    const realState = stateOf(h, A)!;
    rewrite(h, A, 10, 20);
    // Sealed state wound back to seq 9 with the real seal's hash and version: the locked seal says it ends at 20.
    h.db.set({ ...realState, sealedSeq: 9 });
    h.db.set({ pk: "AUDIT_DIRTY", sk: A, since: 10, lastSeq: 20 });
    h.clock.now = at(1);
    const result = await run(h, at(1));
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A, reason: "locked_seal_end", level: "error" })]);
    expect(intentOf(h, E1, A)).toMatchObject({ skipped: "chain_mismatch", finalized: false });
    expect(result.epochs[0]).toMatchObject({ epochId: E1, orgs: 0, skipped: 1 });
    // Nothing was written to the bucket for the org, and its state did not move.
    const after = snapshot(h);
    expect(Object.keys(after).sort()).toStrictEqual([...Object.keys(locked), statementObjectKey(E1), leavesObjectKey(E1)].sort());
    for (const [key, versions] of Object.entries(locked)) expect(after[key], key).toStrictEqual(versions);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 9 });
    expect(markerOf(h, A)).toMatchObject({ lastSeq: 20 });
  });

  it("fails the continuity check when the record at the sealed seq no longer hashes to the locked head hash", async () => {
    const h = harness();
    appendRecords(h, A, 6);
    await run(h, at(0));
    appendRecords(h, A, 3);
    // Seq 6 is rewritten (and everything after it) while the state still says 6 are sealed.
    rewrite(h, A, 6, 9);
    h.clock.now = at(1);
    await run(h, at(1));
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A, reason: "locked_head_hash" })]);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 6 });
  });

  it("fails when the state names a seal hash the locked object does not have", async () => {
    const h = harness();
    appendRecords(h, A, 6);
    await run(h, at(0));
    h.db.set({ ...stateOf(h, A)!, lastSealHash: "f".repeat(64) });
    appendRecords(h, A, 1);
    h.clock.now = at(1);
    await run(h, at(1));
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A, reason: "locked_seal_hash" })]);
  });

  it("fails when the locked seal named by the state cannot be found", async () => {
    const h = harness();
    appendRecords(h, A, 6);
    await run(h, at(0));
    h.db.set({ ...stateOf(h, A)!, lastSealVersionId: "no-such-version" });
    appendRecords(h, A, 1);
    h.clock.now = at(1);
    await run(h, at(1));
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A, reason: "locked_seal_missing" })]);
  });

  it("does not seal again over a locked seal at the same start: a truthful wind-back is caught by the seal key (audit.version_drift) and skipped", async () => {
    const h = harness();
    appendRecords(h, A, 9);
    await run(h, at(0));
    appendRecords(h, A, 11);
    h.clock.now = at(1);
    await run(h, at(1));
    expect(JSON.parse(h.s3.currentText(sealObjectKey(A, 10))!)).toMatchObject({ fromSeq: 10, toSeq: 20 });
    const sealOne = h.db.get(`SEALS#${A}`, pad12(1))!;
    // Records 10 to 20 are rewritten, and the state is wound back to the real seal ending at 9, hash and version included.
    rewrite(h, A, 10, 20);
    const firstSeal = JSON.parse(h.s3.currentText(sealObjectKey(A, 1))!) as OrgSealV1;
    h.db.set({
      pk: `SEALED#${A}`, sk: "STATE", sealedSeq: 9, lastFromSeq: 1, lastSealHash: sealHash(firstSeal),
      lastSealVersionId: (sealOne.objects as { seal: LockedObjectV1 }).seal.versionId, lastEpochId: E0, sealedAt: iso(at(0)),
    });
    h.db.set({ pk: "AUDIT_DIRTY", sk: A, since: 10, lastSeq: 20 });
    const locked = snapshot(h);
    h.clock.now = at(2);
    const result = await run(h, at(2));
    // The continuity check passes (seal 1 is genuine), and the seal key at 10 holds a version with other bytes.
    expect(eventsOf(h, "audit.version_drift")).toStrictEqual([expect.objectContaining({ orgId: A, key: sealObjectKey(A, 10), level: "error" })]);
    expect(intentOf(h, E2, A)).toMatchObject({ skipped: "version_drift" });
    expect(result.status).toBe("sealed");
    expect(h.s3.versionsOf(sealObjectKey(A, 10))).toHaveLength(1);
    expect(snapshot(h)[sealObjectKey(A, 10)]).toStrictEqual(locked[sealObjectKey(A, 10)]);
    expect(snapshot(h)[recordsObjectKey(A, 10)]).toStrictEqual(locked[recordsObjectKey(A, 10)]);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 9 });
  });

  it("gets 412 with different bytes when a writer gets in between the check and the write: audit.object_conflict, and the run stops", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    appendRecords(h, B, 4);
    h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === sealObjectKey(A, 1)) h.s3.forceVersion(sealObjectKey(A, 1), '{"someone":"else"}');
    };
    const result = await run(h, at(0));
    expect(result).toMatchObject({ status: "stopped", reason: "object_conflict" });
    expect(eventsOf(h, "audit.object_conflict")).toStrictEqual([expect.objectContaining({ key: sealObjectKey(A, 1), level: "error" })]);
    expect(eventsOf(h, "audit.epoch_sealed")).toHaveLength(0);
    // Nothing was finalized, the epoch stays open, and the other org's seal was not finalized either.
    expect(stateOf(h, A)).toBeUndefined();
    expect(stateOf(h, B)).toBeUndefined();
    expect(metaOf(h, E0)).toMatchObject({ status: "frozen" });
    expect(epochHead(h)).toMatchObject({ openEpochId: E0 });
    expect(h.s3.currentText(sealObjectKey(A, 1))).toBe('{"someone":"else"}');
    // The next run resumes the same epoch. The key now holds a version with other bytes, which the pre-check sees: that
    // org is skipped (audit.version_drift, alarmed) and the epoch finishes for the others.
    h.s3.before = undefined;
    h.clock.now = at(1);
    const next = await run(h, at(1));
    expect(next.epochs[0]).toMatchObject({ epochId: E0, status: "sealed", resumed: true, orgs: 1, skipped: 1 });
    // The org is tried again in every epoch and alarms in each: E0 (resumed) and E1 (opened for the marker that remains).
    expect(eventsOf(h, "audit.version_drift")).toStrictEqual([
      expect.objectContaining({ orgId: A, epochId: E0, key: sealObjectKey(A, 1) }),
      expect.objectContaining({ orgId: A, epochId: E1, key: sealObjectKey(A, 1) }),
    ]);
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 4 });
    expect(stateOf(h, A)).toBeUndefined();
    expect(h.s3.currentText(sealObjectKey(A, 1))).toBe('{"someone":"else"}');
  });

  it("accepts a 412 whose stored bytes are identical to the bytes to write", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    let raced = false;
    h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === statementObjectKey(E0) && !raced) {
        raced = true;
        // A writer that built the same statement got in first.
        h.s3.forceVersion(statementObjectKey(E0), auditCanonicalJson(metaOf(h, E0)!.statement as EpochStatementV1));
      }
    };
    expect(await run(h, at(0))).toMatchObject({ status: "sealed" });
    expect(raced).toBe(true);
    expect(h.s3.versionsOf(statementObjectKey(E0))).toHaveLength(1);
    expect(h.s3.calls.filter((call) => call.command === "PutObject" && call.key === statementObjectKey(E0))).toHaveLength(1);
    expect(eventsOf(h, "audit.object_conflict")).toHaveLength(0);
  });
});

describe("R1-2: the seal key is never treated as empty when it is not", () => {
  it("treats one identical version as already written after a crash between the seal object and the intent", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    let died = false;
    h.hooks.before = (command) => {
      // The write that records the seal and its objects on the intent.
      if (command.constructor.name === "UpdateCommand" && String(command.input.UpdateExpression).includes("#seal") && !died) {
        died = true;
        throw crash();
      }
    };
    await expect(run(h, at(0))).rejects.toThrow("the process died");
    expect(h.s3.versionsOf(sealObjectKey(A, 1))).toHaveLength(1);
    expect(h.s3.versionsOf(recordsObjectKey(A, 1))).toHaveLength(1);
    expect(intentOf(h, E0, A)!.seal).toBeUndefined();
    const before = snapshot(h);

    h.hooks.before = undefined;
    h.clock.now = at(1);
    await run(h, at(1));
    expect(snapshot(h)[sealObjectKey(A, 1)]).toStrictEqual(before[sealObjectKey(A, 1)]);
    expect(eventsOf(h, "audit.version_drift")).toHaveLength(0);
    expect(intentOf(h, E0, A)).toMatchObject({ finalized: true });
    const sealVersion = h.s3.versionsOf(sealObjectKey(A, 1))[0]!;
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 4, lastSealVersionId: sealVersion.versionId });
  });

  it("raises audit.version_drift for a delete marker on the seal key and skips that org only", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    appendRecords(h, B, 4);
    h.s3.addDeleteMarker(sealObjectKey(A, 1));
    await run(h, at(0));
    expect(eventsOf(h, "audit.version_drift")).toStrictEqual([expect.objectContaining({ orgId: A, key: sealObjectKey(A, 1) })]);
    expect(intentOf(h, E0, A)).toMatchObject({ skipped: "version_drift", finalized: false });
    expect(stateOf(h, A)).toBeUndefined();
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 4 });
    expect(h.s3.versionsOf(sealObjectKey(A, 1))).toHaveLength(0);
    expect(h.s3.versionsOf(recordsObjectKey(A, 1))).toHaveLength(0);
    expect(markerOf(h, A)).toMatchObject({ lastSeq: 4 });
  });

  it("raises it for a delete marker after the genuine version, for a second version, and for one version with other bytes", async () => {
    for (const tamper of [
      (h: Harness, key: string) => h.s3.addDeleteMarker(key),
      (h: Harness, key: string) => { h.s3.forceVersion(key, '{"v":2}'); },
      (h: Harness, key: string) => { h.s3.versionsOf(key)[0]!.body = Buffer.from('{"other":true}'); },
    ]) {
      const h = harness();
      appendRecords(h, A, 4);
      // Write the genuine seal as a crashed run would have, then tamper with it.
      let died = false;
      h.hooks.before = (command) => {
        if (command.constructor.name === "UpdateCommand" && String(command.input.UpdateExpression).includes("#seal") && !died) { died = true; throw crash(); }
      };
      await expect(run(h, at(0))).rejects.toThrow("the process died");
      h.hooks.before = undefined;
      tamper(h, sealObjectKey(A, 1));
      h.clock.now = at(1);
      await run(h, at(1));
      // Once in the resumed epoch and once in the next one, which tries the org again.
      expect(eventsOf(h, "audit.version_drift").map((entry) => [entry.orgId, entry.epochId]), "drift").toStrictEqual([[A, E0], [A, E1]]);
      expect(stateOf(h, A)).toBeUndefined();
    }
  });
});

describe("a finalize the table refuses", () => {
  it("leaves the org's state alone, marks the intent blocked and alarms, while the epoch and the other orgs complete", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    appendRecords(h, B, 4);
    // Someone changes A's sealed state after its seal was written and before it is finalized.
    h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === statementObjectKey(E0)) h.db.set({ pk: `SEALED#${A}`, sk: "STATE", sealedSeq: 2, lastFromSeq: 1, lastSealHash: "a".repeat(64), lastSealVersionId: "v", lastEpochId: E0, sealedAt: iso(at(0)) });
    };
    const result = await run(h, at(0));
    expect(result.epochs[0]).toMatchObject({ epochId: E0, status: "sealed", orgs: 2, blocked: 1 });
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A, reason: "finalize_refused" })]);
    expect(intentOf(h, E0, A)).toMatchObject({ blocked: "chain_mismatch", finalized: false });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 2 });
    expect(h.db.get(`SEALS#${A}`, pad12(1))).toBeUndefined();
    expect(markerOf(h, A)).toMatchObject({ lastSeq: 4 });
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 4 });
    expect(metaOf(h, E0)).toMatchObject({ status: "sealed" });
    // Its seal is in the statement, which is why the epoch cannot leave it out.
    expect((metaOf(h, E0)!.statement as EpochStatementV1).sealCount).toBe(2);
  });
});

describe("finalize edge cases", () => {
  it("blocks an org whose sealed state moved between its seal and its finalize, when it has a seal before", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    await run(h, at(0));
    appendRecords(h, A, 2);
    h.clock.now = at(1);
    h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === statementObjectKey(E1)) h.db.set({ ...stateOf(h, A)!, sealedSeq: 2 });
    };
    await run(h, at(1));
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A, epochId: E1, reason: "finalize_refused" })]);
    expect(intentOf(h, E1, A)).toMatchObject({ blocked: "chain_mismatch", finalized: false });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 2 });
    expect(h.db.get(`SEALS#${A}`, pad12(5))).toBeUndefined();
  });

  it("treats an org whose finalize another run already committed as done, without an alarm", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    appendRecords(h, B, 4);
    let first = true;
    h.hooks.before = async (command) => {
      if (command.constructor.name !== "TransactWriteCommand" || !first) return;
      const items = command.input.TransactItems as Array<Record<string, { Item?: { pk?: string } }>>;
      if (items.some((entry) => entry.Put?.Item?.pk === `SEALED#${A}`)) {
        first = false;
        // A second run commits exactly this finalize first.
        await h.db.send(command);
      }
    };
    const result = await run(h, at(0));
    expect(first).toBe(false);
    expect(eventsOf(h, "audit.chain_mismatch")).toHaveLength(0);
    expect(result.epochs[0]).toMatchObject({ orgs: 2, blocked: 0 });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 4 });
    expect(metaOf(h, E0)).toMatchObject({ status: "sealed" });
  });

  it("does not clear a marker that an append moved past while the anchor was deciding it was stale", async () => {
    const h = harness();
    appendRecords(h, A, 2);
    await run(h, at(0));
    h.db.set({ pk: "AUDIT_DIRTY", sk: A, since: 1, lastSeq: 2 });
    let appended = false;
    h.hooks.before = (command) => {
      if (command.constructor.name === "DeleteCommand" && !appended) {
        appended = true;
        appendRecords(h, A, 1);
      }
    };
    h.clock.now = at(1);
    await run(h, at(1));
    expect(appended).toBe(true);
    expect(markerOf(h, A)).toMatchObject({ lastSeq: 3 });
    h.hooks.before = undefined;
    h.clock.now = at(2);
    await run(h, at(2));
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 3 });
    expect(markerOf(h, A)).toBeUndefined();
  });
});

describe("skipping an org that fails its checks (R1-3)", () => {
  it("skips an org whose range does not hash, keeps its marker, and counts only the leaves", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    appendRecords(h, B, 4);
    appendRecords(h, C, 4);
    // Record 3 of B is edited without being re-hashed.
    const stored = h.db.get(`AUDIT#${B}`, `SEQ#${pad12(3)}`)!;
    h.db.set({ ...stored, facts: { n: 3, edited: true } });
    const result = await run(h, at(0));
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: B, reason: "hash", seq: 3 })]);
    expect(intentOf(h, E0, B)).toMatchObject({ skipped: "chain_mismatch", finalized: false });
    expect(stateOf(h, B)).toBeUndefined();
    expect(markerOf(h, B)).toMatchObject({ lastSeq: 4 });
    expect(h.s3.versionsOf(recordsObjectKey(B, 1))).toHaveLength(0);
    // sealCount is the number of leaves.
    const statement = metaOf(h, E0)!.statement as EpochStatementV1;
    const leaves = (JSON.parse(h.s3.currentText(leavesObjectKey(E0))!) as { seals: OrgSealV1[] }).seals;
    expect(leaves.map((leaf) => leaf.orgId)).toStrictEqual([A, C]);
    expect(statement.sealCount).toBe(2);
    expect(statement.sealCount).toBe(leaves.length);
    expect(intentOf(h, E0, A)).toMatchObject({ index: { index: 0, size: 2 } });
    expect(intentOf(h, E0, C)).toMatchObject({ index: { index: 1, size: 2 } });
    expect(result.epochs[0]).toMatchObject({ orgs: 2, skipped: 1 });
    expect(eventsOf(h, "audit.epoch_sealed")).toStrictEqual([expect.objectContaining({ orgs: 2, skipped: 1 })]);
  });

  it("skips an org whose records are missing, and one whose range does not start where the state says", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    appendRecords(h, B, 4);
    h.db.delete({ pk: `AUDIT#${A}`, sk: `SEQ#${pad12(2)}` });
    await run(h, at(0));
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ orgId: A })]);
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 4 });
  });

  it("tries a skipped org again in the next epoch, and seals it once it is whole", async () => {
    const h = harness();
    appendRecords(h, A, 4);
    const stored = h.db.get(`AUDIT#${A}`, `SEQ#${pad12(3)}`)!;
    h.db.set({ ...stored, facts: { n: 3, edited: true } });
    await run(h, at(0));
    expect(stateOf(h, A)).toBeUndefined();
    h.db.set(stored);
    h.clock.now = at(1);
    await run(h, at(1));
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 4, lastEpochId: E1 });
  });
});

describe("the hand-off from Task 3: one statement per epoch id, and epochs only move forward", () => {
  it("resumes a crashed epoch to the same objects: one statement for the epoch id, and the next epoch chains to it", async () => {
    const h = harness();
    const orgs = ["a", "b", "c", "d", "e", "f"].map(orgOf);
    for (const org of orgs) appendRecords(h, org, 4);
    let seals = 0;
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key?.includes("/seals/") === true) {
        seals += 1;
        if (seals === 3) throw crash();
      }
    };
    await expect(run(h, at(0))).rejects.toThrow("the process died");
    expect(metaOf(h, E0)).toMatchObject({ status: "frozen" });
    expect(metaOf(h, E0)!.statement).toBeUndefined();
    const partial = snapshot(h);
    // Between the crash and the resume: an org of the epoch appends, and a new org becomes dirty.
    h.s3.after = undefined;
    h.clock.now = at(1);
    appendRecords(h, orgs[0]!, 2);
    appendRecords(h, orgOf("g"), 3);

    const result = await run(h, at(1));
    expect(result.epochs.map((epoch) => [epoch.epochId, epoch.status, epoch.resumed])).toStrictEqual([[E0, "sealed", true], [E1, "sealed", false]]);
    const first = metaOf(h, E0)!.statement as EpochStatementV1;
    // Exactly the six frozen orgs, not the one that appeared after; one statement object, equal to the chosen statement.
    expect(first.sealCount).toBe(6);
    expect(h.s3.versionsOf(statementObjectKey(E0))).toHaveLength(1);
    expect(h.s3.currentText(statementObjectKey(E0))).toBe(auditCanonicalJson(first));
    // Everything written before the crash is still there once, with its bytes.
    for (const [key, versions] of Object.entries(partial)) expect(snapshot(h)[key], key).toStrictEqual(versions);
    // The first org sealed 4 records in E0 (its toSeq was fixed at the freeze); the 2 appended later are in E1.
    expect(JSON.parse(h.s3.currentText(sealObjectKey(orgs[0]!, 1))!)).toMatchObject({ toSeq: 4, epochId: E0 });
    expect(JSON.parse(h.s3.currentText(sealObjectKey(orgs[0]!, 5))!)).toMatchObject({ fromSeq: 5, toSeq: 6, epochId: E1 });
    const second = metaOf(h, E1)!.statement as EpochStatementV1;
    expect(second).toMatchObject({ epochId: E1, prevEpochId: E0, prevStatementHash: statementHash(first), sealCount: 2 });
    expect(E1 > E0 && second.closedAt > first.closedAt).toBe(true);
    expect(eventsOf(h, "audit.epoch_sealed").map((entry) => entry.epochId)).toStrictEqual([E0, E1]);
  });

  it("resumes after a crash at every step with the same statement and the same objects", async () => {
    // Crash the n-th DynamoDB write or S3 put in turn, resume, and compare with a run that never crashed.
    const reference = harness();
    for (const org of [A, B]) appendRecords(reference, org, 3);
    await run(reference, at(0));
    const texts = (h: Harness) => Object.fromEntries(h.s3.keys().map((key) => [key, h.s3.currentText(key)]));
    const expected = texts(reference);
    const expectedStatement = metaOf(reference, E0)!.statement;

    for (const kind of ["dynamo", "s3"] as const) {
      for (let crashAt = 1; crashAt <= 40; crashAt += 1) {
        const h = harness();
        for (const org of [A, B]) appendRecords(h, org, 3);
        let writes = 0;
        const isWrite = (name: string) => ["PutCommand", "UpdateCommand", "TransactWriteCommand", "DeleteCommand"].includes(name);
        if (kind === "dynamo") {
          h.hooks.before = (command) => {
            if (isWrite(command.constructor.name)) {
              writes += 1;
              if (writes === crashAt) throw crash();
            }
          };
        } else {
          h.s3.after = (call) => {
            if (call.command === "PutObject") {
              writes += 1;
              if (writes === crashAt) throw crash();
            }
          };
        }
        let crashed = false;
        try {
          await run(h, at(0));
        } catch {
          crashed = true;
        }
        h.hooks.before = undefined;
        h.s3.after = undefined;
        if (!crashed) {
          // Past the last write: the run finished without the injected crash.
          expect(texts(h)).toStrictEqual(expected);
          break;
        }
        // The retry happens in the same slot, at the same instant: an epoch that was never opened is opened now.
        await run(h, at(0));
        expect(metaOf(h, E0), `${kind} ${String(crashAt)}`).toMatchObject({ status: "sealed", statement: expectedStatement });
        for (const key of h.s3.keys()) expect(h.s3.versionsOf(key), `${kind} ${String(crashAt)} ${key}`).toHaveLength(1);
        // Every object the uninterrupted run wrote has the same bytes now (the version ids differ).
        expect(texts(h), `${kind} ${String(crashAt)}`).toStrictEqual(expected);
        expect(stateOf(h, A), `${kind} ${String(crashAt)}`).toMatchObject({ sealedSeq: 3 });
        expect(stateOf(h, B), `${kind} ${String(crashAt)}`).toMatchObject({ sealedSeq: 3 });
      }
    }
  }, 60_000);

  it("opens one epoch for a slot even when two runs start at once", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    appendRecords(h, B, 3);
    const results = await Promise.all([run(h, at(0)), run(h, at(0))]);
    expect(results.map((result) => result.status).sort()).toStrictEqual(["idle", "sealed"]);
    expect(h.db.find((item) => item.sk === "META")).toHaveLength(1);
    expect(h.s3.versionsOf(statementObjectKey(E0))).toHaveLength(1);
    expect(metaOf(h, E0)).toMatchObject({ status: "sealed" });
  });

  it("opens no second epoch in a slot that already has one", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    await run(h, at(0));
    appendRecords(h, A, 1);
    h.clock.now = at(0) + 60_000;
    expect(await run(h, at(0) + 60_000)).toMatchObject({ status: "idle", reason: "slot_not_after_head" });
    expect(h.db.find((item) => item.sk === "META")).toHaveLength(1);
  });

  it("opens no epoch whose id is not later than the last one, or whose time is not later than the last close", async () => {
    // A clock that went backwards: the last epoch has a later id.
    const behind = harness();
    appendRecords(behind, A, 3);
    behind.db.set({ pk: "EPOCH_HEAD", sk: "HEAD", epochId: "e20261020T1215Z", statementHash: "1".repeat(64), closedAt: "2026-10-20T12:15:05.000Z" });
    expect(await run(behind, at(0))).toMatchObject({ status: "idle", reason: "slot_not_after_head" });
    expect(behind.db.find((item) => item.sk === "META")).toHaveLength(0);
    expect(epochHead(behind)).not.toHaveProperty("openEpochId");

    // An id that is later but a close time that is not (a doctored head): the opening transaction's own condition refuses.
    const odd = harness();
    appendRecords(odd, A, 3);
    odd.db.set({ pk: "EPOCH_HEAD", sk: "HEAD", epochId: "e20261020T1145Z", statementHash: "1".repeat(64), closedAt: "2026-10-20T12:30:00.000Z" });
    expect(await run(odd, at(0))).toMatchObject({ status: "idle" });
    expect(odd.db.find((item) => item.sk === "META")).toHaveLength(0);
    expect(epochHead(odd)).not.toHaveProperty("openEpochId");
  });

  it("refuses to open the epoch if the head moved since it was read", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    h.hooks.before = (command) => {
      // A competing run completes epoch 1145 just before this run's opening transaction.
      if (command.constructor.name === "TransactWriteCommand" && h.db.get("EPOCH_HEAD", "HEAD") === undefined) {
        h.db.set({ pk: "EPOCH_HEAD", sk: "HEAD", epochId: "e20261020T1145Z", statementHash: "1".repeat(64), closedAt: "2026-10-20T11:45:05.000Z" });
        h.hooks.before = undefined;
      }
    };
    expect(await run(h, at(0))).toMatchObject({ status: "idle" });
    expect(h.db.find((item) => item.sk === "META")).toHaveLength(0);
  });

  it("the opening transaction itself refuses a head that moved to a later id or a later close time since it was read", async () => {
    for (const moved of [
      // The same id, closed later than this run's clock says it is.
      { epochId: "e20261020T1200Z", closedAt: "2026-10-20T12:30:00.000Z" },
      // A later id, from a competing run.
      { epochId: "e20261020T1230Z", closedAt: "2026-10-20T12:30:00.000Z" },
      // A competing run that opened an epoch first.
      { openEpochId: "e20261020T1215Z" },
    ] as Array<Record<string, string>>) {
      const h = harness();
      appendRecords(h, A, 3);
      await run(h, at(0));
      appendRecords(h, A, 1);
      h.clock.now = at(1);
      let moves = 0;
      h.hooks.before = (command) => {
        // The opening transaction creates a META item; a competing run changes the head just before it.
        const items = command.constructor.name === "TransactWriteCommand" ? (command.input.TransactItems as Array<Record<string, { Item?: { sk?: string } }>>) : [];
        if (items.some((entry) => entry.Put?.Item?.sk === "META") && moves === 0) {
          moves += 1;
          h.db.set({ ...epochHead(h)!, ...moved });
        }
      };
      expect(await run(h, at(1)), JSON.stringify(moved)).toMatchObject({ status: "idle" });
      expect(moves).toBe(1);
      expect(metaOf(h, E1)).toBeUndefined();
      if (moved.openEpochId === undefined) expect(epochHead(h)).not.toHaveProperty("openEpochId");
      else expect(epochHead(h)).toMatchObject({ openEpochId: moved.openEpochId });
    }
  });

  it("never writes over an epoch item that exists, whatever the head says", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    await run(h, at(0));
    appendRecords(h, A, 1);
    // An item for the next slot's epoch exists (for example from a restore) while the head does not know it.
    const stray = { pk: `EPOCH#${E1}`, sk: "META", status: "sealed", closedAt: "2026-10-20T12:15:01.000Z", prevEpochId: E0, prevStatementHash: "1".repeat(64), createdAt: "x", statement: { v: 1, epochId: E1 } };
    h.db.set(stray);
    h.clock.now = at(1);
    expect(await run(h, at(1))).toMatchObject({ status: "idle", reason: "epoch_taken" });
    expect(metaOf(h, E1)).toStrictEqual(stray);
    expect(epochHead(h)).not.toHaveProperty("openEpochId");
  });

  it("stops, and writes no second statement, if the frozen seals no longer give the chosen statement", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    appendRecords(h, B, 3);
    // Crash right after the statement object is written.
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === statementObjectKey(E0)) throw crash();
    };
    await expect(run(h, at(0))).rejects.toThrow("the process died");
    expect(metaOf(h, E0)!.statement).toBeDefined();
    const chosen = h.s3.currentText(statementObjectKey(E0));
    // Someone edits an intent's seal in the table.
    const intent = intentOf(h, E0, A)!;
    h.db.set({ ...intent, seal: { ...(intent.seal as OrgSealV1), batchRoot: "9".repeat(64) } });
    h.s3.after = undefined;
    h.clock.now = at(1);
    const result = await run(h, at(1));
    expect(result).toMatchObject({ status: "stopped", reason: "statement_changed" });
    expect(eventsOf(h, "audit.chain_mismatch")).toStrictEqual([expect.objectContaining({ reason: "statement_changed", epochId: E0 })]);
    expect(h.s3.versionsOf(statementObjectKey(E0))).toHaveLength(1);
    expect(h.s3.currentText(statementObjectKey(E0))).toBe(chosen);
    expect(metaOf(h, E0)).toMatchObject({ status: "frozen" });
    expect(metaOf(h, E1)).toBeUndefined();
  });

  it("leaves no new epoch item when the resume fails, and finishes the epoch once the fault is gone", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === statementObjectKey(E0)) throw crash();
    };
    await expect(run(h, at(0))).rejects.toThrow("the process died");
    h.s3.after = undefined;
    appendRecords(h, B, 2);
    h.s3.before = (call) => {
      if (call.command === "ListObjectVersions") throw Object.assign(new Error("S3 is unavailable"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } });
    };
    h.clock.now = at(1);
    await expect(run(h, at(1))).rejects.toThrow("S3 is unavailable");
    expect(h.db.find((item) => item.sk === "META").map((item) => item.pk)).toStrictEqual([`EPOCH#${E0}`]);
    expect(epochHead(h)).toMatchObject({ openEpochId: E0 });
    expect(eventsOf(h, "audit.epoch_sealed")).toHaveLength(0);

    h.s3.before = undefined;
    h.clock.now = at(2);
    const result = await run(h, at(2));
    expect(result.epochs.map((epoch) => [epoch.epochId, epoch.status])).toStrictEqual([[E0, "sealed"], [E2, "sealed"]]);
    expect(stateOf(h, B)).toMatchObject({ sealedSeq: 2, lastEpochId: E2 });
  });
});

describe("what the anchor writes to S3 satisfies the bucket's rules", () => {
  it("refuses a PUT without a checksum, and without If-None-Match, as the bucket does", async () => {
    const h = harness();
    const send = (input: Record<string, unknown>) => h.s3.client.send(new PutObjectCommand({ Bucket: BUCKET, Key: "k", Body: "x", ...input }));
    await expect(send({ IfNoneMatch: "*" })).rejects.toMatchObject({ name: "InvalidRequest", $metadata: { httpStatusCode: 400 } });
    await expect(send({ ChecksumSHA256: createHash("sha256").update("x").digest("base64") })).rejects.toMatchObject({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    await expect(send({ IfNoneMatch: "*", ChecksumSHA256: "bad" })).rejects.toMatchObject({ name: "BadDigest" });
    await expect(send({ IfNoneMatch: "*", ChecksumSHA256: createHash("sha256").update("x").digest("base64"), ObjectLockMode: "GOVERNANCE", ObjectLockRetainUntilDate: new Date(START + 86_400_000) })).rejects.toMatchObject({ name: "AccessDenied" });
    await send({ IfNoneMatch: "*", ChecksumSHA256: createHash("sha256").update("x").digest("base64") });
    await expect(send({ IfNoneMatch: "*", ChecksumSHA256: createHash("sha256").update("x").digest("base64") })).rejects.toMatchObject({ name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
  });

  it("creates every object with If-None-Match: *, a SHA-256 checksum of its bytes and no retention of its own", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    await run(h, at(0));
    const puts = h.s3.putCalls();
    expect(puts).toHaveLength(4);
    for (const put of puts) {
      const input = put.input;
      expect(input.IfNoneMatch, put.key).toBe("*");
      expect(input.ChecksumSHA256, put.key).toBe(createHash("sha256").update(input.Body as string).digest("base64"));
      expect(input.ChecksumAlgorithm).toBe("SHA256");
      expect(input.Bucket).toBe(BUCKET);
      for (const field of ["ObjectLockMode", "ObjectLockRetainUntilDate", "ObjectLockLegalHoldStatus", "VersionId"]) expect(input, `${put.key} ${field}`).not.toHaveProperty(field);
    }
    // The helper the infrastructure test simulates the bucket policy with is what the anchor sends.
    expect(lockedPutInput(BUCKET, "k", "body", "application/json")).toMatchObject({ Bucket: BUCKET, Key: "k", IfNoneMatch: "*", ChecksumAlgorithm: "SHA256" });
  });

  it("builds its S3 client with checksums calculated whenever the operation supports them, and that client sends the header", async () => {
    expect(auditS3ClientConfig("us-west-2")).toMatchObject({ region: "us-west-2", requestChecksumCalculation: "WHEN_SUPPORTED" });
    const captured: Array<{ headers: Record<string, string>; method: string }> = [];
    const client = new S3Client({
      ...auditS3ClientConfig("us-west-2"),
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
      requestHandler: {
        handle: async (request: { headers: Record<string, string>; method: string }) => {
          captured.push({ headers: { ...request.headers }, method: request.method });
          return { response: { statusCode: 200, headers: { etag: '"abc"', "x-amz-version-id": "v1" }, body: undefined } };
        },
        updateHttpClientConfig: () => undefined,
        httpHandlerConfigs: () => ({}),
      } as never,
    });
    await client.send(new PutObjectCommand(lockedPutInput(BUCKET, "orgs/x/seals/000000000001.json", "{}", "application/json")));
    expect(captured).toHaveLength(1);
    const headers = Object.fromEntries(Object.entries(captured[0]!.headers).map(([name, value]) => [name.toLowerCase(), value]));
    expect(headers["if-none-match"]).toBe("*");
    expect(headers["x-amz-checksum-sha256"]).toBe(createHash("sha256").update("{}").digest("base64"));
    expect(captured[0]!.method).toBe("PUT");
  });

  for (const [name, retention] of [["production", { mode: "COMPLIANCE" as const, days: 1096 }], ["trial", { mode: "GOVERNANCE" as const, days: 1 }]] as const) {
    it(`takes the ${name} profile's retention from the bucket default, for every object`, async () => {
      const h = harness({ retention });
      appendRecords(h, A, 3);
      expect(await run(h, at(0))).toMatchObject({ status: "sealed" });
      for (const key of h.s3.keys()) {
        const version = h.s3.versionsOf(key)[0]!;
        expect(version.lockMode, key).toBe(retention.mode);
        expect(version.retainUntil - version.lastModified, key).toBe(retention.days * 86_400_000);
      }
      const objects = intentOf(h, E0, A)!.objects as { records: LockedObjectV1; seal: LockedObjectV1 };
      expect(objects.seal).toMatchObject({ lockMode: retention.mode, retainUntil: iso(at(0) + retention.days * 86_400_000) });
    });
  }

  it("stops, and says the lock is wrong, when an object comes back without retention", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    h.s3.after = (call) => {
      if (call.command === "PutObject" && call.key === sealObjectKey(A, 1)) {
        const version = h.s3.versionsOf(call.key)[0]!;
        (version as { lockMode: unknown }).lockMode = undefined;
      }
    };
    const result = await run(h, at(0));
    expect(result).toMatchObject({ status: "stopped", reason: "lock_config_mismatch" });
    expect(eventsOf(h, "audit.lock_config_mismatch")).toStrictEqual([expect.objectContaining({ key: sealObjectKey(A, 1) })]);
    expect(stateOf(h, A)).toBeUndefined();
  });
});

describe("the anchor's use of DynamoDB stays inside its grants", () => {
  it("writes the seals table freely, the ledger table only at AUDIT_DIRTY, and reads and deletes nothing else", async () => {
    const h = harness();
    for (const org of [A, B, C]) appendRecords(h, org, 3);
    h.db.set({ pk: "AUDIT_DIRTY", sk: orgOf("z"), since: 1, lastSeq: 0 });
    appendRecords(h, orgOf("y"), 2);
    h.db.delete({ pk: "AUDIT_DIRTY", sk: orgOf("y") });
    await run(h, at(0));
    h.clock.now = at(4);
    await run(h, at(4));

    const onLedger = h.operations.filter((operation) => operation.table === LEDGER);
    const onSeals = h.operations.filter((operation) => operation.table === SEALS);
    expect(new Set(onLedger.map((operation) => operation.action))).toStrictEqual(new Set(["GetItem", "Query", "DeleteItem", "PutItem"]));
    for (const operation of onLedger) {
      if (operation.action === "DeleteItem" || operation.action === "PutItem") expect(operation.pk, `${operation.action} ${operation.pk}`).toBe("AUDIT_DIRTY");
    }
    // Only the seals table's own partitions are ever written there, and only with actions the pinned policy names.
    expect(new Set(onSeals.map((operation) => operation.action))).toStrictEqual(new Set(["GetItem", "Query", "PutItem", "UpdateItem"]));
    for (const operation of onSeals) expect(operation.pk, operation.pk).toMatch(/^(EPOCH#|EPOCH_HEAD$|SEALED#|SEALS#|BACKSTOP$|AUDIT_LOCK$|AUDIT_SWEEP$)/);
    expect(h.operations.every((operation) => [LEDGER, SEALS].includes(operation.table))).toBe(true);
    // The appender's partitions are only ever read.
    for (const operation of onLedger.filter((entry) => entry.pk.startsWith("AUDIT#") || entry.pk === "AUDIT_ORGS")) expect(["GetItem", "Query"]).toContain(operation.action);
  });
});

describe("the Lambda entry point", () => {
  it("runs on the schedule's event and ignores any other", async () => {
    const h = harness();
    appendRecords(h, A, 2);
    expect(AUDIT_EPOCH_SOURCE).toBe("agentx.audit-epoch");
    expect(await handleAuditEpochEvent(h.deps, { source: "someone.else" }, at(0))).toStrictEqual({ status: "ignored" });
    expect(await handleAuditEpochEvent(h.deps, {}, at(0))).toStrictEqual({ status: "ignored" });
    expect(h.db.find((item) => item.sk === "META")).toHaveLength(0);
    expect(await handleAuditEpochEvent(h.deps, { source: AUDIT_EPOCH_SOURCE }, at(0))).toMatchObject({ status: "sealed" });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 2 });
  });
});

describe("what the run logs carries ids and counts, never record content", () => {
  it("logs the epoch, status and counts, and nothing from the records", async () => {
    const h = harness();
    appendRecords(h, A, 3);
    await run(h, at(0));
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain("pull_request");
    expect(text).not.toContain("dev_1");
    expect(eventsOf(h, "audit.epoch_sealed")[0]).toMatchObject({ epochId: E0, status: "sealed", orgs: 1, skipped: 0, blocked: 0, records: 3, resumed: false });
  });
});

describe("a 409 from S3 (another write to the key is in flight) is retried with a backoff (Task 8 carry-over)", () => {
  const conflict = () => Object.assign(new Error("A conflicting operation is in progress"), { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } });

  it("waits 25, 50 and 100 ms between the attempts and then writes the object once", async () => {
    const h = harness();
    appendRecords(h, A, 2);
    const waits: number[] = [];
    h.deps.sleep = async (ms) => { waits.push(ms); };
    let refused = 0;
    h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === sealObjectKey(A, 1) && refused < 3) {
        refused += 1;
        throw conflict();
      }
    };
    expect(await run(h, at(0))).toMatchObject({ status: "sealed" });
    expect(refused).toBe(3);
    expect(waits).toStrictEqual([25, 50, 100]);
    expect(h.s3.versionsOf(sealObjectKey(A, 1))).toHaveLength(1);
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 2 });
  });

  it("gives up after five retries and lets the error out (the run fails and the next one resumes)", async () => {
    const h = harness();
    appendRecords(h, A, 2);
    const waits: number[] = [];
    h.deps.sleep = async (ms) => { waits.push(ms); };
    h.s3.before = (call) => {
      if (call.command === "PutObject" && call.key === sealObjectKey(A, 1)) throw conflict();
    };
    await expect(run(h, at(0))).rejects.toMatchObject({ name: "ConditionalRequestConflict" });
    expect(waits).toStrictEqual([25, 50, 100, 200, 400]);
    h.s3.before = undefined;
    expect(await run(h, at(1))).toMatchObject({ status: "sealed" });
    expect(stateOf(h, A)).toMatchObject({ sealedSeq: 2 });
  });
});
