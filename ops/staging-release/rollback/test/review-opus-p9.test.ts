/* eslint-disable @typescript-eslint/no-unsafe-member-access -- evaluator inputs are plain JSON the tests edit at a path */
// Opus P9 review test (767df9393): the guard's own "no variables" check, independent of the evaluator (reviewer mutant O11 survived because the evaluator also refuses).
import { describe, expect, it } from "vitest";
import { guardRollback } from "../src/guard.ts";
import { RollbackWorld, SHA_A, ctx, rollbackInput } from "./world.ts";

describe("Opus P9 review: the guard refuses variables on its own", () => {
  it("a rollback input carrying variables is refused even if the evaluator says AUTO", async () => {
    const w = RollbackWorld.standard();
    const ports = w.rollbackPorts();
    ports.evaluate = () => ({ verdict: "AUTO", reasons: [], alerts: [], sha: SHA_A, pipeline: "code" });
    const r = await guardRollback(ctx(), rollbackInput(w, (i) => { i.trigger.variables = { ONLY_PARTS: "runtime" }; }), ports);
    expect(r.proceed).toBe(false);
    expect(r.reasons.join(" ")).toContain("carries variables");
    const clean = RollbackWorld.standard();
    const cleanPorts = clean.rollbackPorts();
    cleanPorts.evaluate = () => ({ verdict: "AUTO", reasons: [], alerts: [], sha: SHA_A, pipeline: "code" });
    expect((await guardRollback(ctx(), rollbackInput(clean), cleanPorts)).proceed).toBe(true);
  });
});
