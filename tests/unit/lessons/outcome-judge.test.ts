// Lessons outcomes lane: the correction judge that rates a correction against a lesson loaded into the task. It rides the company's own learning model path (customer pays): the same quote, spend look, Public per-task
// cap, pause codes and failure counts as the curator's judge. A failure is an unjudged correction (no helpful mark), never a thrown-away task.
import { describe, expect, it } from "vitest";
import { modelCorrectionJudge } from "../../../packages/broker/src/lessons/judge-model.js";
import { LearningRefusal, MODEL_FAILURES_BEFORE_PAUSE, newTaskFailureTally, type CurrentPause, type FailureKind, type LessonsPauseStore } from "../../../packages/broker/src/lessons/pause.js";
import type { PipelineModel } from "../../../packages/broker/src/lessons/ports.js";
import { ScriptedModel, Spend, WS, PROJECT, lessonRecord } from "./lesson-helpers.js";

class MemoryPause implements LessonsPauseStore {
  reasons: string[] = [];
  failures: Record<FailureKind, number> = { reflect: 0, judge: 0 };
  judgeCleared = 0;
  cleared = 0;
  async record(_w: string, _p: string, code: CurrentPause["code"]): Promise<void> { this.reasons.push(code); }
  async clear(): Promise<void> { this.cleared += 1; }
  async clearJudgeFailures(): Promise<void> { this.judgeCleared += 1; this.failures.judge = 0; }
  async failed(_w: string, _p: string, kind: FailureKind = "reflect"): Promise<number> { this.failures[kind] += 1; return this.failures[kind]; }
  async read(): Promise<CurrentPause | undefined> { return undefined; }
}

class QuotingModel extends ScriptedModel {
  quotes: Array<Record<string, unknown>> = [];
  constructor(replies: ConstructorParameters<typeof ScriptedModel>[0], public answer: Awaited<ReturnType<NonNullable<PipelineModel["quote"]>>> = { ok: true, usd: 0.004 }) { super(replies); }
  async quote(request: Parameters<NonNullable<PipelineModel["quote"]>>[0]) { this.quotes.push({ ...request }); return this.answer; }
}

const input = { workspaceId: WS, project: PROJECT, lesson: lessonRecord(), correctionKind: "review_comment" as const, correctionText: "use the shared helper" };
const caused = '{"rating":"caused"}';

describe("the outcome judge goes through the company's learning model path", () => {
  it("rates with a fixed code, quotes first, holds the quote, and Public's per-task cap goes with the call (the curator judge's rule)", async () => {
    const model = new QuotingModel([caused, '```json\n{"rating":"unrelated"}\n```']);
    const spend = new Spend();
    const judge = modelCorrectionJudge({ model, spend, edition: "public" });
    expect(await judge.rate(input)).toBe("caused");
    expect(await judge.rate(input)).toBe("unrelated");
    expect(model.quotes[0]).toMatchObject({ purpose: "outcome", workspaceId: WS, project: PROJECT, maxHoldUsd: 0.15 });
    expect(model.calls[0]).toMatchObject({ purpose: "outcome", workspaceId: WS, project: PROJECT, maxHoldUsd: 0.15, budgetUsd: 0.004 });
    expect(spend.asked[0]).toBe(0.004);
  });
  it("Enterprise has no per-task cap of its own: none is passed", async () => {
    const model = new QuotingModel([caused]);
    await modelCorrectionJudge({ model, spend: new Spend(), edition: "enterprise" }).rate(input);
    expect("maxHoldUsd" in model.calls[0]!).toBe(false);
  });
  it("a model that cannot quote keeps the fixed judge estimate for the spend look", async () => {
    const model = new ScriptedModel([caused]);
    const spend = new Spend();
    await modelCorrectionJudge({ model, spend }).rate(input);
    expect(spend.asked).toEqual([0.01]);
  });

  it("a quote that refuses records its pause code, makes no call, and leaves the correction unjudged (throws)", async () => {
    const pause = new MemoryPause();
    const model = new QuotingModel([caused], { ok: false, code: "no_provider" });
    await expect(modelCorrectionJudge({ model, spend: new Spend(), pause }).rate(input)).rejects.toThrow();
    expect(model.calls).toEqual([]);
    expect(pause.reasons).toEqual(["no_provider"]);
  });
  it("a quote that throws counts one judge failure and makes no call", async () => {
    const pause = new MemoryPause();
    const model = Object.assign(new ScriptedModel([caused]), { quote: async () => { throw new Error("table down"); } });
    await expect(modelCorrectionJudge({ model, spend: new Spend(), pause }).rate(input)).rejects.toThrow();
    expect(model.calls).toEqual([]);
    expect(pause.failures).toEqual({ reflect: 0, judge: 1 });
  });
  it("the month's limit (the spend look) records monthly_limit, makes no call, and is unjudged", async () => {
    const pause = new MemoryPause();
    const spend = new Spend();
    spend.admitted = false;
    const model = new QuotingModel([caused]);
    await expect(modelCorrectionJudge({ model, spend, pause }).rate(input)).rejects.toThrow();
    expect(model.calls).toEqual([]);
    expect(pause.reasons).toEqual(["monthly_limit"]);
  });
  it("a failed call counts a judge failure; a refusal records its code and counts none; an answer that does not parse counts one; a good answer starts the judge's count again", async () => {
    const pause = new MemoryPause();
    const model = new QuotingModel([new Error("provider 500"), new LearningRefusal("no_budget", "no budget"), "not json", '{"rating":"maybe"}', caused]);
    const judge = modelCorrectionJudge({ model, spend: new Spend(), pause });
    for (let i = 0; i < 4; i += 1) await expect(judge.rate(input)).rejects.toThrow();
    // The refusal recorded its own code and counted nothing; the three failed calls in a row (500, unparseable, unknown rating) paused the project as model_failed.
    expect(pause.reasons).toEqual(["no_budget", "model_failed"]);
    expect(pause.failures.judge).toBe(3);
    expect(await judge.rate(input)).toBe("caused");
    expect(pause.judgeCleared).toBe(1);
    expect(pause.failures.judge).toBe(0);
  });
  it("three tasks that each fail the judge pause the project as model_failed; one task's several failed calls count once (forTask)", async () => {
    const pause = new MemoryPause();
    const judge = modelCorrectionJudge({ model: new QuotingModel([]), spend: new Spend(), pause });
    const tally = newTaskFailureTally();
    const scoped = judge.forTask!(tally);
    for (let i = 0; i < 5; i += 1) await expect(scoped.rate(input)).rejects.toThrow();
    expect(pause.failures.judge).toBe(1);
    expect(pause.reasons).toEqual([]);
    for (let task = 0; task < MODEL_FAILURES_BEFORE_PAUSE - 1; task += 1) await expect(judge.forTask!(newTaskFailureTally()).rate(input)).rejects.toThrow();
    expect(pause.reasons).toEqual(["model_failed"]);
  });
});

describe("usable: whether outcomes can be rated now (learning not paused, a usable model, the month has room)", () => {
  it("is true when the model quotes and the month has room; it quotes a tiny probe, records nothing and holds nothing", async () => {
    const pause = new MemoryPause();
    const model = new QuotingModel([]);
    expect(await modelCorrectionJudge({ model, spend: new Spend(), pause }).usable!({ workspaceId: WS, project: PROJECT })).toBe(true);
    expect(model.quotes[0]).toMatchObject({ purpose: "outcome", workspaceId: WS, project: PROJECT, maxHoldUsd: 0.15 });
    expect(model.calls).toEqual([]);
    expect(pause.reasons).toEqual([]);
    expect(pause.failures).toEqual({ reflect: 0, judge: 0 });
  });
  it("is false for a refused quote, a quote that throws, and a month that is full, without recording anything", async () => {
    const pause = new MemoryPause();
    const refused = new QuotingModel([], { ok: false, code: "all_models_forbidden" });
    expect(await modelCorrectionJudge({ model: refused, spend: new Spend(), pause }).usable!({ workspaceId: WS, project: PROJECT })).toBe(false);
    const broken = Object.assign(new ScriptedModel(), { quote: async () => { throw new Error("down"); } });
    expect(await modelCorrectionJudge({ model: broken, spend: new Spend(), pause }).usable!({ workspaceId: WS, project: PROJECT })).toBe(false);
    const full = new Spend();
    full.admitted = false;
    expect(await modelCorrectionJudge({ model: new QuotingModel([]), spend: full, pause }).usable!({ workspaceId: WS, project: PROJECT })).toBe(false);
    expect(pause.reasons).toEqual([]);
    expect(pause.failures).toEqual({ reflect: 0, judge: 0 });
  });
});
