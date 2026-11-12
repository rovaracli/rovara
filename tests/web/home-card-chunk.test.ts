// @vitest-environment jsdom
// A Home card's action loads code only when pressed (the session reader for Retry, the intake client for Start). After a release that code's file name is gone: the card must say "Rovara was updated. Reload to
// continue." with Reload, not "Couldn't complete this action. Try again." (trying again can never work). A plain action failure still says the generic words.
import { afterEach, expect, it, vi } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
// vitest wraps an error thrown by a mock factory in its own words, so each module is replaced by one whose export throws when read, which is where the action reads it (a chunk that failed to load).
vi.mock("../../packages/ui/src/api/session-response.js", () => ({ get SessionResponseReaderSchema(): never { throw new Error("Unable to preload CSS for /app/assets/session-response-x.css"); } }));
vi.mock("../../packages/ui/src/api/intake.js", () => ({ get createIntakeApi(): never { throw new TypeError("Failed to fetch dynamically imported module: /app/assets/intake-x.js"); } }));
import { HomeCardRow } from "../../packages/ui/src/screens/home/HomeCardRow.js";
import type { ReadHomeCard } from "../../packages/ui/src/api/home.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { homeSessionId } from "./support/home-fixture.js";
const at = "2026-11-06T11:00:00.000Z", origin = "https://cell.example", sid = homeSessionId(300);
afterEach(() => { vi.restoreAllMocks(); });

function mount(card: unknown, respond: Parameters<typeof fakeHost>[0] = async () => ({ status: 200, body: {} })) {
 const f = fakeHost(respond), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h("ul", null, h(HomeCardRow, { card: card as ReadHomeCard })) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
const retryCard = { cardId: "failure:" + sid, kind: "failure", title: "Verification failed", reason: "The checks did not pass.", sessionId: sid, at, buttons: [{ label: "Retry", action: "retry", method: "POST", href: origin + "/v1/app/sessions/" + sid + "/retry" }] };
const ticketCard = { cardId: "ticket:" + "a".repeat(32), kind: "waiting_ticket", title: "Fix the login redirect", reason: "A ticket is waiting.", at, buttons: [{ label: "Start", action: "start", method: "POST", href: origin + "/v1/app/projects/web/intake/" + "a".repeat(32) + "/start" }] };

for (const [label, card, button] of [["Retry (the session reader's chunk, a plain Error from Vite's CSS preload)", retryCard, "Retry: Verification failed"], ["Start (the intake client's chunk, a TypeError)", ticketCard, "Start: Fix the login redirect"]] as const) {
 it(`${label}: the card says the app was updated and offers Reload, never "Try again"`, async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const f = mount(card);
  try {
   fireEvent.click(screen.getByRole("button", { name: button }));
   const alert = await screen.findByRole("alert");
   expect(alert.textContent).toContain("Rovara was updated. Reload to continue.");
   expect(alert.textContent).not.toContain("Try again");
   const navigate = vi.spyOn(f.host, "navigate");
   fireEvent.click(within(alert).getByRole("button", { name: "Reload" }));
   expect(navigate).toHaveBeenCalled();
  } finally { f.close(); }
 });
}
it("a refused action keeps its own words and has no Reload", async () => {
 const f = mount({ ...retryCard, buttons: [{ label: "Not now", action: "dismiss", method: "POST", href: origin + "/v1/app/home/cards/" + encodeURIComponent(retryCard.cardId) + "/dismiss?occurrence=1" }] }, async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "You can't dismiss this." } } }));
 try {
  fireEvent.click(screen.getByRole("button", { name: "Not now: Verification failed" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("You can't dismiss this.");
  expect(within(alert).queryByRole("button", { name: "Reload" })).toBeNull();
 } finally { f.close(); }
});
