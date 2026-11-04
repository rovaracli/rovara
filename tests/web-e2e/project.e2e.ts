import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
test("a project keeps workflows, running work and spending readable on desktop and phone", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "project" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/projects/payments");await expect(page.getByRole("heading", { name: "payments", exact: true })).toBeVisible();await expect(page.locator("body")).toHaveCSS("font-family", /sans-serif/u);await expect(page.getByRole("button", { name: "New session", exact: true })).toHaveCSS("min-height", "44px");await expect(page.getByText("Everyone on this project can see its sessions, including people who reach it through its Slack channel.")).toBeVisible();await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: ".test-build/web-e2e/project-desktop.png", fullPage: true });
 await page.setViewportSize({ width: 360, height: 800 });expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: ".test-build/web-e2e/project-phone-dark.png", fullPage: true });
});
test("starting a shared workflow preserves project context and reaches the returned session", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "project" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);await page.setViewportSize({ width: 360, height: 800 });await page.goto("/app/projects/payments");
 await page.getByRole("button", { name: "New session", exact: true }).click();await page.getByRole("button", { name: "Payments expert", exact: true }).click();const problem = page.getByRole("textbox", { name: "What should Payments expert do?" });await expect(problem).toBeFocused();await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");await problem.fill("Investigate duplicate refunds");await checkA11y(page, { theme: "light" });await page.getByRole("button", { name: "Start session", exact: true }).click();await expect(page).toHaveURL(/\/s\/ses_bbbbbbbbbbbbbbbbbbbb$/u);await expect(page.getByRole("heading", { name: "Fix duplicate refunds", exact: true })).toBeVisible();
 const sent = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: unknown }>;
 const starts = sent.filter(item => item.method === "POST" && item.path.endsWith("/runs"));expect(starts).toHaveLength(1);expect(starts[0]?.body).toMatchObject({ project: "payments", input: { text: "Investigate duplicate refunds" } });
});
test("describing the work in the project's start box runs Rovara Code and opens its session", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "project" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);await page.setViewportSize({ width: 360, height: 800 });await page.goto("/app/projects/payments");
 const box = page.getByRole("textbox", { name: "What do you need?" });await expect(page.getByText("Runs: this project's process")).toBeVisible();await box.fill("Fix the duplicate refunds");await expect(page.getByText("25 / 4000")).toBeVisible();await checkA11y(page, { theme: "dark" });
 await box.press("Control+Enter");await expect(page).toHaveURL(/\/s\/ses_bbbbbbbbbbbbbbbbbbbb$/u);await expect(page.getByRole("heading", { name: "Fix duplicate refunds", exact: true })).toBeVisible();
 const sent = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: unknown }>;
 const starts = sent.filter(item => item.method === "POST" && item.path.endsWith("/code"));expect(starts).toHaveLength(1);expect(starts[0]?.body).toMatchObject({ input: { text: "Fix the duplicate refunds" } });
});

test("an enrolled company shows the real spending-stop preview before starting work", async ({ page, context, request, baseURL }, testInfo) => {
 await request.post("/__mock/scenario", { data: { name: "project" } });await request.post("/__mock/start-preview");
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/projects/payments");
 await expect(page.getByText("Effective spending stop: $2.00. Checked again when work starts.")).toBeVisible();
 await page.getByRole("textbox", { name: "What do you need?" }).fill("Fix duplicate refunds");await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("start-preview-light.png"), fullPage: true });
 await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath("start-preview-dark.png"), fullPage: true });
 await page.getByRole("button", { name: "Start", exact: true }).click();await expect(page).toHaveURL(/\/s\/ses_bbbbbbbbbbbbbbbbbbbb$/u);
 const calls = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/start-preview"))).toHaveLength(1);expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/code"))).toHaveLength(1);
});
