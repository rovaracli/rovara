// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { workspaceWorkflow } from "./support/workspace-fixture.js";
import { understandSession } from "./support/understand-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { sessionScope } from "../../packages/ui/src/api/session-safety.js";

function mount(session: ReturnType<typeof sessionFixture>, seedDraft = false, options: { steerStatus?: number; commentRefusal?: boolean; failPersistence?: boolean } = {}) {
 let liveSession = session;
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (r.path.endsWith("/journal")) return { status: 503, body: {} };
  if (r.path.endsWith("/answers")) return { status: 202, body: { status: "NEEDS_CONFIRMATION", changes: [] } };
  if (r.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (r.path.endsWith("/messages")) {
   if (r.method === "POST" && r.body && typeof r.body === "object" && "kind" in r.body) {
    const kind = (r.body as { kind: string }).kind;
    if (kind === "steer" && options.steerStatus !== undefined) return { status: options.steerStatus, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara didn't confirm this yet." } } };
    if (kind === "comment" && options.commentRefusal) { liveSession = { ...liveSession, you: { ...liveSession.you, actions: ["watch"] } };return { status: 403, body: { error: { code: "FORBIDDEN", message: "Conversation messages are refused for this session." } } }; }
   }
   return { status: 200, body: { messages: [] } };
  }
  if (r.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (r.path === "/v1/app/decisions") return { status: 404, body: {} };
  return { status: 200, body: { session: liveSession } };
 });
 const setStorage = f.host.storage.set.bind(f.host.storage);
 f.host.storage.set = (key, value) => { if (options.failPersistence && key.endsWith(":request")) throw new Error("storage unavailable");setStorage(key, value); };
 const me = meFixture(), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, SESSION_FIXTURE_ID + ":talk:all");
 if (seedDraft) f.storage.set(scope + ":draft", JSON.stringify({ comment: "Retained unsent note", steer: "" }));
 const query = createQueryClient(), router = createMemoryRouter([{ path: "/s/:id", element: h(SessionScreen, {}) }], { initialEntries: ["/s/" + SESSION_FIXTURE_ID] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { ...f, ...ui, query, close() { ui.unmount();router.dispose();query.clear(); } };
}
it("F1/R4: real starting data mounts acceptance without inventing machine readiness", async () => {
 const f = mount(workspaceFixture({ status: "starting" }, { status: "STARTING" }));
 await screen.findByRole("region", { name: "Task start receipt" });
 expect(screen.getByText("Request accepted")).toBeTruthy();expect(screen.queryByText("Machine ready")).toBeNull();expect(screen.queryByText("First command")).toBeNull();f.close();
});
it("F1/R4: a served budget pause uses the pause view without claiming a monthly refusal", async () => {
 const base = sessionFixture(), f = mount(sessionFixture({ cost: { ...base.cost, paused: { scope: "project budget" } } }));
 await screen.findByRole("region", { name: "Task pause" });expect(screen.getByText("Task paused")).toBeTruthy();expect(screen.queryByText(/monthly limit was reached/)).toBeNull();f.close();
});
it("F1/R1: failed project-site evidence mounts the unavailable view and hides blocked-host facts", async () => {
 const f = mount(workspaceFixture({}, { testingNotice: { state: "needs_repair", text: "Setup needs repair" } }));
 await screen.findByRole("tab", { name: "Evidence" });fireEvent.mouseDown(screen.getByRole("tab", { name: "Evidence" }), { button: 0, ctrlKey: false });
 await screen.findByText("Approved-site details unavailable");expect(screen.queryByText("A setup run recorded a blocked host")).toBeNull();f.close();
});
it("F1/R6g: restores only this identity's unsent draft and never sends it on arrival", async () => {
 const f = mount(sessionFixture(), true);fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 await screen.findByRole("region", { name: "Task draft" });expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Comment" }).value).toBe("Retained unsent note");
 expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/messages") && r.method === "POST")).toHaveLength(0);f.close();
});
it("F1/R2/R3: actual clarification 202 mounts the retained current-round status and locks Send", async () => {
 const f = mount(understandSession());
 fireEvent.click(await screen.findByRole("radio", { name: /The payments table/ }));fireEvent.change(screen.getByRole("textbox", { name: /Should old refunds be migrated/ }), { target: { value: "Keep history" } });
 fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
 await screen.findByRole("region", { name: "Question response status" });
 expect(screen.getByRole("list", { name: "Your retained answers" }).textContent).toContain("Keep history");
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send answers" }).disabled).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Check this question round" }));await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/answers"))).toHaveLength(1));f.close();
});

it("B2/R3/R6d-g: inline steer freezes before dispatch and a 503 prevents a second sender", async () => {
 const f = mount(workspaceFixture({}, { workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" } }), false, { steerStatus: 503 });
 const box = await screen.findByRole<HTMLInputElement>("textbox", { name: "Steer this task" });fireEvent.change(box, { target: { value: "Use the existing helper" } });fireEvent.click(screen.getByRole("button", { name: "Send" }));
 await screen.findByTestId("steer-unavailable");
 const writes = f.request.mock.calls.filter(([request]) => request.method === "POST" && request.path.endsWith("/messages"));expect(writes).toHaveLength(1);
 const lock = [...f.storage.keys()].find(key => key.endsWith(":request"));expect(lock).toBeDefined();expect((JSON.parse(f.storage.get(lock!)!) as { body: { text: string } }).body.text).toBe("Use the existing helper");f.close();
});

it("B2/R6d: inline steer refuses to dispatch when its frozen request cannot be persisted", async () => {
 const f = mount(workspaceFixture({}, { workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" } }), false, { failPersistence: true });
 const box = await screen.findByRole<HTMLInputElement>("textbox", { name: "Steer this task" });fireEvent.change(box, { target: { value: "Keep the same operation" } });fireEvent.click(screen.getByRole("button", { name: "Send" }));
 await screen.findByTestId("steer-error");expect(screen.getByTestId("steer-error").textContent).toContain("can't be made safely");
 expect(f.request.mock.calls.filter(([request]) => request.method === "POST" && request.path.endsWith("/messages"))).toHaveLength(0);f.close();
});

it("B3/R2/R3: definitive conversation refusal clears only its frozen request, keeps text and shows latest authority", async () => {
 const f = mount(workspaceFixture({}, { workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" } }), false, { commentRefusal: true });
 fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));const input = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Comment" });fireEvent.change(input, { target: { value: "Retain this comment" } });fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
 const refusal = await within(await screen.findByRole("dialog")).findByRole("alert");expect(refusal.textContent).toContain("Conversation messages are refused");expect(refusal.textContent).toContain("latest session read no longer allows");
 expect(screen.getByRole("region", { name: "Task draft" }).textContent).toContain("Retain this comment");expect(screen.getByRole("region", { name: "Task draft" }).textContent).toContain("Not sent");
 expect(f.request.mock.calls.filter(([request]) => request.method === "POST" && request.path.endsWith("/messages"))).toHaveLength(1);f.close();
});
