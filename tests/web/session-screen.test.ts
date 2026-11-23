// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createCandidateManifest } from "@agentx/contracts";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { createTaskSessionApi } from "../../packages/ui/src/api/sessions.js";
import { AppHostProvider, useAppHost } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { agentProfile, AGENT_FIXTURE_ID } from "./support/agent-fixture.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { sessionFixture, messageFixture, taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { CARDS, decisionsView } from "./support/work-fixture.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
const requestId: unknown = expect.any(String);
const mergeReadySession = () => {
 const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "c".repeat(40), treeSha: "d".repeat(40), baseCommitSha: "e".repeat(40) }]);
 const workflow = { ...workspaceWorkflow(), stage: "WAIT_FOR_MERGE", state: "WAITING", candidate, verification: { candidateDigest: candidate.digest, producer: "check-runner", environmentId: "fixture-worker", recordedAt: "2026-10-23T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] }, reviews: (["CRITIC", "SECURITY"] as const).map((role, index) => ({ operationId: `7777777${String(index)}-7777-4777-8777-777777777777`, candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-10-23T12:00:00.000Z" })), pullRequests: [{ repositoryId: "payments", number: 42, url: "https://github.com/acme/payments/pull/42", headSha: "c".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }], pullRequestUpdatedAt: "2026-10-23T12:00:00.000Z" };
 return workspaceFixture({}, { status: "SUCCEEDED", workflow, pullRequests: [{ repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" }] });
};
// Exercise retained off-page header controls separately from the rebuilt task page.
function OffPageHeader() {
 const { id = "" } = useParams(), host = useAppHost();
 const read = useQuery({ queryKey: ["session", id], queryFn: () => createTaskSessionApi(host).read(id), enabled: true });
 const session = read.data ?? sessionFixture({ sessionId: id });
 return h("div", {}, h("h2", {}, session.title), session.body.kind === "task" && session.body.task.closing === true ? h("span", {}, "Closing…") : null, h(SessionControls, { key: id, id, agent: "Agent", actions: session.you.actions, following: session.you.following, onChanged: async () => undefined }));
}
function setup(initialMessages: ReturnType<typeof messageFixture>[] = [], cursor?: string, initialSession = sessionFixture(), actionReply?: (request: ApiRequest) => Promise<ApiResponse>, options: { entry?: string; cachedTasks?: ReturnType<typeof taskFixture>[]; pendingDecision?: boolean; offPageHeader?: boolean } = {}) {
 let session = initialSession, messages = initialMessages;
 const f = fakeHost(async request => {
 if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
 if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
 if (request.path.split("?", 1)[0] === "/v1/app/sessions" && options.entry !== undefined) return { status: 403, body: { error: { code: "FORBIDDEN", message: "task access refused" } } };
 if (request.path.split("?", 1)[0]!.endsWith("/messages")) { if (request.method === "POST") { messages = [messageFixture()];return { status: 200, body: messages[0] }; }return { status: 200, body: { messages: request.path.includes("?after=") ? [] : messages, ...(cursor === undefined ? {} : { next: cursor }) } }; }
 if (request.path.endsWith("/people")) return { status: 200, body: { people: { revision: 3, orphaned: true, canManage: false, canTakeOwnership: true, people: [{ personId: "22222222-2222-4222-8222-222222222222", name: "Ada", role: "owner", you: false, effectiveRole: "owner" }] } } };
 if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
 if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: session.viewingNow } };
 if (request.path.endsWith("/follow")) { session = sessionFixture({ you: { ...session.you, following: true } });return { status: 200, body: { following: true } }; }
 if (request.method === "POST" && /\/(stop|retry|close|take-over|agent)$/.test(request.path) && actionReply) return actionReply(request);
 return { status: 200, body: { session } };
 });
 const query = createQueryClient();
 if (options.pendingDecision) query.setQueryData(["decisions"], readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView([{ ...CARDS.find(card => card.kind === "merge")!, id: "merge:11111111-1111-4111-8111-111111111111", taskId: "11111111-1111-4111-8111-111111111111" }]))));
 if (options.cachedTasks !== undefined) query.setQueryData(["work", "tasks", meFixture().org.orgId, meFixture().developer.id], options.cachedTasks.map(task => ({ taskId: task.taskId, sessionId: task.sessionId, title: task.title, project: task.project, status: task.status, workflow: task.workflow, pullRequests: [], spentUsd: undefined, runLimitUsd: undefined, createdAt: task.createdAt, updatedAt: task.updatedAt, hasThread: false })), { updatedAt: 0 });
 if (options.offPageHeader) query.setQueryData(["session", initialSession.sessionId], initialSession);
 const router = createMemoryRouter([{ path: "/app/sessions/:id", element: options.offPageHeader ? h(OffPageHeader, {}) : h(SessionScreen, {}) }, { path: "/app/tasks/:id", element: h(SessionScreen, {}) }], { initialEntries: [options.entry ?? "/app/sessions/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, router, setSession(next: ReturnType<typeof sessionFixture>) { session = next; }, close() { ui.unmount();router.dispose();query.clear(); } };
}
it("opens conversation on demand, keeps the task in place and restores the opener focus", async () => {
 const f = setup(), heading = await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(document.activeElement).toBe(heading);expect(screen.queryByRole("textbox", { name: "Comment" })).toBeNull();const opener = screen.getByRole<HTMLButtonElement>("button", { name: "Talk to this session" });opener.focus();fireEvent.click(opener);expect(await screen.findByRole("dialog", { name: "Talk to this session" })).toBeTruthy();expect(heading.isConnected).toBe(true);fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Close dialog" }));await waitFor(() => expect(document.activeElement).toBe(opener));f.close();
});
it("keeps the served session status and exact task return link on a narrow task arrival", async () => {
 const old = "2020-01-01T00:00:00.000Z";
 const session = sessionFixture({ kind: "task", status: "starting", createdAt: old, updatedAt: old, body: { kind: "task", task: taskFixture({ createdAt: old, updatedAt: old }) } });
 const f = setup([], undefined, session);
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 expect(screen.getByTestId("session-status").textContent).toContain("Starting");
 expect(screen.getByTestId("session-status").textContent).not.toContain("Running");
 expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Work" }).getAttribute("href")).toBe("/app/live?task=11111111-1111-4111-8111-111111111111");
 expect(screen.getByTestId("session-status").className).toContain("rv-session-status");
 f.close();
});
it("opens Merge by default when the next workflow step is merge and no decision is pending", async () => {
 const f = setup([], undefined, mergeReadySession());
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 expect(screen.getByText("More about this task").closest("details")?.open).toBe(true);
 expect(screen.getByRole("region", { name: "Merge" })).toBeTruthy();f.close();
});
it("keeps task details collapsed when a decision is pending even at the merge step", async () => {
 const f = setup([], undefined, mergeReadySession(), undefined, { pendingDecision: true });
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 expect(screen.getByText("More about this task").closest("details")?.open).toBe(false);
 f.close();
});
it("follows through the real API wrapper and refreshes the server view", async () => { const f = setup();fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Follow" }));expect(await screen.findByRole<HTMLButtonElement>("button", { name: "Following" })).toBeTruthy();expect(f.request.mock.calls.some(([request]) => request.method === "POST" && request.path.endsWith("/follow"))).toBe(true);f.close(); });
it("does not fetch the conversation before the reader opens it", async () => { const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/messages"))).toBe(false);fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Talk to this session" }));await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/messages"))).toBe(true));f.close(); });

it("preserves an unsent comment when the conversation tray closes", async () => {
 const f = setup();await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Talk to this session" }));
 fireEvent.change(await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }), { target: { value: "Keep this question while I inspect the work" } });
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Close dialog" }));
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Talk to this session" }));
 expect((await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" })).value).toBe("Keep this question while I inspect the work");f.close();
});

it("retains an unsaved comment edit when inspecting the task outside the tray", async () => {
 const f = setup([messageFixture()]);f.query.setQueryData(["nav"], navFixture());
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Talk to this session" }));
 fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Edit comment" }));fireEvent.change(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" }), { target: { value: "Keep my revised explanation" } });
 fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Close dialog" }));fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Talk to this session" }));
 fireEvent.click(await screen.findByRole<HTMLButtonElement>("button", { name: "Edit comment" }));
 expect((screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" })).value).toBe("Keep my revised explanation");f.close();
});

it("stops offering more conversation when the endpoint returns its unchanged cursor", async () => {
 const f = setup([messageFixture()], "2026-10-23T12:00:00.000Z#msg_aaaaaaaaaaaaaaaaaaaa");
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });fireEvent.click(screen.getByRole<HTMLButtonElement>("button", { name: "Talk to this session" }));
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
 await screen.findByRole("dialog", { name: "Discussion of this file" });expect(heading.isConnected).toBe(true);await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" })));
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
 expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();expect(screen.queryByRole("heading", { name: "Fix duplicate refunds" })).toBeNull();expect(screen.queryByRole("button", { name: "Talk to this session" })).toBeNull();f.close();
});

it("drops cached task content and Continue when the latest task read is refused", async () => {
 const task = taskFixture(), f = setup([], undefined, sessionFixture(), undefined, { entry: "/app/tasks/" + task.taskId, cachedTasks: [task] });
 expect(await screen.findByRole("heading", { name: "You no longer have access to this task" })).toBeTruthy();
 expect(screen.queryByRole("heading", { name: task.title })).toBeNull();
 expect(screen.queryByRole("button", { name: "Continue in my tool" })).toBeNull();
 f.close();
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

it("DEC367 offers header takeover through the live People review and sends exactly once", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, owner: false, actions: ["take_over"] } }), async () => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Unconfirmed" } } }));
 try {
  const takeover = await screen.findByRole<HTMLButtonElement>("button", { name: "Take over" });await waitFor(() => expect(takeover.disabled).toBe(false));fireEvent.click(takeover);
  const dialog = await screen.findByRole("dialog", { name: "Take over this task?" });await within(dialog).findByText("Ada · Owner");
  expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/take-over"))).toBe(false);
  const confirm = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Take over" });await waitFor(() => expect(confirm.disabled).toBe(false));fireEvent.click(confirm);fireEvent.click(confirm);
  await screen.findByText(/Ownership could not be checked/u);
  const calls = f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"));expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toMatchObject({ method: "POST", path: "/v1/app/sessions/" + SESSION_FIXTURE_ID + "/take-over", body: { expectedPeopleRevision: 3 } });
  expect(Object.keys(calls[0]![0].body as object).sort()).toEqual(["expectedPeopleRevision", "requestId"]);
 } finally { f.close(); }
});
it("retries the header session once and navigates to the returned session", async () => {
 const base = sessionFixture(), returned = "ses_bbbbbbbbbbbbbbbbbbbb", f = setup([], undefined, { ...mergeReadySession(), you: { ...base.you, actions: ["retry"] } }, async () => ({ status: 200, body: { session: sessionFixture({ sessionId: returned }) } }));
 const navigate = vi.spyOn(f.host, "navigate");
 const retry = await screen.findByRole("button", { name: "Retry" });act(() => { retry.click();retry.click(); });
 await waitFor(() => expect(navigate).toHaveBeenCalledWith("/s/" + returned));
 expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/retry"))).toHaveLength(1);f.close();
});
it("posts stop only after explicit confirmation and refreshes the session", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["stop"] } }), async () => ({ status: 200, body: { session: sessionFixture() } }));
 fireEvent.click(await screen.findByRole("button", { name: "Stop" }));expect(screen.getByText("Stops the task's current work")).toBeTruthy();
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

it("DEC367 offers legacy Close then explicit Discard only after the live retained-work answer", async () => {
 const base = sessionFixture(), unpublished = [{ repository: "demo", reasons: ["worktree_changes"] }];
 const session = workspaceFixture({ you: { ...base.you, actions: ["close"] } }, { unpublished });
 let asks = 0;
 const f = setup([], undefined, session, async () => ++asks === 1 ? { status: 200, body: { session, closed: false, unpublished } } : { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Unconfirmed" } } });
 try {
  const trigger = await screen.findByRole<HTMLButtonElement>("button", { name: "Close task" });await waitFor(() => expect(trigger.disabled).toBe(false));fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Close this task?" });expect(asks).toBe(0);
  expect(within(dialog).queryByRole("button", { name: "Discard it and close" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close and delete the machine" }));
  const discard = await within(dialog).findByRole<HTMLButtonElement>("button", { name: "Discard it and close" });
  expect(within(dialog).getByRole("list", { name: "Unpublished work" }).textContent).toContain("demo");
  fireEvent.click(discard);fireEvent.click(discard);
  await waitFor(() => expect(asks).toBe(2));
  const calls = f.request.mock.calls.filter(([r]) => r.path.endsWith("/close"));expect(calls).toHaveLength(2);
  expect(calls[0]![0].body).toEqual({ requestId });
  expect(calls[1]![0].body).toEqual({ requestId, discardUnpublished: true });
  expect((calls[1]![0].body as { requestId: string }).requestId).not.toBe((calls[0]![0].body as { requestId: string }).requestId);
 } finally { f.close(); }
});
it("shows the broker's own words when a stop of a blocked task left it as it was", async () => {
 const base = sessionFixture(), words = "This task is blocked, not running. To end it, use Close task (it checks for unpublished work first).";
 const f = setup([], undefined, sessionFixture({ you: { ...base.you, actions: ["stop"] } }), async () => ({ status: 200, body: { session: sessionFixture(), stop: "NOTHING_RUNNING", message: words } }));
 fireEvent.click(await screen.findByRole("button", { name: "Stop" }));fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
 await screen.findByText(words);expect(screen.queryByText("Stop requested.")).toBeNull();f.close();
});

it("does not carry a pending takeover into a different already-cached session", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, owner: false, actions: ["take_over"] } }), async () => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Unconfirmed" } } }));
 try {
  const takeover = await screen.findByRole<HTMLButtonElement>("button", { name: "Take over" });await waitFor(() => expect(takeover.disabled).toBe(false));fireEvent.click(takeover);
  const dialog = await screen.findByRole("dialog", { name: "Take over this task?" }), confirm = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Take over" });await waitFor(() => expect(confirm.disabled).toBe(false));fireEvent.click(confirm);
  await screen.findByText(/Ownership could not be checked/u);expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
  const next = sessionFixture({ sessionId: "ses_bbbbbbbbbbbbbbbbbbbb", title: "Another task", you: { ...base.you, actions: ["watch"] } });f.setSession(next);f.query.setQueryData(["session", next.sessionId], next);
  await act(() => f.router.navigate("/app/sessions/" + next.sessionId));await screen.findByRole("heading", { name: "Another task" });
  expect(screen.queryByText(/Ownership could not be checked/u)).toBeNull();await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Follow" }).disabled).toBe(false));
  expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/take-over"))).toHaveLength(1);
 } finally { f.close(); }
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

it("hides Ask about this task on hosted even when the server offers it, and makes no ask request (DEC 254z-amend2)", async () => {
 const f = setup([], undefined, workspaceFixture({ you: { ...workspaceFixture().you, live: { ask: true } } }));
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });
 await import("../../packages/ui/src/screens/session/AskPanel.js");
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
 expect(screen.queryByText("Ask about this task")).toBeNull();
 expect(f.request.mock.calls.some(([request]) => /\/asks?(\/|\?|$)/.test(request.path))).toBe(false);
 f.close();
});

it("keeps a header takeover pending until ownership arrives in a real session read", async () => {
 const base = sessionFixture(), initial = sessionFixture({ you: { ...base.you, owner: false, actions: ["take_over"] } });
 const f = setup([], undefined, initial, async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["You will own this session."] } }), { offPageHeader: true });
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(false));fireEvent.click(await screen.findByRole("button", { name: "Take over" }));
 const takeover = await screen.findByRole("dialog", { name: "Take over this task?" });await within(takeover).findByText("Ada · Owner");fireEvent.click(within(takeover).getByRole("button", { name: "Take over" }));await screen.findByText("Waiting for you to confirm in your browser");
 fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));expect(f.host.openExternal).toHaveBeenCalledTimes(1);
 const owned = sessionFixture({ revision: 2, you: { ...base.you, owner: true, actions: ["watch"] } });
 await act(() => f.query.setQueryData(["session", SESSION_FIXTURE_ID], owned));expect(screen.queryByText("You now own this session.")).toBeNull();
 f.setSession(owned);await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] });await screen.findByText("You now own this session.");f.close();
});
it("does not carry an off-page pending takeover into a different already-cached session", async () => {
 const base = sessionFixture(), f = setup([], undefined, sessionFixture({ you: { ...base.you, owner: false, actions: ["take_over"] } }), async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["You will own this session."] } }), { offPageHeader: true });
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Take over" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Take over" }));
 const takeover = await screen.findByRole("dialog", { name: "Take over this task?" });await within(takeover).findByText("Ada · Owner");fireEvent.click(within(takeover).getByRole("button", { name: "Take over" }));await screen.findByText(/Ownership could not be checked/);
 const next = sessionFixture({ sessionId: "ses_bbbbbbbbbbbbbbbbbbbb", title: "Another task", you: { ...base.you, actions: ["watch"] } });f.setSession(next);f.query.setQueryData(["session", next.sessionId], next);
 await act(() => f.router.navigate("/app/sessions/" + next.sessionId));await screen.findByRole("heading", { name: "Another task" });
 expect(screen.queryByText(/Ownership could not be checked/)).toBeNull();expect(screen.queryByText("Waiting for you to confirm in your browser")).toBeNull();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Follow" }).disabled).toBe(false);f.close();
});

// Retained legacy/off-page behavior; rebuilt Close also uses this handler (DEC367).
it("closes the task only after a confirmation, asks again before discarding unpublished work, and says it is closed", async () => {
 const base = sessionFixture(), closeSession = workspaceFixture({ you: { ...base.you, actions: ["close"] } }, { unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }] }), answers = [
  { status: 200, body: { session: closeSession, closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }], message: "not closed" } },
  { status: 200, body: { session: closeSession, closed: true, discardedUnpublished: true } },
 ];
 const f = setup([], undefined, closeSession, async () => answers.shift()!, { offPageHeader: true });
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close task" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Close task" }));
 expect(await screen.findByRole("dialog", { name: "Close this task?" })).toBeTruthy();
 expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/close"))).toBe(false);
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close and delete the machine" }));
 // Unpublished work: the list is shown and nothing was discarded.
 expect(await screen.findByRole("dialog", { name: "Discard unpublished work?" })).toBeTruthy();
 expect(screen.getByText("demo: worktree_changes")).toBeTruthy();
 const closes = () => f.request.mock.calls.map(([request]) => request).filter(request => request.path.endsWith("/close"));
 expect(closes()).toHaveLength(1);expect(closes()[0]!.body).not.toHaveProperty("discardUnpublished");
 fireEvent.click(screen.getByRole("button", { name: "Discard it and close" }));
 await screen.findByText("Rovara now reads this task as closed.");
 expect(closes()).toHaveLength(2);expect(closes()[1]!.body).toMatchObject({ discardUnpublished: true });
 expect((closes()[1]!.body as { requestId: string }).requestId).not.toBe((closes()[0]!.body as { requestId: string }).requestId);f.close();
});

// Retained legacy/off-page behavior; rebuilt Close also uses this handler (DEC367).
it("says the task is closing while its workspace is checked, and does not ask the person to press again", async () => {
 const base = sessionFixture(), cloud = (closing: boolean) => sessionFixture({ kind: "task", where: { kind: "cloud" }, you: { ...base.you, actions: ["close"] }, body: { kind: "task", task: taskFixture(closing ? { closing: true } : {}) } });
 const f = setup([], undefined, cloud(false), async () => ({ status: 200, body: { session: cloud(true), closed: false, message: "checking" } }), { offPageHeader: true });
 await screen.findByRole("heading", { name: "Fix duplicate refunds" });expect(screen.queryByText("Closing…")).toBeNull();
 await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close task" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Close task" }));
 f.setSession(cloud(true));
 fireEvent.click(within(await screen.findByRole("dialog", { name: "Close this task?" })).getByRole("button", { name: "Close and delete the machine" }));
 await screen.findByText("Closing…");
 expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toContain("Closing is waiting for confirmation. Its result is not yet known.");
 expect(screen.queryByText(/Press the button again/)).toBeNull();expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/close") && request.method === "POST")).toHaveLength(1);
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close this window" }));f.close();
});
