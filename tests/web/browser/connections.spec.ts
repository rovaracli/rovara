// Guided onboarding PR 12b in the browser, on the pretend Code: Company settings, Connections. Priya (company owner) sees GitHub, Slack and Linear with their
// health; pressing Disconnect confirms first, and Cloud's own fresh-step-up check asks her to confirm it's her before Code is asked. Screenshots go to the
// test output folder.
import { expect, test } from "@playwright/test";
import { ROUTES } from "./pages/index.js";

test("the Connections page lists each integration; Disconnect asks for a fresh sign-in first", async ({ page }, testInfo) => {
  await page.goto(`${ROUTES.admin.home}/connections`);
  const section = page.getByTestId("company-connections");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("connections-github")).toBeVisible();
  await expect(section.getByTestId("connections-slack")).toBeVisible();
  await expect(section.getByTestId("connections-linear")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("connections.png"), fullPage: true });
  const slack = section.getByTestId("connections-slack");
  if (await slack.getByTestId("slack-disconnect").isVisible()) {
    await slack.getByTestId("slack-disconnect").click();
    await expect(slack.getByTestId("slack-confirm")).toBeVisible();
    await slack.getByTestId("slack-disconnect-confirm").click();
    await expect(slack.getByTestId("fresh-sign-in")).toHaveAttribute("data-state", "needed");
    await page.screenshot({ path: testInfo.outputPath("connections-disconnect-step-up.png"), fullPage: true });
  }
});
