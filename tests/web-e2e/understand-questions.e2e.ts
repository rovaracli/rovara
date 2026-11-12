import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { openWorkDetails } from "./support/work-details.js";
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
 await page.setViewportSize({ width: 360, height: 800 });await openWorkDetails(page);
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

// The phone order keeps the work behind the closed "Work details and evidence" disclosure. It opens by itself, and scrolls into view, when Understand's questions wait for this reader (owner decision of 2026-11-12).
const PHONE = { width: 390, height: 800 };
const sessionReads = async (request: APIRequestContext) => ((await (await request.get("/__mock/requests")).json()) as Array<{ method: string; path: string }>).filter(row => row.method === "GET" && row.path.endsWith("/v1/web/sessions/" + id)).length;
async function phoneTask(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string, session: unknown) {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await request.post("/__mock/session-state", { data: { ...(session as object), sessionId: id } });
 await sign(context, baseURL);const realtime = await mockRealtime(page);await page.setViewportSize(PHONE);await page.goto("/app/sessions/" + id);
 return realtime;
}

/** What Chromium's accessibility tree says about the disclosure's summary: its role and whether it is expanded (the other engines expose the native <details> state in their own trees, which Playwright cannot read). */
async function summaryAccessibility(page: Page, context: BrowserContext) {
 const session = await context.newCDPSession(page);
 try {
  await session.send("Accessibility.enable");
  const { nodes } = await session.send("Accessibility.getFullAXTree");
  const node = nodes.find(candidate => candidate.name?.value === "Work details and evidence" && candidate.role?.value === "DisclosureTriangle");
  return node === undefined ? undefined : { expanded: node.properties?.find(property => property.name === "expanded")?.value.value as boolean | undefined };
 } finally { await session.detach(); }
}

test("on a phone, questions the reader may answer open the work details by themselves, in view, with no tap and no stolen focus", async ({ page, context, request, baseURL, browserName }) => {
 await phoneTask(page, context, request, baseURL!, understandSession());
 const details = page.locator("details.rv-session-evidence"), region = page.getByRole("region", { name: "Questions from Rovara" });
 await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
 await expect(details).toHaveJSProperty("open", true);
 await expect(region).toBeVisible();await expect(region).toBeInViewport();await expect(page.getByRole("button", { name: "Send answers" })).toBeVisible();
 // Focus stays where the page put it (the heading); the form did not take it.
 expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
 // The disclosure is a native one: its summary is the first child, and the browser announces it as expanded.
 await expect(details.locator(":scope > summary")).toHaveText("Work details and evidence");
 if (browserName === "chromium") expect(await summaryAccessibility(page, context)).toEqual({ expanded: true });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await evidenceShot(page, { path: ".test-build/web-e2e/understand-questions-phone-open.png", fullPage: false });
 // A tap closes it again, and the form goes with it.
 await details.locator(":scope > summary").click();
 await expect(details).toHaveJSProperty("open", false);await expect(region).toBeHidden();
 if (browserName === "chromium") expect(await summaryAccessibility(page, context)).toEqual({ expanded: false });
});

test("on a phone, with nothing to act on the work details stay closed: questions a viewer cannot answer, and an ordinary task", async ({ page, context, request, baseURL }) => {
 await phoneTask(page, context, request, baseURL!, understandSession({ level: "view" }));
 const details = page.locator("details.rv-session-evidence");
 await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
 await expect(details).toHaveJSProperty("open", false);
 await expect(page.getByRole("region", { name: "Questions from Rovara" })).toBeHidden();
 await details.locator(":scope > summary").click();
 await expect(page.getByRole("region", { name: "Questions from Rovara" })).toContainText("Waiting for Priya to answer");
 await request.post("/__mock/session-state", { data: { ...understandSession({ waiting: false }), sessionId: id } });
 await page.reload();
 await expect(page.getByRole("region", { name: "Where this task stands" })).toBeVisible();
 await expect(details).toHaveJSProperty("open", false);
});

test("on a phone, a manual close is respected until a new round of questions arrives", async ({ page, context, request, baseURL }) => {
 const realtime = await phoneTask(page, context, request, baseURL!, understandSession());
 const details = page.locator("details.rv-session-evidence"), region = page.getByRole("region", { name: "Questions from Rovara" });
 await expect(details).toHaveJSProperty("open", true);await expect(region).toBeVisible();
 await details.locator(":scope > summary").click();
 await expect(details).toHaveJSProperty("open", false);
 // The same round, read again (a newer revision of the task): the reader's close stands.
 await expect.poll(() => realtime.connections()).toBeGreaterThan(0);
 const before = await sessionReads(request);
 await request.post("/__mock/session-state", { data: { ...understandSession({ revision: 6 }), sessionId: id } });
 await realtime.push({ type: "session.updated", sessionId: id, revision: 100 });
 await expect.poll(() => sessionReads(request)).toBeGreaterThan(before);
 await page.waitForTimeout(300);
 await expect(details).toHaveJSProperty("open", false);
 // A new round of questions is a new action: it opens by itself.
 const again = await sessionReads(request);
 await request.post("/__mock/session-state", { data: { ...understandSession({ round: 2, revision: 8 }), sessionId: id } });
 await realtime.push({ type: "session.updated", sessionId: id, revision: 200 });
 await expect.poll(() => sessionReads(request)).toBeGreaterThan(again);
 await expect(details).toHaveJSProperty("open", true);await expect(region).toBeVisible();await expect(region).toBeInViewport();
});
