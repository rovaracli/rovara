import { expect, test, type Page } from "@playwright/test";
import { AdminPage } from "./pages/index.js";

// Lead 4 L4-E: the Spending limits page in a real browser, with the two new tables (nightly upkeep per project, the company's answers limit). Cloud serves no
// spend-limits route against the pretend Code, so the read is given a served route here with `page.route`, as the other admin specs do.
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa";
const LIMITS = {
  companyId: COMPANY, canChange: true, settingsVersion: 3,
  defaults: { companyMonthlyUsd: 500, memberMonthlyUsd: 50, projectMonthlyUsd: 100, taskUsd: 2, upkeepMonthlyUsd: 25, answersMonthlyUsd: 20 },
  projects: [], people: [],
  upkeep: [{ id: "evals-api", monthlyUsd: 10, version: 1, updatedAt: "2026-11-17T12:00:00.000Z", updatedBy: "a".repeat(64) }],
  answers: [], partial: false, max: { projects: 200, people: 200, upkeep: 200, answers: 1 },
};
async function serve(page: Page): Promise<void> {
  await page.route("**/v1/web/org/spend-limits", route => (route.request().method() === "GET" ? route.fulfill(json(LIMITS)) : route.fallback()));
  await page.route("**/v1/web/org/members", route => route.fulfill(json({ members: [] })));
}

test("Spending limits shows nightly upkeep and the answers limit with their defaults and words", async ({ page }, testInfo) => {
  await serve(page);
  const admin = new AdminPage(page);
  await admin.open("/app/admin/money/limits");
  await expect(admin.heading("Spending limits")).toBeVisible();
  await expect(page.getByTestId("spend-upkeep-default")).toHaveText("Nightly upkeep, each project, each month: $25.00");
  await expect(page.getByTestId("spend-answers-default")).toHaveText("Answers, the company, each month: $20.00");
  await expect(page.getByTestId("spend-upkeep-about")).toContainText("This can only lower what the project's and the company's limits already allow.");
  await expect(page.getByTestId("spend-answers-about")).toContainText("on the company's own AI key");
  await expect(page.getByTestId("spend-upkeep-table").getByRole("row", { name: /evals-api/u })).toContainText("$10");
  // The answers limit has no id to type: just the amount.
  const form = page.getByRole("form", { name: "Set the answers limit" });
  await expect(form.getByLabel(/Monthly limit for this company/u)).toBeVisible();
  await expect(form.getByLabel("Company", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("spend-limits-upkeep-answers.png"), fullPage: true });
  // The admin area is a desktop page: a narrow window shows its own "use a wider window" notice (admin-narrow), so there is no phone layout to check here.
});
