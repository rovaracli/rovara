import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
test("Home preserves server ranking and works at 360 pixels in both themes", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "home" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.setViewportSize({ width: 360, height: 800 });await page.goto("/app");await expect(page.getByText("2 things need you")).toBeVisible();
 await expect(page.locator("main h2")).toHaveText(["Review the duplicate-refund fix", "Investigate a failed verification run"]);
 await expect(page.getByRole("link", { name: "Open session: Review the duplicate-refund fix" })).toHaveAttribute("href", "/s/ses_aaaaaaaaaaaaaaaaaaaa");
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });await page.screenshot({ path: ".test-build/web-e2e/home-light.png", fullPage: true });await checkA11y(page, { theme: "dark" });await page.screenshot({ path: ".test-build/web-e2e/home-dark.png", fullPage: true });
});
