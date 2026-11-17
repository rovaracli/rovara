// Guided onboarding PR 17 (DEC 254n item 3) in the browser, on the pretend Code (which applies Code #839's rule): Priya, the company owner, reviews
// what archiving does, archives a project, then restores it, through Cloud's real routes. A stale review and Code not serving the routes yet say
// Cloud's fixed sentences. Screenshots go to the test output folder.
import { expect, test } from "@playwright/test";
import { ProjectLifecyclePage } from "./pages/index.js";

const PROJECT = "api";
const STALE = "The project changed. Review it again before you archive or restore it.";

test("the owner reviews what archiving does, archives the project, then restores it", async ({ page }, testInfo) => {
  const screen = new ProjectLifecyclePage(page);
  await screen.open(PROJECT);
  await screen.reviewArchive.click();
  await expect(screen.dialog).toContainText("New work stops: nobody can start a task in this project.");
  await expect(screen.dialog).toContainText("A task that is running now stops at its next step.");
  await expect(screen.dialog).toContainText("Its 1 linked Slack channel stays linked, but starts nothing.");
  await expect(screen.dialog).toContainText("Nothing is deleted. You can restore the project later.");
  await expect(screen.archive).toBeDisabled();
  await screen.acknowledge.check();
  await page.screenshot({ path: testInfo.outputPath("archive-review.png") });
  await screen.archive.click();
  await expect(screen.dialog.getByText("Current project status: Archived.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("archived.png") });
  await screen.close.click();
  await expect(screen.reviewRestore).toBeVisible();
  await expect(page.getByText(/Status: Archived/)).toBeVisible();
  await screen.reviewRestore.click();
  await expect(screen.dialog).toContainText("New work can start in this project again, from Rovara and from its 1 linked Slack channel.");
  await screen.acknowledge.check();
  await page.screenshot({ path: testInfo.outputPath("restore-review.png") });
  await screen.restore.click();
  await expect(screen.dialog.getByText("Current project status: Active.")).toBeVisible();
  await screen.close.click();
  await expect(screen.reviewArchive).toBeVisible();
});

test("a stale review says Cloud's fixed sentence and asks for a fresh review", async ({ page }, testInfo) => {
  // Someone else changed the project between the review and the write: Code answers 409 CHANGE_STALE, which Cloud words as STALE.
  await page.route("**/v1/web/projects/api/reviewed-archive", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "CHANGE_STALE", message: STALE } }) }));
  const screen = new ProjectLifecyclePage(page);
  await screen.open(PROJECT);
  await screen.reviewArchive.click();
  await screen.acknowledge.check();
  await screen.archive.click();
  await expect(screen.dialog.getByText(STALE)).toBeVisible();
  await expect(screen.reviewLatest).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("archive-stale.png") });
});

test("while Code doesn't serve archiving yet, the page says so and offers no control", async ({ page }, testInfo) => {
  await page.route("**/v1/web/projects/api/lifecycle", (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_ON_CODE_YET", message: "Archiving isn't available yet." } }) }));
  const screen = new ProjectLifecyclePage(page);
  await screen.open(PROJECT);
  await expect(page.getByText("Archiving isn't available yet.")).toBeVisible();
  await expect(screen.reviewArchive).toHaveCount(0);
  await expect(screen.reviewRestore).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("archive-not-yet.png"), fullPage: true });
});
