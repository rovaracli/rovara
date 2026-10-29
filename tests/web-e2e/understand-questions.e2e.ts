import type { BrowserContext } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { understandSession } from "../web/support/understand-fixture.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa";
const sign = async (context: BrowserContext, baseURL: string) => context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL, secure: true, httpOnly: true, sameSite: "Strict" }]);

test("answers Understand's questions on the session page with the keyboard, once, with the revision it read", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await request.post("/__mock/session-state", { data: { ...understandSession(), sessionId: id } });
 await sign(context, baseURL!);await mockRealtime(page);await page.goto("/app/sessions/" + id);
 const region = page.getByRole("region", { name: "Questions from Rovara" });
 await expect(region).toBeVisible();await expect(region.locator("img")).toHaveCount(0);
 expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
 await page.setViewportSize({ width: 360, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await evidenceShot(page, { path: ".test-build/web-e2e/understand-questions-form.png", fullPage: true });
 await page.getByRole("button", { name: "Send answers" }).focus();await page.keyboard.press("Enter");
 await expect(page.getByRole("radio").first()).toBeFocused();await expect(page.getByRole("alert")).toContainText("Answer every question");
 await page.keyboard.press("Space");await page.keyboard.press("Tab");await page.keyboard.press("Tab");
 await page.keyboard.type("Yes, the last year");
 await page.getByRole("button", { name: "Send answers" }).focus();await page.keyboard.press("Enter");
 await expect(page.getByText("Answers sent. Rovara is working on your request.")).toBeVisible();
 await expect(page.getByRole("button", { name: "Send answers" })).toHaveCount(0);
 const posts = ((await (await request.get("/__mock/requests")).json()) as Array<{ method: string; path: string; body?: unknown }>).filter(row => row.method === "POST" && row.path.endsWith("/answers"));
 expect(posts).toHaveLength(1);
 expect(posts[0]!.body).toMatchObject({ round: 1, revision: 4, answers: [{ questionId: "q1", optionId: "a" }, { questionId: "q2", text: "Yes, the last year" }] });
 await evidenceShot(page, { path: ".test-build/web-e2e/understand-questions.png", fullPage: true });
});

test("tells a late answerer the questions were already answered, and shows the questions read-only to someone who cannot answer", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await request.post("/__mock/session-state", { data: { ...understandSession(), sessionId: id } });
 await sign(context, baseURL!);await mockRealtime(page);await page.goto("/app/sessions/" + id);
 await page.getByRole("radio").first().check();await page.getByRole("textbox", { name: /Should old refunds be migrated/u }).fill("Yes");
 // Someone else answers first: the mock's workflow moves on before this person presses the button.
 await request.post("/__mock/session-state", { data: { ...understandSession({ waiting: false, revision: 7 }), sessionId: id } });
 await page.getByRole("button", { name: "Send answers" }).click();
 await expect(page.getByText("These questions were already answered.")).toBeVisible();
 await request.post("/__mock/session-state", { data: { ...understandSession({ level: "view" }), sessionId: id } });
 await page.reload();
 const region = page.getByRole("region", { name: "Questions from Rovara" });
 await expect(region).toContainText("Waiting for Priya to answer");await expect(page.getByRole("button", { name: "Send answers" })).toHaveCount(0);await expect(region.getByRole("textbox")).toHaveCount(0);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
});
