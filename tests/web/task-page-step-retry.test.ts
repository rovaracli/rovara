// @vitest-environment jsdom
import { expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, runLimitBlockText, runLimitWaitingText } from "@agentx/contracts";
import { sessionView, type CodeTask } from "../../packages/cloud-server/src/session-view.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, createMemoryRouter, RouterProvider } from "react-router";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { TaskPageBoundary } from "../../packages/ui/src/screens/session/task-page-policy.js";
import { QuietCard } from "../../packages/ui/src/screens/work/TaskPane.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { sessionScope } from "../../packages/ui/src/api/session-safety.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { readTask, workRow } from "../../packages/ui/src/api/work.js";
const base = workspaceFixture(), id = base.sessionId;
function mount(mode = "unknown", workflowStage = "PLAN") {
 let revision = 16, allowed = true, refusal = false, stage = workflowStage, state = "BLOCKED";
 const view = () => workspaceFixture({ status: "needs_person", you: { ...base.you, actions: allowed ? ["retry"] : [] } }, { status: "FAILED", workflow: { ...workspaceWorkflow(), stage, state, revision, blockReason: "The planner could not finish." } });
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (r.method === "GET") return refusal ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Task access ended" } } } : { status: 200, body: { session: view() } };
  if (mode === "done") return { status: 200, body: { session: view() } };
  if (mode === "config") return { status: 400, body: { error: { code: "CONFIG_INVALID", message: "choose checks that are approved for this project" } } };
  if (mode === "budget") return { status: 402, body: { error: { code: "BUDGET_EXCEEDED", message: "This task has used its run limit, so Rovara will not start more work on it. Start a new task." } } };
  return { status: 503, body: { error: { code: "UPSTREAM", message: "Result unknown" } } };
 });
 const query = createQueryClient();query.setQueryData(["session", id], view());
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskPageBoundary, { children: h(SessionControls, { id, agent: "Agent", actions: ["retry"], following: false, onChanged: async () => undefined }) }) }) }) });
 let ui = renderUi(tree());
 return { f, query, drift() { revision++; }, deny() { allowed = false; }, refuse() { refusal = true; }, observe(nextRevision: number, nextState: string, nextAllowed: boolean) { revision = nextRevision;state = nextState;allowed = nextAllowed; }, settle() { revision++;stage = "PLAN";state = "RUNNING";allowed = false; }, remount() { ui.unmount();query.clear();query.setQueryData(["session", id], view());ui = renderUi(tree()); }, posts: () => f.request.mock.calls.filter(([r]) => r.method === "POST"), close() { ui.unmount();query.clear(); } };
}
it("blocked PLAN Retry uses one guarded send with the displayed revision and no invented candidate", async () => {
 const s = mount("done");try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry the step" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);fireEvent.click(retry);
  await waitFor(() => expect(s.posts()).toHaveLength(1));expect(s.posts()[0]![0]).toMatchObject({ path: `/v1/app/sessions/${id}/retry`, retry: "never", body: { expectedRevision: 16 } });
  expect(Object.keys(s.posts()[0]![0].body as object).sort()).toEqual(["expectedRevision", "requestId"]);
 } finally { s.close(); }
});
it("a pre-run budget refusal shows Code's words and clears only that pending Retry", async () => {
 const s = mount("budget");try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry the step" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);
  await screen.findByText("This task has used its run limit, so Rovara will not start more work on it. Start a new task.");
  expect(screen.queryByText(/didn't confirm/)).toBeNull();expect(s.posts()).toHaveLength(1);
  const me = meFixture(), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "retry:" + id);
  expect(s.f.storage.get(scope + ":request")).toBe("null");s.remount();
  await screen.findByRole("button", { name: "Retry the step" });expect(screen.queryByText(/didn't confirm/)).toBeNull();expect(s.posts()).toHaveLength(1);
 } finally { s.close(); }
});
for (const workflow of [
 { stage: "IMPLEMENT", blockReason: WORKFLOW_BLOCK_REASONS.budgetPaused },
 { stage: "PLAN", blockReason: runLimitBlockText(20, "admin") },
 { stage: "PLAN", blockReason: runLimitWaitingText(20, "project_maintainer") },
 { stage: "PLAN", blockReason: runLimitWaitingText(20, "agent_owner") },
 { stage: "WAIT_FOR_MERGE", blockReason: "Waiting for checks." },
 { stage: "WAIT_FOR_MERGE" },
]) it(`Code-ineligible block has no Retry control or retry copy: ${JSON.stringify(workflow)}`, () => {
 const task: CodeTask = { taskId: "11111111-1111-4111-8111-111111111111", title: "Blocked task", project: "payments", status: "FAILED", createdAt: base.createdAt, updatedAt: base.updatedAt, workflow: { state: "BLOCKED", revision: 16, ...workflow } };
 const session = sessionView({ sessionId: id, taskId: task.taskId, project: task.project, owner: base.owner, startedBy: base.owner, createdAt: task.createdAt, revision: 1 }, task, { developerId: base.owner.developerId }, "https://cloud.example.test");
 if (session.body.kind !== "task") throw new Error("task fixture");
 const query = createQueryClient();query.setQueryData(["session", id], session);
 const f = fakeHost(async () => ({ status: 200, body: meFixture() })), row = { ...workRow(readTask(session.body.task)!, undefined, new Date(session.updatedAt)), group: "stopped" as const };
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskPageBoundary, { children: [h(SessionControls, { key: "controls", id, agent: "Agent", actions: session.you.actions, following: false, onChanged: async () => undefined }), h(QuietCard, { key: "quiet", row, decisionsError: undefined, retryOffered: session.you.actions.includes("retry") })] }) }) }) }));
 try {
  expect(session.you.actions).not.toContain("retry");expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  expect(screen.getByTestId("decision-quiet").textContent).not.toMatch(/retry/i);
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 } finally { ui.unmount();query.clear(); }
});
for (const mode of ["stale", "denied", "refused"]) it(`a ${mode} authority reread sends nothing`, async () => {
 const s = mount();try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry the step" });await waitFor(() => expect(retry.disabled).toBe(false));
  if (mode === "stale") s.drift();else if (mode === "denied") s.deny();else s.refuse();fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/changed|available|access ended/i));expect(s.posts()).toHaveLength(0);
  s.remount();await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });expect(s.posts()).toHaveLength(0);
 } finally { s.close(); }
});
it("unknown Retry survives reload; three Checks reveal DEC285 and a changed workflow can settle it", async () => {
 const s = mount();try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry the step" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);
  await screen.findByText(/Rovara didn't confirm this yet/);expect(screen.queryByText("Result unknown")).toBeNull();const me = meFixture(), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "retry:" + id), frozen = s.f.storage.get(scope + ":request");expect(frozen).toContain('"expectedRevision":16');
  s.remount();await screen.findByText(/Rovara didn't confirm this yet/);expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry the step" }).disabled).toBe(true);
  for (let n = 0; n < 3; n++) { fireEvent.click(screen.getByRole("button", { name: "Check" }));await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
  await screen.findByRole("link", { name: "Open the task to check" });expect(s.posts()).toHaveLength(1);expect(s.f.storage.get(scope + ":request")).toBe(frozen);
  s.settle();fireEvent.click(screen.getByRole("button", { name: "Check" }));await waitFor(() => expect(s.f.storage.get(scope + ":request")).toBe("null"));expect(s.posts()).toHaveLength(1);
 } finally { s.close(); }
});
it("blocked copy names the step and served reason instead of promising a decision card", () => {
 const session = workspaceFixture({}, { workflow: { ...workspaceWorkflow(), stage: "PLAN", state: "BLOCKED", blockReason: "The planner could not finish." } });
 if (session.body.kind !== "task") throw new Error("task fixture");
 const row = workRow(readTask(session.body.task)!, undefined, new Date(session.updatedAt));
 const ui = renderUi(h(QuietCard, { row, decisionsError: undefined, retryOffered: true }));try {
  expect(screen.getByTestId("decision-quiet").querySelector("p")?.textContent).toBe("Rovara stopped while planning. The planner could not finish.");expect(screen.queryByText(/decision card isn't available/)).toBeNull();
 } finally { ui.unmount(); }
});

for (const [revision, state, offered] of [[16, "RUNNING", false], [17, "BLOCKED", false], [17, "RUNNING", true]] as const) it(`Check cannot release an uncertain Retry on incomplete outcome evidence: ${revision}/${state}/${offered}`, async () => {
 const s = mount();try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry the step" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);await screen.findByText(/Rovara didn't confirm this yet/);
  const me = meFixture(), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "retry:" + id), frozen = s.f.storage.get(scope + ":request");
  s.observe(revision, state, offered);fireEvent.click(screen.getByRole("button", { name: "Check" }));await screen.findByText("Rovara still hasn't confirmed this. Check again before trying another action.");
  expect(s.f.storage.get(scope + ":request")).toBe(frozen);expect(s.posts()).toHaveLength(1);
 } finally { s.close(); }
});
it("a blocked review keeps its existing review decision copy", () => {
 const session = workspaceFixture({}, { workflow: { ...workspaceWorkflow(), stage: "REVIEW", state: "BLOCKED", blockReason: "Review stopped." } });
 if (session.body.kind !== "task") throw new Error("task fixture");
 const row = { ...workRow(readTask(session.body.task)!, undefined, new Date(session.updatedAt)), group: "you" as const };
 const ui = renderUi(h(QuietCard, { row, decisionsError: undefined, retryOffered: true }));try { expect(screen.getByTestId("decision-quiet").textContent).not.toContain("Rovara stopped while"); } finally { ui.unmount(); }
});

for (const [state, retryOffered] of [["BLOCKED", false], ["RUNNING", true]] as const) it(`keeps existing quiet guidance without a retryable blocked step: ${state}/${retryOffered}`, () => {
 const session = workspaceFixture({}, { workflow: { ...workspaceWorkflow(), stage: "PLAN", state, blockReason: "The planner could not finish." } });
 if (session.body.kind !== "task") throw new Error("task fixture");
 const row = { ...workRow(readTask(session.body.task)!, undefined, new Date(session.updatedAt)), group: "you" as const };
 const ui = renderUi(h(QuietCard, { row, decisionsError: undefined, retryOffered }));try {
  expect(screen.getByTestId("decision-quiet").textContent).not.toContain("Rovara stopped while");
  expect(screen.getByTestId("decision-quiet").textContent).toContain("decision card isn't available yet");
 } finally { ui.unmount(); }
});
for (const retryOffered of [true, false]) for (const withSession of [true, false]) it(`stopped guidance names retry only when served, preserving age and the reason: ${retryOffered}/${withSession}`, () => {
 const reason = "The planner could not finish: provider timed out.";
 const session = workspaceFixture({}, { workflow: { ...workspaceWorkflow(), stage: "PLAN", state: "BLOCKED", blockReason: reason } });
 if (session.body.kind !== "task") throw new Error("task fixture");
 const task = { ...readTask(session.body.task)!, sessionId: withSession ? id : undefined };
 const row = { ...workRow(task, undefined, new Date(session.updatedAt)), group: "stopped" as const, line: "Stopped 10d ago" };
 const ui = renderUi(h(QuietCard, { row, decisionsError: undefined, retryOffered, wide: true }));try {
  const quiet = screen.getByTestId("decision-quiet");
  expect(quiet.textContent).toContain("Stopped 10d ago");
  expect(quiet.querySelector("p")?.textContent).toBe(retryOffered
   ? `Rovara stopped while planning. ${reason} You can retry this step from Task actions above, close it, or continue it in your tool.`
   : `Rovara stopped before it finished and nobody has picked it up since. ${withSession ? "Close it or continue it in your tool, from the actions above." : "Continue it in your tool from the button above."}`);
 } finally { ui.unmount(); }
});

for (const path of ["/s/" + id, "/app/sessions/" + id]) for (const retryOffered of [true, false]) it(`the production task route matches blocked copy to the served Retry: ${path}/${retryOffered}`, async () => {
 const session = workspaceFixture({ status: "needs_person", you: { ...base.you, actions: retryOffered ? ["retry"] : [] } }, { status: "FAILED", workflow: { ...workspaceWorkflow(), stage: "PLAN", state: "BLOCKED", revision: 16, blockReason: "The planner could not finish." } });
 const nav = navFixture(), f = fakeHost(async r => {
  const url = r.path.split("?")[0];
  if (r.method !== "GET") return r.path.endsWith("/presence") ? { status: 200, body: { viewingNow: [] } } : { status: 503, body: { error: { code: "UPSTREAM", message: "Result unknown" } } };
  if (url === "/v1/app/me") return { status: 200, body: meFixture() };
  if (url === "/v1/app/nav") return { status: 200, body: nav };
  if (url === "/v1/app/sessions/" + id) return { status: 200, body: { session } };
  if (url === "/v1/app/sessions") return { status: 200, body: { tasks: [] } };
  if (url === "/v1/app/decisions") return { status: 200, body: { cards: [] } };
  if (url?.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (url?.endsWith("/messages")) return { status: 200, body: { messages: [], hasMore: false } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const routes = appRoutes(nav.features), app = routes.find(route => route.path === "/app")!, shared = path.startsWith("/s/");
 const leaf = shared ? routes.find(route => route.path === "/s/:id")!.children![0]! : app.children!.find(route => route.path === "sessions/:id")!;
 const router = createMemoryRouter([{ path: shared ? "/s/:id" : "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: [path] }), query = createQueryClient();query.setQueryData(["nav"], nav);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
 try {
  if (!retryOffered) {
   const quiet = await screen.findByTestId("decision-quiet");
   expect(quiet.textContent).not.toContain("Rovara stopped while");
   expect(quiet.querySelector("p")?.textContent).toBe("Rovara stopped before it finished and nobody has picked it up since. Close it or continue it in your tool, from the actions above.");
   expect(screen.queryByRole("button", { name: "Retry the step" })).toBeNull();
   expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/retry"))).toHaveLength(0);
   return;
  }
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry the step" });await waitFor(() => expect(retry.disabled).toBe(false));
  expect(screen.getByTestId("decision-quiet").querySelector("p")?.textContent).toBe("Rovara stopped while planning. The planner could not finish. You can retry this step from Task actions above, close it, or continue it in your tool.");fireEvent.click(retry);
  await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && r.path.endsWith("/retry"))).toHaveLength(1));
  expect(f.request.mock.calls.find(([r]) => r.path.endsWith("/retry"))![0].body).toMatchObject({ expectedRevision: 16 });
 } finally { ui.unmount();router.dispose();query.clear(); }
});

it("a BLOCKED review without a served candidate stays held on the one review Retry", async () => {
 const s = mount("unknown", "REVIEW");try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry" });expect(retry.disabled).toBe(true);fireEvent.click(retry);expect(s.posts()).toHaveLength(0);expect(screen.queryByRole("button", { name: "Retry the step" })).toBeNull();
 } finally { s.close(); }
});

it("N3 the served final configuration refusal shows Code's words and releases only that Retry", async () => {
 const s = mount("config");try {
  const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry the step" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);
  await screen.findByText("choose checks that are approved for this project");
  expect(screen.queryByText(/didn't confirm/)).toBeNull();expect(s.posts()).toHaveLength(1);
  const me = meFixture(), scope = sessionScope({ companyId: me.org.orgId, personId: me.developer.id }, "retry:" + id);
  expect(s.f.storage.get(scope + ":request")).toBe("null");
 } finally { s.close(); }
});
