// OWNER DECISION 18 (PLAN-PANEL-NOW): the plan is read, discussed and decided in one place on the task page, in a real browser. The card shows the key facts; "Read the full plan" opens the document
// in a side panel (desktop) or a full-screen sheet (phone) with line comments, Ask and the card's own Approve pinned at the bottom; `?doc=plan` (where an old review link now forwards) opens it too;
// `?view=feedback` opens the PR feedback view. The mock cell answers the ordinary views; each test adds what the broker would send.
import { mkdirSync } from "node:fs";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";

const SHOTS = process.env.DESIGN_REVIEW_SHOTS ?? ".test-build/web-e2e/shots";
const shot = (name: string) => { mkdirSync(SHOTS, { recursive: true });return SHOTS + "/" + name + ".png"; };
const id = "ses_aaaaaaaaaaaaaaaaaaaa", TASK = "11111111-1111-4111-8111-111111111111", OPEN = "22222222-2222-4222-8222-222222222222", ANSWER = "44444444-4444-4444-8444-444444444444";
const signIn = async (page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await mockRealtime(page);
};
const plan: DecisionItem = {
 subjectId: TASK, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "a".repeat(64), openPath: "/app/sessions/" + id,
 kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0, cost: { lowUsd: 1.2, highUsd: 2.4, minutes: { low: 10, high: 20 } },
 choices: {
  questions: [{ id: "d1", question: "How many times should a payment be retried?", recommended: "three", options: [{ id: "three", label: "Three times" }, { id: "five", label: "Five times" }] }],
  optionalChecks: [], openComments: [{ id: OPEN, excerpt: "Keep the old export too." }],
  summary: { needed: "Retry failed payments: customers pay twice when a retry is missed.", lines: ["Add a retry queue in src/retry.ts.", "Retry each failed payment up to three times.", "Log each retry for support <img src=x onerror=alert(1)>."] },
  openCommentCount: 1,
 },
};
const view = () => { const p = projectDecisionCards([plan]);return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped, choices: p.choices }); };
const documentView = {
 document: "plan", versions: [{ version: 1, current: true, approved: false }], checks: [{ id: "unit", label: "Unit tests" }], unverified: false, waiting: true,
 access: { canComment: true, canSuggest: false, canDecide: true, canAsk: true },
 current: { version: 1, approved: false, format: "structured", title: "Retry failed payments", why: [{ text: "Customers pay twice when a retry is missed.", author: "Maya" }],
  claims: [{ id: "1", text: "Add a retry queue in src/retry.ts." }, { id: "2", text: "Retry each failed payment up to three times.", children: [{ id: "2.1", text: "Wait a minute between tries." }] }],
  decisions: [{ id: "d1", claimId: "2", question: "How many times should a payment be retried?", recommended: "three", options: [{ id: "three", label: "Three times", consequence: "Fewer duplicates." }, { id: "five", label: "Five times", consequence: "More recoveries." }] }],
  risks: ["A retry could charge twice if the bank is slow."], notChanging: ["The checkout page."] },
};
const person = (commentId: string, text: string, extra: Record<string, unknown> = {}) => ({ id: commentId, document: "plan", version: 1, target: { kind: "document" }, author: { kind: "person", name: "Sam Lee", owner: false, you: false },
 text, createdAt: "2026-11-06T10:00:00.000Z", edited: false, deleted: false, sent: false, rev: 1, ...extra });

/** What the broker would answer: the card list and its approve, the task's document and comments; the bodies the page sent. */
const withBroker = async (page: Page) => {
 const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
 let comments: unknown[] = [person(OPEN, "Keep the old export too."), person("66666666-6666-4666-8666-666666666666", "<script>window.pwned=1</script><b>bold?</b>")];
 await page.route("**/v1/web/decisions**", async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (request.method() === "GET") { await route.fulfill({ json: view() });return; }
  sent.push({ path, body: request.postDataJSON() as Record<string, unknown> });
  if (path.endsWith("/evidence-opened")) { await route.fulfill({ json: { cardId: "approve_plan:" + TASK, opened: true, recorded: true } });return; }
  await route.fulfill({ json: { cardId: "approve_plan:" + TASK, outcome: "approved", remainingTabs: [] } });
 });
 await page.route("**/v1/web/tasks/" + TASK + "/**", async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (path.endsWith("/documents/plan")) { await route.fulfill({ json: documentView });return; }
  if (path.endsWith("/comments") && request.method() === "GET") { await route.fulfill({ json: { comments, suggestions: [], canRemember: false } });return; }
  if (path.endsWith("/comments") && request.method() === "POST") {
   const body = request.postDataJSON() as Record<string, unknown>;
   sent.push({ path, body });
   const mine = { ...person("55555555-5555-4555-8555-555555555555", String(body.text), { target: body.target, author: { kind: "person", name: "Maya", owner: true, you: true } }), agentx: "answered" };
   comments = [...comments, mine, { ...person(ANSWER, "Three tries cover most bank outages.", { parentId: mine.id, target: body.target }), author: { kind: "agentx", name: "Rovara", owner: false, you: false } }];
   await route.fulfill({ status: 201, json: { comment: mine, duplicate: false } });return;
  }
  await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Not found" } } });
 });
 return sent;
};
/** The app nav as the broker answers it: `decisionCards` only while the decision cards switch is on (OWNER DECISION 18(d)). */
const withCards = async (page: Page, on: boolean) => {
 await page.route("**/v1/web/nav", async route => {
  const response = await route.fetch(), body = await response.json() as { features: Record<string, unknown> };
  if (on) body.features.decisionCards = true;else delete body.features.decisionCards;
  await route.fulfill({ response, json: body });
 });
};
const withTask = async (page: Page, workflow: Record<string, unknown> = {}, cards = true) => {
 await withCards(page, cards);
 await page.route("**/v1/web/sessions/" + id, async route => {
  const response = await route.fetch(), body = await response.json() as { session: { you: Record<string, unknown>; body: { task: { taskId: string; workflow: Record<string, unknown> } & Record<string, unknown> } } };
  body.session.you = { ...body.session.you, owner: true };
  body.session.body.task.taskId = TASK;
  body.session.body.task.workflow = { ...body.session.body.task.workflow, definitionVersion: "1.1.0", ...workflow };
  await route.fulfill({ response, json: body });
 });
};

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) test("the card shows the key facts, and the full plan opens inside the task page with comments, Ask and the card's Approve at " + String(width) + "px", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page);
 const sent = await withBroker(page);
 await page.emulateMedia({ colorScheme: theme });await page.setViewportSize({ width, height: 900 });await page.goto("/app/sessions/" + id);
 const card = page.getByRole("article", { name: "Retry failed payments" });
 await expect(card).toBeVisible();
 await expect(card.getByText("Needed:")).toBeVisible();
 await expect(card.getByText("Retry each failed payment up to three times.")).toBeVisible();
 await expect(card.getByText(/risk(?: because)?:/u)).toBeVisible();
 await expect(card.getByText("Cost and time:")).toBeVisible();
 await expect(card.getByText("1 open comment")).toBeVisible();
 await expect(page.getByRole("link", { name: "Comment on the plan" })).toHaveCount(0);
 // Model text on the card is text: markup in a summary line shows as written and never becomes an element (review missing test 6).
 await expect(card.getByText("Log each retry for support <img src=x onerror=alert(1)>.")).toBeVisible();
 await card.getByRole("button", { name: "Read the full plan" }).click();
 await expect(page).toHaveURL(/[?&]doc=plan/u);
 const panel = page.getByRole("dialog", { name: "Coding plan v1" });
 await expect(panel).toBeVisible();
 await expect(panel.getByText("Wait a minute between tries.")).toBeVisible();
 await expect(panel.getByRole("list", { name: "Comments on the whole document" }).getByText("Keep the old export too.")).toBeVisible();
 // Model and person text is text: markup in a summary line or a comment shows as written and never runs (review missing test 6).
 await expect(panel.getByText("<script>window.pwned=1</script><b>bold?</b>")).toBeVisible();
 expect(await page.locator("img[src=x], .rv-plan-panel b").count()).toBe(0);
 expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
 // The card's own Approve and Request changes are pinned at the foot of the panel (and only there).
 const foot = panel.getByRole("region", { name: "Decide" });
 await expect(foot.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
 await expect(foot.locator("summary", { hasText: "Request changes" })).toBeVisible();
 // What Approve sends is said as the panel does it (never a pointer to the old review page), and the note's label sits above its full-width box.
 await expect(foot.getByText(/Your answers on the card and the ticked comments go with your decision\./u)).toBeVisible();
 await expect(panel.getByText(/plan review page/u)).toHaveCount(0);
 const label = await foot.getByText("Note for Rovara (optional)").boundingBox(), box = await foot.getByLabel("Note for Rovara (optional)").boundingBox();
 expect(label!.y + label!.height).toBeLessThanOrEqual(box!.y + 1);
 expect(Math.abs(label!.x - box!.x)).toBeLessThanOrEqual(2);
 await checkA11y(page, { theme });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
 await evidenceShot(page, { path: shot("task-page-plan-panel-" + String(width)), fullPage: false });
 await panel.getByRole("button", { name: "Comment on point 1" }).click();
 await panel.getByLabel("Comment on point 1").fill("Why a queue and not a cron job?");
 await panel.getByRole("checkbox", { name: "Ask Rovara to reply to this comment" }).check();
 await panel.getByRole("button", { name: "Comment", exact: true }).click();
 await expect.poll(() => sent.find(entry => entry.path.endsWith("/comments"))?.body).toMatchObject({ document: "plan", version: 1, target: { kind: "claim", id: "1" }, text: "Why a queue and not a cron job?", ask: true });
 await expect(panel.getByText("Three tries cover most bank outages.")).toBeVisible();
 await foot.getByRole("button", { name: "Approve", exact: true }).click();
 await expect.poll(() => sent.some(entry => entry.path.endsWith("/approve"))).toBe(true);
 expect(sent.find(entry => entry.path.endsWith("/approve"))!.body).toMatchObject({ includedCommentIds: [OPEN] });
 await panel.getByRole("button", { name: "Close dialog" }).click();
 await expect(page).not.toHaveURL(/[?&]doc=/u);
});

test("an old review link's landing (?doc=plan) opens the panel; a document outside the fixed list opens nothing", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page);
 await withBroker(page);
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id + "?doc=plan");
 await expect(page.getByRole("dialog", { name: "Coding plan v1" })).toBeVisible();
 await page.goto("/app/sessions/" + id + "?doc=%3Cscript%3E");
 await expect(page.getByRole("article", { name: "Retry failed payments" })).toBeVisible();
 await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) test("the PR feedback view decides the review on the task page at " + String(width) + "px", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page, { stage: "WAIT_FOR_MERGE", state: "WAITING" });
 const decided: Array<Record<string, unknown>> = [];
 const review = { taskId: TASK, title: "Retry failed payments", revision: 9, status: "PENDING", reportStatus: "COMPLETE", workflowStatus: "WAITING", workflowStage: "WAIT_FOR_MERGE",
  reviewDigest: "b".repeat(64), proposalDigest: "c".repeat(64), bundleDigests: ["d".repeat(64)], recommendedFindingIds: ["finding-1"], ciFailures: ["unit"],
  findings: [
   { id: "finding-1", priority: "SHOULD_FIX", assessment: "ACTIONABLE", rationale: "The name is not trimmed. <img src=x onerror=alert(2)>", recommended: true, proposedDisposition: "IMPLEMENT", comments: [{ author: "octocat", body: "Please trim the name." }],
    fixProposal: { summary: "Trim the name in greet.", fileChanges: [{ repositoryId: "demo", path: "greeting.ts", operation: "MODIFY", change: "Trim the name." }], tests: [] } },
   { id: "finding-2", priority: "NICE_TO_HAVE", assessment: "QUESTION", rationale: "Should goodbyes be lowercase?", recommended: false, proposedDisposition: "OWNER_DECISION", fixProposal: { summary: "Lowercase or keep?" } },
  ], candidates: [{ repositoryId: "demo", number: 7, headSha: "e".repeat(40) }] };
 await page.route("**/v1/web/tasks/" + TASK + "/workflow/feedback**", async route => {
  if (route.request().method() === "GET") { await route.fulfill({ json: { review } });return; }
  decided.push(route.request().postDataJSON() as Record<string, unknown>);
  await route.fulfill({ json: { task: {} } });
 });
 await page.emulateMedia({ colorScheme: theme });await page.setViewportSize({ width, height: 900 });await page.goto("/app/sessions/" + id);
 await page.getByRole("button", { name: "Review PR feedback" }).click();
 await expect(page).toHaveURL(/[?&]view=feedback/u);
 const dialog = page.getByRole("dialog", { name: /PR feedback/u });
 await expect(dialog.getByText("The name is not trimmed. <img src=x onerror=alert(2)>")).toBeVisible();
 expect(await page.locator("img[src=x]").count()).toBe(0);
 await expect(dialog.getByText("Lowercase or keep?")).toBeVisible();
 await expect(dialog.getByRole("checkbox", { name: "Include this finding" })).toBeChecked();
 // The dialog fades in; axe measures contrast on what is drawn, so a half-faded dialog read as low contrast in Firefox and WebKit.
 await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
 await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
 await checkA11y(page, { theme });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: shot("task-page-feedback-view-" + String(width)), fullPage: false });
 await dialog.getByRole("button", { name: "Approve 1 finding" }).click();
 await expect.poll(() => decided[0]).toMatchObject({ expectedRevision: 9, reviewDigest: "b".repeat(64), decision: "APPROVE", selectedFindingIds: ["finding-1"] });
 expect(Object.keys(decided[0]!).sort()).toEqual(["bundleDigests", "decision", "expectedRevision", "proposalDigest", "requestId", "reviewDigest", "selectedFindingIds"]);
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) test("an older version of the plan is browsed read-only in the panel, with its own comments and a way back, at " + String(width) + "px", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page);
 await withBroker(page);
 const OLD_COMMENT = "77777777-7777-4777-8777-777777777777", asked: string[] = [];
 const versions = [{ version: 1, current: false, approved: true }, { version: 2, current: true, approved: false }];
 const older = { ...documentView, versions, older: { currentVersion: 2 }, checks: [], waiting: false, access: { canComment: false, canSuggest: false, canDecide: false, canAsk: false },
  current: { ...documentView.current, version: 1, approved: true, title: "Retry failed payments (first draft)", claims: [{ id: "1", text: "Add a cron job for retries." }] } };
 await page.route("**/v1/web/tasks/" + TASK + "/documents/plan**", async route => {
  const url = new URL(route.request().url());asked.push(url.search);
  await route.fulfill({ json: url.searchParams.get("version") === "1" ? older : { ...documentView, versions, current: { ...documentView.current, version: 2 } } });
 });
 await page.route("**/v1/web/tasks/" + TASK + "/comments", async route => {
  if (route.request().method() !== "GET") { await route.fallback();return; }
  await route.fulfill({ json: { comments: [person(OPEN, "Looks right now.", { version: 2 }), person(OLD_COMMENT, "A cron job is simpler.", { version: 1, target: { kind: "claim", id: "1" } })], suggestions: [], canRemember: false } });
 });
 await page.emulateMedia({ colorScheme: theme });await page.setViewportSize({ width, height: 900 });await page.goto("/app/sessions/" + id + "?doc=plan");
 const panel = page.getByRole("dialog", { name: "Coding plan v2" });
 await expect(panel.getByText("Wait a minute between tries.")).toBeVisible();
 const picker = panel.getByRole("combobox", { name: "Version" });
 await expect(picker.locator("option")).toHaveText(["v2 (current)", "v1, approved"]);
 await expect(panel.getByText("Older version.")).toHaveCount(0);
 await picker.selectOption("1");
 const old = page.getByRole("dialog", { name: "Coding plan v1 (older)" });
 await expect(old.getByText("Add a cron job for retries.")).toBeVisible();
 expect(asked).toContain("?version=1");
 await expect(old.getByRole("status").filter({ hasText: "Older version." })).toContainText("You're reading v1 read-only. The current version is v2.");
 // Its own comment shows; the current version's does not; nothing can be written or decided.
 await expect(old.getByText("A cron job is simpler.")).toBeVisible();
 await expect(old.getByText("Looks right now.")).toHaveCount(0);
 await expect(old.getByRole("button", { name: /^Comment on|^Reply$|^Edit$|^Delete$/u })).toHaveCount(0);
 await expect(old.getByRole("region", { name: "Decide" })).toHaveCount(0);
 await old.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
 await checkA11y(page, { theme });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: shot("task-page-plan-panel-older-" + String(width)), fullPage: false });
 await old.getByRole("button", { name: "Back to the current version" }).click();
 const back = page.getByRole("dialog", { name: "Coding plan v2" });
 await expect(back.getByText("Wait a minute between tries.")).toBeVisible();
 await expect(back.getByText("Older version.")).toHaveCount(0);
 // The card's own Approve is back with the current version.
 await expect(back.getByRole("region", { name: "Decide" }).getByRole("button", { name: "Approve", exact: true })).toBeVisible();
});

for (const [width, theme] of [[1280, "light"], [390, "dark"]] as const) test("a PR feedback review that did not finish has Retry review on the task page at " + String(width) + "px", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page, { stage: "WAIT_FOR_MERGE", state: "WAITING" });
 const retried: Array<Record<string, unknown>> = [];
 const review = { taskId: TASK, title: "Retry failed payments", revision: 9, status: "PENDING", reportStatus: "TIMED_OUT", workflowStatus: "WAITING", workflowStage: "WAIT_FOR_MERGE",
  reviewDigest: "b".repeat(64), bundleDigests: [], candidates: [], findings: [], recommendedFindingIds: [], checks: [], nextAction: "Retry the review from the Slack thread of this task." };
 await page.route("**/v1/web/tasks/" + TASK + "/workflow/feedback**", async route => {
  if (route.request().method() === "GET") { await route.fulfill({ json: { review } });return; }
  if (!route.request().url().endsWith("/feedback-retry")) { await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Not found" } } });return; }
  retried.push(route.request().postDataJSON() as Record<string, unknown>);
  await route.fulfill({ json: { started: true } });
 });
 await page.emulateMedia({ colorScheme: theme });await page.setViewportSize({ width, height: 900 });await page.goto("/app/sessions/" + id + "?view=feedback");
 const dialog = page.getByRole("dialog", { name: /PR feedback/u });
 await expect(dialog.getByText("The review didn't finish.")).toBeVisible();
 await expect(dialog.getByText(/Slack/u)).toHaveCount(0);
 // The dialog fades in; contrast is judged once it has settled.
 await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
 await checkA11y(page, { theme });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await evidenceShot(page, { path: shot("task-page-feedback-retry-" + String(width)), fullPage: false });
 await dialog.getByRole("button", { name: "Retry review" }).click();
 await expect(dialog.getByRole("status")).toHaveText("Reviewing the feedback again. A new proposal shows here when it is ready.");
 expect(retried).toEqual([{ reviewDigest: "b".repeat(64) }]);
 await expect(dialog.getByRole("button", { name: "Retry review" })).toBeDisabled();
});

test("with the cards off (dk=0) the task page is as it was: no panel, no feedback view, and the link to the review page's comments", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page, { stage: "WAIT_FOR_MERGE", state: "WAITING" }, false);
 await withBroker(page);
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id + "?doc=plan&view=feedback");
 await expect(page.getByRole("link", { name: "Comment on the plan" })).toBeVisible();
 await expect(page.getByRole("dialog")).toHaveCount(0);
 await expect(page.getByRole("button", { name: /Read the full/u })).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Review PR feedback" })).toHaveCount(0);
});

test("a medium card records its evidence as opened only after the full document has been drawn, never when it failed to load (review M3)", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page);
 const sent = await withBroker(page);
 const medium: DecisionItem = { ...plan, untestedClaims: 2 };
 await page.route("**/v1/web/decisions**", async route => {
  const request = route.request(), path = new URL(request.url()).pathname;
  if (request.method() === "GET") { const p = projectDecisionCards([medium]);await route.fulfill({ json: DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped, choices: p.choices }) });return; }
  sent.push({ path, body: request.postDataJSON() as Record<string, unknown> });
  await route.fulfill({ json: { cardId: "approve_plan:" + TASK, opened: true, recorded: true } });
 });
 let fail = true;
 await page.route("**/v1/web/tasks/" + TASK + "/documents/plan", async route => { if (fail) await route.fulfill({ status: 503, json: { error: { code: "RUNTIME_UNAVAILABLE", message: "Try again shortly." } } });else await route.fallback(); });
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id);
 const card = page.getByRole("article", { name: "Retry failed payments" });
 await expect(card.locator(".rv-decision-risk")).toHaveText("Medium risk");
 await card.getByRole("button", { name: "Read the full plan" }).click();
 const panel = page.getByRole("dialog", { name: /Coding plan/u });
 await expect(panel.getByRole("alert")).toBeVisible();
 await page.waitForTimeout(300);
 expect(sent.filter(entry => entry.path.endsWith("/evidence-opened"))).toEqual([]);
 await panel.getByRole("button", { name: "Close dialog" }).click();
 fail = false;
 await card.getByRole("button", { name: "Read the full plan" }).click();
 await expect(page.getByRole("dialog", { name: "Coding plan v1" }).getByText("Wait a minute between tries.")).toBeVisible();
 await expect.poll(() => sent.filter(entry => entry.path.endsWith("/evidence-opened")).length).toBe(1);
});

test("'Review and approve the plan' with no card on the page opens the plan in its panel, not the old page (review M5)", async ({ page, context, request, baseURL }) => {
 await signIn(page, context, request, baseURL);
 await withTask(page, { stage: "PLAN_REVIEW", state: "WAITING" });
 await withBroker(page);
 await page.route("**/v1/web/decisions**", route => route.fulfill({ json: DecisionCardsViewSchema.parse({ cards: [], total: 0, tabs: {}, details: {}, digests: {}, dropped: 0 }) }));
 await page.setViewportSize({ width: 1280, height: 900 });await page.goto("/app/sessions/" + id + "#plan");
 const popups: string[] = [];
 page.on("popup", popup => { popups.push(popup.url()); });
 await page.getByRole("button", { name: "Review and approve the plan" }).click();
 await expect(page).toHaveURL(/[?&]doc=plan/u);
 await expect(page.getByRole("dialog", { name: "Coding plan v1" })).toBeVisible();
 expect(popups).toEqual([]);
});
