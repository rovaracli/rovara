// TE-B1-fresh: which kind of check round a task gets (check-round-kind.ts), and what each kind may do. The chooser is pure; every fact must be exactly the boolean true to count, so an odd value reads as off.
import { describe, expect, it } from "vitest";
import {
  CHECK_ROUND_KINDS, DEVCONTAINER_ROUND_LINE, FRESH_ROUND_FIRST_LINE, SEALED_ROUND_LINE, WORKING_ROUND_LINE,
  chooseCheckRound, modelEgressRoundKind, realModelCallsAllowed, roundEvidenceLines, sealedRoundClearedFrom, type CheckRoundFacts,
} from "../../packages/worker/src/check-round-kind.js";

const facts = (extra: Partial<CheckRoundFacts> = {}): CheckRoundFacts => ({ freshGate: false, testServices: false, sealedCleared: false, devcontainer: false, sandbox: true, candidateCommitted: true, ...extra });
/** "sealed" with no "not" before it: the word this round must never print on its own. */
const UNSAID_SEALED = /(?<!not )sealed/iu;

describe("chooseCheckRound truth table", () => {
  it("the gate off is today's behaviour (working), whatever else is true except a sealed round that is cleared", () => {
    expect(chooseCheckRound(facts())).toBe("working");
    expect(chooseCheckRound(facts({ testServices: true, sealedCleared: false }))).toBe("working");
  });
  it("the gate on and tx off is the fresh round", () => {
    expect(chooseCheckRound(facts({ freshGate: true }))).toBe("fresh_unsealed");
  });
  it("tx on and the worker self-test passed is the sealed round, with or without the fresh gate", () => {
    expect(chooseCheckRound(facts({ testServices: true, sealedCleared: true }))).toBe("sealed");
    expect(chooseCheckRound(facts({ freshGate: true, testServices: true, sealedCleared: true }))).toBe("sealed");
  });
  it("tx on while the self-test is held never gives the sealed round: the gate decides between fresh and working", () => {
    expect(chooseCheckRound(facts({ freshGate: true, testServices: true, sealedCleared: false }))).toBe("fresh_unsealed");
    expect(chooseCheckRound(facts({ freshGate: false, testServices: true, sealedCleared: false }))).toBe("working");
  });
  it("a dev container or a missing sandbox is never moved: it stays working, with the gate on", () => {
    expect(chooseCheckRound(facts({ freshGate: true, devcontainer: true }))).toBe("working");
    expect(chooseCheckRound(facts({ freshGate: true, sandbox: false }))).toBe("working");
  });
  it("a task whose candidate is not committed has nothing to export: it stays working", () => {
    expect(chooseCheckRound(facts({ freshGate: true, candidateCommitted: false }))).toBe("working");
  });
  it("odd values read as off, for every fact", () => {
    const odd: unknown[] = ["true", 1, "1", {}, [], null, undefined, "yes", 0];
    for (const value of odd) {
      expect(chooseCheckRound(facts({ freshGate: value }))).toBe("working");
      expect(chooseCheckRound(facts({ freshGate: true, sandbox: value }))).toBe("working");
      expect(chooseCheckRound(facts({ freshGate: true, devcontainer: value }))).toBe("working");
      expect(chooseCheckRound(facts({ freshGate: true, candidateCommitted: value }))).toBe("working");
      expect(chooseCheckRound(facts({ freshGate: true, testServices: value, sealedCleared: true }))).toBe("fresh_unsealed");
      expect(chooseCheckRound(facts({ freshGate: true, testServices: true, sealedCleared: value }))).toBe("fresh_unsealed");
    }
  });
  it("an empty facts object is working", () => {
    expect(chooseCheckRound({} as CheckRoundFacts)).toBe("working");
  });
});

describe("D2: real model calls (DECISIONS 163b)", () => {
  it("are allowed only in a fresh check sandbox or the sealed round, never in the working sandbox", () => {
    expect(realModelCallsAllowed("fresh_unsealed")).toBe(true);
    expect(realModelCallsAllowed("sealed")).toBe(true);
    expect(realModelCallsAllowed("working")).toBe(false);
  });
  it("an unknown kind is not allowed", () => {
    for (const value of [undefined, null, "", "FRESH_UNSEALED", "check_unsealed", 1, {}]) expect(realModelCallsAllowed(value), JSON.stringify(value) ?? "undefined").toBe(false);
  });
  it("every kind has an answer and a model-egress spelling", () => {
    expect(CHECK_ROUND_KINDS.map((kind) => [kind, realModelCallsAllowed(kind), modelEgressRoundKind(kind)])).toEqual([
      ["working", false, "working"], ["fresh_unsealed", true, "check_unsealed"], ["sealed", true, "check_sealed"],
    ]);
  });
});

describe("the labels", () => {
  it("the fresh round's first line starts with 'not sealed'", () => {
    expect(FRESH_ROUND_FIRST_LINE.startsWith("not sealed")).toBe(true);
    expect(roundEvidenceLines("fresh_unsealed", { devcontainer: false })[0]).toBe(FRESH_ROUND_FIRST_LINE);
  });
  it("the residual line the model-host block supplies comes second, and is never written here", () => {
    expect(roundEvidenceLines("fresh_unsealed", { devcontainer: false, residualLine: "not sealed; model hosts blocked by name only" })).toEqual([FRESH_ROUND_FIRST_LINE, "not sealed; model hosts blocked by name only"]);
  });
  it("a dev-container project keeps its own line and states the gap plainly", () => {
    const lines = roundEvidenceLines("working", { devcontainer: true });
    expect(lines).toEqual([DEVCONTAINER_ROUND_LINE]);
    expect(DEVCONTAINER_ROUND_LINE.startsWith("checked in your dev container (not sealed)")).toBe(true);
    expect(DEVCONTAINER_ROUND_LINE).toMatch(/not a fresh copy/u);
  });
  it("the word sealed never appears for an unsealed round without 'not' in front of it", () => {
    for (const line of [FRESH_ROUND_FIRST_LINE, WORKING_ROUND_LINE, DEVCONTAINER_ROUND_LINE, ...roundEvidenceLines("fresh_unsealed", { devcontainer: false }), ...roundEvidenceLines("working", { devcontainer: false })]) {
      expect(UNSAID_SEALED.test(line), line).toBe(false);
    }
    // The sealed round has its own words, and they are not used for the others.
    expect(roundEvidenceLines("sealed", { devcontainer: false })).toEqual([SEALED_ROUND_LINE]);
  });
});

describe("M2: the sealed round is cleared only when the worker says so (fail closed)", () => {
  it("no seam is not cleared; only exactly true clears", () => {
    expect(sealedRoundClearedFrom(undefined)).toBe(false);
    expect(sealedRoundClearedFrom(() => true)).toBe(true);
    for (const value of [false, undefined, null, "true", 1, {}]) expect(sealedRoundClearedFrom(() => value), JSON.stringify(value) ?? "undefined").toBe(false);
  });
});
