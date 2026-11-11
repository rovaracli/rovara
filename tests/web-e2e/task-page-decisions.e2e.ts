// OWNER DECISION 7: what the old review page decided is on the task page, in a real browser: the coding plan's card with its question, optional check, open comments and note, and a stopped task's
// Retry the checks, Revise the plan and spec choices. The mock cell answers the ordinary views; each test adds what the broker would send (the card view, the task view's `pageActions`).
import { mkdirSync } from "node:fs";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { DecisionCardsViewSchema } from "@agentx/cloud-contracts/web";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";

const SHOTS = process.env.DESIGN_REVIEW_SHOTS ?? ".test-build/web-e2e/shots";
const shot = (name: string) => { mkdirSync(SHOTS, { recursive: true });return SHOTS + "/" + name + ".png"; };
const id = "ses_aaaaaaaaaaaaaaaaaaaa", TASK = "11111111-1111-4111-8111-111111111111", KEPT = "22222222-2222-4222-8222-222222222222", LEFT = "33333333-3333-4333-8333-333333333333";
const signIn = async (page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
};
const plan: DecisionItem = {
 subjectId: TASK, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "a".repeat(64), openPath: "/app/sessions/" + id,
 kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0,
 choices: {
  questions: [{ id: "d1", question: "How many times should a payment be retried?", recommended: "three", options: [{ id: "three", label: "Three times" }, { id: "five", label: "Five times" }], suggested: [{ optionId: "five", name: "Sam" }] }],
  optionalChecks: [{ id: "lint", label: "Lint the retry module", selected: false }],
  openComments: [{ id: KEPT, excerpt: "Keep the old export too." }, { id: LEFT, excerpt: "Rename the queue later." }],
 },
};
const view = () => { const p = projectDecisionCards([plan]);return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped, choices: p.choices }); };
/** The decisions the broker would list, and what an approve answers; the bodies the page sent. */
const withCard = async (page: Page) => {
 const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
 await page.route("**/v1/web/decisions**", async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (request.method() === "GET") { await route.fulfill({ json: view() });return; }
  sent.push({ path, body: request.postDataJSON() as Record<string, unknown> });
  if (path.endsWith("/evidence-opened")) { await route.fulfill({ json: { cardId: "approve_plan:" + TASK, opened: true, recorded: true } });return; }
  await route.fulfill({ json: { cardId: "approve_plan:" + TASK, outcome: "approved", remainingTabs: [] } });
 });
 return sent;
};
/** The task view with what the broker adds for a stopped task. */
const withTask = async (page: Page, extra: Record<string, unknown>, workflow: Record<string, unknown> = {}) => {
 await page.route("**/v1/web/sessions/" + id, async route => {
  const response = await route.fetch(), body = await response.json() as { session: { body: { task: { taskId: string; workflow: Record<string, unknown> } & Record<string, unknown> } } };
  const task = body.session.body.task;
  task.taskId = TASK;
  task.workflow = { ...task.workflow, definitionVersion: "1.1.0", ...workflow };
  Object.assign(task, extra);
  await route.fulfill({ response, json: body });
 });
};

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) test("the plan's card carries its question, check, comments and note, and Approve sends what the person set at " + String(width) + "px", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page, {});
 const sent = await withCard(page);
 await page.emulateMedia({ colorScheme: theme });await page.setViewportSize({ width, height: 900 });await page.goto("/app/sessions/" + id);
 const card = page.getByRole("article", { name: "Retry failed payments" });
 await expect(card).toBeVisible();
 await expect(card.getByRole("radio", { name: /Three times \(Rovara recommends this\)/u })).toBeChecked();
 await card.getByRole("radio", { name: /Five times · suggested by Sam/u }).check();
 await card.getByRole("checkbox", { name: "Lint the retry module" }).check();
 await card.getByRole("checkbox", { name: "Rename the queue later." }).uncheck();
 await card.getByLabel("Note for Rovara (optional)").fill("Support asked for five.");
 const approve = card.getByRole("button", { name: "Approve", exact: true });
 if (await approve.isDisabled()) await card.locator("summary", { hasText: /evidence/iu }).click();
 await expect(approve).toBeEnabled();
 await checkA11y(page, { theme });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: shot("task-page-plan-card-" + String(width)), fullPage: true });
 await approve.click();
 await expect.poll(() => sent.some(entry => entry.path.endsWith("/approve"))).toBe(true);
 expect(sent.find(entry => entry.path.endsWith("/approve"))!.body).toMatchObject({ answers: [{ decisionId: "d1", optionId: "five", opened: true }], selectedOptionalCheckIds: ["lint"], includedCommentIds: [KEPT], note: "Support asked for five." });
});

for (const width of [1280, 390] as const) test("a stopped task offers Retry the checks, Revise the plan and the spec's choices at " + String(width) + "px, each to its own route", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page, { pageActions: { checksRetry: { canRetry: true }, revisePlan: { canRevise: true }, specHold: { title: "Spec on hold", message: "The spec could not be written.", choices: ["retry", "continue"], canChoose: true } } }, { stage: "IMPLEMENT", state: "BLOCKED", revision: 7 });
 const posts: string[] = [];
 await page.route("**/v1/web/tasks/" + TASK + "/**", async route => { posts.push(new URL(route.request().url()).pathname);await route.fulfill({ json: { revision: 8 } }); });
 await page.setViewportSize({ width, height: 900 });await page.goto("/app/sessions/" + id);
 const region = page.getByRole("region", { name: "What happens next" });
 await expect(region).toBeVisible();
 await checkA11y(page, { theme: "light" });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: shot("task-page-stopped-" + String(width)), fullPage: true });
 await region.getByRole("button", { name: "Retry the browser and API checks" }).click();
 await expect.poll(() => posts).toContain("/v1/web/tasks/" + TASK + "/workflow/checks-retry");
 await region.getByRole("button", { name: "Revise the plan" }).click();
 await expect.poll(() => posts).toContain("/v1/web/tasks/" + TASK + "/workflow/revise-plan");
 await region.getByRole("button", { name: "Continue without the spec" }).click();
 await expect.poll(() => posts).toContain("/v1/web/tasks/" + TASK + "/spec/continue");
});
