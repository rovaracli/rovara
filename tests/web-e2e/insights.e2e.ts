import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { mockInsights, type InsightsVariant } from "./support/insights-mock.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Insights (switch `rovara.insights` = "v2", shown in the new navigation, `rovara.nav` = "v2"). Off: no route, no entry, no request. On: four panels, phone-ready, axe clean.
// Pictures go to .test-build/web-e2e/insights/ (ROVARA_INSIGHTS_SHOTS changes the folder). The reads are `page.route` fixtures (support/insights-mock.ts).
const shots = process.env.ROVARA_INSIGHTS_SHOTS ?? ".test-build/web-e2e/insights";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, variant: InsightsVariant | undefined = "owner", colorScheme: "light" | "dark" = "light") {
 await request.post("/__mock/scenario", { data: { name: "home" } });
 const seen = variant === undefined ? [] : await mockInsights(page, variant);
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, { "rovara.theme": colorScheme, ...store });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
 return seen;
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a), main button, main input, main select, main textarea, main summary")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30)));
async function focusVisible(page: Page) {
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
}
const NAV = { "rovara.nav": "v2" };
const ready = (page: Page) => expect(page.getByRole("region", { name: "Stuck work" }).getByRole("heading", { name: "Retry the payment webhook" })).toBeVisible();

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: no Insights entry, no Insights page, no Insights request`, async ({ page, context, request, baseURL }) => {
  const seen = await enter(page, context, request, baseURL, width, NAV);
  await page.goto("/app");await expect(page.getByText("2 things need you")).toBeVisible();
  const links = await page.locator(".rv-sidebar-nav-v2 a, .rv-tabbar a").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""));
  expect(links.some(text => /Insights/u.test(text))).toBe(false);
  await page.goto("/app/insights");await expect(page.getByText("We couldn't find that.")).toBeVisible();
  await page.waitForLoadState("networkidle");expect(seen).toEqual([]);
 });
}

test("switch on at 1280: the entry is in the sidebar and opens the page; the phone tab bar keeps its five tabs", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { ...NAV, "rovara.insights": "v2" });
 await page.goto("/app");await expect(page.getByText("2 things need you")).toBeVisible();
 const sidebar = page.locator("aside").getByRole("navigation", { name: "Workspace" });
 await expect(sidebar.getByRole("link", { name: "Insights", exact: true })).toHaveCount(1);
 await sidebar.getByRole("link", { name: "Insights", exact: true }).click();
 await expect(page.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();await ready(page);
 await expect(sidebar.getByRole("link", { name: "Insights", exact: true })).toHaveAttribute("aria-current", "page");
 await page.setViewportSize({ width: 390, height: 900 });
 await expect(page.getByRole("navigation", { name: "Main destinations" }).getByRole("link")).toHaveCount(5);
 await page.getByRole("button", { name: "Open workspace menu" }).click();
 await expect(page.getByRole("dialog").getByRole("link", { name: "Insights", exact: true })).toBeVisible();
});

test("switch on but the server refuses: no entry, and the page says why", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { ...NAV, "rovara.insights": "v2" }, "refused");
 await page.goto("/app");await expect(page.getByText("2 things need you")).toBeVisible();await page.waitForLoadState("networkidle");
 await expect(page.locator("aside").getByRole("link", { name: "Insights", exact: true })).toHaveCount(0);
 await page.goto("/app/insights");await expect(page.getByText(/Insights isn't open to you/)).toBeVisible();
 expect(await noSidewaysScroll(page)).toBe(true);
});

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`switch on, owner, ${look.name} at ${String(width)}: four panels, ${phone ? "one column, 44px targets, " : ""}no sideways scroll, axe clean, visible focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...NAV, ...look.store, "rovara.insights": "v2" });await page.goto("/app/insights");
   await expect(page.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();await ready(page);
   if (look.name === "look-v2") await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
   const stuck = page.getByRole("region", { name: "Stuck work" });
   await expect(stuck).toContainText("Priya Shah");await expect(stuck).toContainText("Maya Chen (reviewer)");await expect(stuck).toContainText("Sam Lee");await expect(stuck).toContainText("Dana Wu");
   await expect(stuck).toContainText("You can see that it exists and its state, not its content.");await expect(stuck).toContainText("Does not include: change approvals, plan reviews, merge readiness.");
   const shipped = page.getByRole("region", { name: "Shipped outcomes" });await expect(shipped).toContainText("Collecting data since Nov 1, 2026");await expect(shipped.getByRole("link", { name: /acme\/api#412/ })).toBeVisible();
   const spend = page.getByRole("region", { name: "Spend vs outcomes" });await expect(spend.getByRole("table", { name: "Spending and outcomes by project" })).toContainText("Not recorded yet");await expect(spend.getByRole("table", { name: "Spending by person" })).toContainText("Maya Chen");
   await expect(page.getByRole("region", { name: "Flow health" })).toContainText("Not available yet.");
   await expect(page.getByRole("region", { name: "Who can see Insights" })).toContainText("Maya Chen");
   await expect(page.locator("main")).not.toContainText(/NaN|undefined|ses_[a-z0-9]{20}/u);
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) {
    expect(await smallTargets(page)).toEqual([]);
    const lefts = await page.locator(".rv-ins-figures").first().locator("> div").evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));expect(new Set(lefts).size).toBe(1);
   }
   await evidenceShot(page, { path: `${shots}/insights-owner-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
 }
}

test("switch on at 390, dark, viewer: no person spend, no grant control", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { ...NAV, "rovara.look": "v2", "rovara.insights": "v2" }, "viewer", "dark");await page.goto("/app/insights");await ready(page);
 await expect(page.getByText("You can see that work exists and its state")).toBeVisible();
 await expect(page.getByRole("region", { name: "Spend vs outcomes" }).getByRole("table", { name: "Spending by person" })).toHaveCount(0);await expect(page.getByRole("region", { name: "Spend vs outcomes" })).not.toContainText("Maya Chen");
 await expect(page.getByRole("region", { name: "Who can see Insights" })).toHaveCount(0);
 expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
 await evidenceShot(page, { path: `${shots}/insights-viewer-look-v2-390-dark.png`, fullPage: true });
 await checkA11y(page, { theme: "dark" });
});

test("switch on at 390, maintainer: the project filter, no company totals, no person spend, no grant control", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { ...NAV, "rovara.insights": "v2" }, "maintainer");await page.goto("/app/insights");await ready(page);
 await expect(page.getByText(/Showing the projects you maintain: payments, web\./)).toBeVisible();
 await expect(page.getByRole("combobox", { name: "Project" })).toBeVisible();
 await expect(page.getByRole("region", { name: "Spend vs outcomes" }).locator(".rv-ins-figures")).toHaveCount(0);
 await expect(page.getByRole("region", { name: "Spend vs outcomes" }).getByRole("table", { name: "Spending by person" })).toHaveCount(0);
 await expect(page.getByRole("region", { name: "Who can see Insights" })).toHaveCount(0);
 expect(await noSidewaysScroll(page)).toBe(true);
 await evidenceShot(page, { path: `${shots}/insights-maintainer-look-off-390.png`, fullPage: true });
 await checkA11y(page, { theme: "light" });
});
