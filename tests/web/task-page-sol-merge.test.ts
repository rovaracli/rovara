// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { readDecisions } from "../../packages/ui/src/api/decisions.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { readTaskList, workRows } from "../../packages/ui/src/api/work.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { QuietCard, TaskPane } from "../../packages/ui/src/screens/work/TaskPane.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { CARDS, EVENTS, NOW, PLAN, PROOF, TASKS, decisionsView } from "./support/work-fixture.js";

function mount({ readOnly = false, compact = false, decision = false, failed = false } = {}) {
 let fail = failed;
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (request.path.endsWith("/documents/plan")) {
   if (fail) throw new ApiError(503, "INTERNAL_ERROR", "Plan refresh failed.");
   return { status: 200, body: PLAN };
  }
  if (request.path.endsWith("/evidence")) return { status: 200, body: PROOF };
  if (request.path.endsWith("/events")) return { status: 200, body: EVENTS };
  if (request.path.endsWith("/comments")) return { status: 200, body: { comments: [] } };
  return { status: 200, body: { lessons: [] } };
 });
 const cards = readDecisions(DecisionCardsViewReaderSchema.parse(decisionsView(decision ? [CARDS[0]!] : [])));
 const row = workRows(readTaskList({ tasks: [TASKS[0]] }), cards, NOW)[0]!;
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskPane, { row, readOnly, compact, decisionsError: undefined, onDecided: () => undefined }) }) }) }));
 return { ...ui, query, row, async refreshFailure() { fail = true;await act(async () => { await query.invalidateQueries({ queryKey: ["work", "plan", row.id] }); }); }, close() { ui.unmount();query.clear(); } };
}

it.each([false, true])("merged TaskPane readOnly=%s gates plan decisions", async readOnly => {
 const ui = mount({ decision: true, readOnly, compact: true });
 try {
  await waitFor(() => expect(ui.query.isFetching()).toBe(0));
  expect(screen.queryByRole("button", { name: "Approve plan v1" }) !== null).toBe(!readOnly);
 } finally { ui.close(); }
});

it.each([false, true])("merged TaskPane readOnly=%s gates answers while retaining plan facts", async readOnly => {
 const ui = mount({ readOnly, compact: true });
 try {
  await screen.findByRole("region", { name: "Spec" });
  expect(screen.queryByRole("button", { name: "Yes, behind a flag" }) !== null).toBe(!readOnly);
  expect(screen.getByRole("region", { name: "Spec" }).textContent).toContain("WHEN");
 } finally { ui.close(); }
});

it.each([false, true])("merged TaskPane compact=%s limits navigation and history to the full pane", async compact => {
 const ui = mount({ compact });
 try {
  await screen.findByRole("region", { name: "Spec" });
  expect(screen.queryByText("Plan history") !== null).toBe(!compact);
  expect(screen.queryByRole("list", { name: "Steps of this task" }) !== null).toBe(!compact);
 } finally { ui.close(); }
});

it.each([false, true])("merged TaskPane compact=%s keeps stale context only in the short peek and removes senders", async compact => {
 const ui = mount({ compact });
 try {
  await screen.findByRole("button", { name: "Yes, behind a flag" });
  await ui.refreshFailure();
  await waitFor(() => expect(ui.query.getQueryState(["work", "plan", ui.row.id])?.status).toBe("error"));
  expect(screen.queryByRole("button", { name: "Yes, behind a flag" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Spec" }) !== null).toBe(compact);
  if (compact) expect(screen.getByRole("region", { name: "Spec" }).textContent).toContain("WHEN");
  else expect(ui.container.textContent).toContain("The latest plan couldn't be read. Try again before deciding.");
 } finally { ui.close(); }
});

it("merged TaskPane shows a failed plan read when there are no earlier facts", async () => {
 const ui = mount({ compact: true, failed: true });
 try {
  await waitFor(() => expect(ui.query.getQueryState(["work", "plan", ui.row.id])?.status).toBe("error"));
  expect(screen.queryByRole("region", { name: "Spec" })).toBeNull();
  expect(ui.container.textContent).toContain("The latest plan couldn't be read. Try again before deciding.");
 } finally { ui.close(); }
});

it.each(["STARTING", "RUNNING"])("merged quiet card uses the served %s startup state", status => {
 const row = workRows(readTaskList({ tasks: [{ ...TASKS[1], status, workflow: undefined }] }), [], NOW)[0]!;
 const ui = renderUi(h(QuietCard, { row, decisionsError: undefined }));
 try {
  expect(screen.getByRole("heading", { name: status === "STARTING" ? "Starting" : "Nothing needed from you" })).toBeTruthy();
  expect(ui.container.textContent).not.toContain("queue");
 } finally { ui.unmount(); }
});
