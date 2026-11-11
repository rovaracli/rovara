import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect as baseExpect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Settings > Recent sign-in window. The server is built in parallel, so every answer is a fixture fed through page.route that follows briefs/approval-place-api.md section 2: shorten applies at once, lengthen waits for a
// second admin, the proposer cannot approve. ROVARA_APPROVAL_WINDOW_SHOTS names the folder for the pictures.
const expect = baseExpect.configure({ timeout: 15_000 });
const shots = process.env.ROVARA_APPROVAL_WINDOW_SHOTS ?? ".test-build/web-e2e/approval-window";
const HOUR = 3600, DAY = 86400, ROUTE = /\/v1\/web\/org\/approval-window(\?.*)?$/u;
type Viewer = "first" | "second";
/** A stateful stand-in for the server: one waiting request at a time, and the viewer (which admin is looking) decides `proposedByYou`. */
function fakeServer(options: { off?: boolean; seconds?: number; reauth?: boolean } = {}) {
 const model: { revision: number; seconds: number; pending?: { changeId: string; seconds: number; by: Viewer } | undefined; viewer: Viewer; changed?: boolean } = { revision: 1, seconds: options.seconds ?? DAY, viewer: "first" };
 const state = () => ({ revision: model.revision, seconds: model.seconds, isDefault: model.seconds === DAY, defaultSeconds: DAY, minSeconds: HOUR, maxSeconds: 7 * DAY, canChange: true, unreadable: false,
  ...(model.changed === true ? { changedBy: "Ada Admin", changedAt: "2026-11-11T12:00:00.000Z" } : {}),
  ...(model.pending === undefined ? {} : { pending: { changeId: model.pending.changeId, seconds: model.pending.seconds, proposedByYou: model.pending.by === model.viewer, expiresAt: "2026-11-18T09:00:00.000Z" } }) });
 const posts: unknown[] = [];
 const refuse = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });
 async function handle(page: Page) {
  await page.route(ROUTE, route => {
   if (options.off === true) return route.fulfill(refuse(404, "NOT_FOUND", "none"));
   if (route.request().method() === "GET") return route.fulfill({ json: state() });
   if (options.reauth === true) return route.fulfill(refuse(403, "REAUTH_REQUIRED", "Sign in again to change the window. It needs a sign-in within the last 10 minutes."));
   const body = route.request().postDataJSON() as { action: string; seconds?: number; changeId?: string };posts.push(body);
   if (body.action === "set") {
    if (body.seconds! <= model.seconds) { model.seconds = body.seconds!;model.revision += 1;model.changed = true;return route.fulfill({ json: { status: "applied", ...state() } }); }
    if (model.pending !== undefined) return route.fulfill(refuse(409, "CHANGE_STALE", "A request is already waiting for a different admin. Withdraw it first."));
    model.pending = { changeId: "chg_0123456789abcdef", seconds: body.seconds!, by: model.viewer };
    return route.fulfill({ status: 202, json: { status: "needs_approval", changeId: model.pending.changeId, ...state() } });
   }
   if (body.action === "approve") {
    if (model.pending === undefined) return route.fulfill(refuse(409, "CHANGE_STALE", "That request is no longer waiting."));
    if (model.pending.by === model.viewer) return route.fulfill(refuse(403, "FORBIDDEN", "A different admin has to approve this. If you are the company's only admin, only the company owner can do it alone."));
    model.seconds = model.pending.seconds;model.pending = undefined;model.revision += 1;model.changed = true;return route.fulfill({ json: { status: "applied", ...state() } });
   }
   model.pending = undefined;return route.fulfill({ json: { status: "applied", ...state() } });
  });
 }
 return { model, posts, handle };
}
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, server: ReturnType<typeof fakeServer>) {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await server.handle(page);
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 await page.emulateMedia({ reducedMotion: "reduce" });await page.clock.setFixedTime(new Date("2026-11-11T12:00:00Z"));await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a, main button, main input:not([type=checkbox]):not([type=radio]), main select, main textarea, main summary")].filter(node => { const box = node.getBoundingClientRect(), block = node.tagName === "A" ? node.closest("p,li,dd") : null;if (block !== null) return false;return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
const wide = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main *")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.right > innerWidth + 1; }).slice(0, 6).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 24)));
async function focusVisible(page: Page) {
 await page.keyboard.press("Tab");await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
}
async function settled(page: Page) {
 await expect(page.getByRole("heading", { name: "Recent sign-in window", level: 1 })).toBeVisible();
 await expect(page.getByRole("region", { name: "Change the window" })).toBeVisible();
 await expect(page.getByRole("progressbar")).toHaveCount(0);await page.waitForLoadState("networkidle");
}
const picker = (page: Page) => page.getByLabel("Window length");

test("lengthen to 3 days, then a different admin approves it", async ({ page, context, request, baseURL }) => {
 const server = fakeServer();
 await enter(page, context, request, baseURL, 1280, {}, server);await page.goto("/app/admin/approval-window");await settled(page);
 await expect(page.getByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 24 hours.")).toBeVisible();
 await expect(page.getByRole("table", { name: /Where work can be approved/u })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/start-1280.png`, fullPage: true });
 await picker(page).selectOption(String(3 * DAY));await expect(page.getByText(/Longer: needs a second admin/u)).toBeVisible();
 await page.getByRole("button", { name: "Save window" }).click();
 await expect(page.getByText("Waiting for a second admin. A different admin has to approve a window of 3 days.")).toBeVisible();
 const waiting = page.getByRole("region", { name: "Waiting for a second admin" });
 await expect(waiting).toContainText("You asked to lengthen the window from 24 hours to 3 days");
 await expect(waiting.getByRole("button", { name: "Approve the longer window" })).toHaveCount(0);await expect(waiting.getByRole("button", { name: "Cancel the request" })).toBeVisible();
 await expect(page.getByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 24 hours.")).toBeVisible();
 await evidenceShot(page, { path: `${shots}/pending-proposer-1280.png`, fullPage: true });
 // The other admin opens the page.
 server.model.viewer = "second";await page.reload();await settled(page);
 await expect(waiting).toContainText("Another admin asked to lengthen the window from 24 hours to 3 days");
 await evidenceShot(page, { path: `${shots}/pending-other-admin-1280.png`, fullPage: true });
 await waiting.getByRole("button", { name: "Approve the longer window" }).click();
 await expect(page.getByText("Approved. The window is now 3 days.")).toBeVisible();
 await expect(page.getByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 3 days.")).toBeVisible();
 await expect(waiting).toHaveCount(0);
 expect(server.posts).toEqual([{ action: "set", expectedRevision: 1, seconds: 3 * DAY }, { action: "approve", changeId: "chg_0123456789abcdef" }]);
 await evidenceShot(page, { path: `${shots}/applied-1280.png`, fullPage: true });
});

test("the proposer's own approval is refused by the server and its sentence is shown as it is", async ({ page, context, request, baseURL }) => {
 const server = fakeServer();
 await enter(page, context, request, baseURL, 1280, {}, server);await page.goto("/app/admin/approval-window");await settled(page);
 await picker(page).selectOption(String(7 * DAY));await page.getByRole("button", { name: "Save window" }).click();
 await expect(page.getByRole("region", { name: "Waiting for a second admin" })).toBeVisible();
 // A second tab of the same admin: the page it opened earlier still has the button the server now refuses. Simulated by telling the server the viewer is the proposer while the page shows "other".
 server.model.pending!.by = "second";await page.reload();await settled(page);
 server.model.pending!.by = "first";
 await page.getByRole("button", { name: "Approve the longer window" }).click();
 await expect(page.getByRole("alert")).toHaveText("A different admin has to approve this. If you are the company's only admin, only the company owner can do it alone.");
 await expect(page.getByRole("link", { name: "Recent sign-in window", exact: true })).toBeVisible();
});

test("shorten to 4 hours applies at once", async ({ page, context, request, baseURL }) => {
 const server = fakeServer();
 await enter(page, context, request, baseURL, 1280, {}, server);await page.goto("/app/admin/approval-window");await settled(page);
 await picker(page).selectOption(String(4 * HOUR));await expect(page.getByText("Shorter: applies at once.")).toBeVisible();
 await page.getByRole("button", { name: "Save window" }).click();
 await expect(page.getByText("Saved. The window is now 4 hours.")).toBeVisible();
 await expect(page.getByText("People can approve medium-risk work from chat or comments if they signed in to Rovara in the last 4 hours.")).toBeVisible();
 await expect(page.getByRole("region", { name: "Waiting for a second admin" })).toHaveCount(0);
 await expect(page.getByText(/^Set to 4 hours by Ada Admin on Nov 11, 2026\./u)).toBeVisible();
 await expect(page.getByRole("link", { name: "Who changed it and when is in the audit log" })).toHaveAttribute("href", "/app/admin/audit");
 expect(server.posts).toEqual([{ action: "set", expectedRevision: 1, seconds: 4 * HOUR }]);
 await evidenceShot(page, { path: `${shots}/shortened-1280.png`, fullPage: true });
});

test("a refused sign-in (403 REAUTH_REQUIRED) offers Sign in again and does not redirect by itself", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ reauth: true });
 await enter(page, context, request, baseURL, 1280, {}, server);await page.goto("/app/admin/approval-window");await settled(page);
 await picker(page).selectOption(String(3 * DAY));await page.getByRole("button", { name: "Save window" }).click();
 await expect(page.getByRole("alert")).toContainText("Sign in again to change the window. It needs a sign-in within the last 10 minutes.");
 const again = page.getByRole("button", { name: "Sign in again" });await expect(again).toBeVisible();
 await page.waitForLoadState("networkidle");expect(new URL(page.url()).pathname).toBe("/app/admin/approval-window");
});

test("the nav lists it under Security and sign-in, and a server with it off says 'not turned on' and shows no link", async ({ page, context, request, baseURL }) => {
 const on = fakeServer();
 await enter(page, context, request, baseURL, 1280, {}, on);await page.goto("/app/admin/approval-window");await settled(page);
 await expect(page.getByRole("group", { name: "Security and sign-in" }).getByRole("link", { name: "Recent sign-in window" })).toBeVisible();
 await page.unroute(ROUTE);
 const off = fakeServer({ off: true });await off.handle(page);await page.goto("/app/admin/approval-window");
 await expect(page.getByText("The recent sign-in window is not turned on for your company yet.")).toBeVisible();
 await expect(page.getByRole("link", { name: "Recent sign-in window" })).toHaveCount(0);
 await expect(page.getByRole("table")).toHaveCount(0);await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) for (const width of [360, 390] as const) {
 test(`phone ${String(width)} in ${look.name}: one column, 44px controls, no sideways scroll, visible focus, axe clean in light and dark (with a waiting request)`, async ({ page, context, request, baseURL }) => {
  const server = fakeServer();server.model.pending = { changeId: "chg_0123456789abcdef", seconds: 3 * DAY, by: "second" };
  await enter(page, context, request, baseURL, width, look.store, server);await page.goto("/app/admin/approval-window");await settled(page);
  await expect(page.getByRole("button", { name: "Approve the longer window" })).toBeVisible();
  if (look.name === "look-v2") await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
  expect(await noSidewaysScroll(page)).toBe(true);expect(await wide(page)).toEqual([]);expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/phone-${look.name}-${String(width)}.png`, fullPage: true });
  expect(await focusVisible(page)).not.toBe("hidden");
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await evidenceShot(page, { path: `${shots}/phone-${look.name}-${String(width)}-dark.png`, fullPage: true });
 });
}

for (const theme of ["light", "dark"] as const) test(`desktop, axe clean in ${theme}, with the picker and the policy table`, async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ seconds: 4 * HOUR });
 await enter(page, context, request, baseURL, 1280, { "rovara.look": "v2" }, server);await page.goto("/app/admin/approval-window");await settled(page);
 await expect(page.getByRole("table", { name: /Where work can be approved/u }).getByRole("columnheader")).toHaveCount(4);
 await checkA11y(page, { theme });await evidenceShot(page, { path: `${shots}/desktop-v2-${theme}.png`, fullPage: true });
});
