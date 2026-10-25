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
import { workspaceFixture } from "./support/workspace-fixture.js";
import { navFixture } from "./support/fixtures.js";
import { sessionFixture, messageFixture, taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
function setup(initialMessages: ReturnType<typeof messageFixture>[] = [], cursor?: string, initialSession = sessionFixture()) {
 let session = initialSession, messages = initialMessages;
 const f = fakeHost(async request => {
 if (request.path.split("?", 1)[0]!.endsWith("/messages")) { if (request.method === "POST") { messages = [messageFixture()];return { status: 200, body: messages[0] }; }return { status: 200, body: { messages: request.path.includes("?after=") ? [] : messages, ...(cursor === undefined ? {} : { next: cursor }) } }; }
 if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
 if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
 if (request.path.endsWith("/follow")) { session = sessionFixture({ you: { ...session.you, following: true } });return { status: 200, body: { following: true } }; }
 return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, setSession(next: ReturnType<typeof sessionFixture>) { session = next; }, close() { ui.unmount();router.dispose();query.clear(); } };
}
it("opens conversation on demand, keeps the task in place and restores the opener focus", async () => {
 const f = setup(), heading = await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(document.activeElement).toBe(heading);expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();const opener = screen.getByRole<HTMLButtonElement>("button", { name: "Conversation" });opener.focus();fireEvent.click(opener);expect(await screen.findByRole("dialog", { name: "Conversation" })).toBeTruthy();expect(heading.isConnected).toBe(true);fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Close dialog" }));await waitFor(() => expect(document.activeElement).toBe(opener));f.close();
});
it("follows through the real API wrapper and refreshes the server view", async () => { const f = setup();fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Follow" }));expect(await screen.findByRole<HTMLButtonElement>("button", { name: "Following" })).toBeTruthy();expect(f.request.mock.calls.some(([request]) => request.method === "POST" && request.path.endsWith("/follow"))).toBe(true);f.close(); });
it("does not fetch the conversation before the reader opens it", async () => { const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/messages"))).toBe(false);fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Conversation" }));await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/messages"))).toBe(true));f.close(); });

it("preserves an unsent comment when the conversation tray closes", async () => {
 const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Conversation" }));
 fireEvent.change(await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }), { target: { value: "Keep this question while I inspect the work" } });
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Close dialog" }));
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Conversation" }));
 expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" })).value).toBe("Keep this question while I inspect the work");f.close();
});

it("retains an unsaved comment edit when inspecting the task outside the tray", async () => {
 const f = setup([messageFixture()]);f.query.setQueryData(["nav"], navFixture());
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Conversation" }));
 fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Edit comment" }));fireEvent.change(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" }), { target: { value: "Keep my revised explanation" } });
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Close dialog" }));fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Conversation" }));
 fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Edit comment" }));
 expect((screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" })).value).toBe("Keep my revised explanation");f.close();
});

it("stops offering more conversation when the endpoint returns its unchanged cursor", async () => {
 const f = setup([messageFixture()], "2026-10-23T12:00:00.000Z#msg_aaaaaaaaaaaaaaaaaaaa");
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Conversation" }));
 fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Load more conversation" }));
 await waitFor(() => expect(screen.queryByRole("button", { name: "Load more conversation" })).toBeNull());
 expect(screen.getAllByText("Check refunds before retrying.")).toHaveLength(1);f.close();
});

it("opens a real changed-file discussion without replacing the work and restores source focus", async () => {
 const anchor = { target: "change_file" as const, targetId: "acme/payments:src/refund.ts", revision: "+12-3" };
 const f = setup([], undefined, workspaceFixture({ anchors: [anchor] }));f.query.setQueryData(["nav"], navFixture());
 const heading = await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 fireEvent.mouseDown(await screen.findByRole("tab", { name: "Changes" }), { button: 0, ctrlKey: false });
 const source = screen.getByRole<HTMLButtonElement>("button", { name: "Comment on src/refund.ts" });source.focus();fireEvent.click(source);
 await screen.findByRole("dialog", { name: "Discussion of this file" });expect(heading.isConnected).toBe(true);expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" }));
 expect(screen.queryByRole("button", { name: "Message the agent" })).toBeNull();
 fireEvent.change(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }), { target: { value: "Check the refund key here" } });fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
 await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.method === "POST" && request.path.endsWith("/messages"))).toBe(true));
 expect(f.request.mock.calls.find(([request]) => request.method === "POST" && request.path.endsWith("/messages"))?.[0].body).toMatchObject({ kind: "comment", anchor });
 fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(document.activeElement).toBe(source));f.close();
});

it("hides an anchored discussion and cached target when its part disappears", async () => {
 const anchor = { target: "change_file" as const, targetId: "acme/payments:src/refund.ts", revision: "+12-3" };
 const f = setup([messageFixture({ anchor, anchorState: "current", text: "A permitted comment" })], undefined, workspaceFixture({ anchors: [anchor] }));
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });fireEvent.mouseDown(screen.getByRole("tab", { name: "Changes" }), { button: 0, ctrlKey: false });fireEvent.click(screen.getByRole("button", { name: "Comment on src/refund.ts" }));await screen.findByText("A permitted comment");
 f.setSession(workspaceFixture({ anchors: [], revision: 2, updatedAt: "2026-10-23T13:00:00.000Z", body: { kind: "task", task: taskFixture({ changedFiles: [] }) } }));
 await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID], exact: true });await screen.findByText("That part of this session is no longer available.");
 expect(screen.queryByText("A permitted comment")).toBeNull();expect(screen.queryByText("src/refund.ts")).toBeNull();expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();f.close();
});

it("replaces inaccessible cached session details with the common NotFound screen", async () => {
 const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 f.request.mockResolvedValue({ status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } });
 await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] });
 expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();expect(screen.queryByRole("heading", { name: "Fix duplicate refunds" })).toBeNull();expect(screen.queryByRole("button", { name: "Conversation" })).toBeNull();f.close();
});

it("offers stop from the session header only when the server permits it", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["stop"] } }));
 fireEvent.click(await screen.findByRole("button", { name: "Stop", exact: true }));
 expect(await screen.findByRole("dialog", { name: "Stop this session?" })).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Share", exact: true })).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
 expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/stop"))).toBe(false);f.close();
});
it("offers retry and takeover independently from the session capability list", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["retry", "take_over"] } }));
 expect(await screen.findByRole("button", { name: "Retry", exact: true })).toBeTruthy();
 expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Stop", exact: true })).toBeNull();f.close();
});
