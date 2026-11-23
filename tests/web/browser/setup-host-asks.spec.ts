// SETUP-WIKI-CLOUD-FIXES in the browser, on the pretend Code: Priya (a company owner) allows a website a setup run asked for from the checklist's Setup run row (one send, bound to the ask), the empty Wiki
// tab builds from its own "Build the wiki" button, and the project's header stops saying "Setup needs attention" once the setup is approved and checked.
import { expect, test, type Page } from "@playwright/test";
import { FAKE_CODE_URL, PROJECT, ROUTES, setSetupRun, setWiki, setWikiSetup } from "./pages/index.js";

async function setAsks(page: Page, asks: Array<{ host: string; status?: string }>) {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/setup-host-asks`, { data: { project: PROJECT, asks } });
  expect(answer.status()).toBe(200);
}
test.afterEach(async ({ page }) => { await setAsks(page, []); await setSetupRun(page, PROJECT, "none"); await setWiki(page, PROJECT, { state: "ready" }); await setWikiSetup(page, PROJECT, {}); });

test("an owner allows a website the run asked for: one send, then the ask says it was allowed", async ({ page }) => {
  await setSetupRun(page, PROJECT, "failed");
  await setAsks(page, [{ host: "registry.example-build.io" }, { host: "cdn.example-files.net", status: "refused" }]);
  await page.goto(ROUTES.project(PROJECT));
  await page.getByTestId("setup-run-row").locator("summary", { hasText: "What Rovara ran" }).click();
  // The row's summary says "What Rovara ran": the journal under it does not say it again.
  await expect(page.getByTestId("setup-run-row").getByText("What Rovara ran", { exact: true })).toHaveCount(1);
  const ask = page.locator('[data-testid="host-ask"][data-host="registry.example-build.io"]');
  await expect(ask.getByTestId("host-allow")).toBeVisible();
  await expect(page.locator('[data-testid="host-ask"][data-host="cdn.example-files.net"]').getByTestId("host-allow")).toHaveCount(0);
  const sends: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/setup-agent/host-decide")) sends.push(request.postData() ?? ""); });
  await ask.getByTestId("host-allow").click();
  await expect(ask.getByTestId("host-ask-state")).toContainText("Allowed. Press Run again");
  expect(sends).toHaveLength(1);
  expect(JSON.parse(sends[0]!)).toMatchObject({ host: "registry.example-build.io", outcome: "approve", seen: { revision: 1 } });
});

test("the address Code's website-ask card opens lands on the checklist", async ({ page }) => {
  await page.goto(`/app/projects/${PROJECT}/setup`);
  await expect(page).toHaveURL(new RegExp(`/app/projects/${PROJECT}#setup-checklist$`, "u"));
  await expect(page.getByTestId("project-checklist")).toBeVisible();
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
