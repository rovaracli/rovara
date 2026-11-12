import { test, expect } from "./support/csp.js";
import { appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { checkA11y } from "./support/axe.js";
const fixtureSession = "11111111-1111-4111-8111-111111111111";
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "shell" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: fixtureSession, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
test("signs in and returns to the page asked for (an old /app/live link lands on Work) without violating CSP", async ({ page, context }) => {
 await context.clearCookies();await page.goto("/app/live");await expect(page.getByRole("heading", { name: "Sign in to the mock cell" })).toBeVisible();
 await page.getByRole("button", { name: "Sign in" }).click();await expect(page).toHaveURL(/\/app\/work$/u);await expect(page.getByRole("heading", { name: "Work", exact: true, level: 1 })).toBeVisible();
});
test("serves the exact nonced cell CSP, supports keyboard navigation, and opens the account dialog", async ({ page }) => {
 const response = await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
 const nonce = await page.locator('meta[name="csp-nonce"]').getAttribute("content");
 expect(response?.headers()["content-security-policy"]).toBe(`default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-hashes' 'sha256-3oFxofzq3N//6J8H86e9ul4WT2OkJrtonB66gn/TLJw='; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`);
 for (const [name, heading] of [["Work", "Work"], ["payments", "payments"], ["Home, 3 need you", "Home"]] as const) {
 const link = page.locator("aside").getByRole("link", { name, exact: true });await link.focus();await page.keyboard.press("Enter");await expect(page.getByRole("heading", { name: heading, exact: true })).toBeFocused();
 }
 await page.getByRole("button", { name: "Open account menu" }).click();await expect(page.getByRole("dialog", { name: "Your account" })).toBeVisible();await page.getByRole("button", { name: "Close dialog" }).click();await expect(page.getByRole("dialog")).toHaveCount(0);
});
for (const theme of ["light", "dark"] as const) test("passes accessibility checks in " + theme, async ({ page }) => { await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();await checkA11y(page, { theme }); });
test("opens mobile navigation and restores the menu opener at 390 pixels", async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });await page.goto("/app");const menu = page.getByRole("button", { name: "Open workspace menu" });await menu.click();
 await expect(page.getByRole("dialog", { name: "Workspace" })).toBeVisible();await page.getByRole("button", { name: "Close dialog" }).click();await expect(menu).toBeFocused();expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("uses the real cookie and CSRF guards for mock API writes", async ({ page, context }) => {
 await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
 const statuses = await page.evaluate(async () => {
 const denied = await fetch("/v1/web/realtime/token", { method: "POST" });
 const me = await (await fetch("/v1/web/me")).json() as { csrf: string };
 const accepted = await fetch("/v1/web/realtime/token", { method: "POST", headers: { "x-rovara-csrf": me.csrf } });
 return [denied.status, accepted.status];
 });
 expect(statuses).toEqual([403, 200]);expect((await context.request.post("/v1/web/realtime/token", { headers: { origin: "https://foreign.example", "x-rovara-csrf": appCsrfTokenFor(fixtureSession) } })).status()).toBe(403);
});
