import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Lane exp/polish: the small follow-ups. Pictures go to .test-build/web-e2e/polish/ (ROVARA_POLISH_SHOTS changes the folder).
//  - "Work", never "Live" (decision 125: the one navigation).
//  - The project page's Spending tab: a maintainer's view of that project's spent, held and left.
//  - The phone tab bar: nothing of a page sits under it and a toast sits above it.
const shots = process.env.ROVARA_POLISH_SHOTS ?? ".test-build/web-e2e/polish";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, scenario: string, store: Record<string, string>, colorScheme: "light" | "dark" = "light") {
 await request.post("/__mock/scenario", { data: { name: scenario } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const NAV: Record<string, string> = {};

// ---- Work, not Live
for (const width of [1280, 390] as const) {
 test(`at ${String(width)}: Home's empty state and the task list page say Work, never Live (decision 125)`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, "home", {});
  await request.post("/__mock/home-v2", { data: { mode: "empty" } });
  await page.goto("/app");
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  for (const link of await page.getByRole("link", { name: "See all in Work" }).all()) await expect(link).toHaveAttribute("href", "/app/work");
  await expect(page.locator("main")).not.toContainText(/\bLive\b/u);
  await evidenceShot(page, { path: `${shots}/home-empty-${String(width)}.png`, fullPage: true });
  await request.post("/__mock/scenario", { data: { name: "live" } });
  await page.goto("/app/live");
  await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();await expect(page.getByRole("heading", { name: "Live", level: 1 })).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/app/work");
  expect(await noSidewaysScroll(page)).toBe(true);
 });
}

// ---- The project page's Spending tab
async function openSpendingTab(page: Page) { await page.getByRole("tab", { name: "Spending" }).click();await expect(page.getByRole("tab", { name: "Spending", selected: true })).toBeVisible(); }
for (const width of [1280, 390] as const) {
 test(`at ${String(width)}: a maintainer sees spent, held and left; totals only; axe clean in both themes`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, "project", {});await request.post("/__mock/project-spend?variant=ok");await page.goto("/app/projects/payments");
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
 await enter(page, context, request, baseURL, 390, "project", {});
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
/** WebKit scrolls a focused control into view a few frames after focus() or Tab, not at once: wait until the scroll position has held still for 4 reads, 50 ms apart (at most 3 s), before measuring. */
async function settled(page: Page) {
 let last = -1, still = 0;
 for (let read = 0; read < 60 && still < 4; read++) { const now = await page.evaluate(() => window.scrollY);still = now === last ? still + 1 : 0;last = now;await page.waitForTimeout(50); }
}
/** Everything the tab bar could hide: the end of the page, the last control after focus, any other fixed or sticky box in its band, and a toast. */
async function belowTabBar(page: Page) {
 await expect(page.locator(".rv-tabbar")).toBeVisible();await page.waitForLoadState("networkidle");
 await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
 const problems: string[] = await page.evaluate(() => {
  const bar = document.querySelector(".rv-tabbar")!.getBoundingClientRect(), problems: string[] = [];
  const last = document.querySelector("main")!.lastElementChild!;if (last.getBoundingClientRect().bottom > bar.top) problems.push("the end of the page is under the tab bar");
  // Any other fixed or sticky box that reaches into the bar's band (modal overlays only exist while open, and sit above the bar by design).
  for (const node of document.querySelectorAll<HTMLElement>("body *")) {
   const style = getComputedStyle(node);if ((style.position !== "fixed" && style.position !== "sticky") || node.closest(".rv-tabbar") !== null || style.display === "none" || style.visibility === "hidden") continue;
   const box = node.getBoundingClientRect();if (box.width > 0 && box.height > 0 && box.bottom > bar.top + 0.5 && box.top < bar.bottom) problems.push("fixed or sticky box in the bar's band: " + node.tagName + "." + node.className);
  }
  // A toast (fixed at the bottom right) sits above the bar.
  const toast = document.createElement("div");toast.className = "rv-toast";toast.setAttribute("role", "status");toast.textContent = "Saved";document.body.append(toast);
  const toastBox = toast.getBoundingClientRect();if (toastBox.bottom > bar.top + 0.5) problems.push("the toast is under the tab bar");toast.remove();
  return problems;
 });
 // The last control of the page, focused, ends above the bar (scroll padding keeps it clear).
 const found = await page.evaluate(() => {
  const controls = [...document.querySelectorAll<HTMLElement>("main a[href], main button:not([disabled]), main input:not([type=hidden]):not([disabled]), main select, main textarea, main summary, main [role=tab]")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); });
  const control = controls[controls.length - 1];if (control === undefined) return false;
  window.scrollTo(0, 0);control.focus();return true;
 });
 if (!found) problems.push("no control found");
 else {
  await settled(page);
  const under = await page.evaluate(() => { const control = document.activeElement as HTMLElement, bar = document.querySelector(".rv-tabbar")!.getBoundingClientRect();return control.getBoundingClientRect().bottom > bar.top + 0.5 ? control.tagName + " " + (control.textContent ?? "").slice(0, 30) : undefined; });
  if (under !== undefined) problems.push("the last control is under the tab bar after focus: " + under);
 }
 return problems;
}
for (const target of [
 { name: "the task page", scenario: "workspace", path: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", ready: (page: Page) => expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible() },
 { name: "the task page with its lead header", scenario: "workspace", path: "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa", ready: (page: Page) => expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible() },
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
 { name: "the project page", scenario: "project", path: "/app/projects/payments", min: 10, ready: (page: Page) => expect(page.getByRole("heading", { name: "payments", level: 1 })).toBeVisible() },
 { name: "a settings page", scenario: "admin", path: "/app/admin/money/budgets", min: 5, ready: (page: Page) => expect(page.getByRole("table", { name: "Spending requests waiting" })).toBeVisible() },
] as const) {
 test(`new navigation on a phone, ${target.name}: keyboard focus never ends under the tab bar`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 390, target.scenario, { ...NAV, ...(target.scenario === "admin" ? {} : {}) });await page.goto(target.path);await target.ready(page);await page.waitForLoadState("networkidle");
  const hidden: string[] = [], seen = new Set<string>();
  for (let step = 0; step < 150; step++) {
   await page.keyboard.press("Tab");
   const stop = await page.evaluate(async () => { /* WebKit scrolls the focused control into view a few frames after Tab: wait for the scroll to hold still for 3 frames (at most 60) */await new Promise<void>(resolve => { let last = -1, still = 0, frames = 0;const tick = () => { frames++;still = window.scrollY === last ? still + 1 : 0;last = window.scrollY;if (still >= 3 || frames >= 60) resolve();else requestAnimationFrame(tick); };requestAnimationFrame(tick); });const node = document.activeElement as HTMLElement | null, bar = document.querySelector(".rv-tabbar")!.getBoundingClientRect();if (node === null || node === document.body || node.closest(".rv-tabbar") !== null || node.closest("header") !== null) return undefined;const box = node.getBoundingClientRect();/* a tall scroll region counts as clear when its top 20px are above the bar */return { name: node.tagName + " " + (node.textContent ?? "").slice(0, 30), at: Math.round(box.top + window.scrollY), under: Math.min(box.bottom, bar.top) - Math.max(box.top, 0) < Math.min(box.height, 20) }; });
   if (stop === undefined) continue;
   seen.add(stop.name + "@" + String(stop.at));if (stop.under) hidden.push(stop.name);
  }
  // Distinct controls, not Tab presses: Chromium wraps round to the top of the page and Firefox stays on the tab bar, so the count of presses says nothing about the page.
  // WebKit's Tab key skips links and buttons unless the system is set to tab to them (macOS Safari's default), so there the walk only has to find something.
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  expect(seen.size, "the walk found the controls in the page").toBeGreaterThanOrEqual(webkit ? 1 : target.min);expect(hidden).toEqual([]);
 });
}
