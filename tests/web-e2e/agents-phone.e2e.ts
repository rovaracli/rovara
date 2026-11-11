import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// The agent directory and profile are usable on a phone: not behind the larger-screen block, one column, no sideways scroll, 44px touch targets, visible focus, and a started session.
// The builder and the new-agent page stay desktop-first. Pictures go to .test-build/web-e2e/agents-phone/ (ROVARA_AGENTS_PHONE_SHOTS changes the folder, for before/after comparisons).
const shots = process.env.ROVARA_AGENTS_PHONE_SHOTS ?? ".test-build/web-e2e/agents-phone";
const agentId = "agt_aaaaaaaaaaaaaaaaaaaa", sessionId = "ses_aaaaaaaaaaaaaaaaaaaa", cookie = "11111111-1111-4111-8111-111111111111";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number) {
 await request.post("/__mock/scenario", { data: { name: "agents" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ reducedMotion: "reduce" });await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
// Visible controls under 44px tall. Links inside a sentence are exempt (WCAG 2.5.8); every other link, button, field and summary counts.
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a), main button, main input, main select, main textarea, main summary")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
async function focusVisible(page: Page) {
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
}
for (const width of [360, 390, 1280] as const) {
 const phone = width < 768;
 test(`the agent directory at ${String(width)}: ${phone ? "one column, " : ""}no sideways scroll${phone ? ", 44px targets" : ""}, visible focus`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width);await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "Agent directory", exact: true })).toBeVisible();await expect(page.getByRole("link", { name: "Payments Expert", exact: true })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await expect(page.getByRole("heading", { name: "Open on a larger screen" })).toBeHidden();
  if (phone) {
   expect(await smallTargets(page)).toEqual([]);await expect(page.getByRole("link", { name: "New agent", exact: true })).toBeVisible();await expect(page.getByText("Building agents works best on a larger screen.")).toBeVisible();
   // One column: every row's title starts at the same left edge and the row is as wide as the page content.
   const rows = await page.locator(".rv-agent-list > li").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect();return [Math.round(box.left), Math.round(box.right)]; }));expect(new Set(rows.map(row => row[0])).size).toBe(1);
   await page.getByRole("textbox", { name: "Find in these workflows" }).fill("zzzz");await expect(page.getByText("No loaded workflows match your search.")).toBeVisible();await page.getByRole("textbox", { name: "Find in these workflows" }).fill("");
  }
  await evidenceShot(page, { path: `${shots}/directory-${String(width)}.png`, fullPage: true });
  // Axe before focus moves: with the skip link focused it sits over the header buttons, which axe counts as overlapping targets.
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  expect(await focusVisible(page)).not.toBe("hidden");
 });
 test(`the agent profile at ${String(width)}: reads, no sideways scroll${phone ? ", 44px targets, dialogs fit" : ""}`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width);await page.goto("/app/agents/" + agentId);
  await expect(page.getByRole("heading", { name: "Payments Expert", level: 1 })).toBeFocused();await expect(page.getByText("Check refund idempotency.", { exact: true })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);await expect(page.getByRole("heading", { name: "Open on a larger screen" })).toBeHidden();
  if (!phone) await evidenceShot(page, { path: `${shots}/profile-${String(width)}.png`, fullPage: true });
  for (const summary of ["How it runs", "Sharing and versions", "Working on now", "Spend this month"]) await page.getByText(summary, { exact: true }).click();
  await expect(page.getByRole("link", { name: "Version 3" })).toBeVisible();await expect(page.getByText("Started by people", { exact: true })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  if (phone) {
   expect(await smallTargets(page)).toEqual([]);await expect(page.getByRole("link", { name: "All agents", exact: true })).toBeVisible();await expect(page.getByText("Building agents works best on a larger screen.")).toBeVisible();
   await expect(page.getByRole("link", { name: "Edit", exact: true })).toBeVisible();
  }
  if (phone) await evidenceShot(page, { path: `${shots}/profile-${String(width)}.png`, fullPage: true });
  for (const name of ["Share", "Change owner"]) {
   await page.getByRole("button", { name, exact: true }).click();const dialog = page.getByRole("dialog").last();await expect(dialog).toBeVisible();await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
   const box = (await dialog.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x + box.width).toBeLessThanOrEqual(width);expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
   if (phone) expect(await dialog.evaluate(node => [...node.querySelectorAll<HTMLElement>("button, select, input")].filter(item => { const rect = item.getBoundingClientRect();return rect.width > 0 && rect.height > 0 && rect.height < 43.5; }).length)).toBe(0);
   if (name === "Share") await evidenceShot(page, { path: `${shots}/profile-share-dialog-${String(width)}.png` });
   await dialog.getByRole("button", { name: "Close dialog" }).click();await expect(dialog).toBeHidden();
  }
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
test("on a phone an agent opens as its own page, can be started, and building is sent to a larger screen", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390);await page.goto("/app/agents");
 await page.getByRole("link", { name: "Payments Expert", exact: true }).click();await expect(page).toHaveURL(new RegExp("/app/agents/" + agentId + "$"));
 await expect(page.getByRole("heading", { name: "Payments Expert", level: 1 })).toBeVisible();await expect(page.getByRole("dialog")).toHaveCount(0);
 await page.getByRole("link", { name: "All agents", exact: true }).click();await expect(page.getByRole("heading", { name: "Agent directory", exact: true })).toBeVisible();
 await page.getByRole("link", { name: "Payments Expert", exact: true }).click();
 await page.getByRole("button", { name: "Start session", exact: true }).click();const start = page.getByRole("dialog", { name: "New session with Payments Expert" });
 await start.getByRole("combobox", { name: "Project", exact: true }).selectOption("payments");await start.getByRole("button", { name: "Continue", exact: true }).click();
 await start.getByRole("textbox", { name: "What should Payments Expert do?" }).fill("Investigate why the customer was refunded twice.");await evidenceShot(page, { path: `${shots}/profile-start-dialog-390.png` });
 await start.getByRole("button", { name: "Start session", exact: true }).click();await expect(page).toHaveURL(new RegExp("/app/sessions/" + sessionId + "$"));
 const writes = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;expect(writes.filter(row => row.method === "POST" && row.path.includes("/agents/" + agentId))).not.toHaveLength(0);
});
test("on a phone the builder and the new-agent page stay behind the larger-screen message", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390);
 for (const path of ["/app/agents/new", "/app/agents/" + agentId + "/edit"]) { await page.goto(path);await expect(page.getByRole("heading", { name: "Open on a larger screen" })).toBeVisible();expect(await noSidewaysScroll(page)).toBe(true); }
});
