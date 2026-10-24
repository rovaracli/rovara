// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { sessionFixture, messageFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
function setup() {
 let session = sessionFixture(), messages: ReturnType<typeof messageFixture>[] = [];
 const f = fakeHost(async request => {
 if (request.path.endsWith("/messages")) { if (request.method === "POST") { messages = [messageFixture()];return { status: 200, body: messages[0] }; }return { status: 200, body: { messages } }; }
 if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
 if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
 if (request.path.endsWith("/follow")) { session = sessionFixture({ you: { ...session.you, following: true } });return { status: 200, body: { following: true } }; }
 return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, close() { ui.unmount();router.dispose();query.clear(); } };
}
it("opens conversation on demand, keeps the task in place and restores the opener focus", async () => {
 const f = setup(), heading = await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(document.activeElement).toBe(heading);expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();const opener = screen.getByRole("button", { name: "Conversation" });opener.focus();fireEvent.click(opener);expect(await screen.findByRole("dialog", { name: "Conversation" })).toBeTruthy();expect(heading.isConnected).toBe(true);fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(document.activeElement).toBe(opener));f.close();
});
it("follows through the real API wrapper and refreshes the server view", async () => { const f = setup();fireEvent.click(await screen.findByRole("button", { name: "Follow" }));expect(await screen.findByRole("button", { name: "Following" })).toBeTruthy();expect(f.request.mock.calls.some(([request]) => request.method === "POST" && request.path.endsWith("/follow"))).toBe(true);f.close(); });
it("does not fetch the conversation before the reader opens it", async () => { const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/messages"))).toBe(false);fireEvent.click(screen.getByRole("button", { name: "Conversation" }));await screen.findByRole("textbox", { name: "Comment" });await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/messages"))).toBe(true));f.close(); });

it("preserves an unsent comment when the conversation tray closes", async () => {
 const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
 fireEvent.change(await screen.findByRole("textbox", { name: "Comment" }), { target: { value: "Keep this question while I inspect the work" } });
 fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
 fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
 expect((await screen.findByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("Keep this question while I inspect the work");f.close();
});
