import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Lane exp/polish: the small follow-ups. Pictures go to .test-build/web-e2e/polish/ (ROVARA_POLISH_SHOTS changes the folder).
//  - "Work" not "Live" while the new navigation (`rovara.nav` = "v2") is on; "Live" exactly as today while it is off.
//  - The project page's Spending tab (`rovara.spending` = "v2"): a maintainer's view of that project's spent, held and left.
//  - The phone tab bar (new navigation): nothing of a page sits under it and a toast sits above it.
const shots = process.env.ROVARA_POLISH_SHOTS ?? ".test-build/web-e2e/polish";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, scenario: string, store: Record<string, string>, colorScheme: "light" | "dark" = "light") {
 await request.post("/__mock/scenario", { data: { name: scenario } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const NAV = { "rovara.nav": "v2" };

// ---- Work, not Live
for (const width of [1280, 390] as const) {
 for (const nav of [true, false]) {
  test(`${nav ? "new navigation on" : "navigation off"} at ${String(width)}: Home's empty state and the task list page say ${nav ? "Work" : "Live"}`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, "home", nav ? NAV : {});
   await request.post("/__mock/home-v2", { data: { mode: "empty" } });
   await page.goto("/app");
   const empty = page.getByText("Nothing needs you right now");await expect(empty).toBeVisible();
   const word = nav ? "Work" : "Live", other = nav ? "Live" : "Work";
   await expect(page.getByText("Find ongoing sessions in " + word + ".")).toBeVisible();await expect(page.getByText("Find ongoing sessions in " + other + ".")).toHaveCount(0);
   await expect(page.getByRole("link", { name: "See work in progress" })).toHaveAttribute("href", nav ? "/app/work" : "/app/live");
   await evidenceShot(page, { path: `${shots}/home-empty-${nav ? "nav" : "off"}-${String(width)}.png`, fullPage: true });
   // The page itself: with the navigation on, /app/live is Work (and the work-list switch is off, so today's list shows under the new name).
   await request.post("/__mock/scenario", { data: { name: "live" } });
   await page.goto(nav ? "/app/live" : "/app/live");
   await expect(page.getByRole("heading", { name: word, level: 1 })).toBeVisible();await expect(page.getByRole("heading", { name: other, level: 1 })).toHaveCount(0);
   await expect(page.getByRole("tablist", { name: word + " filters" })).toBeVisible();
   if (nav) expect(new URL(page.url()).pathname).toBe("/app/work");
   expect(await noSidewaysScroll(page)).toBe(true);
  });
 }
}

// ---- The project page's Spending tab
async function openSpendingTab(page: Page) { await page.getByRole("tab", { name: "Spending" }).click();await expect(page.getByRole("tab", { name: "Spending", selected: true })).toBeVisible(); }
for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: the project page has no Spending tab and reads nothing of it`, async ({ page, context, request, baseURL }) => {
  const reads: string[] = [];page.on("request", asked => { if (/\/projects\/payments\/spend/u.test(asked.url())) reads.push(asked.url()); });
  await enter(page, context, request, baseURL, width, "project", {});await page.goto("/app/projects/payments?tab=spending");
  await expect(page.getByRole("heading", { name: "payments", level: 1 })).toBeVisible();await expect(page.getByRole("tab", { name: "Overview", selected: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Spending" })).toHaveCount(0);await page.waitForLoadState("networkidle");expect(reads).toEqual([]);
 });
 test(`switch on at ${String(width)}: a maintainer sees spent, held and left; totals only; axe clean in both themes`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, "project", { "rovara.spending": "v2" });await request.post("/__mock/project-spend?variant=ok");await page.goto("/app/projects/payments");
  await expect(page.getByRole("heading", { name: "payments", level: 1 })).toBeVisible();await openSpendingTab(page);
  await expect(page.getByRole("heading", { name: "Spending, November 2026" })).toBeVisible();
  const figure = (name: string) => page.getByText(name, { exact: true }).locator("xpath=following-sibling::dd");
  await expect(figure("Spent")).toHaveText("$150.00");await expect(figure("Held for work in progress")).toHaveText("$30.00");await expect(figure("Left")).toHaveText("$320.00");
  await expect(page.getByRole("columnheader", { name: "Person" })).toHaveCount(0);await expect(page.getByText("what each person spent is not shown")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("tab")).toBe("spending");
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/project-spending-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
test("the Spending tab with no limit, over the limit, and refused", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, "project", { "rovara.spending": "v2" });
 await request.post("/__mock/project-spend?variant=nolimit");await page.goto("/app/projects/payments?tab=spending");
 await expect(page.getByText("No limit set")).toBeVisible();await expect(page.getByText(/No allowance is set for this project/)).toBeVisible();
 await request.post("/__mock/project-spend?variant=over");await page.reload();
 await expect(page.getByRole("status").filter({ hasText: "past this project's allowance" })).toBeVisible();await expect(page.getByText("Left", { exact: true }).locator("xpath=following-sibling::dd")).toHaveText("$0.00");
 for (const variant of ["forbidden", "missing"]) {
  await request.post("/__mock/project-spend?variant=" + variant);await page.reload();
  await expect(page.getByText("You can't see this project's spending. It is shown to the project's maintainers.")).toBeVisible();await expect(page.getByText("Spent", { exact: true })).toHaveCount(0);
 }
});

// ---- The phone tab bar
/** Everything the tab bar could hide: the end of the page, the last control after focus, any other fixed or sticky box in its band, and a toast. */
async function belowTabBar(page: Page) {
 await expect(page.locator(".rv-tabbar")).toBeVisible();await page.waitForLoadState("networkidle");
 await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
 return page.evaluate(() => {
  const bar = document.querySelector(".rv-tabbar")!.getBoundingClientRect(), problems: string[] = [];
  const last = document.querySelector("main")!.lastElementChild!;if (last.getBoundingClientRect().bottom > bar.top) problems.push("the end of the page is under the tab bar");
  // Any other fixed or sticky box that reaches into the bar's band (modal overlays only exist while open, and sit above the bar by design).
  for (const node of document.querySelectorAll<HTMLElement>("body *")) {
   const style = getComputedStyle(node);if ((style.position !== "fixed" && style.position !== "sticky") || node.closest(".rv-tabbar") !== null || style.display === "none" || style.visibility === "hidden") continue;
   const box = node.getBoundingClientRect();if (box.width > 0 && box.height > 0 && box.bottom > bar.top + 0.5 && box.top < bar.bottom) problems.push("fixed or sticky box in the bar's band: " + node.tagName + "." + node.className);
  }
  // The last control of the page, focused, ends above the bar (scroll padding keeps it clear).
  const controls = [...document.querySelectorAll<HTMLElement>("main a[href], main button:not([disabled]), main input:not([type=hidden]):not([disabled]), main select, main textarea, main summary, main [role=tab]")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); });
  const control = controls[controls.length - 1];if (control === undefined) problems.push("no control found");
  else { window.scrollTo(0, 0);control.focus();const box = control.getBoundingClientRect();if (box.bottom > bar.top + 0.5) problems.push("the last control is under the tab bar after focus: " + control.tagName + " " + (control.textContent ?? "").slice(0, 30)); }
  // A toast (fixed at the bottom right) sits above the bar.
  const toast = document.createElement("div");toast.className = "rv-toast";toast.setAttribute("role", "status");toast.textContent = "Saved";document.body.append(toast);
  const toastBox = toast.getBoundingClientRect();if (toastBox.bottom > bar.top + 0.5) problems.push("the toast is under the tab bar");toast.remove();
  return problems;
 });
}
for (const target of [
 { name: "the task page", scenario: "workspace", path: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", ready: (page: Page) => expect(page.getByRole("tab", { name: "Pipeline" })).toBeVisible() },
 { name: "the task page with its lead header", scenario: "workspace", path: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa?lead=1", ready: (page: Page) => expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible() },
 { name: "a settings page", scenario: "admin", path: "/app/admin/money/budgets", ready: (page: Page) => expect(page.getByRole("heading", { name: /budget|spending/i, level: 1 })).toBeVisible() },
 { name: "the project page", scenario: "project", path: "/app/projects/payments", ready: (page: Page) => expect(page.getByRole("heading", { name: "payments", level: 1 })).toBeVisible() },
] as const) {
 test(`new navigation on a phone, ${target.name}: nothing sits under the tab bar and a toast sits above it`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 390, target.scenario, NAV);await page.goto(target.path);await target.ready(page);
  expect(await belowTabBar(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/tabbar-${target.name.replace(/\W+/gu, "-")}.png` });
 });
}

// Tabbing down a long page: whatever takes keyboard focus is never left under the tab bar (WCAG 2.4.11), because the page keeps room for the bar when it scrolls a focused control into view.
for (const target of [
 { name: "the project page", scenario: "project", path: "/app/projects/payments", ready: (page: Page) => expect(page.getByRole("heading", { name: "payments", level: 1 })).toBeVisible() },
 { name: "a settings page", scenario: "admin", path: "/app/admin/money/budgets", ready: (page: Page) => expect(page.getByRole("table", { name: "Spending requests waiting" })).toBeVisible() },
] as const) {
 test(`new navigation on a phone, ${target.name}: keyboard focus never ends under the tab bar`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 390, target.scenario, { ...NAV, ...(target.scenario === "admin" ? { "rovara.spending": "v2" } : {}) });await page.goto(target.path);await target.ready(page);await page.waitForLoadState("networkidle");
  const hidden: string[] = [];let stops = 0;
  for (let step = 0; step < 150; step++) {
   await page.keyboard.press("Tab");
   const stop = await page.evaluate(() => { const node = document.activeElement as HTMLElement | null, bar = document.querySelector(".rv-tabbar")!.getBoundingClientRect();if (node === null || node === document.body || node.closest(".rv-tabbar") !== null || node.closest("header") !== null) return undefined;const box = node.getBoundingClientRect();/* a tall scroll region counts as clear when its top 20px are above the bar */return { name: node.tagName + " " + (node.textContent ?? "").slice(0, 30), under: Math.min(box.bottom, bar.top) - Math.max(box.top, 0) < Math.min(box.height, 20) }; });
   if (stop === undefined) continue;
   stops++;if (stop.under) hidden.push(stop.name);
  }
  expect(stops, "the walk found controls in the page").toBeGreaterThan(10);expect(hidden).toEqual([]);
 });
}
