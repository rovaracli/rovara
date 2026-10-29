import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { expect, it } from "vitest";
import { needsVerdict } from "../../scripts/ci-gate.js";
import { mockCellPort } from "../web-e2e/support/port.js";
it("runs all browser engines in a dedicated guarded job required by the final gate", async () => {
 const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { needs?: string | string[]; if?: string; steps: Array<{ run?: string; env?: Record<string, string> }> }> };
 const job = workflow.jobs["web-e2e"];expect(job).toBeDefined();expect(job?.needs).toBe("scope");expect(job?.if).toBe("needs.scope.outputs.docs_only != 'true'");
 const commands = job!.steps.map(step => step.run ?? "").join("\n");expect(commands).toContain("npm ci");expect(commands).toContain("npm run build:web");expect(commands).toContain("npx playwright install --with-deps chromium firefox webkit");expect(commands).toContain("npx playwright test -c tests/web-e2e/playwright.config.ts");
 expect(job!.steps.some(step => step.env?.ROVARA_E2E_ALL_BROWSERS === "1")).toBe(true);expect(workflow.jobs.local?.needs).toContain("web-e2e");
});
it("keeps the Playwright traces and report of a failed browser run for seven days", async () => {
 const workflow = YAML.parse(await readFile(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { steps: Array<{ if?: string; uses?: string; with?: Record<string, unknown> }> }> };
 const uploads = workflow.jobs["web-e2e"]!.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
 expect(uploads).toHaveLength(1);expect(uploads[0]!.if).toBe("failure()");expect(uploads[0]!.with?.["retention-days"]).toBe(7);expect(String(uploads[0]!.with?.path)).toContain(".test-build/web-e2e/results");
 for (const [name, job] of Object.entries(workflow.jobs)) if (name !== "web-e2e") expect(job.steps.some(step => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
});
it("refuses missing, skipped or failed required browser results", () => {
 const needs = { scope: { result: "success", outputs: { docs_only: "false" } }, checks: { result: "success" } };
 expect(needsVerdict(JSON.stringify(needs), ["web-e2e"]).ok).toBe(false);
 for (const result of ["failure", "cancelled", "skipped"]) expect(needsVerdict(JSON.stringify({ ...needs, "web-e2e": { result } }), ["web-e2e"]).ok).toBe(false);
 expect(needsVerdict(JSON.stringify({ ...needs, "web-e2e": { result: "success" } }), ["web-e2e"]).ok).toBe(true);
});
it("derives stable worktree-specific ports from the specified hash bytes", () => { expect(mockCellPort("alpha")).toBe(4663);expect(mockCellPort("beta")).toBe(4642);expect(mockCellPort()).toBeGreaterThanOrEqual(4500);expect(mockCellPort()).toBeLessThan(4900); });
