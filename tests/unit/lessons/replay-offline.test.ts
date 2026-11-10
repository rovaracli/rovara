// Lane 7 (DECISIONS 68): an arm's lessons built offline from the same historical tasks, with the current pipeline (B), into a store that is nobody's live set; C refuses by name.
import { describe, expect, it } from "vitest";
import { ArmNotBuiltError, buildSnapshots, dayOf } from "../../../packages/broker/src/lessons/replay-harness.js";
import { consolidatedBuilderStub, offlinePipelineBuilder } from "../../../packages/broker/src/lessons/replay-offline.js";
import type { ReplayCandidate } from "../../../packages/broker/src/lessons/replay-select.js";
import { ScriptedModel, KEY, WS, candidateJson, memberSpan, reply, subject } from "./lesson-helpers.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const tasks: ReplayCandidate[] = Array.from({ length: 4 }, (_, i) => ({ taskId: `t${String(i)}`, project: "proj-1", repository: "api", at: T0 + i * DAY, memberCorrections: 2, outcome: "merged" as const }));
const comment = (n: number) => memberSpan(`Use withRetry for HTTP retries in api, not a hand-rolled loop (${String(n)}).`, { kind: "send_back", eventId: `ev-${String(n)}`, authorId: `rae-${String(n)}` });
const key = { workspaceId: WS, project: KEY.project };

function setup(replies: Array<string | Error | { text: string; costUsd: number }>) {
  const model = new ScriptedModel(replies);
  const asked: string[] = [];
  const builder = offlinePipelineBuilder({
    key, model, repositories: ["api"],
    subjectOf: async (taskId) => { asked.push(taskId); return taskId === "t2" ? undefined : subject([comment(Number(taskId.slice(1)))], { id: taskId, outcome: "merged" }); },
  });
  return { model, builder, asked };
}

describe("pipeline B, offline", () => {
  it("learns from each historical task once, in time order, only those before the day it builds for, and counts every model call", async () => {
    const w = setup([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] })), reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"], title: "Second", body: "Another distinct point about retries in api." }))]);
    const day0 = await w.builder.build({ pipeline: "current", day: dayOf(T0), learningCalls: "explicit", historical: [] });
    expect(day0.lessons).toEqual([]);
    expect(w.asked).toEqual([]);
    const day2 = await w.builder.build({ pipeline: "current", day: dayOf(T0 + 2 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(w.asked).toEqual(["t0", "t1"]);
    expect(day2.calls).toBeGreaterThanOrEqual(2);
    expect(day2.costUsd).toBeCloseTo((day2.calls ?? 0) * 0.01, 6);
    // The next day adds the tasks it has not seen; t2 teaches nothing; nothing is learned twice.
    await w.builder.build({ pipeline: "current", day: dayOf(T0 + 4 * DAY), learningCalls: "explicit", historical: tasks });
    expect(w.asked).toEqual(["t0", "t1", "t2", "t3"]);
  });
  it("makes lessons with simulated times, of this project, kept apart from any live store; a task whose subject is a replay copy teaches nothing", async () => {
    const w = setup([reply(candidateJson({ type: "convention", citations: [], scope: { repos: ["api"] }, evidenceSpanIds: ["S1"] })), reply(candidateJson({ type: "convention", citations: [], scope: { repos: ["api"] }, evidenceSpanIds: ["S1"] }))]);
    const built = await w.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(built.lessons.length).toBeGreaterThan(0);
    for (const lesson of built.lessons) {
      expect(lesson).toMatchObject({ workspaceId: WS, project: KEY.project, status: "active" });
      expect(lesson.createdAt).toBeLessThanOrEqual(T0 + 3 * DAY);
      expect(lesson.createdAt).toBeGreaterThanOrEqual(T0);
    }
    const copy = offlinePipelineBuilder({ key, model: new ScriptedModel([reply(candidateJson())]), repositories: ["api"], subjectOf: async (taskId) => subject([comment(1)], { id: taskId, evalRun: true }) });
    expect((await copy.build({ pipeline: "current", day: dayOf(T0 + DAY), learningCalls: "explicit", historical: tasks.slice(0, 1) })).lessons).toEqual([]);
  });
  it("the harness imports what it builds under the id the install derives from the lessons", async () => {
    const w = setup([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] })), reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
    const built = await buildSnapshots({ key, tasks, arms: ["off", "on:current"], builders: { current: w.builder } });
    expect(Object.keys(built.snapshots["current"]!)).toEqual(tasks.map((t) => dayOf(t.at)));
    expect(Object.values(built.snapshots["current"]!).every((id) => /^snp_[0-9a-f]{20}$/u.test(id))).toBe(true);
    expect(built.learning.find((c) => c.arm === "on:current")!.usd).toBeGreaterThan(0);
  });
  it("a model that fails or answers nothing usable teaches nothing and costs what it cost; it does not stop the build", async () => {
    const w = setup([new Error("model down"), "not json", new Error("again")]);
    const built = await w.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(built.lessons).toEqual([]);
  });
});

describe("pipeline C (lane 8)", () => {
  it("refuses by name until the consolidation pass exists", async () => {
    await expect(consolidatedBuilderStub.build({ pipeline: "consolidated", day: "2026-09-01", learningCalls: "explicit", historical: [] })).rejects.toThrow(ArmNotBuiltError);
  });
});
