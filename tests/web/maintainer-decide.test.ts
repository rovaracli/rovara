// @vitest-environment jsdom
// Approval place (U4), the UI side: a project maintainer (or a company owner or admin) who decides someone else's coding plan is never offered Reject, a run-limit tick or an Approve that would raise
// the limit, is told the owner will hear about it, and keeps Approve and Request changes. The owner, and a server that sends no `decideAs`, see the page exactly as before. A refusal is shown as the server said it.
import { afterEach, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { DecisionList } from "../../packages/ui/src/screens/home/NeedsYou.js";
import { approveLine } from "../../packages/ui/src/screens/session/task-plain-state.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { readPanelView } from "../../packages/ui/src/api/plan-panel.js";
import { MAINTAINER_RUN_LIMIT_WORDS, isMaintainerSeat, maintainerNote, readDecideSeat } from "../../packages/ui/src/api/decide-seat.js";
import { forceTaskPageFlags } from "../../packages/ui/src/screens/session/task-page-flags.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { projectDecisionCards, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import type { ApiRequest } from "../../packages/ui/src/host.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { SESSION_FIXTURE_ID, sessionPerson } from "./support/session-fixture.js";
import { designTaskSession } from "./support/design-review-fixture.js";

afterEach(() => { forceTaskPageFlags(undefined); });
const TASK = "11111111-1111-4111-8111-111111111111";
const SESSION_PATH = "/app/sessions/" + SESSION_FIXTURE_ID;
const MAYA = { developerId: "b".repeat(64), name: "Maya Chen" };
const base = (extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: TASK, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: SESSION_PATH, ...extra });
const plan = (runLimit?: { currentUsd?: number; proposedUsd: number }): DecisionItem => ({ ...base(), kind: "approve_plan", path: "quick", files: [], claims: 2, untestedClaims: 0, ...(runLimit === undefined ? {} : { runLimit }) });
/** A coding plan's card as a future server could list it with a Reject on it (today's plan cards carry none): the UI must still never offer it to a maintainer. */
function viewWithReject(items: DecisionItem[]) {
 const projected = projectDecisionCards(items);
 const cards = projected.cards.map(card => ({ ...card, actions: [...card.actions, { kind: "reject" as const, label: "Not now", href: "/v1/app/decisions/" + card.id.replace(":", "/") + "/reject", method: "POST" as const }], rejectReasons: ["not_now" as const, "wrong_approach" as const] }));
 return DecisionCardsViewSchema.parse({ cards, total: cards.length, tabs: projected.tabs, details: projected.details, digests: projected.digests, dropped: projected.dropped, choices: projected.choices });
}
const decided = (cardId: string, outcome: "approved" | "rejected") => ({ status: 200, body: { cardId, outcome, remainingTabs: [] } });
const planDocument = (access: Record<string, unknown>) => ({ status: 200, body: { document: "plan", versions: [{ version: 1, current: true, approved: false }], checks: [], unverified: false, waiting: true,
 current: { version: 1, approved: false, format: "markdown", markdown: "# Retry failed payments\n\nRetry once." }, access: { canComment: true, canSuggest: false, canDecide: true, canAsk: false, ...access } } });
type Seat = { decideAs?: string; ownerName?: string } | "unreadable";

/** The task page for a viewer who is `owner` or not, with the plan document's access summary as the server sends it (`seat`), a card with a Reject on it, and what the server answers to a press. */
function taskPage(options: { owner: boolean; seat?: Seat; items?: DecisionItem[]; answer?: (request: ApiRequest) => { status: number; body: unknown } | undefined; at?: string; flags?: boolean }) {
 const session = { ...designTaskSession(undefined, {}, { path: "QUICK", reviewPhase: undefined, stage: "PLAN_REVIEW", state: "WAITING", planContent: "# Plan\nRetry once." }),
  owner: options.owner ? sessionPerson : MAYA, you: { level: "edit" as const, owner: options.owner, following: false, actions: ["watch" as const, "comment" as const] } };
 const f = fakeHost(async request => {
  const answered = options.answer?.(request);
  if (answered !== undefined) return answered;
  if (request.path === "/v1/app/decisions") return { status: 200, body: viewWithReject(options.items ?? [plan()]) };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (request.path === "/v1/app/tasks/" + TASK + "/documents/plan") return options.seat === "unreadable" ? { status: 500, body: { error: { code: "INTERNAL", message: "no" } } } : planDocument(options.seat ?? {});
  if (request.method === "POST" && request.path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: request.path.split("/").slice(-3, -1).join(":"), opened: true, recorded: true } };
  return { status: 200, body: { session } };
 });
 if (options.flags === true) forceTaskPageFlags({ leadingHeader: true });
 const query = createQueryClient();
 query.setQueryData(["nav"], { org: { name: "Acme" }, features: { decisionCards: true } });
 const router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: [options.at ?? SESSION_PATH] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST" && !request.path.endsWith("/presence"));
 const seatReads = () => f.request.mock.calls.filter(([request]) => request.path === "/v1/app/tasks/" + TASK + "/documents/plan").length;
 return { ...f, container: ui.container, posts, seatReads, close() { ui.unmount();router.dispose();query.clear(); } };
}
const cardOn = () => screen.findByRole("article", { name: "Retry failed payments" });
const NOTE_MAYA = "You are deciding as a maintainer; Maya Chen will be told.";
const rejects = (scope: HTMLElement) => ({ notNow: within(scope).queryByText("Not now", { selector: "summary" }), reason: within(scope).queryByRole("button", { name: "Wrong approach" }), reject: within(scope).queryByRole("button", { name: /^Reject/u }) });

it("task page, maintainer: no Reject or Not now, the note names the owner, Approve and Request changes stay", async () => {
 const f = taskPage({ owner: false, seat: { decideAs: "maintainer" } });
 const card = await cardOn();
 await waitFor(() => expect(within(card).getByText(NOTE_MAYA)).toBeTruthy());
 expect(rejects(card)).toEqual({ notNow: null, reason: null, reject: null });
 expect(within(card).getByRole("button", { name: "Approve" })).toBeTruthy();
 expect(within(card).getByText("Request changes", { selector: "summary" })).toBeTruthy();
 await expectNoAxeViolations(f.container);
 f.close();
});

it("the note names the owner when the page has the name, and says the task owner when it does not", () => {
 expect(maintainerNote({ as: "maintainer" })).toBe("You are deciding as a maintainer; the task owner will be told.");
 expect(maintainerNote({ as: "maintainer", ownerName: "Maya Chen" })).toBe(NOTE_MAYA);
});

it("task page, maintainer: the server's own owner name beats the session's", async () => {
 const f = taskPage({ owner: false, seat: { decideAs: "maintainer", ownerName: "Sam Rivera" } });
 const card = await cardOn();
 await waitFor(() => expect(within(card).getByText("You are deciding as a maintainer; Sam Rivera will be told.")).toBeTruthy());
 f.close();
});

it("task page, maintainer: Approve sends no acknowledged run limit even when the plan names a limit it would not raise", async () => {
 const f = taskPage({ owner: false, seat: { decideAs: "maintainer" }, items: [plan({ currentUsd: 10, proposedUsd: 6 })], answer: request => request.method === "POST" && request.path.endsWith("/approve") ? decided("approve_plan:" + TASK, "approved") : undefined });
 const card = await cardOn();
 const limit = within(card).getByRole("group", { name: "Run limit" });
 await waitFor(() => expect(limit.textContent).toContain("The task owner decides the run limit."));
 expect(within(limit).queryByRole("checkbox")).toBeNull();
 fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
 await waitFor(() => expect(f.posts().some(request => request.path.endsWith("/approve"))).toBe(true));
 expect(f.posts().find(request => request.path.endsWith("/approve"))!.body).not.toHaveProperty("acknowledgedRunLimitUsd");
 f.close();
});

it("task page, maintainer: a plan that would raise the run limit has no tick and no Approve, says the owner decides it, and still offers Request changes", async () => {
 const f = taskPage({ owner: false, seat: { decideAs: "maintainer" }, items: [plan({ currentUsd: 2, proposedUsd: 6 })] });
 const card = await cardOn();
 const limit = within(card).getByRole("group", { name: "Run limit" });
 await waitFor(() => expect(limit.textContent).toContain(MAINTAINER_RUN_LIMIT_WORDS));
 expect(within(limit).queryByRole("checkbox")).toBeNull();
 expect(within(card).queryByRole("checkbox", { name: /raise this task's run limit/u })).toBeNull();
 expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
 expect(rejects(card)).toEqual({ notNow: null, reason: null, reject: null });
 expect(within(card).getByText("Request changes", { selector: "summary" })).toBeTruthy();
 expect(within(card).getByText(NOTE_MAYA)).toBeTruthy();
 f.close();
});

it("task page, owner: unchanged (Not now with its reasons, the run-limit tick, the ticked limit sent, no maintainer note)", async () => {
 const f = taskPage({ owner: true, seat: { decideAs: "owner" }, items: [plan({ currentUsd: 2, proposedUsd: 6 })], answer: request => request.method === "POST" && request.path.endsWith("/approve") ? decided("approve_plan:" + TASK, "approved") : undefined });
 const card = await cardOn();
 expect(within(card).getByText("Not now", { selector: "summary" })).toBeTruthy();
 expect(within(card).getByRole("button", { name: "Wrong approach" })).toBeTruthy();
 const approve = within(card).getByRole("button", { name: "Approve" });
 expect(approve.hasAttribute("disabled")).toBe(true);
 fireEvent.click(within(card).getByRole("checkbox", { name: /raise this task's run limit/u }));
 await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
 fireEvent.click(approve);
 await waitFor(() => expect(f.posts().find(request => request.path.endsWith("/approve"))?.body).toMatchObject({ acknowledgedRunLimitUsd: 6 }));
 expect(card.textContent).not.toContain("deciding as a maintainer");
 expect(f.seatReads(), "an owner costs no extra read").toBe(0);
 f.close();
});

it("task page, no decideAs from an older server: unchanged, whoever the viewer is", async () => {
 for (const owner of [true, false]) {
  const f = taskPage({ owner, seat: {}, items: [plan({ currentUsd: 2, proposedUsd: 6 })] });
  const card = await cardOn();
  if (!owner) await waitFor(() => expect(f.seatReads()).toBe(1));
  await waitFor(() => expect(within(card).getByText("Not now", { selector: "summary" })).toBeTruthy());
  expect(within(card).getByRole("checkbox", { name: /raise this task's run limit/u })).toBeTruthy();
  expect(card.textContent).not.toContain("deciding as a maintainer");
  f.close();
 }
});

it("task page, a viewer who is not the owner and whose seat cannot be read is treated as a maintainer: Reject is never shown while unsure", async () => {
 const f = taskPage({ owner: false, seat: "unreadable" });
 const card = await cardOn();
 await waitFor(() => expect(f.seatReads()).toBe(1));
 expect(rejects(card)).toEqual({ notNow: null, reason: null, reject: null });
 expect(within(card).getByText(/You are deciding as a maintainer; Maya Chen will be told\./u)).toBeTruthy();
 f.close();
});

it("task page, maintainer: a refusal from the server is shown word for word", async () => {
 for (const sentence of [MAINTAINER_RUN_LIMIT_WORDS, "Only the task owner or a project maintainer can approve this plan."]) {
  const f = taskPage({ owner: false, seat: { decideAs: "maintainer" }, answer: request => request.method === "POST" && request.path.endsWith("/approve") ? { status: 403, body: { error: { code: "FORBIDDEN", message: sentence } } } : undefined });
  const card = await cardOn();
  await waitFor(() => expect(within(card).getByText(NOTE_MAYA)).toBeTruthy());
  fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
  expect((await within(card).findByRole("alert")).textContent).toBe(sentence);
  f.close();
 }
});

it("plan panel footer, maintainer: the card's Approve and Request changes pinned at the foot of the open plan carry the note and no Reject", async () => {
 const f = taskPage({ owner: false, seat: { decideAs: "maintainer" }, at: SESSION_PATH + "?doc=plan" });
 const footer = await screen.findByRole("region", { name: "Decide" });
 await waitFor(() => expect(within(footer).getByText(NOTE_MAYA)).toBeTruthy());
 expect(rejects(footer)).toEqual({ notNow: null, reason: null, reject: null });
 expect(within(footer).getByRole("button", { name: "Approve" })).toBeTruthy();
 f.close();
});

it("plan panel footer, owner: unchanged (Not now is there)", async () => {
 const f = taskPage({ owner: true, seat: { decideAs: "owner" }, at: SESSION_PATH + "?doc=plan" });
 const footer = await screen.findByRole("region", { name: "Decide" });
 expect(within(footer).getByText("Not now", { selector: "summary" })).toBeTruthy();
 expect(footer.textContent).not.toContain("deciding as a maintainer");
 f.close();
});

it("the task page header's can-I-approve line says maintainer for a maintainer and is as before for the owner", async () => {
 const maintainer = taskPage({ owner: false, seat: { decideAs: "maintainer" }, flags: true });
 const lead = await screen.findByRole("region", { name: "Where this task stands" });
 await waitFor(() => expect(lead.textContent).toContain("✓ You can approve or ask for changes as a maintainer · low risk"));
 expect(lead.textContent).not.toContain("✓ You can approve · low risk");
 maintainer.close();
 const owner = taskPage({ owner: true, seat: { decideAs: "owner" }, flags: true });
 const ownerLead = await screen.findByRole("region", { name: "Where this task stands" });
 await waitFor(() => expect(ownerLead.textContent).toContain("✓ You can approve · low risk"));
 owner.close();
 const raising = taskPage({ owner: false, seat: { decideAs: "maintainer" }, flags: true, items: [plan({ currentUsd: 2, proposedUsd: 6 })] });
 const raisingLead = await screen.findByRole("region", { name: "Where this task stands" });
 await waitFor(() => expect(raisingLead.textContent).toContain("You can ask for changes as a maintainer · low risk · the task owner decides the run limit"));
 expect(raisingLead.textContent).not.toContain("✓");
 raising.close();
});

it("the decision list (Home's Needs you and the task page share it): a maintainer seat hides Reject there too, no seat keeps it", async () => {
 const view = viewWithReject([plan()]);
 const decisions = readDecisions(view);
 const f = fakeHost();
 const query = createQueryClient();
 for (const [seat, shown] of [[undefined, true], [{ as: "owner" as const }, true], [{ as: "maintainer" as const, ownerName: "Maya Chen" }, false]] as const) {
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [SESSION_PATH], children: h(DecisionList, { decisions, label: "Decisions", seat }) }) }) }));
  const card = await screen.findByRole("article", { name: "Retry failed payments" });
  expect(within(card).queryByText("Not now", { selector: "summary" }) !== null, JSON.stringify(seat)).toBe(shown);
  ui.unmount();
 }
 query.clear();
});

it("readers: the seat comes only from a real decideAs word; an unknown seat word is read as the narrower one; absent is nothing", () => {
 expect(readDecideSeat({ canDecide: true })).toBeUndefined();
 expect(readDecideSeat(undefined)).toBeUndefined();
 expect(readDecideSeat({ decideAs: 7 })).toBeUndefined();
 expect(readDecideSeat({ decideAs: "" })).toBeUndefined();
 expect(readDecideSeat({ decideAs: "owner", ownerName: "Maya" })).toEqual({ as: "owner" });
 expect(readDecideSeat({ decideAs: "maintainer", ownerName: "  Maya Chen " })).toEqual({ as: "maintainer", ownerName: "Maya Chen" });
 expect(readDecideSeat({ decideAs: "maintainer", ownerName: 4 })).toEqual({ as: "maintainer" });
 expect(isMaintainerSeat(readDecideSeat({ decideAs: "collaborator" }))).toBe(true);
 expect(readPanelView({ access: { canDecide: true, decideAs: "maintainer" } }).access).toMatchObject({ canDecide: true, seat: { as: "maintainer" } });
 expect(readPanelView({ access: { canDecide: true } }).access).not.toHaveProperty("seat");
 expect(readPanelView({ access: { canDecide: true, decideAs: "owner" } }).access.seat).toEqual({ as: "owner" });
});

it("approveLine: an owner (or no seat) reads as it always did", () => {
 const cards = readDecisions(viewWithReject([plan()]));
 expect(approveLine(cards)).toBe("✓ You can approve · low risk");
 expect(approveLine(cards, { as: "owner" })).toBe("✓ You can approve · low risk");
 expect(approveLine(cards, { as: "maintainer" })).toBe("✓ You can approve or ask for changes as a maintainer · low risk");
});
