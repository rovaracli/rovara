import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { UI_FLAG_NAMES } from "@agentx/cloud-contracts/web";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { mockInsights } from "./support/insights-mock.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
import { settingsFromItem, uiFlagsMapOf } from "../../packages/broker/src/org/ui-flags/store.js";
// Decision 116 (new screens on by default): each finished screen in its default state, with NO device key, for a company that never chose anything. The navigation answer's `uiFlags` is
// the one the broker's own store builds for a company with nothing stored (and, for the forced-off case, with the operator's override `all`). Pictures go to .test-build/web-e2e/default-on/.
const shots = process.env.ROVARA_DEFAULT_ON_SHOTS ?? ".test-build/web-e2e/default-on";
const plain = (map: object): Record<string, string> => Object.fromEntries(Object.entries(map).map(([name, state]) => [name, String(state)]));
const DEFAULTS = plain(uiFlagsMapOf(settingsFromItem(undefined), new Set()));
const FORCED_OFF = plain(uiFlagsMapOf(settingsFromItem(undefined), new Set(UI_FLAG_NAMES)));
/** Every device key on: the forced-off case must give the old screens even so. */
const ALL_KEYS = Object.fromEntries(["look", "nav", "home", "work", "spending", "insights", "continue"].map(name => [`rovara.${name}`, "v2"]));

async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, scenario: string, uiFlags: Record<string, string>, store: Record<string, string> = {}, width = 1280) {
 await request.post("/__mock/scenario", { data: { name: scenario } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 // The browser sends `/v1/app/x` as `/v1/web/x`: the mock cell's nav answer with the broker's `uiFlags` added (the mock cell itself sends none, like an older broker).
 await page.route("**/v1/web/nav*", async route => { const response = await route.fetch();const body = await response.json() as Record<string, unknown>;await route.fulfill({ response, json: { ...body, uiFlags } }); });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}

test("the default answer turns on exactly the finished screens", () => {
 expect(Object.entries(DEFAULTS).filter(([, state]) => state === "on").map(([name]) => name)).toEqual(["look", "nav", "home", "work", "spending", "leadingHeader", "insights", "continue"]);
 expect(Object.values(FORCED_OFF).every(state => state === "off")).toBe(true);
});

test("look and navigation: the new look and the new sidebar, with no device key", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, "admin", DEFAULTS);await page.goto("/app/admin");
 await expect(page.getByRole("heading", { name: "Company settings", exact: true })).toBeVisible();
 await expect(page.locator("html")).toHaveAttribute("data-look", "v2");
 await expect(page.locator(".rv-app-shell.rv-nav-v2")).toBeVisible();
 // The troubleshooting page is offered to an owner, under its new name.
 await expect(page.getByRole("link", { name: "Old screens" }).first()).toBeVisible();await expect(page.getByRole("link", { name: "New screens" })).toHaveCount(0);
 await evidenceShot(page, { path: `${shots}/look-nav-1280.png`, fullPage: true });
});

test("Home: the new Home, with no device key", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, "home", DEFAULTS);await request.post("/__mock/home-v2", { data: { mode: "full" } });await page.goto("/app");
 await expect(page.locator(".rv-home-v2")).toBeVisible();
 await expect(page.getByRole("heading", { name: "Needs you" })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/home-1280.png`, fullPage: true });
});

test("Work: the Work list in place of Live, with no device key", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, "work", DEFAULTS);await page.goto("/app/live");
 await expect(page.getByRole("heading", { name: "Work", level: 1 })).toBeVisible();
 await expect(page.locator(".rv-work-row").first()).toBeVisible();
 await evidenceShot(page, { path: `${shots}/work-1280.png`, fullPage: true });
});

test("Spending: the Spending page, with no device key", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, "admin", DEFAULTS);await request.post("/__mock/spending?variant=owner");await page.goto("/app/admin/money/budgets");
 await expect(page.getByRole("heading", { name: "Spending", level: 1 })).toBeVisible();
 await expect(page.getByRole("heading", { name: "This month: November 2026" })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/spending-1280.png`, fullPage: true });
});

test("Insights: the entry and the page while the broker has Insights on, with no device key", async ({ page, context, request, baseURL }) => {
 await mockInsights(page, "owner");
 await enter(page, context, request, baseURL, "home", DEFAULTS);await page.goto("/app");
 const sidebar = page.locator("aside").getByRole("navigation", { name: "Workspace" });
 await sidebar.getByRole("link", { name: "Insights", exact: true }).click();
 await expect(page.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();
 await expect(page.getByRole("region", { name: "Stuck work" })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/insights-1280.png`, fullPage: true });
});

test("Insights with the broker's own switch off: no entry, and the page says calmly it is not turned on", async ({ page, context, request, baseURL }) => {
 await page.route("**/v1/web/insights**", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } }));
 await enter(page, context, request, baseURL, "home", DEFAULTS);await page.goto("/app");
 await expect(page.locator(".rv-home-v2")).toBeVisible();await page.waitForLoadState("networkidle");
 await expect(page.locator("aside").getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Insights", exact: true })).toHaveCount(0);
 await page.goto("/app/insights");
 await expect(page.getByText("Insights isn't turned on for your company yet.")).toBeVisible();
});

test("the task page: the lead header and Continue in your own tool, with no device key and no address switch", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, "workspace", DEFAULTS);
 await page.route("**/v1/web/projects/payments/lessons/local-tools", route => route.fulfill({ json: { enabled: true, preset: "standard", companyStays: false } }));
 await page.goto("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa");
 await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
 await expect(page.getByRole("button", { name: "Continue in your own tool" })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/task-page-1280.png`, fullPage: true });
});

test("the operator's override (all) gives the old screens to everyone, even with every device key on", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, "work", FORCED_OFF, ALL_KEYS);await page.goto("/app/live");
 await expect(page.getByRole("heading", { name: "Live", level: 1 })).toBeVisible();await expect(page.locator(".rv-work-row")).toHaveCount(0);
 await expect(page.locator("html")).not.toHaveAttribute("data-look", /.*/u);await expect(page.locator(".rv-nav-v2")).toHaveCount(0);
 const task = await context.newPage();
 await task.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, ALL_KEYS);
 await task.route("**/v1/web/nav*", async route => { const response = await route.fetch();const body = await response.json() as Record<string, unknown>;await route.fulfill({ response, json: { ...body, uiFlags: FORCED_OFF } }); });
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await mockRealtime(task);await task.setViewportSize({ width: 1280, height: 900 });
 await task.goto("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa?lead=1");
 await expect(task.getByRole("button", { name: "Conversation" })).toBeVisible();await task.waitForLoadState("networkidle");
 await expect(task.getByRole("region", { name: "Where this task stands" })).toHaveCount(0);await expect(task.getByRole("button", { name: /Continue in your own tool/u })).toHaveCount(0);
});
