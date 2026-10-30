import { test, expect } from "./support/csp.js";
import { activate } from "./support/keyboard.js";
import { evidenceShot } from "./support/screenshot.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });expect((await request.post("/__mock/b35-service-status")).ok()).toBe(true);
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
test("B35 reads shared stored service evidence from Overview with accessible keyboard drill-downs", async ({ page, request }, info) => {
 await page.goto("/app/admin");await activate(page.getByRole("link", { name: "Review Rovara service status", exact: true }));await expect(page.getByRole("heading", { name: "Rovara service status", exact: true })).toBeFocused();
 await activate(page.getByRole("link", { name: "browser runtime", exact: true }));await expect(page.getByRole("heading", { name: "Rovara service status: browser runtime", exact: true })).toBeFocused();
 const table = page.getByRole("table", { name: "Stored browser runtime qualification", exact: true });await expect(table.getByRole("cell", { name: "ready", exact: true })).toBeVisible();await expect(table.locator('th[scope="row"]')).toHaveCount(4);await expect(table.locator("time")).toHaveCount(2);
 const refresh = page.getByRole("button", { name: "Refresh stored status", exact: true });await activate(refresh);await expect(page.getByRole("status")).toContainText("Stored status refreshed");await expect(refresh).toBeFocused();
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: info.outputPath("b35-service-status.png"), fullPage: true });
 await activate(page.getByRole("link", { name: "Back to service status", exact: true }));await activate(page.getByRole("link", { name: "API runtime", exact: true }));await expect(page.getByRole("table", { name: "Stored API runtime qualification", exact: true }).getByRole("cell", { name: "parked", exact: true })).toBeVisible();
 const calls = await (await request.get("/__mock/requests")).json() as { method: string; path: string }[];expect(calls.filter(row => row.path.includes("/org/service-status")).every(row => row.method === "GET")).toBe(true);expect(calls.some(row => row.path.startsWith("/v1/admin/") || row.path.includes("qualification"))).toBe(false);await expect(page.locator("body")).not.toContainText("not-disclosed.invalid");
});
