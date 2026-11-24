// L4-U5 in the browser, on the pretend Code (which serves Code's hosted `setup-check`, with the "Setup needs repair" card while a project's setup is broken, and the nightly upkeep read with the pause): the card on
// the project's page in light and dark (screenshots in the test output), its one action and "Re-check setup", what a reader sees (the same words, no action), the card going away when the setup works, and the paused
// upkeep notice on the setup page. No accessibility violations in either theme.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, ROUTES, SetupTabPage, WikiSetupPanel, setFakePerson, setSetupRun, setWikiSetup } from "./pages/index.js";

const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
test.afterEach(async ({ page }) => { await setWikiSetup(page, PROJECT); await setSetupRun(page, PROJECT, "none"); await setFakePerson(page, "priya"); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", {});
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}

for (const scheme of ["light", "dark"] as const) {
  test(`the owner reads the repair banner, then the status card's one action and Check again without AI (${scheme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setSetupRun(page, PROJECT, "ready", true);
    await setWikiSetup(page, PROJECT, { repair: { step: STEP, fixReady: false, changed: "dependency files" } });
    await page.goto(ROUTES.project(PROJECT));
    const banner = page.getByTestId("setup-repair-card");
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("heading", { name: "Setup needs repair: work continues; results may be less reliable until setup is fixed." })).toBeVisible();
    await expect(banner).toHaveAttribute("data-tone", "warning");
    await expect(banner.getByTestId("setup-repair-body")).toHaveText(`The project's setup stopped working after recent code changes (${STEP}).`);
    await expect(banner.getByRole("button")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`setup-repair-banner-${scheme}.png`), fullPage: true });
    await banner.getByRole("link", { name: "Open Setup" }).click();
    const tab = new SetupTabPage(page);
    await expect(tab.card).toHaveAttribute("data-state", "repair");
    await expect(tab.card.getByRole("heading")).toHaveText("Setup stopped working after recent code changes");
    await expect(tab.card.getByRole("button", { name: "Fix setup" })).toBeVisible();
    await expect(tab.card).toContainText("Uses your AI, up to $4.00.");
    await expect(page.getByTestId("setup-repair-card")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`setup-repair-${scheme}.png`), fullPage: true });
    expect(await violations(page)).toEqual([]);
    await tab.card.getByRole("button", { name: "Check again without AI" }).click();
    await expect(tab.card.getByTestId("setup-recheck-started")).toContainText("Checking setup again.");
    // A second press while Code's check runs is refused in a fixed sentence.
    await tab.card.getByRole("button", { name: "Check again without AI" }).click();
    await expect(tab.card.getByTestId("setup-run-error")).toBeVisible();
    await expect(tab.card.getByTestId("setup-run-error")).not.toContainText("ws-recheck");
  });
}

test("a checked fix waiting turns the action into Approve new setup, in the status card", async ({ page }, testInfo) => {
  await setSetupRun(page, PROJECT, "ready", true);
  await setWikiSetup(page, PROJECT, { repair: { step: STEP, fixReady: true } });
  const tab = new SetupTabPage(page);
  await tab.open(PROJECT);
  await expect(tab.card.getByRole("button", { name: "Approve new setup" })).toBeVisible();
  await expect(tab.card.getByRole("button", { name: /^Fix setup/u })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("setup-repair-approve.png"), fullPage: true });
});

test("a developer reads the same words and who can act, with nothing to press", async ({ page }) => {
  await setSetupRun(page, PROJECT, "ready", true);
  await setWikiSetup(page, PROJECT, { repair: { step: STEP, fixReady: false } });
  await setFakePerson(page, "sam");
  const tab = new SetupTabPage(page);
  await tab.open(PROJECT);
  await expect(tab.card).toContainText("Work on");
  await expect(tab.card).toContainText("continues; results may be less reliable until setup is fixed.");
  await expect(tab.card).not.toContainText("can't build");
  await expect(tab.card.getByTestId("setup-reader-note")).toHaveText("A project admin, or a company owner or admin, can do this.");
  await expect(tab.card.getByRole("button")).toHaveCount(0);
});

test("there is no banner while the setup works, and none for a Code with no such read", async ({ page }) => {
  await page.goto(ROUTES.project(PROJECT));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("setup-repair-card")).toHaveCount(0);
  await setWikiSetup(page, PROJECT, { repair: { step: STEP, fixReady: false }, setupCheckOff: true });
  await page.goto(ROUTES.project(PROJECT));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("setup-repair-card")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`nightly upkeep says on the setup page that it is paused, in Code's sentence (${scheme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setWikiSetup(page, PROJECT, { mapMade: true, upkeepOn: true, consent: true, paused: "monthly_limit" });
    await new WikiSetupPanel(page).open(PROJECT);
    const upkeep = page.getByTestId("wiki-setup-upkeep");
    await expect(upkeep).toBeVisible();
    await expect(upkeep.getByTestId("wiki-setup-upkeep-paused")).toContainText("Nightly upkeep is paused: this month's upkeep limit is used up.");
    await page.screenshot({ path: testInfo.outputPath(`upkeep-paused-${scheme}.png`), fullPage: true });
  });
}
