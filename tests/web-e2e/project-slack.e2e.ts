import { test, expect } from "./support/csp.js";
import { activate } from "./support/keyboard.js";
import { evidenceShot } from "./support/screenshot.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });expect((await request.post("/__mock/b34-slack-links")).ok()).toBe(true);
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
test("B34 reviews and unlinks one stored channel with keyboard focus and one audit", async ({ page, request }, info) => {
 await page.goto("/app/admin/projects/payments");await activate(page.getByRole("button", { name: "Manage recorded Slack links", exact: true }));await expect(page.getByText(/Bot membership not verified/)).toBeVisible();
 await activate(page.getByRole("button", { name: "Review unlink T0123456789 / C0123456789", exact: true }));await expect(page.getByText(/fail their next access check/)).toBeVisible();await expect(page.getByText(/New mentions in this channel will be ignored/)).toBeVisible();
 const send = page.getByRole("button", { name: "Unlink reviewed channel", exact: true });await activate(send);await expect(page.getByText(/Receipt confirmed/)).toBeVisible();await expect(send).toBeFocused();await expect(send).toBeDisabled();
 await activate(page.getByRole("button", { name: "Refresh recorded Slack links", exact: true }));await expect(page.getByRole("heading", { name: "Current recorded Slack links", exact: true })).toBeFocused();await expect(page.getByText(/No links for this project were returned/)).toBeVisible();
 const evidence = await (await request.get("/__mock/admin-evidence")).json() as { audit: { action: string }[] };expect(evidence.audit.filter(row => row.action === "slack_channel.unbound")).toHaveLength(1);
 const calls = await (await request.get("/__mock/requests")).json() as { method: string; path: string }[];expect(calls.filter(row => row.method === "POST" && row.path.endsWith("/slack-channel/unbind"))).toHaveLength(1);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: info.outputPath("b34-unlinked.png"), fullPage: true });
});
test("B34 reload recovers an owned unlink receipt with status only", async ({ page, request }) => {
 await page.goto("/app/admin/projects/payments");await activate(page.getByRole("button", { name: "Manage recorded Slack links", exact: true }));await activate(page.getByRole("button", { name: "Review unlink T0123456789 / C0123456789", exact: true }));await activate(page.getByRole("button", { name: "Unlink reviewed channel", exact: true }));await expect(page.getByText(/Receipt confirmed/)).toBeVisible();
 await page.reload();await activate(page.getByRole("button", { name: "Manage recorded Slack links", exact: true }));await expect(page.getByText(/A saved Slack request is available/)).toBeVisible();await activate(page.getByRole("button", { name: "Check Slack request status", exact: true }));await expect(page.getByText(/Receipt confirmed/)).toBeVisible();
 const calls = await (await request.get("/__mock/requests")).json() as { method: string; path: string }[];expect(calls.filter(row => row.method === "POST" && row.path.endsWith("/slack-channel/unbind"))).toHaveLength(1);expect(calls.some(row => row.method === "GET" && row.path.includes("/slack-channel/requests/"))).toBe(true);expect(calls.some(row => row.method === "POST" && /bind$/.test(row.path) && !row.path.endsWith("/unbind"))).toBe(false);
});
test("B34 proposes then explicitly applies a sole-owner link and reloads without another write", async ({ page, request }, info) => {
 await page.goto("/app/admin/projects/payments");await activate(page.getByRole("button", { name: "Manage recorded Slack links", exact: true }));await activate(page.getByRole("button", { name: "Link a Slack channel", exact: true }));
 await page.getByLabel("Slack workspace ID", { exact: true }).fill("T0123456789");await page.getByLabel("Slack channel ID", { exact: true }).fill("C0987654321");await activate(page.getByRole("button", { name: "Review channel link", exact: true }));
 await expect(page.getByText(/People in this channel gain/)).toBeVisible();await activate(page.getByRole("button", { name: "Request channel link approval", exact: true }));await activate(page.getByRole("button", { name: "Review sole-owner exception", exact: true }));
 await expect(page.getByText(/last 24 hours/)).toBeVisible();const approve = page.getByRole("button", { name: "Apply reviewed sole-owner exception", exact: true });await activate(approve);await expect(page.getByText(/Link receipt confirmed/)).toBeVisible();await expect(approve).toBeFocused();await expect(approve).toBeDisabled();
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: info.outputPath("b34-approved-link.png"), fullPage: true });
 await page.reload();await activate(page.getByRole("button", { name: "Manage recorded Slack links", exact: true }));await activate(page.getByRole("button", { name: "Link a Slack channel", exact: true }));await activate(page.getByRole("button", { name: "Check Slack link request status", exact: true }));await expect(page.getByText(/Link receipt confirmed/)).toBeVisible();
 const evidence = await (await request.get("/__mock/admin-evidence")).json() as { audit: { action: string; facts?: { mode?: string } }[] };expect(evidence.audit.filter(row => row.action === "slack_channel.proposed")).toHaveLength(1);expect(evidence.audit.filter(row => row.action === "slack_channel.bound")).toMatchObject([{ facts: { mode: "sole_owner_exception" } }]);
 const calls = await (await request.get("/__mock/requests")).json() as { method: string; path: string }[];expect(calls.filter(row => row.method === "POST" && row.path.endsWith("/slack-channel/proposals"))).toHaveLength(1);expect(calls.filter(row => row.method === "POST" && row.path.endsWith("/approve"))).toHaveLength(1);expect(calls.filter(row => row.method === "POST" && row.path.endsWith("/unbind"))).toHaveLength(0);
});
