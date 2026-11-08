// LV-1 fix round 2: the test gaps the re-check named (R2: the digest's status filter, one reader across pages), the load record's task ids (R3) and the Lessons tab's bounds (R4: each list its own bound, one deadline).
import { describe, expect, it } from "vitest";
import { OrgIdSchema } from "../../../packages/contracts/src/index.js";
import { buildWeeklyDigest } from "../../../packages/broker/src/lessons/digest.js";
import { loadLessonsForStage, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { readVisibleRanked } from "../../../packages/broker/src/lessons/read-visible.js";
import { NO_EMBEDDER, NO_VECTORS } from "../../../packages/broker/src/lessons/runtime.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { buildLessonsView, type LessonViewDeps } from "../../../packages/broker/src/lessons/view.js";
import type { AccessCheckPort } from "../../../packages/broker/src/team-record/access-port.js";
import type { TaskVisibilityPort } from "../../../packages/broker/src/team-record/live-audience.js";
import type { TaskVisibility } from "../../../packages/broker/src/team-record/sources/rovara.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, PROJECT, WS, directory, lessonRecord, seed, settings } from "./lesson-helpers.js";

const SHARED: TaskVisibility = { kind: "shared" };
const NARROWED: TaskVisibility = { kind: "shared_with", developerIds: ["x", "y"] };
function port(table: Record<string, TaskVisibility | undefined>, delayMs = 0) {
  const reads: string[][] = [];
  const value: TaskVisibilityPort = {
    async read(_org, ids, options) {
      reads.push([...ids]);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return new Map(ids.map((id) => [id, options?.signal?.aborted === true ? undefined : table[id]]));
    },
  };
  return { value, reads };
}
const accessOf = (tasks: TaskVisibilityPort): AccessCheckPort => ({ mayRead: async (_o, _v, places) => places.map(() => true), taskVisibility: tasks });
const fromTasks = (id: string, tasks: string[], over: Partial<Lesson> = {}): Lesson =>
  lessonRecord({ id, type: "convention", tier: 1, approvals: [{ approvalId: "ap", by: "ann", at: 1, mode: "one" }], provenance: { ...lessonRecord().provenance, supportTasks: tasks }, ...over });

describe("R2: the digest checks only the statuses it can show", () => {
  it("rejected, withdrawn and long-retired lessons cost no task read; active, pending, stale and this week's retirements do", async () => {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const old = clock.now() - 30 * 24 * 60 * 60 * 1000;
    const one = (id: string, status: Lesson["status"], task: string, over: Partial<Lesson> = {}): Lesson => fromTasks(id, [task], { status, ...(status === "pending" || status === "rejected" ? { approvals: [] } : {}), ...over });
    await seed(store, one("les_active0001", "active", "t-active"), one("les_pending001", "pending", "t-pending"), one("les_stale00001", "stale", "t-stale"), one("les_retiredwk1", "retired", "t-retired-week", { updatedAt: clock.now() }),
      one("les_retiredold", "retired", "t-retired-old", { updatedAt: old }), one("les_rejected01", "rejected", "t-rejected"), one("les_withdrawn1", "withdrawn", "t-withdrawn"), one("les_candidate1", "candidate", "t-candidate"));
    const p = port({ "t-active": SHARED, "t-pending": SHARED, "t-stale": SHARED, "t-retired-week": SHARED });
    const digest = await buildWeeklyDigest(store, KEY, clock.now(), { principals: [], groups: [] }, accessOf(p.value));
    expect(p.reads.flat().sort()).toEqual(["t-active", "t-pending", "t-retired-week", "t-stale"]);
    // Positive control: what was read is what the digest shows.
    expect(digest.top.map((i) => i.id).sort()).toEqual(["les_active0001", "les_pending001"]);
    expect(digest.queuedCount).toBe(1);
  });
});

describe("R2: one reader across the pages of readVisibleRanked when none is passed", () => {
  it("a task shared by lessons on different pages is read once", async () => {
    const lessons = Array.from({ length: 12 }, (_, n) => fromTasks(`les_pages${String(n).padStart(4, "0")}`, ["t-shared", `t-own-${String(n)}`]));
    const table: Record<string, TaskVisibility> = { "t-shared": SHARED };
    for (let n = 0; n < 12; n += 1) table[`t-own-${String(n)}`] = SHARED;
    const p = port(table);
    const result = await readVisibleRanked({ access: accessOf(p.value), key: KEY, viewer: undefined, where: "t", ranked: lessons, pageSize: 4, enough: () => false });
    expect(result.kept).toHaveLength(12);
    const asked = p.reads.flat();
    expect(asked.filter((id) => id === "t-shared")).toHaveLength(1);
    expect(p.reads.length).toBe(3);
  });
});

describe("R3: the load record keeps each loaded lesson's task ids", () => {
  it("the manifest entry names the tasks the lesson was learned from at load time", async () => {
    const store = new InMemoryLessonStore();
    const clock = new Clock();
    await seed(store, fromTasks("les_stayopen1", ["to"], { citations: [{ kind: "task", taskId: "t-cited" }] }));
    const deps: LoadDeps = { access: accessOf(port({ to: SHARED, "t-cited": SHARED }).value), store, embedder: NO_EMBEDDER, vectors: NO_VECTORS, settings: settings(), audit: new Audit(), now: clock.now };
    const request: LoadRequest = { workspaceId: WS, project: PROJECT, taskId: "task-9", stage: "IMPLEMENT", round: 1, intent: "x", repos: ["api"], files: [], languages: [], taskAudience: { kind: "shared" } };
    const result = await loadLessonsForStage(deps, request);
    expect(result.context?.lessons.map((l) => l.id)).toEqual(["les_stayopen1"]);
    expect(result.manifest.lessons[0]!.taskIds?.slice().sort()).toEqual(["t-cited", "to"]);
    expect((await store.manifests(KEY, "task-9"))[0]!.lessons[0]!.taskIds?.slice().sort()).toEqual(["t-cited", "to"]);
  });
});

describe("R4: the Lessons tab", () => {
  const T = OrgIdSchema.parse(WS);
  const viewDeps = (store: InMemoryLessonStore, tasks: TaskVisibilityPort, clock: Clock): LessonViewDeps => {
    const dir = directory({ eligibleIds: ["owner"], ownerIds: ["owner"] });
    dir.identity = async (_ws, id) => ({ principals: [], groups: [], developerId: id });
    return { store, directory: dir, settings: settings(), access: accessOf(tasks), now: clock.now, names: { isErased: async () => false, memberName: async (_o: string, id: string) => id } };
  };

  it("a long active list that is all withheld cannot use up the bound the waiting list, the queue count and the removed list need", async () => {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const table: Record<string, TaskVisibility> = {};
    const narrowedActive = Array.from({ length: 400 }, (_, n) => { table[`ta${String(n)}`] = NARROWED; return fromTasks(`les_act${String(n).padStart(6, "0")}`, [`ta${String(n)}`]); });
    table["tp"] = SHARED; table["tr"] = SHARED; table["tc"] = SHARED;
    await seed(store, ...narrowedActive, fromTasks("les_pending001", ["tp"], { status: "pending", approvals: [] }), fromTasks("les_retired001", ["tr"], { status: "retired" }), fromTasks("les_candidate1", ["tc"], { status: "candidate", approvals: [] }));
    const p = port(table);
    const view = await buildLessonsView(viewDeps(store, p.value, clock), { orgId: T, developerId: "owner" }, PROJECT);
    // The active list read its own 300 tasks and no more...
    expect(view.active).toEqual([]);
    expect(p.reads.flat().filter((id) => id.startsWith("ta")).length).toBeLessThanOrEqual(300);
    // ...and the other lists were still read and shown.
    expect(view.waiting.map((l) => l.id)).toEqual(["les_pending001"]);
    expect(view.removed.map((l) => l.id)).toEqual(["les_retired001"]);
    expect(view.queued).toBe(1);
  });

  it("the whole tab stops reading at its deadline: a slow State table returns in time with what was checked, and says the lists were cut", async () => {
    const clock = new Clock();
    const store = new InMemoryLessonStore();
    const table: Record<string, TaskVisibility> = {};
    const lessons = Array.from({ length: 300 }, (_, n) => { table[`ta${String(n)}`] = NARROWED; return fromTasks(`les_act${String(n).padStart(6, "0")}`, [`ta${String(n)}`]); });
    await seed(store, ...lessons, fromTasks("les_pending001", ["tp"], { status: "pending", approvals: [] }));
    table["tp"] = SHARED;
    const started = Date.now();
    const view = await buildLessonsView(viewDeps(store, port(table, 250).value, clock), { orgId: T, developerId: "owner" }, PROJECT, { deadlineMs: 400 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(view.truncated).toContain("active");
    expect(view.active).toEqual([]);
  });
});
