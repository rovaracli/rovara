import type { Page } from "@playwright/test";
import { test, expect as baseExpect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Same checks, a longer wait: under parallel or long runs a first paint or a menu open can take more than the default 5 s. No assertion changed.
const expect = baseExpect.configure({ timeout: 15_000 });
// The new navigation (switch: localStorage `rovara.nav` = "v2"). Off, the shell is exactly as it was: the "off" journeys take the base pictures
// (set ROVARA_NAV_SHOTS to a folder to compare a run on this branch with a run on the base commit, byte for byte).
// On: the sidebar on a desktop, the bottom tab bar on a phone, no sideways scroll at 360 and 390, 44px targets, visible focus, no accessibility violations, with the v1 look and the v2 look.
const shots = process.env.ROVARA_NAV_SHOTS ?? ".test-build/web-e2e/nav";
const PAGES = [
 { name: "home", scenario: "home", path: "/app", ready: (page: Page) => page.getByText("2 things need you") },
 { name: "agents", scenario: "agents", path: "/app/agents", ready: (page: Page) => page.getByRole("heading", { name: "Agent directory", exact: true }) },
] as const;
const LOOKS = [{ name: "look-off", store: {} as Record<string, string> }, { name: "look-v2", store: { "rovara.look": "v2" } as Record<string, string> }] as const;
async function enter(page: Page, context: Parameters<Parameters<typeof test>[2]>[0]["context"], request: Parameters<Parameters<typeof test>[2]>[0]["request"], baseURL: string | undefined, scenario: string, store: Record<string, string>, width: number) {
 await request.post("/__mock/scenario", { data: { name: scenario } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, { "rovara.theme": "light", ...store });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
for (const screen of PAGES) {
 for (const look of LOOKS) {
  for (const width of [1280, 390] as const) {
   test(`switch off, ${screen.name} ${look.name} at ${String(width)}: today's shell, picture`, async ({ page, context, request, baseURL }) => {
    await enter(page, context, request, baseURL, screen.scenario, look.store, width);await page.goto(screen.path);await expect(screen.ready(page)).toBeVisible();
    await expect(page.locator(".rv-tabbar")).toHaveCount(0);await expect(page.locator(".rv-nav-v2")).toHaveCount(0);
    const links = await page.locator("aside .rv-sidebar-nav").evaluate(node => [...node.querySelectorAll("a")].map(link => link.textContent));
    expect(links).toContain("Live");expect(links).toContain("Agent directory");
    expect(await noSidewaysScroll(page)).toBe(true);
    // The Home start box loads after the first paint; wait for it so two runs take the same picture.
    await page.waitForLoadState("networkidle");
    await evidenceShot(page, { path: `${shots}/off-${screen.name}-${look.name}-${String(width)}.png`, fullPage: false });
   });
  }
 }
}
test("switch off: /app/live stays Live and /app/work is not a page", async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, "live", {}, 1280);
 await page.goto("/app/live");await expect(page.getByRole("heading", { name: "Live", exact: true, level: 1 })).toBeVisible();expect(new URL(page.url()).pathname).toBe("/app/live");
 await page.goto("/app/work");await expect(page.getByText("We couldn't find that.")).toBeVisible();
});
for (const screen of PAGES) {
 for (const look of LOOKS) {
  for (const width of [1280, 390, 360] as const) {
   const phone = width < 768;
   test(`switch on, ${screen.name} ${look.name} at ${String(width)}: ${phone ? "bottom tab bar, 44px targets" : "sidebar"}, no sideways scroll, visible focus, axe clean`, async ({ page, context, request, baseURL }) => {
    await enter(page, context, request, baseURL, screen.scenario, { ...look.store, "rovara.nav": "v2" }, width);await page.goto(screen.path);await expect(screen.ready(page)).toBeVisible();
    await expect(page.locator(".rv-nav-v2")).toHaveCount(1);
    expect(await noSidewaysScroll(page)).toBe(true);
    const sidebar = page.locator("aside").getByRole("navigation", { name: "Workspace" }), tabs = page.getByRole("navigation", { name: "Main destinations" });
    // No agents under projects, anywhere in the navigation; each destination once.
    await expect(page.locator("aside a[href^='/app/agents/'], .rv-tabbar a[href^='/app/agents/']")).toHaveCount(0);
    if (!phone) {
     await expect(sidebar).toBeVisible();await expect(tabs).toBeHidden();
     expect(await sidebar.evaluate(node => [...node.querySelectorAll("a")].slice(0, 5).map(link => link.textContent))).toEqual(screen.name === "home" ? ["Home3", "Work", "Projects", "Agents", "Settings"] : expect.arrayContaining(["Work", "Projects", "Agents", "Settings"]));
     for (const label of ["Work", "Projects", "Agents", "Settings"]) await expect(sidebar.getByRole("link", { name: label, exact: true })).toHaveCount(1);
    } else {
     await expect(tabs).toBeVisible();await expect(page.locator("aside")).toBeHidden();
     const links = tabs.getByRole("link");await expect(links).toHaveCount(5);
     expect(await links.evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").replace(/\d+$/u, "")))).toEqual(["Home", "Work", "Projects", "Agents", "Settings"]);
     // Pinned to the bottom edge, 44px targets, each with an icon, the current page marked.
     const box = (await tabs.boundingBox())!;expect(Math.round(box.y + box.height)).toBe(900);expect(box.x).toBe(0);expect(Math.round(box.width)).toBe(width);
     const small = await links.evaluateAll(nodes => nodes.filter(node => { const rect = node.getBoundingClientRect();return rect.height < 44 || rect.width < 44; }).map(node => node.textContent));expect(small).toEqual([]);
     expect(await links.evaluateAll(nodes => nodes.every(node => node.querySelector("svg[aria-hidden=true]") !== null))).toBe(true);
     await expect(tabs.locator("[aria-current=page]")).toHaveCount(1);await expect(tabs.getByRole("link", { name: screen.name === "home" ? /^Home/u : "Agents" })).toHaveAttribute("aria-current", "page");
     // The page can scroll all the way past the bar: the main area keeps room for it.
     expect(await page.locator("main").evaluate(node => parseFloat(getComputedStyle(node).paddingBottom))).toBeGreaterThanOrEqual(56);
     // The last thing on the page is not covered by the bar once scrolled to the end (with the v2 look on, its own padding rules must not remove the room).
     await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
     expect(await page.evaluate(() => { const last = document.querySelector("main")!.lastElementChild!, bar = document.querySelector(".rv-tabbar")!;return last.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top; })).toBe(true);
     await page.evaluate(() => { window.scrollTo(0, 0); });
     // The top Menu stays for everything else, and is still a 44px target.
     const menu = page.getByRole("button", { name: "Open workspace menu" });await expect(menu).toBeVisible();expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    }
    // Focus: the page moves focus to its heading on load, so start from the skip link. It shows itself on focus, and Tab then walks the page in reading order (header, sidebar or Menu, page, never backwards) with a visible outline on every stop.
    const skip = page.getByRole("link", { name: "Skip to main content" });await skip.focus();await expect(skip).toBeFocused();
    expect((await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    const stops: number[] = [], outlines: string[] = [];
    for (let step = 0; step < 8; step++) {
     await page.keyboard.press("Tab");
     const stop = await page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return { index: -1, outline: "none" };const style = getComputedStyle(node);return { index: [...document.querySelectorAll("a, button, input, select, textarea, summary, [tabindex]")].indexOf(node), outline: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden" }; });
     stops.push(stop.index);outlines.push(stop.outline);
    }
    expect(stops.every((index, at) => index >= 0 && (at === 0 || index > stops[at - 1]!))).toBe(true);expect(outlines).not.toContain("hidden");
    if (phone) { await page.locator(".rv-tabbar a").nth(1).focus();expect(await page.evaluate(() => { const style = getComputedStyle(document.activeElement!);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2; })).toBe(true); }
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await page.waitForLoadState("networkidle");
    await evidenceShot(page, { path: `${shots}/on-${screen.name}-${look.name}-${String(width)}.png`, fullPage: false });
    await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   });
  }
 }
}
for (const width of [1280, 390] as const) {
 test(`switch on at ${String(width)}: /app/live goes to Work, old links keep working, Projects lists projects once`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, "live", { "rovara.nav": "v2" }, width);
  // The navigation answer's own per-project `needsYou` (the Projects page uses it, not the sum of the agents' counts): the mock answer is given one for every project.
  await page.route("**/v1/web/nav", async route => { const answer = await route.fetch(), body = await answer.json() as { projects: Array<Record<string, unknown>> };await route.fulfill({ response: answer, json: { ...body, projects: body.projects.map(project => ({ ...project, needsYou: 2 })) } }); });
  await page.goto("/app/live?filter=needs_me");await expect(page).toHaveURL(/\/app\/work\?filter=needs_me$/u);await expect(page.getByRole("heading", { name: "Work", exact: true, level: 1 })).toBeVisible();await expect(page.getByRole("heading", { name: "Live", exact: true, level: 1 })).toHaveCount(0);
  const current = width < 768 ? page.getByRole("navigation", { name: "Main destinations" }) : page.locator("aside").getByRole("navigation", { name: "Workspace" });
  await expect(current.getByRole("link", { name: "Work", exact: true })).toHaveAttribute("aria-current", "page");
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/on-work-${String(width)}.png`, fullPage: false });
  await page.goto("/app/projects");await expect(page.getByRole("heading", { name: "Projects", exact: true, level: 1 })).toBeFocused();
  await expect(page.getByRole("main").getByRole("link")).toHaveCount(1);await expect(page.getByRole("main").getByRole("link", { name: /payments/u })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: /payments/u })).toContainText("2 need you");
  await expect(current.getByRole("link", { name: "Projects", exact: true })).toHaveAttribute("aria-current", "page");
  expect(await noSidewaysScroll(page)).toBe(true);await evidenceShot(page, { path: `${shots}/on-projects-${String(width)}.png`, fullPage: false });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await page.getByRole("main").getByRole("link", { name: /payments/u }).click();await expect(page).toHaveURL(/\/app\/projects\/payments$/u);
  await page.goto("/s/ses_aaaaaaaaaaaaaaaaaaaa");await expect(page).toHaveURL(/\/app\/sessions\/ses_aaaaaaaaaaaaaaaaaaaa$/u);
 });
}
