// SV-1l: the project's saved environment on or off, from the project setup checklist and the Saved environment section. Fully usable on a phone: nothing scrolls sideways, every control sits inside
// the screen, one switch and one Save, and the two lines say what a change affects and who can change it. The server's answers are stubbed here; the role check is the broker's (contract tests).
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";

const PANEL = "**/v1/web/projects/payments/environment-image";
const SWITCH = "Use a saved environment for new tasks";

async function open(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string, canChangeSetting: boolean) {
 await request.post("/__mock/scenario", { data: { name: "project" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await mockRealtime(page);
 let enabled = true;
 const puts: unknown[] = [];
 await page.route(PANEL, route => route.fulfill({ json: { health: "healthy", image: { builtAt: "2026-11-05T10:00:00.000Z", ageDays: 2, status: "ready" }, canReset: canChangeSetting, enabled, canChangeSetting } }));
 await page.route(PANEL + "/setting", route => { const body = route.request().postDataJSON() as { enabled: boolean };puts.push(body);enabled = body.enabled;return route.fulfill({ json: { enabled, changed: true } }); });
 await page.setViewportSize({ width: 390, height: 844 });
 await page.goto("/app/projects/payments");
 await expect(page.getByRole("heading", { name: "payments", exact: true })).toBeVisible();
 return { puts };
}

/** Nothing scrolls sideways, and every visible control sits inside the screen's width. */
async function fitsThePhone(page: Page) {
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 const outside = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button, main a, main input, main select, main textarea, main [role=switch]")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(node => node.textContent?.slice(0, 40) ?? node.tagName));
 expect(outside).toEqual([]);
}

for (const theme of ["light", "dark"] as const) test(`a maintainer turns the saved environment off from the setup checklist on a 390px phone in ${theme}`, async ({ page, context, request, baseURL }) => {
 await page.emulateMedia({ colorScheme: theme });
 const { puts } = await open(page, context, request, baseURL!, true);
 const row = page.locator("li.rv-setup-row").filter({ has: page.getByRole("heading", { name: "Saved environment", level: 3 }) });
 await expect(row.getByText("On. New tasks start from the saved copy.")).toBeVisible();
 await row.getByRole("button", { name: "Open" }).click();
 await expect(row.getByText("What a change affects.")).toBeVisible();
 await expect(row.getByText("A maintainer of this project.")).toBeVisible();
 await fitsThePhone(page);
 await row.getByRole("switch", { name: SWITCH }).click();
 await row.getByRole("heading", { name: "Saved environment", level: 3 }).scrollIntoViewIfNeeded();
 await page.evaluate(() => { scrollBy(0, -80); });
 await evidenceShot(page, { path: `.test-build/web-e2e/sv1l-phone-checklist-open-${theme}.png` });
 await row.getByRole("button", { name: "Save" }).click();
 await expect(row.getByText("Saved. New tasks set up fresh.")).toBeVisible();
 await expect(row.getByText("Off for this project. Every new task sets up fresh.")).toBeVisible();
 expect(puts).toEqual([{ enabled: false }]);
 // The Saved environment section below says the same, and offers no Reset while it is off.
 const section = page.getByRole("region", { name: "Saved environment" }).filter({ has: page.getByRole("heading", { name: "Saved environment", level: 2 }) });
 await expect(section.getByText("Off for this project. Every new task sets up fresh, and no saved copy is built.")).toBeVisible();
 await expect(section.getByRole("button", { name: "Reset" })).toHaveCount(0);
 await fitsThePhone(page);
 await checkA11y(page, { theme });
 await section.scrollIntoViewIfNeeded();
 await evidenceShot(page, { path: `.test-build/web-e2e/sv1l-phone-section-off-${theme}.png` });
});

test("a person who can't change it reads the setting and who can, with no switch, on a phone", async ({ page, context, request, baseURL }) => {
 await open(page, context, request, baseURL!, false);
 const section = page.getByRole("region", { name: "Saved environment" });
 await expect(section.getByText("You can see this setting but not change it. Ask a maintainer of this project.")).toBeVisible();
 await expect(section.getByRole("switch")).toHaveCount(0);
 await fitsThePhone(page);
 await checkA11y(page, { theme: "light" });
 await section.scrollIntoViewIfNeeded();
 await evidenceShot(page, { path: ".test-build/web-e2e/sv1l-phone-viewer.png" });
});
