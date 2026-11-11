import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// "Continue in your own tool" (switch `rovara.continue` = "v2"): off, the task page has no button and never requests the panel's chunk or the lessons setting; on, at desktop and phone widths, the sheet shows the
// install command per tool, the prompt, the branch (or when it appears), what a push does and the lessons line; copy says Copied; focus stays in the sheet; Escape closes it; every control is 44px tall on a phone;
// axe finds nothing in both themes. Pictures go to .test-build/web-e2e/continue/ (ROVARA_CONTINUE_SHOTS changes the folder, for before/after comparisons).
const shots = process.env.ROVARA_CONTINUE_SHOTS ?? ".test-build/web-e2e/continue", cookie = "11111111-1111-4111-8111-111111111111", PAGE = "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa";
async function enter(page: Page, context: BrowserContext, request: Parameters<Parameters<typeof test>[2]>[0]["request"], baseURL: string | undefined, width: number, store: Record<string, string>) {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ reducedMotion: "reduce" });
 // A clipboard every browser has: the page's writeText lands in window.__copied.
 await page.addInitScript(entries => {
  for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  (window as unknown as { __copied: string[] }).__copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as unknown as { __copied: string[] }).__copied.push(text); } } });
 }, store);
 await page.route("**/v1/web/projects/payments/lessons/local-tools", route => route.fulfill({ json: { enabled: true, preset: "standard", companyStays: false } }));
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's task page, none of the panel`, async ({ page, context, request, baseURL }) => {
  const asked: string[] = [];page.on("request", item => { if (/ContinueInTool-|local-tools/u.test(item.url())) asked.push(item.url()); });
  await enter(page, context, request, baseURL, width, {});await page.goto(PAGE);
  await expect(page.getByRole("button", { name: "Conversation" })).toBeVisible();await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /Continue in your own tool/u })).toHaveCount(0);
  expect(asked, "the panel's chunk, its sheet and its reads are not requested while the switch is off").toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: true });
 });
}
for (const width of [360, 390, 1280] as const) {
 const phone = width < 768;
 test(`switch on at ${String(width)}: the sheet, copy, focus, Escape, ${phone ? "44px targets, " : ""}no sideways scroll, axe`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, { "rovara.continue": "v2" });await page.goto(PAGE);
  const button = page.getByRole("button", { name: "Continue in your own tool" });
  await expect(button).toBeVisible();await expect(page.getByRole("button", { name: "Conversation" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await button.click();
  const sheet = page.getByRole("dialog", { name: "Continue in your own tool" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("radio", { name: "Claude Code" })).toBeChecked();
  await expect(sheet.getByLabel("Install command for Claude Code")).toHaveText("npx @preplabsai/rovara-code mcp install --client claude-code");
  await sheet.getByRole("radio", { name: "Codex" }).check();
  await expect(sheet.getByLabel("Install command for Codex")).toHaveText("npx @preplabsai/rovara-code mcp install --client codex");
  await sheet.getByRole("radio", { name: "Cursor" }).check();
  await expect(sheet.getByLabel("Install command for Cursor")).toHaveText("npx @preplabsai/rovara-code mcp install --client cursor");
  await expect(sheet.getByText("Fix duplicate refunds", { exact: true })).toBeVisible();
  await expect(sheet.getByText("11111111-1111-4111-8111-111111111111", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "acme/payments #42" })).toBeVisible();
  await expect(sheet.getByText(/When you push to the task's branch, Rovara will mark the work 'Changed outside Rovara · checks needed'\. Press Recheck when you're ready\./u)).toBeVisible();
  await expect(sheet.getByText(/trusted, project-wide lessons/u)).toBeVisible();
  await expect(sheet.getByRole("button", { name: /recheck/iu })).toHaveCount(0);
  // Copy says Copied, and the clipboard got the command.
  await sheet.getByRole("button", { name: "Copy install command" }).click();
  await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(["npx @preplabsai/rovara-code mcp install --client cursor"]);
  await sheet.getByRole("button", { name: "Copy prompt" }).click();
  expect((await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied))[1]).toMatch(/^Load Rovara task 11111111-1111-4111-8111-111111111111 \(call agentx_get_task, then agentx_get_plan\) and continue it\.$/u);
  // Nothing sideways; the sheet is on the screen; every control is at least 44px on a phone.
  expect(await noSidewaysScroll(page)).toBe(true);
  const box = await sheet.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  if (phone) {
   const small = await sheet.evaluate(node => [...node.querySelectorAll<HTMLElement>("button, input[type=radio], label.rv-option, summary, pre[tabindex]")].filter(item => { const rect = item.getBoundingClientRect();return rect.width > 0 && rect.height > 0 && rect.height < 43.5 && item.matches("button, label.rv-option"); }).map(item => item.textContent));
   expect(small).toEqual([]);
   for (const name of ["Copy install command", "Copy prompt"]) { const copy = await sheet.getByRole("button", { name }).boundingBox();expect(copy!.height).toBeGreaterThanOrEqual(43.5);expect(copy!.width).toBeGreaterThanOrEqual(43.5); }
  }
  await evidenceShot(page, { path: `${shots}/on-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  // Focus stays in the sheet whichever way a person tabs, Escape closes it, and focus returns to the button.
  for (let step = 0; step < 16; step += 1) { await page.keyboard.press("Tab");expect(await sheet.evaluate(node => node.contains(document.activeElement)), `forward ${String(step)}`).toBe(true); }
  for (let step = 0; step < 16; step += 1) { await page.keyboard.press("Shift+Tab");expect(await sheet.evaluate(node => node.contains(document.activeElement)), `back ${String(step)}`).toBe(true); }
  await page.keyboard.press("Escape");await expect(sheet).toHaveCount(0);await expect(button).toBeFocused();
 });
}
