import type { Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { COMPANIES, MACHINE_REFUSAL, ORG_A, ORG_B, mockCompanies } from "./support/companies-mock.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// The company switcher (switch: localStorage `rovara.companies` = "v2"). Off: the header is today's and the companies route is never called. On with one company: the header looks the same as off.
// On with three: a menu of companies; switching from Acme to Beta Ltd opens Beta's Home with nothing of Acme's on the page; a link for another company asks first; the phone's Menu has the same list.
// Set ROVARA_COMPANY_SHOTS to a folder for the pictures.
const shots = process.env.ROVARA_COMPANY_SHOTS ?? ".test-build/web-e2e/companies";
const LOOKS = [{ name: "look-v2", store: {} as Record<string, string> }] as const;
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
async function enter(page: Page, { context, request, baseURL }: Pick<Fixtures, "context" | "request" | "baseURL">, store: Record<string, string>, width: number) {
 await request.post("/__mock/scenario", { data: { name: "home" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
 await page.addInitScript(values => { if (sessionStorage.getItem("__seeded") === null) { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);sessionStorage.setItem("__seeded", "1"); } }, { "rovara.theme": "light", ...store });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const homeReady = (page: Page, name: string) => expect(page.getByRole("heading", { name: name + ": Review the duplicate-refund fix" })).toBeVisible();
const noneOf = async (page: Page, words: string[]) => { const text = await page.evaluate(() => document.body.innerText + " " + document.documentElement.innerHTML); for (const word of words) expect(text.includes(word), word).toBe(false); };
for (const width of [1280, 390] as const) {
 test(`off at ${String(width)}: today's header, no companies call, no company header, and one company on looks the same`, async ({ page, context, request, baseURL, browserName }) => {
  await enter(page, { context, request, baseURL }, {}, width);
  // WebKit takes a screenshot by adding a <style> element, which the page's CSP refuses and the CSP guard reports (support/screenshot.ts): on WebKit the
  // byte-for-byte picture comparison is skipped, and the header's text and markup are compared instead (on every browser).
  const pixels = browserName !== "webkit";
  const headerOf = () => page.locator("header").first().evaluate(node => node.outerHTML);
  const mock = await mockCompanies(page, { companies: [COMPANIES[0]!] });
  await page.goto("/app");await homeReady(page, "Acme");await page.waitForLoadState("networkidle");
  expect(mock.companyReads()).toHaveLength(0);for (const apiRequest of mock.requests()) expect(await apiRequest.headerValue("x-rovara-company"), apiRequest.url()).toBeNull();
  await expect(page.locator("header .rv-company-button, .rv-company-list, .rv-company-gate")).toHaveCount(0);
  if (width > 767) expect(await page.locator(".rv-shell-org").evaluate(node => node.outerHTML)).toBe('<span class="rv-shell-org">Acme</span>');
  expect(await noSidewaysScroll(page)).toBe(true);
  const off = pixels ? await page.screenshot({ fullPage: false }) : undefined;const offHeader = await headerOf();await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: false });
  // The same page with the switch on and one company: byte for byte the same picture, no button, no chevron, no extra request but the companies read.
  await page.evaluate(() => { localStorage.setItem("rovara.companies", "v2"); });await page.reload();await homeReady(page, "Acme");await page.waitForLoadState("networkidle");
  expect(mock.companyReads().length).toBeGreaterThan(0);
  await expect(page.locator("header .rv-company-button, .rv-company-chevron")).toHaveCount(0);
  if (width > 767) expect(await page.locator(".rv-shell-org").evaluate(node => node.outerHTML)).toBe('<span class="rv-shell-org">Acme</span>');
  expect(await headerOf()).toBe(offHeader);
  if (off !== undefined) expect(Buffer.compare(await page.screenshot({ fullPage: false }), off)).toBe(0);
  await evidenceShot(page, { path: `${shots}/on-one-company-${String(width)}.png`, fullPage: false });
 });
}
for (const look of LOOKS) for (const nav of ["new"] as const) {
 test(`on, three companies, desktop, ${look.name}, ${nav} navigation: switch from Acme to Beta Ltd, Beta's Home shows and nothing of Acme's`, async ({ page, context, request, baseURL }) => {
  await enter(page, { context, request, baseURL }, { ...look.store, "rovara.companies": "v2", ["project-slack:v1:" + ORG_A + ":x"]: "{}" }, 1280);
  const mock = await mockCompanies(page);
  await page.goto("/app");await homeReady(page, "Acme");
  await expect(page.locator("aside").getByRole("link", { name: /acme-payments/u })).toBeVisible();
  // Every request after the first read says which company the page believes it is in.
  const withHeader = mock.requests().filter(apiRequest => !apiRequest.url().endsWith("/v1/web/companies") && !apiRequest.url().endsWith("/v1/web/me"));
  for (const apiRequest of withHeader) expect(await apiRequest.headerValue("x-rovara-company"), apiRequest.url()).toBe(ORG_A);
  const trigger = page.getByRole("button", { name: /Acme.*switch company/u });await expect(trigger).toBeVisible();await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await trigger.click();const menu = page.getByRole("menu");await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveText(["AcmeOwner✓", "Beta LtdMember", "GammaAuditor"]);
  await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveCount(1);
  const small = await menu.getByRole("menuitemradio").evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height < 44).length);expect(small).toBe(0);
  await evidenceShot(page, { path: `${shots}/menu-${look.name}-${nav}.png`, fullPage: false });
  // Escape closes it and focus goes back to the name.
  await page.keyboard.press("Escape");await expect(menu).toBeHidden();await expect(trigger).toBeFocused();
  await trigger.press("Enter");await expect(menu).toBeVisible();await page.keyboard.press("ArrowDown");await expect(menu.getByRole("menuitemradio").nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Beta Ltd: Review the duplicate-refund fix" })).toBeVisible();
  expect(mock.posts()).toEqual([expect.objectContaining({ action: "switch", companyId: ORG_B })]);expect(mock.active()).toBe(ORG_B);
  await expect(page.getByRole("button", { name: /Beta Ltd.*switch company/u })).toBeVisible();
  await expect(page.locator("aside").getByRole("link", { name: /beta-search/u })).toBeVisible();
  await noneOf(page, ["Acme", "acme-payments"]);
  // The page that opened is a new one (a reload), so its first requests already say Beta; the per-company draft the old page kept is gone from this device.
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("project-slack:v1:")))).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("rovara.companies"))).toBe("v2");expect(new URL(page.url()).pathname).toBe("/app");
  const after = mock.requests().filter(apiRequest => apiRequest.url().includes("/v1/web/home"));expect(await after.at(-1)!.headerValue("x-rovara-company")).toBe(ORG_B);
  await evidenceShot(page, { path: `${shots}/after-switch-${look.name}-${nav}.png`, fullPage: false });
 });
}
// Decision 98: the company's runtime flag `companies` rides the navigation answer. On shows the switcher with no device key; off gives today's header even with the key, and no company is named after the answer.
for (const [flag, store, shown] of [["on", {}, true], ["off", { "rovara.companies": "v2" }, false]] as const) {
 test(`the company's companies flag ${flag}${shown ? " with no device key" : " with the device key"}: ${shown ? "the switcher" : "today's header"}`, async ({ page, context, request, baseURL }) => {
  await enter(page, { context, request, baseURL }, store, 1280);
  const mock = await mockCompanies(page, { uiFlags: { companies: flag } });
  await page.goto("/app");await homeReady(page, "Acme");
  if (shown) {
   await expect(page.getByRole("button", { name: /Acme.*switch company/u })).toBeVisible();
   const home = mock.requests().filter(apiRequest => apiRequest.url().includes("/v1/web/home"));expect(await home.at(-1)!.headerValue("x-rovara-company")).toBe(ORG_A);
  } else {
   await page.waitForLoadState("networkidle");
   await expect(page.locator("header .rv-company-button, .rv-company-list, .rv-company-gate")).toHaveCount(0);
   expect(await page.locator(".rv-shell-org").evaluate(node => node.outerHTML)).toBe('<span class="rv-shell-org">Acme</span>');
   const home = mock.requests().filter(apiRequest => apiRequest.url().includes("/v1/web/home"));expect(home.length).toBeGreaterThan(0);
   for (const apiRequest of home) expect(await apiRequest.headerValue("x-rovara-company"), apiRequest.url()).toBeNull();
  }
 });
}
test("a link for another company asks first, and Stay and Switch both work", async ({ page, context, request, baseURL }) => {
 await enter(page, { context, request, baseURL }, { "rovara.companies": "v2" }, 1280);
 const mock = await mockCompanies(page);
 await page.goto("/app?company=" + ORG_B);
 const heading = page.getByRole("heading", { level: 1, name: "This link is for Beta Ltd. Switch to Beta Ltd?" });await expect(heading).toBeVisible();await expect(heading).toBeFocused();
 await expect(page.getByRole("button", { name: "Switch", exact: true })).toBeVisible();await expect(page.getByRole("button", { name: "Stay", exact: true })).toBeVisible();
 // Never shown under the wrong company: Acme's Home is not on the page, and neither is Beta's.
 await expect(page.getByText(/Review the duplicate-refund fix/u)).toHaveCount(0);
 expect(mock.requests().some(apiRequest => apiRequest.url().includes("/v1/web/home"))).toBe(false);
 await evidenceShot(page, { path: `${shots}/link-interstitial-1280.png`, fullPage: false });await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await page.getByRole("button", { name: "Stay", exact: true }).click();await homeReady(page, "Acme");expect(new URL(page.url()).search).toBe("");expect(mock.posts()).toEqual([]);
 await page.goto("/app?company=" + ORG_B);await page.getByRole("button", { name: "Switch", exact: true }).click();
 await homeReady(page, "Beta Ltd");expect(mock.posts()).toEqual([expect.objectContaining({ action: "switch", companyId: ORG_B })]);await noneOf(page, ["Acme"]);
});
test("a link for a company the person is not in gives one generic sentence", async ({ page, context, request, baseURL }) => {
 await enter(page, { context, request, baseURL }, { "rovara.companies": "v2" }, 1280);
 await mockCompanies(page);await page.goto("/app?company=org_" + "z".repeat(20));
 await expect(page.getByRole("heading", { level: 1, name: "You don't have access to this link" })).toBeVisible();
 await noneOf(page, ["Beta Ltd", "Gamma", "zzzzzzzz"]);await expect(page.getByRole("button", { name: "Switch", exact: true })).toHaveCount(0);await checkA11y(page, { theme: "light" });
});
test("a refused switch shows the server's sentence word for word and changes nothing", async ({ page, context, request, baseURL }) => {
 await enter(page, { context, request, baseURL }, { "rovara.companies": "v2" }, 1280);
 const mock = await mockCompanies(page, { refuse: { status: 403, code: "FORBIDDEN", message: MACHINE_REFUSAL } });
 await page.goto("/app");await homeReady(page, "Acme");
 await page.getByRole("button", { name: /switch company/u }).click();await page.getByRole("menuitemradio", { name: /Beta Ltd/u }).click();
 await expect(page.getByRole("alert")).toHaveText(MACHINE_REFUSAL);await expect(page.getByRole("dialog", { name: "Couldn't switch company" })).toBeVisible();await expect(page.getByRole("menu")).toHaveCount(0);expect(mock.active()).toBe(ORG_A);
 await evidenceShot(page, { path: `${shots}/refused-1280.png`, fullPage: false });await checkA11y(page, { theme: "light" });
 await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);await expect(page.getByRole("button", { name: /Acme.*switch company/u })).toBeFocused();await homeReady(page, "Acme");
});
for (const width of [390, 360] as const) for (const nav of ["new"] as const) {
 test(`phone ${String(width)}, ${nav} navigation: the top Menu lists the companies, 44px rows, no sideways scroll, and a switch works`, async ({ page, context, request, baseURL }) => {
  await enter(page, { context, request, baseURL }, { "rovara.companies": "v2" }, width);
  const mock = await mockCompanies(page);
  await page.goto("/app");await homeReady(page, "Acme");expect(await noSidewaysScroll(page)).toBe(true);
  await page.getByRole("button", { name: "Open workspace menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace" }), section = dialog.locator(".rv-company-list");await expect(section).toBeVisible();
  await expect(section.getByRole("button")).toHaveText(["AcmeOwner✓", "Beta LtdMember", "GammaAuditor"]);await expect(section.locator("[aria-current=true]")).toHaveCount(1);
  expect(await section.getByRole("button").evaluateAll(nodes => nodes.filter(node => { const rect = node.getBoundingClientRect();return rect.height < 44 || rect.width < 44; }).length)).toBe(0);
  expect(await noSidewaysScroll(page)).toBe(true);await expect(dialog.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await evidenceShot(page, { path: `${shots}/phone-menu-${String(width)}-${nav}.png`, fullPage: false });await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await section.getByRole("button", { name: /Beta Ltd/u }).click();
  await homeReady(page, "Beta Ltd");expect(mock.active()).toBe(ORG_B);await noneOf(page, ["Acme"]);expect(await noSidewaysScroll(page)).toBe(true);
 });
}
test("phone: a link for another company asks first, with 44px buttons and no sideways scroll", async ({ page, context, request, baseURL }) => {
 await enter(page, { context, request, baseURL }, { "rovara.companies": "v2" }, 390);
 await mockCompanies(page);await page.goto("/app?company=" + ORG_B);
 await expect(page.getByRole("heading", { level: 1, name: "This link is for Beta Ltd. Switch to Beta Ltd?" })).toBeVisible();
 expect(await page.locator(".rv-company-gate-actions button").evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().height < 44).length)).toBe(0);
 expect(await noSidewaysScroll(page)).toBe(true);await evidenceShot(page, { path: `${shots}/link-interstitial-390.png`, fullPage: false });await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});
for (const look of LOOKS) for (const nav of ["new"] as const) for (const theme of ["light", "dark"] as const) {
 test(`axe: the header menu open, ${look.name}, ${nav} navigation, ${theme}`, async ({ page, context, request, baseURL }) => {
  await enter(page, { context, request, baseURL }, { ...look.store, "rovara.companies": "v2", "rovara.theme": theme }, 1280);
  await mockCompanies(page);await page.goto("/app");await homeReady(page, "Acme");
  await page.getByRole("button", { name: /switch company/u }).click();await expect(page.getByRole("menu")).toBeVisible();
  await checkA11y(page, { theme });
 });
}
test("the two companies' ids never reach the page text", async ({ page, context, request, baseURL }) => {
 await enter(page, { context, request, baseURL }, { "rovara.companies": "v2" }, 1280);
 await mockCompanies(page);await page.goto("/app");await homeReady(page, "Acme");await page.getByRole("button", { name: /switch company/u }).click();await expect(page.getByRole("menu")).toBeVisible();
 expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/org_[0-9a-z]{20}/u);
});
