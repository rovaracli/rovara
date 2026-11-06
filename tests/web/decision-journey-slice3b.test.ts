// @vitest-environment jsdom
// Decision journey slice 3b: an outside approver decides on the card. Home shows the card (Open to its own page) and no older approval card for it; the card-only page shows that one card and nothing
// else, with Approve and Decline inline and Sign in again when the server asks for a recent sign-in.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewSchema } from "@agentx/contracts/web";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { DecisionScreen } from "../../packages/ui/src/screens/decisions/DecisionScreen.js";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { projectDecisionCards, type DecisionItem } from "../../packages/broker/src/decisions/project.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";

const ID = "spr_aaaaaaaaaaaaaaaaaaaa";
const CARD = "approve_request:" + ID;
const item: DecisionItem = { kind: "approve_request", subjectId: ID, prefix: "spr", project: "payments", title: "Raise the run limit to $20", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1",
 openPath: "/app/decisions/approve_request/" + ID, details: [{ title: "What is being decided", lines: ["Amount: $18", "New limit: $20"] }] };
const other: DecisionItem = { kind: "approve_plan", subjectId: "11111111-1111-4111-8111-111111111111", taskId: "11111111-1111-4111-8111-111111111111", project: "payments", title: "Someone else's plan", createdAt: "2026-11-06T10:00:00.000Z", contentVersion: "v1", openPath: "/app/sessions/ses_" + "b".repeat(20), path: "quick", files: ["src/a.ts"], claims: 1, untestedClaims: 0 };
const viewOf = (items: DecisionItem[]) => { const p = projectDecisionCards(items); return DecisionCardsViewSchema.parse({ cards: p.cards, total: p.cards.length, tabs: p.tabs, details: p.details, digests: p.digests, dropped: p.dropped }); };
const decided = (outcome: "approved" | "rejected") => ({ status: 200, body: { cardId: CARD, outcome, remainingTabs: [] } });

function page(answer: (request: ApiRequest) => { status: number; body: unknown } | undefined = () => undefined) {
 const f = fakeHost(async request => answer(request) ?? (request.path.split("?")[0] === "/v1/app/decisions" ? { status: 200, body: viewOf([item, other]) }
  : request.method === "POST" && request.path.endsWith("/evidence-opened") ? { status: 200, body: { cardId: CARD, opened: true, recorded: true } } : { status: 200, body: {} }));
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/decisions/:kind/:subject", element: h(DecisionScreen, {}) }], { initialEntries: ["/app/decisions/approve_request/" + ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 const posts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "POST");
 return { ...f, posts, close() { ui.unmount();router.dispose();query.clear(); } };
}

it("the card-only page names the approval in its read and shows that one card and its evidence, nothing else (no task title, plan or diff), with Approve and Decline", async () => {
 const f = page();
 const card = await screen.findByRole("article", { name: "Raise the run limit to $20" });
 expect(f.request.mock.calls.map(([request]) => request.path)).toContain("/v1/app/decisions?approval=" + ID);
 expect(screen.getAllByRole("article")).toHaveLength(1);
 expect(screen.queryByText("Someone else's plan")).toBeNull();
 for (const absent of [/Retry failed payments/u, /src\/a\.ts/u, /Plan/u, /Changes/u, /pull request/iu]) expect(document.body.textContent ?? "").not.toMatch(absent);
 expect(await within(card).findByRole("button", { name: "Approve" })).toBeTruthy();
 expect(within(card).getByRole("button", { name: "Decline" })).toBeTruthy();
 f.close();
});

it("Approve waits for the evidence; without the decide-grade sign-in the card says so and Sign in again starts that sign-in for this approval; Decline posts the card's own reject", async () => {
 let fresh = false;
 const f = page(request => request.method === "POST" && request.path.endsWith("/approve") ? (fresh ? decided("approved") : { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "Sign in again to decide this. Decisions like this need a sign-in within the last 10 minutes." } } })
  : request.method === "POST" && request.path.endsWith("/reject") ? decided("rejected") : undefined);
 const card = await screen.findByRole("article", { name: "Raise the run limit to $20" });
 const approve = await within(card).findByRole("button", { name: "Approve" });
 // The evidence first (what the kind records as its page having been read).
 expect(approve.hasAttribute("disabled")).toBe(true);
 const summary = within(card).getByText("Show the evidence");
 (summary.closest("details") as HTMLDetailsElement).open = true;fireEvent(summary.closest("details")!, new Event("toggle"));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/decisions/approve_request/" + ID + "/evidence-opened"));
 await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(false));
 fireEvent.click(approve);
 expect((await within(card).findByRole("alert")).textContent).toContain("Sign in again to decide this");
 // Sign in again is the decide-grade sign-in for this approval (an email code from a clean sign-in), which comes back to this card.
 expect(within(card).getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/v1/auth/decide/identify?return=" + encodeURIComponent("/v1/app/approve/" + ID));
 expect(f.host.signIn).not.toHaveBeenCalled();
 fresh = true;
 fireEvent.click(within(card).getByRole("button", { name: "Decline" }));
 await waitFor(() => expect(f.posts().map(request => request.path)).toContain("/v1/app/decisions/approve_request/" + ID + "/reject"));
 expect(f.posts().find(request => request.path.endsWith("/reject"))!.body).toMatchObject({ reason: "other" });
 f.close();
});

it("a decision that is not waiting for this person says so (the page shows nothing of it)", async () => {
 const f = page(request => request.path.split("?")[0] === "/v1/app/decisions" ? { status: 200, body: viewOf([other]) } : undefined);
 expect(await screen.findByText("This decision is no longer waiting for you.")).toBeTruthy();
 expect(screen.queryByRole("article")).toBeNull();
 f.close();
});

it("Home shows the card with Open to its own page, and no older approval card for the same request", async () => {
 const older = { cardId: "spend_request:" + ID, kind: "spend_request", title: "Budget request", reason: "A run needs $18 more", at: "2026-11-06T10:00:00.000Z", buttons: [{ label: "Decide", action: "confirm", method: "GET", href: "https://cell.example/v1/app/approve/" + ID }] };
 const f = fakeHost(async request => request.path === "/v1/app/home" ? { status: 200, body: { cards: [older], total: 1 } } : request.path === "/v1/app/decisions" ? { status: 200, body: viewOf([item]) } : { status: 200, body: { notices: [], next: "settled" } });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }));
 const card = await screen.findByRole("article", { name: "Raise the run limit to $20" });
 expect(within(card).getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/app/decisions/approve_request/" + ID);
 expect(within(card).queryByRole("button", { name: "Approve" })).toBeNull();
 await waitFor(() => expect(screen.queryByText("A run needs $18 more")).toBeNull());
 ui.unmount();query.clear();
});
