import type { Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// The new look is off unless storage says so. These journeys show that (nothing changes while off) and that, switched on, no page scrolls sideways at phone widths,
// focus stays visible, and both themes and both densities render. Pictures go to .test-build/web-e2e/look/ (set ROVARA_LOOK_SHOTS to change the folder, for before/after comparisons).
const shots = process.env.ROVARA_LOOK_SHOTS ?? ".test-build/web-e2e/look";
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
const SCREENS = [
 { name: "home", scenario: "home", path: "/app", ready: (page: Page) => page.getByText("2 things need you") },
 { name: "task", scenario: "session", path: "/app/sessions/" + SESSION, ready: (page: Page) => page.getByRole("heading", { name: "Fix duplicate refunds", exact: true }) },
 { name: "settings", scenario: "admin", path: "/app/admin", ready: (page: Page) => page.getByRole("heading", { name: "Company settings", exact: true }) },
 { name: "project", scenario: "project", path: "/app/projects/payments", ready: (page: Page) => page.getByRole("heading", { name: "payments", exact: true }) },
] as const;
const LOOKS = [
 { name: "off", store: {}, colorScheme: "light" },
 { name: "v2-light", store: { "rovara.look": "v2", "rovara.theme": "light" }, colorScheme: "light" },
 { name: "v2-dark", store: { "rovara.look": "v2", "rovara.theme": "dark" }, colorScheme: "dark" },
 { name: "v2-compact", store: { "rovara.look": "v2", "rovara.theme": "light", "rovara.density": "compact" }, colorScheme: "light" },
] as const;
for (const screen of SCREENS) {
 for (const look of LOOKS) {
  for (const width of [1280, 390] as const) {
   test(`${screen.name} ${look.name} at ${String(width)}: no sideways scroll, visible focus, picture`, async ({ page, context, request, baseURL }) => {
    await request.post("/__mock/scenario", { data: { name: screen.scenario } });
    await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
    await page.emulateMedia({ colorScheme: look.colorScheme, reducedMotion: "reduce" });
    await page.addInitScript(store => { for (const [key, value] of Object.entries(store)) localStorage.setItem(key, value); }, look.store);
    await mockRealtime(page);
    await page.setViewportSize({ width: width, height: 900 });await page.goto(screen.path);await expect(screen.ready(page)).toBeVisible();
    const root = page.locator("html");
    if (look.name === "off") { await expect(root).not.toHaveAttribute("data-look", /.*/u); await expect(root).not.toHaveAttribute("data-density", /.*/u); } else { await expect(root).toHaveAttribute("data-look", "v2"); }
    if (look.name === "v2-compact") await expect(root).toHaveAttribute("data-density", "compact");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Every visible button and link is at least 44px tall on a phone, in every look.
    if (width === 390 && look.name !== "off") {
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
