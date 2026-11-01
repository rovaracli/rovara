// Track record (v1.2 slice 1), the store: keys, idempotent samples, scoring held to `pending`, the scored copy, the rate read by score time, pagination and the cap.
import { describe, expect, it } from "vitest";
import {
  OUTCOME_READ_CAP, OUTCOME_SCORED_KEPT_DAYS, OutcomeSampleSchema, outcomeSampleKey, outcomeScoredKey,
  type OutcomeClaim, type OutcomeSample, type OutcomeStage,
} from "../../packages/contracts/src/index.js";
import { readOutcomeRate, recordOutcomeSample, scoreOutcomeSample, type OutcomeDependencies } from "../../packages/broker/src/rovara-code/outcomes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const day = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const TASK = "11111111-1111-4111-8111-111111111111";

function world(options: { sendFails?: boolean } = {}) {
  const db = new FakeDynamoDb();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const metrics: string[] = [];
  const calls: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
  const spying = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => { calls.push(command); return db.send(command); } };
  const ddb = options.sendFails === true ? { send: async () => { throw Object.assign(new Error("secret table text"), { name: "ProvisionedThroughputExceededException" }); } } : spying;
  const deps: OutcomeDependencies = { ddb, tableName: "State", log: (event, fields) => logs.push({ event, fields }), metric: (name) => metrics.push(name) };
  return { db, deps, logs, metrics, calls };
}

const stageOf = (claim: OutcomeClaim): OutcomeStage => (claim === "plan_ready" ? "plan_critic" : claim === "proves_change" ? "check" : claim === "risk_low" ? "risk" : "review");

function sample(over: Partial<OutcomeSample> & { claim?: OutcomeClaim } = {}): OutcomeSample {
  const claim = over.claim ?? "review_pass:CRITIC";
  return {
    orgId: TEST_ORG, project: "payments", stage: stageOf(claim), taskId: TASK, claim, round: "abcdef0123456789", state: "pending",
    agent: { id: "rovara-code", version: "3", digest: "d".repeat(64) }, model: "anthropic/claude-test", createdAt: day(10), ...over,
  };
}

const sampleItems = (db: FakeDynamoDb) => db.find((item) => String(item.pk).includes("#OUTCOME#"));
const scoredItems = (db: FakeDynamoDb) => db.find((item) => String(item.pk).includes("#OUTCOME_SCORED#"));

describe("track record keys", () => {
  it("builds the org-scoped sample key and the scored copy's key from the round and the time", () => {
    expect(outcomeSampleKey(TEST_ORG, "payments", "review", "2026-10-20T09:00:00.000Z", TASK, "review_pass:CRITIC", "abc123")).toEqual({
      pk: `ORG#${TEST_ORG}#OUTCOME#payments#review`, sk: `2026-10-20T09:00:00.000Z#${TASK}#review_pass:CRITIC#abc123` });
    expect(outcomeScoredKey(TEST_ORG, "payments", "review", "2026-10-25T09:00:00.000Z", TASK, "review_pass:CRITIC", "abc123")).toEqual({
      pk: `ORG#${TEST_ORG}#OUTCOME_SCORED#payments#review`, sk: `2026-10-25T09:00:00.000Z#${TASK}#review_pass:CRITIC#abc123` });
  });

  it("refuses a segment that holds the separator, so one segment is never read as two", () => {
    expect(() => outcomeSampleKey(TEST_ORG, "pay#ments", "review", day(1), TASK, "plan_ready", "1")).toThrow();
    expect(() => outcomeSampleKey(TEST_ORG, "payments", "review", day(1), TASK, "plan_ready", "1#2")).toThrow();
  });

  it("keeps the stage a claim belongs to, and a score time only on a scored sample", () => {
    expect(OutcomeSampleSchema.safeParse(sample()).success).toBe(true);
    expect(OutcomeSampleSchema.safeParse(sample({ stage: "check" })).success).toBe(false);
    expect(OutcomeSampleSchema.safeParse(sample({ scoredAt: day(1) })).success).toBe(false);
    expect(OutcomeSampleSchema.safeParse(sample({ state: "held" })).success).toBe(false);
  });
});

describe("recording a sample", () => {
  it("writes it once: the same claim in the same round of the same task is the same item, so a retry or a duplicate event never counts twice", async () => {
    const { db, deps, metrics } = world();
    const first = await recordOutcomeSample(deps, sample());
    const again = await recordOutcomeSample(deps, sample());
    expect(first.created).toBe(true);
    expect(again).toEqual({ key: first.key, created: false });
    expect(sampleItems(db)).toHaveLength(1);
    expect(sampleItems(db)[0]).toMatchObject({ ...first.key, state: "pending", claim: "review_pass:CRITIC", round: "abcdef0123456789", taskId: TASK, orgId: TEST_ORG });
    expect(metrics).toEqual([]);
  });

  it("gives a second round (another candidate, another plan revision) its own sample", async () => {
    const { db, deps } = world();
    await recordOutcomeSample(deps, sample({ round: "round-one" }));
    await recordOutcomeSample(deps, sample({ round: "round-two" }));
    await recordOutcomeSample(deps, sample({ claim: "plan_ready", round: "3" }));
    await recordOutcomeSample(deps, sample({ claim: "plan_ready", round: "5" }));
    expect(sampleItems(db)).toHaveLength(4);
  });

  it("keeps a pending sample a year at most, so one that is never scored still goes away", async () => {
    const { db, deps } = world();
    await recordOutcomeSample(deps, sample());
    expect(sampleItems(db)[0]!.indexExpiresAt).toBe(Math.floor((Date.parse(day(10)) + 365 * 86_400_000) / 1000));
  });

  it("writes a sample that is already scored (the plan check's, after the person's decision) with its copy, in one transaction", async () => {
    const { db, deps } = world();
    const made = await recordOutcomeSample(deps, sample({ claim: "plan_ready", round: "3", state: "held", reason: "plan_approved", scoredAt: day(1), createdAt: day(1) }));
    expect(made.created).toBe(true);
    expect(sampleItems(db)).toHaveLength(1);
    expect(scoredItems(db)).toHaveLength(1);
    expect(scoredItems(db)[0]).toMatchObject({ pk: `ORG#${TEST_ORG}#OUTCOME_SCORED#payments#plan_critic`, state: "held", reason: "plan_approved" });
    expect((await recordOutcomeSample(deps, sample({ claim: "plan_ready", round: "3", state: "held", reason: "plan_approved", scoredAt: day(1), createdAt: day(1) }))).created).toBe(false);
    expect(scoredItems(db)).toHaveLength(1);
  });

  it("never throws or blocks on a write failure: it logs a fixed code, counts a metric and says nothing was written", async () => {
    const { deps, logs, metrics } = world({ sendFails: true });
    const result = await recordOutcomeSample(deps, sample());
    expect(result.created).toBe(false);
    expect(metrics).toEqual(["OutcomeWriteFailed"]);
    expect(logs).toEqual([{ event: "outcomes.record_failed", fields: { error: "ProvisionedThroughputExceededException" } }]);
    expect(JSON.stringify(logs)).not.toContain("secret table text");
  });

  it("refuses a sample that does not fit the contract, without throwing", async () => {
    const { db, deps, metrics } = world();
    const result = await recordOutcomeSample(deps, { ...sample(), stage: "check" });
    expect(result.created).toBe(false);
    expect(metrics).toEqual(["OutcomeWriteFailed"]);
    expect(db.items.size).toBe(0);
  });
});

describe("scoring a sample", () => {
  it("scores a pending sample once, in one transaction with its scored copy", async () => {
    const { db, deps } = world();
    const { key } = await recordOutcomeSample(deps, sample());
    const scored = await scoreOutcomeSample(deps, key, { state: "held", reason: "merged_no_changes_requested", scoredAt: day(5), pr: { repositoryId: "repo", number: 7, mergeCommit: "a".repeat(40), mergedAt: day(5) } });
    expect(scored).toBe(true);
    expect(sampleItems(db)).toHaveLength(1);
    expect(sampleItems(db)[0]).toMatchObject({ ...key, state: "held", reason: "merged_no_changes_requested", scoredAt: day(5), pr: { repositoryId: "repo", number: 7, mergeCommit: "a".repeat(40), mergedAt: day(5) },
      indexExpiresAt: Math.floor((Date.parse(day(5)) + OUTCOME_SCORED_KEPT_DAYS * 86_400_000) / 1000) });
    const copies = scoredItems(db);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ pk: `ORG#${TEST_ORG}#OUTCOME_SCORED#payments#review`, sk: `${day(5)}#${TASK}#review_pass:CRITIC#abcdef0123456789`, state: "held", claim: "review_pass:CRITIC",
      indexExpiresAt: sampleItems(db)[0]!.indexExpiresAt, createdAt: day(10), scoredAt: day(5) });
  });

  it("holds the score to `pending`: the first score wins, a second changes nothing and writes no second copy", async () => {
    const { db, deps } = world();
    const { key } = await recordOutcomeSample(deps, sample());
    expect(await scoreOutcomeSample(deps, key, { state: "not_held", reason: "changes_requested_by_person", scoredAt: day(6) })).toBe(true);
    expect(await scoreOutcomeSample(deps, key, { state: "held", reason: "merged_no_changes_requested", scoredAt: day(2) })).toBe(false);
    expect(sampleItems(db)[0]).toMatchObject({ state: "not_held", scoredAt: day(6) });
    expect(scoredItems(db)).toHaveLength(1);
  });

  it("refuses a sample that is not there, and a lost race that scored it between the read and the write", async () => {
    const { db, deps } = world();
    const { key } = await recordOutcomeSample(deps, sample());
    expect(await scoreOutcomeSample(deps, outcomeSampleKey(TEST_ORG, "payments", "review", day(10), TASK, "review_pass:CRITIC", "other"), { state: "held", reason: "merged_no_changes_requested", scoredAt: day(1) })).toBe(false);
    // Another writer scores it after our read: the transaction's condition fails and nothing is written.
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }] }, times: 1 });
    expect(await scoreOutcomeSample(deps, key, { state: "held", reason: "merged_no_changes_requested", scoredAt: day(1) })).toBe(false);
    expect(sampleItems(db)[0]).toMatchObject({ state: "pending" });
    expect(scoredItems(db)).toHaveLength(0);
  });

  it("never throws on a write failure: it logs, counts and answers false", async () => {
    const { db, deps, metrics, logs } = world();
    const { key } = await recordOutcomeSample(deps, sample());
    db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" }, times: 1 });
    expect(await scoreOutcomeSample(deps, key, { state: "held", reason: "merged_no_changes_requested", scoredAt: day(1) })).toBe(false);
    expect(metrics).toEqual(["OutcomeWriteFailed"]);
    expect(logs[0]).toMatchObject({ event: "outcomes.score_failed" });
    expect(sampleItems(db)[0]).toMatchObject({ state: "pending" });
  });

  it("keeps the unreviewed-merge mark on the sample and its copy", async () => {
    const { db, deps } = world();
    const { key } = await recordOutcomeSample(deps, sample());
    await scoreOutcomeSample(deps, key, { state: "held", reason: "merged_without_person_review", scoredAt: day(1), unreviewedMerge: true });
    expect(sampleItems(db)[0]).toMatchObject({ unreviewedMerge: true });
    expect(scoredItems(db)[0]).toMatchObject({ unreviewedMerge: true });
  });
});

/** A scored sample and its copy, as scoring leaves them. */
async function scored(deps: OutcomeDependencies, input: { claim?: OutcomeClaim; round: string; state: "held" | "not_held" | "closed_unmerged" | "no_outcome"; createdAt: string; scoredAt: string; unreviewedMerge?: true; project?: string }) {
  const { key } = await recordOutcomeSample(deps, sample({ claim: input.claim ?? "review_pass:CRITIC", round: input.round, createdAt: input.createdAt, project: input.project ?? "payments" }));
  expect(await scoreOutcomeSample(deps, key, { state: input.state, reason: input.state === "held" ? "merged_no_changes_requested" : input.state === "not_held" ? "changes_requested_by_person" : input.state === "closed_unmerged" ? "closed_unmerged" : "task_closed", scoredAt: input.scoredAt, ...(input.unreviewedMerge === true ? { unreviewedMerge: true as const } : {}) })).toBe(true);
}
const rateOf = (deps: OutcomeDependencies, claim: OutcomeClaim = "review_pass:CRITIC", over: { project?: string } = {}) =>
  readOutcomeRate(deps, { org: TEST_ORG, project: over.project ?? "payments", stage: stageOf(claim), claim, now: NOW });

describe("the rate", () => {
  it("counts each bucket on its own, so closed-unmerged and no-outcome never vanish and an unreviewed merge is counted and shown", async () => {
    const { deps } = world();
    await scored(deps, { round: "r1", state: "held", createdAt: day(9), scoredAt: day(8) });
    await scored(deps, { round: "r2", state: "held", createdAt: day(9), scoredAt: day(7), unreviewedMerge: true });
    await scored(deps, { round: "r3", state: "not_held", createdAt: day(9), scoredAt: day(6) });
    await scored(deps, { round: "r4", state: "closed_unmerged", createdAt: day(9), scoredAt: day(5) });
    await scored(deps, { round: "r5", state: "no_outcome", createdAt: day(9), scoredAt: day(4) });
    await recordOutcomeSample(deps, sample({ round: "pending-one" }));
    expect(await rateOf(deps)).toEqual({ held: 2, notHeld: 1, closedUnmerged: 1, noOutcome: 1, unreviewedMerges: 1, capped: false, enough: false });
  });

  it("counts a sample made 90 days ago and scored 5 days ago, and leaves out one scored 31 days ago", async () => {
    const { deps } = world();
    await scored(deps, { round: "old-made", state: "held", createdAt: day(90), scoredAt: day(5) });
    await scored(deps, { round: "old-scored", state: "held", createdAt: day(60), scoredAt: day(31) });
    await scored(deps, { round: "edge", state: "not_held", createdAt: day(40), scoredAt: day(29.9) });
    expect(await rateOf(deps)).toMatchObject({ held: 1, notHeld: 1 });
  });

  it("keeps one claim apart from another claim of the same stage, one project from another, and one org from another", async () => {
    const { deps, db } = world();
    await scored(deps, { claim: "review_pass:CRITIC", round: "a", state: "held", createdAt: day(3), scoredAt: day(2) });
    await scored(deps, { claim: "review_pass:SECURITY", round: "a", state: "not_held", createdAt: day(3), scoredAt: day(2) });
    await scored(deps, { claim: "review_pass:CRITIC", round: "a", state: "held", createdAt: day(3), scoredAt: day(2), project: "other" });
    const scoredKey = outcomeScoredKey("org_aaaaaaaaaaaaaaaaaaaa", "payments", "review", day(2), TASK, "review_pass:CRITIC", "a");
    db.set({ ...scoredKey, entityType: "OUTCOME_SCORED", claim: "review_pass:CRITIC", state: "held" });
    expect(await rateOf(deps, "review_pass:CRITIC")).toMatchObject({ held: 1, notHeld: 0 });
    expect(await rateOf(deps, "review_pass:SECURITY")).toMatchObject({ held: 0, notHeld: 1 });
  });

  it("says there is enough history at ten held plus not-held samples, not before", async () => {
    const { deps } = world();
    for (let index = 0; index < 9; index += 1) await scored(deps, { round: `r${String(index)}`, state: index % 3 === 0 ? "not_held" : "held", createdAt: day(5), scoredAt: day(2) });
    expect(await rateOf(deps)).toMatchObject({ enough: false });
    await scored(deps, { round: "tenth", state: "held", createdAt: day(5), scoredAt: day(1) });
    expect(await rateOf(deps)).toMatchObject({ enough: true });
  });

  /** `count` scored copies, newest first by index, one hour apart, written straight into the table. */
  function seedCopies(db: FakeDynamoDb, count: number, state = "held") {
    for (let index = 0; index < count; index += 1) {
      const scoredAt = new Date(NOW - 3_600_000 - index * 1_000).toISOString();
      db.set({ ...outcomeScoredKey(TEST_ORG, "payments", "review", scoredAt, TASK, "review_pass:CRITIC", `r${String(index)}`), entityType: "OUTCOME_SCORED", claim: "review_pass:CRITIC", state: index % 2 === 0 ? state : "not_held" });
    }
  }
  const pageLimits = (calls: ReturnType<typeof world>["calls"]) => calls.filter((call) => call.constructor.name === "QueryCommand").map((call) => call.input.Limit);

  it("reads in pages of at most 500, newest first, until it has everything", async () => {
    const { db, deps, calls } = world();
    seedCopies(db, 1_200);
    const rate = await rateOf(deps);
    expect(rate).toMatchObject({ held: 600, notHeld: 600, capped: false });
    expect(pageLimits(calls)).toEqual([500, 500, 500]);
  });

  it("stops at 2000 items and says the figures are the latest ones, but not when there are exactly 2000", async () => {
    const exact = world();
    seedCopies(exact.db, OUTCOME_READ_CAP);
    expect(await rateOf(exact.deps)).toMatchObject({ held: 1_000, notHeld: 1_000, capped: false });

    const over = world();
    seedCopies(over.db, OUTCOME_READ_CAP + 150);
    const rate = await rateOf(over.deps);
    expect(rate.capped).toBe(true);
    expect(rate.held + rate.notHeld).toBe(OUTCOME_READ_CAP);
    expect(Math.max(...(pageLimits(over.calls) as number[]))).toBeLessThanOrEqual(500);
  });

  it("throws on a read failure: the card shows no record, never a zero", async () => {
    const { deps } = world({ sendFails: true });
    await expect(rateOf(deps)).rejects.toThrow();
  });
});
