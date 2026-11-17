// Guided onboarding PR 9 in the browser, on the pretend Code (Code #841's checklist and #844's hosted setup run): Priya, the company owner, sees the project's
// checklist on its page (a failed setup run with its failing command and last lines), runs setup again and stops it, sets Invite teammates aside, opens
// Project settings (Re-run setup, Archive, Slack and Linear, spend), and sees "Finish setting up" on Home. Screenshots go to the test output folder.
import { expect, test } from "@playwright/test";
import { HomePage, PROJECT, ROUTES, SetupChecklistPage, setSetupRun } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setSetupRun(page, PROJECT, "none"); });

test("the owner works through the project checklist: a failed run, Run again, Stop, Set up later", async ({ page }, testInfo) => {
  await setSetupRun(page, PROJECT, "failed");
  const screen = new SetupChecklistPage(page);
  await screen.open(PROJECT);
  await expect(screen.row("setupRun")).toHaveAttribute("data-state", "failed");
  await expect(screen.runRow).toContainText("A test command failed.");
  await expect(screen.runRow).toContainText("npm test");
  await expect(screen.runRow.getByRole("link", { name: "Edit commands" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("checklist-failed-run.png"), fullPage: true });
  await screen.runAgain.click();
  await expect(screen.row("setupRun")).toHaveAttribute("data-state", "running");
  await expect(screen.stop).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("checklist-running.png"), fullPage: true });
  await screen.stop.click();
  await expect(screen.row("setupRun")).toHaveAttribute("data-state", "failed");
  await screen.skip("invites").click();
  await expect(screen.row("invites")).toHaveAttribute("data-state", "skipped");
  await expect(screen.row("invites")).toContainText("Skipped (optional)");
});

test("a finished run, Project settings with Re-run setup, and Home's Finish setting up card", async ({ page }, testInfo) => {
  await setSetupRun(page, PROJECT, "ready");
  const screen = new SetupChecklistPage(page);
  await screen.open(PROJECT);
  await expect(screen.row("setupRun")).toHaveAttribute("data-state", "done");
  await expect(screen.row("evalConfirm")).toContainText("npm test");
  await page.screenshot({ path: testInfo.outputPath("checklist-ready.png"), fullPage: true });
  await screen.openSettings(PROJECT);
  await expect(screen.rerun).toBeVisible();
  await expect(page.getByRole("button", { name: "Review archive" })).toBeVisible();
  await expect(page.getByTestId("project-integrations")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("project-settings.png"), fullPage: true });
  await screen.rerun.click();
  await expect(screen.settings.getByTestId("setup-run-stop")).toBeVisible();
  const home = new HomePage(page);
  await page.goto(ROUTES.home);
  await home.expectLoaded();
  await expect(screen.homeCard.first()).toContainText("Finish setting up");
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
