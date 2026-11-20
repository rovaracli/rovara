// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { InboxScreen } from "../../packages/ui/src/screens/inbox/InboxScreen.js";
import { WorkScreen } from "../../packages/ui/src/screens/work/WorkScreen.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { CARDS, EVENTS, ID, PLAN, PROOF, TASKS, decisionsView } from "./support/work-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";

const fail = (status = 403): ApiResponse => ({ status, body: { error: { code: "FORBIDDEN", message: "Read refused." } } });
function mount(path = "/app/inbox", initial: Record<string, ApiResponse> = {}) {
 const replies: Record<string, ApiResponse> = {
  "/v1/app/sessions": { status: 200, body: { tasks: TASKS } },
  "/v1/app/decisions": { status: 200, body: decisionsView() },
  "/v1/app/involved": { status: 200, body: { tasks: [] } },
  "/v1/app/lessons/inbox": { status: 200, body: { state: "on", batches: [], unavailable: [] } },
  "/v1/app/inbox": { status: 200, body: { items: [], unread: 0 } },
  "/v1/app/inbox/project-notices": { status: 200, body: { items: [] } },
  "/v1/app/nav": { status: 200, body: navFixture({ projects: [] }) },
  ...initial,
 };
 const f = fakeHost(async request => replies[request.path.split("?")[0]!] ?? (request.path.endsWith("/documents/plan") ? { status: 200, body: PLAN } : request.path.endsWith("/evidence") ? { status: 200, body: PROOF } : request.path.endsWith("/events") ? { status: 200, body: EVENTS } : request.path.endsWith("/comments") ? { status: 200, body: { comments: [] } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "not served" } } }));
 const query = createQueryClient(), where = { current: "" };
 function Where() { const location = useLocation();where.current = location.pathname + location.search;return null; }
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [path], children: h(Announcer, { children: h("div", {}, h(Where), h(Routes, {}, h(Route, { path: "/app/inbox", element: h(InboxScreen) }), h(Route, { path: "/app/live", element: h(WorkScreen) }))) }) }) }) }));
 return { ...f, ...view, query, replies, where, close() { view.unmount();query.clear(); } };
}

it("Inbox shows served needs-you tasks separately from waiting, and preview navigation sends no writes", async () => {
 const f = mount();
 const attention = await screen.findByRole("region", { name: "Inbox attention" });
 await within(attention).findByRole("button", { name: /Add a retry to the billing webhook/u });
 expect(within(attention).queryByRole("button", { name: /Document the router fallbacks/u })).toBeNull();
 fireEvent.click(within(attention).getByRole("button", { name: /Add a retry to the billing webhook/u }));
 const detail = await screen.findByRole("region", { name: "Inbox preview" });
 expect(detail.textContent).toContain(CARDS[0]!.question);
 expect(within(detail).getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/app/sessions/" + ID.plan);
 expect(within(detail).queryByRole("button", { name: "Approve and build" })).toBeNull();
 expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Back to Inbox" }));
 expect(document.activeElement?.textContent).toContain("Add a retry");f.close();
});
it("Inbox waiting is based on workflow WAITING, without inventing a named reviewer", async () => {
 const f = mount("/app/inbox?tab=waiting");const attention = await screen.findByRole("region", { name: "Inbox attention" });
 expect(await within(attention).findByRole("button", { name: /Document the router fallbacks/u })).toBeTruthy();
 expect(within(attention).queryByRole("button", { name: /Add a retry/u })).toBeNull();
 expect(attention.textContent).not.toContain("Waiting for Sam");f.close();
});
it.each(["decisions", "tasks"])("Inbox drops cached %s after a failed read and keeps independently current updates", async source => {
 const f = mount();await screen.findByRole("button", { name: /Add a retry to the billing webhook/u });
 f.replies[source === "tasks" ? "/v1/app/sessions" : "/v1/app/decisions"] = fail();
 await act(async () => { await f.query.invalidateQueries({ queryKey: source === "tasks" ? ["work", "tasks"] : ["decisions"] }); });
 await waitFor(() => expect(screen.queryByRole("button", { name: /Add a retry to the billing webhook/u })).toBeNull());
 expect(screen.getByTestId("inbox-attention").textContent).toContain("can't tell yet");
 expect(screen.queryByText("You're all caught up.")).toBeNull();f.close();
});
it("Inbox empty and partial reads never become a global all-clear", async () => {
 const f = mount("/app/inbox", { "/v1/app/sessions": { status: 200, body: { tasks: [] } }, "/v1/app/decisions": { status: 200, body: decisionsView([]) }, "/v1/app/inbox/project-notices": fail() });
 expect(await screen.findByTestId("project-notices-error")).toBeTruthy();
 expect(screen.getByTestId("inbox-attention").textContent).toContain("can't tell yet");
 expect(screen.queryByText("Nothing needs you")).toBeNull();f.close();
});
it("Inbox setup uses a successful scoped zero-project read and offers no invented invite send", async () => {
 const f = mount("/app/inbox?tab=setup");expect(await screen.findByText("You're not in a project yet")).toBeTruthy();
 expect(screen.getByTestId("inbox-attention").textContent).toContain("Ask your company's admins");
 expect(screen.queryByRole("button", { name: /Ask Ana/u })).toBeNull();expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);f.close();
});
it("Inbox setup refusal never retains the cached project or its link", async () => {
 const f = mount("/app/inbox?tab=setup");await screen.findByText("You're not in a project yet");
 f.replies["/v1/app/nav"] = fail();await act(async () => { await f.query.invalidateQueries({ queryKey: ["nav"] }); });
 await waitFor(() => expect(screen.queryByText("You're not in a project yet")).toBeNull());expect(screen.getByTestId("inbox-attention").textContent).toContain("can't tell yet");f.close();
});
it("Work filters loaded tasks, searches without changing unrelated parameters, and clears no-matches", async () => {
 const f = mount("/app/live?keep=yes");await screen.findByRole("button", { name: "Running" });
 fireEvent.click(screen.getByRole("button", { name: "Running" }));
 expect(document.querySelectorAll("button[data-task-id]")).toHaveLength(1);
 expect(document.querySelector("button[data-task-id]")?.textContent).toContain("Speed up");
 fireEvent.change(screen.getByRole("searchbox", { name: "Search work" }), { target: { value: "absent" } });
 expect(screen.getByText("No tasks match this filter.")).toBeTruthy();expect(f.where.current).toContain("keep=yes");
 fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));expect(document.querySelectorAll("button[data-task-id]").length).toBeGreaterThan(1);f.close();
});
it("Work Needs someone includes waiting tasks and Finished includes served completion only", async () => {
 const f = mount();f.close();const w = mount("/app/live");await screen.findByRole("button", { name: "Needs someone" });
 fireEvent.click(screen.getByRole("button", { name: "Needs someone" }));
 expect(document.querySelector(`button[data-task-id="${ID.waiting}"]`)).toBeTruthy();
 expect(document.querySelector(`button[data-task-id="${ID.running}"]`)).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Finished" }));expect(document.querySelectorAll("button[data-task-id]")).toHaveLength(1);w.close();
});
it("Work unknown selection never substitutes an unrelated task", async () => {
 const f = mount("/app/live?task=missing");expect(await screen.findByTestId("work-selection-unavailable")).toBeTruthy();
 expect(screen.queryByTestId("pane-title")).toBeNull();expect(f.where.current).toContain("task=missing");f.close();
});
it("Work cached task refusal hides the pane and every task control until recovery", async () => {
 const f = mount("/app/live?task=" + ID.plan);await screen.findByTestId("pane-title");f.replies["/v1/app/sessions"] = fail();
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["work", "tasks"] }); });
 expect(screen.queryByTestId("pane-title")).toBeNull();expect(document.querySelector("button[data-task-id]")).toBeNull();expect(screen.getByTestId("work").getAttribute("data-detail-open")).toBe("false");
 f.replies["/v1/app/sessions"] = { status: 200, body: { tasks: TASKS } };
 fireEvent.click(screen.getByRole("button", { name: "Try again" }));await screen.findByTestId("pane-title");f.close();
});
it("Work decision refusal removes stale actions, labels incomplete reads and offers a scoped retry", async () => {
 const f = mount("/app/live?task=" + ID.plan);await screen.findByRole("button", { name: "Approve and build" });
 f.replies["/v1/app/decisions"] = fail();await act(async () => { await f.query.invalidateQueries({ queryKey: ["decisions"] }); });
 expect(screen.queryByRole("button", { name: "Approve and build" })).toBeNull();expect(screen.getByRole("button", { name: "Reload decisions" })).toBeTruthy();expect(screen.getByTestId("decisions-unavailable").closest(".rv-work-list")).toBeNull();f.close();
});
it("Work empty loaded rows never claim that the complete queue is empty", async () => {
 const f = mount("/app/live", { "/v1/app/sessions": { status: 200, body: { tasks: [] } }, "/v1/app/decisions": { status: 200, body: decisionsView([]) } });
 expect(await screen.findByTestId("work-empty")).toBeTruthy();expect(screen.getByTestId("work").textContent).toContain("can't tell yet");f.close();
});
for (const theme of ["light", "dark"] as const) it("has accessible attention and Work filters in " + theme, async () => {
 const f = mount();document.documentElement.dataset.theme = theme;await screen.findByRole("button", { name: /Add a retry/u });await expectNoAxeViolations(f.container);f.close();
 const w = mount("/app/live");await screen.findByRole("button", { name: "Running" });await expectNoAxeViolations(w.container);w.close();
});
