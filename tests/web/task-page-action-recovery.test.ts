// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { TaskActions } from "../../packages/ui/src/screens/session/TaskActions.js";
import { FixWithAgentPanel } from "../../packages/ui/src/screens/session/FixWithAgentPanel.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
import { workspaceFixture, workspaceWorkflow } from "./support/workspace-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const errorRef = { kind: "operation_failed" as const, code: "CHECK_FAILED", subject: { taskId: "11111111-1111-4111-8111-111111111111" }, at: "2026-10-23T12:00:00.000Z" };
const base = workspaceFixture(), settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };

it("Opus-6: unknown Retry cannot hold Stop/Close, survives remount and resolves only on a covering read", async () => {
 let moved = false;
 const session = () => ({ ...base, revision: moved ? 2 : 1, status: moved ? "failed" as const : "running" as const, you: { ...base.you, actions: moved ? ["stop", "close"] : ["retry", "stop", "close"] } });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { session: session() } } : { status: 503, body: { error: { code: "UPSTREAM", message: "Result unknown" } } });
 const query = createQueryClient(), tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(SessionControls, { id: base.sessionId, agent: "Agent", actions: ["retry", "stop", "close"], following: false, onChanged: async () => undefined }) }) });
 let ui = renderUi(tree());const retry = await screen.findByRole<HTMLButtonElement>("button", { name: "Retry" });await waitFor(() => expect(retry.disabled).toBe(false));fireEvent.click(retry);await screen.findByRole("button", { name: "Check" });
 for (let i = 0; i < 3; i++) { fireEvent.click(screen.getByRole("button", { name: "Check" }));await settle(); }
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Stop" }).disabled).toBe(false);
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Close task" }).disabled).toBe(false);
 expect(retry.disabled).toBe(true);ui.unmount();ui = renderUi(tree());await settle();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Retry" }).disabled).toBe(true);
 moved = true;fireEvent.click(screen.getByRole("button", { name: "Check" }));await waitFor(() => expect(screen.queryByRole("button", { name: "Check" })).toBeNull());
 expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(1);ui.unmount();query.clear();
});

it("Continue Check retires an unknown request only when the task is now closed, without claiming success or resending", async () => {
 let closed = false;
 const task = workspaceFixture({}, { workflow: { ...workspaceWorkflow(), state: "RUNNING", stage: "IMPLEMENT" } }).body;
 if (task.kind !== "task") throw new Error("task required");
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { tasks: [{ ...task.task, status: closed ? "CLOSED" : "RUNNING" }] } } : { status: 503, body: { error: { code: "UPSTREAM", message: "Result unknown" } } });
 const query = createQueryClient(), tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(TaskActions, { taskId: task.task.taskId, sessionId: base.sessionId, canContinue: true, showNote: false }) }) });
 let ui = renderUi(tree());const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Continue in my tool" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);await screen.findByRole("button", { name: "Check" });
 fireEvent.click(screen.getByRole("button", { name: "Check" }));await settle();expect(button.disabled).toBe(true);ui.unmount();ui = renderUi(tree());await screen.findByRole("button", { name: "Check" });
 closed = true;fireEvent.click(screen.getByRole("button", { name: "Check" }));await waitFor(() => expect(screen.queryByRole("button", { name: "Check" })).toBeNull());
 expect(screen.getByTestId("continue-message").textContent).toContain("closed");expect(screen.getByTestId("continue-message").textContent).not.toContain("Asked Rovara Code");
 expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(1);ui.unmount();query.clear();
});

for (const change of ["revoked", "403", "503"] as const) it(`Low-3/R6c: diagnosis ${change} before send spends nothing`, async () => {
 const session = { ...base, errorRef, you: { ...base.you, live: change === "revoked" ? {} : { fix: true } } };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? change === "revoked" ? { status: 200, body: { session } } : { status: Number(change), body: { error: { code: "TASK_ACCESS_DENIED", message: "Task read unavailable" } } } : { status: 503, body: {} });
 const query = createQueryClient();renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(FixWithAgentPanel, { sessionId: base.sessionId, errorRef }) }) }));
 const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Fix with agent" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);await settle();
 expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);expect((await screen.findByRole("alert")).textContent).toBeTruthy();query.clear();
});
it("Diagnosis Check reads the session after remount and retires a superseded error without a second paid call", async () => {
 let changed = false;
 const session = () => ({ ...base, errorRef: changed ? { ...errorRef, code: "NEW_ERROR" } : errorRef, you: { ...base.you, live: { fix: true } } });
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: meFixture() } : r.method === "GET" ? { status: 200, body: { session: session() } } : { status: 503, body: { error: { code: "UPSTREAM", message: "Result unknown" } } });
 const query = createQueryClient(), tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(FixWithAgentPanel, { sessionId: base.sessionId, errorRef }) }) });
 let ui = renderUi(tree());const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Fix with agent" });await waitFor(() => expect(button.disabled).toBe(false));fireEvent.click(button);await screen.findByRole("button", { name: "Check this diagnosis request" });
 fireEvent.click(screen.getByRole("button", { name: "Check this diagnosis request" }));await settle();expect(button.disabled).toBe(true);ui.unmount();ui = renderUi(tree());await screen.findByRole("button", { name: "Check this diagnosis request" });
 changed = true;fireEvent.click(screen.getByRole("button", { name: "Check this diagnosis request" }));await waitFor(() => expect(screen.queryByRole("button", { name: "Check this diagnosis request" })).toBeNull());
 expect((await screen.findByRole("status")).textContent).toContain("error changed");expect(f.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(1);ui.unmount();query.clear();
});
