// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { readTaskList, workRows } from "../../packages/ui/src/api/work.js";
import { TaskPane } from "../../packages/ui/src/screens/work/TaskPane.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { EVENTS, ID, NOW, PLAN, PROOF, TASKS } from "./support/work-fixture.js";

it("withdraws inline answer controls after a sibling proof refusal while keeping the current spec facts", async () => {
 let proof: ApiResponse = { status: 200, body: PROOF };
 const f = fakeHost(async request => request.path.endsWith("/evidence") ? proof : { status: 200, body: request.path.endsWith("/documents/plan") ? PLAN : request.path.endsWith("/events") ? EVENTS : { comments: [] } });
 const query = createQueryClient(), row = workRows(readTaskList({ tasks: TASKS }), [], NOW).find(task => task.id === ID.plan)!;
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(TaskPane, { row, decisionsError: undefined, onDecided: () => undefined }) }) }) }));
 try {
  await screen.findByRole("button", { name: "Yes, behind a flag" });await waitFor(() => expect(query.isFetching()).toBe(0));
  proof = { status: 403, body: { error: { code: "FORBIDDEN", message: "Proof access ended" } } };
  await act(async () => { await query.invalidateQueries({ queryKey: ["work", "proof", ID.plan] }); });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Yes, behind a flag" })).toBeNull());
  expect(screen.getByRole("region", { name: "Spec" }).textContent).toContain("Retries are bounded");
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 } finally { view.unmount();query.clear(); }
});
