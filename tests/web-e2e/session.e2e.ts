import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa";
test("collaborates in one task without losing its evidence, with real refetch and presence", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "session" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 const realtime = await mockRealtime(page);await page.clock.install();await page.goto("/app/sessions/" + id);await expect(page.getByRole("heading", { name: "Fix duplicate refunds", exact: true })).toBeVisible();await expect(page).toHaveTitle("Fix duplicate refunds · Rovara");
 const heading = await page.getByRole("heading", { name: "Fix duplicate refunds", exact: true }).elementHandle();
 await page.getByRole("button", { name: "Conversation", exact: true }).click();await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Check refunds before retrying.");await page.getByRole("button", { name: "Send comment" }).click();await expect(page.getByText("Check refunds before retrying.", { exact: true })).toBeVisible();await page.getByRole("button", { name: "Close dialog" }).click();await expect(page.getByRole("button", { name: "Conversation", exact: true })).toBeFocused();expect(await heading?.evaluate(node => node.isConnected)).toBe(true);
 await page.getByRole("button", { name: "Follow", exact: true }).click();await expect(page.getByRole("button", { name: "Following", exact: true })).toBeVisible();
 await page.getByRole("button", { name: "Share", exact: true }).click();await page.getByRole("button", { name: "Arjun", exact: true }).click();await page.getByRole("combobox", { name: "Access level" }).selectOption("use");await page.getByRole("button", { name: "Add share", exact: true }).click();await expect(page.getByText("Shared", { exact: true })).toBeVisible();await page.getByRole("button", { name: "Close dialog" }).click();
 const writes = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: { requestId?: string; principal?: unknown; level?: string } }>;
 const share = writes.find(row => row.method === "PUT" && row.path.endsWith("/shares"));expect(share?.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), principal: { kind: "member", developerId: "b".repeat(64) }, level: "use" });
 await page.clock.fastForward(30_010);await expect.poll(async () => ((await (await request.get("/__mock/requests")).json()) as typeof writes).filter(row => row.path.endsWith("/presence")).length).toBeGreaterThanOrEqual(2);
 const beforeHidden = ((await (await request.get("/__mock/requests")).json()) as typeof writes).filter(row => row.path.endsWith("/presence")).length;
 await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });document.dispatchEvent(new Event("visibilitychange")); });await page.clock.fastForward(60_010);expect(((await (await request.get("/__mock/requests")).json()) as typeof writes).filter(row => row.path.endsWith("/presence")).length).toBe(beforeHidden);
 await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });document.dispatchEvent(new Event("visibilitychange")); });await expect.poll(async () => ((await (await request.get("/__mock/requests")).json()) as typeof writes).filter(row => row.path.endsWith("/presence")).length).toBeGreaterThan(beforeHidden);
 await request.post("/__mock/session-state", { data: { status: "waiting", revision: 2, updatedAt: new Date().toISOString() } });await expect.poll(() => realtime.connections()).toBeGreaterThanOrEqual(1);await realtime.push({ type: "session.updated", sessionId: id, revision: 2 });// The state is said in words by the lead block ("Where this task stands"); the old status icon is gone since the leading header became the only header (decision 125).
 await expect(page.getByRole("region", { name: "Where this task stands" }).getByText("Finished", { exact: true })).toBeVisible();expect(await heading?.evaluate(node => node.isConnected)).toBe(true);
 await page.setViewportSize({ width: 360, height: 800 });expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});

test("phone session actions share one workflow and return focus to the overflow opener", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "session" } });
 await request.post("/__mock/session-state", { data: { you: { owner: false, following: false, level: "edit", actions: ["watch", "share", "stop", "retry", "take_over"] } } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.setViewportSize({ width: 360, height: 800 });await mockRealtime(page);await page.goto("/s/" + id);
 const opener = page.getByRole("button", { name: "Session actions", exact: true });await expect(opener).toBeVisible();
 await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
 await opener.click();for (const name of ["Follow", "Share", "Stop", "Retry", "Take over"]) await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
 await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
 const stop = page.getByRole("dialog", { name: "Stop this session?" });await expect(stop).toBeVisible();
 await expect.poll(() => stop.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await page.getByRole("button", { name: "Keep running" }).click();await expect(opener).toBeFocused();
 await opener.click();await page.getByRole("menuitem", { name: "Share", exact: true }).click();await expect(page.getByRole("dialog", { name: "Share this session" })).toBeVisible();
 await page.getByRole("button", { name: "Close dialog" }).click();await expect(opener).toBeFocused();
 await opener.click();await page.getByRole("menuitem", { name: "Follow", exact: true }).click();
 await opener.click();await expect(page.getByRole("menuitem", { name: "Following", exact: true })).toBeVisible();await page.keyboard.press("Escape");await expect(opener).toBeFocused();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await request.post("/__mock/session-state", { data: { you: { owner: false, following: false, level: "view", actions: ["watch"] } } });await page.reload();await opener.click();
 await expect(page.getByRole("menuitem", { name: "Follow", exact: true })).toBeVisible();
 for (const name of ["Share", "Stop", "Retry", "Take over"]) await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
});
