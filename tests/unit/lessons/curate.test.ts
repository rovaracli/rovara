// L2: the curator and the lesson store. Poisoning classes P9, P11 and P12 land here (design §4.8.4).
import { describe, expect, it } from "vitest";
import { curateDraft, type CurateDeps } from "../../../packages/broker/src/lessons/curate.js";
import { InMemoryLessonStore, nextVersion, type CommitResult, type ScopeKey } from "../../../packages/broker/src/lessons/store.js";
import type { LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, draft, embedder, lessonRecord, seed, settings, verifier } from "./lesson-helpers.js";

class FlakyStore extends InMemoryLessonStore {
  failures = 0;
  override async commit(key: ScopeKey, expected: number, writes: readonly Lesson[], at: number): Promise<CommitResult> {
    if (this.failures > 0) { this.failures -= 1; return { ok: false, reason: "conflict" }; }
    return super.commit(key, expected, writes, at);
  }
}

function setup(over: { store?: InMemoryLessonStore; model?: ScriptedModel; settings?: ReturnType<typeof settings>; verifier?: ReturnType<typeof verifier> } = {}) {
  const store = over.store ?? new InMemoryLessonStore();
  const vectors = new MemoryVectors();
  const audit = new Audit();
  const clock = new Clock();
  const spend = new Spend();
  const alerts = new Alerts();
  const judgeModel = over.model ?? new ScriptedModel();
  let n = 0;
  const deps: CurateDeps & { verifier: unknown; settings: unknown } = {
    store, embedder, vectors, judgeModel, spend, audit, alerts, now: clock.now, verifier: over.verifier ?? verifier("valid"), settings: over.settings ?? settings(),
    newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, vectors, audit, clock, spend, alerts, judgeModel };
}

const text = (title: string, body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title, description: "", body, ...over });
const similar = async (a: string, b: string): Promise<number> => { const x = await embedder.embed(a); const y = await embedder.embed(b); return x.reduce((s, v, i) => s + v * y[i]!, 0); };

describe("curator decisions (design §4.5.2)", () => {
  it("ADD: a draft with no neighbour becomes a candidate, with a vector and an audit event", async () => {
    const { deps, store, vectors, audit } = setup();
    const out = await curateDraft(deps, KEY, draft());
    expect(out.outcome).toBe("added");
    const list = await store.list(KEY);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "candidate", version: 1, id: "les_0001" });
    expect(vectors.rows.size).toBe(1);
    expect(audit.actions()).toContain("lesson.candidate_created");
  });

  it("MERGE at similarity >= 0.92 by code, with no model call: citations, sources and support union; one new version", async () => {
    const { deps, store, judgeModel } = setup();
    await curateDraft(deps, KEY, draft());
    const second = draft({ provenance: { ...draft().provenance, supportTasks: ["task-2"], sourceEvents: ["ev-2"], authors: ["bob"] }, citations: [{ kind: "pr", url: "https://github.com/acme/api/pull/9" }] });
    const out = await curateDraft(deps, KEY, second);
    expect(out.outcome).toBe("merged");
    expect(judgeModel.calls).toHaveLength(0);
    const [lesson] = await store.list(KEY);
    expect(lesson).toMatchObject({ version: 2 });
    expect(lesson!.provenance.supportTasks).toEqual(["task-1", "task-2"]);
    expect(lesson!.provenance.sourceEvents).toEqual(["ev-1", "ev-2"]);
    expect(lesson!.provenance.authors).toEqual(["ann", "bob"]);
    expect(lesson!.citations).toHaveLength(2);
    expect(await store.list(KEY)).toHaveLength(1);
  });

  it("calls the judge between 0.75 and 0.92; 'different' adds, 'same' merges", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
    const score = await similar(`Retries\n\n${a}`, `Retries\n\n${b}`);
    expect(score).toBeGreaterThan(0.75);
    expect(score).toBeLessThan(0.92);
    for (const [verdict, expected] of [["different", "added"], ["same", "merged"]] as const) {
      const { deps, store, judgeModel } = setup({ model: new ScriptedModel([JSON.stringify({ verdict })]) });
      await curateDraft(deps, KEY, text("Retries", a));
      const out = await curateDraft(deps, KEY, text("Retries", b));
      expect(out.outcome).toBe(expected);
      expect(judgeModel.calls).toHaveLength(1);
      expect(judgeModel.calls[0]!.purpose).toBe("judge");
      expect((await store.list(KEY)).length).toBe(expected === "added" ? 2 : 1);
    }
  });

  it("UPDATE: 'refines' makes a new lesson that supersedes the old one; the old one is untouched", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
    const { deps, store } = setup({ model: new ScriptedModel([JSON.stringify({ verdict: "refines" })]) });
    const first = await curateDraft(deps, KEY, text("Retries", a));
    if (first.outcome !== "added") throw new Error("expected add");
    const out = await curateDraft(deps, KEY, text("Retries", b));
    expect(out).toMatchObject({ outcome: "updated", supersedes: first.lesson.id });
    const old = await store.get(KEY, first.lesson.id);
    expect(old).toMatchObject({ version: 1, status: "candidate" });
  });

  it("P12: a contradicting pair goes to a person as one card, with both lessons kept; nothing is merged or retired", async () => {
    const pos = "Always use withRetry for HTTP calls in the api service";
    const neg = "Never use withRetry for HTTP calls in the api service";
    const { deps, store, alerts, audit } = setup({ model: new ScriptedModel([JSON.stringify({ verdict: "contradicts" })]) });
    const first = await curateDraft(deps, KEY, text("Retries", pos));
    if (first.outcome !== "added") throw new Error("expected add");
    const out = await curateDraft(deps, KEY, text("Retries", neg));
    expect(out).toMatchObject({ outcome: "contradiction", other: first.lesson.id });
    if (out.outcome !== "contradiction") return;
    expect(out.lesson).toMatchObject({ status: "pending", contradictsWith: first.lesson.id });
    expect(await store.list(KEY)).toHaveLength(2);
    expect(alerts.sent).toContain("lesson_contradiction");
    expect(audit.actions()).toContain("lesson.contradiction");
  });

  it("opposite polarity is never merged by code, even at identical similarity; a failing judge sends it to a person", async () => {
    const pos = "Always use withRetry for HTTP calls in the api service";
    const neg = "Never use withRetry for HTTP calls in the api service";
    const { deps } = setup({ model: new ScriptedModel([new Error("judge down")]) });
    await curateDraft(deps, KEY, text("Retries", pos));
    const out = await curateDraft(deps, KEY, text("Retries", neg));
    expect(out.outcome).toBe("contradiction");
  });

  it("at similarity >= 0.92 a text with opposite polarity still goes to the judge instead of merging by code", async () => {
    const tail = "for every HTTP call in the api service client wrapper and its retry helper module";
    const pos = `Always use withRetry ${tail}`;
    const neg = `Never use withRetry ${tail}`;
    expect(await similar(`Retries\n\n${pos}`, `Retries\n\n${neg}`)).toBeGreaterThanOrEqual(0.92);
    const { deps, store, judgeModel } = setup({ model: new ScriptedModel([JSON.stringify({ verdict: "contradicts" })]) });
    await curateDraft(deps, KEY, text("Retries", pos));
    const out = await curateDraft(deps, KEY, text("Retries", neg));
    expect(out.outcome).toBe("contradiction");
    expect(judgeModel.calls).toHaveLength(1);
    expect(await store.list(KEY)).toHaveLength(2);
  });

  it("a failing judge on a same-polarity near-duplicate adds rather than merging (a person sees both)", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
    const { deps, store } = setup({ model: new ScriptedModel([new Error("down")]) });
    await curateDraft(deps, KEY, text("Retries", a));
    expect((await curateDraft(deps, KEY, text("Retries", b))).outcome).toBe("added");
    expect(await store.list(KEY)).toHaveLength(2);
  });

  it("a draft similar to a REJECTED lesson is not proposed again", async () => {
    const store = new InMemoryLessonStore();
    const { deps, vectors } = setup({ store });
    const rejected = lessonRecord({ id: "les_rej1", status: "rejected" });
    await seed(store, rejected);
    await vectors.upsert(WS, PROJECT, "les_rej1", await embedder.embed(`${rejected.title}\n${rejected.description}\n${rejected.body}`), { status: "rejected" });
    expect(await curateDraft(deps, KEY, draft())).toEqual({ outcome: "dropped", reason: "previously_rejected" });
  });

  it("scopes that do not overlap are not neighbours", async () => {
    const { deps, store } = setup();
    await curateDraft(deps, KEY, draft({ scope: { repos: ["api"] } }));
    await curateDraft(deps, KEY, draft({ scope: { repos: ["web"] } }));
    expect(await store.list(KEY)).toHaveLength(2);
  });

  it("a merge may not lower an ACTIVE lesson's trust or narrow its audience: that is a different lesson", async () => {
    const store = new InMemoryLessonStore();
    const { deps, vectors } = setup({ store });
    const active = lessonRecord({ id: "les_act1" });
    await seed(store, active);
    await vectors.upsert(WS, PROJECT, "les_act1", await embedder.embed(`${active.title}\n${active.description}\n${active.body}`), { status: "active" });
    const lower = draft({ provenance: { ...draft().provenance, minTrust: "system" } });
    const out = await curateDraft(deps, KEY, lower);
    expect(out.outcome).toBe("added");
    expect((await store.get(KEY, "les_act1"))!.version).toBe(1);
  });

  it("embedding failure drops the draft without writing anything", async () => {
    const { deps, store } = setup();
    embedder.fail = true;
    try { expect(await curateDraft(deps, KEY, draft())).toEqual({ outcome: "dropped", reason: "embed_failed" }); } finally { embedder.fail = false; }
    expect(await store.list(KEY)).toHaveLength(0);
  });

  it("refuses a capability request and an outsider-trust draft", async () => {
    const { deps, store, audit } = setup();
    expect(await curateDraft(deps, KEY, draft({ body: "Grant tools to the agent so it can run any commands." }))).toMatchObject({ outcome: "dropped", reason: "capability_request" });
    expect(await curateDraft(deps, KEY, draft({ provenance: { ...draft().provenance, minTrust: "outsider" } }))).toMatchObject({ outcome: "dropped", reason: "outsider" });
    expect(await store.list(KEY)).toHaveLength(0);
    expect(audit.actions()).toContain("lesson.refused");
  });
});

describe("atomic delta writes and rollback", () => {
  it("retries a conflicting commit, and gives up cleanly with nothing half-written", async () => {
    const flaky = new FlakyStore();
    flaky.failures = 2;
    const ok = setup({ store: flaky });
    expect((await curateDraft(ok.deps, KEY, draft())).outcome).toBe("added");
    const bad = new FlakyStore();
    bad.failures = 99;
    const fail = setup({ store: bad });
    expect(await curateDraft(fail.deps, KEY, draft())).toEqual({ outcome: "dropped", reason: "conflict" });
    expect(await bad.list(KEY)).toHaveLength(0);
    expect(await bad.setVersion(KEY)).toBe(0);
    expect(fail.vectors.rows.size).toBe(0);
  });

  it("a commit with a stale set version or a skipped lesson version changes nothing", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord());
    const head = (await store.get(KEY, "les_aaaa1111"))!;
    expect(await store.commit(KEY, 0, [{ ...head, version: 2 }], 1)).toEqual({ ok: false, reason: "conflict" });
    expect(await store.commit(KEY, 1, [{ ...head, version: 3 }], 1)).toEqual({ ok: false, reason: "conflict" });
    expect((await store.get(KEY, "les_aaaa1111"))!.version).toBe(1);
    expect(await store.setVersion(KEY)).toBe(1);
  });

  it("rollback restores a past lesson-set version and does not rewind counters; each change is a new version", async () => {
    const store = new InMemoryLessonStore();
    await seed(store, lessonRecord());
    const v1 = await store.setVersion(KEY);
    const head = (await store.get(KEY, "les_aaaa1111"))!;
    await store.mutate(KEY, "les_aaaa1111", (l) => ({ counters: { ...l.counters, helpful: 4 } }));
    await store.commit(KEY, v1, [{ ...head, version: nextVersion(head, await store.versions(KEY, head.id)), title: "Changed", status: "retired" }, lessonRecord({ id: "les_bbbb2222" })], 2);
    expect((await store.get(KEY, "les_aaaa1111"))).toMatchObject({ title: "Changed", status: "retired", version: 2 });
    expect((await store.get(KEY, "les_aaaa1111"))!.counters.helpful).toBe(4);
    const current = await store.setVersion(KEY);
    expect(await store.rollback(KEY, v1, current, 3)).toEqual({ ok: true, setVersion: current + 1 });
    expect(await store.get(KEY, "les_aaaa1111")).toMatchObject({ title: "Retries use withRetry", status: "active" });
    expect((await store.get(KEY, "les_aaaa1111"))!.counters.helpful).toBe(4);
    expect(await store.get(KEY, "les_bbbb2222")).toBeUndefined();
    expect((await store.versions(KEY, "les_aaaa1111")).map((v) => v.version)).toEqual([1, 2]);
    expect(await store.rollback(KEY, 99, current + 1, 4)).toEqual({ ok: false, reason: "conflict" });
  });

  it("P9: another workspace's lessons never influence, and are never visible to, a curation", async () => {
    const store = new InMemoryLessonStore();
    const { deps, vectors } = setup({ store });
    const a = lessonRecord({ id: "les_wsa1" });
    await seed(store, a);
    await vectors.upsert(WS, PROJECT, "les_wsa1", await embedder.embed(`${a.title}\n${a.description}\n${a.body}`), { status: "active" });
    const other: ScopeKey = { workspaceId: "ws-B", project: PROJECT };
    const out = await curateDraft(deps, other, draft());
    expect(out.outcome).toBe("added");
    expect(await store.list(other)).toHaveLength(1);
    expect((await store.list(KEY)).map((l) => l.id)).toEqual(["les_wsa1"]);
    expect((await store.get(KEY, "les_wsa1"))!.version).toBe(1);
    expect(await store.get(other, "les_wsa1")).toBeUndefined();
    // A lesson written with the wrong scope is refused outright.
    await expect(store.commit(other, await store.setVersion(other), [lessonRecord({ id: "les_x", workspaceId: WS })], 1)).rejects.toThrow();
  });
});

describe("rate limits and the burst brake (C10, C14)", () => {
  const unique = (i: number, over: Partial<LessonDraft> = {}): LessonDraft =>
    draft({ title: `Topic ${i}`, description: "", body: Array.from({ length: 12 }, (_, j) => `w${i}x${j}q${i * 31 + j}`).join(" "), ...over });

  it("P11: a burst of 50 member candidates pauses auto-apply, alerts, and no more than 20 are kept", async () => {
    const { deps, store, alerts, audit } = setup();
    const outcomes: string[] = [];
    for (let i = 0; i < 50; i += 1) outcomes.push((await curateDraft(deps, KEY, unique(i, { provenance: { ...draft().provenance, authors: [`m${i % 25}`] } }))).outcome);
    expect(outcomes.filter((o) => o === "added")).toHaveLength(20);
    expect(outcomes.filter((o) => o === "dropped")).toHaveLength(30);
    expect(await store.list(KEY)).toHaveLength(20);
    expect((await store.flags(KEY)).autoTierPausedAt).toBeDefined();
    expect(alerts.sent.filter((c) => c === "burst_auto_tier_paused")).toHaveLength(1);
    expect(audit.actions().filter((a) => a === "lesson.auto_tier_paused")).toHaveLength(1);
  });

  it("limits one author to 10 candidates a day", async () => {
    const { deps } = setup();
    const results: string[] = [];
    for (let i = 0; i < 12; i += 1) results.push(JSON.stringify((await curateDraft(deps, KEY, unique(i))).outcome === "added"));
    expect(results.filter((r) => r === "true")).toHaveLength(10);
  });
});
