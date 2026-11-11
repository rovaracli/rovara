// @vitest-environment jsdom
// The new Home (exp/home): off by default (today's Home is unchanged), and with the switch on its sections come in the agreed order (Needs you, Start something beside the agents row, Continue,
// Finished recently), each says plainly when empty, Continue and Finished recently show at most five, and no row shows a raw code.
import { expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { HOME_STORAGE_KEY, isNewHomeOn } from "../../packages/ui/src/screens/home/home-flags.js";
import { HOME_LIST_MAX, continueRows, decisionState, finishedRows, homeCardState, needsYouSessions, nextLine, pickAgents, rowStatus } from "../../packages/ui/src/screens/home/home-rows.js";
import { withFailureSession } from "../../packages/ui/src/screens/home/HomeCardRow.js";
import { PLAIN_STATE_LABELS } from "../../packages/ui/src/screens/session/task-plain-state.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { endedList, endedTile, openTile, directoryOf, agentId, homeSessionId } from "./support/home-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111", at = "2026-11-06T11:00:00.000Z", origin = "https://cell.example";
const names = (count: number) => Array.from({ length: count }, (_, index) => ({ id: agentId(index + 1), name: "Agent " + String(index + 1) }));
const HEADINGS = ["Needs you", "Start something", "Or start with an agent", "Continue", "Finished recently"];
const decisionItem: DecisionItem = { subjectId: "design1", taskId: TASK, project: "payments", title: "Move refunds to the new ledger", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: "/app/sessions/" + SESSION_FIXTURE_ID, kind: "approve_design", files: ["src/refund.ts"] };
const decisionView = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };
const planCard = (n: number, extra: Record<string, unknown> = {}) => ({ cardId: "plan:" + homeSessionId(200 + n), kind: "plan", title: "Review plan " + String(n), reason: "Your plan is ready to review", sessionId: homeSessionId(200 + n), at, buttons: [{ label: "Review plan", action: "open", method: "GET", href: origin + "/app/sessions/" + homeSessionId(200 + n) }], ...extra });

interface Setup { on?: boolean; cards?: unknown[]; decisions?: DecisionItem[]; tiles?: unknown[]; ended?: unknown; directory?: unknown; projects?: boolean; failFinished?: boolean }
function render(options: Setup = {}) {
 const cards = options.cards ?? [];
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/home") return { status: 200, body: { cards, total: cards.length, needsYou: cards.length + (options.decisions?.length ?? 0) } };
  if (request.path === "/v1/app/decisions") return { status: 200, body: decisionView(options.decisions ?? []) };
  if (request.path.startsWith("/v1/app/live")) return { status: 200, body: { tiles: options.tiles ?? [] } };
  if (request.path.startsWith("/v1/app/sessions")) return options.failFinished === true ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Finished work is unavailable." } } } : { status: 200, body: options.ended ?? { sessions: [] } };
  if (request.path.startsWith("/v1/app/agents")) return { status: 200, body: options.directory ?? { agents: [] } };
  if (/^\/v1\/app\/projects\/[^/]+\/overview$/u.test(request.path)) return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
  return { status: 200, body: { notices: [], next: "settled" } };
 });
 if (options.on === true) f.storage.set(HOME_STORAGE_KEY, "v2");
 const query = createQueryClient();
 query.setQueryData(["nav"], navFixture({ projects: options.projects === false ? [] : [{ name: "payments", agents: [] }] }));
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
const headings = (container: HTMLElement) => [...container.querySelectorAll("main h2, h2")].map(node => node.textContent?.replace(/\s+\d+$/u, "").trim());

it("is off unless the device key says v2", () => {
 const f = fakeHost();
 expect(isNewHomeOn(f.host)).toBe(false);
 for (const value of ["", "v1", "true", "V2", "1"]) { f.storage.set(HOME_STORAGE_KEY, value);expect(isNewHomeOn(f.host)).toBe(false); }
 f.storage.set(HOME_STORAGE_KEY, "v2");expect(isNewHomeOn(f.host)).toBe(true);
 expect(isNewHomeOn({ storage: { get() { throw new Error("blocked"); }, set() { /* none */ } } })).toBe(false);
});

it("with the switch off, Home is today's Home: the start box above the old cards, the empty state pointing to Live", async () => {
 const f = render({});
 expect(await screen.findByText("Nothing needs you right now")).toBeTruthy();
 expect(f.container.textContent).toContain("Find ongoing sessions in Live.");
 expect(f.container.querySelector(".rv-home-v2")).toBeNull();
 expect(screen.queryByText("Continue")).toBeNull();
 expect(screen.queryByText("Finished recently")).toBeNull();
 f.close();
});

it("with the switch off and cards present, the old attention list shows and none of the new rows", async () => {
 const f = render({ cards: [planCard(1)] });
 expect(await screen.findByRole("heading", { name: "Review plan 1" })).toBeTruthy();
 expect(f.container.querySelector(".rv-attention-list")).not.toBeNull();
 expect(f.container.querySelector(".rv-hv2-row")).toBeNull();
 f.close();
});

it("with the switch on and nothing anywhere, every section is there in order and says it is empty, in Work's words (never Live)", async () => {
 const f = render({ on: true });
 expect(await screen.findByText("Nothing needs you right now.")).toBeTruthy();
 expect(await screen.findByText("Nothing in progress.")).toBeTruthy();
 expect(await screen.findByText("Nothing finished recently.")).toBeTruthy();
 await waitFor(() => expect(screen.getByText("No agents are available yet.")).toBeTruthy());
 expect(headings(f.container)).toEqual(HEADINGS);
 expect(f.container.textContent).not.toMatch(/\bLive\b/u);
 const links = screen.getAllByRole("link", { name: "See all in Work" });
 expect(links).toHaveLength(2);
 for (const link of links) expect(link.getAttribute("href")).toBe("/app/live");
 expect(screen.getByRole("link", { name: "See all agents" }).getAttribute("href")).toBe("/app/agents");
 f.close();
});

it("Needs you comes first: decisions and older cards as rows with a plain state, the why, the age and one primary action", async () => {
 const f = render({ on: true, cards: [planCard(1), { cardId: "failure:" + homeSessionId(300), kind: "failure", title: "Verification failed", reason: "The checks did not pass.", sessionId: homeSessionId(300), at, buttons: [{ label: "Retry", action: "retry", method: "POST", href: origin + "/v1/app/sessions/" + homeSessionId(300) + "/retry" }] }], decisions: [decisionItem] });
 const list = await screen.findByRole("list", { name: "What needs you" });
 const rows = within(list).getAllByRole("listitem");
 expect(rows).toHaveLength(3);
 // The decision card comes first, then the older cards in the server's order.
 expect(rows[0]!.textContent).toContain("Move refunds to the new ledger");
 expect(rows[0]!.textContent).toContain("Needs a decision");
 expect(rows[1]!.textContent).toContain("Review plan 1");
 expect(rows[1]!.textContent).toContain("Your plan is ready to review");
 expect(rows[1]!.querySelector("time")).not.toBeNull();
 expect(rows[2]!.textContent).toContain("Failed");
 expect(rows[2]!.textContent).toContain("The checks did not pass.");
 // Each row has exactly one primary action.
 for (const row of rows) expect(row.querySelectorAll(".rv-button-primary")).toHaveLength(1);
 expect(within(rows[2]!).getByRole("button", { name: /^Retry/u }).className).toContain("rv-button-primary");
 expect(f.container.textContent).not.toMatch(/approve_design|needs_you|failure\b/u);
 // The heading shows the one count (the server's: 3).
 expect(screen.getByRole("heading", { name: /Needs you\s*3/u })).toBeTruthy();
 // The order on the page: Needs you before Start something before Continue before Finished recently.
 expect(headings(f.container)).toEqual(HEADINGS);
 f.close();
});

it("Continue lists my open work, never a session Needs you holds, at most five, with a plain state and the next step only where known", async () => {
 const tiles = [1, 2, 3, 4, 5, 6, 7].map(n => openTile(n, n === 1 ? { status: "running" } : n === 2 ? { status: "waiting", lastRunFailed: true } : n === 3 ? { needsYou: true } : {}));
 const held = openTile(8, { sessionId: homeSessionId(200 + 1) }); // the one session the plan card is about
 const f = render({ on: true, cards: [planCard(1)], tiles: [...tiles, held] });
 const list = await screen.findByRole("list", { name: "Work to continue" });
 const rows = within(list).getAllByRole("listitem");
 expect(rows).toHaveLength(HOME_LIST_MAX);
 const titles = rows.map(row => within(row).getByRole("heading").textContent);
 expect(titles).not.toContain("Open work 3"); // needs me: shown in Needs you's data, not here
 expect(titles).not.toContain("Open work 8"); // held by the plan card
 expect(titles).toEqual(["Open work 1", "Open work 2", "Open work 4", "Open work 5", "Open work 6"]);
 expect(rows[0]!.textContent).toContain("Building");
 expect(rows[0]!.textContent).toContain("Rovara is on it");
 expect(rows[1]!.textContent).toContain("Failed");
 expect(rows[1]!.textContent).toContain("Retry it, or close the task");
 expect(within(rows[0]!).getByRole("link", { name: "Open work 1" }).getAttribute("href")).toBe("/app/sessions/" + homeSessionId(101));
 expect(rows[0]!.textContent).toContain("payments");
 expect(rows[0]!.textContent).not.toMatch(/\brunning\b|\bwaiting\b|needs_person/u);
 f.close();
});

it("Finished recently lists at most five ended sessions, newest first, with a plain state", async () => {
 const f = render({ on: true, ended: { sessions: [...endedList(7).sessions, endedTile(9, { title: "Merged work" }, { display: { state: "merged" } })] } });
 const list = await screen.findByRole("list", { name: "Recently finished work" });
 const rows = within(list).getAllByRole("listitem");
 expect(rows).toHaveLength(HOME_LIST_MAX);
 expect(rows.map(row => within(row).getByRole("heading").textContent)).toEqual(["Finished work 1", "Finished work 2", "Finished work 3", "Finished work 4", "Finished work 5"]);
 expect(rows[0]!.textContent).toContain("Finished");
 expect(rows[0]!.textContent).not.toMatch(/succeeded/u);
 expect(f.request.mock.calls.some(call => String((call[0] as { path: string }).path) === "/v1/app/sessions?owner=me&status=ended&limit=5")).toBe(true);
 f.close();
});

it("the agents row puts the agents I used recently first, then the directory's first ones, up to four, each linking to its profile", async () => {
 const listed: Array<{ id: string; name: string; description: string; status?: "active" | "archived" }> = [1, 2, 3, 4, 5, 6].map(n => ({ id: agentId(n), name: "Agent " + String(n), description: "Does thing " + String(n) }));
 const directory = directoryOf(listed.concat([{ id: agentId(7), name: "Old agent", description: "Archived.", status: "archived" }]));
 const f = render({ on: true, directory, tiles: [openTile(1, { agent: { agentId: agentId(5), name: "Agent 5", version: 1 } })], ended: { sessions: [endedTile(1, { agent: { agentId: agentId(7), name: "Old agent", version: 1 } })] } });
 const list = await screen.findByRole("list", { name: "Agents" });
 await waitFor(() => expect(within(list).getAllByRole("listitem").map(item => within(item).getByRole("link").textContent)).toEqual(["Agent 5Used recently", "Agent 1Does thing 1", "Agent 2Does thing 2", "Agent 3Does thing 3"]));
 expect(within(list).getByRole("link", { name: /Agent 5/u }).getAttribute("href")).toBe("/app/agents/" + agentId(5));
 f.close();
});

it("a person with no projects is told there is nothing to start; a failed read says so with a way to try again", async () => {
 const f = render({ on: true, projects: false, failFinished: true });
 expect(await screen.findByText("You aren't on a project yet, so there is nothing to start here.")).toBeTruthy();
 expect(await screen.findByText("Finished work is unavailable.")).toBeTruthy();
 expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
 f.close();
});

it("each decision link names its decision, ages read as asked or updated, and a card whose Open cannot be followed still has a way in", async () => {
 const view = decisionView([decisionItem]), broken = { ...view, cards: view.cards.map(card => ({ ...card, actions: card.actions.map(action => action.kind === "open" ? { ...action, method: "POST" } : action) })) };
 const f = render({ on: true, cards: [planCard(1)], decisions: [decisionItem] });
 const row = (await screen.findByRole("heading", { name: "Move refunds to the new ledger" })).closest("li")!;
 expect(within(row).getByRole("link", { name: /^.+: Move refunds to the new ledger$/u })).toBeTruthy();
 expect(row.textContent).toContain("Asked ");
 expect(screen.getByRole("heading", { name: "Review plan 1" }).closest("li")!.textContent).toContain("Updated ");
 expect(within(screen.getByRole("heading", { name: "Review plan 1" }).closest("li")!).getByRole("link", { name: "Review plan: Review plan 1" })).toBeTruthy();
 f.close();
 const g = fakeHost(async request => request.path === "/v1/app/home" ? { status: 200, body: { cards: [], total: 0, needsYou: 1 } } : request.path === "/v1/app/decisions" ? { status: 200, body: broken } : request.path.startsWith("/v1/app/live") ? { status: 200, body: { tiles: [] } } : request.path.startsWith("/v1/app/sessions") ? { status: 200, body: { sessions: [] } } : request.path.startsWith("/v1/app/agents") ? { status: 200, body: { agents: [] } } : { status: 200, body: { notices: [], next: "settled" } });
 g.storage.set(HOME_STORAGE_KEY, "v2");
 const query = createQueryClient();query.setQueryData(["nav"], navFixture({ projects: [] }));
 const ui = renderUi(h(AppHostProvider, { host: g.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 const link = await screen.findByRole("link", { name: "Open: Move refunds to the new ledger" });
 expect(link.getAttribute("href")).toBe("/app/decisions/approve_design/design1");
 ui.unmount();query.clear();
});

it("a card's lead action is chosen by what it does and a dismissal never leads", async () => {
 const buttons = [{ label: "Not now", action: "dismiss", method: "POST", href: origin + "/v1/app/home/cards/" + encodeURIComponent("failure:" + homeSessionId(300)) + "/dismiss?occurrence=1" }, { label: "Retry", action: "retry", method: "POST", href: origin + "/v1/app/sessions/" + homeSessionId(300) + "/retry" }];
 const f = render({ on: true, cards: [{ cardId: "failure:" + homeSessionId(300), kind: "failure", title: "Verification failed", reason: "The checks did not pass.", sessionId: homeSessionId(300), at, buttons }, { cardId: "failure:" + homeSessionId(301), kind: "failure", title: "Only dismissable", reason: "Nothing else.", at, buttons: [buttons[0]] }] });
 const first = (await screen.findByRole("heading", { name: "Verification failed" })).closest("li")!;
 const controls = [...first.querySelectorAll(".rv-hv2-actions > *")].map(node => [node.textContent, node.className.includes("rv-button-primary")]);
 expect(controls[0]).toEqual(["Retry", true]);
 expect(controls.filter(control => control[1] === true)).toHaveLength(1);
 expect(controls.find(control => control[0] === "Not now")?.[1]).toBe(false);
 // This card's button is another card's dismissal, so it is refused; its session (from `failure:<id>`) is its primary.
 const second = screen.getByRole("heading", { name: "Only dismissable" }).closest("li")!;
 expect([...second.querySelectorAll(".rv-hv2-actions > *")].map(node => [node.textContent, node.className.includes("rv-button-primary")])).toEqual([["Open session", true]]);
 f.close();
});

it("a failure card with no Retry still leads with Open: a dismissal-only card with its session, and a card that arrives without its sessionId (taken from its id)", async () => {
 const dismiss = (id: string) => ({ label: "Not now", action: "dismiss", method: "POST", href: origin + "/v1/app/home/cards/" + encodeURIComponent("failure:" + id) + "/dismiss?occurrence=1" });
 const retry = (id: string) => ({ label: "Retry", action: "retry", method: "POST", href: origin + "/v1/app/sessions/" + id + "/retry" });
 const a = homeSessionId(310), b = homeSessionId(311), c = homeSessionId(312);
 const f = render({ on: true, cards: [
  { cardId: "failure:" + a, kind: "failure", title: "Dismiss and session", reason: "x", sessionId: a, at, buttons: [dismiss(a)] },
  { cardId: "failure:" + b, kind: "failure", title: "No sessionId, no buttons", reason: "x", at, buttons: [] },
  { cardId: "failure:" + c, kind: "failure", title: "No sessionId, retry and dismiss", reason: "x", at, buttons: [dismiss(c), retry(c)] },
  { cardId: "failure:verification", kind: "failure", title: "Nothing to open", reason: "x", at, buttons: [dismiss("verification")] },
 ] });
 const row = async (title: string) => (await screen.findByRole("heading", { name: title })).closest("li")!;
 const controls = (li: Element) => [...li.querySelectorAll(".rv-hv2-actions > *")].map(node => [node.textContent, node.className.includes("rv-button-primary")]);
 expect(controls(await row("Dismiss and session"))).toEqual([["Not now", false], ["Open session", true]]);
 expect(controls(await row("No sessionId, no buttons"))).toEqual([["Open session", true]]);
 // The Retry of a card without its sessionId is valid once the id is taken from the card's own id, and it leads.
 expect(controls(await row("No sessionId, retry and dismiss"))[0]).toEqual(["Retry", true]);
 // Nothing to open at all: the dismissal stays quiet, never primary.
 expect(controls(await row("Nothing to open"))).toEqual([["Not now", false]]);
 expect(withFailureSession({ cardId: "plan:" + a, kind: "plan" } as never).sessionId).toBeUndefined();
 f.close();
});

it("the mapping: plain words only, a merge is ready to merge, an unknown kind asks the person", () => {
 expect(homeCardState("failure").label).toBe(PLAIN_STATE_LABELS["failed"]);
 expect(homeCardState("pull_request").label).toBe("Needs review");
 expect(homeCardState("paused").label).toBe("Paused: needs budget");
 expect(homeCardState("a_kind_from_a_newer_server").label).toBe("Needs a decision");
 expect(decisionState({ kind: "merge" }).label).toBe("Ready to merge");
 expect(decisionState({ kind: "approve_plan" }).label).toBe("Needs a decision");
 expect(nextLine({ state: "building" })).toBe("Rovara is on it");
 expect(nextLine({ state: "merged" })).toBeUndefined();
 expect(rowStatus({ status: "paused" }).state).toBe("paused_budget");
});

it("the lists keep their limits and order even when handed more", () => {
 const tiles = Array.from({ length: 12 }, (_, index) => openTile(index + 1));
 expect(continueRows(tiles, new Set()).map(row => row.title)).toEqual([1, 2, 3, 4, 5].map(n => "Open work " + String(n)));
 expect(continueRows(tiles, new Set([homeSessionId(101)])).map(row => row.title)[0]).toBe("Open work 2");
 expect(finishedRows(endedList(12).sessions)).toHaveLength(5);
 expect(pickAgents(directoryOf(names(6)).agents, [], 4)).toHaveLength(4);
 expect(pickAgents(directoryOf(names(2)).agents, [agentId(9)], 4).map(agent => agent.recent)).toEqual([false, false]);
 expect(needsYouSessions([planCard(1)] as never, readDecisions(decisionView([decisionItem])))).toEqual(new Set([homeSessionId(201), SESSION_FIXTURE_ID]));
});
