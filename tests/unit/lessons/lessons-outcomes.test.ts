// Lessons outcomes lane: the end of a task counts its outcome for the lessons it loaded, with the corrections lessons already read (reviewers' pull request comments, "remember this" notes, send-backs), a judge on the
// company's own model path, and nothing recorded where learning cannot judge. The whole path, from the task end to a settled mark, is in tests/contract/lessons-outcomes-wired.test.ts.
import { describe, expect, it } from "vitest";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { modelCorrectionJudge } from "../../../packages/broker/src/lessons/judge-model.js";
import { settleHelpful, type CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { newTaskFailureTally, type CurrentPause, type FailureKind, type LessonsPauseStore } from "../../../packages/broker/src/lessons/pause.js";
import type { CorrectionJudge, CorrectionRating } from "../../../packages/broker/src/lessons/ports.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { looksLikeCorrection } from "../../../packages/broker/src/lessons/correction-filter.js";
import { currentLearningAttempt, noteLearningFault, withLearningAttempt, type LearningAttempt } from "../../../packages/broker/src/lessons/learning-deadline.js";
import { REFUSING_JUDGE } from "../../../packages/broker/src/lessons/runtime.js";
import { learnFromEndedTask, learnFromEndedTaskTyped, type TaskLearningDeps, type TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import type { EvidenceSpan } from "../../../packages/broker/src/lessons/reflect-input.js";
import { Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, embedder, facts, lessonRecord, reply, candidateJson, seed, settings, verifier } from "./lesson-helpers.js";

const DAY = 86_400_000;
const KEY = { workspaceId: WS, project: PROJECT };
const merged = { workspaceId: WS, taskId: "task-1", outcome: "merged" as const };
const MARK = "helpful:task-1:les_used0001";

class Rows implements OutcomeRowReader {
  reverter: { actorDeveloperId?: string } | undefined;
  async sendBack(): Promise<undefined> { return undefined; }
  async revertedBy(): Promise<{ actorDeveloperId?: string } | undefined> { return this.reverter; }
}

/** A judge that answers per correction text and remembers what it was asked. */
class RecordingJudge implements CorrectionJudge {
  asked: Array<{ kind: string; text: string; workspaceId: string; project: string }> = [];
  usableAnswer = true;
  constructor(public answer: CorrectionRating | ((text: string) => CorrectionRating) | Error = "unrelated") {}
  async usable(): Promise<boolean> { return this.usableAnswer; }
  async rate(input: Parameters<CorrectionJudge["rate"]>[0]): Promise<CorrectionRating> {
    this.asked.push({ kind: input.correctionKind, text: input.correctionText, workspaceId: input.workspaceId, project: input.project });
    if (this.answer instanceof Error) throw this.answer;
    return typeof this.answer === "function" ? this.answer(input.correctionText) : this.answer;
  }
}

const span = (kind: EvidenceSpan["kind"], text: string, over: Partial<EvidenceSpan> = {}): EvidenceSpan => ({ kind, text, trust: "member", authorId: "rev", eventId: `ev-${text.length}`, ...over });
const baseOf = (spans: EvidenceSpan[], over: Partial<TaskSubjectBase["facts"]> = {}): TaskSubjectBase => ({
  facts: {
    workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged", task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
    rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [], spans }, ...over,
  },
  sendBackRequestIds: [],
});

async function counted(spans: EvidenceSpan[], judge: CorrectionJudge, over: { settings?: ReturnType<typeof settings>; base?: TaskSubjectBase } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const configured = over.settings ?? settings({ mode: "On" });
  await seed(store, lessonRecord({ id: "les_used0001" }));
  await store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: [{ id: "les_used0001", version: 1, score: 0.5, why: "scope", citation: "valid" }], bytes: 10 });
  const rows = new Rows();
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), facts: facts(), settings: configured,
    newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const counters: CounterDeps = { store, judge, settings: configured, audit, now: clock.now };
  const deps: TaskLearningDeps = {
    source: { read: async () => over.base ?? baseOf(spans) }, rows, settings: configured, counters,
    reflect: { model: new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]), spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now }, process,
  };
  const queued = async () => (await store.duePending(KEY, clock.now() + 30 * DAY, 100)).map((entry) => entry.key);
  return { deps, store, rows, clock, queued, counters };
}

describe("the corrections lessons already read are judged against each loaded lesson", () => {
  it("a reviewer's pull request comment and a 'remember this' note are review comments for the judge (workspace and project named); unrelated leaves the helpful mark queued", async () => {
    const judge = new RecordingJudge("unrelated");
    const w = await counted([span("pr_comment", "You should use the shared helper", { paths: ["src/a.ts"] }), span("remembered", "always use the shared helper")], judge);
    expect(await learnFromEndedTask(w.deps, merged)).toBe("reflected");
    expect(judge.asked).toEqual([
      { kind: "review_comment", text: "You should use the shared helper", workspaceId: WS, project: PROJECT },
      { kind: "review_comment", text: "always use the shared helper", workspaceId: WS, project: PROJECT },
    ]);
    expect(await w.queued()).toEqual([MARK]);
  });
  it("a correction judged 'caused' marks the lesson harmful and queues no helpful mark; 'contradicts' too", async () => {
    for (const rating of ["caused", "contradicts"] as const) {
      const w = await counted([span("pr_comment", "This helper is wrong here, it breaks retries")], new RecordingJudge(rating));
      await learnFromEndedTask(w.deps, merged);
      expect((await w.store.get(KEY, "les_used0001"))!.counters.harmful, rating).toBe(1);
      expect(await w.queued(), rating).toEqual([]);
    }
  });
  it("'same_ignored' (the lesson was not followed) queues no helpful mark and no harmful one", async () => {
    const w = await counted([span("pr_comment", "You should use withRetry here, not a loop")], new RecordingJudge("same_ignored"));
    await learnFromEndedTask(w.deps, merged);
    expect((await w.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(0);
    expect(await w.queued()).toEqual([]);
  });
  it("an outsider's comment, a comment whose words are code's, and spans that are not corrections are never judged; a judge that fails leaves the correction unjudged (no helpful mark)", async () => {
    const judge = new RecordingJudge("unrelated");
    const w = await counted([span("pr_comment", "outsider words", { trust: "outsider" }), span("remembered", "fixed", { fixedText: true }), span("intent", "do the thing"), span("plan", "the plan"), span("review_finding", "agent finding", { trust: "system" })], judge);
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toEqual([]);
    expect(await w.queued()).toEqual([MARK]);
    const failing = await counted([span("pr_comment", "You should use the shared helper here")], new RecordingJudge(new Error("model down")));
    await learnFromEndedTask(failing.deps, merged);
    expect(await failing.queued()).toEqual([]);
    expect((await failing.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(0);
  });
  it("a long review thread costs a bounded number of calls: a lesson is judged against at most five corrections", async () => {
    const judge = new RecordingJudge("unrelated");
    const many = Array.from({ length: 30 }, (_, i) => span("pr_comment", `You should rename thing number ${i} instead`, { eventId: `ev-${i}` }));
    const w = await counted(many, judge);
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked.length).toBe(5);
    expect(await w.queued()).toEqual([MARK]);
  });
});

describe("nothing is recorded where outcomes cannot be judged (fails safe)", () => {
  it("learning Off or Collect: no judge call, no mark", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const judge = new RecordingJudge("unrelated");
      const w = await counted([span("pr_comment", "You should use the shared helper here")], judge, { settings: settings({ mode }) });
      await learnFromEndedTask(w.deps, merged);
      expect(judge.asked, mode).toEqual([]);
      expect(await w.queued(), mode).toEqual([]);
    }
  });
  it("a judge with no usable model (paused, no provider, month full): no judge call and no helpful mark, even with no corrections", async () => {
    const judge = new RecordingJudge("unrelated");
    judge.usableAnswer = false;
    const withComment = await counted([span("pr_comment", "You should use the shared helper here")], judge);
    await learnFromEndedTask(withComment.deps, merged);
    expect(judge.asked).toEqual([]);
    expect(await withComment.queued()).toEqual([]);
    const bare = await counted([], judge);
    await learnFromEndedTask(bare.deps, merged);
    expect(await bare.queued()).toEqual([]);
    // Positive control: the same task with a usable judge queues the mark.
    judge.usableAnswer = true;
    const usable = await counted([], judge);
    await learnFromEndedTask(usable.deps, merged);
    expect(await usable.queued()).toEqual([MARK]);
  });
  it("a revert still takes a queued mark back when no model is usable (the safe direction), judging nothing", async () => {
    const judge = new RecordingJudge("unrelated");
    const w = await counted([span("pr_comment", "You should use the shared helper here")], judge, { base: baseOf([]) });
    await learnFromEndedTask(w.deps, merged);
    expect(await w.queued()).toEqual([MARK]);
    judge.usableAnswer = false;
    w.rows.reverter = { actorDeveloperId: "rev" };
    await learnFromEndedTask(w.deps, { ...merged, outcome: "reverted" });
    expect(judge.asked).toEqual([]);
    expect(await w.queued()).toEqual([]);
  });
});

describe("a revert counts only when a verified member reverted it (DECISIONS: revert by commit message and revert PR)", () => {
  it("a revert with no verified reverter takes nothing back and judges nothing; one with a reverter takes the queued mark back", async () => {
    const judge = new RecordingJudge("unrelated");
    const w = await counted([], judge);
    await learnFromEndedTask(w.deps, merged);
    expect(await w.queued()).toEqual([MARK]);
    w.rows.reverter = {};
    await learnFromEndedTask(w.deps, { ...merged, outcome: "reverted" });
    expect(await w.queued()).toEqual([MARK]);
    w.rows.reverter = undefined;
    await learnFromEndedTask(w.deps, { ...merged, outcome: "reverted" });
    expect(await w.queued()).toEqual([MARK]);
    w.rows.reverter = { actorDeveloperId: "rev" };
    await learnFromEndedTask(w.deps, { ...merged, outcome: "reverted" });
    expect(await w.queued()).toEqual([]);
    // The revert is remembered: a merge delivered again later queues nothing.
    await learnFromEndedTask(w.deps, merged);
    expect(await w.queued()).toEqual([]);
  });
});

describe("the judge's failures are counted once for the task, with the reflection's", () => {
  class Pause implements LessonsPauseStore {
    failures: Record<FailureKind, number> = { reflect: 0, judge: 0 };
    async record(): Promise<void> { return undefined; }
    async clear(): Promise<void> { return undefined; }
    async failed(_w: string, _p: string, kind: FailureKind = "reflect"): Promise<number> { this.failures[kind] += 1; return this.failures[kind]; }
    async read(): Promise<CurrentPause | undefined> { return undefined; }
  }
  it("a task with several failing ratings counts ONE judge failure (the judge is scoped to the task's tally)", async () => {
    const pause = new Pause();
    const failing = { complete: async () => { throw new Error("provider down"); } };
    const judge = modelCorrectionJudge({ model: failing, spend: new Spend(), pause });
    const w = await counted([span("pr_comment", "You should use the shared helper here", { authorId: "a" }), span("pr_comment", "Please avoid the loop and use withRetry", { authorId: "b" }), span("remembered", "always use withRetry for retries", { authorId: "c" })], judge);
    await learnFromEndedTask(w.deps, merged);
    expect(pause.failures.judge).toBe(1);
    expect(await w.queued()).toEqual([]);
    // Positive control: unscoped, the same three failures count three.
    const unscoped = new Pause();
    const bare = modelCorrectionJudge({ model: failing, spend: new Spend(), pause: unscoped });
    for (const text of ["one", "two", "three"]) await bare.rate({ workspaceId: WS, project: PROJECT, lesson: lessonRecord(), correctionKind: "review_comment", correctionText: text }).catch(() => undefined);
    expect(unscoped.failures.judge).toBe(3);
    void newTaskFailureTally;
  });
});

describe("settleHelpful applies the mark after the revert window and renews the lesson", () => {
  it("a mark queued by a clean merge is due after 14 days, settles once, counts helpful and moves the expiry", async () => {
    const w = await counted([], new RecordingJudge("unrelated"));
    await learnFromEndedTask(w.deps, merged);
    expect(await settleHelpful(w.counters, KEY)).toBe(0);
    w.clock.advance(15 * DAY);
    const before = (await w.store.get(KEY, "les_used0001"))!.expiresAt;
    expect(await settleHelpful(w.counters, KEY)).toBe(1);
    expect(await settleHelpful(w.counters, KEY)).toBe(0);
    const lesson = (await w.store.get(KEY, "les_used0001"))!;
    expect(lesson.counters.helpful).toBe(1);
    expect(lesson.expiresAt).toBeGreaterThan(before);
  });
});

describe("M1: only a correction that is really about a lesson harms it", () => {
  it("praise, nits, acknowledgements and bare questions never reach the judge; a request that is phrased as a question does", () => {
    for (const text of ["LGTM!", "Looks good to me, thanks", "nit: rename this variable please", "Nice work on the retry change", "Why is this here?", "Is this still needed here?", "ok", "+1 ship it"]) expect(looksLikeCorrection(text), text).toBe(false);
    for (const text of ["You should use withRetry instead of the loop", "On src/a.ts: this drops errors, use the shared helper", "Why not use the shared helper instead of a copy?", "Don't call the client directly from the handler"]) expect(looksLikeCorrection(text), text).toBe(true);
  });
  it("the task initiator's own comments, quoted or forwarded text, and comments that do not read as corrections are not judged", async () => {
    const judge = new RecordingJudge("caused");
    // (the initiator is whoever the task record says started it: `startedBy` in the base's facts)
    const w = await counted([
      span("pr_comment", "You should use the shared helper here", { authorId: "starter" }), span("remembered", "always use the shared helper for this", { authorId: "starter" }),
      span("pr_comment", "> You should use the shared helper here\nThat is what they wrote to me", { authorId: "rev" }), span("pr_comment", "LGTM, nice work on this one", { authorId: "rev" }),
      span("pr_comment", "nit: rename this variable to something clearer", { authorId: "rev" }),
    ], judge);
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toEqual([]);
    expect(await w.queued()).toEqual([MARK]);
  });
  it("the file a comment was made on goes with it: a lesson that does not reach the file is not judged against it, one that does is", async () => {
    const judge = new RecordingJudge("caused");
    const w = await counted([span("pr_comment", "This contradicts the lesson, say the opposite", { paths: ["docs/README.md"] })], judge);
    await seed(w.store, lessonRecord({ id: "les_used0001", scope: { repos: ["api"], paths: ["src/retry/**"] } }));
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toEqual([]);
    expect((await w.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(0);
    const reached = await counted([span("pr_comment", "This contradicts the lesson, say the opposite", { paths: ["src/retry/a.ts"] })], new RecordingJudge("caused"));
    await seed(reached.store, lessonRecord({ id: "les_used0001", scope: { repos: ["api"], paths: ["src/retry/**"] } }));
    await learnFromEndedTask(reached.deps, merged);
    expect((await reached.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(1);
  });
  it("two different members' comments are two harmful marks and retire a tier-0 lesson; one member's two comments are one mark", async () => {
    const two = await counted([span("pr_comment", "This is wrong, avoid this helper", { authorId: "ann" }), span("pr_comment", "Please don't use this helper here", { authorId: "bob" })], new RecordingJudge("caused"));
    await seed(two.store, lessonRecord({ id: "les_used0001", tier: 0 }));
    await learnFromEndedTask(two.deps, merged);
    expect((await two.store.get(KEY, "les_used0001"))!).toMatchObject({ status: "retired", counters: { harmful: 2 } });
    const one = await counted([span("pr_comment", "This is wrong, avoid this helper", { authorId: "ann" }), span("pr_comment", "Please don't use this helper here", { authorId: "ann" })], new RecordingJudge("caused"));
    await seed(one.store, lessonRecord({ id: "les_used0001", tier: 0 }));
    await learnFromEndedTask(one.deps, merged);
    expect((await one.store.get(KEY, "les_used0001"))!).toMatchObject({ status: "active", counters: { harmful: 1 } });
  });
});

describe("L1: no model wired records nothing", () => {
  it("the refusing judge is never usable: a merged task with no corrections queues no helpful mark", async () => {
    expect(await REFUSING_JUDGE.usable!({ workspaceId: WS, project: PROJECT })).toBe(false);
    const w = await counted([], REFUSING_JUDGE);
    await learnFromEndedTask(w.deps, merged);
    expect(await w.queued()).toEqual([]);
  });
});

describe("M3: the reflection comes first; judging has its own time and its own lease", () => {
  const comments = [span("pr_comment", "You should use the shared helper here", { authorId: "ann" }), span("pr_comment", "Please avoid this loop, use withRetry", { authorId: "bob" }), span("remembered", "always use withRetry for retries", { authorId: "cat" })];
  const attempt = (over: Partial<LearningAttempt> = {}): LearningAttempt => ({ deadlineAt: Date.now() + 240_000, signal: new AbortController().signal, attemptId: "att-1", leaseKey: { pk: "LEARN#x", sk: "CLAIM" }, callStarting: async () => undefined, ...over });

  it("the reflector's model is called before the first judge call", async () => {
    const order: string[] = [];
    const judge = new RecordingJudge("unrelated");
    const w = await counted(comments, judge);
    const reflectModel = w.deps.reflect.model;
    w.deps.reflect.model = { complete: async (request) => { order.push("reflect"); return reflectModel.complete(request); } };
    const rate = judge.rate.bind(judge);
    judge.rate = async (input) => { order.push("judge"); return rate(input); };
    await learnFromEndedTask(w.deps, merged);
    expect(order[0]).toBe("reflect");
    expect(order.filter((o) => o === "judge").length).toBeGreaterThan(0);
  });
  it("the judge runs as its own attempt: not the reflection's lease or call mark, and its faults stay its own, so a judge-heavy task is still reflected and a failed reflection is still retried", async () => {
    const seen: Array<LearningAttempt | undefined> = [];
    const judge = new RecordingJudge("unrelated");
    judge.rate = async () => { seen.push(currentLearningAttempt()); noteLearningFault("final"); throw new Error("judge down"); };
    const w = await counted(comments, judge);
    w.deps.reflect.model = { complete: async () => { noteLearningFault("retryable"); throw new Error("model down"); } };
    const outer = attempt();
    const result = await withLearningAttempt(outer, () => learnFromEndedTaskTyped(w.deps, merged));
    expect(seen.length).toBeGreaterThan(0);
    for (const inner of seen) {
      expect(inner).not.toBe(outer);
      expect(inner!.leaseKey).toBeUndefined();
      expect(inner!.callStarting).toBeUndefined();
      expect(inner!.signal).toBe(outer.signal);
    }
    // The reflection's own fault is the only one the worker reads: it is retryable, whatever the judge noted.
    expect(outer.fault).toBe("retryable");
    expect(result).toEqual({ status: "not_reflected", retry: true });
  });
  it("judging stops starting calls when its own time is used up; the rest are unjudged (no helpful mark), and the next delivery judges them again", async () => {
    let clock: Clock | undefined;
    const judge = new RecordingJudge("unrelated");
    const rate = judge.rate.bind(judge);
    judge.rate = async (input) => { clock!.advance(40_000); return rate(input); };
    const w = await counted(comments, judge);
    clock = w.clock;
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toHaveLength(2);
    expect(await w.queued()).toEqual([]);
    w.clock.advance(61_000);
    judge.rate = rate;
    // Nothing was counted for good, so the redelivery judges everything (all three) and now queues the mark.
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toHaveLength(2 + 3);
    expect(await w.queued()).toEqual([MARK]);
  });
  it("a task judged to the end is counted for good: a reflection tried again does not pay for the judging again", async () => {
    const judge = new RecordingJudge("unrelated");
    const w = await counted(comments, judge);
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toHaveLength(3);
    await learnFromEndedTask(w.deps, merged);
    expect(judge.asked).toHaveLength(3);
  });
  it("a revert never pays for the comments again: only the merge's end judged them", async () => {
    const judge = new RecordingJudge("unrelated");
    const w = await counted(comments, judge);
    await learnFromEndedTask(w.deps, merged);
    const paid = judge.asked.length;
    w.rows.reverter = { actorDeveloperId: "rev" };
    await learnFromEndedTask(w.deps, { ...merged, outcome: "reverted" });
    expect(judge.asked).toHaveLength(paid);
    expect(await w.queued()).toEqual([]);
  });
});

describe("L7: erasing a commenter takes back the harmful marks their corrections caused", () => {
  it("their marks are removed (once, floor zero), another member's mark stays, and a mark made by a button is left as the existing rule has it; the person can make no new mark", async () => {
    const { lessonDeletionPort } = await import("../../../packages/broker/src/lessons/deletion.js");
    const judge = new RecordingJudge("caused");
    const w = await counted([span("pr_comment", "This is wrong, avoid this helper", { authorId: "erin" }), span("pr_comment", "Please don't use this helper here", { authorId: "fay" })], judge);
    await seed(w.store, lessonRecord({ id: "les_used0001", tier: 1 }));
    await learnFromEndedTask(w.deps, merged);
    expect((await w.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(2);
    const port = lessonDeletionPort({ store: w.store, vectors: new MemoryVectors(), audit: new Audit(), now: w.clock.now });
    await port.erasePerson(WS, PROJECT, { developerId: "erin" }, new Set());
    expect((await w.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(1);
    // A second erasure of the same person takes nothing more back.
    await port.erasePerson(WS, PROJECT, { developerId: "erin" }, new Set());
    expect((await w.store.get(KEY, "les_used0001"))!.counters.harmful).toBe(1);
    expect(await w.store.markRef(KEY, "erin")).toBeUndefined();
    expect(await w.store.takeBackHarm(KEY, "fay")).toEqual(["les_used0001"]);
  });
});
