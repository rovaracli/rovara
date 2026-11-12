import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// Work (decision 125: the old Live page is gone and /app/live lands here, with its filter): the task stays in place through pushed updates and a reconnect. The row shows a plain state, not the step, so what a
// push and a reconnect change is checked as the list being read again (the mock's /v1/web/live), with the row still there and the connection note following the socket.
test("Work keeps the task in place through pushed updates and reconnect catch-up", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "live" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 const realtime = await mockRealtime(page);await page.setViewportSize({ width: 390, height: 844 });await page.goto("/app/live?filter=needs_me");
 await expect(page).toHaveURL(/\/app\/work\?/u);await expect(page.getByRole("tab", { name: "Needs attention" })).toHaveAttribute("aria-selected", "true");await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toBeVisible();await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();
 await page.getByRole("button", { name: "Stop", exact: true }).click();await expect(page.getByRole("dialog", { name: "Stop this session?" })).toBeVisible();await expect(page.getByRole("button", { name: "Stop session", exact: true })).toBeVisible();await expect(page.getByRole("dialog", { name: "Stop this session?" })).toHaveCSS("opacity", "1");await checkA11y(page, { theme: "light" });await page.keyboard.press("Escape");await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeFocused();
 const reads = () => page.waitForRequest(asked => new URL(asked.url()).pathname === "/v1/web/live");
 let again = reads();await request.post("/__mock/live-state", { data: { step: "Building", revision: 2 } });await realtime.push({ type: "session.updated", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", revision: 2 });await again;await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toBeVisible();
 await realtime.drop();await expect(page.getByText("Reconnecting", { exact: true })).toBeVisible();again = reads();await request.post("/__mock/live-state", { data: { step: "Verifying", revision: 3 } });await expect.poll(() => realtime.connections()).toBeGreaterThan(1);await again;await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: ".test-build/web-e2e/live-light.png", fullPage: true });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: ".test-build/web-e2e/live-dark.png", fullPage: true });
});
