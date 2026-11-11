import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { expect, it } from "vitest";
import { needsVerdict } from "../../scripts/ci-gate.js";
import { mockCellOrigin, mockCellPort, SLOT_ENV } from "../web-e2e/support/port.js";
import { selectedBrowsers } from "../web-e2e/support/browsers.js";
import { missingBuildOutputs } from "../../scripts/web-e2e-build-guard.js";
import config from "../web-e2e/playwright.config.js";
it("runs each browser engine in its own leg of a guarded matrix job required by the final gate", async () => {
 const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { needs?: string | string[]; if?: string; strategy?: { "fail-fast"?: boolean; matrix?: { browser?: string[] } }; steps: Array<{ run?: string; env?: Record<string, string> }> }> };
 const job = workflow.jobs["web-e2e"];expect(job).toBeDefined();expect(job?.needs).toEqual(["scope", "checks", "web-e2e-build"]);expect(job?.if).toBe("needs.scope.outputs.docs_only != 'true'");
 const commands = job!.steps.map(step => step.run ?? "").join("\n");expect(commands).toContain("npm ci");expect(commands).toContain("npx playwright install --with-deps ${{ matrix.browser }}");expect(commands).toContain("npx playwright test -c tests/web-e2e/playwright.config.ts");
 // One leg per engine, none cancelling the others; the matrix job's result is success only when every leg succeeded, and the gate waits for it by name.
 expect(job!.strategy?.matrix?.browser).toEqual(["chromium", "firefox", "webkit"]);expect(job!.strategy?.["fail-fast"]).toBe(false);
 expect(job!.steps.some(step => step.env?.ROVARA_E2E_BROWSER === "${{ matrix.browser }}")).toBe(true);expect(job!.steps.some(step => step.env?.ROVARA_E2E_ALL_BROWSERS !== undefined)).toBe(false);
 expect(workflow.jobs.local?.needs).toContain("web-e2e");expect(workflow.jobs.local?.needs).toContain("web-e2e-build");
 // The legs compile nothing: the one build job does, and the legs unpack it and check it is complete before the first browser starts.
 expect(commands).not.toMatch(/tsc -b|build:web/);expect(job!.steps.some(step => step.env?.ROVARA_E2E_WORKERS === "2")).toBe(true);
 const steps = job!.steps as Array<{ uses?: string; run?: string; with?: Record<string, string> }>, download = steps.findIndex(step => step.uses?.startsWith("actions/download-artifact@")), unpack = steps.findIndex(step => step.run?.startsWith("tar -xzf")), guard = steps.findIndex(step => step.run === "node scripts/web-e2e-build-guard.ts"), run = steps.findIndex(step => step.run?.startsWith("npx playwright test"));
 expect(steps[download]?.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}( #.*)?$/);expect(steps[download]?.with?.name).toBe("web-e2e-build");
 expect(download).toBeGreaterThan(steps.findIndex(step => step.run === "npm ci"));expect(unpack).toBeGreaterThan(download);expect(guard).toBeGreaterThan(unpack);expect(run).toBeGreaterThan(guard);
});
it("builds once, in a job the browser legs and the final gate wait for, and archives every package's dist", async () => {
 const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { needs?: string | string[]; if?: string; steps: Array<{ run?: string; uses?: string; with?: Record<string, unknown> }> }> };
 const build = workflow.jobs["web-e2e-build"];expect(build).toBeDefined();expect(build!.needs).toEqual(["scope", "checks"]);expect(build!.if).toBe("needs.scope.outputs.docs_only != 'true'");
 const commands = build!.steps.map(step => step.run ?? "");expect(commands).toEqual(expect.arrayContaining(["npm ci", "npx tsc -b", "npm run build:web", "node scripts/web-e2e-build-guard.ts"]));
 // packages/*/dist includes packages/web/dist (the app the mock cell serves).
 expect(commands.some(command => /^tar -czf "\$RUNNER_TEMP\/web-e2e-build\.tgz" packages\/\*\/dist$/.test(command))).toBe(true);
 const uploads = build!.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));expect(uploads).toHaveLength(1);expect(uploads[0]!.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}( #.*)?$/);expect(uploads[0]!.with?.name).toBe("web-e2e-build");expect(uploads[0]!.with?.["if-no-files-found"]).toBe("error");
 expect(workflow.jobs.local?.needs).toContain("web-e2e-build");
 expect(needsVerdict(JSON.stringify({ scope: { result: "success", outputs: { docs_only: "false" } }, "web-e2e": { result: "success" } }), ["web-e2e-build", "web-e2e"]).ok).toBe(false);
 for (const result of ["failure", "cancelled", "skipped"]) expect(needsVerdict(JSON.stringify({ scope: { result: "success", outputs: { docs_only: "false" } }, "web-e2e-build": { result }, "web-e2e": { result: "success" } }), ["web-e2e-build", "web-e2e"]).ok).toBe(false);
 // The gate script itself waits for both by name.
 expect(readFileSync("scripts/ci-gate.ts", "utf8")).toContain('["web-e2e-build", "web-e2e"]');
});
it("the build guard names what is missing from an unpacked build", () => {
 const root = mkdtempSync(join(tmpdir(), "e2e-build-")), put = (path: string) => { mkdirSync(join(root, path, ".."), { recursive: true });writeFileSync(join(root, path), "x") };
 for (const name of ["contracts", "web"]) { put(`packages/${name}/package.json`);put(`packages/${name}/tsconfig.json`) }
 put("packages/notes/README.md");
 expect(missingBuildOutputs(root)).toEqual(["packages/cloud-contracts/dist", "packages/web/dist", "packages/web/dist/app/index.html", "packages/cloud-contracts/dist/index.js"]);
 put("packages/cloud-contracts/dist/index.js");put("packages/web/dist/app/index.html");expect(missingBuildOutputs(root)).toEqual([]);
 const run = (target: string) => spawnSync("node", ["scripts/web-e2e-build-guard.ts", target], { encoding: "utf8" });
 expect(run(root)).toMatchObject({ status: 0 });const empty = mkdtempSync(join(tmpdir(), "e2e-build-"));mkdirSync(join(empty, "packages/web"), { recursive: true });writeFileSync(join(empty, "packages/web/tsconfig.json"), "{}");
 const failed = run(empty);expect(failed.status).toBe(1);expect(failed.stdout).toContain("::error::The web-e2e-build archive does not hold packages/web/dist.");
});
it("gives each worker slot its own mock cell: own port, own TLS directory, own process, and the base URL of its slot", async () => {
 expect(mockCellPort("alpha", 0)).toBe(4663);expect(mockCellPort("alpha", 1)).not.toBe(4663);
 for (const path of ["alpha", "beta", process.cwd()]) { const ports = [0, 1, 2, 3, 4, 5, 6, 7].map(slot => mockCellPort(path, slot));expect(new Set(ports).size).toBe(8);for (const port of ports) { expect(port).toBeGreaterThanOrEqual(4500);expect(port).toBeLessThan(4900) } }
 const servers = config.webServer as Array<{ command: string; url: string; env: Record<string, string>; reuseExistingServer: boolean }>;
 expect(servers).toHaveLength(config.workers as number);expect(servers.length).toBeGreaterThanOrEqual(2);
 expect(new Set(servers.map(server => server.url)).size).toBe(servers.length);expect(new Set(servers.map(server => server.env[SLOT_ENV])).size).toBe(servers.length);
 servers.forEach((server, slot) => { expect(server.env[SLOT_ENV]).toBe(String(slot));expect(server.url).toBe(`${mockCellOrigin(slot)}/app`);expect(server.reuseExistingServer).toBe(false) });
 // baseURL comes from the slot fixture, not from the shared config.
 expect((config.use as { baseURL?: string }).baseURL).toBeUndefined();expect(readFileSync("tests/web-e2e/support/csp.ts", "utf8")).toContain("mockCellOrigin(testInfo.parallelIndex)");
 expect(readFileSync("tests/web-e2e/support/mock-cell.ts", "utf8")).toContain("tls-");
});
it("caches the Playwright browsers by the version package-lock pins, installs them only on a miss, and keeps the system packages on a hit", async () => {
 const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { steps: Array<{ id?: string; if?: string; run?: string; uses?: string; with?: Record<string, string> }> }> };
 const steps = workflow.jobs["web-e2e"]!.steps, lock = JSON.parse(await readFile("package-lock.json", "utf8")) as { packages: Record<string, { version?: string }> };
 const caches = steps.filter(step => step.uses?.startsWith("actions/cache@"));expect(caches).toHaveLength(1);
 const cache = caches[0]!;expect(cache.uses).toMatch(/^actions\/cache@[0-9a-f]{40}( #.*)?$/);expect(cache.with?.path).toBe("~/.cache/ms-playwright");
 // The key is the version the lock file pins, read by an earlier step; the version the test sees there is the one the lock holds.
 const version = steps.find(step => step.id === "playwright-version");expect(version?.run).toContain("package-lock.json");expect(version?.run).toContain("node_modules/playwright-core");
 // A version that cannot be read fails the step: no constant cache key. The step's own script is run against a lockfile with and without the entry.
 const script = version!.run!, readIn = (lock: object) => { const directory = mkdtempSync(join(tmpdir(), "pw-version-")), output = join(directory, "output");writeFileSync(join(directory, "package-lock.json"), JSON.stringify(lock));return { ...spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8" }), output: existsSync(output) ? readFileSync(output, "utf8") : "" }; };
 expect(readIn({ packages: { "node_modules/playwright-core": { version: "1.58.2" } } })).toMatchObject({ status: 0, output: "version=1.58.2\n" });
 for (const lock of [{ packages: {} }, { packages: { "node_modules/playwright-core": {} } }, { packages: { "node_modules/playwright-core": { version: "" } } }]) { const failed = readIn(lock);expect(failed.status).not.toBe(0);expect(failed.output).toBe("");expect(failed.stdout).toContain("::error::") }
 expect(steps.indexOf(version!)).toBeLessThan(steps.indexOf(cache));expect(cache.with?.key).toContain("${{ steps.playwright-version.outputs.version }}");expect(cache.with?.key).toContain("${{ runner.os }}");expect(cache.with?.key).toContain("${{ matrix.browser }}");
 expect(lock.packages["node_modules/playwright-core"]?.version).toMatch(/^\d+\.\d+\.\d+$/);
 expect(lock.packages["node_modules/playwright-core"]?.version).toBe(lock.packages["node_modules/@playwright/test"]?.version);
 // The browsers are downloaded only on a miss (with their system packages); a hit still installs the system packages.
 const cacheId = `steps.${cache.id}.outputs.cache-hit`, miss = steps.find(step => step.run === "npx playwright install --with-deps ${{ matrix.browser }}"), hit = steps.find(step => step.run === "npx playwright install-deps ${{ matrix.browser }}");
 expect(cache.id).toBe("playwright-cache");expect(miss?.if).toBe(`${cacheId} != 'true'`);expect(hit?.if).toBe(`${cacheId} == 'true'`);
 expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(miss!));expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(hit!));
 const test = steps.findIndex(step => step.run?.startsWith("npx playwright test"));expect(steps.indexOf(miss!)).toBeLessThan(test);expect(steps.indexOf(hit!)).toBeLessThan(test);
 for (const [name, job] of Object.entries(workflow.jobs)) if (name !== "web-e2e") expect(job.steps.some(step => step.uses?.startsWith("actions/cache@")), name).toBe(false);
});
it("keeps the Playwright traces and report of a failed browser run for seven days, one artifact per browser", async () => {
 const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { steps: Array<{ if?: string; uses?: string; with?: Record<string, unknown> }> }> };
 const uploads = workflow.jobs["web-e2e"]!.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
 expect(uploads).toHaveLength(1);expect(uploads[0]!.if).toBe("failure()");expect(uploads[0]!.with?.["retention-days"]).toBe(7);expect(String(uploads[0]!.with?.path)).toContain(".test-build/web-e2e/results");expect(uploads[0]!.with?.name).toBe("web-e2e-playwright-${{ matrix.browser }}");
 for (const [name, job] of Object.entries(workflow.jobs)) if (name !== "web-e2e" && name !== "web-e2e-build") expect(job.steps.some(step => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
});
it("refuses missing, skipped or failed required browser results", () => {
 const needs = { scope: { result: "success", outputs: { docs_only: "false" } }, checks: { result: "success" } };
 expect(needsVerdict(JSON.stringify(needs), ["web-e2e"]).ok).toBe(false);
 for (const result of ["failure", "cancelled", "skipped"]) expect(needsVerdict(JSON.stringify({ ...needs, "web-e2e": { result } }), ["web-e2e"]).ok).toBe(false);
 expect(needsVerdict(JSON.stringify({ ...needs, "web-e2e": { result: "success" } }), ["web-e2e"]).ok).toBe(true);
});
it("picks the Playwright projects from ROVARA_E2E_BROWSER, then ROVARA_E2E_ALL_BROWSERS, then chromium alone", () => {
 expect(selectedBrowsers({})).toEqual(["chromium"]);expect(selectedBrowsers({ ROVARA_E2E_ALL_BROWSERS: "1" })).toEqual(["chromium", "firefox", "webkit"]);expect(selectedBrowsers({ ROVARA_E2E_ALL_BROWSERS: "0" })).toEqual(["chromium"]);
 for (const name of ["chromium", "firefox", "webkit"]) { expect(selectedBrowsers({ ROVARA_E2E_BROWSER: name })).toEqual([name]);expect(selectedBrowsers({ ROVARA_E2E_BROWSER: name, ROVARA_E2E_ALL_BROWSERS: "1" })).toEqual([name]) }
 expect(selectedBrowsers({ ROVARA_E2E_BROWSER: "" })).toEqual(["chromium"]);
 // A mistyped name must stop the run, not silently run no (or the wrong) project.
 for (const name of ["Chrome", "edge", "chromium firefox"]) expect(() => selectedBrowsers({ ROVARA_E2E_BROWSER: name })).toThrow(/ROVARA_E2E_BROWSER/);
});
it("derives stable worktree-specific ports from the specified hash bytes", () => { expect(mockCellPort("alpha")).toBe(4663);expect(mockCellPort("beta")).toBe(4642);expect(mockCellPort()).toBeGreaterThanOrEqual(4500);expect(mockCellPort()).toBeLessThan(4900); });
