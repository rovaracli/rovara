// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { readTaskList, workRows } from "../../packages/ui/src/api/work.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { TaskPane } from "../../packages/ui/src/screens/work/TaskPane.js";
import { TaskHeldStatesView } from "../../packages/ui/src/screens/session/TaskHeldStatesView.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { CARDS, EVENTS, NOW, PLAN, PROOF, TASKS, decisionsView } from "./support/work-fixture.js";

function pane(index: number, pageLocked = false, view: { compact?: boolean; readOnly?: boolean; wide?: boolean } = {}) {
 const f = fakeHost(async r => {
  if (r.path.endsWith("/documents/plan")) return { status: 200, body: PLAN };
  if (r.path.endsWith("/evidence")) return { status: 200, body: PROOF };
  if (r.path.endsWith("/events")) return { status: 200, body: EVENTS };
  if (r.path.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not served" } } };
 });
 const rows = workRows(readTaskList({ tasks: TASKS }), readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView(CARDS))), NOW);
 const row = rows.find(item => item.id === TASKS[index]!.taskId)!;
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskPane, { row, decisionsError: undefined, wide: true, ...view, pageLocked, sessionEntry: h("button", { type: "button" }, "Talk independently"), onDecided: () => undefined }) }) }) }));
 return { ...ui, request: f.request, query, close() { ui.unmount();query.clear(); } };
}

it("puts the real plan decision first in one shared frame, with task context beside it", async () => {
 const ui = pane(0);
 await screen.findByRole("button", { name: "Approve plan v1" });
 expect(screen.getByRole("heading", { name: "Approve plan v1?" })).toBeTruthy();
 expect(ui.container.querySelectorAll(".rv-task-reading > fieldset .rv-pane-decision .rv-decision-frame")).toHaveLength(1);
 expect(screen.getByRole("complementary", { name: "Where this task is" })).toBeTruthy();
 expect(screen.getByRole("list", { name: "Where this task is" }).textContent).toContain("Plan");
 const disclosure = screen.getByText("Plan and changes", { selector: "strong" }).closest("summary");
 expect(disclosure?.querySelector(".rv-task-section-summary")?.textContent).toContain("v1");
 ui.close();
});

it("composes the running task in a single primary frame with section rows below it", async () => {
 const ui = pane(1);
 await screen.findByRole("button", { name: "Talk independently" });
 expect(ui.container.querySelectorAll(".rv-task-reading > .rv-decision-frame")).toHaveLength(1);
 expect(ui.container.querySelector(".rv-task-current .rv-task-session-slot button")).not.toBeNull();
 for (const label of ["Plan and changes", "Checks and reviews", "Activity", "About this task"]) expect(screen.getByText(label, { selector: "strong" }).closest("summary")).toBeTruthy();
 ui.close();
});

for (const page of ["session", "running", "talk", "plan", "proof"] as const) it(`R4: ${page} holds unsupported observations in one quiet Unknown chip`, () => {
 const ui = renderUi(h(TaskHeldStatesView, { page, onCheck: () => undefined }));
 expect(screen.getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
 expect(ui.container.querySelector("ul")).toBeNull();
 expect(within(screen.getByTestId("held-" + page)).getByRole("button", { name: "Check recorded facts" })).toBeTruthy();
 expect(ui.container.textContent).not.toContain("Rovara can't tell yet whether");
 ui.unmount();
});

it("keeps the independent Talk entry outside a plan-comment lock while plan controls remain locked", async () => {
 const ui = pane(0, true);
 const approve = await screen.findByRole("button", { name: "Approve plan v1" });
 expect(approve.matches(":disabled")).toBe(true);
 expect(screen.getByRole("button", { name: "Talk independently" }).matches(":disabled")).toBe(false);
 ui.close();
});

it("R4: does not turn a pending Activity read into zero recorded events", () => {
 const ui = pane(0);
 expect(screen.getByText("Loading activity")).toBeTruthy();
 expect(screen.queryByText("0 recorded events")).toBeNull();
 ui.close();
});

for (const compact of [false, true]) it(`merge W3 keeps a ${compact ? "compact" : "full"} read-only pane free of decision and answer senders`, async () => {
 const ui = pane(0, false, { compact, readOnly: true });
 try {
  await screen.findByRole("region", { name: "Spec" });
  expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Yes, behind a flag" })).toBeNull();
  expect(ui.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
  expect(ui.container.querySelector(".rv-task-composition.wide") !== null).toBe(!compact);
 } finally { ui.close(); }
});
for (const compact of [false, true]) it(`merge W3 limits plan history to the ${compact ? "non-compact" : "ordinary"} side pane`, async () => {
 const ui = pane(0, false, { compact, wide: false });
 try {
  await screen.findByRole("region", { name: "Spec" });
  expect(screen.queryByText("Plan history", { selector: "summary" }) !== null).toBe(!compact);
 } finally { ui.close(); }
});

for (const compact of [false, true]) it(`merge W3 ${compact ? "retains read-only" : "removes"} plan facts after a failed refresh`, async () => {
 const ui = pane(0, false, { compact });
 try {
  await screen.findByRole("region", { name: "Spec" });
  const request = ui.request.getMockImplementation()!;
  ui.request.mockImplementation(async input => {
   if (input.path.endsWith("/documents/plan")) throw new ApiError(503, "INTERNAL_ERROR", "Plan refresh failed.");
   return request(input);
  });
  await act(async () => { await ui.query.invalidateQueries({ queryKey: ["work", "plan", TASKS[0]!.taskId] }); });
  await waitFor(() => {
   expect(screen.queryByRole("region", { name: "Spec" }) !== null).toBe(compact);
   expect(screen.queryByRole("button", { name: "Approve plan v1" })).toBeNull();
   expect(screen.queryByRole("button", { name: "Yes, behind a flag" })).toBeNull();
  });
  expect(ui.request.mock.calls.every(([input]) => input.method === "GET")).toBe(true);
 } finally { ui.close(); }
});
