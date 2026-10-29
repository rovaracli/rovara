import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { describe, expect, it } from "vitest";
import { decideSecondPersonApproval, secondPersonMembershipCondition, type ApprovalDecisionInput } from "../../packages/broker/src/org/second-person-approval.js";

const nowMs = Date.parse("2026-10-29T21:00:00Z");
const evidence = (): ApprovalDecisionInput => ({ proposerId: "owner", approverId: "admin", nowMs, complete: true, membershipVersion: 7, ownerIds: ["owner"], eligibleIds: ["owner", "admin"], lastEligibleLossAtMs: null });

describe("shared second-person approval decision", () => {
  it("accepts a distinct live eligible person", () => {
    expect(decideSecondPersonApproval(evidence())).toEqual({ mode: "second_person", membershipVersion: 7 });
  });
  it("refuses same-person approval even with different sessions when another approver exists", () => {
    expect(() => decideSecondPersonApproval({ ...evidence(), approverId: "owner" })).toThrow();
  });
  it("permits the sole owner only with a complete no-other-approver proof", () => {
    expect(decideSecondPersonApproval({ ...evidence(), approverId: "owner", eligibleIds: ["owner"] })).toEqual({ mode: "sole_owner_exception", membershipVersion: 7 });
  });
  it("refuses a sole admin or maintainer who is not the sole owner", () => {
    expect(() => decideSecondPersonApproval({ ...evidence(), proposerId: "admin", eligibleIds: ["admin"] })).toThrow();
  });
  it.each(["proposerId", "approverId"] as const)("refuses a revoked %s", (field) => {
    expect(() => decideSecondPersonApproval({ ...evidence(), [field]: "revoked" })).toThrow();
  });
  it("refuses incomplete enumeration even for distinct people", () => {
    expect(() => decideSecondPersonApproval({ ...evidence(), complete: false })).toThrow();
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses invalid membership generation %s", (membershipVersion) => {
    expect(() => decideSecondPersonApproval({ ...evidence(), membershipVersion })).toThrow();
  });
  it("refuses sole-owner approval during the full 24h cool-off", () => {
    expect(() => decideSecondPersonApproval({ ...evidence(), approverId: "owner", eligibleIds: ["owner"], lastEligibleLossAtMs: nowMs - 86_400_000 + 1 })).toThrow();
  });
  it("allows the exception exactly at the 24h boundary", () => {
    expect(decideSecondPersonApproval({ ...evidence(), approverId: "owner", eligibleIds: ["owner"], lastEligibleLossAtMs: nowMs - 86_400_000 }).mode).toBe("sole_owner_exception");
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, nowMs + 1])("refuses invalid or future eligibility-loss evidence %s", (lastEligibleLossAtMs) => {
    expect(() => decideSecondPersonApproval({ ...evidence(), approverId: "owner", eligibleIds: ["owner"], lastEligibleLossAtMs })).toThrow();
  });
  it("does not impose sole-owner cool-off on a distinct approver", () => {
    expect(decideSecondPersonApproval({ ...evidence(), lastEligibleLossAtMs: nowMs - 1 }).mode).toBe("second_person");
  });
  it("refuses ambiguous duplicate roster evidence", () => {
    expect(() => decideSecondPersonApproval({ ...evidence(), approverId: "owner", eligibleIds: ["owner", "owner"] })).toThrow();
  });
});


describe("shared refusal and commit fence interface", () => {
  it("uses a fixed FORBIDDEN refusal when the proposer approves their own widening", () => {
    expect(() => decideSecondPersonApproval({ ...evidence(), approverId: "owner" })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
  it.each(["generation", "closing", "closed"] as const)("refuses a commit after %s changed without applying its mutation", async (change) => {
    const db = new FakeDynamoDb();
    const key = { pk: "ORG#example", sk: "META" };
    db.set({ ...key, approvalMembershipVersion: change === "generation" ? 8 : 7, ...(change === "closing" ? { closingAt: "now" } : {}), ...(change === "closed" ? { closedAt: "now" } : {}) });
    await expect(db.send(new TransactWriteCommand({ TransactItems: [
      { ConditionCheck: { TableName: "T", Key: key, ...secondPersonMembershipCondition(7) } },
      { Put: { TableName: "T", Item: { pk: "CHANGE", sk: "RESULT", applied: true } } },
    ] }))).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(db.get({ pk: "CHANGE", sk: "RESULT" })).toBeUndefined();
  });
  it("refuses to build a fence from a missing or invalid generation", () => {
    expect(() => secondPersonMembershipCondition(Number.NaN)).toThrow(expect.objectContaining({ code: "CHANGE_STALE" }));
  });
});
