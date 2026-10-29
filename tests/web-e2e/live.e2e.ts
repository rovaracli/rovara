import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
test("Live keeps the task in place through pushed updates and reconnect catch-up", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "live" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 const realtime = await mockRealtime(page);await page.setViewportSize({ width: 390, height: 844 });await page.goto("/app/live?filter=needs_me");
 await expect(page.getByRole("tab", { name: "Needs me" })).toHaveAttribute("aria-selected", "true");await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toBeVisible();await expect(page.getByText("Planning", { exact: true })).toBeVisible();
 await page.getByRole("button", { name: "Stop", exact: true }).click();await expect(page.getByRole("dialog", { name: "Stop this session?" })).toBeVisible();await expect(page.getByRole("button", { name: "Stop session", exact: true })).toBeVisible();await expect(page.getByRole("dialog", { name: "Stop this session?" })).toHaveCSS("opacity", "1");await checkA11y(page, { theme: "light" });await page.keyboard.press("Escape");await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeFocused();
 await request.post("/__mock/live-state", { data: { step: "Building", revision: 2 } });await realtime.push({ type: "session.updated", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", revision: 2 });await expect(page.getByText("Building", { exact: true })).toBeVisible();
 await realtime.drop();await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();await request.post("/__mock/live-state", { data: { step: "Verifying", revision: 3 } });await expect.poll(() => realtime.connections()).toBeGreaterThan(1);await expect(page.getByText("Verifying", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: ".test-build/web-e2e/live-light.png", fullPage: true });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: ".test-build/web-e2e/live-dark.png", fullPage: true });
});
