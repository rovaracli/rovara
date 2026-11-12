import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { mockInsights } from "./support/insights-mock.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Decision 125 ("delete now"): the eight finished screens have no old screen to fall back to, so each must hold up on its own. For every one: EMPTY data, OLD or partial data (fields an older broker
// does not send), a SLOW answer (the loading state shows, then the page), and a FAILED answer (a visible error, with a way to try again where the page offers one). The one rule over all of them:
// never a white page (`notBlank`). The look and the navigation are checked through the shell on each. The browser sends `/v1/app/x` as `/v1/web/x`. Pictures go to .test-build/web-e2e/robust/.
const shots = process.env.ROVARA_ROBUST_SHOTS ?? ".test-build/web-e2e/robust";
const TASK = "/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa";
type Scenario = "home" | "work" | "admin" | "workspace";

async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, scenario: Scenario, width = 1280) {
 await request.post("/__mock/scenario", { data: { name: scenario } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
/** The page shows something a person can read and act on: a level-one heading with words, and body text. */
async function notBlank(page: Page) {
 await expect(page.locator("h1").first()).toBeVisible();
 expect(((await page.locator("h1").first().textContent()) ?? "").trim().length).toBeGreaterThan(0);
 expect(((await page.locator("body").innerText()) ?? "").trim().length).toBeGreaterThan(20);
}
/** The shell is there, in the one look: the navigation, the phone tab bar's markup and data-look="v2". */
async function shellIntact(page: Page) {
 await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
 await expect(page.locator(".rv-app-shell.rv-nav-v2")).toBeVisible();
 await expect(page.locator("aside").getByRole("navigation", { name: "Workspace" })).toBeVisible();
}
/**
 * Presses Reload on the page error (the page loads again, at the same address), then runs `recovered` on the page the person is left with. Playwright's WebKit keeps a failed script fetch with the page it
 * failed on, across a reload and after the route is removed (`unroute`), so there the recovery is looked at on a fresh page of the same browser context at that address; every other browser looks at the reloaded page itself.
 */
async function reloadAndRecover(page: Page, context: BrowserContext, browserName: string, recovered: (page: Page) => Promise<void>) {
 const before = page.url(), loaded = page.waitForEvent("load");await page.getByRole("button", { name: "Reload" }).click();await loaded;
 expect(page.url()).toBe(before);
 if (browserName !== "webkit") { await recovered(page);return; }
 const address = new URL(page.url()), fresh = await context.newPage();
 await mockRealtime(fresh);await fresh.goto(address.pathname + address.search);await recovered(fresh);
}
/** Holds the answers to `pattern` until the returned release is called, so the loading state can be seen. */
async function hold(page: Page, pattern: string | RegExp): Promise<() => void> {
 let release!: () => void;const gate = new Promise<void>(resolve => { release = resolve; });
 await page.route(pattern, async route => { await gate;await route.fallback(); });
 return release;
}
const fail = (status = 500) => (route: Route) => route.fulfill({ status, json: { error: { code: status === 503 ? "RUNTIME_UNAVAILABLE" : "INTERNAL", message: "Something failed on the server. Try again." } } });
/** Answers with the mock cell's own answer changed by `change` (an older broker's shape: fields dropped). */
const reshape = (change: (body: Record<string, unknown>) => Record<string, unknown>) => async (route: Route) => { const response = await route.fetch();const body = await response.json() as Record<string, unknown>;await route.fulfill({ response, json: change(body) }); };
const without = (body: Record<string, unknown>, ...keys: string[]) => { const copy = { ...body };for (const key of keys) delete copy[key];return copy; };

// ---- The look and the navigation (every page has them): the navigation answer itself.
test.describe("look and navigation", () => {
 test("empty: a person on no project with nothing shared gets the full navigation and plain hints", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");await request.post("/__mock/home-v2", { data: { mode: "empty" } });
  await page.route("**/v1/web/nav*", reshape(body => ({ ...body, homeCount: 0, projects: [], shared: { agents: [], sessions: [] } })));
  await page.goto("/app");await notBlank(page);await shellIntact(page);
  await expect(page.getByText("Your projects appear here.").first()).toBeVisible();await expect(page.getByText("Shared work appears here.").first()).toBeVisible();
  await evidenceShot(page, { path: `${shots}/nav-empty-1280.png`, fullPage: true });
 });
 test("old data: an older broker's answer (no uiFlags, no insights switch, no release; the finished screens named off) still gives the new look and navigation", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");await request.post("/__mock/home-v2", { data: { mode: "full" } });
  await page.route("**/v1/web/nav*", reshape(body => ({ ...without(body, "uiFlags", "insights", "release"), uiFlags: { look: "off", nav: "off", home: "off", work: "off", spending: "off", leadingHeader: "off", insights: "off", continue: "off", health: "off" } })));
  await page.goto("/app");await notBlank(page);await shellIntact(page);
  await expect(page.locator(".rv-home-v2")).toBeVisible();
  await expect(page.locator("aside").getByRole("link", { name: "Live" })).toHaveCount(0);
 });
 test("slow: the loading placeholder shows until the answer, then the page", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");
  const release = await hold(page, "**/v1/web/nav*");
  await page.goto("/app");
  await expect(page.getByRole("status", { name: "Loading workspace" }).or(page.getByText("Loading workspace")).first()).toBeVisible();
  release();await notBlank(page);await shellIntact(page);
 });
 test("failed: the navigation read fails: a page error with Reload in the new look, never a blank page; Reload recovers", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");
  await page.route("**/v1/web/nav*", fail(503));
  await page.goto("/app");await notBlank(page);
  await expect(page.getByRole("heading", { name: "Something went wrong on this page.", level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
  await evidenceShot(page, { path: `${shots}/nav-failed-1280.png`, fullPage: true });
  await page.unroute("**/v1/web/nav*");
  await page.getByRole("button", { name: "Reload" }).click();
  await shellIntact(page);await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
 });
});

// ---- Home.
test.describe("Home", () => {
 test("empty: every section says plainly that it is empty", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");await request.post("/__mock/home-v2", { data: { mode: "empty" } });
  await page.goto("/app");await notBlank(page);await shellIntact(page);
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();await expect(page.getByText("Nothing in progress.")).toBeVisible();await expect(page.getByText("Nothing finished recently.")).toBeVisible();
  await evidenceShot(page, { path: `${shots}/home-empty-1280.png`, fullPage: true });
 });
 test("old data: no needs-you count and no decision cards route (an older broker): Home still lists what it has", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");await request.post("/__mock/home-v2", { data: { mode: "full" } });
  await page.route("**/v1/web/home", reshape(body => without(body, "needsYou")));
  await page.route("**/v1/web/decisions*", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "route not found" } } }));
  await page.goto("/app");await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();await expect(page.getByRole("heading", { name: "Continue" })).toBeVisible();
 });
 test("slow: the loading state shows, then the sections", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");await request.post("/__mock/home-v2", { data: { mode: "full" } });
  const release = await hold(page, "**/v1/web/home");
  await page.goto("/app");await shellIntact(page);
  await expect(page.getByText("Loading what needs you").first()).toBeVisible();
  release();await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();await notBlank(page);
 });
 test("failed: a visible error with Try again, the other sections still there, and Try again recovers", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "home");await request.post("/__mock/home-v2", { data: { mode: "full" } });
  await page.route("**/v1/web/home", fail());
  await page.goto("/app");await notBlank(page);await shellIntact(page);
  const alert = page.getByRole("alert").filter({ hasText: /Try again|Something failed/u }).first();await expect(alert).toBeVisible();
  await expect(page.getByRole("heading", { name: "Continue" })).toBeVisible();
  await evidenceShot(page, { path: `${shots}/home-failed-1280.png`, fullPage: true });
  await page.unroute("**/v1/web/home");await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Something failed" })).toHaveCount(0);
 });
});

// ---- Work.
test.describe("Work", () => {
 test("empty: the view says there is nothing, in Work's words", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "work");
  await page.route(/\/v1\/web\/live(\?|$)/u, route => route.fulfill({ json: { tiles: [], requestId: "mock-gateway-request" } }));
  await page.goto("/app/work");await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();await expect(page.getByText("No work of yours right now")).toBeVisible();
  await evidenceShot(page, { path: `${shots}/work-empty-1280.png`, fullPage: true });
 });
 test("old data: tiles without the optional fields an older broker leaves out still read as rows", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "work");
  await page.route(/\/v1\/web\/live(\?|$)/u, reshape(body => ({ ...body, tiles: (body.tiles as Array<Record<string, unknown>>).map(tile => without(tile, "approvalUrl", "agent", "project")) })));
  await page.goto("/app/work");await notBlank(page);await shellIntact(page);
  await expect(page.locator(".rv-work-row").first()).toBeVisible();
 });
 test("slow: the loading state shows, then the rows", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "work");
  const release = await hold(page, /\/v1\/web\/live(\?|$)/u);
  await page.goto("/app/work");await shellIntact(page);
  await expect(page.getByText("Loading work").first()).toBeVisible();
  release();await expect(page.locator(".rv-work-row").first()).toBeVisible();await notBlank(page);
 });
 test("failed: a visible error with Try again, and Try again recovers; an old /app/live link lands here too", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "work");
  await page.route(/\/v1\/web\/live(\?|$)/u, fail());
  await page.goto("/app/live?filter=needs_me");await expect(page).toHaveURL(/\/app\/work\?filter=needs_me$/u);await notBlank(page);await shellIntact(page);
  const alert = page.getByRole("alert").filter({ hasText: /Try again|Something failed/u }).first();await expect(alert).toBeVisible();
  await evidenceShot(page, { path: `${shots}/work-failed-1280.png`, fullPage: true });
  await page.unroute(/\/v1\/web\/live(\?|$)/u);await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".rv-work-row").first()).toBeVisible();
 });
 test("a screen whose code cannot load (a release changed under the page): a page that says so with Reload, never a blank page; Reload recovers", async ({ page, context, request, baseURL, browserName }) => {
  await enter(page, context, request, baseURL, "work");
  await page.route(/\/app\/assets\/WorkListScreen[^/]*\.js$/u, route => route.abort());
  await page.goto("/app");await shellIntact(page);
  await page.locator("aside").getByRole("link", { name: "Work", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." })).toBeVisible();await notBlank(page);
  await evidenceShot(page, { path: `${shots}/work-chunk-failed-1280.png`, fullPage: true });
  await page.unroute(/\/app\/assets\/WorkListScreen[^/]*\.js$/u);
  await reloadAndRecover(page, context, browserName, async shown => { await expect(shown.locator(".rv-work-row").first()).toBeVisible();await shellIntact(shown); });
 });
});

// ---- Spending (Settings > Spending).
test.describe("Spending", () => {
 test("empty: nothing spent this month, plainly", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "admin");await request.post("/__mock/spending?variant=empty");
  await page.goto("/app/admin/money/budgets");await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("heading", { name: "Spending", level: 1 })).toBeVisible();await expect(page.getByRole("heading", { name: /This month/u })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await evidenceShot(page, { path: `${shots}/spending-empty-1280.png`, fullPage: true });
 });
 test("old data: no spend-requests route and a budget answer with fewer fields (an older broker): the rest of the page still shows", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "admin");await request.post("/__mock/spending?variant=owner");
  await page.route("**/v1/web/spend-requests*", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "route not found" } } }));
  await page.route("**/v1/web/budget", reshape(body => without(body, "testing", "personalPlan", "alerts")));
  await page.goto("/app/admin/money/budgets");await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("heading", { name: /This month/u })).toBeVisible();
 });
 test("slow: the loading state shows, then the figures", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "admin");await request.post("/__mock/spending?variant=owner");
  const release = await hold(page, "**/v1/web/org/spend*");
  await page.goto("/app/admin/money/budgets");await shellIntact(page);
  await expect(page.getByText(/^Loading /u).first()).toBeVisible();
  release();await expect(page.getByRole("heading", { name: /This month/u })).toBeVisible();await notBlank(page);
 });
 test("failed: every read fails: each part says it could not load and that no amounts are shown, with Refresh", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "admin");await request.post("/__mock/spending?variant=owner");
  for (const path of ["**/v1/web/budget", "**/v1/web/org/spend*", "**/v1/web/spend-requests*", "**/v1/web/org/budget-settings*"]) await page.route(path, fail());
  await page.goto("/app/admin/money/budgets");await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("alert").filter({ hasText: /No current amounts are shown/u }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Refresh/u }).first()).toBeVisible();
  await evidenceShot(page, { path: `${shots}/spending-failed-1280.png`, fullPage: true });
 });
});

// ---- The task page: its header (leadingHeader) and Continue in your own tool (continue).
async function taskPage(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined) {
 await enter(page, context, request, baseURL, "workspace");
 await page.route("**/v1/web/projects/payments/lessons/local-tools", route => route.fulfill({ json: { enabled: true, preset: "standard", companyStays: false } }));
}
test.describe("task page header", () => {
 test("empty: a task with no conversation and no decision still has its header block", async ({ page, context, request, baseURL }) => {
  await taskPage(page, context, request, baseURL);
  await page.route(/\/v1\/web\/decisions(\?|$)/u, route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "route not found" } } }));
  await page.goto(TASK);await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
 });
 test("old data: a session without the status model, anchors, agent or project (an older broker) still gets the header block", async ({ page, context, request, baseURL }) => {
  await taskPage(page, context, request, baseURL);
  await page.route(/\/v1\/web\/sessions\/ses_a{20}$/u, reshape(body => ({ ...body, session: without(body.session as Record<string, unknown>, "display", "anchors", "retryOf", "errorRef", "agent", "project") })));
  await page.goto(TASK);await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
  await evidenceShot(page, { path: `${shots}/task-old-data-1280.png`, fullPage: true });
 });
 test("slow: the loading state shows, then the header block", async ({ page, context, request, baseURL }) => {
  await taskPage(page, context, request, baseURL);
  const release = await hold(page, /\/v1\/web\/sessions\/ses_a{20}$/u);
  await page.goto(TASK);await shellIntact(page);
  await expect(page.getByText("Loading the session").first()).toBeVisible();
  release();await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();await notBlank(page);
 });
 test("failed: Session unavailable with Try again, and Try again recovers", async ({ page, context, request, baseURL }) => {
  await taskPage(page, context, request, baseURL);
  await page.route(/\/v1\/web\/sessions\/ses_a{20}$/u, fail());
  await page.goto(TASK);await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("heading", { name: "Session unavailable", level: 1 })).toBeVisible();await expect(page.getByRole("alert").first()).toBeVisible();
  await evidenceShot(page, { path: `${shots}/task-failed-1280.png`, fullPage: true });
  await page.unroute(/\/v1\/web\/sessions\/ses_a{20}$/u);await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
 });
});

test.describe("Continue in your own tool", () => {
 const openPanel = async (page: Page) => { await page.getByRole("button", { name: "Continue in your own tool" }).click();return page.getByRole("dialog", { name: "Continue in your own tool" }); };
 test("empty: no lessons setting on the server (404): the panel still gives the commands", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "workspace");
  await page.route("**/v1/web/projects/payments/lessons/local-tools", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "route not found" } } }));
  await page.goto(TASK);await notBlank(page);
  const dialog = await openPanel(page);await expect(dialog.getByLabel("Install command for Claude Code")).toBeVisible();
 });
 test("old data: a task view without the continue loop (an older broker): the button and the panel still work", async ({ page, context, request, baseURL }) => {
  await taskPage(page, context, request, baseURL);
  await page.route(/\/v1\/web\/sessions\/ses_a{20}$/u, reshape(body => { const session = body.session as { body?: { task?: Record<string, unknown> } };return session.body?.task === undefined ? body : { ...body, session: { ...session, body: { ...session.body, task: without(session.body.task, "continueLoop") } } }; }));
  await page.goto(TASK);await notBlank(page);
  const dialog = await openPanel(page);await expect(dialog.getByLabel("Install command for Claude Code")).toBeVisible();
 });
 test("slow: the panel opens while the lessons setting is still on its way, then shows it", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "workspace");
  let release!: () => void;const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/v1/web/projects/payments/lessons/local-tools", async route => { await gate;await route.fulfill({ json: { enabled: true, preset: "standard", companyStays: false } }); });
  await page.goto(TASK);await notBlank(page);
  const dialog = await openPanel(page);await expect(dialog.getByLabel("Install command for Claude Code")).toBeVisible();
  release();await expect(dialog).toBeVisible();
 });
 test("failed: the lessons read fails (500): the panel still gives the commands, with no raw error", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "workspace");
  await page.route("**/v1/web/projects/payments/lessons/local-tools", fail());
  await page.goto(TASK);await notBlank(page);
  const dialog = await openPanel(page);await expect(dialog.getByLabel("Install command for Claude Code")).toBeVisible();
  await expect(dialog).not.toContainText("INTERNAL");
  await evidenceShot(page, { path: `${shots}/continue-failed-1280.png`, fullPage: true });
 });
});

// ---- Insights.
const emptyArrays = (value: unknown): unknown => Array.isArray(value) ? [] : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, emptyArrays(inner)])) : value;
test.describe("Insights", () => {
 test("empty: every panel answers with nothing in it: the page and its panels show, with no error", async ({ page, context, request, baseURL }) => {
  await mockInsights(page, "owner");
  await page.route(/\/v1\/web\/insights\/(stuck|shipped|spend|flow)(\?|$)/u, reshape(body => emptyArrays(body) as Record<string, unknown>));
  await enter(page, context, request, baseURL, "home");
  await page.goto("/app/insights");await notBlank(page);await shellIntact(page);
  await expect(page.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();await expect(page.getByRole("region", { name: "Stuck work" })).toBeVisible();
  await evidenceShot(page, { path: `${shots}/insights-empty-1280.png`, fullPage: true });
 });
 test("old data: the install's Insights switch is off (404, as a broker with `in` off or an older one answers): a calm notice and no navigation entry", async ({ page, context, request, baseURL }) => {
  await page.route("**/v1/web/insights**", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } }));
  await enter(page, context, request, baseURL, "home");
  await page.goto("/app/insights");await notBlank(page);await shellIntact(page);
  await expect(page.getByText("Insights isn't turned on for your company yet.")).toBeVisible();
  await expect(page.locator("aside").getByRole("link", { name: "Insights", exact: true })).toHaveCount(0);
 });
 test("slow: the loading state shows, then the panels", async ({ page, context, request, baseURL }) => {
  await mockInsights(page, "owner");
  await enter(page, context, request, baseURL, "home");
  const release = await hold(page, /\/v1\/web\/insights(\?|$)/u);
  await page.goto("/app/insights");await shellIntact(page);
  await expect(page.getByText("Loading Insights").first()).toBeVisible();
  release();await expect(page.getByRole("region", { name: "Stuck work" })).toBeVisible();await notBlank(page);
 });
 test("failed: a visible error that shows no figures, with Try again, and Try again recovers", async ({ page, context, request, baseURL }) => {
  await mockInsights(page, "owner");
  await enter(page, context, request, baseURL, "home");
  await page.route(/\/v1\/web\/insights(\?|$)/u, fail());
  await page.goto("/app/insights");await notBlank(page);await shellIntact(page);
  const alert = page.getByRole("alert").filter({ hasText: "Couldn't load Insights" });await expect(alert).toBeVisible();
  await evidenceShot(page, { path: `${shots}/insights-failed-1280.png`, fullPage: true });
  await page.unroute(/\/v1\/web\/insights(\?|$)/u);await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Stuck work" })).toBeVisible();
 });
});

// ---- Decision 125 follow-up: code that cannot load, Reload on any address, a phone, a failing panel.
/** The page is styled: the tokens are applied (the root has the one look and a background token), and the page error's heading is not the browser's default size. */
async function styled(page: Page) {
 await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
 expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--rv-bg").trim())).not.toBe("");
 expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
}
for (const [label, scenario, path, chunk, extra] of [
 ["Home", "home", "/app", /\/app\/assets\/HomeV2-[^/]*\.js$/u, "home"],
 ["Insights", "home", "/app/insights", /\/app\/assets\/InsightsScreen-[^/]*\.js$/u, "insights"],
 ["Spending", "admin", "/app/admin/money/budgets", /\/app\/assets\/BudgetsScreen-[^/]*\.js$/u, "spending"],
 ["the task page", "workspace", TASK, /\/app\/assets\/SessionScreen-[^/]*\.js$/u, "task"],
] as const) {
 test(`${label}'s code cannot load: a styled page error with Reload in place of the screen, the navigation${extra === "spending" ? " and the settings menu" : ""} still there; Reload recovers`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, scenario);
  if (extra === "home") await request.post("/__mock/home-v2", { data: { mode: "full" } });
  if (extra === "insights") await mockInsights(page, "owner");
  if (extra === "spending") await request.post("/__mock/spending?variant=owner");
  await page.route(chunk, route => route.abort());
  await page.goto(path);
  await expect(page.locator("main").getByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." })).toBeVisible();
  await shellIntact(page);await styled(page);await notBlank(page);
  if (extra === "spending") await expect(page.getByRole("navigation", { name: "Administration" })).toBeVisible();
  await evidenceShot(page, { path: `${shots}/chunk-${extra}-1280.png`, fullPage: true });
  await page.unroute(chunk);await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("main").getByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." })).toHaveCount(0);await shellIntact(page);
 });
}
// A stale deploy, as a real one looks: the old chunk's script AND its stylesheet are gone (404). Vite preloads a chunk's CSS first and throws a plain Error ("Unable to preload CSS for ..."), not the TypeError a missing
// script alone gives, so this is the case that used to read "Something went wrong on this page." instead of "Rovara was updated. Reload to continue."
for (const [label, path, chunk, extra] of [
 ["Insights", "/app/insights", /\/app\/assets\/InsightsScreen-[^/]*\.(js|css)$/u, "insights"],
 ["the task page's Continue in your own tool", TASK, /\/app\/assets\/ContinueInTool-[^/]*\.(js|css)$/u, "continue"],
] as const) {
 test(`${label}: its script and stylesheet both 404 (a stale deploy): the page says 'Rovara was updated' with Reload, never 'Something went wrong'; Reload recovers`, async ({ page, context, request, baseURL, browserName }) => {
  const mocks = async (p: Page) => { if (extra === "insights") await mockInsights(p, "owner");else await p.route("**/v1/web/projects/payments/lessons/local-tools", route => route.fulfill({ json: { enabled: true, preset: "standard", companyStays: false } })); };
  await enter(page, context, request, baseURL, extra === "insights" ? "home" : "workspace");await mocks(page);
  await page.route(chunk, route => route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }));
  await page.goto(path);
  const updated = extra === "insights" ? page.locator("main").getByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." }) : page.getByRole("alert").filter({ hasText: "Couldn't load this part." });
  await expect(updated).toBeVisible();
  // The words of a generic crash are nowhere.
  await expect(page.getByText("Something went wrong on this page.")).toHaveCount(0);
  await shellIntact(page);
  if (extra === "insights") await notBlank(page);
  await page.unroute(chunk);
  await reloadAndRecover(page, context, browserName, async shown => {
   if (shown !== page) await mocks(shown);
   // The screen itself is back (so the two checks below are not vacuous), with no page error or part error.
   if (extra === "insights") await expect(shown.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();
   else await expect(shown.getByRole("region", { name: "Where this task stands" })).toBeVisible();
   await expect(shown.getByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." })).toHaveCount(0);
   await expect(shown.getByRole("alert").filter({ hasText: "Couldn't load this part." })).toHaveCount(0);
   await shellIntact(shown);
  });
 });
}
test("Reload works on an address the app would not link to (a query with + : and ,): the page reloads to the same address", async ({ page, context, request, baseURL, browserName }) => {
  await enter(page, context, request, baseURL, "work");
  const chunk = /\/app\/assets\/WorkListScreen-[^/]*\.js$/u, address = "/app/work?filter=mine&q=a+b:c,d";
  await page.route(chunk, route => route.abort());
  await page.goto(address);
  await expect(page.getByRole("heading", { level: 1, name: "Rovara was updated. Reload to continue." })).toBeVisible();
  await page.unroute(chunk);
  await reloadAndRecover(page, context, browserName, async shown => {
   expect(new URL(shown.url()).pathname + new URL(shown.url()).search).toBe(address);
   await expect(shown.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
  });
});
test("Continue in your own tool's code cannot load: the task page stays, the part says so with Reload", async ({ page, context, request, baseURL }) => {
  await taskPage(page, context, request, baseURL);
  await page.route(/\/app\/assets\/ContinueInTool-[^/]*\.js$/u, route => route.abort());
  await page.goto(TASK);
  await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
  const part = page.getByRole("alert").filter({ hasText: "Couldn't load this part." });await expect(part).toBeVisible();
  await expect(part.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Conversation" })).toBeVisible();await shellIntact(page);
  await evidenceShot(page, { path: `${shots}/continue-chunk-1280.png`, fullPage: true });
});
test("on a phone (390): Work fails, says so with Try again in the one look, the tab bar stays, nothing scrolls sideways", async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "work", 390);
  await page.route(/\/v1\/web\/live(\?|$)/u, fail());
  await page.goto("/app/work");await notBlank(page);
  await expect(page.getByRole("alert").filter({ hasText: /Try again|Something failed/u }).first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main destinations" })).toBeVisible();await styled(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await evidenceShot(page, { path: `${shots}/work-failed-390.png`, fullPage: true });
});
test("Insights: one panel fails while the overview answers: that panel says so, the others show", async ({ page, context, request, baseURL }) => {
  await mockInsights(page, "owner");
  await page.route(/\/v1\/web\/insights\/stuck(\?|$)/u, fail());
  await enter(page, context, request, baseURL, "home");
  await page.goto("/app/insights");await notBlank(page);await shellIntact(page);
  const stuck = page.getByRole("region", { name: "Stuck work" });
  await expect(stuck.getByRole("alert").or(stuck.getByText(/Couldn.t load|Try again/u)).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Shipped outcomes" })).toBeVisible();
  await evidenceShot(page, { path: `${shots}/insights-panel-failed-1280.png`, fullPage: true });
});
