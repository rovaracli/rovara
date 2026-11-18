import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { FAKE_CODE_URL } from "./pages/index.js";
import { HomePage } from "./pages/home.js";

// Lead 4 PCF through Cloud on the pretend Code: the plan card on Home shows the task's feature in one line (from the Linear parent), and for the person Code says may change it, Change (pick another open feature,
// or make a new one for an owner or admin) and No feature. The pretend Code words the line, applies Code's rule (a person who chose it may not change it again) and serves the choices.
const TASK = "11111111-1111-4111-8111-111111111111";
const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F_CHECKOUT = FT("1"), F_BILLING = FT("2");
const FEATURES = [{ id: F_CHECKOUT, name: "Checkout v2" }, { id: F_BILLING, name: "Billing" }];
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
const seed = (page: Page, data: Record<string, unknown>) => page.request.post(`${FAKE_CODE_URL}/__fake/plan-features`, { data });
test.afterEach(async ({ page }) => {
  await seed(page, { reset: true });
  await page.request.post(`${FAKE_CODE_URL}/__fake/person`, { data: { person: "priya" } });
});

test("the plan card says the feature in one line and Change files another open feature, then the card reads again", async ({ page }, info) => {
  await seed(page, { features: FEATURES, filed: { taskId: TASK, featureId: F_CHECKOUT, source: "tracker" } });
  const home = new HomePage(page);
  await home.open();
  const box = page.getByTestId("plan-feature");
  await expect(box.getByText("Feature: Checkout v2 (from the Linear parent)")).toBeVisible();
  await shot(page, info, "plan-card-line-and-controls");
  await box.getByRole("button", { name: "Change" }).click();
  await expect(box.getByLabel("Feature", { exact: true })).toBeVisible();
  await box.getByLabel("Feature", { exact: true }).selectOption(F_BILLING);
  await shot(page, info, "plan-card-change-picker");
  await box.getByRole("button", { name: "Use this feature" }).click();
  await expect(page.getByTestId("plan-feature").getByText("Feature: Billing (chosen)")).toBeVisible();
  await shot(page, info, "plan-card-after-change");
});

test("No feature files none in one press", async ({ page }) => {
  await seed(page, { features: FEATURES, filed: { taskId: TASK, featureId: F_CHECKOUT, source: "tracker" } });
  await new HomePage(page).open();
  await page.getByTestId("plan-feature").getByRole("button", { name: "No feature" }).click();
  await expect(page.getByTestId("plan-feature").getByText("Feature: No feature")).toBeVisible();
  await expect(page.getByTestId("plan-feature").getByRole("button", { name: "No feature" })).toHaveCount(0);
});

test("an admin may make a new feature from Change; the task is filed under it", async ({ page }, info) => {
  await seed(page, { features: FEATURES });
  await new HomePage(page).open();
  const box = page.getByTestId("plan-feature");
  await expect(box.getByText("Feature: No feature")).toBeVisible();
  await box.getByRole("button", { name: "Change" }).click();
  await box.getByLabel("Or make a new feature").fill("Checkout v3");
  await shot(page, info, "plan-card-make-new");
  await box.getByRole("button", { name: "Make it and use it" }).click();
  await expect(page.getByTestId("plan-feature").getByText("Feature: Checkout v3 (chosen)")).toBeVisible();
});

test("a person Code says may not change it sees the line and no control", async ({ page }, info) => {
  await seed(page, { features: FEATURES, filed: { taskId: TASK, featureId: F_CHECKOUT, source: "chosen" }, canChange: false });
  await new HomePage(page).open();
  const box = page.getByTestId("plan-feature");
  await expect(box.getByText("Feature: Checkout v2 (chosen)")).toBeVisible();
  await expect(box.getByRole("button")).toHaveCount(0);
  await shot(page, info, "plan-card-line-only");
});
