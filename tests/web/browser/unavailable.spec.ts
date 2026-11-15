import { test } from "@playwright/test";
import { UNSERVED_SCREENS, UnavailablePage } from "./pages/index.js";

// A screen whose route Rovara Code does not serve yet must say so plainly, not spin forever (migration plan v3.2, contract v0).
for (const screen of UNSERVED_SCREENS) {
  test(`${screen.name} says it is not available yet instead of loading forever`, async ({ page }) => {
    await page.goto(screen.path);
    await new UnavailablePage(page).expectNotAvailableYet();
  });
}
