import type { BrowserContext } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { answeredSession } from "../web/support/answered-fixture.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", next = "ses_bbbbbbbbbbbbbbbbbbbb";
const sign = async (context: BrowserContext, baseURL: string) => context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL, secure: true, httpOnly: true, sameSite: "Strict" }]);

test("shows the answer of an Answered task, then makes the change anyway with the keyboard, once, and opens the new session", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await request.post("/__mock/session-state", { data: { ...answeredSession(), sessionId: id } });
 await sign(context, baseURL!);await mockRealtime(page);await page.goto("/app/sessions/" + id);
 const region = page.getByRole("region", { name: "Rovara's answer" });
 await expect(region).toBeVisible();
 await expect(region.getByRole("heading", { name: "Rovara answered this. No code was changed." })).toBeVisible();
 await expect(region).toContainText("Second line stays a line.");await expect(region).toContainText("payments/src/retry.ts:4");
 await expect(region.locator("img")).toHaveCount(0);
 expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
 await page.setViewportSize({ width: 360, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await evidenceShot(page, { path: ".test-build/web-e2e/answered.png", fullPage: true });
 await page.getByRole("button", { name: "Make a change anyway" }).focus();await expect(page.getByRole("button", { name: "Make a change anyway" })).toBeFocused();
 await page.keyboard.press("Enter");
 await expect(page).toHaveURL(new RegExp("/app/sessions/" + next + "$"));
 await expect(page.getByText("Building").first()).toBeVisible();
 const posts = ((await (await request.get("/__mock/requests")).json()) as Array<{ method: string; path: string; body?: unknown }>).filter(row => row.method === "POST" && row.path.endsWith("/change-anyway"));
 expect(posts).toHaveLength(1);
 expect(posts[0]!.path).toBe("/v1/web/sessions/" + id + "/change-anyway");
 expect(posts[0]!.body).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
});

test("shows a viewer the answer and no button, and an ordinary task nothing new", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await request.post("/__mock/session-state", { data: { ...answeredSession({ level: "view" }), sessionId: id } });
 await sign(context, baseURL!);await mockRealtime(page);await page.goto("/app/sessions/" + id);
 await expect(page.getByRole("region", { name: "Rovara's answer" })).toContainText("Second line stays a line.");
 await expect(page.getByRole("button", { name: "Make a change anyway" })).toHaveCount(0);
 await page.setViewportSize({ width: 360, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await request.post("/__mock/session-state", { data: { ...answeredSession({ answered: false }), sessionId: id } });
 await page.reload();
 await expect(page.getByText("Building").first()).toBeVisible();
 await expect(page.getByRole("region", { name: "Rovara's answer" })).toHaveCount(0);
});
