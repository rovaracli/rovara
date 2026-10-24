import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
const fixtureSession = "11111111-1111-4111-8111-111111111111";
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "shell" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: fixtureSession, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
test("signs in and returns to Live without violating CSP", async ({ page, context }) => {
 await context.clearCookies();await page.goto("/app/live");await expect(page.getByRole("heading", { name: "Sign in to the mock cell" })).toBeVisible();
 await page.getByRole("button", { name: "Sign in" }).click();await expect(page).toHaveURL(/\/app\/live$/u);await expect(page.getByRole("heading", { name: "Live", exact: true })).toBeVisible();
});
test("serves the exact nonced cell CSP, supports keyboard navigation, and opens the account dialog", async ({ page }) => {
 const response = await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
 const nonce = await page.locator('meta[name="csp-nonce"]').getAttribute("content");
 expect(response?.headers()["content-security-policy"]).toBe(`default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`);
 for (const [name, heading] of [["Live", "Live"], ["payments", "Project"], ["Home, 3 waiting", "Home"]]) {
 const link = page.getByRole("link", { name, exact: true });await link.focus();await page.keyboard.press("Enter");await expect(page.getByRole("heading", { name: heading, exact: true })).toBeFocused();
 }
 await page.getByRole("button", { name: "Open account menu" }).click();await expect(page.getByRole("dialog", { name: "Your account" })).toBeVisible();await page.getByRole("button", { name: "Close dialog" }).click();await expect(page.getByRole("dialog")).toHaveCount(0);
});
for (const theme of ["light", "dark"] as const) test("passes accessibility checks in " + theme, async ({ page }) => { await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();await checkA11y(page, { theme }); });
test("opens mobile navigation and restores the menu opener at 390 pixels", async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });await page.goto("/app");const menu = page.getByRole("button", { name: "Open workspace menu" });await menu.click();
 await expect(page.getByRole("dialog", { name: "Workspace" })).toBeVisible();await page.getByRole("button", { name: "Close dialog" }).click();await expect(menu).toBeFocused();expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
