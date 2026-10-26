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

test("wraps a long member name without overflowing the directory", async ({ page, request }) => { await request.post("/__mock/admin-long-name");await page.goto("/app/admin/people");const cell = page.getByRole("cell", { name: "Long display name ".repeat(30).trim(), exact: true });await expect(cell).toBeVisible();expect(await cell.evaluate(node => getComputedStyle(node).overflowWrap)).toBe("anywhere");expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await checkA11y(page, { theme: "light" }); });

test("reviews a role change, verifies real persisted state and records an audit without duplicate submissions", async ({ page, request }) => {
 await page.goto("/app/admin/people");const trigger = page.getByRole("button", { name: "Change role for Maya" });await trigger.click();const dialog = page.getByRole("dialog", { name: "Change company role" });await expect(dialog.getByText("Current role: Member", { exact: true })).toBeVisible();await dialog.getByRole("combobox", { name: "Proposed role" }).selectOption("admin");await dialog.getByRole("button", { name: "Review role change" }).click();await expect(dialog.getByText("Proposed role: Admin", { exact: true })).toBeVisible();await expect(dialog.getByText(/maintainer access to every project/)).toBeVisible();await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 const before = await (await request.get("/__mock/requests")).json() as Array<{ method: string }>;expect(before.some(row => row.method === "PUT")).toBe(false);
 await dialog.getByRole("button", { name: "Confirm role change" }).click();await expect(dialog.getByText("Company role verified: Admin.", { exact: true })).toBeVisible();await dialog.getByRole("button", { name: "Close dialog" }).click();await expect(trigger).toBeFocused();
 const evidence = await (await request.get("/__mock/admin-evidence")).json() as { receipts: unknown[]; audit: Array<{action:string;facts:unknown}> };expect(evidence.receipts).toHaveLength(1);expect(evidence.audit).toMatchObject([{ action: "member.role_changed", facts: { fromRole: "member", toRole: "admin" } }]);await page.reload();await expect(page.getByRole("row").filter({ hasText: "Maya" })).toContainText("Admin");
 await page.screenshot({ path: ".superpowers/sdd/codex/m3-people.png" });
});
test("blocks the last owner's demotion and exits Administration after a verified self-demotion with another owner", async ({ page, request }) => {
 await page.goto("/app/admin/people");await page.getByRole("button", { name: "Change role for Priya" }).click();let dialog = page.getByRole("dialog", { name: "Change company role" });await dialog.getByRole("combobox", { name: "Proposed role" }).selectOption("member");await expect(dialog.getByText("Add another owner before changing your own role.")).toBeVisible();await expect(dialog.getByRole("button", { name: "Review role change" })).toBeDisabled();await page.keyboard.press("Escape");
 await request.post("/__mock/admin-target-owner");await page.reload();await page.getByRole("button", { name: "Change role for Priya" }).click();dialog = page.getByRole("dialog", { name: "Change company role" });await dialog.getByRole("combobox", { name: "Proposed role" }).selectOption("member");await expect(dialog.getByText(/You are changing your own access/)).toBeVisible();await dialog.getByRole("button", { name: "Review role change" }).click();await dialog.getByRole("button", { name: "Confirm role change" }).click();await expect(page.getByText("Your company role is now Member. Administration access has ended.")).toBeVisible();await expect(page.getByRole("table")).toHaveCount(0);await page.getByRole("link", { name: "Go to Home" }).click();await expect(page).toHaveURL(/\/app$/);
});
