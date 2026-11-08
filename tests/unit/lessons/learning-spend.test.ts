// Lessons in production, lane 1: the company's learning spend cap ($20 a month in Public, none of its own in Enterprise).
import { describe, expect, it } from "vitest";
import { PUBLIC_LEARNING_MONTHLY_CAP_USD, companyLearningSpend, learningMonthOf, learningSpendKey } from "../../../packages/broker/src/aws/broker/learning-spend.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { WS } from "./lesson-helpers.js";

const NOV = Date.UTC(2026, 10, 15, 12);
const DEC = Date.UTC(2026, 11, 1, 0, 0, 1);

function make(over: { edition?: "public" | "enterprise"; at?: { t: number }; cap?: number } = {}) {
  const db = new FakeDynamoDb();
  const clock = over.at ?? { t: NOV };
  const spend = companyLearningSpend({ documentClient: db, tableName: "state", edition: over.edition ?? "public", now: () => clock.t, ...(over.cap === undefined ? {} : { monthlyCapUsd: over.cap }) });
  const counter = (month = learningMonthOf(clock.t)) => db.get(learningSpendKey(WS, month)) as { spentUsd?: number; committedUsd?: number } | undefined;
  return { db, spend, clock, counter };
}

describe("Public: the monthly cap", () => {
  it("is $20, and a call is admitted while the month has room", async () => {
    expect(PUBLIC_LEARNING_MONTHLY_CAP_USD).toBe(20);
    const { spend, counter } = make();
    expect(await spend.admit(WS, 0.15)).toBe(true);
    expect(counter()?.committedUsd).toBeCloseTo(0.15, 6);
  });

  it("refuses at the cap: spent money counts, and what is held counts too", async () => {
    const { spend, counter } = make({ cap: 1 });
    expect(await spend.admit(WS, 0.6)).toBe(true);
    await spend.charge(WS, "proj-1", 0.6, "learning.reflect");
    expect(counter()?.spentUsd).toBeCloseTo(0.6, 6);
    expect(await spend.admit(WS, 0.5)).toBe(false);
    expect(await spend.admit(WS, 0.4)).toBe(true);
    // 1.0 is held or spent: a further call is refused, and nothing was added by the refusal.
    expect(await spend.admit(WS, 0.01)).toBe(false);
    expect(counter()?.committedUsd).toBeCloseTo(1, 6);
  });

  it("concurrent admits never take the month past the cap", async () => {
    const { spend, counter } = make({ cap: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, () => spend.admit(WS, 0.3)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(counter()?.committedUsd).toBeCloseTo(0.9, 6);
  });

  it("a charge settles the hold at the actual cost, and a failed call (cost 0) gives the whole hold back", async () => {
    const { spend, counter } = make({ cap: 1 });
    await spend.admit(WS, 0.5);
    await spend.charge(WS, "proj-1", 0.2, "learning.reflect");
    expect(counter()?.committedUsd).toBeCloseTo(0.2, 6);
    await spend.admit(WS, 0.5);
    await spend.charge(WS, "proj-1", 0, "learning.reflect");
    expect(counter()?.spentUsd).toBeCloseTo(0.2, 6);
    expect(counter()?.committedUsd).toBeCloseTo(0.2, 6);
    // A model that cost more than the estimate is counted at its cost.
    await spend.admit(WS, 0.1);
    await spend.charge(WS, "proj-1", 0.3, "learning.judge");
    expect(counter()?.spentUsd).toBeCloseTo(0.5, 6);
    expect(counter()?.committedUsd).toBeCloseTo(0.5, 6);
  });

  it("the cost is booked under the learning line: the company's ORG counter and a ledger line", async () => {
    const { db, spend } = make();
    await spend.admit(WS, 0.15);
    await spend.charge(WS, "proj-1", 0.07, "learning.reflect");
    const org = db.find((item) => item["entityType"] === "SPEND_COUNTER");
    expect(org).toHaveLength(1);
    expect(org[0]).toMatchObject({ spentUsd: 0.07, committedUsd: 0.07 });
    const lines = db.find((item) => item["entityType"] === "LEDGER");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ usd: 0.07, agentId: "learning", origin: "learning", project: "proj-1", orgId: WS });
    // A call that cost nothing writes no ledger line.
    await spend.admit(WS, 0.15);
    await spend.charge(WS, "proj-1", 0, "learning.reflect");
    expect(db.find((item) => item["entityType"] === "LEDGER")).toHaveLength(1);
  });

  it("a new UTC month starts at zero, and a hold is settled in the month it was made", async () => {
    const { spend, clock, counter } = make({ cap: 1 });
    expect(await spend.admit(WS, 1)).toBe(true);
    expect(await spend.admit(WS, 0.1)).toBe(false);
    clock.t = DEC;
    expect(await spend.admit(WS, 1)).toBe(true);
    expect(counter("2026-12")?.committedUsd).toBeCloseTo(1, 6);
    // The November call ends in December: its hold is settled in November's counter.
    await spend.charge(WS, "proj-1", 0.4, "learning.reflect");
    expect(counter("2026-11")?.spentUsd).toBeCloseTo(0.4, 6);
    expect(counter("2026-11")?.committedUsd).toBeCloseTo(0.4, 6);
    expect(counter("2026-12")?.committedUsd).toBeCloseTo(1, 6);
  });

  it("refuses what is not a company, a bad estimate, and anything it cannot record (fail closed)", async () => {
    const { spend, db } = make();
    expect(await spend.admit("not-an-org", 0.1)).toBe(false);
    expect(await spend.admit(WS, Number.NaN)).toBe(false);
    expect(await spend.admit(WS, -1)).toBe(false);
    expect(await spend.admit(WS, 21)).toBe(false);
    db.injectFault({ command: "UpdateCommand", error: { name: "InternalServerError" }, times: 1 });
    expect(await spend.admit(WS, 0.1)).toBe(false);
  });
});

describe("Enterprise: no cap of its own", () => {
  it("admits however much was spent (the company's existing budgets are checked where the key is made) and still records the spend", async () => {
    const { spend, counter, db } = make({ edition: "enterprise" });
    for (let call = 0; call < 5; call += 1) {
      expect(await spend.admit(WS, 15)).toBe(true);
      await spend.charge(WS, "proj-1", 12, "learning.reflect");
    }
    expect(counter()).toMatchObject({ spentUsd: 60 });
    expect(db.find((item) => item["entityType"] === "LEDGER")).toHaveLength(5);
    expect(await spend.admit("not-an-org", 1)).toBe(false);
  });
});
