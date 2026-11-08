// Keeps the copies of the embedder's identity equal: environments/embedder/models.lock.json (what the image bakes in), the contracts constants (what the broker expects and
// what names the vector index), the hashed requirements files, and the limits both sides enforce. A change to one without the others fails here, before an image is built or a vector is stored.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER } from "@agentx/contracts";
import { EMBEDDER_BLANK_CODE_POINTS, EMBEDDER_LIMITS } from "../../../packages/broker/src/embedder/client.js";

interface Model { repo: string; revision: string; dimension: number; spec: string; pooling: string; maxTokens: number; prefix: string[]; suffix: string[]; license: string; outputs: Record<string, string>; files: Record<string, string>; referenceFiles: Record<string, string> }
interface Lock { toolchain: Record<string, string>; models: Record<"record" | "lesson", Model> }
const read = (name: string): string => readFileSync(new URL(`../../../environments/embedder/${name}`, import.meta.url), "utf8");
const lock = JSON.parse(read("models.lock.json")) as Lock;
const core = read("app/embedder_core.py");

/** The same hash embedder_core.spec_id computes (both models ship in fp32: quantization is "none"). */
function specOf(model: Model, toolchain: Record<string, string>): string {
  const pairs = (values: Record<string, string>): string => Object.keys(values).sort().map((name) => `${name}=${values[name]}`).join(",");
  const textRules = /^TEXT_RULES = "([^"]+)"/m.exec(core)![1]!;
  const parts = [model.repo, model.revision, "none", model.pooling, String(model.maxTokens), model.prefix.join("|"), model.suffix.join("|"), String(model.dimension), textRules, pairs(toolchain), pairs(model.outputs)];
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
}

describe("the embedder's identity", () => {
  it.each([["record", TEAM_RECORD_EMBEDDER], ["lesson", LESSON_EMBEDDER]] as const)("%s: the lock file, the contracts constant and the computed spec agree", (name, constant) => {
    const model = lock.models[name];
    expect(model.repo).toBe(constant.modelId);
    expect(model.revision).toBe(constant.revision);
    expect(model.dimension).toBe(constant.dimension);
    expect(model.spec).toBe(constant.spec);
    expect(specOf(model, lock.toolchain)).toBe(constant.spec);
    expect(constant.model).toBe(name);
  });
  it("the spec names the export tools' versions and the hash of every output file, so a different tool or output is a different spec", () => {
    const model = lock.models.record;
    expect(specOf({ ...model, outputs: { ...model.outputs, "model.onnx": "0".repeat(64) } }, lock.toolchain)).not.toBe(model.spec);
    expect(specOf(model, { ...lock.toolchain, onnx: "0.0.0" })).not.toBe(model.spec);
  });
  it("uses open models with licences we may ship (Apache-2.0 and MIT), pinned to commits, in fp32", () => {
    expect(lock.models.record.license).toBe("Apache-2.0");
    expect(lock.models.lesson.license).toBe("MIT");
    for (const model of Object.values(lock.models)) {
      expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(model).not.toHaveProperty("quantize");
    }
    expect(read("tools/export_models.py")).not.toMatch(/quantize/i);
  });
  it("cuts the record model's texts at 2,048 tokens and the lessons' at 512 (part of the spec)", () => {
    expect(lock.models.record.maxTokens).toBe(2048);
    expect(lock.models.lesson.maxTokens).toBe(512);
  });
  it("the function and the port enforce the same limits", () => {
    const number = (name: string): number => Number(new RegExp(`^${name} = ([0-9_]+)`, "m").exec(core)![1]!.replaceAll("_", ""));
    expect(number("MAX_TEXTS")).toBe(EMBEDDER_LIMITS.maxTexts);
    expect(number("MAX_TEXT_CHARS")).toBe(EMBEDDER_LIMITS.maxTextChars);
    expect(number("MAX_TOTAL_CHARS")).toBe(EMBEDDER_LIMITS.maxTotalChars);
  });
  it("the function and the port call the same characters blank (JavaScript's trim() and Python's strip() disagree on some)", () => {
    const block = /BLANK_CODE_POINTS = \(([^)]*)\)/s.exec(core)![1]!;
    const python = [...block.matchAll(/0x([0-9A-Fa-f]+)/g)].map((match) => Number.parseInt(match[1]!, 16));
    expect([...python].sort((a, b) => a - b)).toEqual([...EMBEDDER_BLANK_CODE_POINTS].sort((a, b) => a - b));
    // everything JavaScript trims is in the set too
    for (let code = 0; code < 0x10000; code += 1) if (String.fromCodePoint(code).trim() === "") expect(EMBEDDER_BLANK_CODE_POINTS, code.toString(16)).toContain(code);
  });
});

describe("the hashed requirements files", () => {
  it("name the tool versions the lock's toolchain names, and the runtime image installs three packages", () => {
    const requirementsIn = read("requirements-build.in");
    for (const [name, version] of Object.entries(lock.toolchain)) {
      if (name === "torch") expect(requirementsIn).toContain(`torch-${version}%2Bcpu-cp312-cp312-manylinux_2_28_aarch64.whl`);
      else expect(requirementsIn).toMatch(new RegExp(`^${name}==${version.replaceAll(".", "\\.")}$`, "m"));
    }
    expect(read("requirements-runtime.in").split("\n").filter((line) => /^[a-z]/.test(line))).toEqual([`onnxruntime==${lock.toolchain.onnxruntime}`, `tokenizers==${lock.toolchain.tokenizers}`, "numpy==2.5.4"]);
  });
});

describe("the function's own tests (python, standard library only)", () => {
  const python = (() => { try { return execFileSync("python3", ["-I", "--version"], { encoding: "utf8" }).startsWith("Python 3") ? "python3" : undefined; } catch { return undefined; } })();
  // Where the check runs for real (CI, or a gate that sets REQUIRE_PYTHON_TESTS=1) a missing python3 FAILS the test instead of skipping it: a skipped test reads as a pass.
  const required = process.env.CI === "true" || process.env.REQUIRE_PYTHON_TESTS === "1";
  if (required) {
    it("python3 is installed (CI must not skip the function's tests)", () => {
      expect(python, "python3 is not installed, so environments/embedder/tests cannot run").toBeDefined();
    });
  }
  it.skipIf(python === undefined && !required)("pass: request checks, limits, error codes, pooling, spec, locked requirements, logging without text", () => {
    expect(python, "python3 is not installed").toBeDefined();
    const path = new URL("../../../environments/embedder/tests/test_embedder.py", import.meta.url).pathname;
    expect(existsSync(path)).toBe(true);
    const output = execFileSync(python!, ["-I", "-B", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" } });
    expect(output).toBe("");
  });
});
