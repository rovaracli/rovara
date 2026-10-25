// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { HomeResponseSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { sessionFixture } from "./support/session-fixture.js";
import { HomeScreen } from "../../packages/ui/src/screens/home/HomeScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
const sessionId = "ses_" + "a".repeat(20);
const cards = [
 { cardId: "plan:first", kind: "plan", reason: "The plan waits for your review.", title: "Review the duplicate-refund fix", sessionId, at: "2026-10-23T12:00:00.000Z", buttons: [{ label: "Dismiss", action: "dismiss" }, { label: "Start", action: "start" }] },
 { cardId: "failure:second", kind: "failure", reason: "Verification failed.", buttons: [], title: "<img src=x onerror=alert(1)>", at: "2026-10-23T13:00:00.000Z" },
];
function setup(body: unknown = HomeResponseSchema.parse({ cards, total: cards.length }), theme: "light" | "dark" = "light", initialStatus = 200, send?: (request: ApiRequest) => Promise<ApiResponse>) {
 let value = body, status = initialStatus;
 const f = fakeHost(async request => request.path === "/v1/app/home" ? { status, body: value } : send && request.method !== "GET" ? send(request) : { status: 200, body: { notices: [], next: "settled" } });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(HomeScreen, {}) }) }) }) }), { theme });
 return { ...f, ...ui, query, answer(next: unknown, code = 200) { value = next;status = code; }, close() { ui.unmount();query.clear(); } };
}
it("keeps server ranking, renders safe titles and uses the actual session identity", async () => {
 const f = setup();await screen.findByText("2 things need you");
 expect(screen.getAllByRole("heading", { level: 2 }).map(el => el.textContent)).toEqual(["Review the duplicate-refund fix", "<img src=x onerror=alert(1)>"]);
 expect(f.container.querySelector("img")).toBeNull();expect(screen.getByRole("link", { name: "Open session: Review the duplicate-refund fix" }).getAttribute("href")).toBe("/s/" + sessionId);expect(f.container.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-23T12:00:00.000Z");f.close();
});
it("hides unsupported writes rather than guessing destinations or permissions", async () => {
 const f = setup();await screen.findByText("2 things need you");expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();expect(screen.queryByRole("button", { name: "Start" })).toBeNull();expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);f.close();
});
it("does not manufacture urgency or an unnecessary truncated-list label", async () => { const f = setup();await screen.findByText("2 things need you");expect(screen.queryByText(/Showing/u)).toBeNull();expect(screen.queryByText(/urgent|overdue|minutes saved/iu)).toBeNull();f.close(); });
it("shows an accurate empty state only after a successful empty read", async () => { const f = setup({ cards: [], total: 0 });expect(await screen.findByRole("heading", { name: "Nothing needs you right now" })).toBeTruthy();expect(screen.getByRole("link", { name: "See work in progress" }).getAttribute("href")).toBe("/app/live");f.close(); });
it("preserves a refusal message and allows a real retry instead of showing empty success", async () => {
 const f = setup({ error: { code: "FORBIDDEN", message: "Ask your project owner to restore access." } }, "light", 403);await screen.findByText("Ask your project owner to restore access.");expect(screen.queryByText("Nothing needs you right now")).toBeNull();f.answer({ cards: [], total: 0 });fireEvent.click(screen.getByRole("button", { name: "Try again" }));await screen.findByText("Nothing needs you right now");f.close();
});
it("announces server removal and retains the other ranked row", async () => { const f = setup();await screen.findByText("2 things need you");f.answer({ cards: [cards[1]], total: 1 });await f.query.invalidateQueries({ queryKey: ["home"] });await waitFor(() => expect(screen.queryByText("Review the duplicate-refund fix")).toBeNull());await waitFor(() => expect(f.container.querySelector('[aria-live="polite"]')?.textContent).toContain("Review the duplicate-refund fix no longer needs you"), { timeout: 2500 });expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();f.close(); });
for (const theme of ["light", "dark"] as const) it("has an accessible attention list in " + theme, async () => { const f = setup(undefined, theme);await screen.findByText("2 things need you");await expectNoAxeViolations(f.container);f.close(); });

it("stops showing cached attention or empty-success claims after a refused refetch", async () => {
 for (const initial of [{ cards, total: cards.length }, { cards: [], total: 0 }]) {
 const f = setup(initial);await screen.findByText(initial.cards.length ? "2 things need you" : "Nothing needs you right now");
 f.answer({ error: { code: "FORBIDDEN", message: "Your access ended." } }, 403);await f.query.invalidateQueries({ queryKey: ["home"] });await screen.findByText("Your access ended.");
 expect(screen.queryByText("Review the duplicate-refund fix")).toBeNull();expect(screen.queryByText("Nothing needs you right now")).toBeNull();f.close();
 }
});

it("shows the authoritative total, server order and reasons as text", async () => {
 const ranked = Array.from({ length: 10 }, (_, i) => ({ ...cards[0], cardId: "plan:p" + i, title: "Review " + i, reason: i === 0 ? "<img src=x onerror=alert(1)>" : "Your review is needed.", buttons: [] }));
 const f = setup({ cards: ranked, total: 14 });await screen.findByText("14 things need you");expect(screen.getByText("Showing 10 of 14")).toBeTruthy();
 expect(screen.getAllByRole("heading", { level: 2 }).map(el => el.textContent)).toEqual(ranked.map(card => card.title));expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();expect(f.container.querySelector("img")).toBeNull();f.close();
});
it("opens the authoritative bare approval link externally without an inline decision", async () => {
 const href = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 const f = setup({ cards: [{ ...cards[0], kind: "approval", cardId: "approval:one", buttons: [{ action: "confirm", label: "Review approval", method: "GET", href }, { action: "dismiss", label: "Dismiss", method: "POST", href: "https://cell.example/v1/app/home/cards/approval%3Aone/dismiss" }] }], total: 1 });
 fireEvent.click(await screen.findByRole("button", { name: "Review approval" }));expect(f.host.openExternal).toHaveBeenCalledWith(href);expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);f.close();
});
it("preserves a question's exact app anchor and only Open for unknown kinds", async () => {
 const href = "https://cell.example/s/" + sessionId + "#questions";
 const f = setup({ cards: [{ ...cards[0], kind: "question", cardId: "question:one", buttons: [{ action: "open", label: "Answer", method: "GET", href }] }, { ...cards[1], kind: "future_kind", cardId: "future:one", buttons: [{ action: "open", label: "Open", method: "GET", href }, { action: "retry", label: "Retry future", method: "POST", href: "https://cell.example/v1/app/sessions/" + sessionId + "/retry" }] }], total: 2 });
 expect((await screen.findByRole("link", { name: "Answer" })).getAttribute("href")).toBe("/s/" + sessionId + "#questions");expect(screen.getByRole("link", { name: "Open" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Retry future" })).toBeNull();f.close();
});
it("dismisses a failure once with the exact occurrence and announces only server removal", async () => {
 const cardId = "failure:one", path = "/v1/app/home/cards/failure%3Aone/dismiss?occurrence=run%3A2";
 let finish: (() => void) | undefined;
 const sent = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve; });return { status: 200, body: { cardId, dismissed: true } }; });
 const f = setup({ cards: [{ ...cards[1], cardId, buttons: [{ action: "dismiss", label: "Dismiss", method: "POST", href: "https://cell.example" + path }] }], total: 1 }, "light", 200, sent);
 const button = await screen.findByRole("button", { name: "Dismiss" });fireEvent.click(button);fireEvent.click(button);await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));expect(screen.getByText(cards[1]!.title)).toBeTruthy();
 f.answer({ cards: [], total: 0 });finish?.();await screen.findByText("Nothing needs you right now");expect(f.request.mock.calls.find(([request]) => request.method === "POST")?.[0].path).toBe(path);
 await waitFor(() => expect(f.container.querySelector('[aria-live="polite"]')?.textContent).toContain("no longer needs you"), { timeout: 2500 });f.close();
});
it("retries the session once with a request id and uses the actual returned session", async () => {
 const returned = "ses_" + "b".repeat(20), sent = vi.fn(async () => ({ status: 200, body: { session: sessionFixture({ sessionId: returned }) } }));
 const f = setup({ cards: [{ ...cards[1], sessionId, buttons: [{ action: "retry", label: "Retry", method: "POST", href: "https://cell.example/v1/app/sessions/" + sessionId + "/retry" }] }], total: 1 }, "light", 200, sent);
 const button = await screen.findByRole("button", { name: "Retry" });fireEvent.click(button);fireEvent.click(button);await waitFor(() => expect(f.host.navigate).toHaveBeenCalledWith("/s/" + returned));expect(sent).toHaveBeenCalledTimes(1);expect(f.request.mock.calls.find(([request]) => request.method === "POST")?.[0].body).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });f.close();
});
it("hides cross-origin writes, mismatched targets and unsupported start destinations", async () => {
 const f = setup({ cards: [{ ...cards[1], sessionId, buttons: [
 { action: "dismiss", label: "Foreign dismiss", method: "POST", href: "https://other.example/v1/app/home/cards/failure%3Asecond/dismiss" },
 { action: "dismiss", label: "Wrong card", method: "POST", href: "https://cell.example/v1/app/home/cards/failure%3Aanother/dismiss" },
 { action: "retry", label: "Wrong session", method: "POST", href: "https://cell.example/v1/app/sessions/ses_cccccccccccccccccccc/retry" },
 { action: "start", label: "Sign out start", method: "POST", href: "https://cell.example/v1/auth/browser/sign-out" },
 ] }], total: 1 });await screen.findByText("1 thing needs you");for (const name of ["Foreign dismiss", "Wrong card", "Wrong session", "Sign out start"]) expect(screen.queryByRole("button", { name })).toBeNull();expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);f.close();
});
