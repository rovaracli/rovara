import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";

test.beforeEach(async ({ context, request, baseURL, page }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.route("**/v1/web/org/model-sources", route => route.fulfill({ json: { sources: [], order: ["rovara"] } }));
});
const open = async (page: Page) => { await page.goto("/app/admin/how-we-work");await expect(page.getByRole("heading", { name: "How we work (company)", exact: true })).toBeVisible();await expect(page.getByRole("region", { name: "Build" })).toBeVisible(); };
const sent = async (request: APIRequestContext) => await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: Record<string, unknown> }>;

test("an admin follows the link from AI models, reviews a change page by page, saves it, and sees the answer", async ({ page, request }) => {
 await page.setViewportSize({ width: 1280, height: 900 });
 await page.goto("/app/admin/models/steps");
 await page.getByRole("link", { name: "Set company defaults and locks in How we work" }).click();
 await expect(page.getByRole("heading", { name: "How we work (company)", exact: true })).toBeFocused();
 const build = page.getByRole("region", { name: "Build" }), review = page.getByRole("region", { name: "Review (code and security)" });
 await expect(build.getByText("anthropic/claude-sonnet-4-6")).toBeVisible();
 await expect(review.getByRole("switch", { name: "Lock this stage" })).toHaveAttribute("aria-checked", "true");
 await expect(build.getByRole("combobox", { name: "Effort" }).locator("option")).toHaveText(["Choose", "Rovara's default", "Model default", "Off", "Minimal", "Low", "Medium", "High"]);
 await build.getByRole("combobox", { name: "Effort" }).selectOption({ label: "High" });
 await page.getByRole("button", { name: "Review changes" }).click();
 await expect(page.getByText("This list may be incomplete.")).toBeVisible();
 const panel = page.getByRole("region", { name: "Review of company changes" });
 await expect(panel.getByText("payments", { exact: true })).toBeVisible();
 await expect(panel.getByText("billing", { exact: true })).toHaveCount(0);
 expect(await panel.innerText()).not.toMatch(/\d/);
 await panel.getByRole("button", { name: "Show more" }).click();
 await expect(panel.getByText("billing", { exact: true })).toBeVisible();
 await expect(panel.getByRole("button", { name: "Show more" })).toHaveCount(0);
 await checkA11y(page, { theme: "dark" });
 await panel.getByRole("button", { name: "Save company defaults" }).click();
 await expect(page.getByText("Saved. New tasks use these defaults; running tasks keep theirs.")).toBeVisible();
 await expect(build.getByRole("combobox", { name: "Effort" })).toHaveValue("high");
 const put = (await sent(request)).find(item => item.method === "PUT" && item.path === "/v1/web/org/model-selection-policy");
 expect(put?.body).toMatchObject({ version: 1, expectedRevision: 4, stepOverrides: { build: { model: "anthropic/claude-sonnet-4-6", effort: "high", locked: false }, code_review: { locked: true }, security_review: { locked: true } } });
 expect(String(put?.body?.requestId)).toMatch(/^[0-9a-f-]{36}$/);
 await checkA11y(page, { theme: "light" });
});

test("removing a lock needs another admin; a lone admin is told when they can confirm it", async ({ page, request }) => {
 await page.setViewportSize({ width: 1280, height: 900 });
 await open(page);
 const unlock = async () => { await page.getByRole("region", { name: "Review (code and security)" }).getByRole("switch", { name: "Lock this stage" }).click();await page.getByRole("button", { name: "Review changes" }).click();await page.getByRole("button", { name: "Save company defaults" }).click(); };
 await unlock();
 await expect(page.getByText("Another company admin must confirm this less-safe change.")).toBeVisible();
 await expect(page.getByRole("button", { name: "Open confirmation" })).toBeVisible();
 await expect(page.getByText(/Saved\./)).toHaveCount(0);
 await request.post("/__mock/company-policy", { data: { soleOwner: true } });
 await page.reload();
 await expect(page.getByRole("region", { name: "Build" })).toBeVisible();
 await unlock();
 await expect(page.getByText("You're the only admin. You can confirm this yourself after 10/30/2026, 12:00:00 PM UTC (a 24-hour safety wait).")).toBeVisible();
 await expect(page.getByRole("button", { name: "Open confirmation" })).toBeVisible();
 await checkA11y(page, { theme: "dark" });
});

test("a lock on a stage with no model is blocked with a fixed message, using the keyboard", async ({ page }) => {
 await page.setViewportSize({ width: 1280, height: 900 });
 await open(page);
 const plan = page.getByRole("region", { name: "Plan", exact: true }).getByRole("switch", { name: "Lock this stage" });
 await plan.focus();await page.keyboard.press("Space");
 await expect(plan).toHaveAttribute("aria-checked", "true");
 await expect(page.getByText("To lock this stage, set its model, effort and, for a checking stage, the vendor rule first.")).toBeVisible();
 const reviewChanges = page.getByRole("button", { name: "Review changes" });
 await reviewChanges.focus();await page.keyboard.press("Enter");
 await expect(page.getByRole("alert").filter({ hasText: "A locked stage needs a model" })).toBeVisible();
 await expect(page.getByRole("region", { name: "Review of company changes" })).toHaveCount(0);
});

test("a stale revision found while reviewing asks for a reload", async ({ page, request }) => {
 await page.setViewportSize({ width: 1280, height: 900 });
 await open(page);
 // Another admin's save moves the revision on while this page is open.
 await request.post("/__mock/company-policy", { data: { moveOn: true } });
 await page.getByRole("region", { name: "Build" }).getByRole("combobox", { name: "Effort" }).selectOption({ label: "Low" });
 await page.getByRole("button", { name: "Review changes" }).click();
 await expect(page.getByRole("alert").filter({ hasText: "The model settings changed. Reload and try again." })).toBeVisible();
 await page.getByRole("button", { name: "Reload" }).click();
 await expect(page.getByText("The model settings changed.")).toHaveCount(0);
 await expect(page.getByRole("region", { name: "Build" }).getByRole("combobox", { name: "Effort" })).toHaveValue("medium");
});

test("a phone gets the larger-screen message, like the other admin pages", async ({ page }) => {
 await page.setViewportSize({ width: 360, height: 800 });
 await page.goto("/app/admin/how-we-work");
 await expect(page.getByText(/Open this on a larger screen/)).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });
});
