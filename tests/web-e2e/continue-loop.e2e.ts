import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// "Continue in your own tool", the continue loop (feat/0515-continue-loop on exp/continue-in-tool): the branch before a pull request and Publish working branch, "Changed outside Rovara · checks needed" with Last pushed by,
// and Recheck only where the server sets canRecheck (a 503 says the server's sentence once). The session read is patched in the browser to carry `continueLoop`; the two routes are mocked. Phone and desktop widths:
// no sideways scroll, 44px buttons, axe in both themes. Pictures go to .test-build/web-e2e/continue-loop/ (ROVARA_CONTINUE_SHOTS changes the folder).
const shots = process.env.ROVARA_CONTINUE_SHOTS ?? ".test-build/web-e2e/continue-loop", cookie = "11111111-1111-4111-8111-111111111111", PAGE = "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa";
const TASK = "11111111-1111-4111-8111-111111111111", BRANCH = "agentx/" + TASK, BASE = "a".repeat(40), HEAD = "b".repeat(40);
type Loop = Record<string, unknown>;
const loopOf = (over: Loop = {}): Loop => ({ branches: [], outside: [], canPublishBranch: false, canRecheck: false, ...over });
async function enter(page: Page, context: BrowserContext, request: Parameters<Parameters<typeof test>[2]>[0]["request"], baseURL: string | undefined, width: number, loop: () => Loop) {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.route("**/v1/web/projects/payments/lessons/local-tools", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "route not found" } } }));
 // The task view carries the continue loop, and no pull request, as a 0.5.15 server sends it before the work is published.
 await page.route(/\/v1\/web\/sessions\/ses_aaaaaaaaaaaaaaaaaaaa(\?.*)?$/u, async route => {
  const response = await route.fetch(), body = await response.json() as { session: { body: { task: Record<string, unknown> } } };
  const task = body.session.body.task;
  task["continueLoop"] = loop();delete task["pullRequests"];
  await route.fulfill({ response, json: body });
 });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const tooSmall = (sheet: ReturnType<Page["locator"]>) => sheet.evaluate(node => [...node.querySelectorAll<HTMLElement>("button")].filter(item => { const rect = item.getBoundingClientRect();return rect.width > 0 && rect.height > 0 && rect.height < 43.5; }).map(item => item.textContent));
const open = async (page: Page) => { await page.getByRole("button", { name: "Continue in your own tool" }).click();const sheet = page.getByRole("dialog", { name: "Continue in your own tool" });await expect(sheet).toBeVisible();return sheet; };

for (const width of [390, 1280] as const) {
 const phone = width < 768;
 test(`publish working branch at ${String(width)}: the button, the branch after it, the prompt, axe`, async ({ page, context, request, baseURL }) => {
  let published = false;const sent: unknown[] = [];
  await enter(page, context, request, baseURL, width, () => loopOf({ canPublishBranch: !published, publishable: published ? [] : [{ repository: "demo", baseSha: BASE }], branches: published ? [{ repository: "demo", branch: BRANCH, source: "published", headSha: BASE }] : [] }));
  await page.route("**/v1/web/tasks/" + TASK + "/continue/publish-branch", async route => { sent.push(route.request().postDataJSON());published = true;await route.fulfill({ json: { repository: "demo", branch: BRANCH, commit: BASE, created: true } }); });
  await page.goto(PAGE);
  const sheet = await open(page);
  const publish = sheet.getByRole("button", { name: "Publish working branch" });
  await expect(publish).toBeVisible();await expect(sheet.getByText(/No branch yet\. Rovara makes it at the commit it started from/u)).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  if (phone) expect(await tooSmall(sheet)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/publish-before-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await publish.click();
  await expect(sheet.getByText(BRANCH, { exact: true }).first()).toBeVisible();
  await expect(publish).toHaveCount(0);
  await expect(sheet.getByLabel("Prompt to paste into your tool")).toContainText("on branch " + BRANCH + ".");
  expect(sent).toEqual([{ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), repository: "demo" }]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/publish-after-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });
 });

 test(`changed outside at ${String(width)}: the chip, Last pushed by, no Recheck while canRecheck is false`, async ({ page, context, request, baseURL }) => {
  const row = { repository: "demo", number: 7, headSha: HEAD, lastPushedBy: { login: "octocat", at: new Date(Date.now() - 5 * 60_000).toISOString() }, canRecheck: false };
  await enter(page, context, request, baseURL, width, () => loopOf({ label: "Changed outside Rovara · checks needed", outside: [row] }));
  let rechecks = 0;page.on("request", item => { if (/\/continue\/recheck/u.test(item.url())) rechecks += 1; });
  await page.goto(PAGE);
  const sheet = await open(page);
  await expect(sheet.getByText("Changed outside Rovara · checks needed")).toBeVisible();
  await expect(sheet.getByText(/^Last pushed by octocat \d+m ago$/u)).toBeVisible();
  await expect(sheet.getByRole("button", { name: /recheck/iu })).toHaveCount(0);
  await expect(sheet.getByText(/Rovara doesn't re-run its checks on pushes made outside it yet/u)).toBeVisible();
  expect(rechecks).toBe(0);expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/outside-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });

 test(`recheck at ${String(width)}: shown when the server sets canRecheck, the new wording, a 503 is said once`, async ({ page, context, request, baseURL }) => {
  const row = { repository: "demo", number: 7, headSha: HEAD, canRecheck: true };
  await enter(page, context, request, baseURL, width, () => loopOf({ label: "Changed outside Rovara · checks needed", canRecheck: true, outside: [row] }));
  const sent: unknown[] = [];
  await page.route("**/v1/web/tasks/" + TASK + "/continue/recheck", async route => { sent.push(route.request().postDataJSON());await route.fulfill({ status: 503, json: { error: { code: "RUNTIME_UNAVAILABLE", message: "This install's workers can't re-check outside changes yet." } } }); });
  await page.goto(PAGE);
  const sheet = await open(page);
  await expect(sheet.getByText("Last pushed by someone outside Rovara")).toBeVisible();
  await expect(sheet.getByText("Rovara will mark the work 'Changed outside Rovara · checks needed'; press Recheck when you're ready.")).toBeVisible();
  const recheck = sheet.getByRole("button", { name: "Recheck demo #7" });
  await expect(recheck).toBeVisible();
  if (phone) expect(await tooSmall(sheet)).toEqual([]);
  await recheck.click();
  await expect(sheet.getByRole("alert")).toHaveText("This install's workers can't re-check outside changes yet.");
  await expect(recheck).toBeDisabled();
  expect(sent).toEqual([{ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), repository: "demo", number: 7, headSha: HEAD }]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/recheck-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
