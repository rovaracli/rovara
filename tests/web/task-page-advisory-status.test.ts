// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { sessionStatus, sessionView, type CodeTask } from "../../packages/cloud-server/src/session-view.js";
import { workTask } from "../../packages/cloud-server/src/work-reads.js";
import { readTask, workRow } from "../../packages/ui/src/api/work.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { workspaceWorkflow } from "./support/workspace-fixture.js";
import { taskFixture, sessionPerson, SESSION_FIXTURE_ID } from "./support/session-fixture.js";
import { PLAN, PROOF, EVENTS } from "./support/work-fixture.js";

const now = "2026-11-22T15:30:00.000Z";
const advisory = { id: "plan-check", kind: "task", status: "FAILED", workflowMode: "PLAN_CRITIQUE" };
function task(patch: Record<string, unknown> = {}): CodeTask {
 return { ...taskFixture({ status: "FAILED", workflow: workspaceWorkflow(), failure: { category: "timed_out", message: "the review timed out" }, updatedAt: now }), operations: [advisory], ...patch } as unknown as CodeTask;
}
function view(t: CodeTask) {
 return sessionView({ sessionId: SESSION_FIXTURE_ID, taskId: t.taskId, project: t.project, owner: sessionPerson, startedBy: sessionPerson, createdAt: t.createdAt, revision: 1 }, t, sessionPerson, "https://cell.example");
}

it.each(["WAITING", "RUNNING", "READY"])("advisory failure preserves the healthy %s workflow on the session and task row", state => {
 const t = task({ workflow: { ...workspaceWorkflow(), state } }), v = SessionViewReaderSchema.parse(view(t));
 expect(v.status).toBe(state === "WAITING" ? "needs_person" : "running");
 expect(v.lastRunFailed).toBeUndefined();expect(v.endedAt).toBeUndefined();
 const row = workRow(readTask(t)!, undefined, new Date(now));
 expect(row.tone).toBe(state === "WAITING" ? "wait" : "run");
 expect(row.line).not.toContain("stopped");
 // The list read must retain the same evidence, including old-server omissions.
 const listed = workRow(readTask(workTask(t))!, undefined, new Date(now));
 expect(listed.tone).toBe(row.tone);
});

const unchanged: Array<[string, Record<string, unknown>, string]> = [
 ["real build failure", { operations: [{ ...advisory, workflowMode: "IMPLEMENT" }] }, "failed"],
 ["publish failure", { operations: [{ ...advisory, kind: "publish" }] }, "failed"],
 ["prepare failure", { operations: [{ ...advisory, kind: "prepare" }] }, "failed"],
 ["mixed failures", { operations: [advisory, { ...advisory, id: "build", workflowMode: "IMPLEMENT" }] }, "failed"],
 ["mixed interrupted failure", { operations: [advisory, { ...advisory, kind: "publish", status: "INTERRUPTED" }] }, "failed"],
 ["old server without workflowMode", { operations: [{ id: "old", kind: "task", status: "FAILED" }] }, "failed"],
 ["old server without operations", { operations: undefined }, "failed"],
 ["empty operations", { operations: [] }, "failed"],
 ["no failed operation", { operations: [{ ...advisory, status: "SUCCEEDED" }] }, "failed"],
 ["unreadable operations", { operations: [null] }, "failed"],
 ["malformed operations", { operations: [{ kind: "task", workflowMode: "PLAN_CRITIQUE" }] }, "failed"],
 ["missing workflow", { workflow: undefined }, "failed"],
 ["complete workflow", { workflow: { ...workspaceWorkflow(), state: "COMPLETE" } }, "failed"],
 ["malformed workflow state", { workflow: { ...workspaceWorkflow(), state: { toString: "WAITING" } } }, "failed"],
 ["unknown workflow state", { workflow: { ...workspaceWorkflow(), state: "FUTURE" } }, "failed"],
 ["closed task", { status: "CLOSED" }, "stopped"],
 ["cancelled task", { status: "CANCELLED" }, "cancelled"],
 ["interrupted task", { status: "INTERRUPTED" }, "failed"],
 ["starting task", { status: "STARTING" }, "starting"],
];
it.each(unchanged)("keeps %s unchanged", (_name, patch, expected) => {
 const t = task(patch);expect(sessionStatus(t)).toBe(expected);
 expect(readTask(t)!.advisoryPlanFailure).toBeUndefined();
 const row = workRow(readTask(t)!, undefined, new Date(now));
 if (t.status === "FAILED") expect(row.tone).toBe("bad");
});

it("BLOCKED remains blocked rather than running", () => {
 const t = task({ workflow: { ...workspaceWorkflow(), state: "BLOCKED" } });
 expect(sessionStatus(t)).toBe("needs_person");
 expect(workRow(readTask(t)!, undefined, new Date(now)).tone).toBe("bad");
});

async function mount(t: CodeTask, withoutSession = false) {
 const nav = navFixture(), session = view(t);
 // Parse the exact served task/session through the production forward reader.
 SessionViewReaderSchema.parse(session);
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0]!;
  if (request.method !== "GET") return { status: 200, body: { viewingNow: [] } };
  if (path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/sessions") return { status: 200, body: { tasks: [workTask(t)] } };
  if (path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (path === "/v1/app/decisions") return { status: 200, body: { cards: [], total: 0, tabs: {}, details: {}, digests: {}, dropped: 0 } };
  if (path.endsWith("/documents/plan")) return { status: 200, body: PLAN };
  if (path.endsWith("/evidence")) return { status: 200, body: PROOF };
  if (path.endsWith("/events")) return { status: 200, body: EVENTS };
  if (path.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  if (path.endsWith("/lessons")) return { status: 200, body: { lessons: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const leaf = appRoutes(nav.features).find(route => route.path === "/app")!.children!.find(route => route.path === "sessions/:id")!;
 const router = createMemoryRouter([{ path: "/app/sessions/:id", lazy: leaf.lazy! }], { initialEntries: ["/app/sessions/" + (withoutSession ? t.taskId : SESSION_FIXTURE_ID)] });
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 await screen.findByTestId("session-title", {}, { timeout: 15_000 });
 return { close() { ui.unmount();router.dispose();query.clear(); } };
}

it.each([
 ["WAITING", "Needs you"], ["RUNNING", "Running"], ["BLOCKED", "Blocked"],
])("real task route: advisory failure + %s shows %s and a quiet note in the plan step", async (state, label) => {
 const ui = await mount(task({ workflow: { ...workspaceWorkflow(), state } }));
 try {
  expect(within(screen.getByTestId("session-header")).getByRole("img", { name: label })).toBeTruthy();
  const note = await screen.findByText("The plan review didn't run: the review timed out");
  expect(note.closest(".rv-task-section")).not.toBeNull();
  expect(note.classList.contains("rv-muted")).toBe(true);
  expect(screen.queryAllByText("The plan review didn't run: the review timed out")).toHaveLength(1);
 } finally { ui.close(); }
});

it("real task route: a real failure stays Failed with no advisory note", async () => {
 const ui = await mount(task({ operations: [{ ...advisory, workflowMode: "IMPLEMENT" }] }));
 try {
  expect(within(screen.getByTestId("session-header")).getByRole("img", { name: "Failed" })).toBeTruthy();
  expect(screen.queryByText(/The plan review didn't run:/)).toBeNull();
 } finally { ui.close(); }
});

it.each([
 ["RUNNING", "IMPLEMENT", "RUNNING", "Running"],
 ["SUCCEEDED", "PLAN_REVIEW", "WAITING", "Needs you"],
] as const)("healthy %s task retains the failed advisory operation's note", async (status, stage, state, label) => {
 const t = task({ status, workflow: { ...workspaceWorkflow(), stage, state } });
 expect(readTask(t)?.advisoryPlanFailure).toBe("the review timed out");
 expect(readTask(workTask(t))?.advisoryPlanFailure).toBe("the review timed out");
 const ui = await mount(t);
 try {
  expect(within(screen.getByTestId("session-header")).getByRole("img", { name: label })).toBeTruthy();
  const note = await screen.findByText("The plan review didn't run: the review timed out");
  expect(note.closest(".rv-task-section")).not.toBeNull();
  expect(note.classList.contains("rv-muted")).toBe(true);
  expect(screen.queryAllByText("The plan review didn't run: the review timed out")).toHaveLength(1);
 } finally { ui.close(); }
});

it.each([
 ["WAITING", "Needs you"], ["RUNNING", "Running"], ["BLOCKED", "Blocked"],
])("task-id route without a session: advisory + %s shows %s", async (state, label) => {
 const ui = await mount(task({ workflow: { ...workspaceWorkflow(), state } }), true);
 try {
  expect(within(screen.getByTestId("session-header")).getByRole("img", { name: label })).toBeTruthy();
  expect(await screen.findByText("The plan review didn't run: the review timed out")).toBeTruthy();
 } finally { ui.close(); }
});

it("a note with no served reason says so without inventing one", () => {
 expect(readTask(task({ failure: undefined }))!.advisoryPlanFailure).toBe("No reason was provided.");
});

it.each(["RUNNING", "SUCCEEDED"])("preserves an ordinary %s task's existing waiting mapping", status => {
 expect(sessionStatus(task({ status, operations: undefined }))).toBe("needs_person");
 expect(workRow(readTask(task({ status, operations: undefined }))!, undefined, new Date(now)).tone).toBe("wait");
});
