// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { agentProfile, AGENT_FIXTURE_ID } from "./support/agent-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { navFixture } from "./support/fixtures.js";
import { sessionFixture, messageFixture, taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
function setup(initialMessages: ReturnType<typeof messageFixture>[] = [], cursor?: string, initialSession = sessionFixture(), actionReply?: (request: ApiRequest) => Promise<ApiResponse>) {
 let session = initialSession, messages = initialMessages;
 const f = fakeHost(async request => {
 if (request.path.split("?", 1)[0]!.endsWith("/messages")) { if (request.method === "POST") { messages = [messageFixture()];return { status: 200, body: messages[0] }; }return { status: 200, body: { messages: request.path.includes("?after=") ? [] : messages, ...(cursor === undefined ? {} : { next: cursor }) } }; }
 if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
 if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
 if (request.path.endsWith("/follow")) { session = sessionFixture({ you: { ...session.you, following: true } });return { status: 200, body: { following: true } }; }
 if (request.method === "POST" && /\/(stop|retry|close|take-over|agent)$/.test(request.path) && actionReply) return actionReply(request);
 return { status: 200, body: { session } };
 });
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/app/sessions/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, router, setSession(next: ReturnType<typeof sessionFixture>) { session = next; }, close() { ui.unmount();router.dispose();query.clear(); } };
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
 await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] });await screen.findByText("That part of this session is no longer available.");
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
 const stop = await screen.findByRole("button", { name: "Stop" });
 expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
 expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
 fireEvent.click(stop);expect(await screen.findByRole("dialog", { name: "Stop this session?" })).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
 expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/stop"))).toBe(false);f.close();
});
it("offers retry and takeover independently from the session capability list", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["retry", "take_over"] } }));
 expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
 expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();f.close();
});

it("keeps a header takeover pending until ownership arrives in a real session read", async () => {
 const base = sessionFixture(), initial = sessionFixture({ you: { ...base.you, owner: false, actions: ["take_over"] } });
 const f = setup([], undefined, initial, async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["You will own this session."] } }));
 fireEvent.click(await screen.findByRole("button", { name: "Take over" }));await screen.findByText("Waiting for you to confirm in your browser");
 fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));expect(f.host.openExternal).toHaveBeenCalledTimes(1);
 const owned = sessionFixture({ revision: 2, you: { ...base.you, owner: true, actions: ["watch"] } });
 await act(() => f.query.setQueryData(["session", SESSION_FIXTURE_ID], owned));expect(screen.queryByText("You now own this session.")).toBeNull();
 f.setSession(owned);await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] });await screen.findByText("You now own this session.");f.close();
});
it("retries the header session once and navigates to the returned session", async () => {
 const base = sessionFixture(), returned = "ses_bbbbbbbbbbbbbbbbbbbb", f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["retry"] } }), async () => ({ status: 200, body: { session: sessionFixture({ sessionId: returned }) } }));
 const navigate = vi.spyOn(f.host, "navigate");
 const retry = await screen.findByRole("button", { name: "Retry" });act(() => { retry.click();retry.click(); });
 await waitFor(() => expect(navigate).toHaveBeenCalledWith("/s/" + returned));
 expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/retry"))).toHaveLength(1);f.close();
});
it("posts stop only after explicit confirmation and refreshes the session", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["stop"] } }), async () => ({ status: 200, body: { session: sessionFixture() } }));
 fireEvent.click(await screen.findByRole("button", { name: "Stop" }));expect(screen.getByText("Payments expert stops after its current step.")).toBeTruthy();
 expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/stop"))).toBe(false);
 fireEvent.click(screen.getByRole("button", { name: "Stop session" }));fireEvent.click(screen.getByRole("button", { name: "Stop session" }));await screen.findByText("Stop requested.");
 expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/stop"))).toHaveLength(1);f.close();
});

it("never says a stop was requested when the broker answered that nothing was running", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["stop"] } }), async () => ({ status: 200, body: { session: sessionFixture(), stop: "NOTHING_RUNNING" } }));
 fireEvent.click(await screen.findByRole("button", { name: "Stop" }));fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
 await screen.findByText("Nothing was running to stop.");expect(screen.queryByText("Stop requested.")).toBeNull();
 expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/stop"))).toHaveLength(1);f.close();
});

it("closes the task only after a confirmation, asks again before discarding unpublished work, and says it is closed", async () => {
 const base = sessionFixture(), answers = [
  { status: 200, body: { session: sessionFixture(), closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }], message: "not closed" } },
  { status: 200, body: { session: sessionFixture(), closed: true, discardedUnpublished: true } },
 ];
 const f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["close"] } }), async () => answers.shift()!);
 fireEvent.click(await screen.findByRole("button", { name: "Close task" }));
 expect(await screen.findByRole("dialog", { name: "Close this task?" })).toBeTruthy();
 expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/close"))).toBe(false);
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close task" }));
 // Unpublished work: the list is shown and nothing was discarded.
 expect(await screen.findByRole("dialog", { name: "Discard unpublished work?" })).toBeTruthy();
 expect(screen.getByText("demo: worktree_changes")).toBeTruthy();
 const closes = () => f.request.mock.calls.map(([request]) => request).filter(request => request.path.endsWith("/close"));
 expect(closes()).toHaveLength(1);expect(closes()[0]!.body).not.toHaveProperty("discardUnpublished");
 fireEvent.click(screen.getByRole("button", { name: "Discard it and close" }));
 await screen.findByText("Task closed.");
 expect(closes()).toHaveLength(2);expect(closes()[1]!.body).toMatchObject({ discardUnpublished: true });
 expect((closes()[1]!.body as { requestId: string }).requestId).not.toBe((closes()[0]!.body as { requestId: string }).requestId);f.close();
});
it("does not carry a pending takeover into a different already-cached session", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, owner: false, actions: ["take_over"] } }), async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["You will own this session."] } }));
 fireEvent.click(await screen.findByRole("button", { name: "Take over" }));await screen.findByText("Waiting for you to confirm in your browser");
 const next = sessionFixture({ sessionId: "ses_bbbbbbbbbbbbbbbbbbbb", title: "Another task", you: { ...base.you, actions: ["watch"] } });f.setSession(next);f.query.setQueryData(["session", next.sessionId], next);
 await act(() => f.router.navigate("/app/sessions/" + next.sessionId));await screen.findByRole("heading", { name: "Another task" });
 expect(screen.queryByText("Waiting for you to confirm in your browser")).toBeNull();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Follow" }).disabled).toBe(false);f.close();
});

it("turns a permitted finished task into the backend's actual agent draft once", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ status: "succeeded", you: { ...base.you, actions: ["make_agent"] } }), async () => ({ status: 201, body: { agent: agentProfile().agent, copied: true } }));
 const navigate = vi.spyOn(f.host, "navigate");fireEvent.click(await screen.findByRole("button", { name: "Make this an agent" }));
 fireEvent.change(screen.getByRole("textbox", { name: "Workflow name (optional)" }), { target: { value: "Refund investigator" } });const create = screen.getByRole("button", { name: "Create draft" });act(() => { create.click();create.click(); });
 await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/agents/" + AGENT_FIXTURE_ID + "/edit"));
 const calls = f.request.mock.calls.filter(([request]) => request.path.endsWith("/agent"));expect(calls).toHaveLength(1);expect(calls[0]?.[0].body).toMatchObject({ name: "Refund investigator" });f.close();
});
it("explains a draft made from scratch without guessing that the source method was copied", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ status: "succeeded", you: { ...base.you, actions: ["make_agent"] } }), async () => ({ status: 201, body: { agent: agentProfile().agent, copied: false, reason: "AGENT_NOT_USABLE" } }));
 const navigate = vi.spyOn(f.host, "navigate");fireEvent.click(await screen.findByRole("button", { name: "Make this an agent" }));fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
 await screen.findByText("The source workflow couldn't be copied. Your new draft starts from scratch.");expect(screen.getByRole("link", { name: "Inspect draft" }).getAttribute("href")).toBe("/app/agents/" + AGENT_FIXTURE_ID + "/edit");expect(screen.getByRole<HTMLButtonElement>("button", { name: "Create draft" }).disabled).toBe(true);expect(navigate).not.toHaveBeenCalled();f.close();
});
it("does not offer task-to-method creation without its server capability", async () => { const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(screen.queryByRole("button", { name: "Make this an agent" })).toBeNull();f.close(); });
