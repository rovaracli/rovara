// @vitest-environment jsdom
// Decision journey, slice 1 (owner: "a cohesive experience for the complete journey, no disparate steps"): every link to a decision lands on its card on the task page, Home shows one card per
// decision, a high-risk Skip without a recent sign-in offers "Sign in again" where it was pressed, and the card's buttons use the one vocabulary.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { withoutDecided } from "../../packages/ui/src/screens/home/one-card.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { projectDecisionCards, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { designReviewFixture, designTaskSession } from "./support/design-review-fixture.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const SESSION = SESSION_FIXTURE_ID, OTHER = "ses_" + "b".repeat(20);
const SESSION_PATH = "/app/sessions/" + SESSION;
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: SESSION_PATH, ...extra });
const designItem: DecisionItem = { ...base("design1"), kind: "approve_design", files: ["src/retry.ts"] };
const mergeItem: DecisionItem = { ...base("pr1"), kind: "merge", prRisk: "low", prReasons: [], proof: { proven: 1, passed: 1, failed: 0, notTested: 0 }, reviewVerdict: "approved", ci: "passing", securityFindingsHigh: 0, fullSuitePending: false };
const viewOf = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };
const at = "2026-11-06T11:00:00.000Z", origin = "https://cell.example";
const open = (sessionId: string) => [{ label: "Open session", action: "open", method: "GET", href: origin + "/s/" + sessionId }];
const homeCards = [
 { cardId: "plan:" + SESSION, kind: "plan", title: "Retry failed payments", reason: "Your plan is ready to review", sessionId: SESSION, at, buttons: open(SESSION) },
 { cardId: "pull_request:" + SESSION, kind: "pull_request", title: "Retry failed payments", reason: "Your pull request is ready for review", sessionId: SESSION, at, buttons: open(SESSION) },
 { cardId: "pull_request:rv_" + "c".repeat(24), kind: "pull_request", title: "Someone else's change", reason: "Waiting for your review for 1 day", sessionId: SESSION, at, buttons: open(SESSION) },
 { cardId: "plan:" + OTHER, kind: "plan", title: "Another task", reason: "Your plan for another task is ready to review", sessionId: OTHER, at, buttons: open(OTHER) },
 { cardId: "failure:" + SESSION, kind: "failure", title: "Retry failed payments", reason: "It failed", sessionId: SESSION, at, buttons: [] },
];

function home(decisions: { status: number; body: unknown }) {
 const f = fakeHost(async request => request.path === "/v1/app/home" ? { status: 200, body: { cards: homeCards, total: homeCards.length } } : request.path === "/v1/app/decisions" ? decisions : { status: 200, body: { notices: [], next: "settled" } });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 return { ...f, close() { ui.unmount();query.clear(); } };
}

function taskPage(items: DecisionItem[], search = "", answer?: (path: string, method: string) => { status: number; body: unknown } | undefined, session = designTaskSession(designReviewFixture())) {
 const f = fakeHost(async request => {
  const answered = answer?.(request.path, request.method);
  if (answered !== undefined) return answered;
  if (request.path === "/v1/app/decisions") return { status: 200, body: viewOf(items) };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: [SESSION_PATH + search] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, close() { ui.unmount();router.dispose();query.clear(); } };
}

it("S1b: Home leaves out the older plan and own pull request cards whose decision a pending card holds, and keeps every other card", async () => {
 const f = home({ status: 200, body: viewOf([designItem, mergeItem]) });
 // The decision cards are the one place: one card for the design and one for the merge.
 const needsYou = await screen.findByRole("list", { name: "Decisions waiting for you" });
 expect(within(needsYou).getAllByRole("article")).toHaveLength(2);
 const older = await screen.findByRole("list", { name: "What needs you" });
 await waitFor(() => expect(within(older).getAllByRole("heading", { level: 2 }).map(heading => heading.textContent)).toEqual(["Someone else's change", "Another task", "Retry failed payments"]));
 // The failure card is the one "Retry failed payments" left; the header counts what is shown.
 expect(within(older).getByText("It failed")).toBeTruthy();
 expect(within(older).queryByText("Your plan is ready to review")).toBeNull();
 expect(within(older).queryByText("Your pull request is ready for review")).toBeNull();
 // UX2 slice 2: ONE count, the older cards shown and the pending decision cards (2 + 3).
 expect(screen.getByText("5 things need you")).toBeTruthy();
 f.close();
});

it("S1b: with no decision cards (the switch is off) every older card still shows", async () => {
 const f = home({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
 await screen.findByText("5 things need you");
 expect(screen.getByText("Your plan is ready to review")).toBeTruthy();
 expect(screen.getByText("Your pull request is ready for review")).toBeTruthy();
 f.close();
});

it("S1b (review fix): a failed decisions read hides nothing: every older card still shows", async () => {
 const f = home({ status: 500, body: { error: { code: "INTERNAL", message: "boom" } } });
 await screen.findByText("5 things need you");
 expect(screen.getByText("Your plan is ready to review")).toBeTruthy();
 expect(screen.getByText("Your pull request is ready for review")).toBeTruthy();
 f.close();
});

it("S1b: the rule itself: only the kinds a card replaces, only for the card's own session, and a decided card replaces nothing", () => {
 const decisions = readDecisions(viewOf([designItem]));
 const cards = homeCards as never[];
 expect(withoutDecided(cards, decisions).map((card: { cardId: string }) => card.cardId)).toEqual(homeCards.filter(card => card.cardId !== "plan:" + SESSION).map(card => card.cardId));
 expect(withoutDecided(cards, undefined)).toHaveLength(homeCards.length);
 const decided = decisions.map(decision => ({ ...decision, card: { ...decision.card, status: "approved" as const } }));
 expect(withoutDecided(cards, decided)).toHaveLength(homeCards.length);
});

it("S1a: Home's merge card opens its card on the task page, and the task page marks that card and has no link back to itself", async () => {
 const f = home({ status: 200, body: viewOf([mergeItem]) });
 const needsYou = await screen.findByRole("list", { name: "Decisions waiting for you" });
 expect(within(needsYou).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(SESSION_PATH + "?decision=merge%3Apr1");
 expect(within(needsYou).getByRole("button", { name: "Merge" })).toBeTruthy();
 f.close();
 const page = taskPage([mergeItem], "?decision=merge%3Apr1");
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(card.getAttribute("data-focused")).toBe("true");
 expect(within(card).queryByRole("link", { name: "Open" })).toBeNull();
 expect(within(card).getByRole("button", { name: "Merge" })).toBeTruthy();
 page.close();
});

it("S1c: a high-risk Skip without a recent sign-in says so where it was pressed, with Sign in again that comes back here", async () => {
 const session = designTaskSession(undefined, { designActions: { designFirst: false, skip: { allowed: true } } });
 const f = taskPage([], "", (path, method) => method === "POST" && path === "/v1/app/tasks/" + TASK + "/design-review/skip"
  ? { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to skip this design review. A high-risk design needs a sign-in within the last 10 minutes." } } } : undefined, session);
 const strip = await screen.findByRole("region", { name: "Design review actions" });
 fireEvent.click(within(strip).getByRole("button", { name: "Skip design review" }));
 fireEvent.click(within(await screen.findByRole("group", { name: "Confirm skipping design review" })).getByRole("button", { name: "Skip design review" }));
 expect((await within(strip).findByRole("alert")).textContent).toContain("Sign in again to skip this design review");
 fireEvent.click(within(strip).getByRole("button", { name: "Sign in again" }));
 expect(f.host.signIn).toHaveBeenCalledWith(f.host.currentPath());
 f.close();
});

it("final review: while the cost card waits, the strip offers no Skip (the card's own Skip is the one); a strip Skip's decide sign-in is a link to it", async () => {
 const waiting = designTaskSession(designReviewFixture({ status: "waiting_cost" }), { designActions: { designFirst: false, skip: { allowed: true } } });
 const f = taskPage([], "", undefined, waiting);
 const strip = await screen.findByRole("region", { name: "Design review actions" });
 expect(within(strip).queryByRole("button", { name: "Skip design review" })).toBeNull();
 f.close();
 const SIGN_IN = "/v1/auth/decide/identify?return=" + encodeURIComponent("/v1/app/approve/apr_" + "a".repeat(20));
 const before = designTaskSession(undefined, { designActions: { designFirst: false, skip: { allowed: true } } });
 const g = taskPage([], "", (path, method) => method === "POST" && path.endsWith("/design-review/skip")
  ? { status: 403, body: { error: { code: "REAUTH_REQUIRED", reason: "decide_sign_in", signInUrl: SIGN_IN, message: "Sign in again to decide this. A high-risk decision needs a sign-in with the email code within the last 10 minutes." } } } : undefined, before);
 const strip2 = await screen.findByRole("region", { name: "Design review actions" });
 fireEvent.click(within(strip2).getByRole("button", { name: "Skip design review" }));
 fireEvent.click(within(await screen.findByRole("group", { name: "Confirm skipping design review" })).getByRole("button", { name: "Skip design review" }));
 expect((await within(strip2).findByRole("link", { name: "Sign in again" })).getAttribute("href")).toBe("https://cell.example" + SIGN_IN);
 g.close();
});

it("S1c: any other refusal is said without Sign in again", async () => {
 const session = designTaskSession(undefined, { designActions: { designFirst: false, skip: { allowed: true } } });
 const f = taskPage([], "", (path, method) => method === "POST" && path.endsWith("/design-review/skip") ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Decide this in the Rovara app." } } } : undefined, session);
 const strip = await screen.findByRole("region", { name: "Design review actions" });
 fireEvent.click(within(strip).getByRole("button", { name: "Skip design review" }));
 fireEvent.click(within(await screen.findByRole("group", { name: "Confirm skipping design review" })).getByRole("button", { name: "Skip design review" }));
 expect((await within(strip).findByRole("alert")).textContent).toContain("Decide this in the Rovara app.");
 expect(within(strip).queryByRole("button", { name: "Sign in again" })).toBeNull();
 f.close();
});
