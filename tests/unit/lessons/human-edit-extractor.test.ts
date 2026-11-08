// Lessons capture lane: the human-edit extractor (decision Q5). The compare's changed lines are handed over once, in memory; the reflector makes lessons from them; only the lessons and a link to
// the pull request are kept. Authors are the company's canonical developer ids; an outsider or an erased author means nothing is learned.
import { describe, expect, it } from "vitest";
import type { HumanEditInput } from "../../../packages/broker/src/team-record/sources/codehost.js";
import { createHumanEditExtractor, type HumanEditExtractorDeps } from "../../../packages/broker/src/lessons/human-edit.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import { Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, embedder, facts, memberSpan, reply, settings, verifier } from "./lesson-helpers.js";

const LINK = "https://github.com/acme/api/pull/7";
const input = (over: Partial<HumanEditInput> = {}): HumanEditInput => ({
  workspaceId: WS, project: PROJECT, repo: "acme/api", taskId: "task-1", pullRequest: { number: 7, url: LINK }, trust: "member", authorCount: 1, authors: ["rae"],
  files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, symbols: ["function load()"], hunks: ["@@ -1,2 +1,2 @@ function load()", "-for (;;) { try { fetch() } catch {} }", "+await withRetry(() => fetch())"] }],
  link: LINK, ...over,
});
const baseOf = (over: Partial<TaskSubjectBase["facts"]> = {}): TaskSubjectBase => ({
  facts: {
    workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
    task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
    rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [LINK], spans: [
      { kind: "intent", text: "Make retries use the helper", trust: "member", authorId: "creator" },
      { kind: "plan", text: "The agent plan", trust: "system" },
      memberSpan("Do not do that", { kind: "send_back", authorId: "starter", eventId: "ev-sb" }),
    ] }, ...over,
  },
  sendBackRequestIds: [],
});

function setup(over: { base?: TaskSubjectBase | undefined; mode?: "Off" | "On"; model?: ScriptedModel; outsiders?: string[]; erased?: string[]; erasedThrows?: boolean } = {}) {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const model = over.model ?? new ScriptedModel([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }] }))]);
  const configured = settings({ mode: over.mode ?? "On" });
  const process: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: verifier("valid"), facts: facts(), settings: configured, newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
  };
  const base = "base" in over ? over.base : baseOf();
  const deps: HumanEditExtractorDeps = {
    source: { read: async () => base }, settings: configured, reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now, newId: () => "run-1" }, process,
    standing: async (_org, who) => (over.outsiders?.includes(who) ? "outsider" : "member"),
    isErased: async (_org, who) => { if (over.erasedThrows) throw new Error("cannot tell"); return over.erased?.includes(who) === true; },
  };
  return { extractor: createHumanEditExtractor(deps), store, model, audit };
}

describe("the human-edit extractor", () => {
  it("makes lessons from the changed lines, names the authors, cites the pull request, and keeps no diff", async () => {
    const w = setup();
    expect(await w.extractor.extract(input())).toEqual({ candidates: 1 });
    expect(w.model.calls).toHaveLength(1);
    const prompt = w.model.calls[0]!.user;
    expect(prompt).toContain("kind=human_edit");
    expect(prompt).toContain("withRetry(() => fetch())");
    // The task's own intent and plan come along for context; its send-backs are the task-end reflection's.
    expect(prompt).toContain("kind=intent");
    expect(prompt).toContain("kind=plan");
    expect(prompt).not.toContain("kind=send_back");
    const lessons = await w.store.list({ workspaceId: WS, project: PROJECT });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.provenance).toMatchObject({ authors: ["rae"], sourceKinds: ["human_edit"], memberSignal: true, supportTasks: ["task-1"] });
    expect(lessons[0]!.citations).toContainEqual({ kind: "pr", url: LINK });
    // Q5: nothing of the diff is in the stored lesson.
    expect(JSON.stringify(lessons)).not.toContain("for (;;)");
  });

  it("several authors: the span names none of them (a file's lines are not attributed), but each is a member", async () => {
    const w = setup();
    await w.extractor.extract(input({ authorCount: 2, authors: ["rae", "sam"] }));
    expect(w.model.calls[0]!.user).toContain("kind=human_edit");
    const lessons = await w.store.list({ workspaceId: WS, project: PROJECT });
    expect(lessons[0]!.provenance.authors).toEqual([]);
  });

  it("outsider: an author who is not a member of the project now means nothing is learned and no model is called", async () => {
    const w = setup({ outsiders: ["sam"] });
    expect(await w.extractor.extract(input({ authorCount: 2, authors: ["rae", "sam"] }))).toEqual({ candidates: 0 });
    expect(w.model.calls).toEqual([]);
  });

  it("erasure: an erased author means nothing is learned; a check that cannot tell throws so the job is retried", async () => {
    const w = setup({ erased: ["rae"] });
    expect(await w.extractor.extract(input())).toEqual({ candidates: 0 });
    expect(w.model.calls).toEqual([]);
    const unsure = setup({ erasedThrows: true });
    await expect(unsure.extractor.extract(input())).rejects.toThrow();
    expect(unsure.model.calls).toEqual([]);
  });

  it("no authors named, mode Off, a task with no facts, another workspace's or project's task: nothing and no model call", async () => {
    const off = setup({ mode: "Off" });
    expect(await off.extractor.extract(input())).toEqual({ candidates: 0 });
    expect(off.model.calls).toEqual([]);
    expect(await setup().extractor.extract(input({ authors: [] }))).toEqual({ candidates: 0 });
    expect(await setup({ base: undefined }).extractor.extract(input())).toEqual({ candidates: 0 });
    expect(await setup().extractor.extract(input({ project: "other" }))).toEqual({ candidates: 0 });
    const foreign = setup({ base: baseOf({ workspaceId: "org_bbbbbbbbbbbbbbbbbbbb" }) });
    expect(await foreign.extractor.extract(input())).toEqual({ candidates: 0 });
    expect(foreign.model.calls).toEqual([]);
  });

  it("a task started or steered by an outsider teaches nothing from its human edit either", async () => {
    const w = setup({ base: baseOf({ rest: { initiatorTrust: "member", steeringTrust: ["member", "outsider"], intentTrust: "member", spans: [] } }) });
    expect(await w.extractor.extract(input())).toEqual({ candidates: 0 });
    expect(w.model.calls).toEqual([]);
  });

  it("a model error throws (the claim is given back and the queue retries); a spend refusal or no lesson does not", async () => {
    const down = setup({ model: new ScriptedModel([new Error("provider down")]) });
    await expect(down.extractor.extract(input())).rejects.toThrow();
    const none = setup({ model: new ScriptedModel([reply()]) });
    expect(await none.extractor.extract(input())).toEqual({ candidates: 0 });
  });
});
