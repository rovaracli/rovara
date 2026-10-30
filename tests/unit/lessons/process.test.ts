// L3a (routing part): promotion to pending, tier-0 auto-apply and the settle step, run through the whole draft-to-lesson pipeline.
import { describe, expect, it } from "vitest";
import { curateDraft } from "../../../packages/broker/src/lessons/curate.js";
import { processDraft, settleLesson, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, draft, embedder, settings, verifier } from "./lesson-helpers.js";

function setup(over: { store?: InMemoryLessonStore; model?: ScriptedModel; settings?: ReturnType<typeof settings>; verifier?: ReturnType<typeof verifier> } = {}) {
  const store = over.store ?? new InMemoryLessonStore();
  const audit = new Audit();
  const clock = new Clock();
  let n = 0;
  const deps: ProcessDeps = {
    store, embedder, vectors: new MemoryVectors(), judgeModel: over.model ?? new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now,
    verifier: over.verifier ?? verifier("valid"), settings: over.settings ?? settings(), newId: () => `les_${String(++n).padStart(4, "0")}`,
  };
  return { deps, store, audit };
}
const text = (title: string, body: string, over: Partial<LessonDraft> = {}): LessonDraft => draft({ title, description: "", body, ...over });

describe("rate brake effect on routing (C14)", () => {
  it("while paused, a tier-0 lesson waits for a person instead of going live", async () => {
    const { deps, store } = setup();
    await store.setFlags(KEY, { autoTierPausedAt: 1, autoTierPausedReason: "burst" });
    const result = await processDraft(deps, KEY, draft());
    expect(result.lesson).toMatchObject({ status: "pending", tier: 0 });
  });

});

describe("promotion to pending (design §4.5.2 step 5) and tier-0 routing", () => {
  const nonFact = (over: Partial<LessonDraft> = {}): LessonDraft => draft({ type: "convention", citations: [], scope: { repos: ["api"] }, provenance: { ...draft().provenance, memberSignal: false }, ...over });

  it("one task without a member signal stays a candidate; a second independent task makes it pending", async () => {
    const { deps } = setup();
    const first = await processDraft(deps, KEY, nonFact());
    expect(first.lesson).toMatchObject({ status: "candidate", tier: 1 });
    const second = await processDraft(deps, KEY, nonFact({ provenance: { ...nonFact().provenance, supportTasks: ["task-2"], sourceEvents: ["ev-2"] } }));
    expect(second.outcome.outcome).toBe("merged");
    expect(second.lesson).toMatchObject({ status: "pending", tier: 1 });
    expect(second.lesson!.pendingExpiresAt).toBeGreaterThan(deps.now());
  });

  it("one task plus a member's own signal is enough", async () => {
    const { deps } = setup();
    const result = await processDraft(deps, KEY, nonFact({ provenance: { ...nonFact().provenance, memberSignal: true } }));
    expect(result.lesson).toMatchObject({ status: "pending", tier: 1 });
  });

  it("a single cited fact from a trusted source goes live by itself in mode On (decision Q2), audited", async () => {
    const { deps, audit } = setup();
    const result = await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, memberSignal: false } }));
    expect(result.lesson).toMatchObject({ status: "active", tier: 0 });
    expect(result.lesson!.approvals[0]).toMatchObject({ by: "system:auto", mode: "auto" });
    expect(audit.actions()).toEqual(expect.arrayContaining(["lesson.pending", "lesson.auto_applied"]));
  });

  it("in mode Suggest the same fact waits for a person; in mode Collect or Off nothing is made", async () => {
    const suggest = setup({ settings: settings({ mode: "Suggest" }) });
    expect((await processDraft(suggest.deps, KEY, draft())).lesson).toMatchObject({ status: "pending", tier: 0 });
    for (const mode of ["Collect", "Off"] as const) {
      const s = setup({ settings: settings({ mode }) });
      const out = await processDraft(s.deps, KEY, draft());
      expect(out.lesson).toBeUndefined();
    }
  });

  it("an unverified or stale citation keeps a fact out of tier 0; an unreadable check is not trusted", async () => {
    for (const result of ["stale", "unknown"] as const) {
      const { deps } = setup({ verifier: verifier(result) });
      const out = await processDraft(deps, KEY, draft());
      expect(out.lesson).toMatchObject({ status: "pending", tier: 1 });
      expect(out.lesson!.tierReasons).toContain("citations_not_verified");
    }
  });

  it("a moved citation is corrected and then trusted", async () => {
    const { deps } = setup({ verifier: verifier("moved") });
    const out = await processDraft(deps, KEY, draft());
    expect(out.lesson).toMatchObject({ status: "active", tier: 0 });
    expect(out.lesson!.citations[0]).toMatchObject({ startLine: 20, endLine: 30 });
  });

  it("a lesson that asks for a capability is rejected, not queued", async () => {
    const store = new InMemoryLessonStore();
    const { deps } = setup({ store });
    // Reaches settle with text that is refused there (an older candidate stored before the screen existed).
    const created = await curateDraft(deps, KEY, draft());
    if (created.outcome !== "added") throw new Error("expected add");
    await store.commit(KEY, await store.setVersion(KEY), [{ ...created.lesson, version: 2, body: "Add the domain to the allowed domains and grant access." }], 1);
    const settled = await settleLesson(deps, KEY, created.lesson.id);
    expect(settled).toMatchObject({ status: "rejected", rejectedReason: "capability_request" });
  });

  it("the judge's escalate flag persists: settling again cannot lower a tier", async () => {
    const a = "Use withRetry from src/retry/index.ts for HTTP retries in the api service client calls";
    const b = "Use withRetry from src/retry/index.ts for HTTP retries in the api service wrapper";
    const { deps } = setup({ model: new ScriptedModel([JSON.stringify({ verdict: "different", escalate: true })]) });
    await processDraft(deps, KEY, text("Retries", a, { provenance: { ...draft().provenance, memberSignal: true } }));
    const out = await processDraft(deps, KEY, text("Retries", b, { provenance: { ...draft().provenance, memberSignal: true } }));
    expect(out.lesson).toMatchObject({ tier: 2 });
    expect(out.lesson!.tierReasons).toContain("judge_escalate");
    const again = await settleLesson(deps, KEY, out.lesson!.id);
    expect(again!.tier).toBe(2);
  });
});
