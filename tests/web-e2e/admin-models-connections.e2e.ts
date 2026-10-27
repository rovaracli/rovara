import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async ({ context, request, baseURL, page }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.route("**/v1/web/models", route => route.fulfill({ json: { models: [{ provider: "openai", modelId: "builtin-model", label: "Builtin", company: "openai", sources: ["rovara", "personal-chatgpt"] }] } }));
 await page.route("**/v1/web/org/model-sources", route => route.fulfill({ json: { sources: [{ sourceId: "src_aaaaaaaaaaaaaaaaaaaa", kind: "openai", label: "Company source", hasCredential: true, inOrder: true, models: [{ catalog: { provider: "openai", modelId: "sample-model" } }] }], order: ["rovara"] } }));
 await page.route("**/v1/web/connections", route => route.fulfill({ json: { connections: [{ connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Company tracker", hasCredential: true, identity: "service", updatedAt: "2026-10-01T00:00:00Z", lastCheck: { ok: true, at: "2026-10-01T00:00:00Z" } }] } }));
 await page.route("**/v1/web/github/requests", route => route.fulfill({ json: { requests: [{ status: "waiting", accountLogin: "Pending organization", requestedAt: "2026-10-01T00:00:00Z" }] } }));
 await page.route("**/v1/web/github/installations", route => route.fulfill({ json: { installations: [{ installationId: 7, accountLogin: "Example organization", status: "suspended" }] } }));
 await page.route("**/v1/web/approvals?status=PENDING", route => route.fulfill({ json: { approvals: [{ approvalId: "apr_fixture", kind: "step", status: "PENDING", createdAt: "2026-10-01T00:00:00Z", confirmUrl: new URL(route.request().url()).origin + "/v1/app/approve/apr_fixture" }] } }));
 await page.route("**/v1/web/spend-requests", route => route.fulfill({ json: { spendRequests: [{ spendRequestId: "spr_fixture", status: "PENDING", createdAt: "2026-10-01T00:00:00Z", amountUsd: 12, confirmUrl: new URL(route.request().url()).origin + "/v1/app/approve/spr_fixture" }] } }));
});
for (const theme of ["light", "dark"] as const) test(`read-only lane C journeys and accessibility in ${theme}`, async ({ page }) => {
 const mutations: string[] = [];page.on("request", r => { if (r.url().includes("/v1/web/") && r.method() !== "GET") mutations.push(r.method()); });
 for (const [path, title] of [["models/sources", "AI models"], ["models/available", "Available models"], ["models/steps", "Code step models"], ["connections", "Connections"], ["waiting", "Waiting for people"]]) {
  await page.goto("/app/admin/" + path);await expect(page.getByRole("heading", { name: title!, exact: true })).toBeVisible();await expect(page.getByRole("progressbar")).toHaveCount(0);await checkA11y(page, { theme });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (theme === "light") await page.screenshot({ path: ".superpowers/sdd/codex/c1-" + path!.replaceAll("/", "-") + ".png" });
 }
 expect(mutations).toEqual([]);
});

test("opens waiting confirmations in a separate window without an opener or referrer", async ({ page, context }) => {
 await context.route("**/v1/app/approve/apr_fixture", route => route.fulfill({ contentType: "text/html", headers: { "Cross-Origin-Opener-Policy": "same-origin" }, body: "<!doctype html><title>Confirmation fixture</title><p>Protected confirmation destination</p>" }));
 await page.goto("/app/admin/waiting");const open = page.getByRole("button", { name: "Open confirmation" }).first();await expect(open).toBeVisible();expect(context.pages()).toHaveLength(1);
 const popup = page.waitForEvent("popup");await open.click();const confirmation = await popup;await confirmation.waitForLoadState();expect(await confirmation.evaluate(() => window.opener === null)).toBe(true);expect(await confirmation.evaluate(() => document.referrer)).toBe("");await expect(confirmation).toHaveURL(/\/v1\/app\/approve\/apr_fixture$/);await expect(page).toHaveURL(/\/app\/admin\/waiting$/);await confirmation.close();
});
test("does not offer the desktop waiting queue from phone navigation", async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();await page.getByRole("button", { name: "Open workspace menu" }).click();await expect(page.getByRole("link", { name: "Waiting for people" })).toHaveCount(0);
});

for(const theme of ["light","dark"] as const)test(`opens scoped connection guidance with keyboard and no requests in ${theme}`,async({page})=>{
 await page.emulateMedia({colorScheme:theme});const writes:string[]=[],reads:string[]=[];page.on("request",r=>{const path=new URL(r.url()).pathname;if(path.startsWith("/v1/web/")&&r.method()!=="GET")writes.push(path);if(["/v1/web/connections","/v1/web/github/requests","/v1/web/github/installations"].includes(path))reads.push(path);});
 await page.goto("/app/admin/connections");const linear=page.locator("summary").filter({hasText:"Guidance for Company tracker"}),github=page.locator("summary").filter({hasText:"GitHub guidance for Example organization"}),slack=page.locator("summary").filter({hasText:"Slack setup guidance"});await expect(linear).toBeVisible();await expect(github).toBeVisible();await expect(page.getByText(/Pending organization/)).toBeVisible();await expect(page.getByRole("progressbar")).toHaveCount(0);const before=reads.length;
 await linear.focus();await linear.press("Space");const detail=linear.locator("..");await expect(detail).toHaveAttribute("open","");await expect(linear).toBeFocused();await expect(detail.getByText(/Current health is unknown/)).toBeVisible();await expect(detail.getByText(/workspace and team access/)).toBeVisible();await github.focus();await github.press("Enter");await expect(github.locator("..").getByText("Stored installation state: Suspended.",{exact:true})).toBeVisible();await slack.focus();await slack.press("Space");await expect(slack.locator("..").getByText(/No company-scoped Slack installation, permission or event data/)).toBeVisible();await checkA11y(page,{theme});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await detail.screenshot({path:`.superpowers/sdd/codex/c12-guidance-${theme}.png`});await linear.focus();await linear.press("Enter");await expect(detail).not.toHaveAttribute("open","");await expect(linear).toBeFocused();expect(reads).toHaveLength(before);expect(writes).toEqual([]);
});
