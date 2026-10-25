// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { HomeResponseSchema } from "@agentx/contracts/web";
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
function setup(body: unknown = HomeResponseSchema.parse({ cards, total: cards.length }), theme: "light" | "dark" = "light", initialStatus = 200) {
 let value = body, status = initialStatus;
 const f = fakeHost(async request => request.path === "/v1/app/home" ? { status, body: value } : { status: 200, body: { notices: [], next: "settled" } });
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
it("does not claim an unseen total or fabricate card explanations", async () => { const f = setup();await screen.findByText("2 things need you");expect(screen.queryByText(/Showing/u)).toBeNull();expect(screen.queryByText(/urgent|overdue|minutes saved/iu)).toBeNull();f.close(); });
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
