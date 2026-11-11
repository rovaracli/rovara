// Owner decision 47 (LEARNING-COLLECT-WHILE-OFF): while the install's lessons switch (`ll`, LEARNED_LESSONS_ENABLED) is off, learning makes NO model call, whatever a project chose. Every path that would call a model behaves as Collect:
// evidence is captured, nothing is reflected, loaded or auto-applied, nothing is spent. An unreadable switch is off. The stored project and company modes never change: turning the switch on gives each project its own mode back.
// Two locks are tested apart: the CAP in `resolveLearning` (every pipeline path obeys it) and the ENTRY-POINT defence on the model itself (a path that skipped `resolveLearning` still cannot spend).
import { learningModeKey } from "@rovara-code/contracts";
import type { InvokeCommand, InvokeCommandOutput } from "@aws-sdk/client-lambda";
import { afterEach, describe, expect, it } from "vitest";
import { customerLearningModel } from "../../../packages/broker/src/aws/broker/learning-model.js";
import type { LessonsHostDependencies } from "../../../packages/broker/src/aws/broker/definitions.js";
import { curateDraft } from "../../../packages/broker/src/lessons/curate.js";
import { dynamoLearningSettings, DynamoTier0Settings } from "../../../packages/broker/src/lessons/dynamo-settings.js";
import { createHumanEditExtractor } from "../../../packages/broker/src/lessons/human-edit.js";
import { gatedByLessonsSwitch, LESSONS_SWITCHED_OFF } from "../../../packages/broker/src/lessons/model-gate.js";
import { learnedLessonsSwitchOn, modeAllows, resolveLearning, setLearnedLessonsGate, type LearningMode, type LearningSettings } from "../../../packages/broker/src/lessons/policy.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { createLessonsRuntime } from "../../../packages/broker/src/lessons/runtime.js";
import { reflectSubject } from "../../../packages/broker/src/lessons/reflect.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { learnFromEndedTask, learnFromEndedTaskTyped, type TaskLearningDeps, type TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import { learnFromHumanEdit } from "../../../packages/broker/src/lessons/human-edit.js";
import { LearningNotForwarded } from "../../../packages/broker/src/model-proxy/access.js";
import { ModelAccessInvoker } from "../../../packages/broker/src/model-proxy/invoker.js";
import { ORG_A, world } from "../../support/team-record-core.js";
import { Alerts, Audit, BASE, Clock, KEY, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, closeEmbedder, draft, embedder, facts, memberSpan, reply, settings, subject, verifier } from "./lesson-helpers.js";

afterEach(() => { setLearnedLessonsGate(undefined); });

/** The two ways the switch is not on: the install says "0", and a switch that cannot be read at all. */
const OFF_STATES = { off: () => false, unreadable: () => { throw new Error("the environment cannot be read"); } } as const;
const offStates = Object.entries(OFF_STATES) as Array<[keyof typeof OFF_STATES, () => boolean]>;

describe("the cap in resolveLearning", () => {
  it("with the switch on, the project's own mode applies unchanged (every mode)", async () => {
    setLearnedLessonsGate(() => true);
    for (const mode of ["Off", "Collect", "Suggest", "On"] as const) {
      const resolved = await resolveLearning(settings({ mode }), WS, PROJECT);
      expect(resolved).toMatchObject({ mode, chosenMode: mode, switchedOff: false });
    }
  });

  it.each(offStates)("with the switch %s, no mode can reflect, load or auto-apply; capture stays; a project that chose Off stays Off; the project's choice is still reported", async (_name, gate) => {
    setLearnedLessonsGate(gate);
    const expected: Record<LearningMode, LearningMode> = { Off: "Off", Collect: "Collect", Suggest: "Collect", On: "Collect" };
    for (const mode of ["Off", "Collect", "Suggest", "On"] as const) {
      const resolved = await resolveLearning(settings({ mode }), WS, PROJECT);
      expect(resolved, mode).toMatchObject({ mode: expected[mode], chosenMode: mode, switchedOff: true });
      for (const action of ["reflect", "load", "auto_apply"] as const) expect(modeAllows(resolved.mode, action), `${mode}/${action}`).toBe(false);
      expect(modeAllows(resolved.mode, "capture")).toBe(mode !== "Off");
    }
  });

  it("the company's lock still applies first, and a setting that does not read is still Off; neither reads as 'on' while the switch is off", async () => {
    setLearnedLessonsGate(() => false);
    expect(await resolveLearning(settings({ mode: "On", companyLock: "Suggest" }), WS, PROJECT)).toMatchObject({ mode: "Collect", chosenMode: "Suggest" });
    expect(await resolveLearning(settings({ mode: "On", companyLock: "Off" }), WS, PROJECT)).toMatchObject({ mode: "Off", chosenMode: "Off" });
    expect(await resolveLearning({ read: async () => { throw new Error("down"); } }, WS, PROJECT)).toMatchObject({ mode: "Off", chosenMode: "Off", switchedOff: true });
    expect(await resolveLearning(settings({ mode: "Bogus" as never }), WS, PROJECT)).toMatchObject({ mode: "Off", switchedOff: true });
  });

  it("the stored settings are not touched: the same row gives the project's own mode back the moment the switch is on", async () => {
    const stored: LearningSettings = { mode: "On", companyLock: "Suggest" };
    const snapshot = JSON.stringify(stored);
    const reader = { read: async () => stored };
    setLearnedLessonsGate(() => false);
    expect((await resolveLearning(reader, WS, PROJECT)).mode).toBe("Collect");
    setLearnedLessonsGate(() => true);
    expect((await resolveLearning(reader, WS, PROJECT)).mode).toBe("Suggest");
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it("the default reading of the switch is the environment variable, exactly \"1\" and nothing else; it is read at every resolve", async () => {
    const was = process.env["LEARNED_LESSONS_ENABLED"];
    try {
      for (const [value, on] of [["1", true], ["0", false], ["", false], ["true", false], [" 1", false], [undefined, false]] as const) {
        if (value === undefined) delete process.env["LEARNED_LESSONS_ENABLED"]; else process.env["LEARNED_LESSONS_ENABLED"] = value;
        expect(learnedLessonsSwitchOn(), String(value)).toBe(on);
        expect((await resolveLearning(settings({ mode: "On" }), WS, PROJECT)).mode, String(value)).toBe(on ? "On" : "Collect");
      }
    } finally { if (was === undefined) delete process.env["LEARNED_LESSONS_ENABLED"]; else process.env["LEARNED_LESSONS_ENABLED"] = was; }
  });

  it("the nightly passes make no model call and are not capped: trialAllowed is a fact about the project's own settings (a lesson already on trial still reaches stable)", async () => {
    setLearnedLessonsGate(() => false);
    const standard = await resolveLearning(settings({ mode: "On", preset: "standard" }), WS, PROJECT);
    expect(standard).toMatchObject({ mode: "Collect", trialAllowed: true });
    setLearnedLessonsGate(() => true);
    expect((await resolveLearning(settings({ mode: "On", preset: "standard" }), WS, PROJECT)).trialAllowed).toBe(true);
  });
});

// ---- each model path, switch off (and unreadable): zero model calls, nothing read that only a model needs ----

const LINK = "https://github.com/acme/api/pull/7";
const baseFacts = (): TaskSubjectBase => ({
  facts: {
    workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
    task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
    rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [LINK], spans: [memberSpan("Use withRetry for HTTP retries in api.", { eventId: "ev-p" })] },
  },
  sendBackRequestIds: ["req-1"],
});

function parts(configured: ReturnType<typeof settings>, model: ScriptedModel) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const judge = new ScriptedModel();
  const reads: string[] = [];
  const rowsAsked: string[] = [];
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: judge, spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: configured, newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const deps: TaskLearningDeps = {
    source: { read: async (input) => { reads.push(input.taskId); return baseFacts(); } },
    rows: { sendBack: async () => { rowsAsked.push("sendback"); return undefined; }, revertedBy: async () => { rowsAsked.push("reverted_by"); return undefined; } },
    settings: configured, reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now }, process,
  };
  return { deps, store, judge, reads, rowsAsked, audit, clock, process };
}

describe.each(offStates)("with the lessons switch %s: every model path makes zero model calls", (_name, gate) => {
  const on = (mode: LearningMode = "On") => settings({ mode });

  it("task-end reflection: nothing is read and the model is never called, for every mode a project can choose", async () => {
    setLearnedLessonsGate(gate);
    for (const mode of ["Off", "Collect", "Suggest", "On"] as const) {
      const model = new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
      const w = parts(on(mode), model);
      expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" }), mode).toBe("off");
      expect(model.calls, mode).toEqual([]);
      expect(w.judge.calls).toEqual([]);
      // (The task's project is read to know which setting applies, as with Collect today; the rows only a reflection needs are not.)
      expect(w.rowsAsked).toEqual([]);
      expect(await w.store.list(KEY)).toEqual([]);
    }
  });

  it("reflect: a subject handed straight to the reflector is skipped for mode_off and the model is never called", async () => {
    setLearnedLessonsGate(gate);
    const model = new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
    const w = parts(on(), model);
    const result = await reflectSubject(w.deps.reflect, subject([memberSpan("Use withRetry for HTTP retries in api.")]));
    expect(result).toMatchObject({ status: "skipped", reason: "mode_off" });
    expect(model.calls).toEqual([]);
  });

  it("human-edit reflection: the extractor and the worker's entry both stop before the compare is read or the model is called", async () => {
    setLearnedLessonsGate(gate);
    const model = new ScriptedModel([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] }))]);
    const w = parts(on(), model);
    let sourceReads = 0;
    const extractor = createHumanEditExtractor({
      source: { read: async () => { sourceReads += 1; return baseFacts(); } }, settings: w.deps.settings, reflect: w.deps.reflect, process: w.process,
      standing: async () => "member", isErased: async () => false,
    });
    const edit = { workspaceId: WS, project: PROJECT, repo: "acme/api", taskId: "task-1", pullRequest: { number: 7, url: LINK }, trust: "member" as const, authorCount: 1, authors: ["rae"],
      files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, symbols: [], hunks: ["@@ -1 +1 @@", "-a", "+b"] }], link: LINK, audience: { kind: "project" as const }, scope: "github:repo/77" };
    expect(await extractor.extract(edit)).toEqual({ candidates: 0 });
    expect(model.calls).toEqual([]);
    expect(sourceReads).toBe(0);
    let handed = 0;
    expect(await learnFromHumanEdit({ run: async () => { handed += 1; return "handed_on"; }, settings: w.deps.settings }, { repo: { workspaceId: WS } as never, project: PROJECT } as never)).toEqual({ status: "off", retry: false });
    expect(handed).toBe(0);
  });

  it("curator judge: a draft that needs a judge gets none (nothing is quoted, looked at or sent) and is kept for a person, as with no judge at all", async () => {
    setLearnedLessonsGate(gate);
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const reworded = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
    const text = (body: string) => draft({ title: "Retries", description: "", body });
    const judge = new ScriptedModel([JSON.stringify({ verdicts: [{ n: 1, verdict: "different" }] })]);
    const spend = new Spend();
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps = { store, embedder: closeEmbedder, vectors: new MemoryVectors(), judgeModel: judge, spend, audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}` };
    await curateDraft(deps, KEY, text(a));
    const out = await curateDraft(deps, KEY, text(reworded));
    // With no judge the second draft is kept as its own candidate (never merged on a guess).
    expect(out.outcome).toBe("added");
    expect(await store.list(KEY)).toHaveLength(2);
    expect(judge.calls).toEqual([]);
    expect(spend.asked).toEqual([]);
  });

  it("learningCompletion: the model-access client sends nothing, not even to the Lambda, and says so as 'not forwarded'", async () => {
    setLearnedLessonsGate(gate);
    const sent: unknown[] = [];
    const lambda = { send: async (command: InvokeCommand): Promise<InvokeCommandOutput> => { sent.push(command); throw new Error("must not be sent"); } };
    const invoker = new ModelAccessInvoker({ functionName: "fn", lambda, learningLambda: lambda, lessonsSwitchOn: () => gate() });
    await expect(invoker.learningCompletion({ key: "k", purpose: "reflect", system: "s", user: "u", maxOutputTokens: 10, model: "m", api: "anthropic-messages" } as never)).rejects.toBeInstanceOf(LearningNotForwarded);
    expect(sent).toEqual([]);
  });

  it("the model itself (customerLearningModel, which the reflector and the curator's judge both use) refuses every quote and call before it plans, holds or sends anything", async () => {
    let touched = 0;
    const dependencies = new Proxy({}, { get: () => { touched += 1; return undefined; } }) as unknown as LessonsHostDependencies;
    const model = customerLearningModel(dependencies, { lessonsSwitchOn: gate });
    const request = { purpose: "reflect" as const, system: "s", user: "u", maxOutputTokens: 100, workspaceId: ORG_A, project: "web" };
    await expect(model.complete(request)).rejects.toThrow(LESSONS_SWITCHED_OFF);
    expect(await model.quote!(request)).toEqual({ ok: false, code: "no_provider" });
    expect(touched).toBe(0);
  });

  it("the model gate refuses whatever is wrapped, and a path that bypasses resolveLearning (here: the model called directly) still cannot spend", async () => {
    setLearnedLessonsGate(gate);
    const inner = new ScriptedModel([{ text: "x", costUsd: 0.01 }]);
    const gated = gatedByLessonsSwitch(inner);
    await expect(gated.complete({ purpose: "judge", system: "s", user: "u", maxOutputTokens: 10, workspaceId: WS })).rejects.toThrow(LESSONS_SWITCHED_OFF);
    expect(inner.calls).toEqual([]);
  });
});

describe("the lessons runtime puts the same gate in front of whatever model it is given (the second lock behind customerLearningModel's own)", () => {
  it.each(offStates)("lessons switch %s: a draft in flight makes no embedder call; with the switch on it does", async (_name, gate) => {
    const run = async (g: () => boolean) => {
      setLearnedLessonsGate(g);
      const before = embedder.calls;
      const store = new InMemoryLessonStore();
      let n = 0;
      const deps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}` };
      await curateDraft(deps, KEY, draft());
      return embedder.calls - before;
    };
    expect(await run(gate)).toBe(0);
    expect(await run(() => true)).toBeGreaterThan(0);
  });

  it.each(offStates)("lessons switch %s: runtime.routes.judgeModel refuses and the given model is never reached; with the switch on it is", async (_name, gate) => {
    const inner = new ScriptedModel([{ text: "x", costUsd: 0.01 }]);
    const w = world();
    const runtime = createLessonsRuntime({ table: w.table, now: Date.now, model: inner, taskVisibility: {}, evidence: {}, reader: {}, repositoriesOf: async () => [], names: {} } as never);
    const request = { purpose: "judge" as const, system: "s", user: "u", maxOutputTokens: 10, workspaceId: WS };
    setLearnedLessonsGate(gate);
    await expect(runtime.routes.judgeModel.complete(request)).rejects.toThrow(LESSONS_SWITCHED_OFF);
    expect(inner.calls).toEqual([]);
    setLearnedLessonsGate(() => true);
    expect((await runtime.routes.judgeModel.complete(request)).text).toBe("x");
    expect(inner.calls).toHaveLength(1);
  });
});

describe("with the lessons switch on: the project's own mode applies unchanged, and the model paths still run (positive controls)", () => {
  it("task-end reflects in mode On and not in Collect; the gate passes the model through; the invoker sends; the judge is asked", async () => {
    setLearnedLessonsGate(() => true);
    const model = new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
    const w = parts(settings({ mode: "On" }), model);
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).not.toBe("off");
    expect(model.calls).toHaveLength(1);
    const collect = new ScriptedModel();
    expect(await learnFromEndedTask(parts(settings({ mode: "Collect" }), collect).deps, { workspaceId: WS, taskId: "task-1" })).toBe("off");
    expect(collect.calls).toEqual([]);

    const inner = new ScriptedModel([{ text: "x", costUsd: 0.01 }]);
    expect((await gatedByLessonsSwitch(inner).complete({ purpose: "judge", system: "s", user: "u", maxOutputTokens: 10, workspaceId: WS })).text).toBe("x");
    expect(inner.calls).toHaveLength(1);

    const sent: unknown[] = [];
    const lambda = { send: async (command: InvokeCommand): Promise<InvokeCommandOutput> => { sent.push(command); return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, result: { text: "t", model: "m" } })) } as InvokeCommandOutput; } };
    const invoker = new ModelAccessInvoker({ functionName: "fn", lambda, learningLambda: lambda, lessonsSwitchOn: () => true });
    await invoker.learningCompletion({ key: "k", purpose: "reflect", system: "s", user: "u", maxOutputTokens: 10, model: "m", api: "anthropic-messages" } as never).catch(() => undefined);
    expect(sent).toHaveLength(1);

    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const reworded = "Wrap outbound HTTP calls in the api service with withRetry from src/retry/index.ts";
    const judge = new ScriptedModel([JSON.stringify({ verdicts: [{ n: 1, verdict: "different" }] })]);
    let n = 0;
    const deps = { store: new InMemoryLessonStore(), embedder: closeEmbedder, vectors: new MemoryVectors(), judgeModel: judge, spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, verifier: verifier("valid"), settings: settings(), newId: () => `les_${String(++n).padStart(4, "0")}` };
    await curateDraft(deps, KEY, draft({ title: "Retries", description: "", body: a }));
    await curateDraft(deps, KEY, draft({ title: "Retries", description: "", body: reworded }));
    expect(judge.calls).toHaveLength(1);
  });
});

describe("wired contract: the real task-end path, the stored project mode (On) read from the Team record's table, and the model client behind the production model gate", () => {
  /** The Team record's table with the project's mode stored as On, read by the production settings reader. */
  function stored() {
    const w = world();
    w.db.set({ ...learningModeKey(ORG_A, "web"), entityType: "TEAM_RECORD_MODE", mode: "on" });
    return dynamoLearningSettings(w.table, new DynamoTier0Settings(w.table));
  }
  /** The model client: counts every call that reaches it. The production gate sits in front of it, as `createLessonsRuntime` puts it in front of the company's model. */
  function wired(gate: () => boolean) {
    setLearnedLessonsGate(gate);
    const client = new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
    const reader = stored();
    const w = parts(reader, client);
    const guarded = gatedByLessonsSwitch(client);
    const deps: TaskLearningDeps = { ...w.deps, reflect: { ...w.deps.reflect, model: guarded }, process: { ...w.process, judgeModel: guarded } };
    return { deps, client, w };
  }

  it.each(offStates)("lessons switch %s: the stored On is kept, the task ends, and the model client is called zero times; nothing is drafted", async (_name, gate) => {
    const { deps, client, w } = wired(gate);
    expect((await resolveLearning(deps.settings, WS, "web")).chosenMode).toBe("On");
    const result = await learnFromEndedTaskTyped(deps, { workspaceId: WS, taskId: "task-1" });
    expect(result).toEqual({ status: "off", retry: false });
    expect(client.calls).toEqual([]);
    expect(w.rowsAsked).toEqual([]);
    expect(await w.store.list({ workspaceId: WS, project: "web" })).toEqual([]);
  });

  it("positive control: the same wiring with the switch on reflects once through the model client", async () => {
    const { deps, client } = wired(() => true);
    const base = baseFacts();
    deps.source = { read: async () => ({ ...base, facts: { ...base.facts, project: "web" } }) };
    const result = await learnFromEndedTaskTyped(deps, { workspaceId: WS, taskId: "task-1" });
    expect(result.status).not.toBe("off");
    expect(client.calls).toHaveLength(1);
  });
});
