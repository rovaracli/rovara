import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { statementHash } from "../../packages/audit-verifier/src/index.js";
import { LockedEvidenceV1Schema, EpochProgressV1Schema } from "../../packages/cloud-server/src/audit-contracts-v1.js";

const time = "2026-11-19T00:00:00.000Z";
const hex = "a".repeat(64);
const statement = { v: 1 as const, epochId: "e20261119T0000Z", closedAt: time, prevEpochId: null, prevStatementHash: null, sealsRoot: hex, sealCount: 1 };
const digest = statementHash(statement);
const object = { key: `audit/epoch/${digest}`, versionId: "version-1", sha256: digest, writtenAt: time, lockMode: "COMPLIANCE", retainUntil: "2027-11-19T00:00:00.000Z" };
const epoch = { ...statement, kind: "epoch-progress", statementHash: digest, updatedAt: time };

describe("audit restart evidence consistency", () => {
  it("refuses the literal null S3 version", () => {
    expect(LockedEvidenceV1Schema.safeParse(object).success).toBe(true);
    expect(LockedEvidenceV1Schema.safeParse({ ...object, versionId: "null" }).success).toBe(false);
  });
  it("binds the fixed epoch fields to the existing statement hash", () => {
    expect(EpochProgressV1Schema.safeParse({ ...epoch, phase: "planned" }).success).toBe(true);
    expect(EpochProgressV1Schema.safeParse({ ...epoch, phase: "planned", statementHash: hex }).success).toBe(false);
    expect(EpochProgressV1Schema.safeParse({ ...epoch, phase: "planned", sealCount: 2 }).success).toBe(false);
  });
  it("resumes the exact canonical base64 timestamp bytes and their hash", () => {
    const tokenBase64 = Buffer.from("test-token").toString("base64");
    const tokenHash = createHash("sha256").update(Buffer.from(tokenBase64, "base64")).digest("hex");
    const progress = { ...epoch, phase: "timestamp-received", statement: object, tsaProvider: "freetsa", tokenBase64, tokenHash };
    expect(EpochProgressV1Schema.safeParse(progress).success).toBe(true);
    expect(EpochProgressV1Schema.safeParse({ ...progress, tokenHash: hex }).success).toBe(false);
    for (const invalid of ["abcde", "a===", "AA=A", "Zh=="]) {
      expect(EpochProgressV1Schema.safeParse({ ...progress, tokenBase64: invalid }).success).toBe(false);
    }
  });
});
