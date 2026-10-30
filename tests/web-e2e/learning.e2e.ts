import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
type Sent = Array<{ method: string; path: string; body?: Record<string, unknown> }>;
const BASE = "/v1/web/projects/payments/learning";
const writes = async (request: { get: (path: string) => Promise<{ json: () => Promise<unknown> }> }) => ((await (await request.get("/__mock/requests")).json()) as Sent).filter(item => item.method !== "GET" && item.path.startsWith(BASE));
async function openTab(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width = 1280) {
 await request.post("/__mock/scenario", { data: { name: "project" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
 await page.setViewportSize({ width, height: 900 });await page.goto("/app/projects/payments?tab=how-we-work");
 await expect(page.getByRole("heading", { name: "Suggested rules (2)" })).toBeVisible();
}
test("a maintainer accepts a suggestion and sees it in Added by suggestions, then removes the rule", async ({ page, context, request, baseURL }) => {
 await openTab(page, context, request, baseURL);
 const card = page.getByRole("region", { name: "Suggested rule for Build" });
 await expect(card.getByRole("textbox", { name: "Proposed wording" })).toHaveValue("Add a test for every bug fix.");
 await expect(card.getByText("Why: said 2 times")).toBeVisible();
 await card.getByRole("textbox", { name: "Proposed wording" }).fill("Add a regression test for every bug fix.");
 await card.getByRole("button", { name: "Accept as new version" }).click();
 await expect(page.getByRole("status").filter({ hasText: "Added in version 3" })).toBeVisible();
 await expect(page.getByRole("heading", { name: "Suggested rules (1)" })).toBeVisible();
 await page.getByRole("button", { name: "Added by suggestions (1)" }).click();
 const added = page.getByRole("list", { name: "Rules added by suggestions" });
 await expect(added.getByText("Add a regression test for every bug fix.")).toBeVisible();
 await expect(added.getByText(/Version 3 · Active/u)).toBeVisible();
 await added.getByRole("button", { name: "Remove rule" }).click();
 await expect(page.getByRole("status").filter({ hasText: "Removed in version 4" })).toBeVisible();
 await expect(added.getByText(/Removed$/u)).toBeVisible();
 await expect(added.getByRole("button", { name: "Remove rule" })).toHaveCount(0);
 const sent = await writes(request);
 expect(sent.map(item => item.method + " " + item.path.replace(BASE, ""))).toEqual(["POST /suggestions/sug_build/accept", "POST /rules/rul_sug_build/remove"]);
 expect(sent[0]!.body).toMatchObject({ expectedRevision: 1, stage: "build", text: "Add a regression test for every bug fix." });
 await checkA11y(page, { theme: "dark" });
});
test("a maintainer dismisses a suggestion with a reason, then reopens it from the Dismissed list", async ({ page, context, request, baseURL }) => {
 await openTab(page, context, request, baseURL);
 const card = page.getByRole("region", { name: "Suggested rule for Plan" });
 await card.getByRole("button", { name: "Dismiss…" }).click();
 await expect(card.getByRole("button", { name: "Dismiss suggestion" })).toBeDisabled();
 await card.getByRole("radio", { name: "One-off, not a pattern" }).check();
 await card.getByRole("button", { name: "Dismiss suggestion" }).click();
 await expect(page.getByRole("heading", { name: "Suggested rules (1)" })).toBeVisible();
 await page.getByRole("button", { name: "Dismissed (1)" }).click();
 const dismissed = page.getByRole("list", { name: "Dismissed suggestions" });
 await expect(dismissed.getByText(/One-off, not a pattern/u)).toBeVisible();
 await dismissed.getByRole("button", { name: "Reopen" }).click();
 await expect(page.getByRole("heading", { name: "Suggested rules (2)" })).toBeVisible();
 await expect(page.getByRole("button", { name: "Dismissed (0)" })).toBeVisible();
 const sent = await writes(request);
 expect(sent.map(item => item.method + " " + item.path.replace(BASE, ""))).toEqual(["POST /suggestions/sug_plan/dismiss", "POST /dismissed/sug_plan/reopen"]);
 expect(sent[0]!.body).toEqual({ expectedRevision: 1, dismissKind: "one_off" });
});
test("Suggested rules stay readable on a phone", async ({ page, context, request, baseURL }) => {
 await openTab(page, context, request, baseURL, 360);
 await page.getByRole("button", { name: "Added by suggestions (0)" }).click();
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });
});

const signIn = async (context: BrowserContext, request: APIRequestContext, baseURL: string | undefined) => { await request.post("/__mock/scenario", { data: { name: "project" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]); };
test("the overview shows how often the same correction was given twice", async ({ page, context, request, baseURL }) => {
 await signIn(context, request, baseURL);await mockRealtime(page);await page.goto("/app/projects/payments");
 const block = page.getByRole("region", { name: "Same correction given twice" });
 await expect(block.getByText("25% this month (3 of 12)")).toBeVisible();
 await expect(block.getByText("down from 40% last month")).toBeVisible();
 await expect(block.getByText("2 repeats came after a rule was accepted")).toBeVisible();
 await expect(block.getByRole("link", { name: "Build rule: 2 repeats" })).toHaveAttribute("href", "/app/projects/payments?tab=how-we-work");
 await expect(block.getByText("Lower is better: it means Rovara is learning your team's corrections.")).toBeVisible();
 await checkA11y(page, { theme: "dark" });
});
test("Home's Review opens How we work at the Suggested rules section", async ({ page, context, request, baseURL }) => {
 await signIn(context, request, baseURL);await mockRealtime(page);await page.setViewportSize({ width: 1280, height: 500 });await page.goto("/app");
 await expect(page.getByRole("heading", { name: "Suggested rules for \u201cpayments\u201d", level: 2 })).toBeVisible();
 await expect(page.getByText("2 suggested rules to review in \u201cpayments\u201d")).toBeVisible();
 await page.getByRole("link", { name: "Review" }).click();
 await expect(page).toHaveURL(/\/app\/projects\/payments\?tab=how-we-work$/u);
 const heading = page.getByRole("heading", { name: "Suggested rules (2)" });
 await expect(heading).toBeFocused();
 await expect(heading).toBeInViewport();
});
