// v1.2 learning loop (B6 round): the walk-resume job in the 5-minute settlement run. Spend settlement is a money job: the learning job runs AFTER every settlement job, has its own 3 s slice,
// is skipped (with a log line) unless that slice and a margin remain, and can never reduce what settlement itself is given. An open-walk entry goes only when its walk truly finishes, a
// walk that crashed is picked up again, and every tick logs ids and counts for each walk it ran.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clearOrgLearning, resumeOpenLearningWalks } from "../../packages/broker/src/learning/cleanup.js";
import { WALK_INDEX_PK } from "../../packages/broker/src/learning/walk.js";
import { LEARNING_SLICE_MARGIN_MS, SETTLEMENT_BUDGETS_MS, SETTLEMENT_TOTAL_LIMIT_MS, learningFirstTick, runSettlementJobs, settlementBudgets, timedSettlementJob } from "../../packages/broker/src/spend/settlement-job.js";
import { PROJECT_CREATED, makeWorld, seedCorrection, seedItem, seedProject, type World } from "../support/learning-world.js";
import { TEST_ORG } from "../support/orgs.js";

const indexItems = (world: World) => world.db.find((item) => item.pk === WALK_INDEX_PK);
function seedBig(world: World, project: string): void {
  seedProject(world.db, TEST_ORG, project);
  seedItem(world.db, TEST_ORG, project, "STATE", { projectCreatedAt: PROJECT_CREATED, revision: 1, openSuggestions: 0, liveCorrections: 4, pendingRules: 0 });
  for (let n = 0; n < 4; n += 1) seedCorrection(world.db, TEST_ORG, project, n);
}

describe("the learning slice of the settlement run", () => {
  it("is 3 s while the slice and the margin remain, and nothing once they do not", () => {
    expect(settlementBudgets(0).learning).toBe(SETTLEMENT_BUDGETS_MS.learning);
    expect(settlementBudgets(SETTLEMENT_TOTAL_LIMIT_MS - SETTLEMENT_BUDGETS_MS.learning - LEARNING_SLICE_MARGIN_MS).learning).toBe(3000);
    expect(settlementBudgets(SETTLEMENT_TOTAL_LIMIT_MS - SETTLEMENT_BUDGETS_MS.learning - LEARNING_SLICE_MARGIN_MS + 1).learning).toBe(0);
    expect(settlementBudgets(SETTLEMENT_TOTAL_LIMIT_MS + 5000).learning).toBe(0);
  });

  it("never changes what settlement's own jobs are given", () => {
    for (const elapsed of [0, 5_000, 12_000, 20_000, 23_000, 26_000]) {
      const budgets = settlementBudgets(elapsed);
      const left = Math.max(0, SETTLEMENT_TOTAL_LIMIT_MS - elapsed);
      expect(budgets.spend).toBe(Math.max(0, left - SETTLEMENT_BUDGETS_MS.audit));
      expect(budgets.audit).toBe(Math.min(SETTLEMENT_BUDGETS_MS.audit, left));
      expect(budgets.drain).toBe(Math.min(SETTLEMENT_BUDGETS_MS.drain, left));
    }
  });

  it("is skipped cleanly, with a log line, when settlement used most of the run, and settlement's result is unaffected", async () => {
    const clock = { now: 1_000_000 };
    const startedAt = clock.now;
    const skipped: string[] = [];
    let learningRan = false;
    const timed = (name: string, pick: Parameters<typeof timedSettlementJob>[0]["pick"], run: (budgetMs: number) => Promise<unknown>) =>
      timedSettlementJob({ name, pick, startedAt, now: () => clock.now, run, onSkip: (job) => skipped.push(job) });
    const reports = await runSettlementJobs([
      timed("sweep-spend", "spend", async (budgetMs) => { clock.now += 23_500; return { settled: 7, budgetMs }; }),
      timed("audit-model-keys", "audit", async () => ({ audited: 2 })),
      timed("resume-learning-walks", "learning", async () => { learningRan = true; return {}; }),
    ]);
    expect(reports[0]).toEqual({ name: "sweep-spend", ok: true, result: { settled: 7, budgetMs: SETTLEMENT_TOTAL_LIMIT_MS - SETTLEMENT_BUDGETS_MS.audit } });
    expect(reports[1]).toMatchObject({ name: "audit-model-keys", ok: true, result: { audited: 2 } });
    expect(reports[2]).toEqual({ name: "resume-learning-walks", ok: true, result: { skipped: "no time left in this run" } });
    expect(learningRan).toBe(false);
    expect(skipped).toEqual(["resume-learning-walks"]);
  });

  it("runs when the run was quick, with a slice of 3 s", async () => {
    const clock = { now: 5 };
    let given = 0;
    const [report] = await runSettlementJobs([timedSettlementJob({ name: "resume-learning-walks", pick: "learning", startedAt: 5, now: () => clock.now, run: async (budgetMs) => { given = budgetMs; return {}; } })]);
    expect(report).toMatchObject({ ok: true });
    expect(given).toBe(3000);
  });

  it("is in the broker's list of jobs AFTER every settlement job, including the key audit", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    const order = ["drain-member-merges", "expire-approvals", "escalate-owner-requests", "sweep-model-sources", "sweep-spend", "audit-model-keys", "resume-learning-walks"].map((name) => source.indexOf(`"${name}"`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(source).toMatch(/name: "resume-learning-walks", pick: "learning"/);
  });
});

describe("open walks", () => {
  it("keeps the entry of a walk that crashed, and the next tick picks it up and finishes it", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2", "p3"]) seedBig(world, name);
    world.db.injectFault({ command: "DeleteCommand", match: (input) => JSON.stringify(input).includes("PROJECT_LEARNING"), error: { name: "InternalServerError" } });
    await expect(clearOrgLearning(world.deps, TEST_ORG)).rejects.toMatchObject({ name: "InternalServerError" });
    expect(indexItems(world)).toEqual([expect.objectContaining({ orgId: TEST_ORG, kind: "close" })]);
    const logs: Array<Record<string, unknown>> = [];
    const report = await resumeOpenLearningWalks(world.deps, {}, (entry) => logs.push(entry));
    expect(report).toMatchObject({ walks: 1, done: 1, failed: 0 });
    expect(indexItems(world)).toEqual([]);
    expect(world.db.find((item) => String(item.pk).includes("PROJECT_LEARNING"))).toEqual([]);
    void logs;
  });

  it("removes the entry only when the walk truly finishes, never when it stops at its budget or fails", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2", "p3", "p4"]) seedBig(world, name);
    await clearOrgLearning(world.deps, TEST_ORG, { writes: 3 });
    for (let tick = 0; tick < 20; tick += 1) {
      const before = indexItems(world).length;
      const report = await resumeOpenLearningWalks(world.deps, { writes: 4 });
      if (report.done === 0) expect(indexItems(world)).toHaveLength(before);
      else { expect(indexItems(world)).toEqual([]); break; }
    }
    expect(indexItems(world)).toEqual([]);
    // A walk that fails inside the tick keeps its entry too.
    for (const name of ["q1", "q2"]) seedBig(world, name);
    await clearOrgLearning(world.deps, TEST_ORG, { writes: 2 });
    world.db.injectFault({ command: "DeleteCommand", match: (input) => JSON.stringify(input).includes("PROJECT_LEARNING"), error: { name: "InternalServerError" }, times: 100 });
    expect(await resumeOpenLearningWalks(world.deps)).toMatchObject({ failed: 1, done: 0 });
    expect(indexItems(world)).toHaveLength(1);
  });

  it("logs each tick's progress with ids and counts only", async () => {
    const world = makeWorld();
    for (const name of ["p1", "p2", "p3", "p4"]) seedBig(world, name);
    await clearOrgLearning(world.deps, TEST_ORG, { writes: 2 });
    const logs: Array<Record<string, unknown>> = [];
    await resumeOpenLearningWalks(world.deps, { writes: 3 }, (entry) => logs.push(entry));
    await resumeOpenLearningWalks(world.deps, {}, (entry) => logs.push(entry));
    const progress = logs.filter((entry) => entry.event === "learning.walk_progress");
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({ orgId: TEST_ORG, kind: "close", status: "running" });
    expect(progress[1]).toMatchObject({ orgId: TEST_ORG, kind: "close", status: "done" });
    expect(typeof progress[0]!.writes).toBe("number");
    expect(JSON.stringify(progress)).not.toMatch(/Use the shared retry helper/);
  });
});


// ---- B6 review fix I4: learning must make progress when every tick is busy, without taking time from spend settlement.
describe("the learning slice is not starved by busy ticks (I4)", () => {
  const TICK_MS = 300_000;
  const BASE = 1_760_000_000_000;

  /** One settlement run in broker.ts's order. `spendLateMs` is how far past its budget the spend sweep ends (it may end a little late). */
  async function run(tick: number, spendLateMs = 0) {
    const startedAt = BASE + tick * TICK_MS;
    const clock = { now: startedAt };
    const first = learningFirstTick(startedAt);
    const given: Record<string, number> = {};
    const timed = (name: string, pick: Parameters<typeof timedSettlementJob>[0]["pick"], work: (budgetMs: number) => Promise<unknown>) =>
      timedSettlementJob({ name, pick, startedAt, now: () => clock.now, run: work, ...(first ? { learningFirst: true } : {}) });
    await runSettlementJobs([
      timed("sweep-spend", "spend", async (budgetMs) => { given.spend = budgetMs; clock.now += budgetMs + spendLateMs; return {}; }),
      timed("audit-model-keys", "audit", async (budgetMs) => { given.audit = budgetMs; clock.now += budgetMs; return {}; }),
      timed("resume-learning-walks", "learning", async (budgetMs) => { given.learning = budgetMs; return {}; }),
    ]);
    return { first, given };
  }

  it("under steady load (spend always uses everything it is given) learning runs at least once in every 3 ticks", async () => {
    const ticks = [];
    for (let tick = 0; tick < 12; tick += 1) ticks.push({ tick, ...(await run(tick)) });
    const ran = ticks.filter((entry) => entry.given.learning !== undefined).map((entry) => entry.tick);
    expect(ran.length).toBeGreaterThanOrEqual(4);
    for (let tick = 0; tick + 2 < 12; tick += 1) expect(ran.some((at) => at >= tick && at <= tick + 2)).toBe(true);
    for (const entry of ticks.filter((one) => one.given.learning !== undefined)) expect(entry.given.learning).toBeGreaterThanOrEqual(1_000);
  });

  it("the spend sweep is given exactly the same on every tick: the slice comes out of the key audit's share", async () => {
    const ticks = [];
    for (let tick = 0; tick < 6; tick += 1) ticks.push(await run(tick));
    expect(ticks.some((entry) => entry.first)).toBe(true);
    expect(ticks.some((entry) => !entry.first)).toBe(true);
    for (const entry of ticks) expect(entry.given.spend).toBe(SETTLEMENT_TOTAL_LIMIT_MS - SETTLEMENT_BUDGETS_MS.audit);
    for (const entry of ticks.filter((one) => one.first)) expect(entry.given.audit).toBeUndefined();
    for (const entry of ticks.filter((one) => !one.first)) expect(entry.given.audit).toBe(SETTLEMENT_BUDGETS_MS.audit);
    for (const entry of ticks.filter((one) => !one.first)) expect(entry.given.learning).toBeUndefined();
  });

  it("the slice is cut short, never longer than the time left less the margin, when the spend sweep ended late; and none when too little is left", async () => {
    const late = (await run(0, 600)).given;
    const first = [0, 1, 2].find((tick) => learningFirstTick(BASE + tick * TICK_MS)) as number;
    const cut = (await run(first, 600)).given;
    expect(cut.learning).toBeGreaterThan(0);
    expect(cut.learning).toBeLessThanOrEqual(SETTLEMENT_BUDGETS_MS.learning);
    expect(cut.learning).toBeLessThanOrEqual(SETTLEMENT_BUDGETS_MS.audit - 600 - LEARNING_SLICE_MARGIN_MS);
    const none = (await run(first, 3_500)).given;
    expect(none.learning).toBeUndefined();
    void late;
  });

  it("the budgets table itself: spend, drain and the rest do not change with the priority; only audit and learning do", () => {
    for (const elapsed of [0, 8_000, 20_000]) {
      const plain = settlementBudgets(elapsed), priority = settlementBudgets(elapsed, { learningFirst: true });
      expect(priority.spend).toBe(plain.spend);
      expect(priority.drain).toBe(plain.drain);
      expect(priority.approvals).toBe(plain.approvals);
      expect(priority.audit).toBe(0);
    }
  });

  it("is wired in broker.ts for the key audit and the learning job, and a skipped learning job has its own event name", () => {
    const source = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(source).toMatch(/learningFirstTick\(startedAt\)/);
    const block = source.slice(source.indexOf('name: "resume-learning-walks"'), source.indexOf('name: "resume-learning-walks"') + 900);
    expect(block).toContain("learning.settlement_job_skipped");
    expect(block).not.toContain("spend.settlement_job_skipped");
  });
});
