import type { APIRequestContext, BrowserContext, Page, Request } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
import * as fx from "../web/support/trial-billing-fixture.js";
// The trial allowance, the trial-end choices and Settings > Billing (switch `rovara.billing` = "v2"). Every answer is a fixture in the real server contract's shapes (packages/contracts/src/app-billing.ts), fed through page.route. Pictures go to
// .test-build/web-e2e/trial-billing/ (ROVARA_BILLING_SHOTS changes the folder). Off, nothing of this exists.
const shots = process.env.ROVARA_BILLING_SHOTS ?? ".test-build/web-e2e/trial-billing";
interface Fixtures { trial?: unknown; billing?: unknown; invoices?: unknown; billingStatus?: number; post?: { status: number; body: unknown } }
const seen: string[] = [];
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, fixtures: Fixtures = {}, colorScheme: "light" | "dark" = "light") {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 seen.length = 0;page.on("request", (value: Request) => { seen.push(value.method() + " " + new URL(value.url()).pathname); });
 await page.route("**/v1/web/trial", route => fixtures.trial === undefined ? route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "none" } } }) : route.fulfill({ json: fixtures.trial }));
 await page.route(/\/v1\/web\/org\/billing(\?.*)?$/u, route => {
  if (route.request().method() === "POST") return route.fulfill(fixtures.post === undefined ? { status: 200, json: { status: "done", state: fixtures.billing } } : { status: fixtures.post.status, json: fixtures.post.body });
  return fixtures.billingStatus === 404 || fixtures.billing === undefined ? route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "none" } } }) : route.fulfill({ json: fixtures.billing });
 });
 await page.route(/\/v1\/web\/org\/billing\/invoices/u, route => route.fulfill({ json: fixtures.invoices ?? fx.invoicePage(1, 2) }));
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a), main button, main input, main select, main textarea, main summary, main [role=tab]")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
async function focusVisible(page: Page) {
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
}
const billingCalls = () => seen.filter(line => /\/v1\/web\/(trial|org\/billing)/u.test(line));
const bannerOf = (page: Page) => page.getByRole("region", { name: "Trial allowance" });

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's app, no banner, no Billing link, no trial page, no billing read`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, {}, { trial: fx.ended(true), billing: fx.billed() });await page.goto("/app/admin");
  await expect(page.getByRole("heading", { name: "Company settings", level: 1 })).toBeVisible();
  if (width < 768) await page.getByRole("button", { name: "Settings menu" }).click();
  await expect(page.getByRole("link", { name: "Spending" })).toBeVisible();await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);
  await expect(bannerOf(page)).toHaveCount(0);await page.waitForLoadState("networkidle");
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: true });
  await page.goto("/app/trial");await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  await page.goto("/app/admin/billing");await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  expect(billingCalls()).toEqual([]);
 });
}

for (const width of [1280, 390] as const) {
 test(`switch on at ${String(width)}: near the end an admin sees a gentle banner and follows Choose what happens next`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, { "rovara.billing": "v2" }, { trial: fx.nearEnd() });await page.goto("/app/admin");
  const banner = bannerOf(page);await expect(banner).toContainText("Your trial allowance is running low");await expect(banner).toContainText("AI models: $7.50 left");
  expect(await noSidewaysScroll(page)).toBe(true);
  // The settings overview underneath is not this lane's: only the banner's own controls are measured here.
  expect(await banner.getByRole("link").evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)).filter(height => height < 44))).toEqual([]);
  await evidenceShot(page, { path: `${shots}/near-end-${String(width)}.png`, fullPage: true });await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await banner.getByRole("link", { name: "Choose what happens next" }).click();
  await expect(page.getByRole("heading", { name: "Your trial", level: 1 })).toBeFocused();await expect(bannerOf(page)).toHaveCount(0);
  const allowances = page.getByRole("list", { name: "Allowances" });await expect(allowances).toContainText("85% used");await expect(allowances).toContainText("One-time allowance. It does not renew.");
  await expect(page.getByRole("button", { name: "Connect your own AI key" })).toBeEnabled();
  expect(await noSidewaysScroll(page)).toBe(true);if (width < 768) expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/trial-near-end-${String(width)}.png`, fullPage: true });await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  expect(await focusVisible(page)).not.toBe("hidden");
 });
}

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 test(`trial ended, an owner (${look.name} at 390): three choices with buttons`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 390, { ...look.store, "rovara.billing": "v2" }, { trial: fx.ended(true), billing: fx.billing({ phase: "ended" }) });await page.goto("/app/admin");
  await expect(bannerOf(page)).toContainText("Your trial allowance is used up");await expect(bannerOf(page).getByRole("link", { name: "Choose what happens next" })).toBeVisible();
  await page.goto("/app/trial");
  await expect(page.getByRole("heading", { name: "What happens when the allowance runs out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toBeDisabled();await expect(page.getByRole("button", { name: "Turn on auto-billing" })).toBeDisabled();await expect(page.getByRole("button", { name: "Connect your own AI key" })).toBeEnabled();
  await expect(page.getByText("Ask an admin.")).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/ended-owner-${look.name}-390.png`, fullPage: true });await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await page.getByRole("button", { name: "Connect your own AI key" }).click();
  await expect(page).toHaveURL(/\/app\/admin\/models/u);
 });
}

test("personal limit used up, a member (1280): the server's notice, Ask an admin and the names it sends; no members read", async ({ page, context, request, baseURL }) => {
 const trial = fx.trial({ you: fx.you({ member: { limitUsd: 29, spentUsd: 29, committedUsd: 29 }, hitLimit: true, notice: fx.PERSONAL_NOTICE }), admins: fx.admins() });
 await enter(page, context, request, baseURL, 1280, { "rovara.billing": "v2" }, { trial });
 await request.post("/__mock/admin-role");await page.goto("/app/trial");
 const notice = page.getByRole("region", { name: "Your personal limit" });
 await expect(notice).toContainText("Your personal limit is used up for this month.");await expect(notice).toContainText("Ask an admin.");await expect(notice).toContainText("Priya, Maya");
 await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
 expect(seen.filter(line => line.endsWith("/org/members"))).toEqual([]);
 expect(await noSidewaysScroll(page)).toBe(true);
 await evidenceShot(page, { path: `${shots}/personal-limit-member-1280.png`, fullPage: true });await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});

test("trial ended, a member (390, dark): the same facts, no buttons, Ask an admin with the admins' names", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.look": "v2", "rovara.billing": "v2" }, { trial: fx.ended(false) }, "dark");
 await request.post("/__mock/admin-role");await page.goto("/app/account");
 await expect(bannerOf(page)).toContainText("Ask an admin to choose what happens next.");await expect(bannerOf(page).getByRole("link", { name: "See details" })).toBeVisible();
 await bannerOf(page).getByRole("link", { name: "See details" }).click();
 await expect(page.getByRole("heading", { name: "What happens when the allowance runs out" })).toBeVisible();
 await expect(page.getByRole("heading", { name: "Stop" })).toBeVisible();await expect(page.getByRole("heading", { name: "Connect your own AI key" })).toBeVisible();
 await expect(page.getByRole("main").getByRole("button")).toHaveCount(0);
 await expect(page.locator(".rv-tb-ask")).toContainText("Priya, Maya");
 expect(seen.filter(line => line.endsWith("/org/members"))).toEqual([]);
 expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
 await evidenceShot(page, { path: `${shots}/ended-member-v2-dark-390.png`, fullPage: true });await checkA11y(page, { theme: "dark" });await checkA11y(page, { theme: "light" });
});

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`Billing page, ${look.name} at ${String(width)}: plan, masked card, limit, invoices; ${phone ? "one column, 44px targets, " : ""}no sideways scroll, axe clean, visible focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.billing": "v2" }, { trial: fx.active(), billing: fx.billed() });await page.goto("/app/admin/billing");
   await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();await expect(page.getByRole("table", { name: "Invoices" })).toBeVisible();
   if (look.name === "look-v2") await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
   const method = page.getByRole("region", { name: "Payment method" });await expect(method).toContainText("Visa ending 4242");await expect(method).toContainText("12/2028");
   await expect(page.getByRole("region", { name: "Monthly limit" })).toContainText("$500.00");await expect(page.getByRole("region", { name: "Monthly limit" }).getByRole("link", { name: /Spending page/ })).toHaveAttribute("href", "/app/admin/money/budgets");
   await expect(page.getByRole("table", { name: "Invoices" })).toContainText("RV-2026-0001");await expect(page.getByRole("table", { name: "Invoices" })).toContainText("$123.45");
   // The browser never handles a card: the only field on the page is the billing email.
   expect(await page.locator("main input, main select, main textarea").evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).type))).toEqual(["email"]);
   await expect(page.locator("main")).not.toContainText(/undefined|NaN|\d{5,}/u);
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) expect(await smallTargets(page)).toEqual([]);
   await evidenceShot(page, { path: `${shots}/billing-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
 }
}

test("Billing page at 390: no provider yet, and a server with billing switched off, say so plainly", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.billing": "v2" }, { trial: fx.active(), billing: fx.unavailable() });await page.goto("/app/admin/billing");
 await expect(page.getByText(/Payment methods and invoices aren't available on this install yet/)).toBeVisible();await expect(page.getByRole("heading", { name: "Invoices" })).toHaveCount(0);
 expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
 await evidenceShot(page, { path: `${shots}/billing-no-provider-390.png`, fullPage: true });await checkA11y(page, { theme: "light" });
 await enter(page, context, request, baseURL, 390, { "rovara.billing": "v2" }, { trial: fx.active(), billingStatus: 404 });await page.goto("/app/admin/billing");
 await expect(page.getByRole("main").getByRole("status").filter({ hasText: "Billing isn't turned on for this install." })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/billing-server-off-390.png`, fullPage: true });await checkA11y(page, { theme: "dark" });
});

test("Billing page: Change opens the provider's own page in a new tab; the request carries no card data; a stale-sign-in refusal offers sign in", async ({ page, context, request, baseURL }) => {
 const hosted = "https://pay.example/hosted/setup-1";
 await context.route("https://pay.example/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Provider</title><p>Provider page</p>" }));
 await enter(page, context, request, baseURL, 1280, { "rovara.billing": "v2" }, { trial: fx.active(), billing: fx.billed(), post: { status: 200, body: { status: "needs_action", state: fx.billed(), action: { kind: "redirect", url: hosted, expiresAt: "2026-11-11T13:00:00.000Z" } } } });
 const bodies: string[] = [];page.on("request", value => { if (value.method() === "POST" && /\/org\/billing$/u.test(value.url())) bodies.push(value.postData() ?? ""); });
 await page.goto("/app/admin/billing");
 const popup = page.waitForEvent("popup");await page.getByRole("button", { name: "Change payment method" }).click();
 expect((await popup).url()).toBe(hosted);
 expect(bodies).toHaveLength(1);const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
 expect(Object.keys(body).sort()).toEqual(["action", "requestId", "returnPath"]);expect(body.action).toBe("payment-method-setup");expect(String(body.returnPath)).toMatch(/^\/app\/admin\/billing/u);
 await expect(page.getByRole("link", { name: "Open the secure page" })).toHaveAttribute("href", hosted);
 await page.unroute(/\/v1\/web\/org\/billing(\?.*)?$/u);
 await page.route(/\/v1\/web\/org\/billing(\?.*)?$/u, route => route.request().method() === "POST" ? route.fulfill({ status: 403, json: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to change the payment method." } } }) : route.fulfill({ json: fx.billed() }));
 await page.getByRole("button", { name: "Change payment method" }).click();
 await expect(page.getByRole("alert")).toContainText("Sign in again to change the payment method.");await expect(page.getByRole("alert").getByRole("button", { name: "Sign in again" })).toBeVisible();
 await checkA11y(page, { theme: "light" });
});
