// Guided onboarding PR 13 in the browser, on the pretend Code: the first visit after joining (`/app?joined=1`) shows a short welcome with the person's projects,
// each project's Slack channel, Start a task and See what's running; "Got it" dismisses it. Screenshots go to the test output folder.
import { expect, test } from "@playwright/test";
import { ROUTES } from "./pages/index.js";

test("a teammate's first visit after joining shows the welcome; Got it dismisses it", async ({ page }, testInfo) => {
  await page.goto(`${ROUTES.home}?joined=1`);
  const welcome = page.getByTestId("teammate-welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("Welcome to");
  await expect(welcome.getByRole("link", { name: "Start a task" }).first()).toBeVisible();
  await expect(welcome.getByRole("link", { name: "See what's running" }).first()).toHaveAttribute("href", "/app/live");
  await page.screenshot({ path: testInfo.outputPath("teammate-welcome.png"), fullPage: true });
  await welcome.getByTestId("welcome-dismiss").click();
  await expect(welcome).toHaveCount(0);
});
