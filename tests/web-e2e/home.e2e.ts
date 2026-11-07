import { mockRealtime } from "./support/realtime.js";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
test("Home preserves server ranking and works at 360 pixels in both themes", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "home" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.setViewportSize({ width: 360, height: 800 });await page.goto("/app");await expect(page.getByText("2 things need you")).toBeVisible();
 await expect(page.locator("main h2")).toHaveText(["Review the duplicate-refund fix", "Investigate a failed verification run"]);
 await expect(page.getByRole("link", { name: "Open session: Review the duplicate-refund fix" })).toHaveAttribute("href", "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa");
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: ".test-build/web-e2e/home-light.png", fullPage: true });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: ".test-build/web-e2e/home-dark.png", fullPage: true });
});

test("Home opens a dedicated approval page and removes it only after a real refetch", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "home" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 const realtime = await mockRealtime(page);await page.goto("/app");await expect(page.getByText("2 things need you")).toBeVisible();
 const opened = context.waitForEvent("page");await page.getByRole("button", { name: "Review plan" }).click();const approval = await opened;
 await expect(approval.getByRole("button", { name: "Approve", exact: true })).toBeVisible();await expect(page.getByRole("heading", { name: "Review the duplicate-refund fix" })).toBeVisible();
 await approval.getByRole("button", { name: "Approve", exact: true }).click();await expect(approval.getByText('"decided":true')).toBeVisible();
 await expect.poll(() => realtime.connections()).toBe(1);await realtime.push({ type: "home.changed", revision: 2 });
 await expect(page.getByRole("heading", { name: "Review the duplicate-refund fix" })).toHaveCount(0);await expect(page.getByText("1 thing needs you")).toBeVisible();await approval.close();
});
