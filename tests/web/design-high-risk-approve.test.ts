// @vitest-environment jsdom
// A HIGH-risk design is decided on the card itself, on the task page (owner 2026-11-06: the card used to offer only "Open to decide", a link to the same page and the same card, so it looped):
// the inline Approve reads what the server shows now, presses with that digest, asks for a sign-in again on the same card when the server says so, and shows who can decide to everyone else.
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
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
const SESSION_PATH = "/app/sessions/ses_" + "a".repeat(20);
const base = (id: string): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: SESSION_PATH });
const design = (reasons: Array<"auth" | "new_api">, blockers = 0): DecisionItem => ({ ...base("design1"), kind: "approve_design", files: ["src/retry.ts"], review: {
 reasons, touches: [], reviewers: { planned: 3, verified: 3 }, blockers: Array.from({ length: blockers }, (_, index) => ({ section: "§3", text: "Blocker " + String(index + 1) })), majors: 0, disagreements: [], costUsd: 0.96 } });
const high = design(["auth"]), medium = design(["new_api"]);
const projectionOf = (items: DecisionItem[]) => projectDecisionCards(items);
const viewOf = (items: DecisionItem[]) => { const p = projectionOf(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };
const APPROVE_PATH = "/v1/app/tasks/" + TASK + "/design-review/approve";

interface Server { read: () => { status: number; body: unknown }; approve: (body: { requestId: string; shownDigest: string; reason?: string }) => { status: number; body: unknown } }
/** The task page with its decision cards and the design review's approve routes answered by `server`. */
function taskPage(items: DecisionItem[], server: Server, search = "") {
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/decisions") return { status: 200, body: viewOf(items) };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (request.path === APPROVE_PATH && request.method === "GET") return server.read();
  if (request.path === APPROVE_PATH && request.method === "POST") return server.approve(request.body as never);
  if (request.method === "POST" && request.path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: request.path.split("/").slice(-3, -1).join(":"), opened: true, recorded: true } };
  return { status: 200, body: { session: designTaskSession(designReviewFixture()) } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID + search] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 const calls = (method: string) => f.request.mock.calls.map(([request]) => request).filter(request => request.method === method && request.path === APPROVE_PATH);
 return { ...f, ...ui, calls, close() { ui.unmount();router.dispose();query.clear(); } };
}
const digestOf = (item: DecisionItem) => projectionOf([item]).digests["approve_design:design1"]!;
const mayApprove = (item: DecisionItem): Server["read"] => () => ({ status: 200, body: { card: {}, digest: digestOf(item), mayApprove: true } });

it("a high-risk design card shows Approve on the task page itself, with the note, and no link back to the same page", async () => {
 const f = taskPage([high], { read: mayApprove(high), approve: () => ({ status: 200, body: { cardId: "approve_design:design1", outcome: "approved" } }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(card.getAttribute("data-risk")).toBe("high");
 const approve = await within(card).findByRole("button", { name: "Approve" });
 expect(within(card).getByText("High risk: approving needs a recent sign-in.")).toBeTruthy();
 expect(within(card).queryByRole("link", { name: "Open" })).toBeNull();
 expect(within(card).queryByText(/on its own page/)).toBeNull();
 f.close();
 expect(approve).toBeTruthy();
});

it("pressing Approve reads the card from the server, then posts with the digest that was shown, once", async () => {
 const f = taskPage([high], { read: mayApprove(high), approve: () => ({ status: 200, body: { cardId: "approve_design:design1", outcome: "approved" } }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 await within(card).findByRole("button", { name: "Approve" });
 const readsBefore = f.calls("GET").length;
 fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
 await within(card).findByText("Approved. Rovara goes on from here.");
 expect(f.calls("GET").length).toBe(readsBefore + 1);
 expect(f.calls("POST")).toHaveLength(1);
 const body = f.calls("POST")[0]!.body as { requestId: string; shownDigest: string; reason?: string };
 expect(body.shownDigest).toBe(digestOf(high));
 expect(typeof body.requestId).toBe("string");
 expect(body).not.toHaveProperty("reason");
 // The read came before the press.
 const order = f.request.mock.calls.map(([request]) => request.method + " " + request.path).filter(line => line.endsWith(APPROVE_PATH));
 expect(order.at(-2)).toBe("GET " + APPROVE_PATH);
 expect(order.at(-1)).toBe("POST " + APPROVE_PATH);
 f.close();
});

it("security review: without the decide-grade sign-in the same card says so, and 'Sign in again' is the decide sign-in the broker made for this card (it comes back here); the second press approves", async () => {
 let signedIn = false;
 const f = taskPage([high], { read: mayApprove(high), approve: () => signedIn ? { status: 200, body: { cardId: "approve_design:design1", outcome: "approved" } } : { status: 403, body: { error: { code: "REAUTH_REQUIRED", reason: "decide_sign_in", signInUrl: SIGN_IN, message: "Sign in again to decide this. A high-risk decision needs a sign-in with the email code within the last 10 minutes." } } } });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 fireEvent.click(await within(card).findByRole("button", { name: "Approve" }));
 expect((await within(card).findByRole("alert")).textContent).toContain("Sign in again to decide this");
 expect(within(card).queryByText("Approved. Rovara goes on from here.")).toBeNull();
 expect(within(card).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("https://cell.example" + SIGN_IN);
 expect(f.host.signIn).not.toHaveBeenCalled();
 // Back from signing in: the person presses Approve once more.
 signedIn = true;
 fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
 await within(card).findByText("Approved. Rovara goes on from here.");
 expect(f.calls("POST")).toHaveLength(2);
 expect(within(card).queryByRole("link", { name: "Sign in again" })).toBeNull();
 f.close();
});

const SIGN_IN = "/v1/auth/decide/identify?return=" + encodeURIComponent("/v1/app/approve/apr_" + "a".repeat(20));

it("a card that changed while the person looked is not approved: 'This changed while you were looking', and nothing is posted", async () => {
 let digest = digestOf(high);
 const f = taskPage([high], { read: () => ({ status: 200, body: { card: {}, digest, mayApprove: true } }), approve: () => ({ status: 200, body: { outcome: "approved" } }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 await within(card).findByRole("button", { name: "Approve" });
 digest = "f".repeat(64);
 fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
 expect((await within(card).findByRole("alert")).textContent).toContain("This changed while you were looking");
 expect(f.calls("POST")).toHaveLength(0);
 f.close();
});

it("a stale answer from the server on the press says the same", async () => {
 const f = taskPage([high], { read: mayApprove(high), approve: () => ({ status: 409, body: { error: { code: "CHANGE_STALE", message: "This changed while you were looking. Reload to see the latest." } } }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 fireEvent.click(await within(card).findByRole("button", { name: "Approve" }));
 expect((await within(card).findByRole("alert")).textContent).toContain("This changed while you were looking");
 expect(f.calls("POST")).toHaveLength(1);
 f.close();
});

it("an open blocker asks for the one-line reason on the inline Approve and sends it", async () => {
 const withBlocker = design(["auth"], 1);
 const f = taskPage([withBlocker], { read: mayApprove(withBlocker), approve: () => ({ status: 200, body: { outcome: "approved" } }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 const approve = await within(card).findByRole("button", { name: "Approve with a reason" });
 expect(approve.hasAttribute("disabled")).toBe(true);
 fireEvent.change(within(card).getByRole("textbox", { name: "Why approve with an open blocker?" }), { target: { value: "Known gap, fixed next week" } });
 await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
 fireEvent.click(approve);
 await waitFor(() => expect(f.calls("POST")).toHaveLength(1));
 expect(f.calls("POST")[0]!.body).toMatchObject({ reason: "Known gap, fixed next week", shownDigest: digestOf(withBlocker) });
 f.close();
});

it("someone who may not approve sees who can, and no Approve", async () => {
 const f = taskPage([high], { read: () => ({ status: 200, body: { card: {}, digest: digestOf(high), mayApprove: false, approverName: "Priya Shah" } }), approve: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "You can't decide this." } } }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 await within(card).findByText("Priya Shah can approve this design.");
 expect(within(card).queryByRole("button", { name: /^Approve/ })).toBeNull();
 expect(within(card).queryByRole("link", { name: "Open" })).toBeNull();
 expect(f.calls("POST")).toHaveLength(0);
 f.close();
 const nobody = taskPage([high], { read: () => ({ status: 200, body: { card: {}, digest: digestOf(high), mayApprove: false } }), approve: () => ({ status: 403, body: {} }) });
 await screen.findByText("Someone else has to approve this design.");
 expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
 nobody.close();
});

it("a medium design card on the task page is unchanged: Approve after the evidence, no read of the high-risk route", async () => {
 const f = taskPage([medium], { read: mayApprove(medium), approve: () => ({ status: 200, body: {} }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(card.getAttribute("data-risk")).toBe("medium");
 expect(within(card).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
 // One Approve only: the card's own, after the evidence (no inline high-risk one).
 expect(within(card).getAllByRole("button", { name: "Approve" })).toHaveLength(1);
 expect(within(card).queryByText(/High risk/)).toBeNull();
 expect(f.calls("GET")).toHaveLength(0);
 f.close();
});

it("Home's high-risk design card links to the card on the task page, and the task page marks that card", async () => {
 const home = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 200, body: viewOf([high]) } : { status: 200, body: { cards: [], total: 0 } });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: home.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 const link = await screen.findByRole("link", { name: "Open" });
 const href = link.getAttribute("href")!;
 expect(href).toBe(SESSION_PATH + "?decision=approve_design%3Adesign1");
 // Home does not approve: only the link.
 expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
 ui.unmount();query.clear();
 const scroll = vi.fn();
 HTMLElement.prototype.scrollIntoView = scroll;
 const page = taskPage([high], { read: mayApprove(high), approve: () => ({ status: 200, body: {} }) }, "?" + href.split("?")[1]);
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(card.getAttribute("data-focused")).toBe("true");
 expect(card.id).toBe("decision-approve_design-design1");
 await waitFor(() => expect(scroll).toHaveBeenCalled());
 page.close();
});

it("without the link's parameter no card is marked", async () => {
 const f = taskPage([high], { read: mayApprove(high), approve: () => ({ status: 200, body: {} }) });
 const card = await screen.findByRole("article", { name: "Retry failed payments" });
 expect(card.hasAttribute("data-focused")).toBe(false);
 f.close();
});

// Security review (no dead ends): a HIGH design cost card is decided on the task page, its choices behind "Show the evidence" (which records the evidence for the digest shown), each press under the decide-grade
// sign-in; on Home it is "Open" only.
const SPEND_PREFIX = "/v1/app/tasks/" + TASK + "/design-review/spend/";
const highSpend: DecisionItem = { ...base(TASK), kind: "approve_spend", amountUsd: 250, scopeLabel: "Design review", design: { why: "over_cap", capUsd: 25, estimateUsd: 250, choices: [
 { label: "Raise the limit to $250", href: SPEND_PREFIX + "raise-cap" }, { label: "Skip design review", href: SPEND_PREFIX + "skip" }] } };

it("security review: on the task page a HIGH design cost card shows its choices after the evidence is opened, and a choice goes through the decide sign-in made for it", async () => {
 expect(projectionOf([highSpend]).cards[0]!.risk, "positive control: the card is high").toBe("high");
 let signedIn = false;
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/decisions") return { status: 200, body: viewOf([highSpend]) };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (request.method === "POST" && request.path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: "approve_spend:" + TASK, opened: true, recorded: true } };
  if (request.method === "POST" && request.path === SPEND_PREFIX + "skip") return signedIn ? { status: 200, body: { outcome: "done", choice: "skip" } }
   : { status: 403, body: { error: { code: "REAUTH_REQUIRED", reason: "decide_sign_in", signInUrl: SIGN_IN, message: "Sign in again to decide this. A high-risk decision needs a sign-in with the email code within the last 10 minutes." } } };
  return { status: 200, body: { session: designTaskSession(designReviewFixture()) } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 const card = (await screen.findAllByRole("article", { name: "Retry failed payments" })).find(article => article.getAttribute("data-risk") === "high")!;
 const skip = await within(card).findByRole("button", { name: "Skip design review" });
 expect(within(card).getByRole("button", { name: "Raise the limit to $250" })).toBeTruthy();
 expect(within(card).queryByRole("link", { name: "Open" })).toBeNull();
 // The evidence first: the choices wait for it, and opening it records it for the digest shown.
 expect(skip.hasAttribute("disabled")).toBe(true);
 const summary = within(card).getByText("Show the evidence");
 (summary.closest("details") as HTMLDetailsElement).open = true;fireEvent(summary.closest("details")!, new Event("toggle"));
 await waitFor(() => expect(f.request.mock.calls.map(([request]) => request.path)).toContain("/v1/app/decisions/approve_spend/" + TASK + "/evidence-opened"));
 await waitFor(() => expect(skip.hasAttribute("disabled")).toBe(false));
 fireEvent.click(skip);
 expect((await within(card).findByRole("alert")).textContent).toContain("Sign in again to decide this");
 expect(within(card).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("https://cell.example" + SIGN_IN);
 // Back from the decide sign-in: the press applies.
 signedIn = true;
 fireEvent.click(within(card).getByRole("button", { name: "Skip design review" }));
 await within(card).findByText("Done. Rovara goes on from here.");
 ui.unmount();router.dispose();query.clear();
});

it("security review: on Home a HIGH design cost card is Open only, with no choice to press", async () => {
 const home = fakeHost(async request => request.path === "/v1/app/decisions" ? { status: 200, body: viewOf([highSpend]) } : { status: 200, body: { cards: [], total: 0 } });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: home.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 expect((await screen.findByRole("link", { name: "Open" })).getAttribute("href")).toBe(SESSION_PATH + "?decision=approve_spend%3A" + TASK);
 expect(screen.queryByRole("button", { name: "Skip design review" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Raise the limit to $250" })).toBeNull();
 ui.unmount();query.clear();
});
