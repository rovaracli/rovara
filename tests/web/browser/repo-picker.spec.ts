// Guided onboarding PR 10 in the browser, on the pretend Code: the repository picker (multi-select, search, "In project X" marks, paging), the question "Do these repos
// work together?", one project from several repos, and the bulk progress table for separate projects, with Code's reasons for the ones it refused.
import { expect, test } from "@playwright/test";
import { HomePage, RepoPickerPage, resetCreatedProjects } from "./pages/index.js";

test.beforeEach(async ({ page }) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
});
test.afterEach(async ({ page }) => { await resetCreatedProjects(page); });

test("the picker lists the company's repositories with 'In project X' marks, searches and pages", async ({ page }, testInfo) => {
  const picker = new RepoPickerPage(page);
  await picker.open();
  await expect(picker.repository("web")).toBeVisible();
  await expect(page.getByText("In project web", { exact: true })).toBeVisible();
  await expect(page.getByText("In project api", { exact: true })).toBeVisible();
  await expect(picker.list).not.toContainText("other-co");
  await expect(picker.picked).toHaveText("No repositories picked yet.");
  await page.screenshot({ path: testInfo.outputPath("picker.png"), fullPage: true });
  await picker.search.fill("pay");
  await expect(picker.repository("payments")).toBeVisible();
  await expect(picker.repository("api")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("picker-search.png"), fullPage: true });
  await picker.search.fill("zzz");
  await expect(page.getByText("No repositories match that search.")).toBeVisible();
});

test("several repos ask the question, one project is preselected, and it creates one project that opens its checklist", async ({ page }, testInfo) => {
  const picker = new RepoPickerPage(page);
  await picker.open();
  await picker.pick("billing");
  await expect(picker.question).toHaveCount(0);
  await picker.pick("mobile");
  await expect(picker.question).toBeVisible();
  await expect(picker.question.getByRole("radio", { name: /Yes, one project/ })).toBeChecked();
  await expect(picker.whySeparate).toHaveCount(0);
  await picker.name.fill("shop");
  await page.screenshot({ path: testInfo.outputPath("question-one-project.png"), fullPage: true });
  await picker.button("Create project with 2 repos").click();
  await page.waitForURL((url) => url.pathname === "/app/projects/shop");
  await expect(page.getByRole("heading", { name: "shop", level: 1 })).toBeVisible();
});

test("above 8 repos 'separate' is preselected with the reason; the table shows what was created and why one was not", async ({ page }, testInfo) => {
  const picker = new RepoPickerPage(page);
  await picker.open();
  await picker.pick("api", "auth", "billing", "design", "docs", "infra", "mobile", "notifier");
  await expect(picker.question.getByRole("radio", { name: /Yes, one project/ })).toBeChecked();
  await picker.pick("payments");
  await expect(picker.question.getByRole("radio", { name: /No, separate projects/ })).toBeChecked();
  await expect(picker.whySeparate).toContainText("You picked more than 8 repos, so separate projects is preselected.");
  await expect(picker.name).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("question-separate-preselected.png"), fullPage: true });
  await picker.button("Create 9 projects").click();
  await expect(picker.table).toBeVisible();
  await expect(picker.table.getByRole("heading")).toHaveText("8 of 9 projects created");
  const rows = picker.table.getByRole("row");
  await expect(rows).toHaveCount(10);
  // `api` already exists as a project, so Code refuses that one in its fixed words; the rest wait for setup.
  await expect(rows.filter({ hasText: "example/api" })).toContainText("A project with this name already exists.");
  await expect(rows.filter({ hasText: "example/auth" })).toContainText("Waiting for setup");
  await expect(rows.filter({ hasText: "example/auth" }).getByRole("link", { name: "Open auth" })).toHaveAttribute("href", "/app/projects/auth#setup-checklist");
  await page.screenshot({ path: testInfo.outputPath("bulk-table.png"), fullPage: true });
  // No setup run starts: the pretend Code saw no request for one.
  await picker.table.getByRole("link", { name: "Open auth" }).click();
  await page.waitForURL((url) => url.pathname === "/app/projects/auth");
});
