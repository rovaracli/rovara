// UX3 item 3: company settings are fully usable on a phone. No sideways scrolling, every control inside the screen, tables as lists, and the settings menu reachable.
import type { Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async ({ context, request, baseURL, page }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.route("**/v1/web/org/model-sources", route => route.fulfill({ json: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", sources: [{ sourceId: "src_aaaaaaaaaaaaaaaaaaaa", kind: "openai", label: "Company source with a rather long display name to wrap", hasCredential: true, inOrder: true, models: [{ catalog: { provider: "openai", modelId: "sample-model" } }] }], order: ["rovara"] } }));
 await page.route("**/v1/web/connections", route => route.fulfill({ json: { connections: [{ connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Company tracker", hasCredential: true, identity: "service", updatedAt: "2026-10-01T00:00:00Z", lastCheck: { ok: true, at: "2026-10-01T00:00:00Z" } }] } }));
 await page.route("**/v1/web/github/requests", route => route.fulfill({ json: { requests: [] } }));
 await page.route("**/v1/web/github/installations", route => route.fulfill({ json: { installations: [{ installationId: 7, accountLogin: "Example organization", accountType: "Organization", repositorySelection: "all", status: "suspended" }] } }));
 await page.setViewportSize({ width: 390, height: 844 });
});
/** Nothing scrolls sideways, and every visible control sits inside the screen's width. */
async function fitsThePhone(page: Page) {
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 const outside = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button, main a, main input, main select, main textarea")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(node => node.textContent?.slice(0, 40) ?? node.tagName));
 expect(outside).toEqual([]);
}
const PAGES = [["/app/admin", "Company settings"], ["/app/admin/people", "People"], ["/app/admin/people/roles", "Roles"], ["/app/admin/invites", "Invites"], ["/app/admin/money/budgets", "Spending"], ["/app/admin/connections", "Connections"], ["/app/admin/models/sources", "AI models"], ["/app/admin/projects", "Projects"], ["/app/admin/agents", "Agents"], ["/app/admin/health", "Rovara service status"]] as const;
for (const theme of ["light", "dark"] as const) test(`every main company settings page fits a 390px phone in ${theme}`, async ({ page }) => {
 await page.emulateMedia({ colorScheme: theme });
 for (const [path, heading] of PAGES) {
  await page.goto(path);await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings menu" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await fitsThePhone(page);await checkA11y(page, { theme });
  if (theme === "light") await evidenceShot(page, { path: ".test-build/web-e2e/ux3-phone-" + path.replaceAll("/", "-") + ".png", fullPage: true });
 }
});
test("the settings menu opens, lists every group, and a link closes it", async ({ page }) => {
 await page.goto("/app/admin/people");
 const menu = page.getByRole("button", { name: "Settings menu" });
 await expect(menu).toHaveAttribute("aria-expanded", "false");await expect(page.getByRole("link", { name: "Connections", exact: true })).toBeHidden();
 await menu.click();await expect(menu).toHaveAttribute("aria-expanded", "true");
 for (const group of ["People and access", "Connections and models", "Money and limits", "How work runs", "Security and sign-in"]) await expect(page.getByRole("group", { name: group })).toBeVisible();
 await fitsThePhone(page);
 await page.getByRole("link", { name: "Connections", exact: true }).click();
 await expect(page.getByRole("heading", { name: "Connections", exact: true, level: 1 })).toBeVisible();await expect(menu).toHaveAttribute("aria-expanded", "false");
});
test("a connection's setup opens in place on a phone and stays inside the screen", async ({ page }) => {
 await page.goto("/app/admin/connections");
 await page.getByRole("button", { name: /^Fix GitHub/ }).click();
 await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();await fitsThePhone(page);
 await page.getByRole("button", { name: /^Manage Linear/ }).click();
 await expect(page.getByRole("button", { name: "Check it works", exact: true })).toBeVisible();await fitsThePhone(page);
 await page.getByRole("button", { name: /^Open AI provider|^Add an AI provider|^Manage AI provider|^Fix AI provider/ }).first().click();
 await fitsThePhone(page);await evidenceShot(page, { path: ".test-build/web-e2e/ux3-phone-connections-open.png", fullPage: true });
});
test("people are a list on a phone: each person's details sit under their name", async ({ page }) => {
 await page.goto("/app/admin/people");
 const row = page.getByRole("row").filter({ hasText: "Maya" });await expect(row).toBeVisible();
 expect(await row.evaluate(node => getComputedStyle(node).display)).toBe("block");
 await expect(page.getByRole("button", { name: "Change role for Maya" })).toBeVisible();await fitsThePhone(page);
});
