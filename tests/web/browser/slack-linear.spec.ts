// Guided onboarding PR 11 in the browser, on the pretend Code: Add to Slack in onboarding (optional, "Set up later"), Slack's return bound to Cloud's cookie, the
// "signed in from A but added to B" question, a project's Slack channel (picker, /invite then Check, change, remove) and its Linear team (Connect Linear, pick,
// remove) in Project settings. The pretend Code keeps its Slack and Linear state for the run, so these run in order.
import { expect, test } from "@playwright/test";
import { ConnectPage, FAKE_LINEAR_CODES, FAKE_SLACK_CODES, HomePage, ROUTES } from "./pages/index.js";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
});

test("Add to Slack is optional: 'Set up later', then Add to Slack, Slack, and back: 'Rovara is in Example Slack'", async ({ page, baseURL }, testInfo) => {
  const connect = new ConnectPage(page);
  await page.goto(ROUTES.firstDay);
  await expect(connect.slackStep).toHaveAttribute("data-state", "open");
  await expect(connect.slackStep).toContainText("Optional");
  await page.screenshot({ path: testInfo.outputPath("slack-step.png"), fullPage: true });
  await connect.slackSkip.click();
  await expect(connect.slackSkipped).toContainText("Skipped (optional)");
  await page.getByRole("button", { name: "Add it now" }).click();
  const { state, redirectUri } = await connect.pressAndStopAt(connect.slackAdd, "slack.com");
  expect(redirectUri).toBe(`${baseURL}/api/connect/slack/callback`);
  await connect.returnFrom("slack", { code: FAKE_SLACK_CODES.connected, state });
  await page.waitForURL((url) => url.pathname === ROUTES.firstDay && url.search === "?slack=result");
  await expect(connect.slackConnected).toHaveText("Rovara is in Example Slack.");
  await expect(connect.slackConnectedLine).toHaveText("Rovara is in Example Slack.");
  await page.screenshot({ path: testInfo.outputPath("slack-connected.png"), fullPage: true });
});

test("a Slack return without Cloud's cookie, with another state, or a replay does nothing but say 'Start again from Rovara.'", async ({ page, context }, testInfo) => {
  const connect = new ConnectPage(page);
  // Slack is connected by now, so the step shows done; a refused return's "Try again" starts a fresh Add to Slack.
  await page.goto(`${ROUTES.firstDay}?slack=start_again`);
  const { state } = await connect.pressAndStopAt(connect.slackAdd, "slack.com");
  await connect.returnFrom("slack", { code: FAKE_SLACK_CODES.connected, state: "Q".repeat(43) });
  await expect(connect.slackRefused).toHaveText("Start again from Rovara.");
  expect((await context.cookies()).some((cookie) => cookie.name === "rovara_cloud_slack")).toBe(false);
  await connect.returnFrom("slack", { code: FAKE_SLACK_CODES.connected, state });
  await expect(connect.slackRefused).toHaveText("Start again from Rovara.");
  expect(new URL(page.url()).search).toBe("?slack=start_again");
  await page.screenshot({ path: testInfo.outputPath("slack-start-again.png"), fullPage: true });
});

test("added to another workspace than the sign-in's: 'You signed in from … but added Rovara to …. Keep it?'", async ({ page }, testInfo) => {
  const connect = new ConnectPage(page);
  await page.goto(`${ROUTES.firstDay}?slack=start_again`);
  const { state } = await connect.pressAndStopAt(connect.slackAdd, "slack.com");
  await connect.returnFrom("slack", { code: FAKE_SLACK_CODES.other, state });
  await expect(connect.slackMismatch).toContainText("You signed in from Example Slack but added Rovara to Side Project Slack. Keep it?");
  await page.screenshot({ path: testInfo.outputPath("slack-keep-it.png"), fullPage: true });
  await connect.slackKeep.click();
  await expect(connect.slackConnected).toHaveText("Rovara is in Side Project Slack.");
});

test("Project settings: link a private channel after /invite and Check, change it, remove it", async ({ page }, testInfo) => {
  const connect = new ConnectPage(page);
  await page.goto(`${ROUTES.admin.projects}/web`);
  await expect(connect.channelRow).toBeVisible();
  await connect.channelSelect.selectOption("GPRIVATE1");
  await connect.channelLink.click();
  await expect(connect.inviteNeeded).toContainText("Type `/invite @Rovara` in the channel, then press Check.");
  await page.screenshot({ path: testInfo.outputPath("slack-invite-check.png"), fullPage: true });
  await connect.channelCheck.click();
  await expect(connect.channelLinked).toHaveText("Linked to #private-team.");
  await connect.channelChange.click();
  await connect.channelSelect.selectOption("CWEBDEV01");
  await connect.channelLink.click();
  await expect(connect.channelLinked).toHaveText("Linked to #web-dev.");
  await page.screenshot({ path: testInfo.outputPath("slack-channel-linked.png"), fullPage: true });
  await connect.channelRemove.click();
  await expect(connect.channelNote).toContainText("Channel removed.");
});

test("Project settings: Connect Linear, back to the same page, pick the project's team, remove it", async ({ page, baseURL }, testInfo) => {
  const connect = new ConnectPage(page);
  await page.goto(`${ROUTES.admin.projects}/web`);
  await expect(connect.linearRow).toContainText("Connect Linear once");
  const { state, redirectUri } = await connect.pressAndStopAt(connect.linearConnect, "linear.app");
  expect(redirectUri).toBe(`${baseURL}/api/connect/linear/callback`);
  // Cancel at Linear first: nothing happens, and a fresh press is needed.
  await connect.returnFrom("linear", { error: "access_denied", state });
  await page.waitForURL((url) => url.pathname === `${ROUTES.admin.projects}/web` && url.search === "?linear=cancelled");
  await expect(connect.linearRefused).toHaveText("Linear wasn't connected. You can connect it any time.");
  const again = await connect.pressAndStopAt(connect.linearConnect.first(), "linear.app");
  await connect.returnFrom("linear", { code: FAKE_LINEAR_CODES.connected, state: again.state });
  await page.waitForURL((url) => url.pathname === `${ROUTES.admin.projects}/web` && url.search === "?linear=result");
  await expect(connect.linearConnected).toHaveText("Connected to Linear workspace Example Linear.");
  await connect.teamSelect.selectOption("lin-team-web");
  await connect.teamSave.click();
  await expect(connect.team).toHaveText("Team: Web team (WEB)");
  await page.screenshot({ path: testInfo.outputPath("linear-team.png"), fullPage: true });
  await connect.teamRemove.click();
  await expect(page.getByTestId("linear-note")).toHaveText("Linear team removed.");
});
