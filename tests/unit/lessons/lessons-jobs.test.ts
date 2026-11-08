// Lessons in production, lane 2: the hourly resume of unfinished lesson deletions (WB-7) and the nightly re-reflection of reverted tasks, from the record's `rovara.reverted_by` link rows of the last 26 hours.
import { describe, expect, it, vi } from "vitest";
import { REVERT_WINDOW_MS, lessonsResumeJob, lessonsRevertJob, type LessonsJobDeps } from "../../../packages/broker/src/lessons/jobs.js";
import { revertedTasksSince } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, addSource, githubDraft, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { settings } from "./lesson-helpers.js";

const NOW = Date.parse("2026-11-08T03:17:00.000Z");
const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();
const link = (taskId: string, at: string, over: Record<string, unknown> = {}) => githubDraft({
  source: "rovara", kind: "rovara.reverted_by", repo: undefined, scope: "rovara:project/web", sourceRef: { system: "rovara", id: `task:${taskId}:reverted_by`, version: "1" }, audience: { kind: "project" }, trust: "member",
  actor: { sourceId: "dev-rita", developerId: "dev-rita", trust: "member" }, text: undefined, links: [], structured: { taskId }, occurredAt: at, ...over,
} as never);
async function setup(): Promise<World> {
  const w = world();
  await addSource(w, { source: "rovara", scope: "rovara:project/web", retention: "D" });
  return w;
}

describe("revertedTasksSince", () => {
  it("lists the tasks of the project's reverted_by rows of the window, once each, newest window only", async () => {
    const w = await setup();
    await w.sink.put(link("task-new", hoursAgo(2)));
    await w.sink.put(link("task-edge", hoursAgo(25.5)));
    await w.sink.put(link("task-old", hoursAgo(30)));
    await w.sink.put(link("task-new", hoursAgo(1), { sourceRef: { system: "rovara", id: "task:task-new:reverted_by", version: "2" } }));
    // Another kind of row in the window is not a revert link.
    await w.sink.put(link("task-other", hoursAgo(1), { kind: "rovara.send_back", sourceRef: { system: "rovara", id: "task:task-other:sendback:r1", version: "1" } }));
    const found = await revertedTasksSince(w.table, ORG_A, "web", NOW - REVERT_WINDOW_MS, { nowSeconds: NOW / 1000 });
    expect(found.taskIds.sort()).toEqual(["task-edge", "task-new"]);
    expect(found.truncated).toBe(false);
  });
  it("is the company's and the project's own: another company or project sees none of it", async () => {
    const w = await setup();
    await w.sink.put(link("task-a", hoursAgo(1)));
    expect((await revertedTasksSince(w.table, ORG_B, "web", NOW - REVERT_WINDOW_MS)).taskIds).toEqual([]);
    expect((await revertedTasksSince(w.table, ORG_A, "api", NOW - REVERT_WINDOW_MS)).taskIds).toEqual([]);
  });
  it("respects erasure: an erased reverter's row is gone, so the task is not listed from it", async () => {
    const w = await setup();
    await w.sink.put(link("task-a", hoursAgo(1)));
    await w.sink.put(link("task-b", hoursAgo(1), { actor: { sourceId: "dev-sam", developerId: "dev-sam", trust: "member" } }));
    expect((await revertedTasksSince(w.table, ORG_A, "web", NOW - REVERT_WINDOW_MS, { nowSeconds: NOW / 1000 })).taskIds.sort()).toEqual(["task-a", "task-b"]);
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-rita" }, "e1");
    expect((await revertedTasksSince(w.table, ORG_A, "web", NOW - REVERT_WINDOW_MS, { nowSeconds: NOW / 1000 })).taskIds).toEqual(["task-b"]);
  });
  it("says so when a project has more rows than the pages it may read", async () => {
    const w = await setup();
    await w.sink.put(link("task-a", hoursAgo(1)));
    expect((await revertedTasksSince(w.table, ORG_A, "web", NOW - REVERT_WINDOW_MS, { maxPages: 0 })).truncated).toBe(true);
  });
});

function jobDeps(w: World, over: Partial<LessonsJobDeps> = {}) {
  const sent: unknown[] = [];
  const logs: string[] = [];
  const deps: LessonsJobDeps = {
    table: w.table, settings: settings({ mode: "On" }), queue: { send: async (m) => { sent.push(m); } }, resumePending: async () => 0,
    now: () => NOW, newRequestId: () => "nightly-1", log: (event) => logs.push(event), ...over,
  };
  return { deps, sent, logs };
}

describe("the nightly re-reflection", () => {
  it("sends {outcome: reverted} per reverted task of the window to the same queue as a task's end: ids only, and the company is the job's, never a row's claim", async () => {
    const w = await setup();
    await w.sink.put(link("task-a", hoursAgo(3)));
    await w.sink.put(link("task-b", hoursAgo(20)));
    const { deps, sent } = jobDeps(w);
    expect(await lessonsRevertJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 2, revertFailures: 0 });
    expect((sent as Array<{ taskId: string }>).slice().sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual([
      { orgId: ORG_A, taskId: "task-a", outcome: "reverted", requestId: "nightly-1" },
      { orgId: ORG_A, taskId: "task-b", outcome: "reverted", requestId: "nightly-1" },
    ]);
  });
  it("a project whose learning is Off or Collect sends nothing; no queue sends nothing; one enqueue failure is counted and the rest go on", async () => {
    const w = await setup();
    await w.sink.put(link("task-a", hoursAgo(3)));
    await w.sink.put(link("task-b", hoursAgo(4)));
    for (const mode of ["Off", "Collect"] as const) {
      const off = jobDeps(w, { settings: settings({ mode }) });
      expect(await lessonsRevertJob(off.deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 0 });
      expect(off.sent).toEqual([]);
    }
    expect(await lessonsRevertJob(jobDeps(w, { queue: undefined }).deps, ORG_A, ["web"], 10_000)).toEqual({ revertsEnqueued: 0 });
    let first = true;
    const flaky = jobDeps(w, { queue: { send: async (m) => { if (first) { first = false; throw new Error("secret"); } flaky.sent.push(m); } } });
    const result = await lessonsRevertJob(flaky.deps, ORG_A, ["web"], 10_000);
    expect(result).toMatchObject({ revertsEnqueued: 1, revertFailures: 1 });
    expect(flaky.logs).toEqual(["lessons_job.enqueue_failed"]);
  });
  it("is bounded in time: with no time left no project is looked at", async () => {
    const w = await setup();
    await w.sink.put(link("task-a", hoursAgo(3)));
    let clock = NOW;
    const late = jobDeps(w, { now: () => (clock += 20_000) });
    expect(await lessonsRevertJob(late.deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertsEnqueued: 0 });
  });
});

describe("the hourly resume of unfinished lesson deletions", () => {
  it("resumes every project of the company whatever its learning mode (an erase must finish), counting what it finished", async () => {
    const w = await setup();
    const resume = vi.fn(async (_org: string, project: string) => (project === "web" ? 2 : 0));
    const { deps } = jobDeps(w, { resumePending: resume, settings: settings({ mode: "Off" }) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web", "api"], 10_000)).toEqual({ lessonDeletionsResumed: 2, lessonResumeFailures: 0, lessonResumeSkipped: 0 });
    expect(resume.mock.calls).toEqual([[ORG_A, "web"], [ORG_A, "api"]]);
  });
  it("one project failing is a fixed log line and the others still run", async () => {
    const w = await setup();
    const logs: string[] = [];
    const { deps } = jobDeps(w, { resumePending: async (_org, project) => { if (project === "web") throw new Error("secret"); return 1; }, log: (event) => logs.push(event) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web", "api"], 10_000)).toEqual({ lessonDeletionsResumed: 1, lessonResumeFailures: 1, lessonResumeSkipped: 0 });
    expect(logs).toEqual(["lessons_job.resume_failed"]);
  });
});
