import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// The Work list (switch `rovara.work` = "v2"): off, the route shows today's Live list; on, the four views with plain states, age and next actor. Pictures go to .test-build/web-e2e/work-list/
// (ROVARA_WORK_SHOTS changes the folder, for before/after comparisons: the "off" pictures of this branch and of its base must be byte-identical).
const shots = process.env.ROVARA_WORK_SHOTS ?? ".test-build/web-e2e/work-list";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, colorScheme: "light" | "dark" = "light") {
 await request.post("/__mock/scenario", { data: { name: "work" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
// Visible controls under 44px tall. Links inside a sentence are exempt (WCAG 2.5.8); every other link, button, field, tab and summary counts.
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a), main button, main input, main select, main textarea, main summary, main [role=tab]")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
async function focusVisible(page: Page) {
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
}
const TITLES = { retry: "Add retry to the payout job", plan: "Review the plan for duplicate refunds", export: "Speed up the invoice export", ledger: "Try the new ledger query", team: "Check refund idempotency", merged: "Fix the rounding bug in tax totals", twice: "Why were customers refunded twice?" };
const rowOf = (page: Page, title: string) => page.locator(".rv-work-row", { has: page.getByRole("heading", { name: title, exact: true }) });

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's Live list, no Work views, picture for the base comparison`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, {});await page.goto("/app/live");
  await expect(page.getByRole("heading", { name: "Live", level: 1 })).toBeVisible();await expect(page.getByRole("heading", { name: TITLES.export })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Needs me" })).toBeVisible();await expect(page.getByRole("tab", { name: "Finished" })).toHaveCount(0);await expect(page.locator(".rv-work-row")).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: true });
 });
}

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`switch on, ${look.name} at ${String(width)}: rows read plainly, ${phone ? "stack, 44px targets, " : ""}no sideways scroll, axe clean, visible focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.work": "v2" });await page.goto("/app/live");
   await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();await expect(page.getByRole("heading", { name: TITLES.export })).toBeVisible();
   if (look.name === "look-v2") await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
   await expect(page.getByRole("tab")).toHaveText(["Mine", "Team", "Needs attention", "Finished"]);
   // Mine: needs attention first, then the rest, each most recently updated first.
   await expect(page.locator(".rv-work-title")).toHaveText([TITLES.plan, TITLES.retry, TITLES.export, TITLES.ledger]);
   const plan = rowOf(page, TITLES.plan);await expect(plan).toContainText("Needs a decision");await expect(plan).toContainText("updated 3 h ago");await expect(plan).toContainText("Next: You");await expect(plan).toContainText("Cloud");
   const retry = rowOf(page, TITLES.retry);await expect(retry).toContainText("Failed");await expect(retry).toContainText("updated 2 d ago");await expect(retry).toContainText("Next: You");
   const building = rowOf(page, TITLES.export);await expect(building).toContainText("Building");await expect(building).toContainText("updated 20 min ago");await expect(building).toContainText("Next: Rovara");
   // A session on a person's own machine: where it runs is said, who acts next is not (Rovara is not the one working).
   const ledger = rowOf(page, TITLES.ledger);await expect(ledger).toContainText("On Priya's MacBook");await expect(ledger).not.toContainText("Next:");
   await expect(page.locator("main")).not.toContainText(/needs_person|RUNNING|Worker status|claude-|anthropic\./u);
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) {
    expect(await smallTargets(page)).toEqual([]);
    // One column: every row starts at the same left edge and is as wide as the list.
    const boxes = await page.locator(".rv-work-row").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect();return [Math.round(box.left), Math.round(box.right)]; }));expect(new Set(boxes.map(box => box[0])).size).toBe(1);expect(new Set(boxes.map(box => box[1])).size).toBe(1);
    // The views are reachable: the whole strip is inside the page, and the last one can be reached.
    await page.getByRole("tab", { name: "Finished" }).scrollIntoViewIfNeeded();await expect(page.getByRole("tab", { name: "Finished" })).toBeVisible();
   }
   await evidenceShot(page, { path: `${shots}/mine-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
 }
}

test("switch on at 390: Team, Needs attention and Finished, and the project filter", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.work": "v2" });await page.goto("/app/live");
 await expect(page.getByRole("heading", { name: TITLES.export })).toBeVisible();
 await page.getByRole("tab", { name: "Team" }).click();await expect(page).toHaveURL(/view=team/u);await expect(page.locator(".rv-work-title")).toHaveText([TITLES.team]);await expect(rowOf(page, TITLES.team)).toContainText("Checking");await expect(page.getByText("Work on projects you're part of")).toBeVisible();
 await page.getByRole("tab", { name: "Needs attention" }).click();await expect(page.locator(".rv-work-title")).toHaveText([TITLES.plan, TITLES.retry]);expect(await noSidewaysScroll(page)).toBe(true);await evidenceShot(page, { path: `${shots}/attention-390.png`, fullPage: true });
 await page.getByRole("tab", { name: "Finished" }).click();await expect(page.locator(".rv-work-title")).toHaveText([TITLES.merged, TITLES.twice]);
 await expect(rowOf(page, TITLES.merged)).toContainText("Merged");await expect(rowOf(page, TITLES.merged)).toContainText("finished 5 h ago");await expect(rowOf(page, TITLES.twice)).toContainText("On Priya's MacBook");await expect(page.locator(".rv-work-row button")).toHaveCount(0);
 await expect(page.getByText(/Your finished work/u)).toBeVisible();expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);await evidenceShot(page, { path: `${shots}/finished-390.png`, fullPage: true });
 await page.getByRole("combobox", { name: "Project" }).selectOption("payments");await expect(page).toHaveURL(/project=payments/u);await expect(page.getByText("Finished work in payments")).toBeVisible();await expect(page.locator(".rv-work-title")).toHaveCount(2);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 // An old Live link still lands on the right view.
 await page.goto("/app/live?filter=needs_me");await expect(page.getByRole("tab", { name: "Needs attention" })).toHaveAttribute("aria-selected", "true");
});
