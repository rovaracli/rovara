// Keeps the three copies of the embedder's identity equal: environments/embedder/models.lock.json (what the image bakes in), the contracts constants (what the broker expects and
// what names the vector index), and the limits both sides enforce. A change to one without the others fails here, before an image is built or a vector is stored.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LESSON_EMBEDDER, TEAM_RECORD_EMBEDDER } from "@agentx/contracts";
import { EMBEDDER_LIMITS } from "../../../packages/broker/src/embedder/client.js";

interface Lock { models: Record<"record" | "lesson", { repo: string; revision: string; dimension: number; spec: string; quantize: boolean; pooling: string; maxTokens: number; prefix: string[]; suffix: string[]; license: string }> }
const lock = JSON.parse(readFileSync(new URL("../../../environments/embedder/models.lock.json", import.meta.url), "utf8")) as Lock;
const core = readFileSync(new URL("../../../environments/embedder/app/embedder_core.py", import.meta.url), "utf8");

/** The same hash embedder_core.spec_id computes. */
function specOf(model: Lock["models"]["record"]): string {
  const parts = [model.repo, model.revision, model.quantize ? "int8-dynamic-per-channel-matmul" : "none", model.pooling, String(model.maxTokens), model.prefix.join("|"), model.suffix.join("|"), String(model.dimension)];
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
}

describe("the embedder's identity", () => {
  it.each([["record", TEAM_RECORD_EMBEDDER], ["lesson", LESSON_EMBEDDER]] as const)("%s: the lock file, the contracts constant and the computed spec agree", (name, constant) => {
    const model = lock.models[name];
    expect(model.repo).toBe(constant.modelId);
    expect(model.revision).toBe(constant.revision);
    expect(model.dimension).toBe(constant.dimension);
    expect(model.spec).toBe(constant.spec);
    expect(specOf(model)).toBe(constant.spec);
    expect(constant.model).toBe(name);
  });
  it("uses open models with licences we may ship (Apache-2.0 and MIT), pinned to commits", () => {
    expect(lock.models.record.license).toBe("Apache-2.0");
    expect(lock.models.lesson.license).toBe("MIT");
    for (const model of Object.values(lock.models)) expect(model.revision).toMatch(/^[0-9a-f]{40}$/);
  });
  it("the function and the port enforce the same limits", () => {
    const number = (name: string): number => Number(new RegExp(`^${name} = ([0-9_]+)`, "m").exec(core)![1]!.replaceAll("_", ""));
    expect(number("MAX_TEXTS")).toBe(EMBEDDER_LIMITS.maxTexts);
    expect(number("MAX_TEXT_CHARS")).toBe(EMBEDDER_LIMITS.maxTextChars);
    expect(number("MAX_TOTAL_CHARS")).toBe(EMBEDDER_LIMITS.maxTotalChars);
  });
});

describe("the function's own tests (python, standard library only)", () => {
  const python = (() => { try { return execFileSync("python3", ["-I", "--version"], { encoding: "utf8" }).startsWith("Python 3") ? "python3" : undefined; } catch { return undefined; } })();
  it.skipIf(python === undefined)("pass: request checks, limits, error codes, pooling, spec, logging without text", () => {
    const path = new URL("../../../environments/embedder/tests/test_embedder.py", import.meta.url).pathname;
    expect(existsSync(path)).toBe(true);
    const output = execFileSync(python!, ["-I", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    expect(output).toBe("");
  });
});
