// Build-time check that the worker's compiled output holds the detector thread's entry file (scripts/check-worker-dist.ts), and that the build runs it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL("../../scripts/check-worker-dist.ts", import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: "utf8" });
const fresh = (): string => { const root = mkdtempSync(join(tmpdir(), "worker-dist-")); roots.push(root); return root; };

describe("scripts/check-worker-dist.ts", () => {
  it("fails, naming the file, when the compiled thread entry is missing", () => {
    const result = run(fresh());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/worker/dist/env-detect/detect-thread.js");
  });
  it("fails when a required file is empty", () => {
    const root = fresh();
    mkdirSync(join(root, "packages/worker/dist/env-detect"), { recursive: true });
    writeFileSync(join(root, "packages/worker/dist/env-detect/detect-thread.js"), "");
    writeFileSync(join(root, "packages/worker/dist/env-detect/guarded.js"), "export {};\n");
    expect(run(root).status).toBe(1);
  });
  it("passes when both files are there", () => {
    const root = fresh();
    mkdirSync(join(root, "packages/worker/dist/env-detect"), { recursive: true });
    for (const name of ["detect-thread.js", "guarded.js"]) writeFileSync(join(root, "packages/worker/dist/env-detect", name), "export {};\n");
    expect(run(root).status).toBe(0);
  });
  it("is part of the build", () => {
    const build = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts["build"]!;
    expect(build).toContain("tsc -b");
    expect(build.indexOf("check-worker-dist")).toBeGreaterThan(build.indexOf("tsc -b"));
  });
});
