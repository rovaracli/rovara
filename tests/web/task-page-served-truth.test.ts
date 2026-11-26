// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DeveloperTaskViewSchema, SessionViewReaderSchema } from "@agentx/contracts/web";
import { sessionView, type CodeTask } from "../../packages/cloud-server/src/session-view.js";
import { failedSections, finishedSections, readTask, sectionState, STAGE_ORDER, STEPS } from "../../packages/ui/src/api/work.js";
import { WorkflowStageSchema } from "../../packages/contracts/src/task-workflow.js";
import { createCandidateManifest } from "../../packages/contracts/src/task-workflow-node.js";
import { detailedRow, workTask } from "../../packages/cloud-server/src/work-reads.js";
import { DeveloperTaskListItemSchema } from "../../packages/contracts/src/developer-tasks-node.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { sessionPerson, SESSION_FIXTURE_ID, taskFixture } from "./support/session-fixture.js";
import { workspaceWorkflow } from "./support/workspace-fixture.js";
import { CARDS, PLAN, PROOF, EVENTS, decisionsView } from "./support/work-fixture.js";

function coreTask(patch: Record<string, unknown> = {}): CodeTask {
 return { ...taskFixture(), workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" }, ...patch } as CodeTask;
}
function servedSession(task: CodeTask, viewer: Parameters<typeof sessionView>[2] = sessionPerson) {
 return sessionView({ sessionId: SESSION_FIXTURE_ID, taskId: task.taskId, project: task.project, owner: sessionPerson, startedBy: sessionPerson, createdAt: task.createdAt, revision: 1 }, task, viewer, "https://cell.example");
}

// These cases catch replacing the running-step check with a nonterminal/display-status check.
const steps: Array<[string, Record<string, unknown>, boolean]> = [
 ["running step", {}, true],
 ["completed last run with a running workflow", { status: "SUCCEEDED" }, true],
 ["WAIT_FOR_MERGE", { status: "SUCCEEDED", workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" } }, false],
 ["WAITING despite a RUNNING task status", { workflow: { stage: "IMPLEMENT", state: "WAITING" } }, false],
 ["pending plan decision", { workflow: { stage: "PLAN_REVIEW", state: "WAITING" } }, false],
 ["READY between steps", { workflow: { stage: "IMPLEMENT", state: "READY" } }, false],
 ["blocked step", { workflow: { stage: "VERIFY", state: "BLOCKED" } }, false],
 ["unknown workflow state", { workflow: { stage: "IMPLEMENT", state: "FUTURE" } }, false],
 ["missing workflow state", { workflow: { stage: "IMPLEMENT" } }, false],
 ["legacy running session without a workflow", { workflow: undefined }, true],
 ["legacy starting session", { workflow: undefined, status: "STARTING" }, false],
 ["cancelled task with stale running workflow", { status: "CANCELLED" }, false],
 ["failed task with stale running workflow", { status: "FAILED" }, false],
];
it.each(steps)("served actions: %s offers Stop only for running work and keeps Close (except an unknown workflow state)", (_name, patch, stop) => {
 const view = servedSession(coreTask(patch));
 expect(view.you.actions.includes("stop")).toBe(stop);
 // DECOUPLE T2 (Opus S5, DEC 540): a workflow state this build does not know reads as an unknown status, so it offers no Close either (it was "Running" with Close before).
 if (_name === "unknown workflow state") expect(view.you.actions).not.toContain("close"); else expect(view.you.actions).toContain("close");
});

it.each(["member", "admin"])("served actions: a %s watcher cannot Stop a running step or Close the task", companyRole => {
 const view = servedSession(coreTask(), { developerId: "b".repeat(64), name: "Sam", companyRole });
 expect(view.you.actions).not.toContain("stop");
 expect(view.you.actions).not.toContain("close");
});

async function mount(task: CodeTask, preview = false, pending = false, taskAddress = false, proofBody: unknown = PROOF, listedTask: unknown = task) {
 const nav = navFixture(), session = servedSession(task);
 SessionViewReaderSchema.parse(session);
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0]!;
  if (request.method === "POST" && path.endsWith("/evidence-opened")) return { status: 200, body: { cardId: CARDS[0]!.id, opened: true, recorded: true } };
  if (request.method !== "GET") return { status: 200, body: { viewingNow: [] } };
  if (path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  // The full page must use the single task read, even when the list has no PR.
  if (path === "/v1/app/sessions") return { status: 200, body: { tasks: [{ ...workTask(preview || taskAddress ? listedTask : { ...task, pullRequests: [] }), ...(preview && !taskAddress ? { sessionId: SESSION_FIXTURE_ID } : {}) }] } };
  if (path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session } };
  if (path === "/v1/app/decisions") return { status: 200, body: decisionsView(pending ? [{ ...CARDS[0]!, taskId: task.taskId, project: task.project }] : []) };
  if (path.endsWith("/documents/plan")) return { status: 200, body: PLAN };
  if (path.endsWith("/evidence")) return { status: 200, body: proofBody };
  if (path.endsWith("/events")) return { status: 200, body: EVENTS };
  if (path.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  if (path.endsWith("/lessons")) return { status: 200, body: { lessons: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const path = preview ? "/app/live" : "/app/sessions/:id";
 const leaf = appRoutes(nav.features).find(route => route.path === "/app")!.children!.find(route => route.path === (preview ? "live" : "sessions/:id"))!;
 const taskLeaf = appRoutes(nav.features).find(route => route.path === "/app")!.children!.find(route => route.path === "sessions/:id")!;
 const router = createMemoryRouter([{ path, lazy: leaf.lazy! }, ...(preview ? [{ path: "/app/sessions/:id", lazy: taskLeaf.lazy! }] : [])], { initialEntries: [preview ? "/app/live?task=" + task.taskId : "/app/sessions/" + (taskAddress ? task.taskId : SESSION_FIXTURE_ID)] });
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) }));
 return { close() { ui.unmount();router.dispose();query.clear(); } };
}

it.each([
 ["RUNNING", "IMPLEMENT", "RUNNING", true],
 ["WAIT_FOR_MERGE", "WAIT_FOR_MERGE", "WAITING", false],
 ["WAITING", "IMPLEMENT", "WAITING", false],
 ["a decision pending", "PLAN_REVIEW", "WAITING", false],
] as const)("full task page: %s shows the served Stop availability and keeps Close", async (_name, stage, state, stop) => {
 const pending = stage === "PLAN_REVIEW";
 const ui = await mount(coreTask({ workflow: { ...workspaceWorkflow(), stage, state } }), false, pending);
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  if (pending) await screen.findByRole("button", { name: "Approve plan v1" });
  fireEvent.keyDown(await screen.findByRole("button", { name: "Task actions" }), { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitem", { name: "Stop" }) !== null).toBe(stop);
  expect(within(menu).getByRole("menuitem", { name: "Close task" })).toBeTruthy();
 } finally { ui.close(); }
});

it("a core task's open PR is shown once on its page, including when opened from Work preview", async () => {
 const task = coreTask({ status: "SUCCEEDED", workflow: { ...workspaceWorkflow(), stage: "WAIT_FOR_MERGE", state: "WAITING" }, pullRequests: [{ repository: "acme/payments", number: 42, state: "open", url: "https://github.com/acme/payments/pull/42" }] });
 for (const preview of [false, true]) {
  const ui = await mount(task, preview);
  try {
   if (preview) {
    await screen.findByTestId("pane-title");
    fireEvent.click(screen.getByRole("link", { name: "Open task" }));
   }
   await screen.findByTestId("session-title", {}, { timeout: 15_000 });
   fireEvent.click((await screen.findByText("Plan and changes", { selector: "strong" })).closest("summary")!);
   const rail = await screen.findByRole("list", { name: "Steps of this task" });
   fireEvent.click(within(rail).getByRole("button", { name: /^Pull request/u }));
    // The full page already lists the pull request in its merge section: it appears once, never again as a card in the selected section.
    const row = await waitFor(() => { const found = document.querySelector<HTMLElement>(".rv-merge-pr"); expect(found).not.toBeNull(); return found!; });
    expect(within(row).getByRole("heading", { name: "acme/payments #42" })).toBeTruthy();
    expect(within(row).getByText("Open")).toBeTruthy();
    expect(within(row).getByRole("link", { name: /Open on GitHub/u }).getAttribute("href")).toBe("https://github.com/acme/payments/pull/42");
    expect(screen.queryByRole("region", { name: "Pull request" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "acme/payments #42" })).toHaveLength(1);
    expect(document.querySelectorAll(".rv-merge-pr")).toHaveLength(1);
   expect(screen.queryByTestId("no-pull-request")).toBeNull();
  } finally { ui.close(); }
 }
});

// R4: section order is navigation, never evidence of a completed workflow step.
it.each([
 [undefined, "Starting"],
 ["unknown", "Starting"],
 ["future-reason", "Starting"],
 ["own-machine-starting", "Starting a machine for this task (about 3 minutes)"],
] as const)("a never-started task uses only served startup evidence (%s)", async (startupReason, words) => {
 const task = coreTask({ status: "STARTING", workflow: undefined, ...(startupReason === undefined ? {} : { startupReason }) });
 // Unknown additions are tolerated by the real forward reader, not treated as machine evidence.
 const ui = await mount(task);
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const rail = screen.getByRole("list", { name: "Steps of this task" });
  expect(rail.textContent).not.toMatch(/[✓●]/u);
  expect(within(rail).getByRole("button", { name: /Request, submitted/u })).toBeTruthy();
  expect(within(screen.getByTestId("decision-quiet")).getByRole("heading", { name: words })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/In the queue|Starts when a runner is free|Queued/u);
 } finally { ui.close(); }
});

it.each([
 ["RUNNING", "RUNNING", "●", "running"],
 ["SUCCEEDED", "RUNNING", "●", "running"],
 ["FAILED", "BLOCKED", "!", "blocked"],
 ["SUCCEEDED", "READY", "", "progress not confirmed"],
 ["RUNNING", "WAITING", "", "needs you"],
 ["RUNNING", "BLOCKED", "!", "blocked"],
 ["STARTING", "RUNNING", "", "progress not confirmed"],
 ["RUNNING", "FUTURE", "", "progress not confirmed"],
 ["FAILED", "RUNNING", "", "progress not confirmed"],
 ["CANCELLED", "RUNNING", "", "progress not confirmed"],
] as const)("section marks follow served task %s / step %s", async (status, state, mark, words) => {
 const ui = await mount(coreTask({ status, workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state } }));
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const rail = screen.getByRole("list", { name: "Steps of this task" });
  // Build is the served current stage, so Request and Spec are before it in the fixed order: finished, unless the task never started.
  const ticks = status === "STARTING" ? 0 : 2;
  expect(rail.textContent?.match(/✓/gu) ?? []).toHaveLength(ticks);
  if (state === "RUNNING" && (status === "RUNNING" || status === "SUCCEEDED")) expect(within(screen.getByTestId("decision-quiet")).getByRole("heading", { name: "Nothing needed from you" })).toBeTruthy();
  const build = within(rail).getByRole("button", { name: new RegExp("Build, " + words, "u") });
  expect(build.closest("li")?.classList.contains("run")).toBe(mark === "●");
  expect(build.closest("li")?.classList.contains("bad")).toBe(mark === "!");
  expect(build.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe(mark);
  expect(rail.textContent?.match(/●/gu) ?? []).toHaveLength(mark === "●" ? 1 : 0);
  expect(rail.textContent?.match(/!/gu) ?? []).toHaveLength(mark === "!" ? 1 : 0);
  expect(screen.queryByText(/2 steps finished/u) !== null).toBe(ticks === 2);
  expect(screen.getByTestId("session-status").textContent).toContain(state === "BLOCKED" && status === "RUNNING" ? "Blocked" : status === "STARTING" ? "Setting up" : "");
  const timeline = screen.getByRole("list", { name: "Where this task is" });
  expect(within(timeline).getByText("Build").closest("li")?.textContent).toContain(mark === "●" ? "Current step" : state === "BLOCKED" ? "Blocked" : state === "WAITING" ? "Waiting for your decision" : "Progress not confirmed");
  const buildState = mark === "●" ? "running" : state === "BLOCKED" || state === "WAITING" ? "needs_you" : "next";
  expect(within(timeline).getAllByRole("listitem").map(item => item.dataset.state)).toEqual(ticks === 2 ? ["done", buildState, "next", "next"] : ["next", "next", buildState, "next", "next"]);
 } finally { ui.close(); }
});

it("agent progress marks only served completed steps, never a pending current pointer", async () => {
 const ui = await mount(coreTask({ run: { state: "RUNNING", currentStep: { id: "build", name: "Build agent" }, steps: [
  { id: "plan", name: "Plan agent", status: "done" },
  { id: "build", name: "Build agent", status: "pending" },
  { id: "checks", name: "Checks agent", status: "running" },
 ], pendingApprovals: [] } }));
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const rail = screen.getByRole("list", { name: "Where this task is" });
  expect(within(rail).getAllByRole("listitem").map(item => item.dataset.state)).toEqual(["done", "next", "next"]);
 } finally { ui.close(); }
});

// The existing Code contract (DEC 254zzz382) must survive both Cloud projections.
it.each(["own-machine-starting", "unknown"] as const)("keeps the documented startupReason %s on the task and detailed row", startupReason => {
 const task = coreTask({ status: "STARTING", startupReason });
 expect(DeveloperTaskViewSchema.parse(task).startupReason).toBe(startupReason);
 expect(SessionViewReaderSchema.parse(servedSession(task)).body).toMatchObject({ task: { startupReason } });
 expect(workTask(task)).toMatchObject({ startupReason });
 expect(readTask(workTask(task))).toMatchObject({ startupReason });
});

it.each([
 ["done", "build", ["done", "done", "next"]],
 ["running", "build", ["done", "running", "next"]],
 ["running", "other", ["done", "next", "next"]],
 ["waiting", "build", ["done", "next", "next"]],
 ["failed", "build", ["done", "needs_you", "next"]],
] as const)("agent progress %s at %s uses each served step status", async (status, current, expected) => {
 const ui = await mount(coreTask({ run: { state: "RUNNING", currentStep: { id: current, name: "Agent current" }, steps: [
  { id: "plan", name: "Plan agent", status: "done" },
  { id: "build", name: "Build agent", status },
  { id: "checks", name: "Checks agent", status: "pending" },
 ], pendingApprovals: [] } }));
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const rail = screen.getByRole("list", { name: "Where this task is" });
  expect(within(rail).getAllByRole("listitem").map(item => item.dataset.state)).toEqual(expected);
 } finally { ui.close(); }
});

it("the startup reason contract accepts old inputs and refuses invented queue reasons", () => {
 expect(DeveloperTaskViewSchema.parse(coreTask()).startupReason).toBeUndefined();
 expect(DeveloperTaskViewSchema.safeParse(coreTask({ startupReason: "daily-limit" })).success).toBe(false);
 expect(DeveloperTaskViewSchema.safeParse(coreTask({ startupReason: 1 })).success).toBe(false);
 expect(workTask(coreTask({ startupReason: "daily-limit" }))?.["startupReason"]).toBeUndefined();
 expect(readTask(coreTask({ startupReason: "daily-limit" }))?.startupReason).toBeUndefined();
});

it("section mapping leaves missing and unknown workflow observations unmarked", () => {
 expect(sectionState(undefined, "build")).toBe("todo");
 for (const workflow of [undefined, { stage: "FUTURE", state: "RUNNING" }, { stage: "IMPLEMENT" }]) {
  expect(sectionState(readTask(coreTask({ workflow })), "build")).toBe("todo");
 }
});

it.each([
 ["STARTING", undefined, "Setting up"],
 ["RUNNING", { stage: "IMPLEMENT", state: "RUNNING" }, "Running"],
 ["RUNNING", { stage: "IMPLEMENT", state: "READY" }, "Running"],
 ["RUNNING", { stage: "VERIFY", state: "BLOCKED" }, "Blocked"],
] as const)("section marks task-address header: %s / %j", async (status, workflow, words) => {
 const ui = await mount(coreTask({ status, workflow: workflow === undefined ? undefined : { ...workspaceWorkflow(), ...workflow } }), false, false, true);
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  expect(screen.getByTestId("session-status").textContent).toContain(words);
  expect(document.body.textContent).not.toContain("Queued");
 } finally { ui.close(); }
});

// TASK-STATUS-TRUTH round 5: ticks come from the served current stage and the fixed stage order (Code's WorkflowStageSchema), never from position alone.
const PROOF_CLEAN = { ...PROOF, items: PROOF.items.map(item => ({ ...item, verdict: "pass" as const })) };
const finishedAt = (patch: Record<string, unknown>) => finishedSections(readTask(coreTask(patch))).map(entry => entry.step);
const FIXED_ORDER = ["request", "spec", "build", "proof", "pull_request"] as const;
it("the fixed stage order is Code's workflow stage order (CLOSED has none)", () => {
 expect([...STAGE_ORDER]).toEqual(WorkflowStageSchema.options.filter(stage => stage !== "CLOSED"));
 expect(STEPS.map(entry => entry.step)).toEqual([...FIXED_ORDER]);
});
it.each([
 ["UNDERSTAND", "WAITING", 0],
 ["PLAN", "RUNNING", 1],
 ["PLAN_CRITIQUE", "RUNNING", 1],
 ["PLAN_REVIEW", "WAITING", 1],
 ["IMPLEMENT", "RUNNING", 2],
 ["VERIFY", "RUNNING", 3],
 ["REVIEW", "RUNNING", 3],
 ["PULL_REQUEST", "READY", 4],
 ["WAIT_FOR_MERGE", "WAITING", 4],
] as const)("a running task at %s / %s has its first %i sections finished and no others", (stage, state, count) => {
 const task = readTask(coreTask({ workflow: { ...workspaceWorkflow(), stage, state } }));
 expect(finishedSections(task).map(entry => entry.step)).toEqual(FIXED_ORDER.slice(0, count));
 for (const [index, step] of FIXED_ORDER.entries()) expect(sectionState(task, step) === "done").toBe(index < count);
});
it("a merged task has every section finished", () => {
 expect(finishedAt({ status: "SUCCEEDED", workflow: { ...workspaceWorkflow(), stage: "MERGED", state: "COMPLETE", outcome: "MERGED" } })).toEqual([...FIXED_ORDER]);
});
it.each([
 ["a never-started task with a stage", { status: "STARTING", workflow: { ...workspaceWorkflow(), stage: "WAIT_FOR_MERGE", state: "WAITING" } }],
 ["a never-started task with no workflow", { status: "STARTING", workflow: undefined }],
 ["no workflow", { workflow: undefined }],
 ["an unknown stage", { workflow: { ...workspaceWorkflow(), stage: "FUTURE_STAGE", state: "RUNNING" } }],
 ["no stage", { workflow: { ...workspaceWorkflow(), stage: undefined, state: "RUNNING" } }],
 ["a closed task (no record of how far it got)", { status: "CLOSED", workflow: { ...workspaceWorkflow(), stage: "CLOSED", state: "COMPLETE" } }],
 ["a skipped stage: a custom program may skip or reorder stages and serves no per-stage done", { workflow: { ...workspaceWorkflow(), stage: "VERIFY", state: "RUNNING", program: { steps: [{ id: "build", kind: "build" }, { id: "check", kind: "check" }] } } }],
] as const)("%s: no section is finished, each reads Progress not confirmed", (_name, patch) => {
 const task = readTask(coreTask(patch));
 expect(finishedSections(task)).toEqual([]);
 for (const step of FIXED_ORDER) expect(sectionState(task, step)).not.toBe("done");
});
it("a custom program reaches the page through the Work list projection too", () => {
 const task = coreTask({ workflow: { ...workspaceWorkflow(), stage: "VERIFY", state: "RUNNING", program: { steps: [{ id: "build", kind: "build" }, { id: "check", kind: "check" }] } } });
 expect(readTask(workTask(task))?.workflow?.programmed).toBe(true);
 expect(finishedSections(readTask(workTask(task)))).toEqual([]);
 expect(readTask(workTask(coreTask()))?.workflow?.programmed).toBeUndefined();
});

function listSummary(task: unknown) {
 // Code's actual detail=1 projection deliberately omits both definitionId and program.
 const parsed = DeveloperTaskViewSchema.parse(task), workflow = parsed.workflow!;
 const row = DeveloperTaskListItemSchema.parse(parsed);
 return detailedRow({ ...row, workflow: { stage: workflow.stage, state: workflow.state, revision: workflow.revision, path: workflow.path, ...(workflow.blockReason === undefined ? {} : { blockReason: workflow.blockReason }) } });
}
const customTask = () => coreTask({ workflow: { ...workspaceWorkflow(), stage: "VERIFY", state: "RUNNING", program: { steps: [{ id: "build", kind: "build" }, { id: "check", kind: "check" }] } } });
it.each(["custom", "built-in"])("real %s list summary cannot prove the built-in order", kind => {
 const full = DeveloperTaskViewSchema.parse(kind === "custom" ? customTask() : coreTask());
 const listed = readTask(workTask(listSummary(full)));
 expect(listed).toBeDefined();
 expect(finishedSections(listed)).toEqual([]);
 for (const step of FIXED_ORDER) expect(sectionState(listed, step)).not.toBe("done");
 // A full built-in read still proves its earlier sections, while a custom one never does.
 expect(finishedSections(readTask(full)).length).toBe(kind === "custom" ? 0 : 2);
});
it("an unknown workflow definition cannot prove the built-in order", () => {
 expect(finishedSections(readTask(workTask(coreTask({ workflow: { ...workspaceWorkflow(), definitionId: "future-workflow", stage: "VERIFY", state: "RUNNING" } }))))).toEqual([]);
});
it.each([false, true])("real summary on the task-address route (Work preview: %s) claims no finished steps", async preview => {
 const task = customTask();
 const ui = await mount(task, preview, false, true, PROOF_CLEAN, listSummary(task));
 try {
  if (preview) await screen.findByRole("heading", { name: task.title });
  else await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  if (preview) {
   expect(screen.getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/app/sessions/" + task.taskId);
   expect(screen.getByTestId("work").textContent).not.toContain("✓");
  } else {
   const rail = await screen.findByRole("list", { name: "Steps of this task" });
   expect(rail.textContent).not.toContain("✓");
   expect(within(rail).getByRole("button", { name: /^Request, submitted/u })).toBeTruthy();
   expect(within(rail).getByRole("button", { name: /^Spec, progress not confirmed/u })).toBeTruthy();
  }
  expect(screen.queryByText(/steps? finished/u)).toBeNull();
 } finally { ui.close(); }
});
it("a task at WAIT_FOR_MERGE shows Request, Spec, Build and Proof finished on the task page; the pull request section is not", async () => {
 const ui = await mount(coreTask({ status: "SUCCEEDED", workflow: { ...workspaceWorkflow(), stage: "WAIT_FOR_MERGE", state: "WAITING" } }), false, false, false, PROOF_CLEAN);
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const rail = screen.getByRole("list", { name: "Steps of this task" });
  for (const label of ["Request", "Spec", "Build", "Proof"]) expect(within(rail).getByRole("button", { name: new RegExp("^" + label + ", finished", "u") }).textContent).toMatch(/^✓\s/u);
  expect(within(rail).getByRole("button", { name: /^Pull request, needs you/u }).textContent).not.toContain("✓");
  expect(rail.textContent?.match(/✓/gu) ?? []).toHaveLength(4);
  const timeline = screen.getByRole("list", { name: "Where this task is" });
  expect(within(timeline).getAllByRole("listitem")[0]!.textContent).toContain("4 steps finished");
  expect(within(timeline).getAllByRole("listitem")[0]!.textContent).toContain("Request, Plan, Build, Checks and review");
  expect(within(timeline).getAllByRole("listitem").map(item => item.dataset.state)).toEqual(["done", "needs_you"]);
 } finally { ui.close(); }
});
it("a running task shows ticks only on the sections before its served stage", async () => {
 const ui = await mount(coreTask({ workflow: { ...workspaceWorkflow(), stage: "VERIFY", state: "RUNNING" } }));
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const rail = screen.getByRole("list", { name: "Steps of this task" });
  expect(rail.textContent?.match(/✓/gu) ?? []).toHaveLength(3);
  expect(within(rail).getByRole("button", { name: /^Proof, running/u }).textContent).toMatch(/^●\s/u);
  expect(within(rail).getByRole("button", { name: /^Pull request, progress not confirmed/u }).textContent).not.toContain("✓");
 } finally { ui.close(); }
});
it("a never-started task shows no tick and no finished-steps line, and its start receipt does not link to the page it is on", async () => {
 const ui = await mount(coreTask({ status: "STARTING", workflow: undefined }));
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  expect(document.body.textContent).not.toContain("✓");
  expect(screen.queryByText(/steps? finished/u)).toBeNull();
  const receipt = screen.getByTestId("task-start-receipt");
  expect(within(receipt).queryByRole("link", { name: /Open this task/u })).toBeNull();
  expect(receipt.querySelector("a")).toBeNull();
  // The "Accepted" tag sits inline with the heading (a row), not as a full-width bar of its own.
  const chip = receipt.querySelector(".rv-status-pill")!;
  expect(chip.textContent).toBe("Accepted");
  expect(chip.nextElementSibling?.tagName).toBe("H2");
  expect((chip.parentElement as HTMLElement).style.display).toBe("flex");
 } finally { ui.close(); }
});
it("a task whose only failure is an advisory plan check keeps a current step beside its finished ones; a real failure does not", () => {
 const advisory = { id: "plan-check", kind: "task", status: "FAILED", workflowMode: "PLAN_CRITIQUE" };
 const patch = (operations: unknown[]) => ({ status: "FAILED", failure: { category: "timed_out", message: "the reviewer timed out" }, workflow: { ...workspaceWorkflow(), stage: "IMPLEMENT", state: "RUNNING" }, operations });
 const quiet = readTask(coreTask(patch([advisory])));
 expect(sectionState(quiet, "build")).toBe("current");
 expect(finishedSections(quiet).map(entry => entry.step)).toEqual(["request", "spec"]);
 const real = readTask(coreTask(patch([advisory, { id: "build-run", kind: "task", status: "FAILED", workflowMode: "IMPLEMENT" }])));
 expect(sectionState(real, "build")).toBe("todo");
 expect(finishedSections(real).map(entry => entry.step)).toEqual(["request", "spec"]);
});

// TASK-STATUS-TRUTH round 6: a step whose SERVED results include a failure is not finished; it needs attention, and "N steps finished" counts clean steps only.
const AT_MERGE = { status: "SUCCEEDED", workflow: { ...workspaceWorkflow(), stage: "WAIT_FOR_MERGE", state: "WAITING" } };
const tracking = (patch: Record<string, unknown>) => [{ orgId: meFixture().org.orgId, taskId: taskFixture().taskId, repositoryId: "acme/payments", number: 42, version: 1, headSha: "5b81d0c3e9a47f126bd8c0e5a1f34d97c2b6e810", draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-11-21", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-11-21T19:38:00.000Z", ...patch }];
it("failedSections reads only served failures: a failing tracked check, or a current failed proof item", () => {
 const clean = readTask(coreTask(AT_MERGE));
 expect([...failedSections(clean)]).toEqual([]);
 expect([...failedSections(clean, PROOF.items)]).toEqual(["proof"]);
 expect([...failedSections(clean, [{ verdict: "fail", stale: true }, { verdict: "unknown", stale: false }, { verdict: "pass", stale: false }])]).toEqual([]);
 expect([...failedSections(readTask(coreTask({ ...AT_MERGE, mergeTracking: tracking({ ci: "failing" }) })))]).toEqual(["proof"]);
 expect([...failedSections(readTask(coreTask({ ...AT_MERGE, mergeTracking: tracking({ failingChecks: ["Refund idempotency"] }) })))]).toEqual(["proof"]);
 expect([...failedSections(readTask(coreTask({ ...AT_MERGE, mergeTracking: tracking({ ci: "failing", state: "merged" }) })))]).toEqual([]);
 expect([...failedSections(readTask(coreTask({ ...AT_MERGE, mergeTracking: tracking({ ci: "pending" }) })))]).toEqual([]);
});
it("a failure is not a finish: the stage says Proof is past, a served failure makes it need attention, and only clean sections are counted", () => {
 const task = readTask(coreTask(AT_MERGE)), failed = failedSections(task, PROOF.items);
 expect(sectionState(task, "proof")).toBe("done");
 expect(sectionState(task, "proof", failed)).toBe("attention");
 expect(finishedSections(task, failed).map(entry => entry.step)).toEqual(["request", "spec", "build"]);
 expect(finishedSections(task).map(entry => entry.step)).toEqual(["request", "spec", "build", "proof"]);
 // The current section stays current, a not-yet-reached section stays unconfirmed, whatever failed.
 const running = readTask(coreTask({ workflow: { ...workspaceWorkflow(), stage: "VERIFY", state: "RUNNING" } }));
 expect(sectionState(running, "proof", failed)).toBe("current");
 expect(sectionState(running, "pull_request", new Set(["pull_request"]))).toBe("todo");
});
it("the Work list projection and the reader carry a served failing check", () => {
 const task = coreTask({ ...AT_MERGE, mergeTracking: tracking({ ci: "failing" }) });
 expect(readTask(workTask(task))?.failedChecks).toBe(true);
 expect(readTask(task)?.failedChecks).toBe(true);
 expect(readTask(workTask(coreTask({ ...AT_MERGE, mergeTracking: tracking({}) })))?.failedChecks).toBeUndefined();
 expect(readTask(workTask(coreTask(AT_MERGE)))?.failedChecks).toBeUndefined();
});
it.each([21, 32])("the full bounded tracking array preserves a failure at entry %i", count => {
 const entries = Array.from({ length: count }, (_, index) => tracking({ number: index + 1, ...(index === count - 1 ? { ci: "failing", failingChecks: ["Refund idempotency"] } : {}) })[0]!);
 const candidate = createCandidateManifest([{ repositoryId: "acme/payments", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
 const recordedAt = "2026-11-21T19:38:00.000Z";
 const task = DeveloperTaskViewSchema.parse(coreTask({ ...AT_MERGE, mergeTracking: entries, workflow: {
  ...AT_MERGE.workflow, candidate,
  verification: { candidateDigest: candidate.digest, producer: "scripted", environmentId: "test", recordedAt, results: [{ checkId: "unit", status: "PASS" }] },
  reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: taskFixture().taskId, candidateDigest: candidate.digest, role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt })),
  pullRequests: entries.map(entry => ({ repositoryId: entry.repositoryId, number: entry.number, url: "https://github.com/acme/payments/pull/" + String(entry.number), candidateDigest: candidate.digest, required: true, state: "OPEN" })),
 } }));
 const full = readTask(task), listed = readTask(workTask(task));
 expect(full?.failedChecks).toBe(true);
 expect(listed?.failedChecks).toBe(true);
 expect([...failedSections(listed)]).toEqual(["proof"]);
 expect(sectionState(listed, "proof", failedSections(listed))).toBe("attention");
 expect(finishedSections(listed, failedSections(listed)).map(entry => entry.step)).toEqual(["request", "spec", "build"]);
 expect(finishedSections(listed, failedSections(listed))).toEqual(finishedSections(full, failedSections(full)));
});
it.each([
 ["failed proof results", AT_MERGE, PROOF],
 ["a served failing check on the pull request", { ...AT_MERGE, mergeTracking: tracking({ ci: "failing", failingChecks: ["Refund idempotency"] }) }, PROOF_CLEAN],
] as const)("WAIT_FOR_MERGE with %s: 3 steps finished, Proof needs attention", async (_name, patch, proofBody) => {
 const ui = await mount(coreTask(patch), false, false, false, proofBody);
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const rail = screen.getByRole("list", { name: "Steps of this task" });
  await waitFor(() => expect(within(rail).getByRole("button", { name: /^Proof, needs attention/u }).textContent).toMatch(/^✕\s/u));
  expect(rail.textContent?.match(/✓/gu) ?? []).toHaveLength(3);
  expect(within(rail).getByRole("button", { name: /^Proof, needs attention/u }).closest("li")?.classList.contains("bad")).toBe(true);
  expect(within(rail).getByRole("button", { name: /^Proof, needs attention/u }).closest("li")?.classList.contains("ok")).toBe(false);
  const timeline = screen.getByRole("list", { name: "Where this task is" }), items = within(timeline).getAllByRole("listitem");
  expect(items[0]!.textContent).toContain("3 steps finished");
  expect(items[0]!.textContent).toContain("Request, Plan, Build");
  expect(items[0]!.textContent).not.toContain("Checks and review");
  expect(items.map(item => item.dataset.state)).toEqual(["done", "attention", "needs_you"]);
  expect(items[1]!.textContent).toContain("Checks and review");
  expect(items[1]!.textContent).toContain("Needs attention");
  expect(within(items[1]!).getByText("Needs attention", { selector: "p" })).toBeTruthy();
  expect(items[1]!.getAttribute("aria-current")).toBeNull();
 } finally { ui.close(); }
});
it("WAIT_FOR_MERGE with clean results still shows 4 steps finished and nothing needing attention", async () => {
 const ui = await mount(coreTask(AT_MERGE), false, false, false, PROOF_CLEAN);
 try {
  await screen.findByTestId("session-title", {}, { timeout: 15_000 });
  const timeline = screen.getByRole("list", { name: "Where this task is" }), items = within(timeline).getAllByRole("listitem");
  expect(items[0]!.textContent).toContain("4 steps finished");
  expect(items.map(item => item.dataset.state)).toEqual(["done", "needs_you"]);
  expect(document.body.textContent).not.toMatch(/Needs attention|needs attention/u);
 } finally { ui.close(); }
});
