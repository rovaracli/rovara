import { expect } from "vitest";
import { evaluate, type Decision } from "../src/evaluate.ts";
import { cloneDeep } from "./clone.ts";
import type { Obj } from "./fixtures.ts";

/** Evaluates an input and asserts MANUAL. `code` (optional) must be among the reason codes; `rule` (optional) among the rules. */
export function manual(input: unknown, code?: string, rule?: string): Decision {
  const d = evaluate(input);
  expect(d.verdict, `expected MANUAL, reasons: ${JSON.stringify(d.reasons)}`).toBe("MANUAL");
  expect(d.reasons.length).toBeGreaterThan(0);
  if (code !== undefined) expect(d.reasons.map((r) => r.code), JSON.stringify(d.reasons)).toContain(code);
  if (rule !== undefined) expect(d.reasons.map((r) => r.rule), JSON.stringify(d.reasons)).toContain(rule);
  return d;
}

export function auto(input: unknown): Decision {
  const d = evaluate(input);
  expect(d.reasons, "no reasons expected").toEqual([]);
  expect(d.verdict).toBe("AUTO");
  return d;
}

/** Clone a fixture, change it, evaluate, expect MANUAL. */
export function attack(base: () => Obj, change: (input: Obj) => void, code?: string, rule?: string): Decision {
  const input = cloneDeep(base());
  change(input);
  return manual(input, code, rule);
}
