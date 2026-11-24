// SETUP-WIKI-CLOUD-FIXES in the browser, on the pretend Code: Priya (a company owner) allows a website a setup run asked for from the checklist's Setup run row (one send, bound to the ask), the empty Wiki
// tab builds from its own "Build the wiki" button, and the project's header stops saying "Setup needs attention" once the setup is approved and checked.
import { expect, test, type Page } from "@playwright/test";
import { FAKE_CODE_URL, PROJECT, ROUTES, SetupTabPage, setSetupRun, setSetupScenario, setWiki, setWikiSetup } from "./pages/index.js";

async function setAsks(page: Page, asks: Array<{ host: string; status?: string }>) {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/setup-host-asks`, { data: { project: PROJECT, asks } });
  expect(answer.status()).toBe(200);
}
test.afterEach(async ({ page }) => { await setAsks(page, []); await setSetupScenario(page, PROJECT, { reset: true }); await setSetupRun(page, PROJECT, "none"); await setWiki(page, PROJECT, { state: "ready" }); await setWikiSetup(page, PROJECT, {}); });

test("an owner allows an address the run asked for from the Setup tab: one send, then the ask says it was allowed; Refuse is not red", async ({ page }) => {
  await setSetupRun(page, PROJECT, "failed");
  await setSetupScenario(page, PROJECT, { run: { stop: "hosts_waiting", failure: "x" }, row: { stop: "hosts_waiting", failedCommand: null }, entries: [{ n: 1, source: "agent", command: "npm ci", exitCode: 1, durationMs: 4000, timedOut: false, flagged: false, blockedHosts: ["registry.example-build.io"], tail: "", startedAt: new Date().toISOString() }] });
  await setAsks(page, [{ host: "registry.example-build.io" }, { host: "cdn.example-files.net", status: "refused" }]);
  const tab = new SetupTabPage(page);
  await tab.open(PROJECT);
  // The card is first, the addresses are right under it and never in a fold, and the card's one primary says how many.
  await expect(tab.card).toContainText("Setup is waiting for you: 1 address to allow or refuse");
  await expect(tab.card.getByRole("button", { name: "Review 1 address" })).toBeVisible();
  await expect(tab.addresses).toBeVisible();
  const ask = tab.hostAsk("registry.example-build.io");
  await expect(ask.getByTestId("host-ask-by")).toHaveText("Asked while running: npm ci");
  await expect(ask.getByTestId("host-allow")).toBeVisible();
  await expect(ask.getByTestId("host-refuse")).not.toHaveClass(/danger/u);
  await expect(tab.hostAsk("cdn.example-files.net")).toHaveCount(1);
  await expect(tab.hostAsk("cdn.example-files.net").getByTestId("host-allow")).toHaveCount(0);
  const sends: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/setup-agent/host-decide")) sends.push(request.postData() ?? ""); });
  await ask.getByTestId("host-allow").click();
  await expect(ask.getByTestId("host-ask-state")).toHaveText("Allowed by you just now.");
  expect(sends).toHaveLength(1);
  expect(JSON.parse(sends[0]!)).toMatchObject({ host: "registry.example-build.io", outcome: "approve", seen: { revision: 1 } });
  await expect(tab.card).toContainText("All 2 addresses are decided. Run setup again to carry on.");
});

test("the address Code's address-ask card opens lands on the project's Setup tab", async ({ page }) => {
  await page.goto(`/app/projects/${PROJECT}/setup`);
  await expect(page).toHaveURL(new RegExp(`/app/projects/${PROJECT}\\?tab=setup$`, "u"));
  await expect(page.getByTestId("setup-status-card")).toBeVisible();
});

test("the empty Wiki tab builds from its own Build the wiki button", async ({ page }) => {
  await setWiki(page, PROJECT, { state: "none" });
  await setWikiSetup(page, PROJECT, { mapMade: true });
  await page.goto(`${ROUTES.project(PROJECT)}?tab=wiki`);
  const here = page.getByTestId("wiki-build-here");
  const build = here.getByRole("button", { name: "Build the wiki" });
  await expect(build).toBeEnabled();
  const sent = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith(`/v1/web/projects/${PROJECT}/wiki-build`));
  await build.click();
  await sent;
});

test("with no AI key the Wiki tab's Build is disabled with its reason", async ({ page }) => {
  await setWiki(page, PROJECT, { state: "none" });
  await setWikiSetup(page, PROJECT, { aiKey: "missing", mapMade: true });
  await page.goto(`${ROUTES.project(PROJECT)}?tab=wiki`);
  const here = page.getByTestId("wiki-build-here");
  await expect(here.getByRole("button", { name: "Build the wiki" })).toBeDisabled();
  await expect(here.getByTestId("wiki-setup-connect-key")).toBeVisible();
});
