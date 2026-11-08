// LP-13 C3: a draft whose curate-and-settle step failed on a passing store fault (before any model call) is tried once more inside the worker's deadline; it is NEVER tried again once the step started a model call
// (the customer pays for each call, so a retry must not double-charge), after a fault that is not a passing one, or when the deadline is near or past.
import { describe, expect, it } from "vitest";
import { DRAFT_RETRY_MIN_LEFT_MS, processDraftRetrying } from "../../../packages/broker/src/lessons/draft-retry.js";
import { withLearningAttempt } from "../../../packages/broker/src/lessons/learning-deadline.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import type { LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, closeEmbedder, draft, facts, settings, verifier } from "./lesson-helpers.js";

const throttled = (): Error => Object.assign(new Error("secret table text"), { name: "ThrottlingException" });
const text = (title: string, body: string): LessonDraft => draft({ title, description: "", body });
const A = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
const REWORDED = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
const one = (verdict: string): string => JSON.stringify({ verdicts: [{ n: 1, verdict }] });

function setup(model: ScriptedModel = new ScriptedModel()) {
  const store = new InMemoryLessonStore();
  const clock = new Clock();
  let n = 0;
  const deps: ProcessDeps = {
    store, embedder: closeEmbedder, vectors: new MemoryVectors(), judgeModel: model, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  /** Makes the next `times` commits fail with `error` before anything is written. */
  const failCommits = (error: Error, times: number): { attempts: () => number } => {
    const real = store.commit.bind(store);
    let failures = 0, attempts = 0;
    store.commit = (async (...args: Parameters<typeof real>) => { attempts += 1; if (failures < times) { failures += 1; throw error; } return real(...args); }) as typeof store.commit;
    return { attempts: () => attempts };
  };
  return { deps, store, failCommits };
}
const noWait = { sleep: async () => undefined };
const logsOf = () => { const lines: Array<[string, Record<string, string | number>]> = []; return { lines, log: (event: string, fields: Record<string, string | number>) => { lines.push([event, fields]); } }; };

describe("processDraftRetrying", () => {
  it("tries once more after a passing store fault before any model call: the draft lands once, no model call is made, and one fixed line says it was retried", async () => {
    const w = setup();
    const commits = w.failCommits(throttled(), 1);
    const logs = logsOf();
    const result = await processDraftRetrying(w.deps, KEY, text("Retries", A), { ...noWait, log: logs.log });
    expect(result.outcome.outcome).toBe("added");
    // the failed try, then the add and the settle's own commit
    expect(commits.attempts()).toBe(3);
    expect(await w.store.list(KEY)).toHaveLength(1);
    expect((w.deps.judgeModel as ScriptedModel).calls).toHaveLength(0);
    expect(logs.lines).toEqual([["learning.draft_retried", {}]]);
    expect(JSON.stringify(logs.lines)).not.toContain("secret");
  });

  it("only once: a second passing fault is the caller's (the draft is lost as before), after exactly two tries", async () => {
    const w = setup();
    const commits = w.failCommits(throttled(), 5);
    await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(commits.attempts()).toBe(2);
  });

  it("NEVER after a model call started: a passing fault after the judge was called is not retried, so the judge is not called (and paid for) twice", async () => {
    const model = new ScriptedModel([one("different"), one("different")]);
    const w = setup(model);
    await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait);
    const commits = w.failCommits(throttled(), 1);
    await expect(processDraftRetrying(w.deps, KEY, text("Wrapped", REWORDED), noWait)).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(model.calls).toHaveLength(1);
    expect(commits.attempts()).toBe(1);
  });

  it("a call that failed on its own counts as started too: the judge refusing or throwing is a call that may have been made", async () => {
    const model = new ScriptedModel([new Error("provider down")]);
    const w = setup(model);
    await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait);
    const commits = w.failCommits(throttled(), 1);
    await expect(processDraftRetrying(w.deps, KEY, text("Wrapped", REWORDED), noWait)).rejects.toMatchObject({ name: "ThrottlingException" });
    expect(model.calls).toHaveLength(1);
    expect(commits.attempts()).toBe(1);
  });

  it("a fault that is not a passing one is final, with no second try (a validation fault, a refused write, a bug)", async () => {
    for (const error of [new Error("table text"), Object.assign(new Error("x"), { name: "ValidationException" }), Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" })]) {
      const w = setup();
      const commits = w.failCommits(error, 1);
      await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).rejects.toBe(error);
      expect(commits.attempts()).toBe(1);
    }
  });

  it("a server-side status (5xx) counts as a passing fault", async () => {
    const w = setup();
    const commits = w.failCommits(Object.assign(new Error("x"), { name: "SomethingElse", $metadata: { httpStatusCode: 503 } }), 1);
    expect((await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).outcome.outcome).toBe("added");
    expect(commits.attempts()).toBe(3);
  });

  it("inside a worker attempt: not at the deadline (the signal is aborted) and not when less than the minimum is left; with enough time it is retried", async () => {
    const aborted = new AbortController();
    aborted.abort();
    for (const attempt of [{ deadlineAt: Date.now() + 60_000, signal: aborted.signal }, { deadlineAt: Date.now() + DRAFT_RETRY_MIN_LEFT_MS - 1_000 }]) {
      const w = setup();
      const commits = w.failCommits(throttled(), 1);
      await withLearningAttempt(attempt, async () => { await expect(processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).rejects.toMatchObject({ name: "ThrottlingException" }); });
      expect(commits.attempts()).toBe(1);
    }
    const w = setup();
    const commits = w.failCommits(throttled(), 1);
    await withLearningAttempt({ deadlineAt: Date.now() + 60_000, signal: new AbortController().signal }, async () => { expect((await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait)).outcome.outcome).toBe("added"); });
    expect(commits.attempts()).toBe(3);
  });

  it("the wrapper hands the real judge model through untouched (the retry guard counts calls, it does not change them)", async () => {
    const model = new ScriptedModel([one("different")]);
    const w = setup(model);
    await processDraftRetrying(w.deps, KEY, text("Retries", A), noWait);
    const second = await processDraftRetrying(w.deps, KEY, text("Wrapped", REWORDED), noWait);
    expect(second.outcome.outcome).toBe("added");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]).toMatchObject({ purpose: "judge" });
  });
});
