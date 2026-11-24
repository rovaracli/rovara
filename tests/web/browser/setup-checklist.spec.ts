// Guided onboarding PR 9 in the browser, on the pretend Code (Code #841's checklist and #844's hosted setup run): Priya, the company owner, sees the project's
// checklist on its page (a failed setup run with its failing command and last lines), runs setup again and stops it, sets Invite teammates aside, opens
// Project settings (a line to the Setup tab, Archive, Slack and Linear, spend), and sees "Finish setting up" on Home. Screenshots go to the test output folder.
import { expect, test } from "@playwright/test";
import { HomePage, PROJECT, ROUTES, SetupChecklistPage, SetupTabPage, setEvalCard, setSetupRun } from "./pages/index.js";

// The setup run and the eval card both go back to the pretend Code's defaults, so no spec depends on the order they run in (batch 12 review L3).
test.afterEach(async ({ page }) => { await setSetupRun(page, PROJECT, "none");await setEvalCard(page, PROJECT, "default"); });

test("the owner works through the project: a failed run on the Setup tab, Run setup again, Stop; the checklist row is one line and Set up later sets Invite teammates aside", async ({ page }, testInfo) => {
  await setSetupRun(page, PROJECT, "failed");
  const checklist = new SetupChecklistPage(page);
  await checklist.open(PROJECT);
  await expect(checklist.row("setupRun")).toHaveAttribute("data-state", "failed");
  await expect(checklist.runRow.getByTestId("setup-run-line")).toHaveText("Setup failed.");
  await checklist.runRow.getByRole("link", { name: "Open Setup" }).click();
  const tab = new SetupTabPage(page);
  await expect(tab.card).toBeVisible();
  await expect(tab.card).toHaveAttribute("data-state", "failed");
  await expect(tab.card).toContainText("Setup failed at:");
  await expect(tab.card).toContainText("npm test");
  await expect(tab.card).toContainText("A test command failed.");
  await expect(page.getByTestId("project-checklist")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("setup-tab-failed-run.png"), fullPage: true });
  await tab.start.click();
  await expect(tab.card).toHaveAttribute("data-state", "running");
  await expect(tab.stop).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("setup-tab-running.png"), fullPage: true });
  await tab.stop.click();
  await expect(tab.card).toHaveAttribute("data-state", "stopped_person");
  await checklist.open(PROJECT);
  await checklist.skip("invites").click();
  await expect(checklist.row("invites")).toHaveAttribute("data-state", "skipped");
  await expect(checklist.row("invites")).toContainText("Skipped (optional)");
});

test("a finished run, the verified Setup tab that stays after the checklist is gone, Project settings' one line, and Home's Finish setting up card", async ({ page }, testInfo) => {
  await setSetupRun(page, PROJECT, "ready");
  const checklist = new SetupChecklistPage(page);
  await checklist.open(PROJECT);
  // L4-T2: a run that ended with a proposal nobody approved is not Done.
  await expect(checklist.row("setupRun")).toHaveAttribute("data-state", "needs_you");
  await setSetupRun(page, PROJECT, "ready", true);
  await checklist.open(PROJECT);
  await expect(checklist.row("setupRun")).toHaveAttribute("data-state", "done");
  // L4-EVC: a finished run brings the eval card; with no card, the row keeps the checks the run reported.
  await expect(checklist.row("evalConfirm")).toContainText("Approve the cost of running your evals");
  await setEvalCard(page, PROJECT, "none");
  await checklist.open(PROJECT);
  await expect(checklist.row("evalConfirm")).toContainText("npm test");
  await page.screenshot({ path: testInfo.outputPath("checklist-ready.png"), fullPage: true });
  const tab = new SetupTabPage(page);
  await tab.open(PROJECT);
  await expect(tab.card).toHaveAttribute("data-state", "verified");
  await expect(tab.card).toContainText("Setup is done.");
  await expect(tab.start).toHaveAttribute("class", /rv-button-secondary/u);
  await page.screenshot({ path: testInfo.outputPath("setup-tab-verified.png"), fullPage: true });
  await checklist.openSettings(PROJECT);
  await expect(checklist.settingsSetupLink).toHaveAttribute("href", `/app/projects/${PROJECT}?tab=setup`);
  await expect(page.getByRole("button", { name: "Review archive" })).toBeVisible();
  await expect(page.getByTestId("project-integrations")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("project-settings.png"), fullPage: true });
  const home = new HomePage(page);
  await page.goto(ROUTES.home);
  await home.expectLoaded();
  await expect(checklist.homeCard.first()).toContainText("Finish setting up");
  await page.screenshot({ path: testInfo.outputPath("home-finish-setup.png"), fullPage: true });
});

test("the company steps: GitHub, Add to Slack (optional), AI and spending, Pick repos", async ({ page }, testInfo) => {
  await page.goto(`${ROUTES.firstDay}?step=slack`);
  await expect(page.getByText("Step 2 of 4")).toBeVisible();
  await expect(page.getByTestId("slack-step")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("company-step-slack.png"), fullPage: true });
  await page.goto(`${ROUTES.firstDay}?step=ai`);
  await expect(page.getByText("Step 3 of 4")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("company-step-ai.png"), fullPage: true });
});
