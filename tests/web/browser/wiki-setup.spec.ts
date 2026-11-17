// Lead 4 W6 in the browser, on the pretend Code (which serves Code W0's file map, W4's build controls and the nightly upkeep seam): the wiki row of the project's setup checklist. Priya, the company owner, maps the
// files, reads the forecast (pages, no dollars), picks what matters, builds, watches progress, stops and continues, reads the report, turns "Give the wiki to agents" on, refreshes, turns nightly upkeep on, changes its
// cap and deletes the wiki; Sam (a developer) sees where it stands and no control; a Code without the routes shows no row. Screenshots go to the test output folder.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, WikiSetupPanel, setFakePerson, setSetupRun, setWikiSetup } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setWikiSetup(page, PROJECT); await setSetupRun(page, PROJECT, "none"); await setFakePerson(page, "priya"); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page, contrast = false): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async (enabled) => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { rules: { "color-contrast": { enabled } } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  }, contrast);
}
/** Cloud's spending-limits routes are the company backend's, which the pretend Code does not stand behind: the cap is answered here, as the routes answer it. */
async function pretendSpendLimits(page: Page, state: { usd: number | null; version: number; puts: unknown[]; stepUp?: boolean }) {
  await page.route("**/v1/web/org/spend-limits**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", canChange: true, settingsVersion: 1, defaults: { companyMonthlyUsd: null, memberMonthlyUsd: null, projectMonthlyUsd: null, taskUsd: null, upkeepMonthlyUsd: 25, answersMonthlyUsd: 20 }, projects: [], people: [], answers: [], upkeep: state.usd === null ? [] : [{ id: PROJECT, monthlyUsd: state.usd, version: state.version, updatedAt: "2026-11-17T00:00:00.000Z", updatedBy: "x" }], partial: false, max: { projects: 200, people: 200, upkeep: 200, answers: 1 } }) });
      return;
    }
    state.puts.push(request.postDataJSON());
    if (state.stepUp === true) { await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "STEP_UP_REQUIRED", message: "Confirm it's you again, then try once more." } }) }); return; }
    state.usd = (request.postDataJSON() as { monthlyUsd: number }).monthlyUsd; state.version += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

test("the owner maps the files, reads the forecast in pages, builds, stops, continues and reads the report", async ({ page }, testInfo) => {
  const panel = new WikiSetupPanel(page);
  await panel.open(PROJECT);
  await expect(panel.row).toHaveAttribute("data-state", "optional");
  await expect(panel.map).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-before-map.png"), fullPage: true });
  await panel.map.click();
  await expect(panel.byId("wiki-forecast-pages")).toHaveText("24");
  await expect(panel.row).toContainText("Pages expected");
  await expect(panel.byId("wiki-setup-forecast")).not.toContainText("$");
  await expect(panel.row).toContainText("There is no cost figure yet");
  await panel.row.getByText("Tell Rovara what matters (optional)").click();
  await expect(panel.row.getByRole("checkbox", { name: /Skip\? web\/dist/u })).toBeChecked();
  await expect(panel.row.getByRole("checkbox", { name: /Write these first\? web\/src\/billing/u })).not.toBeChecked();
  await panel.row.getByRole("checkbox", { name: /Write these first\? web\/src\/billing/u }).check();
  await panel.row.getByLabel("Notes for the wiki build").fill("Billing is the core.");
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-forecast.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
  await panel.build.click();
  await expect(panel.row).toHaveAttribute("data-state", "running");
  await expect(panel.byId("wiki-setup-progress")).toHaveText("6 of 24 pages");
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-running.png"), fullPage: true });
  await panel.stop.click();
  await expect(panel.byId("wiki-setup-message")).toContainText("The wiki build was stopped. It kept the pages it finished.");
  await expect(panel.byId("wiki-setup-message")).toContainText("Stopped by Priya.");
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-stopped.png"), fullPage: true });
  await panel.continue.click();
  await expect(panel.row).toHaveAttribute("data-state", "running");
  await setWikiSetup(page, PROJECT, { status: "built" });
  await page.reload();
  await expect(panel.row).toHaveAttribute("data-state", "done");
  await panel.open(PROJECT);
  await expect(panel.byId("wiki-setup-message")).toContainText("Wiki built.");
  const report = panel.byId("wiki-setup-report");
  await expect(report).toContainText("Pages written");
  await expect(report).toContainText("Sentences with a source found");
  await expect(report).toContainText("Sentences dropped");
  await expect(report).toContainText("Skipped: 13 generated or vendored files, 3 lock files, 34 images and other binary files, 2 secret-shaped files (never read).");
  await expect(panel.byId("wiki-setup-result")).not.toContainText("$");
  await expect(panel.byId("wiki-setup-open")).toHaveAttribute("href", /tab=wiki/u);
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-report.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
});

test("a built wiki: the agents switch starts off, refresh now, and delete asks first", async ({ page }, testInfo) => {
  await setWikiSetup(page, PROJECT, { status: "built" });
  const panel = new WikiSetupPanel(page);
  await panel.open(PROJECT);
  await expect(panel.agents).not.toBeChecked();
  await expect(panel.byId("wiki-setup-agents-state")).toContainText("People can still read the wiki. Agents do not get it until you turn this on.");
  await panel.agents.click();
  await expect(panel.agents).toBeChecked();
  await expect(panel.byId("wiki-setup-agents-state")).toContainText("New tasks get the index.");
  await expect(panel.byId("wiki-setup-refresh-count")).toHaveText("2 pages are out of date or marked wrong.");
  await panel.refresh.click();
  await expect(panel.row).toHaveAttribute("data-state", "running");
  await expect(panel.byId("wiki-setup-delete")).toBeDisabled();
  await setWikiSetup(page, PROJECT, { status: "built", agentsOn: true });
  await page.reload();
  await panel.open(PROJECT);
  await panel.byId("wiki-setup-delete").click();
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-delete-confirm.png"), fullPage: true });
  await panel.byId("wiki-setup-delete-no").click();
  await expect(panel.byId("wiki-setup-delete")).toBeVisible();
  await panel.byId("wiki-setup-delete").click();
  await panel.byId("wiki-setup-delete-yes").click();
  await expect(panel.byId("wiki-setup-deleted")).toContainText("The wiki was deleted.");
  await expect(panel.row).toHaveAttribute("data-state", "optional");
  await expect(panel.byId("wiki-setup-controls")).toHaveCount(0);
});

test("nightly upkeep: one switch, off by default; the cap saves lower at once and asks for a fresh sign-in to raise; each part names its limit", async ({ page }, testInfo) => {
  const cap: { usd: number | null; version: number; puts: unknown[]; stepUp?: boolean } = { usd: null, version: 0, puts: [] };
  await pretendSpendLimits(page, cap);
  const panel = new WikiSetupPanel(page);
  await panel.open(PROJECT);
  await expect(panel.upkeep).not.toBeChecked();
  await expect(panel.byId("wiki-setup-upkeep-state")).toContainText("Nightly upkeep is off.");
  await expect(panel.byId("wiki-setup-upkeep-limits")).toContainText("Setup and mock checks: no AI.");
  await expect(panel.byId("wiki-setup-upkeep-limits")).toContainText("held by the nightly upkeep cap below");
  await expect(panel.byId("wiki-setup-cap")).toContainText("This is the company's default.");
  await expect(panel.byId("wiki-setup-cap").getByLabel("Monthly cap on nightly upkeep")).toHaveValue("25.00");
  await panel.upkeep.click();
  await expect(panel.upkeep).toBeChecked();
  await expect(panel.byId("wiki-setup-upkeep-state")).toContainText("Nightly upkeep is on.");
  await panel.byId("wiki-setup-cap").getByLabel("Monthly cap on nightly upkeep").fill("12.50");
  await panel.byId("wiki-setup-cap-save").click();
  await expect(panel.byId("wiki-setup-cap-saved")).toBeVisible();
  expect(cap.puts).toEqual([{ expectedVersion: 0, monthlyUsd: 12.5 }]);
  await expect(panel.byId("wiki-setup-cap")).toContainText("This project has its own cap.");
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-upkeep.png"), fullPage: true });
  cap.stepUp = true;
  await panel.byId("wiki-setup-cap").getByLabel("Monthly cap on nightly upkeep").fill("40");
  await panel.byId("wiki-setup-cap-save").click();
  await expect(page.getByTestId("fresh-sign-in")).toBeVisible();
  expect(cap.puts).toEqual([{ expectedVersion: 0, monthlyUsd: 12.5 }, { expectedVersion: 1, monthlyUsd: 40 }]);
  expect(await violations(page)).toEqual([]);
});

test("a person who may not manage (Sam) sees where the wiki stands and no control", async ({ page }, testInfo) => {
  await setWikiSetup(page, PROJECT, { status: "built", agentsOn: true });
  await setFakePerson(page, "sam");
  await page.context().clearCookies();
  const panel = new WikiSetupPanel(page);
  await panel.open(PROJECT);
  await expect(panel.byId("wiki-setup-read-only")).toContainText("Only project admins can build the wiki or change these settings.");
  await expect(panel.byId("wiki-setup-message")).toContainText("Wiki built.");
  await expect(panel.row.getByRole("button", { name: /^(Build wiki|Stop|Continue|Refresh now|Delete wiki|Map the files)/u })).toHaveCount(0);
  await expect(panel.row.getByRole("switch")).toHaveCount(0);
  await expect(panel.byId("wiki-setup-agents-state")).toContainText("Agents use the wiki.");
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-viewer.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
});

test("no AI key: Build says so and cannot be pressed; a Code without the build routes shows no row at all", async ({ page }) => {
  await setWikiSetup(page, PROJECT, { aiKey: "missing", mapMade: true });
  const panel = new WikiSetupPanel(page);
  await panel.open(PROJECT);
  await expect(panel.build).toBeDisabled();
  await expect(panel.byId("wiki-setup-connect-key")).toContainText("Connect an AI key to build the wiki.");
  await expect(panel.byId("wiki-setup-connect-key").getByRole("link", { name: "Connect an AI key" })).toHaveAttribute("href", "/app/admin/ai-spending");
  await setWikiSetup(page, PROJECT, { off: true });
  await page.reload();
  await expect(page.getByTestId("project-checklist")).toBeVisible();
  await expect(panel.row).toHaveCount(0);
});

test("phone width and dark mode keep the panel readable", async ({ page }, testInfo) => {
  await setWikiSetup(page, PROJECT, { status: "stopped", stop: "budget_used" });
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = new WikiSetupPanel(page);
  await panel.open(PROJECT);
  await expect(panel.byId("wiki-setup-message")).toContainText("The wiki build reached its spending limit.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-phone.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(panel.row).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-setup-dark.png"), fullPage: true });
  expect(await violations(page, true)).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await violations(page, true)).toEqual([]);
});
