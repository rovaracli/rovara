// Company settings on a phone (decision D25): every admin page, at 360 and 390 px, in look off and look v2. No sideways scroll, every control 44px, axe clean in light and dark, focus visible.
// The 1280 pictures (ROVARA_ADMIN_SHOTS names the folder) are for a byte-for-byte comparison against the base: desktop must not change.
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect as baseExpect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
import { AUDIT_LIMITS_COPY } from "../../packages/ui/src/screens/admin/audit/metadata.js";
// Same checks, a longer wait: under parallel or long runs a first paint or a menu open can take more than the default 5 s. No assertion changed.
const expect = baseExpect.configure({ timeout: 15_000 });
const shots = process.env.ROVARA_ADMIN_SHOTS ?? ".test-build/web-e2e/admin-phone";
const PAGES = [
 ["overview", "/app/admin", "Company settings"], ["people", "/app/admin/people", "People"], ["roles", "/app/admin/people/roles", "Roles"], ["invites", "/app/admin/invites", "Invites"],
 ["tracker-people", "/app/admin/tracker-people", "Tracker people"], ["connections", "/app/admin/connections", "Connections"], ["ai-models", "/app/admin/models/sources", "AI models"],
 ["domains", "/app/admin/domains", "Company domains"], ["second-opinion", "/app/admin/second-review", "Second opinion"], ["audit", "/app/admin/audit", "Audit"],
 ["projects", "/app/admin/projects", "Projects"], ["project-detail", "/app/admin/projects/payments", "payments"], ["agents", "/app/admin/agents", "Agents"], ["agent-versions", "/app/admin/agents/rovara-code/versions", "Agent versions"],
 ["how-we-work", "/app/admin/how-we-work", "How we work (company)"], ["recipes", "/app/admin/how-we-work/recipes", "Setup recipes"], ["images", "/app/admin/how-we-work/images", "Test images"],
 ["spending", "/app/admin/money/budgets", "Spending"], ["waiting", "/app/admin/waiting", "Waiting for people"],
] as const;
const auditStatus = { headSeq: 3, sealedThroughSeq: 2, latestTimestamp: "2026-10-01T00:00:00Z", epochsWithoutTimestamp: ["epoch"], lockMode: "GOVERNANCE" };
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>) {
 await request.post("/__mock/scenario", { data: { name: "admin" } });await request.post("/__mock/admin-invites");
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.route("**/v1/web/org/model-sources", route => route.fulfill({ json: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", sources: [{ sourceId: "src_aaaaaaaaaaaaaaaaaaaa", kind: "openai", label: "Company source with a rather long display name to wrap", hasCredential: true, inOrder: true, models: [{ catalog: { provider: "openai", modelId: "sample-model" } }] }], order: ["rovara"] } }));
 await page.route("**/v1/web/connections", route => route.fulfill({ json: { connections: [{ connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Company tracker", hasCredential: true, identity: "service", updatedAt: "2026-10-01T00:00:00Z", lastCheck: { ok: true, at: "2026-10-01T00:00:00Z" } }] } }));
 await page.route("**/v1/web/github/requests", route => route.fulfill({ json: { requests: [] } }));
 await page.route("**/v1/web/github/installations", route => route.fulfill({ json: { installations: [{ installationId: 7, accountLogin: "Example organization", accountType: "Organization", repositorySelection: "all", status: "suspended" }] } }));
 await page.route("**/v1/web/org/audit/status", route => route.fulfill({ json: { ...auditStatus, limits: AUDIT_LIMITS_COPY } }));
 await page.route("**/v1/web/org/audit/records?*", route => route.fulfill({ json: { ...auditStatus, records: [{ record: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", seq: 1, action: "member.role_changed", recordedAt: "2026-10-01T00:00:01Z", occurredAt: "2026-10-01T00:00:00Z", actor: { kind: "member", id: "actor-pseudonym-with-a-long-identifier-0123456789abcdef" }, target: { kind: "member", id: "target-pseudonym-with-a-long-identifier-0123456789abcdef" }, facts: {} }, sealed: true }], nextCursor: undefined } }));

 await page.route("**/v1/web/org/tracker-people", route => route.fulfill({ json: { unmatched: [{ tool: "Linear", system: "linear", sourceId: "lin-sam-with-a-rather-long-tool-identifier", displayName: "Sam K", reason: "no_verified_domains" }, { tool: "Jira", system: "jira:acme.atlassian.net", sourceId: "acc-9", displayName: "Nine" }], linked: [{ tool: "Linear", system: "linear", sourceId: "lin-priya", displayName: "Priya R", developerId: "a".repeat(64), via: "admin" }, { tool: "Linear", system: "linear", sourceId: "lin-auto", displayName: "Auto A", developerId: "b".repeat(64), via: "auto", why: "domain_company_account_exact_email" }], truncated: false, autoLink: { enabled: false, verifiedDomainsRecorded: false } } }));
 const recipe = (changes: Record<string, unknown> = {}) => ({ recipeId: "rcp_" + "1".repeat(20), revision: 1, status: "proposed", digest: "d".repeat(64), label: "Python services with a rather long label", buildSystems: ["python"], toolchains: [{ tool: "python", version: "3.12" }], setup: [{ line: "{repo}: uv sync --frozen --no-install-project --extra-index-url https://pypi.internal.example.com/simple", timeoutSeconds: 600 }], update: [], checks: [{ id: "unit", label: "Unit tests", kind: "test", command: { line: "{repo}: pytest -q", timeoutSeconds: 600 } }], approvedHosts: ["pypi.internal.example.com"], match: { markerFiles: ["pyproject.toml"], registryHosts: ["pypi.internal.example.com"] }, scope: { kind: "company" }, fromProject: true, proposedBy: "Maya Chen", replaces: [], createdByYou: false, updatedAt: "2026-11-02T09:00:00.000Z", ...changes });
 await page.route("**/v1/web/org/setup-recipes", route => route.fulfill({ json: { recipes: [recipe(), recipe({ recipeId: "rcp_" + "2".repeat(20), status: "approved", revision: 2, label: "Node services", scope: { kind: "projects", projects: ["payments"] } })], unreadable: [], projects: ["payments", "billing"], markerFiles: ["package.json", "pyproject.toml"] } }));
 const image = (changes: Record<string, unknown> = {}) => ({ imageId: "img_" + "1".repeat(20), revision: 1, status: "proposed", image: "postgres:18", registry: "docker.io", official: true, digest: "d".repeat(64), family: "postgres", version: "18", origin: "setup", project: "payments", proposedBy: "Maya Chen", proposedByYou: false, proposedAt: "2026-11-11T09:00:00.000Z", updatedAt: "2026-11-11T09:00:00.000Z", ...changes });
 await page.route("**/v1/web/org/test-images", route => route.fulfill({ json: { images: [image(), image({ imageId: "img_" + "5".repeat(20), image: "acme/postgres-with-a-long-name:16", registry: "ghcr.io", official: false }), image({ imageId: "img_" + "6".repeat(20), image: "mysql:9", family: "mysql", status: "approved", revision: 2 })], catalogAvailable: true, kinds: ["mysql", "postgres", "redis"] } }));
 const record = (domain: string) => ({ type: "TXT", name: "_rovara-verify." + domain, value: "rovara-verify=" + "c".repeat(40) });
 await page.route("**/v1/web/org/domains", route => route.fulfill({ json: { domains: [{ domain: "acme.example", state: "pending", addedAt: "2026-11-02T09:00:00.000Z", record: record("acme.example") }, { domain: "verified-company-domain.example", state: "verified", addedAt: "2026-11-02T09:00:00.000Z", verifiedAt: "2026-11-02T10:00:00.000Z", record: record("verified-company-domain.example") }, { domain: "missing.example", state: "verified", addedAt: "2026-11-02T09:00:00.000Z", verifiedAt: "2026-11-02T10:00:00.000Z", missingSince: "2026-11-09T09:00:00.000Z", lastCheckedAt: "2026-11-10T09:00:00.000Z", lastResult: "not_found", record: record("missing.example") }, { domain: "gone.example", state: "lost", addedAt: "2026-11-02T09:00:00.000Z", lostAt: "2026-11-05T09:00:00.000Z", record: record("gone.example") }], max: 20, lostAfterDays: 3 } }));
 const gpt = { provider: "openrouter", modelId: "openai/gpt-5.5" }, claude = { provider: "amazon-bedrock", modelId: "anthropic.claude-opus-4-1" };
 await page.route("**/v1/web/org/second-review", route => route.request().method() !== "GET" ? route.fulfill({ json: { status: "applied" } }) : route.fulfill({ json: { mode: "shadow", modes: { company: "shadow", project: null, effective: "shadow" }, fitKnown: false, pendingLowering: false, evidence: null, trackRecord: null, notice: { key: "a".repeat(32), code: "stopped_qualifying", seen: false, lines: ["The second opinion model stopped qualifying for blocking, so it now only comments."], createdAt: "2026-11-01T00:00:00.000Z" }, context: "change_only", alsoSees: null, models: [{ model: gpt, company: "openai", costUsd: 0.2, eligible: true, notes: [], suggested: true, suggestionReason: "top-tier strength; a different AI company than the one that wrote the code; medium cost (about $0.20 a review)" }, { model: claude, company: "anthropic", costUsd: 0.4, eligible: false, ineligibleWhy: "same-company", notes: [], suggested: false }], suggested: [gpt], typicalReview: { input: 60000, output: 4000 }, choice: null, projectNarrowing: null, current: { source: "default", models: [gpt], line: "Using default: openai/gpt-5.5 (change)" } } }));
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 await page.emulateMedia({ reducedMotion: "reduce" });await page.clock.setFixedTime(new Date("2026-11-11T12:00:00Z"));await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const wide = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main *")].filter(node => { const box = node.getBoundingClientRect(), own = node.closest("thead,[data-scroll-region],[role=region][tabindex],.rv-scroll-x");return own === null && box.width > 0 && box.height > 0 && box.right > innerWidth + 1; }).slice(0, 6).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 24)));
// Visible controls under 44px tall. Links inside a sentence are exempt (WCAG 2.5.8); every other link, button, field, tab and summary counts.
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a, main button, main input:not([type=checkbox]):not([type=radio]), main select, main textarea, main summary, main [role=tab], main [role=switch]")].filter(node => { const box = node.getBoundingClientRect(), block = node.tagName === "A" ? node.closest("p,li,dd") : null;if (block !== null) { const rest = [...block.querySelectorAll("a")].reduce((text, link) => text.replace(link.textContent ?? "", ""), block.textContent ?? "").replaceAll(/[\s·,;:|()-]/gu, "");if (/\p{L}{2}/u.test(rest) && block.tagName !== "LI") return false; }return box.width > 0 && box.height > 0 && box.height < 43.5; }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
async function settled(page: Page, heading: string) {
 await expect(page.getByRole("heading", { name: heading, level: 1 }).first()).toBeVisible();
 await expect(page.getByRole("progressbar")).toHaveCount(0);await page.waitForLoadState("networkidle");
}
for (const look of [{ name: "look-v2", store: {} }] as const) for (const [id, path, heading] of PAGES) {
 test(`${id} fits a phone in ${look.name}`, async ({ page, context, request, baseURL }) => {
  const issues: string[] = [];
  for (const width of [360, 390]) {
   await enter(page, context, request, baseURL, width, look.store);await page.goto(path);await settled(page, heading);
   if (!(await noSidewaysScroll(page))) issues.push(`${String(width)}: page scrolls sideways`);
   for (const item of await wide(page)) issues.push(`${String(width)}: wider than the screen ${item}`);
   for (const item of await smallTargets(page)) issues.push(`${String(width)}: small target ${item}`);
   if (width === 390) await evidenceShot(page, { path: `${shots}/${id}-${look.name}-390.png`, fullPage: true });
   if (width === 360) await evidenceShot(page, { path: `${shots}/${id}-${look.name}-360.png`, fullPage: true });
  }
  expect(issues).toEqual([]);
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
// Desktop must not change: these pictures are compared with the base's, byte for byte.
for (const [id, path, heading] of PAGES) test(`${id} desktop picture`, async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, 1280, {});await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });await page.goto(path);await settled(page, heading);
 // The server stamps "Read at" times and new invites with its own clock, which the browser's fixed clock cannot reach: the times are replaced by a word, the same way for the base and for this branch.
 await page.evaluate(() => { const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) node.textContent = (node.textContent ?? "").replaceAll(/\d{1,2}\/\d{1,2}\/\d{4},? ?\d{1,2}:\d{2}(?::\d{2})? [AP]M(?: UTC)?|\d{1,2}:\d{2}(?::\d{2})? [AP]M/gu, "TIME"); });
 await evidenceShot(page, { path: `${shots}/${id}-1280.png`, fullPage: true });
});
// The settings menu, open: one column of groups, every row 44px, the list scrolls inside itself, and the page still does not scroll sideways.
for (const width of [360, 390]) test(`the settings menu is a grouped list of 44px rows at ${String(width)}px`, async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, width, {});await page.goto("/app/admin/people");await settled(page, "People");
 const menu = page.getByRole("button", { name: "Settings menu" });await menu.click();await expect(menu).toHaveAttribute("aria-expanded", "true");
 for (const group of ["People and access", "Connections and models", "Money and limits", "How work runs", "Security and sign-in"]) await expect(page.getByRole("group", { name: group })).toBeVisible();
 const rows = await page.locator(".rv-admin-nav-list a").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect();return { text: node.textContent ?? "", height: box.height, left: box.left, right: box.right }; }));
 expect(rows.length).toBeGreaterThan(12);expect(rows.filter(row => row.height < 43.5 || row.left < 0 || row.right > width).map(row => row.text)).toEqual([]);
 expect(await noSidewaysScroll(page)).toBe(true);
 expect(await page.locator(".rv-admin-nav-list").evaluate(node => getComputedStyle(node).overflowY)).toBe("auto");
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await evidenceShot(page, { path: `${shots}/menu-open-${String(width)}.png`, fullPage: false });
 await page.getByRole("link", { name: "Audit", exact: true }).click();await expect(page.getByRole("heading", { name: "Audit", level: 1 })).toBeVisible();await expect(menu).toHaveAttribute("aria-expanded", "false");
});
// Dialogs and confirmations on a phone: inside the screen, forms in one column, every control 44px, axe clean in both themes.
async function dialogFits(page: Page, width: number, name: string) {
 const dialog = page.getByRole("dialog", { name });await expect(dialog).toBeVisible();
 const box = await dialog.boundingBox();expect(box !== null && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 844).toBe(true);
 const small = await dialog.evaluate(node => [...node.querySelectorAll<HTMLElement>("button, a, input:not([type=checkbox]):not([type=radio]), select, textarea")].filter(control => { const rect = control.getBoundingClientRect();return rect.width > 0 && rect.height > 0 && rect.height < 43.5; }).map(control => control.tagName + ":" + (control.textContent ?? "").slice(0, 30) + ":" + String(Math.round(control.getBoundingClientRect().height))));
 expect(small).toEqual([]);expect(await noSidewaysScroll(page)).toBe(true);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await evidenceShot(page, { path: `${shots}/dialog-${name.replaceAll(/\W+/gu, "-")}-${String(width)}.png` });
 return dialog;
}
for (const width of [360, 390]) test(`role change, removal and invite dialogs fit a ${String(width)}px phone`, async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, width, { "rovara.look": "v2" });await page.goto("/app/admin/people");await settled(page, "People");
 await page.getByRole("button", { name: "Change role for Maya" }).click();
 const change = await dialogFits(page, width, "Change company role");await page.keyboard.press("Escape");await expect(change).toBeHidden();
 await page.getByRole("button", { name: "Remove Maya from company" }).click();
 await dialogFits(page, width, "Remove from company");await page.keyboard.press("Escape");
 await page.goto("/app/admin/invites");await settled(page, "Invites");
 await page.getByRole("button", { name: "Create invite", exact: true }).click();
 await dialogFits(page, width, "Create invite");
});
// A risky setting on a phone: removing a lock goes through "Review changes", then needs another admin. Every step stays inside the screen with 44px controls.
for (const width of [360, 390]) test(`removing a lock: review, save and the second-admin confirmation work at ${String(width)}px`, async ({ page, context, request, baseURL }) => {
 await enter(page, context, request, baseURL, width, {});await page.goto("/app/admin/how-we-work");await settled(page, "How we work (company)");
 await expect(page.getByRole("region", { name: "Build" })).toBeVisible();
 await page.getByRole("region", { name: "Review (code and security)" }).getByRole("switch", { name: "Lock this stage" }).click();
 await page.getByRole("button", { name: "Review changes" }).click();await expect(page.getByRole("region", { name: "Review of company changes" })).toBeVisible();
 expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
 await page.getByRole("button", { name: "Save company defaults" }).click();
 await expect(page.getByText("Another company admin must confirm this less-safe change.")).toBeVisible();
 const open = page.getByRole("button", { name: "Open confirmation" });await expect(open).toBeVisible();await open.scrollIntoViewIfNeeded();
 expect(await noSidewaysScroll(page)).toBe(true);expect(await wide(page)).toEqual([]);expect(await smallTargets(page)).toEqual([]);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await evidenceShot(page, { path: `${shots}/risky-confirm-${String(width)}.png`, fullPage: true });
});
