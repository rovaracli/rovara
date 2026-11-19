// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1) in the browser, on the pretend Code: Priya, the company owner, sees the company's
// "AI and spending" following Rovara's model default and with the default monthly limit prefilled; Save saves explicit choices at once
// (no step-up since owner DEC 254zzz73).
// A project's "AI and spend limit" keeps "Same as company" picked; the project's admin sets its own per-task limit through Cloud's route to Code.
// Screenshots go to the test output folder.
import { expect, test, type Page } from "@playwright/test";
import { AiSpendPage, PROJECT, ROUTES } from "./pages/index.js";

test("the company step follows Rovara's default and prefills the default limit, with Save there at once", async ({ page }, testInfo) => {
  const screen = new AiSpendPage(page);
  await screen.open(ROUTES.admin.aiSpending);
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await expect(screen.step.getByRole("region", { name: "Company model setting", exact: true }).locator("p").filter({ hasText: /^Rovara's default \(currently zai\.glm-4\.6\)$/u })).toBeVisible();
  await expect(screen.model.locator("option")).toHaveText(["Choose", "Rovara's default (currently zai.glm-4.6)", "zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"]);
  await expect(screen.rovara).toBeChecked();
  await expect(screen.limit).toHaveValue("500");
  await expect(screen.freshSignIn).toHaveCount(0);
  await expect(screen.save).toBeVisible();
  await screen.own.check();
  await expect(page.getByTestId("ai-spend-own-choices")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ai-spending-step.png"), fullPage: true });
});

// Keep writes local to each browser context; reads after pin/clear reflect the saved model.
async function mockCompanyWrites(page: Page) {
  const writes: { path: string; body: unknown }[] = [];
  let model: string | null = null;
  page.on("request", (request) => {
    if (request.method() === "PUT") writes.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() as unknown });
  });
  await page.route("**/v1/web/org/settings", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", version: 2, settings: {} }) }) : route.fallback()));
  await page.route("**/v1/web/org/agent-ai", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: "rovara", version: 1 }) }) : route.fallback()));
  await page.route("**/v1/web/org/engine-model", (route) => {
    if (route.request().method() === "PUT") model = (route.request().postDataJSON() as { model: string | null }).model;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: model ?? "zai.glm-4.6", source: model === null ? "install" : "company", offered: ["zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"], preselect: "zai.glm-4.6", canChange: true }) });
  });
  return writes;
}

test("Save with the model untouched writes only spending, with no step-up", async ({ page }, testInfo) => {
  const writes = await mockCompanyWrites(page);
  const screen = new AiSpendPage(page);
  await screen.open(ROUTES.admin.aiSpending);
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await screen.save.click();
  await expect(screen.saved).toHaveText("Saved.");
  await expect(screen.save).toBeEnabled();
  expect(writes.map(write => write.path)).toEqual(["/v1/web/org/settings"]);
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await expect(screen.freshSignIn).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-spending-saved.png"), fullPage: true });
});

test("an explicit model choice saves after spending and can go back to Rovara's default", async ({ page }, testInfo) => {
  const writes = await mockCompanyWrites(page);
  const screen = new AiSpendPage(page);
  await screen.open(ROUTES.admin.aiSpending);
  await screen.model.selectOption("claude-sonnet-4-5");
  expect(writes).toEqual([]);
  await screen.save.click();
  await expect(screen.saved).toHaveText("Saved.");
  await expect(screen.save).toBeEnabled();
  expect(writes.map(write => write.path)).toEqual(["/v1/web/org/settings", "/v1/web/org/engine-model"]);
  expect(writes[1]?.body).toEqual({ model: "claude-sonnet-4-5" });
  await expect(screen.step.getByText("Your choice: claude-sonnet-4-5", { exact: true })).toBeVisible();
  const companyModel = screen.step.getByRole("region", { name: "Company model setting", exact: true });
  const clear = companyModel.getByRole("button", { name: "Go back to Rovara's default", exact: true });
  await expect(clear).toBeVisible();
  await expect(screen.freshSignIn).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-spending-model-choice.png"), fullPage: true });
  await clear.click();
  await expect(screen.model.locator("option:checked")).toHaveText("Rovara's default (currently zai.glm-4.6)");
  await expect(screen.save).toBeEnabled();
  expect(writes).toHaveLength(3);
  expect(writes[2]).toEqual({ path: "/v1/web/org/engine-model", body: { model: null } });
  await expect(screen.step.getByText("Your choice: claude-sonnet-4-5", { exact: true })).toHaveCount(0);
  await expect(clear).toHaveCount(0);
  await expect(companyModel.locator("p").filter({ hasText: /^Rovara's default \(currently zai\.glm-4\.6\)$/u })).toBeVisible();
  await expect(screen.freshSignIn).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-spending-model-default.png"), fullPage: true });
});

test("a project's spend limit: Same as company first, then the project's own per-task limit", async ({ page }, testInfo) => {
  const screen = new AiSpendPage(page);
  await screen.open(`${ROUTES.admin.projects}/${PROJECT}`);
  await expect(screen.projectLimits).toBeVisible();
  await expect(screen.projectSame).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("project-spend-same.png") });
  await screen.projectOwn.check();
  await screen.perTask.fill("12.50");
  await screen.projectLimits.getByRole("button", { name: "Save" }).click();
  await expect(screen.projectSaved).toBeVisible();
  await expect(screen.projectOwn).toBeChecked();
  await expect(screen.perTask).toHaveValue("12.5");
  await screen.projectLimits.screenshot({ path: testInfo.outputPath("project-spend-own.png") });
});
