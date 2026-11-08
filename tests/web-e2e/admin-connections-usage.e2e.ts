// p1-ux-connections: the Connections page names the projects that use each connection, and adds a monitoring tool with plain fields (the key is cleared and never shown back).
import { test, expect } from "./support/csp.js";
import { evidenceShot } from "./support/screenshot.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
const LINEAR = "con_aaaaaaaaaaaaaaaaaaaa", ADDED = "con_bbbbbbbbbbbbbbbbbbbb";
const connection = (over: Record<string, unknown>) => ({ connectionId: LINEAR, type: "linear", label: "Company tracker", hasCredential: true, access: "read", updatedAt: "2026-10-02T00:00:00Z", lastCheck: { ok: true, at: "2026-10-02T00:00:00Z" }, ...over });
test.beforeEach(async ({ context, request, baseURL, page }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.route("**/v1/web/github/requests", route => route.fulfill({ json: { requests: [] } }));
 await page.route("**/v1/web/github/installations", route => route.fulfill({ json: { installations: [] } }));
 await page.route("**/v1/web/org/model-sources", route => route.fulfill({ json: { sources: [], order: ["rovara"] } }));
 await page.route("**/v1/web/projects", route => route.fulfill({ json: { projects: [] } }));
});
for (const theme of ["light", "dark"] as const) test(`names the projects that use each connection and adds Sentry without echoing its key in ${theme}`, async ({ page }) => {
 await page.emulateMedia({ colorScheme: theme });
 const key = ["sn", "tok", "q".repeat(12)].join("_"), bodies: unknown[] = [];
 let added = false;
 await page.route("**/v1/web/connection-usage", route => route.fulfill({ json: { complete: true, connections: [{ connectionId: LINEAR, projects: ["web", "api"] }, ...(added ? [{ connectionId: ADDED, projects: [] }] : [])], sources: [] } }));
 await page.route("**/v1/web/connections", route => {
  if (route.request().method() === "POST") { bodies.push(route.request().postDataJSON());added = true;return route.fulfill({ status: 201, json: { connection: connection({ connectionId: ADDED, type: "sentry", label: "Sentry", lastCheck: undefined }) } }); }
  return route.fulfill({ json: { connections: added ? [connection({}), connection({ connectionId: ADDED, type: "sentry", label: "Sentry", lastCheck: { ok: true, at: "2026-10-03T00:00:00Z" } })] : [connection({})] } });
 });
 await page.route(`**/v1/web/connections/${ADDED}/check`, route => route.fulfill({ json: { ok: true } }));
 await page.goto("/app/admin/connections");
 await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
 const linear = page.locator('[data-card="linear"]');
 await expect(linear.getByText("api, web", { exact: false })).toBeVisible();
 await expect(linear).not.toContainText("(company-wide connection)");
 await page.locator('[data-card="cloud"]').getByRole("button", { name: /See cloud tools/ }).click();
 await page.getByLabel("Sentry organization").fill("acme");
 await page.getByLabel("Auth token").fill(key);
 await checkA11y(page, { theme });
 await evidenceShot(page, { path: `.superpowers/sdd/p1-ux-connections/add-sentry-${theme}.png` });
 await page.getByRole("button", { name: "Add and check it works" }).click();
 await expect(page.locator('[data-card="cloud"]').getByText("✓ It works. Rovara reached the service with the saved key.")).toBeVisible();
 expect(bodies).toEqual([expect.objectContaining({ connection: expect.objectContaining({ type: "sentry", access: "read", region: "us", orgSlug: "acme" }), secret: { authToken: key } })]);
 await expect(page.getByLabel("Auth token")).toHaveValue("");
 expect(await page.locator("body").innerText()).not.toContain(key);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("keeps the company-wide wording when the usage read is refused", async ({ page }) => {
 await page.route("**/v1/web/connection-usage", route => route.fulfill({ status: 503, json: { error: { code: "RUNTIME_UNAVAILABLE", message: "later" } } }));
 await page.route("**/v1/web/connections", route => route.fulfill({ json: { connections: [connection({})] } }));
 await page.goto("/app/admin/connections");
 await expect(page.locator('[data-card="linear"]').getByText(/company-wide connection/)).toBeVisible();
});
