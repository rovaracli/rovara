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

/**
 * Nothing scrolls sideways, and every visible control sits inside the screen's width. The project page's tab strip is the one place that scrolls on its own by design (`.rv-tabs`, overflow-x: auto): how many tabs fit
 * depends on the font, so on Linux's wider system font the last tab ("Sources") sits past the edge of the strip (0.5.11 CI, all three browsers; it fit on the Mac). The strip itself must fit the screen, and a tab
 * inside it may be scrolled out of view as long as scrolling the strip brings it in.
 */
async function fitsThePhone(page: Page) {
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 const outside = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button, main a, main input, main select, main textarea, main [role=switch]")].filter(node => { if (node.closest("[role=tablist]") !== null) return false;const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(node => node.textContent?.slice(0, 40) ?? node.tagName));
 expect(outside).toEqual([]);
 const strips = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main [role=tablist]")].map(strip => { const box = strip.getBoundingClientRect();const tabs = [...strip.querySelectorAll<HTMLElement>("[role=tab]")];strip.scrollLeft = strip.scrollWidth;const last = tabs[tabs.length - 1]?.getBoundingClientRect();strip.scrollLeft = 0;return { fits: box.left >= -1 && box.right <= innerWidth + 1, lastReachable: last === undefined || (last.right <= box.right + 1 && last.left >= box.left - 1) }; }));
 expect(strips.length).toBeGreaterThan(0);
 expect(strips).toEqual(strips.map(() => ({ fits: true, lastReachable: true })));
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

/**
 * The project page's tab strip scrolls by design, so it says so: a soft fade (a mask on the strip) at each edge that still has tabs past it, only while there are some, and the selected tab is scrolled
 * into view when the page opens and when the tab changes. How many tabs fit depends on the font, so these assert the rule (the fade shows exactly when tabs are hidden past that edge), and that 340px,
 * where a tab is hidden in every browser and font, really has one to show.
 */
async function stripState(page: Page) {
 return page.evaluate(() => {
  const strip = document.querySelector<HTMLElement>("main [role=tablist]")!;
  const style = getComputedStyle(strip), mask = style.maskImage || style.getPropertyValue("-webkit-mask-image") || "none";
  const box = strip.getBoundingClientRect();
  const active = strip.querySelector<HTMLElement>("[role=tab][aria-selected=true]")!.getBoundingClientRect();
  const hidden = strip.scrollWidth > strip.clientWidth + 1;
  return {
   hidden, atStart: strip.scrollLeft <= 1, atEnd: strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1,
   moreStart: strip.hasAttribute("data-more-start"), moreEnd: strip.hasAttribute("data-more-end"),
   faded: mask !== "none",
   activeInside: active.left >= box.left + (strip.scrollLeft > 1 ? 28 : 0) - 1 && active.right <= box.right - (strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1 ? 28 : 0) + 1, selectedLabel: strip.querySelector("[role=tab][aria-selected=true]")!.textContent,
  };
 });
}

for (const width of [340, 390]) test(`the project tab strip fades at the edge with tabs past it, only while there are some, on a ${width}px phone`, async ({ page, context, request, baseURL }) => {
 await open(page, context, request, baseURL!, true);
 await page.setViewportSize({ width, height: 844 });
 const strip = page.getByRole("tablist", { name: "Project" });
 await expect(strip).toBeVisible();
 // Opened on Overview: nothing hidden before it. Tabs hidden after it show the fade at the end only.
 await expect.poll(async () => (await stripState(page)).moreEnd).toBe((await stripState(page)).hidden);
 const first = await stripState(page);
 if (width === 340) expect(first.hidden).toBe(true);
 expect(first).toMatchObject({ atStart: true, moreStart: false, moreEnd: first.hidden, faded: first.hidden, activeInside: true, selectedLabel: "Overview" });
 await page.evaluate(() => { const strip = document.querySelector("main [role=tablist]")!;strip.scrollLeft = strip.scrollWidth; });
 // Scrolled to the end: the end fade is gone and, if the strip scrolled, the start fade shows.
 await expect.poll(async () => (await stripState(page)).moreEnd).toBe(false);
 const end = await stripState(page);
 expect(end).toMatchObject({ atEnd: true, moreStart: end.hidden, faded: end.hidden });
 await page.evaluate(() => { document.querySelector("main [role=tablist]")!.scrollLeft = 0; });
 await expect.poll(async () => (await stripState(page)).moreStart).toBe(false);
 // Overview, How we work, Lessons, Sources and Spending (the Spending tab is on for everyone who may see the project's spend, since decision 116).
 await expect(strip.getByRole("tab")).toHaveCount(5);
 await expect(strip.getByRole("tab", { selected: true })).toHaveCount(1);
});

// Spending is the last tab of the strip (after Sources), so it is the one End reaches and the one that sits at the end of the strip.
for (const width of [340, 390]) test(`the selected project tab is scrolled into view when the page opens, on a tab change and from the keyboard, on a ${width}px phone`, async ({ page, context, request, baseURL }) => {
 await open(page, context, request, baseURL!, true);
 await page.setViewportSize({ width, height: 844 });
 await page.goto("/app/projects/payments?tab=spending");
 const strip = page.getByRole("tablist", { name: "Project" });
 await expect(strip.getByRole("tab", { name: "Spending", selected: true })).toBeVisible();
 await expect.poll(async () => (await stripState(page)).activeInside).toBe(true);
 const spending = await stripState(page);
 expect(spending).toMatchObject({ selectedLabel: "Spending", atEnd: true, moreEnd: false });
 // Back to the first tab by click, then to the last by the keyboard (End), as a screen reader or keyboard user would; each lands in view and the strip still has one selected tab.
 await strip.getByRole("tab", { name: "Overview" }).click();
 await expect.poll(async () => (await stripState(page)).selectedLabel).toBe("Overview");
 await expect.poll(async () => (await stripState(page)).activeInside).toBe(true);
 await strip.getByRole("tab", { name: "Overview" }).focus();
 await page.keyboard.press("End");
 await expect(strip.getByRole("tab", { name: "Spending", selected: true })).toBeFocused();
 await expect.poll(async () => (await stripState(page)).activeInside).toBe(true);
 await expect(strip.getByRole("tab", { selected: true })).toHaveCount(1);
 await expect(page.getByRole("tabpanel")).toHaveCount(1);
});
