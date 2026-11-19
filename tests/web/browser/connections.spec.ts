// Guided onboarding PR 12b in the browser, on the pretend Code: Company settings, Connections. Priya (company owner) sees GitHub, Slack and Linear with their
// health; pressing Disconnect confirms first, then goes to Code with no step-up (owner DEC 254zzz73). Screenshots go to the
// test output folder.
import { expect, test } from "@playwright/test";
import { ROUTES } from "./pages/index.js";

test("the Connections page lists each integration; Disconnect confirms once and shows no sign-in step", async ({ page }, testInfo) => {
  await page.goto(`${ROUTES.admin.home}/connections`);
  const section = page.getByTestId("company-connections");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("connections-github")).toBeVisible();
  await expect(section.getByTestId("connections-slack")).toBeVisible();
  await expect(section.getByTestId("connections-linear")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("connections.png"), fullPage: true });
  const slack = section.getByTestId("connections-slack");
  if (await slack.getByTestId("slack-disconnect").isVisible()) {
    // Answered here, never by the pretend Code: a real disconnect would leave Slack gone for later specs.
    await page.route("**/v1/web/slack/disconnect", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "disconnected", workspaceName: "Acme", projectsLosingChannel: [] }) }));
    await slack.getByTestId("slack-disconnect").click();
    await expect(slack.getByTestId("slack-confirm")).toBeVisible();
    await slack.getByTestId("slack-disconnect-confirm").click();
    await expect(slack.getByTestId("fresh-sign-in")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("connections-disconnect.png"), fullPage: true });
  }
});
