import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Health and readiness (switch `rovara.health` = "v2"): off, the Health page and the admin overview are today's; on, the readiness list and "What needs an admin". Pictures go to .test-build/web-e2e/health/
// (ROVARA_HEALTH_SHOTS changes the folder, for before/after comparisons: the "off" pictures of this branch and of its base must be byte-identical).
const shots = process.env.ROVARA_HEALTH_SHOTS ?? ".test-build/web-e2e/health";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, variant: string | undefined = "mixed", colorScheme: "light" | "dark" = "light") {
 await request.post("/__mock/scenario", { data: { name: "admin" } });await request.post("/__mock/b35-service-status");
 if (variant !== undefined) await request.post("/__mock/health?variant=" + variant);
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
// Visible controls under 44px tall. Links inside a sentence are exempt (WCAG 2.5.8); every other link, button, field and summary counts.
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main .rv-health a, main .rv-health button, main .rv-health summary, main .rv-health-needs a, main .rv-health-glance a")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
async function focusVisible(page: Page) {
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
}
const HEALTH = "/app/admin/health", OVERVIEW = "/app/admin";
const settled = (page: Page) => expect(page.getByRole("status").filter({ hasText: /checks shown/ })).toBeVisible();

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's Health page and overview, no readiness reads, pictures for the base comparison`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, {}, undefined);await page.goto(HEALTH);
  await expect(page.getByRole("heading", { name: "Rovara service status", exact: true })).toBeVisible();await expect(page.getByRole("link", { name: "browser runtime" })).toBeVisible();await page.waitForLoadState("networkidle");
  await expect(page.getByRole("list", { name: "Readiness checks" })).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-health-${String(width)}.png`, fullPage: true });
  await page.goto(OVERVIEW);await expect(page.getByRole("heading", { name: "Company settings" })).toBeVisible();await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "What needs an admin" })).toHaveCount(0);
  const calls = await (await request.get("/__mock/requests")).json() as Array<{ path: string }>;
  expect(calls.filter(call => /\/v1\/web\/(org\/approvals\/pending-summary|spend-requests|connections|org\/lessons\/preset|org\/design-review)$/u.test(call.path))).toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-overview-${String(width)}.png`, fullPage: true });
 });
}

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`Health, switch on, ${look.name} at ${String(width)}: every row has words, source, time and one fix; ${phone ? "one column, 44px targets, " : ""}no sideways scroll, axe clean, visible focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.health": "v2" });await page.goto(HEALTH);
   await expect(page.getByRole("heading", { name: "Health", level: 1 })).toBeVisible();await settled(page);
   if (look.name === "look-v2") await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
   const list = page.getByRole("list", { name: "Readiness checks" });
   const row = (title: string) => list.locator(".rv-health-row").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
   await expect(row("Code host: GitHub")).toContainText("Healthy");await expect(row("Code host: GitHub")).toContainText("Checked 5 minutes ago");await expect(row("Code host: GitHub").locator("time")).toHaveAttribute("title", /UTC$/u);
   await expect(row("Chat: Slack")).toContainText("Action needed");await expect(row("Chat: Slack")).not.toContainText("Healthy");await expect(row("Chat: Slack")).toContainText(/Checked 2 minutes ago/);await expect(row("Chat: Slack").getByRole("link", { name: "Open Slack connection" })).toHaveAttribute("href", "/app/admin/connections?open=slack");
   await expect(row("Tracker: Linear or Jira")).toContainText("Action needed");await expect(row("Tracker: Linear or Jira").getByRole("link", { name: "Fix tracker connection" })).toHaveAttribute("href", "/app/admin/connections?open=linear");
   await expect(row("AI models")).toContainText("Healthy");await expect(row("AI models")).toContainText(/Checked 15 minutes ago/);await expect(row("AI models")).toContainText(/Rovara used a backup model 3 times in the last 24 hours \(the main model was unavailable\); last at \d\d:\d\d UTC/u);await expect(row("AI models")).not.toContainText("claude-fixture-model-1", { useInnerText: true });
   await expect(row("Test environment: payments")).toContainText("Action needed");await expect(row("Test environment: payments").getByRole("link", { name: "Fix test setup" })).toHaveAttribute("href", "/app/onboard?project=payments&step=setup");
   await expect(row("Test environment: web")).toContainText("Healthy");await expect(row("Team record")).toContainText("Healthy");await expect(row("Lessons and team record sources")).toContainText("Unknown");
   await expect(row("Turned-on features")).toContainText("Unknown");await expect(row("Rovara service")).toContainText("Healthy");
   await expect(list.locator(".rv-health-row").first()).toHaveAttribute("data-status", "action");
   // Raw facts are behind Details, closed by default.
   await expect(row("AI models").locator("details")).not.toHaveAttribute("open", "");await expect(page.locator("main")).not.toContainText(/claude-fixture-model-1|DEFAULT_MODEL_UNAVAILABLE|org_admin|undefined|NaN|\[object/u, { useInnerText: true });
   await row("AI models").locator("summary").click();await expect(row("AI models")).toContainText("claude-fixture-model-1");await row("AI models").locator("summary").click();
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) {
    expect(await smallTargets(page)).toEqual([]);
    const lefts = await page.locator(".rv-health-counts > div").evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));expect(new Set(lefts).size).toBe(1);
   }
   await evidenceShot(page, { path: `${shots}/health-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
  test(`Overview, switch on, ${look.name} at ${String(width)}: What needs an admin with where to fix each item; ${phone ? "44px targets, " : ""}no sideways scroll, axe clean`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.health": "v2" });await page.goto(OVERVIEW);
   const needs = page.locator(".rv-health-needs");await expect(needs.getByRole("heading", { name: "What needs an admin" })).toBeVisible();
   await expect(needs.getByText("Raise the company's agent spending guardrail")).toBeVisible();await expect(needs.getByText("Create an issue in Linear")).toBeVisible();await expect(needs.getByText(/Asked by Maya/u)).toBeVisible();await expect(needs.getByText("3 approvals are waiting in the company. The list may be incomplete.")).toBeVisible();await expect(needs.getByRole("button", { name: "Open to review" }).first()).toBeVisible();await expect(needs.getByText("Spending request: More monthly budget")).toBeVisible();await expect(needs.getByText("Company rule proposal")).toBeVisible();
   await expect(needs.getByText("Tracker: Linear or Jira")).toBeVisible();await expect(needs.getByText("Test environment: payments")).toBeVisible();
   await expect(needs.getByText("Chat: Slack")).toBeVisible();await expect(needs.getByRole("link", { name: "Open Slack connection" })).toHaveAttribute("href", "/app/admin/connections?open=slack");await expect(needs.getByText(/Checked 2 minutes ago/u)).toBeVisible();
   await expect(needs.getByRole("link", { name: "Open the waiting list" }).first()).toHaveAttribute("href", "/app/admin/waiting");
   await expect(needs.getByRole("link", { name: "Open How we work" })).toHaveAttribute("href", "/app/admin/how-we-work");
   await expect(page.locator(".rv-health-glance")).toContainText(/\d+ healthy · \d+ action needed · \d+ unknown/);await expect(page.locator(".rv-health-glance").getByRole("link", { name: "All checks" })).toHaveAttribute("href", "/app/admin/health");
   await expect(page.getByRole("heading", { name: "People and access" })).toBeVisible();
   await expect(page.locator("main")).not.toContainText(/org_guardrail|PENDING|undefined|NaN|\[object/u);
   expect(await noSidewaysScroll(page)).toBe(true);if (phone) expect(await smallTargets(page)).toEqual([]);
   await evidenceShot(page, { path: `${shots}/overview-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  });
 }
}

test("calm company at 390, dark: nothing needs an admin, and the Health page still keeps Unknown honest", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.look": "v2", "rovara.health": "v2" }, "calm", "dark");await page.goto(OVERVIEW);
 await expect(page.getByText("Nothing needs an admin right now.")).toBeVisible();await expect(page.locator(".rv-health-glance")).toContainText("0 action needed");
 expect(await noSidewaysScroll(page)).toBe(true);await evidenceShot(page, { path: `${shots}/overview-calm-dark-390.png`, fullPage: true });await checkA11y(page, { theme: "dark" });
 await page.goto(HEALTH);await settled(page);
 await expect(page.locator(".rv-health-row[data-status=action]")).toHaveCount(0);await expect(page.locator(".rv-health-row[data-status=unknown]").first()).toBeVisible();
 await expect(page.locator(".rv-health-counts")).toContainText("Unknown");
 expect(await smallTargets(page)).toEqual([]);expect(await noSidewaysScroll(page)).toBe(true);
 await evidenceShot(page, { path: `${shots}/health-calm-dark-390.png`, fullPage: true });await checkA11y(page, { theme: "dark" });
});

test("a read that fails shows Unknown, never Healthy, and the page makes no write", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.health": "v2" });
 await page.route("**/v1/web/github/installations", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "down" } }) }));
 await page.goto(HEALTH);await settled(page);
 const code = page.locator(".rv-health-row").filter({ has: page.getByRole("heading", { name: "Code host: GitHub", exact: true }) });
 await expect(code).toContainText("Unknown");await expect(code).not.toContainText("Healthy");await expect(code).toContainText("couldn't read");
 await page.getByRole("button", { name: "Check again" }).click();await settled(page);
 const calls = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(calls.filter(call => call.method !== "GET" && /health|connections|approvals|spend|org\//u.test(call.path))).toEqual([]);
});

for (const status of [404, 403] as const) {
 test(`when the observations route answers ${String(status)}: today's rows stay, the Health page says so, and What needs an admin names the read`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 1280, { "rovara.health": "v2" });
  await page.route("**/v1/web/org/health-observations*", route => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: "no" } }) }));
  await page.goto(HEALTH);await settled(page);
  await expect(page.getByRole("note").filter({ hasText: /when (each )?checks? last ran/u })).toBeVisible();
  for (const title of ["Code host: GitHub", "Chat: Slack", "AI models"]) {
   const row = page.locator(".rv-health-row").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
   await expect(row).not.toContainText("Healthy");await expect(row).toContainText(title === "Chat: Slack" ? /Stored associations read/u : "Check time not recorded");
  }
  await page.goto(OVERVIEW);await expect(page.locator(".rv-health-needs").getByText(/Couldn't read: .*when each check last ran/u)).toBeVisible();
  await expect(page.locator(".rv-health-glance")).toContainText(/\d+ healthy · \d+ action needed · \d+ unknown/u);
 });
}

// The observations read can take seconds when the broker refreshes Slack and GitHub: the page and the overview must not wait for it.
const SLOW_MS = 3000;
const slowObservations = (page: Page) => page.route("**/v1/web/org/health-observations*", async route => { await new Promise(resolve => setTimeout(resolve, SLOW_MS));await route.continue(); });
test("a slow observations read does not hold the Health page: other rows show, the three rows it backs say Checking, then they fill in", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.health": "v2" });await slowObservations(page);
 await page.goto(HEALTH);
 const row = (title: string) => page.locator(".rv-health-row").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
 await expect(page.getByRole("status").filter({ hasText: /checks shown\..*3 still checking\./u })).toBeVisible();
 for (const title of ["Code host: GitHub", "Chat: Slack", "AI models"]) await expect(row(title)).toHaveAttribute("data-status", "checking");
 await expect(row("Tracker: Linear or Jira")).toContainText("Action needed");await expect(row("Rovara service")).toContainText("Healthy");
 await expect(page.getByRole("group", { name: "Summary" }).getByText("3 still checking.")).toBeVisible();
 await expect(row("Code host: GitHub")).toHaveAttribute("data-status", "healthy", { timeout: 15_000 });
 await expect(row("Chat: Slack")).toHaveAttribute("data-status", "action");await expect(row("AI models")).toHaveAttribute("data-status", "healthy");
 await expect(page.getByText(/still checking/u)).toHaveCount(0);
});
test("a slow observations read does not hold the overview: What needs an admin and the counts show with 'still checking', then fill in", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.health": "v2" });await slowObservations(page);
 await page.goto(OVERVIEW);
 const needs = page.locator(".rv-health-needs");
 await expect(needs.getByText("Tracker: Linear or Jira")).toBeVisible();await expect(needs.getByText(/3 still checking/u)).toBeVisible();await expect(needs.getByText(/Couldn't read/u)).toHaveCount(0);
 await expect(page.locator(".rv-health-glance")).toContainText(/\d+ unknown · 3 still checking/u);
 await expect(needs.getByText("Chat: Slack")).toBeVisible({ timeout: 15_000 });
 await expect(page.locator(".rv-health-glance")).not.toContainText("still checking");await expect(needs.getByText(/still checking/u)).toHaveCount(0);
});
