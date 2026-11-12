import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { playbook, policy, rules } from "../web/support/agreement-fixture.js";
// The Working agreement is off unless storage says so (`rovara.agreement` = "v2"). Off, the project's How we work tab is today's. On, in the old look and the v2 look, at phone and desktop widths: every rule has an origin, a lock says
// why, nothing scrolls sideways, every control is 44px tall on a phone, the page passes axe in both themes and focus is visible. Pictures go to .test-build/web-e2e/agreement/ (ROVARA_AGREEMENT_SHOTS changes the folder, for before/after comparisons).
const shots = process.env.ROVARA_AGREEMENT_SHOTS ?? ".test-build/web-e2e/agreement", cookie = "11111111-1111-4111-8111-111111111111";
async function enter(page: Page, context: BrowserContext, request: Parameters<Parameters<typeof test>[2]>[0]["request"], baseURL: string | undefined, width: number, store: Record<string, string>, options: { missing?: boolean } = {}) {
 await request.post("/__mock/scenario", { data: { name: "project" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.addInitScript(entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, store);
 // The reads this panel adds that the mock cell does not answer itself (the project's design review setting, the known failing policy, the company rules count).
 await page.route("**/v1/web/projects/payments/playbook", route => options.missing === true ? route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } }) : route.fulfill({ json: playbook() }));
 await page.route("**/v1/web/org/known-failing-policy", route => route.fulfill({ json: policy({ pendingLoosening: true }) }));
 // The nav answer says company rules are on (`features.companyRules`) unless this install is the "missing" one; the count is read from the member route or the admin route, whichever this person's role uses.
 await page.route("**/v1/web/nav", async route => { const answer = await route.fetch(), body = await answer.json() as { features: Record<string, unknown> };await route.fulfill({ response: answer, json: options.missing === true ? body : { ...body, features: { ...body.features, companyRules: true } } }); });
 await page.route(/\/v1\/web\/org\/company-rules(\/current)?$/u, route => options.missing === true ? route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } }) : route.fulfill({ json: rules(2, 1) }));
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
// Visible controls of the panel under 44px tall. A link inside a sentence is exempt (WCAG 2.5.8); every other link, button and summary counts.
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".rv-agree a:not(p a), .rv-agree button, .rv-agree summary")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + ":" + (node.textContent ?? "").trim().slice(0, 30)));
const focusVisible = async (page: Page) => { await page.locator(".rv-agree summary").first().focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? "visible" : "hidden"; }); };
const PAGE = "/app/projects/payments?tab=how-we-work";
for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's How we work tab, none of the panel`, async ({ page, context, request, baseURL }) => {
  const chunks: string[] = [];page.on("request", asked => { if (/WorkingAgreement|agreement\.css/u.test(asked.url())) chunks.push(asked.url()); });
  const asks: string[] = [];page.on("request", asked => { if (/^\/v1\/.*(?:company-rules|known-failing-policy)/u.test(new URL(asked.url()).pathname)) asks.push(asked.url()); }); // API paths only: a JS chunk is also named company-rules-<hash>.js (shared module the project page loads), and that is not a read
  await enter(page, context, request, baseURL, width, {});await page.goto(PAGE);
  await expect(page.getByRole("heading", { name: "Build", exact: true })).toBeVisible();await page.waitForLoadState("networkidle");
  await expect(page.locator(".rv-agree")).toHaveCount(0);await expect(page.getByRole("heading", { name: "Working agreement" })).toHaveCount(0);
  expect(chunks, "the panel's chunk and sheet are not requested while the switch is off").toEqual([]);expect(asks, "none of the panel's reads are made while the switch is off").toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: true });
 });
}
for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`switch on, ${look.name} at ${String(width)}: origins, locks, pending, ${phone ? "stacked rows, 44px targets, " : ""}no sideways scroll, axe, focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.agreement": "v2" });await page.goto(PAGE);
   const panel = page.locator(".rv-agree");
   await expect(panel.getByRole("heading", { name: "Working agreement", level: 2 })).toBeVisible();
   await expect(panel.getByText("3 company rules apply (2 required, 1 preferred)")).toBeVisible();
   await expect(panel.getByText("Waiting for a second admin")).toBeVisible();
   // Every row names its origin, and a lock is the accent chip with a lock icon.
   const rows = panel.locator(".rv-agree-row");expect(await rows.count()).toBeGreaterThan(6);
   // The reads that give a value only (lessons, learning, known failing tests, company rules) have no chip; no row says "Origin unknown" in this cell.
   expect(await panel.locator(".rv-agree-row:not(:has(.rv-chip))").count()).toBe(await panel.locator('.rv-agree-row[data-origin="none"]').count());
   await expect(panel.getByText("Origin unknown")).toHaveCount(0);
   await expect(panel.locator(".rv-chip-company-lock svg").first()).toBeVisible();
   // "Why?" explains the lock.
   const skip = panel.locator(".rv-agree-row", { hasText: "Design review: skipping" });
   // The disclosure keeps a marker (the sheet draws an arrow before the word), and its accessible name says which rule it is for.
   expect(await skip.locator("summary").evaluate(node => getComputedStyle(node, "::before").content)).not.toBe("none");
   await expect(skip.getByLabel("Why is Design review: skipping locked?")).toBeVisible();
   await skip.getByText("Why?").click();await expect(skip.getByText("Your company set this, and a project can't change it.")).toBeVisible();
   // The order on the page: the panel is above the existing stage cards.
   const tops = await page.evaluate(() => [document.querySelector(".rv-agree")!, document.querySelector(".rv-hww-cards")!].map(node => node.getBoundingClientRect().top));expect(tops[0]!).toBeLessThan(tops[1]!);
   // A phone shows each row in one column: the origin is under the rule, not beside it.
   const box = await skip.evaluate(node => { const text = node.querySelector(".rv-agree-text")!.getBoundingClientRect(), meta = node.querySelector(".rv-agree-meta")!.getBoundingClientRect();return { sameRow: Math.abs(text.top - meta.top) < 4 && meta.left > text.left }; });
   expect(box.sameRow).toBe(!phone);
   // No raw code and no model id reaches the panel.
   expect((await panel.textContent()) ?? "").not.toMatch(/claude-|gpt-|COMPANY_LOCK|BUILTIN_DEFAULT|company-lock|rovara-fixed|undefined/u);
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) expect(await smallTargets(page)).toEqual([]);
   await evidenceShot(page, { path: `${shots}/on-${look.name}-${String(width)}.png`, fullPage: true });
   // A step opened shows its rules (also checked by axe below).
   await panel.locator(".rv-agree-step summary").first().click();await expect(panel.locator(".rv-agree-step[open] .rv-agree-row").first()).toBeVisible();
   if (phone) expect(await smallTargets(page)).toEqual([]);
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).toBe("visible");
  });
 }
}
test("switch on with sources the install does not have: they are listed as Not available yet and nothing is invented", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.agreement": "v2" }, { missing: true });await page.goto(PAGE);
 const missing = page.locator(".rv-agree").getByRole("list", { name: "Not shown yet" });
 await expect(missing.getByText("Company rules")).toBeVisible();await expect(missing.getByText("Design review")).toBeVisible();await expect(missing.getByText(/^Merge rules/u)).toBeVisible();
 await expect(missing.getByText("Not available yet").first()).toBeVisible();
 await expect(page.locator(".rv-agree-row", { hasText: "Company rules" })).toHaveCount(0);
 expect(await noSidewaysScroll(page)).toBe(true);
 await evidenceShot(page, { path: `${shots}/on-missing-390.png`, fullPage: true });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});
