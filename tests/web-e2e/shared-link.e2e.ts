import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", link = "/s/" + id;
for (const expired of [false, true]) test(expired ? "returns an expired shared-link visitor to the same session after sign-in" : "returns a signed-out shared-link visitor to the same session after sign-in", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await context.clearCookies();
 if (expired) { await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await request.post("/__mock/auth", { data: { expired: true } }); }
 await mockRealtime(page);await page.goto(link);await expect(page.getByRole("heading", { name: "Sign in to the mock cell" })).toBeVisible();
 await page.getByRole("button", { name: "Sign in", exact: true }).click();await expect(page).toHaveURL(new RegExp("/app/sessions/" + id + "$"));await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toBeVisible();expect(await page.getByRole("link", { name: /download/i }).count()).toBe(0);
});
test("ends a refused sign-in once without returning to the shared link", async ({ page, context, request }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await context.clearCookies();await request.post("/__mock/auth", { data: { refused: true } });
 await page.goto(link);await expect(page).toHaveURL(/\/app\/signed-out\?reason=removed$/);
 await expect(page.getByText("Your access to this company ended.", { exact: true })).toBeVisible();
 const reads = await (await request.get("/__mock/requests")).json() as Array<{ path: string }>;
 expect(reads.filter(row => row.path === "/v1/auth/browser/authorize")).toHaveLength(1);
});
test("shows the same NotFound for an inaccessible session without leaking its title", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await mockRealtime(page);await page.goto("/s/ses_bbbbbbbbbbbbbbbbbbbb");await expect(page.getByRole("heading", { name: "Not found", exact: true })).toBeVisible();await expect(page.getByText("We couldn't find that. It may not exist, or it hasn't been shared with you.", { exact: true })).toBeVisible();await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toHaveCount(0);
 const reads = await (await request.get("/__mock/requests")).json() as Array<{ path: string }>;expect(reads.some(row => row.path === "/v1/web/sessions/ses_bbbbbbbbbbbbbbbbbbbb")).toBe(true);
});
test("opens the shared task and its conversation on a phone with nothing to install", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await mockRealtime(page);await page.setViewportSize({ width: 390, height: 844 });await page.goto(link);await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toBeVisible();await page.getByRole("button", { name: "Conversation", exact: true }).click();await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toBeVisible();expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
