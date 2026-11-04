import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa";
const errorRef = { kind: "operation_failed", code: "CHECK_FAILED", subject: { taskId: "11111111-1111-4111-8111-111111111111" }, at: "2026-10-23T12:00:00.000Z" };
type Row = { method: string; path: string; body?: { requestId?: string; question?: string; errorRef?: unknown } };

test("shows Ask about this task and Fix with agent only when the server offers them, and neither costs anything to open", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "session" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await mockRealtime(page);
 const rows = async () => (await (await request.get("/__mock/requests")).json()) as Row[];
 // Off: an error is on the page but the server offers nothing, so neither button is there.
 const you = { level: "edit", owner: true, following: false, actions: ["watch", "comment", "steer", "share"] };
 await request.post("/__mock/session-state", { data: { errorRef, you } });
 await page.goto("/app/sessions/" + id);
 await expect(page.getByRole("heading", { name: "Fix duplicate refunds", exact: true })).toBeVisible();
 await expect(page.getByText("Ask about this task", { exact: true })).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Fix with agent", exact: true })).toHaveCount(0);
 // On: the server offers both. Opening the page still sends nothing to ask or diagnose.
 await request.post("/__mock/session-state", { data: { errorRef, you: { ...you, live: { ask: true, fix: true } } } });
 await page.goto("/app/sessions/" + id);
 await expect(page.getByText("Ask about this task", { exact: true })).toBeVisible();
 await expect(page.getByRole("button", { name: "Fix with agent", exact: true })).toBeVisible();
 expect((await rows()).filter(row => /\/ask|\/asks\/|\/diagnoses/.test(row.path))).toEqual([]);
 // Ask: the answer is shown as text, never as markup.
 await page.getByText("Ask about this task", { exact: true }).click();
 await page.getByRole("textbox", { name: "Your question" }).fill("Why did the check fail?");
 await page.getByRole("button", { name: "Ask", exact: true }).click();
 await expect(page.getByText("The check failed because the lockfile is stale.", { exact: false })).toBeVisible();
 await expect(page.getByText("AI answer from this task's data; it can be wrong.")).toBeVisible();
 expect(await page.locator(".rv-ask img").count()).toBe(0);
 // Fix with agent: the explanation and proposals are shown, and there is nothing to apply.
 await page.getByRole("button", { name: "Fix with agent", exact: true }).click();
 await expect(page.getByText("Refunds were retried with a stale lockfile.")).toBeVisible();
 await expect(page.getByText("npm ci", { exact: false })).toBeVisible();
 await expect(page.getByRole("button", { name: /apply/i })).toHaveCount(0);
 const sent = await rows();
 expect(sent.find(row => row.method === "POST" && row.path.endsWith("/ask"))?.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), question: "Why did the check fail?" });
 expect(sent.find(row => row.method === "POST" && row.path === "/v1/web/diagnoses")?.body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), errorRef });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });
 await checkA11y(page, { theme: "dark" });
 await evidenceShot(page, { path: ".test-build/web-e2e/live-buttons-light.png", fullPage: true });
});
