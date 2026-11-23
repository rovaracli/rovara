// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionEventReaderSchema } from "@agentx/contracts/web";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { AppHostProvider, type ApiRequest } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { projectFixture } from "./support/project-fixture.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { messageFixture, sessionFixture, taskFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
afterEach(cleanup);
function setup(question = false, merge = false) {
 let failure = 0, postStatus = 503, answerStatus = 503, refuseHealthSave = false;
 const messages = [messageFixture()];
 const event = SessionEventReaderSchema.parse({ eventId: "evt_aaaaaaaaaaaaaaaaaaaaaaaa", sessionId: SESSION_FIXTURE_ID, type: "comment", source: "slack", at: "2026-10-23T12:00:00.000Z", text: "Comment posted", messageId: messages[0]!.messageId, actor: { kind: "member", ...messages[0]!.author } });
 const f = fakeHost(async (r: ApiRequest) => {
  if (r.path === "/v1/app/decisions") return { status: 200, body: { cards: [], total: 0, digests: {} } };
  if (r.path.endsWith("/overview")) return { status: 200, body: projectFixture() };
  // DEC 254zzz379: task Ask reads its own served history before sending.
  if (r.method === "GET" && r.path.endsWith("/answers")) return { status: 200, body: { entries: [], more: false } };
  if (r.method === "POST" && r.path.endsWith("/answers")) return { status: answerStatus, body: { error: { code: answerStatus === 403 ? "FORBIDDEN" : "UNAVAILABLE", message: "Cannot confirm" } } };
  if (r.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (r.path.includes("/messages")) {
   if (r.method === "POST") { if (postStatus === 200) { const returned = messageFixture({ kind: "steer", text: "Server's returned text", delivery: { state: "queued", at: "2026-10-23T12:00:00.000Z" } });messages.splice(0, messages.length, returned);return { status: 200, body: returned }; }return { status: postStatus, body: { error: { code: postStatus === 403 ? "CSRF_INVALID" : "UNAVAILABLE", message: "Cannot confirm" } } }; }
   if (r.method === "PATCH") return { status: 409, body: { error: { code: "SESSION_REVISION_CONFLICT", message: "Revision changed" } } };
   if (failure) return { status: failure, body: { error: { code: "FORBIDDEN", message: "No longer readable" } } };
   return { status: 200, body: { messages } };
  }
  if (r.path.endsWith("/events")) return { status: 200, body: { events: [event] } };
  if (r.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (r.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session: sessionFixture(question || merge ? { kind: "task", body: { kind: "task", task: taskFixture(merge ? { status: "SUCCEEDED", workflow: undefined, pullRequests: [{ repository: "payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" }] } : {}) } } : {}) } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const persist = f.host.storage.set.bind(f.host.storage);
 f.host.storage.set = (key, value) => { const reads = (JSON.parse(value) as { reads?: Record<string, { health?: string }> } | null)?.reads ?? {};if (refuseHealthSave && Object.entries(reads).some(([resource, read]) => resource.startsWith("messages:") && ["reading", "refused"].includes(read.health ?? ""))) throw new Error("simulated read-health persistence failure");persist(key, value); };
 const query = createQueryClient();query.setQueryData(["nav"], navFixture(question ? { features: { localAgents: false, usage: false, admin: false, chains: false, notices: false, describe: false, answers: true } } : {}));
 const mount = (route = "/app/sessions/:id") => { const router = createMemoryRouter([{ path: route, element: h(SessionScreen, {}) }], { initialEntries: [route.replace(":id", SESSION_FIXTURE_ID)] });const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));return () => { ui.unmount();router.dispose(); }; };
 return { ...f, query, mount, fail: (status: number) => { failure = status; }, post: (status: number) => { postStatus = status; }, answer: (status: number) => { answerStatus = status; }, failRefusedHealthSave: () => { refuseHealthSave = true; }, recoverStorage: () => { refuseHealthSave = false; } };
}
async function open() { fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));await screen.findByRole("textbox", { name: "Comment" });await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function send() { fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Frozen draft" } });fireEvent.click(screen.getByRole("button", { name: "Send comment" })); }
it("F1 mounts provenance, catalogue edit recovery and the server-returned queued outcome in the real page", async () => {
 const f = setup();f.post(200);const close = f.mount();await open();expect((await screen.findByTestId("talk-comment-provenance")).textContent).toContain("from Slack");
 fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), { target: { value: "My retained edit" } });fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
 expect((await screen.findByLabelText("Comment edit recovery")).textContent).toContain("My retained edit");fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));await send();
 await waitFor(() => expect(screen.getByRole("region", { name: "Talk delivery outcome" }).textContent).toContain("Server's returned text"));expect(screen.queryByText("Applied")).toBeNull();close();
});
it("F2 retains a frozen unknown send across close, remount, Check and storage events without a second POST", async () => {
 const f = setup();let close = f.mount();await open();await send();await screen.findByText("Rovara didn't confirm this yet.");
 expect([...f.storage.values()].join(" ")).toContain("Frozen draft");close();close = f.mount();await open();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(true);
 await act(async () => { window.dispatchEvent(new StorageEvent("storage")); });fireEvent.click(screen.getByRole("button", { name: "Check delivery" }));await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path.includes("/messages") && r.method === "GET").length).toBeGreaterThan(1));
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(true);expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(1);close();
});
it("F2 refuses to send when persistence silently fails, and retains the draft", async () => {
 const f = setup();f.host.storage.set = () => undefined;const close = f.mount();await open();await send();await screen.findByText(/can't be made safely in this browser/);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(0);expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).value).toBe("Frozen draft");close();
});
it("F3 drops edit and send authority on a later timeline refusal, across a remount, then reloads the same draft", async () => {
 const f = setup();let close = f.mount();await open();fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Unsent context" } });f.fail(403);
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID, "messages"] }); });
 expect(await screen.findByTestId("talk-timeline-read-recovery")).toBeTruthy();expect(screen.queryByText("Check refunds before retrying.")).toBeNull();expect(screen.queryByRole("button", { name: "Edit comment" })).toBeNull();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(true);
 close();close = f.mount();await open();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(true);f.fail(0);fireEvent.click(screen.getByRole("button", { name: "Reload the conversation" }));fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Fresh draft after reload" } });await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(false));close();
});

it("F5 keeps a refused comment reload fenced after its health save fails, storage recovers, and Talk remounts", async () => {
 const f = setup();let close = f.mount();await open();fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
 fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), { target: { value: "Retain this edit" } });fireEvent.click(screen.getByRole("button", { name: "Save changes" }));await screen.findByRole("button", { name: "Load current comment" });
 f.failRefusedHealthSave();f.fail(403);fireEvent.click(screen.getByRole("button", { name: "Load current comment" }));await screen.findByTestId("talk-timeline-read-recovery");
 f.recoverStorage();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(true);expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).disabled).toBe(true);
 close();close = f.mount();await open();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send comment" }).disabled).toBe(true);expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).disabled).toBe(true);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(0);close();
});

it("R6h re-reads identity after actual CSRF_INVALID without claiming an authority refusal", async () => {
 const f = setup();f.post(403);const close = f.mount();await open();const identityReads = f.request.mock.calls.filter(([r]) => r.path === "/v1/app/me").length;await send();await screen.findByText("Couldn't change that. Your draft is still here.");await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path === "/v1/app/me").length).toBeGreaterThan(identityReads));const post = f.request.mock.calls.findIndex(([r]) => r.method === "POST" && r.path.endsWith("/messages"));expect(f.request.mock.calls.slice(post + 1).some(([r]) => r.path === "/v1/app/me")).toBe(true);expect(screen.queryByText("Rovara didn't confirm this yet.")).toBeNull();close();
});
it("F1 retains the exact edit and recovery when the current-comment read fails", async () => {
 const f = setup();const close = f.mount();await open();fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));fireEvent.change(screen.getByRole("textbox", { name: "Edit comment" }), { target: { value: "Exact edited context" } });fireEvent.click(screen.getByRole("button", { name: "Save changes" }));await screen.findByRole("button", { name: "Load current comment" });f.fail(500);fireEvent.click(screen.getByRole("button", { name: "Load current comment" }));
 await screen.findByText("The current comment could not be loaded. Your draft is still on this page. Reload the comment.");await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });expect(screen.getByLabelText("Comment edit recovery").textContent).toContain("The current comment could not be loaded.");expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Edit comment" }).value).toBe("Exact edited context");close();
});

it("F2 locks the hosted question mode after an unknown answer, including after reopening", async () => {
 const f = setup(true);const close = f.mount();await open();fireEvent.click(await screen.findByRole("button", { name: "Ask about this task" }));fireEvent.click(await screen.findByText("Ask about this task", { selector: "summary" }));const field = await screen.findByTestId("ask-box-text");fireEvent.change(field, { target: { value: "Keep my exact question" } });fireEvent.click(screen.getByTestId("ask-box-submit"));await screen.findByText("Couldn't check whether Rovara answered this.");
 // The composer is one "Ask another question" line while the question is unsettled; focusing it opens the locked question box.
 fireEvent.focus(await screen.findByPlaceholderText("Ask another question"));
 expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Ask" })).matches(":disabled")).toBe(true);expect([...f.storage.values()].join(" ")).toContain("Keep my exact question");fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));fireEvent.focus(await screen.findByPlaceholderText("Ask another question"));expect(screen.getByRole<HTMLButtonElement>("button", { name: "Ask about this task" }).disabled).toBe(true);expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/answers"))).toHaveLength(1);close();
});

it("F4 fences the hosted Ask composer after refusal across remount until a newer owning overview read succeeds", async () => {
 const f = setup(true);f.answer(403);let close = f.mount();await open();fireEvent.click(await screen.findByRole("button", { name: "Ask about this task" }));fireEvent.click(await screen.findByText("Ask about this task", { selector: "summary" }));
 const field = await screen.findByTestId("ask-box-text"), submit = await screen.findByTestId("ask-box-submit");fireEvent.change(field, { target: { value: "Keep my exact question" } });fireEvent.click(submit);await screen.findByText("This question is no longer available in this session.");
 await waitFor(() => { expect(screen.getByTestId("ask-box-text").hasAttribute("disabled")).toBe(true);expect(screen.getByTestId("ask-box-submit").hasAttribute("disabled")).toBe(true); });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["session", SESSION_FIXTURE_ID] }); });
 expect(screen.getByTestId("ask-box-submit").hasAttribute("disabled")).toBe(true);
 close();close = f.mount();await open();fireEvent.click(await screen.findByRole("button", { name: "Ask about this task" }));fireEvent.click(await screen.findByText("Ask about this task", { selector: "summary" }));
 await waitFor(() => expect(screen.getByTestId("ask-box-submit").hasAttribute("disabled")).toBe(true));expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/answers")).length).toBe(1);
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["project", "payments", "overview"] }); });
 await waitFor(() => expect(screen.getByTestId("ask-box-text").hasAttribute("disabled")).toBe(false));
 fireEvent.change(screen.getByTestId("ask-box-text"), { target: { value: "A newer question" } });expect(screen.getByTestId("ask-box-submit").hasAttribute("disabled")).toBe(false);close();
});

it("F1 receives the Slack session route, focuses the task, and returns focus to the Talk opener", async () => {
 const close = setup().mount("/s/:id");const heading = await screen.findByTestId("session-title");
 await waitFor(() => expect(document.activeElement).toBe(heading));
 const opener = screen.getByTestId<HTMLButtonElement>("session-conversation-trigger");expect(opener.textContent).toBe("Talk to this session");expect(opener.getAttribute("aria-haspopup")).toBe("dialog");fireEvent.click(opener);await screen.findByRole("dialog");fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
 await waitFor(() => expect(document.activeElement).toBe(opener));close();
});

it("keeps the Merge section open when the task is at the merge step without a pending decision", async () => {
 const close = setup(false, true).mount();await screen.findByTestId("session-title");
 const more = document.querySelector<HTMLDetailsElement>("details.rv-task-more");expect(more).not.toBeNull();
 expect(more!.open).toBe(true);expect(within(more!).getByRole("region", { name: "Merge" })).toBeTruthy();close();
});

it("a locked instruction asks the person to wait without promising queued writing", async () => {
 const f = setup();const close = f.mount();await open();
 fireEvent.click(screen.getByRole("button", { name: "Send an instruction" }));
 fireEvent.change(screen.getByRole("textbox", { name: "Instruction to Rovara" }), { target: { value: "Keep the existing retry path" } });
 fireEvent.click(screen.getByRole("button", { name: "Send instruction" }));
 await screen.findByText("Rovara didn't confirm this yet.");
 expect(screen.getByText("Wait until this message is settled before writing another. Nothing else is queued.")).toBeTruthy();
 expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Instruction to Rovara" }).disabled).toBe(true);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/messages"))).toHaveLength(1);
 close();
});
