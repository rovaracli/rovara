// Wiring lane B, WA-2: the terminal-task hook. A finished task is reflected on only when the project's learning mode allows it, with a subject built from the real sources of who did
// what; the send-back action tells the record WHO sent the task back; and where learning is not wired nothing is registered at all.
import { describe, expect, it } from "vitest";
import { hasTaskEndHandlers, type TaskEndEvent } from "../../../packages/broker/src/agents/task-end.js";
import { installLearningTaskEnd, uninstallLearningTaskEnd } from "../../../packages/broker/src/aws/broker/learning-wiring.js";
import { announceTaskSendBack } from "../../../packages/broker/src/aws/developer-tasks/learning-events.js";
import type { DeveloperTaskRecord } from "../../../packages/broker/src/developer/task-records.js";
import { announceHumanSendBack, registerHumanSendBackListener, sendBackToRecord } from "../../../packages/broker/src/lessons/send-back-events.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { learnFromEndedTask, learningTaskEndHandler, reflectOutcomeOf, subjectForTask, type TaskLearningDeps, type TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import type { OutcomeRowReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { SendBackFact, TaskSubjectFacts } from "../../../packages/broker/src/lessons/task-subject.js";
import { Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, embedder, facts, memberSpan, reply, settings, verifier } from "./lesson-helpers.js";

class Rows implements OutcomeRowReader {
  asked: string[] = [];
  sendBacks = new Map<string, SendBackFact>();
  reverter: { actorDeveloperId?: string } | undefined;
  failing = false;
  async sendBack(input: { requestId: string }): Promise<SendBackFact | undefined> { this.asked.push(`sendback:${input.requestId}`); if (this.failing) throw new Error("table down"); return this.sendBacks.get(input.requestId); }
  async revertedBy(): Promise<{ actorDeveloperId?: string } | undefined> { this.asked.push("reverted_by"); return this.reverter; }
}

const baseFacts = (over: Partial<TaskSubjectFacts> = {}): TaskSubjectBase["facts"] => ({
  workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
  task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
  rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: ["https://github.com/acme/api/pull/7"], spans: [memberSpan("Use withRetry for HTTP retries in api.", { eventId: "ev-p" })] },
  ...over,
});

function setup(over: { settings?: ReturnType<typeof settings>; base?: TaskSubjectBase | undefined; model?: ScriptedModel } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const model = over.model ?? new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]);
  const rows = new Rows();
  const reads: string[] = [];
  const base = "base" in over ? over.base : ({ facts: baseFacts(), sendBackRequestIds: ["req-1"] } satisfies TaskSubjectBase);
  const configured = over.settings ?? settings({ mode: "On" });
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: configured, newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const deps: TaskLearningDeps = {
    source: { read: async (input) => { reads.push(input.taskId); return base; } }, rows, settings: configured,
    reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now }, process,
  };
  return { deps, store, rows, model, audit, reads };
}

describe("reflectOutcomeOf", () => {
  it("merged, closed and abandoned ends teach something; an agent step that succeeded or a question answered does not", () => {
    expect(["merged", "closed", "failed", "cancelled", "creator_removed", "succeeded", "answered"].map((o) => reflectOutcomeOf(o as never))).toEqual(["merged", "closed", "abandoned", "abandoned", "abandoned", undefined, undefined]);
  });
});

describe("learnFromEndedTask: behind the learning switch", () => {
  it("mode Off and Collect reflect nothing and read no rows", async () => {
    for (const mode of ["Off", "Collect"] as const) {
      const w = setup({ settings: settings({ mode }) });
      expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("off");
      expect(w.model.calls).toEqual([]);
      expect(w.rows.asked).toEqual([]);
    }
  });
  it("a settings reader that fails is Off (fail closed)", async () => {
    const w = setup({ settings: { read: async () => { throw new Error("down"); } } });
    expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("off");
    expect(w.model.calls).toEqual([]);
  });
  it("mode Suggest and On reflect and hand each draft to the curator", async () => {
    for (const mode of ["Suggest", "On"] as const) {
      const w = setup({ settings: settings({ mode }) });
      expect(await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" })).toBe("reflected");
      expect(w.model.calls).toHaveLength(1);
      expect((await w.store.list({ workspaceId: WS, project: PROJECT })).length).toBeGreaterThan(0);
    }
  });
});

describe("learnFromEndedTask: the facts", () => {
  it("a send-back by a third person is a measured outcome, by the starter it is not", async () => {
    const measuredFor = async (actor: string): Promise<boolean | undefined> => {
      const w = setup();
      w.rows.sendBacks.set("req-1", { id: "task:task-1:sendback:req-1", origin: "human", actorDeveloperId: actor, actorTrust: "member", reasonText: "use the shared helper" });
      await learnFromEndedTask(w.deps, { workspaceId: WS, taskId: "task-1" });
      return (await w.store.list({ workspaceId: WS, project: PROJECT }))[0]?.provenance.measured;
    };
    expect(await measuredFor("sam")).toBe(true);
    expect(await measuredFor("starter")).toBe(false);
  });
  it("a reverted task reads the reverter from the person-link row; a merged one never asks for it", async () => {
    const w = setup();
    w.rows.reverter = { actorDeveloperId: "rita" };
    const subject = await subjectForTask(w.deps, { workspaceId: WS, taskId: "task-1", outcome: "reverted" });
    expect(subject).toMatchObject({ outcome: "reverted", revertedBy: "rita", initiatorId: "starter" });
    const merged = await subjectForTask(w.deps, { workspaceId: WS, taskId: "task-1" });
    expect(merged?.revertedBy).toBeUndefined();
    expect(w.rows.asked.filter((q) => q === "reverted_by")).toHaveLength(1);
  });
  it("no facts, a source that claims another workspace, and a source or rows that throw never throw out of the hook", async () => {
    expect(await learnFromEndedTask(setup({ base: undefined }).deps, { workspaceId: WS, taskId: "task-1" })).toBe("no_facts");
    const foreign = setup({ base: { facts: baseFacts({ workspaceId: "org_zzzzzzzzzzzzzzzzzzzz" }), sendBackRequestIds: [] } });
    expect(await learnFromEndedTask(foreign.deps, { workspaceId: WS, taskId: "task-1" })).toBe("no_facts");
    expect(foreign.model.calls).toEqual([]);
    const broken = setup();
    broken.rows.failing = true;
    expect(await learnFromEndedTask(broken.deps, { workspaceId: WS, taskId: "task-1" })).toBe("not_reflected");
    const noSource = setup();
    noSource.deps.source = { read: async () => { throw new Error("down"); } };
    expect(await learnFromEndedTask(noSource.deps, { workspaceId: WS, taskId: "task-1" })).toBe("not_reflected");
  });
});

const endEvent = (over: Partial<TaskEndEvent> = {}): TaskEndEvent => ({ orgId: WS, taskId: "task-1", outcome: "merged", runLimitUsd: 1, spentUsd: 0, ...over });

describe("the task-end handler and its installation", () => {
  it("does nothing without dependencies, and for an end that teaches nothing", async () => {
    const none = learningTaskEndHandler(() => undefined);
    await none({} as never, endEvent());
    const w = setup();
    await learningTaskEndHandler(() => w.deps)({} as never, endEvent({ outcome: "succeeded" }));
    expect(w.reads).toEqual([]);
    await learningTaskEndHandler(() => w.deps)({} as never, endEvent({ outcome: "merged" }));
    expect(w.reads).toEqual(["task-1"]);
  });
  it("is registered only when the broker is given learning dependencies, once, and can be removed", () => {
    uninstallLearningTaskEnd();
    const before = hasTaskEndHandlers();
    installLearningTaskEnd({});
    expect(hasTaskEndHandlers()).toBe(before);
    const w = setup();
    installLearningTaskEnd({ learning: w.deps });
    installLearningTaskEnd({ learning: w.deps });
    expect(hasTaskEndHandlers()).toBe(true);
    uninstallLearningTaskEnd();
    expect(hasTaskEndHandlers()).toBe(before);
  });
});

describe("a human send-back names who sent it", () => {
  const task = (over: Partial<DeveloperTaskRecord> = {}) => ({ taskId: "task-1", orgId: WS, project: PROJECT, developerId: "owner-1", developerName: "Owner", shared: false, ...over }) as unknown as DeveloperTaskRecord;
  function emitterSetup() {
    const sent: Array<Record<string, unknown>> = [];
    const emitter = { sendBack: async (input: Record<string, unknown>) => { sent.push(input); } };
    const w = setup();
    return { sent, emitter, deps: { ...w.deps, rovara: emitter as never } };
  }
  const announce = (over: Partial<Parameters<typeof announceTaskSendBack>[0]> = {}) => announceTaskSendBack({ task: task(), callerDeveloperId: "dev-sam", requestId: "req-9", instructions: "use the shared helper", earlierSendBacks: 1, at: "2026-10-31T10:00:00.000Z", ...over });

  it("reaches the emitter with the pressing person's developer id, the round and the owner's private audience", async () => {
    const { sent, deps } = emitterSetup();
    installLearningTaskEnd({ learning: deps });
    try {
      await announce();
      expect(sent).toEqual([{
        workspaceId: WS, project: PROJECT, taskId: "task-1", visibility: { kind: "private", ownerDeveloperId: "owner-1" }, at: "2026-10-31T10:00:00.000Z",
        sendBackId: "req-9", round: 2, origin: "human", reasonText: "use the shared helper", actorDeveloperId: "dev-sam",
      }]);
      // 2026-11-04 (0.5.5 integration, team-record-sources f792f95a8): the event's `shared` flag no longer decides the audience; the task's Plan 5 visibility does, read by the team-record wiring's listener (`sendBackToRecord(emitter, reader)`,
      // team-record-wiring.ts). This learning wiring has no reader, so the row stays the owner's alone (fail closed), whether or not the task is shared.
      await announce({ task: task({ shared: true }), requestId: "req-10" });
      expect(sent[1]).toMatchObject({ visibility: { kind: "private", ownerDeveloperId: "owner-1" }, sendBackId: "req-10" });
      // With the task's visibility reader the row takes that audience.
      const read: Array<Record<string, unknown>> = [];
      await sendBackToRecord({ sendBack: async (input) => { read.push(input as unknown as Record<string, unknown>); } }, async () => ({ kind: "shared" }))({
        workspaceId: WS, project: PROJECT, taskId: "task-1", requestId: "req-11", actorDeveloperId: "dev-sam", instructions: "again", round: 3, shared: true, ownerDeveloperId: "owner-1", at: "2026-10-31T10:00:00.000Z",
      });
      expect(read[0]).toMatchObject({ visibility: { kind: "shared" }, sendBackId: "req-11", round: 3 });
    } finally { uninstallLearningTaskEnd(); }
  });
  it("tells nobody where learning is not wired, and a task without an org has nowhere to write", async () => {
    const seen: unknown[] = [];
    const remove = registerHumanSendBackListener(async (event) => { seen.push(event); });
    try {
      await announce();
      expect(seen).toHaveLength(1);
      await announce({ task: task({ orgId: undefined as never }) });
      expect(seen).toHaveLength(1);
    } finally { remove(); }
    const { sent } = emitterSetup();
    await announce();
    expect(sent).toEqual([]);
  });
  it("a failing emitter or listener never fails the send-back", async () => {
    const remove = registerHumanSendBackListener(async () => { throw new Error("record down"); });
    try {
      await expect(announce()).resolves.toBeUndefined();
      await expect(announceHumanSendBack({} as never)).resolves.toBeUndefined();
    } finally { remove(); }
    const { deps } = emitterSetup();
    installLearningTaskEnd({ learning: { ...deps, rovara: { sendBack: async () => { throw new Error("down"); } } } });
    try { await expect(announce()).resolves.toBeUndefined(); } finally { uninstallLearningTaskEnd(); }
  });
  it("an unreadable owner falls back to the creator, so the row stays private to a person", async () => {
    const { sent, deps } = emitterSetup();
    installLearningTaskEnd({ learning: deps });
    try {
      await announce({ task: task({ currentOwner: { broken: true } as never }) });
      expect(sent[0]).toMatchObject({ visibility: { kind: "private", ownerDeveloperId: "owner-1" } });
    } finally { uninstallLearningTaskEnd(); }
  });
});
