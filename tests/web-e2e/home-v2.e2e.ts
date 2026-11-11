import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// The new Home is off unless storage says so (`rovara.home` = "v2"). Off, it is today's Home. On, in the old look and the v2 look, at phone and desktop widths: the sections come in the agreed order, nothing scrolls
// sideways, every control is 44px tall on a phone, the page passes axe in both themes and focus is visible. Pictures go to .test-build/web-e2e/home/ (ROVARA_HOME_SHOTS changes the folder, for before/after comparisons).
const shots = process.env.ROVARA_HOME_SHOTS ?? ".test-build/web-e2e/home", cookie = "11111111-1111-4111-8111-111111111111";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, mode?: "full" | "empty" | "actions") {
 await request.post("/__mock/scenario", { data: { name: "home" } });
 if (mode !== undefined) await request.post("/__mock/home-v2", { data: { mode } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.addInitScript(entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
// Visible controls under 44px tall. A link inside a sentence is exempt (WCAG 2.5.8); every other link, button, field and summary counts.
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a), main button, main input, main select, main textarea, main summary")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5 && !node.classList.contains("rv-checkbox"); }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
const focusVisible = async (page: Page) => { await page.keyboard.press("Tab");await page.keyboard.press("Tab");return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; }); };
const HEADINGS = ["Needs you", "Start something", "Or start with an agent", "Continue", "Finished recently"];
for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's Home, none of the new sections`, async ({ page, context, request, baseURL }) => {
  const chunks: string[] = [];page.on("request", asked => { if (/HomeV2|home-v2/u.test(asked.url())) chunks.push(asked.url()); });
  await enter(page, context, request, baseURL, width, {});await page.goto("/app");
  await expect(page.getByText("2 things need you")).toBeVisible();await expect(page.locator(".rv-attention-list")).toBeVisible();
  // The start box line (loaded after the first paint) is waited for, so a before/after picture never catches it half-loaded.
  await expect(page.getByText("Project: payments")).toBeVisible();await expect(page.locator(".rv-home-v2")).toHaveCount(0);await page.waitForLoadState("networkidle");expect(chunks, "the new Home's chunk is not requested while the switch is off").toEqual([]);await expect(page.getByRole("heading", { name: "Continue", exact: true })).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: true });
 });
}
for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)} with card actions showing: today's buttons and links, none of the new rows`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, {}, "actions");await page.goto("/app");
  await expect(page.getByText("2 things need you")).toBeVisible();await expect(page.getByRole("button", { name: "Review plan" })).toBeVisible();await expect(page.getByRole("link", { name: "Open the plan" })).toBeVisible();await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();await expect(page.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(page.getByText("Project: payments")).toBeVisible();await expect(page.locator(".rv-hv2-row")).toHaveCount(0);await page.waitForLoadState("networkidle");
  await evidenceShot(page, { path: `${shots}/off-actions-${String(width)}.png`, fullPage: true });
 });
}
for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`switch on, ${look.name} at ${String(width)}: order, ${phone ? "one column, 44px targets, " : "side by side, "}no sideways scroll, axe, focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.home": "v2" }, "full");await page.goto("/app");
   await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
   await expect(page.getByRole("list", { name: "Work to continue" })).toBeVisible();await expect(page.getByRole("list", { name: "Recently finished work" })).toBeVisible();await expect(page.getByLabel("What do you need?")).toBeVisible();await expect(page.getByRole("list", { name: "Agents" })).toBeVisible();
   // Order on the page, top to bottom.
   expect((await page.locator("main h2").allTextContents()).map(text => text.replace(/\s*\d+$/u, ""))).toEqual(expect.arrayContaining(HEADINGS));
   const tops = await page.evaluate(names => names.map(name => [...document.querySelectorAll("main h2")].find(node => node.textContent?.replace(/\s*\d+$/u, "") === name)!.getBoundingClientRect().top), HEADINGS);
   expect(tops[0]!).toBeLessThan(tops[1]!);expect(tops[1]!).toBeLessThan(tops[3]!);expect(tops[3]!).toBeLessThan(tops[4]!);
   // Start and the agents row: side by side on a desktop, stacked on a phone.
   const cards = await page.evaluate(() => [".rv-hv2-start", ".rv-hv2-agents"].map(selector => { const box = document.querySelector(selector)!.getBoundingClientRect();return { top: box.top, left: box.left, right: box.right }; }));
   if (phone) { expect(cards[1]!.top).toBeGreaterThan(cards[0]!.top);expect(cards[1]!.left).toBe(cards[0]!.left);expect(cards[1]!.right).toBe(cards[0]!.right); } else { expect(cards[1]!.top).toBe(cards[0]!.top);expect(cards[1]!.left).toBeGreaterThan(cards[0]!.right - 1); }
   // Needs you holds the decision card and both older cards; each has at most one primary action (the failure card in this fixture has no buttons of its own: its Open comes from its id). Continue and Finished recently stop at five.
   await expect(page.getByRole("list", { name: "What needs you" }).getByRole("listitem")).toHaveCount(3);
   await expect(page.locator(".rv-hv2-row .rv-button-primary")).toHaveCount(3);expect(await page.getByRole("list", { name: "What needs you" }).locator(".rv-hv2-row").evaluateAll(rows => rows.map(row => row.querySelectorAll(".rv-button-primary").length))).toEqual([1, 1, 1]);
   await expect(page.getByRole("list", { name: "Work to continue" }).getByRole("listitem")).toHaveCount(5);await expect(page.getByRole("list", { name: "Recently finished work" }).getByRole("listitem")).toHaveCount(5);
   await expect(page.getByRole("list", { name: "Agents" }).getByRole("listitem")).toHaveCount(4);
   await expect(page.getByRole("link", { name: "See all in Work" })).toHaveCount(2);await expect(page.getByRole("link", { name: "See all in Work" }).first()).toHaveAttribute("href", "/app/live");
   // No raw code and no model id reaches the page.
   const text = (await page.locator("main").textContent()) ?? "";
   expect(text).not.toMatch(/needs_person|needs_you|approve_design|succeeded|gpt-|claude-|\bLive\b/u);
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) expect(await smallTargets(page)).toEqual([]);
   await evidenceShot(page, { path: `${shots}/on-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
 }
}
test("switch on with nothing anywhere: every section says so plainly, in Work's words", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.home": "v2" }, "empty");await page.goto("/app");
 await expect(page.getByText("Nothing needs you right now.")).toBeVisible();await expect(page.getByText("Nothing in progress.")).toBeVisible();await expect(page.getByText("Nothing finished recently.")).toBeVisible();await expect(page.getByText("No agents are available yet.")).toBeVisible();
 expect(await page.locator("main").textContent()).not.toMatch(/\bLive\b/u);
 expect(await noSidewaysScroll(page)).toBe(true);
 await evidenceShot(page, { path: `${shots}/on-empty-390.png`, fullPage: true });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});
