import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Runtime per-company UI flags (lane U5): the company's value from the nav answer turns a new screen on with no device key, and Settings > New screens changes it.
// Pictures go to .superpowers/sdd/exp-ui-flags/shots/ (set ROVARA_UIFLAGS_SHOTS to change the folder).
const shots = process.env.ROVARA_UIFLAGS_SHOTS ?? ".superpowers/sdd/exp-ui-flags/shots";
const NAMES = ["look", "nav", "home", "work", "spending", "leadingHeader", "health", "setup", "insights", "publish", "billing", "agreement", "companies", "continue"];
const states = (over: Record<string, string>) => Object.fromEntries(NAMES.map(name => [name, over[name] ?? "off"]));
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, options: { uiFlags?: Record<string, string>; store?: Record<string, string>; colorScheme?: "light" | "dark" } = {}) {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: options.colorScheme ?? "light", reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, options.store ?? {});
 // The company's flags ride the real nav answer (the browser sends `/v1/app/x` as `/v1/web/x`): fetch it, add `uiFlags` (an older server sends none).
 if (options.uiFlags !== undefined) await page.route("**/v1/web/nav*", async route => { const response = await route.fetch();const body = await response.json() as Record<string, unknown>;await route.fulfill({ response, json: { ...body, uiFlags: options.uiFlags } }); });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a), main button, main input, main select, main textarea, main summary")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
async function focusVisible(page: Page) {
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
}
const row = (name: string, label: string, over: Record<string, unknown> = {}) => ({ name, label, summary: `What ${label} turns on for people.`, wired: true, enabled: false, forcedOff: false, state: "off", ...over });
function adminFixture() {
 const state = { revision: 3, previews: false, changedAt: "2026-11-11T12:00:00.000Z", flags: [row("look", "New look", { enabled: true, state: "on" }), row("nav", "New navigation", { state: "preview" }), row("home", "New Home"), row("work", "Work list"), row("spending", "Spending page", { enabled: true, forcedOff: true }), row("leadingHeader", "Task page summary"), row("health", "Health page", { wired: false })] };
 return state;
}
async function adminRoutes(page: Page, put: Array<unknown>, fail?: { status: number; code: string; message: string }) {
 const state = adminFixture();
 await page.route("**/v1/web/org/ui-flags*", async route => {
  if (route.request().method() === "PUT") {
   const body = route.request().postDataJSON() as { expectedRevision: number; flags?: Record<string, boolean>; previews?: boolean };put.push(body);
   if (fail !== undefined) { await route.fulfill({ status: fail.status, json: { error: { code: fail.code, message: fail.message } } });return; }
   for (const [name, value] of Object.entries(body.flags ?? {})) { const entry = state.flags.find(flag => flag.name === name);if (entry !== undefined) { entry.enabled = value;entry.state = value ? "on" : "off"; } }
   if (body.previews !== undefined) state.previews = body.previews;state.revision += 1;
  }
  await route.fulfill({ json: state });
 });
}

test("an older server (no uiFlags) leaves the app as it was: the old look and navigation, and the device keys still turn them on", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280);await page.goto("/app/admin");
 await expect(page.getByRole("heading", { name: "Company settings", exact: true })).toBeVisible();await page.waitForLoadState("networkidle");
 await expect(page.locator("html")).not.toHaveAttribute("data-look", /.*/u);await expect(page.locator(".rv-nav-v2")).toHaveCount(0);
 const on = await context.newPage();await on.addInitScript(() => { localStorage.setItem("rovara.look", "v2"); });await mockRealtime(on);await on.goto("/app/admin");
 await expect(on.locator("html")).toHaveAttribute("data-look", "v2");
});

test("uiFlags.look = on shows the new look with no device key, and the company's off beats a device key", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { uiFlags: states({ look: "on", nav: "on" }) });await page.goto("/app/admin");
 await expect(page.getByRole("heading", { name: "Company settings", exact: true })).toBeVisible();
 await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
 await expect(page.locator(".rv-app-shell.rv-nav-v2")).toBeVisible();
 const off = await context.newPage();await off.addInitScript(() => { localStorage.setItem("rovara.look", "v2"); });
 await off.route("**/v1/web/nav*", async route => { const response = await route.fetch();const body = await response.json() as Record<string, unknown>;await route.fulfill({ response, json: { ...body, uiFlags: states({ look: "off" }) } }); });
 await mockRealtime(off);await off.goto("/app/admin");
 await expect(off.getByRole("heading", { name: "Company settings", exact: true })).toBeVisible();await expect(off.locator("html")).not.toHaveAttribute("data-look", /.*/u);
 const preview = await context.newPage();await preview.addInitScript(() => { localStorage.setItem("rovara.look", "v2"); });
 await preview.route("**/v1/web/nav*", async route => { const response = await route.fetch();const body = await response.json() as Record<string, unknown>;await route.fulfill({ response, json: { ...body, uiFlags: states({ look: "preview" }) } }); });
 await mockRealtime(preview);await preview.goto("/app/admin");
 await expect(preview.locator("html")).toHaveAttribute("data-look", "v2");
});

for (const colorScheme of ["light", "dark"] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`Settings > New screens at ${String(width)}, ${colorScheme}: list, 44px targets, no sideways scroll, axe clean, visible focus`, async ({ page, context, request, baseURL }) => {
   const put: unknown[] = [];
   await enter(page, context, request, baseURL, width, { colorScheme });await adminRoutes(page, put);await page.goto("/app/admin/new-screens");
   await expect(page.getByRole("heading", { name: "New screens", level: 1 })).toBeVisible();
   const list = page.getByRole("list", { name: "New screens" });await expect(list.getByRole("listitem")).toHaveCount(6);
   await expect(list).toContainText("On for everyone in");await expect(list).toContainText("Turned off by the Rovara operator");await expect(page.getByText("Health page")).toHaveCount(0);
   await expect(page.getByText(/Preview lets each person try a screen in their own browser first/)).toBeVisible();
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) expect(await smallTargets(page)).toEqual([]);
   expect(await focusVisible(page)).not.toBe("hidden");
   await checkA11y(page, { theme: colorScheme });
   await evidenceShot(page, { path: `${shots}/new-screens-${colorScheme}-${String(width)}.png`, fullPage: true });
   expect(put).toEqual([]);
  });
 }
}

test("turning a screen on sends one revision-fenced change; a conflict and a stale sign-in are shown, not repeated", async ({ page, context, request, baseURL }) => {
 const put: unknown[] = [];
 await enter(page, context, request, baseURL, 390);await adminRoutes(page, put);await page.goto("/app/admin/new-screens");
 await page.getByRole("button", { name: "Turn on New Home for everyone" }).click();
 await expect(page.getByText(/Saved\. Takes effect when people next open or reload the app\./)).toBeVisible();
 expect(put).toEqual([{ expectedRevision: 3, flags: { home: true } }]);
 await expect(page.getByRole("button", { name: "Turn off New Home for everyone" })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/new-screens-saved-390.png`, fullPage: true });
 for (const fail of [{ status: 409, code: "CHANGE_STALE", message: "Someone else changed this. Reload and try again.", shows: "Someone else changed this; reload.", button: "Reload" }, { status: 403, code: "REAUTH_REQUIRED", message: "Sign in again to change company screens.", shows: "Sign in again to change company screens.", button: "Sign in again" }]) {
  const next = await context.newPage();const calls: unknown[] = [];await mockRealtime(next);await next.setViewportSize({ width: 390, height: 900 });await adminRoutes(next, calls, fail);await next.goto("/app/admin/new-screens");
  await next.getByRole("button", { name: "Turn on Work list for everyone" }).click();
  await expect(next.getByRole("alert")).toContainText(fail.shows);await expect(next.getByRole("button", { name: fail.button })).toBeVisible();
  expect(calls).toHaveLength(1);await checkA11y(next, { theme: "light" });
  await evidenceShot(next, { path: `${shots}/new-screens-${fail.code.toLowerCase()}-390.png`, fullPage: true });
 }
});
