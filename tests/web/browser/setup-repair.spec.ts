// L4-U5 in the browser, on the pretend Code (which serves Code's hosted `setup-check`, with the "Setup needs repair" card while a project's setup is broken, and the nightly upkeep read with the pause): the card on
// the project's page in light and dark (screenshots in the test output), its one action and "Re-check setup", what a reader sees (the same words, no action), the card going away when the setup works, and the paused
// upkeep notice on the setup page. No accessibility violations in either theme.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, ROUTES, WikiSetupPanel, setFakePerson, setSetupRun, setWikiSetup } from "./pages/index.js";

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
  test(`the owner reads the repair card, its one action and Re-check setup (${scheme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setWikiSetup(page, PROJECT, { repair: { step: STEP, fixReady: false, changed: "dependency files" } });
    await page.goto(ROUTES.project(PROJECT));
    const card = page.getByTestId("setup-repair-card");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Setup needs repair" })).toBeVisible();
    await expect(card.getByTestId("setup-repair-body")).toHaveText(`The project's setup stopped working after recent code changes (${STEP}). Rovara cannot build on this project until it is fixed.`);
    await expect(card.getByRole("button", { name: "Fix setup (uses your AI, up to $4)" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Re-check setup" })).toBeVisible();
    await expect(card.getByTestId("setup-repair-changed")).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`setup-repair-${scheme}.png`), fullPage: true });
    expect(await violations(page)).toEqual([]);
    await card.getByRole("button", { name: "Re-check setup" }).click();
    await expect(card.getByTestId("setup-recheck-started")).toContainText("Checking setup again.");
    // A second press while Code's check runs is refused in a fixed sentence.
    await card.getByRole("button", { name: "Re-check setup" }).click();
    await expect(card.getByTestId("setup-recheck-error")).toBeVisible();
    await expect(card.getByTestId("setup-recheck-error")).not.toContainText("ws-recheck");
  });
}

test("a checked fix waiting turns the action into Approve new setup, a link to the setup page", async ({ page }, testInfo) => {
  await setWikiSetup(page, PROJECT, { repair: { step: STEP, fixReady: true } });
  await page.goto(ROUTES.project(PROJECT));
  const card = page.getByTestId("setup-repair-card");
  await expect(card.getByRole("link", { name: "Approve new setup" })).toHaveAttribute("href", new RegExp(`/app/onboard\\?project=${PROJECT}&step=setup`, "u"));
  await expect(card.getByRole("button", { name: /Fix setup/u })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("setup-repair-approve.png"), fullPage: true });
});

test("a developer reads the same card and the line that the admins were asked, with nothing to press", async ({ page }) => {
  await setWikiSetup(page, PROJECT, { repair: { step: STEP, fixReady: false } });
  await setFakePerson(page, "sam");
  await page.goto(ROUTES.project(PROJECT));
  const card = page.getByTestId("setup-repair-card");
  await expect(card.getByTestId("setup-repair-body")).toContainText("Rovara cannot build on this project until it is fixed.");
  await expect(card.getByTestId("setup-repair-reader")).toHaveText("The project's admins have been asked to fix it.");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("there is no card while the setup works, and none for a Code with no such read", async ({ page }) => {
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
