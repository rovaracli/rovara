import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// The Spending page (switch `rovara.spending` = "v2"): off, the budgets page is today's; on, this month, people, projects, requests and limits. Pictures go to .test-build/web-e2e/spending/
// (ROVARA_SPENDING_SHOTS changes the folder, for before/after comparisons: the "off" pictures of this branch and of its base must be byte-identical).
const shots = process.env.ROVARA_SPENDING_SHOTS ?? ".test-build/web-e2e/spending";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, variant = "owner", colorScheme: "light" | "dark" = "light") {
 await request.post("/__mock/scenario", { data: { name: "admin" } });await request.post("/__mock/spending?variant=" + variant);
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
const PATH = "/app/admin/money/budgets";
const ready = (page: Page) => expect(page.getByRole("table", { name: "Spending requests waiting" })).toBeVisible();

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's budgets page, no spending views, picture for the base comparison`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, {});await page.goto(PATH);
  await expect(page.getByRole("table", { name: "Monthly base budgets" })).toBeVisible();await expect(page.getByText(/Monthly base budgets are read only/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /This month/ })).toHaveCount(0);await page.waitForLoadState("networkidle");
  const calls = await (await request.get("/__mock/requests")).json() as Array<{ path: string }>;
  expect(calls.filter(call => /\/v1\/web\/(budget|org\/spend|spend-requests)$/u.test(call.path))).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: true });
 });
}

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`switch on, ${look.name} at ${String(width)}: all five parts, ${phone ? "one column, 44px targets, " : ""}no sideways scroll, axe clean, visible focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.spending": "v2" });await page.goto(PATH);
   await expect(page.getByRole("heading", { name: "Spending", level: 1 })).toBeVisible();await ready(page);
   if (look.name === "look-v2") await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
   await expect(page.getByRole("heading", { name: "This month: November 2026" })).toBeVisible();
   const figures = page.locator(".rv-spend-figures");await expect(figures).toContainText("$200.00");await expect(figures).toContainText("$50.00");await expect(figures).toContainText("$250.00");await expect(figures).toContainText("Available to the company");
   await expect(page.getByRole("list", { name: "Spending by source" })).toContainText("Rovara-provided");await expect(page.getByRole("list", { name: "Spending by source" })).toContainText("Company Anthropic key");
   const people = page.getByRole("table", { name: "Spending by person this month" });await expect(people).toContainText("Maya");await expect(people).toContainText("Priya");await expect(people).toContainText("$187.50");
   const projects = page.getByRole("table", { name: "Spending by project this month" });await expect(projects).toContainText("payments");await expect(projects).toContainText("$150.00");
   await expect(page.getByRole("table", { name: "Spending requests waiting" })).toContainText("More monthly budget");await expect(page.getByRole("table", { name: "Spending requests waiting" })).toContainText("Company owners and admins");
   await expect(page.getByRole("heading", { name: "Limits" })).toBeVisible();await expect(page.getByText("Company, each month")).toBeVisible();await expect(page.getByText("Each member, each month")).toBeVisible();await expect(page.getByText(/Couldn't load|not available/)).toHaveCount(0);await expect(page.getByText("Limits can't be changed in the web yet.")).toBeVisible();
   await expect(page.locator("main")).not.toContainText(/org_admin|run_limit|rovara\b(?!-)|anthropic\b(?! key)|undefined|NaN/u);
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) {
    expect(await smallTargets(page)).toEqual([]);
    // One column: the three figures sit one under the other.
    const lefts = await figures.locator("> div").evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));expect(new Set(lefts).size).toBe(1);
   }
   await evidenceShot(page, { path: `${shots}/spending-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
 }
}

test("switch on at 390: a person's own allowance from the settings read is shown in the People table, everyone else is the company default", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.spending": "v2" });
 // The settings answer lists Maya's own allowance (`memberOverrides`, owners and admins only); the rest of the answer is the mock directory's.
 await page.route("**/v1/web/org/budget-settings", async route => { const answer = await route.fetch(), body = await answer.json() as Record<string, unknown>;await route.fulfill({ response: answer, json: { ...body, memberOverrideCount: 1, memberOverrides: [{ developerId: "b".repeat(64), microdollars: 75_000_000 }] } }); });
 await page.goto(PATH);await ready(page);
 const people = page.getByRole("table", { name: "Spending by person this month" });
 await expect(people.getByRole("row", { name: /Maya/u })).toContainText("$75.00");await expect(people.getByRole("row", { name: /Maya/u })).toContainText("own allowance");
 await expect(page.getByText(/A person's own allowance is shown where one is set/u)).toBeVisible();
 expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
 await evidenceShot(page, { path: `${shots}/own-allowance-390.png`, fullPage: true });await checkA11y(page, { theme: "light" });
});

test("switch on at 390, dark: a viewer the broker refuses the company breakdown sees totals and own figures only", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.look": "v2", "rovara.spending": "v2" }, "restricted", "dark");await page.goto(PATH);
 await expect(page.getByRole("heading", { name: "This month: November 2026" })).toBeVisible();await expect(page.getByText(/Spending by person is shown to company owners and admins/)).toBeVisible();
 await expect(page.getByRole("table", { name: "Spending by person this month" })).toHaveCount(0);await expect(page.getByText("Maya")).toHaveCount(0);await expect(page.getByText("$187.50")).toHaveCount(0);
 await expect(page.getByText(/You see your own spending/)).toContainText("$12.50");await expect(page.getByText(/The split by source is shown to company owners and admins/)).toBeVisible();
 expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
 await evidenceShot(page, { path: `${shots}/restricted-v2-dark-390.png`, fullPage: true });await checkA11y(page, { theme: "dark" });
});

test("switch on at 390: past the allowance and an empty month say so plainly", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.spending": "v2" }, "over");await page.goto(PATH);
 await expect(page.getByText(/past the company's allowance/)).toBeVisible();await expect(page.locator(".rv-spend-figures")).toContainText("$60.00");await expect(page.locator(".rv-spend-figures")).toContainText("$0.00");expect(await noSidewaysScroll(page)).toBe(true);
 await evidenceShot(page, { path: `${shots}/over-390.png`, fullPage: true });await checkA11y(page, { theme: "light" });
 await request.post("/__mock/spending?variant=empty");await page.getByRole("button", { name: "Refresh spending" }).click();
 await expect(page.getByText(/No monthly allowance is set/)).toBeVisible();await expect(page.getByText("No spending requests are waiting for you.")).toBeVisible();await expect(page.getByText("No project has spent anything this month yet.")).toBeVisible();
 await evidenceShot(page, { path: `${shots}/empty-390.png`, fullPage: true });await checkA11y(page, { theme: "light" });
});

test("a request's confirmation link opens Rovara's own confirmation page, and the page makes no write", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.spending": "v2" });await page.goto(PATH);await ready(page);
 const popup = page.waitForEvent("popup");await page.getByRole("button", { name: "Open to review" }).first().click();
 const opened = await popup;expect(new URL(opened.url()).pathname).toMatch(/^\/v1\/app\/approve\/spr_[a-z]{20}$/u);
 const calls = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(calls.filter(call => call.method !== "GET" && /budget|spend/u.test(call.path))).toEqual([]);
});
