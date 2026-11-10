// Lane 7: which past tasks the replay uses (DECISIONS 49): 40-60 tasks from repositories with many member corrections, chosen deterministically.
import { describe, expect, it } from "vitest";
import { selectReplayTasks, type ReplayCandidate } from "../../../packages/broker/src/lessons/replay-select.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
function pool(): ReplayCandidate[] {
  const out: ReplayCandidate[] = [];
  // Four correction-heavy repositories with 20 tasks each, two quiet ones with 20 tasks of 0-1 corrections.
  const heavy = ["api", "web", "infra", "billing"];
  for (const [r, repository] of heavy.entries()) for (let i = 0; i < 20; i += 1) out.push({ taskId: `${repository}-${String(i)}`, project: "p", repository, at: T0 + (r * 20 + i) * DAY / 4, memberCorrections: 2 + ((i * 7 + r) % 6), outcome: "merged" });
  for (const repository of ["docs", "tools"]) for (let i = 0; i < 20; i += 1) out.push({ taskId: `${repository}-${String(i)}`, project: "p", repository, at: T0 + i * DAY, memberCorrections: i % 2, outcome: "merged" });
  return out;
}

describe("selectReplayTasks", () => {
  it("takes the target number of tasks, from the repositories with the most corrections, and drops tasks nobody corrected", () => {
    const result = selectReplayTasks(pool(), { seed: "s1" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.tasks).toHaveLength(50);
    expect(result.tasks.every((t) => t.memberCorrections >= 1)).toBe(true);
    expect(new Set(result.tasks.map((t) => t.repository))).toEqual(new Set(["api", "web", "infra", "billing"]));
    expect(Math.max(...result.repositories.map((r) => r.tasks))).toBeLessThanOrEqual(15);
    expect(result.meanCorrections).toBeGreaterThan(result.poolMeanCorrections);
  });
  it("within a repository it takes the tasks with the most corrections first", () => {
    const result = selectReplayTasks(pool(), { seed: "s1", target: 40, perRepoMax: 10 });
    if (!result.ok) throw new Error(result.reason);
    const apiAll = pool().filter((t) => t.repository === "api").sort((a, b) => b.memberCorrections - a.memberCorrections);
    const apiTaken = result.tasks.filter((t) => t.repository === "api");
    expect(apiTaken).toHaveLength(10);
    expect(Math.min(...apiTaken.map((t) => t.memberCorrections))).toBeGreaterThanOrEqual(apiAll[9]!.memberCorrections);
  });
  it("is deterministic: the same pool and seed give the same tasks in any input order; another seed may break ties differently", () => {
    const a = selectReplayTasks(pool(), { seed: "s1" });
    const b = selectReplayTasks([...pool()].reverse(), { seed: "s1" });
    expect(b).toEqual(a);
    const ids = (seed: string): string => { const r = selectReplayTasks(pool(), { seed }); return r.ok ? r.tasks.map((t) => t.taskId).join() : ""; };
    expect(new Set(["s1", "s2", "s3", "s4", "s5"].map(ids)).size).toBeGreaterThan(1);
  });
  it("returns the tasks in the order they happened, because lessons build up in time order", () => {
    const result = selectReplayTasks(pool(), { seed: "s1" });
    if (!result.ok) throw new Error(result.reason);
    const times = result.tasks.map((t) => t.at);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });
  it("lifts the per-repository cap rather than return fewer than the target when the pool is concentrated", () => {
    const concentrated = pool().filter((t) => t.repository === "api" || t.repository === "web");
    const result = selectReplayTasks(concentrated, { seed: "s", target: 40 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.tasks).toHaveLength(40);
  });
  it("refuses a pool with fewer than 40 corrected tasks, a target outside 40-60, a repeated task id and a bad row", () => {
    expect(selectReplayTasks(pool().slice(0, 30), { seed: "s" })).toMatchObject({ ok: false, reason: "not_enough_tasks" });
    expect(selectReplayTasks(pool(), { seed: "s", target: 39 })).toMatchObject({ ok: false, reason: "target_out_of_range" });
    expect(selectReplayTasks(pool(), { seed: "s", target: 61 })).toMatchObject({ ok: false, reason: "target_out_of_range" });
    expect(selectReplayTasks([...pool(), pool()[0]!], { seed: "s" })).toMatchObject({ ok: false, reason: "duplicate_task" });
    expect(selectReplayTasks([{ ...pool()[0]!, memberCorrections: -1 }, ...pool()], { seed: "s" })).toMatchObject({ ok: false, reason: "bad_candidate" });
    expect(selectReplayTasks([{ ...pool()[0]!, at: Number.NaN }, ...pool()], { seed: "s" })).toMatchObject({ ok: false, reason: "bad_candidate" });
    expect(selectReplayTasks(pool(), { seed: "" })).toMatchObject({ ok: false, reason: "no_seed" });
  });
  it("a task that was never finished (no outcome) is not a past task", () => {
    const open = pool().map((t, i) => (i < 70 ? { ...t, outcome: "open" as never } : t));
    const result = selectReplayTasks(open, { seed: "s", target: 40 });
    expect(result).toMatchObject({ ok: false, reason: "not_enough_tasks" });
  });
});
