import type { APIRequestContext, BrowserContext, Page, Route } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { agentCard, me, myAgents, other, publishRequest } from "../web/support/publish-data.js";
// Agent publishing is off unless storage says so (`rovara.publish` = "v2"). Off, the directory, the profile and the builder are today's (none of the new requests is made). On: favourites and suggested agents, ask to publish
// (a project and the whole company), the approver deciding as another person, my requests, and the Home agents row; at phone and desktop widths, in the old look and the v2 look, with axe in both themes. The server is
// built in parallel, so every new route is answered here by page.route with fixtures shaped like the API doc. Pictures go to .test-build/web-e2e/agent-publish/ (ROVARA_PUBLISH_SHOTS changes the folder, for before/after comparisons).
const shots = process.env.ROVARA_PUBLISH_SHOTS ?? ".test-build/web-e2e/agent-publish", cookie = "11111111-1111-4111-8111-111111111111", AGENT = "agt_aaaaaaaaaaaaaaaaaaaa", OTHER_AGENT = "agt_bbbbbbbbbbbbbbbbbbbb";
const PAYMENTS = { agentId: AGENT, name: "Payments Expert", description: "Investigate customer payment failures." };
const NEW_ROUTES = /\/v1\/web\/(?:agent-publish-requests|me\/agents|approvals\/|agents\/[^/]+\/publish-requests)/u;
type Fixture = ReturnType<typeof publishRequest>;
interface World { requests: Fixture[]; favourites: ReturnType<typeof agentCard>[]; viewer: "author" | "approver"; seen: string[]; decided: Array<Record<string, unknown>>; asked: Array<Record<string, unknown>> }
const answer = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body });
const SUGGESTED = [agentCard("ticket-triage", "Ticket triage", "starter"), agentCard(AGENT, "Payments Expert", "used_by_you"), agentCard(OTHER_AGENT, "Release notes writer", "project_roster")];

async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>, scenario = "agents"): Promise<World> {
 await request.post("/__mock/scenario", { data: { name: scenario } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: cookie, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ reducedMotion: "reduce" });
 await page.addInitScript(entries => { for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
 const world: World = { requests: [], favourites: [], viewer: "author", seen: [], decided: [], asked: [] };
 page.on("request", asked => { if (NEW_ROUTES.test(asked.url())) world.seen.push(asked.method() + " " + new URL(asked.url()).pathname); });
 return world;
}
/** The doc's routes, answered from `world`. `viewer: "approver"` makes this person another one (an admin) for whom each waiting request can be decided. */
async function serve(page: Page, world: World, options: { publication?: unknown } = {}) {
 const list = (route: Route) => {
  const url = new URL(route.request().url()), mineOnly = url.searchParams.get("mine") === "1", state = url.searchParams.get("state");
  const requests = world.requests.filter(item => state === "all" || item.state === "pending").filter(item => !mineOnly || item.requestedBy.id === me.id || world.viewer === "author");
  return answer(route, { requests: requests.map(item => world.viewer === "approver" && item.state === "pending" ? { ...item, approval: { ...item.approval, canDecide: true, reason: null, confirmUrl: new URL(route.request().url()).origin + "/v1/app/approve/tkt_abc123" } } : item) });
 };
 await page.route(/\/v1\/web\/nav$/u, async route => { const response = await route.fetch(), nav = await response.json() as { me: Record<string, unknown> };await route.fulfill({ response, json: world.viewer === "approver" ? { ...nav, me: { ...nav.me, developerId: other.id, name: other.name, orgRole: "admin" } } : nav }); });
 await page.route(/\/v1\/web\/agent-publish-requests(\?|$)/u, list);
 await page.route(new RegExp("/v1/web/agents/" + AGENT + "/publish-requests$", "u"), async route => {
  if (route.request().method() === "GET") return list(route);
  const body = route.request().postDataJSON() as Record<string, unknown>;world.asked.push(body);
  const target = body.target as { kind: string };
  if (target.kind === "project" && body.note === "right away") return answer(route, { status: "published", agent: { agentId: AGENT, name: "Payments Expert" }, request: null });
  const created = publishRequest(world.requests.length + 1, { agent: PAYMENTS, requestedBy: me, target: body.target, note: typeof body.note === "string" ? body.note : null, approval: { canDecide: false, reason: "you_requested", freshSignInNeeded: false, confirmUrl: null }, effect: target.kind === "project" ? "Moves Payments Expert to the payments project. Priya keeps edit access." : "Shares Payments Expert with everyone in the company." });
  world.requests.push(created);
  return answer(route, { status: "NEEDS_CONFIRMATION", changes: ["Moves the agent"], request: created }, 202);
 });
 // The screen must never post a decision (RULING Q10: the decide route refuses a script's request); every decision is made on the confirmation page. Any POST here is recorded and fails the test.
 await page.route(/\/v1\/(?:web|app)\/approvals\/apr_[0-9a-z]{20}\/decide$/u, route => { world.decided.push({ url: route.request().url() });return answer(route, { error: { code: "FORBIDDEN", message: "not from a script" } }, 403); });
 await page.route(/\/v1\/web\/me\/agents\/favourites$/u, route => {
  const body = route.request().postDataJSON() as { agentIds: string[]; expectedRevision: number };
  world.favourites = body.agentIds.map(id => agentCard(id, id === AGENT ? "Payments Expert" : id === OTHER_AGENT ? "Release notes writer" : "Ticket triage", "favourite"));
  return answer(route, { favourites: world.favourites, revision: body.expectedRevision + 1 });
 });
 await page.route(/\/v1\/web\/me\/agents(\?|$)/u, route => answer(route, myAgents(world.favourites, SUGGESTED.filter(card => !world.favourites.some(favourite => favourite.agentId === card.agentId)), 4 + world.favourites.length)));
 if (options.publication !== undefined) await page.route(new RegExp("/v1/web/agents/" + AGENT + "$", "u"), async route => { const response = await route.fetch(), body = await response.json() as { agent: Record<string, unknown> };await route.fulfill({ response, json: { ...body, agent: { ...body.agent, publication: options.publication } } }); });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("main a:not(p a), main button, main input, main select, main textarea, main summary")].filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 43.5 && !node.classList.contains("rv-checkbox"); }).map(node => node.tagName + "." + node.className + ":" + (node.textContent ?? "").slice(0, 30) + ":" + String(Math.round(node.getBoundingClientRect().height))));
const focusVisible = async (page: Page) => { await page.keyboard.press("Tab");await page.keyboard.press("Tab");return page.evaluate(() => { const node = document.activeElement;if (node === null || node === document.body) return "none";const style = getComputedStyle(node);return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2 ? "visible" : "hidden"; }); };
const dialogFits = async (page: Page, width: number) => {
 const dialog = page.getByRole("dialog").last();await expect.poll(() => dialog.evaluate(node => getComputedStyle(node).opacity)).toBe("1");
 const box = (await dialog.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x + box.width).toBeLessThanOrEqual(width);expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
 if (width < 768) expect(await dialog.evaluate(node => [...node.querySelectorAll<HTMLElement>("button, select, input, textarea")].filter(item => { const rect = item.getBoundingClientRect();return rect.width > 0 && rect.height > 0 && rect.height < 43.5; }).length)).toBe(0);
};

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: today's directory and profile, and none of the new requests`, async ({ page, context, request, baseURL }) => {
  const world = await enter(page, context, request, baseURL, width, {});await serve(page, world, { publication: { level: "personal", projects: [], pending: null } });
  await page.goto("/app/agents");await expect(page.getByRole("link", { name: "Payments Expert", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Publish requests/ })).toHaveCount(0);await expect(page.getByRole("button", { name: /^Favourite/ })).toHaveCount(0);await expect(page.locator(".rv-pub-extras")).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);await page.waitForLoadState("networkidle");
  await evidenceShot(page, { path: `${shots}/off-directory-${String(width)}.png`, fullPage: true });
  await page.goto("/app/agents/" + AGENT);await expect(page.getByRole("heading", { name: "Payments Expert", level: 1 })).toBeVisible();
  await expect(page.getByText("Who can use it")).toHaveCount(0);await expect(page.getByRole("button", { name: /^Favourite|Ask to publish/ })).toHaveCount(0);await page.waitForLoadState("networkidle");
  expect(await noSidewaysScroll(page)).toBe(true);
  await evidenceShot(page, { path: `${shots}/off-profile-${String(width)}.png`, fullPage: true });
  await page.goto("/app/agents/requests");await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  expect(world.seen, "no new route is asked while the switch is off").toEqual([]);
 });
}
for (const look of [{ name: "look-off", store: {} }, { name: "look-v2", store: { "rovara.look": "v2" } }] as const) {
 for (const width of [360, 390, 1280] as const) {
  const phone = width < 768;
  test(`switch on, ${look.name} at ${String(width)}: favourites and suggestions with reasons, a star that toggles, ${phone ? "44px targets, " : ""}no sideways scroll, axe, focus`, async ({ page, context, request, baseURL }) => {
   const world = await enter(page, context, request, baseURL, width, { ...look.store, "rovara.publish": "v2" });world.requests.push(publishRequest(1, { agent: PAYMENTS }));await serve(page, world, { publication: { level: "personal", projects: [], pending: null } });
   await page.goto("/app/agents");
   const suggested = page.getByRole("region", { name: "Suggested" });await expect(suggested).toBeVisible();
   await expect(suggested.getByText("Starter")).toBeVisible();await expect(suggested.getByText("You use this")).toBeVisible();await expect(suggested.getByText("On this project's roster")).toBeVisible();
   await expect(page.getByRole("region", { name: "Your favourites" })).toHaveCount(0);
   await expect(page.getByRole("link", { name: /Publish requests/ })).toBeVisible();
   // Side by side on a desktop once there are favourites; stacked on a phone.
   const star = suggested.getByRole("button", { name: "Favourite Payments Expert" });await expect(star).toHaveAttribute("aria-pressed", "false");await star.click();
   const favourites = page.getByRole("region", { name: "Your favourites" });await expect(favourites).toBeVisible();await expect(favourites.getByRole("link", { name: "Payments Expert" })).toBeVisible();
   await expect(page.getByRole("region", { name: "Suggested" }).getByRole("link", { name: "Payments Expert" })).toHaveCount(0);
   expect(world.favourites.map(card => card.agentId)).toEqual([AGENT]);
   const boxes = await page.evaluate(() => [...document.querySelectorAll(".rv-pub-col")].map(node => { const box = node.getBoundingClientRect();return { top: box.top, left: box.left }; }));
   if (phone) expect(boxes[1]!.top).toBeGreaterThan(boxes[0]!.top);else { expect(boxes[1]!.top).toBe(boxes[0]!.top);expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left); }
   // The list below has its own star for every card, and it agrees.
   await expect(page.getByRole("button", { name: "Favourite Payments Expert" }).first()).toHaveAttribute("aria-pressed", "true");
   expect(await noSidewaysScroll(page)).toBe(true);if (phone) expect(await smallTargets(page)).toEqual([]);
   await evidenceShot(page, { path: `${shots}/on-directory-${look.name}-${String(width)}.png`, fullPage: true });
   await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
   expect(await focusVisible(page)).not.toBe("hidden");
  });
 }
}
for (const width of [390, 1280] as const) {
 test(`ask to publish at ${String(width)}: a project (the ownership move said plainly), the company, and a maintainer's immediate publish`, async ({ page, context, request, baseURL }) => {
  const world = await enter(page, context, request, baseURL, width, { "rovara.publish": "v2" });await serve(page, world, { publication: { level: "personal", projects: [], pending: null } });
  await page.goto("/app/agents/" + AGENT);await expect(page.getByRole("heading", { name: "Payments Expert", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who can use it" })).toBeVisible();await expect(page.getByText("Only you", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Favourite Payments Expert" })).toBeVisible();
  await page.getByRole("button", { name: "Ask to publish" }).click();
  const dialog = page.getByRole("dialog").last();await expect(dialog.getByRole("heading", { name: "Ask to publish Payments Expert" })).toBeVisible();
  await dialog.getByLabel("Publish to").selectOption("project:payments");
  await expect(dialog.getByRole("status")).toContainText("moves to the payments project");await expect(dialog.getByRole("status")).toContainText("becomes accountable");
  await expect(dialog.getByText("What you are asking to publish")).toBeVisible();
  await dialogFits(page, width);await evidenceShot(page, { path: `${shots}/ask-project-${String(width)}.png` });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await dialog.getByLabel(/A note for the approver/).fill("Used it on 6 releases.");
  await dialog.getByRole("button", { name: "Send request" }).click();
  await expect(dialog.getByText("Request sent.")).toBeVisible();await expect(dialog.getByText("What the approver sees")).toBeVisible();await expect(dialog.getByText("Adds write access to github")).toBeVisible();
  expect(world.asked[0]).toMatchObject({ target: { kind: "project", project: "payments" }, version: 3, note: "Used it on 6 releases." });
  await dialogFits(page, width);await evidenceShot(page, { path: `${shots}/ask-sent-${String(width)}.png` });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();await expect(dialog).toBeHidden();
  // The company, from a fresh dialog.
  await page.getByRole("button", { name: "Ask to publish" }).click();
  await page.getByRole("dialog").last().getByLabel("Publish to").selectOption("company");
  await expect(page.getByRole("dialog").last().getByRole("status")).toContainText("Only an admin can approve");
  await page.getByRole("dialog").last().getByRole("button", { name: "Send request" }).click();await expect(page.getByRole("dialog").last().getByText("Request sent.")).toBeVisible();
  expect(world.asked[1]).toMatchObject({ target: { kind: "company" } });
  await page.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).click();
  // A maintainer's own project: the server applies it at once and the dialog says done.
  await page.getByRole("button", { name: "Ask to publish" }).click();
  await page.getByRole("dialog").last().getByLabel("Publish to").selectOption("project:payments");await page.getByRole("dialog").last().getByLabel(/A note for the approver/).fill("right away");
  await page.getByRole("dialog").last().getByRole("button", { name: "Send request" }).click();
  await expect(page.getByRole("dialog").last().getByText("Done.")).toBeVisible();await expect(page.getByRole("dialog").last()).toContainText("is now published to the payments project");
  await evidenceShot(page, { path: `${shots}/ask-done-${String(width)}.png` });
 });
}
test("ask, then approve as another person: the requester sees it waiting, the admin sees the summary and approves, the requester sees it approved", async ({ page, context, request, baseURL }) => {
 const world = await enter(page, context, request, baseURL, 1280, { "rovara.publish": "v2" });await serve(page, world, { publication: { level: "personal", projects: [], pending: null } });
 await page.goto("/app/agents/" + AGENT);
 await page.getByRole("button", { name: "Ask to publish" }).click();await page.getByRole("dialog").last().getByLabel("Publish to").selectOption("project:payments");
 await page.getByRole("dialog").last().getByLabel(/A note for the approver/).fill("Used it on 6 releases.");await page.getByRole("dialog").last().getByRole("button", { name: "Send request" }).click();
 await expect(page.getByRole("dialog").last().getByText("Request sent.")).toBeVisible();
 // The requester's own list: waiting, withdrawable, and nothing to decide.
 await page.goto("/app/agents/requests");await expect(page.getByRole("heading", { name: "Publish requests", level: 1 })).toBeVisible();
 await expect(page.getByRole("list", { name: "your requests" }).getByText("Waiting", { exact: true })).toBeVisible();await expect(page.getByRole("button", { name: "Withdraw the request for Payments Expert" })).toBeVisible();await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
 await evidenceShot(page, { path: `${shots}/requests-mine-1280.png`, fullPage: true });
 // Another person, an admin: the request is theirs to decide.
 world.viewer = "approver";await page.goto("/app/agents/requests");
 await expect(page.getByRole("tab", { name: "To decide (1)" })).toBeVisible();await expect(page.getByText("This makes the agent less safe:")).toBeVisible();await expect(page.getByText("Moves Payments Expert to the payments project. Priya keeps edit access.")).toBeVisible();await expect(page.getByText(/Used it on 6 releases/)).toBeVisible();
 await evidenceShot(page, { path: `${shots}/requests-decide-1280.png`, fullPage: true });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await page.getByRole("button", { name: "Approve Payments Expert for payments" }).click();
 // One click goes nowhere: the card says it is confirmed on the next page, and Cancel keeps it waiting.
 const confirm = page.getByRole("group", { name: "Confirm approving Payments Expert" });
 await expect(confirm).toBeVisible();await expect(confirm.getByText(/You'll confirm on the next page/)).toBeVisible();
 await page.getByRole("button", { name: "Cancel" }).click();await expect(confirm).toHaveCount(0);
 await page.getByRole("button", { name: "Approve Payments Expert for payments" }).click();
 // Continue opens the request's confirmation page, where the decision is made with a fresh sign-in; the screen itself posts nothing.
 const [opened] = await Promise.all([context.waitForEvent("page"), page.getByRole("button", { name: "Continue to approve" }).click()]);
 await opened.waitForURL(/\/v1\/app\/approve\/tkt_abc123$/u);
 expect(new URL(opened.url()).pathname).toBe("/v1/app/approve/tkt_abc123");await opened.close();
 expect(world.decided).toEqual([]);expect(world.seen.filter(line => line.includes("/decide"))).toEqual([]);
 // The approver confirmed on that page (the server's part); back as the requester: approved.
 world.requests[0]!.state = "approved";world.requests[0]!.decidedBy = other as never;
 world.viewer = "author";await page.goto("/app/agents/requests");
 await expect(page.getByRole("list", { name: "your requests" }).getByText("Approved", { exact: true }).first()).toBeVisible();await expect(page.getByText("Approved by Ada Admin")).toBeVisible();
 await evidenceShot(page, { path: `${shots}/requests-approved-1280.png`, fullPage: true });
});
for (const width of [360, 390] as const) {
 test(`the requests page at ${String(width)}: deciding goes to the confirmation page, my requests fit the phone, 44px targets, axe`, async ({ page, context, request, baseURL }) => {
  const world = await enter(page, context, request, baseURL, width, { "rovara.publish": "v2" });world.viewer = "approver";
  world.requests.push(publishRequest(1, { agent: PAYMENTS, requestedBy: me }), publishRequest(2, { agent: PAYMENTS, requestedBy: me, target: { kind: "company" }, effect: "Shares Release notes writer with everyone in the company." }), publishRequest(3, { agent: PAYMENTS, requestedBy: me, state: "declined", decidedBy: other, declineReason: "Needs a budget first." }));
  await serve(page, world);
  await page.goto("/app/agents/requests");await expect(page.getByRole("tab", { name: "To decide (2)" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  await expect(page.getByRole("button", { name: "Approve Payments Expert for Company" })).toBeVisible();
  await page.getByRole("button", { name: "Approve Payments Expert for payments" }).click();await expect(page.getByRole("group", { name: "Confirm approving Payments Expert" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  await page.getByRole("button", { name: "Cancel" }).click();
  // Decline is confirmed on the next page too, where the reason is written: the card has no text box and posts nothing.
  await page.getByRole("button", { name: "Decline Payments Expert for payments" }).click();
  const declining = page.getByRole("group", { name: "Confirm declining Payments Expert" });
  await expect(declining.getByText(/You'll confirm on the next page/)).toBeVisible();await expect(declining.getByRole("textbox")).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  const [opened] = await Promise.all([context.waitForEvent("page"), declining.getByRole("button", { name: "Continue to decline" }).click()]);
  await opened.waitForURL(/\/v1\/app\/approve\/tkt_abc123$/u);await opened.close();
  expect(world.decided).toEqual([]);
  await evidenceShot(page, { path: `${shots}/requests-decide-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
  await page.getByRole("tab", { name: "My requests" }).click();await expect(page.getByText("Declined by Ada Admin: Needs a budget first.")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/requests-mine-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
for (const width of [390, 1280] as const) {
 test(`Home at ${String(width)} with both switches on: favourites then suggested agents with their reasons; either switch off keeps today's row`, async ({ page, context, request, baseURL }) => {
  const world = await enter(page, context, request, baseURL, width, { "rovara.home": "v2", "rovara.publish": "v2" }, "home");
  await request.post("/__mock/home-v2", { data: { mode: "full" } });world.favourites.push(agentCard(AGENT, "Payments Expert", "favourite"));await serve(page, world);
  await page.goto("/app");
  const favourites = page.getByRole("list", { name: "Favourite agents" }), suggested = page.getByRole("list", { name: "Suggested agents" });
  await expect(favourites).toBeVisible();await expect(favourites.getByRole("link", { name: /Payments Expert/ })).toBeVisible();
  await expect(suggested.getByText("Starter")).toBeVisible();await expect(suggested.getByText("On this project's roster")).toBeVisible();await expect(page.getByRole("list", { name: "Agents", exact: true })).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);if (width < 768) expect(await smallTargets(page)).toEqual([]);
  await evidenceShot(page, { path: `${shots}/home-on-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 });
}
test("Home with the publishing switch off keeps the new Home's agents row and asks for no favourites", async ({ page, context, request, baseURL }) => {
 const world = await enter(page, context, request, baseURL, 1280, { "rovara.home": "v2" }, "home");await request.post("/__mock/home-v2", { data: { mode: "full" } });await serve(page, world);
 await page.goto("/app");await expect(page.getByRole("list", { name: "Agents", exact: true })).toBeVisible();await expect(page.getByRole("list", { name: "Favourite agents" })).toHaveCount(0);await page.waitForLoadState("networkidle");
 expect(world.seen).toEqual([]);
});
