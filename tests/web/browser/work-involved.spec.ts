import { expect, test, type Page } from "@playwright/test";
import { HomePage, WorkPage } from "./pages/index.js";
import { FAKE_CODE_URL } from "./pages/lessons.js";

// The tasks the person was ADDED to (web task channel K4), on the pretend Code: their own "Involved" group on Work, and a short list on Home. The pretend Code keeps its state in memory,
// so every spec puts it back as it was.
const INVOLVED_TASK = "Migrate the invoices table";
const OWN_TASK = "Speed up the search index";

async function control(page: Page, data: Record<string, unknown>): Promise<{ taskId?: string }> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/involved`, { data });
  expect(answer.status()).toBe(200);
  return await answer.json() as { taskId?: string };
}
test.afterEach(async ({ page }) => { await control(page, { reset: true }); });

test("Work lists the tasks I was added to under Involved, apart from my own, and opens one beside the list", async ({ page }, testInfo) => {
  const added = await control(page, { involve: true, as: "priya", title: INVOLVED_TASK });
  const work = new WorkPage(page);
  await work.open();
  await work.expectLoaded();
  // My own work is where it was; the involved task is in a group of its own at the end.
  await expect(work.group("Rovara is working").getByRole("button", { name: new RegExp(OWN_TASK, "u") })).toBeVisible();
  const involved = work.group("Involved");
  await expect(involved).toBeVisible();
  await expect(involved.getByRole("button")).toHaveCount(1);
  await expect(involved.getByRole("button", { name: new RegExp(INVOLVED_TASK, "u") })).toBeVisible();
  await expect(work.group("Needs you").getByRole("button", { name: new RegExp(INVOLVED_TASK, "u") })).toHaveCount(0);
  await involved.getByRole("button", { name: new RegExp(INVOLVED_TASK, "u") }).click();
  await expect(work.paneTitle).toHaveText(INVOLVED_TASK);
  await expect(page).toHaveURL(new RegExp(`[?&]task=${added.taskId}`, "u"));
  await expect(work.pane.getByTestId("decision-quiet")).toContainText("You're involved in this task");
  await expect(work.loadError).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("work-involved.png"), fullPage: true });
});

test("Work shows nothing extra and no error when Code does not serve the involved list yet", async ({ page }) => {
  await control(page, { involve: true, as: "priya", title: INVOLVED_TASK });
  for (const mode of ["404", "501", "400", "old"]) {
    await control(page, { mode });
    const work = new WorkPage(page);
    await work.open();
    await work.expectLoaded();
    await expect(work.group("Involved")).toHaveCount(0);
    await expect(page.getByTestId("involved-unavailable")).toHaveCount(0);
    await expect(work.rowByTitle(INVOLVED_TASK)).toHaveCount(0);
  }
});

test("Home lists the tasks I was added to and each opens in Work", async ({ page }, testInfo) => {
  const added = await control(page, { involve: true, as: "priya", title: INVOLVED_TASK });
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
  const section = page.getByTestId("home-involved");
  await expect(section).toBeVisible();
  await expect(section.getByRole("link", { name: new RegExp(INVOLVED_TASK, "u") })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("home-involved.png"), fullPage: true });
  await section.getByRole("link", { name: new RegExp(INVOLVED_TASK, "u") }).click();
  await expect(page).toHaveURL(new RegExp(`/app/live\\?task=${added.taskId}`, "u"));
  await expect(new WorkPage(page).paneTitle).toHaveText(INVOLVED_TASK);
});
