import { describe, expect, it } from "vitest";
import {
  FUNCTION_RUNNER_EVIDENCE_NOT_CHECKED, FUNCTION_RUNNER_USAGE_LIMITS, FunctionNameSchema, FunctionRunnerUsageSchema, functionCountBucket, functionRunnerEvidenceLine, functionRunnerEvidenceLines, type FunctionRunnerUsage,
} from "@agentx/cloud-contracts";

// Slice 4, lane C1: the functions usage record and the fixed evidence lines (design section 7).
const row = (change: Record<string, unknown> = {}) => ({ name: "resize", where: "runner", runtime: "python3.12", invocations: 21, cold: 2, atCeiling: 1, ...change });
const record = (change: Record<string, unknown> = {}): unknown => ({ schemaVersion: 1, ledger: "read", functions: [row()], otherFunctions: 0, ...change });
const ok = (value: unknown) => FunctionRunnerUsageSchema.safeParse(value).success;

describe("FunctionRunnerUsageSchema", () => {
  it("takes a read record of runner, engine and unsupported rows", () => {
    expect(ok(record())).toBe(true);
    expect(ok(record({ functions: [row(), { name: "notify", where: "engine", invocations: 2, cold: 0, atCeiling: 0 }, { name: "legacy", where: "unsupported", invocations: 1, cold: 0, atCeiling: 0, reason: "x86_native_code" }] }))).toBe(true);
    expect(ok(record({ functions: [] }))).toBe(true);
  });

  it("counts are bucket lower bounds only, so a count carries no more than the services record's counts do", () => {
    for (const value of [3, 5, 7, 20, 22, 41, 100, -1, 1.5, "21"]) expect(ok(record({ functions: [row({ invocations: value })] })), String(value)).toBe(false);
    for (const value of [0, 1, 2, 6, 21]) expect(ok(record({ functions: [row({ invocations: value, cold: 0, atCeiling: 0 })] })), String(value)).toBe(true);
    expect([0, 0.5, 1, 1.9, 2, 5, 6, 20, 21, 5000, Number.NaN, -3].map(functionCountBucket)).toEqual([0, 0, 1, 1, 2, 2, 6, 6, 21, 21, 0, 0]);
  });

  it("holds the row rules: a runner row names its runtime; only a runner row has cold starts or a ceiling; an unsupported one names why; no more cold or ceiling calls than calls", () => {
    expect(ok(record({ functions: [row({ runtime: undefined })] }))).toBe(false);
    expect(ok(record({ functions: [row({ where: "engine", cold: 0, atCeiling: 0 })] }))).toBe(false);
    expect(ok(record({ functions: [row({ where: "engine", runtime: undefined, cold: 2, atCeiling: 0 })] }))).toBe(false);
    expect(ok(record({ functions: [row({ where: "engine", runtime: undefined, cold: 0, atCeiling: 1 })] }))).toBe(false);
    expect(ok(record({ functions: [row({ where: "unsupported", runtime: undefined, cold: 0, atCeiling: 0 })] }))).toBe(false);
    expect(ok(record({ functions: [row({ where: "unsupported", runtime: undefined, cold: 0, atCeiling: 0, reason: "made up" })] }))).toBe(false);
    expect(ok(record({ functions: [row({ invocations: 1, cold: 2, atCeiling: 0 })] }))).toBe(false);
    expect(ok(record({ functions: [row({ invocations: 1, cold: 0, atCeiling: 2 })] }))).toBe(false);
    expect(ok(record({ functions: [row({ reason: "ceiling" })] }))).toBe(true);
    expect(ok(record({ functions: [row({ reason: "runtime" })] }))).toBe(false);
  });

  it("is strict (no extra key: no path, payload or message field can ride along), lists a function once and at most the bound", () => {
    expect(ok(record({ extra: 1 }))).toBe(false);
    expect(ok(record({ functions: [row({ path: "/var/task/app.py" })] }))).toBe(false);
    expect(ok(record({ functions: [row({ message: "boom" })] }))).toBe(false);
    expect(ok(record({ functions: [row(), row()] }))).toBe(false);
    const many = Array.from({ length: FUNCTION_RUNNER_USAGE_LIMITS.functions + 1 }, (_, index) => row({ name: `fn${String(index)}` }));
    expect(ok(record({ functions: many }))).toBe(false);
    expect(ok(record({ functions: many.slice(0, FUNCTION_RUNNER_USAGE_LIMITS.functions) }))).toBe(true);
  });

  it("a record that was not read says nothing: it holds no rows (fail closed), never an empty 'no functions'", () => {
    expect(ok(record({ ledger: "unreadable", functions: [], otherFunctions: 0 }))).toBe(true);
    expect(ok(record({ ledger: "unreadable" }))).toBe(false);
    expect(ok(record({ ledger: "unreadable", functions: [], otherFunctions: 2 }))).toBe(false);
    expect(functionRunnerEvidenceLines(FunctionRunnerUsageSchema.parse(record({ ledger: "unreadable", functions: [] })))).toEqual([FUNCTION_RUNNER_EVIDENCE_NOT_CHECKED]);
    expect(functionRunnerEvidenceLines(undefined)).toEqual([FUNCTION_RUNNER_EVIDENCE_NOT_CHECKED]);
  });
});

describe("function names (evidence lines show them; nothing else of the function's is ever shown)", () => {
  it("are plain Lambda names", () => {
    for (const name of ["resize", "Resize_Image-2", "a", "x".repeat(31), "billing-prod-processOrderEvents"]) expect(FunctionNameSchema.safeParse(name).success, name).toBe(true);
  });
  it("do not show a name of 32 or more plain characters (the record's secret-shape rule reads such a run as a token): that function is counted in otherFunctions instead", () => {
    expect(FunctionNameSchema.safeParse("x".repeat(32)).success).toBe(false);
    expect(FunctionNameSchema.safeParse("a-very-long-function-name-in-prod-v2").success).toBe(false);
  });
  it("refuse a path, a URL, spaces, control or bidi characters, an ARN, an empty or over-long name, and anything secret-shaped", () => {
    const hostile = ["", "x".repeat(65), "/var/task/app", "../etc", "a b", "a\nb", "a‮b", "a\u0000b", "arn:aws:lambda:us-east-1:123456789012:function:x", "http://x.example", "résumé",
      `AKIA${"A".repeat(16)}`, `sk_live_${"a".repeat(24)}`, "abcdefghij".repeat(4)];
    for (const name of hostile) expect(FunctionNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(false);
  });
});

describe("evidence lines", () => {
  const parse = (value: unknown): FunctionRunnerUsage => FunctionRunnerUsageSchema.parse(value);
  it("say where each function ran, in fixed words (the design's three shapes, with the bucket the count falls in)", () => {
    expect(functionRunnerEvidenceLine(parse(record()).functions[0]!)).toBe("resize: 21 or more invocations, ran in the Rovara function runner (gVisor, python3.12, arm64); 2 to 5 cold; 1 at the 28 s ceiling (unsupported)");
    expect(functionRunnerEvidenceLine(parse(record({ functions: [{ name: "notify", where: "engine", invocations: 2, cold: 0, atCeiling: 0 }] })).functions[0]!)).toBe("notify: 2 to 5 invocations, ran in the engine (AWS Emulator, in-process Python or Node)");
    expect(functionRunnerEvidenceLine(parse(record({ functions: [{ name: "legacy", where: "unsupported", invocations: 1, cold: 0, atCeiling: 0, reason: "x86_native_code" }] })).functions[0]!)).toBe("legacy: unsupported (x86_64 native code)");
    expect(functionRunnerEvidenceLine(parse(record({ functions: [row({ invocations: 1, cold: 0, atCeiling: 0 })] })).functions[0]!)).toBe("resize: 1 invocation, ran in the Rovara function runner (gVisor, python3.12, arm64)");
  });

  it("have one line per function in record order, and one for the functions not named", () => {
    const lines = functionRunnerEvidenceLines(parse(record({ functions: [row(), row({ name: "other", invocations: 1, cold: 1, atCeiling: 0 })], otherFunctions: 6 })));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("6 to 20 more functions not named");
    expect(functionRunnerEvidenceLines(parse(record({ functions: [], otherFunctions: 1 })))).toEqual(["1 more function not named"]);
    expect(functionRunnerEvidenceLines(parse(record({ functions: [] })))).toEqual([]);
  });

  it("every unsupported reason has its own words and none contains a path, a number or text from the worker", () => {
    for (const reason of ["x86_native_code", "runtime", "ceiling", "payload_size", "runner_unavailable", "other"]) {
      const line = functionRunnerEvidenceLine(parse(record({ functions: [{ name: "fn", where: "unsupported", invocations: 0, cold: 0, atCeiling: 0, reason }] })).functions[0]!);
      expect(line, reason).toMatch(/^fn: unsupported/u);
      expect(line, reason).not.toMatch(/[\\/]|\d{3,}/u);
    }
  });
});
