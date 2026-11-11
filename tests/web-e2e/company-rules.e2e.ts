// Settings > Company rules in a real browser against stand-in routes (support/company-rules-mock.ts): edit, propose, wait, a different admin approves; the limits block a send; the page on a phone; the switch off; light and dark with no accessibility violations.
import type { Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
import { mockCompanyRules } from "./support/company-rules-mock.js";

test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
const open = async (page: Page) => { await page.goto("/app/admin/company-rules");await expect(page.getByRole("heading", { name: "Company rules", exact: true, level: 1 })).toBeVisible();await expect(page.getByRole("heading", { name: "Current rules" })).toBeVisible(); };
/** Nothing scrolls sideways, and every visible control sits inside the screen's width. */
async function fitsThePhone(page: Page) {
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 const outside = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button, main a, main input, main select, main textarea, main summary")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > innerWidth + 1); }).map(node => node.textContent?.slice(0, 40) ?? node.tagName));
 expect(outside).toEqual([]);
 // Every control a finger presses is at least 44 by 44.
 const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main button, main summary, main input:not([type=checkbox]), main select, main textarea")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && (box.height < 43.5 || box.width < 43.5); }).map(node => (node.textContent ?? node.tagName).slice(0, 40)));
 expect(small).toEqual([]);
}

test("an admin edits a rule, proposes it and waits for a second admin; a different admin approves and the new version shows", async ({ page }, testInfo) => {
 await page.setViewportSize({ width: 1280, height: 1000 });
 const mock = await mockCompanyRules(page);
 await open(page);
 await expect(page.getByText("Version 1, approved by Rovara setup on Nov 11, 2026 UTC.")).toBeVisible();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("current-light.png"), fullPage: true });
 await page.getByRole("button", { name: "Edit the rules" }).click();
 await expect(page.getByLabel(/^Rule \d+$/u)).toHaveCount(14);
 const submit = page.getByRole("button", { name: "Propose this change" });
 await expect(submit).toBeDisabled();
 await page.getByLabel("Rule 13", { exact: true }).fill("Prefer the cheapest model that can do the step well, and explain when a step needs more.");
 await page.getByRole("button", { name: "Move down, rule 1", exact: true }).click();
 // The rule that moved is rule 2 now, and the keyboard focus stayed on its button.
 await expect(page.getByRole("button", { name: "Move down, rule 2", exact: true })).toBeFocused();
 await page.getByRole("button", { name: "Move up, rule 2", exact: true }).click();
 await page.getByLabel(/^Note for the other admin/u).fill("Shorter wording for rule 13");
 await expect(page.getByLabel("The standing instructions block as agents read it")).toContainText("Prefer the cheapest model that can do the step well, and explain when a step needs more.");
 await expect(page.getByText(/Rules 14\/30/u)).toBeVisible();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("edit-light.png"), fullPage: true });
 await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath("edit-dark.png"), fullPage: true });
 await submit.click();
 await expect(page.getByText("Proposed. It is waiting for a second admin.")).toBeVisible();
 const pending = page.getByRole("region", { name: "Waiting for a decision" }).or(page.locator("section").filter({ has: page.getByRole("heading", { name: "Waiting for a decision" }) }));
 await expect(pending.getByText("Waiting for a second admin", { exact: true })).toBeVisible();
 await expect(pending.getByRole("button", { name: "Cancel this proposal" })).toBeVisible();
 await expect(pending.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
 await expect(pending.getByText(/You proposed this, so you can't approve it/u)).toBeVisible();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("pending-proposer-light.png"), fullPage: true });
 expect(mock.requests.filter(row => row.action === "propose")).toHaveLength(1);
 // The same person pressing a decision is refused by the server in its own words (the page would not show the button; this proves the server decides).
 // A different admin signs in and sees Approve and Reject.
 mock.viewer = "omar";
 await page.reload();
 const waiting = page.locator("section").filter({ has: page.getByRole("heading", { name: "Waiting for a decision" }) });
 await expect(waiting.getByText("A change is waiting for your decision")).toBeVisible();
 await expect(waiting.getByRole("group", { name: "The proposal against the current rules" })).toContainText("1 changed");
 await expect(waiting.getByRole("button", { name: "Cancel this proposal" })).toHaveCount(0);
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("pending-approver-light.png"), fullPage: true });
 await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath("pending-approver-dark.png"), fullPage: true });
 await waiting.getByRole("button", { name: "Approve", exact: true }).click();
 await expect(page.getByText(/Approved\. The new version applies/u)).toBeVisible();
 await expect(page.getByRole("heading", { name: "Waiting for a decision" })).toHaveCount(0);
 await expect(page.getByText(/Version 2, approved by Omar Owner/u)).toBeVisible();
 expect(mock.requests.find(row => row.action === "approve")?.body).toMatchObject({ action: "approve", expectedDigest: "d".repeat(64) });
 await expect(page.getByRole("heading", { name: "Version 2" })).toBeVisible();
 await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath("approved-dark.png"), fullPage: true });
});

test("the proposer cannot approve: the server refuses in its own words when it is pressed anyway", async ({ page }) => {
 await page.setViewportSize({ width: 1280, height: 900 });
 const mock = await mockCompanyRules(page);
 await open(page);
 mock.pending = { proposer: "ada", rules: mock.rules.map((rule, index) => (index === 0 ? { ...rule, text: "Never put secrets anywhere." } : rule)), note: null };
 // A page that is stale (it was loaded as a different admin) shows Approve; the server still decides.
 mock.viewer = "omar";
 await page.reload();
 await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
 mock.viewer = "ada";
 await page.getByRole("button", { name: "Approve", exact: true }).click();
 await expect(page.getByRole("alert")).toContainText("You proposed this change, so a different owner or admin has to decide it.");
});

test("an over-limit rule blocks the send with the exact size sentence, and 600 characters go through", async ({ page }, testInfo) => {
 await page.setViewportSize({ width: 1280, height: 900 });
 const mock = await mockCompanyRules(page);
 await open(page);
 await page.getByRole("button", { name: "Edit the rules" }).click();
 await page.getByLabel("Rule 1", { exact: true }).fill("x".repeat(601));
 await expect(page.getByText("Company rules exceed the size budget: rule 1 has 601 characters, at most 600. Shorten it.")).toBeVisible();
 await expect(page.getByText("601/600 characters")).toBeVisible();
 await expect(page.getByRole("button", { name: "Propose this change" })).toBeDisabled();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("over-limit-light.png"), fullPage: true });
 await checkA11y(page, { theme: "dark" });
 expect(mock.requests.filter(row => row.method === "POST")).toHaveLength(0);
 await page.getByLabel("Rule 1", { exact: true }).fill("x".repeat(600));
 await expect(page.getByRole("button", { name: "Propose this change" })).toBeEnabled();
 await page.getByRole("button", { name: "Propose this change" }).click();
 await expect(page.getByText("Proposed. It is waiting for a second admin.")).toBeVisible();
 expect(mock.requests.filter(row => row.action === "propose")).toHaveLength(1);
});

test("on a 390px phone the page is one column, nothing scrolls sideways and every control is at least 44px", async ({ page }, testInfo) => {
 await page.setViewportSize({ width: 390, height: 844 });
 const mock = await mockCompanyRules(page);
 await open(page);
 await expect(page.getByRole("button", { name: "Settings menu" })).toBeVisible();
 await fitsThePhone(page);await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("phone-current.png"), fullPage: true });
 await page.getByRole("button", { name: "Edit the rules" }).click();
 await expect(page.getByLabel("Rule 1", { exact: true })).toBeVisible();
 await fitsThePhone(page);await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("phone-edit.png"), fullPage: true });
 await checkA11y(page, { theme: "dark" });
 await page.getByLabel("Rule 1", { exact: true }).fill("x".repeat(700));
 await fitsThePhone(page);await evidenceShot(page, { path: testInfo.outputPath("phone-over-limit.png"), fullPage: true });
 mock.pending = { proposer: "omar", rules: mock.rules.map((rule, index) => (index === 2 ? { ...rule, text: "Never delete tests." } : rule)), note: "A long note that should wrap onto several lines on a narrow phone screen without any horizontal scrolling at all." };
 mock.viewer = "ada";
 await page.reload();
 await expect(page.getByRole("heading", { name: "Waiting for a decision" })).toBeVisible();
 await fitsThePhone(page);await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("phone-pending.png"), fullPage: true });
 await checkA11y(page, { theme: "dark" });
});

test("a connected repository file shows its status, difference and actions, and fits the phone", async ({ page }, testInfo) => {
 await page.setViewportSize({ width: 390, height: 844 });
 const mock = await mockCompanyRules(page);
 mock.sync = true;
 await open(page);
 const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Company repository file" }) });
 await expect(section.getByText("In sync.", { exact: false })).toBeVisible();
 await expect(section.getByText("Connected to acme/company-meta, file .rovara/company-rules.md on main.")).toBeVisible();
 await expect(section.getByRole("button", { name: "Sync now" })).toBeVisible();
 await fitsThePhone(page);await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath("phone-sync.png"), fullPage: true });
 await section.getByRole("button", { name: "Disconnect" }).click();
 await section.getByRole("button", { name: "Yes, disconnect" }).click();
 await expect(section.getByText("No repository file is connected.")).toBeVisible();
 await section.getByLabel("Repository", { exact: true }).fill("acme/company-meta");
 await section.getByRole("button", { name: "Connect a file" }).click();
 await expect(section.getByText(/Connected to acme\/company-meta/u)).toBeVisible();
 expect(mock.requests.filter(row => row.method === "POST").map(row => row.action)).toEqual(["sync-disconnect", "sync-connect"]);
});

test("with the switch off the page says so and offers nothing to edit", async ({ page }, testInfo) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await mockCompanyRules(page, { off: true });
 await page.goto("/app/admin/company-rules");
 await expect(page.getByText(/Company rules are switched off for this install/u)).toBeVisible();
 await expect(page.getByRole("button", { name: /Edit the rules|Propose/u })).toHaveCount(0);
 await fitsThePhone(page);await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath("switched-off.png"), fullPage: true });
});

test("the settings menu lists Company rules and opens the page", async ({ page }) => {
 await page.setViewportSize({ width: 1280, height: 900 });
 await mockCompanyRules(page);
 await page.goto("/app/admin/people");
 await page.getByRole("navigation", { name: "Administration" }).getByRole("link", { name: "Company rules" }).click();
 await expect(page.getByRole("heading", { name: "Company rules", exact: true, level: 1 })).toBeFocused();
});
