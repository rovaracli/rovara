// Lessons in production, lane 1: the company's learning spend cap ($20 a month in Public, none of its own in Enterprise). `admit` is a look at the month's `LEARNING` counter; the binding hold is the learning key's
// reservation in the spend ledger (tests/contract/learning-customer-model.test.ts and tests/contract/spend-ledger.test.ts).
import { describe, expect, it } from "vitest";
import { spendCounterKey } from "@agentx/contracts";
import { LEARNING_COUNTER, PUBLIC_LEARNING_MONTHLY_CAP_USD, companyLearningSpend, learningMonthOf, learningMonthlyCapUsd } from "../../../packages/broker/src/aws/broker/learning-spend.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { WS } from "./lesson-helpers.js";

const NOV = Date.UTC(2026, 10, 15, 12);
const DEC = Date.UTC(2026, 11, 1, 0, 0, 1);

function make(over: { edition?: "public" | "enterprise"; at?: { t: number }; cap?: number } = {}) {
  const db = new FakeDynamoDb();
  const clock = over.at ?? { t: NOV };
  const spend = companyLearningSpend({ documentClient: db, tableName: "state", edition: over.edition ?? "public", now: () => clock.t, ...(over.cap === undefined ? {} : { monthlyCapUsd: over.cap }) });
  const seed = (committedUsd: number, month = learningMonthOf(clock.t)) => db.set({ ...spendCounterKey(WS, month, LEARNING_COUNTER), entityType: "SPEND_COUNTER", spentUsd: 0, committedUsd });
  return { db, spend, clock, seed };
}

describe("Public: the monthly cap", () => {
  it("is $20, and a call is admitted while the month has room", async () => {
    expect(PUBLIC_LEARNING_MONTHLY_CAP_USD).toBe(20);
    expect(learningMonthlyCapUsd("public")).toBe(20);
    const { spend, db } = make();
    expect(await spend.admit(WS, 0.15)).toBe(true);
    // The look writes nothing and holds nothing: there is no hold to leak.
    expect(db.commandNames().every((name) => name === "GetCommand")).toBe(true);
  });

  it("refuses when what is spent plus what open keys hold leaves less than the estimate, and admits the exact fit", async () => {
    const { spend, seed } = make({ cap: 1 });
    seed(0.6);
    expect(await spend.admit(WS, 0.5)).toBe(false);
    expect(await spend.admit(WS, 0.4)).toBe(true);
    seed(1);
    expect(await spend.admit(WS, 0.01)).toBe(false);
  });

  it("a new UTC month starts at zero", async () => {
    const { spend, seed, clock } = make({ cap: 1 });
    seed(1);
    expect(await spend.admit(WS, 1)).toBe(false);
    clock.t = DEC;
    expect(await spend.admit(WS, 1)).toBe(true);
  });

  it("refuses an estimate over the whole cap, what is not a company, a bad estimate, and anything it cannot read (fail closed)", async () => {
    const { spend, db } = make({ cap: 1 });
    expect(await spend.admit(WS, 1.01)).toBe(false);
    expect(await spend.admit("not-an-org", 0.1)).toBe(false);
    expect(await spend.admit(WS, Number.NaN)).toBe(false);
    expect(await spend.admit(WS, -1)).toBe(false);
    db.injectFault({ command: "GetCommand", error: { name: "ProvisionedThroughputExceededException" } });
    expect(await spend.admit(WS, 0.1)).toBe(false);
  });
});

describe("Enterprise: no cap of its own", () => {
  it("admits however much the month holds (the company's org and project budgets bind the call where its key is reserved)", async () => {
    const { spend, seed } = make({ edition: "enterprise" });
    expect(learningMonthlyCapUsd("enterprise")).toBeUndefined();
    seed(500);
    expect(await spend.admit(WS, 5)).toBe(true);
    expect(await spend.admit("not-an-org", 0.1)).toBe(false);
  });
});
