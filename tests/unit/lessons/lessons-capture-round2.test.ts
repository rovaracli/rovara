// Lessons capture lane, fix round 2: R1 (a lesson names everyone whose words the model READ, and the copied-code check follows what was read) and R5 (author lists are never silently cut).
import { describe, expect, it } from "vitest";
import { lessonDeletionPort } from "../../../packages/broker/src/lessons/deletion.js";
import { curateDraft, type CurateDeps } from "../../../packages/broker/src/lessons/curate.js";
import { isCorroborated } from "../../../packages/broker/src/lessons/value.js";
import { createHumanEditExtractor, type HumanEditExtractorDeps } from "../../../packages/broker/src/lessons/human-edit.js";
import type { HumanEditInput } from "../../../packages/broker/src/team-record/sources/codehost.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { reflectSubject, type LessonDraft, type ReflectDeps } from "../../../packages/broker/src/lessons/reflect.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { Alerts, Audit, BASE, Clock, KEY, MERGED, PROJECT, WS, facts, verifier, MemoryVectors, ScriptedModel, Spend, candidateJson, draft, embedder, lessonRecord, memberSpan, reply, seed, settings, subject } from "./lesson-helpers.js";

function reflectDeps(model: ScriptedModel) {
  const audit = new Audit();
  const d: ReflectDeps = { model, spend: new Spend(), audit, settings: settings({ mode: "On" }), edition: "public", now: new Clock().now, newId: () => "run-1" };
  return { d, audit };
}
const LINK = "https://github.com/acme/api/pull/7";
const editInput = (over: Partial<HumanEditInput> = {}): HumanEditInput => ({
  workspaceId: WS, project: PROJECT, repo: "acme/api", taskId: "task-1", pullRequest: { number: 7, url: LINK }, trust: "member", authorCount: 1, authors: ["rae"],
  files: [{ path: "src/fetch.ts", additions: 1, deletions: 1, symbols: [], hunks: ["@@ -1,2 +1,2 @@", "-old()", "+await withRetry(() => fetch())"] }],
  link: LINK, audience: { kind: "project" }, scope: "github:repo/77", ...over,
});
function extractorSetup() {
  const store = new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  const model = new ScriptedModel([reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [{ kind: "pr", url: LINK }], body: "Wrap network calls with withRetry." }))]);
  const configured = settings({ mode: "On" });
  const process: ProcessDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), facts: facts(), settings: configured, newId: () => "les_0001" };
  const base = { facts: { workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged" as const, task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } }, rest: { initiatorTrust: "member" as const, steeringTrust: ["member" as const], intentTrust: "member" as const, links: [LINK], spans: [] } }, sendBackRequestIds: [] };
  const deps: HumanEditExtractorDeps = { source: { read: async () => base }, settings: configured, reflect: { model, spend: new Spend(), audit, settings: configured, edition: "public", now: clock.now, newId: () => "run-1" }, process, standing: async () => "member", isErased: async () => false };
  return { extractor: createHumanEditExtractor(deps), store, model };
}
const COPIED = "Use this:\n  for (;;) {\n    try { fetch() } catch {}\n  }\n  await withRetry(() => fetch());";
// Spans in the prompt, by rank: remembered, human_edit, send_back, pr_comment, ... intent last.
const spans = () => [
  memberSpan("Wrap fetch in withRetry.", { kind: "human_edit", authorId: "rae", authorIds: ["rae", "sam"], eventId: "ev-edit" }),
  memberSpan("Please make retries consistent.", { kind: "pr_comment", authorId: "cora", eventId: "ev-comment" }),
  memberSpan("Remember: retries go through withRetry.", { kind: "remembered", authorId: "remy", eventId: "ev-note" }),
  memberSpan("Make retries use the helper", { kind: "intent", authorId: "ian", eventId: "ev-intent" }),
];
// With these spans: S1 remembered (remy), S2 human_edit (rae, sam), S3 pr_comment (cora), S4 intent (ian).

describe("R1: the copied-code check follows what was READ", () => {
  it("a human_edit span in the prompt makes the copied-code check apply even when the model cites only another span", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S4"], citations: [], body: COPIED }))]);
    const { d, audit } = reflectDeps(model);
    const result = await reflectSubject(d, subject(spans(), { initiatorId: "init" }));
    expect(result.drafts).toEqual([]);
    expect(audit.events.some((e) => e.action === "lesson.refused" && e.facts?.reason === "copied_code")).toBe(true);
  });

  it("positive control: the same words in prose are kept when only an intent span is cited", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S4"], citations: [], body: "Wrap network calls with withRetry instead of an empty catch loop." }))]);
    const { d } = reflectDeps(model);
    const result = await reflectSubject(d, subject(spans(), { initiatorId: "init" }));
    expect(result.drafts).toHaveLength(1);
  });

  it("no human_edit span was read: copied-looking text is not refused by this check (it is not code from a person's edit)", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S1"], citations: [], body: COPIED }))]);
    const { d } = reflectDeps(model);
    const result = await reflectSubject(d, subject([spans()[2]!, spans()[3]!], { initiatorId: "init" }));
    expect(result.drafts).toHaveLength(1);
  });
});

describe("R1: a lesson names every person whose words were read, so erasing any of them purges it", () => {
  it("readFrom holds the author of every person-written span read (human_edit authors, pr_comment, remembered, intent), whichever span is cited", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S4"], citations: [], body: "Wrap network calls with withRetry." }))]);
    const { d } = reflectDeps(model);
    const result = await reflectSubject(d, subject(spans(), { initiatorId: "init" }));
    expect(result.drafts).toHaveLength(1);
    const p = result.drafts[0]!.provenance;
    expect([...(p.readFrom ?? [])].sort()).toEqual(["cora", "ian", "rae", "remy", "sam"]);
    // They are NOT authors: the cited intent's writer is the only author, so independence and the author rule are unchanged.
    expect(p.authors).toEqual(["ian"]);
  });

  it("agent text and outcomes are not people: a plan span adds nobody", async () => {
    const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S2"], citations: [], body: "Wrap network calls with withRetry." }))]);
    const { d } = reflectDeps(model);
    const plan = memberSpan("The plan", { kind: "plan", trust: "system", authorId: "agent-1" });
    const result = await reflectSubject(d, subject([memberSpan("Use withRetry.", { kind: "send_back", authorId: "ann" }), plan], { initiatorId: "init" }));
    expect(result.drafts[0]!.provenance.readFrom).toEqual(["ann"]);
  });

  it("erasing an uncited commenter or an uncited co-author of the edit purges the stored lesson (positive control: it is live before)", async () => {
    for (const erased of ["cora", "sam", "remy", "rae"]) {
      const model = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S4"], citations: [], body: "Wrap network calls with withRetry." }))]);
      const { d } = reflectDeps(model);
      const result = await reflectSubject(d, subject(spans(), { initiatorId: "init" }));
      const store = new InMemoryLessonStore();
      await seed(store, lessonRecord({ id: "les_r1", provenance: { ...draft().provenance, ...result.drafts[0]!.provenance } }));
      expect(await store.list(KEY)).toHaveLength(1);
      const port = lessonDeletionPort({ store, vectors: new MemoryVectors(), audit: new Audit(), now: new Clock().now });
      const done = await port.erasePerson(KEY.workspaceId, KEY.project, { developerId: erased }, new Set());
      expect({ erased, purged: done.purged }).toEqual({ erased, purged: ["les_r1"] });
      expect(await store.list(KEY)).toEqual([]);
    }
  });

  it("a person who only reviewed is still scrubbed from readFrom on a partial scrub, and a person not named is untouched", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord({ id: "les_r1b", provenance: { ...draft().provenance, authors: ["ann", "bob"], readFrom: ["ann", "cora"] } }));
    const port = lessonDeletionPort({ store, vectors: new MemoryVectors(), audit: new Audit(), now: new Clock().now });
    const none = await port.erasePerson(KEY.workspaceId, KEY.project, { developerId: "zed" }, new Set());
    expect(none).toEqual({ purged: [], scrubbed: [] });
    expect(await store.list(KEY)).toHaveLength(1);
  });
});

describe("R1: a human-edit subject drops candidates that cite no edit span", () => {
  it("requireEvidenceKind human_edit: a candidate citing only the intent is dropped; one citing the edit is kept", async () => {
    const only = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S4"], citations: [], body: "Wrap network calls with withRetry." }))]);
    const a = reflectDeps(only);
    expect((await reflectSubject(a.d, subject(spans(), { initiatorId: "init", requireEvidenceKind: "human_edit" }))).drafts).toEqual([]);
    const cited = new ScriptedModel([reply(candidateJson({ evidenceSpanIds: ["S2"], citations: [], body: "Wrap network calls with withRetry." }))]);
    const b = reflectDeps(cited);
    expect((await reflectSubject(b.d, subject(spans(), { initiatorId: "init", requireEvidenceKind: "human_edit" }))).drafts).toHaveLength(1);
  });
});

describe("R5: author lists", () => {
  const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);
  const withPeople = (authors: string[], over: Partial<LessonDraft["provenance"]> = {}) => draft({ provenance: { ...draft().provenance, authors, sources: authors.map((a) => `member:${a}`), inputSources: authors.map((a) => `member:${a}`), ...over } });
  function curateSetup() {
    const store = new InMemoryLessonStore();
    let n = 0;
    const deps: CurateDeps = { store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: new Clock().now, newId: () => `les_${String(++n).padStart(4, "0")}` };
    return { deps, store };
  }

  it("a merge whose author union would pass 20 is refused: the draft is its own lesson for a person, and the first keeps all of its names", async () => {
    const { deps, store } = curateSetup();
    await curateDraft(deps, KEY, withPeople(ids(15, "a")));
    const out = await curateDraft(deps, KEY, withPeople(ids(10, "b"), { supportTasks: ["task-2"] }));
    expect(out.outcome).toBe("added");
    if (out.outcome !== "added") return;
    expect(out.lesson.reviewRequired).toBe(true);
    const lessons = await store.list(KEY);
    expect(lessons).toHaveLength(2);
    expect(lessons.map((l) => l.provenance.authors.length).sort()).toEqual([10, 15]);
    // Positive control: a union that fits still merges.
    const fits = curateSetup();
    await curateDraft(fits.deps, KEY, withPeople(ids(10, "a")));
    expect((await curateDraft(fits.deps, KEY, withPeople(ids(10, "b"), { supportTasks: ["task-2"] }))).outcome).toBe("merged");
    expect((await fits.store.list(KEY))[0]!.provenance.authors).toHaveLength(20);
  });

  it("a merge keeps both lessons' readFrom and coAuthored", async () => {
    const { deps, store } = curateSetup();
    await curateDraft(deps, KEY, withPeople(["ann"], { readFrom: ["cora"], coAuthored: [["ann", "ann2"]] }));
    await curateDraft(deps, KEY, withPeople(["bob"], { readFrom: ["remy"], coAuthored: [["bob", "bob2"]], supportTasks: ["task-2"] }));
    const [lesson] = await store.list(KEY);
    expect([...(lesson!.provenance.readFrom ?? [])].sort()).toEqual(["cora", "remy"]);
    expect(lesson!.provenance.coAuthored).toHaveLength(2);
  });

  it("two co-authors of one edit are ONE source toward corroboration; two unrelated people are two", () => {
    const base = { measured: false, supportTasks: ["t1", "t2"] };
    expect(isCorroborated({ ...base, authors: ["rae", "sam"], coAuthored: [["rae", "sam"]] })).toBe(false);
    expect(isCorroborated({ ...base, authors: ["rae", "sam"] })).toBe(true);
    expect(isCorroborated({ ...base, authors: ["rae", "sam", "ann"], coAuthored: [["rae", "sam"]] })).toBe(true);
    // Groups that share a person are one source.
    expect(isCorroborated({ ...base, authors: ["rae", "sam", "tia"], coAuthored: [["rae", "sam"], ["sam", "tia"]] })).toBe(false);
  });

  it("the extractor skips an edit by more than five authors (no name is cut), and records one group for a smaller edit", async () => {
    const crowd = ids(6, "p");
    const w = extractorSetup();
    expect(await w.extractor.extract(editInput({ authors: crowd, authorCount: 6 }))).toEqual({ candidates: 0 });
    expect(w.model.calls).toEqual([]);
    const ok = extractorSetup();
    expect(await ok.extractor.extract(editInput({ authors: ["rae", "sam"], authorCount: 2 }))).toEqual({ candidates: 1 });
    const [lesson] = await ok.store.list(KEY);
    expect(lesson!.provenance.coAuthored).toEqual([["rae", "sam"]]);
  });
});
