// Build-time check that the worker's compiled output holds the detector thread's entry file (scripts/check-worker-dist.ts), and that the build runs it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL("../../scripts/check-worker-dist.ts", import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const run = (root: string) => spawnSync(process.execPath, [script, root], { encoding: "utf8" });
const fresh = (): string => { const root = mkdtempSync(join(tmpdir(), "worker-dist-")); roots.push(root); return root; };
const DETECTOR_FILES = ["detect-thread.js", "guarded.js"];
// TS-RUN-1 (image part): the health probe and the sealed DNS helper run from the worker image by these paths (service-helpers.ts PROBE_ENTRY, check-sandbox.ts SEALED_DNS_HELPER_ENTRY).
const TEST_SERVICE_FILES = ["service-probe.js", "sealed-dns-helper.js", "fake-helper.js"];
function build(root: string, present: { detector?: string[]; services?: string[]; empty?: string[] }): void {
  mkdirSync(join(root, "packages/worker/dist/env-detect"), { recursive: true });
  for (const name of present.detector ?? []) writeFileSync(join(root, "packages/worker/dist/env-detect", name), present.empty?.includes(name) === true ? "" : "export {};\n");
  for (const name of present.services ?? []) writeFileSync(join(root, "packages/worker/dist", name), present.empty?.includes(name) === true ? "" : "export {};\n");
}

describe("scripts/check-worker-dist.ts", () => {
  it("fails, naming the file, when the compiled thread entry is missing", () => {
    const result = run(fresh());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/worker/dist/env-detect/detect-thread.js");
  });
  it("fails when a required file is empty", () => {
    const root = fresh();
    build(root, { detector: DETECTOR_FILES, services: TEST_SERVICE_FILES, empty: ["detect-thread.js"] });
    expect(run(root).status).toBe(1);
  });
  it("passes when every required file is there", () => {
    const root = fresh();
    build(root, { detector: DETECTOR_FILES, services: TEST_SERVICE_FILES });
    expect(run(root).status).toBe(0);
  });
  it.each(TEST_SERVICE_FILES)("fails, naming %s, when the test services' %s is missing from the image (TS-RUN-1)", (missing) => {
    const root = fresh();
    build(root, { detector: DETECTOR_FILES, services: TEST_SERVICE_FILES.filter((name) => name !== missing) });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`packages/worker/dist/${missing}`);
  });
  it.each(TEST_SERVICE_FILES)("fails when %s is empty", (empty) => {
    const root = fresh();
    build(root, { detector: DETECTOR_FILES, services: TEST_SERVICE_FILES, empty: [empty] });
    expect(run(root).status).toBe(1);
  });
  it("still checks when it is started through a link or a spelled-out path (it cannot skip itself)", () => {
    const root = fresh();
    const link = join(root, "link-to-script.ts");
    symlinkSync(script, link);
    for (const spelling of [link, join(dirname(script), "..", "scripts", "check-worker-dist.ts")]) {
      const result = spawnSync(process.execPath, [spelling, root], { encoding: "utf8" });
      expect(result.status, spelling).toBe(1);
      expect(result.stderr).toContain("service-probe.js");
    }
  });
  it("requires exactly the entries the helper launcher and the sealed sandbox run from", async () => {
    const { PROBE_ENTRY } = await import("../../packages/worker/src/service-helpers.js");
    const { SEALED_DNS_HELPER_ENTRY } = await import("../../packages/worker/src/check-sandbox.js");
    const { REQUIRED_WORKER_DIST_FILES } = await import("../../scripts/worker-dist-files.js");
    const inImage = (path: string) => path.replace("/opt/agentx/", "");
    expect(REQUIRED_WORKER_DIST_FILES).toContain(inImage(PROBE_ENTRY));
    expect(REQUIRED_WORKER_DIST_FILES).toContain(inImage(SEALED_DNS_HELPER_ENTRY));
  });
  it("is part of the build", () => {
    const build = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts["build"]!;
    expect(build).toContain("tsc -b");
    expect(build.indexOf("check-worker-dist")).toBeGreaterThan(build.indexOf("tsc -b"));
  });
});
