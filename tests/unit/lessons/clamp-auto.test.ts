// Fix round 1, item 6: while automatic go-live is not enabled, a stored tier0 "auto" from ANY source is never honoured, at read time and at settle time.
import { describe, expect, it } from "vitest";
import { clampedSettings } from "../../../packages/broker/src/lessons/clamp-auto.js";
import { approversRequired, resolveLearning } from "../../../packages/broker/src/lessons/policy.js";
import { processDraft, type ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { Alerts, Audit, Clock, KEY, MemoryVectors, ScriptedModel, Spend, WS, PROJECT, draft, embedder, facts, settings, verifier } from "./lesson-helpers.js";

const raw = (value: Parameters<typeof settings>[0]) => settings({ mode: "On", ...value });

describe("the clamp", () => {
  it("a stored auto becomes one while auto-apply is off, in every place it can be set; enabled, it is left alone", async () => {
    for (const value of [{ tier0Approval: "auto" as const }, { approval: { tier0: "auto" as const, tier1: "one" as const } }, { tier0Approval: "auto" as const, companyApproval: { tier0: "auto" as const } }]) {
      const off = await resolveLearning(clampedSettings(raw(value), () => false), WS, PROJECT);
      expect(approversRequired(0, off.approval)).toBe(1);
      const on = await resolveLearning(clampedSettings(raw(value), () => true), WS, PROJECT);
      expect(approversRequired(0, on.approval)).toBe(0);
    }
    expect(approversRequired(0, (await resolveLearning(clampedSettings(raw({ tier0Approval: "two" }), () => false), WS, PROJECT)).approval)).toBe(2);
  });
  it("the flag is asked at every read, so switching it off takes effect at once", async () => {
    let enabled = true;
    const reader = clampedSettings(raw({ tier0Approval: "auto" }), () => enabled);
    expect(approversRequired(0, (await resolveLearning(reader, WS, PROJECT)).approval)).toBe(0);
    enabled = false;
    expect(approversRequired(0, (await resolveLearning(reader, WS, PROJECT)).approval)).toBe(1);
  });
  it("a reader that fails still fails closed", async () => {
    const reader = clampedSettings({ read: async () => { throw new Error("down"); } }, () => true);
    expect((await resolveLearning(reader, WS, PROJECT)).mode).toBe("Off");
  });
  it("at settle time: a cited, corroborated fact that a stored auto would have gone live waits for a person", async () => {
    const run = async (enabled: boolean) => {
      const store = new InMemoryLessonStore();
      const clock = new Clock();
      const reader = clampedSettings(raw({ tier0Approval: "auto" }), () => enabled);
      const deps: ProcessDeps = {
        store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit: new Audit(), alerts: new Alerts(), now: clock.now,
        verifier: verifier("valid"), facts: facts(), settings: reader, newId: () => "les_0001",
      };
      return (await processDraft(deps, KEY, draft({ provenance: { ...draft().provenance, sourceKinds: ["send_back"], measured: true } }))).lesson;
    };
    expect(await run(true)).toMatchObject({ status: "active" });
    expect(await run(false)).toMatchObject({ status: "pending" });
  });
});
