import { expect, test } from "@playwright/test";
import { HomePage, PROJECT } from "./pages/index.js";

test("Home loads for a signed-in person without an error", async ({ page }) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
});

test("Home offers a way to the person's project", async ({ page }) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
  await expect(page.getByRole("link", { name: PROJECT, exact: true })).toBeVisible();
});

test("Home does not say nothing needs the person while decision cards are waiting", async ({ page }) => {
  const home = new HomePage(page);
  await home.open();
  await home.expectLoaded();
  await expect(home.decisions).toBeVisible();
  await expect(home.empty).toHaveCount(0);
});
