// Slice 5 "Outside tools": the project's Tickets section (waiting tickets, a failing watched source, what Rovara writes back) and the Home ticket card (Start / Not this one).
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
test.beforeEach(async ({ context, request, baseURL, page }) => {
 await request.post("/__mock/scenario", { data: { name: "project" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await mockRealtime(page);
});
type Sent = Array<{ method: string; path: string; body?: unknown }>;

test("the Tickets section shows why a ticket waits, why a source fails, and saves the write-back switch", async ({ page, request }, testInfo) => {
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/projects/payments");
 const section = page.locator("#tickets");
 await expect(section.getByRole("heading", { name: "Tickets from Linear, Jira and GitHub" })).toBeVisible();
 await expect(section.getByText("Jira PAY-12: Refunds fail twice")).toBeVisible();
 await expect(section.getByText(/Nobody in your company is linked to the tracker account that asked/)).toBeVisible();
 await expect(section.getByText(/Linear: label "rovara"\. Failing since .*No connection for this tracker is set up for your company\./)).toBeVisible();
 await expect(section.getByText(/Rovara can't comment in Jira/)).toBeVisible();
 const status = section.getByRole("checkbox", { name: "Also change the ticket's status" });
 await expect(status).not.toBeChecked();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("tickets-section-light.png"), fullPage: true });
 await status.click();await expect(section.getByRole("textbox", { name: "Work started: status" })).toHaveValue("In Progress");
 await section.getByRole("button", { name: "Save", exact: true }).click();await expect(section.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
 const sent = await (await request.get("/__mock/requests")).json() as Sent;
 const saves = sent.filter(item => item.method === "PUT" && item.path.endsWith("/intake/updates"));
 expect(saves).toHaveLength(1);expect(saves[0]?.body).toMatchObject({ settings: { comments: true, changeStatus: true, statuses: { started: "In Progress" } } });
 await page.setViewportSize({ width: 360, height: 800 });expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: testInfo.outputPath("tickets-section-dark-phone.png"), fullPage: true });
});

test("Start on a waiting ticket in the section starts it once and opens its session", async ({ page, request }) => {
 await page.goto("/app/projects/payments");
 await page.locator("#tickets").getByRole("button", { name: "Start PAY-12", exact: true }).click();
 await expect(page).toHaveURL(/\/s\/ses_bbbbbbbbbbbbbbbbbbbb$/u);
 const sent = await (await request.get("/__mock/requests")).json() as Sent;
 expect(sent.filter(item => item.method === "POST" && item.path.endsWith("/start"))).toHaveLength(1);
});

test("the Home ticket card says why it waits, and Not this one takes it off Home", async ({ page, request }, testInfo) => {
 await request.post("/__mock/ticket-on-home");
 await page.goto("/app");
 await expect(page.getByRole("heading", { name: "Jira PAY-12: Refunds fail twice" })).toBeVisible();
 await expect(page.getByText(/Waiting to start in "payments"\. Nobody in your company is linked/)).toBeVisible();
 await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("home-ticket-card.png"), fullPage: true });
 await page.getByRole("button", { name: "Not this one", exact: true }).click();
 await expect(page.getByRole("heading", { name: "Jira PAY-12: Refunds fail twice" })).toHaveCount(0);
 const sent = await (await request.get("/__mock/requests")).json() as Sent;
 const dismissals = sent.filter(item => item.method === "POST" && item.path.endsWith("/dismiss"));
 expect(dismissals).toHaveLength(1);expect(dismissals[0]?.path).toBe("/v1/web/projects/payments/intake/" + "a".repeat(32) + "/dismiss");
});
