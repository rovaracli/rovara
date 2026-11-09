// Lessons in the repo, lane R1b (decision 50c): the WIRED path from a merged task's end to a repo-only lesson in the Dynamo store. The real task-end handler sends ids to the queue, the queue's consumer is the real reflect
// worker (lease, deadline) running `learnFromEndedTaskTyped` with the PRODUCTION subject source (`lessonSubjectSource`) and the real capture adapter over a fake code host, the runtime the broker builds
// (`createLessonsRuntime`) stores the drafts, and the real human-edit extractor runs the edits reflection. The world is `tests/support/lessons-repo-reflect-world.ts`.
// Mutation checks (done by hand, see the lane's report): the task end skipping its comments reflection fails the first tests; the edits path removed fails the edits tests; the cap reservation removed fails the cap tests.
import { afterEach, describe, expect, it } from "vitest";
import { loadLessonsForStage } from "../../packages/broker/src/lessons/load.js";
import { setLearnedLessonsGate } from "../../packages/broker/src/lessons/policy.js";
import type { PipelineModel } from "../../packages/broker/src/lessons/ports.js";
import { withLearningAttempt } from "../../packages/broker/src/lessons/learning-deadline.js";
import { learnFromEndedTaskTyped } from "../../packages/broker/src/lessons/task-end.js";
import { noteTaskHeld, readTaskHeld } from "../../packages/broker/src/lessons/repo-reflect.js";
import { allowAllAccess } from "../unit/lessons/lesson-helpers.js";
import { INTENT, KEY, PLACE, PROJECT, PUSHED, TASK, V1_BODY, V2_BODY, WS, World, words } from "../support/lessons-repo-reflect-world.js";

afterEach(() => { setLearnedLessonsGate(undefined); });

describe("a merged task's pull request is reflected on a second time, over the repository's own words, through the real task-end path into the Dynamo store", () => {
  it("a merged pull request with a member's review comment: one repo-only call, and its lesson is repo-only for that repository; the task's own reflection is unchanged", async () => {
    const w = new World();
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.mainCalls()).toHaveLength(1);
    const lessons = await w.lessons();
    expect(lessons).toHaveLength(2);
    const repo = lessons.find((lesson) => lesson.title === "Retries go through withRetry")!;
    const main = lessons.find((lesson) => lesson.title === "Name the retry helper")!;
    expect(repo.provenance.repoOnly).toEqual({ place: PLACE });
    expect(repo.provenance.repoBlockCodes).toBeUndefined();
    expect(repo.provenance.sourceKinds).toEqual(["pr_comment"]);
    expect(main.provenance.repoOnly).toBeUndefined();
    expect(main.provenance.repoBlockCodes).toEqual(["task_inputs_unproved", "intent_not_repo"]);
    expect(w.mainCalls()[0]!.user).toContain(INTENT);
  });

  it("review M2 and L-b (P3a/P3b, real description shapes): the prompt holds the repository's comment, the merge fact and the link; no description, no title (plan summary from Slack, names, task link) and none of the task's own text", async () => {
    for (const body of [V1_BODY, V2_BODY]) {
      // Positive control: Rovara's own description really holds what must not reach the prompt (the quoted plan summary, the names, the task link).
      for (const planted of ["PLANSUMMARY", "Jane Doe", "John Roe", "app.rovara.example"]) expect(body, planted).toContain(planted);
      const w = new World({ body });
      await w.end();
      const { user, system } = w.repoCalls()[0]!;
      expect(user).toContain("Use withRetry for HTTP retries in api, not a hand-rolled loop.");
      // review L-b: no Rovara-written text at all, the title included (the host's title here is "Retries use withRetry").
      expect(user).not.toContain("Retries use withRetry");
      expect(user).toContain("https://github.com/acme/api/pull/7");
      expect(user).toContain("outcome merged");
      for (const forbidden of [INTENT, "PLANSUMMARY", "Initech", "Jane Doe", "John Roe", "app.rovara.example", "Requested by"]) expect(user, forbidden).not.toContain(forbidden);
      expect(user).not.toMatch(/kind=(intent|plan|send_back|remembered|loaded_lesson|review_finding|ci_failure)/u);
      expect(system).toMatch(/<<span [0-9a-f]{16} \.\.\.>>/u);
    }
  });

  it("the repo-only call is paid by the task's one Public cap: it is asked to hold at most what the first reflection left", async () => {
    const w = new World();
    await w.end();
    expect(w.mainCalls()[0]!.maxHoldUsd).toBeCloseTo(0.15, 6);
    expect(w.repoCalls()[0]!.maxHoldUsd).toBeCloseTo(0.14, 6);
  });

  it("switch off (and unreadable) and the modes Off and Collect: zero calls of any kind and nothing stored", async () => {
    for (const gate of [() => false, () => { throw new Error("unreadable"); }]) {
      setLearnedLessonsGate(gate);
      const w = new World();
      await w.end();
      expect(w.calls).toEqual([]);
      expect(await w.lessons()).toEqual([]);
    }
    setLearnedLessonsGate(undefined);
    for (const mode of ["Off", "Collect"] as const) {
      const w = new World();
      w.mode = mode;
      await w.end();
      expect(w.calls, mode).toEqual([]);
    }
  });

  it("no repository-visible correction: no repo-only call (no comment at all, or praise only), and the task's own reflection still runs", async () => {
    const none = new World();
    none.commentIds = [];
    await none.end();
    expect(none.repoCalls()).toEqual([]);
    expect(none.mainCalls()).toHaveLength(1);
    const praise = new World();
    praise.comments = { "review_comment:11": words("acme/api#pr7:review_comment11", "rae", "LGTM, nice work") };
    await praise.end();
    expect(praise.repoCalls()).toEqual([]);
    expect(praise.mainCalls()).toHaveLength(1);
  });

  it("a task that did not merge makes no repo-only call", async () => {
    const w = new World();
    await w.end("closed");
    expect(w.repoCalls()).toEqual([]);
  });

  it("a redelivery makes no second call: the worker's lease stops the whole message, and below the lease the once-key stops the repo-only call", async () => {
    const w = new World();
    await w.end();
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.mainCalls()).toHaveLength(1);
    await learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK });
    expect(w.mainCalls()).toHaveLength(2);
    expect(w.repoCalls()).toHaveLength(1);
  });

  it("review L1 (P4): a quote that fails before the call spends nothing and takes no key; the next delivery reflects the change request", async () => {
    const w = new World();
    w.quoteFailures = 0;
    const real = w.learning.reflect.model;
    let n = 0;
    (w.learning.reflect as { model: PipelineModel }).model = { ...real, quote: async (r) => { n += 1; if (n === 2) throw new Error("quote down"); return real.quote!(r); } };
    await learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK });
    expect(w.repoCalls()).toHaveLength(0);
    await learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK });
    expect(w.repoCalls()).toHaveLength(1);
  });
});

describe("review H1: the repo-only lesson is never merged into the task's own lesson", () => {
  it("P1: both reflections learn the same advice and the curator's judge says 'same': two lessons, the repo-only one keeps its mark, they are linked both ways, and a task is given only one of them (the repo-only one)", async () => {
    const w = new World({ sameText: true });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    const lessons = await w.lessons();
    expect(lessons).toHaveLength(2);
    const repo = lessons.find((lesson) => lesson.provenance.repoOnly !== undefined)!;
    const main = lessons.find((lesson) => lesson.provenance.repoOnly === undefined)!;
    expect(repo.provenance.repoOnly).toEqual({ place: PLACE });
    expect(repo.possibleDuplicateOf).toBe(main.id);
    expect(main.repoTwins).toEqual([repo.id]);
    // Both go live (a person approved them); the loader gives the task one.
    const live = await Promise.all([repo, main].map(async (lesson) => ({ ...lesson, status: "active" as const, approvals: [{ approvalId: "a", by: "ann", at: 1, mode: "one" as const }] })));
    const store = w.runtime.store;
    const setVersion = await store.setVersion(KEY);
    expect((await store.commit(KEY, setVersion, live.map((lesson) => ({ ...lesson, version: lesson.version + 1 })), w.now)).ok).toBe(true);
    const loaded = await loadLessonsForStage({ ...w.runtime.routes, access: allowAllAccess, store, embedder: w.runtime.routes.embedder, vectors: w.runtime.routes.vectors, settings: w.learning.settings, audit: w.runtime.routes.audit, now: () => w.now }, {
      workspaceId: WS, project: PROJECT, taskId: "task-9", stage: "IMPLEMENT", round: 1, intent: "Retry failed HTTP calls in the api service", repos: ["api"], files: ["src/retry/client.ts"], languages: [], taskAudience: { kind: "shared" },
    });
    expect((loaded.context?.lessons ?? []).map((l) => l.id)).toEqual([repo.id]);
  });
});

describe("review M1: the repository is proved from the registered repository URL, before anything is paid", () => {
  it("P2a: the project's name for the repository differs from the host's name: the lesson is repo-only", async () => {
    const w = new World({ prUrl: "https://github.com/acme/backend-api/pull/7", registeredUrl: "https://github.com/acme/backend-api" });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect((await w.lessons()).find((l) => l.title === "Retries go through withRetry")!.provenance.repoOnly).toEqual({ place: PLACE });
  });
  it("P2b: capitals in the host's name: the registered URL matches without case", async () => {
    const w = new World({ prUrl: "https://github.com/Acme/Api/pull/7", registeredUrl: "https://github.com/acme/api.git" });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect((await w.lessons()).find((l) => l.title === "Retries go through withRetry")!.provenance.repoOnly).toEqual({ place: PLACE });
  });
  it("a pull request that is not in the project's registered repository is not reflected, and nothing is paid for it", async () => {
    const w = new World({ registeredUrl: "https://github.com/acme/other" });
    await w.end();
    expect(w.repoCalls()).toEqual([]);
    expect(w.mainCalls()).toHaveLength(1);
  });
});

describe("two reflections, no hand-over: the task end always reflects on the comments; the human-edit job adds an edits reflection when it has real edits", () => {
  it("nobody pushed after Rovara: the task end makes the one comments call; a job that happens to run finds nothing to add (no edits, no edits call)", async () => {
    const w = new World();
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).not.toContain("withRetryEDIT");
  });

  it("a person pushed after Rovara: the task end STILL makes its comments call (it never defers); the job makes a separate edits call with the edits and the same comments; neither is made twice", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.end();
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).not.toContain("withRetryEDIT");
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(2);
    const edits = w.repoCalls()[1]!.user;
    expect(edits).toContain("withRetryEDIT");
    expect(edits).toContain("Use withRetry for HTTP retries in api, not a hand-rolled loop.");
    expect(edits).not.toContain(INTENT);
    for (const lesson of await w.lessons()) expect(lesson.provenance.repoBlockCodes ?? []).not.toContain("typed_in_rovara");
    expect((await w.lessons()).filter((l) => l.provenance.repoOnly !== undefined).length).toBeGreaterThanOrEqual(1);
    await w.extractor().extract(w.editInput());
    await w.end();
    expect(w.repoCalls()).toHaveLength(2);
  });

  it("the job first, then the task end: the same two calls", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.extractor().extract(w.editInput());
    await w.end();
    expect(w.repoCalls()).toHaveLength(2);
  });

  it("the job cannot use the edit (its author is not a member): no edits call; the task end's comments call is untouched", async () => {
    const w = new World({ mergedHead: PUSHED });
    w.outsiders.add("ann");
    await w.end();
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).not.toContain("withRetryEDIT");
  });

  it("a pull request with edits but no review comment: no comments call at the task end; the job reflects on the edits alone", async () => {
    const w = new World({ mergedHead: PUSHED });
    w.commentIds = [];
    await w.end();
    expect(w.repoCalls()).toHaveLength(0);
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(1);
    expect(w.repoCalls()[0]!.user).toContain("withRetryEDIT");
  });

  it("Off, Collect and a switch that is off: the job makes no repo-only call", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = new World({ mergedHead: PUSHED });
      w.mode = mode;
      await w.extractor().extract(w.editInput());
      expect(w.calls, mode).toEqual([]);
    }
    setLearnedLessonsGate(() => false);
    const w = new World({ mergedHead: PUSHED });
    await w.extractor().extract(w.editInput());
    expect(w.calls).toEqual([]);
  });
});

describe("review L-f: Public's cap is one total per task across the task end and the job, in either order", () => {
  const CAP = 0.06;
  const spent = (w: World) => w.calls.length * 0.01;
  for (const order of ["task end first", "job first"] as const) {
    it(`${order}: every model call of the task together (reflections, judges, comments and edits) stays within the cap`, async () => {
      const w = new World({ mergedHead: PUSHED });
      (w.learning.reflect as { capsOverride?: { perTaskUsd?: number } }).capsOverride = { perTaskUsd: CAP };
      if (order === "task end first") { await w.end(); await w.extractor().extract(w.editInput()); } else { await w.extractor().extract(w.editInput()); await w.end(); }
      // Four calls would be made with room (the task's own reflection, its comments reflection, the edit's own reflection, the edits reflection): at 1 cent each the cap of 6 cents holds them all; a lower cap must stop the rest.
      expect(spent(w)).toBeLessThanOrEqual(CAP + 1e-9);
      expect(w.calls.length).toBeGreaterThanOrEqual(4);
    });
    it(`${order}: a cap of 3 cents stops the calls that would go over it`, async () => {
      const w = new World({ mergedHead: PUSHED });
      (w.learning.reflect as { capsOverride?: { perTaskUsd?: number } }).capsOverride = { perTaskUsd: 0.03 };
      if (order === "task end first") { await w.end(); await w.extractor().extract(w.editInput()); } else { await w.extractor().extract(w.editInput()); await w.end(); }
      expect(spent(w)).toBeLessThanOrEqual(0.03 + 1e-9);
      expect(w.calls.length).toBeGreaterThanOrEqual(2);
    });
  }
  it("a pull request with edits and no comment: the task end's own reflection still counts against the cap for the job (a cap of 2 cents holds two calls in all)", async () => {
    const w = new World({ mergedHead: PUSHED });
    w.commentIds = [];
    (w.learning.reflect as { capsOverride?: { perTaskUsd?: number } }).capsOverride = { perTaskUsd: 0.02 };
    await w.end();
    await w.extractor().extract(w.editInput());
    expect(w.calls.length * 0.01).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(w.repoCalls()).toHaveLength(0);
  });
  it("review L-g (C1): the task end and the job running AT THE SAME TIME never spend more than the cap: every call (reflections, judges, comments, edits) reserves on the shared ladder before it is made", async () => {
    for (const cap of [0.03, 0.05]) {
      const w = new World({ mergedHead: PUSHED });
      (w.learning.reflect as { capsOverride?: { perTaskUsd?: number } }).capsOverride = { perTaskUsd: cap };
      await Promise.all([w.end(), w.extractor().extract(w.editInput())]);
      expect(w.calls.length * 0.01, `cap ${String(cap)}`).toBeLessThanOrEqual(cap + 1e-9);
      expect(w.calls.length).toBeGreaterThanOrEqual(2);
      expect(await readTaskHeld(w.runtime.store, KEY, TASK, cap)).toBeLessThanOrEqual(cap + 1e-9);
    }
  });
  it("what the task end held is on the ladder for the job (and a job that finds the cap used up makes no repo-only call)", async () => {
    const w = new World({ mergedHead: PUSHED });
    await w.end();
    expect(await readTaskHeld(w.runtime.store, KEY, TASK, 0.15)).toBeGreaterThan(0);
    await noteTaskHeld(w.runtime.store, KEY, TASK, 0.15, 0.15);
    const before = w.repoCalls().length;
    await w.extractor().extract(w.editInput());
    expect(w.repoCalls()).toHaveLength(before);
  });
});

describe("review L-k: the comments reflection does not depend on the first reflection's retry state", () => {
  const attempt = () => ({ deadlineAt: Date.now() + 60_000 });
  it("the task's own reflection fails in a way the worker would retry: the result says retry, the comments reflection still runs; the retried delivery runs the first reflection again and does not repeat the comments one", async () => {
    const w = new World();
    w.mainFailures = 1;
    const first = await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK }));
    expect(first.retry).toBe(true);
    expect(w.mainCalls()).toHaveLength(0);
    expect(w.repoCalls()).toHaveLength(1);
    const second = await withLearningAttempt(attempt(), () => learnFromEndedTaskTyped(w.learning, { workspaceId: WS, taskId: TASK }));
    expect(second.retry).toBe(false);
    expect(w.mainCalls()).toHaveLength(1);
    expect(w.repoCalls()).toHaveLength(1);
  });
});
