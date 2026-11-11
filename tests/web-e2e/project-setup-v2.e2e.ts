import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// The rich project setup is off unless storage says so (`rovara.setup` = "v2"). Off, it is today's onboarding. On: the whole flow to a started first task, a repository that fails with its recovery, a refused start with
// the server's reason and the fix, and the phone widths (no sideways scroll, 44px targets, axe in both themes, focus visible). Pictures go to .test-build/web-e2e/project-setup/ (ROVARA_SETUP_SHOTS changes the folder).
const shots = process.env.ROVARA_SETUP_SHOTS ?? ".test-build/web-e2e/project-setup", cookie = "11111111-1111-4111-8111-111111111111", SESSION = "ses_cccccccccccccccccccc";
interface Ask { checks?: string[]; agent?: boolean; refuseStart?: boolean; seed?: "failed" | "unchecked" | "ready" }
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, ask?: Ask) {
 await request.post("/__mock/scenario", { data: { name: "onboarding" } });
 if (ask !== undefined) { const asked = await request.post("/__mock/project-setup", { data: ask });expect(asked.ok(), await asked.text()).toBe(true); }
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await request.get("/__mock/github-install");
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.addInitScript(entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
// Visible controls under 44px tall. A link inside a sentence is exempt (WCAG 2.5.8); a radio button or checkbox counts through the 44px row it sits in.
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a):not(li a), main button, main input, main select, main textarea, main summary")].filter(node => {
 const box = (node instanceof HTMLInputElement && node.type === "radio" ? (node.closest("label") ?? node) : node).getBoundingClientRect();
 return box.width > 0 && box.height > 0 && box.height < 43.5 && !node.classList.contains("rv-checkbox");
}).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
const focusVisible = async (page: Page) => { await page.keyboard.press("Tab");await page.keyboard.press("Tab");return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; }); };
const requestsOf = async (request: APIRequestContext) => await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: { input?: { text?: string } } }>;

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's six steps, none of the new setup`, async ({ page, context, request, baseURL }) => {
  const chunks: string[] = [];page.on("request", asked => { if (/ProjectSetupV2|setup-v2|project-setup/u.test(asked.url())) chunks.push(asked.url()); });
  await enter(page, context, request, baseURL, width, {});await page.goto("/app/onboard?github=connected");
  await expect(page.getByRole("heading", { name: "Onboard a project" })).toBeVisible();await expect(page.getByRole("heading", { name: "Choose repositories" })).toBeVisible();await expect(page.getByText("Step 2 of 6")).toBeVisible();
  await expect(page.locator(".rv-psv2")).toHaveCount(0);await page.waitForLoadState("networkidle");expect(chunks, "the new setup's chunk is not requested while the switch is off").toEqual([]);
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-${String(width)}.png`, fullPage: true });
 });
}

test("switch on: the whole flow to a first task that actually starts, with one repository failing and its Retry", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, { "rovara.setup": "v2" }, { checks: ["failed", "ready"] });await page.goto("/app/onboard");
 // 1 Name
 await expect(page.getByRole("heading", { name: "Set up a project" })).toBeVisible();await expect(page.getByText("Step 1 of 6: Name")).toBeVisible();
 await expect(page.getByRole("region", { name: "Company setup" }).getByText(/connected as acme/u)).toBeVisible();
 await page.getByLabel("Project name").fill("mobile-checkout");await page.getByLabel("What is this project for?").fill("Make paying in the mobile app fast and reliable.");
 await evidenceShot(page, { path: `${shots}/on-1-name-1280.png`, fullPage: true });
 await page.getByRole("button", { name: "Choose repositories" }).click();
 // 2 Repos: several code repos need a meta repo
 await expect(page.getByText("Step 2 of 6: Repos")).toBeVisible();
 await page.getByRole("checkbox", { name: "acme/checkout-api" }).click();await page.getByRole("checkbox", { name: "acme/checkout-ios" }).click();
 await expect(page.getByRole("button", { name: "Create the project" })).toBeDisabled();await expect(page.getByRole("status").filter({ hasText: "meta repo" })).toBeVisible();
 await page.getByRole("radio", { name: "acme/mobile-meta" }).check();await expect(page.getByRole("button", { name: "Create the project" })).toBeEnabled();
 await evidenceShot(page, { path: `${shots}/on-2-repos-1280.png`, fullPage: true });
 await page.getByRole("button", { name: "Create the project" }).click();
 // 3 Environment check per repo: nothing checked yet, the meta repo needs nothing
 await expect(page.getByText("Step 3 of 6: Environment check")).toBeVisible();
 const rows = page.getByRole("list", { name: "Repositories" }).getByRole("listitem");
 await expect(rows).toHaveCount(3);await expect(rows.nth(0)).toContainText("Not checked yet");await expect(rows.nth(2)).toContainText("Meta repo");
 await evidenceShot(page, { path: `${shots}/on-3-check-unchecked-1280.png`, fullPage: true });
 await page.getByRole("button", { name: "Retry the check for acme/checkout-api" }).click();
 // The first answer fails at the iOS repository: its row says the step, the cause and one recovery; the API repository is not marked ready on a guess.
 await expect(rows.nth(1)).toContainText("Needs action");await expect(rows.nth(1)).toContainText("pnpm install");await expect(rows.nth(1)).toContainText("Allowed websites");
 await expect(rows.nth(0)).toContainText("Not checked on its own");await expect(page.getByText(/1 of 2 needs action/u)).toBeVisible();
 await expect(page.getByRole("button", { name: "Fix with the setup agent for acme/checkout-ios" })).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Continue to agents" })).toHaveCount(0);
 await evidenceShot(page, { path: `${shots}/on-3-check-failed-1280.png`, fullPage: true });
 await page.getByRole("button", { name: "Retry the check for acme/checkout-ios" }).click();
 await expect(page.getByText(/All ready/u)).toBeVisible();await expect(rows.nth(0)).toContainText("Ready");await expect(rows.nth(1)).toContainText("Ready");
 await evidenceShot(page, { path: `${shots}/on-3-check-ready-1280.png`, fullPage: true });
 await page.getByRole("button", { name: "Continue to agents" }).click();
 // 4 Agents, 5 People (an invite can't carry a project yet, and says so)
 await expect(page.getByText("Step 4 of 6: Agents")).toBeVisible();await expect(page.getByRole("checkbox", { name: "Rovara Code" })).toBeChecked();
 await page.getByRole("button", { name: "Continue to teammates" }).click();
 await expect(page.getByText("Step 5 of 6: People")).toBeVisible();await expect(page.getByText(/can't carry a project or a project role yet/u)).toBeVisible();
 await page.getByRole("button", { name: "Skip for now" }).click();
 // 6 First task: suggested outcomes from the repositories, then it starts through the start route and the task page opens
 await expect(page.getByText("Step 6 of 6: First task")).toBeVisible();
 const suggestions = page.getByRole("group", { name: "Suggested first outcomes" }).getByRole("button");
 await expect(suggestions).toHaveCount(3);await expect(suggestions.first()).toContainText("Map how checkout-api and checkout-ios work together and write a summary to mobile-meta");
 await suggestions.first().click();await expect(page.getByLabel("What do you need?")).toHaveValue(/Map how checkout-api/u);
 await evidenceShot(page, { path: `${shots}/on-6-first-task-1280.png`, fullPage: true });
 await page.getByRole("button", { name: "Start the first task" }).click();
 await expect(page).toHaveURL(new RegExp("/app/sessions/" + SESSION + "$", "u"));
 const sent = (await requestsOf(request)).filter(item => item.method === "POST" && item.path.endsWith("/projects/mobile-checkout/code"));
 expect(sent).toHaveLength(1);expect(sent[0]!.body?.input?.text).toContain("Map how checkout-api and checkout-ios");
});

for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`switch on, ${look.name} at ${String(width)}: a failing repository with its recovery${phone ? ", stacked, 44px targets" : ""}, no sideways scroll, axe, focus`, async ({ page, context, request, baseURL }) => {
   await enter(page, context, request, baseURL, width, { ...look.store, "rovara.setup": "v2" }, { seed: "failed", agent: true, checks: ["failed"] });
   await page.goto("/app/onboard?project=mobile-checkout&step=check");
   await expect(page.getByRole("heading", { name: "Environment check" })).toBeVisible();
   const rows = page.getByRole("list", { name: "Repositories" }).getByRole("listitem");
   await expect(rows).toHaveCount(2);await expect(rows.nth(1)).toContainText("Needs action");
   // The failing step in words, the cause, what to do; then the recoveries, the setup agent first (it is on in this journey).
   await expect(rows.nth(1).getByText("Step that failed")).toBeVisible();await expect(rows.nth(1)).toContainText("Setup command");await expect(rows.nth(1)).toContainText("403 Forbidden");
   const buttons = rows.nth(1).getByRole("button");
   await expect(buttons).toHaveText(["Fix with the setup agent", "Retry the check", "Edit the setup"]);
   expect(await noSidewaysScroll(page)).toBe(true);
   if (phone) {
    expect(await smallTargets(page)).toEqual([]);
    // Stacked: every recovery button is as wide as the row and sits under the one before it.
    const boxes = await buttons.evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect();return { top: box.top, left: box.left }; }));
    expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.top);expect(boxes[1]!.left).toBe(boxes[0]!.left);
   }
   const text = (await page.locator("main").textContent()) ?? "";
   expect(text).not.toMatch(/needs_action|not_checked|SETUP_NOT_READY|undefined|\[object/u);
   await evidenceShot(page, { path: `${shots}/on-failed-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
 }
}

test("switch on at 390: the first task is refused, the page shows the server's reason and the fix, and nothing opens", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 390, { "rovara.setup": "v2" }, { seed: "ready", refuseStart: true });
 await page.goto("/app/onboard?project=mobile-checkout&step=first");
 await expect(page.getByRole("heading", { name: "Start the first task" })).toBeVisible();
 await page.getByRole("group", { name: "Suggested first outcomes" }).getByRole("button").nth(1).click();
 await page.getByRole("button", { name: "Start the first task" }).click();
 const alert = page.getByRole("alert");
 await expect(alert).toContainText("The setup check for this project has not passed.");await expect(alert).toContainText("Go back to the environment check");
 await expect(alert.getByRole("button", { name: "Go to the environment check" })).toBeVisible();
 expect(new URL(page.url()).pathname).toBe("/app/onboard");expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
 await evidenceShot(page, { path: `${shots}/on-refused-390.png`, fullPage: true });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await alert.getByRole("button", { name: "Go to the environment check" }).click();
 await expect(page.getByRole("heading", { name: "Environment check" })).toBeVisible();
});

for (const width of [390, 360] as const) {
 test(`switch on at ${String(width)}: name, repos and first task stack with 44px targets, axe in both themes`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width, { "rovara.setup": "v2" }, { seed: "ready" });
  await page.goto("/app/onboard");
  await expect(page.getByRole("heading", { name: "Name the project" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/on-1-name-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await page.getByRole("button", { name: "Choose repositories" }).click();
  await expect(page.getByRole("heading", { name: "Choose repositories" })).toBeVisible();await expect(page.getByRole("checkbox", { name: "acme/checkout-api" })).toBeVisible();
  await page.getByRole("checkbox", { name: "acme/checkout-ios" }).click();await page.getByRole("radio", { name: "acme/mobile-meta" }).check();
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/on-2-repos-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await page.goto("/app/onboard?project=mobile-checkout&step=first");
  await expect(page.getByRole("heading", { name: "Start the first task" })).toBeVisible();
  await page.getByRole("group", { name: "Suggested first outcomes" }).getByRole("button").first().click();
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/on-6-first-task-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
