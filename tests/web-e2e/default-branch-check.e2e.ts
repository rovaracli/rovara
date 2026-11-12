import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// 0.5.16: the default-branch check on the onboarding setup step (both the rich setup, switch `rovara.setup` = "v2", and today's six steps). Before anything of the setup is offered, the branch is read: an empty one with code
// elsewhere asks "main is empty; use <branch> instead?", a repository with no code says to push code first, GitHub that cannot answer says so and goes on, and a branch with files shows only a "Default branch" line. No setup draft,
// setup agent or check is asked until the question is answered. Pictures go to .test-build/web-e2e/default-branch/ (ROVARA_BRANCH_SHOTS changes the folder).
const shots = process.env.ROVARA_BRANCH_SHOTS ?? ".test-build/web-e2e/default-branch", cookie = "11111111-1111-4111-8111-111111111111";
type Branch = "ok" | "empty" | "none" | "down";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, branch: Branch) {
 await request.post("/__mock/scenario", { data: { name: "onboarding" } });
 const asked = await request.post("/__mock/project-setup", { data: { seed: "unchecked", branch, checks: ["ready"] } });expect(asked.ok(), await asked.text()).toBe(true);
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await request.get("/__mock/github-install");
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.addInitScript(entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const requestsOf = async (request: APIRequestContext) => await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: Record<string, unknown> }>;
const startedWork = async (request: APIRequestContext) => (await requestsOf(request)).filter(item => item.method === "POST" && /\/(setup-draft|setup-agent|setup-check)$/u.test(item.path)).map(item => item.path);
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a):not(li a), main button, main input, main select, main textarea, main summary")].filter(node => {
 const box = (node instanceof HTMLInputElement && (node.type === "radio" || node.type === "checkbox") ? (node.closest("label") ?? node) : node).getBoundingClientRect();
 return box.width > 0 && box.height > 0 && box.height < 43.5 && !node.classList.contains("rv-checkbox");
}).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));

// The rich setup's environment step and today's setup step both sit behind the same gate.
const flows = [
 { name: "rich setup", store: { "rovara.setup": "v2" }, url: "/app/onboard?project=mobile-checkout&step=check", opened: "Environment check" },
 { name: "six steps", store: {}, url: "/app/onboard?project=mobile-checkout&step=setup", opened: "Setup" },
] as const;

for (const flow of flows) {
 test(`${flow.name}: an empty main asks "use <branch> instead?", starts nothing, and accepting it opens the step without starting the draft`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, 1280, flow.store, "empty");await page.goto(flow.url);
  const gate = page.getByRole("group", { name: "Default branch of acme/checkout-api" });
  await expect(gate.getByRole("heading", { name: "main is empty; use 001-dag-orchestrator instead?" })).toBeVisible();
  await expect(gate.getByText("last changed 2026-11-10").first()).toBeVisible();
  // The others to pick from; the setup step itself is not offered while the question stands.
  await expect(gate.getByRole("radio")).toHaveCount(2);await expect(gate.getByRole("radio", { name: /feature\/search/u })).toBeVisible();
  await expect(page.getByRole("heading", { name: flow.opened, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Ask Rovara to propose the setup|Retry the check/u })).toHaveCount(0);
  await evidenceShot(page, { path: `${shots}/empty-main-${flow.name.replace(" ", "-")}-1280.png`, fullPage: true });
  await gate.getByRole("button", { name: "Use 001-dag-orchestrator" }).click();
  await expect(page.getByRole("heading", { name: flow.opened, exact: true })).toBeVisible();
  const saved = (await requestsOf(request)).filter(item => item.method === "PUT" && item.path.endsWith("/default-branch"));
  expect(saved).toHaveLength(1);expect(saved[0]!.body).toMatchObject({ repository: "checkout-api", branch: "001-dag-orchestrator", expectedRevision: 1 });
  await expect(page.getByText("Default branch:")).toBeVisible();await expect(page.locator(".rv-branch-change")).toContainText("001-dag-orchestrator");
  // Accepting sets the branch and makes the draft available; it does not spend anything by itself.
  expect(await startedWork(request)).toEqual([]);
  if (flow.name === "six steps") {
   await page.getByRole("button", { name: "Ask Rovara to propose the setup" }).click();
   await expect(page.getByText(/Rovara is reading your repositories/u)).toBeVisible();expect(await startedWork(request)).toEqual(["/v1/web/projects/mobile-checkout/setup-draft"]);
  }
  await evidenceShot(page, { path: `${shots}/after-accepting-${flow.name.replace(" ", "-")}-1280.png`, fullPage: true });
 });
}

test("picking another branch from the list uses that one", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.setup": "v2" }, "empty");await page.goto(flows[0].url);
 const gate = page.getByRole("group", { name: "Default branch of acme/checkout-api" });
 await gate.getByRole("radio", { name: /feature\/search/u }).check();await gate.getByRole("button", { name: "Use the selected branch" }).click();
 await expect(page.getByRole("heading", { name: "Environment check" })).toBeVisible();
 expect((await requestsOf(request)).filter(item => item.method === "PUT" && item.path.endsWith("/default-branch")).map(item => item.body?.branch)).toEqual(["feature/search"]);
});

test("a repository with no code at all says so plainly, and Continue anyway is the person's explicit choice", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.setup": "v2" }, "none");await page.goto(flows[0].url);
 const gate = page.getByRole("group", { name: "Default branch of acme/checkout-api" });
 await expect(gate.getByRole("heading", { name: "This repository has no code yet. Push code first." })).toBeVisible();
 await expect(gate.getByRole("button", { name: /^Use / })).toHaveCount(0);await expect(page.getByRole("heading", { name: "Environment check", exact: true })).toHaveCount(0);
 await evidenceShot(page, { path: `${shots}/no-code-1280.png`, fullPage: true });
 expect(await startedWork(request)).toEqual([]);
 await gate.getByRole("button", { name: "Continue anyway" }).click();
 await expect(page.getByRole("heading", { name: "Environment check", exact: true })).toBeVisible();
 await expect(page.getByText(/it has no files yet/u)).toBeVisible();
 expect((await requestsOf(request)).filter(item => item.method === "POST" && item.path.endsWith("/branch-check/continue")).map(item => item.body)).toEqual([{ repository: "checkout-api", branch: "main" }]);
 await evidenceShot(page, { path: `${shots}/continued-anyway-1280.png`, fullPage: true });
});

test("GitHub that cannot answer fails open: the page says so, goes on, and starts nothing", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.setup": "v2" }, "down");await page.goto(flows[0].url);
 await expect(page.getByText("We couldn't check the branch; draft the setup when ready.")).toBeVisible();
 await expect(page.getByRole("heading", { name: "Environment check", exact: true })).toBeVisible();
 await expect(page.getByRole("button", { name: "Retry the check for acme/checkout-api" })).toBeVisible();
 await page.waitForLoadState("networkidle");expect(await startedWork(request)).toEqual([]);
 await evidenceShot(page, { path: `${shots}/unchecked-1280.png`, fullPage: true });
});

test("a branch with files behaves as before, and the default branch can be changed afterwards with the same check", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.setup": "v2" }, "ok");await page.goto(flows[0].url);
 await expect(page.getByRole("heading", { name: "Environment check", exact: true })).toBeVisible();await expect(page.getByRole("group", { name: /Default branch of/u })).toHaveCount(0);
 await expect(page.locator(".rv-branch-change")).toContainText("main");
 await page.locator(".rv-branch-change summary").click();
 await page.getByLabel("Use another branch of acme/checkout-api").fill("release");await page.getByRole("button", { name: "Check and use this branch for acme/checkout-api" }).click();
 await expect(page.locator(".rv-branch-change")).toContainText("release");
 expect((await requestsOf(request)).filter(item => item.method === "PUT" && item.path.endsWith("/default-branch")).map(item => item.body?.branch)).toEqual(["release"]);
 await evidenceShot(page, { path: `${shots}/change-later-1280.png`, fullPage: true });
});

for (const width of [390, 1280] as const) {
 test(`the empty-branch question at ${String(width)}: no sideways scroll, 44px targets, axe in both themes`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, { "rovara.setup": "v2" }, "empty");await page.goto(flows[0].url);
  await expect(page.getByRole("heading", { name: "main is empty; use 001-dag-orchestrator instead?" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);if (width < 768) expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/empty-main-v2-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
