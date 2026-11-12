import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// The v2 look is the only look (decision 125), with no device key. These journeys show that no page scrolls sideways at phone widths,
// focus stays visible, and both themes and both densities render. Pictures go to .test-build/web-e2e/look/ (set ROVARA_LOOK_SHOTS to change the folder, for before/after comparisons).
const shots = process.env.ROVARA_LOOK_SHOTS ?? ".test-build/web-e2e/look";
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const SCREENS = [
 { name: "home", scenario: "home", path: "/app", ready: (page: Page) => page.getByText("2 things need you") },
 { name: "task", scenario: "session", path: "/app/sessions/" + SESSION, ready: (page: Page) => page.getByRole("heading", { name: "Fix duplicate refunds", exact: true }) },
 { name: "settings", scenario: "admin", path: "/app/admin", ready: (page: Page) => page.getByRole("heading", { name: "Company settings", exact: true }) },
 { name: "project", scenario: "project", path: "/app/projects/payments", ready: (page: Page) => page.getByRole("heading", { name: "payments", exact: true }) },
 { name: "live", scenario: "live", path: "/app/live", ready: (page: Page) => page.getByRole("heading", { name: "Fix duplicate refunds" }) },
 { name: "onboard", scenario: "onboarding", path: "/app/onboard?github=connected", ready: (page: Page) => page.getByLabel("acme/payments"), before: async (request: APIRequestContext) => { await request.get("/__mock/github-install"); } },
] as const satisfies readonly { name: string; scenario: string; path: string; ready: (page: Page) => Locator; before?: (request: APIRequestContext) => Promise<void> }[];
const LOOKS = [
 { name: "v2-light", store: { "rovara.theme": "light" }, colorScheme: "light" },
 { name: "v2-dark", store: { "rovara.theme": "dark" }, colorScheme: "dark" },
 { name: "v2-compact", store: { "rovara.theme": "light", "rovara.density": "compact" }, colorScheme: "light" },
] as const;
for (const screen of SCREENS) {
 for (const look of LOOKS) {
  for (const width of [1280, 390] as const) {
   test(`${screen.name} ${look.name} at ${String(width)}: no sideways scroll, visible focus, picture`, async ({ page, context, request, baseURL }) => {
    await request.post("/__mock/scenario", { data: { name: screen.scenario } });
    if ("before" in screen) await screen.before(request);
    await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
    await page.emulateMedia({ colorScheme: look.colorScheme, reducedMotion: "reduce" });
    await page.addInitScript(store => { for (const [key, value] of Object.entries(store)) localStorage.setItem(key, value); }, look.store);
    await mockRealtime(page);
    await page.setViewportSize({ width: width, height: 900 });await page.goto(screen.path);await expect(screen.ready(page)).toBeVisible();await page.waitForLoadState("networkidle"); // later queries (for example the Home project line) must have landed before the picture
    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-look", "v2");
    if (look.name === "v2-compact") await expect(root).toHaveAttribute("data-density", "compact");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Every visible button and link is at least 44px tall on a phone, in every look.
    if (width === 390) {
     const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button:not(.rv-checkbox), main .rv-button, header button")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.className + ":" + Math.round(node.getBoundingClientRect().height)));
     expect(small).toEqual([]);
    }
    await page.keyboard.press("Tab");await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; });
    expect(focus).not.toBe("hidden");
    await evidenceShot(page, { path: `${shots}/${screen.name}-${look.name}-${String(width)}.png`, fullPage: false });
   });
  }
 }
}

// Screen sections follow the density choice (v2 only): on the screens whose section paddings, gaps and row heights moved to the density tokens, Compact makes the page shorter
// than Comfortable at both widths, and at phone width every control stays at least 44px tall in both densities (checked in the journey above for every screen and look).
for (const screen of SCREENS.filter(entry => entry.name !== "task")) {
 for (const width of [1280, 390] as const) {
  test(`${screen.name} at ${String(width)}: Compact is denser than Comfortable and controls stay reachable`, async ({ context, request, baseURL }) => {
   const heights: Record<string, number> = {}, small: Record<string, string[]> = {};
   await request.post("/__mock/scenario", { data: { name: screen.scenario } });
   if ("before" in screen) await screen.before(request);
   await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
   for (const density of ["comfortable", "compact"] as const) {
    const view = await context.newPage();
    await view.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await view.addInitScript(store => { for (const [key, value] of Object.entries(store)) localStorage.setItem(key, value); }, { "rovara.theme": "light", "rovara.density": density });
    await mockRealtime(view);
    await view.setViewportSize({ width, height: 900 });await view.goto(screen.path);await expect(screen.ready(view)).toBeVisible();
    await expect(view.locator("html")).toHaveAttribute("data-density", density);await view.waitForLoadState("networkidle");
    // Content height: from the top of the main column to the bottom of its lowest child (the page itself is at least as tall as the window).
    heights[density] = await view.evaluate(() => { const main = document.querySelector("main")!;return Math.round(Math.max(...[...main.querySelectorAll("*")].map(node => node.getBoundingClientRect().bottom)) - main.getBoundingClientRect().top + scrollY); });
    // Visible buttons, summary rows, choices and fields shorter than 43.5px (the 44px phone minimum), as "class:height".
    small[density] = await view.evaluate(() => [...document.querySelectorAll<HTMLElement>("main .rv-button, main summary, main .rv-onboarding-choice, main .rv-attention-open, main .rv-decision-open, main select, main input:not([type=checkbox]):not([type=radio])")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + String(Math.round(node.getBoundingClientRect().height))));
    await view.close();
   }
   expect(heights.compact, JSON.stringify(heights)).toBeLessThan(heights.comfortable!);
   if (width === 390) expect(small).toEqual({ comfortable: [], compact: [] });
  });
 }
}
