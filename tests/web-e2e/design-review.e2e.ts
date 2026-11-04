// Design review (DR11): the Design tab, the Design first and Skip actions, and the How we work card with its settings editor, in a real browser. The mock cell answers the ordinary views; each test
// adds what the broker would send (a design review on the task view, `designActions`, the playbook), the way a newer server's answer carries them.
import { mkdirSync } from "node:fs";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { designReviewFixture } from "../web/support/design-review-fixture.js";

const SHOTS = process.env.DESIGN_REVIEW_SHOTS ?? ".test-build/web-e2e/shots";
const shot = (name: string) => { mkdirSync(SHOTS, { recursive: true });return SHOTS + "/" + name + ".png"; };
const id = "ses_aaaaaaaaaaaaaaaaaaaa", TASK = "11111111-1111-4111-8111-111111111111";
const signIn = async (page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, name: string) => {
 await request.post("/__mock/scenario", { data: { name } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
};
/** The task view as the broker would send it for a Full task with a design review. */
const withReview = async (page: Page, extra: Record<string, unknown> = {}, review: unknown = designReviewFixture()) => {
 await page.route("**/v1/web/sessions/" + id, async route => {
  const response = await route.fetch(), body = await response.json() as { session: { body: { task: { workflow: Record<string, unknown> } & Record<string, unknown> } } };
  const task = body.session.body.task;
  task.workflow = { ...task.workflow, definitionVersion: "1.1.0", path: "FULL", reviewPhase: "DESIGN", designReview: review };
  Object.assign(task, extra);
  await route.fulfill({ response, json: body });
 });
};

test("the Design tab shows the review, its disagreements, and every model word as text", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "workspace");
 await withReview(page);
 await page.setViewportSize({ width: 1280, height: 1000 });await page.goto("/app/sessions/" + id + "#design");
 const region = page.getByRole("region", { name: "Design review", exact: true });
 await expect(region).toBeVisible();
 await expect(region.getByText("Design review: needed. Reason: adds a new API; changes the data model (Rovara's reading of the request).")).toBeVisible();
 await expect(region.getByRole("heading", { name: "Disagreements" })).toBeVisible();
 await expect(region.getByText("The planner contested this blocker with evidence.")).toBeVisible();
 await expect(region.getByText(/verified by the digest of the packet the worker fetched; what the model was sent/u).first()).toBeVisible();
 await expect(region.getByText("not verified, so its result does not count", { exact: false })).toBeVisible();
 // Hostile words are text: nothing ran, nothing became a link or an image, and the hidden characters are shown as codes.
 expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
 await expect(region.locator("script, img, iframe, object")).toHaveCount(0);
 // The only links are code citations, built from the encoded path and the repository of one of the task's own pull requests; none comes from a model's words.
 const links = await region.locator("a").evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
 expect(links.length).toBeGreaterThan(0);
 expect(links.every(href => href.startsWith("https://github.com/acme/payments/blob/1234567/src/"))).toBe(true);
 await expect(region.getByText("[U+202E]", { exact: false }).first()).toBeVisible();
 await evidenceShot(page, { path: shot("design-tab"), fullPage: true });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await page.setViewportSize({ width: 360, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: shot("design-tab-phone"), fullPage: true });
});

test("a task with no design review has no Design tab", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "workspace");
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id);
 await expect(page.getByRole("tab", { name: "Pipeline" })).toBeVisible();
 await expect(page.getByRole("tab", { name: "Design" })).toHaveCount(0);
 await expect(page.getByRole("region", { name: "Design review actions" })).toHaveCount(0);
});

test("Design first and Skip call the broker's routes, and a refused Skip is explained", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "workspace");
 const sent: Array<{ method: string; path: string; body: unknown }> = [];
 await page.route("**/v1/web/tasks/*/design-review/*", async route => { const req = route.request();sent.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postDataJSON() });await route.fulfill({ status: 200, json: { ok: true } }); });
 await withReview(page, { designActions: { designFirst: true, hint: true, skip: { allowed: true } } }, undefined);
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id);
 const strip = page.getByRole("region", { name: "Design review actions" });
 await expect(strip.getByText("This may need design review.")).toBeVisible();
 await strip.getByRole("button", { name: "Design first" }).click();
 await expect(strip.getByText("Asked for design review first.", { exact: false })).toBeVisible();
 await strip.getByRole("button", { name: "Skip design review" }).click();
 await strip.getByRole("group", { name: "Confirm skipping design review" }).getByRole("button", { name: "Skip design review" }).click();
 await expect.poll(() => sent.map(item => item.path)).toEqual(["/v1/web/tasks/" + TASK + "/design-review/first", "/v1/web/tasks/" + TASK + "/design-review/skip"]);
 expect(sent.every(item => item.method === "POST" && typeof (item.body as { requestId?: unknown }).requestId === "string")).toBe(true);
 await evidenceShot(page, { path: shot("design-actions"), fullPage: true });
 await checkA11y(page, { theme: "light" });
});

test("a Skip the broker refused shows who to ask, and offers no Skip", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "workspace");
 await withReview(page, { designActions: { designFirst: false, skip: { allowed: false, because: "needs_high_risk_approver", approverName: "Priya" } } }, designReviewFixture({ status: "waiting_cost", rounds: [] }));
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id);
 await expect(page.getByText("Ask Priya to skip: this design is high risk.")).toBeVisible();
 await expect(page.getByRole("button", { name: "Skip design review" })).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Design first" })).toHaveCount(0);
});

const DEFAULTS = { mode: "auto", tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } };
test("a maintainer changes the design review settings, and a locked field stays read-only with its reason", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL, "project");
 let setting: Record<string, unknown> = { ...DEFAULTS, mode: "always", allowSkip: false }, revision = 3;
 const puts: Array<Record<string, unknown>> = [];
 await page.route("**/v1/web/projects/payments/playbook", async route => {
  const req = route.request(), answer = () => ({ playbook: { revision, defaultProcess: { kind: "builtin" }, designReview: setting }, designReviewLocked: ["designReview.mode", "designReview.allowSkip"], designReviewGroups: false });
  if (req.method() === "PUT") { const body = req.postDataJSON() as Record<string, unknown>;puts.push(body);setting = body.designReview as Record<string, unknown>;revision += 1; }
  await route.fulfill({ status: 200, json: answer() });
 });
 await page.setViewportSize({ width: 1280, height: 1100 });await page.goto("/app/projects/payments?tab=how-we-work");
 const card = page.getByRole("region", { name: "Design review", exact: true });
 await expect(card.getByText("Who does it")).toBeVisible();
 await expect(card.getByText("Always: every code change gets a design review").first()).toBeVisible();
 await expect(card.getByText("Locked by company").first()).toBeVisible();
 const editor = card.getByRole("region", { name: "Design review settings editor" });
 await expect(editor.getByLabel("When it runs")).toBeDisabled();
 await expect(editor.getByLabel("Allow skipping design review")).toBeDisabled();
 await expect(editor.getByText("Your company has locked this setting. A company admin can change it.").first()).toBeVisible();
 await expect(editor.getByLabel("Who approves a high-risk design").locator("option", { hasText: "A group" })).toHaveCount(0);
 await editor.getByLabel("Tier").selectOption("thorough");
 await editor.getByLabel("Cost limit per task (USD)").fill("25");
 await editor.getByRole("button", { name: "Save design review settings" }).click();
 await expect(editor.getByText("Saved. New design reviews use these settings; running ones keep theirs.")).toBeVisible();
 expect(puts).toHaveLength(1);
 expect(puts[0]).toMatchObject({ expectedRevision: 3, defaultProcess: { kind: "builtin" }, designReview: { mode: "always", tier: "thorough", allowSkip: false, capUsdPerTask: 25, highRiskApprover: { kind: "maintainers" } } });
 await evidenceShot(page, { path: shot("how-we-work-design-review"), fullPage: true });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await page.setViewportSize({ width: 360, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
