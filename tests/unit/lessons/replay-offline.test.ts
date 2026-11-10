// Lane 7 (DECISIONS 68; re-check "faithful B"): an arm's lessons built offline from the same historical tasks, with the REAL curator under the project's REAL settings, into a store that is nobody's live set. Only what is active
// and delivered WITHOUT a person under those rules is exported; the rest is counted. C refuses by name, and any builder must export by the same rule.
import { afterEach, describe, expect, it } from "vitest";
import { ReplayExportRuleError, ArmNotBuiltError, buildSnapshots, dayOf, type SnapshotBuilder } from "../../../packages/broker/src/lessons/replay-harness.js";
import { consolidatedBuilderStub, offlinePipelineBuilder } from "../../../packages/broker/src/lessons/replay-offline.js";
import { REPLAY_EXPORT_RULE, exportWithoutAPerson } from "../../../packages/broker/src/lessons/replay-export.js";
import { DEFAULT_APPROVAL_POLICY, setAutoApplyGate, setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { approvedForUse } from "../../../packages/broker/src/lessons/load.js";
import type { ReplayCandidate } from "../../../packages/broker/src/lessons/replay-select.js";
import { EVAL_SNAPSHOT_MAX_LESSONS } from "../../../packages/broker/src/lessons/replay-snapshot-store.js";
import { TRIAL_APPROVER } from "../../../packages/broker/src/lessons/trial.js";
import { ScriptedModel, KEY, WS, candidateJson, facts, lessonRecord, memberSpan, reply, subject, verifier } from "./lesson-helpers.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1);
const tasks: ReplayCandidate[] = Array.from({ length: 4 }, (_, i) => ({ taskId: `t${String(i)}`, project: "proj-1", repository: "api", at: T0 + i * DAY, memberCorrections: 2, outcome: "merged" as const }));
const comment = (n: number) => memberSpan(`Use withRetry for HTTP retries in api, not a hand-rolled loop (${String(n)}).`, { kind: "send_back", eventId: `ev-${String(n)}`, authorId: `rae-${String(n)}` });
const key = { workspaceId: WS, project: KEY.project };
const STANDARD_ON = { read: async () => ({ mode: "On" as const }) };

afterEach(() => { setLearnedLessonsGate(undefined); setAutoApplyGate(() => false); });

function setup(replies: Array<string | Error | { text: string; costUsd: number }>, over: Partial<Parameters<typeof offlinePipelineBuilder>[0]> = {}) {
  const model = new ScriptedModel(replies);
  const asked: string[] = [];
  const builder = offlinePipelineBuilder({
    key, model, repositories: ["api"], settings: STANDARD_ON, autoApply: true,
    subjectOf: async (taskId) => { asked.push(taskId); return taskId === "t2" ? undefined : subject([comment(Number(taskId.slice(1)))], { id: taskId, outcome: "merged" }); },
    ...over,
  });
  return { model, builder, asked };
}
const one = () => reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"] }));

describe("pipeline B, offline, under the project's real rules", () => {
  it("learns from each historical task once, in time order, only those before the day it builds for, and counts every model call", async () => {
    const w = setup([one(), one(), one(), one()]);
    const day0 = await w.builder.build({ pipeline: "current", day: dayOf(T0), learningCalls: "explicit", historical: [] });
    expect(day0.lessons).toEqual([]);
    expect(day0.export).toMatchObject({ rule: REPLAY_EXPORT_RULE, proposed: 0, needsPerson: 0 });
    expect(w.asked).toEqual([]);
    const day2 = await w.builder.build({ pipeline: "current", day: dayOf(T0 + 2 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(w.asked).toEqual(["t0", "t1"]);
    expect(day2.calls).toBeGreaterThanOrEqual(2);
    expect(day2.costUsd).toBeCloseTo((day2.calls ?? 0) * 0.01, 6);
    await w.builder.build({ pipeline: "current", day: dayOf(T0 + 4 * DAY), learningCalls: "explicit", historical: tasks });
    expect(w.asked).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("delivers only what the live curator makes active WITHOUT a person (a verified member correction goes live on trial) and counts the rest as needing a person", async () => {
    // With verified citations a member's correction goes live on trial under Standard + On + auto-apply; the same draft with nothing verifying it waits for a person.
    const verified = setup([one(), one()], { code: { verifier: verifier("valid"), facts: facts() } });
    const built = await verified.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(built.lessons.length).toBeGreaterThan(0);
    for (const lesson of built.lessons) {
      expect(lesson).toMatchObject({ workspaceId: WS, project: KEY.project, status: "active" });
      expect(lesson.approvals).toEqual([expect.objectContaining({ by: TRIAL_APPROVER, mode: "trial" })]); // no approval was made up
      expect(approvedForUse(lesson, DEFAULT_APPROVAL_POLICY, undefined, true)).toBe(true);
    }
    expect(built.export).toMatchObject({ rule: REPLAY_EXPORT_RULE, droppedCalls: 0 });
    expect(built.export.proposed).toBeGreaterThanOrEqual(built.lessons.length);
    const unverified = setup([one(), one()]);
    const waiting = await unverified.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(waiting.lessons).toEqual([]);
    expect(waiting.export.needsPerson).toBeGreaterThan(0);
    expect(waiting.export.needsPerson).toBe(waiting.export.proposed);
  });

  it("follows the project's real settings: a stricter preset or a mode that does not auto-apply delivers nothing without a person (and the install's auto-apply switch is passed on to the curator, which reads it for tier-0 auto approval only)", async () => {
    for (const [settings, autoApply] of [[{ mode: "On" as const, preset: "regulated" as const }, true], [{ mode: "Suggest" as const }, true]] as const) {
      const w = setup([one(), one()], { settings: { read: async () => settings }, autoApply, code: { verifier: verifier("valid"), facts: facts() } });
      const built = await w.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
      expect(built.lessons, JSON.stringify(settings)).toEqual([]);
      expect(built.export.proposed).toBeGreaterThan(0);
      expect(built.export.needsPerson).toBe(built.export.proposed);
    }
  });

  it("refuses to build for a project whose learning mode makes no lessons (an empty arm must not pass for a result), and puts the switches back", async () => {
    const w = setup([one()], { settings: { read: async () => ({ mode: "Collect" as const }) } });
    await expect(w.builder.build({ pipeline: "current", day: dayOf(T0 + DAY), learningCalls: "explicit", historical: tasks.slice(0, 1) })).rejects.toThrow(ArmNotBuiltError);
  });

  it("a task whose subject is a replay copy teaches nothing; a model that fails is counted as a dropped call, not hidden, and does not stop the build", async () => {
    const copy = setup([one()], { subjectOf: async (taskId) => subject([comment(1)], { id: taskId, evalRun: true }) });
    expect((await copy.builder.build({ pipeline: "current", day: dayOf(T0 + DAY), learningCalls: "explicit", historical: tasks.slice(0, 1) })).lessons).toEqual([]);
    const w = setup([new Error("model down"), "not json", new Error("again")]);
    const built = await w.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(built.lessons).toEqual([]);
    expect(built.export.droppedCalls).toBeGreaterThanOrEqual(1);
  });

  it("the harness imports what it builds under the id the install derives from the lessons, and reports proposed, needing a person and dropped calls per arm", async () => {
    const w = setup([one(), one(), one(), one()]);
    const built = await buildSnapshots({ key, tasks, arms: ["off", "on:current"], builders: { current: w.builder } });
    expect(Object.keys(built.snapshots["current"]!)).toEqual(tasks.map((t) => dayOf(t.at)));
    expect(Object.values(built.snapshots["current"]!).every((id) => /^snp_[0-9a-f]{20}$/u.test(id))).toBe(true);
    const cost = built.learning.find((c) => c.arm === "on:current")!;
    expect(cost.usd).toBeGreaterThan(0);
    expect(cost).toMatchObject({ truncated: 0, droppedCalls: 0 });
    expect(typeof cost.proposed).toBe("number");
    expect(typeof cost.needsPerson).toBe("number");
    expect(cost.proposed).toBeGreaterThan(0);
  });
});

describe("the one export rule (the port contract every arm, C included, goes through)", () => {
  const trial = (id: string, over = {}) => lessonRecord({ id, tier: 0, approvals: [{ approvalId: `t-${id}`, by: TRIAL_APPROVER, at: 1, mode: "trial" }], trial: { state: "trial", startedAt: 1 } as never, ...over });
  it("exports active lessons delivered without a person, counts pending, candidate and active-but-short-of-approvals as needing one, and never makes an approval up", () => {
    const person = lessonRecord({ id: "les_aaaaaaaaaaaaaaaaaa01", tier: 1, approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" }] });
    const short = lessonRecord({ id: "les_aaaaaaaaaaaaaaaaaa02", tier: 1, approvals: [] });
    const pending = lessonRecord({ id: "les_aaaaaaaaaaaaaaaaaa03", status: "pending", approvals: [] });
    const candidate = lessonRecord({ id: "les_aaaaaaaaaaaaaaaaaa04", status: "candidate", approvals: [] });
    const retired = lessonRecord({ id: "les_aaaaaaaaaaaaaaaaaa05", status: "retired" });
    const exported = exportWithoutAPerson({ lessons: [person, short, pending, candidate, retired, trial("les_aaaaaaaaaaaaaaaaaa06")], approval: DEFAULT_APPROVAL_POLICY, trialAllowed: true });
    expect(exported.lessons.map((l) => l.id).sort()).toEqual(["les_aaaaaaaaaaaaaaaaaa01", "les_aaaaaaaaaaaaaaaaaa06"]);
    expect(exported).toMatchObject({ rule: REPLAY_EXPORT_RULE, proposed: 5, needsPerson: 3, truncated: 0 });
    // A trial lesson is only delivered while the project's settings allow trials.
    expect(exportWithoutAPerson({ lessons: [trial("les_aaaaaaaaaaaaaaaaaa06")], approval: DEFAULT_APPROVAL_POLICY, trialAllowed: false })).toMatchObject({ lessons: [], needsPerson: 1 });
  });
  it("cuts at the snapshot cap and says how many it cut", () => {
    const many = Array.from({ length: EVAL_SNAPSHOT_MAX_LESSONS + 5 }, (_, i) => lessonRecord({ id: `les_${i.toString(16).padStart(20, "0")}`, tier: 1, createdAt: i, approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" }] }));
    const exported = exportWithoutAPerson({ lessons: many, approval: DEFAULT_APPROVAL_POLICY, trialAllowed: true });
    expect(exported.lessons).toHaveLength(EVAL_SNAPSHOT_MAX_LESSONS);
    expect(exported.truncated).toBe(5);
    expect(exported.lessons[0]!.createdAt).toBeGreaterThan(exported.lessons.at(-1)!.createdAt);
  });
  it("the harness checks the BEHAVIOUR of a builder's export, not its name: a builder that carries the rule's label but exports a made-up person approval, a pending lesson as active, or no label at all is refused; an honest one is accepted", async () => {
    const label = { rule: REPLAY_EXPORT_RULE, proposed: 1, needsPerson: 0, truncated: 0, droppedCalls: 0, unverified: 0, overrides: [] as string[] };
    const builderOf = (lessons: ReturnType<typeof lessonRecord>[], exportInfo: unknown = label): SnapshotBuilder => ({ build: async () => ({ snapshotId: "", lessons, costUsd: 0, calls: 0, export: exportInfo as never }) });
    const run = (builder: SnapshotBuilder) => buildSnapshots({ key, tasks, arms: ["off", "on:consolidated"], builders: { consolidated: builder } });
    const faked = lessonRecord({ id: "les_cccccccccccccccccc01", status: "active", tier: 1, approvals: [{ approvalId: "x", by: "offline-replay", at: 1, mode: "one" }] });
    const second = lessonRecord({ id: "les_cccccccccccccccccc02", status: "active", tier: 2, approvals: [{ approvalId: "x", by: "a", at: 1, mode: "second_person" }] });
    const exception = lessonRecord({ id: "les_cccccccccccccccccc03", status: "active", approvals: [{ approvalId: "x", by: "a", at: 1, mode: "sole_owner_exception" }] });
    const pendingAsActive = lessonRecord({ id: "les_cccccccccccccccccc04", status: "pending", approvals: [] });
    for (const bad of [faked, second, exception, pendingAsActive]) await expect(run(builderOf([bad])), bad.id).rejects.toThrow(ReplayExportRuleError);
    await expect(run(builderOf([], { ...label, rule: "approve-everything" }))).rejects.toThrow(ReplayExportRuleError);
    await expect(run({ build: async () => ({ snapshotId: "", lessons: [], costUsd: 0, calls: 0 }) } as unknown as SnapshotBuilder)).rejects.toThrow(ReplayExportRuleError);
    // An honest export: no lesson carries a person's approval (a trial lesson, or an automatic one).
    const trialLesson = lessonRecord({ id: "les_cccccccccccccccccc05", status: "active", tier: 0, approvals: [{ approvalId: "t", by: TRIAL_APPROVER, at: 1, mode: "trial" }] });
    const auto = lessonRecord({ id: "les_cccccccccccccccccc06", status: "active", tier: 0, approvals: [{ approvalId: "a", by: "system:auto", at: 1, mode: "auto" }] });
    await expect(run(builderOf([trialLesson, auto]))).resolves.toBeDefined();
    const e = exportWithoutAPerson({ lessons: [], approval: DEFAULT_APPROVAL_POLICY, trialAllowed: true });
    await expect(run(builderOf(e.lessons, { rule: e.rule, proposed: 0, needsPerson: 0, truncated: 0, droppedCalls: 0, unverified: 0, overrides: [] }))).resolves.toBeDefined();
  });
  it("counts the proposed lessons whose citations could not be verified (a clone that could not tell), under the live rule: they are kept out of the trial path and wait for a person", async () => {
    const unknown = setup([one(), one()], { code: { verifier: verifier("unknown"), facts: facts() } });
    const built = await unknown.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) });
    expect(built.lessons).toEqual([]);
    expect(built.export.needsPerson).toBe(built.export.proposed);
    expect(built.export.unverified).toBe(built.export.proposed);
    expect(built.export.unverified).toBeGreaterThan(0);
    const valid = setup([one(), one()], { code: { verifier: verifier("valid"), facts: facts() } });
    expect((await valid.builder.build({ pipeline: "current", day: dayOf(T0 + 3 * DAY), learningCalls: "explicit", historical: tasks.slice(0, 2) })).export.unverified).toBe(0);
  });
  it("states every override in force: no embedder, citations unchecked, the lessons switch assumed on, and the auto-apply switch as the install has it", async () => {
    const bare = setup([one()]);
    const a = await bare.builder.build({ pipeline: "current", day: dayOf(T0 + DAY), learningCalls: "explicit", historical: tasks.slice(0, 1) });
    expect(a.export.overrides).toEqual(expect.arrayContaining([expect.stringMatching(/no embedder/u), expect.stringMatching(/citations are not checked/u), expect.stringMatching(/lessons switch is assumed on/u), expect.stringMatching(/auto-apply switch is on/u)]));
    const full = setup([one()], { code: { verifier: verifier("valid"), facts: facts() }, autoApply: false });
    const b = await full.builder.build({ pipeline: "current", day: dayOf(T0 + DAY), learningCalls: "explicit", historical: tasks.slice(0, 1) });
    expect(b.export.overrides.some((o) => /citations are not checked/u.test(o))).toBe(false);
    expect(b.export.overrides).toEqual(expect.arrayContaining([expect.stringMatching(/auto-apply switch is off/u), expect.stringMatching(/lessons switch is assumed on/u)]));
    // The harness carries them to the arm's learning record (and so to the report).
    const built = await buildSnapshots({ key, tasks, arms: ["off", "on:current"], builders: { current: bare.builder } });
    expect(built.learning.find((c) => c.arm === "on:current")!.overrides).toEqual(expect.arrayContaining([expect.stringMatching(/no embedder/u)]));
  });
});

describe("pipeline C (lane 8)", () => {
  it("refuses by name until the consolidation pass exists", async () => {
    await expect(consolidatedBuilderStub.build({ pipeline: "consolidated", day: "2026-09-01", learningCalls: "explicit", historical: [] })).rejects.toThrow(ArmNotBuiltError);
  });
});
