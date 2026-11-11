// Proof and test environment E7: the "full suite pending" follow-up (state, bounds, the pull request's line, the merge card's rule).
import { describe, expect, it } from "vitest";
import { agentXError } from "@rovara-code/contracts";
import {
  FOLLOWUP_DAILY_CAP, FOLLOWUP_MAX_RUN_MS, followupLine, fullSuiteMergeGate, markFollowupRunning, needsFullSuiteFollowup, queueFullSuiteFollowup, readFollowup, recordFollowupResult, type FollowupDeps,
} from "../../packages/broker/src/rovara-code/full-suite-followup.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as const;
const PROJECT = "partner-service";
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
function setup() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const admitted: Array<Record<string, unknown>> = [];
  const admitError: { value: Error | undefined } = { value: undefined };
  const deps: FollowupDeps = { documentClient: db, tableName: "state", now: () => clock.now, admit: (input) => { admitted.push(input); return admitError.value === undefined ? Promise.resolve() : Promise.reject(admitError.value); } };
  const id = (digest = D1) => ({ orgId: ORG, project: PROJECT, taskId: "task-1", candidateDigest: digest });
  const queue = (digest = D1, head = H1, taskId = "task-1") => queueFullSuiteFollowup(deps, { orgId: ORG, project: PROJECT, taskId, candidateDigest: digest, headSha: head });
  const result = { passed: 1_238, failed: 2, total: 1_240, flaky: 2, finishedAt: "2026-11-05T11:00:00.000Z" };
  return { db, clock, deps, id, queue, result, admitted, admitError };
}

describe("when a follow-up is needed", () => {
  const fell = { method: "full" as const, fallbackReason: "map_stale" as const };
  it("only when selection fell back to the full suite and a test check did not finish", () => {
    expect(needsFullSuiteFollowup({ selection: fell, testChecks: [{ after: "not_run" }] })).toBe(true);
    expect(needsFullSuiteFollowup({ selection: fell, testChecks: [{ after: "timed_out" }] })).toBe(true);
    expect(needsFullSuiteFollowup({ selection: fell, testChecks: [{ after: "unknown" }] })).toBe(true);
    expect(needsFullSuiteFollowup({ selection: fell, testChecks: [{ after: "passed" }, { after: "failed" }] })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: { method: "full" }, testChecks: [{ after: "not_run" }] })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: { method: "coverage_map", fallbackReason: undefined }, testChecks: [{ after: "not_run" }] })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: undefined, testChecks: [{ after: "not_run" }] })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: fell, testChecks: [] })).toBe(false);
  });
});

describe("queueing", () => {
  it("queues once per task and commit; asking again is the same follow-up, also after it finished", async () => {
    const h = setup();
    expect(await h.queue()).toEqual({ queued: true, replayed: false });
    expect(await h.queue()).toEqual({ queued: true, replayed: true });
    expect(await readFollowup(h.deps, h.id())).toMatchObject({ state: "queued", candidateDigest: D1, headSha: H1 });
    await markFollowupRunning(h.deps, h.id());
    await recordFollowupResult(h.deps, { ...h.id(), result: h.result });
    expect(await h.queue()).toEqual({ queued: true, replayed: true });
    expect((await readFollowup(h.deps, h.id()))?.state).toBe("failed");
    expect(h.db.find((item) => String(item.sk).startsWith("FULLRUN#"))).toHaveLength(1);
  });
  it("charges the follow-up to the project's budget; a full budget queues nothing and the line says so; a fault is thrown", async () => {
    const h = setup();
    await h.queue();
    expect(h.admitted).toEqual([{ orgId: ORG, project: PROJECT, taskId: "task-1", purpose: "full_suite_followup" }]);
    h.admitError.value = agentXError("PROJECT_BUDGET_EXCEEDED", "used up");
    const refused = await h.queue(D2, H2, "task-2");
    expect(refused).toEqual({ queued: false, reason: "budget" });
    expect(await readFollowup(h.deps, { ...h.id(D2), taskId: "task-2" })).toBeUndefined();
    expect(followupLine(undefined, refused)).toContain("budget has no room");
    h.admitError.value = new Error("ledger down");
    await expect(h.queue(D2, H2, "task-3")).rejects.toThrow("ledger down");
    expect(h.db.find((item) => String(item.sk).includes("task-3"))).toHaveLength(0);
  });
  it("a replay of a follow-up already queued is not charged again", async () => {
    const h = setup();
    await h.queue();
    await h.queue();
    expect(h.admitted).toHaveLength(1);
  });
  it("refuses what is not a task, a commit and a digest", async () => {
    const h = setup();
    await expect(h.queue("short")).rejects.toThrow(/names a task/);
    await expect(h.queue(D1, "nope")).rejects.toThrow(/names a task/);
    await expect(h.queue(D1, H1, "bad id!")).rejects.toThrow(/names a task/);
  });
  it("is capped per project per day, and says 'not run' instead of 'pending' over the cap; a new day starts again", async () => {
    const h = setup();
    for (let index = 0; index < FOLLOWUP_DAILY_CAP; index += 1) expect((await h.queue(D1, H1, `task-${String(index)}`)).queued).toBe(true);
    const over = await h.queue(D1, H1, "task-over");
    expect(over).toEqual({ queued: false, reason: "daily_cap" });
    expect(await readFollowup(h.deps, { ...h.id(), taskId: "task-over" })).toBeUndefined();
    expect(followupLine(undefined, over)).toContain("daily limit");
    h.clock.now += 86_400_000;
    expect((await h.queue(D1, H1, "task-over")).queued).toBe(true);
  });
  it("a newer commit supersedes the older follow-up: its result is refused and it reads as superseded", async () => {
    const h = setup();
    await h.queue(D1, H1);
    await h.queue(D2, H2);
    expect(await recordFollowupResult(h.deps, { ...h.id(D1), result: h.result })).toBe(false);
    expect((await readFollowup(h.deps, h.id(D1)))?.state).toBe("superseded");
    expect(await recordFollowupResult(h.deps, { ...h.id(D2), result: { ...h.result, failed: 0, passed: 1_240, flaky: 0 } })).toBe(true);
    expect((await readFollowup(h.deps, h.id(D2)))?.state).toBe("passed");
  });
});

describe("results", () => {
  it("are accepted once, in order, and only while the follow-up waits", async () => {
    const h = setup();
    await h.queue();
    expect(await markFollowupRunning(h.deps, h.id())).toBe(true);
    expect(await markFollowupRunning(h.deps, h.id())).toBe(false);
    expect(await recordFollowupResult(h.deps, { ...h.id(), result: h.result })).toBe(true);
    expect(await recordFollowupResult(h.deps, { ...h.id(), result: { ...h.result, failed: 0, passed: 1_240 } })).toBe(false);
    expect((await readFollowup(h.deps, h.id()))).toMatchObject({ state: "failed", result: { failed: 2 } });
    expect(await markFollowupRunning(h.deps, h.id())).toBe(false);
  });
  it("may arrive without the worker having reported 'running' first", async () => {
    const h = setup();
    await h.queue();
    expect(await recordFollowupResult(h.deps, { ...h.id(), result: { ...h.result, failed: 0, passed: 1_240, flaky: 0 } })).toBe(true);
    expect((await readFollowup(h.deps, h.id()))?.state).toBe("passed");
  });
  it("are refused for a follow-up nobody queued, and when the counts do not add up", async () => {
    const h = setup();
    expect(await recordFollowupResult(h.deps, { ...h.id(), result: h.result })).toBe(false);
    await h.queue();
    for (const bad of [{ passed: 0, failed: 0, total: 0, flaky: 0, finishedAt: "2026-11-05T11:00:00.000Z" }, { ...h.result, total: 5 }, { ...h.result, passed: -1, total: 1 }, { ...h.result, flaky: 99_999 }, { ...h.result, finishedAt: "later" }, { ...h.result, passed: 1.5, total: 3.5 }]) {
      await expect(recordFollowupResult(h.deps, { ...h.id(), result: bad })).rejects.toThrow(/do not add up/);
    }
    expect((await readFollowup(h.deps, h.id()))?.state).toBe("queued");
  });
  it("one that never reports reads as expired, never passed", async () => {
    const h = setup();
    await h.queue();
    h.clock.now += FOLLOWUP_MAX_RUN_MS + 1;
    expect((await readFollowup(h.deps, h.id()))?.state).toBe("expired");
    const running = setup();
    await running.queue();
    running.clock.now += 3_600_000;
    await markFollowupRunning(running.deps, running.id());
    running.clock.now += FOLLOWUP_MAX_RUN_MS - 1000;
    expect((await readFollowup(running.deps, running.id()))?.state).toBe("running");
    running.clock.now += 2_000;
    expect((await readFollowup(running.deps, running.id()))?.state).toBe("expired");
  });
  it("a damaged stored item reads as no follow-up, never as passed", async () => {
    const h = setup();
    await h.queue();
    const stored = h.db.find((item) => String(item.sk).startsWith("FULLRUN#"))[0]!;
    h.db.set({ ...stored, state: "all-good" });
    expect(await readFollowup(h.deps, h.id())).toBeUndefined();
    h.db.set({ ...stored, headSha: 5 });
    expect(await readFollowup(h.deps, h.id())).toBeUndefined();
  });
});

describe("the pull request's line", () => {
  it("says pending, passed with counts, failed with counts, and what it could not do, in fixed words", async () => {
    const h = setup();
    expect(followupLine(undefined, undefined)).toBeUndefined();
    await h.queue();
    expect(followupLine(await readFollowup(h.deps, h.id()), { queued: true, replayed: false })).toBe("Full suite: pending. A full run on this commit is queued, and this section updates when it finishes.");
    await markFollowupRunning(h.deps, h.id());
    expect(followupLine(await readFollowup(h.deps, h.id()), undefined)).toContain("is running");
    await recordFollowupResult(h.deps, { ...h.id(), result: h.result });
    expect(followupLine(await readFollowup(h.deps, h.id()), undefined)).toBe("Full suite: failed on this commit (2 of 1,240 failing). See the task page for which.");
    const ok = setup();
    await ok.queue();
    await recordFollowupResult(ok.deps, { ...ok.id(), result: { passed: 1_240, failed: 0, total: 1_240, flaky: 2, finishedAt: "2026-11-05T11:00:00.000Z" } });
    expect(followupLine(await readFollowup(ok.deps, ok.id()), undefined)).toBe("Full suite: passed on this commit (1,240 of 1,240; 2 known flaky).");
    ok.clock.now += FOLLOWUP_MAX_RUN_MS * 2;
    const late = setup();
    await late.queue();
    late.clock.now += FOLLOWUP_MAX_RUN_MS + 5;
    expect(followupLine(await readFollowup(late.deps, late.id()), undefined)).toContain("did not report");
  });
});

describe("the merge card", () => {
  const view = (state: string) => ({ state, candidateDigest: D1, headSha: H1, queuedAt: "x" }) as never;
  it("pending: allowed on a medium card, or blocked when the company chose to wait; never lowers a higher card", () => {
    expect(fullSuiteMergeGate({ policy: "allow_pending", followup: view("running"), needed: true, baseRisk: "low" })).toEqual({ allowed: true, risk: "medium", reason: "pending" });
    expect(fullSuiteMergeGate({ policy: "block_until_passed", followup: view("queued"), needed: true, baseRisk: "low" })).toEqual({ allowed: false, risk: "medium", reason: "pending" });
    expect(fullSuiteMergeGate({ policy: "allow_pending", followup: view("queued"), needed: true, baseRisk: "high" })).toMatchObject({ risk: "high" });
  });
  it("failed: a high card and no merge from the card, whatever the policy", () => {
    for (const policy of ["allow_pending", "block_until_passed"] as const) expect(fullSuiteMergeGate({ policy, followup: view("failed"), needed: true, baseRisk: "low" })).toEqual({ allowed: false, risk: "high", reason: "failed" });
  });
  it("expired, superseded, or never queued is 'not run': medium, and blocked under the stricter policy", () => {
    for (const state of ["expired", "superseded", undefined]) {
      const followup = state === undefined ? undefined : view(state);
      expect(fullSuiteMergeGate({ policy: "allow_pending", followup, needed: true, baseRisk: "low" })).toEqual({ allowed: true, risk: "medium", reason: "not_run" });
      expect(fullSuiteMergeGate({ policy: "block_until_passed", followup, needed: true, baseRisk: "low" })).toMatchObject({ allowed: false, reason: "not_run" });
    }
  });
  it("passed or not needed adds nothing", () => {
    expect(fullSuiteMergeGate({ policy: "block_until_passed", followup: view("passed"), needed: true, baseRisk: "low" })).toEqual({ allowed: true, risk: "low", reason: "passed" });
    expect(fullSuiteMergeGate({ policy: "block_until_passed", followup: undefined, needed: false, baseRisk: "medium" })).toEqual({ allowed: true, risk: "medium", reason: "none_needed" });
  });
});
