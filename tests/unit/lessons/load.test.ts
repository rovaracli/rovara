// L4 (broker side): the loader. Poisoning classes P9 and P10 (loader side), and the reviewer-independence control C11.
import { describe, expect, it } from "vitest";
import { LearnedContextSchema } from "../../../packages/contracts/src/index.js";
import { applyLoadReport } from "../../../packages/broker/src/lessons/counters.js";
import { LOAD_MAX_BYTES, LOAD_MAX_LESSONS, learnedContextForDispatch, loadLessonsForStage, scopeMatch, wilsonLower, type LoadDeps, type LoadRequest } from "../../../packages/broker/src/lessons/load.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Audit, Clock, KEY, MemoryVectors, PROJECT, WS, embedder, lessonRecord, seed, settings } from "./lesson-helpers.js";

const restrictedAudience = { kind: "restricted" as const, acl: { source: "slack" as const, scope: "slack:T/C9", principals: ["U-member"], capturedAt: "x", liveCheck: "none" as const } };

function setup(s = settings()) {
  const store = new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const clock = new Clock();
  const deps: LoadDeps = { store, embedder, vectors, settings: s, audit: new Audit(), now: clock.now };
  const add = async (...lessons: Lesson[]) => {
    await seed(store, ...lessons);
    for (const l of lessons) await vectors.upsert(l.workspaceId, l.project, l.id, await embedder.embed(`${l.title}\n${l.description}\n${l.body}`), { status: l.status });
  };
  return { deps, store, vectors, clock, add };
}
const request = (over: Partial<LoadRequest> = {}): LoadRequest => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [],
  taskAudience: { kind: "shared" }, ...over,
});
const ids = (r: Awaited<ReturnType<typeof loadLessonsForStage>>): string[] => r.context?.lessons.map((l) => l.id) ?? [];
const conv = (id: string, over: Partial<Lesson> = {}): Lesson => lessonRecord({ id, type: "convention", tier: 1, ...over });

describe("selection", () => {
  it("loads active, in-scope lessons for the stage; skips pending, retired, stale, expired and withdrawn ones", async () => {
    const { deps, add, clock } = setup();
    await add(conv("les_ok000001"), conv("les_pend0001", { status: "pending" }), conv("les_retd0001", { status: "retired" }), conv("les_stal0001", { status: "stale" }),
      conv("les_expd0001", { expiresAt: clock.now() - 1 }), conv("les_with0001", { status: "withdrawn" }));
    const result = await loadLessonsForStage(deps, request());
    expect(ids(result)).toEqual(["les_ok000001"]);
    expect(LearnedContextSchema.safeParse(result.context).success).toBe(true);
  });

  it("scope: a lesson for another repository, another language or other paths is not loaded", async () => {
    const { deps, add } = setup();
    await add(conv("les_repo0001", { scope: { repos: ["web"] } }), conv("les_lang0001", { scope: { repos: ["api"], languages: ["python"] } }),
      conv("les_path0001", { scope: { repos: ["api"], paths: ["docs/**"] } }), conv("les_hit00001", { scope: { repos: ["api"], paths: ["src/**"] } }), conv("les_open0001", { scope: {} }));
    const result = await loadLessonsForStage(deps, request({ languages: ["typescript"] }));
    expect(ids(result).sort()).toEqual(["les_hit00001", "les_open0001"]);
    expect(result.manifest.lessons.find((e) => e.id === "les_hit00001")!.why).toBe("path");
    expect(scopeMatch(conv("x", { scope: { paths: ["src/**"] } }), { repos: [], files: [], languages: [] }).matches).toBe(true);
    expect(scopeMatch(conv("x", { scope: { paths: ["src/*.ts"] } }), { repos: [], files: ["src/a/b.ts"], languages: [] }).matches).toBe(false);
  });

  it("what each stage gets (design §4.7)", async () => {
    const { deps, add } = setup();
    await add(
      lessonRecord({ id: "les_fact0001", type: "fact", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      lessonRecord({ id: "les_fnc00001", type: "fact", citations: [], stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_conv0001", { stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_pitf0001", { type: "pitfall", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_proc0001", { type: "procedure", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_pref0001", { type: "preference", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"] }),
      conv("les_rchk0001", { type: "review_check", stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"] }),
    );
    const sorted = async (stage: LoadRequest["stage"]) => ids(await loadLessonsForStage(deps, request({ stage, taskId: `t-${stage}` }))).sort();
    expect(await sorted("UNDERSTAND")).toEqual(["les_conv0001", "les_fact0001", "les_fnc00001", "les_pitf0001", "les_pref0001", "les_proc0001"]);
    expect(await sorted("PLAN")).toEqual(await sorted("UNDERSTAND"));
    expect(await sorted("IMPLEMENT")).toEqual(["les_conv0001", "les_fact0001", "les_pitf0001"]);
    expect(await sorted("CHECKS")).toEqual([]);
  });

  it("C11: reviewer stages get only tier-2-approved review_check lessons, plus the list of what the planner and coder loaded", async () => {
    const { deps, add } = setup();
    const two = [{ approvalId: "a", by: "ann", at: 1, mode: "one" as const }, { approvalId: "b", by: "bob", at: 2, mode: "second_person" as const }];
    await add(
      conv("les_rok00001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: two }),
      conv("les_rone0001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: [two[0]!] }),
      conv("les_rauto001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: [{ approvalId: "c", by: "system:auto", at: 1, mode: "auto" }, two[0]!] }),
      conv("les_rtier1ab", { type: "review_check", tier: 1, stages: ["REVIEW"], approvals: two }),
      conv("les_rsole001", { type: "review_check", tier: 2, stages: ["REVIEW"], approvals: [{ approvalId: "d", by: "ann", at: 1, mode: "sole_owner_exception" }] }),
      conv("les_plain001", { stages: ["UNDERSTAND", "PLAN", "IMPLEMENT", "REVIEW"] }),
    );
    await loadLessonsForStage(deps, request({ stage: "IMPLEMENT" }));
    const review = await loadLessonsForStage(deps, request({ stage: "REVIEW" }));
    expect(ids(review).sort()).toEqual(["les_rok00001", "les_rsole001"]);
    expect(review.context!.priorLoaded).toEqual([{ id: "les_plain001", type: "convention", title: "Retries use withRetry" }]);
    // An implementation stage never gets the priorLoaded list.
    expect((await loadLessonsForStage(deps, request({ stage: "IMPLEMENT", round: 2 }))).context!.priorLoaded).toBeUndefined();
  });

  it("ranks by similarity, then helpfulness, deterministically; respects 12 lessons and 6 KB", async () => {
    const { deps, add } = setup();
    await add(conv("les_aaaa0001", { title: "Retry failed HTTP calls", body: "Retry failed HTTP calls in the api service with withRetry" }), conv("les_bbbb0001", { title: "Logging", body: "Use structured logging for the billing worker queue" }));
    const result = await loadLessonsForStage(deps, request());
    expect(ids(result)).toEqual(["les_aaaa0001", "les_bbbb0001"]);
    expect(result.manifest.lessons[0]!.score).toBeGreaterThan(result.manifest.lessons[1]!.score);
    const again = await loadLessonsForStage(deps, request({ taskId: "task-2" }));
    expect(ids(again)).toEqual(ids(result));

    const many = setup();
    await many.add(...Array.from({ length: 20 }, (_, i) => conv(`les_many${String(i).padStart(4, "0")}`, { title: `Lesson ${i}`, body: `Advice number ${i} about retries in api` })));
    const capped = await loadLessonsForStage(many.deps, request());
    expect(capped.context!.lessons).toHaveLength(LOAD_MAX_LESSONS);

    const big = setup();
    await big.add(...Array.from({ length: 8 }, (_, i) => conv(`les_big0${String(i).padStart(4, "0")}`, { title: `Big ${i}`, body: `retry ${"x".repeat(560)}`, description: "d".repeat(150) })));
    const bytes = await loadLessonsForStage(big.deps, request());
    expect(bytes.manifest.bytes).toBeLessThanOrEqual(LOAD_MAX_BYTES);
    expect(bytes.context!.lessons.length).toBeLessThan(8);
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(9, 10)).toBeGreaterThan(wilsonLower(1, 2));
  });

  it("a lesson that was helpful outranks an untested one of equal similarity", async () => {
    const { deps, add } = setup();
    const same = { title: "Retries", body: "Retry failed HTTP calls in the api service" };
    await add(conv("les_aaa00001", { ...same }), conv("les_zzz00001", { ...same, counters: { loaded: 20, helpful: 18, harmful: 0, citationStale: 0 } }));
    expect(ids(await loadLessonsForStage(deps, request()))[0]).toBe("les_zzz00001");
  });

  it("writes the manifest once per stage dispatch; 'loaded' is counted only when the worker reports the lesson reached the prompt (once per task and lesson)", async () => {
    const { deps, add, store } = setup();
    await add(conv("les_ok000001"));
    await loadLessonsForStage(deps, request({ stage: "UNDERSTAND" }));
    await loadLessonsForStage(deps, request({ stage: "IMPLEMENT" }));
    await loadLessonsForStage(deps, request({ stage: "IMPLEMENT" }));
    expect((await store.get(KEY, "les_ok000001"))!.counters.loaded).toBe(0);
    expect(await store.manifests(KEY, "task-1")).toHaveLength(2);
    const [m] = await store.manifests(KEY, "task-1");
    expect(m).toMatchObject({ memory: "live", setVersion: 1, round: 1 });
    const counter = { store, judge: { rate: async () => "unrelated" as const }, settings: settings(), audit: new Audit(), now: new Clock().now };
    const report = (stage: "UNDERSTAND" | "IMPLEMENT") => ({ v: 1 as const, stage, lessons: [{ id: "les_ok000001", version: 1, citation: "valid" as const }] });
    await applyLoadReport(counter, { ...KEY, taskId: "task-1", stage: "UNDERSTAND", round: 1, report: report("UNDERSTAND") });
    await applyLoadReport(counter, { ...KEY, taskId: "task-1", stage: "IMPLEMENT", round: 1, report: report("IMPLEMENT") });
    expect((await store.get(KEY, "les_ok000001"))!.counters.loaded).toBe(1);
  });
});

describe("fail closed", () => {
  it("mode Off, Collect or an unreadable setting loads nothing", async () => {
    for (const s of [settings({ mode: "Off" }), settings({ mode: "Collect" }), settings({ companyLock: "Off" }), { read: async () => { throw new Error("down"); } }]) {
      const { deps, add } = setup(s);
      await add(conv("les_ok000001"));
      const result = await loadLessonsForStage(deps, request());
      expect(result).toMatchObject({ skipped: "mode" });
      expect(result.context).toBeUndefined();
    }
  });

  it("memory off (eval batches only) loads nothing and the manifest says so", async () => {
    const { deps, add } = setup();
    await add(conv("les_ok000001"));
    const result = await loadLessonsForStage(deps, request({ memory: { mode: "off" } }));
    expect(result).toMatchObject({ skipped: "memory_off", manifest: { memory: "off", lessons: [] } });
  });

  it("an unreachable index or a failing embedder loads nothing and never throws", async () => {
    const { deps, add, vectors } = setup();
    await add(conv("les_ok000001"));
    vectors.fail = true;
    expect(await loadLessonsForStage(deps, request())).toMatchObject({ skipped: "index_unreachable" });
    vectors.fail = false;
    embedder.fail = true;
    try { expect(await loadLessonsForStage(deps, request())).toMatchObject({ skipped: "index_unreachable" }); } finally { embedder.fail = false; }
  });
});

describe("audience and isolation", () => {
  it("P10: a lesson from a restricted source is not loaded into a shared task, nor a private task whose owner cannot see the source", async () => {
    const { deps, add } = setup();
    const provenance = { ...lessonRecord().provenance, audience: restrictedAudience };
    await add(conv("les_rest0001", { provenance }), conv("les_open0001"));
    expect(ids(await loadLessonsForStage(deps, request({ taskAudience: { kind: "shared" } })))).toEqual(["les_open0001"]);
    expect(ids(await loadLessonsForStage(deps, request({ taskId: "t2", taskAudience: { kind: "private", identity: { principals: ["U-stranger"], groups: [] } } })))).toEqual(["les_open0001"]);
    expect(ids(await loadLessonsForStage(deps, request({ taskId: "t3", taskAudience: { kind: "private", identity: { principals: ["U-member"], groups: [] } } }))).sort()).toEqual(["les_open0001", "les_rest0001"]);
  });

  it("P9: a lesson of another workspace, or another project, is never loaded", async () => {
    const { deps, add } = setup();
    await add(conv("les_ours0001"), conv("les_ws2b0001", { workspaceId: "ws-B" }), conv("les_proj2001", { project: "proj-2" }));
    expect(ids(await loadLessonsForStage(deps, request()))).toEqual(["les_ours0001"]);
    expect(ids(await loadLessonsForStage(deps, request({ workspaceId: "ws-B" })))).toEqual(["les_ws2b0001"]);
  });
});

describe("the dispatch call", () => {
  it("returns a spreadable learnedContext only for a worker that lists the feature, and records nothing for an older worker", async () => {
    const { deps, add, store } = setup();
    await add(conv("les_ok000001"));
    expect(await learnedContextForDispatch(deps, request(), ["task.modelPolicy"])).toEqual({});
    expect(await store.manifests(KEY, "task-1")).toHaveLength(0);
    expect((await store.get(KEY, "les_ok000001"))!.counters.loaded).toBe(0);
    const out = await learnedContextForDispatch(deps, request(), ["task.learnedContext.v1"]);
    expect(out.learnedContext!.lessons.map((l) => l.id)).toEqual(["les_ok000001"]);
    expect(await learnedContextForDispatch(deps, request({ stage: "CHECKS" }), ["task.learnedContext.v1"])).toEqual({});
  });

  it("never throws: a store that fails gives an empty result", async () => {
    const { deps } = setup();
    expect(await learnedContextForDispatch({ ...deps, store: new Proxy({}, { get: () => async () => { throw new Error("db down"); } }) as never }, request(), ["task.learnedContext.v1"])).toEqual({});
  });
});
