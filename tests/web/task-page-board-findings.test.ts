// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionResponseReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { SessionScreen } from "../../packages/ui/src/screens/session/SessionScreen.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { taskBoardSessionFixture } from "./support/task-board-session-fixture.js";
import { sessionFixture, SESSION_FIXTURE_ID } from "./support/session-fixture.js";

afterEach(cleanup);
function mount(session: ReturnType<typeof SessionResponseReaderSchema.parse>["session"], width = 1280) {
 const parsed = SessionResponseReaderSchema.parse({ session }).session;
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: meFixture() };
  if (request.path === "/v1/app/decisions") return { status: 200, body: { cards: [], total: 0, digests: {} } };
  if (request.path === "/v1/app/sessions/" + SESSION_FIXTURE_ID) return { status: 200, body: { session: parsed } };
  if (request.path.endsWith("/presence")) return { status: 200, body: { viewingNow: [] } };
  if (request.path.endsWith("/messages")) return { status: 200, body: { messages: [] } };
  if (request.path.endsWith("/events")) return { status: 200, body: { events: [] } };
  if (request.path.endsWith("/documents/plan")) return { status: 200, body: { taskId: "11111111-1111-4111-8111-111111111111", document: "plan", current: true, version: 1, requirements: [], tasks: [], questions: [] } };
  return { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Not available in this fixture" } } };
 });
 f.host.viewport = { width: () => width, subscribe: () => () => undefined };
 const query = createQueryClient();query.setQueryData(["nav"], navFixture());
 renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID], children: h(Routes, {}, h(Route, { path: "/app/sessions/:id", element: h(SessionScreen, {}) })) }) }) }));
 return f;
}

it.each(["starting-old", "starting-arrival", "talk-open-arrival"])("S1/R4: %s records acceptance without an approval workflow or receipt", async state => {
 const session = taskBoardSessionFixture(workspaceFixture(), state);mount(session);
 expect((await screen.findByTestId("session-status")).querySelector(".rv-session-status-text")?.textContent).toBe("Starting");
 expect(screen.queryByText(/This task is waiting for an approval decision/)).toBeNull();
 expect(screen.getByText(/The next phase hasn't been reported here/)).toBeTruthy();
 expect(screen.queryByText("Starting: waiting for a machine")).toBeNull();
});
it("S1/R4: the closed capture has a stopped/closed header and a closed summary", async () => {
 mount(taskBoardSessionFixture(workspaceFixture(), "continuation-closed"));
 const header = await screen.findByTestId("session-header");
 expect(within(header).queryByText("Waiting for you")).toBeNull();
 expect(within(header).queryByText("Plan check")).toBeNull();
 expect(within(header).getByText("Closed")).toBeTruthy();
 expect(screen.getByTestId("decision-quiet").textContent).toContain("ClosedNothing more to do here.");
});
it.each(["budget-pause", "budget-partial-facts-no-authorized-destination", "budget-test-cap", "budget-test-cap-readonly"])("S1/R4: %s leads with the recorded pause without an approval summary", async state => {
 mount(taskBoardSessionFixture(workspaceFixture(), state));
 expect((await screen.findByTestId("session-status")).querySelector(".rv-session-status-text")?.textContent).toBe("Paused for budget");
 expect(screen.queryByText(/This task is waiting for an approval decision/)).toBeNull();
 expect(within(screen.getByTestId("session-header")).queryByText("Plan check")).toBeNull();
 expect(screen.queryByText(/Rovara is working\./)).toBeNull();
 expect(screen.getByRole("region", { name: "Task pause" }).textContent).toContain(state.startsWith("budget-test-cap") ? "This test run reached its own limit" : "Task paused");
});
it("S1: the approval capture still records its actual approval wait", async () => {
 mount(taskBoardSessionFixture(workspaceFixture(), "continuation-approval"));
 await screen.findByTestId("session-title");
 expect(screen.getByText(/This task is waiting for an approval decision/)).toBeTruthy();
});
it.each([1440, 768, 390, 320])("T1: Talk keeps the known task and project in its heading at %i px", async width => {
 const title = "Investigate duplicate refunds and preserve the original idempotency key";
 mount(workspaceFixture({ title }), width);
 fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 const dialog = await screen.findByRole("dialog");
 const heading = within(dialog).getByRole("heading", { level: 2 });
 expect(heading.textContent).toBe("Talk to this session");expect(dialog.textContent).toContain(title);expect(dialog.textContent).toContain("payments");
 expect(dialog.textContent).not.toContain("Plan check");
 expect(within(dialog).getByRole("textbox", { name: "Comment" })).toBeTruthy();
});
it("T1: Talk retains the project known from the task read when session metadata omits it", async () => {
 mount(workspaceFixture({ project: undefined }));
 fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 expect(within(await screen.findByRole("dialog")).getByRole("heading", { level: 2 }).textContent).toBe("Talk to this session");
});
it("T1: Talk keeps the title when no project is known without guessing one or a step anchor", async () => {
 mount(sessionFixture({ project: undefined }));
 fireEvent.click(await screen.findByRole("button", { name: "Talk to this session" }));
 const heading = within(await screen.findByRole("dialog")).getByRole("heading", { level: 2 });
 expect(heading.textContent).toBe("Talk to this session");expect(screen.getByRole("dialog").textContent).toContain("Fix duplicate refunds");expect(screen.getByRole("dialog").textContent).not.toContain("payments");
});
it.each([true, false])("R1/R4: unknown current activity qualifies the quiet card (last step present: %s)", async hasStep => {
 mount(workspaceFixture({ status: "running", step: "Build" }, { workflow: undefined, run: { state: "RUNNING", ...(hasStep ? { currentStep: { id: "build", name: "Build" } } : {}), steps: [{ id: "build", name: "Build", status: "running" }], pendingApprovals: [] } }));
 await screen.findByTestId("session-title");
 expect(screen.getByText("Rovara hasn't confirmed the build's latest activity.")).toBeTruthy();
 expect(screen.getByTestId("decision-quiet").textContent).toContain("Last recorded status: working. Rovara hasn't confirmed current activity.");
 expect(screen.queryByText(/Rovara is working\./)).toBeNull();
});
