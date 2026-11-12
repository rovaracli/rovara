// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { createRunApi } from "../../packages/ui/src/api/runs.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";
import { taskFixture } from "./support/session-fixture.js";
const id = "ses_bbbbbbbbbbbbbbbbbbbb";
// 2026-11-04 (0.5.5 integration): StartWorkBox now asks POST .../start-preview when it opens (admin-v11-finish, a read in effect); a project page that is not testing the spending stop answers it "disabled" and does not count it as a start or a write.
function setup(value = projectFixture(), options: { theme?: "light" | "dark"; send?: (request: ApiRequest) => Promise<ApiResponse> } = {}) {
 let body: unknown = value, status = 200;
 const f = fakeHost(async request => request.path === "/v1/app/changes" ? { status: 200, body: { notices: [], next: "settled" } } : request.path.endsWith("/start-preview") ? { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } } : request.method === "GET" ? { status, body } : options.send ? options.send(request) : { status: 202, body: { task: taskFixture({ sessionId: id }) } });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, query, answer(next: unknown, code = 200) { body = next;status = code; }, close() { ui.unmount();query.clear(); } };
}
it("shows the actual project, workflows, budget, running work and exact visibility note", async () => {
 const f = setup();await screen.findByRole("heading", { name: "payments" });expect(screen.getByText("Keep customer payments dependable.")).toBeTruthy();expect(screen.getByText("acme/payments")).toBeTruthy();expect(screen.getByText("Setup ready")).toBeTruthy();expect(screen.getByText("Everyone on this project can see its sessions, including people who reach it through its Slack channel.")).toBeTruthy();expect(screen.getByText("$812.00")).toBeTruthy();expect(screen.getByText("$2,000.00")).toBeTruthy();expect(screen.getByText(/per merged pull request/u)).toBeTruthy();expect(screen.getByRole("heading", { name: "Fix duplicate refunds" })).toBeTruthy();expect(screen.getByRole("link", { name: "Payments expert" }).getAttribute("href")).toBe("/app/agents/agt_aaaaaaaaaaaaaaaaaaaa");f.close();
});
it("starts the selected shared agent once and opens the actual returned session", async () => {
 let finish: ((value: ApiResponse) => void) | undefined;
 const send = vi.fn(async () => new Promise<ApiResponse>(resolve => { finish = resolve; })), f = setup(undefined, { send }), navigate = vi.spyOn(f.host, "navigate");
 fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));const input = await screen.findByRole("textbox", { name: "What should Payments expert do?" });fireEvent.change(input, { target: { value: "Investigate the duplicate refund" } });const start = screen.getByRole("button", { name: "Start session" });fireEvent.click(start);fireEvent.click(start);expect(send).toHaveBeenCalledTimes(1);expect(navigate).not.toHaveBeenCalled();finish?.({ status: 202, body: { task: taskFixture({ sessionId: id }) } });await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/sessions/" + id));expect(f.request.mock.calls.find(([request]) => request.method === "POST" && !request.path.endsWith("/start-preview"))?.[0]).toMatchObject({ path: "/v1/app/agents/agt_aaaaaaaaaaaaaaaaaaaa/runs", body: { project: "payments", input: { text: "Investigate the duplicate refund" }, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown } });f.close();
});
it("does not offer New session, settings or spend without their server capabilities", async () => {
 const f = setup(projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false }, project: { ...projectFixture().project, setup: { status: "failed", failedStep: "bootstrap" } } }));await screen.findByRole("heading", { name: "payments" });expect(screen.queryByRole("button", { name: "New session" })).toBeNull();expect(screen.getByRole("link", { name: "Setup needs attention" }).getAttribute("href")).toBe("#project-setup");expect(screen.queryByText("$812.00")).toBeNull();f.close();
});
it("links the setup state to the project setup checklist on the same page, whatever the state (UX-4b)", async () => {
 const value = projectFixture();value.project.setup.status = "failed";const f = setup(value);expect((await screen.findByRole("link", { name: "Setup needs attention" })).getAttribute("href")).toBe("#project-setup");expect(await screen.findByRole("region", { name: "Project setup" })).toBeTruthy();f.close();
});
it("shows a budget refusal in the start dialog without claiming work started", async () => {
 const f = setup(undefined, { send: async () => ({ status: 403, body: { error: { code: "BUDGET_EXHAUSTED", message: "The project has reached its monthly budget." } } }) });fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));fireEvent.change(await screen.findByRole("textbox", { name: "What should Payments expert do?" }), { target: { value: "Investigate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start session" }));expect(await screen.findByText("The project has reached its monthly budget.")).toBeTruthy();expect(screen.getByRole("dialog")).toBeTruthy();f.close();
});
it("requires a nonblank problem and enforces the 4000-character limit", async () => {
 const f = setup();fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));const input = await screen.findByRole("textbox", { name: "What should Payments expert do?" }), start = screen.getByRole<HTMLButtonElement>("button", { name: "Start session" });expect(start.disabled).toBe(true);fireEvent.change(input, { target: { value: " ".repeat(4) } });expect(start.disabled).toBe(true);fireEvent.change(input, { target: { value: "x".repeat(4001) } });expect(start.disabled).toBe(true);expect(f.request.mock.calls.every(([request]) => request.method === "GET" || request.path.endsWith("/start-preview"))).toBe(true);f.close();
});
it("does not make up a session id or allow a duplicate start when a legacy answer lacks its link", async () => {
 const f = setup(undefined, { send: async () => ({ status: 202, body: { task: taskFixture() } }) });fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));fireEvent.change(await screen.findByRole("textbox", { name: "What should Payments expert do?" }), { target: { value: "Investigate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start session" }));expect(await screen.findByRole("link", { name: "Open Work" })).toBeTruthy();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start session" }).disabled).toBe(true);f.close();
});
it("does not display cached project details or controls after access is refused", async () => {
 const f = setup();await screen.findByRole("heading", { name: "payments" });f.answer({ error: { code: "PROJECT_NOT_FOUND", message: "Not found." } }, 404);await f.query.invalidateQueries({ queryKey: ["project", "payments", "overview"] });await screen.findByRole("heading", { name: "Not found" });expect(screen.queryByRole("button", { name: "New session" })).toBeNull();expect(screen.queryByText("Keep customer payments dependable.")).toBeNull();f.close();
});
it("validates start identities before transport", async () => {
 const f = fakeHost(), api = createRunApi(f.host);await expect(async () => api.startWork("../outside", { project: "payments", text: "Fix it" })).rejects.toThrow();await expect(async () => api.startWork("agt_aaaaaaaaaaaaaaaaaaaa", { project: "../outside", text: "Fix it" })).rejects.toThrow();await expect(async () => api.startWork("agt_aaaaaaaaaaaaaaaaaaaa", { project: "payments", text: "   " })).rejects.toThrow();await expect(async () => api.startWork("agt_aaaaaaaaaaaaaaaaaaaa", { project: "payments", text: "x".repeat(4001) })).rejects.toThrow();expect(f.request).not.toHaveBeenCalled();
});
for (const theme of ["light", "dark"] as const) it("has an accessible project overview in " + theme, async () => { const f = setup(undefined, { theme });await screen.findByRole("heading", { name: "payments" });await expectNoAxeViolations(f.container);f.close(); });
it("keeps an unrecognized future agent readable without inventing a profile or start target", async () => {
 const value = projectFixture();value.agents[0]!.agentId = "future-builtin";const f = setup(value);await screen.findByRole("heading", { name: "payments" });expect(screen.getByText("Payments expert", { selector: ".rv-project-agents span" })).toBeTruthy();expect(screen.queryByRole("link", { name: "Payments expert" })).toBeNull();fireEvent.click(screen.getByRole("button", { name: "New session" }));expect(screen.queryByRole("button", { name: "Payments expert" })).toBeNull();expect(f.request.mock.calls.every(([request]) => request.method === "GET" || request.path.endsWith("/start-preview"))).toBe(true);f.close();
});

it("refreshes running work on an authenticated session update without leaving the project", async () => {
 const f = setup();await screen.findByText("Planning");await waitFor(() => expect(f.sockets).toHaveLength(1));const socket = f.sockets[0]!.socket;socket.open();socket.message({ type: "connection_ack", connectionTimeoutMs: 900_000 });const subscription = socket.sent.find(frame => frame.type === "subscribe")!;
 const next = projectFixture();next.running[0]!.step = "Building";f.answer(next);socket.message({ type: "data", id: subscription.id, event: [JSON.stringify({ type: "session.updated", sessionId: next.running[0]!.sessionId, revision: 2 })] });await screen.findByText("Building");expect(screen.getByRole("heading", { name: "payments" })).toBeTruthy();f.close();expect(socket.closed).toBe(true);
});

it("reuses a start's request identity when the same problem is retried after a refusal", async () => {
 let calls = 0;const send = vi.fn(async () => ++calls === 1 ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Try starting again." } } } : { status: 202, body: { task: taskFixture({ sessionId: id }) } });
 const f = setup(undefined, { send });fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));fireEvent.change(await screen.findByRole("textbox", { name: "What should Payments expert do?" }), { target: { value: "Investigate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start session" }));await screen.findByText("Try starting again.");fireEvent.click(screen.getByRole("button", { name: "Start session" }));await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
 const writes = f.request.mock.calls.filter(([request]) => request.method === "POST" && !request.path.endsWith("/start-preview")).map(([request]) => request.body as { requestId: string });expect(writes[0]?.requestId).toBe(writes[1]?.requestId);f.close();
});
it("hides project data and controls after a non-404 permission refusal too", async () => {
 const f = setup();await screen.findByRole("heading", { name: "payments" });f.answer({ error: { code: "FORBIDDEN", message: "Your project access ended." } }, 403);await f.query.invalidateQueries({ queryKey: ["project", "payments", "overview"] });await screen.findByText("Your project access ended.");expect(screen.queryByText("Keep customer payments dependable.")).toBeNull();expect(screen.queryByRole("button", { name: "New session" })).toBeNull();f.close();
});
it("does not invent a per-merge cost before any pull request merged this month", async () => {
 const value = projectFixture();value.budget = { month: "2026-10", spentUsd: 812, limitUsd: 2000, mergedPullRequests: 0 };const f = setup(value);await screen.findByText("No merged pull requests yet this month");expect(screen.queryByText("$3.90")).toBeNull();f.close();
});
it("starts through the canonical runs API with a fresh default request id for each new intent", async () => {
 const f = fakeHost(async () => ({ status: 202, body: { task: taskFixture({ sessionId: id }) } })), api = createRunApi(f.host);
 const result = await api.startWork("agt_aaaaaaaaaaaaaaaaaaaa", { project: "payments", text: "Investigate refunds" });await api.startWork("agt_aaaaaaaaaaaaaaaaaaaa", { project: "payments", text: "Investigate refunds" });expect(result.kind).toBe("done");
 const writes = f.request.mock.calls.map(([request]) => request.body as { requestId: string });expect(writes.every(body => /^[0-9a-f-]{36}$/u.test(body.requestId))).toBe(true);expect(new Set(writes.map(body => body.requestId)).size).toBe(2);expect(f.request.mock.calls.every(([request]) => request.path === "/v1/app/agents/agt_aaaaaaaaaaaaaaaaaaaa/runs")).toBe(true);
});
it("focuses the loaded project heading once and leaves an active form alone during refresh", async () => {
 const f = setup();const heading = await screen.findByRole("heading", { name: "payments" });await waitFor(() => expect(document.activeElement).toBe(heading));const focus = vi.spyOn(heading, "focus");fireEvent.click(screen.getByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));const input = await screen.findByRole("textbox", { name: "What should Payments expert do?" });await waitFor(() => expect(document.activeElement).toBe(input));f.answer(projectFixture({ project: { ...projectFixture().project, description: "Updated project purpose" } }));await f.query.invalidateQueries({ queryKey: ["project", "payments", "overview"] });await screen.findByText("Updated project purpose");expect(document.activeElement).toBe(input);expect(focus).not.toHaveBeenCalled();f.close();
});

it("offers company-pinned website settings to an own-project maintainer without admin navigation", async () => {
 const f = setup({ ...projectFixture(), orgId: "org_aaaaaaaaaaaaaaaaaaaa" });
 await screen.findByRole("heading", { name: "payments" });
 expect(screen.getByRole("button", { name: "Edit allowed websites" })).toBeTruthy();
 expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();f.close();
});
it("holds website editing when an older overview has no company pin", async () => {
 const f = setup();await screen.findByRole("heading", { name: "payments" });expect(screen.queryByRole("button", { name: "Edit allowed websites" })).toBeNull();f.close();
});

it("the start confirmation says Open Work and links to Work (decision 125: Live is gone), whatever a leftover device key says", async () => {
 const send = async () => ({ status: 202, body: { task: taskFixture() } });
 for (const key of [undefined, "v2", "off"]) {
  const f = setup(undefined, { send });if (key !== undefined) f.storage.set("rovara.nav", key);
  fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));fireEvent.change(await screen.findByRole("textbox", { name: "What should Payments expert do?" }), { target: { value: "Investigate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  const link = await screen.findByRole("link", { name: "Open Work" });
  expect(link.getAttribute("href")).toBe("/app/work");expect(screen.queryByRole("link", { name: "Open Live" })).toBeNull();
  f.close();
 }
});
