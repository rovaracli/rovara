import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
async function openHowWeWork(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, viewport: { width: number; height: number }) {
 await request.post("/__mock/scenario", { data: { name: "project" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
 await page.setViewportSize(viewport);await page.goto("/app/projects/payments?tab=how-we-work");
 await expect(page.getByRole("heading", { name: "Build", exact: true })).toBeVisible();
}
test("a maintainer picks models for Build and Review, saves them, and sees the answer", async ({ page, context, request, baseURL }) => {
 await openHowWeWork(page, context, request, baseURL, { width: 1280, height: 900 });
 const build = page.getByRole("region", { name: "Build" }), review = page.getByRole("region", { name: "Review" });
 const model = build.getByRole("combobox", { name: "Model" });
 await expect(model).toBeVisible();
 await expect(model.locator("option:disabled")).toHaveCount(4);
 await expect(model.locator("option", { hasText: "GPT-5 Codex" })).toBeDisabled();
 await model.selectOption({ label: "Opus 5.5" });
 await build.getByRole("combobox", { name: "Effort" }).selectOption({ label: "High" });
 await review.getByRole("combobox", { name: "Review (code and security)" }).selectOption({ label: "Sonnet 4.6" });
 await review.getByRole("switch", { name: "Different vendor than Build" }).click();
 await expect(review.getByText("Code review")).toBeVisible();
 await expect(review.getByText("Security review")).toBeVisible();
 await page.getByRole("button", { name: "Save draft" }).click();
 await expect(page.getByText("Draft saved. Review changes to publish it.")).toBeVisible();
 await expect(build.getByText("Picked because: Set in this project")).toBeVisible();
 await expect(build.getByText("Cost unavailable")).toBeVisible();
 const sent = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: { overlay?: { steps?: Record<string, Record<string, unknown>> } } }>;
 const steps = sent.find(item => item.method === "PUT" && item.path.endsWith("/draft"))?.body?.overlay?.steps;
 expect(steps?.build).toEqual({ model: { provider: "anthropic", modelId: "claude-opus-5-5" }, thinkingLevel: "high" });
 expect(steps?.review).toEqual({ model: { provider: "anthropic", modelId: "claude-sonnet-4-6" }, differentCompanyFrom: "build" });
 await checkA11y(page, { theme: "dark" });
});
test("the model rows stay readable on a phone", async ({ page, context, request, baseURL }) => {
 await openHowWeWork(page, context, request, baseURL, { width: 360, height: 800 });
 await expect(page.getByRole("region", { name: "Build" }).getByRole("combobox", { name: "Model" })).toBeVisible();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });
});
test("a publish refused for a model choice says which stage and why, with the page that fixes it", async ({ page, context, request, baseURL }) => {
 await openHowWeWork(page, context, request, baseURL, { width: 1280, height: 900 });
 const build = page.getByRole("region", { name: "Build" });
 await build.getByRole("combobox", { name: "Model" }).selectOption({ label: "Opus 5.5" });
 await page.getByRole("button", { name: "Save draft" }).click();
 await expect(page.getByText("Draft saved. Review changes to publish it.")).toBeVisible();
 await page.getByRole("button", { name: "Review changes" }).click();
 const dialog = page.getByRole("dialog", { name: "Review changes" });
 await dialog.getByRole("button", { name: "Publish" }).click();
 const refusal = dialog.getByRole("alert");
 await expect(refusal.getByText("Your company locked this stage's model choice.")).toBeVisible();
 await expect(refusal.getByText("Build", { exact: true })).toBeVisible();
 await expect(refusal.getByRole("link", { name: "How to fix this" })).toHaveAttribute("href", "/app/admin/how-we-work");
 await expect(refusal).not.toContainText("STAGE_LOCKED");
 await checkA11y(page, { theme: "dark" });
});
