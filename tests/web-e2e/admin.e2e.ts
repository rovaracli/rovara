import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
test("opens the real member read from administration and preserves keyboard focus", async ({ page, request }) => {
 await page.goto("/app/admin");await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeFocused();
 await page.getByRole("link", { name: "Review company members" }).focus();await page.keyboard.press("Enter");await expect(page.getByRole("heading", { name: "People", exact: true })).toBeFocused();await expect(page.getByRole("cell", { name: "Maya", exact: true })).toBeVisible();
 await expect(page.getByText("Other company person")).toHaveCount(0);
 await page.getByRole("searchbox", { name: "Find in this member list" }).fill("does not exist");await expect(page.getByText("No matching members in this list.")).toBeVisible();await page.getByRole("searchbox").fill("Maya");
 await page.getByRole("link", { name: "Roles explained" }).click();await expect(page.getByRole("heading", { name: "Roles", exact: true })).toBeFocused();await expect(page.getByText("View project spending", { exact: true })).toBeVisible();
 await page.getByRole("link", { name: "Back to people" }).click();await expect(page.getByRole("searchbox")).toHaveValue("Maya");
 const reads = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(reads.filter(r => r.path.startsWith("/v1/web/")).every(r => r.method === "GET")).toBe(true);
});
for (const theme of ["light", "dark"] as const) test(`checks all three pages in ${theme}`, async ({ page }) => {
 for (const [path, heading] of [["/app/admin", "Administration"], ["/app/admin/people", "People"], ["/app/admin/people/roles", "Roles"]]) {
  await page.goto(path!);await expect(page.getByRole("heading", { name: heading!, exact: true })).toBeVisible();if (heading === "People") await expect(page.getByText("Maya", { exact: true })).toBeVisible();await checkA11y(page, { theme });
 }
});
test("refuses a member deep link after a live role change", async ({ page, request }) => {
 await page.goto("/app/admin/people");await expect(page.getByText("Maya", { exact: true })).toBeVisible();await request.post("/__mock/admin-role");await page.reload();await expect(page.getByRole("heading", { name: "Administration unavailable" })).toBeVisible();await expect(page.getByText("Maya", { exact: true })).toHaveCount(0);await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
});
test("shows the large-screen boundary on phones and at 200 percent zoom equivalent", async ({ page }) => {
 await page.emulateMedia({ reducedMotion: "reduce" });
 for (const width of [390, 640, 1023]) { await page.setViewportSize({ width, height: 844 });await page.goto("/app/admin/people");await expect(page.getByText("Open this on a larger screen to use it.", { exact: false })).toBeVisible();await expect(page.getByRole("heading", { name: "Administration" , exact: true })).toBeVisible();await expect(page.getByRole("table")).toHaveCount(0);const reads = await (await page.request.get("/__mock/requests")).json() as Array<{ path: string }>;expect(reads.some(r => r.path === "/v1/web/org/members")).toBe(false);expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
 await page.setViewportSize({ width: 1440, height: 1000 });await page.goto("/app/admin/people");await expect(page.getByRole("table")).toBeVisible();await page.screenshot({ path: ".superpowers/sdd/codex/m1-people.png" });
});
