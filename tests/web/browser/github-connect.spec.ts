// Guided onboarding PR 2 in the browser, on the pretend Code: Connect GitHub goes to GitHub with Cloud's cookie, GitHub's return lands on onboarding
// with the outcome (a request sent, a list to choose from, connected), and a return without Cloud's cookie or with another state does nothing.
import { expect, test } from "@playwright/test";
import { FAKE_GITHUB_CODES, GithubConnectPage, HomePage, ROUTES } from "./pages/index.js";

test.beforeEach(async ({ page }) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
});

test("a person without GitHub admin rights sends a request, with a link to copy for their admin", async ({ page }, testInfo) => {
  const github = new GithubConnectPage(page);
  await page.goto(`${ROUTES.firstDay}?step=github`);
  const state = await github.pressConnect();
  await github.returnFromGithub({ setup_action: "request", state });
  await page.waitForURL((url) => url.pathname === ROUTES.firstDay && url.searchParams.get("github") === "result");
  await expect(github.requested).toContainText("Request sent. We'll show it here when your GitHub admin approves.");
  await expect(github.adminLink).toHaveValue("https://github.com/apps/rovara-fake/installations/new");
  await page.screenshot({ path: testInfo.outputPath("github-requested.png"), fullPage: true });
});

test("Rovara already on GitHub: a list to choose from; another company's account can't be chosen; choosing connects", async ({ page }, testInfo) => {
  const github = new GithubConnectPage(page);
  await page.goto(`${ROUTES.firstDay}?step=github`);
  const state = await github.pressConnect();
  await github.returnFromGithub({ code: FAKE_GITHUB_CODES.choose, state });
  await expect(github.choose).toBeVisible();
  await expect(github.choices).toHaveCount(2);
  await expect(github.choices.nth(0)).toContainText("We found Rovara on example. Connect it?");
  await expect(github.choices.nth(1)).toContainText("We found Rovara on other-co. It's connected to a different Rovara company.");
  await expect(github.choices.nth(1).getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("github-choose.png"), fullPage: true });
  await github.choices.nth(0).getByRole("button", { name: "Connect it" }).click();
  await expect(github.connected).toHaveText("Connected to example");
});

test("installed on GitHub and back: 'Connected to example', and the step shows Done from the company's connections", async ({ page }, testInfo) => {
  const github = new GithubConnectPage(page);
  await page.goto(`${ROUTES.firstDay}?step=github`);
  const state = await github.pressConnect();
  await github.returnFromGithub({ installation_id: "5001", setup_action: "install", code: FAKE_GITHUB_CODES.connected, state });
  await expect(github.connected).toHaveText("Connected to example");
  await expect(page.getByTestId("onboard-step-github")).toContainText("Done");
  // The landing address carries one fixed word, never a value GitHub sent.
  expect(new URL(page.url()).search).toBe("?github=result");
  await page.screenshot({ path: testInfo.outputPath("github-connected.png"), fullPage: true });
});

test("a return with no Cloud cookie, another state, or a replay does nothing but say 'Start again from Rovara.'", async ({ page, context }, testInfo) => {
  const github = new GithubConnectPage(page);
  await page.goto(`${ROUTES.firstDay}?step=github`);
  const state = await github.pressConnect();
  const other = "Q".repeat(43);
  await github.returnFromGithub({ installation_id: "5001", code: FAKE_GITHUB_CODES.connected, state: other });
  await expect(github.refused).toHaveText("Start again from Rovara.");
  await expect(github.tryAgain).toBeVisible();
  // The binding was spent by that try, and the cookie cleared: the right state now does nothing either.
  expect((await context.cookies()).some((cookie) => cookie.name === "rovara_cloud_github")).toBe(false);
  await github.returnFromGithub({ installation_id: "5001", code: FAKE_GITHUB_CODES.connected, state });
  await expect(github.refused).toHaveText("Start again from Rovara.");
  expect(page.url()).not.toContain(state);
  await page.screenshot({ path: testInfo.outputPath("github-start-again.png"), fullPage: true });
});
