// Lessons in production, lane 2: the hourly resume of unfinished lesson deletions (WB-7) and the nightly re-reflection of reverted tasks, from the record's `rovara.reverted_by` link rows of the last 26 hours.
import { describe, expect, it, vi } from "vitest";
import { REVERT_WINDOW_MS, lessonsExpireJob, lessonsNightlyJob, lessonsPromoteJob, lessonsResumeJob, lessonsRevertJob, type LessonsJobDeps } from "../../../packages/broker/src/lessons/jobs.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { TRIAL_APPROVER, TRIAL_STABLE_AFTER_DAYS } from "../../../packages/broker/src/lessons/trial.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { revertedTasksSince } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { ORG_A, ORG_B, addSource, githubDraft, world, type World } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";
import { Audit, settings, lessonRecord, seed } from "./lesson-helpers.js";

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
    table: w.table, settings: settings({ mode: "On" }), queue: { send: async (m) => { sent.push(m); } }, resume: async () => ({ finished: 0, failed: 0 }),
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
  it("L3: reads only the revert link rows, eventually consistent, and says in one fixed line (the project as a hash) when a project was cut off by the page limit", async () => {
    const w = await setup();
    await w.sink.put(link("task-a", hoursAgo(3)));
    const queries: Array<Record<string, unknown>> = [];
    const spied = { ...w.table, documentClient: { send: async (command: unknown) => { queries.push((command as { input: Record<string, unknown> }).input); return (w.table.documentClient).send(command); } } };
    const found = await revertedTasksSince(spied, ORG_A, "web", NOW - REVERT_WINDOW_MS, { nowSeconds: Math.floor(NOW / 1000) });
    expect(found.taskIds).toEqual(["task-a"]);
    expect(queries[0]).toMatchObject({ FilterExpression: "#kind = :kind", ConsistentRead: false });
    expect((queries[0]!["ExpressionAttributeValues"] as Record<string, unknown>)[":kind"]).toBe("rovara.reverted_by");
    // A project the page limit cut off: counted, and logged with a hash, never the project's name or the company.
    const logs: Array<[string, Record<string, string | number>]> = [];
    const limited = jobDeps(w, { log: (event, fields) => logs.push([event, fields]), table: { ...w.table, documentClient: { send: async (command: unknown) => ({ Items: [], LastEvaluatedKey: { pk: "x", sk: "y" }, ...(command ? {} : {}) }) } } });
    expect(await lessonsRevertJob(limited.deps, ORG_A, ["web"], 10_000)).toMatchObject({ revertWindowsTruncated: 1 });
    expect(logs).toHaveLength(1);
    expect(logs[0]![0]).toBe("lessons_job.revert_window_truncated");
    expect(JSON.stringify(logs)).not.toMatch(/web|org_/u);
    expect(logs[0]![1]["project"]).toMatch(/^[0-9a-f]{12}$/u);
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
    const resume = vi.fn(async (_org: string, project: string) => ({ finished: project === "web" ? 2 : 0, failed: 0 }));
    const { deps } = jobDeps(w, { resume, settings: settings({ mode: "Off" }) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web", "api"], 10_000)).toEqual({ lessonDeletionsResumed: 2, lessonResumeFailures: 0, lessonResumeSkipped: 0 });
    expect(resume.mock.calls).toEqual([[ORG_A, "web"], [ORG_A, "api"]]);
  });
  it("one project failing is a fixed log line and the others still run", async () => {
    const w = await setup();
    const logs: string[] = [];
    const { deps } = jobDeps(w, { resume: async (_org, project) => { if (project === "web") throw new Error("secret"); return { finished: 1, failed: 0 }; }, log: (event) => logs.push(event) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web", "api"], 10_000)).toEqual({ lessonDeletionsResumed: 1, lessonResumeFailures: 1, lessonResumeSkipped: 0 });
    expect(logs).toEqual(["lessons_job.resume_failed"]);
  });
  it("L4: an intent that fails is counted, and the rest of that project's intents were still tried (the counts come from the port, not from a throw)", async () => {
    const w = await setup();
    const logs: Array<[string, Record<string, string | number>]> = [];
    const { deps } = jobDeps(w, { resume: async () => ({ finished: 2, failed: 1 }), log: (event, fields) => logs.push([event, fields]) });
    expect(await lessonsResumeJob(deps, ORG_A, ["web"], 10_000)).toEqual({ lessonDeletionsResumed: 2, lessonResumeFailures: 1, lessonResumeSkipped: 0 });
    expect(logs).toEqual([["lessons_job.resume_failed", { intents: 1 }]]);
  });
});

describe("the nightly trial-to-stable pass (lessons connect)", () => {
  const DAY = 86_400_000;
  const STANDARD_ON = settings({ mode: "On", preset: "standard" });
  const trialLesson = (over: Partial<Lesson> = {}, days = TRIAL_STABLE_AFTER_DAYS + 1, loads = 3): Lesson => lessonRecord({
    id: "les_trial1", workspaceId: ORG_A, project: "web", tier: 1, status: "active", approvals: [{ approvalId: "t1", by: TRIAL_APPROVER, at: 1, mode: "trial" }],
    trial: { state: "trial", startedAt: NOW - days * DAY }, counters: { loaded: loads, helpful: 0, harmful: 0, citationStale: 0 }, ...over,
  });
  async function nightly(lessons: Lesson[], over: Partial<LessonsJobDeps> = {}) {
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const audit = new Audit();
    const { deps, sent, logs } = jobDeps(w, { settings: STANDARD_ON, queue: undefined, maintain: { store, audit, now: () => NOW }, ...over });
    return { deps, store, audit, sent, logs };
  }
  const stateOf = async (store: InMemoryLessonStore, id = "les_trial1") => (await store.get({ workspaceId: ORG_A, project: "web" }, id))!.trial?.state;

  it("a trial lesson at 14 days and 3 loads with no thumbs-down becomes stable in the nightly run, audited", async () => {
    const { deps, store, audit } = await nightly([trialLesson()]);
    expect(await lessonsNightlyJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1, promoteFailures: 0 });
    expect(await stateOf(store)).toBe("stable");
    expect((await store.get({ workspaceId: ORG_A, project: "web" }, "les_trial1"))!.trial).toMatchObject({ state: "stable", stableAt: NOW });
    expect(audit.events.find((e) => e.action === "lesson.trial_stable")).toMatchObject({ lessonId: "les_trial1", project: "web" });
  });
  it("not before: 13 days, 2 loads, a thumbs-down mark or a retire proposal each keep the lesson on trial", async () => {
    const { deps, store } = await nightly([
      trialLesson({ id: "les_young" }, TRIAL_STABLE_AFTER_DAYS - 1), trialLesson({ id: "les_unloaded" }, undefined, 2),
      trialLesson({ id: "les_harmful", counters: { loaded: 3, helpful: 0, harmful: 1, citationStale: 0 } }), trialLesson({ id: "les_retire", retireProposedAt: NOW - DAY }),
    ]);
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
    for (const id of ["les_young", "les_unloaded", "les_harmful", "les_retire"]) expect(await stateOf(store, id), id).toBe("trial");
  });
  it("only where trial lessons are allowed: Off, Collect, Suggest and the Regulated preset change nothing", async () => {
    for (const config of [settings({ mode: "Off", preset: "standard" }), settings({ mode: "Collect", preset: "standard" }), settings({ mode: "Suggest", preset: "standard" }), settings({ mode: "On", preset: "regulated" })]) {
      const { deps, store, audit } = await nightly([trialLesson()], { settings: config });
      expect(await lessonsNightlyJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
      expect(await stateOf(store)).toBe("trial");
      expect(audit.events).toEqual([]);
    }
    // Positive control: the same lesson under Standard and On is promoted.
    const { deps, store } = await nightly([trialLesson()]);
    await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000);
    expect(await stateOf(store)).toBe("stable");
  });
  it("no promotion store, or an invalid company id, does nothing; a person-approved lesson (no trial record) is left alone", async () => {
    const without = await nightly([trialLesson()], { maintain: undefined });
    expect(await lessonsPromoteJob(without.deps, ORG_A, ["web"], 10_000)).toEqual({ trialsPromoted: 0 });
    expect(await stateOf(without.store)).toBe("trial");
    const bad = await nightly([trialLesson()]);
    expect(await lessonsPromoteJob(bad.deps, "not a company", ["web"], 10_000)).toEqual({ trialsPromoted: 0 });
    const person = await nightly([lessonRecord({ id: "les_person", workspaceId: ORG_A, project: "web", tier: 1 })]);
    expect(await lessonsPromoteJob(person.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
  });
  it("respects the time budget: with no time left no project is looked at, and the lessons wait for the next night", async () => {
    let clock = NOW;
    const { deps, store } = await nightly([trialLesson()], { now: () => (clock += 20_000) });
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
    expect(await stateOf(store)).toBe("trial");
    // Positive control: with the budget intact (a clock that stands still) the same lesson moves.
    const fresh = await nightly([trialLesson()]);
    expect(await lessonsPromoteJob(fresh.deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
  });
  it("stops between lessons when the budget runs out mid-project: the first lesson moved, the budget is then gone, the second waits", async () => {
    let late = false;
    const store = new InMemoryLessonStore();
    await seed(store, trialLesson({ id: "les_a" }), trialLesson({ id: "les_b" }));
    const audit = new Audit();
    const emit = audit.emit.bind(audit);
    audit.emit = async (event, options) => { await emit(event, options); late = true; };
    const w = await setup();
    const { deps } = jobDeps(w, { settings: STANDARD_ON, now: () => (late ? NOW + 1_000_000 : NOW), maintain: { store, audit, now: () => NOW } });
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
    expect([await stateOf(store, "les_a"), await stateOf(store, "les_b")].sort()).toEqual(["stable", "trial"]);
  });
  it("is erasure-safe: a lesson that names an erased (fenced) person stays on trial, and the other lessons still move", async () => {
    const { deps, store } = await nightly([trialLesson({ id: "les_erased", provenance: { ...lessonRecord().provenance, authors: ["dev-gone"] } }), trialLesson({ id: "les_fine" })]);
    await store.fence({ workspaceId: ORG_A, project: "web" }, { people: ["dev-gone"] });
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
    expect(await stateOf(store, "les_erased")).toBe("trial");
    expect(await stateOf(store, "les_fine")).toBe("stable");
  });
  it("a project whose settings cannot be read is skipped (fail closed) and the others still run; a repeat night moves nothing twice", async () => {
    const { deps, store } = await nightly([trialLesson()]);
    const flaky: LessonsJobDeps = { ...deps, settings: { read: async (org, project) => { if (project === "api") throw new Error("secret"); return STANDARD_ON.read(org, project); } } };
    expect(await lessonsPromoteJob(flaky, ORG_A, ["api", "web"], 10_000)).toMatchObject({ trialsPromoted: 1 });
    expect(await stateOf(store)).toBe("stable");
    expect(await lessonsPromoteJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ trialsPromoted: 0 });
  });
});

describe("the nightly expiry sweep (lessons connect)", () => {
  const DAY = 86_400_000;
  const live = (over: Partial<Lesson>): Lesson => lessonRecord({ workspaceId: ORG_A, project: "web", tier: 1, status: "active", ...over });
  async function sweep(lessons: Lesson[], over: Partial<LessonsJobDeps> = {}) {
    const w = await setup();
    const store = new InMemoryLessonStore();
    await seed(store, ...lessons);
    const audit = new Audit();
    const { deps } = jobDeps(w, { settings: settings({ mode: "On" }), maintain: { store, audit, now: () => NOW }, ...over });
    return { deps, store, audit };
  }
  const statusOf = async (store: InMemoryLessonStore, id: string) => (await store.get({ workspaceId: ORG_A, project: "web" }, id))!.status;

  it("an active lesson past its expiry and a pending one nobody decided in time become expired, audited; the others stay", async () => {
    const { deps, store, audit } = await sweep([
      live({ id: "les_old", expiresAt: NOW - DAY }), live({ id: "les_new", expiresAt: NOW + DAY }),
      live({ id: "les_pend_old", status: "pending", approvals: [], pendingExpiresAt: NOW - DAY }), live({ id: "les_pend_new", status: "pending", approvals: [], pendingExpiresAt: NOW + DAY }),
    ]);
    expect(await lessonsExpireJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 2, expireFailures: 0 });
    expect(await Promise.all(["les_old", "les_new", "les_pend_old", "les_pend_new"].map((id) => statusOf(store, id)))).toEqual(["expired", "active", "expired", "pending"]);
    expect(audit.events.filter((e) => e.action === "lesson.expired").map((e) => e.lessonId).sort()).toEqual(["les_old", "les_pend_old"]);
  });
  it("runs before the promotion in the nightly run, so an expired trial lesson is never made stable; a project whose learning is Off is left alone", async () => {
    const trial = live({ id: "les_expired_trial", expiresAt: NOW - DAY, approvals: [{ approvalId: "t1", by: TRIAL_APPROVER, at: 1, mode: "trial" }], trial: { state: "trial", startedAt: NOW - 20 * DAY }, counters: { loaded: 3, helpful: 0, harmful: 0, citationStale: 0 } });
    const { deps, store } = await sweep([trial], { settings: settings({ mode: "On", preset: "standard" }) });
    expect(await lessonsNightlyJob(deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 1, trialsPromoted: 0 });
    expect(await statusOf(store, "les_expired_trial")).toBe("expired");
    const off = await sweep([live({ id: "les_old", expiresAt: NOW - DAY })], { settings: settings({ mode: "Off" }) });
    expect(await lessonsExpireJob(off.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
    expect(await statusOf(off.store, "les_old")).toBe("active");
  });
  it("does nothing with no store or no time left", async () => {
    const none = await sweep([live({ id: "les_old", expiresAt: NOW - DAY })], { maintain: undefined });
    expect(await lessonsExpireJob(none.deps, ORG_A, ["web"], 10_000)).toEqual({ lessonsExpired: 0 });
    let clock = NOW;
    const late = await sweep([live({ id: "les_old", expiresAt: NOW - DAY })], { now: () => (clock += 20_000) });
    expect(await lessonsExpireJob(late.deps, ORG_A, ["web"], 10_000)).toMatchObject({ lessonsExpired: 0 });
    expect(await statusOf(late.store, "les_old")).toBe("active");
  });
});
