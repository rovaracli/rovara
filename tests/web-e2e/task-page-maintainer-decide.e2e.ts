// Approval place (U4): a project maintainer who decides someone else's coding plan on the task page is shown Reject like the owner (owner decision 99), is told the owner will hear of it, and keeps Approve and Request changes;
// the owner sees the card as before. The mock cell answers the ordinary views; each test adds what the broker would send: the viewer's seat in the plan document's access summary (`decideAs`), the plan
// card (which carries a Reject since decision 99), and the session read as someone who is not the task's owner.
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
const id = "ses_aaaaaaaaaaaaaaaaaaaa", TASK = "11111111-1111-4111-8111-111111111111";
const signIn = async (page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
};
const plan: DecisionItem = {
 subjectId: TASK, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "a".repeat(64), openPath: "/app/sessions/" + id,
 kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0,
};
const view = () => {
 const p = projectDecisionCards([plan]);
 return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped, choices: p.choices });
};
const documentView = (access: Record<string, unknown>) => ({
 document: "plan", versions: [{ version: 1, current: true, approved: false }], checks: [], unverified: false, waiting: true,
 access: { canComment: true, canSuggest: false, canDecide: true, canAsk: false, ...access },
 current: { version: 1, approved: false, format: "markdown", markdown: "# Retry failed payments\n\nRetry each failed payment up to three times." },
});
/** The cards, the plan document with the viewer's seat, and the session read as `owner` or as someone else (the owner is Maya Chen). */
const withBroker = async (page: Page, options: { owner: boolean; access: Record<string, unknown> }) => {
 await page.route("**/v1/web/decisions**", async route => { await route.fulfill({ json: view() }); });
 await page.route("**/v1/web/tasks/" + TASK + "/**", async route => {
  const path = new URL(route.request().url()).pathname;
  if (path.endsWith("/documents/plan")) { await route.fulfill({ json: documentView(options.access) });return; }
  if (path.endsWith("/comments")) { await route.fulfill({ json: { comments: [], suggestions: [], canRemember: false } });return; }
  await route.fallback();
 });
 await page.route("**/v1/web/sessions/" + id, async route => {
  const response = await route.fetch(), body = await response.json() as { session: { you: Record<string, unknown>; owner: Record<string, unknown>; body: { task: { taskId: string } } } };
  body.session.body.task.taskId = TASK;
  if (!options.owner) { body.session.you = { ...body.session.you, owner: false };body.session.owner = { ...body.session.owner, name: "Maya Chen" }; }
  await route.fulfill({ response, json: body });
 });
};

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) test("a maintainer deciding someone else's plan has Reject, is told the owner will hear of it, and keeps Approve and Request changes at " + String(width) + "px", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withBroker(page, { owner: false, access: { decideAs: "maintainer" } });
 await page.emulateMedia({ colorScheme: theme });await page.setViewportSize({ width, height: 900 });await page.goto("/app/sessions/" + id);
 const card = page.getByRole("article", { name: "Retry failed payments" });
 await expect(card.getByText("You are deciding as a maintainer; Maya Chen will be told.")).toBeVisible();
 await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
 await expect(card.locator("summary", { hasText: "Request changes" })).toBeVisible();
 await expect(card.locator("summary", { hasText: "Reject" })).toBeVisible();
 await expect(card.getByRole("button", { name: "Not now" })).toHaveCount(0);
 await checkA11y(page, { theme });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: shot("task-page-maintainer-" + String(width)), fullPage: true });
});

test("the owner's card is as before: Reject with its reasons, and no maintainer note", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withBroker(page, { owner: true, access: { decideAs: "owner" } });
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id);
 const card = page.getByRole("article", { name: "Retry failed payments" });
 await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
 await expect(card.locator("summary", { hasText: "Reject" })).toBeVisible();
 await expect(card.getByText(/You are deciding as a maintainer/u)).toHaveCount(0);
 await checkA11y(page, { theme: "light" });
});

test("a server that sends no decideAs leaves the card as before", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withBroker(page, { owner: false, access: {} });
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id);
 const card = page.getByRole("article", { name: "Retry failed payments" });
 await expect(card.locator("summary", { hasText: "Reject" })).toBeVisible();
 await expect(card.getByText(/You are deciding as a maintainer/u)).toHaveCount(0);
});
