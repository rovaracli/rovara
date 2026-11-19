// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1) in the browser, on the pretend Code: Priya, the company owner, sees the company's
// "AI and spending" with Code's preselected model from the company's own offered list and the default monthly limit prefilled; Save saves at once
// (no step-up since owner DEC 254zzz73).
// A project's "AI and spend limit" keeps "Same as company" picked; the project's admin sets its own per-task limit through Cloud's route to Code.
// Screenshots go to the test output folder.
import { expect, test } from "@playwright/test";
import { AiSpendPage, PROJECT, ROUTES } from "./pages/index.js";

test("the company step preselects Code's model and prefills the default limit, with Save there at once", async ({ page }, testInfo) => {
  const screen = new AiSpendPage(page);
  await screen.open(ROUTES.admin.aiSpending);
  await expect(screen.model).toHaveValue("zai.glm-4.6");
  await expect(screen.model.locator("option")).toHaveText(["Choose", "zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"]);
  await expect(screen.rovara).toBeChecked();
  await expect(screen.limit).toHaveValue("500");
  await expect(screen.freshSignIn).toHaveCount(0);
  await expect(screen.save).toBeVisible();
  await screen.own.check();
  await expect(page.getByTestId("ai-spend-own-choices")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("ai-spending-step.png"), fullPage: true });
});

test("Save sends the money write first, then the model, with no step-up", async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() === "PUT") writes.push(new URL(request.url()).pathname); });
  // The writes are answered here, never by the local Cloud or the pretend Code: a saved limit, source or model would stay and change what later specs read.
  await page.route("**/v1/web/org/settings", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", version: 2, settings: {} }) }) : route.fallback()));
  await page.route("**/v1/web/org/agent-ai", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: "rovara", version: 1 }) }) : route.fallback()));
  await page.route("**/v1/web/org/engine-model", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: "zai.glm-4.6", source: "company", offered: ["zai.glm-4.7", "claude-sonnet-4-5", "zai.glm-4.6"] }) }) : route.fallback()));
  const screen = new AiSpendPage(page);
  await screen.open(ROUTES.admin.aiSpending);
  await expect(screen.model).toHaveValue("zai.glm-4.6");
  await screen.save.click();
  await expect.poll(() => writes.includes("/v1/web/org/engine-model")).toBe(true);
  expect(writes[0]).toBe("/v1/web/org/settings");
  await expect(screen.freshSignIn).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("ai-spending-saved.png"), fullPage: true });
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
